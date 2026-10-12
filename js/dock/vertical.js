// Vertical tab: the modelled profile through each selection, with its spread,
// the whole-run envelope, and measured casts beside it. Also the column cache
// and stratification readout the other panels share.
//
// 4-D fields are never downloaded whole. The viewer holds the sigma geometry
// (1.3 MB, shared by every variable) and asks the server only for the columns
// a selection actually covers. Draw paths stay synchronous: they paint what is
// cached and request anything missing, which redraws when it lands.

import { LEVEL_UNIT } from '../core/dataset.js';
import { Chart } from '../chart.js';
import { depthProfile, sigmaT, potentialEnergyAnomaly } from '../vertical.js';
import { $, fmtNum, withUnits } from '../util.js';
import { extractor, columns, obs, selections } from '../features/services.js';
import { stepIndex } from '../features/time.js';
import { colVar, vertVar } from '../features/variables.js';
import { obsProfilesFor, obsNote } from '../obs/compare.js';
import { hexA } from './common.js';
import { drawCharts } from './dock.js';
import { updateReadout } from './readout.js';

export const vertChart = new Chart($('c-vert'));

const colWait = new Set();
/** Cached columns for this selection, or null while they are on the way. */
export function columnsFor(v, ks) {
  if (!v || !v.column || !columns.ready) return null;
  const hit = columns.peek(v, ks);
  if (hit) return hit;
  const tag = `${v.key}|${ks.length}|${ks[0]}|${ks[ks.length - 1]}`;
  if (!colWait.has(tag)) {
    colWait.add(tag);
    columns.fetch(v, ks).then(
      () => {
        colWait.delete(tag);
        // redraw OUTSIDE the promise chain: a bug in a draw path is not a
        // failed download, and routing it through this catch would hide it
        // behind a stale panel with nothing in the console
        setTimeout(() => { drawCharts(); updateReadout(); }, 0);
      },
      (e) => {
        colWait.delete(tag);
        console.warn('column fetch failed', e);
      },
    );
  }
  return null;
}

/** Density profile accessor for a column, when temperature and salinity are
 *  both available. Returns null otherwise — a stratification number computed
 *  from one of the two would be a guess with a unit on it. */
function densityAt(ks, t) {
  const T = colVar('temp') || colVar('etw');
  const S = colVar('salt');
  if (!T || !S) return null;
  const ct = columnsFor(T, ks), cs = columnsFor(S, ks);
  if (!ct || !cs) return null;
  return (ci) => (z) => sigmaT(cs.at(ci, t, z), ct.at(ci, t, z));
}

export function initVerticalPanel() {
  for (const id of ['vt-band', 'vt-env', 'vt-obs']) {
    $(id).addEventListener('change', () => drawCharts());
  }
  // The toggle only exists when some collection can draw a profile here; on
  // everything else it would be a dead control promising a comparison the run
  // cannot make.
  {
    const prof = obs.collections.filter((c) => c.kind === 'profiles')
      .concat(obs.stations.some((s) => s.kind === 'timeseries_profile') ? [{ title: 'depth-resolved stations' }] : []);
    if (prof.length) {
      $('vt-obs-wrap').hidden = false;
      $('vt-obs-wrap').title = prof.map((c) => c.title).join(' · ');
    }
  }
}

