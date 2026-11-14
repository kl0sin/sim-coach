// Lap analysis on the track's distance grid: per-corner driving metrics, the observations
// drawn from them, and lap-to-lap comparison. Everything here is deterministic arithmetic
// on the recorded channels; the written coaching on top of it comes from the post-session review.
const { locate } = require('./track');
const { tightest } = require('./raceline');

const pl = (v, d) => v.toFixed(d).replace('.', ',');
const STEER_SWING = 15; // degrees of steering wheel
const HALF_CAR = 1.0;   // metres from the car's centre line to the outside of its tyres
// Centre line this far beyond the limit counts as off the track: the whole car is then past
// the asphalt edge. Running two wheels over the kerb stays well inside this.
const OFF_TRACK = 1.5;

const HINTS = {
  coast: 'Bez gazu i hamulca auto ani skutecznie nie zwalnia, ani nie przyspiesza. Zwykle to znak zbyt wczesnego hamowania albo czekania z gazem.',
  lift: 'Gaz dodany, a potem cofnięty oznacza, że przyszedł za wcześnie lub za mocno jak na linię, którą jechało auto.',
  abs: 'ABS skraca skuteczność hamowania i utrudnia skręt. Odrobinę mniejszy nacisk albo wcześniejsze puszczanie hamulca przy dokręcaniu.',
  tc: 'Kontrola trakcji ucina moc na wyjściu. Łagodniejsze dodawanie gazu albo prostsza kierownica przy pełnym gazie.',
  steer: 'Poprawki kierownicą w środku zakrętu to walka z autem: zwykle za duża prędkość na wejściu albo niespokojne ręce.',
  overlap: 'Gaz i hamulec naraz mają sens tylko jako świadoma technika. Dłuższe nakładanie zwykle kosztuje czas i grzeje hamulce.',
  rebrake: 'Drugie naciśnięcie hamulca oznacza, że pierwsze było za wczesne lub za słabe i trzeba było poprawić.',
  soft: 'W aucie z dociskiem najwięcej hamowania jest na początku, przy dużej prędkości. Mocniejsze pierwsze uderzenie i krótsza strefa.',
  off: 'Całe auto znalazło się za krawędzią asfaltu. Granice toru pochodzą z Assetto Corsa i są dokładne do około metra.',
  radius: 'Większy promień to wyższa prędkość przy tej samej przyczepności. Linia optymalna jest geometryczna: nie zna pochylenia toru, tarek ani nierówności.',
  exit: 'Niewykorzystana szerokość na wyjściu to zwykle za późny lub za ostrożny gaz. Wyjątek: gdy trzeba ustawić auto pod kolejny zakręt.',
  apex: 'Im bliżej wewnętrznej krawędzi w szczycie, tym większy promień łuku i wyższa prędkość przy tej samej przyczepności.',
  entry: 'Wejście z zewnętrznej strony toru otwiera łuk. Wyjątek: gdy poprzedni zakręt wyrzuca auto na drugą stronę.'
};

