// In real (headless) browsers at the same time: the same owner account and the same person's user ID on several computers.
// Signing out on one never signs the others out, everybody keeps the same data, and a computer whose sign-in is really gone
// reconnects without losing what it did. Needs the preview with demo data (npm run dev + node tools/demo-data.mjs):
//   node --disable-warning=ExperimentalWarning tools/test-two-laptops-browser.mjs
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
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const unlock = async (pin) => { await until(() => document.querySelector('.pin-pad')); for (const d of pin) click('.pin-pad [data-k="' + d + '"]'); await until(() => document.querySelector('#shell')); await sleep(800); };`;

async function laptop(name) {
  const dir = path.join(os.tmpdir(), 'velanzo-test-laptop-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  const b = await openBrowser({ profile: dir, width: 1200, height: 800 });
  await b.page.goto(demo.base + '/', 1500);
  return { name, b, run: (code) => b.page.js(H + code) };
}
const signInOwner = (l) => l.run(`await until(() => document.querySelector('#f [name=email], #cOwner')); if (document.querySelector('#cOwner')) { click('#cOwner'); await sleep(200); }
  set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary'); await unlock(${JSON.stringify(demo.owner_pin)});`);
const signInStaff = (l, who) => l.run(`await until(() => document.querySelector('#f [name=login], #cShop')); if (document.querySelector('#cShop')) { click('#cShop'); await sleep(200); }
  set('#f [name=login]', ${JSON.stringify(demo.logins[who].login)}); set('#f [name=password]', ${JSON.stringify(demo.logins[who].password)}); click('#f button.primary'); await unlock(${JSON.stringify(demo.pins[who])});`);
const sync = (l) => l.run('await Cloud.syncNow(); await sleep(200); await refreshBadges();');
// (what the status settles on, not "Saving…" for a moment)
const pill = (l) => l.run("await until(() => !/Saving|waiting/.test(document.querySelector('#syncPill').textContent)); return document.querySelector('#syncPill').textContent.trim();");
const billNos = (l) => l.run("return (await GET('/api/sales', { from: '2000-01-01', to: '2999-12-31', location_id: " + demo.shop_location + " })).map((b) => b.bill_no).sort().join();");
const stockOf = (l, id) => l.run(`return (await GET('/api/products/${id}')).stock.find((s) => s.location_id === ${demo.shop_location})?.qty ?? 0;`);
const refreshStillWorks = (l) => l.run(`const s = JSON.parse(localStorage.getItem('velanzo-auth'));
  return (await fetch('/cloud/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'dev' }, body: JSON.stringify({ refresh_token: s.refresh_token }) })).status === 200;`);

