// The water surface: a translucent sheet at the interpolated water level,
// discarded wherever a cell has fallen dry so the flats emerge.

import * as THREE from 'three';

import { NX, NY, EXT_X, EXT_Z } from '../core/dataset.js';
import { U } from './fields.js';
import { scene } from './viewport.js';
import { program } from './shaderLib.js';

export function createWater() {
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    ...program('water'),
  });
  const geo = new THREE.PlaneGeometry(EXT_X, EXT_Z, NX - 1, NY - 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
