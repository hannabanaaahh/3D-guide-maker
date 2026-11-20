// Guide Builder — UI wiring.
import { Viewer, THREE } from './viewer.js';
import { parseSTL, splitParts, bbox, writeBinarySTL } from './stl.js';
import { parse3MF } from './threemf.js';
import { detectHoles, classifyHole, DEFAULT_HOLE_TYPES, DEFAULT_DETECT } from './holes.js';
import {
  uid, PALETTE, newStep, newProject, allSteps, findStep, stepNumber, newPartsInStep, hardwareFromHoles,
  History, idbPut, idbGet, saveProjectZip, loadProjectZip, migrate, importMarkdown,
} from './model.js';
import { exportPDF, exportMarkdownZip, buildMarkdown, fileSafe, usedHoleTypes } from './export.js';
import { marked } from '../vendor/marked.esm.js';

// ====================================================================== state
const app = {
  project: newProject(),
  geoms: new Map(), // geomKey -> Float32Array (centered positions)
  images: new Map(), // imageId -> dataURL
  stepId: null,
  tab: 'step',
  sel: [], // part ids
  selHole: null, // {partId, holeId}
  selItem: null, // {kind:'callout'|'arrow', id}
  mode: 'select',
  pending: null, // multi-click tool state
  propagate: true,
  fileHandle: null,
  geomDirty: true,
  partFilter: '',
};
const history = new History();
const $ = (s) => document.querySelector(s);
const viewer = new Viewer($('#viewport'));

const curStep = () => findStep(app.project, app.stepId)?.step || allSteps(app.project)[0];
const partById = (id) => app.project.parts.find((p) => p.id === id);
const typeById = (id) => app.project.holeTypes.find((t) => t.id === id);

// ====================================================================== DOM helper
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
const field = (label, input, hint) => h('label', { class: 'field' }, h('span', {}, label), input, hint && h('small', {}, hint));
const btn = (label, onclick, cls = '', title = '') => h('button', { class: cls, onclick, title: title || null }, label);
function inp(value, oninput, props = {}) {
  return h('input', { value: value ?? '', ...props, oninput: (e) => oninput(e.target.value, e), onchange: () => commit() });
}
function num(value, oninput, props = {}) {
  return h('input', { type: 'number', step: 'any', value: value ?? '', ...props,
    oninput: (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) oninput(v, e); }, onchange: () => commit() });
}
function area(value, oninput, props = {}) {
  const t = h('textarea', { ...props, oninput: (e) => { oninput(e.target.value); autoGrow(e.target); }, onchange: () => commit() });
  t.value = value || '';
  requestAnimationFrame(() => autoGrow(t));
  return t;
}
const autoGrow = (t) => { t.style.height = 'auto'; t.style.height = Math.min(500, t.scrollHeight + 2) + 'px'; };
function select(value, options, onchange, props = {}) {
  const s = h('select', { ...props, onchange: (e) => { onchange(e.target.value); commit(); } },
    options.map(([v, l]) => h('option', { value: v, selected: v === value || null }, l)));
  return s;
}
function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
function busy(msg) { $('#busy').textContent = msg || ''; $('#busy').hidden = !msg; }
const tick = () => new Promise((r) => setTimeout(r, 0));

// ====================================================================== commit / undo / autosave
let saveTimer = null;
function commit() {
  if (history.push(JSON.stringify(app.project))) scheduleSave();
  renderUndo();
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, 1200);
  document.title = (app.project.meta.title || 'Guide') + ' • Guide Builder';
}
async function autosave() {
  try {
    await idbPut('project', { json: JSON.stringify(app.project), images: [...app.images], stepId: app.stepId });
    if (app.geomDirty) { await idbPut('geoms', [...app.geoms]); app.geomDirty = false; }
    $('#saved').textContent = 'Autosaved ' + new Date().toLocaleTimeString();
  } catch (e) { console.warn('autosave failed', e); }
}
function undo() { const j = history.undo(); if (j) restore(j); }
function redo() { const j = history.redo(); if (j) restore(j); }
function restore(json) {
  app.project = JSON.parse(json);
  if (!findStep(app.project, app.stepId)) app.stepId = allSteps(app.project)[0].id;
  app.sel = app.sel.filter(partById);
  app.selItem = null; app.selHole = null;
  viewer.syncParts(app.project, app.geoms);
  goStep(app.stepId, { keepCamera: true });
  scheduleSave();
}
function renderUndo() {
  $('#undo').disabled = history.stack.length < 2;
  $('#redo').disabled = !history.redoStack.length;
}

// ====================================================================== steps
function ensureStepParts() {
  const steps = allSteps(app.project);
  for (const pt of app.project.parts) {
    let last = null;
    for (const st of steps) {
      if (!st.parts[pt.id]) st.parts[pt.id] = last ? { ...structuredClone(last) } : { v: false, p: pt.origin.slice(), q: [0, 0, 0, 1], look: 'auto' };
      last = st.parts[pt.id];
    }
  }
  for (const st of steps) for (const id of Object.keys(st.parts)) if (!partById(id)) delete st.parts[id];
}
/** Parts to auto-highlight: the ones new in this step, unless every visible part is new (e.g. step 1). */
function newIdsFor(step) {
  const ids = new Set(newPartsInStep(app.project, step.id).map((p) => p.id));
  const visible = Object.entries(step.parts).filter(([id, s]) => s.v && s.look !== 'ghost' && partById(id)).length;
  return ids.size && ids.size >= visible ? new Set() : ids;
}
function goStep(id, { keepCamera = false } = {}) {
  app.stepId = id;
  ensureStepParts();
  const st = curStep();
  viewer.highlightColor = app.project.settings.accent;
  viewer.showEdges = app.project.settings.edges;
  viewer.autoHighlight = app.project.settings.autoHighlight !== false;
  viewer.setFrameAspect(app.project.settings.renderW / app.project.settings.renderH);
  viewer.applyStep(st, { keepCamera: keepCamera || !st.camera, newIds: newIdsFor(st) });
  if (!st.camera && app.project.parts.length) { viewer.view('iso'); st.camera = viewer.getCamera(); }
  viewer.setSelection(app.sel.filter((id) => st.parts[id]?.v));
  renderAll();
}
function reapply() {
  const st = curStep();
  viewer.applyStep(st, { keepCamera: true, newIds: newIdsFor(st) });
}
function addStep(after = curStep(), copy = true) {
  const loc = findStep(app.project, after.id);
  const st = newStep(`Step ${allSteps(app.project).length + 1}`);
  if (copy) {
    st.parts = structuredClone(after.parts);
    for (const s of Object.values(st.parts)) if (s.look === 'highlight') s.look = 'auto';
    st.camera = after.camera && structuredClone(after.camera);
    st.showHoles = after.showHoles;
  }
  loc.section.steps.splice(loc.index + 1, 0, st);
  commit();
  goStep(st.id);
}
function deleteStep(id) {
  const loc = findStep(app.project, id);
  if (allSteps(app.project).length <= 1) return toast('A guide needs at least one step.');
  if (!confirm(`Delete "${loc.step.title}"?`)) return;
  loc.section.steps.splice(loc.index, 1);
  if (!loc.section.steps.length) loc.section.steps.push(newStep('Step 1'));
  const next = loc.section.steps[Math.min(loc.index, loc.section.steps.length - 1)];
  ensureStepParts();
  commit();
  goStep(next.id);
}
function duplicateStep(id) {
  const loc = findStep(app.project, id);
  const st = structuredClone(loc.step);
  st.id = uid('s');
  st.title += ' (copy)';
  st.callouts.forEach((c) => (c.id = uid('k')));
  st.arrows.forEach((a) => (a.id = uid('a')));
  loc.section.steps.splice(loc.index + 1, 0, st);
  commit();
  goStep(st.id);
}
function moveStep(id, toSection, toIndex) {
  const loc = findStep(app.project, id);
  loc.section.steps.splice(loc.index, 1);
  const sec = app.project.sections.find((s) => s.id === toSection);
  sec.steps.splice(Math.min(toIndex, sec.steps.length), 0, loc.step);
  for (const s of app.project.sections) if (!s.steps.length) s.steps.push(newStep('Step 1'));
  ensureStepParts();
  commit();
  goStep(id, { keepCamera: true });
}
function stepOffset(d) {
  const steps = allSteps(app.project);
  const i = steps.findIndex((s) => s.id === app.stepId);
  const n = steps[i + d];
  if (n) goStep(n.id);
}

/** Set a per-step part property and carry it forward to later steps that still had the old value. */
function setPartState(partId, patch) {
  const steps = allSteps(app.project);
  const i = steps.findIndex((s) => s.id === app.stepId);
  const old = structuredClone(steps[i].parts[partId]);
  Object.assign(steps[i].parts[partId], patch);
  if (!app.propagate) return;
  for (let k = i + 1; k < steps.length; k++) {
    const s = steps[k].parts[partId];
    if (!s) break;
    let same = true;
    for (const key of Object.keys(patch)) if (!eq(s[key], old[key])) same = false;
    if (!same) break;
    Object.assign(s, structuredClone(patch));
  }
}
const eq = (a, b) => Array.isArray(a) ? a.length === b?.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-5) : a === b;