// samples: [{ p: [x, y, z], r: csvRow, w: seconds on the lap's clock }] for the moving part
// of the lap, in order.
// timing (optional): { start, finish } of the timed lap along the track. When the lap covers
// both lines, corners and totals are limited to that stretch, leaving out the run to the
// start line and the cool-down after the finish.
// edges (optional): { left, right } lateral position of the track limits along the model,
// same sign convention as a lap's lateral offset (positive = right of the model line).
// line (optional): the geometric reference line between those limits (raceline.js).
function analyze(track, samples, ix, timing, edges, line) {
  const STEP = track.step;
  const S = [], K = [], LAT = [];
  let hint = -1, lastS = -Infinity;
  for (let k = 0; k < samples.length; k++) {
    const p = samples[k].p;
    const loc = locate(track, p[0], p[2], hint);
    if (loc.d2 > 40 * 40) continue;               // away from the reference line
    if (lastS - loc.s > track.length / 2) {
      // Crossed the start of the track model. A recording that begins a few metres before
      // it starts over from here; otherwise this is the end of the lap.
      if (S.length > 300) break;
      S.length = K.length = LAT.length = 0;
      lastS = -Infinity;
    }
    if (loc.s <= lastS) continue;                 // stationary or reversing
    hint = loc.i; lastS = loc.s;
    S.push(loc.s); K.push(k); LAT.push(loc.lat);
  }
  if (S.length < 50) return null;
  const i0 = Math.ceil(S[0] / STEP), i1 = Math.floor(S[S.length - 1] / STEP), m = i1 - i0 + 1;
  if (m < 25) return null;

  const g = {};
  for (const c of ['t', 'v', 'th', 'br', 'st', 'gear', 'x', 'z', 'e', 'lat', 'abs', 'tc', 'kb']) g[c] = new Array(m);
  const has = c => ix[c] !== undefined;
  // Newer recordings also carry the distance to the nearest car ahead, the fuel and the tyre temperature.
  if (has('ahead_m')) g.ahead = new Array(m);
  let fuel0 = null, fuel1 = null, tyreSum = 0, tyreCnt = 0;
  let j = 0, lastGear = 0;
  for (let i = 0; i < m; i++) {
    const s = (i0 + i) * STEP;
    while (j + 2 < S.length && S[j + 1] < s) j++;
    const a = samples[K[j]], b = samples[K[j + 1]];
    const span = S[j + 1] - S[j], f = span > 0 ? Math.max(0, Math.min(1, (s - S[j]) / span)) : 0;
    const lerp = c => a.r[ix[c]] + (b.r[ix[c]] - a.r[ix[c]]) * f;
    const flag = c => (has(c) && (a.r[ix[c]] !== 0 || b.r[ix[c]] !== 0) ? 1 : 0);
    g.t[i] = a.w + (b.w - a.w) * f; g.v[i] = lerp('speed'); g.th[i] = lerp('throttle'); g.br[i] = lerp('brake'); g.st[i] = lerp('steer');
    g.x[i] = a.p[0] + (b.p[0] - a.p[0]) * f; g.e[i] = a.p[1] + (b.p[1] - a.p[1]) * f; g.z[i] = a.p[2] + (b.p[2] - a.p[2]) * f;
    g.lat[i] = LAT[j] + (LAT[j + 1] - LAT[j]) * f;
    const gear = (f < 0.5 ? a : b).r[ix.gear];
    if (gear !== 0) lastGear = gear;               // the game reports neutral during shifts
    g.gear[i] = lastGear;
    g.abs[i] = flag('abs'); g.tc[i] = flag('tc'); g.kb[i] = flag('kerb');
    if (g.ahead) { const p = a.r[ix.ahead_m], q = b.r[ix.ahead_m]; g.ahead[i] = p > 0 && q > 0 ? p + (q - p) * f : p > 0 ? p : q > 0 ? q : -1; }
    if (has('fuel') && a.r[ix.fuel] > 0) { if (fuel0 === null) fuel0 = a.r[ix.fuel]; fuel1 = a.r[ix.fuel]; }
    if (has('tyre_c') && a.r[ix.tyre_c] > 0) { tyreSum += a.r[ix.tyre_c]; tyreCnt++; }
  }

  // Distance from the car's centre line to each track limit (negative: beyond it).
  if (edges) {
    g.dl = new Array(m); g.dr = new Array(m);
    for (let i = 0; i < m; i++) {
      const l = edges.left[i0 + i], r = edges.right[i0 + i];
      g.dl[i] = l === null || l === undefined ? null : g.lat[i] - l;
      g.dr[i] = r === null || r === undefined ? null : r - g.lat[i];
    }
  }

  const idx = s => Math.round(s / STEP) - i0;
  const sOf = i => (i0 + i) * STEP;
  const sumTime = (a, b, pred) => { let t = 0; for (let i = a; i < b; i++) if (pred(i)) t += g.t[i + 1] - g.t[i]; return t; };

  // Stretch the totals refer to: the timed lap when its lines are known and covered.
  let ra = 0, rb = m - 1, timed = false;
  if (timing && idx(timing.start) >= 0 && idx(timing.finish) <= m - 1) { ra = idx(timing.start); rb = idx(timing.finish); timed = true; }

  // The driven line against the reference line through one corner: the tightest radius of
  // each, what that is worth at the same grip, and where the two differ (at the reference
  // line's own turn-in point, apex and exit point).
  function againstLine(c, out, p) {
    const K = i => i0 + i, right = c.dir === 'R';
    const gap = (side, i) => { const e = edges[side][K(i)]; return e === null || e === undefined ? null : side === 'right' ? e - line.off[K(i)] : line.off[K(i)] - e; };
    const lIn = i => gap(right ? 'right' : 'left', i), lOut = i => gap(right ? 'left' : 'right', i);
    const least = (fn, from, to) => { let best = null, bv = Infinity; for (let i = Math.max(0, from); i <= Math.min(m - 1, to); i++) { const v = fn(i); if (v !== null && v < bv) { bv = v; best = i; } } return best; };
    const jApex = least(lIn, p.a, p.b);
    if (jApex === null) return null;
    const jEntry = least(lOut, Math.max(p.zs, p.a - 75), jApex), jExit = least(lOut, jApex, p.ze);
    const mine = tightest(g.x, g.z, p.a, p.b), ideal = tightest(line.x, line.z, K(p.a), K(p.b));
    let beyond = 0; // how far the car's centre went past the room the reference line was given (kerbs, or limits that are off here)
    for (let i = Math.max(0, p.a - 15); i <= Math.min(m - 1, p.b + 15); i++) beyond = Math.max(beyond, line.lo[K(i)] - g.lat[i], g.lat[i] - line.hi[K(i)]);
    const diff = (mineArr, fn, j) => (j === null || mineArr[j] === null || fn(j) === null ? null : mineArr[j] - fn(j));
    const res = {
      rDrv: mine.radius, rLine: ideal.radius, gain: 0, beyond,
      entryDiff: diff(p.outside, lOut, jEntry), apexDiff: diff(p.inside, lIn, jApex), exitDiff: diff(p.outside, lOut, jExit),
      apexShift: (p.iApex - jApex) * STEP, apexS: sOf(jApex), advice: [], codes: []
    };
    // worth naming only when clearly larger; never more than 8%, the model is too plain for bigger promises
    if (out.significant && c.angle >= 30 && mine.radius < 400 && ideal.radius >= mine.radius * 1.12)
      res.gain = Math.round(Math.min(out.vMin * (Math.sqrt(ideal.radius / mine.radius) - 1), out.vMin * 0.08));
    if (res.entryDiff !== null && res.entryDiff >= 1.5) { res.codes.push('entry'); res.advice.push('wejście ' + pl(res.entryDiff, 1) + ' m dalej od zewnętrznej krawędzi'); }
    // (a long corner can have two apexes; a shift of more than 40 m compares one with the other and says nothing)
    if (c.angle >= 40 && res.apexShift <= -12 && res.apexShift >= -40) { res.codes.push('early'); res.advice.push('szczyt ' + Math.round(-res.apexShift) + ' m za wcześnie'); }
    else if (c.angle >= 40 && res.apexShift >= 12 && res.apexShift <= 40) { res.codes.push('late'); res.advice.push('szczyt ' + Math.round(res.apexShift) + ' m za późno'); }
    if (res.apexDiff !== null && res.apexDiff >= 1.2) { res.codes.push('apex'); res.advice.push('w szczycie ' + pl(res.apexDiff, 1) + ' m dalej od wewnętrznej'); }
    if (res.exitDiff !== null && res.exitDiff >= 1.5) { res.codes.push('exit'); res.advice.push('na wyjściu ' + pl(res.exitDiff, 1) + ' m toru zostaje'); }
    return res;
  }

  const corners = [];
  track.corners.forEach((c, ci) => {
    const prev = track.corners[ci - 1], next = track.corners[ci + 1];
    const zs = idx(Math.max(prev ? prev.s1 : 0, c.s0 - 250)), ze = idx(Math.min(next ? next.s0 : track.length, c.s1 + 200));
    const a = idx(c.s0), b = idx(c.s1);
    if (zs < 0 || ze > m - 1) return; // this lap does not cover the whole corner
    if (timed && (a < ra || b > rb)) return; // outside the timed lap

    let iMin = a;
    for (let i = Math.max(zs, a - 8); i <= Math.min(ze, b + 8); i++) if (g.v[i] < g.v[iMin]) iMin = i;
    let iIn = zs;
    for (let i = zs; i <= iMin; i++) if (g.v[i] > g.v[iIn]) iIn = i;

    // Braking applications on the approach and inside the corner (gaps under 10 m joined).
    const runs = [];
    for (let i = zs, st = -1, gap = 0; i <= b + 1; i++) {
      const on = i <= b && g.br[i] > 5;
      if (on) { if (st < 0) st = i; gap = 0; }
      else if (st >= 0 && (++gap > 5 || i > b)) { const end = i - gap; if (end > st) runs.push([st, end]); st = -1; gap = 0; }
    }
    let main = null, peak = 0, iPeak = 0;
    for (const r of runs) for (let i = r[0]; i <= r[1]; i++) if (g.br[i] > peak) { peak = g.br[i]; iPeak = i; main = r; }

    let iTh = zs;
    for (let i = zs; i <= b; i++) if (g.th[i] < g.th[iTh]) iTh = i;
    const flat = !main && g.th[iTh] >= 90;
    let decel = main ? main[0] : iTh;
    if (!main) while (decel > zs && g.th[decel - 1] < 90) decel--;

    let pickup = null;
    for (let i = main ? main[1] + 1 : iTh; i <= ze - 2; i++) if (g.th[i] > 10 && g.th[i + 1] > 10 && g.th[i + 2] > 10) { pickup = i; break; }
    let full = null;
    if (pickup !== null) for (let i = pickup; i <= ze - 4; i++) { let ok = true; for (let q = 0; q < 5; q++) if (g.th[i + q] < 97) { ok = false; break; } if (ok) { full = i; break; } }
    // Lifts after getting on the throttle: a drop of 20 points below the highest value reached.
    let lifts = 0;
    if (pickup !== null) {
      let top = 0, lifting = false;
      for (let i = pickup; i <= (full === null ? ze : full); i++) {
        if (g.th[i] > top) top = g.th[i];
        if (!lifting && g.th[i] < top - 20) { lifts++; lifting = true; }
        else if (lifting && g.th[i] >= top - 5) lifting = false;
      }
    }
    // Steering reversals inside the corner beyond the normal turn-in / unwind. Only swings of
    // 15 degrees or more count: smaller ones are the wheel following bumps.
    let reversals = 0;
    for (let i = a + 1, ext = g.st[a], dir = 0; i <= b; i++) {
      const d = g.st[i] - ext;
      if (dir === 0) { if (Math.abs(d) > STEER_SWING) { dir = Math.sign(d); ext = g.st[i]; } }
      else if (d * dir > 0) ext = g.st[i];
      else if (Math.abs(d) > STEER_SWING) { reversals++; dir = -dir; ext = g.st[i]; }
    }
    let kerb = 0;
    for (let i = a; i <= b; i++) if (g.kb[i]) kerb += STEP;

    const out = {
      n: c.n, dir: c.dir, angle: c.angle, radius: c.radius, s0: c.s0, s1: c.s1, zs: sOf(zs), ze: sOf(ze),
      flat, vIn: g.v[iIn], vMin: g.v[iMin], sMin: sOf(iMin), vOut: g.v[b], gear: g.gear[iMin],
      brake: main && {
        on: sOf(main[0]), off: sOf(main[1]), peak, dist: sOf(iMin) - sOf(main[0]),
        time: g.t[main[1]] - g.t[main[0]], toPeak: g.t[iPeak] - g.t[main[0]],
        trail: Math.max(0, sOf(main[1]) - c.s0), rebrake: runs.length - 1
      },
      // a corner taken on a lift alone: where the throttle came off, and how far
      // (carried: the throttle was already down on the way in from the corner before, so there is no point to lift at)
      lift: !main && !flat ? { on: sOf(decel), min: g.th[iTh], carried: decel <= zs } : null,
      coast: flat ? 0 : sumTime(decel, pickup === null ? ze : pickup, i => g.th[i] < 5 && g.br[i] < 5),
      pickup: pickup === null ? null : sOf(pickup),
      pickupRel: pickup === null ? null : sOf(pickup) - sOf(iMin),
      toFull: pickup !== null && full !== null ? g.t[full] - g.t[pickup] : null,
      lifts,
      abs: sumTime(zs, b, i => g.abs[i]), tc: sumTime(iMin, ze, i => g.tc[i]),
      overlap: sumTime(zs, ze, i => g.th[i] > 10 && g.br[i] > 10),
      corrections: Math.max(0, reversals - 1), kerb, time: g.t[ze] - g.t[zs]
    };
    // Another car close ahead on the way in or through the corner: what happened here is not
    // the driver's own doing. Close: within a second, or within 25 m.
    if (g.ahead) {
      let gap = Infinity, secs = Infinity;
      for (let i = zs; i <= b; i++) if (g.ahead[i] > 0) { if (g.ahead[i] < gap) gap = g.ahead[i]; const t = g.ahead[i] / Math.max(g.v[i] / 3.6, 5); if (t < secs) secs = t; }
      out.traffic = gap < Infinity ? { gap: Math.round(gap), seconds: Math.round(secs * 10) / 10 } : null;
      out.inTraffic = gap <= 25 || secs <= 1.0;
    }
    out.significant = !flat && (!!main || out.vIn - out.vMin >= 8);
    if (edges) {
      // How much track is left unused: gap between the outer tyres and the limit.
      const inside = c.dir === 'R' ? g.dr : g.dl, outside = c.dir === 'R' ? g.dl : g.dr;
      const least = (arr, from, to) => { let best = null; for (let i = Math.max(0, from); i <= Math.min(m - 1, to); i++) if (arr[i] !== null && (best === null || arr[i] < arr[best])) best = i; return best; };
      const iApex = least(inside, a, b), iExit = iApex === null ? null : least(outside, iApex, ze), iEntry = least(outside, Math.max(zs, a - 75), a + 5);
      let off = 0;
      for (let i = zs; i <= ze; i++) if (g.dl[i] !== null && Math.min(g.dl[i], g.dr[i]) < -OFF_TRACK) off += STEP;
      out.line = {
        apexGap: iApex === null ? null : inside[iApex] - HALF_CAR, apexS: iApex === null ? null : sOf(iApex),
        exitGap: iExit === null ? null : outside[iExit] - HALF_CAR, exitS: iExit === null ? null : sOf(iExit),
        entryGap: iEntry === null ? null : outside[iEntry] - HALF_CAR, off
      };
      if (line && iApex !== null) out.ideal = againstLine(c, out, { a, b, zs, ze, iApex, inside, outside });
    }
    corners.push(out);
  });

  const findings = [];
  const add = (c, type, score, text, hint) => findings.push({ corner: c.n, type, score: Math.round(score * 100) / 100, text, hint: hint || HINTS[type] });
  for (const c of corners) {
    if (!c.significant) continue;
    if (c.coast >= 0.35) add(c, 'coast', c.coast, 'Toczenie bez pedałów: ' + pl(c.coast, 1) + ' s');
    if (c.lifts >= 1) add(c, 'lift', 0.3 * c.lifts, 'Odpuszczenie gazu po jego dodaniu: ' + c.lifts + '×');
    if (c.abs >= 0.3) add(c, 'abs', 0.6 * c.abs, 'ABS aktywny: ' + pl(c.abs, 1) + ' s');
    if (c.tc >= 0.3) add(c, 'tc', 0.6 * c.tc, 'Kontrola trakcji aktywna: ' + pl(c.tc, 1) + ' s');
    if (c.corrections >= 2) add(c, 'steer', 0.15 * c.corrections, 'Korekty kierownicą: ' + c.corrections);
    if (c.overlap >= 0.5) add(c, 'overlap', 0.4 * c.overlap, 'Gaz i hamulec jednocześnie: ' + pl(c.overlap, 1) + ' s');
    if (c.brake && c.brake.rebrake >= 1) add(c, 'rebrake', 0.3, 'Drugie dohamowanie w strefie hamowania');
    if (c.brake && c.brake.peak < 60 && c.brake.time > 1.2 && c.vIn - c.vMin > 40)
      add(c, 'soft', 0.3, 'Długie, lekkie hamowanie: szczyt ' + Math.round(c.brake.peak) + '%, ' + pl(c.brake.time, 1) + ' s');
    // Line findings only for real corners; the limits are accurate to roughly a metre.
    const l = c.line;
    if (c.ideal && c.ideal.gain > 0) add(c, 'radius', 0.08 * c.ideal.gain, 'Linia: promień ' + Math.round(c.ideal.rDrv) + ' m, możliwy ' + Math.round(c.ideal.rLine) + ' m (ok. +' + c.ideal.gain + ' km/h)',
      (c.ideal.advice.length ? 'Względem linii optymalnej: ' + c.ideal.advice.join(', ') + '. ' : '') + HINTS.radius);
    if (l && l.off >= 4) add(c, 'off', 1 + l.off / 50, 'Poza torem na ok. ' + l.off + ' m');
    if (l && c.angle >= 25) {
      if (l.exitGap !== null && l.exitGap >= 2) add(c, 'exit', 0.2 * l.exitGap, 'Na wyjściu zostaje ok. ' + pl(l.exitGap, 1) + ' m toru');
      if (l.apexGap !== null && l.apexGap >= 1.5) add(c, 'apex', 0.2 * l.apexGap, 'Apex ok. ' + pl(l.apexGap, 1) + ' m od wewnętrznej krawędzi');
      if (c.brake && c.angle >= 40 && l.entryGap !== null && l.entryGap >= 2) add(c, 'entry', 0.1 * l.entryGap, 'Wejście ok. ' + pl(l.entryGap, 1) + ' m od zewnętrznej krawędzi');
    }
  }
  findings.sort((p, q) => q.score - p.score);

  const total = g.t[rb] - g.t[ra] || 1;
  let top = 0;
  for (let i = ra; i <= rb; i++) if (g.v[i] > top) top = g.v[i];
  const share = pred => sumTime(ra, rb, pred) / total;
  const summary = {
    timed, from: sOf(ra), to: sOf(rb),
    time: total, length: (rb - ra) * STEP, avgSpeed: (rb - ra) * STEP / total * 3.6, topSpeed: top,
    full: share(i => g.th[i] >= 97), brake: share(i => g.br[i] > 5), coast: share(i => g.th[i] < 5 && g.br[i] <= 5),
    coastTime: corners.reduce((sum, c) => sum + (c.significant ? c.coast : 0), 0),
    absTime: sumTime(ra, rb, i => g.abs[i]), tcTime: sumTime(ra, rb, i => g.tc[i]),
    overlapTime: sumTime(ra, rb, i => g.th[i] > 10 && g.br[i] > 10),
    corners: corners.length, braked: corners.filter(c => c.brake).length,
    // context a lap time depends on, where the recording has it
    fuel: fuel0 === null ? null : { start: fuel0, end: fuel1 }, tyreTemp: tyreCnt ? tyreSum / tyreCnt : null,
    traffic: g.ahead ? corners.filter(c => c.inTraffic).length : null
  };

  return { i0, i1, m, step: STEP, g, corners, findings, summary };
}

