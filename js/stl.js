// STL parsing, vertex welding, and splitting into connected parts.
// Pure JS (no three.js) so it can be tested under Node.

/** Parse binary or ASCII STL. Returns [{name, positions: Float32Array}] (9 floats per triangle).
 *  ASCII files with several `solid ... endsolid` blocks yield one entry per block. */
export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 84) {
    const dv = new DataView(buffer);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length) return [parseBinary(dv, n)];
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (head.startsWith('solid')) {
    const text = new TextDecoder().decode(bytes);
    if (/facet\s+normal/i.test(text)) return parseASCII(text);
  }
  // Fall back to binary even if the size does not match exactly (some exporters pad).
  const dv = new DataView(buffer);
  const n = Math.min(dv.getUint32(80, true), Math.floor((bytes.length - 84) / 50));
  return [parseBinary(dv, n)];
}

function parseBinary(dv, n) {
  const pos = new Float32Array(n * 9);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) { pos[i * 9 + k] = dv.getFloat32(o, true); o += 4; }
    o += 2;
  }
  return { name: '', positions: pos };
}

function parseASCII(text) {
  const solids = [];
  const solidRe = /solid\s*([^\r\n]*)([\s\S]*?)endsolid/g;
  const vRe = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  let m;
  while ((m = solidRe.exec(text))) {
    const arr = [];
    let v;
    vRe.lastIndex = 0;
    while ((v = vRe.exec(m[2]))) arr.push(+v[1], +v[2], +v[3]);
    const len = arr.length - (arr.length % 9);
    if (len) solids.push({ name: m[1].trim(), positions: Float32Array.from(arr.slice(0, len)) });
  }
  if (!solids.length) { // no endsolid: treat whole file as one
    const arr = [];
    let v;
    while ((v = vRe.exec(text))) arr.push(+v[1], +v[2], +v[3]);
    solids.push({ name: '', positions: Float32Array.from(arr.slice(0, arr.length - (arr.length % 9))) });
  }
  return solids;
}

/** Weld identical vertices. Returns {verts: Float32Array, idx: Uint32Array}. */
export function weld(positions, tol = 1e-4) {
  const map = new Map();
  const verts = [];
  const nTri = positions.length / 9;
  const idx = new Uint32Array(nTri * 3);
  const inv = 1 / tol;
  for (let i = 0; i < nTri * 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let id = map.get(key);
    if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(x, y, z); }
    idx[i] = id;
  }
  return { verts: Float32Array.from(verts), idx };
}

/** Signed volume of a triangle set (positive for outward-facing closed shells). */
export function signedVolume(positions) {
  let v = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function bbox(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const c = positions[i + k];
      if (c < min[k]) min[k] = c;
      if (c > max[k]) max[k] = c;
    }
  }
  return { min, max };
}

/** Split a triangle soup into connected shells. Inner void shells (negative volume, enclosed in
 *  another shell's bounding box) are merged back into their enclosing shell. Returns array of Float32Array. */
export function splitParts(positions) {
  const { idx } = weld(positions);
  const nTri = idx.length / 3;
  const nV = idx.reduce((a, b) => (b > a ? b : a), 0) + 1;
  const parent = new Int32Array(nV).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let t = 0; t < nTri; t++) {
    const a = find(idx[t * 3]), b = find(idx[t * 3 + 1]), c = find(idx[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== find(c)) parent[find(c)] = a2;
  }
  const groups = new Map();
  for (let t = 0; t < nTri; t++) {
    const r = find(idx[t * 3]);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(t);
  }
  let shells = [...groups.values()].map((tris) => {
    const p = new Float32Array(tris.length * 9);
    tris.forEach((t, i) => p.set(positions.subarray(t * 9, t * 9 + 9), i * 9));
    return { p, vol: signedVolume(p), box: bbox(p) };
  });
  if (shells.length === 1) return [positions];
  // merge inner voids
  const outer = shells.filter((s) => s.vol >= 0);
  const voids = shells.filter((s) => s.vol < 0);
  const merged = outer.map((s) => ({ ...s, extra: [] }));
  for (const v of voids) {
    let best = null, bestVol = Infinity;
    for (const o of merged) {
      if (contains(o.box, v.box) && o.vol < bestVol) { best = o; bestVol = o.vol; }
    }
    if (best) best.extra.push(v.p); else merged.push({ ...v, extra: [] });
  }
  return merged.map((s) => {
    if (!s.extra.length) return s.p;
    const total = s.p.length + s.extra.reduce((a, e) => a + e.length, 0);
    const out = new Float32Array(total);
    out.set(s.p, 0);
    let o = s.p.length;
    for (const e of s.extra) { out.set(e, o); o += e.length; }
    return out;
  });
}

function contains(a, b) {
  for (let k = 0; k < 3; k++) if (b.min[k] < a.min[k] - 1e-3 || b.max[k] > a.max[k] + 1e-3) return false;
  return true;
}

/** Write binary STL from triangle positions. */
export function writeBinarySTL(positions, name = 'part') {
  const n = positions.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const hdr = new TextEncoder().encode(('guide-builder ' + name).slice(0, 79));
  new Uint8Array(buf).set(hdr, 0);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    const ux = positions[b + 3] - positions[b], uy = positions[b + 4] - positions[b + 1], uz = positions[b + 5] - positions[b + 2];
    const vx = positions[b + 6] - positions[b], vy = positions[b + 7] - positions[b + 1], vz = positions[b + 8] - positions[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, positions[b + k], true); o += 4; }
    o += 2;
  }
  return buf;
}
