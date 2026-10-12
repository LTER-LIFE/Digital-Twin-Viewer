// Pointer over the map: the hover readout for a cell or an observation
// marker, and clicking a station marker to put it on the chart.

import { meta, NX, NY, NDAYS, STEP_DAYS, LEVEL_UNIT, terrain, masks, latlon } from '../core/dataset.js';
import { sampleLatLon, fmtDeg } from '../core/geo.js';
import { ObsStore, KIND_LABEL } from '../observations.js';
import { renderer, viewEl } from '../render/viewport.js';
import { $, fmtNum, niceName, escapeHtml } from '../util.js';
import { extractor, obs, selections } from './services.js';
import { dayF, stepIndex, levelAtCell } from './time.js';
import { varState, currentSource } from './variables.js';
import { obsTarget, modelNearWet } from '../obs/compare.js';
import { obsLayer } from '../obs/markers.js';
import { addStationSelection, fmtDuration } from '../obs/panel.js';

const tip = $('tip');

function placeTip(e) {
  tip.style.display = 'block';
  const r = viewEl.getBoundingClientRect();
  const tx = Math.min(e.clientX - r.left + 16, r.width - tip.offsetWidth - 10);
  const ty = Math.min(e.clientY - r.top + 16, r.height - tip.offsetHeight - 10);
  tip.style.left = Math.max(4, tx) + 'px';
  tip.style.top = Math.max(4, ty) + 'px';
}

/** Tooltip for an observation marker: what it is, and what it measured. */
function obsTipHtml(it) {
  const coll = it.coll;
  const head = `<span class="obs-k" style="color:${coll.color}">${escapeHtml(KIND_LABEL[coll.kind] || coll.kind)}</span>`
    + ` · ${escapeHtml(coll.title)}`;
  if (it.kind === 'station') {
    const st = it.ref;
    const target = obsTarget();
    const m = obs.match(coll, target.desc, target.special);
    let val = '';
    if (m && m.conv && st.vars && st.vars[m.key]) {
      const s = obs.series(st, m.key);
      if (s && s.n) {
        let bi = 0;
        for (let i = 1; i < s.n; i++) if (Math.abs(s.tau[i] - dayF) < Math.abs(s.tau[bi] - dayF)) bi = i;
        if (Math.abs(s.tau[bi] - dayF) * STEP_DAYS <= 1) {
          const v = s.v[bi] * m.conv.factor + m.conv.offset;
          val = `<br><span class="val">${escapeHtml(m.var.label || m.key)}:</span> <b>${fmtNum(v)}</b>`
            + ` ${escapeHtml(target.units)} <span class="nd">at ${new Date(obs.msOfTau(s.tau[bi])).toISOString().slice(0, 16).replace('T', ' ')}</span>`;
        }
      }
    }
    const vars = Object.keys(st.vars || {}).map(escapeHtml).join(', ');
    const snap = st.cell.snapKm > 0.05 ? `<br><span class="nd">${Math.round(st.cell.snapKm * 1000)} m to its sea cell (${st.cell.i}, ${st.cell.j})</span>` : '';
    const cad = st.cadence ? `${st.cadence}${st.dtS ? ', ' + fmtDuration(st.dtS) : ''} · ` : '';
    return `<b class="obs-h">${escapeHtml(st.name)}</b><br>${head}<br>${escapeHtml(cad)}${vars}${val}${snap}`
      + '<br><span class="nd">Click to add it as a station</span>';
  }
  if (it.kind === 'cast') {
    const c = it.ref;
    return `<b class="obs-h">${escapeHtml(c.name && c.name !== c.station ? c.name : (c.station || c.id))}</b><br>${head}<br>`
      + `${escapeHtml(c.time.slice(0, 16).replace('T', ' '))} UTC · ${c.z.length} levels`
      + '<br><span class="nd">Its profile shows on the Vertical panel beside a selection nearby</span>';
  }
  const p = it.ref;
  const vals = Object.entries(coll.doc.variables || {}).map(([k, v]) => {
    const x = ObsStore.pointValue(p, k);
    return Number.isFinite(x) ? `${escapeHtml(v.label || k)}: <b>${fmtNum(x)}</b> ${escapeHtml(v.units || '')}` : null;
  }).filter(Boolean).join('<br>');
  let mod = '';
  const m = varState && obs.match(coll, varState);
  if (m && m.conv) {
    const x = obs.tauOf(p.ms);
    if (x >= 0 && x <= NDAYS - 1) {
      const [mv, moved] = modelNearWet(obsTarget(), p.cell.k, x, Math.max(1, Math.round(1 / STEP_DAYS)));
      if (Number.isFinite(mv)) {
        mod = `<br><span class="val">Model ${escapeHtml(niceName(varState))}:</span> <b>${fmtNum(mv)}</b> `
          + `${escapeHtml(varState.units || '')}${moved ? ' <span class="nd">(nearest wet step)</span>' : ''}`;
      }
    } else mod = '<br><span class="nd">sampled outside this run</span>';
  }
  return `<b class="obs-h">${escapeHtml(p.station)}</b> · ${new Date(p.ms).toISOString().slice(0, 10)}<br>${head}<br>${vals}${mod}`;
}

