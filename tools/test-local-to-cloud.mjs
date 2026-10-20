// A computer uses Velanzo with no cloud set up, then the cloud is switched on and it connects:
// all its data must go up, and a shop computer joining afterwards must see it.
// Needs the preview running (npm run dev). EMPTIES the preview's stand-in cloud.
//   node --disable-warning=ExperimentalWarning tools/test-local-to-cloud.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, sleep } from './shot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://localhost:4000';
const NOCONF = path.join(ROOT, '.dev-cloud', 'no-config');
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };
const post = async (p, body, token) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) })).json();
const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };`;
const browsers = [];
async function device(name) {
  const dir = path.join(os.tmpdir(), 'velanzo-l2c-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  const b = await openBrowser({ profile: dir, width: 1280, height: 800 });
  browsers.push(b);
  b.page.run = (code) => b.page.js(H + code);
  return b.page;
}

try {
  await post('/cloud/dev/reset');
  fs.writeFileSync(NOCONF, '');
  const p = await device('owner');
  await p.goto(BASE + '/', 2500);
  ok(await p.run(`return document.body.innerText.includes('Start Velanzo');`), 'no cloud set up: Velanzo offers to start on this device');
  await p.run(`set('#f [name=business_name]', 'Local Shop'); set('#f [name=owner_name]', 'Owner'); for (const d of '12341234') document.querySelector('#pinSetup .pin-pad [data-k="' + d + '"]').click();
    await sleep(300); document.querySelector('#f button.primary').click(); await until(() => document.querySelector('.pin-pad')); for (const d of '1234') document.querySelector('.pin-pad [data-k="' + d + '"]').click(); await until(() => document.querySelector('#view')); await sleep(1500);`);
  const bill = await p.run(`const s1 = App.locations.find((l) => l.type === 'shop').id;
    const [pr] = await POST('/api/products', { name: 'Test Kurta', cost_price: 500, sale_price: 1000, variants: [{ size: 'M', opening_qty: 5 }], opening_location_id: s1 });
    const s = await POST('/api/sales', { location_id: s1, items: [{ product_id: pr.id, qty: 2 }] });
    return s.bill_no;`);
  ok(bill === 'S1-A0001', `bill ${bill} made on the device without any cloud`);
  ok(await p.run(`return document.querySelector('#syncPill').textContent === 'On this device';`), 'top bar says: On this device');

  // the cloud is switched on (config.js filled in) and the page opened again
  fs.rmSync(NOCONF);
  await p.reload(BASE + '/#/device', 3500);
  await p.run(`await until(() => document.querySelector('.pin-pad')); for (const d of '1234') document.querySelector('.pin-pad [data-k="' + d + '"]').click(); await until(() => document.querySelector('#connectBtn'));`);
  await p.run(`await until(() => document.querySelector('#connectBtn')); document.querySelector('#connectBtn').click(); await sleep(300);
    set('#f [name=email]', 'local.owner@test.local'); set('#f [name=password]', 'local-pass-123'); document.querySelector('#f button').click();
    await until(() => document.querySelector('.people')); await sleep(300);
    document.querySelector('.person').click(); await sleep(200); for (const d of '1234') document.querySelector('.pin-pad [data-k="' + d + '"]').click(); await until(() => document.querySelector('#view')); await sleep(1000); await Cloud.syncNow(); await refreshBadges();`);
  ok(await p.run(`return document.querySelector('#syncPill').textContent === 'All saved online';`), 'connected: All saved online');
  ok(await p.run(`return App.device.mode === 'cloud' && App.device.id >= 2;`), 'the device is now a cloud device');

  // a shop computer joins and finds the data that was made before the cloud existed
  const tok = (await post('/cloud/auth/v1/token?grant_type=password', { email: 'local.owner@test.local', password: 'local-pass-123' })).access_token;
  const s1 = await p.run(`return App.locations.find((l) => l.type === 'shop').id;`);
  // the owner makes a user for the shop (saved on the owner computer, then given a user ID and password in the cloud)
  const shopper = await p.run(`const u = await POST('/api/users', { name: 'Shopper', role: 'staff', location_id: ${JSON.stringify(s1)} }); await Cloud.syncNow(); await Cloud.setUserLogin(u.id, 'shopper', 'shopper-pass-1'); return u.id;`);
  const shop = await device('shop');
  await shop.goto(BASE + '/', 2500);
  await shop.run(`document.querySelector('#cShop').click(); await sleep(200); set('#f [name=login]', 'shopper'); set('#f [name=password]', 'shopper-pass-1'); document.querySelector('#f button').click(); await until(() => document.querySelector('.people'));`);
  const seen = await shop.run(`const r = await Engine.api({ method: 'GET', path: '/api/login-users' }); return r.body.business_name;`);
  ok(seen === 'Local Shop', 'the shop computer downloaded the business made before the cloud');
  // the new user chooses their own passcode (4 numbers, twice), then is in
  await shop.run(`await until(() => document.querySelector('#pinSetup')); for (const d of '12341234') document.querySelector('#pinSetup .pin-pad [data-k="' + d + '"]').click(); await sleep(300); document.querySelector('#fp button.primary').click(); await until(() => document.querySelector('#view'));`);
  ok(await shop.run(`return App.user.name === 'Shopper';`), 'the new user chose a passcode and is in');
  const sale = await shop.run(`await Engine.system('info');
    return (await Engine.api({ method: 'GET', path: '/api/sales', query: {} })).body.map((x) => x.bill_no);`);
  ok(sale.includes(bill), `the shop sees bill ${bill}`);
  console.log(`\nAll ${checks} checks passed.`);
} finally {
  if (fs.existsSync(NOCONF)) fs.rmSync(NOCONF);
  for (const b of browsers) await b.close();
}
process.exit(0);
