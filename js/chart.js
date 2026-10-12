// Hand-rolled canvas2d plotting, in the same spirit as the rest of the app:
// no build step, no CDN, works offline and inside the container.
//
// Three plot forms are needed and they share one axis/frame implementation:
//   - multi-series line with gaps and a percentile band  (timeseries)
//   - filled cross-section, layer by layer                (transect profile)
//   - distance x time raster                             (Hovmoller)
//
// Gaps matter more here than in a normal chart. A model cell that is dry, or is
// land, has no value — the pipeline nearest-fills it so the 3-D drape has no
// seams, which means a naive read returns a neighbour's number. Series carry
// null at those steps and the line BREAKS rather than interpolating across.

import { sampleCmap } from './colormaps.js';

const CSS = {
  text:   '#e8f4fa',
  muted:  '#9db8c6',
  dim:    '#6d8695',
  grid:   'rgba(255,255,255,.075)',
  axis:   'rgba(255,255,255,.22)',
  cursor: 'rgba(95,212,255,.85)',
  hover:  'rgba(255,255,255,.30)',
  panel:  'rgba(6,16,24,.93)',
};
const PAD = { l: 56, r: 12, t: 12, b: 26 };
const SEAM = 0.5;          // device-pixel overlap between adjacent section quads
const FONT = '10.5px "Segoe UI", system-ui, sans-serif';

/** 1 / 2 / 5 x 10^k tick values covering [min,max]. */
export function niceTicks(min, max, target = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  if (min > max) [min, max] = [max, min];      // reversed axes (time downward)
  const raw = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/** Tick label with just enough decimals to separate neighbouring ticks. */
function tickText(v, step) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(1);
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(Math.abs(step || 1))) + 0));
  return v.toFixed(dec);
}

