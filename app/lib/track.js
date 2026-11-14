// Track model: a reference line resampled at a fixed step, with curvature and corners.
// Built from a driven lap; every other lap is projected onto it so that "distance along
// the track" means the same place for all laps.
const STEP = 2;            // metres between reference points
const VERSION = 3;         // bump to rebuild stored track files
const CORNER_MIN_CURV = 1 / 300; // tighter than a 300 m radius counts as cornering
const CORNER_MIN_LEN = 20;       // metres
const CORNER_MIN_ANGLE = 7;      // degrees of direction change
const CORNER_MERGE_GAP = 16;     // metres of straight that still joins two same-way arcs

const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// points: [[x, y, z], ...] in driving order (y is up).
function build(points, source) {
  const x = [points[0][0]], y = [points[0][1]], z = [points[0][2]];
  let acc = 0, next = STEP;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (d === 0 || d > 50) continue;
    while (acc + d >= next) {
      const f = (next - acc) / d;
      x.push(a[0] + (b[0] - a[0]) * f); y.push(a[1] + (b[1] - a[1]) * f); z.push(a[2] + (b[2] - a[2]) * f);
      next += STEP;
    }
    acc += d;
  }
  const n = x.length;
  const closed = n > 500 && Math.hypot(x[0] - x[n - 1], z[0] - z[n - 1]) < 30;

  // Curvature from the change of heading over +-8 m, then smoothed. Positive = right-hand bend
  // (x is east, z is south, so a right turn decreases atan2(dx, dz)).
  const W = 4, at = i => Math.max(0, Math.min(n - 1, i));
  const heading = i => Math.atan2(x[at(i + W)] - x[at(i - W)], z[at(i + W)] - z[at(i - W)]);
  const raw = new Array(n);
  for (let i = 0; i < n; i++) raw[i] = -wrapPi(heading(i + W) - heading(i - W)) / ((at(i + W) - at(i - W)) * STEP || 1);
  const k = new Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) { sum += raw[j]; cnt++; }
    k[i] = sum / cnt;
  }

  // Corners: runs of sustained curvature in one direction.
  const runs = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && Math.abs(k[i]) >= CORNER_MIN_CURV;
    if (on && start >= 0 && Math.sign(k[i]) !== Math.sign(k[start])) { runs.push([start, i - 1]); start = i; }
    else if (on && start < 0) start = i;
    else if (!on && start >= 0) { runs.push([start, i - 1]); start = -1; }
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && Math.sign(k[last[0]]) === Math.sign(k[r[0]]) && (r[0] - last[1]) * STEP <= CORNER_MERGE_GAP) last[1] = r[1];
    else merged.push(r.slice());
  }
  const corners = [];
  for (const [a, b] of merged) {
    let angle = 0, apex = a;
    for (let i = a; i <= b; i++) { angle += Math.abs(k[i]) * STEP; if (Math.abs(k[i]) > Math.abs(k[apex])) apex = i; }
    const deg = angle * 180 / Math.PI;
    if ((b - a) * STEP < CORNER_MIN_LEN || deg < CORNER_MIN_ANGLE) continue;
    corners.push({
      n: corners.length + 1, s0: a * STEP, s1: b * STEP, apex: apex * STEP,
      dir: k[apex] > 0 ? 'R' : 'L', angle: Math.round(deg), radius: Math.round(1 / Math.abs(k[apex]))
    });
  }

  const r2 = v => Math.round(v * 100) / 100;
  return {
    version: VERSION, step: STEP, n, length: (n - 1) * STEP, closed, source,
    x: x.map(r2), y: y.map(v => Math.round(v * 10) / 10), z: z.map(r2),
    k: k.map(v => Math.round(v * 1e5) / 1e5), corners
  };
}

// Nearest point of the reference line to (px, pz). `hint` is the index found for the
// previous sample: laps only move forward, so a short window ahead is enough and keeps
// neighbouring parts of the track from being confused.
function locate(track, px, pz, hint) {
  const { x, z, n } = track;
  let best = -1, bd = Infinity;
  const scan = (a, b) => {
    for (let j = a; j <= b; j++) { const dx = x[j] - px, dz = z[j] - pz, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = j; } }
  };
  if (hint >= 0) {
    scan(Math.max(0, hint - 10), Math.min(n - 1, hint + 150));
    // on a closed track the line continues from its last point to its first
    if (track.closed && hint + 150 > n - 1) scan(0, hint + 150 - (n - 1));
  }
  if (bd > 30 * 30) { bd = Infinity; scan(0, n - 1); }

  let out = null;
  for (const a of [best - 1, best]) {
    const b = a + 1;
    if (a < 0 || b >= n) continue;
    const ex = x[b] - x[a], ez = z[b] - z[a], len2 = ex * ex + ez * ez || 1;
    const u = Math.max(0, Math.min(1, ((px - x[a]) * ex + (pz - z[a]) * ez) / len2));
    const qx = x[a] + ex * u, qz = z[a] + ez * u, d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
    if (!out || d2 < out.d2) {
      const side = ex * (pz - qz) - ez * (px - qx); // > 0: to the right of the driving direction
      out = { i: best, s: (a + u) * track.step, d2, lat: Math.sign(side) * Math.sqrt(d2) };
    }
  }
  return out || { i: best, s: best * track.step, d2: bd, lat: 0 };
}

module.exports = { build, locate, STEP, VERSION };
