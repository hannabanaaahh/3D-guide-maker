// 3MF reader. Handles the core spec (meshes, components, build items, units, transforms) plus the
// extensions slicers use:
//  - Production extension (p:path): Bambu Studio / Orca keep meshes in 3D/Objects/*.model
//  - Bambu/Orca Metadata/model_settings.config: object + part names, part subtype (modifiers are skipped),
//    extruder -> filament colour from Metadata/project_settings.config
//  - PrusaSlicer Metadata/Slic3r_PE_model.config: one mesh split into named volumes by triangle ranges
//  - basematerials / colorgroup display colours
// Returns [{name, object, positions: Float32Array (world coords, mm), color: '#rrggbb' | null}]
// Pure JS apart from the JSZip instance passed in, so it runs in the browser and under Node.

const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export async function parse3MF(buffer, JSZip) {
  const zip = await JSZip.loadAsync(buffer);
  const files = new Map();
  for (const name of Object.keys(zip.files)) files.set('/' + name.replace(/^\/+/, '').toLowerCase(), name);
  const read = async (path) => {
    const real = files.get('/' + path.replace(/^\/+/, '').toLowerCase());
    return real ? zip.file(real).async('string') : null;
  };

  // root model from the package relationships
  let rootPath = '/3D/3dmodel.model';
  const rels = await read('_rels/.rels');
  if (rels) {
    for (const tag of tags(rels, 'Relationship')) {
      const a = attrs(tag);
      if (/3dmodel$/i.test(a.Type || '') && a.Target) rootPath = '/' + a.Target.replace(/^\/+/, '');
    }
  }

  // ---- slicer metadata
  const bambu = parseBambuConfig(await read('Metadata/model_settings.config'));
  const prusa = parsePrusaConfig(await read('Metadata/Slic3r_PE_model.config'));
  let filamentColors = [];
  const proj = await read('Metadata/project_settings.config');
  if (proj) { try { filamentColors = JSON.parse(proj).filament_colour || []; } catch { /* not JSON */ } }

  // ---- model documents (parsed lazily, cached)
  const docs = new Map();
  async function doc(path) {
    const key = path.toLowerCase();
    if (docs.has(key)) return docs.get(key);
    const xml = await read(path);
    if (xml == null) throw new Error(`3MF: missing model part ${path}`);
    const d = parseModel(xml);
    docs.set(key, d);
    return d;
  }

  const root = await doc(rootPath);
  const bodies = [];

  async function emit(path, objectId, T, ctx, depth = 0) {
    if (depth > 16) return;
    const d = await doc(path);
    const obj = d.objects.get(objectId);
    if (!obj) return;
    const scale = d.scale;
    if (obj.mesh) {
      const partInfo = ctx.bambu?.parts.get(objectId) || (ctx.bambu && ctx.bambu.parts.size === 1 && depth === 0 ? [...ctx.bambu.parts.values()][0] : null);
      if (partInfo && partInfo.subtype && partInfo.subtype !== 'normal_part') return; // modifier / negative / support volumes
      const extruder = partInfo?.extruder || ctx.bambu?.extruder;
      const color = (extruder && filamentColors[extruder - 1]) || obj.color || ctx.color || null;
      const volumes = depth === 0 && ctx.prusa?.volumes?.length ? ctx.prusa.volumes : null;
      if (volumes) {
        for (const v of volumes) {
          if (v.type && v.type !== 'ModelPart') continue;
          const pos = meshPositions(obj.mesh, T, scale, v.first, v.last);
          if (pos.length) bodies.push({ name: v.name || ctx.name, object: ctx.name, positions: pos, color: v.extruder && filamentColors[v.extruder - 1] || color });
        }
      } else {
        const pos = meshPositions(obj.mesh, T, scale);
        if (pos.length) bodies.push({ name: partInfo?.name || obj.name || ctx.name, object: ctx.name, positions: pos, color });
      }
    }
    for (const c of obj.components) {
      const cPath = c.path ? '/' + c.path.replace(/^\/+/, '') : path;
      await emit(cPath, c.objectid, mul(c.transform, T), { ...ctx, color: obj.color || ctx.color }, depth + 1);
    }
  }

  let items = root.items;
  if (!items.length) items = [...root.objects.keys()].map((id) => ({ objectid: id, transform: IDENTITY }));
  let n = 0;
  for (const it of items) {
    if (it.printable === '0' && items.length > 1) continue;
    const obj = root.objects.get(it.objectid);
    const b = bambu.get(it.objectid);
    const pr = prusa.get(it.objectid);
    const name = b?.name || pr?.name || obj?.name || `object_${++n}`;
    await emit(rootPath, it.objectid, it.transform, { name, bambu: b, prusa: pr });
  }
  // name copies of the same object distinctly
  const seen = new Map();
  for (const b of bodies) {
    const k = b.name;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const idx = new Map();
  for (const b of bodies) if (seen.get(b.name) > 1) { const i = (idx.get(b.name) || 0) + 1; idx.set(b.name, i); b.name = `${b.name} (${i})`; }
  return bodies;
}

// ------------------------------------------------------------------ model XML
function parseModel(xml) {
  const head = /<(?:\w+:)?model\b([^>]*)>/.exec(xml);
  const unit = head ? attrs(head[1]).unit : null;
  const scale = UNITS[unit] || 1;

  // colour resources: basematerials and colorgroups
  const colorRes = new Map();
  for (const m of xml.matchAll(/<(?:\w+:)?basematerials\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?basematerials>/g)) {
    const id = attrs(m[1]).id;
    colorRes.set(id, tags(m[2], 'base').map((t) => hex(attrs(t).displaycolor)));
  }
  for (const m of xml.matchAll(/<(?:\w+:)?colorgroup\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?colorgroup>/g)) {
    const id = attrs(m[1]).id;
    colorRes.set(id, tags(m[2], 'color').map((t) => hex(attrs(t).color)));
  }

  const objects = new Map();
  const objRe = /<(?:\w+:)?object\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const a = attrs(m[1]);
    let body = '';
    if (!m[2]) {
      const end = xml.indexOf('</', objRe.lastIndex) >= 0 ? findClose(xml, objRe.lastIndex, 'object') : -1;
      body = end > 0 ? xml.slice(objRe.lastIndex, end) : '';
      if (end > 0) objRe.lastIndex = end;
    }
    const o = { id: a.id, name: a.name || '', type: a.type || 'model', mesh: null, components: [], color: null };
    if (a.pid && colorRes.has(a.pid)) o.color = colorRes.get(a.pid)[+(a.pindex || 0)] || null;
    const meshStart = body.search(/<(?:\w+:)?mesh\b/);
    if (meshStart >= 0) o.mesh = parseMesh(body.slice(meshStart));
    for (const t of tags(body, 'component')) {
      const c = attrs(t);
      o.components.push({ objectid: c.objectid, path: c['p:path'] || c.path || null, transform: parseT(c.transform) });
    }
    if (o.type === 'support' || o.type === 'other') { o.mesh = null; o.components = []; }
    objects.set(o.id, o);
  }
  const items = [];
  const build = /<(?:\w+:)?build\b[^>]*>([\s\S]*?)<\/(?:\w+:)?build>/.exec(xml);
  if (build) for (const t of tags(build[1], 'item')) {
    const a = attrs(t);
    items.push({ objectid: a.objectid, transform: parseT(a.transform), printable: a.printable });
  }
  return { scale, objects, items };
}

