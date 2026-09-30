#!/usr/bin/env node
/*
  Parser audit: compare our parse of each replay against an independent parser
  (w3gjs) reading the SAME .w3g, and list where the two disagree.

  Neither is ground truth, but two separate implementations agreeing is strong
  evidence, and a disagreement points at a specific thing to look into:
    units / buildings / upgrades   how many of each the player ordered
    hero abilities                 how many skill points were spent, per hero
    game length

  Known, intended differences: w3gjs counts every order issued, while we drop
  orders that were cancelled or refused, so "they have more than us" is often
  fine. "We have MORE than they do" is not -- we should never invent orders.

  Usage:
    node tools/parser-audit.js [replay-id ...]        (default: every published game)
    node tools/parser-audit.js --json                 machine-readable output

  Needs w3gjs:   npm i --no-save w3gjs   (in this folder's parent, or NODE_PATH)
*/
const fs = require('fs');
const path = require('path');

let W3GReplay;
try { W3GReplay = require('w3gjs').default; } catch (e) {
  const alt = process.env.W3GJS_PATH || '/tmp/claude-1000/-home-deck-daz-ai-agent/89106a11-532e-401d-837d-7f18f5bcb9af/scratchpad/w3g/node_modules/w3gjs';
  W3GReplay = require(alt).default;
}

const DEPLOY = path.join(__dirname, '..', '..', 'wc3v-deploy', 'replays');
const norm = (n) => String(n || '').split('#')[0].toLowerCase();

function ourNames (d) {
  const out = {};
  const meta = d.replay.metadata || {};
  Object.entries(meta.players || {}).forEach(([id, p]) => { if (p.name) out[id] = norm(p.name); });
  (meta.playerRecords || []).forEach((p) => { if (p.playerName) out[String(p.playerId)] = norm(p.playerName); });
  return out;
}

function inc (o, k, n = 1) { if (k) o[k] = (o[k] || 0) + n; }

// Spell-created units: real units, but nobody trained them, so they are not orders.
const SUMMON_IDS = new Set(['uske', 'uskm', 'ucs1', 'ucs2', 'ucs3', 'hwat', 'hwt2', 'hwt3', 'efon', 'osw1', 'osw2', 'osw3']);

function ourCounts (p) {
  const units = {}, buildings = {}, upgrades = {}, heroPoints = {};
  for (const e of p.eventStream || []) {
    if (e.key === 'addUnit' && e.unit && !e.unit.isHero && !e.unit.isSummon && !SUMMON_IDS.has(e.unit.itemId)) inc(units, e.unit.itemId, Number(e.count) || 1);
    else if (e.key === 'addBuilding' && e.building) inc(buildings, e.building.itemId, Number(e.count) || 1);
    else if ((e.key === 'tierUpgrade' || e.key === 'buildingUpgrade') && e.building) inc(buildings, e.building.itemId);
    else if (e.key === 'research') inc(upgrades, e.itemId);
    else if (e.key === 'HeroLevel' && e.unit) inc(heroPoints, e.unit.itemId);
  }
  return { units, buildings, upgrades, heroPoints };
}

function theirCounts (tp) {
  const heroPoints = {};
  for (const h of tp.heroes || []) heroPoints[h.id] = (h.abilityOrder || []).length;
  return { units: tp.units.summary || {}, buildings: tp.buildings.summary || {}, upgrades: tp.upgrades.summary || {}, heroPoints };
}

function diffs (kind, ours, theirs) {
  const out = [];
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const a = ours[k] || 0, b = theirs[k] || 0;
    if (a !== b) out.push({ kind, id: k, ours: a, theirs: b, delta: a - b });
  }
  return out;
}

