// The terrain block's top surface: bathymetry and islands, coloured in the
// realistic or analysis style, with the variable drape over the sea.

import * as THREE from 'three';

import { NX, NY, EXT_X, EXT_Z } from '../core/dataset.js';
import { CMAP_DEFINES } from '../colormaps.js';
import { U } from './fields.js';
import { scene } from './viewport.js';
import { program } from './shaderLib.js';

export function createTerrain() {
  const mat = new THREE.ShaderMaterial({
    uniforms: U,
    defines: CMAP_DEFINES,
    ...program('terrain'),
  });
  const geo = new THREE.PlaneGeometry(EXT_X, EXT_Z, NX - 1, NY - 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
