#!/usr/bin/env node
/*
  Full pipeline from a freshly-captured .w3g to a live deploy: parse, name,
  file into both repos, add to the site, prune to the cap, deploy, commit +
  push both repos, notify. Wired into wc3-replay-watch.sh so every real game
  Dazootz plays goes live with no manual step.

  Usage: node tools/publish-replay.js <path-to-LastReplay_TIMESTAMP.w3g>

  Idempotent: if the computed final filename already exists in
  ../wc3v-deploy/replays/, exits quietly (handles the watcher accidentally
  firing twice on the same file).

  New-map case (this replay's map has never been converted): can't produce
  a display name or terrain, so it skips with a notification instead of
  guessing -- see README.md's "Rebuilding from scratch" for the manual
  extraction step, then rerun this script on the same .w3g.
*/
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const WC3V_DIR = path.join(__dirname, '..');
const DEPLOY_DIR = path.join(WC3V_DIR, '..', 'wc3v-deploy');
const TOKEN_ENV = path.join(process.env.HOME, '.config', 'wc3-replays', 'deploy.env');

// Runs under systemd as a user service, whose default PATH is minimal
// (/usr/bin and friends) and doesn't include ~/.local/bin -- found the hard
// way when the "node" spawned below (and npx, for wrangler) came back
// ENOENT despite working fine from an interactive shell. Fix once here
// rather than hardcode an absolute path at every execFileSync call site.
process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;

const MAP_DISPLAY_NAMES = require('./map-display-names');
const { generateSummary, extractFacts } = require('./generate-summary');
const { applyRecorderWinner } = require('./recorder-result');
const { verifyData, verifyRender } = require('./verify-replay');

function notify (title, body) {
  try { execFileSync('notify-send', [title, body]); } catch (e) { /* best-effort */ }
  console.log(`${title}: ${body}`);
}

function fail (msg) {
  notify('WC3 Replay Publish', msg);
  process.exit(1);
}

(async () => {

const dryRun = process.argv.includes('--dry-run');
const input = process.argv[2];
if (!input || !fs.existsSync(input)) fail(`No such file: ${input}`);

// LastReplay_2026-09-28_15-30-00.w3g -> the watcher's own capture instant,
// which is the timestamp source of truth (Charles, 2026-09-28: "the time
// should be when the watcher renames the file").
const stampMatch = path.basename(input).match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
if (!stampMatch) fail(`Filename doesn't carry a watcher timestamp: ${path.basename(input)}`);
const [, yyyy, mm, dd, HH, MM] = stampMatch;
const tempName = `publish-tmp-${yyyy}${mm}${dd}${HH}${MM}`;

// 1. Parse.
const rawDest = path.join(WC3V_DIR, 'replays', tempName + '.w3g');
fs.copyFileSync(input, rawDest);
try {
  execFileSync('node', ['wc3v.js', `--replay=${tempName}`], { cwd: WC3V_DIR, stdio: 'pipe' });
} catch (e) {
  fs.unlinkSync(rawDest);
  fail(`Parse failed: ${e.message.split('\n')[0]}`);
}

// 2. Extract map + opponent from the parsed output (same fallback chain
// used manually earlier -- meta.players is the Reforged shape, playerRecords
// the classic one; neither is guaranteed).
const parsedGzPath = path.join(WC3V_DIR, 'client', 'replays', tempName + '.wc3v.gz');
const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(parsedGzPath)));
const meta = parsed.replay.metadata;

// Games shorter than a minute (instant leaves, dropped lobbies) are never
// published. Exit 0 so the watcher doesn't treat it as a failure and retry.
const MIN_GAME_MS = Number(process.env.WC3_MIN_GAME_MS) || 60 * 1000;
const lengthMs = parsed.replay.subheader && parsed.replay.subheader.replayLengthMS;
if (lengthMs != null && lengthMs < MIN_GAME_MS) {
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  notify('WC3 Replay Publish', `Skipped ${path.basename(input)}: game lasted only ${Math.round(lengthMs / 1000)}s (under 1 minute).`);
  process.exit(0);
}
const mapFolder = meta.map.mapName.split('/').pop().replace(/\.w3x$/i, '').replace(/^\(\d+\)/, '');

