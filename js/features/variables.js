// Scalar variables draped over the sea (temperature, salinity, plankton, …):
// loading and caching their arrays, the colour scale, the colour bar, and the
// Variables section of the sidebar.

import {
  meta, DATA, N, VARIABLES, masks, terrain, flowU8, BOOT_BYTES, fetchProgress,
} from '../core/dataset.js';
import { U, pFA, pFB, varTexA, varTexB, setCmapTex } from '../render/fields.js';
import { enhanceCmapSelect } from '../cmappicker.js';
import { CMAP_GROUPS, cmapLabel, isCmap, defaultCmap, cssGradient } from '../colormaps.js';
import { makeDecoder, quantum } from '../timeseries.js';
import { $, fmtNum, niceName, withUnits, escapeHtml } from '../util.js';
import { stepIndex, levelAtCell } from './time.js';
import { urlState } from './urlSync.js';
import { drawCharts, updateTabs } from '../dock/dock.js';
import { updateReadout } from '../dock/readout.js';

/** The variable on screen: { ...descriptor, arr, decode, storeLo, storeHi }, or null. */
export let varState = null;
let varDayA = -1;
/** The colour scale the drape, colour bar, charts and markers all share. */
export const colourScale = { lo: 0, hi: 1, cmap: 'viridis', log: false, rev: false };
let cmapPicker = null;   // set once buildVariableUI has filled the <select>

/** The colormap a variable should open with.
 *
 *  meta.json records the pipeline's guess from the day the dataset was built,
 *  so a rule fixed or a map added later would never reach it — this dataset was
 *  processed when "Suspended sediment" still fell through to viridis. Trust the
 *  stored name only when this build knows it AND it is not the pipeline's own
 *  fallback; otherwise classify from the variable's name, units and range.
 */
const cmapFor = (p) => (p.colormap && p.colormap !== 'viridis' && isCmap(p.colormap))
  ? p.colormap : defaultCmap(p);

// ---------------------------------------------------------------- array cache
// Variable arrays are 23 MB each as uint8 and 47 MB as uint16, so they cannot
// all stay resident: two is enough to flip back and forth between a pair of
// fields without a refetch, and bounded enough not to exhaust a laptop.
const VAR_CACHE_MAX = 2;
const varCache = new Map();
let bytesResident = BOOT_BYTES;
function cachePut(key, arr) {
  varCache.delete(key);
  varCache.set(key, arr);
  while (varCache.size > VAR_CACHE_MAX) {
    const oldest = varCache.keys().next().value;
    bytesResident -= varCache.get(oldest).byteLength;
    varCache.delete(oldest);
  }
  updateMemory();
}
export function updateMemory() {
  const held = [...varCache.keys()].join(', ') || 'none';
  $('mem-note').innerHTML =
    `<b>${(bytesResident / 1e6).toFixed(0)} MB</b> held in the browser: elevation` +
    `${flowU8 ? ', flow' : ''}, terrain and masks, plus the cached variable ` +
    `array${varCache.size === 1 ? '' : 's'} (${escapeHtml(held)}). At most ` +
    `${VAR_CACHE_MAX} variables are kept; switching beyond that refetches.`;
}

// A descriptor written by the current pipeline names its own file and says how
// wide its samples are. One without either predates the uint16 change, and is
// a uint8 field normalised over the percentile range in `lo`/`hi`.
const varFile = (p) => p.file || `param_${p.key}.bin`;
const storeRange = (p) => (p.bytes === 2 ? [p.dataMin, p.dataMax] : [p.lo, p.hi]);

/** Layer provenance — a 4-D field silently became one layer, and the reader is
 *  entitled to know which one. */
export function layerLabel(p) {
  if (p.layerLabel) return p.layerLabel;
  if (p.layer === null || p.layer === undefined) return null;
  const of = meta.nLayers ? ` of ${meta.nLayers}` : '';
  return `surface layer (k = ${p.layer + 1}${of})`;
}

/** Push the variable's bracketing steps into the drape textures. */
export function loadVarFrames(force) {
  if (!varState) return;
  const nf = varState.nFrames;
  const d0 = varState.static ? 0 : Math.min(stepIndex(), nf - 1);
  const d1 = varState.static ? 0 : Math.min(d0 + 1, nf - 1);
  if (!force && d0 === varDayA) return;
  // normalise to 0..1 over the STORED range here; the shader turns that back
  // into physical units and applies the user's colour range
  const a = varState.arr, inv = varState.bytes === 2 ? 1 / 65535 : 1 / 255;
  const oA = d0 * N, oB = d1 * N;
  for (let i = 0; i < N; i++) { pFA[i] = a[oA + i] * inv; pFB[i] = a[oB + i] * inv; }
  varTexA.needsUpdate = true; varTexB.needsUpdate = true;
  varDayA = d0;
}

// ---------------------------------------------------------------- selecting one
// Guards against a slow fetch finishing after a later one. Clicking two
// variables in quick succession would otherwise leave whichever download
// happened to be slower as the displayed field, with the list highlighting the
// other one.
let varRequest = 0;

