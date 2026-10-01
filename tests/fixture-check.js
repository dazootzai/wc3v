// Shared guard for suites whose raw fixture replays were recorded locally or
// pulled from the pro corpus and never committed (the git repo carries only
// happy-vs-grubby.w3g). A missing file exits 0 with a SKIP notice so an
// absent fixture reads as "fixture absent", not as a parser regression.
const fs = require('fs');
const path = require('path');

function requireFixtures (...names) {
  const missing = names.filter(n => !fs.existsSync(path.join(__dirname, '..', 'replays', `${n}.w3g`)));
  if (missing.length) {
    console.log('=== TEST SKIPPED (fixtures absent) ===');
    console.log('This suite parses raw fixture replays that are not in replays/ and were never committed to git:');
    missing.forEach(n => console.log(`  - replays/${n}.w3g`));
    console.log('Restore them (pro-corpus raws live wherever the corpus was fetched; the suite is otherwise unrunnable), re-run to execute.');
    process.exit(0);
  }
}

module.exports = { requireFixtures };
