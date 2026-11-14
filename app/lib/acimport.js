// Imports track limits from an original Assetto Corsa track folder. AC stores, for every
// 1.5 m of its AI line, the distance to the left and right edge of the track; AC Evo
// publishes nothing of the kind. The two games use different coordinates for the same
// circuit, so the AC line is first fitted onto our track model (rotation + shift), then
// the edges are expressed as lateral offsets along the model.
const fs = require('fs');
const path = require('path');
const { locate } = require('./track');

// ai/fast_lane.ai, version 7: header (4 x int32), then per point x y z length id (20 bytes),
// then a count and 18 floats per point: speed gas brake latG radius sideLeft sideRight ...
function parseFastLane(file) {
  const b = fs.readFileSync(file);
  const version = b.readInt32LE(0), n = b.readInt32LE(4);
  if (version !== 7 || n < 10 || b.length < 16 + n * 20 + 4 + n * 72) throw new Error('unsupported fast_lane.ai (version ' + version + ')');
  const extra = 16 + n * 20 + 4;
  if (b.readInt32LE(extra - 4) !== n) throw new Error('fast_lane.ai: point and detail counts differ');
  const out = { n, x: [], y: [], z: [], speed: [], left: [], right: [] };
  for (let i = 0; i < n; i++) {
    const p = 16 + i * 20, e = extra + i * 72;
    out.x.push(b.readFloatLE(p)); out.y.push(b.readFloatLE(p + 4)); out.z.push(b.readFloatLE(p + 8));
    out.speed.push(b.readFloatLE(e) * 3.6); out.left.push(b.readFloatLE(e + 20)); out.right.push(b.readFloatLE(e + 24));
  }
  return out;
}

// data/sections.ini: named stretches as fractions of the AI line.
function parseSections(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^\[SECTION_\d+\]/.test(line)) { cur = {}; out.push(cur); continue; }
    const m = /^(IN|OUT|TEXT)=(.*)$/.exec(line.trim());
    if (cur && m) cur[m[1].toLowerCase()] = m[1] === 'TEXT' ? m[2].trim() : Number(m[2]);
  }
  return out.filter(s => s.text && s.in >= 0 && s.out >= 0);
}

// Rigid fit of AC points onto the model: X = c*x - s*(m*z) + tx, Z = s*x + c*(m*z) + tz.
function fit(model, ai) {
  const apply = (T, x, z) => [T.c * x - T.s * (T.m * z) + T.tx, T.s * x + T.c * (T.m * z) + T.tz];
  const mean = arr => arr.reduce((p, q) => p + q, 0) / arr.length;
  const mIdx = []; for (let i = 0; i < model.n; i += 5) mIdx.push(i);
  const aIdx = []; for (let i = 0; i < ai.n; i += 3) aIdx.push(i);

  // Nearest AC point for each sampled model point; returns pairs and the distances.
  const pairs = (T, modelIdx, aiIdx) => {
    const ax = [], az = [];
    for (const i of aiIdx) { const [x, z] = apply(T, ai.x[i], ai.z[i]); ax.push(x); az.push(z); }
    const out = [];
    for (const i of modelIdx) {
      let best = -1, bd = Infinity;
      for (let k = 0; k < ax.length; k++) { const dx = ax[k] - model.x[i], dz = az[k] - model.z[i], d = dx * dx + dz * dz; if (d < bd) { bd = d; best = k; } }
      out.push({ i, k: aiIdx[best], d: Math.sqrt(bd) });
    }
    return out;
  };
  const median = arr => arr.slice().sort((p, q) => p - q)[arr.length >> 1];

  // Coarse search over rotation and mirroring, shifting centroid onto centroid.
  const cmx = mean(model.x), cmz = mean(model.z), cax = mean(ai.x);
  let best = null;
  const coarseM = mIdx.filter((_, k) => k % 6 === 0), coarseA = aIdx.filter((_, k) => k % 3 === 0);
  for (const m of [1, -1]) {
    const caz = mean(ai.z) * m;
    for (let deg = 0; deg < 360; deg += 3) {
      const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
      const T = { c, s, m, tx: cmx - (c * cax - s * caz), tz: cmz - (s * cax + c * caz) };
      const cost = median(pairs(T, coarseM, coarseA).map(p => p.d));
      if (!best || cost < best.cost) best = { T, cost };
    }
  }
  // Refine: repeatedly solve the best rotation + shift for the current nearest pairs,
  // leaving out pairs far beyond the typical distance (parts only one of the lines has).
  let T = best.T;
  for (let iter = 0; iter < 25; iter++) {
    const pr = pairs(T, mIdx, aIdx), lim = Math.max(3, 3 * median(pr.map(p => p.d)));
    const use = pr.filter(p => p.d <= lim);
    let ax = 0, az = 0, bx = 0, bz = 0;
    for (const p of use) { ax += ai.x[p.k]; az += T.m * ai.z[p.k]; bx += model.x[p.i]; bz += model.z[p.i]; }
    ax /= use.length; az /= use.length; bx /= use.length; bz /= use.length;
    let sxx = 0, sxz = 0;
    for (const p of use) {
      const ux = ai.x[p.k] - ax, uz = T.m * ai.z[p.k] - az, vx = model.x[p.i] - bx, vz = model.z[p.i] - bz;
      sxx += ux * vx + uz * vz; sxz += ux * vz - uz * vx;
    }
    const ang = Math.atan2(sxz, sxx), c = Math.cos(ang), s = Math.sin(ang);
    T = { c, s, m: T.m, tx: bx - (c * ax - s * az), tz: bz - (s * ax + c * az) };
  }
  const final = pairs(T, mIdx, aIdx.length ? Array.from({ length: ai.n }, (_, i) => i) : aIdx).map(p => p.d).sort((p, q) => p - q);
  return { T, apply: (x, z) => apply(T, x, z), median: final[final.length >> 1], p90: final[Math.floor(final.length * 0.9)], coarse: best.cost };
}

