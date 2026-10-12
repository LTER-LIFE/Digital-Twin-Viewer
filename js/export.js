// Publication-quality figure export, and data export that stays interpretable
// once it has left this app.
//
// The figure is rendered into an off-screen WebGLRenderTarget rather than by
// resizing the visible canvas. That avoids a visible flash at 4x, keeps the
// on-screen renderer untouched, and — importantly — means `preserveDrawingBuffer`
// stays off, which would otherwise cost frame rate on every frame of the
// animation for the sake of an occasional screenshot. The target's texture is
// tagged sRGB so the same tone mapping and colour-space conversion the canvas
// gets is applied on the way out; a linear read would come back visibly dark.

import * as THREE from 'three';
import { sampleCmap } from './colormaps.js';
import { download, fmtNum, slugify } from './util.js';

const CAPTION_H = 86;   // at 1x; scales with the figure

/**
 * @param opts {{renderer, scene, camera, width, height, scale, caption:object|null}}
 * caption: {title, subtitle, date, variable, units, range:[lo,hi], cmap, rev, log,
 *           exag, scaleBar:{px,label}, northDeg, attribution, note}
 */
export async function figurePNG(opts) {
  const { renderer, scene, camera, scale } = opts;
  const w = Math.round(opts.width * scale);
  const h = Math.round(opts.height * scale);

  const max = renderer.capabilities.maxTextureSize;
  if (w > max || h > max) {
    throw new Error(`${w}x${h} exceeds this GPU's ${max} px limit — choose a smaller scale`);
  }

  const rt = new THREE.WebGLRenderTarget(w, h, {
    samples: 4,                       // MSAA, so the flow trails do not alias
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;

  const prevTarget = renderer.getRenderTarget();
  const prevRatio = renderer.getPixelRatio();
  const prevAspect = camera.aspect;
  const buf = new Uint8Array(w * h * 4);
  try {
    // the render target already carries the pixel count; a pixel ratio on top
    // would multiply it a second time
    renderer.setPixelRatio(1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setPixelRatio(prevRatio);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    rt.dispose();
  }

  const capH = opts.caption ? Math.round(CAPTION_H * scale) : 0;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h + capH;
  const ctx = out.getContext('2d');

  // GL reads bottom-up; flip into the 2-D canvas one row at a time
  const img = ctx.createImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  }
  ctx.putImageData(img, 0, 0);

  if (opts.caption) drawOverlays(ctx, w, h, capH, scale, opts.caption);
  return new Promise((res) => out.toBlob(res, 'image/png'));
}

/** Translucent plate behind an on-image overlay. The scene runs from a
 *  near-white sky to a dark seabed, so white-on-shadow is not reliably legible;
 *  a plate is, at any camera angle. */
function plate(ctx, x, y, w, h, r) {
  ctx.save();
  ctx.fillStyle = 'rgba(6,16,24,.55)';
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawOverlays(ctx, w, h, capH, s, c) {
  const F = (px) => `${(px * s).toFixed(1)}px "Segoe UI", system-ui, sans-serif`;
  const B = (px) => `600 ${(px * s).toFixed(1)}px "Segoe UI", system-ui, sans-serif`;

  // ---- scale bar + vertical exaggeration, burned into the image itself so a
  // cropped figure still carries them
  if (c.scaleBar) {
    const px = c.scaleBar.px * s;
    const padX = 10 * s, padY = 8 * s;
    const boxW = px + padX * 2;
    const boxH = (c.exag ? 46 : 30) * s;
    const bx = w - boxW - 16 * s, by = h - boxH - 16 * s;
    plate(ctx, bx, by, boxW, boxH, 8 * s);

    ctx.font = B(11);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(c.scaleBar.label, bx + boxW / 2, by + padY);

    const lineY = by + padY + 15 * s;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    ctx.moveTo(bx + padX, lineY - 5 * s);
    ctx.lineTo(bx + padX, lineY);
    ctx.lineTo(bx + padX + px, lineY);
    ctx.lineTo(bx + padX + px, lineY - 5 * s);
    ctx.stroke();

    if (c.exag) {
      ctx.font = B(10.5);
      ctx.fillStyle = '#ffc857';
      ctx.fillText(`V.E. ${c.exag}×`, bx + boxW / 2, lineY + 5 * s);
    }
  }

  // ---- north arrow
  if (Number.isFinite(c.northDeg)) {
    const r = 15 * s;
    const cx = 16 * s + r + 8 * s, cy = 16 * s + r + 8 * s;
    plate(ctx, cx - r - 8 * s, cy - r - 8 * s, (r + 8 * s) * 2, (r + 8 * s) * 2 + 12 * s, 8 * s);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((c.northDeg * Math.PI) / 180);
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#ffc857';
    ctx.lineWidth = 1.6 * s;
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.42, r * 0.55); ctx.lineTo(0, r * 0.22);
    ctx.lineTo(-r * 0.42, r * 0.55); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.font = B(10);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', cx, cy + r + 1 * s);
  }

  if (c.attribution) {
    ctx.font = F(9.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(c.attribution).width;
    plate(ctx, 12 * s, h - 24 * s, tw + 14 * s, 18 * s, 5 * s);
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    ctx.fillText(c.attribution, 19 * s, h - 10 * s);
  }

  if (!capH) return;

  // ---- caption bar. Left column is identity, right column is what the colours
  // mean; both are laid out on the same baseline grid so a long variable name
  // can never land on top of the date.
  ctx.fillStyle = '#0a1620';
  ctx.fillRect(0, h, w, capH);
  ctx.fillStyle = 'rgba(120,200,235,.28)';
  ctx.fillRect(0, h, w, Math.max(1, s));

  const pad = 18 * s;
  const bw = 140 * s, bh = 9 * s;
  const bx = w - pad - bw;
  const rightW = c.variable && c.range ? bw + 28 * s : 160 * s;

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = B(13);
  ctx.fillStyle = '#e8f4fa';
  ctx.fillText(clipText(ctx, c.title, w - rightW - pad * 2), pad, h + 24 * s);

  ctx.font = F(10.5);
  ctx.fillStyle = '#9db8c6';
  ctx.fillText(clipText(ctx, c.subtitle || '', w - rightW - pad * 2), pad, h + 43 * s);
  if (c.note) {
    ctx.fillStyle = '#6d8695';
    ctx.font = F(9.5);
    ctx.fillText(clipText(ctx, c.note, w - rightW - pad * 2), pad, h + 61 * s);
  }

  ctx.textAlign = 'right';
  ctx.font = B(11);
  ctx.fillStyle = '#e8f4fa';
  ctx.fillText(c.date, w - pad, h + 21 * s);

  // colour ramp with its range, so the figure is self-describing
  if (c.variable && c.range) {
    const by = h + 46 * s;
    // sampled rather than built from stops: the exported bar has to be the
    // same colours as the on-screen one, including a reversed map
    const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
    const BAR = 33;
    for (let i = 0; i < BAR; i++) {
      const t = i / (BAR - 1);
      const col = sampleCmap(c.cmap, t, c.rev);
      grad.addColorStop(t, `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255,255,255,.3)';
    ctx.lineWidth = Math.max(1, s * 0.8);
    ctx.strokeRect(bx, by, bw, bh);

    ctx.font = F(10);
    ctx.fillStyle = '#c8dbe6';
    ctx.textAlign = 'right';
    ctx.fillText(c.variable + (c.log ? ' (log)' : ''), bx + bw, by - 6 * s);

    ctx.font = F(9.5);
    ctx.fillStyle = '#9db8c6';
    ctx.textAlign = 'left';
    ctx.fillText(fmtNum(c.range[0]), bx, by + bh + 11 * s);
    ctx.textAlign = 'right';
    ctx.fillText(fmtNum(c.range[1]) + (c.units ? ' ' + c.units : ''), bx + bw, by + bh + 11 * s);
  }
}

function clipText(ctx, text, maxW) {
  if (!text || ctx.measureText(text).width <= maxW) return text || '';
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

// =========================================================== data export

/** Comment header carried by every CSV, so the numbers stay interpretable. */
export function csvHeader(info) {
  const L = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') L.push(`# ${k}: ${v}`); };
  add('generated', new Date().toISOString());
  add('source', 'Wad-EMOaaS Digital Twin Viewer');
  add('dataset', info.title);
  add('grid', `${info.nx} x ${info.ny} cells @ ${info.cellKm} km`);
  add('time', `${info.nDays} steps of ${info.stepDays} day(s) from ${info.startDate}`);
  add('vertical datum', info.datum || 'not stated in the source file');
  add('layer', info.layer);
  add('value precision', info.precision);
  add('caveat', info.caveat);
  add('view', info.url);
  L.push('#');
  return L.join('\n') + '\n';
}

const q = (v) => {
  const s = v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Long-format CSV: one row per selection x step x series. Long format because
 * a wide table cannot hold selections with different statistics and units side
 * by side without lying about one of them.
 */
const SERIES_COLS = ['selection', 'type', 'n_cells', 'step', 'date', 'variable',
  'units', 'statistic', 'value', 'n_valid', 'wet_fraction'];

/** Columns for a vertical-profile export. The layer's own top, bottom and
 *  thickness travel with the value: a sigma layer index means nothing away
 *  from this app, and a reader should not have to reconstruct the depth. */
export const PROFILE_COLS = ['selection', 'type', 'row', 'col', 'step', 'date',
  'layer', 'of_layers', 'bottom_m', 'top_m', 'mid_m', 'thickness_m',
  'variable', 'units', 'value'];

export function seriesCSV({ header, rows, cols = SERIES_COLS }) {
  const out = [header + cols.join(',')];
  for (const r of rows) out.push(cols.map((c) => q(r[c])).join(','));
  return new Blob([out.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
}

export function selectionsJSON(payload) {
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
}

export function saveBlob(blob, name) { download(blob, name); }
export { slugify };
