// Reads recordings (CSV + JSON sidecar written by the SimHub plugin), joins the pieces of a
// lap that was saved in several files, keeps the track models, and serves analysed laps.
const fs = require('fs');
const path = require('path');
const trackLib = require('./track');
const { analyze, compare } = require('./analysis');
const sections = require('./sections');
const target = require('./target');
const raceline = require('./raceline');

// Standing still, the game can report positions that drift (loading, garage): while parked
// there is no line to draw, so those samples are left out.
const PARKED_KMH = 2;
const fileCache = new Map(); // file -> { mtime, csv?, meta?, edge? }
const lapCache = new Map();  // lap id -> { sig, analysis?, detail? }
const tracks = new Map();    // track key -> track model
let index = new Map();       // lap id -> lap record from the last scan

function entry(file) {
  const mtime = fs.statSync(file).mtimeMs;
  let e = fileCache.get(file);
  if (!e || e.mtime !== mtime) { e = { mtime }; fileCache.set(file, e); }
  return e;
}

function readCsv(file) {
  const e = entry(file);
  if (e.csv) return e.csv;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const cols = lines[0].trim().split(',');
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  const rows = lines.slice(1).map(l => l.split(',').map(Number));
  // Parsed files are large; keep only the most recently used ones.
  let kept = 0;
  for (const other of [...fileCache.values()].reverse()) if (other.csv && ++kept > 5) delete other.csv;
  return (e.csv = { rows, ix });
}

// Car position: recorded x/y/z, or the centre of the four tyre contact points
// (files from the first recorder version have no car coordinates).
function position(r, ix) {
  if (r[ix.x] !== 0 || r[ix.z] !== 0) return [r[ix.x], r[ix.y], r[ix.z]];
  if (ix.cp_fl_x === undefined || (r[ix.cp_fl_x] === 0 && r[ix.cp_fl_z] === 0)) return null;
  const avg = s => (r[ix['cp_fl_' + s]] + r[ix['cp_fr_' + s]] + r[ix['cp_rl_' + s]] + r[ix['cp_rr_' + s]]) / 4;
  return [avg('x'), avg('y'), avg('z')];
}

// Same measures the recorder writes, for sidecars from before it wrote them.
function measure(file) {
  const { rows, ix } = readCsv(file);
  let path_m = 0, coverage = 0, max = 0, pit = false, invalidAt = -1, prev = null, prevPos = null;
  for (const r of rows) {
    const p = r[ix.speed] < PARKED_KMH ? null : position(r, ix);
    if (p && prev) { const d = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); if (d < 50) path_m += d; }
    if (p) prev = p;
    if (prevPos !== null) {
      let d = r[ix.pos] - prevPos;
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
      if (d > 0 && d < 0.05) coverage += d;
    }
    prevPos = r[ix.pos];
    if (r[ix.speed] > max) max = r[ix.speed];
    if (r[ix.in_pit]) pit = true;
    if (invalidAt < 0 && !r[ix.valid]) invalidAt = coverage;
  }
  const complete = coverage >= 0.98;
  return {
    path_m, coverage, complete, pit, max_speed_kmh: max, invalid_from_coverage: invalidAt < 0 ? null : invalidAt,
    valid: complete && (invalidAt < 0 || invalidAt >= 0.975),
    duration_s: rows.length ? rows[rows.length - 1][ix.wall] : 0
  };
}

function meta(file) {
  const e = entry(file);
  if (e.meta) return e.meta;
  let m = {};
  try { m = JSON.parse(fs.readFileSync(file.replace(/\.csv$/i, '.json'), 'utf8')); } catch { /* CSV without a sidecar */ }
  if (m.path_m === undefined) Object.assign(m, measure(file));
  return (e.meta = m);
}

// First and last sample of a file, read from its ends only (files are several MB each).
function edge(file) {
  const e = entry(file);
  if (e.edge) return e.edge;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, 4096);
    const head = Buffer.alloc(n), tail = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    fs.readSync(fd, tail, 0, n, size - n);
    const hl = head.toString('utf8').split('\n'), tl = tail.toString('utf8').trim().split('\n');
    const ix = Object.fromEntries(hl[0].trim().split(',').map((c, i) => [c, i]));
    const first = hl[1].split(',').map(Number), last = tl[tl.length - 1].split(',').map(Number);
    return (e.edge = { t0: first[ix.t], t1: last[ix.t], w1: last[ix.wall], p0: position(first, ix), p1: position(last, ix) });
  } finally { fs.closeSync(fd); }
}

// ---------- recordings -> laps ----------
// A lap can be split over several files: the recorder cuts a recording when the game is
// paused for long, and its first versions also cut on the game's unreliable lap counter.
// Two consecutive files belong to one lap when the second starts where and when the first
// ended and the game's lap timer simply carried on (it restarts only at the timing line).
function continues(prev, cur) {
  const a = prev.e, b = cur.e;
  if (!a.p1 || !b.p0 || b.t0 < 1.0 || Math.abs(b.t0 - a.t1) > 2.0) return false;
  if (Math.hypot(b.p0[0] - a.p1[0], b.p0[2] - a.p1[2]) > 40) return false;
  return Math.abs(new Date(cur.m.recorded_at) - new Date(prev.m.recorded_at)) < 3600e3;
}

function lapRecord(root, chunks) {
  const first = chunks[0], last = chunks[chunks.length - 1], rel = path.relative(root, first.file).split(path.sep);
  let length = 0, duration = 0, coverage = 0, pit = false, max = 0, invalidAt = -1;
  for (const c of chunks) {
    if (invalidAt < 0 && c.m.invalid_from_coverage !== null && c.m.invalid_from_coverage !== undefined) invalidAt = coverage + c.m.invalid_from_coverage;
    length += c.m.path_m || 0; duration += c.m.duration_s || 0; coverage += c.m.coverage || 0;
    pit = pit || !!c.m.pit; max = Math.max(max, c.m.max_speed_kmh || 0);
  }
  const single = chunks.length === 1;
  const complete = single ? !!first.m.complete : coverage >= 0.98;
  const valid = single ? !!first.m.valid : complete && (invalidAt < 0 || invalidAt >= 0.975);
  // Only a time the game itself reported counts as the lap time. For a joined lap it is the
  // value the last piece saw, unless the first piece already had it (then it is the previous lap's).
  let lapTime = null;
  if (single) { if (first.m.complete && first.m.lap_time_source === 'game') lapTime = first.m.lap_time_s; }
  else if (complete && last.m.game_last_lap_s > 0 && last.m.game_last_lap_s !== first.m.game_last_lap_s && last.m.game_last_lap_s < duration + 2) lapTime = last.m.game_last_lap_s;
  return {
    files: chunks.map(c => c.file),
    edges: chunks.map(c => c.e),
    sig: chunks.map(c => c.file + ':' + entry(c.file).mtime).join('|'),
    invalidAt, trackLength: first.m.track_length_m || 0,
    summary: {
      id: rel.join('/'),
      game: first.m.game || rel[0] || '', track: first.m.track || rel[1] || '', track_config: first.m.track_config || '', car: first.m.car || rel[2] || '',
      recorded_at: first.m.recorded_at || new Date(entry(first.file).mtime).toISOString().slice(0, 19),
      lap_time_s: lapTime, duration_s: duration, length_m: length, max_speed_kmh: max,
      complete, valid, pit, pieces: chunks.length, ended_by: last.m.ended_by || ''
    }
  };
}

