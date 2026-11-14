// The plan the overlay coaches towards. Not a replay of the best lap: the best lap with its
// braking points, slowest speeds and throttle points moved to where the recordings say
// there is time left, one careful step at a time.
//
// Three kinds of evidence, in order of trust:
//   1. proven   another clean pass through the corner braked later (or carried more speed,
//               or went back on the throttle earlier) and was not slower;
//   2. limit    a pass that braked later ended off the track or clearly slower: the plan
//               stays short of that point;
//   3. model    how hard this car has been shown to brake (from every recorded braking
//               zone) against how long this zone took. Zones the driver stretches much more
//               than their own better ones have room; the plan takes half of it.
const GRAVITY = 9.81;
const BIN = 25;                 // km/h per speed band of the braking model
const STEP_SHARE = 0.5;         // share of the estimated room taken per revision of the plan
const STEP_SECONDS = 0.25;      // and never more than this much later at the approach speed
const TOTAL_SECONDS = 0.35;     // the most a braking point moves in one revision, proven part included, at the approach speed
const MIN_SHIFT = 5;            // metres: a smaller change is finer than anyone can place a braking point
const MIN_STEP = 3;             // metres: the least worth adding on top of a braking point already proven
const PROVEN_CAP = 30;          // metres: a much later braking point on another lap is a different approach, not proof
const LIMIT_MARGIN = 5;         // metres kept short of a braking point that went wrong
const SPEED_STEP = 8;           // km/h: the most a target speed is raised in one revision

const quantile = (values, q) => {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b), f = (v.length - 1) * q, i = Math.floor(f);
  return i + 1 < v.length ? v[i] + (v[i + 1] - v[i]) * (f - i) : v[i];
};

// Deceleration on level ground (m/s2) the car has reached under hard braking, by speed.
function brakingModel(analyses) {
  const bins = new Map(), all = [];
  for (const a of analyses) {
    const g = a.g, ds = 2 * a.step;
    for (let i = 2; i < a.m - 1; i++) {
      if (g.br[i] < 80 || g.br[i - 2] < 60 || g.v[i] < 60) continue; // past the first squeeze of the pedal
      const v0 = g.v[i - 1] / 3.6, v1 = g.v[i + 1] / 3.6;
      const level = (v0 * v0 - v1 * v1) / (2 * ds) - GRAVITY * (g.e[i + 1] - g.e[i - 1]) / ds; // uphill helps, so take its share out
      if (!(level > 2 && level < 40)) continue;
      const k = Math.floor(g.v[i] / BIN);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(level); all.push(level);
    }
  }
  const overall = quantile(all, 0.7) || 10, points = [];
  for (const [k, list] of [...bins.entries()].sort((p, q) => p[0] - q[0])) if (list.length >= 15) points.push({ v: (k + 0.5) * BIN, a: quantile(list, 0.7), n: list.length });
  const at = v => {
    if (!points.length) return overall;
    if (v <= points[0].v) return points[0].a;
    for (let i = 1; i < points.length; i++) if (v <= points[i].v) { const p = points[i - 1], q = points[i]; return p.a + (q.a - p.a) * (v - p.v) / (q.v - p.v); }
    return points[points.length - 1].a;
  };
  return { points, overall, samples: all.length, at };
}

// Metres this pass would have needed from its braking point down to its slowest speed at the
// car's demonstrated braking, on this stretch's own gradient.
function needed(a, model, c, last) {
  const g = a.g, i0 = Math.round(c.brake.on / a.step) - a.i0;
  let v = g.v[i0] / 3.6, d = 0;
  const vEnd = (last || c).vMin / 3.6;
  for (let i = i0; i < a.m - 1 && v > vEnd && d < 800; i++) {
    const dec = model.at(v * 3.6) + GRAVITY * (g.e[i + 1] - g.e[i]) / a.step;
    const v2 = v * v - 2 * Math.max(1, dec) * a.step;
    if (v2 <= vEnd * vEnd) { d += (v * v - vEnd * vEnd) / (2 * Math.max(1, dec)); break; }
    v = Math.sqrt(v2); d += a.step;
  }
  return d;
}
const realBraking = c => !!c.brake && c.brake.peak >= 70 && c.vIn - c.vMin >= 25 && c.brake.dist >= 10;
const offTrack = c => !!c.line && c.line.off >= 4;