export async function selectVariable(key, opts = {}) {
  const request = ++varRequest;
  if (!key) {
    varState = null; U.uVarOn.value = 0; varDayA = -1;
    updateVariableUI(null);
    updateTabs();
    drawCharts(); updateReadout();
    return;
  }
  const p = VARIABLES.find((x) => x.key === key);
  if (!p) return;
  if (varState && varState.key === key && !opts.force) return;
  updateVariableUI(p, 'loading');
  let arr = varCache.get(key);
  if (!arr) {
    try {
      const buf = await fetchProgress(`${DATA}/${varFile(p)}`);
      if (request !== varRequest) return;            // superseded while loading
      arr = p.bytes === 2 ? new Uint16Array(buf) : new Uint8Array(buf);
      bytesResident += buf.byteLength;
      cachePut(key, arr);
    } catch (e) {
      if (request !== varRequest) return;
      alert('Could not load variable "' + niceName(p) + '":\n' + e.message);
      updateVariableUI(varState);
      return;
    }
  } else {
    cachePut(key, arr);              // refresh LRU position
  }
  const [sLo, sHi] = storeRange(p);
  varState = { ...p, arr, storeLo: sLo, storeHi: sHi, decode: makeDecoder(p) };
  colourScale.cmap = opts.cmap || cmapFor(p);
  colourScale.lo = Number.isFinite(opts.lo) ? opts.lo : p.lo;
  colourScale.hi = Number.isFinite(opts.hi) ? opts.hi : p.hi;
  colourScale.log = !!opts.log;
  colourScale.rev = !!opts.rev;
  U.uVarOn.value = 1;
  varDayA = -1;
  applyColourScale();
  loadVarFrames(true);
  updateVariableUI(varState);
  updateTabs();
  drawCharts();
  updateReadout();
}

/** The variable as a source for the extractor, or null with none on screen. */
export const currentSource = () => (varState
  ? { kind: 'variable', desc: varState, arr: varState.arr, decode: varState.decode }
  : null);

/** A variable that carries vertical columns, by key. */
export const colVar = (key) => VARIABLES.find((v) => v.key === key && v.column);
/** The variable actually drawn in the vertical views. */
export const vertVar = () => (varState && varState.column ? varState : null);

// ---------------------------------------------------------------- colour scale
export function applyColourScale() {
  if (!varState) return;
  // a log scale needs a strictly positive lower bound; fall back to the
  // smallest positive value the stored range can represent
  if (colourScale.log && colourScale.lo <= 0) {
    const span = varState.storeHi - varState.storeLo;
    colourScale.lo = Math.max(varState.storeLo, 0) + Math.abs(span) * 1e-4 || 1e-6;
  }
  if (!(colourScale.hi > colourScale.lo)) colourScale.hi = colourScale.lo + Math.abs(colourScale.lo || 1) * 1e-3;
  U.uVarRange.value.set(varState.storeLo, varState.storeHi, colourScale.lo, colourScale.hi);
  U.uVarLog.value = colourScale.log ? 1 : 0;
  setCmapTex(colourScale.cmap, colourScale.rev);
  $('cs-min').value = +colourScale.lo.toPrecision(6);
  $('cs-max').value = +colourScale.hi.toPrecision(6);
  $('cs-log').checked = colourScale.log;
  $('cs-rev').checked = colourScale.rev;
  $('cs-cmap').value = colourScale.cmap;
  if (cmapPicker) cmapPicker.sync();
  updateColorbar();
  urlState.touch();
}

/** Colour position of a value under the current scale, 0..1. */
export function position(v) {
  const { lo, hi, log } = colourScale;
  if (log) {
    const l0 = Math.max(lo, 1e-12);
    return Math.log(Math.max(v, l0 * 1e-6) / l0) / Math.max(Math.log(Math.max(hi, l0 * 1.000001) / l0), 1e-6);
  }
  return (v - lo) / ((hi - lo) || 1);
}

export function updateColorbar() {
  const cb = $('colorbar');
  if (!varState) { cb.hidden = true; return; }
  cb.hidden = !$('ov-colorbar').checked;
  $('cb-title').textContent = withUnits(varState);
  $('cb-bar').style.background = cssGradient(colourScale.cmap, colourScale.rev);
  const u = varState.units ? ' ' + varState.units : '';
  $('cb-lo').textContent = fmtNum(colourScale.lo) + u;
  $('cb-hi').textContent = fmtNum(colourScale.hi);
  $('cb-mid').textContent = colourScale.log
    ? fmtNum(Math.sqrt(Math.max(colourScale.lo, 1e-12) * colourScale.hi))
    : fmtNum((colourScale.lo + colourScale.hi) / 2);
  // hatch the ends where real data exists outside the chosen scale, so a
  // saturated area never reads as a genuine plateau
  $('cb-cap-lo').classList.toggle('show', colourScale.lo > varState.storeLo + 1e-12);
  $('cb-cap-hi').classList.toggle('show', colourScale.hi < varState.storeHi - 1e-12);
}

