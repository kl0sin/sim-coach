// SimCoach UI: lap list (left), map + traces of the selected lap (centre), coach panel (right).
const $ = id => document.getElementById(id);
const nf = (v, d = 0) => v.toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 0) => (v < 0 ? '−' : '+') + nf(Math.abs(v), d);
// Sequential single-hue ramp for speed, slow to fast. The slow end stays clear of the asphalt colour.
const RAMP = ['#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'];
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const RGB = RAMP.map(hexRgb);
const mix = (a, b, t) => 'rgb(' + [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * t)).join(',') + ')';
const HALF_CAR = 1.0; // metres from the car's centre line to the outside of its tyres

function fmtLap(s) {
  const m = Math.floor(s / 60);
  return m + ':' + (s - m * 60).toFixed(3).padStart(6, '0');
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const api = async url => { try { return await (await fetch(url)).json(); } catch { return null; } };

// ================= data & navigation =================
// Screens: games -> tracks of a game -> laps on a track -> one lap. The address bar holds
// the place (#/g/<game>, #/t/<game>/<track>/<layout>, #/lap/<id>), so Back works.
let allLaps = [], allTracks = [], dataSignature = '';
let route = { screen: 'home' }, selectedId = null;
let carFilter = '', sortBy = 'time';
const GAME_NAMES = { AssettoCorsaEVO: 'Assetto Corsa EVO', AssettoCorsa: 'Assetto Corsa', AssettoCorsaCompetizione: 'Assetto Corsa Competizione', AssettoCorsaRally: 'Assetto Corsa Rally', LMU: 'Le Mans Ultimate', LeMansUltimate: 'Le Mans Ultimate', RFactor2: 'rFactor 2' };
const gameName = g => GAME_NAMES[g] || String(g).replace(/([a-z])([A-Z])/g, '$1 $2');
const circuit = t => String(t.track).replace(/^Nurburgring$/, 'Nürburgring');
const trackName = t => [circuit(t), t.track_config].filter(Boolean).join(' – ');
const trackKey = l => [l.game, l.track, l.track_config || ''].join('|');
const bestOf = laps => { const t = laps.filter(l => l.lap_time_s && l.valid).map(l => l.lap_time_s); return t.length ? Math.min(...t) : null; };
const enc = encodeURIComponent;
const hrefGame = g => '#/g/' + enc(g);
const hrefTrack = t => '#/t/' + enc(t.game) + '/' + enc(t.track) + '/' + enc(t.track_config || '-');
const hrefLap = id => '#/lap/' + enc(id);
const shortDate = iso => new Date(iso).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric' });
const longDate = iso => new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTime = iso => new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const FONT = 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif';
// Canvas text in the same condensed capitals as the rest of the interface.
function condensed(c, size, weight) {
  c.font = (weight || 400) + ' ' + size + 'px ' + FONT;
  if ('fontStretch' in c) c.fontStretch = 'condensed';
  if ('letterSpacing' in c) c.letterSpacing = '0.6px';
}

function parseRoute(hash = location.hash) {
  // (#/lap/<id>?tab=plan&z=30 opens a lap on a tab with a corner picked)
  const [raw, query] = hash.replace(/^#\/?/, '').split('?'), q = new URLSearchParams(query || '');
  const parts = raw.split('/').map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  if (parts[0] === 'g' && parts[1]) return { screen: 'game', game: parts[1] };
  if (parts[0] === 't' && parts[2]) return { screen: 'track', game: parts[1], track: parts[2], track_config: !parts[3] || parts[3] === '-' ? '' : parts[3] };
  if (parts[0] === 'lap' && parts[1]) return { screen: 'lap', id: parts.slice(1).join('/'), want: q.has('tab') || q.has('z') ? { tab: q.get('tab') || 'corners', n: Number(q.get('z')) || 0 } : null };
  if (parts[0] === 'overlay') return { screen: 'overlay' };
  if (parts[0] === 's' && parts[4]) return { screen: 'session', game: parts[1], track: parts[2], track_config: !parts[3] || parts[3] === '-' ? '' : parts[3], from: parts[4] };
  return { screen: 'home' };
}

async function refreshData() {
  const data = await api('/api/overview');
  if (!data) return;
  const sig = data.laps.map(l => l.id + (l.has_note ? '+' : '') + l.pieces + (l.lap_time_s || '')).join('|') + '#' + data.tracks.map(t => (t.limits ? 1 : 0)).join('');
  if (sig === dataSignature) return;
  const first = !dataSignature, noteArrived = D && data.laps.some(l => l.id === selectedId && l.has_note) && !note;
  dataSignature = sig; allLaps = data.laps; allTracks = data.tracks;
  const stat = (label, value) => { const s = el('span', '', label); s.append(el('b', '', String(value))); return s; };
  $('status').replaceChildren(stat('Tory', allTracks.length), stat('Okrążenia', allLaps.filter(l => l.complete).length));
  if (first || route.screen !== 'lap') render();
  else { renderSidebar(); renderCrumbs(); if (noteArrived) loadNote(); if (D) renderCompare(); }
}

// The overlay page is a side trip: the place it was opened from is kept, so that its link in
// the top bar, the path beside it, the page's own back link and Esc all lead back there.
let lastPlace = '#/';
try { lastPlace = sessionStorage.getItem('simcoach.place') || '#/'; } catch { /* no storage: back leads to the first screen */ }
function render() {
  route = parseRoute();
  // a corner asked for in the address is opened once; the address then goes back to the plain lap
  if (route.want) { wantCorner = route.want; history.replaceState(null, '', location.pathname + hrefLap(route.id)); }
  document.body.dataset.screen = route.screen;
  if (route.screen !== 'overlay') { lastPlace = location.hash || '#/'; try { sessionStorage.setItem('simcoach.place', lastPlace); } catch { /* as above */ } }
  $('ovLink').href = route.screen === 'overlay' ? lastPlace : '#/overlay';
  renderCrumbs();
  if (route.screen === 'home') renderHome();
  else if (route.screen === 'game') renderGame();
  else if (route.screen === 'track') renderTrack();
  else if (route.screen === 'overlay') renderOverlayPage();
  else if (route.screen === 'session') renderSession();
  else {
    renderSidebar();
    if (route.id !== selectedId || (!D && loading === 0)) select(route.id);
    else { layout(true); renderStrip(); applyWant(); } // the canvases had no size while another screen was shown
  }
}
addEventListener('hashchange', render);
addEventListener('keydown', e => { if (e.key === 'Escape' && route.screen === 'overlay' && !e.defaultPrevented) location.hash = lastPlace; });

function crumbsOf(r) {
  const lap = r.screen === 'lap' ? allLaps.find(l => l.id === r.id) : null;
  const tr = r.screen === 'track' || r.screen === 'session' ? r : lap, game = r.game || (lap && lap.game);
  const parts = [['Gry', '#/']];
  if (game) parts.push([gameName(game), hrefGame(game)]);
  if (tr) parts.push([trackName(tr), hrefTrack(tr)]);
  if (r.screen === 'lap') parts.push([lap && lap.lap_time_s ? fmtLap(lap.lap_time_s) : 'przejazd', hrefLap(r.id)]);
  if (r.screen === 'session') parts.push(['Sesja ' + new Date(r.from).toLocaleString('pl-PL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }), hrefSession(r, r.from)]);
  return parts;
}
function renderCrumbs() {
  // on the overlay page: the path of the place it was opened from, each step a way back
  const over = route.screen === 'overlay', parts = crumbsOf(over ? parseRoute(lastPlace) : route);
  if (over) {
    const back = $('ovBack'), from = parts[parts.length - 1];
    back.href = lastPlace; back.textContent = '← Wróć: ' + from[0];
    parts.push(['Nakładka', null]);
  }
  const box = $('crumbs');
  box.replaceChildren();
  parts.forEach(([text, href], i) => {
    if (i) box.append(el('span', 'sep', '/'));
    const last = i === parts.length - 1, a = el(last ? 'span' : 'a', last ? 'here' : '', text);
    if (!last) a.href = href;
    box.append(a);
  });
}

// ---------- the circuit in 3D ----------
// Axonometric drawing of a line with its elevation: the line itself, a translucent wall
// down to a ground plane, and the plan of the line on that plane. Elevation is exaggerated,
// otherwise 300 m of climb would vanish next to 20 km of track.
class Track3D {
  constructor(canvas, o = {}) {
    this.cv = canvas; this.c = canvas.getContext('2d');
    this.yaw = o.yaw === undefined ? -0.55 : o.yaw;
    this.pitch = o.pitch === undefined ? 0.6 : o.pitch; // camera height above the horizon, radians
    this.exag = o.exag || 6; this.lw = o.lineWidth || 2.4; this.stride = o.stride || 1;
    this.color = o.color || null; this.grid = o.grid !== false; this.labels = !!o.labels; this.tight = !!o.tight;
    this.onHover = o.onHover || null; this.zoom = 1; this.hover = -1; this.ghost = -1; this.at = o.at || 0.5; this.highlight = null; this.n = 0; this.raf = 0;
    if (o.interactive) this.bind();
  }
  setData(x, y, z) {
    this.x = x; this.y = y; this.z = z; this.n = x.length;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < this.n; i++) { x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); z0 = Math.min(z0, z[i]); z1 = Math.max(z1, z[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
    this.cx = (x0 + x1) / 2; this.cz = (z0 + z1) / 2; this.y0 = y0; this.yr = y1 - y0;
    this.R = 0; this.iHi = 0; this.iLo = 0;
    for (let i = 0; i < this.n; i++) { this.R = Math.max(this.R, Math.hypot(x[i] - this.cx, z[i] - this.cz)); if (y[i] > y[this.iHi]) this.iHi = i; if (y[i] < y[this.iLo]) this.iLo = i; }
    this.sx = new Float32Array(this.n); this.sy = new Float32Array(this.n); this.gy = new Float32Array(this.n); this.d = new Float32Array(this.n);
  }
  // world point -> screen; h is the height above the lowest point, in metres
  to(wx, wz, h) {
    const X = wx - this.cx, Z = wz - this.cz, cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const xr = X * cy - Z * sy, zr = X * sy + Z * cy;
    return [this.ox + xr * this.s, this.oy + (zr * Math.sin(this.pitch) - h * this.exag * Math.cos(this.pitch)) * this.s, zr];
  }
  draw() {
    const r = this.cv.getBoundingClientRect(), dpr = devicePixelRatio || 1, c = this.c;
    if (!r.width || !this.n) return;
    if (this.cv.width !== Math.round(r.width * dpr) || this.cv.height !== Math.round(r.height * dpr)) { this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr); }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, lift = this.yr * this.exag * Math.cos(this.pitch);
    this.s = this.zoom * 0.9 * Math.min(W / (2 * this.R), H / (2 * this.R * Math.sin(this.pitch) + lift));
    this.ox = W * this.at; this.oy = H / 2 + lift * this.s / 2;
    if (this.tight) {
      this.s = 1; this.ox = 0; this.oy = 0;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < this.n; i++) {
        const p = this.to(this.x[i], this.z[i], this.y[i] - this.y0), q = this.to(this.x[i], this.z[i], 0);
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1], q[1]); y1 = Math.max(y1, p[1], q[1]);
      }
      this.s = Math.min((W - 8) / (x1 - x0 || 1), (H - 8) / (y1 - y0 || 1));
      this.ox = W / 2 - (x0 + x1) / 2 * this.s; this.oy = H / 2 - (y0 + y1) / 2 * this.s;
    }
    c.clearRect(0, 0, W, H);
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (let i = 0; i < this.n; i++) {
      const p = this.to(this.x[i], this.z[i], this.y[i] - this.y0);
      this.sx[i] = p[0]; this.sy[i] = p[1]; this.d[i] = p[2];
      this.gy[i] = p[1] + (this.y[i] - this.y0) * this.exag * Math.cos(this.pitch) * this.s;
    }
    if (this.grid) { // ground plane
      const g = [100, 250, 500, 1000, 2500].find(v => v * this.s > 34) || 5000, m = Math.ceil(this.R / g) * g;
      c.strokeStyle = css.grid; c.lineWidth = 1; c.beginPath();
      for (let v = -m; v <= m + 1; v += g) {
        let a = this.to(this.cx + v, this.cz - m, 0), b = this.to(this.cx + v, this.cz + m, 0);
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
        a = this.to(this.cx - m, this.cz + v, 0); b = this.to(this.cx + m, this.cz + v, 0);
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      }
      c.stroke();
    }
    c.strokeStyle = css.axis; c.lineWidth = 1; c.beginPath(); // the plan of the line on the ground
    for (let i = 0; i < this.n; i++) i ? c.lineTo(this.sx[i], this.gy[i]) : c.moveTo(this.sx[i], this.gy[i]);
    c.stroke();
    // far to near, so that nearer walls cover what is behind them
    const st = this.stride, order = [];
    for (let i = 0; i + st < this.n; i += st) order.push(i);
    order.sort((a, b) => this.d[a] - this.d[b]);
    const dMin = -this.R, dSpan = 2 * this.R || 1, hl = this.highlight;
    for (const i of order) {
      const j = Math.min(this.n - 1, i + st), near = Math.max(0, Math.min(1, (this.d[i] - dMin) / dSpan));
      const lit = hl && i >= hl[0] && i <= hl[1];
      c.globalAlpha = 1;
      c.fillStyle = lit ? 'rgba(255,214,10,0.22)' : 'rgba(237,235,230,' + (0.035 + 0.05 * near).toFixed(3) + ')';
      c.beginPath(); c.moveTo(this.sx[i], this.gy[i]); c.lineTo(this.sx[j], this.gy[j]); c.lineTo(this.sx[j], this.sy[j]); c.lineTo(this.sx[i], this.sy[i]); c.closePath(); c.fill();
      c.globalAlpha = 0.4 + 0.6 * near;
      c.strokeStyle = this.color ? this.color(i) : css.ink; c.lineWidth = this.lw;
      c.beginPath(); c.moveTo(this.sx[i], this.sy[i]); c.lineTo(this.sx[j], this.sy[j]); c.stroke();
    }
    c.globalAlpha = 1;
    if (this.labels) {
      condensed(c, 14, 600); c.textBaseline = 'middle';
      const mark = (i, text, color, up = -26) => {
        c.strokeStyle = color; c.lineWidth = 1; c.beginPath(); c.moveTo(this.sx[i], this.sy[i]); c.lineTo(this.sx[i], this.sy[i] + up); c.stroke();
        c.fillStyle = color; c.beginPath(); c.arc(this.sx[i], this.sy[i], 3.5, 0, 7); c.fill();
        c.textAlign = this.sx[i] > W * 0.75 ? 'right' : 'left';
        c.fillText(text, this.sx[i] + (c.textAlign === 'right' ? -7 : 7), this.sy[i] + up);
      };
      mark(this.iHi, 'NAJWYŻEJ ' + nf(this.y[this.iHi]) + ' M', css.ink);
      mark(this.iLo, 'NAJNIŻEJ ' + nf(this.y[this.iLo]) + ' M', css['ink-2']);
      mark(0, 'START', css.accent, 30);
    }
    for (const m of this.marks || []) { // where unfinished runs ended
      if (m.i < 0 || m.i >= this.n) continue;
      const x = this.sx[m.i], y = this.sy[m.i];
      c.fillStyle = css.surface; c.fillRect(x - 6, y - 6, 12, 12);
      if (m.off) { c.fillStyle = css.loss; c.fillRect(x - 4.5, y - 4.5, 9, 9); } else { c.strokeStyle = css['ink-2']; c.lineWidth = 1.5; c.strokeRect(x - 3.75, y - 3.75, 7.5, 7.5); }
    }
    if (this.ghost >= 0) { c.fillStyle = css.ref; c.strokeStyle = css.surface; c.lineWidth = 2; c.beginPath(); c.arc(this.sx[this.ghost], this.sy[this.ghost], 6, 0, 7); c.fill(); c.stroke(); }
    if (this.hover >= 0 && this.hover < this.n) {
      const x = this.sx[this.hover], y = this.sy[this.hover];
      c.strokeStyle = css.ink; c.lineWidth = 1; c.beginPath(); c.moveTo(x, y); c.lineTo(x, this.gy[this.hover]); c.stroke();
      c.fillStyle = this.color ? this.color(this.hover) : css.ink; c.strokeStyle = css.surface; c.lineWidth = 2;
      c.beginPath(); c.arc(x, y, 7, 0, 7); c.fill(); c.stroke();
      c.strokeStyle = css.ink; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 9.5, 0, 7); c.stroke();
    }
  }
  nearest(mx, my) {
    let best = -1, bd = 30 * 30;
    for (let i = 0; i < this.n; i++) { const dx = this.sx[i] - mx, dy = this.sy[i] - my, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
    return best;
  }
  bind() {
    const cv = this.cv;
    let last = null;
    cv.addEventListener('pointerdown', e => { last = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); this.dragged = true; });
    cv.addEventListener('pointermove', e => {
      if (last) {
        this.yaw += (e.clientX - last[0]) * 0.006;
        this.pitch = Math.max(0.2, Math.min(1.5, this.pitch + (e.clientY - last[1]) * 0.005));
        last = [e.clientX, e.clientY];
        this.draw();
      } else if (this.onHover) { const r = cv.getBoundingClientRect(); this.onHover(this.nearest(e.clientX - r.left, e.clientY - r.top)); }
    });
    const up = () => { last = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (!last && this.onHover) this.onHover(-1); });
    cv.addEventListener('wheel', e => { e.preventDefault(); this.zoom = Math.max(0.6, Math.min(8, this.zoom * Math.exp(-e.deltaY * 0.0012))); this.draw(); }, { passive: false });
  }
  // Slow turntable while the canvas is on screen and nobody has grabbed it.
  spin() {
    cancelAnimationFrame(this.raf);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.draw(); return; }
    const step = () => {
      if (!this.cv.isConnected || this.cv.offsetParent === null) return;
      if (!this.dragged) this.yaw += 0.0016;
      this.draw();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  stop() { cancelAnimationFrame(this.raf); }
}
// A small still drawing of a circuit for a board row.
function miniTrack(row, outline) {
  const cv = el('canvas');
  if (!outline) return cv;
  const t3 = new Track3D(cv, { grid: false, lineWidth: 2, tight: true, pitch: 0.72, yaw: -0.35 });
  t3.setData(outline.x, outline.y, outline.z);
  requestAnimationFrame(() => t3.draw());
  return cv;
}
const stat = (label, value, cls, small) => { const s = el('div', 'stat'); s.append(el('span', '', label), el('b', cls || '', value)); if (small) s.append(el('small', '', small)); return s; };

let home3d = null;
function renderHome() {
  const games = [...new Set(allTracks.map(t => t.game))];
  const recentTrack = allTracks.slice().sort((a, b) => (a.last < b.last ? 1 : -1))[0];
  $('homeHero').hidden = !(recentTrack && recentTrack.outline);
  if (recentTrack && recentTrack.outline) {
    $('homeHero').href = hrefTrack(recentTrack);
    const h = $('heroTrack');
    h.replaceChildren(circuit(recentTrack));
    h.append(el('small', '', [recentTrack.track_config, gameName(recentTrack.game)].filter(Boolean).join(' · ')));
    $('heroStats').replaceChildren(stat('Najlepszy czas', recentTrack.best ? fmtLap(recentTrack.best) : '–', 'best'), stat('Okrążenia', String(recentTrack.laps)),
      stat('Przewyższenie', nf(recentTrack.elev_max - recentTrack.elev_min) + ' m'), stat('Jazda', shortDate(recentTrack.last)));
    if (!home3d) { home3d = new Track3D($('home3d'), { lineWidth: 3, at: 0.66, pitch: 0.5 }); home3d.zoom = 1.3; }
    home3d.setData(recentTrack.outline.x, recentTrack.outline.y, recentTrack.outline.z);
    home3d.spin();
  }
  $('homeLead').textContent = games.length
    ? 'Nowe przejazdy pojawiają się tu same, gdy SimHub jest włączony podczas jazdy.'
    : 'Brak zapisanych okrążeń. Uruchom SimHub i przejedź okrążenie, a pojawi się tutaj.';
  $('games').replaceChildren(...games.map((g, i) => {
    const ts = allTracks.filter(t => t.game === g), last = ts.map(t => t.last).sort().pop();
    const a = el('a', 'brow'), name = el('div', 'name', gameName(g));
    a.href = hrefGame(g);
    name.append(el('small', '', ts.map(trackName).slice(0, 3).join(' · ')));
    a.append(el('span', 'n', String(i + 1).padStart(2, '0')), miniTrack(a, ts[0] && ts[0].outline), name,
      stat('Tory', String(ts.length)), stat('Okrążenia', String(ts.reduce((p, t) => p + t.laps, 0))), stat('Ostatnia jazda', shortDate(last)), el('span', 'go', '→'));
    return a;
  }));
  lapTable($('recent'), allLaps.filter(l => l.complete).slice(0, 8), true);
}

function renderGame() {
  $('gameTitle').textContent = gameName(route.game);
  const ts = allTracks.filter(t => t.game === route.game).sort((a, b) => (a.last < b.last ? 1 : -1));
  $('tracks').replaceChildren(...ts.map((t, i) => {
    const a = el('a', 'brow'), name = el('div', 'name', circuit(t));
    a.href = hrefTrack(t);
    name.append(el('small', '', [t.track_config, t.limits && 'z granicami toru'].filter(Boolean).join(' · ')));
    a.append(el('span', 'n', String(i + 1).padStart(2, '0')), miniTrack(a, t.outline), name,
      stat('Najlepszy czas', t.best ? fmtLap(t.best) : '–', 'best', t.best ? t.best_car : ''),
      stat('Okrążenia', String(t.laps)), stat('Długość', t.length_m ? nf(t.length_m / 1000, 1) + ' km' : '–'), el('span', 'go', '→'));
    return a;
  }));
  if (!ts.length) $('tracks').append(el('p', 'muted', 'Brak przejazdów w tej grze.'));
}

// Timing table of laps; with `withTrack` it also names the track (home screen).
function lapTable(table, laps, withTrack) {
  table.replaceChildren();
  const head = el('div', 'thead');
  for (const h of ['', 'Czas', 'Do najlepszego'].concat(withTrack ? ['Tor'] : [], ['Auto', 'Data', 'Maks.', ''])) head.append(el('span', '', h));
  table.append(head);
  laps.forEach((l, i) => {
    const best = bestOf(withTrack ? allLaps.filter(x => trackKey(x) === trackKey(l)) : laps);
    const isBest = l.lap_time_s && l.valid && l.lap_time_s === best;
    const r = el('a', 'trow' + (isBest ? ' best' : ''));
    r.href = hrefLap(l.id);
    const tags = el('span', 'tags');
    if (isBest) tags.append(el('span', 'tag best', 'najlepsze'));
    if (l.complete && !l.valid) tags.append(el('span', 'tag', 'nieważne'));
    if (!l.complete) tags.append(el('span', 'tag', 'niepełne'));
    if (l.has_note) tags.append(el('span', 'tag noted', 'notatka'));
    r.append(
      el('span', 'pos', String(i + 1).padStart(2, '0')),
      l.lap_time_s ? el('span', 'time', fmtLap(l.lap_time_s)) : el('span', 'time none', l.complete ? 'bez czasu' : nf(l.length_m / 1000, 1) + ' km'),
      el('span', 'delta', l.lap_time_s && best && !isBest ? signed(l.lap_time_s - best, 3) : '')
    );
    if (withTrack) r.append(el('span', '', trackName(l)));
    r.append(el('span', withTrack ? 'dim' : '', l.car), el('span', 'dim', dateTime(l.recorded_at)), el('span', 'dim', nf(l.max_speed_kmh) + ' km/h'), tags);
    table.append(r);
  });
  if (!laps.length) table.append(el('p', 'muted', 'Brak przejazdów do pokazania.'));
}

let hero3d = null;
function renderTrack() {
  const t = allTracks.find(x => trackKey(x) === trackKey(route));
  const title = $('trackTitle');
  title.replaceChildren(circuit(route));
  if (route.track_config) title.append(el('small', '', route.track_config));
  $('trackEyebrow').textContent = gameName(route.game);
  const laps = allLaps.filter(l => trackKey(l) === trackKey(route));
  if (!t || !laps.length) { $('trackLead').textContent = 'Brak przejazdów na tym torze.'; for (const id of ['trackFacts', 'carPills', 'sortSeg', 'lapTable']) $(id).replaceChildren(); return; }

  const best = t.best ? stat('Najlepszy czas', fmtLap(t.best), 'best', t.best_car) : stat('Najlepszy czas', '–');
  const unit = (label, value, u) => { const s = stat(label, value); s.querySelector('b').append(el('small', '', u)); return s; };
  $('trackFacts').replaceChildren(best,
    unit(t.timed_m ? 'Odcinek mierzony' : 'Długość', nf((t.timed_m || t.length_m) / 1000, 2), 'km'),
    unit('Przewyższenie', nf(t.elev_max - t.elev_min), 'm'),
    stat('Zakręty', String(t.corners)));
  $('trackLead').textContent = ['Okrążenia: ' + t.laps, 'Auta: ' + t.cars.length, 'Ostatnia jazda: ' + longDate(t.last), t.limits ? 'granice toru z Assetto Corsa' : ''].filter(Boolean).join(' · ');

  if (t.outline) {
    if (!hero3d) { hero3d = new Track3D($('hero3d'), { interactive: true, labels: true, lineWidth: 2.6 }); hero3d.zoom = 1.1; }
    hero3d.setData(t.outline.x, t.outline.y, t.outline.z);
    hero3d.dragged = false;
    hero3d.spin();
    requestAnimationFrame(() => drawProfile($('profile'), t, trackEnds));
  }
  if (carFilter && !t.cars.includes(carFilter)) carFilter = '';
  const pill = (text, value) => { const b = el('button', 'pill', text); b.setAttribute('aria-pressed', carFilter === value); b.onclick = () => { carFilter = value; renderTrack(); }; return b; };
  $('carPills').replaceChildren(pill('Wszystkie auta', ''), ...t.cars.map(car => pill(car, car)));
  $('sortSeg').replaceChildren(...[['time', 'Najlepszy czas'], ['date', 'Najnowsze']].map(([v, text]) => {
    const b = el('button', '', text); b.setAttribute('aria-pressed', sortBy === v); b.onclick = () => { sortBy = v; renderTrack(); }; return b;
  }));
  const shown = laps.filter(l => ($('withPartial').checked || l.complete) && (!$('onlyValid').checked || l.valid) && (!carFilter || l.car === carFilter));
  shown.sort(sortBy === 'date' ? (a, b) => (a.recorded_at < b.recorded_at ? 1 : -1)
    : (a, b) => (a.lap_time_s || Infinity) - (b.lap_time_s || Infinity) || (a.recorded_at < b.recorded_at ? 1 : -1));
  lapTable($('lapTable'), shown, false);
  loadSessions();
}

// ---- sessions: each evening at the wheel as one row ----
let sessionsFor = '', sessionsData = null;
async function loadSessions() {
  const key = trackKey(route) + '#' + dataSignature;
  if (sessionsFor !== key) {
    sessionsFor = key; trackEnds = []; if (hero3d) hero3d.marks = null;
    const data = await api('/api/sessions?game=' + enc(route.game) + '&track=' + enc(route.track) + '&config=' + enc(route.track_config || ''));
    if (sessionsFor !== key || !data) return;
    sessionsData = data.sessions;
  }
  renderSessions();
}
// Lap times of a session in the order they were driven: a dot per lap, lower is faster.
// The best lap is purple, an invalid one hollow, an unfinished one a tick on the baseline.
function sessionChart(s) {
  const NS = 'http://www.w3.org/2000/svg', W = 360, H = 86, L = 8, R = 8, T = 14, B = 16;
  const node = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text !== undefined) e.textContent = text; return e; };
  const svg = node('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'sesschart', role: 'img' });
  const times = s.laps.filter(l => l.time).map(l => l.time), trackBest = bestOf(allLaps.filter(l => trackKey(l) === trackKey(route)));
  if (!times.length) return svg;
  // the scale covers the valid laps; a lap far off them (traffic, a spin) is pinned to the top edge
  const valid = s.laps.filter(l => l.time && l.valid).map(l => l.time), lo = Math.min(...times), hi = Math.max(lo + 2, Math.min(Math.max(...times), (valid.length ? Math.max(...valid) : lo) + 4));
  const n = s.laps.length, X = i => L + (n === 1 ? 0.5 : i / (n - 1)) * (W - L - R), Y = t => T + (H - T - B) * (1 - Math.min(1, (t - lo) / (hi - lo)));
  svg.append(node('line', { x1: L, x2: W - R, y1: H - B + 0.5, y2: H - B + 0.5, class: 'base' }));
  const pts = s.laps.map((l, i) => (l.time ? X(i) + ',' + Y(l.time) : null)).filter(Boolean);
  if (pts.length > 1) svg.append(node('polyline', { points: pts.join(' '), class: 'run' }));
  s.laps.forEach((l, i) => {
    const when = new Date(l.at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    const a = node('a', { href: hrefLap(l.id) });
    if (!l.time) a.append(node('line', { x1: X(i), x2: X(i), y1: H - B - 5, y2: H - B + 5, class: 'cut' }));
    else {
      // purple is the best time on this track, as on a timing screen; a session's own best is only larger
      const best = s.best && l.id === s.best.id, record = best && l.time === trackBest, off = l.time > hi;
      a.append(node('circle', { cx: X(i), cy: Y(l.time), r: best ? 5 : 4, class: 'lapdot' + (record ? ' best' : '') + (l.valid ? '' : ' invalid') + (off ? ' off' : '') }));
      if (best) svg.append(node('text', { x: Math.max(L + 30, Math.min(W - R - 30, X(i))), y: Y(l.time) + 18, class: 'lbl' + (record ? ' best' : ''), 'text-anchor': 'middle' }, fmtLap(l.time)));
    }
    a.append(node('circle', { cx: X(i), cy: l.time ? Y(l.time) : H - B, r: 11, class: 'hit' })); // a larger target than the mark
    a.append(node('title', {}, when + ' · ' + (l.time ? fmtLap(l.time) + (l.valid ? '' : ' · nieważne') : 'przerwane po ' + nf(l.km, 1) + ' km')));
    svg.append(a);
  });
  return svg;
}
function sessionRow(s, link) {
  const row = el('div', 'sess'), head = el('div', 'sesshead');
  const day = new Date(s.from), hm = d => new Date(d).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  head.append(el('b', '', day.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' })), el('span', '', hm(s.from) + ' – ' + hm(s.until)), el('small', '', s.car));
  if (link) { const a = el('a', 'sessgo', 'Omówienie sesji →'); a.href = hrefSession(route, s.from); head.append(a); }
  const stats = el('div', 'sessstats');
  const bestStat = stat('Najlepsze', s.best ? fmtLap(s.best.time) : '–', s.best && s.best.time === bestOf(allLaps.filter(l => trackKey(l) === trackKey(route))) ? 'best' : '',
    s.best && s.previous ? signed(s.best.time - s.previous, 3) + ' s do wcześniejszego' : s.best ? 'pierwszy czas' : '');
  stats.append(bestStat,
    stat('Idealne', s.ideal ? fmtLap(s.ideal) : '–', '', s.ideal && s.best ? 'zapas ' + nf(s.best.time - s.ideal, 2) + ' s' : 'za mało okrążeń'),
    stat('Okrążenia', String(s.count), '', s.aborted ? 'przerwane: ' + s.aborted : 'bez przerwanych'),
    stat('Rozrzut', s.spread !== null ? '±' + nf(s.spread, 1) + ' s' : '–', '', s.spread !== null ? 'między ważnymi' : 'za mało okrążeń'));
  row.append(head, sessionChart(s), stats);
  if (s.losses.length) row.append(el('p', 'sessnote', 'Najlepsze okrążenie traci do idealnego: ' + s.losses.map(x => 'odcinek ' + x.sector + (x.name ? ' (' + x.name + ')' : '') + ' ' + nf(x.loss, 2) + ' s').join(', ') + '.'));
  return row;
}
function renderSessions() {
  const box = $('sessions');
  box.replaceChildren();
  const all = (sessionsData || []).filter(s => !carFilter || s.car === carFilter);
  $('sessLead').textContent = all.length ? 'Każda kropka to okrążenie w kolejności jazdy, niżej znaczy szybciej. Okrążenie idealne składa najlepsze czasy z dziesięciu odcinków.' : '';
  for (const s of all) box.append(sessionRow(s, true));
  if (!all.length) box.append(el('p', 'muted', 'Brak sesji do pokazania.'));
  markEnds(all);
}
// Where unfinished runs ended, on the 3D drawing and on the height profile: a filled red
// square where the car had left the road, a hollow one where the run was simply given up.
function markEnds(all) {
  const t = allTracks.find(x => trackKey(x) === trackKey(route)), note = $('endsNote');
  const ends = all.flatMap(s => s.laps.filter(l => l.end).map(l => l.end));
  note.hidden = !ends.length;
  if (!t || !t.outline) return;
  if (hero3d) hero3d.marks = ends.map(e => ({ i: Math.round(e.s / t.outline.step), off: e.off }));
  trackEnds = ends;
  drawProfile($('profile'), t, ends);
  if (!ends.length) return;
  const tally = list => { const by = new Map(); for (const e of list) by.set(e.name || 'bez nazwy', (by.get(e.name || 'bez nazwy') || 0) + 1); return [...by].sort((p, q) => q[1] - p[1]).map(([name, n]) => name + (n > 1 ? ' ' + n + '×' : '')).join(', '); };
  const off = ends.filter(e => e.off), quit = ends.filter(e => !e.off), sw = cls => el('i', 'endsw ' + cls);
  note.replaceChildren(el('b', '', 'Przerwane przejazdy: ' + ends.length));
  if (off.length) note.append(sw('off'), 'poza torem: ' + tally(off));
  if (quit.length) note.append(sw(''), 'bez wypadnięcia: ' + tally(quit));
}

// ---- one session, looked at as a whole ----
const hrefSession = (t, from) => '#/s/' + enc(t.game) + '/' + enc(t.track) + '/' + enc(t.track_config || '-') + '/' + enc(from);
let sessionFor = '', sessionData = null, wantCorner = null, showAllHabits = false;
async function renderSession() {
  const key = [trackKey(route), route.from, dataSignature].join('#');
  if (sessionFor !== key) {
    sessionFor = key; sessionData = null;
    $('sesTitle').textContent = 'Sesja'; $('sesLead').textContent = ''; $('sesRow').replaceChildren(); $('sesBody').replaceChildren(el('p', 'muted', 'Przeglądam okrążenia tej sesji…'));
    const data = await api('/api/session?game=' + enc(route.game) + '&track=' + enc(route.track) + '&config=' + enc(route.track_config || '') + '&from=' + enc(route.from));
    if (sessionFor !== key) return;
    sessionData = data && !data.error ? data : null;
  }
  const d = sessionData, body = $('sesBody');
  if (!d) { body.replaceChildren(el('p', 'muted', 'Nie ma takiej sesji.')); return; }
  const s = d.session, day = new Date(s.from);
  $('sesTitle').textContent = 'Sesja ' + day.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
  $('sesLead').textContent = 'Co powtarzało się z okrążenia na okrążenie. Pojedyncza wpadka to przypadek; to samo w większości okrążeń to nawyk, i tam leży czas.';
  $('sesRow').replaceChildren(sessionRow(s, false));
  const head = (idx, title, lead) => { const h = el('header', 'pagehead minor'); h.append(el('span', 'idx', idx), el('h1', '', title), el('p', '', lead || '')); return h; };
  // a corner opens on the session's best lap, with its card
  const open = n => { if (s.best) location.hash = hrefLap(s.best.id) + '?tab=plan&z=' + n; };
  const count = (n, of) => { const b = el('span', 'hcount'); b.append(el('b', '', String(n)), ' z ' + of); return b; };
  const sq = kind => { const i = el('i', 'cat'); i.style.background = 'var(--' + kind + ')'; i.title = CATEGORY_NAME[kind] || ''; return i; };
  body.replaceChildren();

  body.append(head('02', 'Nawyki względem planu', d.plan && d.judged ? 'Liczone do planu, który prowadzi teraz nakładkę' + (d.plan.lap_time ? ' (z okrążenia ' + fmtLap(d.plan.lap_time) + ')' : '') + '. Zakręty z autem tuż przed Tobą pominięte.' : ''));
  const habits = el('div', 'hlist'), top = showAllHabits ? d.habits : d.habits.slice(0, 12);
  for (const h of top) {
    const row = el('button', 'hrow'), what = el('span', 'hwhat'), most = Math.max(...h.parts.map(p => p.count));
    // (the count on the right is of the part that came back most; a rarer one says its own)
    for (const p of h.parts) { const part = el('span', ''); part.append(sq(p.kind), p.text + (p.count < most ? ' (' + p.count + '×)' : '')); what.append(part); }
    row.append(el('span', 'z', 'Z' + h.n), el('span', 'hname', h.name || ''), what, count(most, h.passes));
    row.onclick = () => open(h.n);
    habits.append(row);
  }
  body.append(habits);
  if (d.habits.length > 12) { const more = el('button', 'linkbtn', showAllHabits ? 'Pokaż 12 najważniejszych' : 'Pokaż wszystkie (' + d.habits.length + ')'); more.onclick = () => { showAllHabits = !showAllHabits; renderSession(); }; body.append(more); }
  if (!d.habits.length) body.append(el('p', 'muted', !d.plan ? 'Dla tego toru i samochodu nie ma jeszcze planu.' : d.judged < 2 ? 'Do nawyków potrzeba co najmniej dwóch pełnych okrążeń poza tym, od którego wychodzi plan.' : 'Nic nie powtarzało się w większości okrążeń.'));

  body.append(head('03', 'Powtarzające się obserwacje', d.analysed ? 'To, co nagrania pokazują same, bez planu: w co najmniej ' + Math.max(2, Math.ceil(d.analysed * 0.6)) + ' z ' + d.analysed + ' pełnych okrążeń.' : ''));
  const finds = el('div', 'hlist'), shown = d.findings.slice(0, 12);
  for (const f of shown) {
    const row = el('button', 'hrow'), what = el('span', 'hwhat'), part = el('span', '');
    part.append(sq(f.kind), f.text); what.append(part);
    row.append(el('span', 'z', 'Z' + f.n), el('span', 'hname', f.name || ''), what, count(f.count, d.analysed));
    row.onclick = () => open(f.n);
    finds.append(row);
  }
  body.append(finds);
  if (!shown.length) body.append(el('p', 'muted', d.analysed < 2 ? 'Do tego potrzeba co najmniej dwóch pełnych okrążeń.' : 'Nic nie powtarzało się w większości okrążeń.'));
  else if (d.findings.length > shown.length) body.append(el('p', 'muted', 'Pokazane 12 najważniejszych z ' + d.findings.length + '.'));

  if (d.ends.length) {
    body.append(head('04', 'Przerwane przejazdy', 'Gdzie kończyły się przejazdy, które nie dotarły do mety.'));
    const ends = el('div', 'hlist');
    for (const e of d.ends) {
      const row = el('a', 'hrow'), what = el('span', 'hwhat'), part = el('span', '');
      row.href = hrefLap(e.id);
      part.append(el('i', 'endsw ' + (e.off ? 'off' : '')), e.off ? 'auto wypadło z toru' : 'przerwany bez wypadnięcia'); what.append(part);
      row.append(el('span', 'z', new Date(e.at).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })), el('span', 'hname', e.name || 'bez nazwy'), what, el('span', 'hcount', 'po ' + nf(e.km, 1) + ' km'));
      ends.append(row);
    }
    body.append(ends);
  }
  body.append(head(d.ends.length ? '05' : '04', 'Notatka coacha'));
  body.append(d.note ? renderNote(d.note) : el('p', 'muted', 'Brak omówienia tej sesji. Poproś Claude o omówienie sesji, a pojawi się tutaj.'));
}
// A corner asked for from another screen: opened once its lap is on screen.
function applyWant() {
  if (!wantCorner || route.screen !== 'lap' || !D || selectedId !== route.id) return;
  const w = wantCorner;
  wantCorner = null;
  if (['notes', 'corners', 'compare', 'plan'].includes(w.tab)) setTab(w.tab);
  if (w.n && cornerByN(w.n)) openCorner(w.n);
}
$('onlyValid').onchange = renderTrack;
$('withPartial').onchange = renderTrack;

// Height of the track along its length, with the named sections that fit.
let trackEnds = [];
function drawProfile(cv, t, ends) {
  const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1, c = cv.getContext('2d');
  if (!r.width) return;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height, L = 56, R = 16, T = 30, B = 22, o = t.outline, n = o.y.length, len = (n - 1) * o.step;
  const X = d => L + d / len * (W - L - R), Y = v => T + (H - T - B) * (1 - (v - t.elev_min) / (t.elev_max - t.elev_min || 1));
  c.clearRect(0, 0, W, H);
  condensed(c, 12.5); c.textBaseline = 'middle';
  c.fillStyle = css.muted; c.textAlign = 'left'; c.fillText('PROFIL WYSOKOŚCI', 14, 14);
  c.textAlign = 'right';
  for (const v of [t.elev_min, t.elev_max]) {
    c.strokeStyle = css.grid; c.lineWidth = 1; c.beginPath(); c.moveTo(L, Math.round(Y(v)) + 0.5); c.lineTo(W - R, Math.round(Y(v)) + 0.5); c.stroke();
    c.fillStyle = css.muted; c.fillText(nf(v) + ' M', L - 8, Y(v) - (v === t.elev_min ? 6 : 0)); // the low label clear of the distance axis
  }
  c.beginPath(); c.moveTo(X(0), H - B);
  for (let i = 0; i < n; i++) c.lineTo(X(i * o.step), Y(o.y[i]));
  c.lineTo(X(len), H - B); c.closePath(); c.fillStyle = 'rgba(237,235,230,0.07)'; c.fill();
  c.beginPath();
  for (let i = 0; i < n; i++) i ? c.lineTo(X(i * o.step), Y(o.y[i])) : c.moveTo(X(0), Y(o.y[0]));
  c.strokeStyle = css.ink; c.lineWidth = 1.6; c.lineJoin = 'round'; c.stroke();
  c.textAlign = 'center'; c.textBaseline = 'top'; c.fillStyle = css.muted;
  for (let km = 0; km * 1000 <= len; km += len > 12000 ? 2 : 1) c.fillText(km + (km ? '' : ' KM'), X(km * 1000), H - B + 5);
  for (const e of ends || []) { // where unfinished runs ended
    const x = Math.round(X(Math.min(len, e.s))), y = Math.round(Y(o.y[Math.min(n - 1, Math.round(e.s / o.step))]));
    c.fillStyle = css.surface; c.fillRect(x - 6, y - 6, 12, 12);
    if (e.off) { c.fillStyle = css.loss; c.fillRect(x - 4.5, y - 4.5, 9, 9); } else { c.strokeStyle = css['ink-2']; c.lineWidth = 1.5; c.strokeRect(x - 3.75, y - 3.75, 7.5, 7.5); }
  }
  // section names above the line, longest sections first, skipping the ones that would collide
  const placed = [[14 + 62, 124]];
  c.textBaseline = 'middle';
  for (const sec of (t.sections || []).slice().sort((a, b) => (b.to - b.from) - (a.to - a.from))) {
    const mid = (sec.from + sec.to) / 2, text = sec.name.toUpperCase(), w = c.measureText(text).width, x = Math.max(L + w / 2, Math.min(W - R - w / 2, X(mid)));
    if (mid > len || placed.some(p => Math.abs(p[0] - x) < (p[1] + w) / 2 + 10)) continue;
    placed.push([x, w]);
    c.fillStyle = css['ink-2']; c.fillText(text, x, 14 + (placed.length % 2 ? 0 : 0));
    c.strokeStyle = css.axis; c.lineWidth = 1; c.beginPath(); c.moveTo(Math.round(X(mid)) + 0.5, 23); c.lineTo(Math.round(X(mid)) + 0.5, Y(o.y[Math.min(n - 1, Math.round(mid / o.step))]) - 3); c.stroke();
  }
}

// Laps of the same track, next to the lap being analysed.
function renderSidebar() {
  const cur = allLaps.find(l => l.id === (route.id || selectedId));
  const box = $('laps');
  box.replaceChildren();
  if (!cur) { $('count').textContent = ''; return; }
  const inTrack = allLaps.filter(l => trackKey(l) === trackKey(cur)), best = bestOf(inTrack);
  const manyCars = new Set(inTrack.map(l => l.car)).size > 1;
  const shown = inTrack.filter(l => !$('onlyFull').checked || l.complete || l.id === cur.id);
  $('count').textContent = 'Przejazdy ' + shown.length;
  let day = '';
  for (const l of shown) {
    const date = new Date(l.recorded_at), d = longDate(l.recorded_at), isBest = l.lap_time_s && l.valid && l.lap_time_s === best;
    if (d !== day) { day = d; box.append(el('div', 'day', d)); }
    const b = el('button', 'lap' + (isBest ? ' best' : ''));
    b.setAttribute('aria-current', l.id === cur.id);
    b.append(
      l.lap_time_s ? el('span', 'time', fmtLap(l.lap_time_s)) : el('span', 'time none', l.complete ? 'bez czasu' : 'niepełne, ' + nf(l.length_m / 1000, 1) + ' km'),
      el('span', 'when', date.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }))
    );
    const meta = el('span', 'meta');
    if (isBest) meta.append(el('span', 'tag best', 'najlepsze'));
    else if (l.lap_time_s && best) meta.append(el('span', 'num', signed(l.lap_time_s - best, 3)));
    if (l.complete && !l.valid) meta.append(el('span', 'tag', 'nieważne'));
    if (l.has_note) meta.append(el('span', 'tag noted', 'notatka'));
    if (manyCars) meta.append(el('span', '', l.car));
    if (meta.children.length) b.append(meta);
    b.onclick = () => { location.hash = hrefLap(l.id); };
    box.append(b);
  }
}
$('onlyFull').onchange = renderSidebar;

