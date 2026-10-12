// Grid cells <-> geographic positions.
//
// GETM grids are often curvilinear and rotated, so latitude and longitude both
// depend on row AND column. Everything here uses the per-cell coordinates in
// latlon.bin when the dataset has them, and only falls back to the lat/lon
// bounding box for datasets processed before that file existed.

import { meta, NX, NY, N, latlon } from './dataset.js';

/** Decimal degrees from "53.412", "53,412", "53 24.7 N", "5 12 30 W" or "-5.208". */
export function parseDeg(str, negLetter) {
  const raw = String(str).trim();
  if (!raw) return NaN;
  const hemi = raw.match(/[NSEW]/i);
  // The Netherlands writes 53,412. Read a comma between digits as a decimal
  // point: taken as a degrees/minutes separator instead it would give
  // 53 deg 412 min = 59.87 deg, a 75 km error with nothing on screen to show for it.
  // Whatever comma separated the pair is already gone by here, split off above.
  const body = raw.replace(/[NSEW]/gi, ' ').replace(/(\d),(\d)/g, '$1.$2').trim();
  const nums = body.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length > 3) return NaN;
  const [d, m = 0, sc = 0] = nums.map(Number);
  if (![d, m, sc].every(Number.isFinite)) return NaN;
  const sign = (d < 0 ? -1 : 1) * (hemi && hemi[0].toUpperCase() === negLetter ? -1 : 1);
  return sign * (Math.abs(d) + m / 60 + sc / 3600);
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0088, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2
    + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Nearest grid cell to a geographic position.
 *
 *  The grid is curvilinear and rotated, so there is no closed-form inverse and
 *  the lat/lon bounding box is wrong by kilometres away from the domain centre
 *  — the same reason the tooltip samples latlon.bin rather than interpolating
 *  the box. A full scan is exact and, once per button press, costs nothing.
 */
export function cellFromLatLon(lat, lon) {
  if (latlon) {
    const cs = Math.cos(lat * Math.PI / 180);   // a degree of longitude is shorter
    let best = -1, bd = Infinity;
    for (let k = 0; k < N; k++) {
      const dLat = latlon[2 * k] - lat;
      const dLon = (latlon[2 * k + 1] - lon) * cs;
      const d = dLat * dLat + dLon * dLon;
      if (d < bd) { bd = d; best = k; }
    }
    return best < 0 ? null : { i: Math.floor(best / NX), j: best % NX };
  }
  if (!(meta.latMax > meta.latMin) || !(meta.lonMax > meta.lonMin)) return null;
  return {
    i: Math.round((lat - meta.latMin) / (meta.latMax - meta.latMin) * (NY - 1)),
    j: Math.round((lon - meta.lonMin) / (meta.lonMax - meta.lonMin) * (NX - 1)),
  };
}

export const HAS_COORDS = !!latlon || (meta.latMax > meta.latMin && meta.lonMax > meta.lonMin);
// How far a typed position may sit from the cell it snaps to before it is
// treated as outside the domain. A cell and a half: inside that, snapping to a
// cell centre is what a click would have done anyway; beyond it, the nearest
// cell is a border cell that happens to be closest, and placing a station there
// would quietly move it somewhere the user did not ask for.
export const SNAP_TOL_KM = 1.5 * (meta.cellKm || 1);

/** True (lat, lon) of a cell centre — the curvilinear grid, not a lat/lon box. */
export function latLonOfCell(k) {
  if (latlon) return [latlon[2 * k], latlon[2 * k + 1]];
  if (!(meta.latMax > meta.latMin)) return null;
  const i = Math.floor(k / NX), j = k % NX;
  return [meta.latMin + ((meta.latMax - meta.latMin) * (i + 0.5)) / NY,
          meta.lonMin + ((meta.lonMax - meta.lonMin) * (j + 0.5)) / NX];
}

// Bilinear sample of the per-cell lat/lon grid at a fractional (row, col).
// The grid may be curvilinear/rotated, so lat and lon both depend on row AND
// column — interpolating a lat/lon bounding box instead would be wrong by tens
// of km away from the domain centre.
export function sampleLatLon(fi, fj) {
  const i0 = Math.min(Math.max(Math.floor(fi), 0), NY - 1);
  const j0 = Math.min(Math.max(Math.floor(fj), 0), NX - 1);
  const i1 = Math.min(i0 + 1, NY - 1), j1 = Math.min(j0 + 1, NX - 1);
  const ti = Math.min(Math.max(fi - i0, 0), 1);
  const tj = Math.min(Math.max(fj - j0, 0), 1);
  const at = (r, c, o) => latlon[2 * (r * NX + c) + o];
  const mix = (o) =>
    (at(i0, j0, o) * (1 - tj) + at(i0, j1, o) * tj) * (1 - ti) +
    (at(i1, j0, o) * (1 - tj) + at(i1, j1, o) * tj) * ti;
  return [mix(0), mix(1)];
}

export const fmtDeg = (v, pos, neg) => `${Math.abs(v).toFixed(3)}°${v < 0 ? neg : pos}`;
