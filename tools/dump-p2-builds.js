// probe 37: dump a player's build/train presses with decoded ability ids —
// find the altar build and hero trains the sim never processed.
const fs = require('fs');
const path = require('path');
const utils = require(path.join(__dirname, '..', 'helpers', 'utils'));
const ReplayParser = require(path.join(__dirname, '..', 'node_modules', 'w3gjs', 'dist', 'lib', 'parsers', 'ReplayParser')).default;

const file = process.argv[2] || '/home/deck/wc3v-deploy/replays/2026-10-17_0257_dazootz-vs-solazy.w3g';
const target = parseInt(process.argv[3] || '2', 10);
const buffer = fs.readFileSync(file);

const fcc = (a) => Array.isArray(a)
  ? String.fromCharCode(a[0] & 0x7f, a[1], a[2], a[3])
  : (typeof a === 'number' && a > 0x20000000
      ? String.fromCharCode((a >> 24) & 0x7f, (a >> 16) & 0xff, (a >> 8) & 0xff, a & 0xff)
      : String(a));

const parser = new ReplayParser();
let t = 0, all = 0, p2n = 0;
const presses = [];
parser.on('gamedatablock', (block) => {
  if (block.timeIncrement) t += block.timeIncrement;
  (block.commandBlocks || []).forEach((ab) => {
    all += (ab.actions || []).length;
    if (ab.playerId !== target) return;
    (ab.actions || []).forEach((raw) => {
      p2n++;
      const fixed = utils.fixBrokenActionFormat(utils.normalizeAction(raw));
      if (fixed.id === 16 || fixed.id === 17 || fixed.id === 18) {
        presses.push({ t, act: fixed.id, it: fixed.itemId, fl: fixed.abilityFlags, x: fixed.targetX, y: fixed.targetY });
      }
    });
  });
});
try { parser.parse(buffer); } catch (e) { console.error('parse threw:', e.message); }

// the parser emits asynchronously — print after the queue drains
setTimeout(() => {
const out = [];
let cur = null;
for (const p of presses) {
  const k = p.act + ':' + JSON.stringify(p.it);
  if (cur && cur.k === k && p.t - cur.lt < 20000) { cur.n++; cur.lt = p.t; }
  else { if (cur) out.push(cur); cur = { k, n: 1, first: p, lt: p.t }; }
}
if (cur) out.push(cur);

for (const r of out) {
  const f = r.first;
  const xy = f.act !== 16 ? ' @(' + Math.round(f.x || 0) + ',' + Math.round(f.y || 0) + ')' : '';
  console.log('%8.1fs act %2d %-14s flags=%-4s n=%d%s', f.t / 1000, f.act, fcc(f.it), f.fl, r.n, xy);
}
console.error('all=%d p2=%d presses=%d', all, p2n, presses.length);
}, 1500);
