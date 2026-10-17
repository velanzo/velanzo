// In a real (headless) browser: a shop computer loses its internet, keeps selling, even reopens Velanzo,
// and everything reaches the cloud when the internet is back. Needs the preview running with demo data:
//   npm run dev   +   node tools/demo-data.mjs   then   node --disable-warning=ExperimentalWarning tools/test-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, sleep } from './shot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev-cloud', 'demo.json'), 'utf8'));
const BASE = demo.base;
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };

const token = async () => (await (await fetch(`${BASE}/cloud/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: demo.owner_email, password: demo.owner_password }) })).json()).access_token;
const rpc = async (fn, args) => (await fetch(`${BASE}/cloud/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify(args) })).json();

const profile = path.join(os.tmpdir(), 'velanzo-test-browser');
fs.rmSync(profile, { recursive: true, force: true });
const b = await openBrowser({ profile, width: 1280, height: 800 });
const p = b.page;
const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };`;
const run = (code) => p.js(H + code);
const offline = (on) => p.cdp.send('Network.emulateNetworkConditions', { offline: on, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await p.cdp.send('Network.enable');

try {
  // join as the Shop 1 counter and log in as Ahmed
  await p.goto(BASE + '/', 2500);
  const code = await rpc('create_setup_code', { p_location: demo.shop_location });
  await run(`document.querySelector('#cShop').click(); await sleep(200); const i = document.querySelector('#f [name=code]'); i.value = ${JSON.stringify(code)};
    document.querySelector('#f button').click(); await until(() => document.querySelector('.people'));
    [...document.querySelectorAll('.person')].find((x) => x.textContent.includes('Ahmed')).click(); await sleep(200);
    for (const d of '2222') document.querySelector('.pin-pad [data-k="' + d + '"]').click(); document.querySelector('.pin-pad [data-k="ok"]').click();
    await until(() => document.querySelector('#scan')); await sleep(1500);`);
  ok(await run(`return document.querySelector('#syncPill').textContent === 'All saved online';`), 'shop computer set up and online');
  await sleep(1500); // let the service worker finish keeping its files

  // the internet goes away
  await offline(true);
  const bill = await run(`const p = ProductCache.list.find((x) => x.loc_qty > 0);
    const s = await POST('/api/sales', { items: [{ product_id: p.id, qty: 1 }], payment_method: 'cash' });
    await Cloud.syncNow(); await refreshBadges(); return s.bill_no;`);
  ok(!!bill, `bill ${bill} made without internet`);
  ok(await run(`return document.querySelector('#syncPill').textContent;`) === 'No internet · 1 waiting', 'top bar says: No internet · 1 waiting');

  // reopen Velanzo while still offline (the files come from this computer)
  await p.reload(BASE + '/#/sales', 4500);
  ok(await run(`await until(() => document.querySelector('#view .tbl, #view .empty')); return document.body.innerText.includes(${JSON.stringify(bill)});`), 'reopened offline: the bill is still there');

  // the internet is back
  await offline(false);
  await run(`await Cloud.syncNow(); await refreshBadges();`);
  ok(await run(`return document.querySelector('#syncPill').textContent;`) === 'All saved online', 'internet back: All saved online');
  const res = await (await fetch(`${BASE}/cloud/rest/v1/rpc/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() },
    body: JSON.stringify({ p_device: 2, p_user: null, p_since: 0, p_limit: 100000 }) })).json();
  ok(res.rows.some((r) => r.t === 'sales' && r.r.bill_no === bill), `the cloud has bill ${bill}`);
  console.log(`\nAll ${checks} browser checks passed.`);
} finally {
  await b.close();
}
process.exit(0);
