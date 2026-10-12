// The block's cut sides: sediment strata from the base up to the bed, a
// translucent water wall from the bed up to the water level, and a dark cap
// underneath. Both side walls share one skirt geometry around the border.

import * as THREE from 'three';

import { NX, NY, EXT_X, EXT_Z, BASE_M } from '../core/dataset.js';
import { U } from './fields.js';
import { scene } from './viewport.js';
import { program } from './shaderLib.js';

function buildSkirt() {
  // border traversal: for each border cell strip, 2 verts (top/bottom) per point
  const pos = [], uvt = [], top = [], nOut = [], along = [], idx = [];
  let vi = 0;
  const wx = (j) => (j / (NX - 1)) * EXT_X - EXT_X / 2;
  const wz = (i) => -((i / (NY - 1)) * EXT_Z - EXT_Z / 2);
  const addStrip = (pts, normal) => {
    const start = vi;
    let dist = 0;
    for (let k = 0; k < pts.length; k++) {
      const [i, j] = pts[k];
      if (k > 0) {
        const [pi, pj] = pts[k - 1];
        dist += Math.hypot(wx(j) - wx(pj), wz(i) - wz(pi));
      }
      const x = wx(j), z = wz(i);
      const u = (j + 0.5) / NX, v = (i + 0.5) / NY;
      for (const tp of [1, 0]) {
        pos.push(x, 0, z); uvt.push(u, v); top.push(tp);
        nOut.push(...normal); along.push(dist);
        vi++;
      }
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = start + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  const S = [], Nn = [], W = [], E = [];
  for (let j = 0; j < NX; j++) { S.push([0, j]); Nn.push([NY - 1, j]); }
  for (let i = 0; i < NY; i++) { W.push([i, 0]); E.push([i, NX - 1]); }
  addStrip(S, [0, 0, 1]);
  addStrip(Nn, [0, 0, -1]);
  addStrip(W, [-1, 0, 0]);
  addStrip(E, [1, 0, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aUvT', new THREE.Float32BufferAttribute(uvt, 2));
  g.setAttribute('aTop', new THREE.Float32BufferAttribute(top, 1));
  g.setAttribute('aN', new THREE.Float32BufferAttribute(nOut, 3));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setIndex(idx);
  return g;
}

let cap = null;

export function createSkirts() {
  const skirtGeo = buildSkirt();

  // sediment strata sides
  const strataMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uBaseM: { value: BASE_M } },
    side: THREE.DoubleSide,
    ...program('strata'),
  });
  const strataMesh = new THREE.Mesh(skirtGeo, strataMat);
  strataMesh.frustumCulled = false;
  scene.add(strataMesh);

  // translucent water side walls
  const waterSkirtMat = new THREE.ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    ...program('water-skirt'),
  });
  const waterSkirt = new THREE.Mesh(skirtGeo, waterSkirtMat);
  waterSkirt.renderOrder = 2;
  waterSkirt.frustumCulled = false;
  scene.add(waterSkirt);

  // bottom cap
  const capMat = new THREE.MeshBasicMaterial({ color: 0x17130f });
  cap = new THREE.Mesh(new THREE.PlaneGeometry(EXT_X, EXT_Z), capMat);
  cap.rotateX(Math.PI / 2);
  cap.position.y = BASE_M * U.uHS.value;
  scene.add(cap);
}

/** Keep the bottom cap at the block's base when the exaggeration changes. */
export function syncCapHeight() {
  cap.position.y = BASE_M * U.uHS.value;
}
