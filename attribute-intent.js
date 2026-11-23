'use strict';
// attribute-intent.js - per-press intent attribution for the gate games.
// usage: node attribute-intent.js <basename> <wc3replaysDir>
// Joins parse-intent.js's full-length walk with the per-game oracle sidecar:
// for every order press, the recipients = the selection at press time
// (pairs id1,id2) mapped to unit types. Output: .simtmp/intent-attrib-<base>.json
// per-press rows {ms,p,act,ord,flags,pt,tgt:[id1,id2],recip:[{id1,id2,ty}]}.
const fs = require('fs');
const path = require('path');
const base = process.argv[2];
const wrDir = process.argv[3] || path.join(__dirname, '..', 'wc3-replays');
if (!base) { console.error('usage: node attribute-intent.js <basename> [wc3replaysDir]'); process.exit(1); }
const simtmp = (f) => path.join(wrDir, '.simtmp', f);

// oracle: per player, id1/id2 -> unit type
const side = JSON.parse(fs.readFileSync(simtmp('oracle-walklag-' + base + '.json'), 'utf8'));
const typeByPair = new Map(); // "id1,id2" -> type ; and id1 -> type
for (const pk of Object.keys(side.players)) {
	for (const u of side.players[pk]) {
		typeByPair.set(pk + ':' + u.id1 + ',' + u.id2, u.type);
		typeByPair.set(pk + ':' + u.id1, u.type);
	}
}

const lines = fs.readFileSync(simtmp('intent-' + base + '.txt'), 'utf8').split('\n');
const sel = {}; // player -> array of "id1,id2"
const presses = [];
let selCount = 0, subCount = 0, ordCount = 0, chatCount = 0;
const orderRe = /^t=(\d+)ms p(\d+) act 0x(\w+) #(\d+) flags=0x([0-9a-f]+)(?: pt\(([-\d.]+),([-\d.]+)\))?(?: obj=(-?\d+),(-?\d+))?/;
const selRe = /^t=(\d+)ms p(\d+) SELECT mode=(\d+) \[(.*)\]$/;
const grpRe = /^GRP\t(\d+)\t(\d+)\t(\d+)\t(.*)$/;
const gkeyRe = /^GKEY\t(\d+)\t(\d+)\t(\d+)\s*$/;
// selection semantics mirror the feeder's oracle-graded applySelection:
// mode2 = remove; mode1 right after a mode2 IN THE SAME command block (same
// ms) = REPLACE; mode1 alone = shift-ADD. A group-hotkey press (GKEY, 0x18)
// is an unambiguous REPLACE from the saved group; GRP (0x17) only saves.
const hotkeys = {}; // player -> { group: [pairs] }
const lastSelChange = {}; // player -> { ms, mode }
let gkeyCount = 0;
function applySel(p, pairs, mode, ms) {
	selCount++;
	const prev = lastSelChange[p];
	const replace = mode === 1 && prev && prev.ms === ms && prev.mode === 2;
	lastSelChange[p] = { ms, mode };
	if (!sel[p]) sel[p] = [];
	if (mode === 2) {
		const drop = new Set(pairs.map((x) => x.split(',')[0]));
		sel[p] = sel[p].filter((x) => !drop.has(x.split(',')[0]));
	} else if (replace) {
		sel[p] = pairs.slice();
	} else {
		const have = new Set(sel[p].map((x) => x.split(',')[0]));
		for (const pair of pairs) if (!have.has(pair.split(',')[0])) sel[p].push(pair);
	}
}
for (const line of lines) {
	let m = line.match(selRe);
	if (m) {
		applySel(m[2], m[4] ? m[4].split(';') : [], +m[3], +m[1]);
		continue;
	}
	m = line.match(grpRe);
	if (m) {
		subCount++;
		hotkeys[m[2]] = hotkeys[m[2]] || {};
		hotkeys[m[2]][m[3]] = m[4] ? m[4].split(';') : [];
		continue;
	}
	m = line.match(gkeyRe);
	if (m) {
		gkeyCount++;
		const hk = (hotkeys[m[2]] || {})[m[3]];
		if (hk) {
			sel[m[2]] = hk.slice();
			lastSelChange[m[2]] = { ms: +m[1], mode: 1 };
		}
		continue;
	}
	m = line.match(orderRe);
	if (m) {
		ordCount++;
		const p = m[2];
		const cur = sel[p] || [];
		const recip = cur.map((pair) => {
			const key = p + ':' + pair;
			const ty = typeByPair.get(key) || typeByPair.get(p + ':' + pair.split(',')[0]) || '?';
			return { id1: Number(pair.split(',')[0]), id2: Number(pair.split(',')[1] || 0), ty };
		});
		presses.push({
			ms: +m[1], p, act: m[3], ord: +m[4], flags: m[5],
			pt: m[6] ? [+m[6], +m[7]] : null,
			tgt: m[8] ? [Number(m[8]), Number(m[9])] : null,
			recip
		});
		continue;
	}
	if (/^CHAT/.test(line)) chatCount++;
}
const outPath = simtmp('intent-attrib-' + base + '.json');
fs.writeFileSync(outPath, JSON.stringify({ base, selCount, subCount, ordCount, chatCount, presses }, null, 1));
console.log('written ' + outPath);
console.log('selections=' + selCount + ' groupSaves=' + subCount + ' groupUses=' + gkeyCount + ' orders=' + ordCount + ' chats=' + chatCount);
const multi = presses.filter((p) => p.recip.length >= 2).length;
const unbound = presses.filter((p) => p.recip.length && p.recip.every((r) => r.ty === '?')).length;
console.log('multi-recipient presses=' + multi + ' fully-unbound presses=' + unbound);
