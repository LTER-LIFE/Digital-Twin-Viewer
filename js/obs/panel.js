// The Observations section of the sidebar: one card per collection, with its
// variables, display options and stations, plus loading new collections into
// the store.

import { KIND_LABEL } from '../observations.js';
import { cssGradient } from '../colormaps.js';
import { $, fmtNum, niceName, escapeHtml } from '../util.js';
import { VARIABLES } from '../core/dataset.js';
import { shell, obs, selections } from '../features/services.js';
import { stepIndex } from '../features/time.js';
import { varState, selectVariable } from '../features/variables.js';
import { onSelectionsChanged } from '../features/selectionPanel.js';
import { drawCharts } from '../dock/dock.js';
import { updateReadout } from '../dock/readout.js';
import { invalidateValidation } from '../dock/validation.js';
import { OBS_KM, OBS_PROFILE_DAYS, pairCache, obsOnly, setObsOnly } from './compare.js';
import { obsLayer } from './markers.js';

/** Put a station on the chart: a point selection at its cell, named after it
 *  and tied to it, so the readout compares against this station first. */
export function addStationSelection(st) {
  const have = selections.list.find((s) => s.obsKey === st.key);
  if (have) {
    if (!have.visible) selections.toggle(have.id);
    shell.setDock(true);
    return have;
  }
  const sel = selections.commit('point', [[st.cell.i, st.cell.j]], st.name);
  sel.obsKey = st.key;
  shell.setDock(true);
  onSelectionsChanged();
  return sel;
}

export function fmtDuration(s) {
  if (!Number.isFinite(s)) return '';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400 * 1.5) return `${+(s / 3600).toFixed(1)} h`;
  if (s < 86400 * 45) return `~${Math.round(s / 86400)} d`;
  if (s < 86400 * 300) return `~${Math.round(s / (86400 * 30.4))} months`;
  return `~${+(s / (86400 * 365.25)).toFixed(1)} yr`;
}

/** "continuous, 10 min" -- the typical cadence of a collection's stations. */
function cadenceSummary(coll) {
  const st = coll.doc.stations || [];
  if (!st.length) return '';
  const dts = st.map((x) => x.dtMedianS).filter(Number.isFinite).sort((a, b) => a - b);
  const cad = st.map((x) => x.cadence).filter(Boolean);
  const top = cad.sort((a, b) => cad.filter((v) => v === a).length - cad.filter((v) => v === b).length).pop();
  return top ? `${top}${dts.length ? `, ${fmtDuration(dts[Math.floor(dts.length / 2)])}` : ''}` : '';
}

/** Model variables of this run that an observed variable can be compared with. */
function modelMatchesOf(coll, key) {
  const out = [];
  for (const v of VARIABLES) {
    const m = obs.match(coll, v);
    if (m && m.conv && m.key === key) out.push(v);
  }
  const q = (coll.doc.variables[key] || {}).quantity;
  if (q === 'water_level') out.push({ key: '__level', name: 'water level' });
  if (q === 'water_depth') out.push({ key: '__depth', name: 'water depth' });
  return out;
}