export class Chart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onScrub?:(x:number)=>void, onHover?:(x:number|null)=>void}} opts
   */
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.spec = null;
    this.hoverX = null;
    this.hoverY = null;
    this._ro = new ResizeObserver(() => this.redraw());
    this._ro.observe(canvas);
    this._wire();
  }

  _wire() {
    const cv = this.cv;
    let dragging = false;
    // Both axes are reported. On a timeseries the meaningful one is x; on a
    // Hovmoller, time runs down the y axis, so a readout that only knew x could
    // not say which timestep the cursor is over.
    const toXY = (ev) => {
      const r = cv.getBoundingClientRect();
      const p = this._plot(r.width, r.height);
      const s = this.spec;
      if (!s || !s.x || !s.y) return null;
      const fx = (ev.clientX - r.left - p.x) / p.w;
      const fy = (ev.clientY - r.top - p.y) / p.h;
      return {
        x: s.x.min + Math.min(Math.max(fx, 0), 1) * (s.x.max - s.x.min),
        y: s.y.max + Math.min(Math.max(fy, 0), 1) * (s.y.min - s.y.max),
      };
    };
    const scrub = (v) => {
      if (!v) return;
      // the Hovmoller carries time on either axis depending on what is
      // selected, so the spec says which one a drag means
      const ax = this.spec && this.spec.scrubAxis;
      if (this.opts.onScrub && ax !== 'y') this.opts.onScrub(v.x);
      if (this.opts.onScrubY && ax !== 'x') this.opts.onScrubY(v.y);
    };
    cv.addEventListener('pointerdown', (e) => {
      const v = toXY(e);
      if (!v) return;
      dragging = true;
      // capture is a convenience — it keeps the drag alive when the pointer
      // leaves the canvas. It can refuse (a pointer already released, a
      // synthetic event), and losing the whole scrub because of that would be
      // a far worse failure than losing capture. selection.js guards its own
      // capture the same way.
      try { cv.setPointerCapture(e.pointerId); } catch { /* drag without it */ }
      scrub(v);
    });
    cv.addEventListener('pointermove', (e) => {
      const v = toXY(e);
      if (dragging) scrub(v);
      this.hoverX = v ? v.x : null;
      this.hoverY = v ? v.y : null;
      // only repaint for the hover guide when this spec actually draws one —
      // a raster redraw rebuilds its whole ImageData and must not run per pixel
      if (this.spec && this.spec.hoverFmt) this.redraw();
    });
    const end = () => { dragging = false; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      dragging = false;
      const had = this.hoverX !== null;
      this.hoverX = null;
      this.hoverY = null;
      if (had && this.spec && this.spec.hoverFmt) this.redraw();
    });
  }

  _plot(w, h) {
    const s = this.spec || {};
    const l = PAD.l + (s.y && s.y.label ? 0 : -14);
    const b = PAD.b + (s.x && s.x.label ? 12 : 0);
    const t = PAD.t + (s.title ? 14 : 0);
    // a second axis needs room on the right for its ticks and rotated label
    const r = s.y2 ? PAD.l : PAD.r;
    return { x: l, y: t, w: Math.max(10, w - l - r), h: Math.max(10, h - t - b) };
  }

  draw(spec) { this.spec = spec; this.redraw(); }

  redraw() {
    const cv = this.cv, ctx = this.ctx;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';

    const s = this.spec;
    if (!s || s.empty) {
      ctx.fillStyle = CSS.dim;
      ctx.textAlign = 'center';
      wrapText(ctx, (s && s.empty) || 'No data', w / 2, h / 2, w - 30, 15);
      return;
    }

    const p = this._plot(w, h);
    this._frame(p, s);
    if (s.raster) this._raster(p, s);
    if (s.polys) this._polys(p, s);
    if (s.spans) this._spans(p, s);
    if (s.bands) for (const b of s.bands) this._band(p, s, b);
    if (s.vbands) for (const b of s.vbands) this._vband(p, s, b);
    if (s.hlines) for (const l of s.hlines) this._hline(p, s, l);
    if (s.vlines) for (const l of s.vlines) this._vline(p, s, l);
    if (s.series) for (const ser of s.series) this._line(p, s, ser);
    this._cursor(p, s);
    this._legend(p, s);
    if (s.title) {
      ctx.fillStyle = CSS.muted;
      ctx.textAlign = 'left';
      ctx.fillText(s.title, p.x, 8);
    }
  }

  // --------------------------------------------------------------- helpers
  /** A band whose spread runs along X at each Y — the shape a vertical
   *  profile needs. _band is the same walk with the axes swapped; they are
   *  kept apart rather than generalised because the gap handling reads far
   *  more clearly when the independent axis has a name. */
  _vband(p, s, b) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    ctx.fillStyle = b.color;
    let i = 0;
    while (i < b.ys.length) {
      while (i < b.ys.length && !Number.isFinite(b.lo[i])) i++;
      let j = i;
      while (j < b.ys.length && Number.isFinite(b.lo[j]) && Number.isFinite(b.hi[j])) j++;
      if (j - i > 1) {
        ctx.beginPath();
        for (let k = i; k < j; k++) ctx.lineTo(this._sx(p, s, b.hi[k]), this._sy(p, s, b.ys[k]));
        for (let k = j - 1; k >= i; k--) ctx.lineTo(this._sx(p, s, b.lo[k]), this._sy(p, s, b.ys[k]));
        ctx.closePath(); ctx.fill();
      }
      i = j + 1;
    }
    ctx.restore();
  }

  /** The mirror of _hline, for a plot whose time axis runs horizontally. */
  _vline(p, s, l) {
    const ctx = this.ctx;
    const lo = Math.min(s.x.min, s.x.max), hi = Math.max(s.x.min, s.x.max);
    if (l.x < lo || l.x > hi) return;
    const x = Math.round(this._sx(p, s, l.x)) + 0.5;
    ctx.save();
    ctx.setLineDash(l.dash || [3, 3]);
    ctx.strokeStyle = l.color || 'rgba(255,255,255,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
    ctx.restore();
    if (l.label) {
      ctx.fillStyle = CSS.dim;
      ctx.textAlign = 'left';
      ctx.fillText(l.label, x + 4, p.y + 2);
    }
  }

  _sx(p, s, v) { return p.x + ((v - s.x.min) / (s.x.max - s.x.min || 1)) * p.w; }
  _sy(p, s, v) { return p.y + p.h - ((v - s.y.min) / (s.y.max - s.y.min || 1)) * p.h; }
  /** Series carrying different units are mapped through their own axis rather
   *  than being squeezed onto one — plotting km² against a metre scale would
   *  make both curves lie about their magnitude. */
  _sv(p, s, ser, v) {
    if (ser && ser.axis === 'right' && s.y2) {
      return p.y + p.h - ((v - s.y2.min) / (s.y2.max - s.y2.min || 1)) * p.h;
    }
    return this._sy(p, s, v);
  }

  _frame(p, s) {
    const ctx = this.ctx;
    // both axes accept either bare numbers or {v, text} — month names on a time
    // axis, plain numbers elsewhere
    const norm = (ticks, auto) => {
      const raw = ticks || auto;
      const step = raw.length > 1 && typeof raw[0] === 'number' ? raw[1] - raw[0] : null;
      return raw.map((t) => (typeof t === 'number' ? { v: t, text: tickText(t, step) } : t));
    };
    const yt = norm(s.y.ticks, niceTicks(s.y.min, s.y.max, Math.max(2, Math.round(p.h / 42))));
    ctx.strokeStyle = CSS.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.fillStyle = CSS.dim;
    for (const t of yt) {
      const y = Math.round(this._sy(p, s, t.v)) + 0.5;
      if (y < p.y - 1 || y > p.y + p.h + 1) continue;
      ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
      if (t.text) ctx.fillText(t.text, p.x - 6, y);
    }
    const xt = norm(s.x.ticks, niceTicks(s.x.min, s.x.max, Math.max(2, Math.round(p.w / 70))));
    ctx.textAlign = 'center';
    for (const t of xt) {
      const x = Math.round(this._sx(p, s, t.v)) + 0.5;
      if (x < p.x - 1 || x > p.x + p.w + 1) continue;
      ctx.strokeStyle = CSS.grid;
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
      if (t.text) ctx.fillText(t.text, x, p.y + p.h + 10);
    }
    ctx.strokeStyle = CSS.axis;
    ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w, p.h);

    // second axis: ticks and label on the right, no gridlines of its own so the
    // two scales never draw a confusing double grid
    if (s.y2) {
      const y2t = norm(s.y2.ticks, niceTicks(s.y2.min, s.y2.max, Math.max(2, Math.round(p.h / 42))));
      ctx.textAlign = 'left';
      ctx.fillStyle = CSS.dim;
      for (const t of y2t) {
        const y = Math.round(p.y + p.h - ((t.v - s.y2.min) / (s.y2.max - s.y2.min || 1)) * p.h) + 0.5;
        if (y < p.y - 1 || y > p.y + p.h + 1) continue;
        ctx.strokeStyle = CSS.axis;
        ctx.beginPath(); ctx.moveTo(p.x + p.w, y); ctx.lineTo(p.x + p.w + 4, y); ctx.stroke();
        if (t.text) ctx.fillText(t.text, p.x + p.w + 7, y);
      }
    }

    ctx.fillStyle = CSS.muted;
    if (s.x.label) { ctx.textAlign = 'center'; ctx.fillText(s.x.label, p.x + p.w / 2, p.y + p.h + 22); }
    if (s.y.label) {
      ctx.save();
      ctx.translate(11, p.y + p.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillText(clip(ctx, s.y.label, p.h), 0, 0);
      ctx.restore();
    }
    if (s.y2 && s.y2.label) {
      ctx.save();
      ctx.translate(p.x + p.w + PAD.l - 12, p.y + p.h / 2);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.fillStyle = CSS.muted;
      ctx.fillText(clip(ctx, s.y2.label, p.h), 0, 0);
      ctx.restore();
    }
  }

  _spans(p, s) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    for (const sp of s.spans) {
      const a = this._sx(p, s, sp.x0), b = this._sx(p, s, sp.x1);
      ctx.fillStyle = sp.color;
      ctx.fillRect(a, p.y, Math.max(b - a, 0.8), p.h);
    }
    ctx.restore();
  }

  _band(p, s, b) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    ctx.fillStyle = b.color;
    // walk contiguous runs so a gap does not close the polygon across it
    let i = 0;
    while (i < b.xs.length) {
      while (i < b.xs.length && (b.lo[i] === null || !Number.isFinite(b.lo[i]))) i++;
      let j = i;
      while (j < b.xs.length && b.lo[j] !== null && Number.isFinite(b.lo[j])) j++;
      if (j - i > 1) {
        ctx.beginPath();
        for (let k = i; k < j; k++) ctx.lineTo(this._sx(p, s, b.xs[k]), this._sy(p, s, b.hi[k]));
        for (let k = j - 1; k >= i; k--) ctx.lineTo(this._sx(p, s, b.xs[k]), this._sy(p, s, b.lo[k]));
        ctx.closePath(); ctx.fill();
      }
      i = j + 1;
    }
    ctx.restore();
  }

  _hline(p, s, l) {
    const ctx = this.ctx;
    // the y axis may run either way — the Hovmoller puts time at the top and
    // counts down, so a plain min/max comparison would reject every value
    const lo = Math.min(s.y.min, s.y.max), hi = Math.max(s.y.min, s.y.max);
    if (l.y < lo || l.y > hi) return;
    const y = Math.round(this._sy(p, s, l.y)) + 0.5;
    ctx.save();
    ctx.setLineDash(l.dash || [3, 3]);
    ctx.strokeStyle = l.color || 'rgba(255,255,255,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
    ctx.restore();
    if (l.label) {
      ctx.fillStyle = CSS.dim;
      ctx.textAlign = 'left';
      ctx.fillText(l.label, p.x + 4, y - 7);
    }
  }

  _line(p, s, ser) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();

    if (ser.fill) {
      const ax = ser.axis === 'right' && s.y2 ? s.y2 : s.y;
      const base = this._sv(p, s, ser, Math.min(Math.max(ser.fillBase ?? ax.min, ax.min), ax.max));
      ctx.fillStyle = ser.fill;
      let i = 0;
      while (i < ser.xs.length) {
        while (i < ser.xs.length && !Number.isFinite(ser.ys[i])) i++;
        let j = i;
        while (j < ser.xs.length && Number.isFinite(ser.ys[j])) j++;
        if (j - i > 1) {
          ctx.beginPath();
          ctx.moveTo(this._sx(p, s, ser.xs[i]), base);
          for (let k = i; k < j; k++) ctx.lineTo(this._sx(p, s, ser.xs[k]), this._sv(p, s, ser, ser.ys[k]));
          ctx.lineTo(this._sx(p, s, ser.xs[j - 1]), base);
          ctx.closePath(); ctx.fill();
        }
        i = j + 1;
      }
    }

    ctx.strokeStyle = ser.color;
    ctx.lineWidth = ser.width || 1.6;
    ctx.lineJoin = 'round';
    ctx.setLineDash(ser.dash || []);
    // `noLine` draws samples only: a set of bottle samples a month apart is
    // a set of readings, and joining them would draw a curve nobody measured
    if (!ser.noLine) {
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < ser.xs.length; k++) {
        const v = ser.ys[k];
        if (!Number.isFinite(v) || !Number.isFinite(ser.xs[k])) { pen = false; continue; }
        const x = this._sx(p, s, ser.xs[k]), y = this._sv(p, s, ser, v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    }

    // a lone valid sample between two gaps has no segment to draw — mark it,
    // otherwise an intermittently wet cell plots as an empty panel. `dots` asks
    // for every sample to be marked, which is how a measured profile says it is
    // a set of readings at depths rather than a continuous curve.
    ctx.setLineDash([]);
    ctx.fillStyle = ser.color;
    ctx.strokeStyle = ser.color;
    ctx.lineWidth = 1.2;
    const r = ser.dots || 1.7;
    for (let k = 0; k < ser.xs.length; k++) {
      if (!Number.isFinite(ser.ys[k]) || !Number.isFinite(ser.xs[k])) continue;
      if (!ser.dots) {
        const prev = k > 0 && Number.isFinite(ser.ys[k - 1]);
        const next = k < ser.xs.length - 1 && Number.isFinite(ser.ys[k + 1]);
        if (prev || next) continue;
      }
      ctx.beginPath();
      ctx.arc(this._sx(p, s, ser.xs[k]), this._sv(p, s, ser, ser.ys[k]), r, 0, 7);
      // a ring is a measurement, a filled dot a model sample: the same
      // distinction the line styles make
      if (ser.ring) ctx.stroke(); else ctx.fill();
    }
    ctx.restore();
  }

  /** Filled vertical bars — the water column of a cross-section, coloured by
   *  the active variable so the profile shows the field, not just the geometry. */
  /** Filled quadrilaterals: {x0, x1, bl, br, tl, tr, color}, where bl/br and
   *  tl/tr are the bottom and top edges at the left and right x.
   *
   *  Axis-aligned rectangles were the obvious first shape and the wrong one. A
   *  section's layers follow the bed, so a rectangle per cell leaves the fill
   *  as a staircase against the bed line drawn through cell centres — visibly
   *  ragged where water meets ground, and worse between layers, where two
   *  stacked rectangles share an edge the rasteriser antialiases into a pale
   *  seam. Sloping the edges makes neighbours share exact corners, and
   *  stroking each polygon in its own colour closes the hairline that
   *  antialiasing still leaves along the shared edge. */
  _polys(p, s) {
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.8;
    for (const c of s.polys) {
      // Sideways overlap, in device pixels. Two quads that share an edge
      // exactly still leave a seam: each covers part of the boundary pixel,
      // neither covers all of it, and the background shows through the
      // remainder — measured at 9 % here, which reads as a dark pinstripe down
      // every cell. Half a pixel of overlap lets the later quad cover the
      // boundary outright. Every quad grows on both sides, so the columns keep
      // their width and only the boundary moves, by less than a pixel.
      const x0 = this._sx(p, s, c.x0) - SEAM, x1 = this._sx(p, s, c.x1) + SEAM;
      const bl = this._sy(p, s, c.bl), br = this._sy(p, s, c.br);
      const tl = this._sy(p, s, c.tl), tr = this._sy(p, s, c.tr);
      // the same trick vertically would push the lowest layer through the bed
      // and the top one through the waterline; stroking the outline in the
      // fill colour closes those interfaces without growing the shape
      ctx.fillStyle = ctx.strokeStyle = c.color;
      ctx.beginPath();
      ctx.moveTo(x0, tl); ctx.lineTo(x1, tr); ctx.lineTo(x1, br); ctx.lineTo(x0, bl);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  _raster(p, s) {
    const r = s.raster;
    const { nx, ny, values, cmap, rev, lo, hi } = r;
    if (!this._off) this._off = document.createElement('canvas');
    const off = this._off;
    off.width = nx; off.height = ny;
    const octx = off.getContext('2d');
    const img = octx.createImageData(nx, ny);
    const span = (hi - lo) || 1;
    for (let i = 0; i < nx * ny; i++) {
      const v = values[i];
      const o = i * 4;
      if (!Number.isFinite(v)) {          // no data: transparent, grid shows through
        img.data[o + 3] = 0;
        continue;
      }
      const t = r.log
        ? Math.log(Math.max(v, lo * 1e-6) / lo) / Math.log(hi / lo)
        : (v - lo) / span;
      const c = sampleCmap(cmap, t, rev);
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
    // no smoothing: each pixel is one model cell at one timestep, and blurring
    // them would invent structure the model never produced
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, p.x, p.y, p.w, p.h);
    ctx.restore();
  }

  _cursor(p, s) {
    const ctx = this.ctx;
    if (Number.isFinite(s.cursor)) {
      const x = Math.round(this._sx(p, s, s.cursor)) + 0.5;
      if (x >= p.x && x <= p.x + p.w) {
        ctx.strokeStyle = CSS.cursor;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
      }
    }
    if (this.hoverX !== null && s.hoverFmt) {
      const x = Math.round(this._sx(p, s, this.hoverX)) + 0.5;
      if (x < p.x || x > p.x + p.w) return;
      ctx.strokeStyle = CSS.hover;
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
      // a raster reads in two dimensions, so it gets a crosshair not a rule
      if (s.raster && this.hoverY !== null) {
        const y = Math.round(this._sy(p, s, this.hoverY)) + 0.5;
        ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
      }
      ctx.setLineDash([]);
      const lines = s.hoverFmt(this.hoverX, this.hoverY);
      if (!lines || !lines.length) return;
      ctx.textAlign = 'left';
      const wBox = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 18;
      const hBox = lines.length * 14 + 8;
      const bx = Math.min(x + 8, p.x + p.w - wBox);
      const by = p.y + 4;
      ctx.fillStyle = CSS.panel;
      ctx.strokeStyle = 'rgba(120,200,235,.22)';
      roundRect(ctx, bx, by, wBox, hBox, 5);
      ctx.fill(); ctx.stroke();
      lines.forEach((l, i) => {
        const ly = by + 11 + i * 14;
        if (l.color) {
          ctx.fillStyle = l.color;
          ctx.fillRect(bx + 6, ly - 3, 6, 6);
        }
        ctx.fillStyle = l.color ? CSS.text : CSS.muted;
        ctx.fillText(l.text, bx + (l.color ? 17 : 6), ly);
      });
    }
  }

  _legend(p, s) {
    // `noLegend` lets a panel name a series for the hover readout without
    // spending a legend row on it
    const items = (s.series || []).filter((x) => x.label && !x.noLegend);
    if (items.length < 2 && !s.forceLegend) return;
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    let y = p.y + 8;
    const x = p.x + 8;
    for (const it of items) {
      ctx.strokeStyle = it.color;
      ctx.fillStyle = it.color;
      ctx.lineWidth = it.width || 1.6;
      ctx.setLineDash(it.dash || []);
      if (it.noLine) {
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(x + 6.5, y, it.dots || 2.4, 0, 7);
        if (it.ring) ctx.stroke(); else ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 13, y); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = CSS.muted;
      ctx.fillText(clip(ctx, it.label, p.w - 40), x + 18, y);
      y += 13;
      if (y > p.y + p.h - 6) break;
    }
  }

  /** PNG of the chart at the given pixel scale, for export. */
  toBlob(scale = 2) {
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    const out = document.createElement('canvas');
    out.width = Math.round(w * scale);
    out.height = Math.round(h * scale);
    const c = out.getContext('2d');
    c.fillStyle = '#0d1c28';
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(this.cv, 0, 0, out.width, out.height);
    return new Promise((res) => out.toBlob(res, 'image/png'));
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clip(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function wrapText(ctx, text, cx, cy, maxW, lh) {
  const words = String(text).split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; }
    else line = t;
  }
  if (line) lines.push(line);
  const y0 = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, y0 + i * lh));
}