// ====================================================================== import STL / 3MF
const MESH_RE = /\.(stl|3mf)$/i;
async function importSTLFiles(files) {
  files = [...files].filter((f) => MESH_RE.test(f.name));
  if (!files.length) return;
  const opts = await importDialog(files);
  if (!opts) return;
  const st = curStep();
  const steps = allSteps(app.project);
  const si = steps.indexOf(st);
  let made = 0, holeCount = 0;
  const prefix = commonPrefix(files.map((f) => f.name.replace(MESH_RE, '')));
  for (const f of files) {
    busy(`Reading ${f.name}…`);
    await tick();
    const base = f.name.replace(MESH_RE, '').slice(prefix.length) || f.name.replace(MESH_RE, '');
    let solids;
    try {
      if (/\.3mf$/i.test(f.name)) {
        // 3MF: one solid per object / part, with names and (when they differ) colours from the file
        const got = await parse3MF(await f.arrayBuffer(), JSZip);
        const distinct = new Set(got.map((b) => b.color).filter(Boolean)).size > 1;
        solids = got.map((b) => ({ name: got.length === 1 ? base : b.name.replace(/\.stl\b/i, ''), positions: b.positions, color: distinct ? b.color : null }));
      } else solids = parseSTL(await f.arrayBuffer());
    } catch (e) {
      console.error(e);
      toast(`Could not read ${f.name}: ${e.message}`, 5000);
      continue;
    }
    if (!solids.length) { toast(`${f.name} has no printable meshes.`); continue; }
    const bodies = [];
    for (const s of solids) {
      const split = /\.3mf$/i.test(f.name) ? opts.split3mf : opts.split;
      const parts = split ? splitParts(s.positions) : [s.positions];
      parts.forEach((p, i) => bodies.push({ name: s.name && solids.length > 1 ? s.name : base, idx: parts.length > 1 ? i + 1 : 0, pos: p, color: s.color }));
    }
    for (const b of bodies) {
      busy(`Analysing ${b.name}${b.idx ? ' #' + b.idx : ''}…`);
      await tick();
      const bb = bbox(b.pos);
      const c = [0, 1, 2].map((k) => (bb.min[k] + bb.max[k]) / 2);
      const pos = new Float32Array(b.pos.length);
      for (let i = 0; i < pos.length; i += 3) { pos[i] = b.pos[i] - c[0]; pos[i + 1] = b.pos[i + 1] - c[1]; pos[i + 2] = b.pos[i + 2] - c[2]; }
      const gk = uid('g');
      app.geoms.set(gk, pos);
      app.geomDirty = true;
      let holes = [];
      if (opts.holes) {
        holes = detectHoles(pos, app.project.detect || {}).map((hh) => ({ ...hh, id: uid('h'), type: classifyHole(hh, app.project.holeTypes) }));
        holeCount += holes.length;
      }
      const part = {
        id: uid('p'), name: b.name + (b.idx ? `_${b.idx}` : ''), file: f.name, geom: gk,
        color: b.color || PALETTE[app.project.parts.length % PALETTE.length], origin: c.map(r4), holes,
      };
      app.project.parts.push(part);
      steps.forEach((s, k) => { s.parts[part.id] = { v: k >= si, p: part.origin.slice(), q: [0, 0, 0, 1], look: 'auto' }; });
      made++;
    }
  }
  if (opts.arrange) arrangeOnBed(app.project.parts.slice(-made).map((p) => p.id));
  busy();
  viewer.syncParts(app.project, app.geoms);
  commit();
  goStep(st.id, { keepCamera: true });
  if (!st.camera || made === app.project.parts.length) { viewer.view('iso'); st.camera = viewer.getCamera(); commit(); }
  toast(`Imported ${made} part${made === 1 ? '' : 's'}${opts.holes ? `, found ${holeCount} hole${holeCount === 1 ? '' : 's'}` : ''}.`);
}
function importDialog(files) {
  return new Promise((resolve) => {
    const o = { split: true, split3mf: false, holes: true, arrange: false };
    const has = (re) => files.some((f) => re.test(f.name));
    const close = (v) => { closeModal(); resolve(v); };
    openModal(h('div', { class: 'dialog' },
      h('h2', {}, `Import ${files.length} file${files.length > 1 ? 's' : ''}`),
      h('ul', { class: 'filelist' }, files.slice(0, 12).map((f) => h('li', {}, f.name)), files.length > 12 && h('li', {}, `…and ${files.length - 12} more`)),
      has(/\.stl$/i) && check('STL: split disconnected bodies into separate parts', o.split, (v) => (o.split = v)),
      has(/\.3mf$/i) && check('3MF: also split each object/part into disconnected bodies (3MF parts are kept as defined otherwise)', o.split3mf, (v) => (o.split3mf = v)),
      check('Detect screw / insert holes', o.holes, (v) => (o.holes = v)),
      check('Arrange side by side on the bed (otherwise keep file positions)', o.arrange, (v) => (o.arrange = v)),
      h('div', { class: 'row end' }, btn('Cancel', () => close(null)), btn('Import', () => close(o), 'primary'))));
  });
}
/** Shared leading text of several file names, cut at a separator (so 'kit_base', 'kit_lid' -> 'kit_'). */
function commonPrefix(names) {
  if (names.length < 2) return '';
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  const m = /^.*[\s_\-.]/.exec(p);
  return m ? m[0] : '';
}
const check = (label, val, on) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: val, onchange: (e) => on(e.target.checked) }), label);

function arrangeOnBed(ids) {
  let x = 0;
  const steps = allSteps(app.project);
  for (const id of ids) {
    const pt = partById(id);
    const pos = app.geoms.get(pt.geom);
    const bb = bbox(pos);
    const w = bb.max[0] - bb.min[0];
    const p = [x + w / 2, 0, -bb.min[2]];
    x += w + 10;
    pt.origin = p.map(r4);
    for (const s of steps) Object.assign(s.parts[id], { p: p.slice() });
  }
  // center the row
  const shift = x / 2;
  for (const id of ids) {
    const pt = partById(id);
    pt.origin[0] = r4(pt.origin[0] - shift);
    for (const s of steps) s.parts[id].p[0] = pt.origin[0];
  }
}

// ====================================================================== transforms & tools
function applyMeshStates(states) {
  for (const s of states) setPartState(s.id, { p: s.p, q: s.q });
  commit();
  renderInspector();
}
viewer.addEventListener('transform', (e) => applyMeshStates(e.detail));
viewer.addEventListener('camera', (e) => { const st = curStep(); st.camera = e.detail; scheduleSave(); history.stack[history.stack.length - 1] = JSON.stringify(app.project); });
viewer.addEventListener('selection', () => {});
viewer.addEventListener('calloutMoved', () => commit());
viewer.addEventListener('calloutClick', (e) => { app.selItem = { kind: 'callout', id: e.detail.id }; app.tab = 'sel'; renderInspector(); renderTabs(); });

/** Move/rotate a part in world space via a function on its mesh, then store the result. */
function transformParts(ids, fn) {
  const states = [];
  for (const id of ids) {
    const m = viewer.meshes.get(id);
    if (!m || !m.visible) continue;
    fn(m, id);
    m.updateMatrixWorld();
    states.push(viewer.stateOf(id));
  }
  applyMeshStates(states);
  reapply();
  viewer.setSelection(app.sel);
}
function rotateSel(axis, deg) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), (deg * Math.PI) / 180);
  transformParts(app.sel, (m) => m.quaternion.premultiply(q));
}
function dropToBed(ids = app.sel) {
  transformParts(ids, (m, id) => { const b = viewer.partBox(id); m.position.z -= b.min.z; });
}
function centerXY(ids = app.sel) {
  const box = new THREE.Box3();
  ids.forEach((id) => box.union(viewer.partBox(id)));
  const c = box.getCenter(new THREE.Vector3());
  transformParts(ids, (m) => { m.position.x -= c.x; m.position.y -= c.y; });
}
function align(axis, where) {
  const [anchor, ...rest] = app.sel;
  if (!rest.length) return toast('Select 2+ parts (shift-click). The first one is the anchor.');
  const k = 'xyz'[axis];
  const A = viewer.partBox(anchor);
  const val = (b) => (where === 'min' ? b.min[k] : where === 'max' ? b.max[k] : (b.min[k] + b.max[k]) / 2);
  transformParts(rest, (m, id) => { m.position[k] += val(A) - val(viewer.partBox(id)); });
}
function stackOn() {
  const [anchor, ...rest] = app.sel;
  if (!rest.length) return toast('Select the base part first, then shift-click the parts to stack on it.');
  const A = viewer.partBox(anchor);
  let top = A.max.z;
  transformParts(rest, (m, id) => {
    const b = viewer.partBox(id);
    m.position.z += top - b.min.z;
    m.position.x += (A.min.x + A.max.x) / 2 - (b.min.x + b.max.x) / 2;
    m.position.y += (A.min.y + A.max.y) / 2 - (b.min.y + b.max.y) / 2;
    top += b.max.z - b.min.z;
  });
}
function resetPart(ids = app.sel) {
  transformParts(ids, (m, id) => { m.position.set(...partById(id).origin); m.quaternion.identity(); });
}
/** Feature (point + outward normal) in part-local coordinates from a pick. */
function featureFromHit(hit) {
  const pt = partById(hit.partId);
  if (hit.holeId) {
    const hh = pt.holes.find((x) => x.id === hit.holeId);
    return { partId: pt.id, p: new THREE.Vector3(...hh.c), n: new THREE.Vector3(...hh.a), hole: hh };
  }
  if (!hit.faceLocal) return null;
  return { partId: pt.id, p: hit.local.clone(), n: hit.faceLocal.clone().normalize() };
}
function mate(A, B, gap = 0) {
  const ma = viewer.meshes.get(A.partId), mb = viewer.meshes.get(B.partId);
  ma.updateMatrixWorld(); mb.updateMatrixWorld();
  const nA = A.n.clone().transformDirection(ma.matrixWorld), nB = B.n.clone().transformDirection(mb.matrixWorld);
  const pB = B.p.clone().applyMatrix4(mb.matrixWorld);
  transformParts([A.partId], (m) => {
    const q = new THREE.Quaternion().setFromUnitVectors(nA, nB.clone().negate());
    m.quaternion.premultiply(q);
    m.updateMatrixWorld();
    const pA2 = A.p.clone().applyMatrix4(m.matrixWorld);
    m.position.add(pB.clone().sub(pA2)).addScaledVector(nB, gap);
  });
}
function layFlat(hit) {
  const n = hit.normal.clone().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
  transformParts([hit.partId], (m) => m.quaternion.premultiply(q));
  dropToBed([hit.partId]);
}

