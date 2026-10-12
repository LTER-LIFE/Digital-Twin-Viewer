// Field observations alongside the model.
//
// Observations live in data/observations/, compiled there by obs_ingest.py from
// the DTV observation format (see OBSERVATIONS.md). They belong to no single
// model run: on load, every collection that overlaps the open dataset in space
// and time is picked up, and its variables are matched to the run's variables
// through obs_vocab.json -- the same vocabulary the ingest used, so the two
// sides can never disagree about what a name means or how its units convert.
//
// What a collection IS decides where it is shown. The ingest classified it from
// its sampling, not from its label:
//
//   timeseries / timeseries_profile  stations   -> marker; chart overlay + skill
//   profiles                         casts      -> marker near its time; Vertical panel
//   survey / trajectory              samples    -> map points coloured by value; scatter
//
// Two rules hold throughout, as they do for the CTD comparison this replaces:
// the MODEL is brought to the observation (interpolated in time and depth, the
// measurement is never resampled), and nothing is compared that cannot be: a
// unit that does not convert, a different element ('g AFDM' vs 'mg C'), or a
// datum that is not the model's is reported rather than papered over.

const EARTH_KM = 111.195;

/** Categorical colours for collections, Okabe-Ito order: fixed, never cycled
 *  by position on the map, so a collection keeps its colour between runs. */
export const OBS_COLORS = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#CC79A7', '#D55E00', '#0072B2'];

export const KIND_LABEL = {
  timeseries: 'Time series',
  timeseries_profile: 'Time series of profiles',
  profiles: 'Profiles',
  survey: 'Spatial survey',
  trajectory: 'Moving platform',
  mixed: 'Mixed',
};

const norm = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// ================================================================ vocabulary
export class Vocab {
  constructor(doc) {
    this.doc = doc;
    this.quantities = doc.quantities || {};
    this.units = doc.units || {};
    this.elements = (doc.elements || []).map(norm);
    this._alias = new Map();
    this._std = new Map();
    for (const [qid, q] of Object.entries(this.quantities)) {
      for (const a of q.aliases || []) if (!this._alias.has(norm(a))) this._alias.set(norm(a), qid);
      if (!this._alias.has(norm(qid))) this._alias.set(norm(qid), qid);
      for (const s of q.standard_names || []) if (!this._std.has(s.toLowerCase())) this._std.set(s.toLowerCase(), qid);
    }
  }

  quantity(name, standardName, explicit) {
    if (explicit) return this.quantities[explicit] ? explicit : (this._alias.get(norm(explicit)) || null);
    if (standardName && this._std.has(String(standardName).toLowerCase())) {
      return this._std.get(String(standardName).toLowerCase());
    }
    const n = norm(name);
    if (this._alias.has(n)) return this._alias.get(n);
    const m = n.match(/^([a-z]+?)(\d+m|surface|bottom|avg|mean)$/);
    return m && this._alias.has(m[1]) ? this._alias.get(m[1]) : null;
  }

  /** The same parse as obs_ingest.Vocab.parse_units — keep them in step. */
  parseUnits(u, group) {
    let s = String(u ?? '').trim().toLowerCase()
      .replace(/[µμ]/g, 'u').replace(/\^|\*\*/g, '').replace(/·/g, ' ')
      .replace(/⁻¹/g, '-1').replace(/⁻²/g, '-2').replace(/⁻³/g, '-3')
      .replace(/²/g, '2').replace(/³/g, '3').replace(/ per /g, '/');
    s = s.replace(/\s+/g, ' ');
    const groups = (group && this.units[group]) ? [group] : [];
    for (const g of Object.keys(this.units)) if (!groups.includes(g)) groups.push(g);
    const lookup = (key, element) => {
      for (const g of groups) {
        const spec = this.units[g];
        if (spec.factors && key in spec.factors) return { group: g, factor: spec.factors[key], offset: 0, element, approx: false };
        if (spec.offsets && key in spec.offsets) return { group: g, factor: 1, offset: spec.offsets[key], element, approx: false };
        if (spec.approx && key in spec.approx) return { group: g, factor: spec.approx[key], offset: 0, element, approx: true };
      }
      return null;
    };
    const whole = lookup(s.replace(/ /g, ''), null);
    if (whole) return whole;
    const toks = s.split(' ');
    if (toks.length >= 2) {
      const head = toks[0], rest = toks.slice(1).join(' ');
      const m = rest.match(/^([a-z0-9-]+)(.*)$/);
      if (m) {
        const el = norm(m[1]);
        if (this.elements.includes(el)) {
          return lookup((head + m[2].trim()).replace(/ /g, ''), el.startsWith('chl') ? 'chl' : el);
        }
      }
    }
    return null;
  }