// AC's side distances are a sawtooth: they jump by a metre or more every 10-15 m (the game
// measures to pieces of the track mesh, not to a smooth line). A running median removes the
// teeth without rounding off real changes of width; a short average then removes the steps.
function smooth(arr) {
  const n = arr.length, med = new Array(n), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = arr.slice(Math.max(0, i - 10), Math.min(n, i + 11)).sort((p, q) => p - q);
    med[i] = w[w.length >> 1];
  }
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) { sum += med[k]; cnt++; }
    out[i] = sum / cnt;
  }
  return out;
}

// Edges, AI line and section names, both as map polylines and as lateral offsets on the
// track model's distance grid (for measuring how far a lap ran from each limit).
function importTrack(track, acDir) {
  const ai = parseFastLane(path.join(acDir, 'ai', 'fast_lane.ai'));
  const f = fit({ n: track.n, x: track.x, z: track.z }, ai);
  const sideL = smooth(ai.left), sideR = smooth(ai.right);

  // The AC line in our coordinates, and the two limits offset from it along its own normal.
  const P = [];
  for (let i = 0; i < ai.n; i++) P.push(f.apply(ai.x[i], ai.z[i]));
  const poly = { xA: [], zA: [], xL: [], zL: [], xR: [], zR: [] };
  for (let i = 0; i < ai.n; i++) {
    const a = P[Math.max(0, i - 2)], b = P[Math.min(ai.n - 1, i + 2)];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1, nx = -dz / len, nz = dx / len; // right-hand normal
    poly.xA.push(P[i][0]); poly.zA.push(P[i][1]);
    poly.xL.push(P[i][0] - nx * sideL[i]); poly.zL.push(P[i][1] - nz * sideL[i]);
    poly.xR.push(P[i][0] + nx * sideR[i]); poly.zR.push(P[i][1] + nz * sideR[i]);
  }

  // A polyline as lateral offset along the model: project its points, then interpolate
  // between neighbours onto the model's grid.
  const n = track.n, step = track.step;
  const along = [];
  const onGrid = (xs, zs, keep) => {
    // AC's line starts at its own start line, somewhere along our model, and runs past the
    // model's end back to that point: the projected distances come in two rising runs.
    // So the projections are simply sorted by distance along the model.
    const pairs = [];
    let hint = locate(track, xs[0], zs[0], -1).i;
    for (let i = 0; i < xs.length; i++) {
      const loc = locate(track, xs[i], zs[i], hint);
      if (loc.d2 > 100 * 100) continue;
      hint = loc.i;
      if (keep) along[i] = loc.s;
      pairs.push([loc.s, loc.lat]);
    }
    pairs.sort((p, q) => p[0] - q[0]);
    const S = pairs.map(p => p[0]), LAT = pairs.map(p => p[1]);
    const out = new Array(n).fill(null);
    for (let k = 0, j = 0; k < n; k++) {
      const s = k * step;
      while (j + 2 < S.length && S[j + 1] < s) j++;
      if (S.length < 2 || s < S[j] || s > S[j + 1] || S[j + 1] - S[j] > 12) continue;
      out[k] = LAT[j] + (LAT[j + 1] - LAT[j]) * (s - S[j]) / (S[j + 1] - S[j] || 1);
    }
    return out;
  };
  const line = onGrid(poly.xA, poly.zA, true), left = onGrid(poly.xL, poly.zL), right = onGrid(poly.xR, poly.zR);

  const sections = parseSections(path.join(acDir, 'data', 'sections.ini')).map(sec => {
    const at = frac => { let i = Math.round(frac * (ai.n - 1)); while (i < ai.n - 1 && along[i] === undefined) i++; return Math.round(along[i] || 0); };
    return { name: sec.text, from: at(sec.in), to: at(sec.out) };
  }).filter(sec => sec.to > sec.from);
  const r2 = v => (v === null ? null : Math.round(v * 100) / 100);
  for (const k of Object.keys(poly)) poly[k] = poly[k].map(r2);
  return {
    source: acDir, fit: { median_m: +f.median.toFixed(2), p90_m: +f.p90.toFixed(2), mirrored: f.T.m < 0, rotation_deg: +(Math.atan2(f.T.s, f.T.c) * 180 / Math.PI).toFixed(3), shift: [+f.T.tx.toFixed(2), +f.T.tz.toFixed(2)] },
    step, n, left: left.map(r2), right: right.map(r2), line: line.map(r2), poly, sections
  };
}