// ================= selected lap =================
let D = null, G = null, N = 0, STEP = 2, I0 = 0, note = null, loading = 0;
let T = null;                    // the track itself: limits, AI line, sections, timing lines
const trackViews = new Map();
let vMin = 0, vMax = 1;
let mode = 'speed', hover = -1, focus = { a: 0, b: 1 }, focusLabel = '', selCorner = null;
let cmp = null, cmpRefId = '', tab = 'notes', showAllFindings = false, cornerFilter = 'issues';
let css = {}, rgb = {};
const dist = i => (I0 + i) * STEP;
const idxOf = s => Math.max(0, Math.min(N - 1, Math.round(s / STEP) - I0));
const cornerByN = n => D.corners.find(c => c.n === n);
const cornerName = c => 'Z' + c.n + (c.name ? ' · ' + c.name : '');
const findingsOf = n => D.findings.filter(f => f.corner === n);
const hasLimits = () => !!(T && T.left);
// Distance from the car's centre line to the track limits at a sample (null where unknown).
const toLeft = i => { const v = T.left[I0 + i]; return v === null || v === undefined ? null : G.lat[i] - v; };
const toRight = i => { const v = T.right[I0 + i]; return v === null || v === undefined ? null : v - G.lat[i]; };

async function select(id) {
  selectedId = id;
  stopPlay();
  renderSidebar();
  const ticket = ++loading;
  const data = await api('/api/lap?id=' + encodeURIComponent(id));
  if (ticket !== loading || !data) return;
  const lap = data.lap || {}, key = trackKey(lap);
  if (!trackViews.has(key)) trackViews.set(key, await api('/api/track?id=' + encodeURIComponent(id)));
  if (ticket !== loading) return;

  cmp = null; cmpRefId = ''; note = null; report = null; showAllReport = false; selCorner = null; hover = -1; showAllFindings = false; focusLabel = '';
  if (mode === 'delta') mode = 'speed';
  $('tip').style.display = 'none';
  $('view').hidden = false;
  $('title').textContent = lap.lap_time_s ? fmtLap(lap.lap_time_s) : lap.complete ? 'Pełne okrążenie' : 'Niepełny przejazd';
  const when = lap.recorded_at ? new Date(lap.recorded_at).toLocaleString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  $('sub').textContent = [lap.car, when].filter(Boolean).join(' · ');
  // what the lap was driven with, where the recording has it (fuel load and tyre temperature move a lap time)
  const ctx = data.summary || {};
  if (ctx.fuel) $('sub').textContent += ' · paliwo ' + nf(ctx.fuel.start) + ' → ' + nf(ctx.fuel.end) + ' l';
  if (ctx.tyreTemp) $('sub').textContent += ' · opony ' + nf(ctx.tyreTemp) + '°C';
  if (ctx.traffic) $('sub').textContent += ' · ruch w ' + ctx.traffic + ' zakrętach';

  const chips = [];
  const best = bestOf(allLaps.filter(l => trackKey(l) === key));
  $('title').className = lap.lap_time_s && lap.valid && lap.lap_time_s === best ? 'best' : '';
  if (lap.lap_time_s && best) chips.push(lap.valid && lap.lap_time_s === best ? ['best', 'najlepsze okrążenie'] : ['', signed(lap.lap_time_s - best, 3) + ' do najlepszego']);
  if (lap.complete && !lap.valid) chips.push(['', 'nieważne']);
  if (lap.lap_time_source === 'telemetry') chips.push(['', 'czas zmierzony z telemetrii']);
  $('chips').replaceChildren(...chips.map(([cls, text]) => el('span', 'chip ' + cls, text)));

  if (data.error || !data.g) {
    D = null; G = null; N = 0; T = null;
    $('sub').textContent += ' · ' + (data.error || 'Brak danych');
    $('tiles').replaceChildren(); $('traces').replaceChildren(); $('strip').replaceChildren(); $('coach').hidden = true; $('crumb').textContent = '';
    layout(false);
    return;
  }
  D = data; G = data.g; N = G.v.length; STEP = data.step; I0 = data.i0; T = trackViews.get(key);
  vMin = Infinity; vMax = -Infinity;
  for (let i = 0; i < N; i++) { if (G.v[i] < vMin) vMin = G.v[i]; if (G.v[i] > vMax) vMax = G.v[i]; }
  focus = { a: 0, b: N - 1 };
  if (lap3d) lap3d.setData(G.x, G.e, G.z);

  const s = D.summary;
  const tile = (value, label) => { const t = el('div', 'tile'); t.append(el('b', '', value), el('span', '', label)); return t; };
  $('tiles').replaceChildren(
    tile(nf(s.full * 100) + '%', 'pełny gaz'),
    tile(nf(s.brake * 100) + '%', 'hamowanie'),
    tile(nf(s.coastTime, 1) + ' s', 'toczenie'),
    tile(nf(s.overlapTime, 1) + ' s', 'gaz + hamulec'),
    tile(nf(s.absTime, 1) + ' s', 'ABS'),
    tile(nf(s.tcTime, 1) + ' s', 'TC'),
    tile(nf(s.topSpeed), 'km/h maks.')
  );
  $('coach').hidden = false;
  $('aiToggle').hidden = !hasLimits();
  $('optToggle').hidden = !(T && T.xO);
  $('crumb').textContent = '';
  buildModes(); buildTraces(); legend(); renderStrip();
  layout(true);
  renderCoach();
  loadNote(); loadReport(); loadPlan();
  applyWant();
}