  /** {factor, offset, approx, note} taking `from` to `to`, or null. */
  conversion(from, to, group) {
    const a = this.parseUnits(from, group), b = this.parseUnits(to, group);
    if (!a || !b || a.group !== b.group) return null;
    if (a.element && b.element && a.element !== b.element) return null;
    return {
      factor: a.factor / b.factor,
      offset: (a.offset - b.offset) / b.factor,
      approx: a.approx || b.approx,
      note: (!!a.element !== !!b.element) ? 'element not stated on one side' : null,
    };
  }
}

// ================================================================ locating cells
/** Nearest model cell to a geographic position, fast enough for thousands of
 *  survey samples. The grid is curvilinear, so there is no closed-form
 *  inverse; cells are bucketed on a coarse lat/lon raster and only the
 *  buckets around the query are searched. */
export class CellLocator {
  constructor({ latlon, NX, NY, N, masks, meta }) {
    Object.assign(this, { latlon, NX, NY, N, masks, meta });
    if (!latlon) return;
    let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
    for (let k = 0; k < N; k++) {
      const a = latlon[2 * k], b = latlon[2 * k + 1];
      if (a < la0) la0 = a; if (a > la1) la1 = a;
      if (b < lo0) lo0 = b; if (b > lo1) lo1 = b;
    }
    const cellDeg = (meta.cellKm || 1) / EARTH_KM;
    this.dLat = cellDeg * 2;
    this.dLon = this.dLat / Math.max(0.2, Math.cos(((la0 + la1) / 2) * Math.PI / 180));
    this.la0 = la0; this.lo0 = lo0;
    this.nb = [Math.max(1, Math.ceil((la1 - la0) / this.dLat) + 1),
               Math.max(1, Math.ceil((lo1 - lo0) / this.dLon) + 1)];
    const count = new Int32Array(this.nb[0] * this.nb[1] + 1);
    const bk = new Int32Array(N);
    for (let k = 0; k < N; k++) {
      const b = this._bucket(latlon[2 * k], latlon[2 * k + 1]);
      bk[k] = b;
      count[b + 1]++;
    }
    for (let i = 1; i < count.length; i++) count[i] += count[i - 1];
    this.start = count.slice();
    this.cells = new Int32Array(N);
    const fill = count.slice();
    for (let k = 0; k < N; k++) this.cells[fill[bk[k]]++] = k;
    this.cosLat = Math.cos(((la0 + la1) / 2) * Math.PI / 180);
  }

  _bucket(la, lo) {
    const r = Math.min(this.nb[0] - 1, Math.max(0, Math.floor((la - this.la0) / this.dLat)));
    const c = Math.min(this.nb[1] - 1, Math.max(0, Math.floor((lo - this.lo0) / this.dLon)));
    return r * this.nb[1] + c;
  }

