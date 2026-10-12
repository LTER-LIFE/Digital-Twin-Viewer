// The run's clock: where playback is (dayF, a fractional step), whether it is
// playing, and keeping the GPU fields in step with it.

import { N, NDAYS, elevI16, terrainCm } from '../core/dataset.js';
import { U, fA, fB, elevTexA, elevTexB, loadFrame, wetArr, wetTex, prevWet } from '../render/fields.js';
import { flow, setFlowFrames } from '../render/flowTrails.js';
import { $ } from '../util.js';
import { varState, loadVarFrames } from './variables.js';
import { urlState } from './urlSync.js';

/** Current time as a fractional step index. */
export let dayF = 0;
export let playing = true;
let daysPerSec = 3;
let dayA = -1, lastIntDay = -1;

const slider = $('day-slider');
const playBtn = $('play');

export const stepIndex = () => Math.min(Math.floor(dayF), NDAYS - 1);

/** Water level in metres at a cell, interpolated exactly as the shaders do. */
export const levelAtCell = (k) => fA[k] * (1 - U.uMix.value) + fB[k] * U.uMix.value;

function stepWetness(day, reset) {
  const off = day * N;
  if (reset) {
    for (let i = 0; i < N; i++) {
      const w = elevI16[off + i] > terrainCm[i] ? 1 : 0;
      wetArr[i * 2] = w; wetArr[i * 2 + 1] = 0; prevWet[i] = w;
    }
  } else {
    for (let i = 0; i < N; i++) {
      const w = elevI16[off + i] > terrainCm[i] ? 1 : 0;
      if (w) {
        wetArr[i * 2 + 1] = prevWet[i] ? wetArr[i * 2 + 1] * 0.72 : 1;
        wetArr[i * 2] = 1;
      } else {
        wetArr[i * 2] *= 0.90;
        wetArr[i * 2 + 1] *= 0.72;
      }
      prevWet[i] = w;
    }
  }
  wetTex.needsUpdate = true;
}

/** Load the frames bracketing dayF and set the blend between them. */
export function setDayTextures() {
  const d0 = Math.min(Math.floor(dayF), NDAYS - 1);
  const d1 = Math.min(d0 + 1, NDAYS - 1);
  if (d0 !== dayA) {
    loadFrame(fA, elevTexA, d0);
    loadFrame(fB, elevTexB, d1);
    setFlowFrames(d0, d1);
    dayA = d0;
  }
  U.uMix.value = Math.min(dayF - d0, 1);
  // wetness bookkeeping at integer-day granularity
  if (d0 !== lastIntDay) {
    const jump = d0 - lastIntDay;
    const scrubbed = lastIntDay < 0 || jump < 0 || jump > 8;
    if (scrubbed) stepWetness(d0, true);
    else for (let d = lastIntDay + 1; d <= d0; d++) stepWetness(d, false);
    // a jump lands the trails in a field they were never advected by, and any
    // that are now over dry ground would linger until they aged out
    if (scrubbed && lastIntDay >= 0 && flow) flow.reseed();
    lastIntDay = d0;
  }
  if (varState) loadVarFrames(false);
}

// ---------------------------------------------------------------- playback
export function setPlay(p) { playing = p; playBtn.textContent = p ? '❚❚' : '▶'; }

export function setDay(d) {
  dayF = Math.min(Math.max(d, 0), NDAYS - 1);
  slider.value = dayF;
  urlState.touch();
}

/** Advance the clock by one rendered frame. */
export function tick(dt) {
  if (playing) {
    dayF += daysPerSec * dt;
    if (dayF >= NDAYS - 1) dayF = 0;      // loop the year
    slider.value = dayF;
  }
}

export function initTimeline() {
  slider.max = NDAYS - 1;
}

export function initPlayback() {
  playBtn.addEventListener('click', () => setPlay(!playing));
  setPlay(true);

  slider.addEventListener('input', () => { dayF = parseFloat(slider.value); urlState.touch(); });

  document.querySelectorAll('.spd').forEach((b) => b.addEventListener('click', () => {
    daysPerSec = parseFloat(b.dataset.spd);
    document.querySelectorAll('.spd').forEach((x) => x.classList.toggle('on', x === b));
  }));
}
