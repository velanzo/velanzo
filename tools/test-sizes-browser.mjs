// In a real (headless) browser, as the owner: one item in kids sizes 1-2Y to 9-10Y with two prices (a price per size
// when adding it), then changing the price of several sizes at once on the Items page.
// Needs the preview with demo data (npm run dev + node tools/demo-data.mjs):
//   node --disable-warning=ExperimentalWarning tools/test-sizes-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './shot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev-cloud', 'demo.json'), 'utf8'));
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };
const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = typeof s === 'string' ? document.querySelector(s) : s; if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };`;
const dir = path.join(os.tmpdir(), 'velanzo-test-sizes');
fs.rmSync(dir, { recursive: true, force: true });
const b = await openBrowser({ profile: dir, width: 1280, height: 900 });
const run = (code) => b.page.js(H + code);
try {
  await b.page.goto(demo.base + '/', 1500);
  await run(`await until(() => document.querySelector('#cOwner')); click('#cOwner'); await sleep(200);
    set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]'); await until(() => document.querySelector('#shell')); await sleep(1000);`);
  const name = 'Kids shirt ' + Date.now();
  await run(`location.hash = '#/products'; await until(() => document.querySelector('#addBtn')); click('#addBtn'); await until(() => document.querySelector('#allKids'));
    set('.modal-wrap [name=name]', ${JSON.stringify(name)}); set('.modal-wrap [name=sale_price]', '1500'); click('#allKids'); await sleep(300);`);
  const rows = await run(`return [...document.querySelectorAll('.modal-wrap tr[data-key]')].map((r) => r.dataset.key.split('|')[0]);`);
  ok(rows.join() === '1-2Y,2-3Y,3-4Y,4-5Y,5-6Y,6-7Y,7-8Y,8-9Y,9-10Y', '"All kids sizes" adds 1-2Y to 9-10Y: ' + rows.join(', '));
  ok(await run(`return !document.querySelector('.modal-wrap tr[data-key] [data-f=sale_price]') && document.querySelector('#saleBox').style.display !== 'none' && !document.querySelector('.modal-wrap [name=sizes]').value.includes('XS');`),
    'same price for all sizes (the start): one sale price, no price per size; no size chosen by itself');
  await run(`click('[data-pm=each]'); await sleep(200);`);
  ok(await run(`return document.querySelector('#saleBox').style.display === 'none' && document.querySelectorAll('.modal-wrap tr[data-key] [data-f=sale_price]').length === 9;`), '"A different price for each size": a price box on every size, none above');
  await run(`click('.modal-wrap #apSave'); await sleep(800);`);
  ok(await run(`return /Type the sale price of/.test(document.body.innerText) && !!document.querySelector('.modal-wrap #apSave');`), 'it will not save while a size has no price');
  // the cost is not known for this stock
  await run(`const ck = document.querySelector('.modal-wrap [name=cost_known]'); ck.checked = false; ck.dispatchEvent(new Event('change', { bubbles: true })); await sleep(100);`);
  ok(await run(`return document.querySelector('.modal-wrap [name=cost_price]').style.display === 'none';`), '"I know the cost price" off: the cost box goes away');
  await run(`for (const r of document.querySelectorAll('.modal-wrap tr[data-key]')) set(r.querySelector('[data-f=sale_price]'), ['5-6Y', '6-7Y', '7-8Y', '8-9Y', '9-10Y'].includes(r.dataset.key.split('|')[0]) ? '1900' : '1500');
    click('.modal-wrap #apSave'); await sleep(1500); if (document.querySelector('#wGo')) { click('#wGo'); await sleep(1200); } if (document.querySelector('#cOk')) { click('#cOk'); await sleep(800); }`);
  const made = await run(`return (await GET('/api/products', { q: ${JSON.stringify(name)}, all: 1 })).map((p) => p.size + '=' + p.sale_price).sort().join();`);
  ok(made === '1-2Y=1500,2-3Y=1500,3-4Y=1500,4-5Y=1500,5-6Y=1900,6-7Y=1900,7-8Y=1900,8-9Y=1900,9-10Y=1900', 'one item, two prices: ' + made);
  ok(await run(`return (await GET('/api/products', { q: ${JSON.stringify(name)}, all: 1 })).every((p) => p.cost_price === null);`), 'the cost is left empty (unknown), not 0');

  // edit an item: its stock can be changed right there
  const one = await run(`return (await GET('/api/products', { q: ${JSON.stringify(name)}, all: 1 }))[0].id;`);
  await run(`location.hash = '#/products/${one}'; await until(() => document.querySelector('#editBtn')); click('#editBtn');
    await until(() => document.querySelector('.modal-wrap [data-stock]'));
    set('.modal-wrap [data-stock="${demo.warehouse_location}"]', '7'); click('#epSave'); await sleep(1500); if (document.querySelector('#wGo')) { click('#wGo'); await sleep(1500); }`);
  const qty = await run(`return (await GET('/api/products/${one}')).stock.find((s) => s.location_id === ${demo.warehouse_location}).qty;`);
  ok(qty === 7, 'editing the item sets its stock at the warehouse to 7 (noted in the stock history)');

  // change the price of 1-2Y to 4-5Y at once
  await run(`location.hash = '#/stock'; await sleep(300); location.hash = '#/products'; await until(() => document.querySelector('#q')); set('#q', ${JSON.stringify(name)}); await sleep(1200);
    for (const r of document.querySelectorAll('#list tr[data-id]')) if (r.children[1].textContent.includes(${JSON.stringify(name)}) && ['1-2Y', '2-3Y', '3-4Y', '4-5Y'].includes(r.children[2].textContent.trim())) r.querySelector('[data-sel]').click();
    await sleep(200);`);
  const btn = await run(`return (document.querySelector('#priceBtn')?.textContent || 'no button') + ' | ' + document.querySelectorAll('#list tr[data-id]').length + ' rows | ' + [...document.querySelectorAll('#list tr[data-id]')].slice(0, 3).map((r) => r.children[2].textContent).join(',');`);
  ok(/Change price \(4\)/.test(btn), 'tick four sizes: ' + btn);
  await run(`click('#priceBtn'); await until(() => document.querySelector('.modal-wrap input')); set('#pIn', '1550'); click('#pOk'); await sleep(2000);`);
  const after = await run(`return (await GET('/api/products', { q: ${JSON.stringify(name)}, all: 1 })).map((p) => p.size + '=' + p.sale_price).sort().join();`);
  ok(after === '1-2Y=1550,2-3Y=1550,3-4Y=1550,4-5Y=1550,5-6Y=1900,6-7Y=1900,7-8Y=1900,8-9Y=1900,9-10Y=1900', 'only those four changed: ' + after);
  console.log(`\nAll ${checks} size and price checks passed.`);
} finally { await b.close(); }
process.exit(0);
