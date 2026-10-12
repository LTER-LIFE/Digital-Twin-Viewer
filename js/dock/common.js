// Helpers shared by the chart panels: the timeseries spec builder, the series
// cache, and small colour / range utilities.

import { NDAYS, STEP_DAYS, LEVEL_UNIT } from '../core/dataset.js';
import { stepDate, TIME_TICKS } from '../core/calendar.js';
import { fmtNum } from '../util.js';
import { extractor, obs } from '../features/services.js';
import { dayF } from '../features/time.js';

// A series depends only on the selection geometry, the source field and the
// statistic — never on the current step, which is just a cursor. Recomputing
// one is a full pass over (cells x steps), so an area of a few thousand cells
// would otherwise be re-reduced several times a second during playback.
const seriesCache = new Map();
export function cachedSeries(sel, src, stat) {
  const cells = extractor.cells(sel);
  const srcKey = src.kind === 'variable' ? `v:${src.desc.key}` : src.kind;
  const key = `${sel.id}|${cells.key}|${srcKey}|${stat}`;
  let hit = seriesCache.get(key);
  if (!hit) {
    hit = extractor.series(sel, src, stat);
    if (seriesCache.size > 48) seriesCache.clear();
    seriesCache.set(key, hit);
  }
  return hit;
}

/** Build the common spec for a timeseries panel: x is the model time axis and
 *  the cursor is the animation's current step.
 *
 *  Series tagged `axis:'right'` are scaled separately. That is not decoration:
 *  exposed-flat area is km² and water level is metres, and putting them on one
 *  scale would draw two curves whose relative sizes mean nothing. */
export function timeSpec(series, bands, spans, yLabel, units) {
  const left = series.filter((s) => s.axis !== 'right');
  const right = series.filter((s) => s.axis === 'right');
  const [lo, hi] = extent(left.length ? left : series, bands);
  const y2 = right.length
    ? (() => {
      const [a, b] = extent(right, []);
      return { min: a, max: b, label: right[0].units || '' };
    })()
    : null;
  return {
    x: { min: 0, max: NDAYS - 1, ticks: TIME_TICKS, label: null },
    y: { min: lo, max: hi, label: yLabel },
    y2,
    series, bands, spans,
    cursor: dayF,
    hlines: units === LEVEL_UNIT && lo < 0 && hi > 0 ? [{ y: 0, label: `0 ${LEVEL_UNIT}` }] : null,
    hoverFmt: (x) => {
      const t = Math.round(Math.min(Math.max(x, 0), NDAYS - 1));
      const out = [{ text: stepDate(t).toISOString().slice(0, 10) }];
      for (const s of series) {
        let v = s.ys[t], when = '';
        if (s.irregular) {
          // observations sit at their own times: the nearest one, if close
          v = NaN;
          let bi = -1, bd = Infinity;
          for (let i = 0; i < s.xs.length; i++) {
            const d = Math.abs(s.xs[i] - x);
            if (d < bd) { bd = d; bi = i; }
          }
          if (bi >= 0 && bd <= Math.max(1, 0.5 / STEP_DAYS)) {
            v = s.ys[bi];
            when = ` (${new Date(obs.msOfTau(s.xs[bi])).toISOString().slice(0, 16).replace('T', ' ')})`;
          }
        }
        const u = s.units !== undefined ? s.units : units;
        out.push({
          color: s.color,
          text: `${s.label}: ${Number.isFinite(v) ? fmtNum(v) + (u ? ' ' + u : '') + when : 'no data'}`,
        });
      }
      return out;
    },
    empty: series.length ? null : 'Nothing to plot.',
  };
}

function extent(series, bands) {
  let lo = Infinity, hi = -Infinity;
  const scan = (a) => { for (const v of a) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
  for (const s of series) scan(s.ys);
  for (const b of bands) { scan(b.lo); scan(b.hi); }
  if (!Number.isFinite(lo)) return [0, 1];
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const pad = (hi - lo) * 0.06;
  return [lo - pad, hi + pad];
}

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
