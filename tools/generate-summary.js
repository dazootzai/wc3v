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
const https = require('https');
const MAP_DISPLAY_NAMES = require('./map-display-names');

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

  let winner = null; // 'dazootz' | 'opponent' | null (unresolved -- never guessed)
  if (data.winner && data.winner.playerId != null) {
    winner = data.winner.playerId === dazootz.id ? 'dazootz' : 'opponent';
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
    winnerConfidence: data.winner ? data.winner.confidence : null,
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

function callClaude (apiKey, prompt) {
  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
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
          resolve(parsed.content[0].text.trim());
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
    facts.winner
      ? `Winner: ${facts.winner === 'dazootz' ? 'Dazootz' : facts.dazootzOpponent} (${facts.winnerConfidence} confidence, inferred from leave records)`
      : 'Winner: not determinable from this replay (leave records inconclusive) -- do not guess or imply one',
    trendLine,
    battleLines ? `Battles:\n${battleLines}` : 'Battles: none detected',
    macroLine,
  ].filter(Boolean).join('\n');

  const prompt = `Write a short analysis (4-6 sentences, one paragraph) of this Warcraft III 1v1 replay for Dazootz's own replay-sharing page -- he wants to know what actually decided the game and what to work on, not a recap. Plain, direct tone, second person to Dazootz ("you"), no hype or "epic battle" filler.

Cover, using only the facts given below -- don't invent anything beyond them:
- How close the game actually was (the dominance trend) and whether it swung early or late.
- The key battle(s): which one(s) mattered most (biggest dominance swing), who started them, and what that suggests.
- A real macro/micro comparison (supply utilization, resources spent, gold lost in fights) -- not just numbers restated, but what they mean (e.g., low supply utilization suggests production sat idle; heavy gold lost in fights with little dominance gain suggests bad fights).
- One concrete, specific thing Dazootz could improve next game, grounded in what actually happened in THIS game -- not generic advice.

If the winner is marked "not determinable", do not state or imply who won -- analyze the game's trajectory and what to improve regardless. Refer to the opponent by their actual name given below (not "the opponent"), even if it looks like an ordinary word.

${lines}

Analysis:`;

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
