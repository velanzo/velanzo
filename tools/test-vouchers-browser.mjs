// In a real (headless) browser, as the owner: make vouchers, print them (with a QR code), discount one bill line,
// scan a voucher on the sale screen (it becomes a line that takes money off), finish the bill, and see the voucher used up.
// Needs the preview with demo data (npm run dev + node tools/demo-data.mjs):
//   node --disable-warning=ExperimentalWarning tools/test-vouchers-browser.mjs [--shots DIR]
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
  const answer = async () => { await sleep(700); if (document.querySelector('#wGo')) { click('#wGo'); await sleep(500); } if (document.querySelector('#cOk')) { click('#cOk'); await sleep(500); } };`;

const dir = path.join(os.tmpdir(), 'velanzo-test-vouchers');
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

  // ---- make two vouchers on the Vouchers page ----
  await run(`await go('#/vouchers'); await until(() => document.querySelector('#newV')); click('#newV'); await until(() => document.querySelector('#vForm'));
    set('#vForm [name=value]', '100'); set('#vForm [name=count]', '2'); set('#vForm [name=note]', 'Test gift'); click('#vMake');
    await until(() => document.querySelectorAll('#vList [data-pick]').length >= 2 && document.querySelectorAll('#vList [data-pick]:checked').length === 2);`);
  const codes = await run(`return [...document.querySelectorAll('#vList td.mono b')].map((e) => e.textContent);`);
  ok(codes.length >= 2 && codes.every((c) => /^VZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)), 'two vouchers made, with readable codes: ' + codes.slice(0, 2).join(', '));
  ok(await run(`return /2 selected/.test(document.querySelector('#vPrintR').textContent);`), 'the new vouchers are ticked, ready to print');
  if (SHOTS) await p.shot(path.join(SHOTS, 'vouchers.png'));

  // ---- printing: a QR code on each voucher ----
  await run(`PrintLog.save([]); click('#vPrintR'); await sleep(900);`);
  const pr = await run(`const e = PrintLog.all()[0]; return { title: e.title, queue: e.queue, svgs: (e.body.match(/<svg/g) || []).length, code1: e.body.includes(${JSON.stringify(codes[0])}), note: e.body.includes('Test gift'), pages: (e.body.match(/class="vch"/g) || []).length };`);
  const docR = SHOTS ? await run(`const e = PrintLog.all()[0]; return { body: e.body, css: e.css };`) : null;
  ok(pr.title === 'Vouchers' && pr.queue === 'receipt' && pr.svgs === 2 && pr.pages === 2 && pr.code1 && pr.note, 'printing sends both vouchers to the receipt queue, each with a QR code and its code');
  await run(`PrintLog.save([]); click('#vPrintA'); await sleep(900);`);
  const docA = SHOTS ? await run(`const e = PrintLog.all()[0]; return { body: e.body, css: e.css };`) : null;
  ok(await run(`const e = PrintLog.all()[0]; return e.queue === 'paper' && /class="sheet"/.test(e.body);`), 'A4 printing makes a sheet of cut-out cards');

  // ---- the sale screen: a discount on one line, then the voucher ----
  const item = await run(`await ProductCache.load(${demo.shop_location}, true); const x = ProductCache.list.filter((q) => q.sale_price >= 500).sort((a, c) => c.loc_qty - a.loc_qty)[0]; return { id: x.id, barcode: x.barcode, price: x.sale_price };`);
  await run(`localStorage.setItem('vz_pos_loc', '${demo.shop_location}'); await go('#/pos'); await until(() => document.querySelector('#scan'));
    document.querySelector('#clearBtn').click(); await sleep(300); if (document.querySelector('#cOk')) click('#cOk'); await sleep(300);
    scan(${JSON.stringify(item.barcode)}); await until(() => document.querySelector('#cart [data-disc]'));`);
  await run(`set('#cart [data-disc="0"]', '10%'); await sleep(300);`);
  const net = Math.round(item.price * 0.9 * 100) / 100;
  ok((await run(`return document.querySelector('#sTotal').textContent;`)).replace(/[^0-9.]/g, '') === String(net), `a 10% discount on the line: the total is ${net}`);
  ok(await run(`return /off/.test(document.querySelector('.tot-sub').textContent) && !!document.querySelector('.cart-row .amt s');`), 'the line shows the old amount crossed out');
  await run(`scan(${JSON.stringify(codes[0])}); await until(() => document.querySelector('.voucher-line'));`);
  const net2 = Math.round((net - 100) * 100) / 100;
  ok((await run(`return document.querySelector('#sTotal').textContent;`)).replace(/[^0-9.]/g, '') === String(net2), `the voucher is a line on the bill: ${net} - 100 = ${net2}`);
  ok(await run(`return /Voucher/.test(document.querySelector('.voucher-line').textContent) && !document.querySelector('#scan').value;`), 'the scan box is empty again and the voucher line shows its code');
  if (SHOTS) await p.shot(path.join(SHOTS, 'pos-voucher.png'));
  // a second voucher cannot be added to the same bill
  await run(`scan(${JSON.stringify(codes[1])}); await sleep(700);`);
  ok(await run(`return /already has a voucher/.test(document.body.innerText) && document.querySelectorAll('.voucher-line').length === 1;`), 'only one voucher per bill');
  // take it off and put it back
  await run(`click('[data-rmv]'); await sleep(300);`);
  ok((await run(`return document.querySelector('#sTotal').textContent;`)).replace(/[^0-9.]/g, '') === String(net), 'taking the voucher off brings the total back');
  await run(`scan(${JSON.stringify(codes[0].toLowerCase().replace(/-/g, ''))}); await until(() => document.querySelector('.voucher-line'));`);
  ok(true, 'a typed code (small letters, no dashes) works too');

  await run(`click('#doneBtn'); await answer(); await until(() => /Bill .* saved/.test(document.body.innerText));`);
  const bill = await run(`const l = await GET('/api/sales', { from: '2000-01-01', to: '2999-12-31' }); return l[0];`);
  ok(bill.voucher_code === codes[0] && bill.voucher === 100 && bill.total === net2, `the saved bill: voucher ${bill.voucher_code} took off ${bill.voucher}, total ${bill.total}`);
  const full = await run(`return await GET('/api/sales/${bill.id}');`);
  ok(full.items[0].list_price === item.price && full.items[0].price === net, 'the bill line keeps the price before the discount');
  const printed = await run(`return billHtml(await GET('/api/sales/${bill.id}'));`);
  ok(/Voucher VZ-/.test(printed) && /Discount \(/.test(printed), 'the printed bill shows the item discount and the voucher');

  // ---- the voucher is used up ----
  await run(`document.querySelector('#mNew').click(); await sleep(300); scan(${JSON.stringify(item.barcode)}); await until(() => document.querySelector('#cart .cart-row'));
    scan(${JSON.stringify(codes[0])}); await sleep(800);`);
  ok(await run(`return /already used/.test(document.body.innerText) && !document.querySelector('.voucher-line');`), 'the same voucher cannot be used again');
  await run(`document.querySelector('#clearBtn').click(); await sleep(300); if (document.querySelector('#cOk')) click('#cOk'); await go('#/vouchers'); await until(() => document.querySelector('#vShow'));
    click('#vShow [data-s="used"]'); await sleep(300);`);
  ok(await run(`return [...document.querySelectorAll('#vList td.mono b')].some((e) => e.textContent === ${JSON.stringify(codes[0])});`), 'the Vouchers page lists it under "Used up"');
  await run(`click('#vList [data-bills]'); await until(() => document.querySelector('.modal-wrap'));`);
  ok(await run(`return document.querySelector('.modal-wrap').innerText.includes(${JSON.stringify(bill.bill_no)});`), 'its bills show which bill used it');
  if (SHOTS) await p.shot(path.join(SHOTS, 'voucher-bills.png'));
  if (SHOTS) { // what the printed vouchers look like
    for (const [name, d] of [['voucher-receipt', docR], ['voucher-a4', docA]]) {
      const f = path.join(SHOTS, name + '.html');
      fs.writeFileSync(f, `<!doctype html><meta charset="utf-8"><style>${d.css.replace(/@page[^}]*}/g, '')}</style><body style="background:#fff;${name === 'voucher-a4' ? 'width:190mm' : ''}">${d.body}</body>`);
      await p.goto('file:///' + f.replace(/\\/g, '/'), 800);
      await p.shot(path.join(SHOTS, name + '.png'));
    }
  }
  console.log(`\nAll ${checks} voucher checks passed.`);
} finally {
  await b.close();
}
process.exit(0);
