// Sidebar shell: activity rail, section switching, collapse and drag-resize for
// both the sidebar and the chart dock, all persisted across sessions.
//
// Widths live in CSS custom properties on #app rather than inline styles on the
// panels, so the grid recomputes in one place and the view cell is always
// exactly what is left over. Nothing here touches the renderer — render/viewport.js watches
// the view cell with a ResizeObserver, so any layout change (collapse, drag,
// window resize, devtools opening) reaches the camera by the same path.

const $ = (id) => document.getElementById(id);

const SB_MIN = 240, SB_MAX = 560;
const DK_MIN = 280, DK_MAX = 720;

const store = {
  get(k, d) { try { const v = localStorage.getItem('ui.' + k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ui.' + k, String(v)); } catch { /* private mode */ } },
};

export function initShell() {
  const app = $('app');
  // only the buttons that open a sidebar section — the dock toggle shares the
  // rail but is not one of them, and must not shift the 1..7 shortcuts
  const railBtns = [...document.querySelectorAll('.rail-btn[data-section]')];
  const dockBtn = document.querySelector('.rail-btn[data-toggle="dock"]');
  const sections = [...document.querySelectorAll('.sb-sec')];
  const tabBtns = [...document.querySelectorAll('.tab')];
  const listeners = { tab: [] };

  // ---------------------------------------------------------------- sidebar
  // Both panels start closed: the first thing anyone wants from this app is the
  // model domain, at full width. A returning visitor gets whatever they last
  // left open instead.
  let section = store.get('section', 'variables');
  if (!sections.some((s) => s.dataset.section === section)) section = 'variables';
  let sbOpen = store.get('sbOpen', '0') === '1';

  function paint() {
    app.classList.toggle('sb-closed', !sbOpen);
    for (const s of sections) s.classList.toggle('on', s.dataset.section === section);
    for (const b of railBtns) b.classList.toggle('on', sbOpen && b.dataset.section === section);
    const btn = railBtns.find((b) => b.dataset.section === section);
    $('sb-title').textContent = btn ? btn.title.replace(/\s*\(.*\)$/, '') : section;
  }

  function openSection(name, toggle = false) {
    // clicking the active icon collapses, as in VS Code
    if (toggle && sbOpen && name === section) { setSidebar(false); return; }
    section = name;
    sbOpen = true;
    store.set('section', section);
    store.set('sbOpen', '1');
    paint();
  }
  function setSidebar(open) {
    sbOpen = open;
    store.set('sbOpen', open ? '1' : '0');
    paint();
  }

  for (const b of railBtns) {
    b.addEventListener('click', () => openSection(b.dataset.section, true));
  }
  $('sb-close').addEventListener('click', () => setSidebar(false));

  // ------------------------------------------------------------------- dock
  let dkOpen = store.get('dkOpen', '0') === '1';
  let tab = store.get('tab', 'series');

  function paintDock() {
    app.classList.toggle('dk-closed', !dkOpen);
    if (dockBtn) dockBtn.classList.toggle('on', dkOpen);
    for (const b of tabBtns) b.classList.toggle('on', b.dataset.tab === tab);
    for (const w of document.querySelectorAll('.chart-wrap')) w.hidden = w.dataset.tab !== tab;
  }
  function setDock(open) {
    dkOpen = open;
    store.set('dkOpen', open ? '1' : '0');
    paintDock();
  }
  function setTab(name) {
    const btn = tabBtns.find((b) => b.dataset.tab === name);
    if (!btn || btn.disabled) return;
    tab = name;
    store.set('tab', name);
    paintDock();
    for (const fn of listeners.tab) fn(name);
  }
  for (const b of tabBtns) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('dk-close').addEventListener('click', () => setDock(false));
  if (dockBtn) dockBtn.addEventListener('click', () => setDock(!dkOpen));

  /** Enable/disable a dock tab; falls back to Timeseries if the active one goes. */
  function enableTab(name, on) {
    const btn = tabBtns.find((b) => b.dataset.tab === name);
    if (!btn) return;
    btn.disabled = !on;
    if (!on && tab === name) setTab('series');
  }

  // -------------------------------------------------------------- resizing
  function dragger(handle, cssVar, min, max, storeKey, fromRight) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      app.classList.add('dragging');
      const move = (ev) => {
        const r = app.getBoundingClientRect();
        const w = fromRight ? r.right - ev.clientX : ev.clientX - r.left - 48;
        const v = Math.round(Math.min(Math.max(w, min), max));
        app.style.setProperty(cssVar, v + 'px');
        store.set(storeKey, v);
      };
      const up = () => {
        app.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
  dragger($('sb-resize'), '--sb-w', SB_MIN, SB_MAX, 'sbWidth', false);
  dragger($('dk-resize'), '--dk-w', DK_MIN, DK_MAX, 'dkWidth', true);

  const sbW = parseInt(store.get('sbWidth', ''), 10);
  if (sbW >= SB_MIN && sbW <= SB_MAX) app.style.setProperty('--sb-w', sbW + 'px');
  const dkW = parseInt(store.get('dkWidth', ''), 10);
  if (dkW >= DK_MIN && dkW <= DK_MAX) app.style.setProperty('--dk-w', dkW + 'px');

  // ------------------------------------------------------------- shortcuts
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.ctrlKey && e.code === 'KeyB') { e.preventDefault(); setSidebar(!sbOpen); return; }
    if (e.ctrlKey && e.code === 'KeyJ') { e.preventDefault(); setDock(!dkOpen); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7'].indexOf(e.code);
    if (n >= 0 && railBtns[n]) { e.preventDefault(); openSection(railBtns[n].dataset.section); }
  });

  paint();
  paintDock();

  return {
    openSection,
    setSidebar,
    setDock,
    setTab,
    enableTab,
    get tab() { return tab; },
    get dockOpen() { return dkOpen; },
    get sidebarOpen() { return sbOpen; },
    onTab(fn) { listeners.tab.push(fn); },
  };
}