function scan(root) {
  const byDir = new Map();
  const walk = dir => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (/\.csv$/i.test(d.name)) {
        try {
          if (!byDir.has(dir)) byDir.set(dir, []);
          byDir.get(dir).push({ file: full, m: meta(full), e: edge(full) });
        } catch (err) { console.error('skipping ' + full + ': ' + err.message); }
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  const next = new Map();
  for (const chunks of byDir.values()) {
    chunks.sort((a, b) => (a.file < b.file ? -1 : 1)); // file names start with the recording time
    let chain = [];
    for (const c of chunks) {
      if (chain.length && !continues(chain[chain.length - 1], c)) { const lap = lapRecord(root, chain); next.set(lap.summary.id, lap); chain = []; }
      chain.push(c);
    }
    if (chain.length) { const lap = lapRecord(root, chain); next.set(lap.summary.id, lap); }
  }
  index = next;
  return index;
}

// Summary as shown to the user. Once the timing lines of a track are known, a recording that
// runs from the start line past the finish line is a complete lap even when the driver left
// the track right after it, and a lap the game gave no time for is timed from telemetry.
function describe(root, lap) {
  const s = Object.assign({}, lap.summary, { has_note: fs.existsSync(noteFile(lap)), lap_time_source: lap.summary.lap_time_s ? 'game' : null });
  const timing = timingFor(root, s);
  if (!timing) return s;
  if (!s.complete && lap.edges[0].t0 < 1.0 && s.length_m >= timing.finish + 20) {
    s.complete = true;
    s.valid = lap.invalidAt < 0 || lap.invalidAt * (lap.trackLength || timing.finish) >= timing.finish - 50;
  }
  if (s.complete && !s.lap_time_s) {
    try {
      const { a } = analysis(root, lap), t = a && timeBetween(a, timing.start, timing.finish);
      if (t) { s.lap_time_s = Math.round(t * 1000) / 1000; s.lap_time_source = 'telemetry'; }
    } catch (err) { console.error(err.message); }
  }
  return s;
}

function list(root) {
  const out = [];
  for (const lap of scan(root).values()) {
    const s = describe(root, lap);
    // The drive up to the start line (from the pits, or from the car park on the Nordschleife
    // tourist layout) is no lap: recordings of it from before the plugin stopped keeping them
    // stay on disk, but are not shown or used.
    // (the first version of the plugin did not write down how a recording ended: there a short one is taken for a run-up)
    if (!s.complete && ((lap.edges[0].t0 >= 1.0 && s.ended_by === 'line') || (!s.ended_by && s.length_m < 1500))) continue;
    out.push(s);
  }
  return out.sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
}

// Everything the navigation screens need: all laps, plus one entry per track layout with
// its totals and a coarse outline of the circuit for the track cards.
function overview(root) {
  const laps = list(root), byKey = new Map();
  for (const l of laps) {
    const key = trackKey(l);
    let t = byKey.get(key);
    if (!t) { t = { key, game: l.game, track: l.track, track_config: l.track_config, laps: 0, cars: [], best: null, best_car: '', last: l.recorded_at, outline: null, limits: false }; byKey.set(key, t); }
    if (l.complete) t.laps++;
    if (!t.cars.includes(l.car)) t.cars.push(l.car);
    if (l.recorded_at > t.last) t.last = l.recorded_at;
    if (l.complete && l.valid && l.lap_time_s && (t.best === null || l.lap_time_s < t.best)) { t.best = l.lap_time_s; t.best_car = l.car; }
  }
  for (const t of byKey.values()) {
    try {
      const model = trackFor(root, t), edges = edgesFor(root, t), timing = timingFor(root, t);
      const x = [], y = [], z = [];
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < model.n; i++) { if (model.y[i] < lo) lo = model.y[i]; if (model.y[i] > hi) hi = model.y[i]; }
      for (let i = 0; i < model.n; i += 8) { x.push(Math.round(model.x[i])); y.push(model.y[i]); z.push(Math.round(model.z[i])); }
      // with elevation, so the cards can draw the circuit in 3D and its height profile
      t.outline = { x, y, z, closed: !!model.closed, step: model.step * 8 };
      t.length_m = model.length; t.corners = model.corners.length; t.elev_min = lo; t.elev_max = hi;
      t.timed_m = timing ? timing.finish - timing.start : null;
      t.limits = !!edges;
      t.sections = edges && edges.sections ? edges.sections : [];
    } catch (err) { console.error('no outline for ' + t.key + ': ' + err.message); }
  }
  return { laps, tracks: [...byKey.values()] };
}

// Lap record for an id coming from the browser. Ids are only ever looked up in the scan
// result, so nothing outside the laps folder can be addressed.
function get(root, id) {
  if (typeof id !== 'string') return null;
  return index.get(id) || scan(root).get(id) || null;
}

function movingSamples(lap) {
  const out = [];
  let ix = null, offset = 0;
  lap.files.forEach((file, k) => {
    const csv = readCsv(file);
    ix = csv.ix;
    // pieces are laid end to end on one clock, using the game's lap timer across the cut
    if (k > 0) offset += lap.edges[k - 1].w1 + Math.max(1 / 120, lap.edges[k].t0 - lap.edges[k - 1].t1);
    for (const r of csv.rows) {
      if (r[ix.speed] < PARKED_KMH) continue;
      const p = position(r, ix);
      if (p) out.push({ p, r, w: offset + r[ix.wall] });
    }
  });
  return { samples: out, ix };
}

// ---------- track models ----------
const safe = s => String(s || 'unknown').replace(/[^\p{L}\p{N} ._()-]/gu, '_');
const trackKey = s => [s.game, s.track, s.track_config].map(safe).join('__');
const trackFile = (root, s, suffix) => path.join(root, '..', 'tracks', trackKey(s) + suffix);

// The track model is built from the first complete lap of that layout (any car) and stored,
// so corner numbers stay the same from then on. Until a complete lap exists it is built from
// the longest recording and marked provisional.
function trackFor(root, s) {
  const key = trackKey(s), file = trackFile(root, s, '.json');
  const same = [...index.values()].filter(l => trackKey(l.summary) === key);
  const complete = same.filter(l => l.summary.complete).sort((a, b) => (a.summary.recorded_at < b.summary.recorded_at ? -1 : 1));
  let t = tracks.get(key);
  if (!t && fs.existsSync(file)) { try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { t = null; } }
  const stale = !t || t.version !== trackLib.VERSION || !index.has(t.source) || (t.provisional && complete.length > 0);
  if (stale) {
    const src = complete[0] || same.slice().sort((a, b) => b.summary.length_m - a.summary.length_m)[0];
    t = trackLib.build(movingSamples(src).samples.map(x => x.p), src.summary.id);
    t.provisional = !src.summary.complete;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(t));
    // limits and timing lines are positions along the old model: they have to be found again
    for (const suffix of ['.edges.json', '.edges.none.json']) fs.rmSync(trackFile(root, s, suffix), { force: true });
    lapCache.clear();
  }
  tracks.set(key, t);
  return t;
}

// Timing lines of a track (start and finish of the game's timed lap, as distances along
// the track model), written by "node app/cli.js gates".
function timingFor(root, s) {
  const file = trackFile(root, s, '.timing.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
// Track limits, AI line and section names imported from an original Assetto Corsa track
// folder by "node app/cli.js import-ac" (see acimport.js).
const edgeCache = new Map();
// Where the original Assetto Corsa is installed: data/config.json { "assettoCorsaDir": "..." }.
function assettoCorsaDir(root) {
  try {
    const dir = JSON.parse(fs.readFileSync(path.join(root, '..', 'config.json'), 'utf8')).assettoCorsaDir;
    return dir && fs.existsSync(dir) ? dir : null;
  } catch { return null; }
}
// The first time a track has a complete lap, look for the same circuit among the Assetto
// Corsa tracks and take its limits and section names. The outcome is written down either
// way, so the search (a few seconds) runs once per track.
function autoImport(root, s, file) {
  const none = trackFile(root, s, '.edges.none.json'), ac = assettoCorsaDir(root);
  if (!ac || fs.existsSync(none)) return;
  let track;
  try { track = trackFor(root, s); } catch { return; }
  if (track.provisional) return; // wait for a complete lap
  try {
    const acimport = require('./acimport'), found = acimport.matchTrack(track, ac, s.track_config);
    const tried = found.tried.map(t => ({ layout: t.name, median_m: +t.median.toFixed(2), p90_m: +t.p90.toFixed(2) }));
    if (found.match) {
      const edges = acimport.importTrack(track, found.match.dir);
      edges.matched = { layout: found.match.name, tried };
      fs.writeFileSync(file, JSON.stringify(edges));
      console.log('track limits for ' + trackKey(s) + ' taken from Assetto Corsa layout ' + found.match.name);
    } else {
      fs.writeFileSync(none, JSON.stringify({ searched: new Date().toISOString().slice(0, 10), tried }, null, 2));
      console.log('no Assetto Corsa layout matches ' + trackKey(s));
    }
  } catch (err) { console.error('track limit import failed: ' + err.message); }
}
function edgesFor(root, s) {
  const file = trackFile(root, s, '.edges.json');
  if (!fs.existsSync(file)) autoImport(root, s, file);
  if (!fs.existsSync(file)) return null;
  const mtime = fs.statSync(file).mtimeMs, hit = edgeCache.get(file);
  if (hit && hit.mtime === mtime) return hit.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: treat as absent */ }
  edgeCache.set(file, { mtime, data });
  lapCache.clear();
  return data;
}
// The geometric reference line between those limits (see raceline.js). Working it out takes
// a couple of seconds, so it is stored next to the limits and redone only when they change.
const lineCache = new Map();
function lineFor(root, s) {
  const track = trackFor(root, s), edges = edgesFor(root, s);
  if (!edges || edges.n !== track.n) return null;
  const file = trackFile(root, s, '.line.json'), stamp = fs.statSync(trackFile(root, s, '.edges.json')).mtimeMs;
  const hit = lineCache.get(file);
  if (hit && hit.stamp === stamp) return hit.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not made yet */ }
  if (!data || data.version !== raceline.VERSION || data.stamp !== stamp || data.n !== track.n) {
    data = Object.assign(raceline.build(track, edges), { stamp });
    fs.writeFileSync(file, JSON.stringify(data));
  }
  lineCache.set(file, { stamp, data });
  return data;
}
function sectionName(s, edges, dist) {
  if (edges && edges.sections && edges.sections.length) {
    let best = '', gap = 150;
    for (const sec of edges.sections) {
      if (dist >= sec.from && dist <= sec.to) return sec.name;
      const d = Math.min(Math.abs(dist - sec.from), Math.abs(dist - sec.to));
      if (d < gap) { gap = d; best = sec.name; }
    }
    return best;
  }
  return sections.nameAt(s, dist);
}

