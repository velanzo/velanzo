// In a real (headless) browser, as the owner: tick items on Stock and on Items and press "Move stock" (a dispatch order
// filled in with their pieces); a click next to a tick box ticks it instead of opening the item; the last warehouse can be deleted.
// Needs the preview with demo data (npm run dev + node tools/demo-data.mjs):
//   node --disable-warning=ExperimentalWarning tools/test-move-stock-browser.mjs
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
  const set = (s, v) => { const e = typeof s === 'string' ? document.querySelector(s) : s; e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };`;
const dir = path.join(os.tmpdir(), 'velanzo-test-move');
fs.rmSync(dir, { recursive: true, force: true });
const b = await openBrowser({ profile: dir, width: 1400, height: 900 });
const run = (code) => b.page.js(H + code);
try {
  await b.page.goto(demo.base + '/', 1500);
  await run(`await until(() => document.querySelector('#cOwner')); click('#cOwner'); await sleep(200);
    set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]'); await until(() => document.querySelector('#shell')); await sleep(1000);
    localStorage.removeItem('vz_dispatch_' + App.user.id);`);
  const W = demo.warehouse_location;

  // ---- Stock page ----
  await run(`location.hash = '#/stock'; await until(() => document.querySelector('#list td.sel'));`);
  // a click in the tick box's cell, beside the box: ticks, does not open the item
  await run(`const td = document.querySelectorAll('#list td.sel')[0]; td.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 })); await sleep(300);`);
  ok(await run(`return location.hash === '#/stock' && document.querySelectorAll('#list td.sel input')[0].checked;`), 'Stock: a click next to the tick box ticks it, the item does not open');
  ok(await run(`return !document.querySelector('#mvSel').classList.contains('hidden');`), 'Stock: "Move stock" shows once something is ticked');
  // tick the first two rows that have stock at the warehouse
  const picked = JSON.parse(await run(`click(document.querySelectorAll('#list td.sel input')[0]); await sleep(100);
    const d = await GET('/api/stock', {}); const rows = d.rows.filter((r) => (r.qty[${W}] || 0) > 0).slice(0, 2);
    for (const r of rows) click('[data-sel="' + r.id + '"]'); await sleep(200); return JSON.stringify(rows.map((r) => ({ id: r.id, q: r.qty[${W}] })));`));
  await run(`click('#mvSel'); await until(() => document.querySelector('#mvFrom')); set('#mvFrom', '${W}'); await sleep(100); click('#mvOk'); await until(() => location.hash === '#/dispatch/new' && document.querySelector('#lines tbody')); await sleep(800);`);
  const lines = JSON.parse(await run(`return JSON.stringify([...document.querySelectorAll('#lines [data-q]')].map((i) => Number(i.value)));`));
  ok(lines.length === 2 && lines.join() === picked.map((p) => p.q).join(), `Move stock opens a dispatch order with the 2 items and all their pieces (${lines.join(', ')})`);
  ok(await run(`return Number(document.querySelector('#from').value) === ${W} && document.querySelector('#to').value && Number(document.querySelector('#to').value) !== ${W};`), 'from the warehouse, to another place');

  // ---- Items page ----
  await run(`localStorage.removeItem('vz_dispatch_' + App.user.id); location.hash = '#/products'; await until(() => document.querySelector('#list td.sel'));
    const td = document.querySelectorAll('#list td.sel')[1]; td.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(300);`);
  ok(await run(`return location.hash === '#/products' && document.querySelectorAll('#list td.sel input')[1].checked && !document.querySelector('#mvBtn').disabled;`), 'Items: a click next to the tick box ticks it; "Move stock" is ready');
  await run(`click('#mvBtn'); await until(() => document.querySelector('#mvFrom')); set('#mvFrom', '${W}'); await sleep(100); click('#mvOk'); await sleep(1500);`);
  ok(await run(`return location.hash === '#/dispatch/new' || /no stock at/.test(document.body.innerText);`), 'Items: Move stock opens the dispatch order (or says the item has no stock there)');

  // ---- the last warehouse can be deleted ----
  const out = await run(`const w = (await GET('/api/locations')).find((l) => l.id === ${W});
    await PUT('/api/locations/' + w.id, { type: 'shop' });
    const n = await POST('/api/locations', { name: 'Spare store', code: 'SPR', type: 'warehouse' });
    let msg = 'deleted'; try { await DEL('/api/locations/' + n.id); } catch (e) { msg = e.message; }
    await PUT('/api/locations/' + w.id, { type: 'warehouse' });
    return msg;`);
  ok(out === 'deleted', 'the only warehouse can be deleted: ' + out);
  console.log(`\nAll ${checks} move stock checks passed.`);
} finally { await b.close(); }
process.exit(0);