  /** {k, i, j, km, snapKm, land} or null when the position is off the grid.
   *  With `sea`, a station whose own cell is land (a jetty, a harbour gauge)
   *  moves to the nearest sea cell within maxSnapKm, and says how far. */
  nearest(lat, lon, { sea = true, maxSnapKm = 3 } = {}) {
    const { latlon, NX, masks } = this;
    if (!latlon) {
      const { meta, NY } = this;
      if (!(meta.latMax > meta.latMin)) return null;
      const i = Math.round(((lat - meta.latMin) / (meta.latMax - meta.latMin)) * (NY - 1));
      const j = Math.round(((lon - meta.lonMin) / (meta.lonMax - meta.lonMin)) * (NX - 1));
      if (i < 0 || j < 0 || i >= NY || j >= NX) return null;
      return { k: i * NX + j, i, j, km: 0, snapKm: 0, land: !!(masks[i * NX + j] & 1) };
    }
    const r0 = Math.floor((lat - this.la0) / this.dLat), c0 = Math.floor((lon - this.lo0) / this.dLon);
    const dist = (k) => {
      const dy = (latlon[2 * k] - lat) * EARTH_KM;
      const dx = (latlon[2 * k + 1] - lon) * EARTH_KM * this.cosLat;
      return Math.hypot(dx, dy);
    };
    const search = (want, maxRing) => {
      let best = -1, bd = Infinity;
      for (let ring = 0; ring <= maxRing; ring++) {
        for (let r = r0 - ring; r <= r0 + ring; r++) {
          if (r < 0 || r >= this.nb[0]) continue;
          for (let c = c0 - ring; c <= c0 + ring; c++) {
            if (c < 0 || c >= this.nb[1]) continue;
            if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring) continue;
            const b = r * this.nb[1] + c;
            for (let p = this.start[b]; p < this.start[b + 1]; p++) {
              const k = this.cells[p];
              if (want && !want(k)) continue;
              const d = dist(k);
              if (d < bd) { bd = d; best = k; }
            }
          }
        }
        // a ring further out cannot hold anything nearer than this
        if (best >= 0 && bd < ring * this.dLat * EARTH_KM) break;
      }
      return best < 0 ? null : { k: best, km: bd };
    };
    const own = search(null, 2);
    // more than ~1.5 cells from the nearest cell centre: outside the grid
    if (!own || own.km > 1.6 * (this.meta.cellKm || 1)) return null;
    let hit = own, snapKm = 0;
    const isLand = (k) => (masks[k] & 1) !== 0;
    if (sea && isLand(own.k)) {
      const rings = Math.ceil(maxSnapKm / (this.dLat * EARTH_KM)) + 1;
      const s = search((k) => !isLand(k), rings);
      if (s && s.km <= maxSnapKm) { hit = s; snapKm = s.km; }
    }
    return {
      k: hit.k, i: Math.floor(hit.k / NX), j: hit.k % NX, km: hit.km, snapKm,
      land: isLand(hit.k),
    };
  }
}

// ================================================================ statistics
/** Skill of matched pairs. With `anomaly`, both sides lose their own mean
 *  first: two water levels on different datums agree on the tide even when
 *  their zeros differ, and that offset is reported, not hidden. */
export function skill(pairs, { anomaly = false } = {}) {
  const n = pairs.length;
  if (!n) return null;
  let so = 0, sm = 0;
  for (const p of pairs) { so += p.o; sm += p.m; }
  const mo = so / n, mm = sm / n;
  const ao = anomaly ? mo : 0, am = anomaly ? mm : 0;
  let sd = 0, sq = 0, soo = 0, smm = 0, som = 0;
  for (const p of pairs) {
    const o = p.o - ao, m = p.m - am;
    const d = m - o;
    sd += d; sq += d * d;
    soo += (p.o - mo) ** 2; smm += (p.m - mm) ** 2; som += (p.o - mo) * (p.m - mm);
  }
  const r = n >= 3 && soo > 0 && smm > 0 ? som / Math.sqrt(soo * smm) : NaN;
  return { n, bias: sd / n, rmse: Math.sqrt(sq / n), r, meanObs: mo, meanModel: mm,
           offset: anomaly ? mm - mo : null };
}