let names = [];
if (meta.players) {
  names = Object.values(meta.players).filter((p) => p.name && !/neutral|blizzard/i.test(p.name)).map((p) => p.name.split('#')[0]);
} else if (meta.playerRecords) {
  const seen = new Set();
  for (const p of meta.playerRecords) {
    if (p.playerName && !seen.has(p.playerId) && !/neutral|blizzard/i.test(p.playerName)) {
      seen.add(p.playerId);
      names.push(p.playerName.split('#')[0]);
    }
  }
}
const opponent = names.find((n) => n.toLowerCase() !== 'dazootz');
if (!opponent) {
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  fail(`Couldn't find an opponent name in ${path.basename(input)} (parsed but names were empty/unrecognized -- check manually)`);
}

const mapDisplay = MAP_DISPLAY_NAMES[mapFolder];
const mapDirExists = fs.existsSync(path.join(DEPLOY_DIR, 'maps', mapFolder));
if (!mapDisplay || !mapDirExists) {
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  fail(`Unknown map "${mapFolder}" -- extract and convert it manually first (README.md), add it to MAP_DISPLAY_NAMES, then rerun on this .w3g`);
}

// 3. Compute the final name and check idempotency.
const opponentSlug = opponent.toLowerCase().replace(/[^a-z0-9]+/g, '');
const finalName = `${yyyy}-${mm}-${dd}_${HH}${MM}_dazootz-vs-${opponentSlug}`;
if (fs.existsSync(path.join(DEPLOY_DIR, 'replays', finalName + '.w3g'))) {
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  console.log(`Already published as ${finalName} -- nothing to do.`);
  process.exit(0);
}

if (dryRun) {
  console.log(`Would publish as: ${finalName}`);
  console.log(`  map: ${mapDisplay}  opponent: ${opponent}`);
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  process.exit(0);
}

// 4. Rename into place in the wc3v fork (canonical source copies).
const finalRaw = path.join(WC3V_DIR, 'replays', finalName + '.w3g');
const finalParsedGz = path.join(WC3V_DIR, 'client', 'replays', finalName + '.wc3v.gz');
fs.renameSync(rawDest, finalRaw);
fs.renameSync(parsedGzPath, finalParsedGz);
let wc3vBuf = zlib.gunzipSync(fs.readFileSync(finalParsedGz));
// Make the stored winner match Dazootz's own result (see recorder-result.js), so
// the viewer's match summary agrees with the badge on the list.
{
  const d = JSON.parse(wc3vBuf);
  const ids = Object.entries((d.replay.metadata.players || {})).map(([id, p]) => ({ id: +id, n: (p.name || '').split('#')[0].toLowerCase() }));
  const recs = (d.replay.metadata.playerRecords || []).map((p) => ({ id: p.playerId, n: (p.playerName || '').split('#')[0].toLowerCase() }));
  const all = ids.concat(recs).filter((x) => x.n && !/neutral|blizzard/.test(x.n));
  const me = all.find((x) => x.n === 'dazootz');
  const them = all.find((x) => x.n !== 'dazootz');
  if (me && them && applyRecorderWinner(d, me.id, them.id)) wc3vBuf = Buffer.from(JSON.stringify(d));
}

// 5. Copy both formats into the deploy repo.
fs.copyFileSync(finalRaw, path.join(DEPLOY_DIR, 'replays', finalName + '.w3g'));
fs.writeFileSync(path.join(DEPLOY_DIR, 'replays', finalName + '.wc3v'), wc3vBuf);

// 6. Also rename the live capture in the actual WC3 Replays folder, same as
// every existing file there (deck-setup/README.md's own convention, even
// though deck-setup/ itself isn't in use -- keeps that folder's names
// consistent with everything else for anyone browsing it directly).
try { fs.renameSync(input, path.join(path.dirname(input), finalName + '.w3g')); } catch (e) { /* not fatal */ }

// 7. AI summary (battles, macro/micro, what to improve -- see
// generate-summary.js). Non-fatal: a failed/missing summary just means the
// card publishes without one, not that the whole game fails to go live.
let summary = null;
const parsedForFacts = JSON.parse(wc3vBuf);
const facts = extractFacts(parsedForFacts);
try {
  const token = fs.readFileSync(TOKEN_ENV, 'utf8').match(/ANTHROPIC_API_KEY=(.+)/);
  if (token) summary = await generateSummary(parsedForFacts, token[1].trim());
} catch (e) {
  console.log(`Summary generation failed (publishing without one): ${e.message}`);
}

