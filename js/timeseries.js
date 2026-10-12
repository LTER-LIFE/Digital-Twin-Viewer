// Extraction of timeseries, profiles and Hovmoller rasters from the arrays the
// viewer already holds in memory. No server round-trip is involved: elev.bin is
// resident for the whole run, and a variable's array is fetched once when it is
// selected, so a 365-step series over an arbitrary polygon is array indexing.
//
// The one thing this module is strict about is VALIDITY. Two separate effects
// make a raw array read untrustworthy:
//
//   1. The pipeline nearest-fills masked cells so bilinear texture sampling has
//      no seam at the coast. A land cell therefore holds some neighbour's
//      number, not "no data".
//   2. elev.bin stores dry cells as the nearest wet level clamped just BELOW the
//      bed, so shorelines interpolate smoothly. Plotting that as a water level
//      would draw a curve that tracks the bathymetry, not the tide.
//
// So every read here is gated on (not land) and (wet at this step) — the same
// test the shaders use — and anything failing it becomes NaN, which the chart
// renders as a break in the line rather than a value.

const EPS = 0.005;   // m of water depth below which a cell counts as dry

/** Build a raw -> physical-units decoder for a variable descriptor.
 *  Old datasets store uint8 normalised over the 1-99 percentile range; new ones
 *  store uint16 over the true data range. `bytes` tells them apart. */
export function makeDecoder(desc) {
  if (desc.bytes === 2) {
    const lo = desc.dataMin, span = (desc.dataMax - desc.dataMin) || 1;
    return (raw) => lo + (raw / 65535) * span;
  }
  const lo = desc.lo, span = (desc.hi - desc.lo) || 1;
  return (raw) => lo + (raw / 255) * span;
}

/** Quantisation step of a variable in its own units — what the last digit of a
 *  reported value is actually worth. */
export function quantum(desc) {
  return desc.bytes === 2
    ? ((desc.dataMax - desc.dataMin) || 1) / 65535
    : ((desc.hi - desc.lo) || 1) / 255;
}

export class Extractor {
  /** @param ctx {{NX,NY,N,NDAYS,terrain,masks,elevI16,latlon,cellKm}} */
  constructor(ctx) {
    this.ctx = ctx;
    this._cells = new Map();
    this._pRange = new Map();     // selection id+geometry -> {ks, dist}
  }

