// App-wide keyboard shortcuts. The shell (ui.js) owns Ctrl+B / Ctrl+J and the
// 1..7 section keys; selection.js owns Esc / Enter while a tool is drawing.

import { flow } from '../render/flowTrails.js';
import { resetView } from '../render/viewport.js';
import { $ } from '../util.js';
import { dayF, playing, setDay, setPlay } from './time.js';
import { toggleMode } from './viewControls.js';

export function initKeyboard() {
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space') { e.preventDefault(); setPlay(!playing); }
    else if (e.code === 'ArrowRight') setDay(Math.floor(dayF) + 1);
    else if (e.code === 'ArrowLeft') setDay(Math.floor(dayF) - 1);
    else if (e.code === 'KeyM') toggleMode();
    else if (e.code === 'KeyR') resetView();
    else if (e.code === 'KeyF' && flow) $('b-flow').click();
  });
}
