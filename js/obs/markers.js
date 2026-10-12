// What the observation markers on the map show: which stations, casts and
// survey samples are drawn at the current time, in what colour, and the map
// legend that names their collections. The drawing itself is
// render/obsMarkers.js.

import { ObsStore } from '../observations.js';
import { defaultCmap, sampleCmap } from '../colormaps.js';
import { createObsMarkers } from '../render/obsMarkers.js';
import { $, escapeHtml } from '../util.js';
import { locator, obs } from '../features/services.js';
import { stepIndex } from '../features/time.js';
import { varState, colourScale, position } from '../features/variables.js';
import { OBS_PROFILE_DAYS } from './compare.js';

/** Which survey variable colours the markers: the one matching the variable
 *  on screen unless the user chose otherwise. */
function surveyColourKey(coll) {
  if (coll.colorBy === 'none') return null;
  if (coll.colorBy && coll.colorBy !== 'auto') return coll.colorBy;
  const m = varState && obs.match(coll, varState);
  return m && m.conv ? m.key : null;
}

/** Colour of a survey sample. Coloured by the variable on screen, it uses the
 *  MODEL's colour scale after unit conversion -- the same number in the same
 *  colour on the drape and on the dot, which is the point of the map. Any
 *  other variable gets its own 2-98 % range, shown in the sidebar. */
function surveyPainter(coll) {
  const key = surveyColourKey(coll);
  coll._range = null;
  if (!key) return () => null;
  const grey = [0.42, 0.45, 0.48];
  const shared = varState && obs.match(coll, varState);
  if (shared && shared.conv && shared.key === key) {
    const { factor, offset } = shared.conv;
    coll._range = { shared: true, key };
    return (p) => {
      const v = ObsStore.pointValue(p, key);
      if (!Number.isFinite(v)) return grey;
      const c = sampleCmap(colourScale.cmap, Math.min(Math.max(position(v * factor + offset), 0), 1),
        colourScale.rev);
      return [c[0] / 255, c[1] / 255, c[2] / 255];
    };
  }
  const rng = obs.pointRange(coll, key);
  if (!rng) return () => null;
  const v0 = coll.doc.variables[key] || {};
  const cmap = defaultCmap({ key, name: v0.label || key, units: v0.units || '' });
  coll._range = { shared: false, key, lo: rng[0], hi: rng[1], cmap, units: v0.units || '' };
  return (p) => {
    const v = ObsStore.pointValue(p, key);
    if (!Number.isFinite(v)) return grey;
    const c = sampleCmap(cmap, Math.min(Math.max((v - rng[0]) / ((rng[1] - rng[0]) || 1), 0), 1), false);
    return [c[0] / 255, c[1] / 255, c[2] / 255];
  };
}

const hexRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** Every marker to draw at the current step. */
function collect() {
  const out = [];
  if (!obs.ready || !$('ov-obs').checked) return out;
  const t = stepIndex();
  for (const coll of obs.collections) {
    if (!coll.show) continue;
    const c = hexRgb(coll.color);
    if (coll.kind === 'survey' || coll.kind === 'trajectory') {
      const rows = obs.points(coll, t);
      if (!rows) continue;
      const paint = surveyPainter(coll);
      for (const p of rows) {
        out.push({ k: p.cell.k, kind: 'point', ref: p, coll, color: paint(p) || c, shape: 0, size: 6 });
      }
    } else if (coll.kind === 'profiles') {
      const casts = obs.castsAround(coll, t, coll.windowDays || OBS_PROFILE_DAYS);
      if (!casts) continue;
      for (const cast of casts) {
        if (cast.cell === undefined) cast.cell = locator.nearest(cast.lat, cast.lon, { sea: true }) || null;
        if (cast.cell) out.push({ k: cast.cell.k, kind: 'cast', ref: cast, coll, color: c, shape: 2, size: 9 });
      }
    }
  }
  for (const st of obs.stations) {
    if (!st.coll.show) continue;
    out.push({ k: st.cell.k, kind: 'station', ref: st, coll: st.coll, color: hexRgb(st.coll.color),
               shape: 1, size: 15, stem: true });
  }
  return out;
}

function renderObsLegend(items) {
  const el = $('obs-legend');
  if (!items.length) { el.innerHTML = ''; return; }
  const seen = new Map();
  for (const it of items) if (!seen.has(it.coll.id)) seen.set(it.coll.id, it);
  el.innerHTML = [...seen.values()].map((it) => {
    const mk = it.shape === 1 ? 'ring' : it.shape === 2 ? 'cast' : 'disc';
    const by = it.kind === 'point' && it.coll._range ? ` <span class="nd">· by ${escapeHtml(
      (it.coll.doc.variables[it.coll._range.key] || {}).label || it.coll._range.key)}</span>` : '';
    return `<div class="li"><span class="mk ${mk}" style="--c:${it.coll.color}"></span>`
      + `<span>${escapeHtml(it.coll.title)}${by}</span></div>`;
  }).join('');
}

/** The marker layer: {update, pick, invalidate, items}. Set by createObsLayer(). */
export let obsLayer = null;

export function createObsLayer() {
  obsLayer = createObsMarkers({ collect, onRebuild: renderObsLegend });
}