// ---------------------------------------------------------------- sidebar section
function updateVariableUI(active, state) {
  document.querySelectorAll('.var-item').forEach((b) =>
    b.classList.toggle('on', (b.dataset.key || '') === (active ? active.key : '')));
  const det = $('var-detail');
  if (!active) { det.hidden = true; updateColorbar(); return; }
  det.hidden = false;
  const q = quantum(active);
  const layer = layerLabel(active);
  const precision = active.bytes === 2
    ? `Stored as uint16 over ${fmtNum(active.dataMin)}–${fmtNum(active.dataMax)}; values resolve to ±${fmtNum(q / 2)} ${active.units || ''}.`
    : `Stored as uint8 over the 1st–99th percentile (${fmtNum(active.lo)}–${fmtNum(active.hi)}): ` +
      `values step by ${fmtNum(q)} ${active.units || ''} and the extreme 1 % at each end is clipped flat. ` +
      `Reprocess this dataset to get full precision.`;
  $('var-note').innerHTML =
    (state === 'loading' ? '<b>Loading…</b><br>' : '') +
    (layer ? `<b>Layer:</b> ${escapeHtml(layer)}<br>` : '') +
    escapeHtml(precision);
  $('var-note').classList.toggle('warn', active.bytes !== 2);
  // on a uint8 dataset the stored range IS the percentile range, so "full
  // range" would silently do nothing — say why instead of offering a dead button
  const full = $('cs-full');
  full.disabled = active.bytes !== 2;
  full.title = active.bytes === 2
    ? 'Stretch the scale to the true minimum and maximum of the field'
    : 'Unavailable: this dataset stores only the 1st–99th percentile range';
}

export function buildVariableUI() {
  const list = $('var-list');
  list.innerHTML = '';
  if (!VARIABLES.length) {
    list.innerHTML = '<p class="note">This dataset carries no scalar variables beyond water level.</p>';
    return;
  }
  const mk = (key, label, sub) => {
    const b = document.createElement('button');
    b.className = 'var-item'; b.dataset.key = key || '';
    b.innerHTML = `<span class="vi-name">${escapeHtml(label)}</span>` +
      (sub ? `<span class="vi-sub">${escapeHtml(sub)}</span>` : '');
    b.addEventListener('click', () => selectVariable(key || null));
    list.appendChild(b);
  };
  mk('', 'None (default view)', '');
  for (const p of VARIABLES) mk(p.key, niceName(p), p.units || '');

  const sel = $('cs-cmap');
  sel.innerHTML = CMAP_GROUPS.map((g) =>
    `<optgroup label="${escapeHtml(g.label)}">` +
    g.names.map((n) => `<option value="${n}">${escapeHtml(cmapLabel(n))}</option>`).join('') +
    '</optgroup>').join('');
  cmapPicker = enhanceCmapSelect(sel, { reversed: () => colourScale.rev });
  updateVariableUI(null);
}

/** Min / max, colormap, log, reverse and the three range presets. */
export function initColourScaleControls() {
  const onScaleInput = () => {
    const lo = parseFloat($('cs-min').value), hi = parseFloat($('cs-max').value);
    if (Number.isFinite(lo)) colourScale.lo = lo;
    if (Number.isFinite(hi)) colourScale.hi = hi;
    applyColourScale();
    drawCharts();
  };
  $('cs-min').addEventListener('change', onScaleInput);
  $('cs-max').addEventListener('change', onScaleInput);
  $('cs-cmap').addEventListener('change', (e) => {
    colourScale.cmap = e.target.value;
    applyColourScale();
    drawCharts();
  });
  $('cs-log').addEventListener('change', (e) => {
    colourScale.log = e.target.checked;
    applyColourScale();
    drawCharts();
  });
  $('cs-rev').addEventListener('change', (e) => {
    colourScale.rev = e.target.checked;
    applyColourScale();
    drawCharts();
  });
  $('cs-reset').addEventListener('click', () => {
    if (!varState) return;
    colourScale.lo = varState.lo; colourScale.hi = varState.hi;
    applyColourScale(); drawCharts();
  });
  $('cs-full').addEventListener('click', () => {
    if (!varState) return;
    colourScale.lo = varState.storeLo; colourScale.hi = varState.storeHi;
    applyColourScale(); drawCharts();
  });
  $('cs-step').addEventListener('click', () => {
    if (!varState) return;
    // range of the current timestep over water only — land cells hold a
    // nearest-filled neighbour value and would widen the scale for nothing
    const t = varState.static ? 0 : Math.min(stepIndex(), varState.nFrames - 1);
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < N; k++) {
      if ((masks[k] & 1) || levelAtCell(k) - terrain[k] <= 0.005) continue;
      const v = varState.decode(varState.arr[t * N + k]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo < hi) { colourScale.lo = lo; colourScale.hi = hi; applyColourScale(); drawCharts(); }
  });
}