/** Pair an observed series with the model.
 *
 *  Both sides are instantaneous, so the denser one is sampled at the sparser
 *  one's times rather than averaged: an hourly record against daily model
 *  snapshots is compared at the snapshot times (nearest observation within
 *  tolerance), a monthly bottle sample against hourly output at the sample
 *  time (model interpolated linearly between the two steps around it).
 *
 *  tau: observation times in fractional model steps; o: values in MODEL units;
 *  modelAt(t): model value at integer step t, NaN where dry or land.
 */
export function pairSeries(tau, o, modelAt, { nSteps, stepS, obsDtS, tolS }) {
  const out = [];
  if (!tau.length) return out;
  const denser = obsDtS && obsDtS < stepS;
  if (denser) {
    const tol = (tolS ?? Math.min(stepS / 2, Math.max(obsDtS, 600))) / stepS;
    let i = 0;
    for (let t = 0; t < nSteps; t++) {
      while (i < tau.length - 1 && tau[i + 1] <= t) i++;
      let best = -1, bd = Infinity;
      for (const c of [i, i + 1]) {
        if (c < 0 || c >= tau.length || !Number.isFinite(o[c])) continue;
        const d = Math.abs(tau[c] - t);
        if (d < bd) { bd = d; best = c; }
      }
      if (best < 0 || bd > tol) continue;
      const m = modelAt(t);
      if (Number.isFinite(m)) out.push({ t, o: o[best], m, i: best });
    }
  } else {
    for (let i = 0; i < tau.length; i++) {
      const x = tau[i];
      if (!(x >= 0 && x <= nSteps - 1) || !Number.isFinite(o[i])) continue;
      const a = Math.floor(x), b = Math.min(a + 1, nSteps - 1), f = x - a;
      const ma = modelAt(a), mb = f > 0 ? modelAt(b) : ma;
      let m;
      if (Number.isFinite(ma) && Number.isFinite(mb)) m = ma + (mb - ma) * f;
      else continue;                              // dry on either side: no pair
      out.push({ t: x, o: o[i], m, i });
    }
  }
  return out;
}

// ================================================================ store
export class ObsStore {
  /** ctx: {base, DATA, DS, meta, NDAYS, STEP_DAYS, START_MS, locator} */
  constructor(ctx) {
    this.ctx = ctx;
    this.vocab = null;
    this.collections = [];
    this.stations = [];
    this._cache = new Map();          // key -> data | Promise
    this.onUpdate = () => {};
    this.error = null;
  }

  get ready() { return this.collections.length > 0; }
  get stepS() { return (this.ctx.STEP_DAYS || 1) * 86400; }

  /** Model step (fractional) of an epoch time in ms. */
  tauOf(ms) { return (ms - this.ctx.START_MS) / (this.stepS * 1000); }
  msOfTau(tau) { return this.ctx.START_MS + tau * this.stepS * 1000; }

  async load() {
    const { base, meta } = this.ctx;
    try {
      const vr = await fetch('./obs_vocab.json', { cache: 'no-cache' });
      this.vocab = new Vocab(vr.ok ? await vr.json() : {});
    } catch { this.vocab = new Vocab({}); }

    const runStart = this.ctx.START_MS;
    const runEnd = this.msOfTau(this.ctx.NDAYS - 1);
    this.span = [runStart, runEnd];
    let index = [];
    try {
      const r = await fetch(`${base}/index.json`, { cache: 'no-cache' });
      if (r.ok) index = (await r.json()).collections || [];
    } catch { /* no store yet */ }
    this.available = index.length;

    const overlapBox = (b) => !b || !(meta.latMax > meta.latMin) || !(
      b[1] < meta.latMin || b[0] > meta.latMax || b[3] < meta.lonMin || b[2] > meta.lonMax);
    let color = 0;
    for (const c of index) {
      if (!overlapBox(c.bbox) || !c.time) continue;
      const t0 = Date.parse(c.time[0]), t1 = Date.parse(c.time[1]);
      // a survey is worth showing for the year either side -- it is the map
      // that matters, and the run may sit between two campaigns
      const pad = (c.kind === 'survey' ? 365 : c.kind === 'profiles' ? 3 : 0) * 86400000;
      const inTime = !(t1 + pad < runStart || t0 - pad > runEnd);
      let doc;
      try {
        const r = await fetch(`${base}/${c.path}`, { cache: 'no-cache' });
        if (!r.ok) continue;
        doc = await r.json();
      } catch { continue; }
      this._add(doc, c.color || OBS_COLORS[color++ % OBS_COLORS.length], inTime);
    }
    return this.ready;
  }

