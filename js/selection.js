// Map picking and the point / transect / area selection tools.
//
// PICKING. The old readout intersected a fixed plane at y = 0 and read the cell
// underneath. That is only correct when the terrain is flat. The scene displaces
// every vertex by height x uHS, and at the default 200x exaggeration a +12 m
// dune sits 2.4 world units above that plane while a -44 m channel sits 8.8
// below it — so under an oblique camera the plane hit lands on a different cell
// than the pixel you are pointing at, by several kilometres near the horizon.
//
// Rather than GPU-picking (a render target read per mouse move) this walks the
// ray onto the surface: intersect the flat plane, look up the surface height
// there, re-intersect at that height, repeat. Two or three passes converge for
// any camera angle a user can reach, because the surface is single-valued in y
// and the height field is smooth relative to the grid. Non-convergence at a
// grazing angle falls back to the last iterate, which is no worse than the old
// behaviour.

import * as THREE from 'three';
import { SELECTION_COLORS } from './colormaps.js';

const MAX_ITER = 4;
const NAME_MAX = 60;

const defaultName = (type, n) => `${type[0].toUpperCase()}${type.slice(1)} ${n}`;

export class Selections {
  /**
   * @param ctx {{scene,camera,controls,renderer,NX,NY,N,EXT_X,EXT_Z,terrain,
   *              masks,U,levelAtCell:(k:number)=>number}}
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.onChange = opts.onChange || (() => {});
    this.list = [];
    this.tool = null;
    this.draft = null;           // vertices of the selection being drawn
    this._uid = 0;
    this._ray = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();
    this._ndc = new THREE.Vector2();

    this.group = new THREE.Group();
    this.group.renderOrder = 6;
    ctx.scene.add(this.group);
    this._meshes = new Map();    // id -> THREE.LineSegments
    this._draftMesh = this._makeMesh('#ffffff');
    this._draftMesh.visible = false;
    this.group.add(this._draftMesh);

    this._wire();
  }

  // ------------------------------------------------------------- picking
  /** Screen position -> grid cell, or null if the ray misses the domain. */
  pick(clientX, clientY) {
    const { camera, renderer, EXT_X, EXT_Z, NX, NY, U } = this.ctx;
    const r = renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    this._ndc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    );
    this._ray.setFromCamera(this._ndc, camera);

