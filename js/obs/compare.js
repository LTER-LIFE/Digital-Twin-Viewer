// Model against observation: which stations, casts and samples belong beside
// a selection, how each is paired with the model, and the skill lines that
// summarise it. The model is always brought to the observation — interpolated
// in time, and in depth on the Vertical panel — never the reverse.

import { meta, NDAYS, STEP_DAYS, DATUM, LEVEL_UNIT, terrain } from '../core/dataset.js';
import { haversineKm, latLonOfCell } from '../core/geo.js';
import { ObsStore, pairSeries, skill, profileBias } from '../observations.js';
import { depthProfile } from '../vertical.js';
import { $, fmtNum, escapeHtml } from '../util.js';
import { extractor, columns, locator, obs } from '../features/services.js';
import { stepIndex } from '../features/time.js';
import { varState, layerLabel, currentSource } from '../features/variables.js';
import { columnsFor } from '../dock/vertical.js';

// How far a measurement may be from a model column and still be set beside
// it. Three cells -- 16 km on the 5.3 km shelf grid, the window the CTD
// comparison was built with -- but never less than 1.5 km, so a station on the
// 500 m Wadden Sea grid still finds the column it stands in.
export const OBS_KM = Math.max(1.5, 3 * (meta.cellKm || 1));
export const OBS_PROFILE_DAYS = 3;
const OBS_PROFILE_MAX = 3, OBS_STATION_MAX = 3;
export const STEP_S = STEP_DAYS * 86400;
export const sgn = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v) < 0.01 && v !== 0 ? Math.abs(v).toFixed(3) : fmtNum(Math.abs(v))}`;

/** "bias +0.51" -- or, for two levels on different datums, the offset
 *  between their means, since an anomaly's own bias is zero by construction. */
export const biasText = (s, anomaly) => (anomaly
  ? `offset <b>${sgn(s.offset)}</b>` : `bias <b>${sgn(s.bias)}</b>`);

/** What observations are compared against: the variable on screen, or --
 *  with none -- the water level (or depth) the timeseries panel then shows. */
export function obsTarget() {
  if (varState) return { desc: varState, special: null, units: varState.units || '', key: varState.key };
  if ($('ser-depth').checked && !$('ser-level').checked) {
    return { desc: null, special: 'water_depth', units: 'm', key: 'depth' };
  }
  return { desc: null, special: 'water_level', units: LEVEL_UNIT, key: 'level' };
}
export const LEVEL_TARGET = { desc: null, special: 'water_level', units: LEVEL_UNIT, key: 'level' };

/** Model value at a cell and integer step, for whatever the target is. */
function modelAtCell(target, k, t) {
  if (target.special === 'water_level') return extractor.valueAt({ kind: 'level' }, k, t);
  if (target.special === 'water_depth') return extractor.valueAt({ kind: 'depth' }, k, t);
  return extractor.valueAt(currentSource(), k, t);
}

/** The model at a fractional step; where the cell is dry at that moment, the
 *  nearest wet step within `reach` steps -- a benthic sample taken on foot at
 *  low water is still a sample of that flat. Returns [value, steps moved]. */
export function modelNearWet(target, k, x, reach) {
  const a = Math.floor(x), b = Math.min(a + 1, NDAYS - 1), f = x - a;
  const ma = modelAtCell(target, k, a), mb = f > 0 ? modelAtCell(target, k, b) : ma;
  if (Number.isFinite(ma) && Number.isFinite(mb)) return [ma + (mb - ma) * f, 0];
  for (let d = 1; d <= reach; d++) {
    for (const t of [Math.round(x) - d, Math.round(x) + d]) {
      if (t < 0 || t >= NDAYS) continue;
      const m = modelAtCell(target, k, t);
      if (Number.isFinite(m)) return [m, d];
    }
  }
  return [NaN, 0];
}

/** An observed level on a datum the model does not share is compared as an
 *  anomaly -- each about its own mean -- and the offset is reported, because
 *  an offset between datums is not a model error. */
const datumDiffers = (m) => !!(m && m.var && m.var.quantity === 'water_level'
  && m.var.datum && m.var.datum !== DATUM);

function comparisonNotes(st, m, target) {
  const n = [];
  if (st.cell.snapKm > 0.05) n.push(`station ${Math.round(st.cell.snapKm * 1000)} m from its sea cell`);
  if (target.desc) {
    const l = layerLabel(target.desc);
    const vk = st.coll.doc.vertical;
    const d = st.depths && st.depths.length ? st.depths.map((x) => fmtNum(x)).join(', ') : null;
    const lv = m.var.level && m.var.level !== 'profile' ? m.var.level.replace('_', ' ') : null;
    if (d && vk && vk.kind === 'depth') n.push(`obs at ${d} m depth vs model ${l || '2-D field'}`);
    else if (d && vk && vk.kind === 'elevation') n.push(`obs at ${d} m ${vk.datum || ''} vs model ${l || '2-D field'}`);
    else if (lv) n.push(`obs ${lv} vs model ${l || '2-D field'}`);
    else if (l) n.push(`model ${l}`);
  }
  if (m.conv.factor !== 1 || m.conv.offset) n.push(`converted from ${m.var.units}`);
  if (m.conv.approx) n.push('approximate unit conversion');
  if (m.conv.note) n.push(m.conv.note);
  if (st.coll.doc.timePrecision === 'day') n.push('obs dated to the day');
  n.push(st.dtS && st.dtS < STEP_S ? 'paired at model times' : 'model interpolated to obs times');
  return n;
}

/** Matched pairs per station, keyed station|variable|target. Cleared whenever
 *  the observation set or its display changes (obsChanged). */
export const pairCache = new Map();
/** Matched pairs at one station, cached: the observations, their conversion
 *  and the model at that cell are all fixed for a run. Null while loading. */
export function stationPairs(st, m, target) {
  const key = `${st.key}|${m.key}|${target.key}`;
  if (pairCache.has(key)) return pairCache.get(key);
  const s = obs.series(st, m.key);
  if (!s) return null;
  const o = new Float64Array(s.n);
  for (let i = 0; i < s.n; i++) o[i] = s.v[i] * m.conv.factor + m.conv.offset;
  // below a detection limit (flag 2) or above a range (3): drawn, never
  // scored -- the number is a bound, not a measurement
  const tau = [], ov = [];
  for (let i = 0; i < s.n; i++) if (s.f[i] < 2) { tau.push(s.tau[i]); ov.push(o[i]); }
  const pairs = pairSeries(tau, ov, (t) => modelAtCell(target, st.cell.k, t),
    { nSteps: NDAYS, stepS: STEP_S, obsDtS: st.dtS });
  const anomaly = datumDiffers(m);
  const stats = skill(pairs, { anomaly });
  const notes = comparisonNotes(st, m, target);
  if (anomaly && stats) {
    notes.unshift(`compared as anomalies — obs on ${m.var.datum}, model datum`
      + ` ${DATUM ? DATUM : 'not stated'}`);
  }
  const res = { series: s, o, pairs, stats, notes, anomaly };
  if (pairCache.size > 400) pairCache.clear();
  pairCache.set(key, res);
  return res;
}

// ---------------------------------------------------------------- stations
/** Stations to set beside one selection: the one it was made from, those
 *  within OBS_KM of a point, those whose cell lies inside an area. */
export function obsStationsFor(sel, target) {
  if (!obs.ready || !$('ser-obs').checked || sel.type === 'transect') return [];
  const cand = obs.stationsFor(target.desc, target.special);
  if (!cand.length) return [];
  const cells = extractor.cells(sel);
  const out = [];
  if (sel.type === 'area') {
    const inside = new Set(cells.ks);
    for (const c of cand) if (inside.has(c.st.cell.k)) out.push({ ...c, km: 0 });
  } else {
    const ll = latLonOfCell(cells.ks[0]);
    for (const c of cand) {
      const own = c.st.key === sel.obsKey;
      const km = own ? 0 : (ll ? haversineKm(ll[0], ll[1], c.st.lat, c.st.lon) : Infinity);
      if (own || km <= OBS_KM) out.push({ ...c, km });
    }
  }
  out.sort((a, b) => a.km - b.km);
  return out.slice(0, sel.type === 'area' ? 12 : OBS_STATION_MAX);
}

/** A station's record as a chart series: dashed when continuous (the same
 *  convention as a measured profile), rings when it is a set of samples. */
export function pushObsSeries(list, sel, target) {
  for (const a of obsStationsFor(sel, target)) {
    const r = stationPairs(a.st, a.m, target);
    if (!r) continue;                              // loading; onUpdate redraws
    const s = r.series;
    const cont = a.st.cadence === 'continuous';
    const gap = cont ? (3 * Math.max(a.st.dtS || STEP_S, 1)) / STEP_S : Infinity;
    const xs = [], ys = [];
    for (let i = 0; i < s.n; i++) {
      if (i && s.tau[i] - s.tau[i - 1] > gap) { xs.push(NaN); ys.push(NaN); }
      xs.push(s.tau[i]); ys.push(r.o[i]);
    }
    if (!xs.length) continue;
    const what = a.st.coll.title.split(' — ').pop();
    list.push({
      label: `${a.st.name} · ${what}${a.km > 0.05 ? ` · ${fmtNum(a.km)} km` : ''}`,
      color: sel.color, xs, ys, irregular: true, units: target.units,
      ...(cont ? { width: 1.0, dash: [3, 2] } : { noLine: true, dots: 2.6, ring: true }),
    });
  }
}

/** An observed station variable shown on its own -- {coll, key} or null. Set
 *  from the Observations panel for a variable this run has no counterpart
 *  for, so a measured record is never hidden just because the model lacks it. */
export let obsOnly = null;
export function setObsOnly(v) { obsOnly = v; }

/** Stations of the obsOnly collection beside one selection, as for a match. */
function obsOnlyStationsFor(sel) {
  if (!obsOnly || !obs.ready || !$('ser-obs').checked || sel.type === 'transect') return [];
  const { coll, key } = obsOnly;
  if (!coll.show) return [];
  const cand = obs.stations.filter((st) => st.coll === coll && st.vars && st.vars[key]);
  const out = [];
  const cells = extractor.cells(sel);
  if (sel.type === 'area') {
    const inside = new Set(cells.ks);
    for (const st of cand) if (inside.has(st.cell.k)) out.push({ st, km: 0 });
  } else {
    const ll = latLonOfCell(cells.ks[0]);
    for (const st of cand) {
      const own = st.key === sel.obsKey;
      const km = own ? 0 : (ll ? haversineKm(ll[0], ll[1], st.lat, st.lon) : Infinity);
      if (own || km <= OBS_KM) out.push({ st, km });
    }
  }
  out.sort((a, b) => a.km - b.km);
  return out.slice(0, sel.type === 'area' ? 12 : OBS_STATION_MAX);
}

/** The observed-only record at a selection's stations, in observed units. */
export function pushObsOnlySeries(list, sel) {
  for (const a of obsOnlyStationsFor(sel)) {
    const s = obs.series(a.st, obsOnly.key);
    if (!s) continue;                              // loading; onUpdate redraws
    const cont = a.st.cadence === 'continuous';
    const gap = cont ? (3 * Math.max(a.st.dtS || STEP_S, 1)) / STEP_S : Infinity;
    const xs = [], ys = [];
    for (let i = 0; i < s.n; i++) {
      if (i && s.tau[i] - s.tau[i - 1] > gap) { xs.push(NaN); ys.push(NaN); }
      xs.push(s.tau[i]); ys.push(s.v[i]);
    }
    if (!xs.length) continue;
    list.push({
      label: `${a.st.name}${a.km > 0.05 ? ` · ${fmtNum(a.km)} km` : ''}`,
      // no legend in a 130 px panel -- it would sit on the data; hovering
      // names each station, and they are in the selection's colour
      color: sel.color, xs, ys, irregular: true, noLegend: true,
      units: (obsOnly.coll.doc.variables[obsOnly.key] || {}).units || '',
      ...(cont ? { width: 1.0, dash: [3, 2] } : { noLine: true, dots: 2.6, ring: true }),
    });
  }
}

export function obsSkillLine(a, r, target) {
  const head = `vs <b>${escapeHtml(a.st.name)}</b> <span class="obs-tag" style="color:${a.st.coll.color}">`
    + `${escapeHtml(a.st.coll.title)}</span>`;
  if (!r) return `${head} — loading…`;
  const s = r.stats;
  if (!s) return `${head} — no observations inside this run`;
  const u = target.units ? ' ' + escapeHtml(target.units) : '';
  const rr = Number.isFinite(s.r) ? ` · r <b>${s.r.toFixed(2)}</b>` : '';
  return `${head} — n ${s.n} · ${biasText(s, r.anomaly)} · RMSE <b>${fmtNum(s.rmse)}</b>${u}${rr}`
    + (r.notes.length ? `<br>&nbsp;&nbsp;&nbsp;&nbsp;${r.notes.map(escapeHtml).join(' · ')}` : '');
}

// ---------------------------------------------------------------- profiles
/** Elevations of an observed profile on the model's vertical axis. */
function castElevations(c, coll, t) {
  const kind = (coll.doc.vertical && coll.doc.vertical.kind) || 'depth';
  if (c.cell === undefined) c.cell = locator.nearest(c.lat, c.lon, { sea: true }) || null;
  const k = c.cell ? c.cell.k : -1;
  if (kind === 'depth') {
    // depths are below the surface the cast saw; the model's own surface at
    // that cell and hour stands in for it, so a cast on a falling tide is not
    // drawn half a metre too high (the CTD path used to assume a surface at 0)
    const eta = k >= 0 && extractor.isWet(k, t) ? extractor.levelAt(k, t) : 0;
    return c.z.map((d) => (d === null ? NaN : eta - d));
  }
  if (kind === 'height_above_bed') return k >= 0 ? c.z.map((h) => terrain[k] + h) : null;
  if (kind === 'elevation') return c.z.map((z) => (z === null ? NaN : z));
  return null;                          // sediment depths have no water column to sit in
}

/** Observed profiles for the Vertical panel: casts near the selection and the
 *  nearest visit of any depth-resolved station, in model units on the model's
 *  elevation axis. */
export function obsProfilesFor(sel, v, t) {
  const out = [];
  let waiting = false;
  if (!obs.ready || !v) return { list: out, waiting };
  const ks = [...extractor.cells(sel).ks];
  const stride = Math.max(1, Math.ceil(ks.length / 400));
  const ll = ks.filter((_, i) => i % stride === 0).map(latLonOfCell).filter(Boolean);
  for (const coll of obs.collections) {
    if (!coll.show || coll.kind !== 'profiles') continue;
    const m = obs.match(coll, v);
    if (!m || !m.conv) continue;
    const casts = obs.profilesNear(coll, t, ll, { km: OBS_KM, days: OBS_PROFILE_DAYS });
    if (casts === null) { waiting = true; continue; }
    for (const c of casts.slice(0, OBS_PROFILE_MAX)) {
      const vals = c.v[m.key];
      if (!vals) continue;
      const z = castElevations(c, coll, t);
      if (!z) continue;
      out.push({ id: c.name && c.name !== c.station ? c.name : (c.station || c.id), time: c.time,
                 km: c.km, z, x: vals.map((x) => (x === null ? NaN : x * m.conv.factor + m.conv.offset)) });
    }
  }
  for (const { st, m } of obs.stationsFor(v)) {
    if (st.kind !== 'timeseries_profile') continue;
    if (!ll.some(([la, lo]) => haversineKm(la, lo, st.lat, st.lon) <= OBS_KM)) continue;
    const s = obs.series(st, m.key);
    if (!s) { waiting = true; continue; }
    let best = -1, bd = Infinity;
    for (let i = 0; i < s.n; i++) {
      const d = Math.abs(s.tau[i] - t);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0 || bd * STEP_DAYS > OBS_PROFILE_DAYS) continue;
    const tv = s.tau[best];
    const idx = [];
    for (let i = 0; i < s.n; i++) if (s.tau[i] === tv && Number.isFinite(s.z[i])) idx.push(i);
    if (idx.length < 2) continue;
    idx.sort((a, b) => s.z[a] - s.z[b]);
    const z = castElevations({ lat: st.lat, lon: st.lon, z: idx.map((i) => s.z[i]), cell: st.cell },
      st.coll, t);
    if (!z) continue;
    out.push({ id: st.name, time: new Date(obs.msOfTau(tv)).toISOString(), km: 0, z,
               x: idx.map((i) => s.v[i] * m.conv.factor + m.conv.offset) });
  }
  return { list: out, waiting };
}

/** What the dashed lines are. Deliberately short: the panel is narrow. */
export function obsNote(seen) {
  return seen ? `dashed: ${seen} measured profile${seen > 1 ? 's' : ''} `
              + `≤ ${fmtNum(OBS_KM)} km, ±${OBS_PROFILE_DAYS} d` : '';
}

/** Model minus observation over the profiles at one selection.
 *
 *  Mean bias and RMSE together, because a bias near zero with a large RMSE
 *  means the profile SHAPE is wrong even though the average is right. The
 *  model is interpolated onto the observed depths, never the other way round. */
export function obsSkillOf(sel, v, t) {
  if (!obs.ready || !v || !$('vt-obs').checked) return '';
  const r = obsProfilesFor(sel, v, t);
  if (!r.list.length) return '';
  const ks = [...extractor.cells(sel).ks];
  const c = columnsFor(v, ks);
  if (!c) return '';
  const p = depthProfile(c, t, columns);
  if (!p.nz) return '';
  const scores = r.list.map((o) => profileBias(o.z, o.x, p.ys, p.mid)).filter(Boolean);
  const n = scores.reduce((a, b) => a + b.n, 0);
  if (!n) return '';
  const bias = scores.reduce((a, b) => a + b.bias * b.n, 0) / n;
  const rmse = Math.sqrt(scores.reduce((a, b) => a + b.rmse * b.rmse * b.n, 0) / n);
  const names = r.list.map((o) => escapeHtml(o.id)).join(', ');
  return `vs ${names} — bias <b>${sgn(bias)}</b>`
       + ` · RMSE <b>${fmtNum(rmse)}</b> ${escapeHtml(v.units || '')}`
       + ` <span class="nd">(${n} depths)</span>`;
}

// ---------------------------------------------------------------- surveys
/** Survey samples paired with the model at their own cell and date. A
 *  sample on a flat that is dry at that moment takes the model at the
 *  nearest wet step within a day. */
export function surveyPairs(coll, m, target, keep) {
  const rows = obs.points(coll, stepIndex());
  if (rows === null) return null;
  const reach = Math.max(1, Math.round(1 / STEP_DAYS));
  const out = [];
  for (const p of rows) {
    if (keep && !keep(p)) continue;
    const v = ObsStore.pointValue(p, m.key);
    if (!Number.isFinite(v)) continue;
    const fl = p.body.f && p.body.f[m.key] && p.body.f[m.key][p.i];
    if (fl >= 2) continue;
    const x = obs.tauOf(p.ms);
    if (!(x >= 0 && x <= NDAYS - 1)) continue;
    const [mv] = modelNearWet(target, p.cell.k, x, reach);
    if (!Number.isFinite(mv)) continue;
    out.push({ t: x, o: v * m.conv.factor + m.conv.offset, m: mv, p });
  }
  return out;
}
