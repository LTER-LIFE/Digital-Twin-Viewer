// Static text about the dataset: its properties and sampling note in the
// Dataset section, and the "Reading these numbers" caveats under Help.

import {
  meta, NX, NY, NDAYS, EXT_X, EXT_Z, STEP_DAYS, TITLE, DATUM, LEVEL_UNIT, FLOW, VARIABLES,
} from '../core/dataset.js';
import { ALIAS_TEXT } from '../core/calendar.js';
import { $, fmtNum, escapeHtml } from '../util.js';

export function buildInfoPanels() {
  $('alias-note').textContent = ALIAS_TEXT;

  const dl = $('ds-props');
  const rows = [
    ['Title', TITLE],
    ['Grid', `${NX} × ${NY} cells @ ${meta.cellKm} km`],
    ['Extent', `${EXT_X.toFixed(0)} × ${EXT_Z.toFixed(0)} km`],
    ['Time', `${NDAYS} steps × ${STEP_DAYS} d from ${meta.startDate}`],
    ['Bed range', `${fmtNum(meta.terrainMin)} to ${fmtNum(meta.terrainMax)} ${LEVEL_UNIT}`],
    ['Vertical datum', DATUM || 'not stated in the source file'],
    ['Intertidal', `${(meta.intertidalCells * meta.cellKm ** 2).toFixed(0)} km² (${meta.intertidalCells} cells)`],
    ['Coordinates', meta.hasLatLon ? `per-cell, grid north ${meta.gridNorthDeg}°` : 'bounding-box estimate only'],
    ['Velocity', FLOW ? `${FLOW.uName}/${FLOW.vName}, grid-aligned, peak ${fmtNum(FLOW.maxSpeed)} m/s` : 'none'],
    ['Imagery', meta.satellite ? (meta.satelliteAttribution || 'yes') : 'none'],
    ['Variables', VARIABLES.length ? VARIABLES.map((p) => p.name).join(', ') : 'none'],
  ];
  dl.innerHTML = rows.map(([k, v]) =>
    `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');

  const anyU8 = VARIABLES.some((p) => p.bytes !== 2);
  $('caveats').innerHTML = [
    `<p><b>Vertical exaggeration.</b> The default 200× makes a 1 m tidal range look like a
      200 m cliff. Slopes and volumes read from the picture are meaningless; the readouts
      and charts are not exaggerated.</p>`,
    `<p><b>Dry cells.</b> Where a cell falls dry the file has no water level, so the pipeline
      stores a fill value clamped below the bed to keep shorelines smooth. Charts break the
      line at those steps rather than plotting the fill.</p>`,
    `<p><b>Masked cells.</b> Land and dry cells are nearest-filled in the exported fields so the
      3-D drape has no seam at the coast. Readouts and charts suppress those cells, so a value
      you can see on screen near the coast may be reported as "no data" — that is the honest
      answer, not a bug.</p>`,
    anyU8 ? `<p><b>Value precision.</b> Variables in this dataset are stored as uint8 over their
      1st–99th percentile range, so values step coarsely and the extreme 1 % at each end is
      clipped flat. Reprocess the source file to store full-precision uint16.</p>` : '',
    `<p><b>Sampling.</b> ${escapeHtml(ALIAS_TEXT)}</p>`,
    DATUM ? '' : `<p><b>Datum.</b> The source file does not state a vertical datum, so elevations
      are reported as plain metres. Do not assume NAP or MSL.</p>`,
  ].join('');
}