const MODES = {
  select: 'Click a part to select it. Shift-click to add to the selection. Drag the gizmo to move/rotate.',
  callout: 'Click on a part to place a callout label. Drag the label afterwards to position it.',
  arrow: 'Click on a part surface to add an arrow pointing into it.',
  addhole: 'Click on a flat surface to add a hole marker there.',
  mate1: 'Mate: click a hole or face on the part you want to MOVE.',
  mate2: 'Mate: now click the hole or face it should meet on the target part.',
  flat: 'Lay flat: click the face that should rest on the bed.',
};
function setMode(m) {
  app.mode = m;
  viewer.mode = m;
  if (m !== 'mate2') app.pending = m === 'mate1' ? {} : null;
  $('#hint').textContent = MODES[m] || '';
  $('#hint').classList.toggle('active', m !== 'select');
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m || (m === 'mate2' && b.dataset.mode === 'mate1')));
}

viewer.addEventListener('pick', (e) => {
  const { hit, mode, shift } = e.detail;
  const st = curStep();
  if (mode === 'select') {
    app.selItem = null;
    if (!hit) { app.sel = []; app.selHole = null; }
    else if (hit.holeId && !shift) { app.selHole = { partId: hit.partId, holeId: hit.holeId }; app.sel = [hit.partId]; }
    else {
      app.selHole = null;
      if (shift) app.sel = app.sel.includes(hit.partId) ? app.sel.filter((x) => x !== hit.partId) : [...app.sel, hit.partId];
      else app.sel = [hit.partId];
    }
    viewer.selectedHole = app.selHole;
    viewer.refreshAllHoles();
    viewer.setSelection(app.sel);
    if (app.sel.length || app.selHole) app.tab = 'sel';
    renderTabs(); renderInspector(); renderParts();
    return;
  }
  if (!hit) return;
  if (mode === 'callout') {
    const c = { id: uid('k'), partId: hit.partId, lp: hit.local.toArray().map(r4), text: partById(hit.partId).name, dx: 60, dy: -50 };
    st.callouts.push(c);
    app.selItem = { kind: 'callout', id: c.id };
    app.tab = 'sel';
    setMode('select');
    commit(); viewer.dirty(); renderTabs(); renderInspector();
    setTimeout(() => $('#inspector textarea')?.select(), 30);
  } else if (mode === 'arrow') {
    if (!hit.faceLocal) return;
    const a = { id: uid('a'), partId: hit.partId, lp: hit.local.toArray().map(r4), ld: hit.faceLocal.clone().negate().toArray().map(r4), len: 25, gap: 2, color: '#e03131' };
    st.arrows.push(a);
    app.selItem = { kind: 'arrow', id: a.id };
    app.tab = 'sel';
    setMode('select');
    commit(); reapply(); renderTabs(); renderInspector();
  } else if (mode === 'addhole') {
    if (!hit.faceLocal) return;
    const pt = partById(hit.partId);
    const hh = { id: uid('h'), c: hit.local.toArray().map(r4), a: hit.faceLocal.toArray().map(r4), d: 3.4, depth: 5, through: false, shape: 'circle', cb: null, csk: null, manual: true };
    hh.type = classifyHole(hh, app.project.holeTypes) || 'other';
    pt.holes.push(hh);
    app.selHole = { partId: pt.id, holeId: hh.id };
    viewer.selectedHole = app.selHole;
    app.sel = [pt.id];
    app.tab = 'sel';
    setMode('select');
    viewer.refreshAllHoles();
    commit(); renderTabs(); renderInspector();
  } else if (mode === 'mate1') {
    const f = featureFromHit(hit);
    if (!f) return;
    app.pending = { A: f };
    setMode('mate2');
  } else if (mode === 'mate2') {
    const f = featureFromHit(hit);
    if (!f) return;
    if (f.partId === app.pending.A.partId) return toast('Pick a feature on a different part.');
    mate(app.pending.A, f);
    app.sel = [app.pending.A.partId];
    viewer.setSelection(app.sel);
    setMode('select');
    toast('Mated. Use Rotate (E) to spin it about the axis if needed.');
  } else if (mode === 'flat') {
    if (!hit.normal) return;
    layFlat(hit);
    setMode('select');
  }
});

// ====================================================================== render: outline
function renderAll() { renderOutline(); renderParts(); renderTabs(); renderInspector(); renderStepbar(); renderUndo(); renderToolbarState(); }

function renderOutline() {
  const p = app.project;
  const root = $('#outline');
  root.replaceChildren();
  root.append(h('div', { class: 'ol-guide' + (app.tab === 'guide' ? ' on' : ''), onclick: () => { app.tab = 'guide'; renderTabs(); renderInspector(); renderOutline(); } },
    h('span', { class: 'ic' }, '📘'), p.meta.title || 'Untitled guide'));
  let n = 0;
  p.sections.forEach((sec, si) => {
    const head = h('div', { class: 'ol-sec', draggable: false,
      ondragover: (e) => { e.preventDefault(); head.classList.add('dropin'); },
      ondragleave: () => head.classList.remove('dropin'),
      ondrop: (e) => { e.preventDefault(); head.classList.remove('dropin'); moveStep(e.dataTransfer.getData('text/step'), sec.id, 0); } },
      h('span', { class: 'sec-t', ondblclick: () => renameSection(sec), title: 'Double-click to rename' }, sec.title),
      h('span', { class: 'acts' },
        btn('＋', () => { const last = sec.steps[sec.steps.length - 1]; addStep(last); }, 'mini', 'Add step to this section'),
        btn('↑', () => { if (si) { p.sections.splice(si - 1, 0, p.sections.splice(si, 1)[0]); commit(); renderAll(); } }, 'mini', 'Move section up'),
        btn('↓', () => { if (si < p.sections.length - 1) { p.sections.splice(si + 1, 0, p.sections.splice(si, 1)[0]); commit(); renderAll(); } }, 'mini', 'Move section down'),
        btn('✕', () => deleteSection(sec), 'mini', 'Delete section')));
    root.append(head);
    sec.steps.forEach((st, i) => {
      n++;
      const row = h('div', { class: 'ol-step' + (st.id === app.stepId ? ' on' : ''), draggable: true,
        onclick: () => { if (app.stepId !== st.id) goStep(st.id); else { app.tab = 'step'; renderTabs(); renderInspector(); } },
        ondragstart: (e) => { e.dataTransfer.setData('text/step', st.id); row.classList.add('dragging'); },
        ondragend: () => row.classList.remove('dragging'),
        ondragover: (e) => { e.preventDefault(); row.classList.add('dropover'); },
        ondragleave: () => row.classList.remove('dropover'),
        ondrop: (e) => { e.preventDefault(); row.classList.remove('dropover'); const id = e.dataTransfer.getData('text/step'); if (id && id !== st.id) moveStep(id, sec.id, i); } },
        h('span', { class: 'num' }, n), h('span', { class: 'st-t' }, st.title || '(untitled)'),
        st.id === p.meta.coverStepId && h('span', { class: 'tag', title: 'Cover image' }, 'cover'),
        h('span', { class: 'acts' },
          btn('⧉', (e) => { e.stopPropagation(); duplicateStep(st.id); }, 'mini', 'Duplicate step'),
          btn('✕', (e) => { e.stopPropagation(); deleteStep(st.id); }, 'mini', 'Delete step')));
      root.append(row);
    });
  });
  root.append(h('div', { class: 'row', style: { marginTop: '8px' } },
    btn('＋ Step', () => addStep(), 'small'),
    btn('＋ Section', addSection, 'small')));
}
function addSection() {
  const title = prompt('Section name', 'New section');
  if (!title) return;
  const st = newStep('Step 1');
  st.parts = structuredClone(curStep().parts);
  st.camera = curStep().camera;
  app.project.sections.push({ id: uid('c'), title, intro: '', steps: [st] });
  commit();
  goStep(st.id);
}
function renameSection(sec) {
  const t = prompt('Section name', sec.title);
  if (t) { sec.title = t; commit(); renderAll(); }
}
function deleteSection(sec) {
  const p = app.project;
  if (p.sections.length <= 1) return toast('A guide needs at least one section.');
  if (!confirm(`Delete section "${sec.title}" and its ${sec.steps.length} step(s)?`)) return;
  p.sections = p.sections.filter((s) => s !== sec);
  commit();
  goStep(findStep(p, app.stepId) ? app.stepId : allSteps(p)[0].id);
}

