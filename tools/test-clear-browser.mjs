// In a real (headless) browser: the owner clears some bills by date, then everything, and the shop computer
// follows. This EMPTIES the preview's demo data — run `node tools/demo-data.mjs` afterwards to get it back.
//   npm run dev   +   node tools/demo-data.mjs   then   node --disable-warning=ExperimentalWarning tools/test-clear-browser.mjs
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
const rpc = async (fn, a) => (await fetch(`${BASE}/cloud/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() }, body: JSON.stringify(a) })).json();
const cloud = async () => {
  const res = await rpc('pull', { p_device: 2, p_user: null, p_since: 0, p_limit: 100000 });
  const c = {};
  for (const r of res.rows) c[r.t] = (c[r.t] || 0) + 1;
  return c;
};
const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };`;
const profile = (n) => path.join(os.tmpdir(), 'velanzo-test-clear-' + n);

async function join(name, { owner = false, who, pin }) {
  fs.rmSync(profile(name), { recursive: true, force: true });
  const b = await openBrowser({ profile: profile(name), width: 1280, height: 900 });
  const p = b.page;
  p.run = (code) => p.js(H + code);
  await p.goto(BASE + '/', 1500);
  await p.run("await until(() => document.querySelector('#cShop'), 30000);");
  if (owner) {
    await p.run(`click('#cOwner'); await sleep(200); set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button');
      await until(() => document.querySelector('.people'), 60000);`);
  } else {
    await p.run(`click('#cShop'); await sleep(200); set('#f [name=login]', ${JSON.stringify(demo.logins[who].login)}); set('#f [name=password]', ${JSON.stringify(demo.logins[who].password)}); click('#f button'); await until(() => document.querySelector('.people'), 30000);`);
  }
  await p.run(`click([...document.querySelectorAll('.person')].find((x) => x.textContent.includes(${JSON.stringify(who)}))); await sleep(200);
    for (const d of ${JSON.stringify(pin)}) click('.pin-pad [data-k="' + d + '"]');
    await until(() => document.querySelector('#shell')); await sleep(1500);`);
  return { b, p };
}

// the owner's page uploads what stays, then reloads: wait until the cloud has people again
const settle = async () => {
  for (let i = 0; i < 80; i++) { await sleep(800); const c = await cloud(); if (c.users) break; }
  await sleep(2500);
};
let bo, bs;
try {
  ({ b: bs } = await join('shop', { who: 'Ahmed', pin: demo.pins.Ahmed }));
  ({ b: bo } = await join('owner', { owner: true, who: 'Owner', pin: demo.owner_pin }));
  const s = bs.page, o = bo.page;
  const count = (p, url, q = {}) => p.run(`return (await GET(${JSON.stringify(url)}, ${JSON.stringify(q)})).length;`);
  const shopBills = () => count(s, '/api/sales', { from: '2000-01-01', to: '2100-01-01' });
  await s.run('await Cloud.syncNow();');
  const shopBefore = await shopBills();
  const cloudBefore = await cloud();
  ok(cloudBefore.sales > 10 && shopBefore > 5, `start: ${cloudBefore.sales} bills in the cloud, ${shopBefore} on the shop computer`);

  // the owner opens Settings → Backup & data
  await o.run(`window.alert = () => {}; location.hash = '#/settings/backup'; await until(() => document.querySelector('#clSome'));`);
  const table = await o.run(`return document.querySelector('#mdBody').innerText;`);
  ok(/Bills/.test(table) && /Items/.test(table), 'Manage data shows what is stored');

  // ---- clear bills older than a week (by date) ----
  const cutoff = await o.run(`const d = new Date(); d.setDate(d.getDate() - 7); return ymd(d);`);
  await o.run(`document.querySelector('[data-kind=sales]').click(); set('#clTo', ${JSON.stringify(cutoff)}); click('#clSome');
    await until(() => document.querySelector('#cOk')); click('#cOk');
    await until(() => document.querySelector('#pIn')); set('#pIn', 'CLEAR'); click('#pOk');`);
  await settle();
  const c1 = await cloud();
  ok(c1.sales < cloudBefore.sales && c1.sales > 0, `cloud: bills before ${cutoff} are gone (${cloudBefore.sales} → ${c1.sales}), newer ones stay`);
  ok(c1.products === cloudBefore.products && c1.stock === cloudBefore.stock, 'items and stock counts are untouched');
  await s.run('await Cloud.syncNow(); await sleep(500); await Cloud.syncNow();');
  const shopMid = await shopBills();
  ok(shopMid < shopBefore, `the shop computer followed (${shopBefore} → ${shopMid} bills)`);

  // ---- clear everything ----
  // (Velanzo reloaded itself after the first clearing, so it asks for the passcode again)
  await o.run(`await until(() => document.querySelector('.pin-pad')); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]'); await until(() => document.querySelector('#shell')); await sleep(500);`);
  await o.run(`window.alert = () => {}; location.hash = '#/settings/backup'; await until(() => document.querySelector('#clAll')); click('#clAll');
    await until(() => document.querySelector('#cOk')); click('#cOk');
    await until(() => document.querySelector('#pIn')); set('#pIn', 'clear'); click('#pOk');`);
  await settle();
  const c2 = await cloud();
  ok(!c2.sales && !c2.products && !c2.purchases && !c2.movements && !c2.suppliers && !c2.expenses, 'cloud: all business data cleared');
  ok(c2.users >= 3 && c2.locations === 2, 'people and places stay');
  await s.run('await Cloud.syncNow(); await sleep(500); await Cloud.syncNow();');
  ok((await shopBills()) === 0 && (await count(s, '/api/products', { all: 1, active: 'all' })) === 0, 'the shop computer is empty too');
  ok(await s.run(`return !!App.user;`), 'the shop computer still has its people (still logged in)');
  console.log(`\nAll ${checks} clear-data browser checks passed.\nNow run: node tools/demo-data.mjs  (to refill the demo business)`);
} finally {
  if (bo) await bo.close();
  if (bs) await bs.close();
}
process.exit(0);
