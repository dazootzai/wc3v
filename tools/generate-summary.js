#!/usr/bin/env node
/*
  A few-sentence AI summary of one parsed replay, from real extracted facts
  (map, races, duration, APM, tech timings, the winner if computeWinner
  could resolve one) -- never guessed, never invented. Used both by
  publish-replay.js (one new game) and backfill-summaries.js (existing ones).

  Exports generateSummary(wc3vData) -> Promise<string>.
  CLI: node tools/generate-summary.js <path-to.wc3v-or-.wc3v.gz>
*/
const fs = require('fs');
const zlib = require('zlib');
const http = require('http');
const MAP_DISPLAY_NAMES = require('./map-display-names');
const { recorderResult } = require('./recorder-result');

// E for Night Elf, not N -- checked against every race code actually
// present across all 8 real replays (only E/H/O/U ever appear) rather
// than assumed.
const RACE_NAMES = { H: 'Human', O: 'Orc', U: 'Undead', E: 'Night Elf' };

function extractFacts (data) {
  const meta = data.replay.metadata;
  const mapFolder = meta.map.mapName.split('/').pop().replace(/\.w3x$/i, '').replace(/^\(\d+\)/, '');
  const mapName = MAP_DISPLAY_NAMES[mapFolder] || mapFolder;

  let records = [];
  if (meta.players) {
    records = Object.entries(meta.players).filter(([, p]) => p.name && !/neutral|blizzard/i.test(p.name))
      .map(([id, p]) => ({ id: +id, name: p.name.split('#')[0], race: p.raceDetected }));
  } else if (meta.playerRecords) {
    const seen = new Set();
    for (const p of meta.playerRecords) {
      if (p.playerName && !seen.has(p.playerId) && !/neutral|blizzard/i.test(p.playerName)) {
        seen.add(p.playerId);
        records.push({ id: p.playerId, name: p.playerName.split('#')[0] });
      }
    }
  }
  const dazootz = records.find((r) => r.name.toLowerCase() === 'dazootz');
  const opponent = records.find((r) => r.name.toLowerCase() !== 'dazootz');
  if (!dazootz || !opponent) return null;

  const dazPlayer = data.players[String(dazootz.id)] || {};
  const oppPlayer = data.players[String(opponent.id)] || {};
  const dazRace = dazPlayer.race || dazootz.race;
  const oppRace = oppPlayer.race || opponent.race;

  const durationMs = (data.replay.subheader && data.replay.subheader.replayLengthMS)
    || (data.replay.parseTruncated && data.replay.parseTruncated.lastActionGameTimeMs) || null;

  let winner = null; // 'dazootz' | 'opponent' | null (unresolved)
  let winnerAssumed = false;
  const rec = recorderResult(data);   // Dazootz's own result, from the observer-seat record
  if (rec) {
    winner = rec === 'win' ? 'dazootz' : 'opponent';
  } else if (data.winner && data.winner.playerId != null) {
    winner = data.winner.playerId === dazootz.id ? 'dazootz' : 'opponent';
  } else if (!(data.replay.leaveEvents || []).length) {
    // No leave data at all (parser stopped early, or the recording just
    // doesn't have it) -- Dazootz's own call (2026-09-28): he quits out early
    // on losses, never on wins, so a replay with nothing captured is safe to
    // treat as a loss. Only applies when there's truly zero leave data; a
    // replay that HAS leave events but they're contradictory/ambiguous still
    // resolves to null -- that's a different failure mode, not "quit early."
    winner = 'opponent';
    winnerAssumed = true;
  }

  const tierTime = (stream, tier) => {
    const e = (stream || []).find((t) => t.tier === tier);
    return e ? Math.round(e.gameTime / 1000) : null;
  };

  // dominanceSeries.score is Dazootz's own share of total (both players'
  // own series report their own score the same way -- 50 is even, above is
  // ahead), sampled every ~10s. Used for both the game-long trend and to
  // measure each battle's actual effect (score just before -> just after).
  const samples = (dazPlayer.dominanceSeries && dazPlayer.dominanceSeries.samples) || [];
  const scoreAt = (t) => {
    if (!samples.length) return null;
    let nearest = samples[0];
    for (const s of samples) { if (s.t <= t) nearest = s; else break; }
    return nearest.score;
  };
  const trend = [0, 0.25, 0.5, 0.75, 1].map((frac) => {
    if (!durationMs) return null;
    return Math.round(scoreAt(durationMs * frac));
  });

  const battles = (dazPlayer.battleParticipation || []).map((b) => {
    const before = scoreAt(b.startTime - 1);
    const after = scoreAt(b.endTime + 1);
    const initiatorSide = b.role === 'initiator' ? 'dazootz'
      : ((oppPlayer.battleParticipation || []).find((ob) => ob.battleId === b.battleId && ob.role === 'initiator') ? 'opponent' : null);
    return {
      timeSec: Math.round(b.startTime / 1000),
      category: b.category,
      initiator: initiatorSide,
      dominanceSwingTowardDazootz: (before != null && after != null) ? Math.round((after - before) * 10) / 10 : null,
    };
  });

  const foodUtilization = (series) => {
    const usable = (series || []).filter((s) => s.foodMax > 0);
    if (!usable.length) return null;
    return Math.round(usable.reduce((sum, s) => sum + s.foodUsed / s.foodMax, 0) / usable.length * 100);
  };
  const lastOf = (series) => (series && series.length ? series[series.length - 1] : {});
  const dazLast = lastOf(dazPlayer.resourceSeries);
  const oppLast = lastOf(oppPlayer.resourceSeries);

  return {
    map: mapName,
    dazootzOpponent: opponent.name,
    dazootzRace: RACE_NAMES[dazRace] || dazRace || 'unknown race',
    opponentRace: RACE_NAMES[oppRace] || oppRace || 'unknown race',
    durationSec: durationMs ? Math.round(durationMs / 1000) : null,
    dazootzApm: dazPlayer.apmData ? dazPlayer.apmData.effective.average : null,
    opponentApm: oppPlayer.apmData ? oppPlayer.apmData.effective.average : null,
    dazootzTier2Sec: tierTime(dazPlayer.tierStream, 2),
    dazootzTier3Sec: tierTime(dazPlayer.tierStream, 3),
    winner,
    winnerAssumed,
    winnerConfidence: winnerAssumed ? 'assumed' : (rec ? 'high' : (data.winner ? data.winner.confidence : null)),
    // Dazootz's dominance score at 0/25/50/75/100% of the game -- 50 even,
    // above is ahead. null entries mean no dominance data was available.
    dominanceTrend: trend,
    battles,
    macro: {
      dazootzFoodUtilizationPct: foodUtilization(dazPlayer.resourceSeries),
      opponentFoodUtilizationPct: foodUtilization(oppPlayer.resourceSeries),
      dazootzGoldSpent: dazLast.goldSpent ?? null,
      opponentGoldSpent: oppLast.goldSpent ?? null,
      dazootzLumberSpent: dazLast.lumberSpent ?? null,
      opponentLumberSpent: oppLast.lumberSpent ?? null,
      dazootzGoldLostInFights: dazLast.goldLost ?? null,
      opponentGoldLostInFights: oppLast.goldLost ?? null,
    },
  };
}