// ====================================================================== render: parts list
function renderParts() {
  const st = curStep();
  const root = $('#parts');
  root.replaceChildren();
  const p = app.project;
  if (!p.parts.length) {
    root.append(h('div', { class: 'empty' }, 'No parts yet.', h('br'), btn('Import STL / 3MF…', () => $('#file-stl').click(), 'primary small'), h('br'), h('small', {}, 'or drop .stl / .3mf files on the viewport')));
    return;
  }
  const newIds = newIdsFor(st);
  root.append(h('div', { class: 'row tight' },
    h('input', { class: 'grow', placeholder: 'Filter parts…', value: app.partFilter, oninput: (e) => { app.partFilter = e.target.value; renderPartRows(); } }),
    btn('Show all', () => { p.parts.forEach((pt) => setPartState(pt.id, { v: true })); commit(); reapply(); renderAll(); }, 'small'),
    btn('Hide all', () => { p.parts.forEach((pt) => setPartState(pt.id, { v: false })); commit(); reapply(); renderAll(); }, 'small')));
  const list = h('div', { class: 'plist' });
  root.append(list);
  function renderPartRows() {
    list.replaceChildren();
    const f = app.partFilter.toLowerCase();
    for (const pt of p.parts) {
      if (f && !pt.name.toLowerCase().includes(f)) continue;
      const s = st.parts[pt.id] || { v: false };
      list.append(h('div', { class: 'prow' + (app.sel.includes(pt.id) ? ' on' : '') + (s.v ? '' : ' off') },
        h('button', { class: 'eye', title: s.v ? 'Hide in this step' : 'Show in this step', onclick: () => { setPartState(pt.id, { v: !s.v }); commit(); reapply(); renderAll(); } }, s.v ? '👁' : '—'),
        h('span', { class: 'sw', style: { background: pt.color } }),
        h('span', { class: 'pn', title: pt.file, onclick: (e) => {
          app.sel = e.shiftKey ? [...new Set([...app.sel, pt.id])] : [pt.id];
          app.selHole = null; app.selItem = null; app.tab = 'sel';
          viewer.setSelection(app.sel); renderTabs(); renderInspector(); renderParts();
        } }, pt.name),
        newIds.has(pt.id) && h('span', { class: 'tag new', title: 'First appears in this step' }, 'new'),
        (pt.holes?.length || 0) > 0 && h('span', { class: 'tag', title: 'Detected holes' }, '◎' + pt.holes.length),
        select(s.look || 'auto', [['auto', 'Auto'], ['normal', 'Normal'], ['highlight', 'Highlight'], ['ghost', 'Ghost']],
          (v) => { setPartState(pt.id, { look: v }); reapply(); }, { class: 'look', title: 'Appearance in this step' })));
    }
  }
  renderPartRows();
}

// ====================================================================== render: inspector
function renderTabs() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === app.tab));
}
function renderInspector() {
  const root = $('#inspector');
  const scroll = root.scrollTop;
  root.replaceChildren();
  const fn = { step: inspStep, sel: inspSelection, guide: inspGuide, holes: inspHoleTypes, export: inspExport }[app.tab] || inspStep;
  fn(root);
  root.scrollTop = scroll;
}

function inspStep(root) {
  const p = app.project;
  const st = curStep();
  const loc = findStep(p, st.id);
  const sec = loc.section;
  root.append(
    h('div', { class: 'sec-box' },
      h('div', { class: 'muted small' }, 'Section'),
      inp(sec.title, (v) => { sec.title = v; renderOutline(); }, { class: 'strong' }),
      h('details', {}, h('summary', {}, 'Section introduction'), area(sec.intro, (v) => (sec.intro = v), { placeholder: 'Markdown shown at the start of the section' }))),
    h('h3', {}, `Step ${stepNumber(p, st.id)}`),
    field('Title', inp(st.title, (v) => { st.title = v; renderOutline(); renderStepbar(); })),
    field('Instructions', area(st.text, (v) => (st.text = v), { placeholder: 'Markdown: **bold**, *italic*, - bullets, 1. numbered' })),
  );
  // notes
  const notes = h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Notes',
    h('span', {}, btn('+ Tip', () => addNote('tip'), 'mini'), btn('+ Warning', () => addNote('warning'), 'mini'), btn('+ Note', () => addNote('info'), 'mini'))));
  st.notes.forEach((nt, i) => notes.append(h('div', { class: 'note ' + nt.kind },
    h('div', { class: 'row tight' }, select(nt.kind, [['tip', 'Tip'], ['warning', 'Warning'], ['info', 'Note']], (v) => { nt.kind = v; renderInspector(); }),
      h('span', { class: 'grow' }), btn('↑', () => { if (i) { st.notes.splice(i - 1, 0, st.notes.splice(i, 1)[0]); commit(); renderInspector(); } }, 'mini'),
      btn('✕', () => { st.notes.splice(i, 1); commit(); renderInspector(); }, 'mini')),
    area(nt.text, (v) => (nt.text = v)))));
  function addNote(kind) { st.notes.push({ kind, text: '' }); commit(); renderInspector(); }
  root.append(notes);
  // hardware
  const hw = h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Hardware',
    h('span', {}, btn('Suggest from holes', suggestHardware, 'mini', 'Count holes of the parts that are new in this step'), btn('+ Add', () => { st.hardware.push({ qty: 1, name: '' }); commit(); renderInspector(); }, 'mini'))));
  st.hardware.forEach((it, i) => hw.append(h('div', { class: 'row tight' },
    num(it.qty, (v) => (it.qty = v), { class: 'qty', min: 0 }), inp(it.name, (v) => (it.name = v), { class: 'grow', placeholder: 'e.g. M3x8 screw', list: 'hw-names' }),
    btn('✕', () => { st.hardware.splice(i, 1); commit(); renderInspector(); }, 'mini'))));
  root.append(hw);
  function suggestHardware() {
    const parts = newPartsInStep(p, st.id);
    const sug = hardwareFromHoles(p, parts.length ? parts : p.parts.filter((pt) => st.parts[pt.id]?.v));
    if (!sug.length) return toast('No classified holes on the parts in this step.');
    for (const s of sug) {
      const ex = st.hardware.find((x) => x.name === s.name);
      if (ex) ex.qty = s.qty; else st.hardware.push(s);
    }
    commit(); renderInspector();
  }
  // view
  root.append(h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Picture'),
    check('Show hole markers', st.showHoles !== false, (v) => { st.showHoles = v; commit(); reapply(); }),
    field('Explode', h('input', { type: 'range', min: 0, max: 1.5, step: 0.05, value: st.explode || 0,
      oninput: (e) => { st.explode = +e.target.value; reapply(); $('#explode').value = st.explode; }, onchange: () => commit() })),
    check('Use 3D render as the step picture', st.useRender !== false, (v) => { st.useRender = v; commit(); }),
    h('div', { class: 'imgs' }, st.images.map((id, i) => h('div', { class: 'thumb' }, h('img', { src: app.images.get(id) }),
      btn('✕', () => { st.images.splice(i, 1); commit(); renderInspector(); }, 'mini x')))),
    h('div', { class: 'row tight' },
      btn('Add photo…', () => pickImages((urls) => { urls.forEach((u) => { const id = uid('i'); app.images.set(id, u); st.images.push(id); }); commit(); renderInspector(); }), 'small'),
      btn('Snapshot → photo', () => { const id = uid('i'); app.images.set(id, renderStepCanvas(st).toDataURL('image/png')); st.images.push(id); st.useRender = false; commit(); renderInspector(); toast('Render frozen as a photo. Edit it outside if you like.'); }, 'small', 'Freeze the current render as a still image'),
      btn(p.meta.coverStepId === st.id ? '★ Cover' : '☆ Use as cover', () => { p.meta.coverStepId = p.meta.coverStepId === st.id ? null : st.id; commit(); renderAll(); }, 'small'))));
  // callouts & arrows
  const ann = h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Callouts & arrows',
    h('span', {}, btn('+ Callout', () => setMode('callout'), 'mini'), btn('+ Arrow', () => setMode('arrow'), 'mini'))));
  st.callouts.forEach((c) => ann.append(h('div', { class: 'row tight item', onclick: () => { app.selItem = { kind: 'callout', id: c.id }; app.tab = 'sel'; renderTabs(); renderInspector(); } },
    h('span', { class: 'grow' }, '🏷 ' + (c.text || '(empty)').split('\n')[0]), btn('✕', (e) => { e.stopPropagation(); st.callouts = st.callouts.filter((x) => x !== c); commit(); viewer.dirty(); renderInspector(); }, 'mini'))));
  st.arrows.forEach((a) => ann.append(h('div', { class: 'row tight item', onclick: () => { app.selItem = { kind: 'arrow', id: a.id }; app.tab = 'sel'; renderTabs(); renderInspector(); } },
    h('span', { class: 'grow' }, '➜ arrow on ' + (partById(a.partId)?.name || 'world')), btn('✕', (e) => { e.stopPropagation(); st.arrows = st.arrows.filter((x) => x !== a); commit(); reapply(); renderInspector(); }, 'mini'))));
  root.append(ann);
  root.append(h('div', { class: 'row' },
    btn('Duplicate step', () => duplicateStep(st.id), 'small'),
    btn('Delete step', () => deleteStep(st.id), 'small danger')));
}