async function loadNote() {
  const id = selectedId, data = await api('/api/note?id=' + encodeURIComponent(id));
  if (id !== selectedId || !data) return;
  note = data.note;
  renderNotes();
}
// How the lap went against the plan the overlay follows (see report() on the server).
let report = null, showAllReport = false;
async function loadReport() {
  const id = selectedId;
  report = null;
  const data = await api('/api/report?id=' + encodeURIComponent(id));
  if (id !== selectedId || !data) return;
  report = data.report;
  renderPlan(); renderCard(); drawMap();
}

// ================= colours =================
function readTheme() {
  const s = getComputedStyle(document.documentElement);
  for (const k of ['surface', 'raised', 'ink', 'ink-2', 'muted', 'grid', 'axis', 'wash', 'accent', 'speed', 'throttle', 'brake', 'coast', 'steer', 'ref', 'gain', 'loss', 'mid', 'warn', 'asphalt', 'edge', 'ai', 'ideal'])
    css[k] = s.getPropertyValue('--' + k).trim();
  for (const k of ['gain', 'loss', 'mid', 'raised', 'warn']) rgb[k] = hexRgb(css[k]);
}
function speedColor(v) {
  const t = (v - vMin) / (vMax - vMin || 1);
  const f = Math.max(0, Math.min(0.9999, t)) * (RGB.length - 1), i = Math.floor(f);
  return mix(RGB[i], RGB[i + 1], f - i);
}
const cmpAt = (key, i) => { const k = i + I0 - cmp.i0; return k >= 0 && k < cmp.delta.length ? cmp[key][k] : null; };
// Diverging scale for where time is lost or gained against the reference lap.
const LOSS_RATE = 0.0015; // seconds per metre shown at full colour (1.5 s per kilometre)
const diverge = t => (t >= 0 ? mix(rgb.mid, rgb.loss, Math.min(1, t)) : mix(rgb.mid, rgb.gain, Math.min(1, -t)));
function deltaColor(i) {
  const a = cmpAt('delta', Math.max(0, i - 5)), b = cmpAt('delta', Math.min(N - 1, i + 5));
  return a === null || b === null ? css.mid : diverge((b - a) / (10 * STEP) / LOSS_RATE);
}
// Pedals: how hard, not only which one. Each pedal has its own one-hue ramp from dim (a touch)
// to vivid (to the floor); the middle of each ramp is the colour of that pedal's trace.
// Twelve steps per ramp, so the line is still drawn in runs of one colour.
const THROTTLE_RAMP = ['#245c4b', '#199e70', '#3ee6ab'], BRAKE_RAMP = ['#70351f', '#d95926', '#ff4a2b'];
const PEDAL_STEPS = 12;
const rampSteps = hexes => {
  const stops = hexes.map(hexRgb), out = [];
  for (let k = 0; k < PEDAL_STEPS; k++) { const f = k / (PEDAL_STEPS - 1) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)); out.push(mix(stops[i], stops[i + 1], f - i)); }
  return out;
};
const THROTTLE_STEPS = rampSteps(THROTTLE_RAMP), BRAKE_STEPS = rampSteps(BRAKE_RAMP);
const pedalStep = pct => Math.max(0, Math.min(PEDAL_STEPS - 1, Math.round(pct / 100 * (PEDAL_STEPS - 1))));
const pedalColor = i => (G.br[i] > 5 ? BRAKE_STEPS[pedalStep(G.br[i])] : G.th[i] > 5 ? THROTTLE_STEPS[pedalStep(G.th[i])] : css.coast);
const colorAt = i => mode === 'speed' ? speedColor(G.v[i]) : mode === 'pedals' ? pedalColor(i) : deltaColor(i);

