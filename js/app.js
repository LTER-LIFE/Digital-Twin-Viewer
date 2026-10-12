// Digital Twin Viewer — entry point.
//
// This file only puts the pieces together, in order, and runs the frame loop.
// Where things live:
//
//   core/      the dataset (meta + binary fields), calendar, coordinates
//   render/    WebGL: renderer & camera, GPU fields & uniforms, scene meshes,
//              flow trails, observation markers; shaderLib loads ../shaders/
//   features/  the sidebar sections and app state: time, variables, view,
//              selections, export, URL, tooltip, keyboard
//   dock/      the chart dock: one module per tab, plus the readout
//   obs/       field observations: model comparison, markers, sidebar panel
//
// Importing core/dataset.js (and render/fields.js, render/shaderLib.js)
// already loads the data and shaders: they use top-level await, so by the
// time the code below runs, everything it needs is resident.

import * as THREE from 'three';

import './render/shaderLib.js';
import {
  URL_STATE, meta, NX, NY, N, NDAYS, VARIABLES,
} from './core/dataset.js';
import { cellFromLatLon, latLonOfCell, haversineKm, SNAP_TOL_KM } from './core/geo.js';
import { renderer, scene, camera, controls } from './render/viewport.js';
import { U } from './render/fields.js';
import { createTerrain } from './render/terrain.js';
import { createWater } from './render/water.js';
import { createFlowTrails, flow } from './render/flowTrails.js';
import { createSkirts } from './render/skirts.js';
import { createSky } from './render/sky.js';
import { $ } from './util.js';

import {
  createShell, createAnalysis, shell, extractor, columns, obs, selections,
} from './features/services.js';
import {
  dayF, playing, setDay, setPlay, setDayTextures, tick, initTimeline, initPlayback,
} from './features/time.js';
import { initStatusStrip, updateHUD, updateScaleBar, updateCompass } from './features/hud.js';
import {
  varState, colourScale, selectVariable, buildVariableUI, initColourScaleControls, updateMemory,
} from './features/variables.js';
import { initViewControls, buildFlowUI, setMode } from './features/viewControls.js';
import { buildInfoPanels } from './features/infoPanels.js';
import { initSelectionPanel, onSelectionsChanged } from './features/selectionPanel.js';
import { initPointEntry } from './features/pointEntry.js';
import { initPointer } from './features/tooltip.js';
import { initDatasetBrowser, refreshDatasets } from './features/datasets.js';
import { initExportPanel } from './features/exportPanel.js';
import { urlState, applyUrlState } from './features/urlSync.js';
import { initKeyboard } from './features/keyboard.js';

import { initDock, drawCharts } from './dock/dock.js';
import { seriesChart } from './dock/series.js';
import { profileChart } from './dock/profile.js';
import { vertChart, initVerticalPanel } from './dock/vertical.js';
import { hovChart } from './dock/hovmoller.js';
import { updateReadout } from './dock/readout.js';

import { createObsLayer, obsLayer } from './obs/markers.js';
import { renderObsPanel, initObsPanel, addStationSelection } from './obs/panel.js';

// ---------------------------------------------------------------- scene
createShell();
createTerrain();
createWater();
createFlowTrails();
createSkirts();
const sky = createSky();

// ---------------------------------------------------------------- controls
initStatusStrip();
initTimeline();
initColourScaleControls();
initViewControls();
initPlayback();

// ---------------------------------------------------------------- analysis
await createAnalysis({ onSelectionsChanged });
initSelectionPanel();
initPointEntry();
createObsLayer();
initVerticalPanel();
initDock();
initPointer();
initDatasetBrowser();
initExportPanel();

// A deliberate handle on the pieces worth poking at from the console: the
// charts keep their last spec, so `__app.charts.vert.spec` is the quickest way
// to see what a panel was actually asked to draw. It is also what the headless
// tests drive. Read-only by convention — nothing in the app reads it back.
window.__app = {
  columns, obs, obsLayer, addStationSelection, extractor, selections, shell, meta, NX, NY, N, NDAYS,
  charts: { series: seriesChart, profile: profileChart, vert: vertChart, hov: hovChart },
  selectVariable, setDay, cellFromLatLon, latLonOfCell, drawCharts, updateReadout,
  setPlay,
  get playing() { return playing; },
  get step() { return dayF; },
  place: (type, pts) => selections.commit(type, pts),
  // Placing by coordinate is what a scripted tour and a validation workflow
  // both want: "the cell at 56.00 N, 2.00 E", not a pixel on the canvas.
  // Refuses rather than snaps when a position lands outside the domain, by the
  // same tolerance the typed-coordinate panel uses: a tour that silently moved
  // a station to the nearest border cell would be worse than one that stopped.
  placeAt: (type, coords, name) => {
    const pts = [];
    for (const [la, lo] of coords) {
      const c = cellFromLatLon(la, lo);
      if (!c) return null;
      const ll = latLonOfCell(c.i * NX + c.j);
      if (ll && haversineKm(la, lo, ll[0], ll[1]) > SNAP_TOL_KM) return null;
      pts.push([c.i, c.j]);
    }
    return pts.length ? selections.commit(type, pts, name) : null;
  },
  get varState() { return varState; },
  get colourScale() { return colourScale; },
};

initKeyboard();

// ---------------------------------------------------------------- boot
buildVariableUI();
buildFlowUI();
buildInfoPanels();
updateMemory();
setMode(0);
onSelectionsChanged();
renderObsPanel();
initObsPanel();
try { await refreshDatasets(); } catch { /* plain static server — browser stays hidden */ }

// apply whatever the URL asked for, before the first frame is shown
await applyUrlState(URL_STATE);
urlState.start();       // only now may the address bar be rewritten

setDayTextures();
updateHUD();
updateScaleBar();
if (flow) flow.reseed();      // needs the day-0 water levels loaded above
$('loader').style.display = 'none';

// debug / scripting hooks
window.__viz = {
  setDay,
  setMode,
  setPlay,
  setVariable: selectVariable,
  setParam: selectVariable,     // deprecated alias, kept for existing scripts
  variables: VARIABLES,
  selections,
  extractor,
  flow,
  camera, controls, meta,
};

// ---------------------------------------------------------------- frame loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  U.uTime.value += dt;
  tick(dt);
  setDayTextures();
  updateHUD();
  if (flow) flow.update(dt);
  selections.update();
  obsLayer.update();
  sky.position.copy(camera.position);
  updateScaleBar();
  updateCompass();
  controls.update();
  renderer.render(scene, camera);
}
animate();