// Everything about the track itself that the viewer draws: limits and AI line as map
// coordinates, section names, timing lines. Fetched once per track.
function trackView(root, lap) {
  const s = lap.summary, track = trackFor(root, s), edges = edgesFor(root, s), timing = timingFor(root, s);
  const out = { key: trackKey(s), step: track.step, n: track.n, length: track.length, timing, sections: edges ? edges.sections : [] };
  if (!edges || edges.n !== track.n) return out;
  Object.assign(out, edges.poly, { left: edges.left, right: edges.right, line: edges.line, fit: edges.fit });
  // the geometric reference line: as map coordinates, and as its offset from the model line
  const ideal = lineFor(root, s);
  if (ideal) Object.assign(out, { xO: ideal.x.map(v => Math.round(v * 10) / 10), zO: ideal.z.map(v => Math.round(v * 10) / 10), opt: ideal.off });
  // The timing lines as segments across the track, from limit to limit.
  out.gates = [];
  for (const [s, name] of timing ? [[timing.start, 'START'], [timing.finish, 'META']] : []) {
    let k = Math.max(0, Math.min(track.n - 1, Math.round(s / track.step)));
    for (let d = 0; d < 10 && (edges.left[k] === null || edges.right[k] === null); d++) k = Math.min(track.n - 1, k + 1); // limits can start a few metres in
    if (edges.left[k] === null || edges.right[k] === null) continue;
    const a = Math.max(0, k - 2), b = Math.min(track.n - 1, k + 2);
    const dx = track.x[b] - track.x[a], dz = track.z[b] - track.z[a], len = Math.hypot(dx, dz) || 1;
    const at = lat => [track.x[k] - dz / len * lat, track.z[k] + dx / len * lat]; // right-hand normal is (-dz, dx)
    out.gates.push({ name, a: at(edges.left[k]), b: at(edges.right[k]) });
  }
  return out;
}

function timeBetween(a, start, finish) {
  const at = s => {
    const f = s / a.step - a.i0, i = Math.floor(f);
    if (i < 0 || i + 1 >= a.m) return null;
    return a.g.t[i] + (a.g.t[i + 1] - a.g.t[i]) * (f - i);
  };
  const t0 = at(start), t1 = at(finish);
  return t0 === null || t1 === null ? null : t1 - t0;
}
function analysis(root, lap) {
  const track = trackFor(root, lap.summary);
  const edges = edgesFor(root, lap.summary); // before the cache lookup: a new import clears the cache
  let c = lapCache.get(lap.summary.id);
  if (!c || c.sig !== lap.sig) { c = { sig: lap.sig }; lapCache.set(lap.summary.id, c); }
  if (!c.analysis) {
    const { samples, ix } = movingSamples(lap);
    const limits = edges && edges.n === track.n ? edges : null;
    c.analysis = { result: analyze(track, samples, ix, timingFor(root, lap.summary), limits, limits ? lineFor(root, lap.summary) : null) };
  }
  return { track, edges, a: c.analysis.result, cache: c };
}

const round = (arr, d) => { const f = 10 ** d; return arr.map(v => Math.round(v * f) / f); };

function detail(root, lap) {
  const { track, edges, a, cache } = analysis(root, lap);
  const s = describe(root, lap);
  if (!a) return { lap: s, error: 'Ten przejazd jest za krótki albo poza zapisanym torem.' };
  if (cache.detail) return Object.assign({}, cache.detail, { lap: s });
  const timing = timingFor(root, s);
  const g = a.g;
  // A timed lap is shown from its start line to its finish line: what was driven before and
  // after (on the Nordschleife tourist layout, the way round to the next start) is not the lap.
  const from = a.summary.timed ? Math.round(a.summary.from / a.step) - a.i0 : 0, to = a.summary.timed ? Math.round(a.summary.to / a.step) - a.i0 : a.m - 1;
  const cut = (arr, d) => { const part = arr.slice(from, to + 1); return d === undefined ? part : round(part, d); };
  return (cache.detail = {
    lap: s,
    track: { length: track.length, provisional: !!track.provisional, source: track.source, timing },
    i0: a.i0 + from, step: a.step,
    g: {
      t: cut(g.t, 3), v: cut(g.v, 1), th: cut(g.th, 0), br: cut(g.br, 0), st: cut(g.st, 0),
      x: cut(g.x, 2), z: cut(g.z, 2), e: cut(g.e, 1), lat: cut(g.lat, 2),
      gear: cut(g.gear), abs: cut(g.abs), tc: cut(g.tc), kb: cut(g.kb), ahead: g.ahead ? cut(g.ahead, 0) : null
    },
    limits: !!g.dl,
    corners: a.corners.map(c => Object.assign({ name: sectionName(s, edges, (c.s0 + c.s1) / 2) }, c)),
    findings: a.findings, summary: a.summary
  });
}

function comparison(root, lap, ref) {
  const A = analysis(root, ref), B = analysis(root, lap);
  if (!A.a || !B.a) return null;
  const c = compare(A.a, B.a);
  if (!c) return null;
  const off = c.i0 - A.a.i0, len = c.i1 - c.i0 + 1, cut = (arr, d) => round(arr.slice(off, off + len), d);
  return {
    ref: ref.summary, i0: c.i0, step: c.step, total: c.total,
    delta: round(c.delta, 3), lat: round(c.lat, 2), dv: round(c.dv, 1), corners: c.corners,
    // the reference lap's own line and speed, for drawing under the selected lap
    x: cut(A.a.g.x, 2), z: cut(A.a.g.z, 2), v: cut(A.a.g.v, 1)
  };
}

// ---------- driving plan for the in-game overlay ----------
// One plain-text file per track and car, read by the SimHub plugin while driving: the track
// line with the reference lap's time and speed at every point, and for each corner where
// that lap braked, how slow it got and where it went back on the throttle. Coach
// adjustments (a note per corner, a braking point moved by some metres) come from
// <same name>.coach.json, written after a session review:
//   { "corners": { "18": { "note": "Release the brake earlier", "brakeShift": 10, "minSpeed": 105 } } }
// brakeShift: metres later (+) or earlier (-) than the lap braked; minSpeed: the speed to aim
// for at the slowest point instead of the lap's own.
const guideBase = (root, s) => path.join(root, '..', 'guides', [s.game, s.track, s.track_config, s.car].map(safe).join('__'));