function fmtMin (sec) {
  if (sec == null) return null;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// Summaries route through the local GLM bridge (glm-bridge, localhost:8787)
// rather than api.anthropic.com — Charles's call, 2026-10-01: no Anthropic
// API usage. The bridge translates the claude-* model name to glm-5.3-flash
// and injects the real upstream key itself, so the key argument is only a
// formality kept for the existing call signature.
function callClaude (apiKey, prompt) {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    // Was 160 — enough for haiku's text-only reply, but glm-5.3-flash thinks
    // before answering and burned the whole budget on the thinking block,
    // leaving nothing for the text (backfill failed with "no text block").
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8787,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'authorization': 'Bearer ' + apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          // content is a block array; glm-5.3-flash (and any model with
          // thinking enabled) puts a thinking block first — take the first
          // text block, not blindly index 0.
          const textBlock = (parsed.content || []).find(b => b && b.type === 'text');
          if (!textBlock || !textBlock.text) return reject(new Error('no text block in response: ' + data.slice(0, 300)));
          resolve(textBlock.text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function generateSummary (data, apiKey) {
  apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('No ANTHROPIC_API_KEY (set it in env or pass one in)');

  const facts = extractFacts(data);
  if (!facts) throw new Error('Could not identify Dazootz + an opponent in this replay');

  const trendLabels = ['start', '25%', 'mid', '75%', 'end'];
  const trendLine = facts.dominanceTrend.some((v) => v != null)
    ? `Dominance trend (Dazootz's share of the game, 50 = even, higher = ahead): ${facts.dominanceTrend.map((v, i) => `${trendLabels[i]} ${v == null ? '?' : v}`).join(', ')}`
    : null;

  // Computed, not left to the model to eyeball -- every summary was coming
  // back with the literal phrase "close throughout" regardless of what the
  // numbers actually showed (freitasking ended 18 points lopsided and still
  // got called close). Ground sentence 2 in a real number instead.
  const closenessLine = (() => {
    const pts = facts.dominanceTrend;
    const known = pts.map((v, i) => ({ v, i })).filter((p) => p.v != null);
    if (known.length < 2) return null;
    const maxDev = known.reduce((m, p) => Math.max(m, Math.abs(p.v - 50)), 0);
    const peak = known.reduce((a, b) => (Math.abs(b.v - 50) > Math.abs(a.v - 50) ? b : a));
    const timing = peak.i <= 1 ? 'early' : peak.i >= 3 ? 'late' : 'mid-game';
    const towardWho = peak.v > 50 ? 'Dazootz' : facts.dazootzOpponent;
    let label;
    if (maxDev <= 8) label = 'close the entire game, never far from even';
    else if (maxDev <= 18) label = `somewhat one-sided -- ${towardWho} built a real lead ${timing}`;
    else label = `one-sided -- ${towardWho} was clearly ahead ${timing}`;
    return `Closeness (computed from the trend above, use this framing directly): ${label}.`;
  })();

  const battleLines = facts.battles.length
    ? facts.battles.map((b) => {
        const who = b.initiator === 'dazootz' ? 'Dazootz initiated' : b.initiator === 'opponent' ? `${facts.dazootzOpponent} initiated` : 'initiator unclear';
        const swing = b.dominanceSwingTowardDazootz == null ? '' :
          b.dominanceSwingTowardDazootz > 0 ? `, swung ${b.dominanceSwingTowardDazootz} points toward Dazootz`
          : b.dominanceSwingTowardDazootz < 0 ? `, swung ${Math.abs(b.dominanceSwingTowardDazootz)} points toward ${facts.dazootzOpponent}`
          : ', no measurable dominance swing';
        return `  - ${fmtMin(b.timeSec)} ${b.category}, ${who}${swing}`;
      }).join('\n')
    : null;

  const m = facts.macro;
  const macroLine = `Macro at game end: Dazootz ${m.dazootzFoodUtilizationPct != null ? `${m.dazootzFoodUtilizationPct}% avg supply utilization` : 'supply data unavailable'}, ${m.dazootzGoldSpent ?? '?'} gold / ${m.dazootzLumberSpent ?? '?'} lumber spent, ${m.dazootzGoldLostInFights ?? '?'} gold lost in fights. `
    + `${facts.dazootzOpponent} ${m.opponentFoodUtilizationPct != null ? `${m.opponentFoodUtilizationPct}% avg supply utilization` : 'supply data unavailable'}, ${m.opponentGoldSpent ?? '?'} gold / ${m.opponentLumberSpent ?? '?'} lumber spent, ${m.opponentGoldLostInFights ?? '?'} gold lost in fights.`;

  const lines = [
    `Map: ${facts.map}`,
    `Dazootz: ${facts.dazootzRace}${facts.dazootzApm != null ? `, ${facts.dazootzApm} effective APM` : ''}${facts.dazootzTier2Sec != null ? `, hit Tier 2 at ${fmtMin(facts.dazootzTier2Sec)}` : ''}${facts.dazootzTier3Sec != null ? `, Tier 3 at ${fmtMin(facts.dazootzTier3Sec)}` : ''}`,
    `Opponent name: ${facts.dazootzOpponent}`,
    `Opponent: ${facts.opponentRace}${facts.opponentApm != null ? `, ${facts.opponentApm} effective APM` : ''}`,
    facts.durationSec != null ? `Game length: ${fmtMin(facts.durationSec)}` : null,
    facts.winnerAssumed
      ? `Winner: Dazootz lost (assumed -- no leave data was captured at all, and Dazootz quits out early on losses, never on wins, so this is treated as a loss)`
      : facts.winner
        ? `Winner: ${facts.winner === 'dazootz' ? 'Dazootz' : facts.dazootzOpponent} (${facts.winnerConfidence} confidence, inferred from leave records)`
        : 'Winner: not determinable from this replay (leave records inconclusive) -- do not guess or imply one',
    trendLine,
    closenessLine,
    battleLines ? `Battles:\n${battleLines}` : 'Battles: none detected',
    macroLine,
  ].filter(Boolean).join('\n');

  const prompt = `Write a very short, plain, factual 2-sentence summary of this Warcraft III 1v1 replay. The replay card already shows the map, both races, and who won right above this text -- do NOT restate any of that (no map name, no race names, no "Dazootz won/lost"). Use the freed-up space to say something actually useful instead.

Style example (length and plainness only, not content -- every game is different, don't reuse this wording):

"The game stayed close until fumed built a lead through the mid-game harass, and Dazootz never fully closed the gap. Dazootz out-spent fumed on resources, but let fights happen on bad terms -- picking fights only when ahead in numbers would help."

Rules:
- Sentence 1: how the game actually went and what the single biggest turning point was -- ground this in the "Closeness" line below (close vs. one-sided, and when/toward whom the lead formed) but describe it as an event, not a restated number. Never default to "close throughout" unless the Closeness line actually says close.
- Sentence 2: the real deciding factor (macro, army composition, micro, tech timing, map control, fight decisions) grounded in the facts below, ending with one concrete, general thing to improve -- a skill Dazootz can carry into ANY future game, not specific to this opponent.
- Third-grade-reading-level plain words. No stats, no numbers, no times, no jargon, no hype. You may name the opponent once if it reads naturally.
- Never imply a rematch or rivalry -- every opponent is a one-off random matchup.
- If the winner is marked "not determinable", don't state or imply who won -- describe the trajectory and the improvement point regardless.

Use only the facts below -- don't invent anything beyond them.

${lines}

Summary:`;

  return callClaude(apiKey, prompt);
}

module.exports = { generateSummary, extractFacts };

if (require.main === module) {
  const input = process.argv[2];
  if (!input) { console.error('Usage: node tools/generate-summary.js <path-to.wc3v[.gz]>'); process.exit(1); }
  let buf = fs.readFileSync(input);
  if (input.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const data = JSON.parse(buf);
  generateSummary(data).then((s) => console.log(s)).catch((e) => { console.error(e.message); process.exit(1); });
}