export function renderObsPanel() {
  const list = $('obs-list');
  const n = obs.collections.length;
  $('obs-summary').innerHTML = n
    ? `<b>${n}</b> collection${n > 1 ? 's' : ''} overlap${n > 1 ? '' : 's'} this run`
      + `${obs.available > n ? ` (of ${obs.available} in the store)` : ''}. On the map, rings are`
      + ' stations, dots survey samples and diamonds casts near the current time.'
    : obs.available
      ? `None of the ${obs.available} collections in the store overlap this run in space and time.`
      : 'No observations loaded yet.';
  $('obs-how').innerHTML = `Stations within <b>${fmtNum(OBS_KM)} km</b> of a point, or inside an`
    + ' area, are set beside it. The model is taken at the station\'s own cell and brought to the'
    + ' observation — interpolated in time, and in depth on the Vertical panel — never the reverse.'
    + ' Values below a detection limit are drawn but not scored.';
  list.innerHTML = '';
  for (const coll of obs.collections) {
    const d = coll.doc;
    const card = document.createElement('div');
    card.className = 'obs-coll' + (coll.show ? '' : ' off');
    card.style.setProperty('--c', coll.color);
    const mine = obs.stations.filter((s) => s.coll === coll);
    const nSt = d.nStations || 0;
    const what = coll.kind === 'survey' || coll.kind === 'trajectory'
      ? `${(d.points && d.points.n) || 0} samples at ${(d.points && d.points.nStations) || nSt} stations`
      : coll.kind === 'profiles' ? `${(d.profiles && d.profiles.n) || 0} profiles`
        : `${mine.length} of ${nSt} station${nSt > 1 ? 's' : ''} on this grid`;
    const cad = coll.kind === 'survey' ? '' : cadenceSummary(coll);
    const span = d.time ? `${d.time[0].slice(0, 10)} – ${d.time[1].slice(0, 10)}` : '';
    const vars = Object.entries(d.variables || {}).map(([k, v]) => {
      const ms = modelMatchesOf(coll, k);
      const surveyLike = coll.kind === 'survey' || coll.kind === 'trajectory';
      // without a counterpart a station variable can still be plotted alone,
      // and a survey variable can still colour the dots
      const alone = !ms.length && coll.kind !== 'profiles' && (surveyLike || mine.length > 0);
      const act = (varState && ms.some((x) => x.key === varState.key))
        || (!varState && ms.some((x) => x.key === '__level'))
        || (alone && (surveyLike ? coll.colorBy === k : obsOnly && obsOnly.coll === coll && obsOnly.key === k));
      const why = v.notes && v.notes.length ? v.notes.join('; ') : 'No counterpart in this run';
      const tip = ms.length ? `Compared with ${ms.map((x) => niceName(x)).join(', ')} — click to show it`
        : alone ? `${why} — click to ${surveyLike ? 'colour the samples by it' : 'plot the observations on their own'}`
          : why;
      return `<button class="obs-var${ms.length ? ' match' : ''}${alone ? ' alone' : ''}${act ? ' active' : ''}" `
        + `data-m="${ms.length ? escapeHtml(ms[0].key) : ''}" data-k="${escapeHtml(k)}" title="${escapeHtml(tip)}">`
        + `${escapeHtml(v.label || k)}${v.units ? ` <span class="u">${escapeHtml(v.units)}</span>` : ''}</button>`;
    }).join('');
    let extra = '';
    if (coll.kind === 'survey' || coll.kind === 'trajectory') {
      const opts = Object.entries(d.variables || {}).map(([k, v]) =>
        `<option value="${escapeHtml(k)}"${coll.colorBy === k ? ' selected' : ''}>${escapeHtml(v.label || k)}</option>`).join('');
      extra = `<div class="obs-row">Colour <select class="cby">`
        + `<option value="auto"${!coll.colorBy || coll.colorBy === 'auto' ? ' selected' : ''}>by the variable on screen</option>`
        + `<option value="none"${coll.colorBy === 'none' ? ' selected' : ''}>collection colour</option>${opts}</select></div>`
        + `<div class="obs-row">Show <select class="win">`
        + `<option value="window"${coll.window === 'window' ? ' selected' : ''}>within ±${coll.windowDays} d of the current time</option>`
        + `<option value="year"${coll.window === 'year' ? ' selected' : ''}>the campaign nearest this run</option>`
        + `<option value="all"${coll.window === 'all' ? ' selected' : ''}>all years</option></select></div>`
        + '<div class="obs-cbar-wrap"></div>';
    } else if (mine.length) {
      const rows = mine.slice(0, 200).map((st) => `<div class="obs-st"><span class="nm" title="${escapeHtml(st.id)}">`
        + `${escapeHtml(st.name)}<span class="sub"> · ${escapeHtml(Object.keys(st.vars || {}).join(', '))}`
        + `${st.cell.snapKm > 0.05 ? ` · ${Math.round(st.cell.snapKm * 1000)} m to sea cell` : ''}</span></span>`
        + `<button data-st="${escapeHtml(st.key)}" title="Add as a station selection">+</button></div>`).join('');
      extra = `<details><summary>Stations (${mine.length})</summary>${rows}</details>`;
    }
    const notes = [...(d.warnings || []), ...(d.info || [])];
    const notesHtml = notes.length
      ? `<details><summary>Ingest notes (${notes.length})</summary>${notes.map((x) => `<div class="obs-sub">${escapeHtml(x)}</div>`).join('')}</details>`
      : '';
    card.innerHTML = `
      <div class="obs-head">
        <label class="chk"><input type="checkbox" class="show"${coll.show ? ' checked' : ''}><span>${escapeHtml(coll.title)}</span></label>
        <span class="obs-kind">${escapeHtml(KIND_LABEL[coll.kind] || coll.kind)}</span>
        <button class="ds-btn del" title="Remove this collection from the store">&#10005;</button>
      </div>
      <div class="obs-sub">${what}${cad ? ' · ' + escapeHtml(cad) : ''}<br>${span}${d.source ? ' · ' + escapeHtml(d.source) : ''}</div>
      ${coll.inTime ? '' : '<div class="obs-sub warn">Outside this run\'s time span — drawn on the map, not compared.</div>'}
      <div class="obs-vars">${vars}</div>
      ${extra}${notesHtml}
      <div class="obs-sub obs-status"></div>`;
    card.querySelector('.show').addEventListener('change', (e) => {
      coll.show = e.target.checked;
      card.classList.toggle('off', !coll.show);
      obsChanged();
    });
    card.querySelectorAll('.obs-var.match').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.m;
      if (k === '__level' || k === '__depth') {
        $('ser-level').checked = k === '__level';
        $('ser-depth').checked = k === '__depth';
        selectVariable(null);
      } else {
        selectVariable(k);
      }
    }));
    card.querySelectorAll('.obs-var.alone').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (coll.kind === 'survey' || coll.kind === 'trajectory') {
        coll.colorBy = coll.colorBy === k ? 'auto' : k;
      } else {
        setObsOnly(obsOnly && obsOnly.coll === coll && obsOnly.key === k ? null : { coll, key: k });
        if (obsOnly) { shell.setDock(true); shell.setTab('series'); }
      }
      renderObsPanel();
      obsChanged();
    }));
    card.querySelector('.del')?.addEventListener('click', async () => {
      if (!confirm(`Remove "${coll.title}" from the observation store?\nThis cannot be undone.`)) return;
      const r = await fetch(`/api/obs-delete?id=${encodeURIComponent(coll.id)}`, { method: 'POST' });
      const j = await r.json().catch(() => ({ ok: false, error: `server said ${r.status}` }));
      if (!j.ok) { alert('Could not remove it:\n' + (j.error || 'unknown error')); return; }
      location.reload();
    });
    card.querySelector('.cby')?.addEventListener('change', (e) => { coll.colorBy = e.target.value; obsChanged(); });
    card.querySelector('.win')?.addEventListener('change', (e) => { coll.window = e.target.value; obsChanged(); });
    card.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', () => {
      const st = obs.stations.find((x) => x.key === b.dataset.st);
      if (st) addStationSelection(st);
    }));
    coll._card = card;
    list.appendChild(card);
  }
  updateObsStatus();
}

