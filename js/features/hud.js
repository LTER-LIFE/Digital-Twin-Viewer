// What sits over the map and tracks the view: the status strip (date, step,
// season, tide trend), the scale bar and the compass.

import { meta, NDAYS, START_MS, STEP_DAYS, STEP_WORD, ST } from '../core/dataset.js';
import { stepDate, MONTHS, MON3, seasonOf } from '../core/calendar.js';
import { camera, controls, viewH } from '../render/viewport.js';
import { $ } from '../util.js';
import { stepIndex, setDay } from './time.js';
import { drawCharts } from '../dock/dock.js';
import { updateReadout } from '../dock/readout.js';

// ---------------------------------------------------------------- status strip
const stDate = $('st-date'), stStep = $('st-step'), seasonChip = $('season-chip'), tideChip = $('tide-chip');
const tlDate = $('tl-date'), stJump = $('st-jump');

export function initStatusStrip() {
  // The status strip drops its least important parts rather than letting the
  // groups collide. Measured rather than assumed from the window width: what
  // matters is the map area left over once the sidebar and the chart dock have
  // taken theirs, and either can be resized at any moment.
  {
    const bar = $('statusbar');
    // The left group is the one that gives way under flex, so "does it fit" is
    // really "is the run's name still being truncated". Summing intrinsic widths
    // instead would read as fitting the moment the title started clipping, which
    // is exactly the state worth avoiding.
    // #st-title is the element that actually clips (it carries the ellipsis), so
    // it is the one to ask. Its parent never overflows -- it just gets narrower.
    const title = $('st-title');
    const fits = () => title.scrollWidth <= title.clientWidth + 1;
    const fit = () => {
      bar.classList.remove('tight', 'tighter');
      if (!fits()) bar.classList.add('tight');       // drop step counter, date picker
      if (!fits()) bar.classList.add('tighter');     // drop the grid note as well
    };
    // hiding children does not change the bar's own box, so this cannot loop
    new ResizeObserver(fit).observe(bar);
    fit();
  }
  stJump.min = stepDate(0).toISOString().slice(0, 10);
  stJump.max = stepDate(NDAYS - 1).toISOString().slice(0, 10);
  stJump.addEventListener('change', () => {
    const t = Date.parse(stJump.value + 'T00:00:00Z');
    if (!Number.isFinite(t)) return;
    const d = Math.round((t - START_MS) / 86400000 / STEP_DAYS);
    setDay(Math.min(Math.max(d, 0), NDAYS - 1));
  });
}

let hudDay = -1;
/** Refresh everything keyed to the current step — once per step, not per frame. */
export function updateHUD() {
  const d = stepIndex();
  if (d === hudDay) return;
  hudDay = d;
  const date = stepDate(d);
  const m = date.getUTCMonth();
  const hhmm = STEP_DAYS < 0.99
    ? ` ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}` : '';
  stDate.textContent = `${date.getUTCDate()} ${MONTHS[m]} ${date.getUTCFullYear()}${hhmm}`;
  stStep.textContent = `${STEP_WORD} ${d + 1} / ${NDAYS}`;
  seasonChip.textContent = seasonOf(m);
  tlDate.textContent = `${String(date.getUTCDate()).padStart(2, '0')} ${MON3[m]}`;
  stJump.value = date.toISOString().slice(0, 10);
  const prev = ST.meanLevel[Math.max(d - 1, 0)], next = ST.meanLevel[Math.min(d + 1, NDAYS - 1)];
  const trend = next - prev;
  tideChip.textContent = trend > 0.03 ? 'Tide ▲ rising' : trend < -0.03 ? 'Tide ▼ falling' : 'Tide ~ steady';
  drawCharts();
  updateReadout();
}

// ---------------------------------------------------------------- scale bar
// World units are kilometres, so the bar is the on-screen length of a nice
// round distance at the depth of the camera target. It is drawn on the map and
// burned into exported figures — a 3-D block with no scale is a picture, not a
// measurement.
const NICE_KM = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
/** The bar as last drawn; figure export burns the same one into the PNG. */
export let scaleBar = { px: 80, label: '10 km' };
// These run every frame from the render loop, so they only touch the DOM when
// the value actually changed — writing an identical style or text still costs a
// style recalculation, and two of them per frame is a measurable tax for nothing.
export function updateScaleBar() {
  const dist = camera.position.distanceTo(controls.target);
  const visibleKm = 2 * dist * Math.tan((camera.fov * Math.PI) / 360);
  const kmPerPx = visibleKm / viewH;
  let km = NICE_KM[0];
  for (const c of NICE_KM) { km = c; if (c / kmPerPx >= 90) break; }
  const px = Math.round(km / kmPerPx);
  const label = km < 1 ? `${km * 1000} m` : `${km} km`;
  if (px === scaleBar.px && label === scaleBar.label) return;
  scaleBar = { px, label };
  $('sb-bar').style.width = px + 'px';
  $('sb-len').textContent = label;
}

// ---------------------------------------------------------------- compass
const needle = $('needle');
// The scene is drawn in grid space. On a rotated grid, world -Z is not true
// north — gridNorthDeg is its real bearing, so the needle has to back it out.
const GRID_NORTH = meta.gridNorthDeg || 0;
export const northDeg = () => controls.getAzimuthalAngle() * 180 / Math.PI - GRID_NORTH;
let lastBearing = null;

export function updateCompass() {
  // rotate(azimuth) alone points the needle along world -Z, i.e. grid north;
  // backing out its bearing swings it onto true north
  const bearing = northDeg().toFixed(1);
  if (bearing !== lastBearing) {
    lastBearing = bearing;
    needle.style.transform = `rotate(${bearing}deg)`;
  }
}
