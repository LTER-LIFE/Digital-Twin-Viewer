// Profile tab: a cross-section along the transect at the current step — bed,
// water surface, and the water column coloured by the variable (layer by
// layer for a 4-D field).

import { NX, LEVEL_UNIT } from '../core/dataset.js';
import { stepDate } from '../core/calendar.js';
import { Chart } from '../chart.js';
import { sampleCmap, cmapAccent } from '../colormaps.js';
import { $, fmtNum, niceName } from '../util.js';
import { extractor, columns, selections } from '../features/services.js';
import { stepIndex } from '../features/time.js';
import { varState, colourScale, currentSource, vertVar, position } from '../features/variables.js';
import { columnsFor } from './vertical.js';

export const profileChart = new Chart($('c-profile'));

export function drawProfile() {
  const tr = selections.transect;
  if (!tr) { profileChart.draw({ empty: 'Draw a transect to see a cross-section.' }); return; }
  const src = currentSource();
  const t = stepIndex();
  const p = extractor.profile(tr, src, t);
  const maxD = p.dist[p.dist.length - 1] || 1;

  // The axis spans the bed plus every water level this transect will ever see,
  // so it does not move as the run plays. Fitting it to the current step made
  // the bed — the one thing in the panel that cannot move — appear to slide up
  // and down while the tide, which does move, sat still against the frame.
  const rng = extractor.profileRange(tr);
  const pad = (rng.hi - rng.lo) * 0.08 || 1;
  const lo = rng.lo - pad, hi = rng.hi + pad;

  // The water column, coloured by the variable. With a 4-D field this is a
  // true section: one quadrilateral per model layer, at that layer's own
  // depth. A 2-D field has nothing to say about the vertical, so it fills the
  // column in one piece — honest for a depth-averaged quantity, and actively
  // misleading when a stratified 4-D field was collapsed to its surface value.
  //
  // Every boundary in this panel — bed, water surface, each layer interface —
  // is the straight line through the per-cell values AT THE CELL CENTRES,
  // because that is what the bed and water-level series draw. The fill has to
  // use the same line or it parts company with them.
  //
  // So each cell contributes TWO quads, meeting at its centre, and every
  // polygon edge is a chord between two adjacent centres. Spanning the whole
  // cell with one quad looks equivalent and is not: its bottom is then a chord
  // across the kink at the centre, which floats above the bed line wherever
  // the bed is locally concave. Measured over 60 transects of this dataset,
  // that happened at 41 % of cells, by up to 6.7 m — a gap over a hundred
  // pixels tall at the bottom of a channel.
  const quads = [];
  const vv = vertVar();
  const vcols = vv ? columnsFor(vv, Array.from(p.ks)) : null;
  const n = p.bed.length;
  /** Left, centre and right x of cell i; the outer halves of the end cells
   *  have no neighbour to meet and collapse to zero width. */
  const xParts = (i) => [
    i > 0 ? (p.dist[i] + p.dist[i - 1]) / 2 : p.dist[i],
    p.dist[i],
    i < n - 1 ? (p.dist[i] + p.dist[i + 1]) / 2 : p.dist[i],
  ];
  /** The same three positions on a boundary. A neighbour that cannot supply a
   *  value — dry, land, or past the end — leaves that edge at this cell's own
   *  value, which keeps the half-quad square instead of collapsing it. */
  const yParts = (i, at) => {
    const v = at(i);
    const a = i > 0 ? at(i - 1) : NaN;
    const b = i < n - 1 ? at(i + 1) : NaN;
    return [Number.isFinite(a) ? (a + v) / 2 : v, v,
            Number.isFinite(b) ? (b + v) / 2 : v];
  };
  const halves = (i, xs, bot, top, color) => {
    for (const h of [0, 1]) {
      const x0 = xs[h], x1 = xs[h + 1];
      if (!(x1 > x0)) continue;              // the outer half of an end cell
      quads.push({ x0, x1, bl: bot[h], br: bot[h + 1], tl: top[h], tr: top[h + 1], color });
    }
  };
  const quadCol = (val) => {
    const c = sampleCmap(colourScale.cmap, position(val), colourScale.rev);
    return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  };
  if (vcols) {
    const at = new Map();
    for (let i = 0; i < vcols.ks.length; i++) at.set(vcols.ks[i], i);
    // interfaces for the whole transect up front: each quad needs its
    // neighbours' interfaces to find its own sloping edges
    const zs = [];
    for (let i = 0; i < n; i++) {
      zs.push(at.has(p.ks[i]) ? columns.interfaces(p.ks[i], t) : null);
    }
    const iface = (zi) => (i) => (zs[i] ? zs[i][zi] : NaN);
    for (let i = 0; i < n; i++) {
      const ci = at.get(p.ks[i]);
      if (ci === undefined || !zs[i]) continue;
      const xs = xParts(i);
      for (let zi = 0; zi < vcols.nz; zi++) {
        const val = vcols.at(ci, t, zi);
        if (!Number.isFinite(val)) continue;
        halves(i, xs, yParts(i, iface(zi)), yParts(i, iface(zi + 1)), quadCol(val));
      }
    }
  } else if (src) {
    const bedAt = (i) => p.bed[i];
    const lvlAt = (i) => p.lvl[i];
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(p.lvl[i]) || !Number.isFinite(p.val[i])) continue;
      halves(i, xParts(i), yParts(i, bedAt), yParts(i, lvlAt), quadCol(p.val[i]));
    }
  }

  profileChart.draw({
    x: { min: 0, max: maxD, label: `Distance along transect [km]` },
    y: { min: lo, max: hi, label: `Elevation [${LEVEL_UNIT}]` },
    polys: quads,
    series: [
      {
        // opaque, not a wash: the ground in a section is solid, and a
        // translucent one let the gridlines show through it as if the seabed
        // were made of glass. The tone is what the old 45 % fill composited to,
        // so only the gridlines change.
        label: `Bed elevation`, color: '#c8a97a', xs: p.dist, ys: p.bed,
        width: 1.8, fill: '#3e3a32', fillBase: lo,
      },
      {
        label: `Water level — ${stepDate(t).toISOString().slice(0, 10)}`,
        color: '#5fd4ff', xs: p.dist, ys: p.lvl, width: 1.6,
        fill: src ? null : 'rgba(60,150,200,.20)', fillBase: lo,
      },
    ],
    forceLegend: true,
    hlines: lo < 0 && hi > 0 ? [{ y: 0, label: `0 ${LEVEL_UNIT}` }] : null,
    hoverFmt: (x, y) => {
      let i = 0;
      for (let n = 1; n < p.dist.length; n++) if (Math.abs(p.dist[n] - x) < Math.abs(p.dist[i] - x)) i = n;
      const out = [{ text: `${p.dist[i].toFixed(2)} km · cell ${(p.ks[i] / NX) | 0}, ${p.ks[i] % NX}` }];
      out.push({ color: '#c8a97a', text: `Bed: ${fmtNum(p.bed[i])} ${LEVEL_UNIT}` });
      out.push({
        color: '#5fd4ff',
        text: Number.isFinite(p.lvl[i])
          ? `Level: ${fmtNum(p.lvl[i])} ${LEVEL_UNIT} · depth ${fmtNum(p.lvl[i] - p.bed[i])} m`
          : 'Dry at this step',
      });
      if (vcols) {
        // name the layer the cursor is actually in, not the surface value
        const ci = vcols.ks.indexOf(p.ks[i]);
        const z = ci >= 0 ? columns.interfaces(p.ks[i], t) : null;
        let zi = -1;
        if (z) {
          for (let n = 0; n < vcols.nz; n++) {
            if (y >= z[n] && y <= z[n + 1]) { zi = n; break; }
          }
          if (zi < 0 && y > z[vcols.nz]) zi = vcols.nz - 1;
          if (zi < 0 && y < z[0]) zi = 0;
        }
        const val = zi >= 0 ? vcols.at(ci, t, zi) : NaN;
        out.push({
          color: cmapAccent(colourScale.cmap, colourScale.rev),
          text: `${niceName(varState)}: ${Number.isFinite(val)
            ? fmtNum(val) + (varState.units ? ' ' + varState.units : '') : 'no data'}`
            + (zi >= 0 ? ` · layer ${zi + 1} of ${vcols.nz}` : ''),
        });
      } else if (src) {
        out.push({
          color: cmapAccent(colourScale.cmap, colourScale.rev),
          text: `${niceName(varState)}: ${Number.isFinite(p.val[i])
            ? fmtNum(p.val[i]) + (varState.units ? ' ' + varState.units : '') : 'no data'}`,
        });
      }
      return out;
    },
  });
}
