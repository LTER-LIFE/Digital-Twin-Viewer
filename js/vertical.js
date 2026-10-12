// Vertical structure of 4-D (time, level, y, x) fields.
//
// Two things make this cheap enough to do in a browser.
//
// GEOMETRY. The model's sigma layers are stored once, as the fraction of the
// local water column each layer occupies — measured to be time-invariant to
// ~4e-5 of the depth. Multiplying those fractions by the water depth the app
// already animates reconstructs every layer interface at every timestep, to
// 0.5 mm typical and 8 cm worst case. So no layer-thickness field is ever
// downloaded, and depths follow the tide for free.
//
// VALUES. The column store is laid out level-fastest, then time, then cell, so
// one cell's entire history is contiguous — about 7 kB for a year of daily
// output. The app asks the server for exactly the cells a selection covers and
// never touches the rest of a file that may be hundreds of megabytes.

const MAX_COLUMNS = 4096;       // must match MAX_COLUMNS in server.py

export class Columns {
  /**
   * @param ctx {{DATA, slug, NX, NY, N, NDAYS, terrain, elevI16, meta}}
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.nz = 0;
    this.frac = null;            // Uint16Array[N * nz], cell-major
    this.cellmap = null;         // Int32Array[N], -1 on land
    this._cache = new Map();     // key -> {ks, nt, nz, data, lo, step}
    this._inflight = new Map();
  }

  get ready() { return this.nz > 0 && !!this.frac && !!this.cellmap; }

  /** Load the two small shared files. Returns false when the dataset has no
   *  vertical grid, which is the normal case for a 2-D-only run. */
  async load() {
    const { DATA, meta } = this.ctx;
    const vg = meta.vgrid;
    if (!vg || !vg.nLayers || !meta.cellmap) return false;
    const [f, c] = await Promise.all([
      fetch(`${DATA}/${vg.file}`).then((r) => (r.ok ? r.arrayBuffer() : null)),
      fetch(`${DATA}/${meta.cellmap.file}`).then((r) => (r.ok ? r.arrayBuffer() : null)),
    ]);
    if (!f || !c) return false;
    this.nz = vg.nLayers;
    this.frac = new Uint16Array(f);
    this.cellmap = new Int32Array(c);
    this.nColumns = meta.cellmap.nColumns;
    return true;
  }

  /** Does this grid cell have a water column? */
  has(k) { return this.ready && this.cellmap[k] >= 0; }

  // ------------------------------------------------------------- geometry
  /** Layer interfaces at cell k and step t, in metres, BED FIRST (nz+1 of
   *  them). Returns null where the cell is dry or has no column — a profile
   *  through a dry flat is not a thin profile, it is no profile. */
  interfaces(k, t, out) {
    if (!this.has(k)) return null;
    const { terrain, elevI16, N } = this.ctx;
    const bed = terrain[k];
    const D = elevI16[t * N + k] * 0.01 - bed;
    if (!(D > 0.005)) return null;
    const z = out || new Float64Array(this.nz + 1);
    const base = k * this.nz;
    let acc = bed;
    z[0] = bed;
    for (let i = 0; i < this.nz; i++) {
      acc += (this.frac[base + i] / 65535) * D;
      z[i + 1] = acc;
    }
    z[this.nz] = bed + D;      // kill the quantisation drift at the surface
    return z;
  }

  /** Layer-centre elevations, bed first. */
  centres(k, t, out) {
    const z = this.interfaces(k, t);
    if (!z) return null;
    const m = out || new Float64Array(this.nz);
    for (let i = 0; i < this.nz; i++) m[i] = (z[i] + z[i + 1]) * 0.5;
    return m;
  }

  // --------------------------------------------------------------- values
  /** Fetch the columns for a set of grid cells.
   *
   *  Cells are sorted and de-duplicated before asking, so an area's rows
   *  collapse into contiguous runs the server can serve with one read each.
   *  Above MAX_COLUMNS the set is evenly subsampled rather than truncated —
   *  a thinned sample of the whole area is honest, the first 4096 cells of it
   *  would quietly be a corner.
   */
  _plan(v, ks) {
    if (!this.ready || !v || !v.column) return null;
    const want = [...new Set(ks)].filter((k) => this.has(k)).sort((a, b) => a - b);
    if (!want.length) return null;
    let cells = want, sampled = false;
    if (want.length > MAX_COLUMNS) {
      cells = [];
      for (let i = 0; i < MAX_COLUMNS; i++) {
        cells.push(want[Math.floor((i * want.length) / MAX_COLUMNS)]);
      }
      sampled = true;
    }
    const cols = cells.map((k) => this.cellmap[k]);
    const key = `${v.key}|${cols.length}|${cols[0]}|${cols[cols.length - 1]}|`
      + hash(cols);
    return { cells, cols, key, sampled, ofTotal: want.length };
  }