function buildModes() {
  const modes = [['speed', 'Prędkość'], ['pedals', 'Gaz i hamulec']];
  if (cmp) modes.push(['delta', 'Strata i zysk']);
  $('modes').replaceChildren(...modes.map(([m, label]) => {
    const b = el('button', '', label);
    b.setAttribute('aria-pressed', m === mode);
    b.onclick = () => { mode = m; buildModes(); legend(); drawMap(); };
    return b;
  }));
}
function legend() {
  const key = (v, text) => '<div class="key"><i class="sw" style="background:var(--' + v + ')"></i><span>' + text + '</span></div>';
  const ramp = (from, colours, to, size) => '<div class="key"' + (size ? ' title="Od lekkiego nacisku do pedału w podłodze"' : '') + '><span>' + from + '</span><i class="ramp ' + (size || '') + '" style="background:linear-gradient(90deg,' + colours + ')"></i>' + (to ? '<span>' + to + '</span>' : '') + '</div>';
  $('legend').innerHTML = mode === 'speed' ? ramp(nf(vMin), RAMP.join(','), nf(vMax) + ' km/h')
    : mode === 'pedals' ? ramp('gaz', THROTTLE_RAMP.join(','), '', 'short') + ramp('hamulec', BRAKE_RAMP.join(','), '', 'short') + key('coast', 'bez pedałów')
    : ramp('zysk', 'var(--gain),var(--mid),var(--loss)', 'strata') + key('ref', 'okrążenie odniesienia');
}
$('showAI').onchange = () => { buildTraces(); layout(false); };

// ================= track strip =================
// The lap as one bar divided into the track's named sections: how much needs attention in
// each, or how much time was gained or lost there against the reference lap. Names are
// written above the bar where they fit; hovering a section always shows its name and value,
// clicking zooms the map and the traces onto it.
function renderStrip() {
  const box = $('strip');
  box.replaceChildren();
  if (!D || !T || !T.sections || !T.sections.length) return;
  const from = D.summary.from, to = D.summary.to, span = to - from || 1;
  const labels = el('div', 'labels'), bar = el('div', 'bar'), entries = [];
  for (const sec of T.sections.slice().sort((a, b) => a.from - b.from)) {
    const a = Math.max(sec.from, from), b = Math.min(sec.to, to);
    if (b - a < 20) continue;
    let value, weight = 0, color = null;
    if (cmp) {
      const d0 = cmpAt('delta', idxOf(a)), d1 = cmpAt('delta', idxOf(b)), d = d0 === null || d1 === null ? null : d1 - d0;
      value = d === null ? 'poza porównaniem' : signed(d, 2) + ' s';
      if (d !== null) { weight = Math.abs(d); color = mix(rgb.raised, hexRgb(d >= 0 ? css.loss : css.gain), Math.min(0.85, Math.abs(d) / 0.5)); }
    } else {
      const inSec = D.findings.filter(f => { const k = cornerByN(f.corner); return k.sMin >= a && k.sMin <= b; });
      weight = inSec.reduce((p, f) => p + f.score, 0);
      value = inSec.length ? 'uwagi: ' + inSec.length : 'bez uwag';
      if (inSec.length) color = mix(rgb.raised, rgb.warn, Math.min(0.85, 0.15 + weight / 5));
    }
    const seg = el('button', 'sec'), lab = el('span', 'lab');
    seg.style.left = (a - from) / span * 100 + '%';
    seg.style.width = (b - a) / span * 100 + '%';
    if (color) seg.style.background = color;
    seg.setAttribute('aria-label', sec.name + ', ' + value);
    seg.setAttribute('aria-current', focusLabel === sec.name);
    lab.append(el('b', '', sec.name), el('i', '', value));
    lab.style.left = ((a + b) / 2 - from) / span * 100 + '%';
    seg.onmouseenter = () => { labels.classList.add('hovering'); lab.classList.add('hot'); clampLabel(lab, box); };
    seg.onmouseleave = () => { labels.classList.remove('hovering'); lab.classList.remove('hot'); lab.style.marginLeft = ''; };
    seg.onclick = () => (focusLabel === sec.name ? openCorner(null) : focusSpan(sec.from - 40, sec.to + 40, sec.name));
    bar.append(seg); labels.append(lab);
    entries.push({ lab, weight, len: b - a });
  }
  bar.title = cmp ? 'Sekcje toru od startu do mety: zysk i strata do okrążenia odniesienia' : 'Sekcje toru od startu do mety: im jaśniejszy kolor, tym więcej uwag';
  stripWin = el('div', 'win');
  bar.append(stripWin);
  box.append(labels, bar);
  updateWindow();
  // Write as many names as fit without touching: the sections that matter most first.
  const kept = [];
  for (const e of entries.sort((p, q) => q.weight - p.weight || q.len - p.len)) {
    clampLabel(e.lab, box);
    const r = e.lab.getBoundingClientRect();
    if (kept.some(k => r.left < k.right + 6 && r.right > k.left - 6)) e.lab.classList.add('hide'); else kept.push(r);
  }
}
// Keeps a centred label inside the strip at its ends.
function clampLabel(lab, box) {
  lab.style.marginLeft = '';
  const r = lab.getBoundingClientRect(), b = box.getBoundingClientRect();
  const shift = r.left < b.left ? b.left - r.left : r.right > b.right ? b.right - r.right : 0;
  if (shift) lab.style.marginLeft = shift + 'px';
}

// ================= map =================
const map = $('map'), map3d = $('map3d'), wrap = $('mapwrap'), mctx = map.getContext('2d');
let W = 0, H = 0, view = { s: 1, tx: 0, ty: 0 }, view3d = false, lap3d = null;
function fitRange(a, b, pad) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = a; i <= b; i++) { x0 = Math.min(x0, G.x[i]); x1 = Math.max(x1, G.x[i]); z0 = Math.min(z0, G.z[i]); z1 = Math.max(z1, G.z[i]); }
  const s = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (z1 - z0 || 1), 12);
  view = { s, tx: (W - (x1 - x0) * s) / 2 - x0 * s, ty: (H - (z1 - z0) * s) / 2 - z0 * s };
}
const px = x => x * view.s + view.tx, pz = z => z * view.s + view.ty;
const sx = i => px(G.x[i]), sy = i => pz(G.z[i]);
// where a sample is on screen, in whichever view is shown
const screenOf = i => (view3d && lap3d ? [lap3d.sx[i], lap3d.sy[i]] : [sx(i), sy(i)]);
function sizeCanvas(c) {
  const r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  return [r.width, r.height];
}
function draw3d() {
  if (!lap3d || !G) return;
  lap3d.color = colorAt;
  lap3d.hover = hover;
  lap3d.ghost = ghost ? Math.min(lap3d.n - 1, ghost.i) : -1;
  const k = selCorner ? cornerByN(selCorner) : null;
  lap3d.highlight = k ? [idxOf(k.s0), idxOf(k.s1)] : focusLabel ? [focus.a, focus.b] : null;
  lap3d.draw();
}
function setView(v3) {
  view3d = v3;
  map.hidden = v3; map3d.hidden = !v3;
  $('v2d').setAttribute('aria-pressed', !v3); $('v3d').setAttribute('aria-pressed', v3);
  $('mapHint').textContent = v3 ? 'Przeciągnij: obrót · kółko: zoom · wysokości przewyższone 6×' : 'Kółko: zoom · przeciągnij: przesuwanie';
  if (v3 && G) {
    if (!lap3d) { lap3d = new Track3D(map3d, { interactive: true, lineWidth: 3, stride: 2, onHover: i => setHover(i) }); lap3d.zoom = 1.15; }
    lap3d.setData(G.x, G.e, G.z);
  }
  $('tip').style.display = 'none';
  drawMap();
}
$('v2d').onclick = () => setView(false);
$('v3d').onclick = () => setView(true);

function drawMap() {
  if (view3d) { draw3d(); return; }
  const c = mctx;
  c.clearRect(0, 0, W, H);
  if (!G) return;
  c.lineCap = 'round'; c.lineJoin = 'round'; c.textAlign = 'left'; c.textBaseline = 'middle';
  const limits = hasLimits(), zoomed = view.s > 0.3;
  const path = (a, b) => { c.beginPath(); for (let i = a; i <= b; i++) i === a ? c.moveTo(sx(i), sy(i)) : c.lineTo(sx(i), sy(i)); };
  const poly = (xs, zs) => { c.beginPath(); for (let k = 0; k < xs.length; k++) k ? c.lineTo(px(xs[k]), pz(zs[k])) : c.moveTo(px(xs[k]), pz(zs[k])); };

  // drawing-sheet grid: squares of a round size; the scale bar below gives that size
  const g = [50, 100, 250, 500, 1000, 2500, 5000].find(v => v * view.s >= 90) || 10000;
  c.strokeStyle = css.grid; c.lineWidth = 1; c.beginPath();
  for (let x = Math.ceil(-view.tx / view.s / g) * g; px(x) < W; x += g) { const X = Math.round(px(x)) + 0.5; c.moveTo(X, 0); c.lineTo(X, H); }
  for (let z = Math.ceil(-view.ty / view.s / g) * g; pz(z) < H; z += g) { const Z = Math.round(pz(z)) + 0.5; c.moveTo(0, Z); c.lineTo(W, Z); }
  c.stroke();

  if (limits) { // the track itself: asphalt between the limits, then the limits
    const n = T.xL.length;
    c.beginPath();
    for (let k = 0; k < n; k++) k ? c.lineTo(px(T.xL[k]), pz(T.zL[k])) : c.moveTo(px(T.xL[k]), pz(T.zL[k]));
    for (let k = n - 1; k >= 0; k--) c.lineTo(px(T.xR[k]), pz(T.zR[k]));
    c.closePath(); c.fillStyle = css.asphalt; c.fill();
    c.strokeStyle = css.asphalt; c.lineWidth = 2; c.stroke(); // keeps the track visible when it is under a pixel wide
    if (view.s > 0.8) {
      c.strokeStyle = css.edge; c.lineWidth = 1.5;
      poly(T.xL, T.zL); c.stroke(); poly(T.xR, T.zR); c.stroke();
    }
    if ($('showAI').checked) { c.strokeStyle = css.ai; c.lineWidth = 1.5; c.setLineDash([6, 5]); poly(T.xA, T.zA); c.stroke(); c.setLineDash([]); }
    // start and finish of the timed lap at any zoom: on the tourist layout they are not the same place
    if (view.s <= 0.5) for (const gate of T.gates || []) {
      const mx = (px(gate.a[0]) + px(gate.b[0])) / 2, my = (pz(gate.a[1]) + pz(gate.b[1])) / 2, start = gate.name === 'START';
      c.fillStyle = css.surface; c.fillRect(mx - 7, my - 7, 14, 14);
      c.fillStyle = css.ink; c.fillRect(mx - 5, my - 5, 10, 10);
      if (!start) { c.fillStyle = css.surface; c.fillRect(mx - 5, my - 5, 5, 5); c.fillRect(mx, my, 5, 5); } // the finish as a chequer
      condensed(c, 13, 700); label(gate.name, mx + (start ? 12 : -12 - c.measureText(gate.name).width), my - 14, css.ink);
    }
    if (view.s > 0.5) for (const gate of T.gates || []) {
      const ax = px(gate.a[0]), ay = pz(gate.a[1]), bx = px(gate.b[0]), by = pz(gate.b[1]);
      c.strokeStyle = css.ink; c.lineWidth = 3; c.setLineDash([5, 5]);
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); c.setLineDash([]);
      condensed(c, 13, 700); label(gate.name, ax + 10, ay - 10, css.ink);
    }
  }
  if (selCorner) { // highlight the corner being discussed
    const k = cornerByN(selCorner);
    c.strokeStyle = css.accent; c.globalAlpha = 0.16; c.lineWidth = Math.max(26, 16 * view.s); path(idxOf(k.s0), idxOf(k.s1)); c.stroke(); c.globalAlpha = 1;
  }
  // On the track ribbon the line is drawn as wide as the car when zoomed in; with a
  // reference lap both lines stay thin so a metre between them remains visible.
  const lw = cmp ? Math.max(2.5, Math.min(5, 0.7 * view.s)) : limits ? Math.max(3, Math.min(30, 2 * HALF_CAR * view.s)) : Math.max(3, Math.min(12, 9 * view.s));
  if (cmp) {
    c.strokeStyle = css.ref; c.lineWidth = lw; c.beginPath();
    for (let k = 0; k < cmp.x.length; k++) k ? c.lineTo(px(cmp.x[k]), pz(cmp.z[k])) : c.moveTo(px(cmp.x[k]), pz(cmp.z[k]));
    c.stroke();
  }
  c.lineWidth = lw;
  let run = colorAt(0);
  c.beginPath(); c.moveTo(sx(0), sy(0));
  for (let i = 1; i < N; i++) {
    c.lineTo(sx(i), sy(i));
    const col = colorAt(i);
    if (col !== run || i === N - 1) { c.strokeStyle = run; c.stroke(); c.beginPath(); c.moveTo(sx(i), sy(i)); run = col; }
  }
  // where the lap strayed from the plan: a red mark at each such corner (grey: another car was in the way)
  if (report && tab === 'plan' && !selCorner) for (const x of report.rows) {
    if (!x.worse && !x.traffic) continue;
    const i = idxOf(x.sMin), X = sx(i), Y = sy(i), r = view.s > 0.5 ? 6 : 4;
    c.fillStyle = css.surface; c.fillRect(X - r - 1.5, Y - r - 1.5, 2 * r + 3, 2 * r + 3);
    c.fillStyle = x.traffic ? css.muted : css.loss; c.fillRect(X - r, Y - r, 2 * r, 2 * r);
  }
  // The geometric reference line, as a row of dots on top of the driven line (which is as wide
  // as the car here): only once the road has some width on screen. Dark rims keep the dots
  // readable on the light end of the speed colours.
  if (limits && T.xO && $('showOpt').checked && view.s > 1.2) {
    poly(T.xO, T.zO); c.setLineDash([0.1, 7]);
    c.strokeStyle = css.surface; c.lineWidth = 5; c.stroke();
    c.strokeStyle = css.ideal; c.lineWidth = 2.6; c.stroke();
    c.setLineDash([]);
  }

  const onScreen = (x, y) => x > -40 && y > -20 && x < W + 40 && y < H + 20;
  if (zoomed) { // corner numbers
    condensed(c, 15, 700);
    for (const k of D.corners) {
      if (k.n === selCorner || !k.significant) continue;
      const i = idxOf(k.sMin), x = sx(i), y = sy(i);
      if (onScreen(x, y)) label('Z' + k.n, x + Math.max(10, lw / 2 + 6), y - Math.max(10, lw / 2 + 6), css['ink-2']);
    }
  } else if (T && T.sections && T.sections.length) { // whole track: section names, like on a circuit map
    condensed(c, 13.5);
    const placed = [];
    for (const sec of T.sections.slice().sort((a, b) => (b.to - b.from) - (a.to - a.from))) {
      const mid = (sec.from + sec.to) / 2;
      if (mid < dist(0) || mid > dist(N - 1)) continue;
      const i = idxOf(mid), j = Math.min(N - 1, i + 3), h = Math.max(0, i - 3);
      const dx = sx(j) - sx(h), dy = sy(j) - sy(h), len = Math.hypot(dx, dy) || 1;
      const nx = dy / len, ny = -dx / len; // left of the driving direction: the outside of a clockwise lap
      const text = sec.name.toUpperCase(), w = c.measureText(text).width;
      const align = nx < -0.3 ? 'right' : nx > 0.3 ? 'left' : 'center';
      const x = sx(i) + nx * 14, y = sy(i) + ny * 14 + (align === 'center' ? ny * 6 : 0);
      const box = [align === 'right' ? x - w : align === 'left' ? x : x - w / 2, y - 9, w, 18];
      // longest sections first; a name that would run into one already written is left out
      if (!onScreen(x, y) || placed.some(p => box[0] < p[0] + p[2] + 6 && box[0] + box[2] + 6 > p[0] && box[1] < p[1] + p[3] && box[1] + box[3] > p[1])) continue;
      placed.push(box);
      c.textAlign = align;
      label(text, x, y, css['ink-2']);
    }
    c.textAlign = 'left';
  }
  if (selCorner) {
    const k = cornerByN(selCorner);
    condensed(c, 15, 700);
    const mark = (s, text, dy) => { const i = idxOf(s), x = sx(i), y = sy(i); dot(x, y, 5, css.ink, css.surface, 2); label(text, x + 10, y + dy, css.ink); };
    if (k.brake) mark(k.brake.on, 'HAMULEC', -13);
    mark(k.sMin, nf(k.vMin) + ' KM/H', 13);
    if (k.pickup !== null) mark(k.pickup, 'GAZ', -13);
  }
  if (ghost) dot(px(ghost.x), pz(ghost.z), 6, css.ref, css.surface, 2); // the reference lap at the same moment
  if (hover >= 0) {
    const x = sx(hover), y = sy(hover);
    dot(x, y, 7, colorAt(hover), css.surface, 2);
    c.strokeStyle = css.ink; c.lineWidth = 1.5; c.beginPath(); c.arc(x, y, 9.5, 0, 7); c.stroke();
  }
  // scale bar (one grid square) and north arrow: the map is drawn north-up
  condensed(c, 12.5); c.textAlign = 'left'; c.textBaseline = 'middle';
  const bw = g * view.s, bx = 18, by = H - 20;
  c.strokeStyle = css['ink-2']; c.lineWidth = 1.5; c.beginPath(); c.moveTo(bx, by - 6); c.lineTo(bx, by); c.lineTo(bx + bw, by); c.lineTo(bx + bw, by - 6); c.stroke();
  c.fillStyle = css['ink-2']; c.fillText(g >= 1000 ? g / 1000 + ' KM' : g + ' M', bx + bw + 9, by - 3);
  const ax = W - 28, ay = 34;
  c.beginPath(); c.moveTo(ax, ay - 14); c.lineTo(ax - 6, ay + 3); c.lineTo(ax, ay - 1); c.lineTo(ax + 6, ay + 3); c.closePath(); c.fill();
  c.textAlign = 'center'; c.fillText('N', ax, ay + 14);
}
function dot(x, y, r, fill, stroke, w) {
  const c = mctx;
  c.fillStyle = fill; c.strokeStyle = stroke; c.lineWidth = w;
  c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.stroke();
}
function label(text, x, y, color) {
  const c = mctx;
  c.lineWidth = 4; c.strokeStyle = css.surface; c.strokeText(text, x, y);
  c.fillStyle = color; c.fillText(text, x, y);
}
function nearestOnMap(mx, my) {
  let best = -1, bd = 40 * 40;
  for (let i = 0; i < N; i++) { const dx = sx(i) - mx, dy = sy(i) - my, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
  return best;
}
function zoomAt(mx, my, k) {
  const s = Math.max(0.01, Math.min(40, view.s * k)); k = s / view.s;
  view.tx = mx - (mx - view.tx) * k; view.ty = my - (my - view.ty) * k; view.s = s;
  drawMap();
}
// The 3D view handles its own pointer; these act on the flat map only.
let drag = null;
wrap.addEventListener('wheel', e => { if (view3d) return; e.preventDefault(); const r = map.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015)); scheduleSync(); }, { passive: false });
wrap.addEventListener('pointerdown', e => { if (view3d || e.target.closest('.zoom')) return; drag = { x: e.clientX, y: e.clientY }; wrap.classList.add('drag'); wrap.setPointerCapture(e.pointerId); });
wrap.addEventListener('pointermove', e => {
  if (!G || view3d) return;
  const r = map.getBoundingClientRect();
  if (drag) { view.tx += e.clientX - drag.x; view.ty += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; drawMap(); return; }
  setHover(nearestOnMap(e.clientX - r.left, e.clientY - r.top));
});
wrap.addEventListener('pointerup', () => { if (drag) scheduleSync(); drag = null; wrap.classList.remove('drag'); });
wrap.addEventListener('pointerleave', () => { if (!drag) setHover(-1); });
const zoomBy = k => { if (view3d && lap3d) { lap3d.zoom = Math.max(0.6, Math.min(8, lap3d.zoom * k)); drawMap(); } else { zoomAt(W / 2, H / 2, k); scheduleSync(); } };
$('zin').onclick = () => zoomBy(1.6);
$('zout').onclick = () => zoomBy(1 / 1.6);
$('zfit').onclick = () => { if (!G) return; if (lap3d) lap3d.zoom = 1; openCorner(null); };
$('mapHint').textContent = 'Kółko: zoom · przeciągnij: przesuwanie';

