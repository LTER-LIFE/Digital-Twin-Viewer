// Hovmöller tab: distance x time along a transect, or — for a point or area
// on a 4-D field — depth x time through its water column.

import { NX, NDAYS, LEVEL_UNIT } from '../core/dataset.js';
import { stepDate, TIME_TICKS } from '../core/calendar.js';
import { Chart } from '../chart.js';
import { cmapAccent } from '../colormaps.js';
import { depthProfile } from '../vertical.js';
import { $, fmtNum, withUnits } from '../util.js';
import { extractor, columns, selections } from '../features/services.js';
import { dayF, setDay } from '../features/time.js';
import { varState, colourScale, currentSource, vertVar } from '../features/variables.js';
import { columnsFor } from './vertical.js';

// the Hovmoller's vertical axis IS time, so dragging down it scrubs the run
// The depth plot puts time on x and the distance plot puts it on y, so the
// chart is given both and each draw says which one a drag means.
export const hovChart = new Chart($('c-hov'), {
  onScrub: (x) => setDay(x),
  onScrubY: (y) => setDay(y),
});

const hovCache = new Map();
function cachedHovmoller(sel, src) {
  const cells = extractor.cells(sel);
  const key = `${sel.id}|${cells.key}|${src.desc.key}`;
  let hit = hovCache.get(key);
  if (!hit) {
    hit = extractor.hovmoller(sel, src);
    if (hovCache.size > 6) hovCache.clear();
    hovCache.set(key, hit);
  }
  return hit;
}

/** Depth against time for a selection: the view that shows a stratification
 *  season building and breaking down.
 *
 *  Time stays on the vertical axis and depth replaces distance on the
 *  horizontal, rather than the other way round. That keeps the scrub gesture
 *  and the step rule identical to the distance–time plot beside it; swapping
 *  the axes as well as the quantity would make the two panels behave
 *  differently for no gain.
 */
function drawDepthHovmoller(sel) {
  const v = vertVar();
  const ks = Array.from(extractor.cells(sel).ks);
  const c = columnsFor(v, ks);
  if (!c) { hovChart.draw({ empty: 'Loading profiles…' }); return; }

  // one median per (step, level); a wide area is thinned because the median
  // barely moves past a couple of hundred cells and this runs for every step
  const NL = 72;
  const stride = Math.max(1, Math.ceil(c.ks.length / 192));
  const sub = stride === 1 ? c : {
    ...c, ks: c.ks.filter((_, i) => i % stride === 0),
    at: (ci, t, z) => c.at(ci * stride, t, z),
  };
  let zlo = Infinity, zhi = -Infinity;
  for (let t = 0; t < c.nt; t++) {
    for (const k of sub.ks) {
      const z = columns.interfaces(k, t);
      if (z) { zlo = Math.min(zlo, z[0]); zhi = Math.max(zhi, z[columns.nz]); }
    }
  }
  if (!Number.isFinite(zlo) || !(zhi > zlo)) {
    hovChart.draw({ empty: 'No water column here over this run.' });
    return;
  }
  const values = new Float64Array(NL * c.nt).fill(NaN);
  const ys = new Float64Array(NL);
  for (let i = 0; i < NL; i++) ys[i] = zlo + ((zhi - zlo) * i) / (NL - 1);
  for (let t = 0; t < c.nt; t++) {
    const p = depthProfile(sub, t, columns, NL, true);
    for (let i = 0; i < NL; i++) {
      // depthProfile picks its own levels from the wet columns at this step;
      // resample onto the fixed axis so every row of the raster lines up
      const y = ys[i];
      if (!p.nz || y < p.ys[0] || y > p.ys[p.nz - 1]) continue;
      let a = 0;
      while (a < p.nz - 2 && p.ys[a + 1] < y) a++;
      const f = (y - p.ys[a]) / (p.ys[a + 1] - p.ys[a] || 1);
      const v0 = p.mid[a], v1 = p.mid[a + 1];
      values[t * NL + i] = Number.isFinite(v0) && Number.isFinite(v1)
        ? v0 + (v1 - v0) * f : (Number.isFinite(v0) ? v0 : v1);
    }
  }
  // The raster is built level-major; transpose it so depth can go on the
  // vertical axis, where a reader expects it, with time running left to right.
  const flat = new Float64Array(NL * c.nt);
  for (let t = 0; t < c.nt; t++) {
    for (let i = 0; i < NL; i++) flat[(NL - 1 - i) * c.nt + t] = values[t * NL + i];
  }
  const u = varState.units ? ' ' + varState.units : '';
  hovChart.draw({
    x: { min: 0, max: NDAYS - 1, ticks: TIME_TICKS, label: 'Time' },
    y: { min: zlo, max: zhi, label: `Elevation [${LEVEL_UNIT}]` },
    raster: {
      values: flat, nx: c.nt, ny: NL,
      cmap: colourScale.cmap, rev: colourScale.rev,
      lo: colourScale.lo, hi: colourScale.hi, log: colourScale.log,
    },
    title: `${withUnits(varState)} through ${sel.name}`
      + (c.sampled ? ` · sampled ${c.ks.length} of ${c.ofTotal} cells` : ''),
    cursor: null,
    scrubAxis: 'x',
    // time is horizontal here, so the step marker is a vertical rule
    vlines: [{ x: dayF, color: 'rgba(95,212,255,.9)', dash: [] }],
    hoverFmt: (x, y) => {
      const t = Math.round(Math.min(Math.max(x, 0), NDAYS - 1));
      let i = 0;
      for (let n = 1; n < NL; n++) if (Math.abs(ys[n] - y) < Math.abs(ys[i] - y)) i = n;
      const val = values[t * NL + i];
      return [
        { text: `${stepDate(t).toISOString().slice(0, 10)} · ${ys[i].toFixed(2)} ${LEVEL_UNIT}` },
        { text: `${sel.name} · ${c.ks.length} cell${c.ks.length === 1 ? '' : 's'}` },
        {
          color: cmapAccent(colourScale.cmap, colourScale.rev),
          text: Number.isFinite(val) ? `${fmtNum(val)}${u}` : 'no data (dry or outside the column)',
        },
      ];
    },
  });
}

