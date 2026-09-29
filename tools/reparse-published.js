#!/usr/bin/env node
// Re-run the parser on already-published replays and refresh the copy the site
// serves, without renaming, summarising or re-listing anything.
//
//   node tools/reparse-published.js <finalName> [<finalName> ...]
//   node tools/reparse-published.js --all          # every replay in wc3v-deploy/replays
//
// Use after a parser fix (see config.adoptUnknownSelection). The site's
// replays-data.js entry, summary and result badge are left exactly as published;
// only replays/<name>.wc3v changes. Deploy afterwards with `npx wrangler deploy`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { applyRecorderWinner } = require('./recorder-result');

const WC3V_DIR = path.join(__dirname, '..');
const DEPLOY_DIR = process.env.WC3_DEPLOY_DIR || path.join(process.env.HOME, 'wc3v-deploy');

let names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (process.argv.includes('--all')) {
  names = fs.readdirSync(path.join(DEPLOY_DIR, 'replays'))
    .filter((f) => f.endsWith('.wc3v')).map((f) => f.replace(/\.wc3v$/, ''));
}
if (!names.length) { console.log('Usage: node tools/reparse-published.js <finalName>... | --all'); process.exit(1); }

for (const name of names) {
  const raw = path.join(WC3V_DIR, 'replays', name + '.w3g');
  const gz = path.join(WC3V_DIR, 'client', 'replays', name + '.wc3v.gz');
  const out = path.join(DEPLOY_DIR, 'replays', name + '.wc3v');
  if (!fs.existsSync(raw)) { console.log(`skip ${name}: no source .w3g in wc3v/replays`); continue; }
  try {
    execFileSync('node', ['wc3v.js', `--replay=${name}`], { cwd: WC3V_DIR, stdio: 'ignore' });
    let buf = zlib.gunzipSync(fs.readFileSync(gz));
    // Same result-matching step publish-replay.js applies, so the summary panel
    // keeps agreeing with the badge on the list.
    const d = JSON.parse(buf);
    const ids = Object.entries((d.replay.metadata.players || {})).map(([id, p]) => ({ id: +id, n: (p.name || '').split('#')[0].toLowerCase() }));
    const recs = (d.replay.metadata.playerRecords || []).map((p) => ({ id: p.playerId, n: (p.playerName || '').split('#')[0].toLowerCase() }));
    const all = ids.concat(recs).filter((x) => x.n && !/neutral|blizzard/.test(x.n));
    const me = all.find((x) => x.n === 'dazootz');
    const them = all.find((x) => x.n !== 'dazootz');
    if (me && them && applyRecorderWinner(d, me.id, them.id)) buf = Buffer.from(JSON.stringify(d));
    fs.writeFileSync(out, buf);
    console.log(`reparsed ${name}`);
  } catch (e) {
    console.log(`FAILED ${name}: ${String(e.message).split('\n')[0]}`);
  }
}
