// The Analysis section: selection tools, the list of selections, the area
// statistic and the extra series toggles.

import { meta } from '../core/dataset.js';
import { $, escapeHtml } from '../util.js';
import { shell, extractor, obs, selections } from './services.js';
import { urlState } from './urlSync.js';
import { drawCharts, updateTabs } from '../dock/dock.js';
import { updateReadout } from '../dock/readout.js';

/** How an area selection is reduced to one number per step. */
export let areaStat = 'mean';
export function setAreaStat(s) { areaStat = s; }

export function initSelectionPanel() {
  $('area-stat').addEventListener('change', (e) => {
    areaStat = e.target.value;
    drawCharts();
    updateReadout();          // the readout quotes the statistic too
    urlState.touch();
  });
  $('area-band').addEventListener('change', drawCharts);
  for (const id of ['ser-level', 'ser-depth', 'ser-domain']) $(id).addEventListener('change', drawCharts);

  for (const b of document.querySelectorAll('[data-tool]')) {
    b.addEventListener('click', () => {
      selections.setTool(selections.tool === b.dataset.tool ? null : b.dataset.tool);
    });
  }
  $('sel-clear').addEventListener('click', () => {
    extractor.invalidate();        // drop every cached cell walk with them
    selections.clear();
  });
}

/** Repaint everything that depends on the selection list. Selections calls it
 *  on every change; `added` is true when one was just placed. */
export function onSelectionsChanged(added) {
  // The chart is the whole point of placing a selection, and the dock starts
  // closed — leaving it shut here would make a click on the map look like it
  // did nothing.
  if (added) shell.setDock(true);
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.classList.toggle('on', selections.tool === b.dataset.tool);
  }
  $('stat-wrap').hidden = !selections.list.some((s) => s.type === 'area');
  const hint = {
    point: 'Click a cell to place a station.',
    transect: 'Click along the section; double-click or Enter to finish, Esc to cancel.',
    area: 'Click a polygon (Enter to close), or shift-drag a rectangle.',
  }[selections.tool] || 'Choose a tool, then click the map.';
  const n = selections.draft ? selections.draft.length : 0;
  $('tool-hint').textContent = n ? `${hint} ${n} vertex${n === 1 ? '' : 'es'} placed.` : hint;

  const list = $('sel-list');
  if (!selections.list.length) {
    list.innerHTML = '<p class="note">No selections yet.</p>';
  } else {
    list.innerHTML = '';
    for (const s of selections.list) {
      const cells = extractor.cells(s);
      const km = cells.dist[cells.dist.length - 1] || 0;
      const tied = s.obsKey && obs.stations.find((x) => x.key === s.obsKey);
      const sub = s.type === 'point'
        ? `cell ${cells.ij[0][0]}, ${cells.ij[0][1]}${tied ? ` · ${tied.coll.title}` : ''}`
        : s.type === 'transect'
          ? `${cells.ks.length} cells · ${km.toFixed(1)} km`
          : `${cells.ks.length} cells · ${(cells.ks.length * meta.cellKm ** 2).toFixed(1)} km²`;
      const row = document.createElement('div');
      row.className = 'sel-item' + (s.visible ? '' : ' off');
      row.innerHTML =
        `<span class="sw" style="background:${s.color}"></span>` +
        `<span class="nm" title="Double-click to rename">${escapeHtml(s.name)}` +
        `<span class="sub">${escapeHtml(sub)}</span></span>` +
        `<button class="ren" title="Rename">✎</button>` +
        `<button class="eye" title="Show / hide">${s.visible ? '◉' : '◎'}</button>` +
        `<button class="x" title="Remove">✕</button>`;
      const rename = () => beginRename(row, s);
      row.querySelector('.ren').addEventListener('click', rename);
      row.querySelector('.nm').addEventListener('dblclick', rename);
      row.querySelector('.eye').addEventListener('click', () => selections.toggle(s.id));
      row.querySelector('.x').addEventListener('click', () => {
        extractor.invalidate(s.id);
        selections.remove(s.id);
      });
      list.appendChild(row);
    }
  }
  updateTabs();
  drawCharts();
  updateReadout();
  urlState.touch();
}

/** Swap a selection row's label for a text box, in place.
 *
 *  Enter and blur both commit. The other way round — blur discards — silently
 *  throws away a name the user has already finished typing the moment they
 *  click anywhere else, which is the more expensive of the two mistakes; Esc is
 *  there for the cheap one. Either way the row is repainted from the list, so
 *  the input can never outlive the selection it belongs to.
 */
function beginRename(row, sel) {
  if (row.querySelector('.rename')) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'rename';
  inp.value = sel.name;
  inp.maxLength = 60;
  row.querySelector('.nm').replaceWith(inp);
  inp.focus();
  inp.select();

  let done = false;
  const finish = (save) => {
    if (done) return;                    // repainting the row can fire blur again
    done = true;
    if (save) selections.rename(sel.id, inp.value);   // repaints via onChange
    else onSelectionsChanged();
  };
  inp.addEventListener('keydown', (e) => {
    // bare keys are app shortcuts — space plays, arrows step the run
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}
