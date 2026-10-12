// Model vs obs tab: every model–observation pair for the variable on screen,
// plotted against the 1:1 line, with pooled and per-group skill.

import { Chart } from '../chart.js';
import { skill } from '../observations.js';
import { haversineKm, latLonOfCell } from '../core/geo.js';
import { $, fmtNum, niceName, escapeHtml } from '../util.js';
import { extractor, obs, selections } from '../features/services.js';
import { stepIndex } from '../features/time.js';
import { varState, colourScale } from '../features/variables.js';
import {
  OBS_KM, sgn, biasText, obsTarget, stationPairs, obsStationsFor, surveyPairs,
} from '../obs/compare.js';
import { obsVersion } from '../obs/panel.js';

const validChart = new Chart($('c-valid'));

/** Everything that can be paired with the run for the variable on screen.
 *  With selections: the stations and survey samples tied to them. Without:
 *  every station of every collection that can be compared -- the run-wide
 *  view a validation starts from. */
export function validationGroups() {
  const target = obsTarget();
  const groups = [];
  let waiting = false;
  if (!obs.ready || !$('ser-obs').checked) return { groups, waiting, target };
  const sels = selections.active.filter((x) => x.type !== 'transect');
  const seen = new Set();
  const addStation = (a, color) => {
    if (seen.has(a.st.key)) return;
    seen.add(a.st.key);
    const r = stationPairs(a.st, a.m, target);
    if (!r) { waiting = true; return; }
    if (r.pairs.length) {
      groups.push({ label: a.st.name, color, pairs: r.pairs, stats: r.stats, anomaly: r.anomaly,
                    st: a.st, m: a.m, notes: r.notes });
    }
  };
  if (sels.length) {
    for (const sel of sels) for (const a of obsStationsFor(sel, target)) addStation(a, sel.color);
  } else {
    for (const a of obs.stationsFor(target.desc, target.special)) addStation(a, a.st.coll.color);
  }
  if (target.desc) {
    let keep = null;
    if (sels.length) {
      const inArea = new Set();
      const pts = [];
      for (const sel of sels) {
        const c = extractor.cells(sel);
        if (sel.type === 'area') for (const k of c.ks) inArea.add(k);
        else { const ll = latLonOfCell(c.ks[0]); if (ll) pts.push(ll); }
      }
      keep = (p) => inArea.has(p.cell.k)
        || pts.some(([la, lo]) => haversineKm(la, lo, p.lat, p.lon) <= OBS_KM);
    }
    for (const coll of obs.collections) {
      if (!coll.show || (coll.kind !== 'survey' && coll.kind !== 'trajectory')) continue;
      const m = obs.match(coll, target.desc);
      if (!m || !m.conv) continue;
      const pairs = surveyPairs(coll, m, target, keep);
      if (pairs === null) { waiting = true; continue; }
      if (pairs.length) groups.push({ label: coll.title, color: coll.color, pairs, stats: skill(pairs), coll, m });
    }
  }
  return { groups, waiting, target };
}

// The scatter only changes with what is paired, not with the step, so it is
// redrawn only when this signature does.
let validSig = '';
/** Force the next drawValidation() to redraw. */
export function invalidateValidation() { validSig = ''; }