function inspSelection(root) {
  const st = curStep();
  const p = app.project;
  if (app.selItem) return inspItem(root, st);
  if (app.selHole) {
    const pt = partById(app.selHole.partId);
    const hh = pt?.holes.find((x) => x.id === app.selHole.holeId);
    if (hh) return inspHole(root, pt, hh);
  }
  if (!app.sel.length) {
    root.append(h('div', { class: 'empty' }, 'Nothing selected.', h('br'), h('small', {}, 'Click a part, hole marker or callout in the viewport.')));
    return;
  }
  if (app.sel.length > 1) {
    root.append(h('h3', {}, `${app.sel.length} parts selected`), h('div', { class: 'muted small' }, `Anchor: ${partById(app.sel[0]).name} (first selected)`));
    const grid = h('div', { class: 'align-grid' }, h('span'), h('b', {}, 'min'), h('b', {}, 'center'), h('b', {}, 'max'));
    ['X', 'Y', 'Z'].forEach((ax, i) => grid.append(h('b', {}, ax), ...['min', 'center', 'max'].map((w) => btn('⇥', () => align(i, w), 'small', `Align ${w} ${ax} to anchor`))));
    root.append(h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Align to anchor'), grid,
      h('div', { class: 'row tight' }, btn('Stack on anchor', stackOn, 'small'), btn('Drop all to bed', () => dropToBed(), 'small'), btn('Center group', () => centerXY(), 'small'))));
    root.append(rotateBox(), h('div', { class: 'row' },
      btn('Hide in step', () => { app.sel.forEach((id) => setPartState(id, { v: false })); commit(); reapply(); renderAll(); }, 'small'),
      btn('Ghost', () => { app.sel.forEach((id) => setPartState(id, { look: 'ghost' })); commit(); reapply(); renderParts(); }, 'small'),
      btn('Highlight', () => { app.sel.forEach((id) => setPartState(id, { look: 'highlight' })); commit(); reapply(); renderParts(); }, 'small')));
    return;
  }
  const pt = partById(app.sel[0]);
  const s = st.parts[pt.id];
  const m = viewer.meshes.get(pt.id);
  const eu = new THREE.Euler().setFromQuaternion(m.quaternion, 'XYZ');
  const deg = [eu.x, eu.y, eu.z].map((r) => Math.round(((r * 180) / Math.PI) * 100) / 100);
  const pos = viewer.stateOf(pt.id).p;
  const setPos = (k, v) => { transformParts([pt.id], (mm) => { mm.position.setComponent(k, v + (viewer.explodeOffsets.get(pt.id)?.getComponent(k) || 0)); }); };
  const setRot = (k, v) => { deg[k] = v; const e = new THREE.Euler(...deg.map((d) => (d * Math.PI) / 180), 'XYZ'); transformParts([pt.id], (mm) => mm.quaternion.setFromEuler(e)); };
  root.append(
    field('Part name', inp(pt.name, (v) => { pt.name = v; renderParts(); })),
    h('div', { class: 'row tight' },
      field('Color', h('input', { type: 'color', value: pt.color, oninput: (e) => { pt.color = e.target.value; viewer.syncParts(p, app.geoms); renderParts(); }, onchange: () => commit() })),
      field('In this step', select(s.look || 'auto', [['auto', 'Auto'], ['normal', 'Normal'], ['highlight', 'Highlight'], ['ghost', 'Ghost']], (v) => { setPartState(pt.id, { look: v }); reapply(); renderParts(); }))),
    h('div', { class: 'muted small' }, `File: ${pt.file}`),
    h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Position (mm)'),
      h('div', { class: 'xyz' }, [0, 1, 2].map((k) => h('label', {}, 'XYZ'[k], num(pos[k], (v) => setPos(k, v)))))),
    h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Rotation (°)'),
      h('div', { class: 'xyz' }, [0, 1, 2].map((k) => h('label', {}, 'XYZ'[k], num(deg[k], (v) => setRot(k, v)))))),
    rotateBox(),
    h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Place'),
      h('div', { class: 'row tight wrap' },
        btn('Drop to bed', () => dropToBed(), 'small'), btn('Center XY', () => centerXY(), 'small'),
        btn('Lay flat…', () => setMode('flat'), 'small', 'Click a face to put it on the bed'),
        btn('Mate…', () => setMode('mate1'), 'small', 'Click a hole/face on this part, then the matching one on another part'),
        btn('Reset', () => resetPart(), 'small', 'Back to the position from the STL file'),
        btn('Isolate', () => { p.parts.forEach((x) => setPartState(x.id, { v: x.id === pt.id })); commit(); reapply(); renderAll(); }, 'small', 'Hide everything else in this step'))),
  );
  // holes
  const hg = h('div', { class: 'group' }, h('div', { class: 'group-h' }, `Holes (${pt.holes.length})`,
    h('span', {}, btn('Re-detect', () => redetect(pt), 'mini'), btn('+ Add', () => setMode('addhole'), 'mini'))));
  const types = p.holeTypes.map((t) => [t.id, t.name]);
  for (const hh of pt.holes) {
    const t = typeById(hh.type);
    hg.append(h('div', { class: 'hrow' + (hh.hidden ? ' off' : '') },
      h('span', { class: 'ring', style: { borderColor: t?.color || '#aaa' } }),
      h('span', { class: 'hd', onclick: () => { app.selHole = { partId: pt.id, holeId: hh.id }; viewer.selectedHole = app.selHole; viewer.refreshHoles(pt.id); renderInspector(); } },
        `${hh.shape === 'hex' ? '⬡' : 'Ø'}${fmt(hh.d)}${hh.depth != null ? ' × ' + fmt(hh.depth) : ''}${hh.through ? ' thru' : ''}`),
      select(hh.type || '', [['', '(unclassified)'], ...types], (v) => { hh.type = v || null; viewer.refreshHoles(pt.id); renderInspector(); }, { class: 'grow' }),
      h('button', { class: 'mini', title: hh.hidden ? 'Show marker' : 'Hide marker', onclick: () => { hh.hidden = !hh.hidden; viewer.refreshHoles(pt.id); commit(); renderInspector(); } }, hh.hidden ? '—' : '👁')));
  }
  root.append(hg);
  root.append(h('div', { class: 'row' },
    btn('Duplicate part', () => duplicatePart(pt), 'small', 'Adds another copy that shares the same STL (counts as qty 2)'),
    btn('Export STL', () => download(new Blob([writeBinarySTL(app.geoms.get(pt.geom), pt.name)]), fileSafe(pt.name) + '.stl'), 'small'),
    btn('Delete part', () => deletePart(pt), 'small danger')));
}
function rotateBox() {
  const g = h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Rotate 90°'));
  const r = h('div', { class: 'row tight wrap' });
  [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]].forEach(([n, ax]) => r.append(btn(`${n} −`, () => rotateSel(ax, -90), 'small'), btn(`${n} +`, () => rotateSel(ax, 90), 'small')));
  g.append(r);
  return g;
}
function inspHole(root, pt, hh) {
  const p = app.project;
  const refresh = () => { viewer.refreshHoles(pt.id); };
  root.append(
    h('div', { class: 'muted small' }, `Hole on ${pt.name}`),
    h('h3', {}, `${hh.shape === 'hex' ? 'Hex pocket' : 'Hole'} Ø${fmt(hh.d)}`),
    field('Type', select(hh.type || '', [['', '(unclassified)'], ...p.holeTypes.map((t) => [t.id, t.name])], (v) => { hh.type = v || null; refresh(); renderInspector(); })),
    h('div', { class: 'row tight' },
      field(hh.shape === 'hex' ? 'Across flats' : 'Diameter', num(hh.d, (v) => { hh.d = v; refresh(); })),
      field('Depth', num(hh.depth, (v) => { hh.depth = v; refresh(); })),
      field('Shape', select(hh.shape, [['circle', 'Round'], ['hex', 'Hex']], (v) => { hh.shape = v; refresh(); }))),
    check('Through hole', hh.through, (v) => { hh.through = v; commit(); }),
    hh.cb && h('div', { class: 'muted small' }, `Counterbore Ø${fmt(hh.cb.d)} × ${fmt(hh.cb.depth)}`),
    hh.csk && h('div', { class: 'muted small' }, `Countersink / chamfer Ø${fmt(hh.csk)}`),
    check('Hide marker', !!hh.hidden, (v) => { hh.hidden = v; refresh(); commit(); }),
    h('div', { class: 'row wrap' },
      btn('Flip axis', () => { hh.a = hh.a.map((x) => -x); refresh(); commit(); }, 'small'),
      btn('Reclassify by size', () => { hh.type = classifyHole(hh, p.holeTypes); refresh(); commit(); renderInspector(); }, 'small'),
      btn('Same type for all Ø' + fmt(hh.d), () => {
        let n = 0;
        for (const x of p.parts) for (const o of x.holes) if (Math.abs(o.d - hh.d) < 0.05 && o.shape === hh.shape) { o.type = hh.type; n++; }
        viewer.refreshAllHoles(); commit(); toast(`Updated ${n} holes.`);
      }, 'small'),
      btn('Delete hole', () => { pt.holes = pt.holes.filter((x) => x !== hh); app.selHole = null; viewer.selectedHole = null; refresh(); commit(); renderInspector(); }, 'small danger'),
      btn('Back to part', () => { app.selHole = null; viewer.selectedHole = null; refresh(); renderInspector(); }, 'small')));
}
function inspItem(root, st) {
  const { kind, id } = app.selItem;
  const back = btn('Done', () => { app.selItem = null; renderInspector(); }, 'small');
  if (kind === 'callout') {
    const c = st.callouts.find((x) => x.id === id);
    if (!c) { app.selItem = null; return inspSelection(root); }
    root.append(h('h3', {}, 'Callout'),
      field('Text', area(c.text, (v) => { c.text = v; viewer.dirty(); }), 'Drag the label in the viewport to move it.'),
      field('Color', h('input', { type: 'color', value: c.color || app.project.settings.accent, oninput: (e) => { c.color = e.target.value; viewer.dirty(); }, onchange: () => commit() })),
      h('div', { class: 'row' }, back, btn('Delete', () => { st.callouts = st.callouts.filter((x) => x !== c); app.selItem = null; commit(); viewer.dirty(); renderInspector(); }, 'small danger')));
  } else {
    const a = st.arrows.find((x) => x.id === id);
    if (!a) { app.selItem = null; return inspSelection(root); }
    const upd = () => reapply();
    root.append(h('h3', {}, 'Arrow'),
      h('div', { class: 'row tight' },
        field('Length', num(a.len, (v) => { a.len = v; upd(); })),
        field('Gap', num(a.gap ?? 1, (v) => { a.gap = v; upd(); })),
        field('Color', h('input', { type: 'color', value: a.color, oninput: (e) => { a.color = e.target.value; upd(); }, onchange: () => commit() }))),
      h('div', { class: 'row tight wrap' },
        btn('Flip', () => { a.lp = a.lp.map((x, i) => x - a.ld[i] * ((a.len || 20) + 2 * (a.gap ?? 1))); a.ld = a.ld.map((x) => -x); commit(); upd(); }, 'small', 'Reverse direction'),
        ...[['+X', [1, 0, 0]], ['−X', [-1, 0, 0]], ['+Y', [0, 1, 0]], ['−Y', [0, -1, 0]], ['+Z', [0, 0, 1]], ['−Z', [0, 0, -1]]].map(([n, d]) =>
          btn(n, () => { a.ld = worldDirToLocal(a.partId, d); commit(); upd(); }, 'small', 'Point along world ' + n))),
      h('div', { class: 'row' }, back, btn('Delete', () => { st.arrows = st.arrows.filter((x) => x !== a); app.selItem = null; commit(); upd(); renderInspector(); }, 'small danger')));
  }
}
function worldDirToLocal(partId, d) {
  const m = viewer.meshes.get(partId);
  if (!m) return d;
  const q = m.quaternion.clone().invert();
  return new THREE.Vector3(...d).applyQuaternion(q).toArray().map(r4);
}

