// The chart dock: which tabs are available, drawing the one on show, and the
// caption under it. Each tab's drawing lives in its own module.

import { ALIASED } from '../core/calendar.js';
import { $, withUnits } from '../util.js';
import { shell, columns, obs, selections } from '../features/services.js';
import { varState, colourScale, vertVar, layerLabel } from '../features/variables.js';
import { drawSeries } from './series.js';
import { drawProfile } from './profile.js';
import { drawVertical } from './vertical.js';
import { drawHovmoller } from './hovmoller.js';
import { drawValidation } from './validation.js';
import { updateReadout } from './readout.js';

/** Profile needs a transect; Hovmöller needs a transect AND a variable. Both
 *  the selection list and the variable choice can change either answer. */
export function updateTabs() {
  const tr = selections.transect;
  shell.enableTab('profile', !!tr);
  // the vertical panel works off any selection, not just a transect — a single
  // station's profile is the commonest thing anyone wants from a 4-D field
  const vert = columns.ready && !!vertVar() && selections.active.length > 0;
  shell.enableTab('vert', vert);
  $('b-vcsv').disabled = !vert;
  shell.enableTab('hov', (!!tr || vert) && !!varState);
  shell.enableTab('valid', obs.ready);
  $('b-pcsv').disabled = !obs.ready;
}

export function drawCharts() {
  if (shell.tab === 'series') drawSeries();
  else if (shell.tab === 'profile') drawProfile();
  else if (shell.tab === 'vert') drawVertical();
  else if (shell.tab === 'valid') drawValidation();
  else drawHovmoller();
  updateChartCaption();
}

function updateChartCaption() {
  const bits = [];
  if (varState) {
    bits.push(withUnits(varState)
      + (colourScale.log ? ', log scale' : '')
      + (colourScale.rev ? ', reversed colours' : ''));
    // the layer note describes what the panel in front of you is showing: the
    // drape is one layer, but the vertical panels draw the whole column, and
    // telling a reader "surface layer" under a full profile would be a lie
    const whole = columns.ready && !!vertVar() && (
      shell.tab === 'vert'
      || (shell.tab === 'profile' && !!selections.transect)
      || (shell.tab === 'hov' && !selections.transect));
    const l = whole ? `all ${columns.nz} layers` : layerLabel(varState);
    if (l) bits.push(l);
  }
  if (shell.tab === 'valid') {
    bits.push('model at each station\'s own cell, brought to the observation');
  }
  bits.push(ALIASED ? 'daily snapshots — tidally aliased' : 'instantaneous snapshots');
  $('dk-caption').textContent = bits.join(' · ');
}

export function initDock() {
  // The readout is tab-dependent too -- the vertical tab adds the model-minus-
  // observation line -- so a tab change has to refresh both. Refreshing only
  // the chart left the skill numbers absent until the step happened to change.
  shell.onTab(() => { drawCharts(); updateReadout(); });
}
