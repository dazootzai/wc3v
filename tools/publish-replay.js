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
const { generateSummary, extractFacts, generateTeamSummary, extractTeamFacts } = require('./generate-summary');
const { applyRecorderWinner } = require('./recorder-result');

function notify (title, body) {
  // Desktop popups removed (2026-10-13): they fired mid-game on the Deck.
  // Success is visible on the site; failures land in the watcher log at
  // ~/.local/state/wc3-replay-publish.log.
  console.log(`${title}: ${body}`);
}

function fail (msg) {
  console.log(`WC3 Replay Publish FAILURE: ${msg}`);
  process.exit(1);
}

// Team entry rosters: [{ name, race }, ...] -> the source literal for the
// TEAM_REPLAYS line (empty array when no facts could be extracted).
function formatRoster (facts, side) {
  const list = (facts && facts[side]) || [];
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `[${list.map((p) => `{ name: '${esc(p.name)}', race: '${esc(p.race)}' }`).join(', ')}]`;
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

// 1. Parse with the CURRENT engine from the deploy repo -- this repo's own
// engine is an upstream snapshot and goes stale as fixes land in wc3v-deploy
// (2026-10-12: publishes had silently lost click capture and every engine fix
// after it). Pull the deploy repo first so each publish uses the latest; a
// failed pull (diverged, offline, mid-other-work) falls back to the local copy.
const rawDest = path.join(DEPLOY_DIR, 'replays', tempName + '.w3g');
fs.copyFileSync(input, rawDest);
try {
  execFileSync('git', ['pull', '--ff-only'], { cwd: DEPLOY_DIR, stdio: 'pipe' });
} catch (e) {
  console.log(`Deploy-repo pull failed, parsing with the local engine copy: ${e.message.split('\n')[0]}`);
}
try {
  execFileSync('node', ['engine/wc3v.js', `--replay=${tempName}`], { cwd: DEPLOY_DIR, stdio: 'pipe' });
} catch (e) {
  fs.unlinkSync(rawDest);
  fail(`Parse failed: ${e.message.split('\n')[0]}`);
}

// 2. Extract map + opponent from the parsed output (same fallback chain
// used manually earlier -- meta.players is the Reforged shape, playerRecords
// the classic one; neither is guaranteed).
const parsedGzPath = path.join(DEPLOY_DIR, 'engine', 'client', 'replays', tempName + '.wc3v.gz');
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

// Team-game split (2v2+): replay.players carries each player's name and
// teamId, so Dazootz's side and the enemy side fall straight out of it. In
// a team game the first non-Dazootz name can be his TEAMMATE, so anything
// opponent-shaped must come from this split, never from `opponent` above.
const teammates = [];
const opponents = [];
{
  const norm = (n) => (n || '').split('#')[0].toLowerCase();
  const rp = parsed.replay.players || {};
  const dazEntry = Object.entries(rp).find(([, p]) => norm(p.name) === 'dazootz');
  const dazTeam = dazEntry ? +dazEntry[1].teamId : null;
  for (const [id, p] of Object.entries(rp)) {
    if (!p.name || /neutral|blizzard/i.test(p.name) || norm(p.name) === 'dazootz') continue;
    const player = { id: +id, name: p.name.split('#')[0], teamId: +p.teamId };
    (dazTeam != null && player.teamId === dazTeam ? teammates : opponents).push(player);
  }
}
const isTeam = opponents.length > 1;

const mapDisplay = MAP_DISPLAY_NAMES[mapFolder];
const mapDirExists = fs.existsSync(path.join(DEPLOY_DIR, 'maps', mapFolder));
if (!mapDisplay || !mapDirExists) {
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  fail(`Unknown map "${mapFolder}" -- extract and convert it manually first (README.md), add it to MAP_DISPLAY_NAMES, then rerun on this .w3g`);
}

// 3. Compute the final name and check idempotency. Team games list the
// opposing players only (teammates stay out of the filename): the star API
// caps the slug at 60 chars and a 2v2 with both sides doesn't always fit.
const slugify = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '');
const opponentSlug = isTeam ? opponents.map((o) => slugify(o.name)).join('-') : slugify(opponent);
const finalName = `${yyyy}-${mm}-${dd}_${HH}${MM}_dazootz-vs-${opponentSlug}`;
if (fs.existsSync(path.join(DEPLOY_DIR, 'replays', finalName + '.w3g'))) {
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  console.log(`Already published as ${finalName} -- nothing to do.`);
  process.exit(0);
}

if (dryRun) {
  console.log(`Would publish as: ${finalName}`);
  console.log(`  map: ${mapDisplay}  ${isTeam
    ? `team: ${['Dazootz'].concat(teammates.map((t) => t.name)).join(' & ')} vs ${opponents.map((o) => o.name).join(' & ')}`
    : `opponent: ${opponent}`}`);
  fs.unlinkSync(rawDest);
  fs.unlinkSync(parsedGzPath);
  process.exit(0);
}