export function drawHovmoller() {
  const tr = selections.transect;
  const src = currentSource();
  // A transect has a distance axis and no single water column; a point or an
  // area has a column and no distance. The selection therefore decides which
  // plot this is, and there is nothing for the reader to choose.
  if (!tr && vertVar() && columns.ready) {
    const sel = selections.active[0];
    if (!sel) { hovChart.draw({ empty: 'Place a selection to see a depth–time plot.' }); return; }
    return drawDepthHovmoller(sel);
  }
  if (!tr || !src) {
    hovChart.draw({ empty: 'Draw a transect and select a variable to see a distance–time plot.' });
    return;
  }
  const h = cachedHovmoller(tr, src);
  const maxD = h.dist[h.dist.length - 1] || 1;
  const u = varState.units ? ' ' + varState.units : '';
  hovChart.draw({
    x: { min: 0, max: maxD, label: 'Distance along transect [km]' },
    y: { min: NDAYS - 1, max: 0, ticks: TIME_TICKS, label: 'Time' },
    scrubAxis: 'y',
    raster: {
      values: h.values, nx: h.nx, ny: h.ny,
      cmap: colourScale.cmap, rev: colourScale.rev,
      lo: colourScale.lo, hi: colourScale.hi, log: colourScale.log,
    },
    title: `${withUnits(varState)} along ${tr.name}`,
    cursor: null,
    // the current timestep, as a rule across the time axis
    hlines: [{ y: dayF, color: 'rgba(95,212,255,.9)', dash: [] }],
    // both axes carry meaning here, so the readout names the cell, the step and
    // the value under the crosshair
    hoverFmt: (x, y) => {
      let c = 0;
      for (let n = 1; n < h.dist.length; n++) if (Math.abs(h.dist[n] - x) < Math.abs(h.dist[c] - x)) c = n;
      const t = Math.round(Math.min(Math.max(y, 0), NDAYS - 1));
      const v = h.values[t * h.nx + c];
      const k = extractor.cells(tr).ks[c];
      return [
        { text: `${stepDate(t).toISOString().slice(0, 10)} · ${h.dist[c].toFixed(2)} km` },
        { text: `cell ${Math.floor(k / NX)}, ${k % NX}` },
        {
          color: cmapAccent(colourScale.cmap, colourScale.rev),
          text: Number.isFinite(v) ? `${fmtNum(v)}${u}` : 'no data (dry or land)',
        },
      ];
    },
  });
}
