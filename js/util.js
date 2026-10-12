// Small shared helpers.

export const $ = (id) => document.getElementById(id);

/** Compact but honest number formatting: keeps 3 significant-ish digits without
 *  ever printing more precision than the value has. */
export function fmtNum(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 1e5)) return v.toExponential(1);
  return (+v.toFixed(a < 1 ? 3 : a < 100 ? 2 : 1)).toString();
}

/** Human label for a variable descriptor: long_name if the file has one. */
export function niceName(p) {
  const s = (p && (p.long || p.name || p.key)) || '';
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "Chlorophylla [mg Chl/m3]" */
export function withUnits(p) {
  return niceName(p) + (p && p.units ? ` [${p.units}]` : '');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Trigger a browser download of a Blob under the given filename. */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoke late — Safari cancels an in-flight download if the URL dies too soon
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

/** A filesystem-safe slug for export filenames. */
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
}
