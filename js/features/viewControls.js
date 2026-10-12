// The View and Flow sections of the sidebar: exaggeration, water clarity,
// brightness, realistic / analysis mode, orbit, map overlays, and the flow
// animation's controls.

import { U } from '../render/fields.js';
import { flow } from '../render/flowTrails.js';
import { syncCapHeight } from '../render/skirts.js';
import { controls, resetView } from '../render/viewport.js';
import { $ } from '../util.js';
import { updateColorbar } from './variables.js';
import { urlState } from './urlSync.js';

const modeBtn = $('b-mode');

/** 0 = realistic, 1 = analysis (intertidal state colours). */
export function setMode(m) {
  U.uMode.value = m;
  modeBtn.classList.toggle('on', m === 1);
  modeBtn.textContent = m === 1 ? 'Realistic mode' : 'Analysis mode';
  $('legend-items').innerHTML = m === 1 ? `
    <div class="li"><span class="sw" style="background:#1f7ad9"></span> Flooded intertidal flats</div>
    <div class="li"><span class="sw" style="background:#26ffbf"></span> Just flooded (this step)</div>
    <div class="li"><span class="sw" style="background:#ff7a26"></span> Recently fell dry</div>
    <div class="li"><span class="sw" style="background:#9e9270"></span> Dry flats</div>
    <div class="li"><span class="sw" style="background:#2a333f"></span> Permanent sea</div>
    <div class="li"><span class="sw" style="background:#4d5448"></span> Land</div>` : `
    <div class="li"><span class="sw" style="background:#2b5d7c"></span> Tidal channels &amp; sea</div>
    <div class="li"><span class="sw" style="background:#79c7d4"></span> Shallow water on flats</div>
    <div class="li"><span class="sw" style="background:#8a7355"></span> Wet sand (just exposed)</div>
    <div class="li"><span class="sw" style="background:#d9c9a3"></span> Dry sand flats</div>
    <div class="li"><span class="sw" style="background:#6d8f4e"></span> Islands &amp; mainland</div>`;
  urlState.touch();
}

export const toggleMode = () => setMode(U.uMode.value === 0 ? 1 : 0);

export function initViewControls() {
  $('r-exag').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    U.uHS.value = v / 1000;
    $('o-exag').textContent = v + '×';
    $('sb-ve').textContent = `V.E. ${v}×`;
    syncCapHeight();
    urlState.touch();
  });
  $('r-clar').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    U.uAlphaMul.value = 1.35 - v * 0.009;   // 10% -> 1.26 opaque, 100% -> 0.45 clear
    $('o-clar').textContent = v + '%';
    urlState.touch();
  });
  U.uAlphaMul.value = 1.35 - 55 * 0.009;
  $('r-bright').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    U.uBright.value = v / 100;
    $('o-bright').textContent = v + '%';
    urlState.touch();
  });

  modeBtn.addEventListener('click', toggleMode);

  const orbitBtn = $('b-orbit');
  orbitBtn.addEventListener('click', () => {
    controls.autoRotate = !controls.autoRotate;
    orbitBtn.classList.toggle('on', controls.autoRotate);
  });
  $('b-reset').addEventListener('click', resetView);

  for (const [id, el] of [['ov-scale', 'scalebar'], ['ov-compass', 'compass'],
    ['ov-legend', 'maplegend'], ['ov-status', 'statusbar']]) {
    $(id).addEventListener('change', (e) => { $(el).hidden = !e.target.checked; });
  }
  $('ov-colorbar').addEventListener('change', updateColorbar);
}

// ---------------------------------------------------------------- flow
export function buildFlowUI() {
  if (!flow) {
    $('flow-body').hidden = true;
    $('flow-absent').hidden = false;
    return;
  }
  const btn = $('b-flow');
  const setFlow = (on) => { flow.setEnabled(on); btn.classList.toggle('on', on); urlState.touch(); };
  btn.addEventListener('click', () => setFlow(!flow.enabled));
  setFlow(true);

  $('r-fdens').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    flow.setCount(v); $('o-fdens').textContent = v;
  });
  // slider is in tenths of an hour of model time per second of wall clock
  $('r-fspd').addEventListener('input', (e) => {
    const h = parseFloat(e.target.value) / 10;
    flow.setSpeedMul(h * 3600); $('o-fspd').textContent = h.toFixed(1) + ' h/s';
  });

  $('flow-note').innerHTML =
    `Depth-averaged current. Trails show each frame's instantaneous field, not particle tracks — ` +
    `a streak is where the water at that point is going, not where a parcel has been.`;
}