  // ------------------------------------------------------------- geometry
  /** Cells covered by a selection, with along-path distance in km.
   *  point: one cell · transect: DDA walk · area: polygon scan. */
  cells(sel) {
    const key = sel.type + ':' + sel.pts.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(';');
    const hit = this._cells.get(sel.id);
    if (hit && hit.key === key) return hit;

    const { NX, NY } = this.ctx;
    const clampI = (v) => Math.min(Math.max(Math.round(v), 0), NY - 1);
    const clampJ = (v) => Math.min(Math.max(Math.round(v), 0), NX - 1);
    let ks = [], ij = [], dist = null;

    if (sel.type === 'point' || sel.pts.length === 1) {
      const i = clampI(sel.pts[0][0]), j = clampJ(sel.pts[0][1]);
      ij = [[i, j]];
      dist = [0];
    } else if (sel.type === 'transect') {
      // Sample each segment at half-cell steps and drop repeats, so the walk
      // never skips a cell on a shallow diagonal.
      //
      // Distance is accumulated along the SAMPLE PATH — the straight line the
      // user drew — and each cell records the arc length where it was picked
      // up. Summing centre-to-centre distances between the selected cells
      // instead would measure the staircase, which on a 60:100 diagonal is 23 %
      // longer than the section actually is.
      const d = [];
      let last = -1, arc = 0;
      let pi = sel.pts[0][0], pj = sel.pts[0][1];
      for (let s = 0; s < sel.pts.length - 1; s++) {
        const [i0, j0] = sel.pts[s], [i1, j1] = sel.pts[s + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(i1 - i0, j1 - j0) * 2));
        for (let t = 0; t <= n; t++) {
          const f = t / n;
          const fi = i0 + (i1 - i0) * f, fj = j0 + (j1 - j0) * f;
          arc += this.spanKm(pi, pj, fi, fj);
          pi = fi; pj = fj;
          const i = clampI(fi), j = clampJ(fj);
          const k = i * NX + j;
          if (k !== last) { ij.push([i, j]); d.push(arc); last = k; }
        }
      }
      dist = d;
    } else {
      // area: scan the bounding box, keep cell centres inside the polygon
      let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
      for (const [i, j] of sel.pts) {
        i0 = Math.min(i0, i); i1 = Math.max(i1, i);
        j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
      i0 = clampI(Math.floor(i0)); i1 = clampI(Math.ceil(i1));
      j0 = clampJ(Math.floor(j0)); j1 = clampJ(Math.ceil(j1));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          if (pointInPoly(i, j, sel.pts)) ij.push([i, j]);
        }
      }
      // a polygon thinner than a cell would select nothing; fall back to its
      // vertices so a stray click still produces something readable
      if (!ij.length) ij = sel.pts.map(([i, j]) => [clampI(i), clampJ(j)]);
    }

    ks = new Int32Array(ij.length);
    for (let n = 0; n < ij.length; n++) ks[n] = ij[n][0] * NX + ij[n][1];
    // an area has no meaningful along-path distance; zeros say so plainly
    const out = { key, ks, ij, dist: Float64Array.from(dist || new Array(ij.length).fill(0)) };
    this._cells.set(sel.id, out);
    return out;
  }

  /** Distance in km between two fractional grid positions — true geodesic when
   *  the dataset carries per-cell coordinates, grid distance otherwise.
   *  Fractional, because the transect walk measures along the drawn line rather
   *  than between cell centres. */
  spanKm(fi0, fj0, fi1, fj1) {
    const { latlon, cellKm } = this.ctx;
    if (latlon) {
      const a = this.latLonAt(fi0, fj0), b = this.latLonAt(fi1, fj1);
      return haversineKm(a[0], a[1], b[0], b[1]);
    }
    return Math.hypot(fi1 - fi0, fj1 - fj0) * cellKm;
  }

  /** Bilinear (lat, lon) at a fractional (row, col). The grid may be
   *  curvilinear and rotated, so both depend on row AND column. */
  latLonAt(fi, fj) {
    const { latlon, NX, NY } = this.ctx;
    const i0 = Math.min(Math.max(Math.floor(fi), 0), NY - 1);
    const j0 = Math.min(Math.max(Math.floor(fj), 0), NX - 1);
    const i1 = Math.min(i0 + 1, NY - 1), j1 = Math.min(j0 + 1, NX - 1);
    const ti = Math.min(Math.max(fi - i0, 0), 1), tj = Math.min(Math.max(fj - j0, 0), 1);
    const at = (r, c, o) => latlon[2 * (r * NX + c) + o];
    const mix = (o) =>
      (at(i0, j0, o) * (1 - tj) + at(i0, j1, o) * tj) * (1 - ti) +
      (at(i1, j0, o) * (1 - tj) + at(i1, j1, o) * tj) * ti;
    return [mix(0), mix(1)];
  }

  // ------------------------------------------------------------- validity
  isLand(k) { return (this.ctx.masks[k] & 1) !== 0; }

  levelAt(k, t) { return this.ctx.elevI16[t * this.ctx.N + k] * 0.01; }

  depthAt(k, t) { return this.levelAt(k, t) - this.ctx.terrain[k]; }

  isWet(k, t) { return !this.isLand(k) && this.depthAt(k, t) > EPS; }

  // -------------------------------------------------------------- sources
  /**
   * One value for one cell at one step, or NaN where there is no data.
   * @param src {{kind:'variable'|'level'|'depth'|'bed', desc?, arr?, decode?}}
   */
  valueAt(src, k, t) {
    if (src.kind === 'bed') return this.ctx.terrain[k];
    if (this.isLand(k)) return NaN;
    if (src.kind === 'level' || src.kind === 'depth') {
      // a dry cell's stored level is a fill clamped below the bed, not a level
      if (!this.isWet(k, t)) return NaN;
      return src.kind === 'level' ? this.levelAt(k, t) : this.depthAt(k, t);
    }
    if (!this.isWet(k, t)) return NaN;
    const f = src.desc.static ? 0 : Math.min(t, src.desc.nFrames - 1);
    return src.decode(src.arr[f * this.ctx.N + k]);
  }

  // -------------------------------------------------------------- series
  /**
   * Timeseries over a selection.
   * @returns {{ys:Float64Array, lo:Float64Array, hi:Float64Array, n:Int32Array,
   *            wetFrac:Float64Array}}  ys is NaN where nothing valid was found.
   */
  series(sel, src, stat = 'mean') {
    const { NDAYS } = this.ctx;
    const { ks } = this.cells(sel);
    const ys = new Float64Array(NDAYS).fill(NaN);
    const lo = new Float64Array(NDAYS).fill(NaN);
    const hi = new Float64Array(NDAYS).fill(NaN);
    const n = new Int32Array(NDAYS);
    const wetFrac = new Float64Array(NDAYS);
    const buf = new Float64Array(ks.length);

    for (let t = 0; t < NDAYS; t++) {
      let m = 0, wet = 0;
      for (let c = 0; c < ks.length; c++) {
        const k = ks[c];
        if (!this.isLand(k) && this.isWet(k, t)) wet++;
        const v = this.valueAt(src, k, t);
        if (Number.isFinite(v)) buf[m++] = v;
      }
      n[t] = m;
      wetFrac[t] = ks.length ? wet / ks.length : 0;
      if (!m) continue;
      const sub = buf.subarray(0, m);
      ys[t] = reduce(sub, stat);
      if (m > 2) {
        const sorted = Float64Array.from(sub).sort();
        lo[t] = percentile(sorted, 0.10);
        hi[t] = percentile(sorted, 0.90);
      }
    }
    return { ys, lo, hi, n, wetFrac, nCells: ks.length };
  }

  // ------------------------------------------------------------- profiles
  /** Bed elevation, water level and variable value along a transect at step t. */
  profile(sel, src, t) {
    const { ks, dist } = this.cells(sel);
    const bed = new Float64Array(ks.length);
    const lvl = new Float64Array(ks.length).fill(NaN);
    const val = new Float64Array(ks.length).fill(NaN);
    for (let c = 0; c < ks.length; c++) {
      const k = ks[c];
      bed[c] = this.ctx.terrain[k];
      if (this.isWet(k, t)) lvl[c] = this.levelAt(k, t);
      if (src) val[c] = this.valueAt(src, k, t);
    }
    return { dist, bed, lvl, val, ks };
  }

  /** distance x time raster for a transect: values[t*nx + c]. */
  hovmoller(sel, src) {
    const { NDAYS } = this.ctx;
    const { ks, dist } = this.cells(sel);
    const values = new Float64Array(ks.length * NDAYS);
    for (let t = 0; t < NDAYS; t++) {
      for (let c = 0; c < ks.length; c++) values[t * ks.length + c] = this.valueAt(src, ks[c], t);
    }
    return { values, nx: ks.length, ny: NDAYS, dist };
  }

  /** Drop cached cell walks — call when a selection's geometry changes. */
  /** Fixed elevation range for a transect's cross-section: the bed it crosses,
   *  plus every water level the run will ever draw on it.
   *
   *  A full pass over (cells x steps), so it is cached against the same
   *  geometry key as the cell walk and recomputed only when the transect moves.
   */
  profileRange(sel) {
    const cells = this.cells(sel);
    const hit = this._pRange.get(sel.id);
    if (hit && hit.key === cells.key) return hit;

    const { ks } = cells;
    const { terrain, NDAYS } = this.ctx;
    let lo = Infinity, hi = -Infinity;
    for (let c = 0; c < ks.length; c++) {
      const h = terrain[ks[c]];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    for (let t = 0; t < NDAYS; t++) {
      for (let c = 0; c < ks.length; c++) {
        const k = ks[c];
        if (!this.isWet(k, t)) continue;
        const v = this.levelAt(k, t);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    // a transect that is land end to end has no span to draw
    if (!(lo < hi)) { lo -= 1; hi += 1; }

    const out = { key: cells.key, lo, hi };
    this._pRange.set(sel.id, out);
    return out;
  }

  invalidate(id) {
    if (id === undefined) { this._cells.clear(); this._pRange.clear(); }
    else { this._cells.delete(id); this._pRange.delete(id); }
  }
}

// ------------------------------------------------------------------ maths
function reduce(a, stat) {
  const m = a.length;
  if (stat === 'min') { let v = Infinity; for (let i = 0; i < m; i++) v = Math.min(v, a[i]); return v; }
  if (stat === 'max') { let v = -Infinity; for (let i = 0; i < m; i++) v = Math.max(v, a[i]); return v; }
  let s = 0;
  for (let i = 0; i < m; i++) s += a[i];
  const mean = s / m;
  if (stat === 'mean') return mean;
  if (stat === 'std') {
    let q = 0;
    for (let i = 0; i < m; i++) { const d = a[i] - mean; q += d * d; }
    // sample standard deviation; a single cell has no spread to report
    return m > 1 ? Math.sqrt(q / (m - 1)) : 0;
  }
  const sorted = Float64Array.from(a).sort();
  return percentile(sorted, 0.5);
}

function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  const x = p * (n - 1);
  const i = Math.floor(x), f = x - i;
  return i + 1 < n ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

function pointInPoly(i, j, pts) {
  let inside = false;
  for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
    const [ia, ja] = pts[a], [ib, jb] = pts[b];
    if ((ia > i) !== (ib > i) && j < ((jb - ja) * (i - ia)) / (ib - ia || 1e-12) + ja) inside = !inside;
  }
  return inside;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