// B against reference A, on the stretch of track both laps cover.
// delta > 0: B is behind A at that point.
function compare(A, B) {
  let lo = Math.max(A.i0, B.i0), hi = Math.min(A.i1, B.i1);
  // two timed laps are compared from the start line to the finish line only
  if (A.summary.timed && B.summary.timed) { lo = Math.max(lo, Math.round(A.summary.from / A.step)); hi = Math.min(hi, Math.round(A.summary.to / A.step)); }
  if (hi - lo < 25) return null;
  const a0 = lo - A.i0, b0 = lo - B.i0, len = hi - lo + 1;
  const delta = new Array(len), lat = new Array(len), dv = new Array(len);
  for (let i = 0; i < len; i++) {
    delta[i] = (B.g.t[b0 + i] - B.g.t[b0]) - (A.g.t[a0 + i] - A.g.t[a0]);
    lat[i] = B.g.lat[b0 + i] - A.g.lat[a0 + i];
    dv[i] = B.g.v[b0 + i] - A.g.v[a0 + i];
  }
  const byN = new Map(A.corners.map(c => [c.n, c]));
  const corners = [];
  for (const b of B.corners) {
    const a = byN.get(b.n);
    if (!a) continue;
    corners.push({
      n: b.n, dTime: b.time - a.time, dVMin: b.vMin - a.vMin, dVOut: b.vOut - a.vOut,
      dBrake: a.brake && b.brake ? b.brake.on - a.brake.on : null,   // > 0: B brakes later
      dPickup: a.pickup !== null && b.pickup !== null ? b.pickup - a.pickup : null // > 0: B on throttle later
    });
  }
  return { i0: lo, i1: hi, step: A.step, total: delta[len - 1], delta, lat, dv, corners };
}

module.exports = { analyze, compare };
