// Colormaps — the single source of truth for the GLSL drape, the CSS colour
// bar, the Hovmöller raster and the chart accents. Adding a map here reaches
// all four without another edit.
//
// Two kinds of map live here. The six below are hand-authored for this app and
// written as a few interpolation stops, because that is how they were designed
// and how they stay legible to edit. Everything else comes from cmapdata.js as
// a full 256-entry table lifted from Fabio Crameri's Scientific colour maps.
//
// Both are normalised to a 256-entry lookup table at first use, so there is one
// representation downstream: the drape uploads it as a texture, the colour bar
// and the raster read it directly. That replaced a generated GLSL function per
// map — a chain that would have needed 30 more branches, and could not have
// expressed the hard sea/land break in oleron at any length.

import { CRAMERI, CRAMERI_KIND } from './cmapdata.js';

/** Hand-authored maps, as interpolation stops. cmocean-inspired. */
const STOPS = {
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  thermal: [[4, 8, 38], [70, 20, 100], [140, 40, 90], [200, 70, 60], [240, 140, 50], [250, 230, 120]],
  haline:  [[41, 24, 107], [28, 79, 153], [19, 127, 148], [43, 168, 104], [150, 197, 60], [253, 238, 60]],
  algae:   [[26, 32, 25], [30, 70, 50], [35, 110, 70], [70, 150, 80], [150, 190, 90], [230, 230, 140]],
  turbid:  [[35, 30, 20], [70, 55, 30], [120, 90, 40], [170, 130, 55], [210, 180, 90], [235, 225, 160]],
  // current speed: dark water -> the app's cyan accent -> hot white at the jets
  speed:   [[8, 26, 42], [16, 78, 110], [30, 140, 170], [95, 212, 255], [200, 240, 255], [255, 255, 245]],
};

export const LUT_N = 256;

// ------------------------------------------------------------------ tables
const _lut = new Map();

/** The map as 256 RGB triples, built once. */
function lut(name) {
  let t = _lut.get(name);
  if (t) return t;
  t = CRAMERI[name] ? fromHex(CRAMERI[name])
    : fromStops(STOPS[name] || STOPS.viridis);
  _lut.set(name, t);
  return t;
}

