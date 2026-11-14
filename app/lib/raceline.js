// A geometric reference line: the smoothest path that fits between the track limits.
// It is the classic "minimum curvature" line: a car's cornering speed grows with the radius
// it drives, so the path that bends least is the fastest one a flat, even road would allow.
// It knows nothing about camber, bumps, kerbs or grip, and the limits it is built from are
// accurate to about a metre: a yardstick for the driven line, not the last word.
//
// The line is described by its lateral offset from the track model at every model point
// (same convention as everywhere else: positive = right of the model line).
const MARGIN = 1.0;        // metres from the car's centre line to a track limit: the outer tyres on the limit
const MAX_WIDTH = 16;      // wider than this is a junction or a run-off in the imported limits, not road
const SHORTEN = 1e-5;      // weight of path length against bending, per square metre: keeps the line from wandering on straights
const SMOOTH = 5;          // points either side over which the limits are averaged (their own wobble would end up in the line)
const VERSION = 20;

// Solves A x = r for a symmetric positive definite matrix with two bands above the diagonal
// (a: diagonal, b: first, c: second), in place of nothing: returns x.
function solveBanded(a, b, c, r) {
  const n = a.length, d = new Float64Array(n), l1 = new Float64Array(n), l2 = new Float64Array(n), x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let di = a[i], bi = b[i];
    if (i >= 1) { di -= d[i - 1] * l1[i - 1] * l1[i - 1]; bi -= d[i - 1] * l1[i - 1] * l2[i - 1]; }
    if (i >= 2) di -= d[i - 2] * l2[i - 2] * l2[i - 2];
    d[i] = di; l1[i] = bi / di; l2[i] = c[i] / di;
  }
  for (let i = 0; i < n; i++) x[i] = r[i] - (i >= 1 ? l1[i - 1] * x[i - 1] : 0) - (i >= 2 ? l2[i - 2] * x[i - 2] : 0);
  for (let i = 0; i < n; i++) x[i] /= d[i];
  for (let i = n - 1; i >= 0; i--) x[i] -= (i + 1 < n ? l1[i] * x[i + 1] : 0) + (i + 2 < n ? l2[i] * x[i + 2] : 0);
  return x;
}