export function drawValidation() {
  if (!obs.ready) {
    validSig = '';
    return validChart.draw({ empty: 'No observations overlap this run — load some in the Observations section.' });
  }
  const target = obsTarget();
  const surveyWin = obs.collections.some((c) => c.kind === 'survey' && c.window === 'window') ? stepIndex() : 0;
  const sig = [target.key, obsVersion, surveyWin, $('ser-obs').checked, colourScale.log,
    selections.active.map((x) => `${x.id}:${extractor.cells(x).key}`).join(',')].join('|');
  if (sig === validSig) return;                   // static: no need to redraw on each step
  const { groups, waiting } = validationGroups();
  if (!groups.length) {
    validSig = waiting ? '' : sig;
    return validChart.draw({
      empty: waiting ? 'Loading observations…'
        : `Nothing measured as ${target.desc ? niceName(target.desc) : 'water level'} can be paired with`
          + ` this run${selections.active.length ? ' at the selected places' : ''}.` });
  }
  validSig = waiting ? '' : sig;
  let lo = Infinity, hi = -Infinity, nAll = 0;
  const series = [];
  const MAXPTS = 6000;
  const pooled = [];
  for (const g of groups) {
    const step = Math.max(1, Math.ceil(g.pairs.length / MAXPTS));
    const xs = [], ys = [];
    for (let i = 0; i < g.pairs.length; i++) {
      const p = g.pairs[i];
      const o = g.anomaly ? p.o - g.stats.meanObs : p.o;
      const m = g.anomaly ? p.m - g.stats.meanModel : p.m;
      pooled.push({ o, m });
      if (i % step) continue;                      // thinned for drawing, scored in full
      xs.push(o); ys.push(m);
      lo = Math.min(lo, o, m); hi = Math.max(hi, o, m);
    }
    nAll += g.pairs.length;
    series.push({ label: `${g.label} (n ${g.pairs.length})`, color: g.color, xs, ys, noLine: true, dots: 1.9 });
  }
  const all = skill(pooled);
  const anomaly = groups.some((g) => g.anomaly);
  const u = target.units ? ` [${target.units}]` : '';
  // Plotted on log axes when the variable is shown on a log colour scale --
  // the statistics stay linear, and the title says which numbers they are
  const logAx = !!(varState && colourScale.log && !anomaly);
  let ticks = null;
  if (logAx) {
    let llo = Infinity, lhi = -Infinity;
    for (const ser of series) {
      for (let i = 0; i < ser.xs.length; i++) {
        const ok = ser.xs[i] > 0 && ser.ys[i] > 0;
        ser.xs[i] = ok ? Math.log10(ser.xs[i]) : NaN;
        ser.ys[i] = ok ? Math.log10(ser.ys[i]) : NaN;
        if (ok) { llo = Math.min(llo, ser.xs[i], ser.ys[i]); lhi = Math.max(lhi, ser.xs[i], ser.ys[i]); }
      }
    }
    lo = Number.isFinite(llo) ? llo : 0; hi = Number.isFinite(lhi) ? lhi : 1;
    ticks = [];
    for (let k = Math.floor(lo); k <= Math.ceil(hi); k++) ticks.push({ v: k, text: fmtNum(10 ** k) });
  }
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  series.unshift({ label: '1:1', color: 'rgba(255,255,255,.45)', xs: [lo, hi], ys: [lo, hi], width: 1, dash: [4, 4] });
  const back = (v) => (logAx ? 10 ** v : v);
  validChart.draw({
    x: { min: lo, max: hi, ticks, label: `Observed${anomaly ? ' anomaly' : ''}${u}${logAx ? ' (log)' : ''}` },
    y: { min: lo, max: hi, ticks, label: `Model${anomaly ? ' anomaly' : ''}${u}${logAx ? ' (log)' : ''}` },
    series, forceLegend: true,
    title: `n ${nAll} · ${anomaly ? 'anomalies' : `bias ${sgn(all.bias)}`} · RMSE ${fmtNum(all.rmse)}`
      + `${Number.isFinite(all.r) ? ` · r ${all.r.toFixed(2)}` : ''}${logAx ? ' (linear statistics)' : ''}`,
    hoverFmt: (x, y) => [{ text: `obs ${fmtNum(back(x))} · model ${fmtNum(back(y))}${u}` }],
  });
}

export function validationReadout() {
  const { groups, waiting, target } = validationGroups();
  if (!groups.length) {
    return waiting ? '<span class="nd">Loading observations…</span>'
      : '<span class="nd">Nothing to pair yet: pick a variable a loaded collection measures, or click'
        + ' a station on the map.</span>';
  }
  const u = target.units ? ' ' + escapeHtml(target.units) : '';
  return groups.map((g) => {
    const s = g.stats;
    const rr = Number.isFinite(s.r) ? ` · r <b>${s.r.toFixed(2)}</b>` : '';
    const notes = g.notes ? g.notes.slice(0, 3) : (g.m && g.m.conv && g.m.conv.factor !== 1 ? [`converted from ${g.m.var.units}`] : []);
    return `<span style="color:${g.color}">●</span> <b>${escapeHtml(g.label)}</b> — n ${s.n}`
      + ` · ${biasText(s, g.anomaly)} · RMSE <b>${fmtNum(s.rmse)}</b>${u}${rr}`
      + (notes.length ? ` <span class="nd">(${notes.map(escapeHtml).join(' · ')})</span>` : '');
  }).join('<br>');
}
