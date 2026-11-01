// The driver files shipped in web/drivers match the SHA-256 codes shown on the Hardware page.
// Run: node tools/test-drivers.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const src = fs.readFileSync(new URL('../web/js/views/hardware.js', import.meta.url), 'utf8');
const rows = [...src.matchAll(/href: '(drivers\/[^']+)'[^]*?sha: '([0-9a-f]{64})'/g)];
assert.equal(rows.length, 2, 'two drivers listed');
for (const [, href, sha] of rows) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(new URL('../web/' + href, import.meta.url))).digest('hex');
  assert.equal(got, sha, href + ' matches its SHA-256');
  console.log('  ✓ ' + href);
}
console.log('All driver files match.');
