// three.js viewport: parts, selection, transform gizmo, hole markers, arrows, callouts, snapshots.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { TransformControls } from 'three/addons/TransformControls.js';

const Z_UP = new THREE.Vector3(0, 0, 1);
THREE.Object3D.DEFAULT_UP.copy(Z_UP);

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay';
    container.appendChild(this.overlay);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#eef1f5');
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 20000);
    this.camera.up.copy(Z_UP);
    this.camera.position.set(250, -300, 220);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, -1.5, 2);
    this.camera.add(key); // light follows camera so every view is lit
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-2, 1, 0.5);
    this.camera.add(fill);
    this.scene.add(this.camera);

    this.grid = new THREE.GridHelper(400, 40, 0x99a3ad, 0xcfd5dc);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(30);
    this.scene.add(this.axes);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.meshes = new Map(); // partId -> mesh
    this.geomCache = new Map(); // geomKey -> {geometry, edges}

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = false;
    this.orbit.addEventListener('change', () => this.dirty());
    this.orbit.addEventListener('end', () => this.emit('camera', this.getCamera()));

    this.pivot = new THREE.Object3D();
    this.scene.add(this.pivot);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this._dragStart(); else this._dragEnd();
    });
    this.gizmo.addEventListener('objectChange', () => this._dragMove());
    this.gizmo.addEventListener('change', () => this.dirty());
    this.scene.add(this.gizmo);

    this.selection = []; // partIds
    this.mode = 'select';
    this.highlightColor = '#1c7ed6';
    this.explodeOffsets = new Map();
    this.step = null;
    this.project = null;

    this.raycaster = new THREE.Raycaster();
    this._bindPointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { if (this._dirty) { this._dirty = false; this._render(); } requestAnimationFrame(loop); };
    loop();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  dirty() { this._dirty = true; }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.overlay.width = w * devicePixelRatio;
    this.overlay.height = h * devicePixelRatio;
    this.overlay.style.width = w + 'px';
    this.overlay.style.height = h + 'px';
    this.camera.aspect = w / h;
    this._updateFov();
    this.dirty();
  }

  /** The picture frame (export aspect) is the part of the viewport that ends up in the guide.
   *  The step camera's fov is defined for that frame; the editor widens its fov to show the frame whole. */
  setFrameAspect(a) { this.frameAspect = a || 1.6; this._updateFov(); this.dirty(); }
  _updateFov() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const fa = this.frameAspect || 1.6, base = this.baseFov || 30;
    const va = w / h;
    const fh = va >= fa ? h : w / fa;
    this._frame = { w: fh * fa, h: fh, x: (w - fh * fa) / 2, y: (h - fh) / 2 };
    this.camera.fov = (2 * Math.atan(Math.tan((base * Math.PI) / 360) * (h / fh)) * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  _render() {
    this.renderer.render(this.scene, this.camera);
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const W = this.container.clientWidth, H = this.container.clientHeight;
    this._labelRects = this.drawCallouts(ctx, this.camera, W, H, 1);
    const f = this._frame;
    if (f && this.showFrame !== false) {
      ctx.fillStyle = 'rgba(30,40,50,0.10)';
      ctx.fillRect(0, 0, W, f.y); ctx.fillRect(0, f.y + f.h, W, H - f.y - f.h);
      ctx.fillRect(0, f.y, f.x, f.h); ctx.fillRect(f.x + f.w, f.y, W - f.x - f.w, f.h);
      ctx.strokeStyle = 'rgba(28,126,214,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([6, 4]);
      ctx.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1); ctx.setLineDash([]);
    }
  }

  // ------------------------------------------------------------------ parts
  _geom(key, positions) {
    let g = this.geomCache.get(key);
    if (!g) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const edges = new THREE.EdgesGeometry(geometry, 28);
      g = { geometry, edges };
      this.geomCache.set(key, g);
    }
    return g;
  }

  /** Make the scene match project.parts (create / delete meshes, refresh hole markers). */
  syncParts(project, geomStore) {
    this.project = project;
    const ids = new Set(project.parts.map((p) => p.id));
    for (const [id, m] of this.meshes) if (!ids.has(id)) { this.root.remove(m); this.meshes.delete(id); }
    for (const part of project.parts) {
      let m = this.meshes.get(part.id);
      if (!m) {
        const g = this._geom(part.geom, geomStore.get(part.geom));
        const mat = new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.65, metalness: 0.05, flatShading: false,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
        m = new THREE.Mesh(g.geometry, mat);
        m.userData.partId = part.id;
        const lines = new THREE.LineSegments(g.edges, new THREE.LineBasicMaterial({ color: 0x1d232a, transparent: true, opacity: 0.55 }));
        lines.userData.isEdges = true;
        lines.raycast = () => {};
        m.add(lines);
        m.userData.edges = lines;
        const hg = new THREE.Group();
        m.add(hg);
        m.userData.holeGroup = hg;
        const ag = new THREE.Group();
        m.add(ag);
        m.userData.arrowGroup = ag;
        this.root.add(m);
        this.meshes.set(part.id, m);
      }
      m.material.color.set(part.color);
      this._buildHoleMarkers(part, m);
    }
    this.dirty();
  }

  _buildHoleMarkers(part, mesh) {
    const hg = mesh.userData.holeGroup;
    hg.clear();
    const types = new Map((this.project.holeTypes || []).map((t) => [t.id, t]));
    for (const h of part.holes || []) {
      const t = types.get(h.type);
      if (h.hidden || (t && t.hidden) || !h.type) continue;
      const color = new THREE.Color(t ? t.color : '#868e96');
      const r = (h.shape === 'hex' ? h.d / Math.cos(Math.PI / 6) : h.d) / 2;
      const g = new THREE.Group();
      g.userData = { partId: part.id, holeId: h.id };
      const a = new THREE.Vector3(...h.a).normalize();
      const torus = new THREE.Mesh(new THREE.TorusGeometry(r * 1.08, Math.max(0.18, r * 0.12), 8, h.shape === 'hex' ? 6 : 40),
        new THREE.MeshBasicMaterial({ color }));
      if (h.shape === 'hex') torus.rotation.z = Math.PI / 6;
      const depth = h.depth || r * 2;
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r * 0.9, depth, h.shape === 'hex' ? 6 : 24, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      cyl.rotation.x = Math.PI / 2; // cylinder Y axis -> Z
      cyl.position.z = -depth / 2;
      torus.position.z = 0.05;
      const orient = new THREE.Group();
      orient.add(torus, cyl);
      orient.quaternion.setFromUnitVectors(Z_UP, a);
      orient.position.set(...h.c);
      for (const o of [torus, cyl]) o.userData = g.userData;
      g.add(orient);
      if (this.selectedHole && this.selectedHole.partId === part.id && this.selectedHole.holeId === h.id) {
        const sel = new THREE.Mesh(new THREE.TorusGeometry(r * 1.5, Math.max(0.25, r * 0.12), 8, 40), new THREE.MeshBasicMaterial({ color: 0xff00aa }));
        sel.userData.selRing = true;
        orient.add(sel);
      }
      hg.add(g);
    }
    this.dirty();
  }

  refreshHoles(partId) {
    const part = this.project.parts.find((p) => p.id === partId);
    const m = this.meshes.get(partId);
    if (part && m) this._buildHoleMarkers(part, m);
  }
  refreshAllHoles() { for (const p of this.project.parts) this.refreshHoles(p.id); }

  // ------------------------------------------------------------------ step state
  applyStep(step, { keepCamera = false, newIds = null } = {}) {
    this.step = step;
    if (newIds) this._newIds = newIds;
    const auto = this._newIds || new Set();
    const ps = step.parts;
    // explode offsets around the centroid of visible parts
    this.explodeOffsets.clear();
    const vis = Object.entries(ps).filter(([id, s]) => s.v && this.meshes.has(id));
    if (step.explode && vis.length > 1) {
      const c = new THREE.Vector3();
      vis.forEach(([, s]) => c.add(new THREE.Vector3(...s.p)));
      c.divideScalar(vis.length);
      for (const [id, s] of vis) this.explodeOffsets.set(id, new THREE.Vector3(...s.p).sub(c).multiplyScalar(step.explode));
    }
    for (const [id, m] of this.meshes) {
      const s = ps[id];
      if (!s || !s.v) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(...s.p).add(this.explodeOffsets.get(id) || new THREE.Vector3());
      m.quaternion.set(...s.q);
      m.userData.look = !s.look || s.look === 'auto' ? (this.autoHighlight !== false && auto.has(id) ? 'highlight' : 'normal') : s.look;
      m.userData.holeGroup.visible = step.showHoles !== false;
    }
    this._buildArrows(step);
    const floor = new THREE.Box3();
    for (const m of this.meshes.values()) if (m.visible) { m.updateMatrixWorld(); floor.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
    this.grid.position.z = floor.isEmpty() ? 0 : Math.min(0, floor.min.z) - 0.02;
    if (!floor.isEmpty()) { // keep the grid under the parts (slicer 3MFs place objects on the plate, away from 0,0)
      const c = floor.getCenter(new THREE.Vector3());
      this.grid.position.x = Math.round(c.x / 10) * 10;
      this.grid.position.y = Math.round(c.y / 10) * 10;
    }
    this.updateLooks();
    if (!keepCamera && step.camera) this.setCamera(step.camera);
    this._attachGizmo();
    this.dirty();
  }

  updateLooks(forSnapshot = false) {
    const hl = new THREE.Color(this.highlightColor);
    for (const [id, m] of this.meshes) {
      const look = m.userData.look;
      const sel = !forSnapshot && this.selection.includes(id);
      const mat = m.material;
      const ghost = look === 'ghost';
      mat.transparent = ghost;
      mat.opacity = ghost ? 0.18 : 1;
      mat.depthWrite = !ghost;
      mat.emissive.set(sel ? '#3d8bfd' : look === 'highlight' ? hl : '#000000');
      mat.emissiveIntensity = sel ? 0.5 : look === 'highlight' ? 0.28 : 0;
      const e = m.userData.edges;
      e.visible = this.showEdges !== false;
      e.material.color.set(look === 'highlight' ? hl.clone().multiplyScalar(0.6) : new THREE.Color(0x1d232a));
      e.material.opacity = ghost ? 0.12 : look === 'highlight' ? 0.9 : 0.55;
      mat.needsUpdate = true;
    }
    this.dirty();
  }

  _buildArrows(step) {
    for (const m of this.meshes.values()) m.userData.arrowGroup.clear();
    this.worldArrows?.removeFromParent();
    this.worldArrows = new THREE.Group();
    this.root.add(this.worldArrows);
    for (const a of step.arrows || []) {
      const parent = a.partId ? this.meshes.get(a.partId)?.userData.arrowGroup : this.worldArrows;
      if (!parent) continue;
      parent.add(makeArrow(a));
    }
  }

  // ------------------------------------------------------------------ camera
  getCamera() {
    return { p: this.camera.position.toArray().map(r2), t: this.orbit.target.toArray().map(r2), fov: this.baseFov || 30 };
  }
  setCamera(c) {
    this.camera.position.set(...c.p);
    this.orbit.target.set(...c.t);
    if (c.fov) this.baseFov = c.fov;
    this._updateFov();
    this.orbit.update();
    this.dirty();
  }
  visibleBox(ids) {
    const box = new THREE.Box3();
    for (const [id, m] of this.meshes) {
      if (!m.visible || (ids && !ids.includes(id))) continue;
      if (m.userData.look === 'ghost' && !ids) continue;
      box.expandByObject(m, false);
    }
    if (box.isEmpty()) for (const m of this.meshes.values()) if (m.visible) box.expandByObject(m);
    return box;
  }
  fit(dir, ids, camera = this.camera, target = this.orbit) {
    const box = this.visibleBox(ids);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const d = dir ? new THREE.Vector3(...dir).normalize() : camera.position.clone().sub(target.target).normalize();
    const main = camera === this.camera;
    const fov = ((main ? this.baseFov || 30 : camera.fov) * Math.PI) / 180;
    const fitFov = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * (main ? this.frameAspect || 1.6 : camera.aspect)));
    const dist = (sphere.radius / Math.sin(fitFov / 2)) * 1.05;
    target.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(d, dist);
    camera.updateProjectionMatrix();
    if (target.update) target.update();
    this.dirty();
    if (camera === this.camera) this.emit('camera', this.getCamera());
  }
  view(name) {
    const dirs = { iso: [1, -1.2, 0.9], front: [0, -1, 0.0001], back: [0, 1, 0.0001], left: [-1, 0, 0.0001], right: [1, 0, 0.0001],
      top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], iso2: [-1, -1.2, 0.9] };
    this.fit(dirs[name]);
  }

  // ------------------------------------------------------------------ selection & gizmo
  setSelection(ids) {
    this.selection = ids.filter((id) => this.meshes.has(id));
    this.updateLooks();
    this._attachGizmo();
    this.emit('selection', this.selection.slice());
  }
  setGizmo(mode, space) {
    if (mode) this.gizmo.setMode(mode);
    if (space) this.gizmo.setSpace(space);
    this.dirty();
  }
  setSnap(t, r) {
    this.gizmo.setTranslationSnap(t || null);
    this.gizmo.setRotationSnap(r ? (r * Math.PI) / 180 : null);
  }
  _attachGizmo() {
    const sel = this.selection.map((id) => this.meshes.get(id)).filter((m) => m && m.visible);
    if (!sel.length || this.gizmoHidden) { this.gizmo.detach(); this.dirty(); return; }
    if (sel.length === 1) {
      this.pivot.position.copy(sel[0].position);
      this.pivot.quaternion.copy(sel[0].quaternion);
    } else {
      const c = new THREE.Vector3();
      sel.forEach((m) => c.add(m.position));
      this.pivot.position.copy(c.divideScalar(sel.length));
      this.pivot.quaternion.identity();
    }
    this.pivot.updateMatrixWorld();
    this.gizmo.attach(this.pivot);
    this.dirty();
  }
  _dragStart() {
    this._m0 = this.pivot.matrixWorld.clone().invert();
    this._starts = this.selection.map((id) => [id, this.meshes.get(id).matrixWorld.clone()]);
  }
  _dragMove() {
    if (!this._starts) return;
    this.pivot.updateMatrixWorld();
    const delta = this.pivot.matrixWorld.clone().multiply(this._m0);
    for (const [id, m0] of this._starts) {
      const m = this.meshes.get(id);
      const mm = delta.clone().multiply(m0);
      mm.decompose(m.position, m.quaternion, new THREE.Vector3());
    }
    this.dirty();
  }
  _dragEnd() {
    if (!this._starts) return;
    const ids = this._starts.map(([id]) => id);
    this._starts = null;
    this.emit('transform', ids.map((id) => this.stateOf(id)));
    this._attachGizmo();
  }
  /** Current transform of a part with the explode offset removed. */
  stateOf(id) {
    const m = this.meshes.get(id);
    const p = m.position.clone().sub(this.explodeOffsets.get(id) || new THREE.Vector3());
    return { id, p: p.toArray().map(r4), q: m.quaternion.toArray().map((x) => Math.round(x * 1e6) / 1e6) };
  }
  worldBox(id) {
    const m = this.meshes.get(id);
    m.updateMatrixWorld();
    return new THREE.Box3().setFromObject(m, true);
  }
  _bboxPrecise(m) { // vertex-precise box (edges/markers excluded)
    m.updateMatrixWorld();
    const b = new THREE.Box3();
    const pos = m.geometry.attributes.position;
    const v = new THREE.Vector3();
    const stride = Math.max(1, Math.floor(pos.count / 60000));
    for (let i = 0; i < pos.count; i += stride) b.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
    return b;
  }
  partBox(id) { return this._bboxPrecise(this.meshes.get(id)); }

  // ------------------------------------------------------------------ pointer
  _ndc(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }
  pickAt(ev) {
    this.raycaster.setFromCamera(this._ndc(ev), this.camera);
    const objs = [];
    for (const m of this.meshes.values()) if (m.visible) objs.push(m);
    const hits = this.raycaster.intersectObjects(objs, true).filter((h) => h.object.visible && !h.object.userData.isEdges);
    // prefer hole markers when close to the first surface hit
    const surf = hits.find((h) => h.object.userData.partId !== undefined && h.object.isMesh && h.object.userData.holeGroup);
    const hole = hits.find((h) => h.object.userData.holeId);
    const pick = hole && (!surf || hole.distance <= surf.distance + 3) ? hole : surf;
    if (!pick) return null;
    const mesh = this.meshes.get(pick.object.userData.partId);
    const res = { partId: pick.object.userData.partId, point: pick.point.clone(), holeId: pick.object.userData.holeId || null };
    if (surf) {
      const nWorld = surf.face.normal.clone().transformDirection(surf.object.matrixWorld);
      res.normal = nWorld;
      res.faceLocal = surf.face.normal.clone();
      if (!hole || pick === surf) res.point = surf.point.clone();
    }
    res.local = mesh.worldToLocal(res.point.clone());
    return res;
  }
  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (ev) => {
      down = { x: ev.clientX, y: ev.clientY, ev };
      const lbl = this._hitLabel(ev);
      if (lbl && this.mode === 'select' && ev.button === 0) {
        this.orbit.enabled = false;
        this._labelDrag = { id: lbl.id, x: ev.clientX, y: ev.clientY, dx: lbl.c.dx, dy: lbl.c.dy, c: lbl.c };
        el.setPointerCapture(ev.pointerId);
      }
    });
    el.addEventListener('pointermove', (ev) => {
      if (this._labelDrag) {
        const d = this._labelDrag;
        d.c.dx = d.dx + (ev.clientX - d.x);
        d.c.dy = d.dy + (ev.clientY - d.y);
        this.dirty();
      } else {
        el.style.cursor = this._hitLabel(ev) ? 'move' : this.mode === 'select' ? '' : 'crosshair';
      }
    });
    el.addEventListener('pointerup', (ev) => {
      if (this._labelDrag) {
        const d = this._labelDrag;
        this._labelDrag = null;
        this.orbit.enabled = true;
        if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 2) this.emit('calloutMoved', d.c);
        else this.emit('calloutClick', d.c);
        return;
      }
      if (!down || ev.button !== 0) return;
      if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) return; // was an orbit drag
      if (this.gizmo.dragging || this.gizmo.axis) return;
      const hit = this.pickAt(ev);
      this.emit('pick', { hit, mode: this.mode, shift: ev.shiftKey || ev.ctrlKey || ev.metaKey });
    });
  }
  _hitLabel(ev) {
    if (!this._labelRects) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    return this._labelRects.find((l) => x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) || null;
  }

  // ------------------------------------------------------------------ callouts (2D overlay)
  drawCallouts(ctx, camera, w, h, scale) {
    const rects = [];
    const step = this.step;
    if (!step) return rects;
    const accent = this.highlightColor;
    for (const c of step.callouts || []) {
      let wp;
      if (c.partId) {
        const m = this.meshes.get(c.partId);
        if (!m || !m.visible) continue;
        m.updateMatrixWorld();
        wp = new THREE.Vector3(...c.lp).applyMatrix4(m.matrixWorld);
      } else wp = new THREE.Vector3(...c.lp);
      const v = wp.clone().project(camera);
      if (v.z > 1) continue;
      const px = ((v.x + 1) / 2) * w, py = ((1 - v.y) / 2) * h;
      const fs = 14 * scale;
      ctx.font = `600 ${fs}px Inter, Segoe UI, Arial, sans-serif`;
      const lines = String(c.text || '').split('\n');
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width), 10);
      const pad = 6 * scale;
      const bw = tw + pad * 2, bh = lines.length * fs * 1.25 + pad * 1.4;
      const bx = px + c.dx * scale - bw / 2, by = py + c.dy * scale - bh / 2;
      // leader
      ctx.strokeStyle = c.color || accent;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(Math.min(Math.max(px, bx), bx + bw), Math.min(Math.max(py, by), by + bh));
      ctx.stroke();
      ctx.fillStyle = c.color || accent;
      ctx.beginPath(); ctx.arc(px, py, 3.5 * scale, 0, Math.PI * 2); ctx.fill();
      // box
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, bx, by, bw, bh, 5 * scale);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1d232a';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad * 0.7 + i * fs * 1.25));
      rects.push({ id: c.id, c, x: bx, y: by, w: bw, h: bh });
    }
    return rects;
  }

  // ------------------------------------------------------------------ snapshots
  _offscreen(w, h) {
    if (!this._off) this._off = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this._off.setPixelRatio(1);
    this._off.setSize(w, h, false);
    return this._off;
  }
  /** Render a step to a canvas (w x h) as it will appear in the guide. */
  snapshot(step, w, h, opts = {}) {
    const prev = this.step, prevSel = this.selection, cam = this.getCamera(), prevNew = this._newIds;
    this.selection = [];
    this.applyStep(step, { keepCamera: true, newIds: opts.newIds || new Set() });
    const camera = new THREE.PerspectiveCamera(this.baseFov || 30, w / h, this.camera.near, this.camera.far);
    camera.up.copy(Z_UP);
    camera.position.copy(this.camera.position);
    camera.quaternion.copy(this.camera.quaternion);
    if (step.camera) {
      camera.position.set(...step.camera.p);
      camera.fov = step.camera.fov || camera.fov;
      camera.lookAt(new THREE.Vector3(...step.camera.t));
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.camera.children.forEach((l) => camera.add(l.clone()));
    const out = this._renderOff(camera, w, h, opts, true);
    // restore
    this.selection = prevSel;
    if (prev) this.applyStep(prev, { keepCamera: true, newIds: prevNew });
    this.setCamera(cam);
    return out;
  }
  _renderOff(camera, w, h, opts, callouts) {
    const r = this._offscreen(w, h);
    const bg = this.scene.background;
    this.scene.background = new THREE.Color(opts.bg || '#ffffff');
    const gv = this.grid.visible, av = this.axes.visible, giz = this.gizmo.visible;
    this.grid.visible = !!opts.grid;
    this.axes.visible = false;
    this.gizmo.visible = false;
    this.updateLooks(true);
    const rings = [];
    this.root.traverse((o) => { if (o.userData.selRing && o.visible) { rings.push(o); o.visible = false; } });
    const camParent = camera.parent;
    if (!camParent) this.scene.add(camera);
    r.render(this.scene, camera);
    if (!camParent) this.scene.remove(camera);
    this.scene.background = bg;
    this.grid.visible = gv; this.axes.visible = av; this.gizmo.visible = giz;
    this.updateLooks(false);
    rings.forEach((o) => (o.visible = true));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(r.domElement, 0, 0, w, h);
    if (callouts) this.drawCallouts(ctx, camera, w, h, h / Math.max(300, this.container.clientHeight || 600));
    return cv;
  }
  /** Iso thumbnail of one part on its own. */
  thumbnail(partId, size = 320, opts = {}) {
    const m = this.meshes.get(partId);
    const state = [...this.meshes].map(([id, mm]) => [mm, mm.visible, mm.position.clone(), mm.quaternion.clone(), mm.userData.look, mm.userData.holeGroup.visible]);
    for (const mm of this.meshes.values()) mm.visible = false;
    m.visible = true;
    m.position.set(0, 0, 0);
    m.quaternion.identity();
    m.userData.look = 'normal';
    m.userData.holeGroup.visible = !!opts.holes;
    const ag = m.userData.arrowGroup.visible;
    m.userData.arrowGroup.visible = false;
    const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 20000);
    camera.up.copy(Z_UP);
    this.camera.children.forEach((l) => camera.add(l.clone()));
    const fake = { target: new THREE.Vector3() };
    m.updateMatrixWorld(true);
    const sphere = this._bboxPrecise(m).getBoundingSphere(new THREE.Sphere());
    const d = new THREE.Vector3(1, -1.2, 0.9).normalize();
    const dist = (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.02;
    camera.position.copy(sphere.center).addScaledVector(d, dist);
    camera.lookAt(sphere.center);
    fake.target.copy(sphere.center);
    camera.near = dist / 100; camera.far = dist * 10;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const cv = this._renderOff(camera, size, size, opts, false);
    for (const [mm, v, p, q, look, hv] of state) { mm.visible = v; mm.position.copy(p); mm.quaternion.copy(q); mm.userData.look = look; mm.userData.holeGroup.visible = hv; }
    m.userData.arrowGroup.visible = ag;
    this.updateLooks();
    return cv;
  }
}

function makeArrow(a) {
  const g = new THREE.Group();
  const L = a.len || 20;
  const color = new THREE.Color(a.color || '#e03131');
  const mat = new THREE.MeshBasicMaterial({ color });
  const headL = Math.min(L * 0.35, Math.max(3, L * 0.25)), headR = Math.max(1.2, L * 0.07), shaftR = headR * 0.4;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, L - headL, 12), mat);
  shaft.position.y = (L - headL) / 2;
  const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headL, 16), mat);
  head.position.y = L - headL / 2;
  const inner = new THREE.Group();
  inner.add(shaft, head);
  // arrow points along +Y in inner; tip at y=L. Place tip at lp + ld*gap pointing along ld.
  const dir = new THREE.Vector3(...a.ld).normalize();
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const tip = new THREE.Vector3(...a.lp).addScaledVector(dir, -(a.gap ?? 1));
  g.position.copy(tip).addScaledVector(dir, -L);
  g.add(inner);
  g.traverse((o) => { o.raycast = () => {}; });
  return g;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export { THREE };
