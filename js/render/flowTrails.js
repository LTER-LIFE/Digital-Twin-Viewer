// Current flow: the decoded velocity field, and particles advected through it,
// each drawn as a short fading streak.
//
// Speed is encoded three ways at once so it reads instantly: how fast the
// streak moves, how long it is, and its colour.

import * as THREE from 'three';

import { meta, NX, NY, N, EXT_X, EXT_Z, FLOW, terrain, masks, flowU8 } from '../core/dataset.js';
import { U, fA, fB } from './fields.js';
import { scene, SC } from './viewport.js';
import { program } from './shaderLib.js';

// ---------------------------------------------------------------- flow field
// Velocity components as written by the pipeline: sqrt-coded uint8 about 128,
// lying along the GRID axes — u along +column, v along +row. The scene is drawn
// in grid space too (column -> +X, row -> -Z), so they need no rotation here.
const FLOW_SCALE = FLOW ? FLOW.scale : 1;
// decoded (u, v) in m/s for the two bracketing days; advection lerps them by uMix
const flowA = FLOW && flowU8 ? new Float32Array(N * 2) : null;
const flowB = FLOW && flowU8 ? new Float32Array(N * 2) : null;
let flowDayA = -1;
function loadFlowFrame(arr, day) {
  const off = day * N * 2;
  for (let i = 0; i < N * 2; i++) {
    const s = (flowU8[off + i] - 128) / 127;
    arr[i] = (s < 0 ? -s * s : s * s) * FLOW_SCALE;   // undo the sqrt coding
  }
}
/** Decode the velocity of the two steps either side of the current time. */
export function setFlowFrames(d0, d1) {
  if (!flowA || d0 === flowDayA) return;
  const nf = FLOW.nFrames;
  loadFlowFrame(flowA, Math.min(d0, nf - 1));
  loadFlowFrame(flowB, Math.min(d1, nf - 1));
  flowDayA = d0;
}

// ---------------------------------------------------------------- flow trails
/** The particle system, or null when the dataset has no velocity field.
 *  Assigned by createFlowTrails(). */
export let flow = null;

