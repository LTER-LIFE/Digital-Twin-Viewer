// The long-lived objects every panel works against. Each is created once, at
// the point in the boot sequence app.js gives, and read everywhere else
// through these exports — ES module bindings are live, so an importer sees the
// object as soon as it has been assigned here.

import {
  meta, DATA, DS, NX, NY, N, NDAYS, EXT_X, EXT_Z, STEP_DAYS, START_MS,
  terrain, masks, elevI16, latlon,
} from '../core/dataset.js';
import { U } from '../render/fields.js';
import { scene, camera, controls, renderer } from '../render/viewport.js';
import { initShell } from '../ui.js';
import { Columns } from '../vertical.js';
import { ObsStore, CellLocator } from '../observations.js';
import { Extractor } from '../timeseries.js';
import { Selections } from '../selection.js';
import { levelAtCell } from './time.js';

/** Sidebar, rail and chart dock (ui.js). */
export let shell = null;
/** Cell walks and series reductions over the resident arrays (timeseries.js). */
export let extractor = null;
/** Vertical grid and 4-D columns, fetched on demand (vertical.js). */
export let columns = null;
/** Nearest sea cell to a lat/lon (observations.js). */
export let locator = null;
/** Observation collections overlapping this run (observations.js). */
export let obs = null;
/** Points, transects and areas drawn on the map (selection.js). */
export let selections = null;

export function createShell() {
  shell = initShell();
}

/** Analysis back end. Waits for the vertical grid and the observation index;
 *  both are optional, and everything downstream checks `.ready`. */
export async function createAnalysis({ onSelectionsChanged }) {
  extractor = new Extractor({ NX, NY, N, NDAYS, terrain, masks, elevI16, latlon, cellKm: meta.cellKm });
  columns = new Columns({
    DATA, base: '.', slug: DS, NX, NY, N, NDAYS, terrain, elevI16, meta,
  });
  // a 2-D-only run simply has no vertical grid; everything below checks .ready
  await columns.load().catch(() => false);

  // Field observations: every collection in data/observations/ that overlaps
  // this run in space and time (see observations.js and OBSERVATIONS.md).
  // Optional in exactly the same way as the vertical grid: everything below
  // checks .ready.
  locator = new CellLocator({ latlon, NX, NY, N, masks, meta });
  obs = new ObsStore({
    base: './data/observations', DATA, DS, meta, NDAYS, STEP_DAYS, START_MS, locator,
  });
  await obs.load().catch((e) => console.warn('observations failed to load', e));

  selections = new Selections(
    { scene, camera, controls, renderer, NX, NY, N, EXT_X, EXT_Z, terrain, masks, U, levelAtCell },
    { onChange: onSelectionsChanged },
  );
}
