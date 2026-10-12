// View state in the URL, so a figure can be pointed at rather than described.
//
// Everything that changes what you see goes in: dataset, variable, timestep,
// colour scale, exaggeration, render mode, camera pose and the selections. The
// write is debounced and uses replaceState — an orbit drag fires hundreds of
// camera updates a second and each one must not become a history entry.

const DEBOUNCE_MS = 400;

const num = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();

// A name only travels if the user chose it. Re-placing the selections in the
// same order regenerates the same defaults at the far end, so spending URL on
// "Point 1" would buy nothing.
const defaultName = (type, n) => `${type[0].toUpperCase()}${type.slice(1)} ${n}`;

// encodeURIComponent leaves ! ~ * _ and ' alone, and four of those are our own
// separators — percent-escape them by hand so a name can contain anything.
const encName = (s) =>
  encodeURIComponent(s).replace(/[!~*_:']/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const decName = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Selections -> "p:120.5_88.1*NIOZ%20jetty~t:10_10!40_60~a:1_2!3_4!5_6" */
function encodeSelections(list) {
  return list.map((s) => {
    const body = s.type[0] + ':' + s.pts.map((p) => p.map((v) => num(v, 1)).join('_')).join('!');
    const named = s.name && s.num && s.name !== defaultName(s.type, s.num);
    return named ? body + '*' + encName(s.name) : body;
  }).join('~');
}

function decodeSelections(str) {
  const types = { p: 'point', t: 'transect', a: 'area' };
  const out = [];
  for (const part of String(str).split('~')) {
    const [geom, rawName] = part.split('*');
    const [tag, body] = geom.split(':');
    const type = types[tag];
    if (!type || !body) continue;
    const pts = body.split('!').map((p) => p.split('_').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite));
    const need = type === 'area' ? 3 : type === 'transect' ? 2 : 1;
    if (pts.length >= need) out.push({ type, pts, name: rawName ? decName(rawName) : undefined });
  }
  return out;
}

/** Read whatever this URL carries. Missing or malformed keys are simply absent
 *  — a hand-edited link must never leave the app in a broken state. */
export function readState() {
  const q = new URLSearchParams(location.search);
  const f = (k) => {
    const v = parseFloat(q.get(k));
    return Number.isFinite(v) ? v : undefined;
  };
  const state = {
    dataset: q.get('dataset') || undefined,
    variable: q.get('v') || undefined,
    step: f('t'),
    cmin: f('cmin'),
    cmax: f('cmax'),
    cmap: q.get('cmap') || undefined,
    log: q.get('log') === '1' ? true : q.get('log') === '0' ? false : undefined,
    rev: q.get('crev') === '1' || undefined,
    exag: f('ve'),
    clarity: f('cl'),
    bright: f('br'),
    mode: f('mode'),
    flow: q.get('flow') === '1' ? true : q.get('flow') === '0' ? false : undefined,
    stat: q.get('stat') || undefined,
  };
  const cam = (q.get('cam') || '').split(',').map(Number);
  if (cam.length === 6 && cam.every(Number.isFinite)) state.cam = cam;
  if (q.get('sel')) state.selections = decodeSelections(q.get('sel'));
  return state;
}

export class UrlState {
  constructor(collect) {
    this.collect = collect;
    this._timer = 0;
    // Writing is off until the app says it has finished restoring. Boot sets a
    // dozen controls, each of which schedules a write, while the variable named
    // in the URL is still being fetched — a write landing in that window would
    // rewrite the address bar without the parameters it is in the middle of
    // applying, which is what a user would copy if they were quick.
    this.ready = false;
  }

  /** Allow writes, and flush the state the app has ended up in. */
  start() {
    this.ready = true;
    this.touch();
  }

  /** Build the URL for the current view without touching the address bar. */
  href() {
    const s = this.collect();
    const q = new URLSearchParams();
    if (s.dataset && s.dataset !== 'default') q.set('dataset', s.dataset);
    if (s.variable) q.set('v', s.variable);
    q.set('t', num(s.step, 2));
    if (s.variable) {
      if (Number.isFinite(s.cmin)) q.set('cmin', num(s.cmin, 4));
      if (Number.isFinite(s.cmax)) q.set('cmax', num(s.cmax, 4));
      if (s.cmap) q.set('cmap', s.cmap);
      if (s.log) q.set('log', '1');
      if (s.rev) q.set('crev', '1');
    }
    q.set('ve', num(s.exag, 0));
    if (s.clarity !== undefined) q.set('cl', num(s.clarity, 0));
    if (s.bright !== undefined) q.set('br', num(s.bright, 0));
    if (s.mode) q.set('mode', '1');
    if (s.flow === false) q.set('flow', '0');
    if (s.stat && s.stat !== 'mean') q.set('stat', s.stat);
    if (s.cam) q.set('cam', s.cam.map((v) => num(v, 2)).join(','));
    if (s.selections && s.selections.length) q.set('sel', encodeSelections(s.selections));
    return `${location.origin}${location.pathname}?${q}`;
  }

  /** Schedule a replaceState. Safe to call from the render loop. */
  touch() {
    if (!this.ready || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = 0;
      try { history.replaceState(null, '', this.href()); } catch { /* file:// */ }
    }, DEBOUNCE_MS);
  }
}