// 4. Rename into place in the deploy repo (where the parse ran), and mirror
// the canonical source copies into this repo's replays/ for the archive.
const finalRaw = path.join(DEPLOY_DIR, 'replays', finalName + '.w3g');
const finalParsedGz = path.join(DEPLOY_DIR, 'engine', 'client', 'replays', finalName + '.wc3v.gz');
fs.renameSync(rawDest, finalRaw);
fs.renameSync(parsedGzPath, finalParsedGz);
try {
  fs.copyFileSync(finalRaw, path.join(WC3V_DIR, 'replays', finalName + '.w3g'));
  fs.copyFileSync(finalParsedGz, path.join(WC3V_DIR, 'client', 'replays', finalName + '.wc3v.gz'));
} catch (e) {
  console.log(`Fork-archive mirror skipped: ${e.message}`);
}
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
  if (me && them && applyRecorderWinner(d, me.id, them.id)) {
    // Team game: name the whole winning side, not just its first member.
    if (isTeam && d.winner && d.winner.teamId != null) {
      const winners = Object.entries(d.replay.players || {})
        .filter(([, p]) => p.name && !/neutral|blizzard/i.test(p.name) && +p.teamId === +d.winner.teamId)
        .map(([id]) => +id);
      if (winners.length) d.winner.playerIds = winners;
    }
    wc3vBuf = Buffer.from(JSON.stringify(d));
  }
}

// 5. Write the viewer format into the deploy repo (the raw .w3g is already there).
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
const facts = isTeam ? extractTeamFacts(parsedForFacts) : extractFacts(parsedForFacts);
try {
  const token = fs.readFileSync(TOKEN_ENV, 'utf8').match(/ANTHROPIC_API_KEY=(.+)/);
  if (token) summary = await (isTeam ? generateTeamSummary : generateSummary)(parsedForFacts, token[1].trim());
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
// Duration = the last leave event's game time (the game's real length; a
// game can also end on a disco, which leaveEvents still records).
const leaves = (parsedForFacts.replay && parsedForFacts.replay.leaveEvents) || [];
const durationMs = leaves.length ? Math.max(...leaves.map((e) => e.gameTimeMs || 0)) : null;
const durationField = durationMs ? `, durationMs: ${durationMs}` : '';
const entryLine = isTeam
  ? `      { file: '${finalName}', map: '${mapDisplay}', day: '${day}', timeLabel: '${timeLabel}'${durationField}, gameMode: '${parsed.gameMode || '2v2'}', team: ${formatRoster(facts, 'team')}, opponents: ${formatRoster(facts, 'opponents')}, winner: '${facts ? (facts.winner || '') : ''}'${summaryField} },\n`
  : `      { file: '${finalName}', map: '${mapDisplay}', opponent: '${opponent}', day: '${day}', timeLabel: '${timeLabel}'${durationField}${raceFields}${summaryField} },\n`;
if (isTeam) {
  // Team games live in their own array so the 1v1 tooling (prune, backfill,
  // the 1v1 publish insert) never has to understand them.
  if (!/var TEAM_REPLAYS = \[\n/.test(html)) {
    html += `\n// Team games (2v2+), newest first. Written by publish-replay.js's team path;\n// same line format as REPLAYS, but roster fields instead of a single opponent.\nvar TEAM_REPLAYS = [\n${entryLine}];\n`;
  } else {
    html = html.replace(/(var TEAM_REPLAYS = \[\n)/, `$1${entryLine}`);
  }
} else {
  html = html.replace(/(var REPLAYS = \[\n)/, `$1${entryLine}`);
}
fs.writeFileSync(htmlPath, html);

// 9. Cap enforcement, then publish the HTML.
execFileSync('node', ['scripts/prune-replays.js'], { cwd: DEPLOY_DIR, stdio: 'inherit' });
fs.copyFileSync(path.join(DEPLOY_DIR, 'my-replays.html'), path.join(DEPLOY_DIR, 'index.html'));

// 10. Deploy -- through the repo's deploy wrapper, which regenerates the
// content-derived cache busters (root hash block + MODEL_ASSET_VERSION) so
// a deploy can never ship stale asset versions. WC3_SKIP_DEPLOY=1 stages
// everything locally only (multi-game staging, dry runs).
if (process.env.WC3_SKIP_DEPLOY) {
  console.log('WC3_SKIP_DEPLOY is set -- skipping deploy.');
} else {
  const token = fs.readFileSync(TOKEN_ENV, 'utf8').match(/CLOUDFLARE_API_TOKEN=(.+)/)[1].trim();
  try {
    execFileSync('node', ['engine/tools/gen-root-asset-manifest.js'], { cwd: DEPLOY_DIR, stdio: 'pipe' });
    execFileSync('npx', ['--yes', 'wrangler', 'deploy'], {
      cwd: DEPLOY_DIR,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
      stdio: 'pipe',
    });
  } catch (e) {
    fail(`Deploy failed for ${finalName}: ${e.message.split('\n')[0]} (files are in place locally -- retry with: cd ${DEPLOY_DIR} && npx wrangler deploy)`);
  }
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

const matchup = isTeam
  ? `Dazootz & ${teammates.map((t) => t.name).join(' & ')} vs ${opponents.map((o) => o.name).join(' & ')}`
  : `Dazootz vs ${opponent}`;
notify('WC3 Replay Published', `${matchup} (${mapDisplay}) is live on the site.`);

})().catch((e) => fail(`Unexpected error: ${e.message}`));