function findClose(xml, from, name) {
  // objects do not nest, so the first closing tag is ours
  const re = new RegExp(`</(?:\\w+:)?${name}>`, 'g');
  re.lastIndex = from;
  const m = re.exec(xml);
  return m ? m.index : -1;
}

function parseMesh(s) {
  const vEnd = s.search(/<\/(?:\w+:)?vertices>/);
  const vPart = s.slice(0, vEnd < 0 ? s.length : vEnd);
  const tPart = vEnd < 0 ? '' : s.slice(vEnd);
  const verts = [];
  const vRe = /<(?:\w+:)?vertex\b([^>]*)\/?>/g;
  let m;
  while ((m = vRe.exec(vPart))) {
    const a = m[1];
    verts.push(num(a, 'x'), num(a, 'y'), num(a, 'z'));
  }
  const tris = [];
  const tRe = /<(?:\w+:)?triangle\b([^>]*)\/?>/g;
  while ((m = tRe.exec(tPart))) {
    const a = m[1];
    tris.push(num(a, 'v1'), num(a, 'v2'), num(a, 'v3'));
  }
  return { verts: Float64Array.from(verts), tris: Uint32Array.from(tris) };
}

function meshPositions(mesh, T, scale, first = 0, last = Infinity) {
  const { verts, tris } = mesh;
  const nT = tris.length / 3;
  const a = Math.max(0, first), b = Math.min(nT - 1, last);
  if (b < a) return new Float32Array(0);
  const out = new Float32Array((b - a + 1) * 9);
  let o = 0;
  for (let t = a; t <= b; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = tris[t * 3 + k] * 3;
      const x = verts[vi], y = verts[vi + 1], z = verts[vi + 2];
      out[o++] = (x * T[0] + y * T[3] + z * T[6] + T[9]) * scale;
      out[o++] = (x * T[1] + y * T[4] + z * T[7] + T[10]) * scale;
      out[o++] = (x * T[2] + y * T[5] + z * T[8] + T[11]) * scale;
    }
  }
  return out;
}

