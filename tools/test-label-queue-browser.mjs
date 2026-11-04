// In a real (headless) browser, as the owner: tick items on the Stock page, add them to barcode printing, and change
// their quantities (typing and with + and −) on the Barcodes page. Needs the preview with demo data:
//   node --disable-warning=ExperimentalWarning tools/test-label-queue-browser.mjs [--shots DIR]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './shot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev-cloud', 'demo.json'), 'utf8'));
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };
const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = typeof s === 'string' ? document.querySelector(s) : s; if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const go = async (h) => { location.hash = h; await sleep(900); };`;
const dir = path.join(os.tmpdir(), 'velanzo-test-labelq');
fs.rmSync(dir, { recursive: true, force: true });
const b = await openBrowser({ profile: dir, width: 1280, height: 900 });
const p = b.page;
const run = (code) => p.js(H + code);
try {
  await p.goto(demo.base + '/', 1500);
  await run(`await until(() => document.querySelector('#cOwner'), 30000); click('#cOwner'); await sleep(200);
    set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]');
    await until(() => document.querySelector('#shell')); await sleep(1200); localStorage.removeItem('vz_labels');`);
  await run(`await go('#/stock'); await until(() => document.querySelectorAll('#list [data-sel]').length >= 3);`);
  ok(await run(`return document.querySelector('#addLbl').classList.contains('hidden');`), 'the button is hidden until something is ticked');
  const picked = await run(`const boxes = [...document.querySelectorAll('#list [data-sel]')].slice(0, 3); boxes.forEach((c) => c.click()); await sleep(200);
    return { n: boxes.length, text: document.querySelector('#addLbl').textContent.trim(), names: boxes.map((c) => c.closest('tr').querySelector('b').textContent) };`);
  ok(/Add 3 to barcode printing/.test(picked.text), 'ticking three items shows "' + picked.text + '"');
  if (SHOTS) await p.shot(path.join(SHOTS, 'stock-select.png'));
  // a click on a tick box must not open the item page
  ok(await run(`return location.hash === '#/stock';`), 'ticking does not open the item');
  await run(`click('#addLbl'); await sleep(400);`);
  ok(await run(`return JSON.parse(localStorage.vz_labels).length === 3 && document.querySelector('#addLbl').classList.contains('hidden') && !document.querySelector('#list [data-sel]:checked');`), 'the three items are in the barcode list and the ticks are cleared');
  // the menu entry opens the list
  await run(`click('a[data-nav="labels"]'); await until(() => document.querySelector('#qList [data-c]'));`);
  ok(await run(`const stock = (await GET('/api/stock', {})).rows; return [...document.querySelectorAll('#qList [data-c]')].length === 3 && JSON.parse(localStorage.vz_labels).every((x) => x.copies === stock.find((r) => r.id === x.product.id).total);`), 'the Barcodes page lists the three items, one sticker per piece in stock');
  await run(`set('#qList [data-c="0"]', '1'); await sleep(100); set('#qList [data-c="2"]', '1'); await sleep(100); click('#qList [data-inc="0"]'); click('#qList [data-inc="0"]'); await sleep(200);`);
  ok(await run(`return document.querySelector('#qList [data-c="0"]').value === '3';`), '+ twice makes 3');
  await run(`click('#qList [data-dec="0"]'); await sleep(200);`);
  ok(await run(`return document.querySelector('#qList [data-c="0"]').value === '2';`), '− makes 2');
  await run(`set('#qList [data-c="1"]', '25'); await sleep(200);`);
  ok(await run(`return document.querySelector('#qList [data-c="1"]').value === '25' && /Print 28 labels/.test(document.querySelector('#printBtn').textContent);`), 'typing 25 in a box works; the print button counts 28 labels');
  if (SHOTS) await p.shot(path.join(SHOTS, 'barcodes-list.png'));
  // adding the same item again from Stock sets its line back to the stock count
  await run(`await go('#/stock'); await until(() => document.querySelectorAll('#list [data-sel]').length >= 1); document.querySelector('#list [data-sel]').click(); click('#addLbl'); await sleep(300);`);
  ok(await run(`const q = JSON.parse(localStorage.vz_labels), stock = (await GET('/api/stock', {})).rows; return q.length === 3 && q[0].copies === stock.find((r) => r.id === q[0].product.id).total;`), 'the same item again takes the stock count, no duplicate line');
  // select all, and the removed test button
  await run(`await go('#/stock'); await until(() => document.querySelector('#selAll')); click('#selAll'); await sleep(200);`);
  ok(await run(`const n = document.querySelectorAll('#list [data-sel]').length; return n > 3 && document.querySelector('#addLbl').textContent.includes('Add ' + n + ' to');`), 'the header box selects every item shown');
  await run(`await go('#/labels'); await until(() => document.querySelector('#printBtn'));`);
  ok(await run(`return !document.querySelector('#one') && !/1 of each/.test(document.body.innerText);`), 'there is no "Print 1 of each" button any more');
  console.log(`\nAll ${checks} barcode list checks passed.`);
} finally { await b.close(); }
process.exit(0);
