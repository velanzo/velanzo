// The QR codes Velanzo prints for vouchers: every text we make must read back exactly (decoded with the jsQR reader).
// Run: node tools/test-qr.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const QR = require('../web/js/qr.js');
const jsQR = require('jsqr');

let checks = 0;
function read(text, scale = 4) {
  const q = QR.build(text), quiet = 4, N = q.size + quiet * 2, W = N * scale;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) {
    if (!q.modules[y][x]) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + quiet) * scale + dy) * W + (x + quiet) * scale + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  const r = jsQR(px, W, W);
  return r && r.data;
}
const same = (text) => { assert.equal(read(text), text, 'QR for ' + JSON.stringify(text)); checks++; };

// voucher codes, as made by the app
const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
for (let i = 0; i < 200; i++) {
  let s = ''; for (let k = 0; k < 8; k++) s += A[rnd(A.length)];
  same(`VZ-${s.slice(0, 4)}-${s.slice(4)}`);
}
// every length from 1 to 150 characters: versions 1 to 10, all block layouts
for (let n = 1; n <= 150; n++) same('x'.repeat(n).replace(/x/g, (_, i) => String.fromCharCode(33 + ((i * 7 + n) % 90))));
same('Velanzo é ü ₹ 100');
same('DIWALI-10');
// the printed picture
const svg = QR.svg('VZ-ABCD-EFGH', { moduleMm: 0.75 });
assert.ok(/^<svg/.test(svg) && /width="\d+\.\d+mm"/.test(svg) && /<path d="M/.test(svg)); checks++;
assert.throws(() => QR.build('x'.repeat(400)), /too long/); checks++;
console.log(`All ${checks} QR checks passed.`);