function inspGuide(root) {
  const m = app.project.meta;
  root.append(h('h3', {}, 'Guide'),
    field('Title', inp(m.title, (v) => { m.title = v; renderOutline(); })),
    field('Subtitle', inp(m.subtitle, (v) => (m.subtitle = v))),
    h('div', { class: 'row tight' }, field('Author', inp(m.author, (v) => (m.author = v))), field('Version', inp(m.version, (v) => (m.version = v))), field('Date', inp(m.date, (v) => (m.date = v)))),
    field('Introduction', area(m.intro, (v) => (m.intro = v), { placeholder: 'Markdown. What is this, what will you build…' })),
    field('Requirements / tools', area(m.requirements, (v) => (m.requirements = v), { placeholder: '- Soldering iron for inserts\n- 2.5 mm hex key' })),
    field('Cover picture', select(m.coverStepId || '', [['', 'Last step (default)'], ...allSteps(app.project).map((s, i) => [s.id, `Step ${i + 1}: ${s.title}`])], (v) => { m.coverStepId = v || null; renderOutline(); })));
}

function inspHoleTypes(root) {
  const p = app.project;
  root.append(h('h3', {}, 'Hole types'),
    h('p', { class: 'muted small' }, 'Detected holes are matched top-to-bottom against these rules by shape, diameter (hex: across flats) and blind/through. First match wins.'));
  p.holeTypes.forEach((t, i) => {
    root.append(h('div', { class: 'htype' + (t.hidden ? ' off' : '') },
      h('div', { class: 'row tight' },
        h('input', { type: 'color', value: t.color, oninput: (e) => { t.color = e.target.value; viewer.refreshAllHoles(); }, onchange: () => commit() }),
        inp(t.name, (v) => (t.name = v), { class: 'grow strong' }),
        btn('↑', () => { if (i) { p.holeTypes.splice(i - 1, 0, p.holeTypes.splice(i, 1)[0]); commit(); renderInspector(); } }, 'mini'),
        btn(t.hidden ? '—' : '👁', () => { t.hidden = !t.hidden; viewer.refreshAllHoles(); commit(); renderInspector(); }, 'mini', 'Show/hide these markers'),
        btn('✕', () => { p.holeTypes.splice(i, 1); commit(); renderInspector(); }, 'mini')),
      h('div', { class: 'row tight' },
        select(t.shape, [['circle', 'Round'], ['hex', 'Hex'], ['any', 'Any']], (v) => (t.shape = v)),
        num(t.min, (v) => (t.min = v), { class: 'qty', title: 'min Ø' }), '–', num(t.max, (v) => (t.max = v), { class: 'qty', title: 'max Ø' }), 'mm',
        select(t.when, [['any', 'any'], ['blind', 'blind'], ['through', 'through']], (v) => (t.when = v))),
      inp(t.hardware, (v) => (t.hardware = v), { placeholder: 'Hardware name for BOM (e.g. M3 heat-set insert)' })));
  });
  const det = { ...DEFAULT_DETECT, ...(p.detect || {}) };
  root.append(h('div', { class: 'row wrap' },
    btn('+ Type', () => { p.holeTypes.push({ id: uid('t'), name: 'New type', color: '#e64980', hardware: '', shape: 'circle', min: 0, max: 0, when: 'any' }); commit(); renderInspector(); }, 'small'),
    btn('Re-classify all holes', () => { for (const pt of p.parts) for (const hh of pt.holes) if (!hh.manual) hh.type = classifyHole(hh, p.holeTypes); viewer.refreshAllHoles(); commit(); toast('Holes re-classified.'); }, 'small primary'),
    btn('Reset defaults', () => { if (confirm('Replace hole types with the defaults?')) { p.holeTypes = structuredClone(DEFAULT_HOLE_TYPES); commit(); renderInspector(); viewer.refreshAllHoles(); } }, 'small')),
    h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Detection'),
      h('div', { class: 'row tight' },
        field('Edge angle °', num(det.featureAngle, (v) => { p.detect = { ...det, featureAngle: v }; })),
        field('Min Ø', num(det.minD, (v) => { p.detect = { ...det, minD: v }; })),
        field('Max Ø', num(det.maxD, (v) => { p.detect = { ...det, maxD: v }; }))),
      btn('Re-detect holes on all parts', async () => { for (const pt of p.parts) await redetect(pt, true); commit(); toast('Done.'); }, 'small')));
}
async function redetect(pt, quiet = false) {
  busy(`Detecting holes on ${pt.name}…`);
  await tick();
  const manual = pt.holes.filter((x) => x.manual);
  const found = detectHoles(app.geoms.get(pt.geom), app.project.detect || {}).map((hh) => ({ ...hh, id: uid('h'), type: classifyHole(hh, app.project.holeTypes) }));
  // keep user-chosen types where a hole sits in the same place
  for (const f of found) {
    const old = pt.holes.find((o) => !o.manual && Math.hypot(o.c[0] - f.c[0], o.c[1] - f.c[1], o.c[2] - f.c[2]) < 0.05);
    if (old) { f.type = old.type; f.hidden = old.hidden; }
  }
  pt.holes = [...found, ...manual];
  busy();
  viewer.refreshHoles(pt.id);
  if (!quiet) { commit(); renderInspector(); renderParts(); toast(`${found.length} holes found on ${pt.name}.`); }
}