// 3MF transforms are 3x4 row-vector matrices: p' = p * M  ("m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32")
function parseT(s) {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY;
}
/** Apply A then B. */
function mul(A, B) {
  const r = new Array(12);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j] + (i === 3 ? B[9 + j] : 0);
    }
  }
  return r;
}

// ------------------------------------------------------------------ slicer configs
function parseBambuConfig(xml) {
  const out = new Map();
  if (!xml) return out;
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attrs(m[1]).id;
    const body = m[2];
    const head = body.split(/<part\b/)[0];
    const o = { name: meta(head, 'name'), extruder: +meta(head, 'extruder') || 0, parts: new Map() };
    for (const p of body.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g)) {
      const pa = attrs(p[1]);
      o.parts.set(pa.id, { name: meta(p[2], 'name'), subtype: pa.subtype || 'normal_part', extruder: +meta(p[2], 'extruder') || 0 });
    }
    out.set(id, o);
  }
  return out;
}
function parsePrusaConfig(xml) {
  const out = new Map();
  if (!xml) return out;
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attrs(m[1]).id;
    const volumes = [];
    for (const v of m[2].matchAll(/<volume\b([^>]*)>([\s\S]*?)<\/volume>/g)) {
      const a = attrs(v[1]);
      const typeMeta = meta(v[2], 'volume_type');
      const modifier = meta(v[2], 'modifier') === '1';
      volumes.push({ first: +a.firstid, last: +a.lastid, name: meta(v[2], 'name'), type: modifier ? 'ParameterModifier' : typeMeta || 'ModelPart', extruder: +meta(v[2], 'extruder') || 0 });
    }
    out.set(id, { name: meta(m[2].split(/<volume\b/)[0], 'name'), volumes });
  }
  return out;
}
const meta = (s, key) => {
  const m = new RegExp(`<metadata\\b[^>]*\\bkey="${key}"[^>]*\\bvalue="([^"]*)"`).exec(s);
  return m ? unescapeXml(m[1]) : '';
};

// ------------------------------------------------------------------ tiny XML helpers
function tags(s, name) {
  const re = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)\\/?>`, 'g');
  return [...s.matchAll(re)].map((m) => m[1]);
}
function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1]] = unescapeXml(m[2] ?? m[3]);
  return o;
}
function num(s, key) {
  const m = new RegExp(`\\b${key}\\s*=\\s*["']([^"']+)`).exec(s);
  return m ? +m[1] : 0;
}
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function hex(c) {
  if (!c) return null;
  const m = /^#?([0-9a-f]{6})/i.exec(c.trim());
  return m ? '#' + m[1].toLowerCase() : null;
}
