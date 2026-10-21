// In a real (headless) browser, as the owner: a purchase order saved as a draft, changed, confirmed, reset to draft,
// received, and reset again (the pieces leave stock); a dispatch saved as a draft, sent and reset; a bill held at
// the sale screen and opened again; a finished bill reset to draft (it opens in the sale screen).
// Needs the preview with demo data (npm run dev + node tools/demo-data.mjs):
//   node --disable-warning=ExperimentalWarning tools/test-drafts-browser.mjs [--shots DIR]
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
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const scan = (code) => { const s = document.querySelector('#scan'); s.focus(); s.value = code; s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
  const go = async (h) => { location.hash = h; await sleep(900); };
  // a "Please check this" or "Are you sure" box: answer it
  const answer = async () => { await sleep(700); if (document.querySelector('#wGo')) { click('#wGo'); await sleep(500); } if (document.querySelector('#cOk')) { click('#cOk'); await sleep(500); } };
  const flow = () => document.querySelector('.flow span.on')?.textContent.trim();`;

const dir = path.join(os.tmpdir(), 'velanzo-test-drafts');
fs.rmSync(dir, { recursive: true, force: true });
const b = await openBrowser({ profile: dir, width: 1280, height: 900 });
const p = b.page;
const run = (code) => p.js(H + code);
try {
  await p.goto(demo.base + '/', 1500);
  await run(`await until(() => document.querySelector('#cOwner'), 30000); click('#cOwner'); await sleep(200);
    set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]');
    await until(() => document.querySelector('#shell')); await sleep(1200);`);
  const item = await run(`await ProductCache.load(${demo.warehouse_location}, true); const x = ProductCache.list.filter((q) => q.loc_qty > 1 && q.sale_price > 0).sort((a, c) => c.loc_qty - a.loc_qty)[0]; return { id: x.id, barcode: x.barcode, name: x.name };`);
  const stockAt = (loc) => run(`return (await GET('/api/products/${item.id}')).stock.find((s) => s.location_id === ${loc})?.qty ?? 0;`);
  const wh0 = await stockAt(demo.warehouse_location);

  // ---- purchase order: draft → change → confirm → reset → confirm → receive → owner resets ----
  await run(`await go('#/purchases/new?order=1'); await until(() => document.querySelector('#draftBtn')); set('#loc', '${demo.warehouse_location}'); await sleep(300);
    scan(${JSON.stringify(item.barcode)}); await until(() => document.querySelector('#lines [data-f=qty]')); set('#lines [data-f=qty]', '4');
    click('#draftBtn'); await until(() => /purchases\\/\\d+\\?drafted/.test(location.hash) && document.querySelector('.flow'));`);
  const poId = await run(`return Number(location.hash.match(/purchases\\/(\\d+)/)[1]);`);
  ok(await run(`return flow() === 'Draft' && /Draft saved/.test(document.body.innerText) && !!document.querySelector('#confirmBtn') && !!document.querySelector('#pageActions a[href$="/edit"]');`), 'Save draft: the flow bar shows Draft, with Edit and Confirm order');
  if (SHOTS) await p.shot(path.join(SHOTS, 'draft-po.png'));
  ok(await stockAt(demo.warehouse_location) === wh0, 'a draft order changes no stock');
  await run(`click('#pageActions a[href$="/edit"]'); await until(() => document.querySelector('#lines [data-f=qty]')); set('#lines [data-f=qty]', '6'); click('#draftBtn');
    await until(() => /drafted/.test(location.hash) && document.querySelector('.flow')); await sleep(300);`);
  ok((await run(`return (await GET('/api/purchases/${poId}')).total_qty;`)) === 6, 'Edit the draft: 6 pieces now');
  await run(`click('#confirmBtn'); await answer(); await until(() => /placed/.test(location.hash) && flow() === 'Confirmed');`);
  ok(true, 'Confirm order: the flow bar moves to Confirmed');
  await run(`click('#resetBtn'); await answer(); await until(() => flow() === 'Draft');`);
  ok(await run(`return !!document.querySelector('#confirmBtn');`), 'Reset to draft: back to Draft, it can be changed again');
  await run(`click('#confirmBtn'); await answer(); await until(() => flow() === 'Confirmed');
    await go('#/purchases/${poId}/receive'); await until(() => document.querySelector('#okBtn')); click('#okBtn'); await answer();
    await until(() => /arrived/.test(location.hash) && flow() === 'Received');`);
  ok(await stockAt(demo.warehouse_location) === wh0 + 6, 'Received: the flow bar shows Received and 6 pieces are in stock');
  if (SHOTS) await p.shot(path.join(SHOTS, 'received-po.png'));
  await run(`click('#resetBtn'); await until(() => document.querySelector('#cOk')); click('#cOk'); await until(() => flow() === 'Draft');`);
  ok(await stockAt(demo.warehouse_location) === wh0, 'the owner resets the received order: the 6 pieces leave stock, it is a draft again');

  // ---- dispatch: draft → send → reset ----
  await run(`await go('#/dispatch/new'); await until(() => document.querySelector('#draftBtn')); set('#from', '${demo.warehouse_location}'); await sleep(600);
    set('#to', '${demo.shop_location}'); scan(${JSON.stringify(item.barcode)}); await until(() => document.querySelector('#lines [data-q]'));
    click('#draftBtn'); await until(() => /dispatch\\/\\d+\\?drafted/.test(location.hash) && document.querySelector('.flow'));`);
  ok(await run(`return flow() === 'Draft' && !!document.querySelector('#sendBtn');`) && await stockAt(demo.warehouse_location) === wh0, 'Save draft parcel: Draft, nothing left the warehouse');
  await run(`click('#sendBtn'); await answer(); await until(() => /new=1/.test(location.hash) && flow() === 'On the way');`);
  ok(await stockAt(demo.warehouse_location) === wh0 - 1, 'Send now: On the way, 1 piece left the warehouse');
  await run(`click('#resetBtn'); await until(() => document.querySelector('#cOk')); click('#cOk'); await until(() => flow() === 'Draft');`);
  ok(await stockAt(demo.warehouse_location) === wh0, 'Reset to draft: the piece is back in the warehouse');
  if (SHOTS) await p.shot(path.join(SHOTS, 'draft-dispatch.png'));

  // ---- hold a bill ----
  const shopItems = await run(`await ProductCache.load(${demo.shop_location}, true); return ProductCache.list.filter((q) => q.loc_qty > 2).slice(0, 2).map((q) => ({ id: q.id, barcode: q.barcode, name: q.name }));`);
  await run(`localStorage.setItem('vz_pos_loc', '${demo.shop_location}'); await go('#/pos'); await until(() => document.querySelector('#scan')); await sleep(500);
    scan(${JSON.stringify(shopItems[0].barcode)}); await until(() => document.querySelector('.cart-row')); click('#holdBtn'); await sleep(400);`);
  ok(await run(`return !document.querySelector('.cart-row') && document.querySelector('#heldN').textContent === '1' && !document.querySelector('#heldBtn').classList.contains('hidden');`), 'Hold bill: the screen is free for the next customer, “Held bills (1)”');
  await run(`scan(${JSON.stringify(shopItems[1].barcode)}); await until(() => document.querySelector('.cart-row')); click('#heldBtn'); await until(() => document.querySelector('[data-open]'));`);
  if (SHOTS) await p.shot(path.join(SHOTS, 'held-bills.png'));
  await run(`click('[data-open]'); await sleep(500);`);
  ok(await run(`return document.querySelector('.cart-row .iname').textContent.includes(${JSON.stringify(shopItems[0].name)}) && document.querySelector('#heldN').textContent === '1';`), 'Open: the held bill is back, and the bill that was on the screen is held instead');
  await run(`HeldBills.save([]); click('#clearBtn'); await sleep(300); if (document.querySelector('#cOk')) click('#cOk'); await sleep(300);`);

  // ---- the owner resets a finished bill ----
  const bill = await run(`return await POST('/api/sales', { location_id: ${demo.shop_location}, items: [{ product_id: ${shopItems[1].id}, qty: 2 }] });`);
  await run(`await go('#/sales'); await sleep(300); showBill(${bill.id}); await until(() => document.querySelector('#bReset')); click('#bReset'); await until(() => document.querySelector('#cOk')); click('#cOk');
    await until(() => location.hash === '#/pos' && document.querySelector('.cart-row')); await sleep(400);`);
  ok(await run(`return document.querySelector('.cart-row .iname').textContent.includes(${JSON.stringify(shopItems[1].name)}) && document.querySelector('.cart-row [data-qty]').value === '2';`), 'Reset bill to draft: it opens in the sale screen with its 2 pieces');
  ok((await run(`return (await GET('/api/sales/${bill.id}')).status;`)) === 'void', 'the old bill is cancelled (its pieces went back into stock)');
  await run(`click('#clearBtn'); await sleep(300); if (document.querySelector('#cOk')) click('#cOk');`);
  console.log(`\nAll ${checks} draft checks passed.`);
} finally {
  await b.close();
}
process.exit(0);
