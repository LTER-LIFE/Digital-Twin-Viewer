// The model fields as GPU textures, and the uniforms every scene shader shares.
//
// Elevation and the variable drape are streamed per timestep: two frames are
// held (A and B, the steps either side of the current time) and the shaders
// blend them by uMix. time.js decides which steps those are.

import * as THREE from 'three';

import { meta, DATA, NX, NY, N, EXT_X, EXT_Z, terrain, masks, elevI16, fetchProgress } from '../core/dataset.js';
import { cmapTexData, LUT_N } from '../colormaps.js';
import { $ } from '../util.js';
import { renderer, FILT, SC } from './viewport.js';

function dataTex(data, format) {
  const t = new THREE.DataTexture(data, NX, NY, format, THREE.FloatType);
  t.magFilter = FILT; t.minFilter = FILT;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
// terrain: R=height m, G=land, B=intertidal
const terrRGBA = new Float32Array(N * 4);
for (let i = 0; i < N; i++) {
  terrRGBA[i * 4] = terrain[i];
  terrRGBA[i * 4 + 1] = masks[i] & 1;
  terrRGBA[i * 4 + 2] = (masks[i] >> 1) & 1;
  terrRGBA[i * 4 + 3] = 1;
}
const terrainTex = dataTex(terrRGBA, THREE.RGBAFormat);

/** Water level (m) of the two bracketing steps, as the shaders see them. */
export const fA = new Float32Array(N), fB = new Float32Array(N);
export const elevTexA = dataTex(fA, THREE.RedFormat);
export const elevTexB = dataTex(fB, THREE.RedFormat);
export function loadFrame(arr, tex, day) {
  const off = day * N;
  for (let i = 0; i < N; i++) arr[i] = elevI16[off + i] * 0.01;
  tex.needsUpdate = true;
}

// wetness (R) + flood flash (G)
export const wetArr = new Float32Array(N * 2);
export const wetTex = dataTex(wetArr, THREE.RGFormat);
export const prevWet = new Uint8Array(N);

// scalar variable drape (temperature, salinity, plankton, …), lazily loaded
export const pFA = new Float32Array(N), pFB = new Float32Array(N);
export const varTexA = dataTex(pFA, THREE.RedFormat);
export const varTexB = dataTex(pFB, THREE.RedFormat);

// real-world satellite drape (optional, produced by satellite.py)
const satPlaceholder = new THREE.DataTexture(
  new Uint8Array([120, 125, 115, 255]), 1, 1, THREE.RGBAFormat);
satPlaceholder.needsUpdate = true;
let satTex = satPlaceholder, satUVTex = satPlaceholder, hasSat = 0;
if (meta.satellite) {
  try {
    const [uvBuf, tex] = await Promise.all([
      fetchProgress(`${DATA}/satuv.bin`),
      new THREE.TextureLoader().loadAsync(`${DATA}/satellite.jpg`),
    ]);
    satUVTex = dataTex(new Float32Array(uvBuf), THREE.RGFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    satTex = tex;
    hasSat = 1;
    const at = $('attrib');
    at.textContent = meta.satelliteAttribution || 'Imagery © Esri';
    at.hidden = false;
  } catch (e) {
    console.warn('satellite imagery unavailable:', e);
  }
}

// ---------------------------------------------------------------- colormap LUT
// The variable drape reads its colours from a 256x1 lookup texture instead of a
// generated GLSL function per colormap. With 36 maps that chain would be 36
// more shader branches, and oleron's sea/land step cannot be written as
// interpolation stops at all.
//
// The texture is deliberately left in the default (non-sRGB) colour space. The
// GLSL it replaces fed raw byte/255 values straight into the lit, tone-mapped
// pipeline; declaring these as sRGB would be more correct in isolation but
// would restyle every existing figure, which is not this change's business.
const cmapTex = new THREE.DataTexture(cmapTexData('viridis', false), LUT_N, 1, THREE.RGBAFormat);
cmapTex.minFilter = cmapTex.magFilter = THREE.LinearFilter;
cmapTex.wrapS = cmapTex.wrapT = THREE.ClampToEdgeWrapping;
cmapTex.needsUpdate = true;

export function setCmapTex(name, rev) {
  cmapTex.image.data.set(cmapTexData(name, rev));
  cmapTex.needsUpdate = true;
}

// ---------------------------------------------------------------- shared uniforms
export const U = {
  uHS:       { value: 0.20 },                         // world units per metre (exag/1000)
  uMix:      { value: 0 },
  uTime:     { value: 0 },
  uMode:     { value: 0 },
  uAlphaMul: { value: 0.85 },
  uBright:   { value: 1.0 },
  uSunDir:   { value: new THREE.Vector3(-0.52, 0.62, 0.55).normalize() },
  uFogColor: { value: new THREE.Color(0.78, 0.84, 0.87) },
  uFogRange: { value: new THREE.Vector2(1.67 * SC, 5.67 * SC) },
  uTerrainTex: { value: terrainTex },
  uElevA:    { value: elevTexA },
  uElevB:    { value: elevTexB },
  uWet:      { value: wetTex },
  uVarA:     { value: varTexA },
  uVarB:     { value: varTexB },
  uVarOn:    { value: 0 },
  // x,y = the physical range the stored bytes span; z,w = the range the user
  // has chosen for the colour scale. Keeping them apart is what lets the scale
  // be narrowed or widened without touching the data.
  uVarRange: { value: new THREE.Vector4(0, 1, 0, 1) },
  uVarLog:   { value: 0 },
  uCmapTex:  { value: cmapTex },
  uSatTex:   { value: satTex },
  uSatUV:    { value: satUVTex },
  uHasSat:   { value: hasSat },
  uTexFit:   { value: new THREE.Vector4((NX - 1) / NX, (NY - 1) / NY, 0.5 / NX, 0.5 / NY) },
  uGrid:     { value: new THREE.Vector2(NX, NY) },
  uCell:     { value: new THREE.Vector2(EXT_X / (NX - 1), EXT_Z / (NY - 1)) },
};