// ================= traces =================
// What the user arranged: which panels are open, their sizes, which traces are shown.
const prefs = Object.assign({ side: 290, coach: 420, traces: 320, noSide: false, noCoach: false, shown: {} },
  (() => { try { return JSON.parse(localStorage.getItem('simcoach.ui') || '{}'); } catch { return {}; } })());
const savePrefs = () => { try { localStorage.setItem('simcoach.ui', JSON.stringify(prefs)); } catch { /* private window: keep for this visit only */ } };
$('showOpt').checked = prefs.showOpt !== false;
$('showOpt').onchange = () => { prefs.showOpt = $('showOpt').checked; savePrefs(); drawMap(); };

const PADL = 42, PADR = 8, PADT = 5, PADB = 17;
let traces = [], brush = null, stripWin = null, syncTimer = 0;
function drawTraces() { for (const t of traces) drawTrace(t); updateWindow(); }

function buildTraces() {
  const vAxis = Math.max(50, Math.ceil(vMax / 50) * 50);
  let stMax = 30;
  for (let i = 0; i < N; i++) if (Math.abs(G.st[i]) > stMax) stMax = Math.abs(G.st[i]);
  stMax = Math.ceil(stMax / 30) * 30;
  const all = [
    { id: 'speed', name: 'Prędkość', unit: 'km/h', min: 0, max: vAxis, tick: vAxis > 200 ? 100 : 50,
      keys: cmp ? [['speed', 'to okrążenie'], ['ref', 'odniesienie']] : [],
      series: (cmp ? [{ color: 'ref', val: i => cmpAt('v', i) }] : []).concat([{ color: 'speed', val: i => G.v[i] }]) },
    { id: 'pedals', name: 'Pedały', unit: '%', min: 0, max: 100, tick: 50, keys: [['throttle', 'gaz'], ['brake', 'hamulec']],
      series: [{ color: 'throttle', val: i => G.th[i] }, { color: 'brake', val: i => G.br[i] }] },
    { id: 'steer', name: 'Kierownica', unit: 'stopnie, + w prawo', min: -stMax, max: stMax, tick: stMax, keys: [],
      series: [{ color: 'steer', val: i => G.st[i] }] }
  ];
  if (cmp) {
    let dMax = 0.2;
    for (const v of cmp.delta) if (Math.abs(v) > dMax) dMax = Math.abs(v);
    dMax = Math.ceil(dMax * 5) / 5;
    all.push({ id: 'delta', name: 'Różnica czasu', unit: 'sekundy, + to strata do odniesienia', min: -dMax, max: dMax, tick: dMax, digits: 1, keys: [],
      series: [{ color: 'ink', val: i => cmpAt('delta', i) }] });
  }
  traces = all.filter(t => prefs.shown[t.id] !== false);

  const bar = el('div', 'tracebar'), pills = el('div', 'pills');
  for (const t of all) {
    const b = el('button', 'pill', t.name);
    b.setAttribute('aria-pressed', prefs.shown[t.id] !== false);
    b.onclick = () => { prefs.shown[t.id] = prefs.shown[t.id] === false; savePrefs(); buildTraces(); layout(false); };
    pills.append(b);
  }
  const range = el('span', 'range'), reset = el('button', 'reset', 'Całe okrążenie');
  range.id = 'range'; reset.id = 'rangeReset';
  reset.onclick = () => openCorner(null);
  bar.append(pills, range, reset, el('span', 'help', 'Przeciągnij: zaznacz odcinek · kółko: zoom · Shift + kółko: przesuń · dwuklik: całość'));

  $('traces').replaceChildren(bar, ...traces.map(t => {
    const box = el('div', 'trace'), h = el('h2', '', t.name + ' ');
    h.append(el('small', '', t.unit));
    for (const [color, text] of t.keys) { const s = el('span'); const i = el('i', 'sw'); i.style.background = 'var(--' + color + ')'; s.append(i, text); h.append(s); }
    const cv = t.el = el('canvas');
    const at = e => { const r = cv.getBoundingClientRect(), f = (e.clientX - r.left - PADL) / (r.width - PADL - PADR); return Math.round(focus.a + Math.max(0, Math.min(1, f)) * (focus.b - focus.a)); };
    cv.addEventListener('pointerdown', e => { if (e.button !== 0) return; brush = { a: at(e), b: at(e), x: e.clientX, moved: false }; try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } });
    cv.addEventListener('pointermove', e => {
      if (!brush) { setHover(at(e)); return; }
      brush.b = at(e); brush.moved = brush.moved || Math.abs(e.clientX - brush.x) > 5;
      drawTraces();
    });
    const end = () => { // a drag selects a stretch; a plain click changes nothing
      if (!brush) return;
      const b = brush; brush = null;
      if (b.moved && Math.abs(b.b - b.a) >= 5) setRange(Math.min(b.a, b.b), Math.max(b.a, b.b)); else drawTraces();
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!brush) setHover(-1); });
    cv.addEventListener('dblclick', () => openCorner(null));
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const span = focus.b - focus.a;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const d = Math.round(span * 0.12 * Math.sign(e.deltaX || e.deltaY)); setRange(focus.a + d, focus.b + d, true); }
      else { const i = at(e), k = Math.exp(e.deltaY * 0.0015); setRange(i - (i - focus.a) * k, i + (focus.b - i) * k); }
    }, { passive: false });
    box.append(h, cv);
    return box;
  }));
  if (!traces.length) $('traces').append(el('p', 'none', 'Wszystkie wykresy są wyłączone.'));
}

// Show one stretch of the lap in the traces; the map follows to the same stretch.
function setRange(a, b, pan) {
  let span = Math.max(30, Math.round(b - a));
  if (span >= N - 1) { if (focus.a > 0 || focus.b < N - 1) openCorner(null); return; }
  a = Math.round(pan ? a : a);
  if (a < 0) a = 0;
  if (a + span > N - 1) a = N - 1 - span;
  focus = { a, b: a + span };
  afterRange(true);
}
function afterRange(moveMap) {
  let lists = false;
  if (selCorner) { const i = idxOf(cornerByN(selCorner).sMin); if (i < focus.a || i > focus.b) { selCorner = null; lists = true; } }
  if (focusLabel) { focusLabel = ''; renderStrip(); }
  $('crumb').textContent = selCorner ? cornerName(cornerByN(selCorner)) : '';
  if (lists) renderLists();
  if (moveMap && !view3d) fitRange(focus.a, focus.b, 60);
  drawMap(); drawTraces();
}
// After the map was moved by hand: show in the traces the stretch of the lap that is on
// screen (the run of samples around the one nearest to the middle of the map).
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncToMap, 150); }
function syncToMap() {
  if (!G || view3d) return;
  const inView = i => { const x = sx(i), y = sy(i); return x >= 0 && y >= 0 && x <= W && y <= H; };
  let best = -1, bd = Infinity;
  for (let i = 0; i < N; i += 2) { if (!inView(i)) continue; const d = (sx(i) - W / 2) ** 2 + (sy(i) - H / 2) ** 2; if (d < bd) { bd = d; best = i; } }
  if (best < 0) return;
  let a = best, b = best;
  while (a > 0 && inView(a - 1)) a--;
  while (b < N - 1 && inView(b + 1)) b++;
  if (b - a > (N - 1) * 0.85) { a = 0; b = N - 1; }
  if (b - a < 30 || (a === focus.a && b === focus.b)) return;
  focus = { a, b };
  afterRange(false);
}
// The range read-out, and the window on the section strip that marks the shown stretch.
function updateWindow() {
  const whole = focus.a <= 0 && focus.b >= N - 1, r = $('range'), reset = $('rangeReset');
  if (r) r.textContent = whole ? '' : nf(dist(focus.a) / 1000, 2) + ' – ' + nf(dist(focus.b) / 1000, 2) + ' km';
  if (reset) reset.hidden = whole;
  if (!stripWin || !D) return;
  const from = D.summary.from, span = D.summary.to - from || 1;
  const l = Math.max(0, (dist(focus.a) - from) / span), rgt = Math.min(1, (dist(focus.b) - from) / span);
  stripWin.style.display = whole || rgt <= l ? 'none' : 'block';
  stripWin.style.left = l * 100 + '%'; stripWin.style.width = (rgt - l) * 100 + '%';
}