// The target plan for a lap: that lap, corrected with what every other recording of the same
// track and car shows (see target.js). Recomputed when any of those recordings changes.
let targetCache = { sig: '', plan: null };
function targetFor(root, lap) {
  const s = lap.summary, same = l => l.game === s.game && l.track === s.track && l.track_config === s.track_config && l.car === s.car;
  const records = list(root).filter(same).map(l => get(root, l.id)).filter(Boolean);
  const sig = lap.summary.id + '#' + records.map(r => r.sig).join('|');
  if (targetCache.sig === sig) return targetCache.plan;
  const when = r => { const d = new Date(r.summary.recorded_at); return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'numeric' }) + ' ' + d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }); };
  const entry = r => ({ id: r.summary.id, when: when(r), at: r.summary.recorded_at, a: analysis(root, r).a });
  const ref = entry(lap);
  const plan = ref.a ? target.build(trackFor(root, s), ref, records.filter(r => r.summary.id !== s.id).map(entry)) : null;
  targetCache = { sig, plan };
  return plan;
}
function guideStatus(root, s) {
  const file = guideBase(root, s) + '.guide.txt';
  if (!fs.existsSync(file)) return null;
  const head = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n', 24)) { const eq = line.indexOf('='); if (eq > 0) head[line.slice(0, eq)] = line.slice(eq + 1).trim(); }
  return { lap: head.source || '', lap_time: head.lap || '', corners: Number(head.corners) || 0, notes: Number(head.notes) || 0,
    changes: Number(head.changes) || 0, gain: Number(head.gain) || 0, laps: Number(head.laps) || 0, stamp: head.stamp || '',
    focus: Number(head.focus) || 0, fullChanges: Number(head.fullchanges) || Number(head.changes) || 0, fullGain: Number(head.fullgain) || Number(head.gain) || 0 };
}
// The plan for a lap as the overlay will follow it, corner by corner: the target computed
// from the recordings, with the coach's own word on top where there is one (a note replaces
// the automatic cue; a brakeShift or minSpeed replaces the computed value).
function planRows(root, lap) {
  const s = lap.summary, { edges, a } = analysis(root, lap), plan = a && targetFor(root, lap);
  if (!plan) return null;
  let coach = {}, coachStamp = 0;
  try { const file = guideBase(root, s) + '.coach.json'; coach = JSON.parse(fs.readFileSync(file, 'utf8')).corners || {}; coachStamp = fs.statSync(file).mtimeMs; } catch { /* no adjustments yet */ }
  const rows = [];
  for (const t of plan.corners) {
    const c = a.corners.find(x => x.n === t.n), adj = coach[c.n] || {};
    const own = adj.brakeShift !== undefined && t.brake && !t.carried;
    const shift = own ? Number(adj.brakeShift) || 0 : t.brake ? t.brake.shift : 0;
    const speed = Number(adj.minSpeed) > 0 ? Number(adj.minSpeed) : t.minSpeed.target;
    const row = {
      n: c.n, name: sectionName(s, edges, (c.s0 + c.s1) / 2), c, carried: t.carried, chainTo: t.brake && t.brake.chain ? t.brake.chain : 0, caution: t.caution,
      brake: t.brake ? { ref: t.brake.ref, shift, target: t.brake.ref + shift, limit: t.brake.limit, coach: own } : null,
      minSpeed: { ref: c.vMin, target: speed, seen: t.minSpeed.seen }, pickup: t.pickup,
      note: adj.note || '', cue: adj.note || t.cue, why: t.why, gain: t.gain,
      coached: !!(adj.note || adj.brakeShift !== undefined || Number(adj.minSpeed) > 0) // the coach's own word: always in force
    };
    // What the driven line leaves on the table against the geometric reference line: said in
    // the game only where the plan has nothing more pressing for this corner.
    if (c.ideal && c.ideal.gain > 0) {
      const LINE_CUES = { entry: 'Szerzej na wejściu', early: 'Późniejszy szczyt', late: 'Wcześniejszy szczyt', apex: 'Bliżej wewnętrznej w szczycie', exit: 'Na wyjściu do samej krawędzi' };
      row.line = { gain: c.ideal.gain, rDrv: Math.round(c.ideal.rDrv), rLine: Math.round(c.ideal.rLine) };
      row.why = row.why.concat('Linia: Twój promień ' + row.line.rDrv + ' m, linia optymalna ' + row.line.rLine + ' m' + (c.ideal.advice.length ? ' (' + c.ideal.advice.join(', ') + ')' : '') + '. Przy tej samej przyczepności to ok. +' + c.ideal.gain + ' km/h.');
      if (!row.cue && !t.caution && c.ideal.codes.length) row.cue = LINE_CUES[c.ideal.codes[0]];
    }
    row.changed = !!(shift || Math.round(speed) !== Math.round(c.vMin) || t.pickup.shift);
    rows.push(row);
  }
  return { rows, laps: plan.laps, standard: plan.standard, sig: targetCache.sig + '#' + coachStamp };
}

// ---------- how the plan is run: which lap it stands on, and how much it asks at once ----------
// <guide name>.plan.json, per track and car:
//   pin    a lap id: the plan stays on that lap. Empty: it follows the best valid lap by itself.
//   focus  how many corners the plan moves at a time (0: every change at once). The rest keep
//          the base lap's own points until their turn comes.
//   set    the focus as it stands for the base lap: the corners in it with the targets the
//          driver was given and how many laps in a row met them, the corners already met
//          (kept at the target they were met at), and the laps judged so far.
const PLAN_DEFAULTS = { pin: '', focus: 5 }, FOCUS_HITS = 2, FOCUS_TRIES = 6;
function planConfig(root, s) {
  try { return Object.assign({}, PLAN_DEFAULTS, JSON.parse(fs.readFileSync(guideBase(root, s) + '.plan.json', 'utf8'))); } catch { return Object.assign({}, PLAN_DEFAULTS); }
}
function savePlanConfig(root, s, cfg) {
  const file = guideBase(root, s) + '.plan.json';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}