  _add(doc, color, inTime) {
    const coll = {
      id: doc.id, doc, title: doc.title || doc.id, kind: doc.kind, color,
      inTime, show: true,
      colorBy: null,                       // survey: variable key, or null = collection colour
      window: doc.kind === 'survey' ? 'window' : null,
      windowDays: (doc.comparison && doc.comparison.window_days)
        || (doc.kind === 'survey' ? 60 : doc.kind === 'profiles' ? 3 : 0),
    };
    this.collections.push(coll);
    if (doc.kind === 'survey' || doc.kind === 'profiles' || doc.kind === 'trajectory') return coll;
    for (const s of doc.stations || []) {
      const cell = this.ctx.locator.nearest(s.lat, s.lon, { sea: true });
      if (!cell) continue;                 // inside the collection's box, outside this grid
      const st = {
        key: `${doc.id}/${s.id}`, coll, id: s.id, name: s.name || s.id, lat: s.lat, lon: s.lon,
        kind: s.kind, cadence: s.cadence, dtS: s.dtMedianS, depths: s.depths, vars: s.vars,
        years: s.years, file: s.file, t0: s.t0, t1: s.t1, cell,
      };
      this.stations.push(st);
    }
    return coll;
  }

  // ------------------------------------------------------------ matching
  /** Quantity of a model variable descriptor. A '-avg' key is the same
   *  quantity, depth-averaged. */
  modelQuantity(desc) {
    if (!desc) return null;
    const key = String(desc.key || '').replace(/-avg$/i, '');
    return this.vocab.quantity(key) || this.vocab.quantity(desc.name || '')
      || this.vocab.quantity(desc.long || '');
  }

  /** The observed variable in `coll` that answers to this model variable, with
   *  the conversion into the model's units — or {key, why} when one exists
   *  but cannot be compared, or null when there is none. */
  match(coll, desc, special) {
    const vars = coll.doc.variables || {};
    const q = special || this.modelQuantity(desc);
    let best = null;
    for (const [k, v] of Object.entries(vars)) {
      const explicit = desc && (v.model || []).map((x) => String(x).toLowerCase())
        .includes(String(desc.key).toLowerCase());
      if (!explicit && (!q || v.quantity !== q)) continue;
      const qd = this.vocab.quantities[v.quantity] || {};
      const toUnits = special ? (qd.units || v.units) : desc.units;
      const conv = this.vocab.conversion(v.units, toUnits, qd.group);
      if (!conv && !(explicit && (!v.units || !toUnits))) {
        best = best || { key: k, var: v, why: `units ${v.units || '?'} do not convert to ${toUnits || '?'}` };
        continue;
      }
      return { key: k, var: v, conv: conv || { factor: 1, offset: 0, approx: false, note: 'declared match, units unchecked' } };
    }
    return best;
  }

  /** Stations whose collection has a comparable variable. */
  stationsFor(desc, special) {
    const out = [];
    for (const st of this.stations) {
      if (!st.coll.show) continue;
      const m = this.match(st.coll, desc, special);
      if (m && m.conv && st.vars && st.vars[m.key]) out.push({ st, m });
    }
    return out;
  }