export function drawVertical() {
  const sels = selections.active;
  const v = vertVar();
  if (!columns.ready) {
    return vertChart.draw({ empty: 'This dataset has no vertical grid.' });
  }
  if (!v) {
    return vertChart.draw({
      empty: 'Select a variable that carries a vertical profile.' });
  }
  if (!sels.length) {
    return vertChart.draw({ empty: 'Place a point, transect or area to see its profile.' });
  }
  const t = stepIndex();
  const band = $('vt-band').checked;
  const env = $('vt-env').checked;
  const series = [], vbands = [], hlines = [];
  let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
  let waiting = false, note = '';
  const showObs = obs.ready && $('vt-obs').checked;
  let obsSeen = 0;

  for (const sel of sels) {
    const ks = [...extractor.cells(sel).ks];
    const c = columnsFor(v, ks);
    if (!c) { waiting = true; continue; }
    const p = depthProfile(c, t, columns);
    if (!p.nz) continue;
    if (c.sampled) note = `sampled ${c.ks.length} of ${c.ofTotal} cells`;
    // how many cells reach each level, so a band that narrows because the
    // channel does is not mistaken for one that narrows because the water is
    // uniform there
    const ns = [...p.n].filter((x) => x > 0);
    if (!note && c.ks.length > 1 && ns.length) {
      const nlo = Math.min(...ns), nhi = Math.max(...ns);
      if (nlo !== nhi) note = `${nlo}–${nhi}/${c.ks.length} cells per level`;
    }

    const single = c.ks.length === 1;
    if (!single && band) {
      vbands.push({ color: hexA(sel.color, 0.16), ys: p.ys, lo: p.lo, hi: p.hi });
    }
    if (env) {
      // the range the whole run covers, so a single step is read against the
      // seasonal envelope rather than in isolation
      const elo = new Float64Array(p.nz).fill(Infinity);
      const ehi = new Float64Array(p.nz).fill(-Infinity);
      for (let tt = 0; tt < c.nt; tt++) {
        const q = depthProfile(c, tt, columns);
        for (let i = 0; i < p.nz; i++) {
          if (Number.isFinite(q.mid[i])) {
            elo[i] = Math.min(elo[i], q.mid[i]);
            ehi[i] = Math.max(ehi[i], q.mid[i]);
          }
        }
      }
      for (let i = 0; i < p.nz; i++) {
        if (!Number.isFinite(elo[i])) { elo[i] = NaN; ehi[i] = NaN; }
      }
      vbands.push({ color: 'rgba(255,255,255,.07)', ys: p.ys, lo: elo, hi: ehi });
      for (let i = 0; i < p.nz; i++) {
        if (Number.isFinite(elo[i])) { xlo = Math.min(xlo, elo[i]); xhi = Math.max(xhi, ehi[i]); }
      }
    }
    series.push({
      label: sel.name + (single ? '' : ' (median)'), color: sel.color,
      xs: Array.from(p.mid), ys: Array.from(p.ys), width: 1.8,
    });

    // Measured casts near this selection, dashed and dotted in the same colour:
    // colour says WHERE, line style says MODEL or MEASURED. Nearest first and
    // only a few, because the point is to read the offset at a glance and a
    // dozen casts is a thicket.
    if (showObs) {
      const r = obsProfilesFor(sel, v, t);
      if (r.waiting) waiting = true;
      for (const o of r.list) {
        const vals = o.x;
        series.push({
          label: `${o.id} · ${o.time.slice(0, 10)} · ${fmtNum(o.km)} km`,
          color: sel.color, xs: vals, ys: o.z,
          width: 1.1, dash: [4, 3], dots: 2.1,
          // named for the hover readout but kept out of the legend: with three
          // stations and their casts the legend was eight entries deep and sat
          // on top of the thermocline. Colour already says which station a cast
          // belongs to, and the dashes say it is measured.
          noLegend: true,
        });
        obsSeen++;
        for (let i = 0; i < vals.length; i++) {
          if (!Number.isFinite(vals[i]) || !Number.isFinite(o.z[i])) continue;
          xlo = Math.min(xlo, vals[i]); xhi = Math.max(xhi, vals[i]);
          ylo = Math.min(ylo, o.z[i]); yhi = Math.max(yhi, o.z[i]);
        }
      }
    }
    for (let i = 0; i < p.nz; i++) {
      const a = band && !single ? p.lo[i] : p.mid[i];
      const b = band && !single ? p.hi[i] : p.mid[i];
      if (Number.isFinite(a)) { xlo = Math.min(xlo, a); xhi = Math.max(xhi, b); }
      if (Number.isFinite(p.ys[i])) { ylo = Math.min(ylo, p.ys[i]); yhi = Math.max(yhi, p.ys[i]); }
    }

  }

  if (waiting && !series.length) return vertChart.draw({ empty: 'Loading profiles…' });
  if (!series.length) {
    return vertChart.draw({ empty: 'No water column here at this step — the cells are dry.' });
  }
  const pad = (xhi - xlo) * 0.06 || 1;
  vertChart.draw({
    x: { min: xlo - pad, max: xhi + pad, label: withUnits(v) },
    y: { min: ylo, max: yhi, label: `Elevation [${LEVEL_UNIT}]` },
    vbands, series, hlines,
    forceLegend: true,
    title: [obsNote(obsSeen), note].filter(Boolean).join('  ·  ') || undefined,
    hoverFmt: (x, y) => {
      const out = [{ text: `${y.toFixed(2)} ${LEVEL_UNIT}` }];
      for (const ser of series) {
        let i = 0;
        for (let n = 1; n < ser.ys.length; n++) {
          if (Math.abs(ser.ys[n] - y) < Math.abs(ser.ys[i] - y)) i = n;
        }
        out.push({ color: ser.color,
                   text: `${ser.label}: ${fmtNum(ser.xs[i])} ${v.units || ''}` });
      }
      return out;
    },
  });
}

/** How stratified this selection is right now, as a readout line.
 *
 *  phi is the potential energy anomaly: the work per unit volume needed to mix
 *  the column, 0 when it already is. It is reported in preference to a bare
 *  surface-minus-bottom difference because it accounts for WHERE the density
 *  step sits, and it is the number the stratification literature uses. Both are
 *  shown, since the difference is the one people have an instinct for.
 *
 *  Needs temperature and salinity together; with only one of them any density
 *  is a guess with a unit on it, so nothing is printed.
 */
export function stratificationOf(sel, t) {
  if (!columns.ready) return '';
  const ks = Array.from(extractor.cells(sel).ks);
  const rho = densityAt(ks, t);
  if (!rho) return '';
  const T = colVar('temp') || colVar('etw');
  const c = columns.peek(T, ks);
  if (!c) return '';
  let phi = 0, dRho = 0, n = 0;
  for (let ci = 0; ci < c.ks.length; ci++) {
    const z = columns.interfaces(c.ks[ci], t);
    if (!z) continue;
    const f = rho(ci);
    const p = potentialEnergyAnomaly(z, f, columns.nz);
    const d = f(columns.nz - 1) - f(0);
    if (!Number.isFinite(p) || !Number.isFinite(d)) continue;
    phi += p; dRho += d; n++;
  }
  if (!n) return '';
  const mean = phi / n;
  return `stratification φ <b>${mean.toFixed(mean < 10 ? 2 : 1)}</b> J/m³`
    + ` · surface−bed Δρ ${(dRho / n).toFixed(2)} kg/m³`
    + (n > 1 ? ` <span class="nd">(mean of ${n} columns)</span>` : '');
}