export function createFlowTrails() {
  if (!flowA) return null;

  const TRAIL = 8;                       // points per trail
  const SEGS = TRAIL - 1;
  const MAX_P = 40000;
  // A trail point is committed on a fixed time interval, not per rendered frame,
  // so a streak always spans TRAIL_SPAN seconds of animation. Its length on
  // screen is then speed x time — which is exactly the magnitude cue we want:
  // slack water draws short dashes, the tidal jets draw long streaks.
  const TRAIL_SPAN = 1.2;
  const TRAIL_DT = TRAIL_SPAN / SEGS;
  let count = 14000;                     // live particles (density slider)
  // seconds of model time per second of wall clock. Real-time advection would be
  // imperceptible: 0.3 m/s across a 168 km domain is ~0.002 cells per frame.
  let speedMul = 3600;                   // 1 h/s
  let enabled = true;

  const CELL_M = (meta.cellKm || 0.5) * 1000;
  // per-particle state, in fractional grid indices
  const pFi = new Float32Array(MAX_P), pFj = new Float32Array(MAX_P);
  const pAge = new Float32Array(MAX_P), pLife = new Float32Array(MAX_P);
  const pSpd = new Float32Array(MAX_P), pTimer = new Float32Array(MAX_P);
  const trail = new Float32Array(MAX_P * TRAIL * 3);   // ring buffer of world pos
  const tHead = new Uint8Array(MAX_P);
  const tFill = new Uint8Array(MAX_P);                 // how many points are valid

  // geometry: SEGS line segments per particle, 2 verts each, non-indexed
  const VPP = SEGS * 2;
  const pos = new Float32Array(MAX_P * VPP * 3);
  const fade = new Float32Array(MAX_P * VPP);
  const spd = new Float32Array(MAX_P * VPP);
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aFade', new THREE.BufferAttribute(fade, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(spd, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), SC * 4);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 1.0 },
      // the ramp saturates well below the domain peak: the top speeds are a
      // handful of cells in the inlets, and keying to them leaves the flow
      // everyone actually looks at sitting in the bottom fifth of the scale
      uMaxSpeed: { value: Math.max(0.05, (FLOW.maxSpeed || 1) * 0.22) },
      uFogColor: U.uFogColor, uFogRange: U.uFogRange,
    },
    transparent: true, depthWrite: false, depthTest: true,
    ...program('flow-trails'),
  });
  const mesh = new THREE.LineSegments(geo, mat);
  mesh.renderOrder = 4;                  // above the water sheet (3)
  mesh.frustumCulled = false;
  scene.add(mesh);

  const wx = (fj) => (fj / (NX - 1) - 0.5) * EXT_X;
  const wz = (fi) => -(fi / (NY - 1) - 0.5) * EXT_Z;

  // bilinear sample of the time-interpolated velocity, in m/s
  const vel = [0, 0];
  function sampleVel(fi, fj, mix) {
    const i0 = Math.min(Math.max(Math.floor(fi), 0), NY - 1);
    const j0 = Math.min(Math.max(Math.floor(fj), 0), NX - 1);
    const i1 = Math.min(i0 + 1, NY - 1), j1 = Math.min(j0 + 1, NX - 1);
    const ti = Math.min(Math.max(fi - i0, 0), 1), tj = Math.min(Math.max(fj - j0, 0), 1);
    const k00 = (i0 * NX + j0) * 2, k01 = (i0 * NX + j1) * 2;
    const k10 = (i1 * NX + j0) * 2, k11 = (i1 * NX + j1) * 2;
    for (let c = 0; c < 2; c++) {
      const a = (flowA[k00 + c] * (1 - tj) + flowA[k01 + c] * tj) * (1 - ti) +
                (flowA[k10 + c] * (1 - tj) + flowA[k11 + c] * tj) * ti;
      const b = (flowB[k00 + c] * (1 - tj) + flowB[k01 + c] * tj) * (1 - ti) +
                (flowB[k10 + c] * (1 - tj) + flowB[k11 + c] * tj) * ti;
      vel[c] = a * (1 - mix) + b * mix;
    }
    return vel;
  }
  // water depth at a cell, matching the water shader's own dry test
  function depthAt(i, j, mix) {
    const k = i * NX + j;
    return (fA[k] * (1 - mix) + fB[k] * mix) - terrain[k];
  }
  function levelAt(i, j, mix) {
    const k = i * NX + j;
    return fA[k] * (1 - mix) + fB[k] * mix;
  }

  function respawn(p, mix) {
    // rejection-sample a wet cell; give up after a few tries and park it dead
    for (let n = 0; n < 24; n++) {
      const fi = Math.random() * (NY - 1), fj = Math.random() * (NX - 1);
      const i = Math.round(fi), j = Math.round(fj);
      if ((masks[i * NX + j] & 1) === 0 && depthAt(i, j, mix) > 0.05) {
        pFi[p] = fi; pFj[p] = fj;
        pAge[p] = 0; pLife[p] = 3.0 + Math.random() * 5.0;
        tFill[p] = 0; tHead[p] = 0; pSpd[p] = 0; pTimer[p] = 0;
        return true;
      }
    }
    pAge[p] = 1e9; pLife[p] = 0;
    return false;
  }

  function reseed() {
    const mix = U.uMix.value;
    for (let p = 0; p < MAX_P; p++) {
      respawn(p, mix);
      pAge[p] = Math.random() * pLife[p];   // stagger so respawns don't pulse
    }
  }

  function update(dt) {
    if (!enabled) { geo.setDrawRange(0, 0); return; }
    const mix = U.uMix.value;
    const hs = U.uHS.value;
    const stepScale = (dt * speedMul) / CELL_M;   // m/s -> grid cells this frame
    let vtx = 0;

    for (let p = 0; p < count; p++) {
      pAge[p] += dt;
      let fi = pFi[p], fj = pFj[p];
      const i = Math.round(fi), j = Math.round(fj);
      const dead = pAge[p] > pLife[p] ||
        fi < 0 || fi > NY - 1 || fj < 0 || fj > NX - 1 ||
        (masks[i * NX + j] & 1) !== 0 || depthAt(i, j, mix) <= 0.004;
      if (dead) { if (!respawn(p, mix)) continue; fi = pFi[p]; fj = pFj[p]; }

      const uv = sampleVel(fi, fj, mix);
      // u runs along +column (+X), v along +row (which the scene draws as -Z)
      fj += uv[0] * stepScale;
      fi += uv[1] * stepScale;
      pFi[p] = fi; pFj[p] = fj;
      pSpd[p] = Math.hypot(uv[0], uv[1]);

      const ci = Math.min(Math.max(Math.round(fi), 0), NY - 1);
      const cj = Math.min(Math.max(Math.round(fj), 0), NX - 1);
      // ride just above the water sheet (which sits at level*uHS + 0.015)
      const y = levelAt(ci, cj, mix) * hs + 0.028;

      // the head slot always tracks the live position so the leading segment is
      // smooth; a new slot is only committed every TRAIL_DT
      let h = tHead[p];
      const px = wx(fj), pz = wz(fi);
      if (tFill[p] === 0) { tFill[p] = 1; }
      pTimer[p] += dt;
      if (pTimer[p] >= TRAIL_DT) {
        pTimer[p] -= TRAIL_DT;
        h = (h + 1) % TRAIL;
        tHead[p] = h;
        if (tFill[p] < TRAIL) tFill[p]++;
      }
      const base = p * TRAIL * 3 + h * 3;
      trail[base] = px; trail[base + 1] = y; trail[base + 2] = pz;

      // emit the trail as segments, newest first, fading toward the tail
      const nfill = tFill[p];
      if (nfill < 2) continue;
      const sp = pSpd[p];
      for (let s = 0; s < nfill - 1; s++) {
        const iA = (h - s + TRAIL) % TRAIL;
        const iB = (h - s - 1 + TRAIL) % TRAIL;
        const aOff = p * TRAIL * 3 + iA * 3, bOff = p * TRAIL * 3 + iB * 3;
        const f0 = 1 - s / SEGS, f1 = 1 - (s + 1) / SEGS;
        pos[vtx * 3] = trail[aOff]; pos[vtx * 3 + 1] = trail[aOff + 1]; pos[vtx * 3 + 2] = trail[aOff + 2];
        fade[vtx] = f0; spd[vtx] = sp; vtx++;
        pos[vtx * 3] = trail[bOff]; pos[vtx * 3 + 1] = trail[bOff + 1]; pos[vtx * 3 + 2] = trail[bOff + 2];
        fade[vtx] = f1; spd[vtx] = sp; vtx++;
      }
    }
    geo.setDrawRange(0, vtx);
    if (vtx) {
      posAttr.addUpdateRange(0, vtx * 3);
      geo.attributes.aFade.addUpdateRange(0, vtx);
      geo.attributes.aSpeed.addUpdateRange(0, vtx);
      posAttr.needsUpdate = true;
      geo.attributes.aFade.needsUpdate = true;
      geo.attributes.aSpeed.needsUpdate = true;
    }
  }

  flow = {
    update, reseed, mesh,
    get enabled() { return enabled; },
    setEnabled(v) { enabled = v; mesh.visible = v; if (v) reseed(); },
    setCount(v) { count = Math.min(Math.max(1, v | 0), MAX_P); },
    setSpeedMul(v) { speedMul = v; },
    get count() { return count; },
  };
  return flow;
}
