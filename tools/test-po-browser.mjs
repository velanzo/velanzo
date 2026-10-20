// In a real (headless) browser: order 10 black henley shirts today (making the item right inside the order),
// nothing is in stock; ten days later 9 arrive: count them, the stock becomes 9, the labels are ready, and the
// warehouse can dispatch them. Needs the preview with demo data (npm run dev + node tools/demo-data.mjs).
//   node --disable-warning=ExperimentalWarning tools/test-po-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, sleep } from './shot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev-cloud', 'demo.json'), 'utf8'));
const BASE = demo.base;
const args = process.argv.slice(2);
const SHOTS = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : null;
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };

const token = async () => (await (await fetch(`${BASE}/cloud/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: demo.owner_email, password: demo.owner_password }) })).json()).access_token;
const rpc = async (fn, a) => (await fetch(`${BASE}/cloud/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify(a) })).json();
const cloudRows = async (tbl) => (await rpc('pull', { p_device: 2, p_user: null, p_since: 0, p_limit: 100000 })).rows.filter((r) => r.t === tbl).map((r) => r.r);

const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const go = async (h) => { location.hash = h; await sleep(900); };`;

fs.rmSync(path.join(os.tmpdir(), 'velanzo-test-po'), { recursive: true, force: true });
const b = await openBrowser({ profile: path.join(os.tmpdir(), 'velanzo-test-po'), width: 1280, height: 900 });
const p = b.page;
const run = (code) => p.js(H + code);
try {
  await p.goto(BASE + '/', 1500);
  await run("await until(() => document.querySelector('#cOwner'), 30000);");
  await run(`click('#cOwner'); await sleep(200); set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button'); await until(() => document.querySelector('.people'), 60000);
    click([...document.querySelectorAll('.person')].find((x) => x.textContent.includes('Owner'))); await sleep(200);
    for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]'); await until(() => document.querySelector('#shell')); await sleep(1500);`);
  const stockOf = (name) => run(`const rows = (await GET('/api/stock', { q: ${JSON.stringify(name)}, zero: 1 })).rows; return rows.reduce((a, r) => a + r.total, 0);`);

  // ---- Day 0: the order, with a brand-new item made inside it ----
  await run(`await go('#/purchases'); await until(() => document.querySelector('#pageActions .btn.primary'));`);
  ok(await run(`return document.querySelector('#pageActions .btn.primary').textContent.includes('New purchase order');`), 'Purchase has a “New purchase order” button');
  await run(`click('#pageActions .btn.primary'); await until(() => document.querySelector('#newItem'));`);
  ok(await run(`return document.body.innerText.includes('Nothing is added to stock now') && !document.querySelector('#paid') && !!document.querySelector('#exp');`), 'the order form says nothing goes to stock, asks for the expected date, and has no payment box');
  await run(`click('#newItem'); await until(() => document.querySelector('.modal-wrap [name=name]'));
    set('.modal-wrap [name=name]', 'Black Henley Shirt'); set('.modal-wrap [name=category]', 'Shirt'); set('.modal-wrap [name=cost_price]', '800'); set('.modal-wrap [name=sale_price]', '1800'); set('.modal-wrap [name=colors]', 'Black');
    await sleep(300); click('.modal-wrap #apSave'); await until(() => !document.querySelector('.modal-wrap'));`);
  await run(`await until(() => document.querySelector('#lines [data-f=qty]')); set('#lines [data-f=qty]', '10'); set('#exp', ${JSON.stringify(await run(`const d = new Date(); d.setDate(d.getDate() + 10); return ymd(d);`))});`);
  if (SHOTS) await p.shot(path.join(SHOTS, 'po-new.png'));
  const stockBefore = await stockOf('Black Henley');
  await run(`click('#saveBtn'); await until(() => /^#\\/purchases\\/\\d+/.test(location.hash) && document.querySelector('.alert'));`);
  const detail = await run(`return document.body.innerText;`);
  ok(/Purchase order/.test(detail) && /Nothing is in stock yet/.test(detail) && /Receive stock/.test(detail), 'the order is saved: “nothing is in stock yet”, with a Receive stock button');
  if (SHOTS) await p.shot(path.join(SHOTS, 'po-saved.png'));
  ok((await stockOf('Black Henley')) === stockBefore, 'nothing is in stock after ordering');
  ok(await run(`return !document.querySelector('#lblBtn');`), 'no label button before the goods arrive');
  const orderId = await run(`return Number(location.hash.match(/purchases\\/(\\d+)/)[1]);`);
  await run(`await go('#/purchases'); await sleep(500);`);
  ok(await run(`return document.querySelector('#tabs [data-t=ordered]').textContent.includes('(');`), 'the list shows how many orders are waiting');
  await run(`click('#tabs [data-t=ordered]'); await sleep(500);`);
  ok(await run(`return document.querySelector('#list').innerText.includes('Black Henley') === false && document.querySelector('#list').innerText.includes('On order');`), 'the “On order” tab lists it');
  // it reaches the cloud as an order
  await run('await Cloud.syncNow();');
  const cp = (await cloudRows('purchases')).find((x) => x.id === orderId);
  ok(cp && cp.status === 'ordered', 'the cloud has it as an order');

  // ---- Day 10: the goods arrive: 9 of 10 ----
  await run(`await go('#/purchases/' + ${orderId});`);
  await run(`click('.alert a.btn'); await until(() => document.querySelector('#okBtn'));`);
  ok(await run(`return document.body.innerText.includes('count the pieces') && !document.querySelector('#scan');`), 'the receive screen asks you to count (no scanning: the shirts have no barcode yet)');
  await run(`set('[data-q]', '9'); set('#inv', 'SUP-77'); set('#paid', '3000');`);
  if (SHOTS) await p.shot(path.join(SHOTS, 'po-receive.png'));
  await run(`click('#okBtn'); await until(() => document.querySelector('#cOk')); click('#cOk'); await until(() => document.querySelector('#lblBtn'));`);
  const arrived = await run(`return document.body.innerText;`);
  ok(/Received\. 9 pieces/.test(arrived) && /ordered 10/.test(arrived) && /print the barcode labels/i.test(arrived), 'received: 9 added, “ordered 10” is kept, next step is the labels');
  ok((await stockOf('Black Henley')) === stockBefore + 9, 'stock is now 9');
  if (SHOTS) await p.shot(path.join(SHOTS, 'po-arrived.png'));

  // ---- labels: one per piece, all the same barcode ----
  await run(`click('#lblBtn'); await until(() => document.querySelector('#qList .tbl'));`);
  const labels = await run(`return { n: JSON.parse(localStorage.getItem('vz_labels') || '[]').map((x) => x.copies), text: document.querySelector('#printBtn').textContent };`);
  ok(labels.n.includes(9) && /Print \d+ label/.test(labels.text), 'labels: 9 labels of the same barcode are ready to print');

  // ---- it works in the cloud and on the owner's stock / dispatch ----
  await run('await Cloud.syncNow();');
  const done = (await cloudRows('purchases')).find((x) => x.id === orderId);
  ok(done && done.status === 'done' && done.total_qty === 9, 'the cloud has the received purchase (9 pieces)');
  ok((await cloudRows('stock')).filter((s) => s.qty === 9).length > 0, 'the cloud stock shows 9');
  ok((await run(`return (await GET('/api/badges')).errors || 0;`)) === 0, 'nothing was refused by the cloud');
  console.log(`\nAll ${checks} purchase order checks passed.`);
} finally {
  await b.close();
}
process.exit(0);
