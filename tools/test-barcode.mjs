// The barcodes Velanzo prints are correct Code 128: the pattern table is the standard one, every code reads back
// exactly (with its check digit), and the sizes chosen for bills and labels use whole printer dots.
// Run: node tools/test-barcode.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Barcode = require('../web/js/barcode.js');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ---- the pattern table (ISO/IEC 15417) ----
const P = Barcode.PATTERNS;
ok(P.length === 107, '107 patterns (0–105 and stop)');
ok(P.slice(0, 106).every((p) => p.length === 6 && [...p].reduce((a, w) => a + +w, 0) === 11), 'every symbol is 3 bars + 3 spaces, 11 modules');
ok(P[106] === '2331112', 'stop is 2331112 (13 modules)');
ok(new Set(P).size === 107, 'all patterns are different');
// a few values everyone can check against the published table
ok(P[0] === '212222' && P[1] === '222122' && P[16] === '123122' && P[100] === '114131' && P[103] === '211412' && P[104] === '211214' && P[105] === '211232', 'known values match the standard table');
// bars in a symbol are 1–4 modules wide
ok(P.every((p) => [...p].every((w) => w >= 1 && w <= 4)), 'bar widths 1–4 modules');

// ---- read a barcode back, the way a scanner does ----
function decode(widths) {
  const syms = [];
  let i = 0;
  while (i < widths.length) {
    const len = widths.length - i === 7 ? 7 : 6;
    const v = P.indexOf(widths.slice(i, i + len));
    if (v < 0) throw new Error('unknown symbol at ' + i);
    syms.push(v);
    i += len;
  }
  const stop = syms.pop();
  const check = syms.pop();
  assert.equal(stop, 106, 'ends with stop');
  let sum = syms[0];
  for (let k = 1; k < syms.length; k++) sum += syms[k] * k;
  assert.equal(sum % 103, check, 'check digit');
  let set = { 103: 'A', 104: 'B', 105: 'C' }[syms[0]], out = '';
  for (const v of syms.slice(1)) {
    if (set === 'C') { if (v === 100) set = 'B'; else out += String(v).padStart(2, '0'); }
    else out += String.fromCharCode(v + 32);
  }
  return out;
}
const samples = ['20100015', '20400001', '2010001', '8964000123457', '012345678905', '123456789012', 'S1-E0001', 'D-A0012', 'P-D0001', 'WH-B0099', 'abc-XYZ_09', '7'];
for (const t of samples) ok(decode(Barcode.encode(t)) === t, `“${t}” reads back exactly`);
// every 8-digit shop code from one device
for (let n = 0; n < 2000; n++) { const t = String(20100000 + n * 37); ok(decode(Barcode.encode(t)) === t, 'shop code ' + t); }

// ---- sizes: whole printer dots (8 dots per mm) ----
const fit = (t, w) => Barcode.fit(t, w);
ok(fit('20100015', 47) === 0.375, '8-digit code on a 50 mm label: 0.375 mm modules (3 dots)');
ok(fit('8964000123457', 47) === 0.25, '13-digit code on a 50 mm label: 0.25 mm modules (2 dots)');
ok(fit('20100015', 35) === 0.25, '8-digit code on a 38 mm label: 0.25 mm (2 dots)');
ok(fit('S1-E0001', 72) === 0.5 && fit('S1-E0001', 48) === 0.25, 'bill number: 4 dots on 80 mm paper, 2 dots on 58 mm paper');
ok([0.5, 0.375, 0.25].every((m) => Number.isInteger(m * 8)), 'each module size is a whole number of dots at 203 dpi');
const svg = Barcode.svg('20100015', { moduleMm: 0.375 });
ok(/width:37\.125mm/.test(svg) && /crispEdges/.test(svg), 'the SVG is drawn at exactly 37.125 mm (99 modules × 0.375 mm), with sharp edges');
console.log(`All ${checks} barcode checks passed.`);
