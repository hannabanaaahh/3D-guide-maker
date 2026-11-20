// Project data model, undo history, autosave (IndexedDB), project files (.guide zip) and Markdown import.
import { DEFAULT_HOLE_TYPES } from './holes.js';

export const uid = (p = 'x') => p + Math.random().toString(36).slice(2, 9);

export const PALETTE = ['#4dabf7', '#ff922b', '#69db7c', '#f783ac', '#ffd43b', '#9775fa', '#3bc9db', '#ff6b6b', '#a9e34b', '#ced4da'];

export function newStep(title = 'New step') {
  return {
    id: uid('s'), title, text: '', notes: [], hardware: [], showHoles: true, explode: 0,
    camera: null, parts: {}, callouts: [], arrows: [], images: [], useRender: true,
  };
}

export function newProject() {
  return {
    version: 1,
    meta: {
      title: 'Assembly Guide', subtitle: '', author: '', version: '1.0',
      date: new Date().toISOString().slice(0, 10), intro: '', requirements: '', coverStepId: null,
    },
    settings: {
      pageSize: 'a4', layout: 'one', accent: '#1c7ed6', renderW: 1600, renderH: 1000, edges: true,
      bg: '#ffffff', grid: false, toc: true, legend: true, partsList: true, fontSize: 10, footer: '',
    },
    holeTypes: structuredClone(DEFAULT_HOLE_TYPES),
    parts: [],
    sections: [{ id: uid('c'), title: 'Assembly', intro: '', steps: [newStep('Step 1')] }],
  };
}

export const allSteps = (p) => p.sections.flatMap((s) => s.steps);
export function findStep(p, id) {
  for (const s of p.sections) {
    const i = s.steps.findIndex((x) => x.id === id);
    if (i >= 0) return { section: s, step: s.steps[i], index: i };
  }
  return null;
}
export function stepNumber(p, id) { return allSteps(p).findIndex((s) => s.id === id) + 1; }

/** Parts visible in this step that were not visible in the previous step. */
export function newPartsInStep(p, stepId) {
  const steps = allSteps(p);
  const i = steps.findIndex((s) => s.id === stepId);
  if (i < 0) return [];
  const prev = i > 0 ? steps[i - 1] : null;
  return p.parts.filter((pt) => {
    const s = steps[i].parts[pt.id];
    if (!s || !s.v || s.look === 'ghost') return false;
    const ps = prev && prev.parts[pt.id];
    return !ps || !ps.v || ps.look === 'ghost';
  });
}

/** Group parts by geometry+name for parts lists (copies of one STL count as qty). */
export function groupParts(parts) {
  const m = new Map();
  for (const pt of parts) {
    const k = pt.geom + '|' + pt.name;
    const g = m.get(k);
    if (g) g.qty++; else m.set(k, { part: pt, qty: 1 });
  }
  return [...m.values()];
}

/** Hardware suggested by holes of the given parts (counts per hole type with hardware text). */
export function hardwareFromHoles(project, parts) {
  const types = new Map(project.holeTypes.map((t) => [t.id, t]));
  const counts = new Map();
  for (const pt of parts) for (const h of pt.holes || []) {
    const t = types.get(h.type);
    if (!t || !t.hardware || h.hidden) continue;
    counts.set(t.hardware, (counts.get(t.hardware) || 0) + 1);
  }
  return [...counts].map(([name, qty]) => ({ qty, name }));
}

// ------------------------------------------------------------------ undo
export class History {
  constructor(limit = 120) { this.limit = limit; this.stack = []; this.redoStack = []; }
  reset(json) { this.stack = [json]; this.redoStack = []; }
  push(json) {
    if (this.stack[this.stack.length - 1] === json) return false;
    this.stack.push(json);
    if (this.stack.length > this.limit) this.stack.shift();
    this.redoStack = [];
    return true;
  }
  undo() {
    if (this.stack.length < 2) return null;
    this.redoStack.push(this.stack.pop());
    return this.stack[this.stack.length - 1];
  }
  redo() {
    const j = this.redoStack.pop();
    if (j) this.stack.push(j);
    return j || null;
  }
}