function drawTrace(t) {
  const c = t.el.getContext('2d'), w = t.w, h = t.h, pw = w - PADL - PADR, ph = h - PADT - PADB;
  if (!w || ph < 8) return;
  const a = focus.a, b = focus.b, span = b - a || 1;
  const X = i => PADL + (i - a) / span * pw;
  const Y = v => PADT + ph - (Math.max(t.min, Math.min(t.max, v)) - t.min) / (t.max - t.min) * ph;
  c.clearRect(0, 0, w, h);
  if (selCorner) { // the corner itself, as a band behind the lines
    const k = cornerByN(selCorner), x0 = Math.max(PADL, X(idxOf(k.s0))), x1 = Math.min(w - PADR, X(idxOf(k.s1)));
    if (x1 > x0) { c.fillStyle = css.wash; c.fillRect(x0, PADT, x1 - x0, ph); }
  }
  condensed(c, 12.5); c.lineWidth = 1;
  c.textAlign = 'right'; c.textBaseline = 'middle';
  const tick = ph / ((t.max - t.min) / t.tick) < 14 ? t.tick * 2 : t.tick; // fewer labels on a short trace
  for (let v = t.min; v <= t.max + 1e-9; v += tick) {
    const y = Math.round(Y(v)) + 0.5;
    c.strokeStyle = Math.abs(v) < 1e-9 ? css.axis : css.grid; c.beginPath(); c.moveTo(PADL, y); c.lineTo(w - PADR, y); c.stroke();
    c.fillStyle = css.muted; c.fillText(nf(v, t.digits || 0), PADL - 6, Y(v));
  }
  // distance axis
  const d0 = dist(a), d1 = dist(b);
  const step = [50, 100, 200, 500, 1000, 2000, 5000].find(s => (d1 - d0) / s <= 11) || 5000;
  c.textAlign = 'center'; c.textBaseline = 'top';
  let first = true;
  for (let d = Math.ceil(d0 / step) * step; d <= d1; d += step) {
    c.fillText(nf(d / 1000, step < 1000 ? (step < 100 ? 2 : 1) : 0) + (first ? ' KM' : ''), PADL + (d - d0) / (d1 - d0 || 1) * pw, h - PADB + 3);
    first = false;
  }
  c.lineJoin = 'round';
  for (const s of t.series) {
    c.strokeStyle = css[s.color]; c.lineWidth = 2; c.beginPath();
    // min/max per pixel column, so short stabs survive when a whole lap fits in one row
    let col = -1, lo = 0, hi = 0, open = false;
    const flush = () => { if (col < 0) return; if (open) { c.lineTo(col, Y(lo)); c.lineTo(col, Y(hi)); } else { c.moveTo(col, Y(lo)); c.lineTo(col, Y(hi)); open = true; } };
    for (let i = a; i <= b; i++) {
      const v = s.val(i);
      if (v === null || v === undefined) { flush(); col = -1; open = false; continue; }
      const cx = Math.round(X(i));
      if (cx !== col) { flush(); col = cx; lo = hi = v; } else { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    flush(); c.stroke();
  }
  if (selCorner) { // where braking starts, the slowest point, where the throttle comes back
    const k = cornerByN(selCorner);
    c.strokeStyle = css['ink-2']; c.lineWidth = 1; c.setLineDash([3, 3]);
    for (const s of [k.brake && k.brake.on, k.sMin, k.pickup]) {
      if (s === null || s === false || s === undefined) continue;
      const x = Math.round(X(idxOf(s))) + 0.5;
      if (x >= PADL && x <= w - PADR) { c.beginPath(); c.moveTo(x, PADT); c.lineTo(x, PADT + ph); c.stroke(); }
    }
    c.setLineDash([]);
  }
  if (brush && brush.moved) { // the stretch being selected
    const x0 = X(Math.min(brush.a, brush.b)), x1 = X(Math.max(brush.a, brush.b));
    c.fillStyle = 'rgba(255,214,10,0.16)'; c.fillRect(x0, PADT, x1 - x0, ph);
    c.strokeStyle = css.accent; c.lineWidth = 1.5; c.beginPath(); c.moveTo(x0, PADT); c.lineTo(x0, PADT + ph); c.moveTo(x1, PADT); c.lineTo(x1, PADT + ph); c.stroke();
  }
  if (hover >= a && hover <= b) {
    const x = Math.round(X(hover)) + 0.5;
    c.strokeStyle = css.ink; c.lineWidth = 1; c.beginPath(); c.moveTo(x, PADT); c.lineTo(x, PADT + ph); c.stroke();
    for (const s of t.series) {
      const v = s.val(hover);
      if (v === null || v === undefined) continue;
      c.fillStyle = css[s.color]; c.strokeStyle = css.surface; c.lineWidth = 2;
      c.beginPath(); c.arc(x, Y(v), 4, 0, 7); c.fill(); c.stroke();
    }
  }
}

// ================= hover / tooltip =================
const tip = $('tip');
const row = (k, v) => '<div class="row"><span>' + k + '</span><span>' + v + '</span></div>';
const key = v => '<i class="k" style="background:var(--' + v + ')"></i>';
// Gap between the outer tyres and a track limit, as text.
const gapText = v => (v === null ? '–' : v < 0 ? nf(-v, 1) + ' m za krawędzią' : nf(v, 1) + ' m');
function setHover(i, fromPlayback) {
  if (!G || (playing && !fromPlayback) || i === hover) return;
  hover = i;
  ghost = i >= 0 ? ghostAt(i) : null;
  drawMap(); drawTraces(); updateClock();
  if (i < 0) { tip.style.display = 'none'; return; }
  // numeric values only: nothing from file names or notes goes through innerHTML
  let html = '<b>' + nf(dist(i) / 1000, 2) + ' km</b>'
    + row(key('speed') + 'Prędkość', nf(G.v[i]) + ' km/h')
    + row(key('throttle') + 'Gaz', G.th[i] + ' %')
    + row(key('brake') + 'Hamulec', G.br[i] + ' %')
    + row('Bieg', G.gear[i] < 0 ? 'R' : G.gear[i] || 'N') + row('Kierownica', nf(G.st[i]) + '°');
  if (hasLimits() && toLeft(i) !== null) html += row('Do lewej krawędzi', gapText(toLeft(i) - HALF_CAR)) + row('Do prawej krawędzi', gapText(toRight(i) - HALF_CAR));
  if (T && T.opt) { const d = G.lat[i] - T.opt[I0 + i]; html += row('Od linii optymalnej', Math.abs(d) < 0.25 ? 'na linii' : nf(Math.abs(d), 1) + ' m ' + (d > 0 ? 'w prawo' : 'w lewo')); }
  const flags = [G.abs[i] && 'ABS', G.tc[i] && 'TC', G.kb[i] && 'tarka'].filter(Boolean);
  if (flags.length) html += row('Aktywne', flags.join(', '));
  if (cmp && cmpAt('delta', i) !== null) {
    const d = cmpAt('delta', i), l = cmpAt('lat', i);
    html += row('Do odniesienia', signed(d, 2) + ' s') + row('Linia', nf(Math.abs(l), 1) + ' m ' + (l >= 0 ? 'w prawo' : 'w lewo'));
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const [x, y] = screenOf(i), tw = tip.offsetWidth, th = tip.offsetHeight;
  const inView = x >= 0 && y >= 0 && x <= W && y <= H;
  tip.style.left = Math.max(6, Math.min(W - tw - 6, inView ? (x + 24 + tw > W ? x - tw - 24 : x + 24) : W - tw - 10)) + 'px';
  tip.style.top = Math.max(6, Math.min(H - th - 6, inView ? y - th / 2 : 10)) + 'px';
}

// ================= coach panel =================
// Focus the map and the traces on a stretch of the lap.
function focusSpan(sFrom, sTo, name) {
  selCorner = null; focusLabel = name;
  focus = { a: idxOf(sFrom), b: idxOf(sTo) };
  fitRange(focus.a, focus.b, 60);
  $('crumb').textContent = name;
  drawMap(); drawTraces();
  renderStrip(); renderLists();
}
// Focus on one corner (null: back to the whole lap).
function openCorner(n) {
  selCorner = n; focusLabel = '';
  if (n === null) { focus = { a: 0, b: N - 1 }; fitRange(0, N - 1, 36); }
  else {
    const k = cornerByN(n);
    focus = { a: idxOf(k.zs - 60), b: idxOf(k.ze + 60) };
    fitRange(focus.a, focus.b, 70);
  }
  $('crumb').textContent = n === null ? '' : cornerName(cornerByN(n));
  drawMap(); drawTraces();
  renderStrip(); renderLists();
  // the card takes room from the list under it: keep the picked row in sight
  const body = $('tab-' + tab), row = n === null ? null : body.querySelector('.item[aria-current="true"]');
  if (row) {
    const b = body.getBoundingClientRect(), r = row.getBoundingClientRect();
    if (r.top < b.top) body.scrollTop -= b.top - r.top + 8;
    else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom + 8;
  }
}
function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  for (const name of ['notes', 'corners', 'compare', 'plan']) $('tab-' + name).hidden = name !== t;
  if (G) drawMap(); // the plan marks belong to the Coach tab
  if (t === 'plan') loadPlan();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
// The lists of the panel and the corner card: all of them mark the corner that is open.
function renderLists() { renderNotes(); renderCorners(); renderCompare(); renderPlan(); renderCard(); }
function renderCoach() { renderLists(); }

// Inline text with **bold** and corner references (Z12) turned into buttons.
function rich(text) {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(\*\*[^*]+\*\*|\bZ\d{1,3}\b)/)) {
    if (!part) continue;
    if (part.startsWith('**')) frag.append(el('b', '', part.slice(2, -2)));
    else if (/^Z\d{1,3}$/.test(part) && D && cornerByN(Number(part.slice(1)))) {
      const b = el('button', 'zref', part);
      b.onclick = () => openCorner(Number(part.slice(1)));
      frag.append(b);
    } else frag.append(part);
  }
  return frag;
}
function renderNote(md) {
  const box = el('div', 'cnote');
  let list = null;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { list = null; continue; }
    if (t.startsWith('#')) { list = null; const h = el('h4'); h.append(rich(t.replace(/^#+\s*/, ''))); box.append(h); }
    else if (/^[-*]\s+/.test(t)) { if (!list) { list = el('ul'); box.append(list); } const li = el('li'); li.append(rich(t.replace(/^[-*]\s+/, ''))); list.append(li); }
    else { list = null; const p = el('p'); p.append(rich(t)); box.append(p); }
  }
  return box;
}
// What a finding is about, shown as a coloured square next to its text.
const CATEGORY = { coast: 'throttle', lift: 'throttle', tc: 'throttle', abs: 'brake', rebrake: 'brake', soft: 'brake', overlap: 'brake', steer: 'steer', off: 'accent', exit: 'accent', apex: 'accent', entry: 'accent', radius: 'accent' };
const CATEGORY_NAME = { throttle: 'gaz', brake: 'hamulec', steer: 'kierownica', accent: 'linia przejazdu' };
function item(z, what, val, more, current, onclick, cat) {
  const b = el('button', 'item');
  b.setAttribute('aria-current', !!current);
  const w = el('span', 'what');
  if (cat) { const sq = el('i', 'cat'); sq.style.background = 'var(--' + cat + ')'; sq.title = CATEGORY_NAME[cat]; w.append(sq); }
  w.append(what);
  b.append(el('span', 'z', z), w, el('span', 'val', val));
  if (more) b.append(el('span', 'more', more));
  b.onclick = onclick;
  return b;
}

function renderNotes() {
  const box = $('tab-notes');
  box.replaceChildren();
  if (!D) return;
  box.append(el('h3', '', 'Notatka coacha'));
  box.append(note ? renderNote(note) : el('p', 'muted', 'Brak notatki do tego przejazdu. Po sesji poproś Claude o omówienie, a pojawi się tutaj.'));
  box.append(el('h3', '', 'Obserwacje z danych'));
  const keyRow = el('div', 'catkey');
  for (const cat of ['brake', 'throttle', 'steer', 'accent']) { const s = el('span'), sq = el('i', 'cat'); sq.style.background = 'var(--' + cat + ')'; s.append(sq, CATEGORY_NAME[cat]); keyRow.append(s); }
  box.append(keyRow);
  const shown = showAllFindings ? D.findings : D.findings.slice(0, 14);
  const list = el('div', 'list');
  for (const f of shown) { const k = cornerByN(f.corner); list.append(item('Z' + f.corner, f.text, '', k.name || '', f.corner === selCorner, () => openCorner(f.corner === selCorner ? null : f.corner), CATEGORY[f.type])); }
  box.append(list);
  if (!D.findings.length) box.append(el('p', 'muted', 'Brak obserwacji dla tego przejazdu.'));
  if (D.findings.length > 14) {
    const more = el('button', 'linkbtn', showAllFindings ? 'Pokaż 14 najważniejszych' : 'Pokaż wszystkie (' + D.findings.length + ')');
    more.onclick = () => { showAllFindings = !showAllFindings; renderNotes(); };
    box.append(more);
  }
  box.append(el('p', 'muted', 'Obserwacje są wyliczane automatycznie z jednego przejazdu. Ruch na torze potrafi je zaburzyć.'
    + (hasLimits() ? ' Granice toru pochodzą z Assetto Corsa i są dokładne do około metra.' : '')));
}

// The corner card: everything about the picked corner in one place, above whichever tab is
// open. What the plan wants there and why, how this lap did against it, then the facts of
// the pass and the observations. Every list in the panel opens this same card.
const planBits = c => [
  c.brakeShift && 'hamulec ' + nf(Math.abs(c.brakeShift)) + ' m ' + (c.brakeShift > 0 ? 'dalej' : 'bliżej'),
  c.speed && 'cel ' + nf(c.speed) + ' km/h (było ' + nf(c.speedWas) + ')',
  c.throttleShift && 'gaz ' + nf(Math.abs(c.throttleShift)) + ' m ' + (c.throttleShift < 0 ? 'wcześniej' : 'później'),
  c.line && 'linia: promień ' + nf(c.line.rDrv) + ' m, możliwy ' + nf(c.line.rLine) + ' m',
  c.coach && 'słowo coacha'].filter(Boolean);
function renderCard() {
  const box = $('kcard'), k = D && selCorner ? cornerByN(selCorner) : null;
  box.replaceChildren();
  box.hidden = !k;
  if (!k) return;
  const head = el('div', 'khead'), title = el('div', 'ktitle'), nav = el('div', 'knav'), at = D.corners.indexOf(k);
  title.append(el('h3', '', cornerName(k)), el('p', '', (k.dir === 'R' ? 'Prawy' : 'Lewy') + ' ' + k.angle + '°, promień ok. ' + k.radius + ' m, ' + nf(k.sMin / 1000, 2) + ' km'));
  const step = (to, label, text) => { const b = el('button', '', text); b.setAttribute('aria-label', label); b.title = label; b.disabled = !to; b.onclick = () => openCorner(to.n); return b; };
  const close = el('button', '', '×');
  close.setAttribute('aria-label', 'Zamknij kartę zakrętu'); close.title = 'Zamknij: całe okrążenie'; close.onclick = () => openCorner(null);
  nav.append(step(D.corners[at - 1], 'Poprzedni zakręt', '‹'), step(D.corners[at + 1], 'Następny zakręt', '›'), close);
  head.append(title, nav);
  const body = el('div', 'kbody');

  // what the plan wants here, and how this lap did against it
  if (planReady() && planInfo.guide) {
    const c = planInfo.cues.find(x => x.n === k.n), done = report && !report.plan.own ? report.rows.find(x => x.n === k.n) : null;
    const p = el('div', 'kplan' + (c && c.focus === 'held' ? ' held' : '')), h = el('h4', '', 'Plan' + (!c || !c.focus ? '' : c.focus === 'active' ? ' · w skupieniu' : c.focus === 'done' ? ' · zaliczony' : ' · czeka na swoją kolej'));
    if (c && c.gain >= 0.01) h.append(el('i', '', '−' + nf(c.gain, 2) + ' s'));
    p.append(h);
    if (c) {
      p.append(el('b', '', c.cue || 'Zmiana punktów'));
      const bits = planBits(c);
      if (bits.length > 1 || (bits.length && !c.brakeShift)) p.append(el('p', 'bits', bits.join(' · '))); // (a lone braking shift is what the cue already says)
      for (const line of c.why) p.append(el('p', '', line));
      if (c.caution) p.append(el('p', '', 'Któryś przejazd skończył się tu poza torem, więc plan jest ostrożniejszy.'));
      if (c.focus === 'active') { const d = el('p', 'done'); d.append(el('span', '', 'Trafiony'), pips(c.hits, planInfo.focusHits), ' ' + c.hits + ' z ' + planInfo.focusHits + ' okrążeń z rzędu'); p.append(d); }
      if (c.focus === 'held') p.append(el('p', '', 'Na razie nakładka prowadzi tu po punktach okrążenia bazowego. Zmiana wejdzie, gdy zwolni się miejsce w skupieniu.'));
    } else p.append(el('p', '', 'Bez zmian: tak jak w okrążeniu bazowym.'));
    if (done) {
      const d = el('p', 'done');
      d.append(el('span', '', 'To okrążenie'), done.traffic ? 'auto tuż przed Tobą, nie liczę' : done.parts.length ? done.parts.join(' · ') : 'w punkt');
      p.append(d);
    }
    body.append(p);
  }

  const dl = el('dl', 'facts');
  const fact = (name, value) => dl.append(el('dt', '', name), el('dd', '', value));
  fact('Prędkość', nf(k.vIn) + ' → ' + nf(k.vMin) + ' → ' + nf(k.vOut) + ' km/h (bieg ' + (k.gear || 'N') + ')');
  if (k.brake) {
    fact('Hamowanie', nf(k.brake.dist) + ' m przed najwolniejszym punktem, szczyt ' + nf(k.brake.peak) + '%, ' + nf(k.brake.time, 1) + ' s');
    fact('W zakręcie', k.brake.trail > 0 ? 'hamulec trzymany jeszcze ' + nf(k.brake.trail) + ' m od początku łuku' : 'hamulec puszczony przed łukiem');
  } else fact('Hamowanie', k.flat ? 'brak, pełny gaz' : 'brak, samo odpuszczenie gazu');
  if (!k.flat) {
    fact('Toczenie', nf(k.coast, 1) + ' s bez gazu i hamulca');
    fact('Gaz', k.pickup === null ? 'nie wrócił w tej strefie'
      : (k.pickupRel >= 0 ? nf(k.pickupRel) + ' m za' : nf(-k.pickupRel) + ' m przed') + ' najwolniejszym punktem'
        + (k.toFull === null ? ', bez pełnego gazu przed kolejnym zakrętem' : ', pełny po ' + nf(k.toFull, 1) + ' s'));
  }
  if (k.line && k.line.apexGap !== null) {
    const l = k.line;
    const bit = (where, v, side) => where + ' ' + (v === null ? '–' : v < 0 ? nf(-v, 1) + ' m za ' + side + 'ą krawędzią' : nf(v, 1) + ' m od ' + side + 'ej krawędzi');
    fact('Linia', [bit('wejście', l.entryGap, 'zewnętrzn'), bit('szczyt', l.apexGap, 'wewnętrzn'), bit('wyjście', l.exitGap, 'zewnętrzn')].join(', '));
  }
  if (k.ideal && k.radius < 400) {
    const d = k.ideal, same = d.rLine < d.rDrv * 1.12;
    fact('Linia optymalna', 'promień ' + nf(d.rDrv) + ' m, na linii ' + nf(d.rLine) + ' m'
      + (d.gain ? ': przy tej samej przyczepności ok. +' + d.gain + ' km/h' : same && d.beyond >= 0.5 ? ': Twoja jest co najmniej tak dobra, korzystasz z ' + nf(d.beyond, 1) + ' m poza limitem' : same ? ': bez zapasu' : '')
      + (d.advice.length ? '; ' + d.advice.join(', ') : ''));
  }
  const extra = [k.abs >= 0.05 && 'ABS ' + nf(k.abs, 1) + ' s', k.tc >= 0.05 && 'TC ' + nf(k.tc, 1) + ' s', k.corrections && 'korekty kierownicą: ' + k.corrections, k.kerb && 'tarka ' + k.kerb + ' m'].filter(Boolean);
  if (extra.length) fact('Poza tym', extra.join(', '));
  if (cmp) {
    const d = cmp.corners.find(x => x.n === k.n);
    if (d) fact('Do odniesienia', signed(d.dTime, 2) + ' s, najwolniej ' + signed(d.dVMin) + ' km/h' + compareBits(d));
  }
  body.append(dl);
  for (const f of findingsOf(k.n)) {
    const o = el('div', 'obs'), line = el('b'), sq = el('i', 'cat');
    sq.style.background = 'var(--' + CATEGORY[f.type] + ')';
    line.append(sq, f.text);
    o.append(line, el('span', 'muted', f.hint));
    body.append(o);
  }
  box.append(head, body);
}
const compareBits = d => (d.dBrake === null || Math.abs(d.dBrake) < 2 ? '' : ', hamowanie ' + nf(Math.abs(d.dBrake)) + ' m ' + (d.dBrake > 0 ? 'później' : 'wcześniej'))
  + (d.dPickup === null || Math.abs(d.dPickup) < 2 ? '' : ', gaz ' + nf(Math.abs(d.dPickup)) + ' m ' + (d.dPickup > 0 ? 'później' : 'wcześniej'));

function renderCorners() {
  const box = $('tab-corners');
  box.replaceChildren();
  if (!D) return;
  const seg = el('div', 'seg');
  for (const [f, text] of [['issues', 'Z uwagami'], ['braked', 'Hamowane'], ['all', 'Wszystkie']]) {
    const b = el('button', '', text);
    b.setAttribute('aria-pressed', f === cornerFilter);
    b.onclick = () => { cornerFilter = f; renderCorners(); };
    seg.append(b);
  }
  box.append(seg);
  const list = el('div', 'list');
  for (const k of D.corners) {
    const fs = findingsOf(k.n);
    if (k.n !== selCorner && ((cornerFilter === 'issues' && !fs.length) || (cornerFilter === 'braked' && !k.brake))) continue;
    if (focusLabel && k.name !== focusLabel && k.n !== selCorner) continue; // a section is in focus: only its corners
    const turn = (k.dir === 'R' ? 'prawy ' : 'lewy ') + k.angle + '°';
    list.append(item('Z' + k.n, k.name || turn, nf(k.vMin) + ' km/h', (k.name ? turn : '') + (fs.length ? (k.name ? ' · ' : '') + 'uwagi: ' + fs.length : ''), k.n === selCorner, () => openCorner(k.n === selCorner ? null : k.n)));
  }
  box.append(list);
  if (!list.children.length) box.append(el('p', 'muted', 'Brak zakrętów do pokazania w tym widoku.'));
}

function renderCompare() {
  const box = $('tab-compare');
  box.replaceChildren();
  if (!D) return;
  const me = D.lap;
  const others = allLaps.filter(l => l.id !== me.id && trackKey(l) === trackKey(me) && l.complete);
  if (!others.length) { box.append(el('p', 'muted', 'Do porównania potrzebne są co najmniej dwa pełne okrążenia tego toru. Kolejne pojawią się tu same.')); return; }
  const field = el('label', 'field'), sel = el('select');
  field.append(el('span', '', 'Okrążenie odniesienia'), sel);
  const none = el('option', '', 'bez porównania'); none.value = ''; sel.append(none);
  for (const l of others) {
    const when = new Date(l.recorded_at).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const o = el('option', '', (l.lap_time_s ? fmtLap(l.lap_time_s) : 'bez czasu') + ' · ' + when + (l.valid ? '' : ' · nieważne') + (l.car !== me.car ? ' · ' + l.car : ''));
    o.value = l.id; sel.append(o);
  }
  sel.value = cmpRefId;
  sel.onchange = () => setReference(sel.value);
  box.append(field);
  if (!cmp) { box.append(el('p', 'muted', 'Wybierz okrążenie odniesienia, żeby zobaczyć różnicę czasu wzdłuż toru i różnicę linii przejazdu.')); return; }
  const km = (cmp.delta.length - 1) * STEP / 1000;
  const total = el('div', 'detail');
  total.append(el('h3', '', signed(cmp.total, 3) + ' s'), el('p', 'muted', (cmp.total >= 0 ? 'Strata' : 'Zysk') + ' do odniesienia na wspólnym odcinku ' + nf(km, 2) + ' km. Pasek sekcji nad mapą pokazuje, gdzie powstała.'));
  box.append(total);
  box.append(el('h3', '', 'Zakręty, od największej straty'));
  const list = el('div', 'list');
  for (const d of cmp.corners.slice().sort((p, q) => q.dTime - p.dTime)) {
    const k = cornerByN(d.n);
    if (!k) continue;
    list.append(item('Z' + d.n, k.name || (k.dir === 'R' ? 'prawy' : 'lewy'), signed(d.dTime, 2) + ' s',
      ('najwolniej ' + signed(d.dVMin) + ' km/h' + compareBits(d)), d.n === selCorner, () => openCorner(d.n === selCorner ? null : d.n)));
  }
  box.append(list);
}
async function setReference(id) {
  cmpRefId = id; cmp = null;
  if (id) {
    const lapId = selectedId, data = await api('/api/compare?id=' + encodeURIComponent(lapId) + '&ref=' + encodeURIComponent(id));
    if (lapId !== selectedId || cmpRefId !== id) return;
    if (data && !data.error) cmp = data;
  }
  mode = cmp ? 'delta' : mode === 'delta' ? 'speed' : mode;
  buildModes(); buildTraces(); legend(); renderStrip(); layout(true); // the extra trace changes the map's size
  renderCorners(); renderCompare();
}

// ================= the plan =================
// The plan the overlay coaches towards belongs to a track and a car. Its tab on the lap
// screen shows the lap it starts from, how this lap went against it and what it changes.
// (The overlay's window and sounds are not a lap's business: they have their own page, below.)
let planInfo = null, planOf = '', planSeen = '';
const planReady = () => !!planInfo && planOf === selectedId;
async function loadPlan(action, lapId, extra) {
  if (!D) return;
  // (lapId: act on another lap of the same track and car)
  const id = selectedId, url = '/api/guide?id=' + enc(lapId || id) + (action ? '&do=' + action + (extra || '') : '');
  let data = null;
  try { data = await (await fetch(url, action ? { method: 'POST' } : undefined)).json(); } catch { /* server closed */ }
  if (id !== selectedId || !data) return;
  const seen = JSON.stringify([data.guide, data.cues, data.faster, data.account, data.error, data.plugin.driving, data.pinned, data.focus]);
  if (seen === planSeen && planOf === id) return; // nothing changed: leave the lists alone
  planInfo = data; planOf = id; planSeen = seen;
  renderPlan(); renderCard();
  if (action) loadReport(); // the plan has changed: this lap is measured against the new one
}
const watchPlan = () => { if (route.screen === 'lap' && tab === 'plan' && !document.hidden) loadPlan(); };
setInterval(watchPlan, 3000);
const button = (cls, text, onclick, disabled) => { const b = el('button', 'ovbtn ' + cls, text); b.onclick = onclick; b.disabled = !!disabled; return b; };
// How many laps in a row met a focus corner's target, out of the number it takes: filled squares.
function pips(hits, of) {
  const box = el('span', 'pips');
  box.title = 'Trafiony w ' + hits + ' z ' + of + ' okrążeń z rzędu';
  for (let i = 0; i < of; i++) box.append(el('i', i < hits ? 'on' : ''));
  return box;
}
let showHeld = false;

function renderPlan() {
  const box = $('tab-plan');
  box.replaceChildren();
  if (!D) return;
  if (!planReady()) { box.append(el('p', 'muted', 'Sprawdzam plan…')); return; }
  const o = planInfo, me = D.lap, g = o.guide, isPlan = !!g && g.lap === selectedId;

  // 1. the lap the plan starts from, and what it promises
  box.append(el('h3', '', 'Plan docelowy'));
  const plan = el('div', 'detail');
  if (g) {
    const src = allLaps.find(l => l.id === g.lap), t = Number(g.lap_time);
    plan.append(el('h3', '', t ? fmtLap(t) : 'Bez czasu'));
    plan.append(el('p', 'muted', (isPlan ? 'Plan wychodzi od tego okrążenia' : 'Plan wychodzi od okrążenia' + (src ? ' z ' + dateTime(src.recorded_at) : ''))
      + ' i poprawia je tam, gdzie nagrania pokazują zapas.'));
    const dl = el('dl', 'facts'), part = o.focus > 0 && g.fullChanges > g.changes;
    dl.append(el('dt', '', 'Zmiany'), el('dd', '', g.changes ? 'w ' + g.changes + ' z ' + g.corners + ' zakrętów' + (part ? ' teraz, ' + g.fullChanges + ' w całym planie' : '') : 'brak'));
    if (g.fullGain > 0) dl.append(el('dt', '', 'Szacowany zysk'), el('dd', '', 'ok. ' + nf(g.gain, 1) + ' s' + (part ? ' teraz, ' + nf(g.fullGain, 1) + ' s w całym planie' : ' na okrążeniu')));
    dl.append(el('dt', '', 'Na podstawie'), el('dd', '', g.laps + (g.laps === 1 ? ' przejazdu' : ' przejazdów') + ' tym autem'));
    plan.append(dl);
    if (g.pending) plan.append(el('p', 'muted', 'Trwa jazda. Lista niżej uwzględnia już nowe przejazdy; do gry trafi po zjeździe z toru.'));
    // which lap the plan stands on: the best one by itself, or the one it was pinned to
    if (o.pinned) {
      plan.append(el('p', 'muted', 'Plan jest przypięty do ' + (isPlan ? 'tego okrążenia' : 'wybranego okrążenia') + (o.faster ? ', choć masz już szybsze: ' + fmtLap(o.faster.lap_time) + '.' : '.')));
      plan.append(button(o.faster ? 'go' : '', o.faster ? 'Odepnij: przejdź na ' + fmtLap(o.faster.lap_time) : 'Odepnij: idź za najlepszym', () => loadPlan('unpin')));
    } else plan.append(el('p', 'muted', 'Sam przechodzi na każde nowe najlepsze ważne okrążenie i przelicza się po każdym przejeździe.'));
  } else plan.append(el('p', 'muted', 'Nakładka nie ma jeszcze planu dla tego toru i samochodu. Powstanie sam po pierwszym ważnym okrążeniu; możesz też wskazać okrążenie ręcznie.'));
  if (!isPlan) {
    if (me.complete) plan.append(button(g ? '' : 'go', g ? 'Przypnij plan do tego okrążenia' : 'Oprzyj plan na tym okrążeniu', () => loadPlan('set')));
    else plan.append(el('p', 'muted', 'Plan może wyjść tylko od pełnego okrążenia.'));
  }
  box.append(plan);
  if (o.error) box.append(el('p', 'overr', o.error));
  if (o.account && o.account.length) {
    // how the earlier plans' estimates turned out
    const t = el('div', 'acct');
    t.title = 'Ile plan szacował, a o ile szybszy był kolejny rekord';
    t.append(el('span', 'h', 'Plan z'), el('span', 'h', 'Szacował'), el('span', 'h', 'Kolejny rekord dał'));
    for (const a of o.account) t.append(el('span', '', fmtLap(a.from)), el('span', '', nf(a.estimated, 1) + ' s'), el('span', '', nf(a.gained, 1) + ' s'));
    box.append(t);
  }
  if (!g) return;

  // 2. how much the plan asks at once
  const field = el('div', 'field'), seg = el('div', 'seg ovseg');
  for (const [value, text] of [[5, '5 zakrętów'], [8, '8 zakrętów'], [0, 'Wszystkie zmiany']]) {
    const b = el('button', '', text);
    b.setAttribute('aria-pressed', value === o.focus || (value === 5 && o.focus > 0 && o.focus !== 8));
    b.onclick = () => loadPlan('focus', '', '&n=' + value);
    seg.append(b);
  }
  field.append(el('span', '', 'Ile naraz'), seg);
  box.append(el('h3', '', 'Skupienie'), field);
  box.append(el('p', 'muted', o.focus ? 'Nakładka przesuwa punkty tylko w wybranych zakrętach, tam gdzie zysk jest największy. W pozostałych prowadzi po punktach okrążenia bazowego. Zakręt trafiony w ' + o.focusHits + ' okrążeniach z rzędu ustępuje miejsca następnemu; nietrafiony w sześciu przejazdach wraca na koniec kolejki.'
    : 'Nakładka przesuwa punkty we wszystkich zakrętach planu jednocześnie.'));

  // 3. this lap against the plan: what was off, worst first (the plan's own lap has nothing to answer for)
  if (report && !report.plan.own) {
    const r = report, c = r.count;
    box.append(el('h3', '', 'To okrążenie a plan'));
    const tally = el('div', 'tally');
    const cell = (n, label, cls) => { const d = el('div', cls || ''); d.append(el('b', '', String(n)), el('span', '', label)); tally.append(d); };
    cell(c.onPlan, 'w punkt', 'ok'); cell(c.brakeEarly, 'hamulec za wcześnie'); cell(c.gasLate + c.gasEarly, 'gaz nie w punkt'); cell(c.slow, 'wolniej w szczycie');
    if (c.traffic) cell(c.traffic, 'w ruchu', 'off');
    box.append(tally);
    const worst = r.rows.filter(x => x.worse).sort((p, q) => q.weight - p.weight), shown = showAllReport ? worst : worst.slice(0, 6);
    if (shown.length) {
      const list = el('div', 'list');
      for (const x of shown) list.append(item('Z' + x.n, x.parts.join(' · '), '', x.name || '', x.n === selCorner, () => openCorner(x.n === selCorner ? null : x.n), x.kind));
      box.append(list);
      if (worst.length > 6) { const more = el('button', 'linkbtn', showAllReport ? 'Pokaż 6 najważniejszych' : 'Pokaż wszystkie (' + worst.length + ')'); more.onclick = () => { showAllReport = !showAllReport; renderPlan(); }; box.append(more); }
    } else box.append(el('p', 'muted', 'Wszystkie zakręty w punkt.'));
    const excused = r.rows.filter(x => x.traffic);
    if (excused.length) box.append(el('p', 'muted', 'Z autem tuż przed Tobą: ' + excused.map(x => 'Z' + x.n).join(', ') + '. Tych zakrętów nie liczę ani tu, ani przy układaniu planu.'));
  }

  // 4. what the plan changes, corner by corner (the reasons are on the corner's card)
  const rows = cues => {
    const list = el('div', 'list');
    for (const c of cues) {
      const k = cornerByN(c.n), open = c.n === selCorner;
      const row = item('Z' + c.n, c.cue || 'Zmiana punktów', c.gain >= 0.01 ? '−' + nf(c.gain, 2) + ' s' : '', [c.name || (k && k.name)].concat(planBits(c)).filter(Boolean).join(' · '), open, () => k && openCorner(open ? null : c.n));
      if (c.focus === 'active') row.querySelector('.val').prepend(pips(c.hits, o.focusHits));
      if (c.focus === 'held') row.classList.add('held');
      list.append(row);
    }
    return list;
  };
  if (!o.cues.length) box.append(el('h3', '', 'Co plan zmienia'), el('p', 'muted', 'Plan niczego jeszcze nie zmienia: potrzeba więcej przejazdów tym autem.'));
  else if (!o.focus) box.append(el('h3', '', 'Co plan zmienia'), rows(o.cues));
  else {
    const of = kind => o.cues.filter(c => c.focus === kind), active = of('active'), done = of('done'), held = of('held'), fixed = of('');
    box.append(el('h3', '', 'W skupieniu'));
    box.append(active.length ? rows(active) : el('p', 'muted', 'Wszystkie zmiany planu są już zaliczone.'));
    if (done.length) box.append(el('h3', '', 'Zaliczone'), rows(done));
    if (fixed.length) box.append(el('h3', '', 'Uwagi coacha'), rows(fixed));
    if (held.length) {
      box.append(el('h3', '', 'Czekają na swoją kolej'));
      if (showHeld) box.append(rows(held));
      const more = el('button', 'linkbtn', showHeld ? 'Schowaj' : 'Pokaż ' + held.length + ' zakrętów, łącznie ok. ' + nf(held.reduce((s, c) => s + c.gain, 0), 1) + ' s');
      more.onclick = () => { showHeld = !showHeld; renderPlan(); };
      box.append(more);
    }
  }
  if (o.cues.length) box.append(el('p', 'muted', 'Kliknij zakręt, żeby zobaczyć powód. Plan przesuwa granice małymi krokami; zysk to szacunek, nie obietnica.'));
  const link = el('a', 'linkbtn', 'Okno i dźwięki nakładki →');
  link.href = '#/overlay';
  box.append(link);
}

// ================= the overlay's own page =================
// The overlay is drawn by the SimHub plugin. This page sets it up, once for every track:
// where its window stands and how big it is, which sounds it makes, and a show of it
// without the game. The top bar carries a link here with the plugin's state.
let device = null, deviceSeen = '', deviceHeld = false, deviceTick = 0;
async function loadDevice(action, params) {
  let data = null;
  try { data = await (await fetch('/api/overlay' + (action ? '?do=' + action + (params || '') : ''), action ? { method: 'POST' } : undefined)).json(); } catch { /* server closed */ }
  if (!data || !data.plugin) return;
  const seen = JSON.stringify(data);
  if (seen === deviceSeen) return; // nothing changed: leave the controls alone
  device = data; deviceSeen = seen;
  const link = $('ovLink'), p = data.plugin;
  link.dataset.state = p.alive ? (p.driving ? 'drive' : 'on') : 'off';
  link.title = 'Okno i dźwięki, które prowadzą w grze · ' + (p.alive ? (p.driving ? 'trwa jazda' : 'wtyczka w SimHub działa') : 'SimHub nie odpowiada');
  if (route.screen === 'overlay' && !deviceHeld) renderOverlayPage();
}
// often while the page is open (the plugin answers within a second), now and then otherwise for the light in the top bar
setInterval(() => { if (!document.hidden && (route.screen === 'overlay' || ++deviceTick % 4 === 0)) loadDevice(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { watchPlan(); loadDevice(); } }); // back from the game or SimHub: the current state at once

const SOUND_SETS = [[0, 'Miękki', 'Okrągłe, ciche tony.'], [1, 'Wyścigowy', 'Wysokie elektroniczne sygnały jak przy światłach startowych; najlepiej słyszalne przy głośnym silniku.'],
  [2, 'Neon', 'Szkliste, krótkie dźwięki z echem.'], [3, 'Puls', 'Perkusyjne, z niskim uderzeniem przy hamowaniu.'],
  [4, 'Własne', 'Twoje pliki; brakujące zastępuje zestaw miękki, a głośność ustawiasz w samych plikach.']];
function renderOverlayPage() {
  const box = $('ovBoard');
  if (!device) { box.replaceChildren(el('p', 'muted', 'Sprawdzam stan nakładki…')); return; }
  const o = device, st = o.settings, alive = o.plugin.alive, can = f => (o.plugin.features || []).includes(f);
  const set = q => loadDevice('settings', q), plan = o.plans[0] || null;
  const seg = (options, current, pick) => {
    const s = el('div', 'seg');
    for (const [value, text] of options) {
      const b = el('button', '', text);
      b.setAttribute('aria-pressed', Math.abs(value - current) < 0.03);
      b.onclick = () => pick(value);
      s.append(b);
    }
    return s;
  };
  const row = (label, hint, ...controls) => {
    const r = el('div', 'setrow'), c = el('div', 'setctl'), line = el('div', 'setline');
    line.append(...controls); c.append(line);
    for (const h of [].concat(hint || [])) c.append(typeof h === 'string' ? el('p', 'muted', h) : h);
    r.append(el('span', 'setlab', label), c);
    return r;
  };
  const head = (idx, title, lead) => { const h = el('header', 'pagehead minor'); h.append(el('span', 'idx', idx), el('h1', '', title), el('p', '', lead || '')); return h; };
  const grid = el('div', 'ovgrid'), left = el('div', 'ovleft'), right = el('div', 'ovright');

  // ---- the screen in small: the window stands where it will in the game, and can be dragged there ----
  const state = el('p', 'ovstate ' + (alive ? 'on' : 'off'));
  state.append(el('i'), alive ? (o.plugin.driving ? 'Wtyczka w SimHub działa · trwa jazda' : 'Wtyczka w SimHub działa') : 'SimHub nie odpowiada · uruchom go: okno rysuje jego wtyczka SimCoach');
  const sw = screen.width || 1920, sh = screen.height || 1080;
  const scr = el('div', 'scr'), win = el('div', 'scrwin' + (st.enabled ? '' : ' off'));
  scr.style.aspectRatio = sw + ' / ' + sh;
  // a road to the horizon, so the frame reads as the game's picture
  scr.innerHTML = '<svg viewBox="0 0 160 90" preserveAspectRatio="none" aria-hidden="true"><path d="M0 40H160"/><path d="M80 40L18 90M80 40L142 90"/><path class="mid" d="M80 40V90"/></svg>';
  // the window is 640 × 138 at 100%, and 60 taller with the pedals and steering strip
  const w = Math.min(1, 640 * st.scale / sw), h = Math.min(1, (st.inputs ? 198 : 138) * st.scale / sh);
  const place = (x, top) => { win.style.left = (1 - w) * x * 100 + '%'; win.style.top = (1 - h) * top * 100 + '%'; };
  win.style.width = w * 100 + '%'; win.style.height = h * 100 + '%';
  win.title = 'Okno nakładki: przeciągnij tam, gdzie ma stać w grze';
  place(st.x, st.top);
  let grab = null, at = { x: st.x, top: st.top };
  const unit = v => Math.max(0, Math.min(1, v));
  win.addEventListener('pointerdown', e => {
    const r = scr.getBoundingClientRect(), b = win.getBoundingClientRect();
    grab = { dx: e.clientX - b.left, dy: e.clientY - b.top, left: r.left + scr.clientLeft, top: r.top + scr.clientTop, fx: scr.clientWidth - b.width, fy: scr.clientHeight - b.height };
    deviceHeld = true; // no redrawing under the hand
    try { win.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    win.classList.add('drag');
  });
  win.addEventListener('pointermove', e => {
    if (!grab) return;
    at = { x: grab.fx > 0 ? unit((e.clientX - grab.dx - grab.left) / grab.fx) : 0.5, top: grab.fy > 0 ? unit((e.clientY - grab.dy - grab.top) / grab.fy) : 0 };
    if (Math.abs(at.x - 0.5) < 0.02) at.x = 0.5; // the middle of the screen holds on a little
    place(at.x, at.top);
  });
  const drop = () => {
    if (!grab) return;
    grab = null; deviceHeld = false; win.classList.remove('drag');
    if (Math.abs(at.x - st.x) > 0.001 || Math.abs(at.top - st.top) > 0.001) set('&x=' + at.x.toFixed(4) + '&top=' + at.top.toFixed(4));
  };
  win.addEventListener('pointerup', drop); win.addEventListener('pointercancel', drop);
  scr.append(win, el('span', 'scrnote', 'Twój ekran · przeciągnij ramkę'));

  const acts = el('div', 'ovacts'), showing = o.plugin.demo || o.demoAsked;
  // the three ready places are centred; anything else is where the window was dragged to
  acts.append(seg([[0.04, 'Góra'], [0.5, 'Środek'], [0.96, 'Dół']], Math.abs(st.x - 0.5) < 0.03 ? st.top : -1, v => set('&x=0.5&top=' + v)));
  acts.append(st.move ? button('sm go', 'Gotowe: zablokuj położenie', () => set('&move=0'))
    : button('sm', 'Ustaw na pulpicie myszą', () => set('&move=1'), !alive || !can('move')));
  acts.append(showing ? button('sm', '■  Zatrzymaj pokaz', () => loadDevice('stop'))
    : button('sm', '▶  Pokaz bez gry', () => loadDevice('demo', '&id=' + enc(plan.lap)), !plan || !alive));
  left.append(state, scr, acts);
  if (o.error) left.append(el('p', 'overr', o.error));
  left.append(el('p', 'muted', st.move ? 'Okno nakładki jest teraz na pulpicie. Złap je myszą i przeciągnij; po zablokowaniu znów przepuszcza kliknięcia.'
    : showing ? 'Przez okno nakładki leci nagrane okrążenie. Zatrzymaj pokaz przed jazdą.'
      : 'Pokaz puszcza przez okno nagrane okrążenie' + (plan && plan.lap_time ? ' ' + fmtLap(plan.lap_time) : '') + ', żeby je zobaczyć i ustawić. W grze niczego nie klikasz: nakładka włącza się sama po przecięciu linii startu.'));
  left.append(el('p', 'muted', 'W grze ustaw tryb okna bez ramek. W pełnoekranowym trybie wyłącznym Windows nie pozwala rysować nad grą.'));

  // ---- window ----
  const windowRows = el('div', 'setgroup');
  windowRows.append(row('W czasie jazdy', st.enabled ? '' : 'Okno jest ukryte, prowadzi sam dźwięk.', seg([[1, 'Widoczne'], [0, 'Ukryte']], st.enabled ? 1 : 0, v => set('&enabled=' + v))));
  windowRows.append(row('Rozmiar', '', seg([[0.75, '75%'], [1, '100%'], [1.25, '125%'], [1.5, '150%'], [2, '200%']], st.scale, v => set('&scale=' + v))));
  windowRows.append(row('Pedały i kierownica', alive && !can('inputs') ? [el('p', 'overr', 'Ten pasek pojawi się po wgraniu nowej wtyczki (SimHub musi zostać uruchomiony ponownie przy zamkniętej grze).')]
    : st.inputs ? 'Pod wskazówkami coacha: wykres gazu, hamulca i skrętu z ostatnich 5 sekund, słupki pedałów i kierownica obrócona tak jak Twoja.' : '',
    seg([[1, 'Pokazuj'], [0, 'Ukryj']], st.inputs ? 1 : 0, v => set('&inputs=' + v))));
  right.append(head('02', 'Okno'), windowRows);

  // ---- sound: the same guidance for the ears, so the eyes can stay on the road ----
  // choosing a set or a volume plays it, once the plugin has had its second to read the new setting
  const hear = q => { set(q); if (alive && can('themes') && st.sound) setTimeout(() => loadDevice('beep'), 1400); };
  const soundRows = el('div', 'setgroup'), sets = SOUND_SETS.filter(s => s[0] < 4 || o.ownSounds.length);
  soundRows.append(row('Sygnały', st.sound === 0 ? 'Nakładka prowadzi tylko obrazem.'
    : (st.sound === 2 ? 'Dwa tyknięcia przed punktem hamowania, w samym punkcie najdłuższy sygnał.' : 'W punkcie hamowania najdłuższy sygnał.')
      + ' Na gaz krótki sygnał w górę, osobny tam, gdzie wystarczy odpuścić gaz. Gdy już to robisz, sygnał milczy.',
    seg([[0, 'Wyłączone'], [1, 'W punktach'], [2, 'Z odliczaniem']], st.sound, v => set('&sound=' + v))));
  soundRows.append(row('Zestaw', [(SOUND_SETS[st.theme] || SOUND_SETS[0])[2]].concat(o.ownSounds.length ? [] : 'Własne dźwięki: wrzuć tick.wav, brake.wav, gas.wav i lift.wav do folderu ' + o.soundsDir + '.'),
    seg(sets.map(s => [s[0], s[1]]), st.theme, v => hear('&theme=' + v))));
  const errors = [];
  if (alive && !can('sound')) errors.push(el('p', 'overr', 'Działająca wtyczka jest starsza i nie zna jeszcze dźwięków ani przesuwania okna. Nowa wersja wymaga ponownego uruchomienia SimHuba po zamknięciu gry.'));
  else if (alive && !can('themes')) errors.push(el('p', 'overr', 'Zestawy dźwięków pojawią się po wgraniu nowej wtyczki (SimHub musi zostać uruchomiony ponownie przy zamkniętej grze).'));
  soundRows.append(row('Głośność', errors, seg([[0.3, 'Cicho'], [0.6, 'Średnio'], [1, 'Głośno']], st.volume, v => hear('&volume=' + v)),
    button('sm', '♪  Zagraj próbkę', () => loadDevice('beep'), !alive || !st.sound || !can('sound'))));
  right.append(head('03', 'Dźwięk'), soundRows);
  grid.append(left, right);

  // ---- the plans it drives by ----
  const plans = el('div', 'board');
  for (const p of o.plans) {
    const a = el('a', 'planrow');
    a.href = hrefLap(p.lap);
    a.onclick = () => setTab('plan');
    a.append(el('span', 'name', trackName(p)), el('span', 'car', p.car), stat('Okrążenie bazowe', p.lap_time ? fmtLap(p.lap_time) : '–'),
      stat('Zmiany', String(p.changes)), stat('Szacowany zysk', p.gain > 0 ? nf(p.gain, 1) + ' s' : '–'), el('span', 'go', 'Otwórz plan →'));
    plans.append(a);
  }
  if (!o.plans.length) plans.append(el('p', 'muted', 'Nie ma jeszcze żadnego planu. Otwórz pełne okrążenie i w zakładce Plan oprzyj na nim plan.'));
  box.replaceChildren(grid, head('04', 'Plany', 'Jeden na tor i samochód. W grze nakładka sama bierze ten, który pasuje do jazdy.'), plans);
}
// ================= panels: show, hide, resize =================
function applyPanels() {
  const app = $('app');
  app.style.setProperty('--side-w', prefs.side + 'px');
  app.style.setProperty('--coach-w', prefs.coach + 'px');
  app.style.setProperty('--traces-h', prefs.traces + 'px');
  app.classList.toggle('no-side', !!prefs.noSide);
  app.classList.toggle('no-coach', !!prefs.noCoach);
  $('swSide').setAttribute('aria-pressed', !prefs.noSide);
  $('swCoach').setAttribute('aria-pressed', !prefs.noCoach);
}
function togglePanel(flag) {
  prefs[flag] = !prefs[flag];
  savePrefs(); applyPanels();
  layout(true); renderStrip();
}
$('swSide').onclick = () => togglePanel('noSide');
$('swCoach').onclick = () => togglePanel('noCoach');
addEventListener('keydown', e => {
  if (document.body.dataset.screen !== 'lap' || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '[') togglePanel('noSide');
  else if (e.key === ']') togglePanel('noCoach');
  else if (e.key === ' ') { e.preventDefault(); playing ? stopPlay() : startPlay(); }
});
// A divider: dragging it changes the size of the panel beside it; a double click hides the panel.
function splitter(id, key, horizontal, sign, min, max, flag) {
  const s = $(id);
  let start = null;
  s.addEventListener('pointerdown', e => {
    start = { p: horizontal ? e.clientY : e.clientX, v: prefs[key] };
    try { s.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    s.classList.add('active');
    document.body.classList.add('resizing'); document.body.classList.toggle('rows', horizontal);
  });
  s.addEventListener('pointermove', e => {
    if (!start) return;
    const d = ((horizontal ? e.clientY : e.clientX) - start.p) * sign;
    prefs[key] = Math.round(Math.max(min, Math.min(max(), start.v + d)));
    applyPanels(); layout(false);
  });
  const end = () => {
    if (!start) return;
    start = null; s.classList.remove('active'); document.body.classList.remove('resizing', 'rows');
    savePrefs(); layout(false); renderStrip();
  };
  s.addEventListener('pointerup', end); s.addEventListener('pointercancel', end);
  if (flag) s.addEventListener('dblclick', () => togglePanel(flag));
}
splitter('splitSide', 'side', false, 1, 210, () => 560, 'noSide');
splitter('splitCoach', 'coach', false, -1, 320,() => Math.max(320, innerWidth * 0.6), 'noCoach');
splitter('splitTraces', 'traces', true, -1, 90, () => Math.max(120, innerHeight - 330));
applyPanels();

// ================= playback =================
// Runs the lap on its own clock: the marker moves along the map and the traces. With a
// reference lap selected, a second marker shows where that lap was at the same moment.
let playing = false, playRate = 4, playT = 0, playLast = 0, ghost = null;
const RATES = [1, 2, 4, 8, 16];
const lapClock = i => G.t[i] - G.t[0];
function ghostAt(i) {
  if (!cmp) return null;
  const k0 = cmp.i0 - I0, n = cmp.delta.length;
  if (i < k0 || i >= k0 + n) return null;
  const t = G.t[i] - G.t[k0];
  // the reference lap's clock at common point m is ours there minus the difference; it only rises
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; (G.t[k0 + m] - G.t[k0]) - cmp.delta[m] < t ? lo = m + 1 : hi = m; }
  return { x: cmp.x[lo], z: cmp.z[lo], i: lo + k0 };
}
function updateClock() {
  const box = $('clock');
  if (!G || hover < 0) { box.replaceChildren(); return; }
  box.replaceChildren(fmtLap(lapClock(hover)));
  if (cmp && cmpAt('delta', hover) !== null) box.append(el('i', '', signed(cmpAt('delta', hover), 2) + ' s'));
}
function playStep(now) {
  if (!playing || !G) return;
  playT += Math.min(0.1, (now - playLast) / 1000) * playRate;
  playLast = now;
  const end = lapClock(focus.b);
  let lo = focus.a, hi = focus.b;
  while (lo < hi) { const m = (lo + hi) >> 1; lapClock(m) < playT ? lo = m + 1 : hi = m; }
  setHover(lo, true);
  if (playT >= end) { stopPlay(); return; }
  requestAnimationFrame(playStep);
}
function startPlay() {
  if (!G) return;
  // from the point under the cursor, or from the start of the shown stretch
  const from = hover >= focus.a && hover < focus.b - 10 ? hover : focus.a;
  playing = true; playT = lapClock(from); playLast = performance.now();
  $('play').textContent = '❚❚'; $('play').classList.add('on'); $('play').setAttribute('aria-label', 'Zatrzymaj');
  requestAnimationFrame(playStep);
}
function stopPlay() {
  playing = false;
  $('play').textContent = '▶'; $('play').classList.remove('on'); $('play').setAttribute('aria-label', 'Odtwórz okrążenie');
}
$('play').onclick = () => (playing ? stopPlay() : startPlay());
$('rate').onclick = () => { playRate = RATES[(RATES.indexOf(playRate) + 1) % RATES.length]; $('rate').textContent = playRate + '×'; };

// ================= layout =================
function layout(refit) {
  if ($('view').hidden) return;
  const box = wrap.getBoundingClientRect();
  W = box.width; H = box.height;
  const hintBox = $('mapHint'); // shown whole or not at all
  hintBox.classList.remove('cut');
  hintBox.classList.toggle('cut', hintBox.scrollWidth > hintBox.clientWidth + 1);
  if (!view3d) sizeCanvas(map); // the 3D view sizes its own canvas when it draws
  for (const t of traces) [t.w, t.h] = sizeCanvas(t.el);
  if (!G) { mctx.clearRect(0, 0, W, H); return; }
  if (refit) fitRange(focus.a, focus.b, selCorner ? 70 : focusLabel ? 60 : 36);
  drawMap(); drawTraces();
}
addEventListener('resize', () => { layout(true); renderStrip(); });

readTheme();
refreshData();
loadDevice();
setInterval(refreshData, 10000); // new laps and notes appear on their own