function inspExport(root) {
  const S = app.project.settings;
  const apply = () => { viewer.highlightColor = S.accent; viewer.showEdges = S.edges; viewer.autoHighlight = S.autoHighlight !== false; reapply(); };
  root.append(h('h3', {}, 'Export'),
    h('div', { class: 'col' },
      btn('Preview guide', preview, 'wide'),
      btn('Export PDF', doExportPDF, 'wide primary'),
      btn('Export Markdown (.zip with images)', () => doExportMD(false), 'wide'),
      btn('Export Markdown (single file, embedded images)', () => doExportMD(true), 'wide')),
    h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Layout'),
      h('div', { class: 'row tight' },
        field('Page', select(S.pageSize, [['a4', 'A4'], ['letter', 'US Letter']], (v) => (S.pageSize = v))),
        field('Steps per page', select(S.layout, [['one', '1'], ['two', '2']], (v) => (S.layout = v))),
        field('Text size', num(S.fontSize, (v) => (S.fontSize = v), { min: 7, max: 14 }))),
      field('Accent colour', h('input', { type: 'color', value: S.accent, oninput: (e) => { S.accent = e.target.value; apply(); }, onchange: () => commit() })),
      field('Footer text', inp(S.footer, (v) => (S.footer = v), { placeholder: 'Defaults to the guide title' })),
      check('Table of contents', S.toc, (v) => { S.toc = v; commit(); }),
      check('Hole legend', S.legend, (v) => { S.legend = v; commit(); }),
      check('Parts list with thumbnails', S.partsList, (v) => { S.partsList = v; commit(); })),
    h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Pictures'),
      h('div', { class: 'row tight' },
        field('Width px', num(S.renderW, (v) => { S.renderW = Math.round(v); viewer.setFrameAspect(S.renderW / S.renderH); })),
        field('Height px', num(S.renderH, (v) => { S.renderH = Math.round(v); viewer.setFrameAspect(S.renderW / S.renderH); })),
        field('Background', h('input', { type: 'color', value: S.bg, oninput: (e) => (S.bg = e.target.value), onchange: () => commit() }))),
      check('Outline edges', S.edges, (v) => { S.edges = v; apply(); commit(); }),
      check('Show grid in pictures', S.grid, (v) => { S.grid = v; commit(); }),
      check('Auto-highlight parts that are new in a step', S.autoHighlight !== false, (v) => { S.autoHighlight = v; apply(); commit(); })),
    h('div', { class: 'group' }, h('div', { class: 'group-h' }, 'Hole types used'),
      ...usedHoleTypes(app.project).map(({ t, n }) => h('div', { class: 'row tight' }, h('span', { class: 'ring', style: { borderColor: t.color } }), h('span', { class: 'grow' }, t.name), h('span', { class: 'muted' }, n)))));
}

// ====================================================================== stepbar & toolbar
function renderStepbar() {
  const steps = allSteps(app.project);
  const i = steps.findIndex((s) => s.id === app.stepId);
  $('#step-label').textContent = `Step ${i + 1} / ${steps.length}: ${steps[i]?.title || ''}`;
  $('#prev-step').disabled = i <= 0;
  $('#next-step').disabled = i >= steps.length - 1;
  $('#explode').value = steps[i]?.explode || 0;
  $('#holes-toggle').classList.toggle('on', steps[i]?.showHoles !== false);
}
function renderToolbarState() {
  $('#propagate').classList.toggle('on', app.propagate);
  $('#edges-toggle').classList.toggle('on', app.project.settings.edges);
}

// ====================================================================== parts ops
function duplicatePart(pt) {
  const np = structuredClone(pt);
  np.id = uid('p');
  np.holes.forEach((x) => (x.id = uid('h')));
  app.project.parts.push(np);
  for (const s of allSteps(app.project)) {
    const o = s.parts[pt.id];
    s.parts[np.id] = { ...structuredClone(o), p: [o.p[0] + 10, o.p[1] + 10, o.p[2]] };
  }
  viewer.syncParts(app.project, app.geoms);
  app.sel = [np.id];
  commit();
  goStep(app.stepId, { keepCamera: true });
}
function deletePart(pt) {
  if (!confirm(`Delete part "${pt.name}" from the whole guide?`)) return;
  app.project.parts = app.project.parts.filter((x) => x !== pt);
  for (const s of allSteps(app.project)) {
    delete s.parts[pt.id];
    s.callouts = s.callouts.filter((c) => c.partId !== pt.id);
    s.arrows = s.arrows.filter((a) => a.partId !== pt.id);
  }
  app.sel = [];
  viewer.syncParts(app.project, app.geoms);
  commit();
  goStep(app.stepId, { keepCamera: true });
}

// ====================================================================== export
function renderStepCanvas(st, w, h) {
  const S = app.project.settings;
  return viewer.snapshot(st, w || S.renderW, h || S.renderH, { bg: S.bg, grid: S.grid, newIds: newIdsFor(st) });
}
function exportCtx() {
  ensureStepParts();
  return {
    project: app.project, images: app.images,
    renderStep: (st, w, h) => renderStepCanvas(st, w, h),
    thumb: (id) => viewer.thumbnail(id, 320, { bg: '#ffffff' }),
  };
}
async function doExportPDF() {
  try {
    busy('Building PDF…');
    await tick();
    const blob = await exportPDF(exportCtx(), (m) => busy('Building PDF: ' + m));
    download(blob, fileSafe(app.project.meta.title) + '.pdf');
    toast('PDF exported.');
  } catch (e) { console.error(e); alert('PDF export failed: ' + e.message); } finally { busy(); goStep(app.stepId, { keepCamera: true }); }
}
async function doExportMD(embed) {
  try {
    busy('Building Markdown…');
    await tick();
    if (embed) {
      const { md } = await buildMarkdown(exportCtx(), { embed: true });
      download(new Blob([md], { type: 'text/markdown' }), fileSafe(app.project.meta.title) + '.md');
    } else {
      download(await exportMarkdownZip(exportCtx()), fileSafe(app.project.meta.title) + '_md.zip');
    }
    toast('Markdown exported.');
  } catch (e) { console.error(e); alert('Markdown export failed: ' + e.message); } finally { busy(); goStep(app.stepId, { keepCamera: true }); }
}
/** Interactive 3D guide: a copy of Guide Viewer (vendor/guide-viewer.html) with this project embedded as base64. */
async function doExportHTML() {
  try {
    busy('Building interactive HTML…');
    await tick();
    ensureStepParts();
    const r = await fetch('vendor/guide-viewer.html', { cache: 'no-store' });
    if (!r.ok) throw new Error('vendor/guide-viewer.html is missing. Copy guide-viewer.html from the Guide Viewer project into vendor/.');
    const tpl = await r.text();
    const slot = /(<script type="application\/x-guide\+base64" id="guide-data">)\s*(<\/script>)/;
    if (!slot.test(tpl)) throw new Error('vendor/guide-viewer.html has no guide-data slot. Update it to the latest Guide Viewer.');
    const zip = await saveProjectZip(app.project, app.geoms, app.images);
    const b64 = (await readDataURL(zip)).split(',')[1];
    const title = (app.project.meta.title || 'Assembly guide').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
    const html = tpl.replace(slot, (_, a, b) => a + b64 + b).replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
    download(new Blob([html], { type: 'text/html' }), fileSafe(app.project.meta.title) + '.html');
    toast(`Interactive HTML exported (${(html.length / 1048576).toFixed(1)} MB). It loads three.js from a CDN, so it needs internet.`, 5000);
  } catch (e) { console.error(e); alert('HTML export failed: ' + e.message); } finally { busy(); }
}
async function preview() {
  busy('Rendering preview…');
  await tick();
  try {
    const { md } = await buildMarkdown(exportCtx(), { embed: true });
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{font:15px/1.55 system-ui,Segoe UI,Arial,sans-serif;max-width:860px;margin:24px auto;padding:0 24px;color:#212529}
      img{max-width:100%;border:1px solid #dee2e6;border-radius:6px}td img{border:0}
      h1{font-size:2.1em}h2{border-bottom:3px solid ${app.project.settings.accent};padding-bottom:4px;margin-top:2em}
      h3{background:#f1f3f5;padding:6px 10px;border-left:5px solid ${app.project.settings.accent};margin-top:2em}
      blockquote{margin:10px 0;padding:8px 14px;background:#f8f9fa;border-left:4px solid ${app.project.settings.accent}}
      table{border-collapse:collapse}td,th{border:1px solid #dee2e6;padding:4px 10px}a{color:${app.project.settings.accent}}</style>${marked.parse(md)}`;
    openModal(h('div', { class: 'preview' },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, 'Preview (Markdown rendering — the PDF uses the same content)'), btn('Export PDF', () => { closeModal(); doExportPDF(); }, 'primary small'), btn('Close', closeModal, 'small')),
      h('iframe', { srcdoc: html })), true);
  } finally { busy(); goStep(app.stepId, { keepCamera: true }); }
}

// ====================================================================== project files
async function saveProject(as = false) {
  busy('Saving…');
  await tick();
  try {
    const blob = await saveProjectZip(app.project, app.geoms, app.images);
    const name = fileSafe(app.project.meta.title) + '.guide';
    if (window.showSaveFilePicker) {
      if (as || !app.fileHandle) {
        app.fileHandle = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'Guide project', accept: { 'application/zip': ['.guide'] } }] });
      }
      const w = await app.fileHandle.createWritable();
      await w.write(blob); await w.close();
    } else download(blob, name);
    toast('Project saved.');
  } catch (e) { if (e.name !== 'AbortError') alert('Save failed: ' + e.message); } finally { busy(); }
}
async function openProject(file, handle = null) {
  busy('Opening…');
  try {
    const { project, geoms, images } = await loadProjectZip(file);
    loadState(project, geoms, images);
    app.fileHandle = handle;
    toast(`Opened ${file.name}`);
  } catch (e) { alert('Could not open project: ' + e.message); } finally { busy(); }
}
function loadState(project, geoms, images, stepId) {
  app.project = migrate(project);
  app.geoms = geoms; app.images = images;
  app.geomDirty = true;
  app.sel = []; app.selHole = null; app.selItem = null;
  for (const m of [...viewer.meshes.keys()]) { viewer.root.remove(viewer.meshes.get(m)); viewer.meshes.delete(m); }
  viewer.geomCache.clear();
  viewer.syncParts(app.project, app.geoms);
  history.reset(JSON.stringify(app.project));
  goStep(stepId && findStep(app.project, stepId) ? stepId : allSteps(app.project)[0].id);
  if (!curStep().camera) viewer.view('iso');
  scheduleSave();
}
async function importMD(files) {
  const md = [...files].find((f) => /\.md$/i.test(f.name));
  if (!md) return;
  const imgs = new Map();
  for (const f of files) if (/\.(png|jpe?g|gif|webp)$/i.test(f.name)) imgs.set(f.name, await readDataURL(f));
  const { project, images } = importMarkdown(await md.text(), imgs);
  const replace = !app.project.parts.length || confirm('Replace the current guide text with the imported Markdown?\n\nOK = replace sections/steps (keeps your parts)\nCancel = append as new sections');
  if (replace) {
    const parts = app.project.parts;
    project.parts = parts;
    project.holeTypes = app.project.holeTypes;
    project.settings = app.project.settings;
    app.project = project;
  } else app.project.sections.push(...project.sections);
  for (const [k, v] of images) app.images.set(k, v);
  ensureStepParts();
  commit();
  goStep(allSteps(app.project)[0].id);
  toast(`Imported ${project.sections.length} section(s) from ${md.name}.`);
}

