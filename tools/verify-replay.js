/*
  Pre-publish check for one parsed replay. Two stages:

    1. verifyData(data)      -- is the parsed file complete and believable?
    2. verifyRender(...)     -- does the real viewer load it and draw something?
                                Saves screenshots for a human glance.

  Each returns { errors: [], warnings: [] }. Errors HOLD the game back (the
  publisher moves it aside and does not deploy); warnings publish but are
  reported. A stage that can't run at all (e.g. no browser available) reports a
  warning, never an error -- a broken checker must not block every game.

  Usage (standalone, against something already in ../wc3v-deploy/replays):
    node tools/verify-replay.js <replay-id> [--no-render]
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const DEPLOY_DIR = path.join(__dirname, '..', '..', 'wc3v-deploy');
const REVIEW_DIR = path.join(os.homedir(), 'wc3-review');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- data stage
function verifyData (data) {
  const errors = [];
  const warnings = [];
  const players = Object.entries(data.players || {}).filter(([, p]) => !p.isNeutralPlayer);
  const durationMs = data.replay && data.replay.subheader && data.replay.subheader.replayLengthMS;
  const minutes = (durationMs || 0) / 60000;

  if (!durationMs) errors.push('no game length recorded');
  else if (durationMs < 60000) errors.push(`game lasted only ${Math.round(durationMs / 1000)}s`);
  if (data.replay && data.replay.parseTruncated) errors.push('the parser stopped before the end of the recording');
  if (players.length !== 2) errors.push(`expected 2 players, found ${players.length}`);

  const meta = (data.replay && data.replay.metadata) || {};
  const names = [];
  Object.values(meta.players || {}).forEach((p) => { if (p.name && !/neutral|blizzard/i.test(p.name)) names.push(p.name); });
  (meta.playerRecords || []).forEach((p) => { if (p.playerName && !/neutral|blizzard/i.test(p.playerName)) names.push(p.playerName); });
  if (new Set(names.map((n) => n.split('#')[0].toLowerCase())).size < 2) errors.push('could not read both player names');

  players.forEach(([id, p], i) => {
    const who = `player ${i + 1}`;
    if (!p.race) errors.push(`${who}: race not detected`);
    if (!(p.units || []).length || (p.units || []).length < 3) errors.push(`${who}: almost no units or buildings found (${(p.units || []).length})`);
    if (!(p.eventStream || []).length || p.eventStream.length < 5) errors.push(`${who}: almost no build actions found (${(p.eventStream || []).length})`);
    if (!(p.resourceSeries || []).length) errors.push(`${who}: no gold/lumber history`);
    if (p.parseConfidence != null && p.parseConfidence < 0.6) errors.push(`${who}: parse confidence very low (${p.parseConfidence.toFixed(2)})`);
    else if (p.parseConfidence != null && p.parseConfidence < 0.8) warnings.push(`${who}: parse confidence is on the low side (${p.parseConfidence.toFixed(2)})`);
    if (minutes > 5 && (p.eventStream || []).length / minutes < 3) warnings.push(`${who}: very few actions for a ${minutes.toFixed(0)}-minute game (${p.eventStream.length}) -- player may have gone idle`);
    if (minutes > 5 && !((p.dominanceSeries && p.dominanceSeries.samples) || []).length) warnings.push(`${who}: no dominance history`);
  });

  if (minutes > 8 && !(data.battles || []).length) warnings.push('no fights detected in a game this long');
  if (data.validation && (data.validation.warnings || []).some((w) => w.severity === 'critical')) {
    warnings.push(`${data.validation.warnings.filter((w) => w.severity === 'critical').length} critical parser warnings`);
  }
  return { errors, warnings };
}

// -------------------------------------------------------------- render stage
function serveDeployDir (root) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary' };
  const server = http.createServer((q, r) => {
    let u = decodeURIComponent(q.url.split('?')[0]);
    if (!u.startsWith('/wc3')) { r.writeHead(404); return r.end(); }
    u = u.slice(4) || '/';
    if (u === '/') u = '/index.html';
    let f = path.join(root, u);
    if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      if (fs.existsSync(f + '.html')) f += '.html'; else { r.writeHead(404); return r.end(); }
    }
    r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(r);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withBrowser (mobile, W, H, fn) {
  const port = 9600 + Math.floor(Math.random() * 300);
  const prof = path.join(os.homedir(), 'Downloads', `chrome-prof-verify-${port}`);
  const ch = spawn('flatpak', ['run', 'com.google.Chrome', '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${W},${H}`, `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => {
    try { ch.kill(); } catch (e) {}
    try { execFileSync('pkill', ['-f', `chrome-prof-verify-${port}`]); } catch (e) {}
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  };
  try {
    let list = null;
    for (let i = 0; i < 40 && !list; i++) {
      try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (l.length) list = l; } catch (e) {}
      if (!list) await sleep(500);
    }
    if (!list) throw new Error('browser did not start');
    const page = list.find((x) => x.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('browser connection failed')); });
    let id = 0;
    const pend = {};
    const events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } else if (m.method) events.push(m);
    };
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: mobile ? 2 : 1, mobile });
    if (mobile) {
      await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36' });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    await send('Page.enable');
    await send('Runtime.enable');
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const shot = async (file) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(s.result.data, 'base64');
      fs.writeFileSync(file, buf);
      return buf.length;
    };
    const result = await fn({ send, evalJs, shot, events });
    ws.close();
    return result;
  } finally {
    cleanup();
  }
}

async function verifyRender (replayId, expectedDurationMs, opts = {}) {
  const errors = [];
  const warnings = [];
  const outDir = path.join(REVIEW_DIR, replayId);
  fs.mkdirSync(outDir, { recursive: true });
  const server = await serveDeployDir(DEPLOY_DIR);
  const base = `http://127.0.0.1:${server.address().port}/wc3/viewer?r=${encodeURIComponent(replayId)}`;
  const shots = [];

  try {
    // Desktop: full check.
    await withBrowser(false, 1400, 850, async ({ send, evalJs, shot, events }) => {
      await send('Page.navigate', { url: base });
      let loaded = false;
      for (let i = 0; i < 100 && !loaded; i++) {
        await sleep(1000);
        loaded = await evalJs('!!(window.wc3v && window.wc3v.gameLoaded)');
      }
      if (!loaded) { errors.push('the viewer never finished loading this game'); await shot(path.join(outDir, 'desktop-failed.png')); return; }
      await sleep(3000);

      const info = await evalJs(`(() => {
        const v = window.wc3v;
        const ps = (v.buildOrderPlayers || []).filter(p => p && !p.isNeutralPlayer);
        const bo = ps.map(p => { try { const d = v.boRenderer.boData.processBuildOrderData(p); return [1,2,3].reduce((n,t) => n + ((d.tiers[t] && d.tiers[t].events) || []).length, 0); } catch (e) { return -1; } });
        return { players: ps.length, bo, end: v.matchEndTime, clock: (document.querySelector('.scrubber-clock') || {}).innerText || '' };
      })()`);
      if (!info) { errors.push('could not read the viewer state'); return; }
      if (info.players !== 2) errors.push(`viewer shows ${info.players} players`);
      info.bo.forEach((n, i) => { if (n < 3) errors.push(`viewer's build order for player ${i + 1} has ${n} entries`); });
      if (expectedDurationMs && Math.abs(info.end - expectedDurationMs) > 2000) errors.push(`viewer game length (${info.end}ms) does not match the file (${expectedDurationMs}ms)`);

      for (const frac of [0.25, 0.5, 0.85]) {
        const t = Math.floor(info.end * frac);
        await evalJs(`window.wc3v.seekToGameTime(${t})`);
        await sleep(4000);
        const file = path.join(outDir, `desktop-${Math.round(frac * 100)}pct.png`);
        const size = await shot(file);
        shots.push(file);
        if (size < 60000) warnings.push(`the picture at ${Math.round(frac * 100)}% of the game looks nearly empty`);
      }
      const uncaught = events.filter((e) => e.method === 'Runtime.exceptionThrown');
      if (uncaught.length) {
        const d = uncaught[0].params.exceptionDetails;
        errors.push(`the page threw an error: ${(d.exception && d.exception.description || d.text || '').split('\n')[0].slice(0, 160)}`);
      }
      const consoleErrs = events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
      if (consoleErrs.length) warnings.push(`${consoleErrs.length} error message(s) in the page console`);
    });

    // Phone: it must at least load and draw.
    if (!opts.skipPhone) {
      await withBrowser(true, 390, 844, async ({ send, evalJs, shot, events }) => {
        await send('Page.navigate', { url: base });
        let loaded = false;
        for (let i = 0; i < 100 && !loaded; i++) {
          await sleep(1000);
          loaded = await evalJs('!!(window.wc3v && window.wc3v.gameLoaded)');
        }
        if (!loaded) { warnings.push('the phone layout never finished loading this game'); return; }
        await sleep(3000);
        const file = path.join(outDir, 'phone.png');
        await shot(file);
        shots.push(file);
        const overflow = await evalJs('document.documentElement.scrollWidth > window.innerWidth + 2');
        if (overflow) warnings.push('the phone layout scrolls sideways');
        const uncaught = events.filter((e) => e.method === 'Runtime.exceptionThrown');
        if (uncaught.length) warnings.push('the phone layout threw a page error');
      });
    }
  } catch (e) {
    warnings.push(`visual check could not run: ${e.message}`);
  } finally {
    server.close();
  }
  return { errors, warnings, shots, outDir };
}

module.exports = { verifyData, verifyRender, REVIEW_DIR };

if (require.main === module) {
  (async () => {
    const id = process.argv[2];
    if (!id) { console.error('usage: node tools/verify-replay.js <replay-id> [--no-render]'); process.exit(2); }
    const zlib = require('zlib');
    const data = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, 'replays', id + '.wc3v')));
    const out = verifyData(data);
    if (!process.argv.includes('--no-render')) {
      const r = await verifyRender(id, data.replay.subheader && data.replay.subheader.replayLengthMS);
      out.errors.push(...r.errors); out.warnings.push(...r.warnings);
      console.log('screenshots in', r.outDir);
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.errors.length ? 1 : 0);
  })();
}