function fromHex(hex) {
  const out = new Uint8Array(LUT_N * 3);
  for (let i = 0; i < LUT_N * 3; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function fromStops(st) {
  const out = new Uint8Array(LUT_N * 3);
  for (let i = 0; i < LUT_N; i++) {
    const x = (i / (LUT_N - 1)) * (st.length - 1);
    const s = Math.min(Math.floor(x), st.length - 2);
    const f = x - s;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(st[s][c] + (st[s + 1][c] - st[s][c]) * f);
  }
  return out;
}

// --------------------------------------------------------------- catalogue
// Grouped the way the dropdown shows them. The app's own maps come first
// because they are the ones the automatic defaults reach for most.
export const CMAP_GROUPS = [
  {
    label: 'App / cmocean-style',
    names: ['viridis', 'thermal', 'haline', 'algae', 'turbid', 'speed'],
  },
  {
    label: 'Crameri — sequential',
    names: ['batlow', 'batlowK', 'devon', 'oslo', 'lapaz', 'davos', 'nuuk', 'bamako',
      'lajolla', 'bilbao', 'turku', 'imola', 'hawaii', 'grayC', 'navia', 'lipari'],
  },
  {
    label: 'Crameri — diverging',
    names: ['vik', 'roma', 'broc', 'cork', 'berlin', 'lisbon', 'tofino', 'bam'],
  },
  {
    // a hard break at the midpoint, meant to sit at a sea/land or zero contour
    label: 'Crameri — sea/land',
    names: ['oleron', 'bukavu', 'fes'],
  },
  {
    // first colour equals last, so 0° and 360° are the same colour
    label: 'Crameri — cyclic',
    names: ['romaO', 'vikO', 'brocO'],
  },
];

export const CMAP_ORDER = CMAP_GROUPS.flatMap((g) => g.names);

/** "batlowK" -> "BatlowK", "grayC" -> "GrayC" — capitalised, nothing else, so
 *  the published map names stay searchable. */
export const cmapLabel = (n) => n[0].toUpperCase() + n.slice(1);

/** 'sequential' | 'diverging' | 'multi' | 'cyclic' | 'app' */
export const cmapKind = (n) => CRAMERI_KIND[n] || 'app';

export const isCmap = (n) => Object.prototype.hasOwnProperty.call(CRAMERI, n)
  || Object.prototype.hasOwnProperty.call(STOPS, n);

// ---------------------------------------------------------------- sampling
/** Colour at t in [0,1] -> [r,g,b] 0..255. `rev` flips the map end for end. */
export function sampleCmap(name, t, rev) {
  const L = lut(name);
  let x = Math.min(Math.max(t, 0), 1);
  if (rev) x = 1 - x;
  // linear between table entries: the table is dense enough that this only
  // smooths, and it keeps a designed discontinuity inside one entry
  const p = x * (LUT_N - 1);
  const i = Math.min(Math.floor(p), LUT_N - 2);
  const f = p - i;
  const a = i * 3, b = a + 3;
  return [
    L[a] + (L[b] - L[a]) * f,
    L[a + 1] + (L[b + 1] - L[a + 1]) * f,
    L[a + 2] + (L[b + 2] - L[a + 2]) * f,
  ];
}

/** RGBA bytes for the drape's lookup texture, 256x1. */
export function cmapTexData(name, rev) {
  const L = lut(name);
  const out = new Uint8Array(LUT_N * 4);
  for (let i = 0; i < LUT_N; i++) {
    const s = (rev ? LUT_N - 1 - i : i) * 3;
    const o = i * 4;
    out[o] = L[s]; out[o + 1] = L[s + 1]; out[o + 2] = L[s + 2]; out[o + 3] = 255;
  }
  return out;
}

// 33 stops keeps the CSS string small while staying under a pixel of error on
// the smooth maps. A designed break lands inside one 3 %-wide band, which on a
// colour bar a couple of hundred pixels wide is a few pixels of blend.
const BAR_STOPS = 33;

export function cssGradient(name, rev) {
  const parts = [];
  for (let i = 0; i < BAR_STOPS; i++) {
    const t = i / (BAR_STOPS - 1);
    const c = sampleCmap(name, t, rev);
    parts.push(`rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/** A readable line colour for a variable: the bright end of its own colormap. */
export function cmapAccent(name, rev) {
  const c = sampleCmap(name, 0.78, rev).map((v) => Math.round(Math.min(255, v * 1.05)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ------------------------------------------------------------------- GLSL
// One texture lookup replaces the generated per-map functions. Sampling at
// texel centres keeps both ends exact; without the half-texel inset, t = 0 and
// t = 1 would each be a half-and-half blend with the clamped edge.
//
// The GLSL itself is shaders/chunks/cmap.glsl; a material that includes it
// passes these as `defines`, so the inset follows LUT_N from this one place.
export const CMAP_DEFINES = {
  CMAP_LUT_SCALE: ((LUT_N - 1) / LUT_N).toFixed(6),
  CMAP_LUT_OFFSET: (0.5 / LUT_N).toFixed(6),
};

// ------------------------------------------------------- automatic defaults
/** Pick a colormap from a variable's name, long name, units and value range.
 *
 *  Kept here rather than only in nc_pipeline.py because meta.json records
 *  whatever the pipeline knew when the dataset was built: a map added later, or
 *  a rule fixed later, would otherwise never reach a dataset already processed.
 *  nc_pipeline.py carries the same table for the sake of the metadata it
 *  writes — change both together.
 *
 *  @param p {{key?,name?,long?,units?,dataMin?,dataMax?}}
 */
export function defaultCmap(p) {
  const s = [p.key, p.name, p.long, p.units].filter(Boolean).join(' ').toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));
  // whole-token match, for short names that are substrings of other words —
  // "ess" is inside "stress", "hs" inside "flashes"
  const word = (...w) => w.some((x) => new RegExp(`(^|[^a-z0-9])${x}($|[^a-z0-9])`).test(s));
  const signed = p.dataMin < 0 && p.dataMax > 0;

  // A signed component or anomaly carries its meaning in the sign, which a
  // sequential map cannot show: an eastward and a westward wind of the same
  // strength must not be the same colour. Diverging, with the neutral tone at
  // zero, is the only honest choice — but only when the data really spans zero.
  if (signed && (has('anomaly', 'residual', 'difference', 'delta', 'gradient', 'divergence')
    || has('eastward', 'northward', 'westward', 'southward', 'easternwind', 'southernwind')
    || word('u', 'v', 'uu', 'vv', 'east', 'west', 'north', 'south', 'component'))) return 'vik';

  // 0 and 360 are the same bearing, so the map has to close on itself
  if (has('direction', 'bearing', 'heading', 'azimuth', 'phase')
    || (has('angle') && has('deg'))) return 'romaO';

  if (has('shear', 'stress') || word('tau', 'taub', 'tauc', 'tauw')) return 'lajolla';
  if (has('wave height', 'waveheight', 'significant wave') || word('hs', 'swh', 'hsig')) return 'davos';
  if (has('period', 'zero crossing') || word('tz', 'tp', 'tm')) return 'turku';

  if (has('temperature', 'temp', 'sst', 'theta')) return 'thermal';
  if (has('salin', 'salt') || word('psu', 'sal')) return 'haline';
  if (has('chlorophyll', 'phytoplankton', 'phyto', 'diatom', 'algae', 'flagel')
    || word('chl', 'chla') || has('p1_', 'p2_', 'p3_', 'p4_')) return 'algae';
  if (has('sediment', 'turbid', 'silt', 'clay', 'sand', 'extinction', 'attenuation',
    'backscatter', 'secchi', 'suspended') || word('spm', 'ssc', 'tsm', 'ess', 'kd')) return 'turbid';
  if (has('detritus', 'organic', 'carbon') || word('poc', 'pon', 'doc', 'om')) return 'bamako';
  if (has('nitrate', 'nitrogen', 'nitrite', 'phosph', 'silicate', 'ammoni', 'nutrient')
    || word('o2', 'oxygen', 'n1p', 'n3n', 'n4n', 'n5s', 'ph')) return 'nuuk';
  if (has('zooplankton', 'macrofauna', 'invertebrate', 'benthos', 'benthic', 'fauna', 'bacteria')
    || word('z4', 'z5', 'z6')) return 'turku';
  if (has('speed', 'velocity', 'current', 'orbital', 'wind', 'discharge', 'transport')
    || word('m/s', 'm s-1')) return 'speed';
  if (has('bathym', 'topograph', 'bed level', 'seabed', 'orography')
    || word('elevation', 'zb')) return 'oleron';
  if (has('depth', 'thickness')) return 'devon';

  return 'viridis';
}

/** Qualitative palette for user selections — distinguishable against the dark
 *  panels and against each other, and safe for the common colour deficiencies. */
export const SELECTION_COLORS = [
  '#5fd4ff', '#ffc857', '#7ee787', '#ff8fa3', '#c792ea', '#ffab70', '#6ee7d7', '#f78fb3',
];