// A corner's zone reaches into the approach of the next one. Braking found there, after the
// corner's own slowest point, is the next corner's braking: hand it over, so that it has its
// real starting point instead of the edge of its zone. Works on copies; the analysis is shared.
function ownCorners(a) {
  const list = a.corners.map(c => Object.assign({}, c, { brake: c.brake && Object.assign({}, c.brake) }));
  for (let k = 0; k + 1 < list.length; k++) {
    const c = list[k], next = list[k + 1];
    if (!c.brake || !next.brake || c.brake.on < c.sMin - 4 || next.brake.on > c.brake.off + 10) continue;
    next.brake.on = Math.min(next.brake.on, c.brake.on); next.brake.dist = next.sMin - next.brake.on;
    next.brake.peak = Math.max(next.brake.peak, c.brake.peak);
    next.vIn = Math.max(next.vIn, a.g.v[Math.round(next.brake.on / a.step) - a.i0]);
    c.brake = null;
  }
  return list;
}

// Corners braked for as one: the brake stays on into the next corner, or is let go for a
// moment and pressed again without the car being asked to accelerate in between. Returns
// the last corner of the chain that starts at corners[k] (corners[k] itself when it stands alone).
function chainEnd(a, corners, k) {
  let end = k;
  for (;;) {
    const c = corners[end], next = corners[end + 1];
    if (!next || !next.brake || !c.brake || next.vMin > c.vMin - 10) break;
    const gap = next.brake.on - c.brake.off;
    if (gap > 80) break;
    let throttle = 0;
    for (let s = c.brake.off; s <= next.brake.on; s += a.step) throttle = Math.max(throttle, a.g.th[Math.round(s / a.step) - a.i0] || 0);
    if (gap > 4 && throttle > 30) break;
    end++;
  }
  return end;
}

// A recording that ends inside a corner after the car left the road or came to a stop there
// (the drive back to the pits): what the analysis could not measure as a corner still says
// where braking began on the pass that went wrong.
function abortedPass(track, a, c, ci, refA) {
  const prev = track.corners[ci - 1], next = track.corners[ci + 1], step = a.step, g = a.g;
  const zs = Math.round(Math.max(prev ? prev.s1 : 0, c.s0 - 250) / step) - a.i0, ze = Math.round(Math.min(next ? next.s0 : track.length, c.s1 + 200) / step) - a.i0;
  const end = a.m - 1;
  if (zs < 0 || end < zs + 5 || end >= ze) return null; // not started here, or the corner is whole
  let off = 0, on = -1, peak = 0;
  for (let i = zs; i <= end; i++) {
    if (g.dl && g.dl[i] !== null && Math.min(g.dl[i], g.dr[i]) < -1.0) off += step;
    if (g.br[i] > 5 && on < 0) on = i;
    if (g.br[i] > peak) peak = g.br[i];
  }
  const k = a.i0 + end - refA.i0, refSpeed = k >= 0 && k < refA.m ? refA.g.v[k] : null;
  const stopped = refSpeed !== null && refSpeed > 80 && g.v[end] < refSpeed * 0.5;
  if (off < 4 && !stopped) return null;
  return { on: on >= 0 && peak >= 50 ? (a.i0 + on) * step : null, off, stopped };
}

/**
 * @param track  the track model
 * @param ref    { id, when, a } the lap the plan starts from (a: its analysis)
 * @param others [{ id, when, a }] every other analysed recording of this track and car
 */
