#!/usr/bin/env node
/*
  One-time (well, "run whenever needed") pass: generate an AI summary for
  every replay in ../wc3v-deploy/replays/*.wc3v that doesn't have one yet in
  my-replays.html's REPLAYS array, and write it in as a `summary` field.

  Usage: ANTHROPIC_API_KEY=... node tools/backfill-summaries.js
*/
const fs = require('fs');
const path = require('path');
const { generateSummary } = require('./generate-summary');

const DEPLOY_DIR = path.join(__dirname, '..', '..', 'wc3v-deploy');
const HTML_PATH = path.join(DEPLOY_DIR, 'my-replays.html');

async function main () {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const files = fs.readdirSync(path.join(DEPLOY_DIR, 'replays')).filter((f) => f.endsWith('.wc3v'));

  let updated = html;
  for (const f of files) {
    const file = f.replace(/\.wc3v$/, '');
    const lineRe = new RegExp(`\\{ file: '${file}'[^}]*\\}`);
    const m = updated.match(lineRe);
    if (!m) { console.log(`skip ${file}: not in REPLAYS array`); continue; }
    if (/summary:/.test(m[0])) { console.log(`skip ${file}: already has a summary`); continue; }

    console.log(`generating: ${file}...`);
    const data = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, 'replays', f), 'utf8'));
    let text;
    try {
      text = await generateSummary(data);
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      continue;
    }
    const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const withSummary = m[0].replace(/\}$/, `, summary: '${escaped}' }`);
    updated = updated.replace(m[0], withSummary);
    console.log(`  done (${text.length} chars)`);
  }

  fs.writeFileSync(HTML_PATH, updated);
  console.log('\nWrote my-replays.html. Next: cp my-replays.html index.html && npx wrangler deploy');
}

main().catch((e) => { console.error(e); process.exit(1); });