async function auditOne (id) {
  const d = JSON.parse(fs.readFileSync(path.join(DEPLOY, id + '.wc3v')));
  const w = await new W3GReplay().parse(path.join(DEPLOY, id + '.w3g'));
  const names = ourNames(d);
  const result = { id, lengthDeltaMs: (d.replay.subheader.replayLengthMS || 0) - w.duration, players: [] };
  for (const [pid, p] of Object.entries(d.players)) {
    if (p.isNeutralPlayer) continue;
    const nm = names[pid];
    const tp = w.players.find((x) => norm(x.name) === nm);
    if (!tp) { result.players.push({ name: nm || pid, missing: true, diffs: [] }); continue; }
    const o = ourCounts(p), t = theirCounts(tp);
    result.players.push({
      name: nm,
      race: p.race,
      diffs: [].concat(diffs('units', o.units, t.units), diffs('buildings', o.buildings, t.buildings),
        diffs('upgrades', o.upgrades, t.upgrades), diffs('heroSkills', o.heroPoints, t.heroPoints))
    });
  }
  return result;
}

(async () => {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  let ids = args.filter((a) => !a.startsWith('--'));
  if (!ids.length) ids = fs.readdirSync(DEPLOY).filter((f) => f.endsWith('.wc3v')).map((f) => f.replace('.wc3v', '')).sort();

  const results = [];
  for (const id of ids) {
    try { results.push(await auditOne(id)); } catch (e) { results.push({ id, error: e.message, players: [] }); }
  }
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }

  // Roll up across games: which (kind, id) disagree most often, and in which direction.
  const roll = {};
  for (const r of results) {
    for (const pl of r.players) {
      for (const df of pl.diffs) {
        const key = `${df.kind}:${df.id}`;
        const e = roll[key] || (roll[key] = { key, games: new Set(), over: 0, under: 0, more: 0, fewer: 0 });
        e.games.add(r.id);
        if (df.delta > 0) { e.more += df.delta; e.over++; } else { e.fewer -= df.delta; e.under++; }
      }
    }
  }
  const rows = Object.values(roll).sort((a, b) => (b.more + b.fewer) - (a.more + a.fewer));
  console.log(`Audited ${results.length} games with ${results.reduce((n, r) => n + r.players.length, 0)} players.\n`);
  console.log('WE HAVE MORE than the other parser (we may be inventing orders):');
  rows.filter((r) => r.more > 0).sort((a, b) => b.more - a.more).slice(0, 25)
    .forEach((r) => console.log(`  ${r.key.padEnd(22)} +${String(r.more).padEnd(4)} in ${r.over} player-games   (games: ${r.games.size})`));
  console.log('\nWE HAVE FEWER (expected for cancelled orders; large gaps are worth a look):');
  rows.filter((r) => r.fewer > 0).sort((a, b) => b.fewer - a.fewer).slice(0, 25)
    .forEach((r) => console.log(`  ${r.key.padEnd(22)} -${String(r.fewer).padEnd(4)} in ${r.under} player-games   (games: ${r.games.size})`));
  console.log('\nBIGGEST GAPS in a single player-game (other parser has >=3 more AND >=25% more; or we have >=2 more):');
  const gaps = [];
  for (const r of results) for (const pl of r.players) for (const df of pl.diffs) {
    if ((df.delta <= -3 && -df.delta >= 0.25 * df.theirs) || df.delta >= 2) gaps.push({ game: r.id, who: pl.name, ...df });
  }
  gaps.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 30)
    .forEach((g) => console.log(`  ${g.game.slice(0, 28).padEnd(29)} ${String(g.who).padEnd(11)} ${(g.kind + ':' + g.id).padEnd(20)} ours ${String(g.ours).padEnd(3)} theirs ${g.theirs}`));
  console.log('\nGame length differences over 1s:');
  results.filter((r) => Math.abs(r.lengthDeltaMs) > 1000).forEach((r) => console.log(`  ${r.id}: ${r.lengthDeltaMs}ms`));
  const errs = results.filter((r) => r.error);
  if (errs.length) { console.log('\nCould not audit:'); errs.forEach((r) => console.log(`  ${r.id}: ${r.error}`)); }
})();
