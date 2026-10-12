// Timeseries tab: the variable on screen at each selection (or its domain
// mean), water level / depth in their own panel, and observed series beside
// the modelled ones.

import { meta, N, NDAYS, LEVEL_UNIT, ST, masks, terrain, elevI16 } from '../core/dataset.js';
import { XS } from '../core/calendar.js';
import { Chart } from '../chart.js';
import { cmapAccent } from '../colormaps.js';
import { $, niceName, withUnits } from '../util.js';
import { selections } from '../features/services.js';
import { setDay } from '../features/time.js';
import { varState, colourScale, currentSource } from '../features/variables.js';
import { areaStat } from '../features/selectionPanel.js';
import {
  obsTarget, LEVEL_TARGET, pushObsSeries, pushObsOnlySeries, obsOnly,
} from '../obs/compare.js';
import { cachedSeries, timeSpec, hexA } from './common.js';

export const seriesChart = new Chart($('c-series'), { onScrub: (x) => setDay(x) });
const series2Chart = new Chart($('c-series2'), { onScrub: (x) => setDay(x) });
const series3Chart = new Chart($('c-series3'), { onScrub: (x) => setDay(x) });

// Sea cells only — the domain mean must not include land, where the exported
// field holds a nearest-filled neighbour value rather than a model result.
export const SEA_CELLS = (() => {
  const idx = [];
  for (let k = 0; k < N; k++) if ((masks[k] & 1) === 0) idx.push(k);
  return Int32Array.from(idx);
})();

// Domain-mean fallback for datasets processed before the pipeline wrote
// per-step statistics. It is a full pass over (sea cells x steps), so it is
// computed once per variable and cached; the loop is inlined rather than going
// through valueAt because that is ~12 million calls on this grid.
const domainCache = new Map();
export function domainSeries() {
  if (!varState) return null;
  const pre = meta.stats && meta.stats.vars && meta.stats.vars[varState.key];
  if (pre && Array.isArray(pre.mean)) return { ys: pre.mean, exact: true };
  if (domainCache.has(varState.key)) return domainCache.get(varState.key);

  const ys = new Float64Array(NDAYS).fill(NaN);
  const { arr, nFrames, static: isStatic, storeLo, storeHi, bytes } = varState;
  const inv = bytes === 2 ? 1 / 65535 : 1 / 255;
  const span = (storeHi - storeLo) || 1;
  for (let t = 0; t < NDAYS; t++) {
    const eOff = t * N;
    const vOff = (isStatic ? 0 : Math.min(t, nFrames - 1)) * N;
    let sum = 0, m = 0;
    for (let c = 0; c < SEA_CELLS.length; c++) {
      const k = SEA_CELLS[c];
      // same wet test the extractor and the shaders use, to the same tolerance
      if (elevI16[eOff + k] * 0.01 - terrain[k] <= 0.005) continue;
      sum += storeLo + arr[vOff + k] * inv * span;
      m++;
    }
    if (m) ys[t] = sum / m;
  }
  const out = { ys, exact: false };
  domainCache.set(varState.key, out);
  return out;
}