// ------------------------------------------------------------------ IndexedDB autosave
const DB = 'guide-builder', STORE = 'kv';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbPut(key, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
export async function idbGet(key) {
  const d = await db();
  return new Promise((res, rej) => {
    const r = d.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

// ------------------------------------------------------------------ project file (.guide = zip)
export async function saveProjectZip(project, geoms, images) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(project, null, 1));
  const usedG = new Set(project.parts.map((p) => p.geom));
  for (const [k, g] of geoms) if (usedG.has(k)) zip.file(`geom/${k}.bin`, g.buffer.slice(g.byteOffset, g.byteOffset + g.byteLength));
  const usedI = new Set(allSteps(project).flatMap((s) => s.images));
  for (const [k, url] of images) if (usedI.has(k)) zip.file(`images/${k}.txt`, url);
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
export async function loadProjectZip(file) {
  const zip = await JSZip.loadAsync(file);
  const project = migrate(JSON.parse(await zip.file('project.json').async('string')));
  const geoms = new Map(), images = new Map();
  for (const [path, f] of Object.entries(zip.files)) {
    if (path.startsWith('geom/') && path.endsWith('.bin')) geoms.set(path.slice(5, -4), new Float32Array(await f.async('arraybuffer')));
    if (path.startsWith('images/') && path.endsWith('.txt')) images.set(path.slice(7, -4), await f.async('string'));
  }
  return { project, geoms, images };
}
export function migrate(p) {
  const base = newProject();
  p.meta = { ...base.meta, ...p.meta };
  p.settings = { ...base.settings, ...p.settings };
  p.holeTypes = p.holeTypes || base.holeTypes;
  p.parts = p.parts || [];
  p.sections = p.sections?.length ? p.sections : base.sections;
  for (const st of allSteps(p)) Object.assign(st, { ...newStep(), ...st, id: st.id });
  return p;
}

// ------------------------------------------------------------------ Markdown import
/** Build sections/steps from a Markdown guide: '#' title, '##' sections, '###' steps.
 *  imageFiles: Map(filename -> dataURL) used to attach referenced images. */
export function importMarkdown(md, imageFiles = new Map()) {
  const p = newProject();
  p.sections = [];
  let sec = null, step = null, introBuf = [];
  const flush = (txt) => {
    if (step) step.text += txt;
    else if (sec) sec.intro += txt;
    else introBuf.push(txt);
  };
  const imgs = new Map();
  const lines = md.replace(/\r/g, '').split('\n');
  for (const line of lines) {
    let m;
    if ((m = /^#\s+(.*)/.exec(line)) && !p._titled) { p.meta.title = clean(m[1]); p._titled = true; continue; }
    if ((m = /^##\s+(.*)/.exec(line))) { sec = { id: uid('c'), title: clean(m[1]), intro: '', steps: [] }; p.sections.push(sec); step = null; continue; }
    if ((m = /^#{3,6}\s+(.*)/.exec(line))) {
      if (!sec) { sec = { id: uid('c'), title: 'Assembly', intro: '', steps: [] }; p.sections.push(sec); }
      step = newStep(clean(m[1]));
      sec.steps.push(step);
      continue;
    }
    const imgRe = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
    let im, rest = line;
    while ((im = imgRe.exec(line))) {
      const name = decodeURIComponent(im[1].split('/').pop());
      const data = imageFiles.get(name) || (im[1].startsWith('data:') ? im[1] : null);
      if (data && step) {
        const id = uid('i');
        imgs.set(id, data);
        step.images.push(id);
        step.useRender = false;
      }
      rest = rest.replace(im[0], '');
    }
    flush(rest + '\n');
  }
  delete p._titled;
  p.meta.intro = introBuf.join('').trim();
  for (const s of p.sections) { s.intro = s.intro.trim(); for (const st of s.steps) st.text = st.text.trim(); }
  if (!p.sections.length) p.sections = newProject().sections;
  for (const s of p.sections) if (!s.steps.length) s.steps.push(newStep('Step 1'));
  return { project: p, images: imgs };
}
const clean = (s) => s.replace(/\*\*|__|\\/g, '').replace(/\s*\{#.*\}$/, '').trim();