  // ------------------------------------------------------------ loading
  _get(key, loader) {
    const hit = this._cache.get(key);
    if (hit && !(hit instanceof Promise)) return hit;
    if (!hit) {
      const p = loader().then((v) => { this._cache.set(key, v); this.onUpdate(); return v; },
        (e) => { this._cache.delete(key); console.warn('observation load failed', key, e); });
      this._cache.set(key, p);
    }
    return null;
  }

  _years(extraDays = 0) {
    const pad = extraDays * 86400000;
    const y0 = new Date(this.span[0] - pad).getUTCFullYear();
    const y1 = new Date(this.span[1] + pad).getUTCFullYear();
    const ys = [];
    for (let y = y0; y <= y1; y++) ys.push(y);
    return ys;
  }

  /** A station's record of one variable over the run, or null while it loads.
   *  -> {tau, v (observed units), z, f, n} restricted to the run (+/- pad). */
  series(st, key) {
    const years = (st.vars[key] && st.vars[key].years) || st.years || [];
    const want = this._years(2).filter((y) => years.includes(y));
    const files = want.map((y) => this._get(`ts|${st.coll.id}|${st.file}|${y}`, async () => {
      const r = await fetch(`${this.ctx.base}/${st.coll.id}/${st.file}/${y}.json`);
      if (!r.ok) throw new Error(`${r.status}`);
      return r.json();
    }));
    if (files.some((f) => f === null)) return null;
    const tau = [], v = [], z = [], f = [];
    const lo = -2, hi = this.ctx.NDAYS + 1;
    for (const body of files) {
      const e = body.vars[key];
      if (!e) continue;
      const y0 = Date.UTC(body.year, 0, 1);
      for (let i = 0; i < e.t.length; i++) {
        const x = this.tauOf(y0 + e.t[i] * 60000);
        if (x < lo || x > hi || e.v[i] === null) continue;
        tau.push(x); v.push(e.v[i]);
        z.push(e.z ? e.z[i] : NaN);
        f.push(e.f ? e.f[i] : 0);
      }
    }
    return { tau: Float64Array.from(tau), v: Float64Array.from(v), z: Float64Array.from(z),
             f: Int8Array.from(f), n: tau.length };
  }

  /** Casts of a profiles collection within +/-days of step t and km of any of
   *  the given positions, nearest first, or null while loading. */
  profilesNear(coll, t, pts, { km, days }) {
    const years = Object.keys((coll.doc.profiles && coll.doc.profiles.years) || {}).map(Number);
    const want = this._years(days + 1).filter((y) => years.includes(y));
    const parts = want.map((y) => this._get(`prof|${coll.id}|${y}`, async () => {
      const r = await fetch(`${this.ctx.base}/${coll.id}/profiles/${y}.json`);
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      for (const c of j.casts) c.ms = Date.parse(c.time);
      return j.casts;
    }));
    if (parts.some((p) => p === null)) return null;
    const casts = parts.flat();
    const out = [];
    const maxSteps = days / (this.ctx.STEP_DAYS || 1);
    for (const c of casts) {
      const ms = c.ms ?? Date.parse(c.time);
      const tau = this.tauOf(ms);
      if (Math.abs(tau - t) > maxSteps) continue;
      let best = Infinity;
      for (const [la, lo] of pts) {
        const dy = (c.lat - la) * EARTH_KM;
        const dx = (c.lon - lo) * EARTH_KM * Math.cos((la * Math.PI) / 180);
        best = Math.min(best, Math.hypot(dx, dy));
        if (best <= km) break;
      }
      if (best <= km) out.push({ ...c, km: best, tau });
    }
    out.sort((a, b) => a.km - b.km);
    return out;
  }

  /** All casts of a profiles collection within +/-days of step t (for markers). */
  castsAround(coll, t, days) {
    return this.profilesNear(coll, t, [[0, 0]], { km: Infinity, days });
  }

