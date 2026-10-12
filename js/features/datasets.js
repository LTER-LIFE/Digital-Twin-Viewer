// The Dataset section's browser: datasets already processed on this server,
// and uploading a new .nc file for server.py to convert.

import { DS } from '../core/dataset.js';
import { $, escapeHtml } from '../util.js';
import { setPlay } from './time.js';

const slugifyNc = (s) => s.toLowerCase().replace(/\.nc$/, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
const loader = $('loader'), loaderMsg = $('loader-msg'), loaderTitle = $('loader-title');
const bar = $('bar'), loadPct = $('load-pct');

export function initDatasetBrowser() {
  $('b-load').addEventListener('click', () => $('nc-file').click());
  $('nc-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    let slug = slugifyNc(file.name);
    if (slug === 'default') slug = 'default-upload';

    setPlay(false);
    loaderTitle.textContent = 'Processing dataset';
    loaderMsg.textContent = `Uploading ${file.name} (${(file.size / 1e6).toFixed(0)} MB)…`;
    loadPct.textContent = '';
    bar.style.width = '4%';
    loader.style.display = 'flex';

    const poll = setInterval(async () => {
      try {
        const r = await fetch(`./data/${slug}/status.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return;
        const st = await r.json();
        if (st.stage === 'error') return;
        loaderMsg.textContent = st.step ? `${st.stage}… (${st.step} / ${st.of})` : `${st.stage}…`;
        bar.style.width = Math.max(4, st.pct) + '%';
      } catch { /* server busy or file not there yet */ }
    }, 1200);

    try {
      const res = await fetch(`/api/upload-nc?name=${encodeURIComponent(file.name)}`, {
        method: 'POST', body: file,
      });
      let j;
      try { j = await res.json(); }
      catch { throw new Error(`server said ${res.status} — is the app running via run_app.bat / server.py?`); }
      if (!j.ok) throw new Error(j.error || 'processing failed');
      clearInterval(poll);
      loaderMsg.textContent = 'Done — loading new dataset…';
      bar.style.width = '100%';
      location.href = `${location.pathname}?dataset=${encodeURIComponent(j.dataset)}`;
    } catch (err) {
      clearInterval(poll);
      loader.style.display = 'none';
      alert('Could not load the .nc file:\n' + err.message);
    }
  });
  $('ds-toggle').addEventListener('click', () => $('ds-browser').classList.toggle('open'));
}

/** List the server's datasets. Throws on a plain static server, where the
 *  browser simply stays hidden. */
export async function refreshDatasets() {
  const r = await fetch('/api/datasets');
  if (!r.ok) return;
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) return;
  $('ds-browser').hidden = false;
  const cur = list.find((d) => d.slug === DS);
  $('ds-current').textContent = cur ? cur.title : 'Datasets…';
  const ul = $('ds-list');
  ul.innerHTML = '';
  for (const d of list) {
    const item = document.createElement('div');
    item.className = 'ds-item' + (d.slug === DS ? ' cur' : '');
    const steps = d.stepDays === 1 ? `${d.nDays} days`
      : d.stepDays < 1 ? `${d.nDays} × ${(d.stepDays * 24).toFixed(1)} h steps`
      : `${d.nDays} × ${d.stepDays} d steps`;
    item.innerHTML = `
      <div class="ds-head">
        <span class="ds-name" title="${escapeHtml(d.slug)}">${escapeHtml(d.title)}<span class="sub">${d.nx}×${d.ny} · ${steps}</span></span>
        <button class="ds-btn info" title="Properties">&#9432;</button>
        ${d.slug === DS ? '<button class="ds-btn" disabled>Current</button>'
                        : '<button class="ds-btn load">Load</button>'}
        ${d.slug === 'default' ? '' : '<button class="ds-btn del" title="Delete dataset">&#10005;</button>'}
      </div>
      <div class="ds-info">
        <b>Grid:</b> ${d.nx} × ${d.ny} cells @ ${d.cellKm} km${d.extentKm ? ` (${d.extentKm.map((v) => v.toFixed(0)).join(' × ')} km)` : ''}<br>
        <b>Time:</b> ${steps} from ${d.startDate || '?'}<br>
        <b>Satellite imagery:</b> ${d.satellite ? 'yes' : 'no'}<br>
        <b>Processed:</b> ${d.processedAt ? new Date(d.processedAt * 1000).toLocaleString() : '—'} · ${d.sizeMB} MB on disk<br>
        <b>Source .nc:</b> ${d.hasNc ? `${d.ncSizeMB} MB (uploads/${escapeHtml(d.slug)}.nc)` : 'not kept'}
      </div>`;
    const toggleInfo = () => item.classList.toggle('open');
    item.querySelector('.info').addEventListener('click', toggleInfo);
    item.querySelector('.ds-name').addEventListener('click', toggleInfo);
    item.querySelector('.load')?.addEventListener('click', () => {
      location.href = `${location.pathname}?dataset=${encodeURIComponent(d.slug)}`;
    });
    item.querySelector('.del')?.addEventListener('click', async () => {
      if (!confirm(`Delete dataset "${d.title}" and its uploaded .nc file?\nThis cannot be undone.`)) return;
      const res = await fetch(`/api/delete-dataset?slug=${encodeURIComponent(d.slug)}`, { method: 'POST' });
      const j = await res.json().catch(() => ({ ok: false, error: `server said ${res.status}` }));
      if (!j.ok) { alert('Could not delete:\n' + (j.error || 'unknown error')); return; }
      if (d.slug === DS) location.href = location.pathname;   // deleted the open dataset
      else refreshDatasets();
    });
    ul.appendChild(item);
  }
}