function build(track, ref, others) {
  const every = [ref, ...others].filter(l => l.a);
  for (const l of every) l.corners = ownCorners(l.a);
  const model = brakingModel(every.map(l => l.a));
  // how much of the distance their braking zones use, over all recordings: the driver's own standard
  const shares = [];
  for (const l of every) l.corners.forEach((c, k) => {
    if (realBraking(c) && chainEnd(l.a, l.corners, k) === k) shares.push(Math.min(1, needed(l.a, model, c) / c.brake.dist));
  });
  // the level of their better zones (not the very best one, which may be a fluke)
  const standard = quantile(shares, 0.85) || 0.8;

  const corners = [], carried = new Set();
  let gain = 0, changes = 0;
  track.corners.forEach((tc, ci) => {
    const c = ref.corners.find(x => x.n === tc.n);
    if (!c) return;
    const out = { n: c.n, changes: [], why: [], cue: '', gain: 0, caution: false, carried: carried.has(c.n),
      brake: null, minSpeed: { ref: c.vMin, target: c.vMin, seen: null }, pickup: { ref: c.pickup, target: c.pickup, shift: 0 } };
    const passes = [];
    for (const l of others) {
      if (!l.a) continue;
      const p = l.corners.find(x => x.n === c.n);
      if (p) passes.push({ lap: l, c: p, clean: !offTrack(p), traffic: !!p.inTraffic });
      else { const ab = abortedPass(track, l.a, tc, ci, ref.a); if (ab) passes.push({ lap: l, aborted: ab, clean: false }); }
    }
    // Evidence is a pass the driver had to himself: one with another car close ahead says
    // nothing about what he could do here.
    const clean = passes.filter(p => p.clean && !p.traffic);
    // An incident here calls for care until the corner has been driven cleanly twice since.
    const cleanSince = at => clean.filter(q => q.lap.at > at).length + (ref.at > at && !offTrack(c) ? 1 : 0);
    if (offTrack(c) || passes.some(p => !p.clean && !p.traffic && cleanSince(p.lap.at) < 2)) out.caution = true;

    // ---- braking point ----
    if (c.brake) {
      const b = out.brake = { ref: c.brake.on, target: c.brake.on, shift: 0, proven: 0, room: 0, limit: null, share: null };
      const v0 = ref.a.g.v[Math.round(c.brake.on / ref.a.step) - ref.a.i0];
      // One braking for several corners is judged as one: from where it starts to the
      // slowest point of the last of them. The corners after the first have no braking
      // point of their own.
      const k = ref.corners.indexOf(c), last = out.carried ? c : ref.corners[chainEnd(ref.a, ref.corners, k)];
      if (last !== c) { b.chain = last.n; for (let q = k + 1; ref.corners[q - 1] !== last; q++) carried.add(ref.corners[q].n); }
      if (!out.carried && (realBraking(c) || last !== c)) {
        const need = needed(ref.a, model, c, last), used = last.sMin - c.brake.on;
        b.share = need / used;
        b.room = Math.max(0, used - need / standard);
        // the tyres were already at their limit for a good part of this braking: no later, or less
        const abs = ref.corners.slice(k, ref.corners.indexOf(last) + 1).reduce((sum, x) => sum + x.abs, 0);
        if (abs >= 1.0) { b.room = 0; b.abs = abs; } else if (abs >= 0.5) b.room /= 2;
      }
      let proof = null;
      for (const p of clean) {
        if (!p.c.brake) continue;
        const later = p.c.brake.on - c.brake.on;
        if (later >= MIN_SHIFT && later <= PROVEN_CAP && p.c.time <= c.time + 0.03 && later > b.proven) { b.proven = later; proof = p; }
      }
      for (const p of passes) {
        // a later braking point that ended off the road, or cost a clear quarter of a second
        const on = p.aborted ? p.aborted.on : p.c.brake ? p.c.brake.on : null;
        // (much later than the lap braked is another way of taking the corner, not a step beyond this one)
        if (on === null || on - c.brake.on < MIN_SHIFT || on - c.brake.on > PROVEN_CAP + 10 || p.traffic) continue;
        // a limit lasts until a later clean pass brakes as late and gets away with it
        if (clean.some(q => q.c.brake && q.lap.at > p.lap.at && q.c.brake.on >= on - 3 && q.c.time <= c.time + 0.25)) continue;
        // (slower with a clearly lower slowest speed: the mark of going in too deep, not of traffic or a cautious lap)
        const bad = p.aborted || !p.clean || (p.c.time >= c.time + 0.25 && p.c.vMin <= c.vMin - 5);
        if (bad && (b.limit === null || on - c.brake.on < b.limit.later)) b.limit = { later: on - c.brake.on, lap: p.lap.id, when: p.lap.when, off: !!p.aborted || !p.clean };
      }
      const cap = STEP_SECONDS * v0 / 3.6;
      let step = out.carried ? 0 : Math.min(STEP_SHARE * Math.max(b.room - b.proven, 0), cap);
      if (step < MIN_STEP) step = 0;
      if (out.carried) b.proven = 0;
      let shift = b.proven + step;
      // short of a braking point that went wrong: by a margin if it only cost time, by half if it left the road
      const ceiling = b.limit ? (b.limit.off ? b.limit.later / 2 : b.limit.later - LIMIT_MARGIN) : Infinity;
      if (shift > ceiling) { shift = Math.max(0, ceiling); b.limited = true; }
      if (offTrack(c)) shift = 0; // the reference pass itself left the road here: no later
      shift = Math.min(shift, TOTAL_SECONDS * v0 / 3.6); // however good the evidence, one revision moves a point only so far
      shift = Math.round(shift);
      if (shift >= MIN_SHIFT) {
        b.shift = shift; b.target = c.brake.on + shift;
        out.gain += shift * (3.6 / Math.max(30, last.vMin) - 3.6 / Math.max(30, v0));
        out.changes.push('brake');
        const extra = Math.round(shift - Math.min(shift, b.proven));
        if (proof && !extra) out.why.push('Na okrążeniu z ' + proof.lap.when + ' hamowanie było ' + Math.round(b.proven) + ' m dalej i zakręt nie wyszedł wolniej.');
        else if (proof) out.why.push('Na okrążeniu z ' + proof.lap.when + ' hamowanie było już ' + Math.round(b.proven) + ' m dalej bez straty; plan dokłada kolejne ' + extra + ' m.');
        if (extra && b.share !== null) out.why.push((b.chain ? 'To jedno hamowanie aż do Z' + b.chain + ': od ' + Math.round(v0) + ' do ' + Math.round(last.vMin) + ' km/h na ' + Math.round(last.sMin - c.brake.on) + ' m. Wykorzystuje ' : 'Ta strefa hamowania wykorzystuje ')
          + Math.round(b.share * 100) + '% możliwości auta, Twoje lepsze strefy ' + Math.round(standard * 100) + '%. Zapas ok. ' + Math.round(b.room) + ' m, plan bierze z niego ' + extra + ' m.');
      } else if (b.abs) out.why.push('ABS pracował tu ' + b.abs.toFixed(1).replace('.', ',') + ' s: opony były już na granicy, więc plan nie przesuwa hamowania dalej.');
      if (b.limit && (b.limited || b.limit.off)) out.why.push('Hamowanie ' + Math.round(b.limit.later) + ' m dalej (' + b.limit.when + ') ' + (b.limit.off ? 'skończyło się poza torem' : 'kosztowało czas') + ': plan zostaje wyraźnie przed tym punktem.');
    }

    // ---- slowest speed ----
    // (not where the braking runs on into the next corner: the lowest speed inside this one is just a moment of that braking)
    if (!out.caution && !(out.brake && out.brake.chain)) {
      let fastest = null;
      for (const p of clean) if (p.c.vMin >= c.vMin + 3 && p.c.time <= c.time - 0.05 && (!fastest || p.c.time < fastest.c.time)) fastest = p;
      const raise = fastest ? Math.round(Math.min((fastest.c.vMin - c.vMin) / 2, SPEED_STEP)) : 0;
      if (raise >= 3) {
        out.minSpeed.seen = fastest.c.vMin;
        out.minSpeed.target = Math.round(c.vMin) + raise;
        out.changes.push('speed');
        out.gain = Math.max(out.gain, (c.time - fastest.c.time) * raise / (fastest.c.vMin - c.vMin));
        out.why.push('Na okrążeniu z ' + fastest.lap.when + ' najwolniejszy punkt był o ' + Math.round(fastest.c.vMin - c.vMin) + ' km/h szybszy i zakręt wyszedł o ' + (c.time - fastest.c.time).toFixed(2).replace('.', ',') + ' s lepiej. Plan podnosi cel o ' + raise + ' km/h.');
      }
    }

    // ---- back on the throttle ----
    if (c.pickup !== null && c.significant) {
      const rel = c.pickupRel;
      let target = c.pickup;
      if (rel >= 8 && !out.caution) {
        // past the slowest point with no throttle yet: half the way back, or as early as a clean pass already did
        target = c.sMin + Math.round(rel / 2);
        for (const p of clean) if (p.c.pickup !== null && p.c.pickup < target && p.c.pickup >= c.sMin - 4 && p.c.vOut >= c.vOut - 1 && p.c.lifts === 0) target = Math.max(p.c.pickup, c.sMin);
        out.why.push('Gaz wracał ' + Math.round(rel) + ' m za najwolniejszym punktem. Plan przesuwa go o ' + Math.round(c.pickup - target) + ' m wcześniej.');
      } else if (rel <= -25 && c.lifts >= 1 && c.vMin < 150) {
        // a slow corner, on the throttle long before the slowest point, then off it again: wait, then once
        target = Math.min(c.sMin - 6, c.pickup + 40);
        out.why.push('Gaz wracał ' + Math.round(-rel) + ' m przed najwolniejszym punktem i trzeba go było cofać (' + c.lifts + '×). Plan: ' + Math.round(target - c.pickup) + ' m później, za to jednym ruchem.');
      }
      target = Math.round(target);
      if (Math.abs(target - c.pickup) >= 4) { out.pickup.target = target; out.pickup.shift = target - c.pickup; out.changes.push('throttle'); }
    }

    // ---- one short line for the overlay ----
    const bits = [];
    const b = out.brake;
    const offLimit = b && b.limit && b.limit.off ? Math.round(b.limit.later) : 0;
    if (offLimit && !b.shift) bits.push('Tu limit: ' + offLimit + ' m dalej było poza torem');
    if (b && b.shift) bits.push('Hamuj ' + b.shift + ' m dalej' + (offLimit ? ', przy ' + offLimit + ' było poza torem' : b.chain ? ', jednym ciągiem do Z' + b.chain : ''));
    if (out.minSpeed.seen !== null) bits.push('Cel ' + out.minSpeed.target + ' km/h, było już ' + Math.round(out.minSpeed.seen));
    if (out.pickup.shift < 0) bits.push('Gaz ' + (-out.pickup.shift) + ' m wcześniej');
    else if (out.pickup.shift > 0) bits.push('Z gazem poczekaj, potem jednym ruchem');
    out.cue = bits.length > 1 && (bits[0] + ' · ' + bits[1]).length <= 48 ? bits[0] + ' · ' + bits[1] : bits[0] || '';
    out.gain = Math.round(out.gain * 100) / 100;
    if (out.changes.length) { changes++; gain += out.gain; }
    corners.push(out);
  });
  return { corners, gain: Math.round(gain * 10) / 10, changes, standard, model: { points: model.points, overall: model.overall, samples: model.samples }, laps: every.length };
}

module.exports = { build, brakingModel, ownCorners };
