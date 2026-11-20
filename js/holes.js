// Automatic detection of cylindrical holes (screw holes, heat-set insert holes, nut traps) in a triangle mesh.
// Pure JS (no three.js) so it can be tested under Node.
//
// Method: find sharp "feature" edges, chain them into closed loops, keep loops that are planar and circular
// (or regular hexagons), decide from the adjacent wall faces whether the loop is a hole (wall normals point to
// the axis) or a boss, then pair an opening rim with the matching rim further along the axis to get depth and
// through/blind. Counterbores and chamfers are folded into the hole they belong to.

import { weld } from './stl.js';

export const DEFAULT_DETECT = {
  featureAngle: 35, // degrees between face normals for an edge to count as sharp
  minD: 1.0,
  maxD: 30,
  circularity: 0.06, // max radial deviation / r
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export function detectHoles(positions, opts = {}) {
  const o = { ...DEFAULT_DETECT, ...opts };
  const { verts, idx } = weld(positions, 1e-4);
  const nTri = idx.length / 3;
  const nV = verts.length / 3;
  const V = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];

  // face normals + centroids
  const fn = new Float32Array(nTri * 3), fc = new Float32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const a = V(idx[t * 3]), b = V(idx[t * 3 + 1]), c = V(idx[t * 3 + 2]);
    const n = norm(cross(sub(b, a), sub(c, a)));
    fn.set(n, t * 3);
    fc.set([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3], t * 3);
  }
  const FN = (t) => [fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]];
  const FC = (t) => [fc[t * 3], fc[t * 3 + 1], fc[t * 3 + 2]];

  // edges -> faces
  const first = new Map();
  const edges = []; // {a,b,t1,t2}
  for (let t = 0; t < nTri; t++) {
    for (let k = 0; k < 3; k++) {
      let a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      if (a > b) [a, b] = [b, a];
      const key = a * nV + b;
      const f = first.get(key);
      if (f === undefined) first.set(key, t);
      else if (f >= 0) { edges.push({ a, b, t1: f, t2: t }); first.set(key, -1); }
    }
  }
  const cosT = Math.cos((o.featureAngle * Math.PI) / 180);
  const feat = edges.filter((e) => dot(FN(e.t1), FN(e.t2)) < cosT);
  const adj = new Map();
  feat.forEach((e, i) => {
    for (const v of [e.a, e.b]) { let l = adj.get(v); if (!l) adj.set(v, (l = [])); l.push(i); }
  });

  // chain feature edges into loops
  const used = new Uint8Array(feat.length);
  const loops = [];
  for (let s = 0; s < feat.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const start = feat[s].a;
    let cur = feat[s].b, prevV = start, curE = s;
    const chain = [s];
    const visited = new Set([start, cur]);
    let ok = false;
    for (let step = 0; step < 720; step++) {
      const dCur = norm(sub(V(cur), V(prevV)));
      const eCur = feat[curE];
      const nA = FN(eCur.t1), nB = FN(eCur.t2);
      let best = -1, bestScore = -Infinity, closes = -1;
      for (const ei of adj.get(cur) || []) {
        if (ei === curE || used[ei]) continue;
        const e = feat[ei];
        const nxt = e.a === cur ? e.b : e.a;
        const dN = norm(sub(V(nxt), V(cur)));
        // smooth continuation + bonus for sharing a face plane with the current edge (the flat cap)
        const m1 = FN(e.t1), m2 = FN(e.t2);
        const share = Math.max(dot(nA, m1), dot(nA, m2), dot(nB, m1), dot(nB, m2)) > 0.999 ? 0.5 : 0;
        const score = dot(dCur, dN) + share;
        if (nxt === start) { if (score > bestScore - 0.25) closes = ei; }
        if (visited.has(nxt) && nxt !== start) continue;
        if (score > bestScore) { bestScore = score; best = ei; }
      }
      if (closes >= 0 && chain.length >= 4) { chain.push(closes); ok = true; break; }
      if (best < 0) break;
      const e = feat[best];
      const nxt = e.a === cur ? e.b : e.a;
      chain.push(best);
      used[best] = 1;
      prevV = cur; cur = nxt; curE = best;
      if (cur === start) { ok = true; break; }
      visited.add(cur);
    }
    if (ok) {
      for (const ei of chain) used[ei] = 1;
      loops.push(chain);
    } else {
      for (let i = 1; i < chain.length; i++) used[chain[i]] = 0;
    }
  }

  // evaluate loops
  const rims = [];
  for (const chain of loops) {
    const rim = evalLoop(chain);
    if (rim) rims.push(rim);
  }

  function evalLoop(chain) {
    // ordered vertex list
    const vs = [];
    let prev = null;
    const e0 = feat[chain[0]], e1 = feat[chain[1]];
    let cur = e1.a === e0.a || e1.b === e0.a ? e0.b : e0.a; // start at the vertex not shared with e1
    for (const ei of chain) {
      const e = feat[ei];
      vs.push(cur);
      cur = e.a === cur ? e.b : e.a;
    }
    const n = vs.length;
    if (n < 6 || n > 720) return null;
    const P = vs.map(V);
    // Newell normal
    let N = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n];
      N[0] += (a[1] - b[1]) * (a[2] + b[2]);
      N[1] += (a[2] - b[2]) * (a[0] + b[0]);
      N[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if (len(N) < 1e-9) return null;
    N = norm(N);
    const cen = scale(P.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / n);
    // basis
    const ref = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const U = norm(cross(N, ref)), W = cross(N, U);
    const pts = P.map((p) => { const d = sub(p, cen); return [dot(d, U), dot(d, W), dot(d, N)]; });
    // Kasa circle fit
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
    for (const [x, y] of pts) {
      const z = x * x + y * y;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
    }
    const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    const rhs = [sxz, syz, sz];
    const sol = solve3(M, rhs);
    if (!sol) return null;
    const cx = sol[0] / 2, cy = sol[1] / 2;
    const r = Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy));
    if (!(r > 0)) return null;
    const d = 2 * r;
    if (d < o.minD || d > o.maxD) return null;
    let maxDev = 0, maxPlane = 0;
    const angs = [];
    for (const [x, y, z] of pts) {
      maxDev = Math.max(maxDev, Math.abs(Math.hypot(x - cx, y - cy) - r));
      maxPlane = Math.max(maxPlane, Math.abs(z));
      angs.push(Math.atan2(y - cy, x - cx));
    }
    if (maxPlane > 0.02 * r + 0.01) return null;
    if (maxDev > o.circularity * r + 0.005) return null;
    angs.sort((a, b) => a - b);
    let gap = angs[0] + 2 * Math.PI - angs[n - 1];
    for (let i = 1; i < n; i++) gap = Math.max(gap, angs[i] - angs[i - 1]);
    if (gap > (100 * Math.PI) / 180) return null;
    const c = add(cen, add(scale(U, cx), scale(W, cy)));

    // hole vs boss, direction into the hole, and opening vs floor
    let holeVotes = 0, into = 0, capDot = 0, cnt = 0;
    for (const ei of chain) {
      const e = feat[ei];
      const n1 = FN(e.t1), n2 = FN(e.t2);
      const [tw, tc] = Math.abs(dot(n1, N)) < Math.abs(dot(n2, N)) ? [e.t1, e.t2] : [e.t2, e.t1];
      const mid = scale(add(V(e.a), V(e.b)), 0.5);
      let radial = sub(mid, c);
      radial = norm(sub(radial, scale(N, dot(radial, N))));
      const nw = FN(tw);
      if (dot(nw, radial) < -0.2) holeVotes++;
      const side = dot(sub(FC(tw), c), N);
      into += Math.sign(side);
      cnt++;
      capDot += dot(FN(tc), N);
    }
    if (holeVotes < 0.7 * cnt) return null;
    const dirInto = into >= 0 ? N : scale(N, -1);
    const cd = (capDot / cnt) * (into >= 0 ? 1 : -1);
    const kind = cd > 0.3 ? 'floor' : 'open';
    // regular hexagon?
    let shape = 'circle';
    if (n === 6) {
      const L = P.map((p, i) => len(sub(P[(i + 1) % 6], p)));
      const avg = L.reduce((a, b) => a + b, 0) / 6;
      if (L.every((l) => Math.abs(l - avg) < 0.03 * avg)) shape = 'hex';
    }
    return { c, N, dirInto, r, kind, shape, n };
  }

  // pair rims into holes
  const coax = (A, B) => {
    if (Math.abs(dot(A.N, B.N)) < 0.995) return false;
    const d = sub(B.c, A.c);
    const off = len(sub(d, scale(A.N, dot(d, A.N))));
    return off < Math.max(0.05, 0.05 * A.r);
  };
  const sameR = (A, B) => Math.abs(A.r - B.r) < Math.max(0.05, 0.04 * A.r);
  const consumed = new Set();
  const segs = [];
  const opens = rims.filter((r) => r.kind === 'open');
  for (const A of opens) {
    if (consumed.has(A)) continue;
    let best = null, bestT = Infinity;
    for (const B of rims) {
      if (B === A || consumed.has(B) || !sameR(A, B) || !coax(A, B)) continue;
      const t = dot(sub(B.c, A.c), A.dirInto);
      if (t > 0.01 && dot(B.dirInto, A.dirInto) < 0 && t < bestT) { best = B; bestT = t; }
    }
    consumed.add(A);
    if (best) consumed.add(best);
    segs.push({
      A, B: best,
      c: A.c, a: scale(A.dirInto, -1), // a = outward axis (points out of the hole opening)
      d: 2 * A.r, depth: best ? bestT : null,
      through: best ? best.kind === 'open' : false,
      shape: A.shape,
    });
  }

  // fold counterbores / chamfers into the hole they lead into
  const removed = new Set();
  for (const X of segs) {
    if (X.shape === 'hex') continue;
    let done = false;
    for (const Y of segs) {
      if (done) break;
      if (X === Y || removed.has(Y) || Y.d >= X.d - 0.1 || !coax(X.A, Y.A)) continue;
      // a through hole may have been traced from either end: try both
      const ends = [{ c: Y.c, a: Y.a }];
      if (Y.through && Y.B) ends.push({ c: Y.B.c, a: scale(Y.a, -1) });
      for (const end of ends) {
        if (dot(X.a, end.a) < 0.99) continue;
        const t = dot(sub(end.c, X.c), scale(X.a, -1)); // how far below X's opening Y starts
        if (t < -0.01) continue;
        if (X.B && X.B.kind === 'floor' && Math.abs(t - X.depth) < 0.08) {
          Y.cb = { d: X.d, depth: X.depth };
        } else if (!X.B && t < (X.d - Y.d) + 0.5) {
          Y.csk = X.d;
        } else continue;
        Y.c = X.c;
        Y.a = X.a;
        if (Y.depth != null) Y.depth += t;
        removed.add(X);
        done = true;
        break;
      }
    }
  }

  return segs.filter((s) => !removed.has(s)).map((s, i) => ({
    id: 'h' + i,
    c: s.c.map(round4), a: s.a.map(round4),
    d: round4(s.shape === 'hex' ? s.d * Math.cos(Math.PI / 6) : s.d), // hex: across flats
    depth: s.depth == null ? null : round4(s.depth),
    through: s.through,
    shape: s.shape,
    cb: s.cb ? { d: round4(s.cb.d), depth: round4(s.cb.depth) } : null,
    csk: s.csk ? round4(s.csk) : null,
  }));
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

