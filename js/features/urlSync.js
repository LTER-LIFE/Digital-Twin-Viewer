// The view <-> address bar. Dataset, variable, timestep, colour scale,
// exaggeration, camera and selections all live in the URL, so a link restores
// exactly what was on screen.

import { DS } from '../core/dataset.js';
import { U } from '../render/fields.js';
import { flow } from '../render/flowTrails.js';
import { camera, controls } from '../render/viewport.js';
import { UrlState } from '../state.js';
import { $ } from '../util.js';
import { dayF, setDay } from './time.js';
import { varState, colourScale, selectVariable } from './variables.js';
import { setMode } from './viewControls.js';
import { selections } from './services.js';
import { areaStat, setAreaStat } from './selectionPanel.js';

// Writes stay off until boot calls urlState.start(); see state.js.
export const urlState = new UrlState(() => ({
  dataset: DS,
  variable: varState ? varState.key : null,
  step: dayF,
  cmin: varState ? colourScale.lo : undefined,
  cmax: varState ? colourScale.hi : undefined,
  cmap: varState ? colourScale.cmap : undefined,
  rev: varState ? colourScale.rev : undefined,
  log: colourScale.log,
  exag: parseFloat($('r-exag').value),
  clarity: parseFloat($('r-clar').value),
  bright: parseFloat($('r-bright').value),
  mode: U.uMode.value,
  flow: flow ? flow.enabled : undefined,
  stat: areaStat,
  cam: [camera.position.x, camera.position.y, camera.position.z,
    controls.target.x, controls.target.y, controls.target.z],
  selections: selections.list,
}));

/** Apply whatever the URL asked for, before the first frame is shown. */
export async function applyUrlState(s) {
  if (Number.isFinite(s.exag)) {
    $('r-exag').value = s.exag;
    $('r-exag').dispatchEvent(new Event('input'));
  }
  if (Number.isFinite(s.clarity)) {
    $('r-clar').value = s.clarity;
    $('r-clar').dispatchEvent(new Event('input'));
  }
  if (Number.isFinite(s.bright)) {
    $('r-bright').value = s.bright;
    $('r-bright').dispatchEvent(new Event('input'));
  }
  if (s.mode) setMode(1);
  if (s.flow === false && flow) $('b-flow').click();
  if (s.stat) { setAreaStat(s.stat); $('area-stat').value = s.stat; }
  // the URL is not live yet, so setDay's touch() writes nothing
  if (Number.isFinite(s.step)) setDay(s.step);
  if (s.cam) {
    camera.position.set(s.cam[0], s.cam[1], s.cam[2]);
    controls.target.set(s.cam[3], s.cam[4], s.cam[5]);
  }
  if (s.variable) {
    await selectVariable(s.variable, { lo: s.cmin, hi: s.cmax, cmap: s.cmap, log: s.log, rev: s.rev });
  }
  if (s.selections) {
    for (const sel of s.selections) selections.commit(sel.type, sel.pts, sel.name);
    selections.setTool(null);
  }
}