export function drawSeries() {
  const src = currentSource();
  const active = selections.active;
  const series = [], bands = [], spans = [];
  // metres go in their own panel whenever the main panel is showing a variable
  const metres = [];
  let yLabel = 'Value', units = '';

  if (src) { yLabel = withUnits(varState); units = varState.units || ''; }

  const wantLevel = $('ser-level').checked;
  const wantDepth = $('ser-depth').checked;

  for (const sel of active) {
    const stat = sel.type === 'area' ? areaStat : 'mean';
    const tag = sel.type === 'area' ? ` (${stat})` : '';
    if (src) {
      const r = cachedSeries(sel, src, stat);
      series.push({ label: sel.name + tag, color: sel.color, xs: XS, ys: r.ys, width: 1.7 });
      if (sel.type === 'area' && $('area-band').checked) {
        bands.push({ color: hexA(sel.color, 0.13), xs: XS, lo: r.lo, hi: r.hi });
      }
    }
    // With no variable selected the main panel is the metres panel, so level
    // and depth go straight into it; with one selected they get their own.
    const into = src ? metres : series;
    if (wantLevel || (!src && !wantDepth)) {
      const r = cachedSeries(sel, { kind: 'level' }, stat);
      into.push({
        label: `${sel.name} — water level`, color: sel.color, xs: XS, ys: r.ys,
        width: 1.5, units: LEVEL_UNIT,
      });
      if (!src) { yLabel = `Water level [${LEVEL_UNIT}]`; units = LEVEL_UNIT; }
    }
    if (wantDepth) {
      const r = cachedSeries(sel, { kind: 'depth' }, stat);
      into.push({
        label: `${sel.name} — depth`, color: sel.color, xs: XS, ys: r.ys,
        dash: [4, 3], width: 1.4, units: 'm',
      });
      if (!src && !wantLevel) { yLabel = 'Water depth [m]'; units = 'm'; }
    }
    // shade the steps a single point selection is dry, so a gap is explained
    if (sel.type === 'point' && active.length === 1) {
      const r = cachedSeries(sel, { kind: 'level' }, 'mean');
      for (let t = 0; t < NDAYS; t++) {
        if (!Number.isFinite(r.ys[t])) {
          spans.push({ x0: t - 0.5, x1: t + 0.5, color: 'rgba(255,200,87,.07)' });
        }
      }
    }
    // measured series beside the modelled ones, in the selection's colour
    pushObsSeries(series, sel, obsTarget());
    if (src && wantLevel) pushObsSeries(metres, sel, LEVEL_TARGET);
  }

  if (!series.length) {
    // nothing selected — show what the drape itself is showing
    if (src) {
      const d = domainSeries();
      series.push({
        label: `Domain mean — ${niceName(varState)}`,
        color: cmapAccent(colourScale.cmap, colourScale.rev), xs: XS, ys: d.ys, width: 1.8,
      });
    } else {
      series.push({
        label: 'Exposed flat area', color: '#ffc857', xs: XS, ys: ST.exposedKm2,
        width: 1.8, fill: 'rgba(255,200,87,.10)', units: 'km²',
      });
      yLabel = 'Exposed flat area [km²]'; units = 'km²';
    }
  }
  // the default no-variable, no-selection view already IS this curve, so only
  // add it where it is not already on screen
  const haveArea = series.some((s) => s.ys === ST.exposedKm2);
  if ($('ser-domain').checked && !haveArea) {
    // km², so it can never share the metre axis: on its own it takes the panel's
    // left axis, alongside level/depth it moves to the right one
    const target = src ? metres : series;
    const alone = !target.some((s) => s.units === LEVEL_UNIT || s.units === 'm');
    target.push({
      label: 'Domain exposed flat area', color: '#ffc857', xs: XS, ys: ST.exposedKm2,
      dash: [2, 3], width: 1.3, units: 'km²', axis: alone ? 'left' : 'right',
    });
  }

  seriesChart.draw(timeSpec(series, bands, spans, yLabel, units));

  const cv3 = $('c-series3');
  cv3.hidden = !obsOnly;
  if (obsOnly) {
    const only = [];
    for (const sel of active) pushObsOnlySeries(only, sel);
    const v = obsOnly.coll.doc.variables[obsOnly.key] || {};
    const u = v.units || '';
    // the 130 px panel has room for the units on its axis, not the name:
    // the name and why the model is missing go in the title
    const spec = timeSpec(only, [], spans, u || 'value', u);
    spec.title = `${v.label || obsOnly.key} — observed, not in this run`;
    if (!only.length) {
      spec.empty = `${obsOnly.coll.title}: ${v.label || obsOnly.key} has no model counterpart in this run.`
        + ' Add one of its stations (a ring on the map, or + in the Observations panel) to plot it here.';
    }
    series3Chart.draw(spec);
  }

  const cv2 = $('c-series2');
  cv2.hidden = !metres.length;
  if (metres.length) {
    const onlyArea = metres.every((s) => s.units === 'km²');
    series2Chart.draw(timeSpec(metres, [], spans,
      onlyArea ? 'Exposed flat area [km²]' : `Water level / depth [${LEVEL_UNIT}]`,
      onlyArea ? 'km²' : LEVEL_UNIT));
  }
}