// Length of an AI line without reading the whole file: the last point's running distance.
function lineLength(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 8, 0);
    const n = head.readInt32LE(4);
    if (head.readInt32LE(0) !== 7 || n < 10) return 0;
    fs.readSync(fd, tail, 0, 4, 16 + (n - 1) * 20 + 12);
    return tail.readFloatLE(0);
  } finally { fs.closeSync(fd); }
}

// Every track layout of an Assetto Corsa install that has an AI line.
function listLayouts(acRoot) {
  const tracks = path.join(acRoot, 'content', 'tracks'), out = [];
  if (!fs.existsSync(tracks)) return out;
  const has = dir => fs.existsSync(path.join(dir, 'ai', 'fast_lane.ai'));
  for (const d of fs.readdirSync(tracks, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(tracks, d.name);
    if (has(dir)) out.push({ dir, name: d.name });
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      if (sub.isDirectory() && has(path.join(dir, sub.name))) out.push({ dir: path.join(dir, sub.name), name: d.name + '/' + sub.name });
    }
  }
  return out;
}

// Finds the AC layout that is the same circuit as our track model, by shape alone: the
// games name tracks differently, but a line that can be laid over ours to within a couple
// of metres all the way round is the same road. Returns null when nothing fits.
function matchTrack(track, acRoot, layoutHint) {
  const model = { n: track.n, x: track.x, z: track.z }, tried = [];
  for (const layout of listLayouts(acRoot)) {
    let len = 0;
    try { len = lineLength(path.join(layout.dir, 'ai', 'fast_lane.ai')); } catch { continue; }
    if (!len || Math.abs(len - track.length) / track.length > 0.15) continue;
    try {
      const f = fit(model, parseFastLane(path.join(layout.dir, 'ai', 'fast_lane.ai')));
      tried.push({ dir: layout.dir, name: layout.name, median: f.median, p90: f.p90 });
    } catch { /* unreadable layout: skip */ }
  }
  const ok = tried.filter(t => t.median < 3 && t.p90 < 10).sort((a, b) => a.median - b.median);
  if (!ok.length) return { match: null, tried };
  // layouts of one circuit fit almost equally well: prefer the one named like ours
  const hint = String(layoutHint || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const close = ok.filter(t => t.median - ok[0].median < 0.3);
  const named = hint && close.find(t => t.name.toLowerCase().replace(/[^a-z0-9/]/g, '').split('/').pop().includes(hint));
  return { match: named || ok[0], tried };
}

module.exports = { importTrack, matchTrack, listLayouts, parseFastLane, parseSections };
