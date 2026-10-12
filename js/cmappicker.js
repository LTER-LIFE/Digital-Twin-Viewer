// A colormap picker that shows what each map looks like.
//
// A native <option> can hold text and nothing else, so with 36 maps the list
// read "Lipari", "Navia", "Bamako" with no way to tell them apart short of
// picking each one and looking at the map. This is the one control in the app
// whose whole subject is colour, so it gets a real listbox with a gradient
// swatch per row.
//
// The original <select> stays in the DOM as the value holder — hidden, but
// still carrying its options. Everything that already reads or writes
// $('cs-cmap').value, or listens for its change event, keeps working untouched;
// this file only replaces the popup the browser would have drawn. Call sync()
// after setting .value programmatically, since that fires no event.
//
// The popup is position:fixed and lives on <body>: #sb-body scrolls, and an
// absolutely positioned list inside it would be clipped at the panel edge.

import { CMAP_GROUPS, cmapLabel, cssGradient } from './colormaps.js';

/**
 * @param sel   the <select> to take over
 * @param opts  {reversed?: () => boolean}  current reverse state, so the
 *              swatches show the colours the map will actually be drawn in
 * @returns {{sync: () => void}}
 */
export function enhanceCmapSelect(sel, opts = {}) {
  if (sel.dataset.enhanced) return { sync: () => {} };
  sel.dataset.enhanced = '1';
  const isRev = opts.reversed || (() => false);

  const wrap = document.createElement('div');
  wrap.className = 'cmsel';
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('cmsel-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cmsel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.append(span('nm'), span('cmsel-sw'));
  wrap.appendChild(btn);

  const pop = document.createElement('div');
  pop.className = 'cmsel-pop';
  pop.setAttribute('role', 'listbox');
  pop.hidden = true;
  document.body.appendChild(pop);

  const rows = [];
  for (const g of CMAP_GROUPS) {
    const head = document.createElement('div');
    head.className = 'cmsel-grp';
    head.textContent = g.label;
    pop.appendChild(head);
    for (const name of g.names) {
      const row = document.createElement('div');
      row.className = 'cmsel-opt';
      row.setAttribute('role', 'option');
      row.dataset.name = name;
      const label = span('nm');
      label.textContent = cmapLabel(name);
      row.append(label, span('cmsel-sw'));
      row.addEventListener('click', () => { choose(name); btn.focus(); });
      row.addEventListener('mousemove', () => setActive(rows.indexOf(row)));
      pop.appendChild(row);
      rows.push(row);
    }
  }

  let active = 0;
  let paintedRev = null;

  function span(cls) {
    const s = document.createElement('span');
    s.className = cls;
    return s;
  }
  const swatch = (el) => el.querySelector('.cmsel-sw');

  /** Repaint the 36 row swatches only when the direction actually changed —
   *  applyColourScale runs on every nudge of the min/max boxes. */
  function paintRows(rev) {
    if (paintedRev === rev) return;
    paintedRev = rev;
    for (const r of rows) swatch(r).style.background = cssGradient(r.dataset.name, rev);
  }

  function sync() {
    const cur = sel.value;
    const rev = !!isRev();
    btn.querySelector('.nm').textContent = cur ? cmapLabel(cur) : '';
    swatch(btn).style.background = cur ? cssGradient(cur, rev) : 'none';
    for (const r of rows) {
      const on = r.dataset.name === cur;
      r.classList.toggle('on', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (!pop.hidden) paintRows(rev);
  }

  function setActive(i) {
    active = Math.min(Math.max(i, 0), rows.length - 1);
    for (let k = 0; k < rows.length; k++) rows[k].classList.toggle('active', k === active);
    rows[active].scrollIntoView({ block: 'nearest' });
  }

  function choose(name) {
    close();
    if (sel.value === name) return;
    sel.value = name;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  }

  const PAD = 10;

  function place() {
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = Math.round(r.width) + 'px';

    // Room on each side, clamped to the viewport. The trigger lives in a
    // scrolling panel and can sit past either edge of it, which makes the raw
    // r.top / r.bottom larger than the window — without the clamp that became
    // a max-height taller than the screen, and a list whose last rows could
    // not be reached.
    const below = Math.max(0, innerHeight - r.bottom - PAD);
    const above = Math.max(0, r.top - PAD);
    const useBelow = below >= above || below >= 320;
    const room = Math.min(useBelow ? below : above, innerHeight - 2 * PAD);
    pop.style.maxHeight = Math.max(140, Math.floor(room)) + 'px';

    // decide the side before measuring: max-height changes the height
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(r.left, innerWidth - 8 - w);
    const top = useBelow ? r.bottom + 4 : r.top - h - 4;
    pop.style.left = Math.round(Math.max(8, left)) + 'px';
    pop.style.top = Math.round(Math.max(6, Math.min(top, innerHeight - h - 6))) + 'px';
  }

  const onDocDown = (e) => {
    if (!pop.contains(e.target) && !btn.contains(e.target)) close();
  };

  /** The popup is fixed, so when the panel underneath scrolls it has to be
   *  moved to stay with its trigger — and dropped once the trigger is no
   *  longer on screen to point at.
   *
   *  This must ignore the popup's own scrolling. The listener is on the window
   *  in the capture phase, which is the only way to hear a nested scroller, so
   *  it also hears the list scrolling itself: closing on that made the wheel
   *  unusable, and made every arrow key close the menu, because moving the
   *  active row calls scrollIntoView. */
  const onScroll = (e) => {
    if (pop.contains(e.target)) return;
    reanchor();
  };

  function reanchor() {
    const r = btn.getBoundingClientRect();
    const gone = r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
    if (gone) close();
    else place();
  }

  function open() {
    if (!pop.hidden) return;
    paintRows(!!isRev());
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    place();
    const cur = rows.findIndex((r) => r.dataset.name === sel.value);
    setActive(cur < 0 ? 0 : cur);
    addEventListener('pointerdown', onDocDown, true);
    addEventListener('resize', reanchor);
    addEventListener('scroll', onScroll, true);
  }

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', onDocDown, true);
    removeEventListener('resize', reanchor);
    removeEventListener('scroll', onScroll, true);
  }

  btn.addEventListener('click', () => (pop.hidden ? open() : close()));

  let typed = '', typeTimer = 0;
  btn.addEventListener('keydown', (e) => {
    // the app binds bare keys — Space plays the run, arrows step it — and a
    // <button> is not one of the targets its global handler skips
    e.stopPropagation();
    const k = e.key;
    if (pop.hidden) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
        e.preventDefault();
        open();
      }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); close(); }
    else if (k === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (k === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (k === 'Home') { e.preventDefault(); setActive(0); }
    else if (k === 'End') { e.preventDefault(); setActive(rows.length - 1); }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(rows[active].dataset.name); }
    else if (k === 'Tab') close();
    else if (/^[a-z0-9]$/i.test(k)) {
      // 36 names is enough that typing the first letters beats scrolling
      typed += k.toLowerCase();
      clearTimeout(typeTimer);
      typeTimer = setTimeout(() => { typed = ''; }, 700);
      const i = rows.findIndex((r) => r.dataset.name.toLowerCase().startsWith(typed));
      if (i >= 0) setActive(i);
    }
  });

  sync();
  return { sync };
}
