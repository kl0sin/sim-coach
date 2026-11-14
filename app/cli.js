// Text dump of a lap's analysis, used for the post-session review.
// Usage: node app/cli.js laps
//        node app/cli.js analyze <number from "laps" | lap id> [--all]
//        node app/cli.js compare <lap> <reference lap>
//        node app/cli.js gates <number of any lap on that track>   (find the timing lines)
//        node app/cli.js refresh                                    (bring the overlay's plans up to date)
const fs = require('fs');
const path = require('path');
const laps = require('./lib/laps');

const ROOT = path.join(__dirname, '..', 'data', 'laps');
const all = laps.list(ROOT);
const pick = arg => {
  const s = /^\d+$/.test(arg || '') ? all[Number(arg) - 1] : all.find(l => l.id === arg || l.id.endsWith(arg || '\0'));
  if (!s) { console.error('lap not found: ' + arg); process.exit(1); }
  return laps.get(ROOT, s.id);
};
const f = (v, d = 0) => (v === null || v === undefined ? '-' : v.toFixed(d));
const lapTime = s => (s ? Math.floor(s / 60) + ':' + (s - Math.floor(s / 60) * 60).toFixed(3).padStart(6, '0') : '-');
const [cmd, a1, a2] = process.argv.slice(2);

if (cmd === 'laps' || !cmd) {
  all.forEach((l, i) => console.log(`${String(i + 1).padStart(2)}. ${l.recorded_at}  ${lapTime(l.lap_time_s).padStart(9)} ${(l.lap_time_source || '').padEnd(9)}  ${(l.length_m / 1000).toFixed(2).padStart(5)} km  ${l.complete ? 'full   ' : 'partial'}${l.valid ? '        ' : ' invalid'} ${l.pieces} file(s)  ${l.track} ${l.track_config} | ${l.car}`));
} else if (cmd === 'analyze') {
  const lap = pick(a1), s0 = lap.summary;
  const { track, a } = laps.analysis(ROOT, lap);
  if (!a) { console.log('no analysis (too short or off the reference line)'); process.exit(0); }
  const s = a.summary;
  console.log(`${s0.track} ${s0.track_config} | ${s0.car} | ${s0.recorded_at} | game time ${lapTime(s0.lap_time_s)}`);
  console.log(`track model: ${track.length} m, ${track.corners.length} corners, source ${track.source}${track.provisional ? ' (provisional)' : ''}`);
  console.log(`covered ${(a.i0 * a.step / 1000).toFixed(2)}-${(a.i1 * a.step / 1000).toFixed(2)} km in ${f(s.time, 1)} s | avg ${f(s.avgSpeed)} top ${f(s.topSpeed)} km/h`);
  console.log(`time share: full throttle ${f(s.full * 100)}%  braking ${f(s.brake * 100)}%  coasting ${f(s.coast * 100)}% | corner coasting ${f(s.coastTime, 1)} s | ABS ${f(s.absTime, 1)} s | TC ${f(s.tcTime, 1)} s | throttle+brake ${f(s.overlapTime, 1)} s | braked corners ${s.braked}/${s.corners}`);
  console.log('\nFINDINGS (score, corner, text)');
  for (const x of a.findings) console.log(`  ${f(x.score, 2).padStart(5)}  Z${String(x.corner).padEnd(3)} ${x.text}`);
  console.log('\nCORNERS  n dir angle radius | km | vIn vMin vOut gear | brake: mBefore peak% time s trail m | coast s | throttle: m after vMin, s to full, lifts | abs tc corr kerb');
  for (const c of a.corners) {
    if (!c.significant && !process.argv.includes('--all')) continue;
    const b = c.brake;
    console.log(`  Z${String(c.n).padEnd(3)} ${c.dir} ${String(c.angle).padStart(3)}deg R${String(c.radius).padStart(4)} | ${(c.sMin / 1000).toFixed(2)} | ${f(c.vIn).padStart(3)} ${f(c.vMin).padStart(3)} ${f(c.vOut).padStart(3)} g${c.gear} | ${b ? `${f(b.dist).padStart(3)} ${f(b.peak).padStart(3)}% ${f(b.time, 1)} ${f(b.trail).padStart(3)}${b.rebrake ? ' x' + (b.rebrake + 1) : ''}` : (c.flat ? 'flat' : 'lift').padEnd(16)} | ${f(c.coast, 1)} | ${f(c.pickupRel).padStart(4)} ${f(c.toFull, 1).padStart(4)} ${c.lifts} | ${f(c.abs, 1)} ${f(c.tc, 1)} ${c.corrections} ${c.kerb}`);
  }
} else if (cmd === 'compare') {
  const c = laps.comparison(ROOT, pick(a1), pick(a2));
  if (!c) { console.log('laps do not overlap'); process.exit(0); }
  console.log(`delta over ${(c.i0 * c.step / 1000).toFixed(2)}-${((c.i0 + c.delta.length - 1) * c.step / 1000).toFixed(2)} km: ${c.total >= 0 ? '+' : ''}${c.total.toFixed(3)} s vs reference`);
  for (const x of c.corners.slice().sort((p, q) => q.dTime - p.dTime))
    console.log(`  Z${String(x.n).padEnd(3)} ${(x.dTime >= 0 ? '+' : '') + x.dTime.toFixed(2)} s | vMin ${f(x.dVMin, 1)} | brake ${f(x.dBrake)} m | throttle ${f(x.dPickup)} m`);
} else if (cmd === 'gates') {
  // The game times a lap between two lines whose positions it does not publish. For a finish
  // line at s, each lap with a known game time implies a start line (where the lap was that
  // much time earlier). The true finish is where all laps imply the same start.
  const any = pick(a1).summary, sameTrack = l => l.game === any.game && l.track === any.track && l.track_config === any.track_config;
  const known = all.filter(l => sameTrack(l) && l.complete && l.lap_time_s).map(l => ({ l, a: laps.analysis(ROOT, laps.get(ROOT, l.id)).a })).filter(x => x.a);
  if (known.length < 2) { console.log('need at least two complete laps with a game lap time, have ' + known.length); process.exit(0); }
  const tAt = (a, s) => { const q = s / a.step - a.i0, i = Math.floor(q); return i < 0 || i + 1 >= a.m ? null : a.g.t[i] + (a.g.t[i + 1] - a.g.t[i]) * (q - i); };
  const sAtTime = (a, t) => { let lo = 0, hi = a.m - 1; if (t < a.g.t[0] || t > a.g.t[hi]) return null; while (hi - lo > 1) { const mid = (lo + hi) >> 1; a.g.t[mid] <= t ? lo = mid : hi = mid; } return (a.i0 + lo + (t - a.g.t[lo]) / (a.g.t[hi] - a.g.t[lo] || 1)) * a.step; };
  const len = known[0].a.i1 * known[0].a.step;
  let best = null;
  const rows = [];
  for (let s = len * 0.5; s <= len; s += 1) {
    const starts = known.map(k => { const t = tAt(k.a, s); return t === null ? null : sAtTime(k.a, t - k.l.lap_time_s); });
    if (starts.some(v => v === null)) continue;
    const spread = Math.max(...starts) - Math.min(...starts), start = starts.reduce((p, q) => p + q, 0) / starts.length;
    rows.push([s, start, spread]);
    if (!best || spread < best.spread) best = { finish: s, start, spread };
  }
  if (!best) { console.log('no finish position is covered by all laps'); process.exit(0); }
  for (const r of rows.filter((_, i) => i % 100 === 0)) console.log(`finish ${(r[0] / 1000).toFixed(2)} km -> start ${(r[1] / 1000).toFixed(3)} km, disagreement ${r[2].toFixed(1)} m`);
  const within = rows.filter(r => r[2] < best.spread + 3);
  console.log(`\nbest: start ${best.start.toFixed(0)} m, finish ${best.finish.toFixed(0)} m (laps disagree by ${best.spread.toFixed(1)} m); within 3 m of best: finish ${within[0][0].toFixed(0)}-${within[within.length - 1][0].toFixed(0)} m`);
  for (const k of known) console.log(`  ${k.l.recorded_at}: game ${k.l.lap_time_s.toFixed(3)} s, telemetry ${laps.timeBetween(k.a, best.start, best.finish).toFixed(3)} s`);
  if (process.argv.includes('--write')) {
    const file = laps.trackFile(ROOT, any, '.timing.json');
    fs.writeFileSync(file, JSON.stringify({ start: Math.round(best.start), finish: Math.round(best.finish), disagreement_m: +best.spread.toFixed(1), laps: known.map(k => k.l.id) }, null, 2));
    console.log('written ' + file);
  }
} else if (cmd === 'line') {
  // node app/cli.js line <lap>   (the geometric reference line of the lap's track, against the lap's own line)
  const lap = pick(a1), t0 = Date.now(), line = laps.lineFor(ROOT, lap.summary);
  if (!line) { console.log('no track limits for this track'); process.exit(0); }
  const { track, edges, a } = laps.analysis(ROOT, lap), tightest = require('./lib/raceline').tightest;
  let atLimit = 0, far = 0;
  for (let i = 0; i < line.n; i++) { if (edges.left[i] === null) continue; const l = line.off[i] - edges.left[i], r = edges.right[i] - line.off[i]; if (Math.min(l, r) < line.margin + 0.05) atLimit++; far = Math.max(far, Math.abs(line.off[i])); }
  console.log(`line ready in ${Date.now() - t0} ms | active-set rounds ${line.rounds}, unsettled points ${line.unsettled}, worst overshoot ${line.outside.toFixed(3)} m, last polishing sweep moved ${line.moved.toExponential(1)} m | on a limit at ${(atLimit / line.n * 100).toFixed(0)}% of points | furthest from the model line ${far.toFixed(1)} m`);
  if (!a) process.exit(0);
  console.log('\n  n   angle | radius: driven, line | slowest: driven -> same grip on the line | driven line beyond the room the reference line was given (m, worst point)');
  for (const c of a.corners) {
    if (!c.significant || c.angle < 25) continue;
    const i0 = Math.round(c.s0 / track.step), i1 = Math.round(c.s1 / track.step);
    const mine = tightest(a.g.x, a.g.z, i0 - a.i0, i1 - a.i0), ideal = tightest(line.x, line.z, i0, i1);
    console.log(`  Z${String(c.n).padEnd(3)} ${String(c.angle).padStart(3)}deg | ${f(mine.radius).padStart(4)} ${f(ideal.radius).padStart(4)} | ${f(c.vMin).padStart(3)} -> ${f(c.vMin * Math.sqrt(ideal.radius / mine.radius)).padStart(3)} | ${(() => { let worst = Infinity; for (let k = i0 - 15; k <= i1 + 15; k++) { const lat = a.g.lat[k - a.i0]; if (lat !== undefined) worst = Math.min(worst, lat - line.lo[k], line.hi[k] - lat); } return worst < 0 ? (-worst).toFixed(1) : '-'; })()}`);
  }
} else if (cmd === 'target') {
  // node app/cli.js target <lap>   (the plan the overlay would coach towards, starting from this lap)
  const lap = pick(a1), plan = laps.targetFor(ROOT, lap), a = laps.analysis(ROOT, lap).a;
  if (!plan) { console.log('no analysis for this lap'); process.exit(0); }
  console.log(`from ${plan.laps} recordings | braking model (km/h: m/s2) ${plan.model.points.map(p => p.v + ': ' + p.a.toFixed(1) + ' (' + p.n + ')').join(', ')} | overall ${plan.model.overall.toFixed(1)}`);
  console.log(`driver's own standard: braking zones use ${(plan.standard * 100).toFixed(0)}% of that | ${plan.changes} corners changed | estimated gain ${plan.gain} s`);
  console.log('\n  n   | brake: ref m, share, room, proven, limit -> shift | vMin ref -> target (seen) | throttle ref -> shift | gain | cue');
  for (const t of plan.corners) {
    const c = a.corners.find(x => x.n === t.n), b = t.brake;
    if (!c.significant && !t.changes.length && !process.argv.includes('--all')) continue;
    console.log(`  Z${String(t.n).padEnd(3)}| ${b ? `${f(b.ref).padStart(5)} ${b.share === null ? '  - ' : (b.share * 100).toFixed(0).padStart(3) + '%'} ${f(b.room).padStart(3)} ${f(b.proven).padStart(3)} ${b.limit ? f(b.limit.later).padStart(3) + (b.limit.off ? '!' : ' ') : '  - '} -> ${String(b.shift).padStart(2)}` : '        -                 '.padEnd(31)} | ${f(t.minSpeed.ref).padStart(3)} -> ${f(t.minSpeed.target).padStart(3)} ${t.minSpeed.seen ? '(' + f(t.minSpeed.seen) + ')' : '     '} | ${f(c.pickupRel).padStart(4)} -> ${String(t.pickup.shift).padStart(3)} | ${t.gain.toFixed(2)} | ${t.caution ? '[caution] ' : ''}${t.carried ? '[carried] ' : ''}${b && b.chain ? '[to Z' + b.chain + '] ' : ''}${t.cue}`);
    if (process.argv.includes('--why')) for (const w of t.why) console.log('         ' + w);
  }
} else if (cmd === 'guide') {
  // node app/cli.js guide <lap>   (write the overlay's driving plan from this lap)
  const lap = pick(a1);
  console.log(JSON.stringify(laps.writeGuide(ROOT, lap)));
} else if (cmd === 'refresh') {
  // node app/cli.js refresh   (bring every plan up to date with the recordings; the plugin runs this after each lap)
  const t0 = Date.now(), done = laps.refreshPlans(ROOT);
  for (const p of done) console.log(`${p.track} | ${p.car}: plan on ${p.lap_time || 'a lap without a time'}, ${p.changes} changes${p.moved ? ' (moved to a new lap)' : p.changed ? ' (rewritten)' : ' (unchanged)'}`);
  console.log(`refresh: ${done.length} plan(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} else if (cmd === 'import-ac') {
  // node app/cli.js import-ac <number of any lap on that track> <AC track layout folder>
  // e.g. ...\assettocorsa\content\tracks\ks_nordschleife\touristenfahrten
  const any = pick(a1).summary;
  if (!a2 || !fs.existsSync(path.join(a2, 'ai', 'fast_lane.ai'))) { console.error('no ai/fast_lane.ai in ' + a2); process.exit(1); }
  const edges = require('./lib/acimport').importTrack(laps.trackFor(ROOT, any), a2);
  const widths = edges.left.map((l, i) => (l === null ? null : edges.right[i] - l)).filter(w => w !== null).sort((p, q) => p - q);
  console.log('fit', JSON.stringify(edges.fit));
  console.log(`limits for ${widths.length} of ${edges.n} points, track width median ${widths[widths.length >> 1].toFixed(1)} m, ${edges.sections.length} named sections`);
  const file = laps.trackFile(ROOT, any, '.edges.json');
  fs.writeFileSync(file, JSON.stringify(edges));
  console.log('written ' + file);
} else {
  console.error('unknown command');
  process.exit(2);
}