// 8. Insert into REPLAYS, newest-first (top of the array).
const dateObj = new Date(`${yyyy}-${mm}-${dd}T${HH}:${MM}:00`);
const day = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const timeLabel = dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const htmlPath = path.join(DEPLOY_DIR, 'replays-data.js');
let html = fs.readFileSync(htmlPath, 'utf8');
const summaryField = summary ? `, summary: '${summary.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : '';
const raceFields = facts ? `, dazRace: '${facts.dazootzRace}', oppRace: '${facts.opponentRace}', winner: '${facts.winner || ''}'` : '';
const entryLine = `      { file: '${finalName}', map: '${mapDisplay}', opponent: '${opponent}', day: '${day}', timeLabel: '${timeLabel}'${raceFields}${summaryField} },\n`;
html = html.replace(/(var REPLAYS = \[\n)/, `$1${entryLine}`);
fs.writeFileSync(htmlPath, html);

// 8b. Review check: is the parsed file complete, and does the real viewer load
// and draw it? Errors hold the game back (moved aside, not deployed); warnings
// publish but are reported. --force skips the hold. See verify-replay.js.
const review = verifyData(parsedForFacts);
try {
  const r = await verifyRender(finalName, parsedForFacts.replay.subheader && parsedForFacts.replay.subheader.replayLengthMS);
  review.errors.push(...r.errors);
  review.warnings.push(...r.warnings);
} catch (e) {
  review.warnings.push(`visual check could not run: ${e.message}`);
}
try {
  const outDir = path.join(require('./verify-replay').REVIEW_DIR, finalName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(review, null, 2));
} catch (e) { /* not fatal */ }

if (review.errors.length && !process.argv.includes('--force')) {
  const held = path.join(process.env.HOME, 'wc3-held', finalName);
  fs.mkdirSync(held, { recursive: true });
  for (const f of [path.join(DEPLOY_DIR, 'replays', finalName + '.w3g'), path.join(DEPLOY_DIR, 'replays', finalName + '.wc3v'), finalRaw, finalParsedGz]) {
    try { fs.renameSync(f, path.join(held, path.basename(f))); } catch (e) { /* already gone */ }
  }
  let list = fs.readFileSync(htmlPath, 'utf8');
  list = list.split('\n').filter((l) => !l.includes(`file: '${finalName}'`)).join('\n');
  fs.writeFileSync(htmlPath, list);
  notify('WC3 Replay HELD', `Dazootz vs ${opponent} was NOT published: ${review.errors.join('; ')}. Kept in ${held} (publish anyway with --force). Screenshots: ~/wc3-review/${finalName}`);
  process.exit(0);
}

if (process.argv.includes('--no-deploy')) { console.log('--no-deploy: review passed, stopping before deploy'); process.exit(0); }

// 9. Cap enforcement, then publish the HTML.
execFileSync('node', ['scripts/prune-replays.js'], { cwd: DEPLOY_DIR, stdio: 'inherit' });
fs.copyFileSync(path.join(DEPLOY_DIR, 'my-replays.html'), path.join(DEPLOY_DIR, 'index.html'));

// 10. Deploy.
const token = fs.readFileSync(TOKEN_ENV, 'utf8').match(/CLOUDFLARE_API_TOKEN=(.+)/)[1].trim();
try {
  execFileSync('npx', ['--yes', 'wrangler', 'deploy'], {
    cwd: DEPLOY_DIR,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    stdio: 'pipe',
  });
} catch (e) {
  fail(`Deploy failed for ${finalName}: ${e.message.split('\n')[0]} (files are in place locally -- retry with: cd ${DEPLOY_DIR} && npx wrangler deploy)`);
}

// 11. Commit + push both repos so the Deck and any other device stay in sync.
for (const repo of [WC3V_DIR, DEPLOY_DIR]) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `Publish ${finalName}`], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['push'], { cwd: repo, stdio: 'pipe' });
  } catch (e) {
    // A commit can legitimately no-op (wc3v fork has nothing new to commit
    // most of the time -- only the deploy repo actually changed); only a
    // real push failure is worth surfacing.
    if (/nothing to commit/i.test(e.stdout || e.message)) continue;
    notify('WC3 Replay Publish', `${finalName} is live, but git push failed in ${path.basename(repo)}: ${e.message.split('\n')[0]}`);
  }
}

notify('WC3 Replay Published', `Dazootz vs ${opponent} (${mapDisplay}) is live on the site.` + (review.warnings.length ? ` Check-up notes: ${review.warnings.join('; ')}. Screenshots: ~/wc3-review/${finalName}` : ''));

})().catch((e) => fail(`Unexpected error: ${e.message}`));
