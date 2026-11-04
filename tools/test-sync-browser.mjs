// In a real (headless) browser, as the owner: confirming a saved draft does not warn about its own invoice, a draft shows
// the planned sale price, changes from another computer are offered without disturbing the page, and this computer's own
// work does not count as such. Needs the preview with demo data (npm run dev + node tools/demo-data.mjs):
//   node --disable-warning=ExperimentalWarning tools/test-sync-browser.mjs
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
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const go = async (h) => { location.hash = h; await sleep(900); };`;
const dir = path.join(os.tmpdir(), 'velanzo-test-syncb');
fs.rmSync(dir, { recursive: true, force: true });
const b = await openBrowser({ profile: dir, width: 1280, height: 900 });
const run = (code) => b.page.js(H + code);
try {
  await b.page.goto(demo.base + '/', 1500);
  await run(`await until(() => document.querySelector('#cOwner'), 30000); click('#cOwner'); await sleep(200);
    set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]');
    await until(() => document.querySelector('#shell')); await sleep(1500);`);

  // ---- a draft with a supplier's invoice number, then Confirm ----
  const ids = await run(`const sup = await POST('/api/suppliers', { name: 'Invoice test ' + Date.now() });
    await ProductCache.load(${demo.warehouse_location}, true); const p = ProductCache.list.filter((x) => x.sale_price > 0)[0];
    const r = await POST('/api/purchases', { supplier_id: sup.id, location_id: ${demo.warehouse_location}, invoice_no: 'INV-' + Date.now(), draft: true, items: [{ product_id: p.id, qty: 2, cost: Math.round(p.sale_price / 2), sale_price: p.sale_price + 111 }] });
    return { id: r.id, planned: p.sale_price + 111 };`);
  await run(`await go('#/purchases/${ids.id}'); await until(() => document.querySelector('#confirmBtn'));`);
  ok(await run(`return /sale price/i.test(document.querySelector('.tbl').innerText) && !/sale price now/i.test(document.querySelector('.tbl').innerText) && document.querySelector('.tbl').innerText.replace(/,/g, '').includes('${ids.planned}');`), 'a draft shows the sale price typed on it');
  await run(`click('#confirmBtn'); await sleep(1500);`);
  ok(await run(`return !document.querySelector('#wGo') && !/already entered/.test(document.body.innerText);`), 'confirming the draft does not warn about its own invoice');
  await run(`await until(() => /placed/.test(location.hash));`);
  ok(await run(`return document.querySelector('.flow span.on')?.textContent.trim() === 'Confirmed';`), 'it is confirmed');

  // ---- changes from another computer ----
  await run(`await go('#/stock'); await until(() => document.querySelector('#list [data-sel], #list table')); set('#q', 'kurta'); await sleep(500);`);
  await run(`await remoteChanged(['products']); await sleep(100);`);
  ok(await run(`return !!document.querySelector('#freshBar') && document.querySelector('#q').value === 'kurta';`), 'on Stock: a bar offers the changes, the search stays');
  await run(`click('#freshBar button'); await sleep(900);`);
  ok(await run(`return !document.querySelector('#freshBar');`), 'pressing it shows them');
  await run(`await go('#/purchases/${ids.id}'); await until(() => document.querySelector('.flow')); window.__el = document.querySelector('#view'); await remoteChanged(['purchases']); await sleep(600);`);
  ok(await run(`return document.querySelector('#view') !== window.__el && !document.querySelector('#freshBar');`), 'on an order: it redraws by itself');
  await run(`await go('#/purchases/new'); await until(() => document.querySelector('#scan')); window.__el = document.querySelector('#view'); await remoteChanged(['products']); await sleep(300);`);
  ok(await run(`return document.querySelector('#view') === window.__el && !document.querySelector('#freshBar');`), 'on a form being filled: nothing is disturbed');
  await run(`await remoteChanged(['settings']); await sleep(300);`);
  ok(await run(`return document.querySelectorAll('#nav a').length > 3;`), 'a change to settings or shops refreshes the menu');

  // ---- this computer's own work is not "from another computer" ----
  await run(`await go('#/stock'); await until(() => document.querySelector('#list table')); const p = ProductCache.list.find((x) => x.sale_price > 0);
    await POST('/api/expenses', { amount: 12, category: 'Tea', location_id: ${demo.shop_location} });
    await Cloud.syncNow(); await sleep(500); await Cloud.syncNow(); await sleep(300);`);
  ok(await run(`return !document.querySelector('#freshBar');`), "this computer's own save does not show the bar");
  ok(await run(`return document.querySelector('#syncPill').textContent.trim() === 'All saved online';`), 'the status says All saved online');

  // ---- what the status says when something is wrong ----
  await run(`Cloud.status().problem = { short: 'Not up to date', text: 'test reason' }; paintSync();`);
  ok(await run(`return document.querySelector('#syncPill').textContent.trim() === 'Not up to date' && document.querySelector('#syncPill').title === 'test reason';`), 'a problem shows with its reason');
  await run(`await Cloud.syncNow(); await until(() => !/Saving|waiting/.test(document.querySelector('#syncPill').textContent));`);
  const after = await run(`return document.querySelector('#syncPill').textContent.trim() + ' / ' + JSON.stringify(Cloud.status().problem);`);
  ok(after.startsWith('All saved online'), 'and clears by itself when syncing works again: ' + after);

  // ---- Download everything again keeps the person logged in ----
  await run(`await go('#/device'); await until(() => document.querySelector('#redlBtn')); click('#redlBtn'); await sleep(3000);`);
  ok(await run(`return !!document.querySelector('#shell') && !document.querySelector('.pin-pad') && !!document.querySelector('#redlBtn');`), 'Download everything again: still working, nobody is logged out');
  ok((await run(`return (await GET('/api/purchases/${ids.id}')).status;`)) === 'ordered', 'and the data is all there');
  console.log(`\nAll ${checks} sync screen checks passed.`);
} finally { await b.close(); }
process.exit(0);
