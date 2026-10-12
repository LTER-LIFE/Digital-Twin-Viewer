// The text readout under the charts: the value at each selection at the
// current step, its stratification, and how it compares with observations.

import { LEVEL_UNIT, ST } from '../core/dataset.js';
import { $, fmtNum, escapeHtml } from '../util.js';
import { shell, extractor, selections } from '../features/services.js';
import { stepIndex } from '../features/time.js';
import { varState, currentSource, vertVar } from '../features/variables.js';
import { areaStat } from '../features/selectionPanel.js';
import {
  obsTarget, LEVEL_TARGET, obsStationsFor, stationPairs, obsSkillLine, obsSkillOf,
} from '../obs/compare.js';
import { cachedSeries } from './common.js';
import { stratificationOf } from './vertical.js';
import { validationReadout } from './validation.js';

export function updateReadout() {
  const el = $('readout');
  if (shell.tab === 'valid') { el.innerHTML = validationReadout(); return; }
  const t = stepIndex();
  const src = currentSource();
  const rows = [];
  for (const sel of selections.active) {
    const stat = sel.type === 'area' ? areaStat : 'mean';
    const cells = extractor.cells(sel);
    let line = `<span style="color:${sel.color}">■</span> <b>${escapeHtml(sel.name)}</b>`;
    if (src) {
      const r = cachedSeries(sel, src, stat);
      const v = r.ys[t];
      line += ` — ${Number.isFinite(v)
        ? `<b>${fmtNum(v)}</b> ${escapeHtml(varState.units || '')}`
        : '<span class="nd">no data (dry or land)</span>'}`;
      line += ` <span class="nd">(${r.n[t]}/${cells.ks.length} cells, ` +
        `${(r.wetFrac[t] * 100).toFixed(0)} % wet)</span>`;
    } else {
      const r = cachedSeries(sel, { kind: 'level' }, stat);
      const v = r.ys[t];
      line += ` — ${Number.isFinite(v)
        ? `level <b>${fmtNum(v)}</b> ${LEVEL_UNIT}`
        : '<span class="nd">dry at this step</span>'}`;
    }
    const strat = stratificationOf(sel, t);
    if (strat) line += `<br>&nbsp;&nbsp;<span class="nd">${strat}</span>`;
    if (shell.tab === 'vert') {
      const sk = obsSkillOf(sel, vertVar(), t);
      if (sk) line += `<br>&nbsp;&nbsp;<span class="nd">${sk}</span>`;
    } else if (shell.tab === 'series') {
      const targets = [obsTarget()];
      if (src && $('ser-level').checked) targets.push(LEVEL_TARGET);
      for (const target of targets) {
        for (const a of obsStationsFor(sel, target)) {
          line += `<br>&nbsp;&nbsp;<span class="nd">${obsSkillLine(a, stationPairs(a.st, a.m, target), target)}</span>`;
        }
      }
    }
    rows.push(line);
  }
  if (!rows.length) {
    rows.push(`Exposed flats <b>${ST.exposedKm2[t].toFixed(0)}</b> km² · ` +
      `flooded <b>${ST.floodedKm2[t].toFixed(0)}</b> km² · ` +
      `mean level <b>${ST.meanLevel[t] >= 0 ? '+' : ''}${ST.meanLevel[t].toFixed(2)}</b> ${LEVEL_UNIT}`);
    rows.push('<span class="nd">Place a selection to read values at a point, along a section, or over an area.</span>');
  }
  el.innerHTML = rows.join('<br>');
}
