/*
  The win/loss of the player who RECORDED the replay (Dazootz, always, for this
  site), read from the leave record filed under the hidden observer-team seat
  (player 1, shown as "Blizzard"). That seat's result code is the recorder's own
  outcome: 09 = won, 07 = lost, 08 = lost.

  Checked against 7 games with results Dazootz confirmed from memory: 3 wins
  (09) and 4 losses (07, 07, 07, 08), all 7 match. It replaces the earlier
  reading of the two players' own records, which happened to fit the first six
  games and got the seventh wrong.

  Anything else (no such record, unknown code) returns null so the caller can
  fall back rather than guess.
*/
const CODES = { '09000000': 'win', '07000000': 'loss', '08000000': 'loss' };

function recorderResult (data) {
  const r = data && data.replay;
  if (!r) return null;
  const slots = (r.metadata && r.metadata.slotRecords) || [];
  const version = (r.subheader && r.subheader.version) || 0;
  const observerTeam = version >= 29 ? 24 : 12;
  const teamOf = {};
  slots.forEach((s) => { if (s) teamOf[s.playerId] = s.teamId; });
  // The observer seat, not the Neutral Player (team 1046) which never leaves.
  const ev = (r.leaveEvents || []).find((e) => teamOf[e.playerId] === observerTeam);
  return ev ? (CODES[ev.result] || null) : null;
}

// Sets data.winner to match the recorder's result when it is known. `me` and
// `them` are player ids. Returns 'win' | 'loss' | null (left untouched).
function applyRecorderWinner (data, meId, themId) {
  const res = recorderResult(data);
  if (!res || meId == null || themId == null) return null;
  const winnerId = res === 'win' ? meId : themId;
  const slot = ((data.replay.metadata.slotRecords) || []).find((s) => s && s.playerId === winnerId);
  data.winner = {
    teamId: slot ? slot.teamId : null,
    playerId: winnerId,
    playerIds: [winnerId],
    method: 'recorderSlot',
    confidence: 'high'
  };
  return res;
}

module.exports = { recorderResult, applyRecorderWinner };
