/*
  Build client/assets/wc3icons/<rawID>.jpg for units, buildings, heroes,
  abilities, and items (looked up via the *skin.txt Art= field), plus
  client/assets/wc3icons/<btnName>.jpg for upgrades (already resolved into
  researchMeta.json by parse-upgrade-data.js).

  Source DDS textures must already be extracted into
  tools/map-data/icons-raw/replaceabletextures/commandbuttons(disabled)/
  (see bulk_extract.js run against the CASC storage).

  Usage: node tools/convert-command-icons.js
*/
const fs = require('fs');
const path = require('path');
const { createCanvas, ImageData } = require('canvas');
const { decodeDds } = require('./convert-terrain-dds');
const { parseSLK } = require('../helpers/slkParser');

const ICONS_RAW = path.join(__dirname, 'map-data', 'icons-raw', 'replaceabletextures');
const UNITMETA = path.join(__dirname, 'map-data', 'unitmeta');
const OUT_DIR = path.join(__dirname, '..', 'client', 'assets', 'wc3icons');
const RESEARCH_META = path.join(__dirname, '..', 'helpers', 'researchMeta.json');

function parseSkinFile (text) {
  // [ID]\n...\nArt=ReplaceableTextures\CommandButtons\BtnFoo.blp\n...
  const map = {};
  let currentId = null;
  for (const line of text.split(/\r?\n/)) {
    const sec = line.match(/^\[(\w+)\]/);
    if (sec) { currentId = sec[1]; continue; }
    if (!currentId) continue;
    const art = line.match(/^Art\s*=\s*(.+)$/i);
    if (art && !map[currentId]) {
      const base = art[1].trim().split(/[\\/]/).pop().replace(/\.(blp|dds|tga)$/i, '');
      map[currentId] = base.toLowerCase();
    }
  }
  return map;
}

function findDdsFile (btnBase) {
  const candidates = [
    path.join(ICONS_RAW, 'commandbuttons', btnBase + '.dds'),
    path.join(ICONS_RAW, 'commandbuttonsdisabled', btnBase + '.dds'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function convertOne (btnBase, outName, stats) {
  const outPath = path.join(OUT_DIR, outName + '.jpg');
  if (fs.existsSync(outPath)) { stats.skipped++; return; }
  const ddsPath = findDdsFile(btnBase);
  if (!ddsPath) { stats.missing++; return; }
  try {
    const buf = fs.readFileSync(ddsPath);
    const { width, height, rgba } = decodeDds(buf);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
    fs.writeFileSync(outPath, canvas.toBuffer('image/jpeg', { quality: 0.9 }));
    stats.converted++;
  } catch (err) {
    stats.failed++;
    if (stats.failed <= 10) console.log(`  FAIL ${outName} (${btnBase}): ${err.message}`);
  }
}

function main () {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const unitSkin = parseSkinFile(fs.readFileSync(path.join(UNITMETA, 'unitskin.txt'), 'utf8'));
  const abilitySkin = parseSkinFile(fs.readFileSync(path.join(UNITMETA, 'abilityskin.txt'), 'utf8'));

  // itemskin.txt carries no Art= field — items borrow their "use" ability's
  // icon instead, via itemdata.slk's abilList column.
  const itemData = parseSLK(path.join(UNITMETA, 'itemdata.slk'));
  const itemSkin = {};
  for (const row of itemData.rows) {
    const firstAbil = (row.abilList || '').split(',')[0].trim();
    if (row.itemID && firstAbil && abilitySkin[firstAbil]) {
      itemSkin[row.itemID] = abilitySkin[firstAbil];
    }
  }

  console.log(`unitskin: ${Object.keys(unitSkin).length} ids, abilityskin: ${Object.keys(abilitySkin).length} ids, itemskin (via abilList): ${Object.keys(itemSkin).length} ids`);

  const stats = { converted: 0, missing: 0, failed: 0, skipped: 0 };

  for (const [id, btn] of Object.entries(unitSkin)) convertOne(btn, id, stats);
  for (const [id, btn] of Object.entries(abilitySkin)) convertOne(btn, id, stats);
  for (const [id, btn] of Object.entries(itemSkin)) convertOne(btn, id, stats);

  // Upgrades: researchMeta.json already stores btn-names directly as the
  // lookup key the client uses, so source == destination name.
  if (fs.existsSync(RESEARCH_META)) {
    const research = JSON.parse(fs.readFileSync(RESEARCH_META, 'utf8'));
    const btnNames = new Set();
    for (const entry of Object.values(research)) {
      for (const icon of (entry.icons || [])) btnNames.add(icon);
    }
    console.log(`researchMeta upgrade icons: ${btnNames.size}`);
    for (const btn of btnNames) convertOne(btn, btn, stats);
  }

  console.log(`\nDONE converted=${stats.converted} skipped(existing)=${stats.skipped} missing=${stats.missing} failed=${stats.failed}`);
}

main();