const sameCar = s => l => l.game === s.game && l.track === s.track && (l.track_config || '') === (s.track_config || '') && l.car === s.car;
function bestLap(root, s) {
  return list(root).filter(sameCar(s)).filter(l => l.complete && l.valid && l.lap_time_s).sort((p, q) => p.lap_time_s - q.lap_time_s)[0] || null;
}
// The rows one braking covers: a chain's first corner and the ones its braking carries into.
function chainOf(rows, k) {
  const out = [k];
  for (let q = k + 1; rows[k].chainTo && q < rows.length && rows[q - 1].n !== rows[k].chainTo; q++) out.push(q);
  return out;
}
// Did a pass meet the target its corner was given? (null: another car was in the way, no verdict)
function metTarget(c, t) {
  if (!c || c.inTraffic) return null;
  if (t.brake !== null && (!c.brake || c.brake.on < t.brake - 5)) return false;
  if (t.speed !== null && c.vMin < t.speed - 3) return false;
  if (t.pickup !== null && (c.pickup === null || c.pickup > t.pickup + 10)) return false;
  return true;
}
// Judges the laps driven since the focus was last looked at, lets the corners that were met
// twice in a row go, and fills the free places with the changes worth most.
function updateFocus(root, lap) {
  const s = lap.summary, cfg = planConfig(root, s), full = planRows(root, lap);
  if (!full) return;
  const before = JSON.stringify(cfg.set || null);
  const complete = list(root).filter(sameCar(s)).filter(l => l.complete).sort((p, q) => (p.recorded_at < q.recorded_at ? -1 : 1));
  const set = cfg.set && cfg.set.base === s.id ? cfg.set : { base: s.id, active: [], done: [], parked: [], seen: complete.map(l => l.id) };
  if (!set.parked) set.parked = [];
  for (const l of complete) {
    if (set.seen.includes(l.id)) continue;
    set.seen.push(l.id);
    const rec = get(root, l.id), a = rec && analysis(root, rec).a;
    if (!a) continue;
    const mine = target.ownCorners(a);
    for (const f of set.active) {
      const met = metTarget(mine.find(c => c.n === f.n), f);
      if (met !== null) { f.hits = met ? f.hits + 1 : 0; f.tries = (f.tries || 0) + 1; }
    }
    for (const f of set.active) {
      if (f.hits >= FOCUS_HITS) set.done.push({ n: f.n, brake: f.brake, speed: f.speed, pickup: f.pickup, cue: f.cue });
      // not met in six passes: to the back of the queue, so the focus does not stand still on one corner
      else if (f.tries >= FOCUS_TRIES) set.parked.push(f.n);
    }
    set.active = set.active.filter(f => f.hits < FOCUS_HITS && (f.tries || 0) < FOCUS_TRIES);
  }
  const size = Math.max(0, Math.round(cfg.focus) || 0);
  const open = full.rows.filter(r => r.changed && !r.carried && !r.coached);
  set.active = set.active.filter(f => open.some(r => r.n === f.n)).slice(0, size || undefined); // (a change the plan no longer makes has no place here)
  if (size) {
    const waiting = () => open.filter(r => !set.done.some(d => d.n === r.n) && !set.parked.includes(r.n) && !set.active.some(f => f.n === r.n)).sort((p, q) => q.gain - p.gain);
    let pool = waiting();
    // the queue is empty: the corners put back come round again; and when every change has
    // been met, round two starts on the plan's targets as they stand now
    if (!pool.length && set.active.length < size && set.parked.length) { set.parked = []; pool = waiting(); }
    if (!pool.length && !set.active.length && set.done.length) { set.done = []; pool = waiting(); }
    while (set.active.length < size && pool.length) set.active.push({ n: pool.shift().n, hits: 0, tries: 0 });
  }
  for (const f of set.active) { // what the driver is asked for from now on: only what the plan moves in that corner is judged
    const r = full.rows.find(x => x.n === f.n);
    f.brake = r.brake && !r.carried && r.brake.shift ? r.brake.target : null;
    f.speed = !r.chainTo && Math.round(r.minSpeed.target) !== Math.round(r.minSpeed.ref) ? r.minSpeed.target : null;
    f.pickup = r.pickup.shift ? r.pickup.target : null;
    f.cue = r.cue;
  }
  cfg.set = set;
  if (JSON.stringify(set) !== before) savePlanConfig(root, s, cfg);
}
// Marks each row with its place in the focus and takes the changes that are waiting out of the plan.
function applyFocus(rows, cfg, baseId) {
  for (const r of rows) r.full = { brakeShift: r.brake ? r.brake.shift : 0, speed: r.minSpeed.target, pickupShift: r.pickup.shift, cue: r.cue, gain: r.gain };
  const size = Math.max(0, Math.round(cfg.focus) || 0);
  if (!size) return;
  let set = cfg.set && cfg.set.base === baseId ? cfg.set : null;
  if (!set) { // not looked at yet: the changes worth most, as updateFocus will choose them
    const open = rows.filter(r => r.changed && !r.carried && !r.coached).sort((p, q) => q.gain - p.gain);
    set = { active: open.slice(0, size).map(r => ({ n: r.n, hits: 0 })), done: [] };
  }
  const place = new Map();
  rows.forEach((r, k) => {
    const f = set.active.find(x => x.n === r.n), d = set.done.find(x => x.n === r.n);
    if (f || d) for (const q of chainOf(rows, k)) place.set(q, f ? 'active' : 'done');
  });
  rows.forEach((r, k) => {
    r.focus = '';
    if (r.coached) return;
    const at = place.get(k);
    if (at === 'active') { r.focus = 'active'; const f = set.active.find(x => x.n === r.n); r.hits = f ? f.hits : 0; return; }
    if (at === 'done') {
      const d = set.done.find(x => x.n === r.n);
      if (d) { // stays at the target it was met at, whatever the plan has made of it since
        if (r.brake && d.brake !== null && d.brake !== undefined) { r.brake.target = d.brake; r.brake.shift = Math.round(d.brake - r.brake.ref); }
        if (d.speed !== null && d.speed !== undefined) r.minSpeed.target = d.speed;
        if (d.pickup !== null && d.pickup !== undefined && r.pickup.ref !== null) r.pickup = { ref: r.pickup.ref, target: d.pickup, shift: Math.round(d.pickup - r.pickup.ref) };
        if (d.cue) r.cue = d.cue;
      }
      r.focus = 'done';
      return;
    }
    if (!r.changed) { if (!r.note) r.cue = ''; return; } // (a word about the line can wait as well)
    // waiting for its turn: the lap's own points
    r.focus = 'held';
    if (r.brake) { r.brake.shift = 0; r.brake.target = r.brake.ref; }
    r.minSpeed.target = r.minSpeed.ref;
    r.pickup = { ref: r.pickup.ref, target: r.pickup.ref, shift: 0 };
    r.cue = ''; r.changed = false;
  });
}
function planFor(root, lap) {
  const full = planRows(root, lap);
  if (!full) return null;
  const s = lap.summary, cfg = planConfig(root, s), rows = full.rows;
  let fullGain = 0, fullChanges = 0, gain = 0, changes = 0, cues = 0;
  for (const r of rows) if (r.changed) { fullChanges++; fullGain += r.gain; }
  applyFocus(rows, cfg, s.id);
  for (const r of rows) { if (r.changed) { changes++; gain += r.gain; } if (r.cue) cues++; }
  const set = cfg.set && cfg.set.base === s.id ? [cfg.set.active.map(f => f.n), cfg.set.done] : null;
  // identifies the recordings, the coach file and the focus this plan was made from: a guide with another stamp is out of date
  const stamp = require('crypto').createHash('md5').update(full.sig + '#' + JSON.stringify([cfg.focus, set])).digest('hex').slice(0, 12);
  const tenth = v => Math.round(v * 10) / 10;
  return { rows, gain: tenth(gain), changes, cues, laps: full.laps, standard: full.standard, stamp, focus: Math.max(0, Math.round(cfg.focus) || 0), fullGain: tenth(fullGain), fullChanges };
}
// Brings the plan of a track and car up to date with its recordings: onto the best valid lap
// unless it is pinned to one, the focus judged against the laps driven since, and the guide
// written again if any of that changed it. hold: change nothing, only say whether there is
// something to change (a lap is being driven and the plugin would swap plans in the middle of it).
function refreshPlan(root, s, hold) {
  const guide = guideStatus(root, s);
  if (!guide) return null;
  const cfg = planConfig(root, s), best = bestLap(root, s);
  const wantId = cfg.pin && get(root, cfg.pin) ? cfg.pin : best ? best.id : guide.lap;
  const lap = get(root, wantId) || get(root, guide.lap);
  if (!lap) return { guide };
  if (!hold) updateFocus(root, lap);
  const plan = planFor(root, lap), moved = lap.summary.id !== guide.lap;
  if (!plan || (!moved && plan.stamp === guide.stamp)) return { guide };
  if (hold) return { guide, pending: true };
  return { guide: writeGuide(root, lap), moved, written: true };
}
// Every plan there is, and a first one for each track and car that has a valid lap but no plan yet.
function refreshPlans(root) {
  const out = [], seen = new Set();
  for (const l of list(root)) {
    const key = guideBase(root, l);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      let r = refreshPlan(root, l), made = false;
      if (!r) { const best = bestLap(root, l), lap = best && get(root, best.id); if (lap) { r = { guide: writeGuide(root, lap), moved: true }; made = true; } }
      if (r) out.push({ track: l.track, car: l.car, lap_time: r.guide.lap_time, changes: r.guide.changes, changed: made || !!r.written, moved: !!r.moved });
    } catch (err) { console.error('plan for ' + l.track + ' / ' + l.car + ': ' + err.message); }
  }
  return out;
}
// The driver's own choice of lap: the plan stays there, unless it is the best one anyway.
function setPlan(root, lap) {
  const s = lap.summary, cfg = planConfig(root, s), best = bestLap(root, s);
  cfg.pin = best && best.id === s.id ? '' : s.id;
  savePlanConfig(root, s, cfg);
  return writeGuide(root, lap);
}
function planOption(root, s, change) {
  const cfg = planConfig(root, s);
  if (change.pin !== undefined) cfg.pin = change.pin;
  if (isFinite(change.focus)) cfg.focus = Math.max(0, Math.min(12, Math.round(change.focus)));
  savePlanConfig(root, s, cfg);
  return refreshPlan(root, s);
}
function writeGuide(root, lap) {
  const s = describe(root, lap), { track, a } = analysis(root, lap);
  if (!a) throw new Error('Tego przejazdu nie da się przeanalizować.');
  const timing = timingFor(root, s) || { start: 0, finish: track.length };
  updateFocus(root, lap);
  const plan = planFor(root, lap);
  const one = v => String(v).replace(/[;\r\n]/g, ',').trim();
  // n;name;s0;s1;braking point;metres moved;target slowest speed;where it is;throttle point;gear;cue;flags;brake pressure;brake release;lift point
  // (new columns only ever go at the end: a plugin from before them reads the ones it knows)
  // flags: c = the braking is carried over from the corner before (no braking point of its own);
  //        h = this braking runs on into the next corners: the speed given is the one at the end of it;
  //        l = no braking here, a lift of the throttle carries the car through; f = flat out
  // brake pressure: peak pedal % to aim for; brake release: where the pedal is fully off again;
  // lift point: with flag l, where to come off the throttle
  const last = r => (r.chainTo ? plan.rows.find(x => x.n === r.chainTo) || r : r);
  const corners = plan.rows.map((r, k) => {
    const lift = !r.brake && r.c.lift && !r.c.lift.carried, flat = !r.brake && r.c.flat;
    let pressure = 0, release = -1;
    if (r.brake && r.c.brake) {
      // one braking through several corners ends where the last of them lets go, and is as hard as its hardest part
      let peak = r.c.brake.peak;
      release = r.c.brake.off;
      for (let q = k + 1; r.chainTo && q < plan.rows.length && plan.rows[q - 1].n !== r.chainTo; q++) { const b = plan.rows[q].c.brake; if (b) { peak = Math.max(peak, b.peak); release = b.off; } }
      // The pedal pressure the lap itself used, not more. Raising it where the braking point
      // moves later was tried and was wrong: on 13.11.2026 the laps that braked later and went
      // faster did so with less pedal and more speed carried in, not with harder braking.
      pressure = Math.min(100, Math.round(peak / 5) * 5);
    }
    return [r.n, one(r.name), r.c.s0, r.c.s1, r.brake ? r.brake.target.toFixed(1) : -1, r.brake ? r.brake.shift : 0,
      last(r).minSpeed.target.toFixed(1), r.c.sMin, r.pickup.target === null ? -1 : r.pickup.target, r.c.gear, one(r.cue),
      (r.carried ? 'c' : '') + (r.chainTo ? 'h' : '') + (lift ? 'l' : '') + (flat ? 'f' : ''), pressure, release, lift ? r.c.lift.on : -1].join(';');
  });
  const lines = ['SIMCOACH-GUIDE 1', 'game=' + s.game, 'track=' + s.track, 'config=' + s.track_config, 'car=' + s.car,
    'lap=' + (s.lap_time_s ? s.lap_time_s.toFixed(3) : ''), 'source=' + s.id, 'step=' + track.step, 'n=' + track.n,
    'start=' + timing.start, 'finish=' + timing.finish, 'closed=' + (track.closed ? 1 : 0), 'corners=' + corners.length, 'notes=' + plan.cues,
    'changes=' + plan.changes, 'gain=' + plan.gain, 'laps=' + plan.laps, 'stamp=' + plan.stamp,
    'focus=' + plan.focus, 'fullchanges=' + plan.fullChanges, 'fullgain=' + plan.fullGain, '[line]'];
  for (let k = 0; k < track.n; k++) {
    const i = k - a.i0, on = i >= 0 && i < a.m;
    lines.push(track.x[k] + ',' + track.z[k] + ',' + (on ? a.g.t[i].toFixed(3) : -1) + ',' + (on ? a.g.v[i].toFixed(1) : -1));
  }
  lines.push('[corners]', ...corners);
  const file = guideBase(root, s) + '.guide.txt';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  notePlan(root, s, plan);
  return guideStatus(root, s);
}
// Asks the plugin to play a recorded lap through the overlay (no game needed), or to stop.
function overlayDemo(root, lap) {
  const file = path.join(root, '..', 'overlay.demo.txt');
  if (!lap) { fs.rmSync(file, { force: true }); return { playing: false }; }
  const s = lap.summary, guide = guideBase(root, s) + '.guide.txt';
  if (!fs.existsSync(guide)) throw new Error('Najpierw ustaw okrążenie odniesienia dla nakładki.');
  // without the plugin the request would wait on disk and start a demo the next time SimHub is opened
  if (!overlayStatus(root, lap).plugin.alive) throw new Error('SimHub nie odpowiada. Uruchom go i spróbuj ponownie.');
  fs.writeFileSync(file, [guide, ...lap.files].join('\n') + '\n');
  return { playing: true };
}
// The overlay's settings file, shared with the plugin (which re-reads it every second).
// enabled: the window is shown while driving; scale: its size; x, top: where on the screen
// (0 = left / top edge, 1 = right / bottom edge); sound: 0 off, 1 tones at the braking and
// throttle points, 2 with a count-down to the braking point; volume 0..1; move: the window
// can be dragged with the mouse (the plugin ends that by itself once driving starts).
// theme: the set of sounds (0 soft, 1 race, 2 neon, 3 pulse, 4 the driver's own files in data/sounds)
const OVERLAY_DEFAULTS = { enabled: true, scale: 1, x: 0.5, top: 0.04, sound: 2, volume: 0.6, theme: 1, move: false };
const OVERLAY_RANGE = { scale: [0.5, 3], x: [0, 1], top: [0, 1], sound: [0, 2], volume: [0.05, 1], theme: [0, 4] };
function overlaySettings(root, change) {
  const file = path.join(root, '..', 'overlay.txt'), now = { ...OVERLAY_DEFAULTS };
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('='), k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
      if (k === 'enabled') now.enabled = v !== '0';
      else if (k === 'move') now.move = v === '1';
      else if (OVERLAY_RANGE[k] && isFinite(Number(v)) && v !== '') now[k] = Number(v);
    }
  } catch { /* not written yet: the defaults */ }
  if (!change) return now;
  if (change.enabled !== undefined) now.enabled = !!change.enabled;
  if (change.move !== undefined) now.move = !!change.move;
  for (const k in OVERLAY_RANGE) if (isFinite(change[k])) now[k] = Math.max(OVERLAY_RANGE[k][0], Math.min(OVERLAY_RANGE[k][1], k === 'sound' || k === 'theme' ? Math.round(change[k]) : change[k]));
  fs.mkdirSync(path.dirname(file), { recursive: true }); // (nothing has been recorded yet on a fresh copy: no data folder)
  fs.writeFileSync(file, ['enabled=' + (now.enabled ? 1 : 0), 'scale=' + now.scale, 'x=' + now.x, 'top=' + now.top, 'sound=' + now.sound, 'volume=' + now.volume, 'theme=' + now.theme, 'move=' + (now.move ? 1 : 0)].join('\r\n') + '\r\n');
  return now;
}
// Asks the plugin to play its sounds once, in the order they come at a corner.
function overlayBeep(root) { fs.mkdirSync(path.join(root, '..'), { recursive: true }); fs.writeFileSync(path.join(root, '..', 'overlay.beep.txt'), '1'); }
// The overlay as a device, whatever the track: is the plugin there, how the window and the
// sounds are set, and the plans it has to drive by (one per track and car, newest first).
function overlayDevice(root) {
  const dataDir = path.join(root, '..');
  // the plugin rewrites its state file every second while SimHub runs
  const plugin = { alive: false, driving: false, demo: false, features: [] };
  try {
    const file = path.join(dataDir, 'overlay.state.txt');
    if (Date.now() - fs.statSync(file).mtimeMs < 4000) {
      plugin.alive = true;
      const text = fs.readFileSync(file, 'utf8');
      plugin.driving = /^driving=1/m.test(text); plugin.demo = /^demo=1/m.test(text);
      // an older plugin still running (SimHub not restarted since the update) knows nothing of sounds or dragging
      plugin.features = (/^features=(.*)$/m.exec(text) || ['', ''])[1].split(',').filter(Boolean);
    }
  } catch { /* SimHub is not running, or an older plugin */ }
  // the driver's own sounds, if any were put there: tick.wav, brake.wav, gas.wav, lift.wav
  const soundsDir = path.join(dataDir, 'sounds');
  const ownSounds = ['tick.wav', 'brake.wav', 'gas.wav', 'lift.wav'].filter(f => fs.existsSync(path.join(soundsDir, f)));
  return { plugin, settings: overlaySettings(root), ownSounds, soundsDir, demoAsked: fs.existsSync(path.join(dataDir, 'overlay.demo.txt')) };
}
function plans(root) {
  const dir = path.join(root, '..', 'guides'), out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.guide.txt')); } catch { /* no plan yet */ }
  for (const f of files) {
    const head = {};
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n', 20)) { const eq = line.indexOf('='); if (eq > 0) head[line.slice(0, eq)] = line.slice(eq + 1).trim(); }
    if (!head.source || !get(root, head.source)) continue; // its lap is gone: nothing to open or play
    out.push({ game: head.game, track: head.track, track_config: head.config || '', car: head.car, lap: head.source, lap_time: Number(head.lap) || null,
      changes: Number(head.changes) || 0, gain: Number(head.gain) || 0, at: fs.statSync(path.join(dir, f)).mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at);
}
// Everything the app shows about the plan for one lap's track and car.
function overlayStatus(root, lap) {
  const s = lap.summary, device = overlayDevice(root), plugin = device.plugin;
  // What the plan changes against the lap it starts from. New recordings or a new word from
  // the coach change the plan: the guide file is rewritten then, so the game always gets the current one.
  let guide = guideStatus(root, s), cues = [], faster = null;
  const cfg = planConfig(root, s);
  try {
    // (not while a lap is being driven with a plugin that would swap plans in the middle of it;
    // the current plugin waits for the end of the lap by itself)
    const fresh = guide && refreshPlan(root, s, plugin.driving && !plugin.features.includes('autoplan'));
    if (fresh) { guide = fresh.guide; if (fresh.pending) guide.pending = true; }
    const source = guide && get(root, guide.lap), plan = source && planFor(root, source);
    // a row waiting for its turn in the focus is listed with what the whole plan has for it
    if (plan) cues = plan.rows.filter(r => r.changed || r.note || r.cue || r.focus === 'held').map(r => {
      const held = r.focus === 'held', shift = held ? r.full.brakeShift : r.brake ? r.brake.shift : 0, speed = Math.round(held ? r.full.speed : r.minSpeed.target);
      return {
        line: r.line || null, focus: r.focus || '', hits: r.hits || 0,
        n: r.n, name: r.name, cue: held ? r.full.cue : r.cue, coach: !!r.note, caution: r.caution, why: r.why, gain: r.changed || held ? r.gain : 0,
        brakeShift: shift, speed: speed !== Math.round(r.minSpeed.ref) ? speed : 0,
        speedWas: Math.round(r.minSpeed.ref), throttleShift: held ? r.full.pickupShift : r.pickup.shift
      };
    });
    // pinned to a lap while a quicker valid one exists
    const best = bestLap(root, s);
    if (source && source.summary.lap_time_s && best && best.lap_time_s < source.summary.lap_time_s - 0.0005) faster = { id: best.id, lap_time: best.lap_time_s };
  } catch (err) { console.error('overlay plan: ' + err.message); }
  return { ...device, account: planAccount(root, s), guide, cues, faster, pinned: !!(cfg.pin && guide && cfg.pin === guide.lap), focus: Math.max(0, Math.round(cfg.focus) || 0), focusHits: FOCUS_HITS };
}

// How a lap went against the plan the overlay follows now: corner by corner, what was off.
// The plan's own lap answers 'what does the plan want changed'; any other lap 'where did I
// stray from it'. Corners with another car close ahead are named but not held against the lap.
function report(root, lap) {
  const s = lap.summary, guide = guideStatus(root, s), source = guide && get(root, guide.lap);
  const plan = source && planFor(root, source), a = analysis(root, lap).a;
  if (!plan || !a) return null;
  const mine = target.ownCorners(a), rows = [];
  const count = { corners: 0, onPlan: 0, brakeEarly: 0, brakeLate: 0, gasLate: 0, gasEarly: 0, slow: 0, traffic: 0 };
  const m = v => Math.round(Math.abs(v)) + ' m';
  for (const r of plan.rows) {
    const c = mine.find(x => x.n === r.n);
    if (!c || !(c.significant || r.changed)) continue;
    const row = { n: r.n, name: r.name, parts: [], worse: false, weight: 0, kind: '', traffic: !!c.inTraffic };
    if (r.brake && !r.carried && c.brake) {
      const d = c.brake.on - r.brake.target;
      row.dBrake = Math.round(d);
      if (d <= -5) { row.parts.push('hamulec ' + m(d) + ' za wcześnie'); row.worse = true; row.kind = 'brake'; row.early = true; row.weight += -d * (3.6 / Math.max(30, c.vMin) - 3.6 / Math.max(30, c.vIn)); }
      else if (d >= 5) { row.parts.push('hamulec ' + m(d) + ' później'); row.late = true; }
    }
    if (r.pickup.target !== null && c.pickup !== null && c.significant) {
      const d = c.pickup - r.pickup.target;
      row.dGas = Math.round(d);
      if (d >= 10 && d <= 80) { row.parts.push('gaz ' + m(d) + ' za późno'); row.worse = true; row.kind = row.kind || 'throttle'; row.gasLate = true; row.weight += d * 0.003; }
      else if (d <= -10 && c.lifts > 0) { row.parts.push('gaz za wcześnie, cofnięty'); row.worse = true; row.kind = row.kind || 'throttle'; row.gasEarly = true; row.weight += 0.05 * c.lifts; }
    }
    if (!r.chainTo) {
      const dv = c.vMin - r.minSpeed.target;
      row.dSpeed = Math.round(dv);
      if (dv <= -3) { row.parts.push('szczyt ' + Math.round(dv) + ' km/h'); row.worse = true; row.kind = row.kind || 'accent'; row.slow = true; row.weight += -dv * 0.015; }
      else if (dv >= 3) row.parts.push('szczyt +' + Math.round(dv) + ' km/h');
    }
    count.corners++;
    if (row.traffic) { count.traffic++; row.worse = false; row.weight = 0; }
    else {
      if (!row.worse) count.onPlan++;
      if (row.early) count.brakeEarly++; if (row.late) count.brakeLate++; if (row.gasLate) count.gasLate++; if (row.gasEarly) count.gasEarly++; if (row.slow) count.slow++;
    }
    row.sMin = c.sMin; row.weight = Math.round(row.weight * 100) / 100;
    rows.push(row);
  }
  return { plan: { lap: guide.lap, lap_time: Number(guide.lap_time) || null, own: guide.lap === s.id }, count, rows };
}

// ---------- sessions ----------
// An evening at the wheel: the recordings of one car on one track with no more than 45
// minutes between them. For each: its laps in order, the best one, how far apart they were,
// and the ideal lap, put together from the best time through each tenth of the timed lap.
const SESSION_GAP_MS = 45 * 60e3, SECTORS = 10;
// Where a run that was not finished ended: how far along the track, in which section, and
// whether the car had left the road in its last 150 metres.
function endOf(root, l, edges) {
  try {
    const rec = get(root, l.id), a = rec && analysis(root, rec).a;
    if (!a) return null;
    const g = a.g, last = a.m - 1, s = (a.i0 + last) * a.step;
    let off = 0;
    for (let i = Math.max(0, last - Math.round(150 / a.step)); i <= last; i++) if (g.dl && g.dl[i] !== null && Math.min(g.dl[i], g.dr[i]) < -1.0) off += a.step;
    return { s: Math.round(s), name: sectionName(l, edges, s), off: off >= 4 };
  } catch (err) { console.error(err.message); return null; }
}
// One session looked at as a whole: what kept coming back lap after lap. A slip in one lap
// is chance; the same thing in most laps is a habit, and habits are where the time is.
const HABIT_SHARE = 0.6;
const FINDING_NAMES = { coast: 'toczenie bez pedałów', lift: 'gaz cofnięty po dodaniu', abs: 'ABS', tc: 'kontrola trakcji', steer: 'korekty kierownicą', overlap: 'gaz i hamulec jednocześnie',
  rebrake: 'drugie dohamowanie', soft: 'długie, lekkie hamowanie', radius: 'ciaśniejsza linia niż możliwa', off: 'poza torem', exit: 'niewykorzystane wyjście', apex: 'daleko od szczytu', entry: 'wąskie wejście' };
const FINDING_KIND = { coast: 'throttle', lift: 'throttle', tc: 'throttle', abs: 'brake', rebrake: 'brake', soft: 'brake', overlap: 'brake', steer: 'steer' };
function sessionNoteFile(root, s) {
  const first = get(root, s.laps[0].id);
  return first ? path.join(path.dirname(first.files[0]), 'session_' + s.from.replace(/[-:]/g, '').replace('T', '_').slice(0, 13) + '.coach.md') : null;
}
function sessionReview(root, ref, from) {
  const s = sessions(root, ref).find(x => x.from === from);
  if (!s) return null;
  const first = get(root, s.laps[0].id), sum = first.summary, guide = guideStatus(root, sum), edges = edgesFor(root, sum);
  const done = s.laps.filter(l => l.complete), median = v => v.slice().sort((p, q) => p - q)[v.length >> 1];
  // ---- against the plan the overlay follows now ----
  const byCorner = new Map();
  let judged = 0;
  for (const l of done) {
    if (guide && guide.lap === l.id) continue; // the plan's own lap is the yardstick, not a pass to judge
    let r = null;
    try { r = report(root, get(root, l.id)); } catch (err) { console.error(err.message); }
    if (!r) continue;
    judged++;
    for (const x of r.rows) {
      if (x.traffic) continue;
      const t = byCorner.get(x.n) || { n: x.n, name: x.name, passes: 0, early: [], gas: [], slow: [], weight: 0 };
      byCorner.set(x.n, t);
      t.passes++; t.weight += x.weight;
      if (x.early) t.early.push(-x.dBrake);
      if (x.gasLate) t.gas.push(x.dGas);
      if (x.slow) t.slow.push(-x.dSpeed);
    }
  }
  const habits = [];
  for (const t of byCorner.values()) {
    const often = v => v.length >= Math.max(2, Math.ceil(t.passes * HABIT_SHARE)), parts = [];
    if (often(t.early)) parts.push({ kind: 'brake', text: 'hamulec za wcześnie, zwykle o ' + median(t.early) + ' m', count: t.early.length });
    if (often(t.gas)) parts.push({ kind: 'throttle', text: 'gaz za późno, zwykle o ' + median(t.gas) + ' m', count: t.gas.length });
    if (often(t.slow)) parts.push({ kind: 'accent', text: 'wolniej w szczycie, zwykle o ' + median(t.slow) + ' km/h', count: t.slow.length });
    if (parts.length) habits.push({ n: t.n, name: t.name, passes: t.passes, parts, weight: Math.round(t.weight / t.passes * 100) / 100 });
  }
  habits.sort((p, q) => q.weight - p.weight);
  // ---- what the recordings themselves show, plan or no plan ----
  const seen = new Map();
  let analysed = 0;
  for (const l of done) {
    let res = null;
    try { res = analysis(root, get(root, l.id)); } catch (err) { console.error(err.message); }
    if (!res || !res.a) continue;
    analysed++;
    for (const f of res.a.findings) {
      const key = f.corner + '#' + f.type, c = res.a.corners.find(x => x.n === f.corner);
      const t = seen.get(key) || { n: f.corner, name: c ? sectionName(sum, edges, (c.s0 + c.s1) / 2) : '', type: f.type, count: 0, score: 0 };
      seen.set(key, t);
      t.count++; t.score += f.score;
    }
  }
  const findings = [...seen.values()].filter(t => t.count >= Math.max(2, Math.ceil(analysed * HABIT_SHARE)))
    .map(t => ({ n: t.n, name: t.name, type: t.type, kind: FINDING_KIND[t.type] || 'accent', text: FINDING_NAMES[t.type] || t.type, count: t.count, score: Math.round(t.score / t.count * 100) / 100 }))
    .sort((p, q) => q.score * q.count - p.score * p.count);
  let note = null;
  try { note = fs.readFileSync(sessionNoteFile(root, s), 'utf8'); } catch { /* not reviewed yet */ }
  return { session: s, game: sum.game, track: sum.track, track_config: sum.track_config, plan: guide ? { lap: guide.lap, lap_time: Number(guide.lap_time) || null } : null,
    judged, analysed, habits, findings, ends: s.laps.filter(l => l.end).map(l => Object.assign({ id: l.id, at: l.at, km: l.km }, l.end)), note };
}
function sessions(root, ref) {
  const same = l => l.game === ref.game && l.track === ref.track && (l.track_config || '') === (ref.track_config || '');
  const laps = list(root).filter(same).sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));
  if (!laps.length) return [];
  const track = trackFor(root, laps[0]), edges = edgesFor(root, laps[0]), timing = timingFor(root, laps[0]);
  const start = timing ? timing.start : 0, finish = timing ? timing.finish : track.length;
  const bounds = Array.from({ length: SECTORS + 1 }, (_, k) => start + (finish - start) * k / SECTORS);
  const names = bounds.slice(0, -1).map((b, k) => {
    const a = sectionName(laps[0], edges, b + 150), z = sectionName(laps[0], edges, bounds[k + 1] - 150);
    return a && z && a !== z ? a + ' – ' + z : a || z || '';
  });
  const end = l => new Date(new Date(l.recorded_at).getTime() + (l.duration_s || 0) * 1000);
  const groups = [];
  for (const l of laps) {
    const g = groups[groups.length - 1];
    if (g && g.car === l.car && new Date(l.recorded_at) - g.until <= SESSION_GAP_MS) { g.laps.push(l); g.until = end(l); }
    else groups.push({ car: l.car, from: l.recorded_at, until: end(l), laps: [l] });
  }
  const out = [];
  let before = {}; // best valid time per car before the session
  for (const g of groups) {
    const timed = g.laps.filter(l => l.complete && l.lap_time_s), valid = timed.filter(l => l.valid);
    const sectors = new Map();
    for (const l of valid) {
      try {
        const a = analysis(root, get(root, l.id)).a;
        const t = a && bounds.slice(0, -1).map((b, k) => timeBetween(a, b, bounds[k + 1]));
        if (t && t.every(v => v !== null && v > 0)) sectors.set(l.id, t);
      } catch (err) { console.error(err.message); }
    }
    const bestLap = valid.slice().sort((p, q) => p.lap_time_s - q.lap_time_s)[0] || null;
    const s = {
      // (recording times are local wall-clock times, and so is this one)
      car: g.car, from: g.from, until: new Date(g.until.getTime() - g.until.getTimezoneOffset() * 60000).toISOString().slice(0, 19),
      laps: g.laps.map(l => ({ id: l.id, at: l.recorded_at, time: l.complete ? l.lap_time_s : null, valid: l.valid, complete: l.complete, km: Math.round(l.length_m / 100) / 10,
        end: l.complete ? null : endOf(root, l, edges) })),
      count: timed.length, aborted: g.laps.filter(l => !l.complete).length,
      best: bestLap && { id: bestLap.id, time: bestLap.lap_time_s }, previous: before[g.car] || null,
      spread: null, ideal: null, losses: []
    };
    if (valid.length >= 3) {
      const mean = valid.reduce((sum, l) => sum + l.lap_time_s, 0) / valid.length;
      s.spread = Math.sqrt(valid.reduce((sum, l) => sum + (l.lap_time_s - mean) ** 2, 0) / valid.length);
    }
    if (sectors.size >= 2 && bestLap && sectors.has(bestLap.id)) {
      const best = bounds.slice(0, -1).map((_, k) => Math.min(...[...sectors.values()].map(t => t[k])));
      // the game's own clock for the best lap, less what its sectors lose to the best ones (the two clocks agree to a hundredth)
      const mine = sectors.get(bestLap.id), loss = mine.map((t, k) => t - best[k]);
      s.ideal = bestLap.lap_time_s - loss.reduce((p, q) => p + q, 0);
      s.losses = loss.map((v, k) => ({ sector: k + 1, name: names[k], loss: Math.round(v * 100) / 100 })).filter(x => x.loss >= 0.05).sort((p, q) => q.loss - p.loss).slice(0, 3);
    }
    if (bestLap && (!before[g.car] || bestLap.lap_time_s < before[g.car])) before = Object.assign({}, before, { [g.car]: bestLap.lap_time_s });
    out.push(s);
  }
  return out.reverse();
}