  /** Survey samples to show at step t, per the collection's window setting,
   *  or null while loading. Each sample gets its model cell once. */
  points(coll, t) {
    const years = Object.keys((coll.doc.points && coll.doc.points.years) || {}).map(Number);
    if (!years.length) return [];
    const now = this.msOfTau(t);
    const yNow = new Date(now).getUTCFullYear();
    let want;
    if (coll.window === 'all') want = years;
    else if (coll.window === 'year') {
      // the campaign of the run's year, or the nearest one to it
      const best = years.reduce((a, y) => (Math.abs(y - yNow) < Math.abs(a - yNow) ? y : a), years[0]);
      want = [best];
    } else {
      const d = coll.windowDays * 86400000;
      want = years.filter((y) => Date.UTC(y + 1, 0, 1) >= now - d && Date.UTC(y, 0, 1) <= now + d);
    }
    const parts = want.map((y) => this._get(`pts|${coll.id}|${y}`, async () => {
      const r = await fetch(`${this.ctx.base}/${coll.id}/points/${y}.json`);
      if (!r.ok) throw new Error(`${r.status}`);
      const j = await r.json();
      const y0 = Date.UTC(j.year, 0, 1);
      const n = j.station.length;
      const rows = new Array(n);
      for (let i = 0; i < n; i++) {
        const cell = this.ctx.locator.nearest(j.lat[i], j.lon[i], { sea: false });
        rows[i] = { i, year: j.year, station: j.station[i], lat: j.lat[i], lon: j.lon[i],
                    ms: y0 + j.t[i] * 60000, z: j.z ? j.z[i] : null, cell, body: j };
      }
      return rows;
    }));
    if (parts.some((p) => p === null)) return null;
    let rows = parts.flat().filter((p) => p.cell);
    if (coll.window === 'window') {
      const d = coll.windowDays * 86400000;
      rows = rows.filter((p) => Math.abs(p.ms - now) <= d);
    }
    return rows;
  }

  /** Value of variable `key` at a survey sample (observed units), or null. */
  static pointValue(p, key) {
    const col = p.body.v[key];
    if (!col) return null;
    const v = col[p.i];
    return v === null || v === undefined ? null : v;
  }

  /** Display range of a survey variable over what is loaded: 2nd-98th
   *  percentile, the same robust first look the model drape uses. */
  pointRange(coll, key) {
    const vals = [];
    for (const [k, v] of this._cache) {
      if (!k.startsWith(`pts|${coll.id}|`) || v instanceof Promise || !v) continue;
      for (const p of v) {
        const x = ObsStore.pointValue(p, key);
        if (Number.isFinite(x)) vals.push(x);
      }
    }
    if (!vals.length) return null;
    vals.sort((a, b) => a - b);
    const q = (f) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(f * (vals.length - 1))))];
    return [q(0.02), q(0.98)];
  }
}

/** Linear interpolation of (zs, vs) at z; zs ascending, no extrapolation. */
export function interpProfile(zs, vs, z) {
  if (!zs.length || z < zs[0] || z > zs[zs.length - 1]) return NaN;
  let i = 0;
  while (i < zs.length - 2 && zs[i + 1] < z) i++;
  const f = (z - zs[i]) / (zs[i + 1] - zs[i] || 1);
  const a = vs[i], b = vs[i + 1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.isFinite(a) ? a : b;
  return a + (b - a) * f;
}

/** Mean model - observation over the depths a cast sampled. The MODEL is
 *  interpolated onto the observed depths; depths it does not reach are
 *  skipped, and the count says how many were actually compared. */
export function profileBias(castZ, castV, modelZ, modelV) {
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < castZ.length; i++) {
    const o = castV[i];
    if (o === null || !Number.isFinite(o)) continue;
    const m = interpProfile(modelZ, modelV, castZ[i]);
    if (!Number.isFinite(m)) continue;
    const d = m - o;
    sum += d; sq += d * d; n++;
  }
  return n ? { n, bias: sum / n, rmse: Math.sqrt(sq / n) } : null;
}