function solve3(M, b) {
  const A = M.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    if (Math.abs(A[p][i]) < 1e-12) return null;
    [A[i], A[p]] = [A[p], A[i]];
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = A[k][i] / A[i][i];
      for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

// ---------------------------------------------------------------- classification

export const DEFAULT_HOLE_TYPES = [
  { id: 'ins-m2', name: 'Heat-set insert M2', color: '#e8590c', hardware: 'M2 heat-set insert', shape: 'circle', min: 3.0, max: 3.6, when: 'blind' },
  { id: 'ins-m3', name: 'Heat-set insert M3', color: '#f08c00', hardware: 'M3 heat-set insert', shape: 'circle', min: 3.8, max: 4.8, when: 'blind' },
  { id: 'ins-m4', name: 'Heat-set insert M4', color: '#d9480f', hardware: 'M4 heat-set insert', shape: 'circle', min: 5.3, max: 6.0, when: 'blind' },
  { id: 'tap-m2', name: 'M2 screw (self-tap)', color: '#5c940d', hardware: 'M2 screw', shape: 'circle', min: 1.5, max: 2.05, when: 'any' },
  { id: 'clr-m2', name: 'M2 clearance', color: '#2f9e44', hardware: 'M2 screw', shape: 'circle', min: 2.1, max: 2.45, when: 'any' },
  { id: 'tap-m3', name: 'M3 screw (self-tap)', color: '#1971c2', hardware: 'M3 screw', shape: 'circle', min: 2.46, max: 2.95, when: 'any' },
  { id: 'clr-m3', name: 'M3 clearance', color: '#1c7ed6', hardware: 'M3 screw', shape: 'circle', min: 3.0, max: 3.7, when: 'any' },
  { id: 'clr-m4', name: 'M4 clearance', color: '#3b5bdb', hardware: 'M4 screw', shape: 'circle', min: 4.1, max: 4.8, when: 'through' },
  { id: 'clr-m5', name: 'M5 clearance', color: '#5f3dc4', hardware: 'M5 screw', shape: 'circle', min: 5.1, max: 5.8, when: 'through' },
  { id: 'nut-m2', name: 'M2 nut trap', color: '#c2255c', hardware: 'M2 hex nut', shape: 'hex', min: 3.9, max: 4.6, when: 'any' },
  { id: 'nut-m3', name: 'M3 nut trap', color: '#a61e4d', hardware: 'M3 hex nut', shape: 'hex', min: 5.4, max: 6.5, when: 'any' },
  { id: 'nut-m4', name: 'M4 nut trap', color: '#862e9c', hardware: 'M4 hex nut', shape: 'hex', min: 6.9, max: 7.7, when: 'any' },
  { id: 'other', name: 'Other hole', color: '#868e96', hardware: '', shape: 'any', min: 0, max: 999, when: 'any' },
];

/** First matching type id for a detected hole, or null. */
export function classifyHole(h, types) {
  for (const t of types) {
    if (t.shape !== 'any' && t.shape !== h.shape) continue;
    if (t.when === 'blind' && (h.through || h.depth == null)) continue;
    if (t.when === 'through' && !h.through) continue;
    if (h.d >= t.min && h.d <= t.max) return t.id;
  }
  return null;
}
