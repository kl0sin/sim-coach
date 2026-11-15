// SimCoach viewer: local web app for browsing recorded laps.
// Usage: node app/server.js [--open] [--parent <pid>]     (then http://localhost:8377)
//   --open          open the app in the default browser once the server is up
//   --parent <pid>  stop once that process is gone and the app's window is closed (the SimHub
//                   plugin and the launcher start the server this way, so it is never left behind)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const laps = require('./lib/laps');

const PORT = Number(process.env.SIMCOACH_PORT) || 8377;
const ROOT = path.join(__dirname, '..', 'data', 'laps');
const PUBLIC = path.join(__dirname, 'public');
const URL_LOCAL = 'http://localhost:' + PORT;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon'
};
const STARTED = new Date().toISOString();
const openBrowser = () => exec('start "" "' + URL_LOCAL + '"');

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, body) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(body));

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, URL_LOCAL);
    // lets the plugin and the launcher tell this server from something else on the port
    if (url.pathname === '/api/ping') return json(res, 200, { app: 'simcoach', pid: process.pid, started: STARTED });
    // A server left running with older code is told to make room for a fresh one (the plugin
    // and the launcher ask). Not for another site open in the browser.
    if (url.pathname === '/api/quit' && req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && origin !== URL_LOCAL && origin !== 'http://127.0.0.1:' + PORT) return json(res, 403, { error: 'Obce źródło' });
      json(res, 200, { quitting: true });
      return void setTimeout(() => process.exit(0), 100);
    }
    if (url.pathname === '/api/overview') return json(res, 200, laps.overview(ROOT));
    if (url.pathname === '/api/lap') {
      const lap = laps.get(ROOT, url.searchParams.get('id'));
      return lap ? json(res, 200, laps.detail(ROOT, lap)) : json(res, 404, { error: 'Nie znaleziono okrążenia' });
    }
    // The in-game overlay. /api/overlay is the device itself (window, sounds, a show without the
    // game); /api/guide is the plan for one lap's track and car (see it, put it on a lap).
    if (url.pathname === '/api/guide' || url.pathname === '/api/overlay') {
      const device = url.pathname === '/api/overlay', q = url.searchParams;
      const lap = laps.get(ROOT, q.get('id'));
      if (!device && !lap) return json(res, 404, { error: 'Nie znaleziono okrążenia' });
      let error;
      if (req.method === 'POST') {
        // these change files on disk: only this app's own page may ask, not another site open in the browser
        const origin = req.headers.origin;
        if (origin && origin !== URL_LOCAL && origin !== 'http://127.0.0.1:' + PORT) return json(res, 403, { error: 'Obce źródło' });
        const action = q.get('do'), num = k => (q.has(k) ? Number(q.get(k)) : NaN);
        try {
          if (action === 'set' && lap) laps.setPlan(ROOT, lap);
          else if (action === 'unpin' && lap) laps.planOption(ROOT, lap.summary, { pin: '' });
          else if (action === 'focus' && lap) laps.planOption(ROOT, lap.summary, { focus: num('n') });
          else if (action === 'demo' && lap) laps.overlayDemo(ROOT, lap);
          else if (action === 'stop') laps.overlayDemo(ROOT, null);
          else if (action === 'settings') laps.overlaySettings(ROOT, {
            enabled: q.has('enabled') ? q.get('enabled') === '1' : undefined, move: q.has('move') ? q.get('move') === '1' : undefined,
            inputs: q.has('inputs') ? q.get('inputs') === '1' : undefined,
            scale: num('scale'), x: num('x'), top: num('top'), sound: num('sound'), volume: num('volume'), theme: num('theme')
          });
          else if (action === 'beep') laps.overlayBeep(ROOT);
          else return json(res, 400, { error: 'Nieznane polecenie' });
        } catch (err) { error = String(err.message || err); }
      }
      return json(res, 200, device ? { ...laps.overlayDevice(ROOT), plans: laps.plans(ROOT), error } : { ...laps.overlayStatus(ROOT, lap), error });
    }
    if (url.pathname === '/api/track') {
      const lap = laps.get(ROOT, url.searchParams.get('id'));
      return lap ? json(res, 200, laps.trackView(ROOT, lap)) : json(res, 404, { error: 'Nie znaleziono okrążenia' });
    }
    if (url.pathname === '/api/compare') {
      const lap = laps.get(ROOT, url.searchParams.get('id')), ref = laps.get(ROOT, url.searchParams.get('ref'));
      if (!lap || !ref) return json(res, 404, { error: 'Nie znaleziono okrążenia' });
      return json(res, 200, laps.comparison(ROOT, lap, ref) || { error: 'Te przejazdy nie mają wspólnego odcinka toru.' });
    }
    if (url.pathname === '/api/sessions') {
      const q = url.searchParams;
      return json(res, 200, { sessions: laps.sessions(ROOT, { game: q.get('game'), track: q.get('track'), track_config: q.get('config') || '' }) });
    }
    if (url.pathname === '/api/session') {
      const q = url.searchParams, review = laps.sessionReview(ROOT, { game: q.get('game'), track: q.get('track'), track_config: q.get('config') || '' }, q.get('from'));
      return review ? json(res, 200, review) : json(res, 404, { error: 'Nie znaleziono sesji' });
    }
    if (url.pathname === '/api/report') {
      const lap = laps.get(ROOT, url.searchParams.get('id'));
      return lap ? json(res, 200, { report: laps.report(ROOT, lap) }) : json(res, 404, { error: 'Nie znaleziono okrążenia' });
    }
    if (url.pathname === '/api/note') {
      const lap = laps.get(ROOT, url.searchParams.get('id'));
      return lap ? json(res, 200, { note: laps.note(lap) }) : json(res, 404, { error: 'Nie znaleziono okrążenia' });
    }
    const name = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const file = path.join(PUBLIC, name);
    if (!TYPES[path.extname(file)] || !fs.existsSync(file)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    send(res, 200, TYPES[path.extname(file)], fs.readFileSync(file));
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err.message || err) });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('SimCoach już działa: ' + URL_LOCAL);
    if (process.argv.includes('--open')) openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else throw err;
});

// Started by the plugin or the launcher: stay for as long as that process lives or the app's own
// window is open (the browser keeps "lockfile" in the window's profile folder while it runs).
const parentAt = process.argv.indexOf('--parent');
const parent = parentAt >= 0 ? Number(process.argv[parentAt + 1]) : 0;
if (parent > 0) {
  const windowLock = path.join(__dirname, '..', 'data', 'window', 'lockfile');
  const alive = pid => {
    try { process.kill(pid, 0); return true; } // signal 0 only asks whether the process is there
    catch (err) { return err.code !== 'ESRCH'; }
  };
  setInterval(() => { if (!alive(parent) && !fs.existsSync(windowLock)) process.exit(0); }, 2000).unref();
}

// Local machine only: the viewer exposes driving data and should not be reachable from the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log('SimCoach: ' + URL_LOCAL + '  (zamknij to okno, aby wyłączyć)');
  console.log('Okrążenia: ' + ROOT);
  if (process.argv.includes('--open')) openBrowser();
});