function build(track, edges) {
  const n = track.n, step = track.step, X = track.x, Z = track.z;
  // right-hand normal of the model line at each point
  const nx = new Float64Array(n), nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = Math.max(0, i - 2), q = Math.min(n - 1, i + 2), dx = X[q] - X[p], dz = Z[q] - Z[p], len = Math.hypot(dx, dz) || 1;
    nx[i] = -dz / len; nz[i] = dx / len;
  }
  // room for the car's centre line; gaps in the limits are bridged from their neighbours
  const fill = arr => {
    const out = new Float64Array(n);
    let last = null;
    for (let i = 0; i < n; i++) { if (arr[i] !== null && arr[i] !== undefined) last = arr[i]; out[i] = last === null ? NaN : last; }
    for (let i = n - 1, next = null; i >= 0; i--) { if (!Number.isNaN(out[i])) next = out[i]; else out[i] = next === null ? 0 : next; }
    return out;
  };
  const average = arr => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) { let sum = 0, cnt = 0; for (let k = Math.max(0, i - SMOOTH); k <= Math.min(n - 1, i + SMOOTH); k++) { sum += arr[k]; cnt++; } out[i] = sum / cnt; }
    return out;
  };
  const left = average(fill(edges.left)), right = average(fill(edges.right));
  const lo = new Float64Array(n), hi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let l = left[i], r = right[i];
    if (r - l > MAX_WIDTH) { const mid = (l + r) / 2; l = mid - MAX_WIDTH / 2; r = mid + MAX_WIDTH / 2; }
    lo[i] = l + MARGIN; hi[i] = r - MARGIN;
    if (hi[i] - lo[i] < 0.5) { const mid = (l + r) / 2; lo[i] = mid - 0.25; hi[i] = mid + 0.25; }
  }

  // The cost is quadratic in the offsets: squared second differences of the positions
  // (bending) plus a little squared first difference (length). Its matrix has two bands.
  //   cost = 1/2 x'Hx + g'x,  H: h0 (diagonal), h1, h2
  const h0 = new Float64Array(n), h1 = new Float64Array(n), h2 = new Float64Array(n), g = new Float64Array(n);
  const w = SHORTEN * step * step;
  for (let i = 1; i + 1 < n; i++) {
    // |d + n[i-1] x[i-1] - 2 n[i] x[i] + n[i+1] x[i+1]|^2
    const dx = X[i - 1] - 2 * X[i] + X[i + 1], dz = Z[i - 1] - 2 * Z[i] + Z[i + 1];
    const k = [i - 1, i, i + 1], cx = [nx[i - 1], -2 * nx[i], nx[i + 1]], cz = [nz[i - 1], -2 * nz[i], nz[i + 1]];
    for (let p = 0; p < 3; p++) {
      g[k[p]] += 2 * (cx[p] * dx + cz[p] * dz);
      h0[k[p]] += 2 * (cx[p] * cx[p] + cz[p] * cz[p]);
      if (p < 2) h1[k[p]] += 2 * (cx[p] * cx[p + 1] + cz[p] * cz[p + 1]);
      if (p < 1) h2[k[p]] += 2 * (cx[p] * cx[p + 2] + cz[p] * cz[p + 2]);
    }
  }
  for (let i = 0; i + 1 < n; i++) {
    // w |e - n[i] x[i] + n[i+1] x[i+1]|^2
    const ex = X[i + 1] - X[i], ez = Z[i + 1] - Z[i];
    g[i] += -2 * w * (nx[i] * ex + nz[i] * ez); g[i + 1] += 2 * w * (nx[i + 1] * ex + nz[i + 1] * ez);
    h0[i] += 2 * w; h0[i + 1] += 2 * w; h1[i] += -2 * w * (nx[i] * nx[i + 1] + nz[i] * nz[i + 1]);
  }
  const gradient = x => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = g[i] + h0[i] * x[i];
      if (i >= 1) v += h1[i - 1] * x[i - 1]; if (i >= 2) v += h2[i - 2] * x[i - 2];
      if (i + 1 < n) v += h1[i] * x[i + 1]; if (i + 2 < n) v += h2[i] * x[i + 2];
      out[i] = v;
    }
    return out;
  };

  // Which offsets sit on a limit is not known beforehand. Guess, solve the rest exactly,
  // correct the guess from the result, repeat (a primal-dual active set method): a point
  // stays on its limit while the cost still pushes it outwards, and is set free otherwise.
  // state: 0 free, -1 on the lower limit, +1 on the upper one; the two ends are held in the
  // middle of the road (they lie on the straight where the model begins and ends).
  const state = new Int8Array(n), x = new Float64Array(n), fixed = new Uint8Array(n);
  for (const i of [0, 1, n - 2, n - 1]) { fixed[i] = 1; x[i] = (lo[i] + hi[i]) / 2; }
  let rounds = 0, changed = n;
  for (; rounds < 60 && changed > 0; rounds++) {
    const a = Float64Array.from(h0), b = Float64Array.from(h1), c = Float64Array.from(h2), r = new Float64Array(n);
    for (let i = 0; i < n; i++) r[i] = -g[i];
    const held = i => fixed[i] || state[i] !== 0, value = i => (fixed[i] ? x[i] : state[i] < 0 ? lo[i] : hi[i]);
    for (let i = 0; i < n; i++) {
      if (!held(i)) continue;
      const v = value(i);
      // its column moves to the right-hand side of its neighbours, its own row becomes "x = v"
      if (i >= 1) { r[i - 1] -= h1[i - 1] * v; b[i - 1] = 0; } if (i >= 2) { r[i - 2] -= h2[i - 2] * v; c[i - 2] = 0; }
      if (i + 1 < n) { r[i + 1] -= h1[i] * v; b[i] = 0; } if (i + 2 < n) { r[i + 2] -= h2[i] * v; c[i] = 0; }
    }
    for (let i = 0; i < n; i++) if (held(i)) { a[i] = 1; r[i] = value(i); }
    const sol = solveBanded(a, b, c, r);
    for (let i = 0; i < n; i++) x[i] = sol[i];
    const grad = gradient(x);
    changed = 0;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      // free point outside its limits: hold it there; held point the cost pulls back inside: release it
      const t = x[i] - grad[i] / h0[i];
      const next = t < lo[i] ? -1 : t > hi[i] ? 1 : 0;
      if (next !== state[i]) { state[i] = next; changed++; }
    }
  }
  let outside = 0;
  for (let i = 0; i < n; i++) { if (x[i] < lo[i] - 1e-6) { outside = Math.max(outside, lo[i] - x[i]); x[i] = lo[i]; } else if (x[i] > hi[i] + 1e-6) { outside = Math.max(outside, x[i] - hi[i]); x[i] = hi[i]; } }
  // The guessing can end up going back and forth over a few points. What is left then is
  // local, and settles by taking each point in turn to its best place given its neighbours.
  let moved = 0;
  for (let sweep = 0; sweep < 400; sweep++) {
    moved = 0;
    for (let q = 2; q < n - 2; q++) {
      const i = sweep & 1 ? n - 1 - q : q;
      const grad = g[i] + h0[i] * x[i] + h1[i - 1] * x[i - 1] + h2[i - 2] * x[i - 2] + h1[i] * x[i + 1] + h2[i] * x[i + 2];
      let v = x[i] - 1.5 * grad / h0[i];
      if (v < lo[i]) v = lo[i]; else if (v > hi[i]) v = hi[i];
      if (Math.abs(v - x[i]) > moved) moved = Math.abs(v - x[i]);
      x[i] = v;
    }
    if (moved < 1e-5) break;
  }

  const off = Array.from(x, v => Math.round(v * 100) / 100);
  return { version: VERSION, n, step, margin: MARGIN, off, rounds, unsettled: changed, outside, moved, lo: Array.from(lo, v => Math.round(v * 100) / 100), hi: Array.from(hi, v => Math.round(v * 100) / 100),
    x: off.map((v, i) => Math.round((X[i] + nx[i] * v) * 100) / 100), z: off.map((v, i) => Math.round((Z[i] + nz[i] * v) * 100) / 100) };
}

// Radius (m) of a path at point i, from the circle through it and the points `reach` away.
function radiusAt(x, z, i, reach) {
  const a = i - reach, b = i + reach;
  if (a < 0 || b >= x.length) return Infinity;
  const ux = x[i] - x[a], uz = z[i] - z[a], vx = x[b] - x[i], vz = z[b] - z[i], wx = x[b] - x[a], wz = z[b] - z[a];
  const cross = Math.abs(ux * vz - uz * vx);
  return cross < 1e-9 ? Infinity : Math.hypot(ux, uz) * Math.hypot(vx, vz) * Math.hypot(wx, wz) / (2 * cross);
}
// The tightest stretch of a path between two points: the smallest radius held over about 20 m.
function tightest(x, z, from, to) {
  let best = Infinity, at = from;
  for (let i = Math.max(from, 10); i <= Math.min(to, x.length - 11); i++) {
    let sum = 0;
    for (let q = -5; q <= 5; q++) { const r = radiusAt(x, z, i + q, 5); if (Number.isFinite(r)) sum += 1 / r; }
    const r = sum > 0 ? 11 / sum : Infinity;
    if (r < best) { best = r; at = i; }
  }
  return { radius: best, at };
}

module.exports = { build, tightest, MARGIN, VERSION };
