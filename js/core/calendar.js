// The run's time axis as a calendar: step dates, month names, chart ticks, and
// the sampling caveat that every chart and export repeats.

import { NDAYS, STEP_DAYS, START_MS, STEP_WORD } from './dataset.js';

export const stepDate = (d) => new Date(START_MS + d * STEP_DAYS * 86400000);

export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const seasonOf = (m) => (m < 2 || m === 11) ? 'Winter' : m < 5 ? 'Spring' : m < 8 ? 'Summer' : 'Autumn';

// ---------------------------------------------------------------- caveats
// Daily sampling of a ~12.4 h semidiurnal tide is an alias: the apparent cycle
// is the beat between the two, not the tide. It affects every field in the
// file, not only the velocity, so it belongs at dataset level.
const stepHours = STEP_DAYS * 24;
const cycles = stepHours / 12.42;
const beat = Math.abs(1 / (Math.round(cycles) - cycles));
export const ALIASED = stepHours >= 6 && Number.isFinite(beat);
export const ALIAS_TEXT = ALIASED
  ? `Each frame is an instantaneous snapshot ${stepHours.toFixed(0)} h apart, not an average over ` +
    `the interval. With a ~12.4 h semidiurnal tide that under-samples the tidal cycle by ` +
    `${cycles.toFixed(2)} cycles per frame, so every field appears to cycle over ~${beat.toFixed(0)} ` +
    `${STEP_WORD.toLowerCase()}s — an alias, not a real signal. Compare like tidal phase with care.`
  : `Each frame is an instantaneous snapshot ${stepHours.toFixed(1)} h apart, not an average over the interval.`;

/** Ticks along the model time axis. Calendar labels beat step numbers, but the
 *  right calendar unit depends on how long the run is: a year of daily steps
 *  wants months, a fortnight of hourly steps wants days. */
function timeTicks() {
  const spanDays = Math.max(NDAYS - 1, 1) * STEP_DAYS;
  const iso = (d) => stepDate(d).toISOString();

  // month boundaries — the first step that lands in each new month
  if (spanDays > 80) {
    // Year numbers only earn their width on a run that actually crosses a year
    // boundary; on a single year they just collide with the next month's label.
    const multiYear = stepDate(0).getUTCFullYear() !== stepDate(NDAYS - 1).getUTCFullYear();
    const out = [];
    let lastMonth = -1;
    for (let d = 0; d < NDAYS; d++) {
      const date = stepDate(d);
      const m = date.getUTCMonth();
      if (m !== lastMonth) {
        out.push({ v: d, text: multiYear && m === 0 ? String(date.getUTCFullYear()) : MON3[m] });
        lastMonth = m;
      }
    }
    // thin out so labels never collide on a narrow dock
    const keep = Math.ceil(out.length / 12);
    return keep > 1 ? out.filter((_, i) => i % keep === 0) : out;
  }

  // day boundaries, or times within a day for a run shorter than about two days
  const out = [];
  const fmt = spanDays > 2
    ? (d) => iso(d).slice(5, 10)                       // MM-DD
    : (d) => iso(d).slice(11, 16);                     // HH:MM
  const wantEvery = Math.max(1, Math.round((spanDays > 2 ? 1 : 0.25) / STEP_DAYS));
  const stride = Math.max(wantEvery, Math.ceil(NDAYS / 10));
  for (let d = 0; d < NDAYS; d += stride) out.push({ v: d, text: fmt(d) });
  if (out.length < 2) {
    return [{ v: 0, text: iso(0).slice(0, 10) }, { v: NDAYS - 1, text: iso(NDAYS - 1).slice(0, 10) }];
  }
  return out;
}
export const TIME_TICKS = timeTicks();

/** Step indices 0..NDAYS-1, the x values of every timeseries. */
export const XS = Float64Array.from({ length: NDAYS }, (_, i) => i);