/** The one-line state under each collection: what is drawn now. */
function updateObsStatus() {
  const t = stepIndex();
  for (const coll of obs.collections) {
    const card = coll._card;
    if (!card) continue;
    const el = card.querySelector('.obs-status');
    let txt = '';
    if (coll.kind === 'survey' || coll.kind === 'trajectory') {
      const rows = obs.points(coll, t);
      txt = rows === null ? 'loading…' : rows.length ? `${rows.length} samples drawn`
        : 'no samples in this window — widen it above';
      const wrap = card.querySelector('.obs-cbar-wrap');
      const r = coll._range;
      if (wrap) {
        wrap.innerHTML = r && !r.shared
          ? `<div class="obs-cbar" style="background:${cssGradient(r.cmap, false)}"></div>`
            + `<div class="obs-cbar-lab"><span>${fmtNum(r.lo)}</span><span>${escapeHtml(r.units)}</span><span>${fmtNum(r.hi)}</span></div>`
          : r && r.shared ? '<div class="obs-sub">on the drape\'s own colour scale</div>' : '';
      }
    } else if (coll.kind === 'profiles') {
      const casts = obs.castsAround(coll, t, coll.windowDays || OBS_PROFILE_DAYS);
      txt = casts === null ? 'loading…' : `${casts.length} profile${casts.length === 1 ? '' : 's'} within ±${coll.windowDays || OBS_PROFILE_DAYS} d`;
    }
    el.textContent = txt;
  }
}

/** Bumped on every change to what is observed or shown; the Model vs obs
 *  panel uses it to tell when it must redraw. */
export let obsVersion = 0;
export function obsChanged() {
  obsVersion++;
  pairCache.clear();
  obsLayer.invalidate();
  drawCharts();
  updateReadout();
  updateObsStatus();
}

export function initObsPanel() {
  // loads land in bursts (one file per station-year); redraw once per frame
  let pending = 0;
  obs.onUpdate = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; obsChanged(); });
  };
  let lastVar = null;
  // the panel's highlighted chips, and the survey colours, follow the variable on screen
  setInterval(() => {
    const k = varState ? varState.key : '';
    if (k !== lastVar) { lastVar = k; renderObsPanel(); obsLayer.invalidate(); invalidateValidation(); }
  }, 400);
  $('ser-obs').addEventListener('change', obsChanged);
  $('ov-obs').addEventListener('change', () => obsLayer.invalidate());
  for (const id of ['ser-level', 'ser-depth']) $(id).addEventListener('change', () => { invalidateValidation(); updateReadout(); });
  $('b-obs-load').addEventListener('click', () => $('obs-file').click());
  $('obs-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    const rep = $('obs-report');
    rep.hidden = false;
    rep.className = 'obs-report';
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      for (const f of files) {
        rep.textContent = `Uploading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`;
        const r = await fetch(`/api/obs-stage?token=${token}&name=${encodeURIComponent(f.name)}`,
          { method: 'POST', body: f });
        const j = await r.json().catch(() => ({ ok: false, error: `server said ${r.status}` }));
        if (!j.ok) throw new Error(j.error || 'upload failed');
      }
      rep.textContent = 'Reading and classifying…';
      const r = await fetch(`/api/obs-ingest?token=${token}`, { method: 'POST' });
      const j = await r.json().catch(() => ({ ok: false,
        error: `server said ${r.status} — is the app running via run_app.bat / server.py?` }));
      if (!j.ok) throw new Error(j.error || 'ingest failed');
      rep.innerHTML = `${escapeHtml(j.report)}\n\n<button class="sm" id="b-obs-reload">Reload to show it</button>`;
      $('b-obs-reload').addEventListener('click', () => location.reload());
    } catch (err) {
      rep.className = 'obs-report bad';
      rep.textContent = 'Could not load the observations:\n' + err.message;
    }
  });
}