  /** What fetch() would return, if it is already here. Lets the draw path stay
   *  synchronous: it paints what it has and asks for the rest. */
  peek(v, ks) {
    const plan = this._plan(v, ks);
    return plan ? this._cache.get(plan.key) : undefined;
  }

  async fetch(v, ks) {
    const plan = this._plan(v, ks);
    if (!plan) return null;
    const { cells, cols, key, sampled } = plan;
    const hit = this._cache.get(key);
    if (hit) return hit;
    const pending = this._inflight.get(key);
    if (pending) return pending;

    const c = v.column;
    const p = (async () => {
      const r = await fetch(`${this.ctx.base}/api/columns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset: this.ctx.slug, file: c.file,
          nFrames: c.nFrames, nLayers: c.nLayers, cells: cols,
        }),
      });
      if (!r.ok) throw new Error(`columns ${r.status}`);
      const buf = await r.arrayBuffer();
      const out = {
        ks: cells, sampled, ofTotal: plan.ofTotal,
        nt: c.nFrames, nz: c.nLayers,
        data: new Uint16Array(buf),
        // 0 is the explicit "no data" code, so real values start at 1
        lo: v.dataMin, step: (v.dataMax - v.dataMin) / (c.codeMax - 1),
      };
      out.at = (ci, t, z) => {
        const q = out.data[(ci * out.nt + t) * out.nz + z];
        return q === 0 ? NaN : out.lo + (q - 1) * out.step;
      };
      this._cache.set(key, out);
      // One entry per (variable, selection). Eight was too few for the ordinary
      // case of three stations compared across three variables: switching
      // variable evicted a column that the very next draw needed, and the third
      // station's profile vanished until its refetch landed. A single-cell
      // entry is ~1.5 kB and an area of 500 cells ~0.8 MB, so holding a few
      // dozen costs little against redrawing without them.
      if (this._cache.size > 24) this._cache.delete(this._cache.keys().next().value);
      this._inflight.delete(key);
      return out;
    })();
    this._inflight.set(key, p);
    return p;
  }

  clear() { this._cache.clear(); }
}

function hash(a) {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i];
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------- aggregation
/** Percentiles of a small sample, with linear interpolation between ranks. */
function pct(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const x = (n - 1) * q;
  const i = Math.floor(x), f = x - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

/** Profile of a selection on a common ELEVATION grid.
 *
 *  Each column is interpolated from its own layer centres onto shared levels,
 *  then percentiles are taken across whatever cells reach that level. `n`
 *  carries that count per level: near the bed of the deepest channel a single
 *  cell may be all there is, and a band drawn from one sample is not a spread.
 *  The caller is expected to show it.
 *
 *  Interpolating is unavoidable once the axis is a real elevation, because
 *  layer k sits at a different depth in every cell. Nothing is extrapolated:
 *  a column contributes to a level only between its own top and bottom layer
 *  centres.
 */
export function depthProfile(cols, t, geom, nLevels = 60, hold = false) {
  const { ks } = cols;
  let zmin = Infinity, zmax = -Infinity;
  const zs = [];
  const ends = [];
  for (let ci = 0; ci < ks.length; ci++) {
    const c = geom.centres(ks[ci], t);
    zs.push(c);
    if (!c) { ends.push(null); continue; }
    // `hold` extends each column to its bed and surface, holding the end
    // layers' values over their own half-thicknesses. The model is finite
    // volume: a layer's number is the average over that layer, not a sample at
    // its centre, so a filled plot should reach the bed. A line profile leaves
    // it off, because there the dots ARE the layer centres and flat tails on
    // the ends would look like data.
    const f = hold ? geom.interfaces(ks[ci], t) : null;
    ends.push(f ? [f[0], f[f.length - 1]] : [c[0], c[c.length - 1]]);
    zmin = Math.min(zmin, ends[ci][0]);
    zmax = Math.max(zmax, ends[ci][1]);
  }
  if (!Number.isFinite(zmin) || !(zmax > zmin)) {
    return { ys: new Float64Array(0), mid: new Float64Array(0), lo: new Float64Array(0),
             hi: new Float64Array(0), n: new Int32Array(0), nz: 0 };
  }
  const ys = new Float64Array(nLevels);
  for (let i = 0; i < nLevels; i++) ys[i] = zmin + ((zmax - zmin) * i) / (nLevels - 1);

  const mid = new Float64Array(nLevels).fill(NaN);
  const lo = new Float64Array(nLevels).fill(NaN);
  const hi = new Float64Array(nLevels).fill(NaN);
  const n = new Int32Array(nLevels);
  const buf = new Float64Array(ks.length);

  for (let i = 0; i < nLevels; i++) {
    const y = ys[i];
    let m = 0;
    for (let ci = 0; ci < ks.length; ci++) {
      const c = zs[ci], e = ends[ci];
      if (!c || !e || y < e[0] || y > e[1]) continue;        // outside this column
      let v;
      if (y <= c[0]) v = cols.at(ci, t, 0);                  // below the lowest centre
      else if (y >= c[c.length - 1]) v = cols.at(ci, t, c.length - 1);
      else {
        let a = 0;
        while (a < c.length - 2 && c[a + 1] < y) a++;
        const f = (y - c[a]) / (c[a + 1] - c[a] || 1);
        const v0 = cols.at(ci, t, a), v1 = cols.at(ci, t, a + 1);
        v = Number.isFinite(v0) && Number.isFinite(v1) ? v0 + (v1 - v0) * f
          : Number.isFinite(v0) ? v0 : v1;
      }
      if (Number.isFinite(v)) buf[m++] = v;
    }
    n[i] = m;
    if (!m) continue;
    const s = buf.slice(0, m).sort((a, b) => a - b);
    mid[i] = pct(s, 0.5);
    lo[i] = pct(s, 0.1);
    hi[i] = pct(s, 0.9);
  }
  return { ys, mid, lo, hi, n, nz: nLevels };
}

// ------------------------------------------------------------ diagnostics
/** Potential energy anomaly, phi (J/m3): the work per unit volume needed to
 *  mix the column to uniform density. 0 is fully mixed; it is the standard
 *  single number for "how stratified is this column", and unlike a simple
 *  surface-minus-bottom difference it accounts for where in the column the
 *  density actually sits.
 *
 *      phi = (1/D) * integral( (rho_mean - rho(z)) * g * z dz )
 *
 *  @param rho  (i) -> density of layer i, bed first
 */
export function potentialEnergyAnomaly(z, rho, nz) {
  let m = 0, w = 0;
  for (let i = 0; i < nz; i++) {
    const r = rho(i);
    if (!Number.isFinite(r)) return NaN;
    const h = z[i + 1] - z[i];
    m += r * h; w += h;
  }
  if (!(w > 0)) return NaN;
  const mean = m / w;
  let phi = 0;
  for (let i = 0; i < nz; i++) {
    const h = z[i + 1] - z[i];
    const zc = (z[i] + z[i + 1]) * 0.5 - z[0];      // height above the bed
    phi += (mean - rho(i)) * 9.81 * zc * h;
  }
  return phi / w;
}

/** UNESCO EOS-80 density at atmospheric pressure, kg/m3. Enough for a
 *  stratification diagnostic in 0-40 PSU, -2..40 degC coastal water; it is not
 *  a substitute for the model's own equation of state. */
export function sigmaT(S, T) {
  if (!Number.isFinite(S) || !Number.isFinite(T)) return NaN;
  const rw = 999.842594 + 6.793952e-2 * T - 9.095290e-3 * T * T
    + 1.001685e-4 * T ** 3 - 1.120083e-6 * T ** 4 + 6.536332e-9 * T ** 5;
  const A = 0.824493 - 4.0899e-3 * T + 7.6438e-5 * T * T
    - 8.2467e-7 * T ** 3 + 5.3875e-9 * T ** 4;
  const B = -5.72466e-3 + 1.0227e-4 * T - 1.6546e-6 * T * T;
  return rw + A * S + B * S ** 1.5 + 4.8314e-4 * S * S;
}
