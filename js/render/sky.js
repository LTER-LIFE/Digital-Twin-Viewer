// Sky dome with sun and drifting clouds. It is drawn at the far plane and
// follows the camera (see the render loop), so it never gets closer.

import * as THREE from 'three';

import { U } from './fields.js';
import { scene, SC } from './viewport.js';
import { program } from './shaderLib.js';

export function createSky() {
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    side: THREE.BackSide,
    depthWrite: false,
    ...program('sky'),
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(8.4 * SC, 32, 16), mat);
  sky.frustumCulled = false;
  scene.add(sky);
  return sky;
}