// ---------- how good the plan's promises were ----------
// Each time the plan is put on a new lap, what it estimated there was to gain is written
// down. When a faster lap follows, the two can be set side by side.
function planHistory(root, s) {
  try { return JSON.parse(fs.readFileSync(guideBase(root, s) + '.history.json', 'utf8')).plans || []; } catch { return []; }
}
function notePlan(root, s, plan) {
  const plans = planHistory(root, s), last = plans[plans.length - 1];
  if (last && last.lap === s.id) return; // the estimate made when the plan was first put on this lap stands
  // (the whole plan's estimate, whatever part of it the focus lets through at a time)
  plans.push({ at: new Date().toISOString().slice(0, 19), lap: s.id, lap_time: s.lap_time_s || null, gain: plan.fullGain, changes: plan.fullChanges });
  fs.writeFileSync(guideBase(root, s) + '.history.json', JSON.stringify({ plans }, null, 2));
}
function planAccount(root, s) {
  const plans = planHistory(root, s).filter(p => p.lap_time), out = [];
  for (let i = 0; i + 1 < plans.length; i++) if (plans[i + 1].lap_time < plans[i].lap_time)
    out.push({ from: plans[i].lap_time, to: plans[i + 1].lap_time, estimated: plans[i].gain, gained: Math.round((plans[i].lap_time - plans[i + 1].lap_time) * 1000) / 1000 });
  return out;
}

// Coach note: a Markdown file next to the lap's first recording, written after the session review.
function noteFile(lap) { return lap.files[0].replace(/\.csv$/i, '.coach.md'); }
function note(lap) {
  const f = noteFile(lap);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

module.exports = { sessions, sessionReview, sessionNoteFile, report, overlayBeep, overlayDevice, plans, refreshPlans, refreshPlan, setPlan, planOption, planConfig, lineFor, edgesFor, targetFor, planFor, guideStatus, writeGuide, overlayDemo, overlaySettings, overlayStatus, list, overview, get, detail, comparison, analysis, note, noteFile, timingFor, timeBetween, trackFile, trackFor, trackView };
