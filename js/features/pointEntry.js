// Placing a point by number. Reading an exact position off an oblique 3-D view
// is guesswork, so a station whose coordinates are already known is typed in
// rather than hunted for.

import { NX, NY, latlon } from '../core/dataset.js';
import {
  parseDeg, haversineKm, cellFromLatLon, sampleLatLon, HAS_COORDS, SNAP_TOL_KM,
} from '../core/geo.js';
import { $ } from '../util.js';
import { selections } from './services.js';

function paintCoordMode() {
  const ij = $('pt-mode').value === 'ij';
  $('pt-la').firstChild.nodeValue = ij ? 'Row' : 'Latitude';
  $('pt-lb').firstChild.nodeValue = ij ? 'Column' : 'Longitude';
  $('pt-a').placeholder = ij ? `0–${NY - 1}` : '53.412';
  $('pt-b').placeholder = ij ? `0–${NX - 1}` : '5.223';
}

function placeTypedPoint() {
  const msg = $('pt-msg');
  const say = (t, cls) => { msg.textContent = t; msg.className = 'note' + (cls ? ' ' + cls : ''); };

  let a = $('pt-a').value.trim();
  let b = $('pt-b').value.trim();
  // A pair pasted whole arrives in the first box. Where the comma is also the
  // decimal separator, splitting on it would halve both numbers — so prefer an
  // explicit ';' or a space, and fall back to the comma only when there is
  // exactly one of them to fall back to.
  if (!b) {
    const m = a.match(/^(.*?[NS])\s*,?\s*(.*[EW])$/i)   // "53.412 N 5.223 E"
      || a.match(/^(.+?)\s*;\s*(.+)$/)
      || a.match(/^(\S+)\s+(\S+)$/)
      || (a.split(',').length === 2 && a.match(/^(.+?)\s*,\s*(.+)$/));
    if (m) { a = m[1].trim(); b = m[2].trim(); }
  }
  if (!a || !b) { say('Enter both values.', 'bad'); return; }

  let i, j, note = '';
  if ($('pt-mode').value === 'ij') {
    i = Math.round(Number(a)); j = Math.round(Number(b));
    if (!Number.isFinite(i) || !Number.isFinite(j)) { say('Row and column must be numbers.', 'bad'); return; }
    if (i < 0 || i > NY - 1 || j < 0 || j > NX - 1) {
      say(`Off the grid — rows 0–${NY - 1}, columns 0–${NX - 1}.`, 'bad');
      return;
    }
  } else {
    const lat = parseDeg(a, 'S'), lon = parseDeg(b, 'W');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { say('Could not read those as degrees.', 'bad'); return; }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { say('Latitude is ±90°, longitude ±180°.', 'bad'); return; }
    const c = cellFromLatLon(lat, lon);
    if (!c) { say('This dataset carries no coordinates.', 'bad'); return; }
    i = c.i; j = c.j;
    // a nearest cell always exists, so how far away it is is the only thing
    // that says whether the typed position is inside the domain at all
    const [clat, clon] = latlon ? sampleLatLon(i, j) : [lat, lon];
    const off = haversineKm(lat, lon, clat, clon);
    if (off > SNAP_TOL_KM) {
      say(`That is ${off.toFixed(off < 10 ? 1 : 0)} km outside the model domain.`, 'bad');
      return;
    }
    note = off > 0.02 ? `, ${(off * 1000).toFixed(0)} m from what you typed` : '';
  }

  const sel = selections.commit('point', [[i, j]], $('pt-name').value.trim());
  $('pt-name').value = '';
  say(`${sel.name} placed at cell ${i}, ${j}${note}.`, 'ok');
}

export function initPointEntry() {
  if (!HAS_COORDS) {
    // no geography in this dataset: row/column is the only honest input
    $('pt-mode').querySelector('option[value=ll]').disabled = true;
    $('pt-mode').value = 'ij';
  }
  paintCoordMode();
  $('pt-mode').addEventListener('change', () => {
    paintCoordMode();
    $('pt-msg').textContent = '';
    $('pt-msg').className = 'note';
  });

  $('pt-add').addEventListener('click', placeTypedPoint);
  for (const id of ['pt-a', 'pt-b', 'pt-name']) {
    $(id).addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); placeTypedPoint(); }
    });
  }
}