export function initPointer() {
  renderer.domElement.addEventListener('pointermove', (e) => {
    const oh = obsLayer.pick(e.clientX, e.clientY);
    if (oh) { tip.innerHTML = obsTipHtml(oh); placeTip(e); return; }
    const hit = selections.pick(e.clientX, e.clientY);
    if (!hit) { tip.style.display = 'none'; return; }
    const { fi, fj, i, j, k } = hit;
    const isLand = masks[k] & 1, isInter = (masks[k] >> 1) & 1;
    const h = terrain[k];
    const lv = levelAtCell(k);
    const depth = lv - h;
    let lat = null, lon = null;
    if (latlon) {
      [lat, lon] = sampleLatLon(fi, fj);            // true position, any grid
    } else if (meta.latMax !== meta.latMin) {
      // dataset processed before latlon.bin existed: fall back to the bounding-box
      // estimate, which is only correct on a north-aligned rectilinear grid
      lat = meta.latMin + (i / (NY - 1)) * (meta.latMax - meta.latMin);
      lon = meta.lonMin + (j / (NX - 1)) * (meta.lonMax - meta.lonMin);
    }
    const cell = `cell ${i}, ${j}`;
    const where = lat === null ? cell
      : `${fmtDeg(lat, 'N', 'S')}, ${fmtDeg(lon, 'E', 'W')} · ${cell}`;
    let state;
    if (isLand) state = `<span style="color:#9dc069;font-weight:700">LAND</span>`;
    else if (depth > 0.005) state = `<span class="wet">WET</span> — depth ${depth.toFixed(2)} m, level ${lv >= 0 ? '+' : ''}${lv.toFixed(2)} ${LEVEL_UNIT}`;
    else state = `<span class="dry">DRY${isInter ? ' FLAT' : ''}</span> — exposed seabed`;

    let varLine = '';
    if (varState) {
      const t = stepIndex();
      const v = extractor.valueAt(currentSource(), k, t);
      varLine = `<br><span class="val">${escapeHtml(niceName(varState))}:</span> ` + (Number.isFinite(v)
        ? `${fmtNum(v)}${varState.units ? ' ' + escapeHtml(varState.units) : ''}`
        : `<span class="nd">no data here</span>`);
    }
    tip.innerHTML = `<b>${where}</b><br>` +
      `Bed elevation: ${h >= 0 ? '+' : ''}${h.toFixed(2)} ${LEVEL_UNIT}<br>${state}${varLine}`;
    placeTip(e);
  });

  // A click on a station marker (with no selection tool armed) puts that
  // station on the chart. A drag is the camera's, so only a still click counts.
  {
    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null;
    });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || selections.tool) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), held = performance.now() - down.t;
      down = null;
      if (moved > 4 || held > 600) return;
      const it = obsLayer.pick(e.clientX, e.clientY);
      if (it && it.kind === 'station') addStationSelection(it.ref);
    });
  }
  renderer.domElement.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
}
