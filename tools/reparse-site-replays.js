#!/usr/bin/env node
/*
  Re-parse every published game from its raw .w3g with the current parser and
  write the result over ../wc3v-deploy/replays/<name>.wc3v, re-applying the
  recorder-slot result (recorder-result.js). Run after a parser fix so every
  game on the site benefits, not just new ones.

  Usage: node tools/reparse-site-replays.js [--only=substring]
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { applyRecorderWinner } = require('./recorder-result');

const WC3V = path.join(__dirname, '..');
const DEPLOY = path.join(WC3V, '..', 'wc3v-deploy', 'replays');
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

const count = (d, pred) => Object.values(d.players || {}).reduce((n, p) => n + (p.units || []).filter(pred).length, 0);

for (const f of fs.readdirSync(path.join(WC3V, 'replays')).filter((f) => /^\d{4}-.*_dazootz-vs-.*\.w3g$/.test(f)).sort()) {
  const name = f.replace(/\.w3g$/, '');
  if (only && !name.includes(only)) continue;
  const target = path.join(DEPLOY, name + '.wc3v');
  const before = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;

  execFileSync('node', ['wc3v.js', `--replay=${name}`], { cwd: WC3V, stdio: 'pipe' });
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(WC3V, 'client', 'replays', name + '.wc3v.gz'))));

  const m = d.replay.metadata;
  const recs = (m.playerRecords || []).map((p) => ({ id: p.playerId, n: (p.playerName || '').split('#')[0].toLowerCase() }))
    .concat(Object.entries(m.players || {}).map(([id, p]) => ({ id: +id, n: (p.name || '').split('#')[0].toLowerCase() })))
    .filter((x) => x.n && !/neutral|blizzard/.test(x.n));
  const me = recs.find((x) => x.n === 'dazootz');
  const them = recs.find((x) => x.n !== 'dazootz');
  applyRecorderWinner(d, me && me.id, them && them.id);

  fs.writeFileSync(target, JSON.stringify(d));
  const b = (x) => (x ? count(x, (u) => u.isBuilding) : '?');
  console.log(name.padEnd(42), 'buildings', String(b(before)).padStart(3), '->', String(b(d)).padStart(3));
}