// ====================================================================== misc helpers
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const readDataURL = (f) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
function pickImages(cb) {
  const i = h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: async () => cb(await Promise.all([...i.files].map(readDataURL))) });
  i.click();
}
function openModal(content, wide = false) {
  const m = $('#modal');
  m.replaceChildren(h('div', { class: 'modal-box' + (wide ? ' wide' : '') }, content));
  m.hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modal').replaceChildren(); }
const fmt = (x) => (x == null ? '?' : Math.round(x * 100) / 100);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// ====================================================================== wire up static UI
function wire() {
  $('#btn-new').onclick = () => { if (confirm('Start a new, empty guide? (Save first if you need the current one.)')) { app.fileHandle = null; loadState(newProject(), new Map(), new Map()); } };
  $('#btn-open').onclick = async () => {
    if (window.showOpenFilePicker) {
      try {
        const [hd] = await showOpenFilePicker({ types: [{ description: 'Guide project', accept: { 'application/zip': ['.guide', '.zip'] } }] });
        openProject(await hd.getFile(), hd);
      } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
    } else $('#file-project').click();
  };
  $('#file-project').onchange = (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };
  $('#btn-save').onclick = () => saveProject(false);
  $('#btn-saveas').onclick = () => saveProject(true);
  $('#btn-stl').onclick = () => $('#file-stl').click();
  $('#file-stl').onchange = (e) => { importSTLFiles(e.target.files); e.target.value = ''; };
  $('#btn-md').onclick = () => $('#file-md').click();
  $('#file-md').onchange = (e) => { importMD(e.target.files); e.target.value = ''; };
  $('#undo').onclick = undo;
  $('#redo').onclick = redo;
  $('#btn-preview').onclick = preview;
  $('#btn-pdf').onclick = doExportPDF;
  $('#btn-mdx').onclick = () => doExportMD(false);
  $('#btn-html').onclick = doExportHTML;
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => { app.tab = b.dataset.tab; renderTabs(); renderInspector(); renderOutline(); }));
  document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => setMode(app.mode === b.dataset.mode ? 'select' : b.dataset.mode)));
  document.querySelectorAll('[data-gizmo]').forEach((b) => (b.onclick = () => {
    viewer.setGizmo(b.dataset.gizmo);
    document.querySelectorAll('[data-gizmo]').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('#space').onclick = (e) => { const loc = viewer.gizmo.space === 'local'; viewer.setGizmo(null, loc ? 'world' : 'local'); e.target.textContent = loc ? 'World' : 'Local'; };
  const snap = () => viewer.setSnap(+$('#snap-t').value, +$('#snap-r').value);
  $('#snap-t').onchange = snap; $('#snap-r').onchange = snap; snap();
  document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => viewer.view(b.dataset.view)));
  $('#fit').onclick = () => viewer.fit();
  $('#fit-sel').onclick = () => app.sel.length && viewer.fit(null, app.sel);
  $('#explode').oninput = (e) => { curStep().explode = +e.target.value; reapply(); };
  $('#explode').onchange = () => { commit(); if (app.tab === 'step') renderInspector(); };
  $('#holes-toggle').onclick = () => { const st = curStep(); st.showHoles = st.showHoles === false; commit(); reapply(); renderStepbar(); if (app.tab === 'step') renderInspector(); };
  $('#edges-toggle').onclick = () => { const S = app.project.settings; S.edges = !S.edges; viewer.showEdges = S.edges; viewer.updateLooks(); commit(); renderToolbarState(); };
  $('#propagate').onclick = () => { app.propagate = !app.propagate; renderToolbarState(); toast(app.propagate ? 'Changes carry forward into later steps (until a step differs).' : 'Changes affect this step only.'); };
  $('#grid-toggle').onclick = (e) => { viewer.grid.visible = !viewer.grid.visible; viewer.axes.visible = viewer.grid.visible; e.target.classList.toggle('on', viewer.grid.visible); viewer.dirty(); };
  $('#prev-step').onclick = () => stepOffset(-1);
  $('#next-step').onclick = () => stepOffset(1);
  $('#add-step').onclick = () => addStep();
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

  // drag & drop files
  const vp = $('#viewport');
  ['dragenter', 'dragover'].forEach((t) => document.addEventListener(t, (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); vp.classList.add('dropping'); } }));
  ['dragleave', 'drop'].forEach((t) => document.addEventListener(t, (e) => { if (t === 'dragleave' && e.relatedTarget) return; vp.classList.remove('dropping'); }));
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const proj = files.find((f) => /\.guide$/i.test(f.name));
    if (proj) return openProject(proj);
    if (files.some((f) => /\.md$/i.test(f.name))) return importMD(files);
    const imgs = files.filter((f) => /^image\//.test(f.type));
    if (imgs.length && !files.some((f) => MESH_RE.test(f.name))) {
      Promise.all(imgs.map(readDataURL)).then((urls) => { const st = curStep(); urls.forEach((u) => { const id = uid('i'); app.images.set(id, u); st.images.push(id); }); commit(); app.tab = 'step'; renderTabs(); renderInspector(); toast('Photo added to this step.'); });
      return;
    }
    importSTLFiles(files);
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(e.shiftKey); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateStep(app.stepId); return; }
    if (mod) return;
    const k = e.key.toLowerCase();
    if (k === 'w') $('[data-gizmo="translate"]').click();
    else if (k === 'e') $('[data-gizmo="rotate"]').click();
    else if (k === 'f') app.sel.length ? viewer.fit(null, app.sel) : viewer.fit();
    else if (k === 'escape') { setMode('select'); app.sel = []; app.selHole = null; app.selItem = null; viewer.selectedHole = null; viewer.refreshAllHoles(); viewer.setSelection([]); renderInspector(); renderParts(); }
    else if (k === 'pagedown' || (k === 'arrowright' && e.altKey)) stepOffset(1);
    else if (k === 'pageup' || (k === 'arrowleft' && e.altKey)) stepOffset(-1);
    else if (k === 'h') { app.sel.forEach((id) => setPartState(id, { v: false })); app.sel = []; commit(); reapply(); renderAll(); }
    else if (k === 'delete' || k === 'backspace') {
      const st = curStep();
      if (app.selItem) {
        st.callouts = st.callouts.filter((c) => c.id !== app.selItem.id);
        st.arrows = st.arrows.filter((a) => a.id !== app.selItem.id);
        app.selItem = null; commit(); reapply(); renderInspector();
      } else if (app.sel.length) { app.sel.forEach((id) => setPartState(id, { v: false })); app.sel = []; commit(); reapply(); renderAll(); toast('Hidden in this step (H). Delete a part from its inspector.'); }
    }
  });
  const hw = $('#hw-names');
  hw.replaceChildren(...[...new Set(app.project.holeTypes.map((t) => t.hardware).filter(Boolean).concat(['M3x6 screw', 'M3x8 screw', 'M3x10 screw', 'M3x12 screw', 'M3x16 screw', 'M2x6 screw', 'M3 washer']))].map((v) => h('option', { value: v })));
}

// ====================================================================== boot
async function boot() {
  wire();
  setMode('select');
  try {
    const saved = await idbGet('project');
    if (saved?.json) {
      const geoms = new Map((await idbGet('geoms')) || []);
      loadState(JSON.parse(saved.json), geoms, new Map(saved.images || []), saved.stepId);
      app.geomDirty = false;
      toast('Restored your last session.');
      return;
    }
  } catch (e) { console.warn('restore failed', e); }
  loadState(newProject(), new Map(), new Map());
  app.tab = 'guide';
  renderAll();
}
boot();
// handy for debugging from the browser console
window.__gb = { app, viewer, goStep, addStep, setPartState, commit, reapply, transformParts, mate, align, dropToBed, layFlat, rotateSel,
  doExportPDF, doExportMD, preview, setMode, renderAll, exportCtx };
window.__app = app;
