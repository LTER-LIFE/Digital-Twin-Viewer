// Observation markers on the map: rings on stems for stations, diamonds for
// casts, dots for survey samples. Drawn over the water like the selections, so
// a station on a channel bed is not hidden by it.
//
// This module only draws and picks. WHAT is drawn comes from the caller's
// collect(), which returns items {k, kind, ref, coll, color, shape, size, stem?}.

import * as THREE from 'three';

import { NX, NY, EXT_X, EXT_Z, terrain } from '../core/dataset.js';
import { stepIndex, levelAtCell } from '../features/time.js';
import { U } from './fields.js';
import { scene, camera, renderer } from './viewport.js';
import { program } from './shaderLib.js';

/**
 * @param {{collect: () => object[], onRebuild: (items: object[]) => void}} opts
 */
export function createObsMarkers({ collect, onRebuild }) {
  const MAX = 30000, MAX_STEM = 2000;
  const pos = new Float32Array(MAX * 3), col = new Float32Array(MAX * 3);
  const shp = new Float32Array(MAX), siz = new Float32Array(MAX);
  const attr = (a, n) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', attr(pos, 3));
  geo.setAttribute('color', attr(col, 3));
  geo.setAttribute('shape', attr(shp, 1));
  geo.setAttribute('size', attr(siz, 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uDpr: { value: renderer.getPixelRatio() } },
    ...program('obs-markers'),
    transparent: true, depthTest: false, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 9;
  scene.add(points);

  const stemPos = new Float32Array(MAX_STEM * 6);
  const stemGeo = new THREE.BufferGeometry();
  stemGeo.setAttribute('position', attr(stemPos, 3));
  stemGeo.setDrawRange(0, 0);
  stemGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const stems = new THREE.LineSegments(stemGeo, new THREE.LineBasicMaterial({
    color: 0xe8f4fa, transparent: true, opacity: 0.55, depthTest: false }));
  stems.frustumCulled = false;
  stems.renderOrder = 8;
  scene.add(stems);

  const S = Math.max(EXT_X, EXT_Z);
  const wx = (j) => (j / (NX - 1) - 0.5) * EXT_X;
  const wz = (i) => -(i / (NY - 1) - 0.5) * EXT_Z;
  let items = [], lastStep = -1, dirty = true;

  function rebuild() {
    items = collect().slice(0, MAX);
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      col[3 * n] = it.color[0]; col[3 * n + 1] = it.color[1]; col[3 * n + 2] = it.color[2];
      shp[n] = it.shape; siz[n] = it.size;
    }
    geo.attributes.color.needsUpdate = true;
    geo.attributes.shape.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    geo.setDrawRange(0, items.length);
    onRebuild(items);
    dirty = false;
  }

  /** Positions ride the surface every frame, like the selection markers. */
  function update() {
    const step = stepIndex();
    if (dirty || step !== lastStep) { lastStep = step; rebuild(); }
    const hs = U.uHS.value;
    let ns = 0;
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const k = it.k, i = Math.floor(k / NX), j = k % NX;
      const y0 = Math.max(terrain[k], levelAtCell(k)) * hs;
      const lift = it.stem ? 0.016 * S : 0.002 * S;
      pos[3 * n] = wx(j); pos[3 * n + 1] = y0 + lift; pos[3 * n + 2] = wz(i);
      if (it.stem && ns < MAX_STEM) {
        const o = 6 * ns++;
        stemPos[o] = stemPos[o + 3] = wx(j);
        stemPos[o + 1] = y0; stemPos[o + 4] = y0 + lift;
        stemPos[o + 2] = stemPos[o + 5] = wz(i);
      }
    }
    geo.attributes.position.needsUpdate = true;
    stemGeo.attributes.position.needsUpdate = true;
    stemGeo.setDrawRange(0, ns * 2);
    points.visible = stems.visible = items.length > 0;
  }

  const v3 = new THREE.Vector3();
  /** The marker under the pointer, within 9 px; a station wins a near tie. */
  function pick(cx, cy) {
    if (!items.length) return null;
    const r = renderer.domElement.getBoundingClientRect();
    let best = null, bd = 81;
    for (let n = 0; n < items.length; n++) {
      v3.set(pos[3 * n], pos[3 * n + 1], pos[3 * n + 2]).project(camera);
      if (v3.z > 1) continue;
      const x = r.left + ((v3.x + 1) / 2) * r.width, y = r.top + ((1 - v3.y) / 2) * r.height;
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      const win = d < bd || (best && best.kind !== 'station' && items[n].kind === 'station' && d < bd + 40);
      if (win) { bd = d; best = items[n]; }
    }
    return best;
  }
  return { update, pick, invalidate() { dirty = true; }, get items() { return items; } };
}
