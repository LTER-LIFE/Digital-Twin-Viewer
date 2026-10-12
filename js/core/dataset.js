// The dataset this page shows: which one the URL asks for, its meta.json, and
// the binary fields every other module reads.
//
// Evaluating this module IS the first loading phase. It uses top-level await,
// so every importer waits for the data and then sees plain constants.

import { readState } from '../state.js';
import { $ } from '../util.js';

/** Fetch a binary file, reporting bytes as they arrive. */
export async function fetchProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes && onBytes(got);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

export const URL_STATE = readState();
export const DS = URL_STATE.dataset || 'default';
export const DATA = `./data/${encodeURIComponent(DS)}`;

const metaRes = await fetch(`${DATA}/meta.json`);
if (!metaRes.ok) {
  alert(`Dataset "${DS}" not found — returning to the default dataset.`);
  location.href = location.pathname;
  throw new Error('dataset missing');
}
export const meta = await metaRes.json();
export const NX = meta.nx, NY = meta.ny, N = NX * NY, NDAYS = meta.nDays;
export const EXT_X = meta.extentKm[0], EXT_Z = meta.extentKm[1];
export const BASE_M = meta.baseHeight;
export const STEP_DAYS = meta.stepDays || 1;
export const START_MS = Date.parse((meta.startDate || '2015-01-01') + 'T00:00:00Z');
export const TITLE = meta.title || 'Dutch Wadden Sea 500m';
export const STEP_WORD = STEP_DAYS === 1 ? 'Day' : 'Step';
export const DATUM = meta.verticalDatum || null;
export const LEVEL_UNIT = DATUM ? `m ${DATUM}` : 'm';
/** Per-step domain statistics written by the pipeline. */
export const ST = meta.stats;
export const VARIABLES = Array.isArray(meta.variables) ? meta.variables
  : Array.isArray(meta.params) ? meta.params : [];

document.title = `${TITLE} — Digital Twin Viewer`;
$('st-title').textContent = TITLE;
$('st-sub').textContent = `${NX}×${NY} · ${meta.cellKm} km cells`;
$('loader-hint').textContent = `${TITLE} · ${NDAYS} time steps`;

export const FLOW = (meta.flow && meta.flow.hasFlow) ? meta.flow : null;
const elevSize = NDAYS * N * 2;
const flowSize = FLOW ? N * 2 * FLOW.nFrames : 0;
const loadSize = elevSize + flowSize;
const bar = $('bar'), loadPct = $('load-pct');
// the two big files stream in parallel, so each reports into its own slot and
// the bar shows their sum — a single shared counter would jitter between them
const gotBytes = [0, 0];
const onBytes = (slot) => (b) => {
  gotBytes[slot] = b;
  const t = gotBytes[0] + gotBytes[1];
  bar.style.width = (Math.min(1, t / loadSize) * 100).toFixed(1) + '%';
  loadPct.textContent = (t / 1e6).toFixed(1) + ' / ' + (loadSize / 1e6).toFixed(0) + ' MB';
};
const [terrainBuf, masksBuf, elevBuf, latlonBuf, flowBuf] = await Promise.all([
  fetchProgress(`${DATA}/terrain.bin`),
  fetchProgress(`${DATA}/masks.bin`),
  fetchProgress(`${DATA}/elev.bin`, onBytes(0)),
  // true per-cell (lat, lon) — absent on datasets processed before it was added
  meta.hasLatLon ? fetchProgress(`${DATA}/latlon.bin`).catch(() => null) : null,
  // velocity field for the flow animation — only when the .nc had a u/v pair
  FLOW ? fetchProgress(`${DATA}/flow.bin`, onBytes(1)).catch(() => null) : null,
]);
/** Bed / land elevation in metres, +up. */
export const terrain = new Float32Array(terrainBuf);
/** bit0 land, bit1 intertidal. */
export const masks = new Uint8Array(masksBuf);
/** Water level in cm, NDAYS x N. */
export const elevI16 = new Int16Array(elevBuf);
/** Interleaved per-cell (lat, lon), or null. */
export const latlon = latlonBuf ? new Float32Array(latlonBuf) : null;
// kept as raw uint8 (48 MB) — expanding to Float32 would cost 4x for no gain
export const flowU8 = flowBuf ? new Uint8Array(flowBuf) : null;
/** Bed elevation in cm, for wet tests against elevI16 without a multiply. */
export const terrainCm = new Int16Array(N);
for (let i = 0; i < N; i++) terrainCm[i] = Math.round(terrain[i] * 100);

/** Bytes held after the boot load; variables.js adds its cached arrays to it. */
export const BOOT_BYTES = terrainBuf.byteLength + masksBuf.byteLength + elevBuf.byteLength +
  (latlonBuf ? latlonBuf.byteLength : 0) + (flowBuf ? flowBuf.byteLength : 0);