const open = [];
const start = async (name) => { const l = await laptop(name); open.push(l); return l; };
try {
  // ---- the test's stand-in behaves like Supabase: a sign-out without "only here" ends every sign-in of the account ----
  const A = await start('a');
  const control = await A.run(`const signIn = async () => (await fetch('/cloud/auth/v1/token?grant_type=password', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'dev' }, body: JSON.stringify({ email: ${JSON.stringify(demo.owner_email)}, password: ${JSON.stringify(demo.owner_password)} }) })).json();
    const one = await signIn(), two = await signIn();
    await fetch('/cloud/auth/v1/logout', { method: 'POST', headers: { apikey: 'dev', Authorization: 'Bearer ' + one.access_token } });
    return (await fetch('/cloud/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: 'dev' }, body: JSON.stringify({ refresh_token: two.refresh_token }) })).status;`);
  ok(control === 400, '(check of the test: the old way of signing out ended the sign-in on the other computer)');

  // ---- the same owner account on two laptops ----
  const B = await start('b');
  await signInOwner(A);
  await signInOwner(B);
  ok(await pill(A) === 'All saved online' && await pill(B) === 'All saved online', 'the owner account is open on two laptops, both saved online');
  const item = await A.run(`await ProductCache.load(${demo.shop_location}, true); const x = ProductCache.list.filter((q) => q.sale_price > 0)[0]; return { id: x.id };`);
  const newName = 'Renamed ' + Date.now();
  await A.run(`await PUT('/api/products/${item.id}', { name: ${JSON.stringify(newName)} });`);
  await sync(A); await sync(B);
  ok((await B.run(`const r = await GET('/api/products/${item.id}'); return (r.product || r).name;`)) === newName, 'a change on the first laptop reaches the second');
  await B.run(`await POST('/api/sales', { location_id: ${demo.shop_location}, items: [{ product_id: ${item.id}, qty: 1 }] });`);
  await sync(B); await sync(A);
  ok(await billNos(A) === await billNos(B), 'a bill on the second reaches the first');
  ok(await stockOf(A, item.id) === await stockOf(B, item.id), 'both show the same stock');

  await B.run(`Setup.signOut(false); await until(() => document.querySelector('#cOk')); click('#cOk'); await until(() => document.querySelector('#cOwner'));`);
  ok(await refreshStillWorks(A), 'signing out on the second laptop does not end the sign-in on the first');
  await sync(A);
  ok(await pill(A) === 'All saved online', 'the first laptop keeps working');
  await A.run(`await POST('/api/expenses', { amount: 4321, category: 'Two laptops', location_id: ${demo.shop_location} });`);
  await sync(A);
  await signInOwner(B);
  ok(await B.run(`return (await GET('/api/expenses', { from: '2000-01-01', to: '2999-12-31' })).some((e) => e.amount === 4321);`), 'signing in again on the second laptop gets everything, and the first is not disturbed');
  ok(await refreshStillWorks(A), 'signing in on another laptop does not end the sign-in on the first');

  // ---- the same person's user ID on two laptops ----
  const C = await start('c'), D = await start('d');
  await signInStaff(C, 'Ahmed');
  await signInStaff(D, 'Ahmed');
  ok(await pill(C) === 'All saved online' && await pill(D) === 'All saved online', "the same person's user ID is open on two laptops, both saved online");
  await C.run(`await POST('/api/sales', { items: [{ product_id: ${item.id}, qty: 1 }] });`);
  await D.run(`await POST('/api/sales', { items: [{ product_id: ${item.id}, qty: 2 }] });`);
  await sync(C); await sync(D); await sync(C);
  ok(await pill(C) === 'All saved online' && await pill(D) === 'All saved online', 'both sell at the same time, nothing refused');
  ok(await billNos(C) === await billNos(D), 'both show the same bills');
  ok(await stockOf(C, item.id) === await stockOf(D, item.id), 'both show the same stock');
  await sync(A);
  ok(await stockOf(A, item.id) === await stockOf(C, item.id), 'and the owner sees the same');

  await D.run(`Setup.signOut(false); await until(() => document.querySelector('#cOk')); click('#cOk'); await until(() => document.querySelector('#cShop'));`);
  await C.run(`await POST('/api/sales', { items: [{ product_id: ${item.id}, qty: 1 }] });`);
  await sync(C);
  ok(await pill(C) === 'All saved online', 'one signs out, the other keeps working');
  ok(await refreshStillWorks(A), 'and the owner is not disturbed');

  // ---- a computer that really lost its sign-in keeps what it did and reconnects ----
  await C.run(`localStorage.removeItem('velanzo-auth'); location.reload();`).catch(() => {});
  await new Promise((r) => { setTimeout(r, 2500); });
  await C.run(`await unlock(${JSON.stringify(demo.pins.Ahmed)}); await Cloud.syncNow(); await sleep(300);`);
  ok(await pill(C) === 'Not connected', 'a computer whose sign-in is gone says Not connected');
  const offlineBill = await C.run(`return (await POST('/api/sales', { items: [{ product_id: ${item.id}, qty: 1 }] })).bill_no;`);
  ok(!!offlineBill, 'it can keep working: bill ' + offlineBill);
  const oldDevice = await C.run('return App.device.id;');
  await C.run(`location.hash = '#/device'; await until(() => document.querySelector('#reBtn')); click('#reBtn');`);
  await signInStaff(C, 'Ahmed');
  await sync(C);
  const afterConnect = await C.run(`return JSON.stringify({ pill: document.querySelector('#syncPill').textContent.trim(), problem: Cloud.status().problem, errors: await GET('/api/sync/errors') });`);
  ok(JSON.parse(afterConnect).pill === 'All saved online', 'Connect again: signed in, saved online ' + (JSON.parse(afterConnect).pill === 'All saved online' ? '' : afterConnect));
  ok((await C.run('return App.device.id;')) !== oldDevice, '(with a new number)');
  await sync(A);
  ok((await A.run(`return (await GET('/api/sales/by-bill/${offlineBill}')).bill_no;`)) === offlineBill, 'the bill made meanwhile reached the owner');
  ok(await A.run(`return (await GET('/api/devices')).find((d) => d.id === ${oldDevice})?.active === 0;`), 'the old number is retired, not left behind');

  // ---- an owner sign-in left on a computer does not become the account of a shop person ----
  const E = await start('e');
  await E.run(`await until(() => document.querySelector('#cShop')); await Cloud.signIn(${JSON.stringify(demo.owner_email)}, ${JSON.stringify(demo.owner_password)}); click('#cShop');`);
  await signInStaff(E, 'Sara');
  ok(await E.run(`return JSON.parse(localStorage.getItem('velanzo-auth')).user.is_anonymous === true;`), "a person's computer gets its own sign-in, not the owner's that was left there");
  await sync(A); await sync(B);
  ok(await pill(A) === 'All saved online' && await pill(B) === 'All saved online', "the owner's computers are not switched off");
  ok(await A.run(`return (await GET('/api/devices')).filter((d) => d.active && d.location_id == null).length >= 2;`), 'they are still listed as in use');

  // ---- after all that, every computer compares equal with the cloud, and none needed repairing ----
  for (const l of [A, B, C, E]) {
    await sync(l);
    const r = await l.run(`await Cloud.syncNow(); return JSON.stringify({ c: await Engine.system('compareWithCloud', await Cloud.rpc('sync_check', { p_device: App.device.id, p_user: App.user.id })), repaired: (await GET('/api/sync/status')).repaired_at });`);
    const { c, repaired } = JSON.parse(r);
    ok(c.same !== false && !repaired, `${l.name}: the same as the cloud, no repair was needed (${JSON.stringify(c)})`);
  }

  console.log(`\nAll ${checks} two-laptop checks passed.`);
} finally {
  for (const l of open) await l.b.close().catch(() => {});
}
process.exit(0);