    let fi = null, fj = null, y = 0;
    for (let it = 0; it < MAX_ITER; it++) {
      this._plane.constant = -y;                       // plane at height y
      if (!this._ray.ray.intersectPlane(this._plane, this._hit)) return null;
      const nj = (this._hit.x / EXT_X + 0.5) * (NX - 1);
      const ni = (-this._hit.z / EXT_Z + 0.5) * (NY - 1);
      const moved = fi === null ? Infinity : Math.hypot(ni - fi, nj - fj);
      fi = ni; fj = nj;
      if (fi < -1 || fi > NY || fj < -1 || fj > NX) return null;
      const yNext = this._surfaceY(fi, fj) * U.uHS.value;
      if (moved < 0.05) { y = yNext; break; }          // settled on a cell
      y = yNext;
    }
    const i = Math.min(Math.max(Math.round(fi), 0), NY - 1);
    const j = Math.min(Math.max(Math.round(fj), 0), NX - 1);
    if (fi < -0.5 || fi > NY - 0.5 || fj < -0.5 || fj > NX - 0.5) return null;
    return { fi, fj, i, j, k: i * NX + j };
  }

  /** Height in metres of whatever is drawn at this cell: the water sheet where
   *  wet, the bed where dry. Matches what the eye is actually pointing at. */
  _surfaceY(fi, fj) {
    const { NX, NY, terrain, levelAtCell } = this.ctx;
    const i = Math.min(Math.max(Math.round(fi), 0), NY - 1);
    const j = Math.min(Math.max(Math.round(fj), 0), NX - 1);
    const k = i * NX + j;
    return Math.max(terrain[k], levelAtCell(k));
  }

  // ------------------------------------------------------------- tooling
  setTool(name) {
    this.tool = name || null;
    this.draft = null;
    this._draftMesh.visible = false;
    document.getElementById('view').classList.toggle('picking', !!this.tool);
    this.onChange();
  }

  cancel() {
    if (!this.draft) { this.setTool(null); return; }
    this.draft = null;
    this._draftMesh.visible = false;
    this.onChange();
  }

  _wire() {
    const el = this.ctx.renderer.domElement;
    let down = null, rect = null;

    el.addEventListener('pointerdown', (e) => {
      if (!this.tool || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      // shift-drag draws a rectangle; the camera must hold still while it does
      if (this.tool === 'area' && e.shiftKey) {
        const p = this.pick(e.clientX, e.clientY);
        if (p) {
          rect = { a: p, b: p, pointerId: e.pointerId };
          this.ctx.controls.enabled = false;
          // capture, so releasing outside the canvas still ends the drag —
          // without it the camera would stay frozen with no way to recover
          try { el.setPointerCapture(e.pointerId); } catch { /* already gone */ }
        }
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (rect) {
        const p = this.pick(e.clientX, e.clientY);
        if (p) { rect.b = p; this._drawDraft(rectPts(rect), true); }
        return;
      }
      if (this.draft && this.tool) {
        const p = this.pick(e.clientX, e.clientY);
        if (p) this._drawDraft([...this.draft, [p.fi, p.fj]], this.tool === 'area');
      }
    });

    const endRect = (e, commit) => {
      this.ctx.controls.enabled = true;
      try { el.releasePointerCapture(rect.pointerId); } catch { /* already released */ }
      const pts = rectPts(rect);
      rect = null;
      down = null;
      this._draftMesh.visible = false;
      // reject a stray click that never became a drag
      if (commit && Math.hypot(pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]) > 0.7) {
        this.commit('area', pts);
      }
    };

    el.addEventListener('pointerup', (e) => {
      if (rect) { endRect(e, true); return; }
      if (!down || !this.tool) { down = null; return; }
      // distinguish a click from an orbit drag: OrbitControls owns the same
      // button, so only a near-stationary press counts as placing a vertex
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const held = performance.now() - down.t;
      down = null;
      if (moved > 4 || held > 700) return;
      const p = this.pick(e.clientX, e.clientY);
      if (!p) return;
      if (this.tool === 'point') { this.commit('point', [[p.fi, p.fj]]); return; }
      this.draft = [...(this.draft || []), [p.fi, p.fj]];
      this._drawDraft(this.draft, this.tool === 'area');
      this.onChange();
    });

    // a cancelled pointer (browser gesture, window blur, touch interruption)
    // must also unfreeze the camera
    el.addEventListener('pointercancel', (e) => { if (rect) endRect(e, false); });

    el.addEventListener('dblclick', () => this.finish());

    addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.code === 'Escape') this.cancel();
      else if (e.code === 'Enter') this.finish();
    });
  }

  /** Close the in-progress transect/area. */
  finish() {
    if (!this.draft || !this.tool) return;
    const need = this.tool === 'area' ? 3 : 2;
    if (this.draft.length >= need) this.commit(this.tool, this.draft);
    this.draft = null;
    this._draftMesh.visible = false;
    this.onChange();
  }

  commit(type, pts, name) {
    const n = this._freeNum(type);
    const sel = {
      id: `${type}-${Date.now().toString(36)}-${++this._uid}`,
      type,
      pts: pts.map(([i, j]) => [i, j]),
      num: n,
      name: (name && String(name).trim().slice(0, NAME_MAX)) || defaultName(type, n),
      color: this._freeColor(),
      visible: true,
    };
    this.list.push(sel);
    this._meshes.set(sel.id, this._addMesh(sel.color));
    this.draft = null;
    this._draftMesh.visible = false;
    // a point is a one-click action; transects and areas stay armed for another
    if (type === 'point') this.setTool(null);
    this.onChange(sel);
    return sel;
  }

  /** Lowest number of this type that no live selection holds.
   *
   *  Numbering describes what is on the map, not how many were ever drawn: a
   *  monotonic counter meant that deleting Point 1 and clicking again gave
   *  Point 2 with no Point 1 anywhere, and clearing the list did not reset it.
   *  A number is reserved for as long as its selection exists — including one
   *  the user has renamed — so a default name can never collide with a live one.
   */
  _freeNum(type) {
    const used = new Set(this.list.filter((s) => s.type === type).map((s) => s.num));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  /** Likewise for the palette: a freed colour comes back before the cycle
   *  wraps, so two live selections never share one while a slot is going spare. */
  _freeColor() {
    const used = new Set(this.list.map((s) => s.color));
    return SELECTION_COLORS.find((c) => !used.has(c))
      || SELECTION_COLORS[this.list.length % SELECTION_COLORS.length];
  }

  /** Give a selection a user-chosen label — a station code, say, rather than
   *  "Point 3". Blank restores the default, so a rename is always undoable
   *  without deleting and re-placing the geometry. */
  rename(id, name) {
    const s = this.list.find((x) => x.id === id);
    if (!s) return null;
    const v = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
    s.name = v || defaultName(s.type, s.num);
    this.onChange();
    return s;
  }

  remove(id) {
    const i = this.list.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.list.splice(i, 1);
    const m = this._meshes.get(id);
    if (m) { this.group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this._meshes.delete(id);
    this.onChange();
  }

  clear() {
    for (const s of [...this.list]) this.remove(s.id);
    this.cancel();
  }

  toggle(id) {
    const s = this.list.find((x) => x.id === id);
    if (!s) return;
    s.visible = !s.visible;
    this.onChange();
  }

  get active() { return this.list.filter((s) => s.visible); }
  get transect() { return this.active.find((s) => s.type === 'transect') || null; }

  // ------------------------------------------------------------ geometry
  _makeMesh(color) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4096), 3)
      .setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      // selections must stay readable through the translucent water sheet
      depthTest: false, transparent: true, opacity: 0.95,
    });
    const m = new THREE.LineSegments(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = 7;
    return m;
  }

  _addMesh(color) {
    const m = this._makeMesh(color);
    this.group.add(m);
    return m;
  }

  _wx(fj) { return (fj / (this.ctx.NX - 1) - 0.5) * this.ctx.EXT_X; }
  _wz(fi) { return -(fi / (this.ctx.NY - 1) - 0.5) * this.ctx.EXT_Z; }
  _wy(fi, fj) { return this._surfaceY(fi, fj) * this.ctx.U.uHS.value + 0.05; }

  /** Rebuild all selection geometry against the current timestep and
   *  exaggeration. Cheap — a few hundred vertices — so it runs every frame and
   *  markers never lag the surface they sit on. */
  update() {
    for (const sel of this.list) {
      const m = this._meshes.get(sel.id);
      if (!m) continue;
      m.visible = sel.visible;
      if (sel.visible) this._fill(m, sel.pts, sel.type === 'area', sel.type === 'point');
    }
  }

  _drawDraft(pts, close) {
    this._draftMesh.visible = pts.length > 0;
    this._fill(this._draftMesh, pts, close && pts.length > 2, pts.length === 1);
  }

  /** Rewrite a selection's line geometry in place.
   *
   *  This runs every frame — the water surface these lines ride on moves
   *  continuously as the timestep interpolates, so rebuilding only on whole
   *  steps makes the markers visibly snap. It therefore writes straight into
   *  the buffer with no Vector3 or intermediate array: at 60 fps even a few
   *  hundred temporary objects per frame is enough garbage to show as stutter.
   */
  _fill(mesh, pts, close, pin) {
    const attr = mesh.geometry.attributes.position;
    const buf = attr.array;
    const cap = attr.count * 3;
    let n = 0;
    const vtx = (fi, fj, dy) => {
      if (n + 3 > cap) return;
      buf[n++] = this._wx(fj);
      buf[n++] = this._wy(fi, fj) + (dy || 0);
      buf[n++] = this._wz(fi);
    };
    const seg = (i0, j0, i1, j1) => {
      // subdivide so the line follows the surface instead of cutting through it
      const steps = Math.max(1, Math.ceil(Math.hypot(i1 - i0, j1 - j0)));
      for (let s = 0; s < steps; s++) {
        const f0 = s / steps, f1 = (s + 1) / steps;
        vtx(i0 + (i1 - i0) * f0, j0 + (j1 - j0) * f0, 0);
        vtx(i0 + (i1 - i0) * f1, j0 + (j1 - j0) * f1, 0);
      }
    };

    const S = Math.max(this.ctx.EXT_X, this.ctx.EXT_Z);
    if (pin || pts.length === 1) {
      // a cross and a stem, so a single cell is visible from any angle. The
      // arms are sized in GRID steps so they stay square in world space even
      // when the domain is not.
      const [fi, fj] = pts[0];
      const dj = (0.006 * S) / (this.ctx.EXT_X / (this.ctx.NX - 1));
      const di = (0.006 * S) / (this.ctx.EXT_Z / (this.ctx.NY - 1));
      vtx(fi, fj - dj, 0); vtx(fi, fj + dj, 0);
      vtx(fi - di, fj, 0); vtx(fi + di, fj, 0);
      vtx(fi, fj, 0); vtx(fi, fj, 0.024 * S);
    } else {
      for (let k = 0; k < pts.length - 1; k++) {
        seg(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]);
      }
      if (close && pts.length > 2) {
        const a = pts[pts.length - 1], b = pts[0];
        seg(a[0], a[1], b[0], b[1]);
      }
      // a short stem at each vertex, so the clicked points stay identifiable
      for (const [fi, fj] of pts) { vtx(fi, fj, 0); vtx(fi, fj, 0.012 * S); }
    }

    attr.addUpdateRange(0, n);
    attr.needsUpdate = true;
    mesh.geometry.setDrawRange(0, n / 3);
  }
}

function rectPts(rect) {
  const { a, b } = rect;
  return [[a.fi, a.fj], [a.fi, b.fj], [b.fi, b.fj], [b.fi, a.fj]];
}
