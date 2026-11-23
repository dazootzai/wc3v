'use strict';
// parse-intent.js — full-length raw action walk with per-unit intent fields:
// 0x16/0x17 selections carry BOTH object ids per unit, orders carry the target
// object id pair, and the game routes an order to the whole selection — so
// per-unit intent = selection membership at press time. FIX vs actscan4: the
// walk died at the first CHAT block (0x20; measured on xina @76.5s: id, player,
// u16 len, then len bytes) — birdmane truncated at 646.1s, xina at 76.5s.
// (skipMetadata + walkBlocks + parseAction sizes): prints 0x10-0x14 orders and
// 0x16 selections with timestamps in a window. Ground truth for recorded clicks.
const fs = require('fs');
const zlib = require('zlib');

const path = process.argv[2];
const winLo = parseInt(process.argv[3] || '0', 10);
const winHi = parseInt(process.argv[4] || '999999999', 10);
const file = fs.readFileSync(path);

const magicStart = file.indexOf(Buffer.from('Warcraft III recorded game'));
if (magicStart < 0) { console.log('no w3g magic'); process.exit(1); }
let pos = magicStart;
while (file[pos] !== 0) pos++;
pos += 1 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 2 + 2 + 4 + 4;

const chunks = [];
while (pos + 12 <= file.length) {
	const blockStart = pos;
	const compressedSize = file.readUInt16LE(pos);
	if (compressedSize === 0) break;
	const contentStart = blockStart + 12;
	if (contentStart + compressedSize > file.length) break;
	try {
		chunks.push(zlib.inflateSync(file.subarray(contentStart, contentStart + compressedSize), { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
	} catch (e) {
		try {
			chunks.push(zlib.inflateRawSync(file.subarray(contentStart, contentStart + compressedSize), { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
		} catch (e2) { console.log('block at ' + blockStart + ' failed both inflates'); }
	}
	pos = contentStart + compressedSize;
}
const out = Buffer.concat(chunks);
let d = 0;
let post202 = false;

const u8 = (p) => out[p] & 0xFF;
const u16 = (p) => out.readUInt16LE(p);
const u32 = (p) => out.readUInt32LE(p);
const f32 = (p) => out.readFloatLE(p);
function zeroTermStr(p) { const s = p; while (out[p] !== 0) p++; return { str: out.toString('latin1', s, p), next: p + 1 }; }
function zeroTermBytes(p) { const s = p; while (out[p] !== 0) p++; return { bytes: out.subarray(s, p), next: p + 1 }; }
function hostRecord(p) { p += 1; const r = zeroTermStr(p); p = r.next; const add = u8(p); p += 1 + add; return p; }
function decodeMeta(hex) {
	const dec = []; let mask = 0, dp = 0;
	for (let i = 0; i < hex.length; i++) {
		if (i % 8 === 0) mask = hex[i];
		else dec[dp++] = (mask & (1 << (i % 8))) === 0 ? hex[i] - 1 : hex[i];
	}
	return Buffer.from(dec.slice(0, dp));
}

// skipMetadata
d += 5;
d = hostRecord(d);
const gn = zeroTermStr(d); d = gn.next;
const s2 = zeroTermStr(d); d = s2.next;
const enc = zeroTermBytes(d); d = enc.next;
const meta = decodeMeta(enc.bytes);
let m = 0;
m += 4 + 5 + 4;
{ const r = zeroTermStr(m); m = r.next; } // map name
{ const r = zeroTermStr(m); m = r.next; } // map author
m += 1 + 20;
d += 4; // player count
d += 8; // game type + locale
while (u8(d) === 22) { d = hostRecord(d); d += 4; }
while (true) {
	const peek = u8(d);
	if (peek === 0x38 || peek === 0x39) {
		if (peek === 0x38) post202 = true;
		d += 2;
		const len = u32(d); d += 4 + len;
	} else break;
}
if (u8(d) !== 25) console.log('missing 0x19 separator (got 0x' + u8(d).toString(16) + ')');
d += 1;
d += 2; // remaining u16
const slotCount = u8(d); d += 1;
d += slotCount * 9 + 6;
console.log('post202=' + post202 + ' data starts at ' + d);

const fourcc = (o) => {
	const b = Buffer.alloc(4); b.writeUInt32LE(o >>> 0);
	const s = b.toString('latin1');
	return /^[\x21-\x7e]{4}$/.test(s) ? "'" + s + "'" : '#' + (o >>> 0);
};

let ms = 0;
while (d < out.length) {
	const id = u8(d); d += 1;
	if (id === 0x1E || id === 0x1F) {
		const byteCount = u16(d); d += 2;
		const timeIncrement = u16(d); d += 2;
		ms += timeIncrement;
		const end = d + byteCount - 2;
		while (d < end) {
			const playerId = u8(d); d += 1;
			const actionLen = u16(d); d += 2;
			const actionEnd = d + actionLen;
			while (d < actionEnd) {
				const actStart = d;
				let act = u8(d); d += 1;
				if (post202 && act > 0x77) act += 1;
				const inWin = ms >= winLo && ms <= winHi;
				switch (act) {
					case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: {
						const flags = u16(d);
						const o = u32(d + 2);
						let extra = '';
						if (act !== 0x10) extra = ' pt(' + f32(d + 14).toFixed(1) + ',' + f32(d + 18).toFixed(1) + ')';
						if (act === 0x12) extra += ' obj=' + u32(d + 22) + ',' + u32(d + 26);
						if (inWin) console.log('t=' + ms.toFixed(0) + 'ms p' + playerId + ' act 0x' + act.toString(16) + ' ' + fourcc(o) + ' flags=0x' + flags.toString(16) + extra);
						d += (act === 0x10) ? 14 : (act === 0x11) ? 22 : (act === 0x12) ? 30 : (act === 0x13) ? 38 : 43;
						break;
					}
					case 0x16: {
						const mode = u8(d);
						const count = u16(d + 1);
						if (inWin) {
							const ids = [];
							for (let i = 0; i < count; i++) ids.push(u32(d + 3 + i * 8) + ',' + u32(d + 7 + i * 8));
							console.log('t=' + ms.toFixed(0) + 'ms p' + playerId + ' SELECT mode=' + mode + ' [' + ids.join(',') + ']');
						}
						d += 3 + count * 8;
						break;
					}
					case 0x17: {
						// assign group hotkey: u8 group, u16 count, pairs (feeder-verified)
						const grp = u8(d);
						const count = u16(d + 1);
						if (inWin) {
							const pairs = [];
							for (let i = 0; i < count; i++) pairs.push(u32(d + 3 + i * 8) + ',' + u32(d + 7 + i * 8));
							console.log('GRP	' + ms + '	' + playerId + '	' + grp + '	' + pairs.join(';'));
						}
						d += 3 + count * 8;
						break;
					}
					case 0x18: {
						// select group hotkey: u8 group, u8 unknown (a REPLACE per the feeder)
						if (inWin) console.log('GKEY	' + ms + '	' + playerId + '	' + u8(d));
						d += 2;
						break;
					}
					case 0x19: d += 12; break;
					case 0x1A: break;
					case 0x1B: case 0x1C: d += 9; break;
					case 0x20: { const chatBytes = u16(d + 1); d += 3 + chatBytes; break; } // chat (measured: id,player,u16 len,len bytes)
					case 0x21: d += 8; break;
					case 0x1D: d += 8; break;
					case 0x1E: case 0x1F: d += 5; break;
					case 0x60: d += 8; { const r = zeroTermStr(d); d = r.next; } break;
					case 0x61: case 0x66: case 0x67: break;
					case 0x62: d += 12; break;
					case 0x63: d += 8; break;
					case 0x64: case 0x65: d += 8; break;
					case 0x68: d += 12; break;
					case 0x69: case 0x6a: case 0x7b: d += 16; break;
					case 0x6b: case 0x6c: case 0x6d: case 0x70: case 0x71: case 0x72: case 0x73: {
						{ const r = zeroTermStr(d); d = r.next; }
						{ const r = zeroTermStr(d); d = r.next; }
						{ const r = zeroTermStr(d); d = r.next; }
						if (act === 0x6b) d += 4; else if (act === 0x6c) d += 4; else if (act === 0x6d) d += 1;
						break;
					}
					case 0x75: d += 1; break;
					case 0x76: d += 10; break;
					case 0x77: { d += 8; const bl = u32(d); d += 4 + bl; break; }
					case 0x78: {
						{ const r = zeroTermStr(d); d = r.next; }
						{ const r = zeroTermStr(d); d = r.next; }
						d += 4;
						break;
					}
					case 0x79: { d += 16; const r = zeroTermStr(d); d = r.next; break; }
					case 0x7a: d += 20; break;
					case 0xa0: d += 14; break;
					case 0xa1: d += 9; break;
					default:
						if (inWin) console.log('t=' + ms.toFixed(0) + 'ms UNKNOWN act 0x' + act.toString(16) + ' at ' + actStart);
						d = actionEnd;
						break;
				}
				if (d > actionEnd) { console.log('OVERSHOOT by ' + (d - actionEnd) + ' at act 0x' + act.toString(16) + ' t=' + ms.toFixed(0)); d = actionEnd; }
			}
		}
	} else if (id === 0x17) break;
	else if (id === 0x1A || id === 0x1B || id === 0x1C) d += 4;
	else if (id === 0x20) {
		// chat, MEASURED layout (xina @35635 byte-for-byte): id(1) player(1)
		// chatBytes u16(2) then chatBytes bytes (flags byte + mode int + string)
		const chatBytes = u16(d + 1);
		d += 3 + chatBytes;
	}
	else if (id === 0x22) d += 1 + u8(d);
	else if (id === 0x23) d += 10;
	else if (id === 0x2F) d += 8;
	else { console.log('UNKNOWN top block 0x' + id.toString(16) + ' at ' + (d - 1) + ' ms=' + ms + ' hex: ' + out.subarray(d - 1, d + 23).toString('hex')); break; }
}
console.log('done, final time ' + ms.toFixed(0) + 'ms');
