// WebGL renderer, scene, camera and orbit controls, sized to the view cell.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { EXT_X, EXT_Z } from '../core/dataset.js';
import { $ } from '../util.js';

export const viewEl = $('view');

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('canvas-wrap').appendChild(renderer.domElement);
const floatLinear = !!renderer.getContext().getExtension('OES_texture_float_linear');
/** Filter for float data textures: linear where the GPU can, else nearest. */
export const FILT = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;

// scene scale follows the dataset extent (world unit = 1 km)
export const SC = Math.max(EXT_X, EXT_Z);
const CAM_POS = [-0.107 * SC, 0.37 * SC, 0.705 * SC];
const CAM_TGT = [0, -1, 0.024 * SC];

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(46, 1, Math.max(SC / 300, 0.1), 20 * SC);
camera.position.set(...CAM_POS);
export const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(...CAM_TGT);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = SC / 28;
controls.maxDistance = 3.1 * SC;
controls.maxPolarAngle = Math.PI * 0.492;
controls.autoRotateSpeed = 0.55;

export function resetView() {
  camera.position.set(...CAM_POS);
  controls.target.set(...CAM_TGT);
}

// The renderer follows the VIEW CELL, not the window. Collapsing the sidebar,
// dragging a resizer and resizing the window all reach the camera by this one
// path, so the projection can never disagree with the pixels on screen — which
// is what every pointer-to-cell conversion depends on.
export let viewW = 1, viewH = 1;
function fitRenderer() {
  const r = viewEl.getBoundingClientRect();
  viewW = Math.max(1, Math.round(r.width));
  viewH = Math.max(1, Math.round(r.height));
  renderer.setSize(viewW, viewH);
  camera.aspect = viewW / viewH;
  camera.updateProjectionMatrix();
}
new ResizeObserver(fitRenderer).observe(viewEl);
fitRenderer();
