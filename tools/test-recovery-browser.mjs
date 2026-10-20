// In real (headless) browsers: a shop person forgets their PIN, the owner approves from the email link on another
// computer, and the person chooses a new PIN. The same for the owner's own PIN, and a forgotten owner password.
// (The preview sends no real emails; it keeps the links so this test can open them.)
// Needs the preview with demo data: npm run dev + node tools/demo-data.mjs, then
//   node --disable-warning=ExperimentalWarning tools/test-recovery-browser.mjs
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

const post = async (p, body, token) => (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })).json();
const login = (email, password) => post('/cloud/auth/v1/token?grant_type=password', { email, password });
const lastMail = async (kind) => (await (await fetch(`${BASE}/cloud/dev/mail?email=${encodeURIComponent(demo.owner_email)}`)).json()).find((m) => m.kind === kind);

const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = document.querySelector(s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const typePin = (d) => { for (const k of d) click('.pin-pad [data-k="' + k + '"]'); };`;
const open = async (name) => {
  const dir = path.join(os.tmpdir(), 'velanzo-test-recovery-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  const b = await openBrowser({ profile: dir, width: 1100, height: 850 });
  b.page.run = (code) => b.page.js(H + code);
  return b;
};
async function join(name, { owner = false, who }) {
  const b = await open(name);
  const p = b.page;
  await p.goto(BASE + '/', 1500);
  await p.run("await until(() => document.querySelector('#cShop'), 30000);");
  if (owner) {
    await p.run(`click('#cOwner'); await sleep(200); set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button');
      await until(() => document.querySelector('.people'), 60000);`);
  } else {
    await p.run(`click('#cShop'); await sleep(200); set('#f [name=login]', ${JSON.stringify(demo.logins[who].login)}); set('#f [name=password]', ${JSON.stringify(demo.logins[who].password)}); click('#f button'); await until(() => document.querySelector('.people'), 30000);`);
  }
  await p.run(`click([...document.querySelectorAll('.person')].find((x) => x.textContent.includes(${JSON.stringify(who)}))); await sleep(300);`);
  return b;
}
// the owner opens the emailed link in a browser of their own and approves
async function approveFrom(link, who) {
  const b = await open('approver-' + Math.random().toString(36).slice(2, 6));
  try {
    await b.page.goto(link, 2500);
    const text = await b.page.run(`await until(() => document.querySelector('[data-ok]')); return document.querySelector('#list').innerText;`);
    ok(text.includes(who), `the owner's link shows “${who}” waiting`);
    await b.page.run(`click('[data-ok]'); await sleep(1500);`);
  } finally { await b.close(); }
}

let shop, ownerB;
try {
  // ================= a shop person forgets their PIN =================
  shop = await join('shop', { who: 'Ahmed' });
  const s = shop.page;
  ok(await s.run(`return !!document.querySelector('#forgotPin');`), 'the PIN screen has “Forgot your PIN?”');
  await s.run(`click('#forgotPin'); await until(() => document.querySelector('#send')); click('#send'); await until(() => document.querySelector('.progress'));`);
  ok((await s.run(`return document.body.innerText;`)).includes('o***@demo.local'), 'it says where the link went (the owner email, partly hidden)');
  const mail = await lastMail('magiclink');
  ok(!!mail && mail.link.includes('type=magiclink'), 'a link was emailed to the owner');
  await approveFrom(mail.link, 'Ahmed');
  await s.run(`await until(() => [...document.querySelectorAll('h1')].some((h) => h.textContent === 'Approved'), 20000);`);
  ok(true, 'the shop computer noticed the approval by itself');
  await s.run(`for (const k of '55555555') click('#pinSetup .pin-pad [data-k="' + k + '"]'); await sleep(300); click('#f button.primary'); await until(() => document.querySelector('#shell'), 20000); await sleep(1500);`);
  ok(await s.run(`return App.user.name === 'Ahmed';`), 'Ahmed chose a new PIN and is in');
  // the old PIN no longer works, the new one does
  await s.run(`click('#userMenu summary'); click('#switchBtn'); await until(() => document.querySelector('.person')); click([...document.querySelectorAll('.person')].find((x) => x.textContent.includes('Ahmed'))); await sleep(300); typePin(${JSON.stringify(demo.pins.Ahmed)}); await sleep(800);`);
  ok(await s.run(`return /Wrong passcode/.test(document.querySelector('#pinErr').textContent);`), 'the old PIN is refused');
  await s.run(`typePin('5555'); await until(() => document.querySelector('#shell'));`);
  ok(true, 'the new PIN works');
  await s.run('await Cloud.syncNow();');
  ok((await s.run(`return (await GET('/api/badges')).errors || 0;`)) === 0, 'the new PIN was accepted by the cloud (nothing refused)');
  // approving twice or using an old link does nothing
  const again = await approveCheck(mail.link);
  ok(again, 'the same link shows nothing waiting any more');
  await shop.close(); shop = null;

  // ================= the owner forgets their own PIN =================
  ownerB = await join('owner', { owner: true, who: 'Owner' });
  const o = ownerB.page;
  await o.run(`click('#forgotPin'); await until(() => document.querySelector('#send')); click('#send'); await until(() => document.querySelector('.progress'));`);
  const m2 = await lastMail('magiclink');
  await approveFrom(m2.link, 'Owner');
  try {
    await o.run(`await until(() => [...document.querySelectorAll('h1')].some((h) => h.textContent === 'Approved'), 20000); for (const k of '77777777') click('#pinSetup .pin-pad [data-k="' + k + '"]'); await sleep(300); click('#f button.primary'); await until(() => document.querySelector('#shell'), 20000);`);
  } catch (e) {
    console.log('  (the owner computer shows: ' + String(await o.run('return document.body.innerText;')).replace(/\n/g, ' | ').slice(0, 400) + ')');
    throw e;
  }
  ok(await o.run(`return App.user.owner === true;`), 'the owner chose a new PIN with the emailed link');
  await ownerB.close(); ownerB = null;

  // ================= the owner forgets the password =================
  const b3 = await open('password');
  try {
    const p = b3.page;
    await p.goto(BASE + '/', 1500);
    await p.run(`await until(() => document.querySelector('#cOwner')); click('#cOwner'); await sleep(200); click('#forgot'); await until(() => document.querySelector('#f [name=email]'));
      set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); click('#f button'); await until(() => document.body.innerText.includes('Check your email'));`);
    const rec = await lastMail('recovery');
    ok(!!rec && rec.link.includes('type=recovery'), 'a password link was emailed');
    await p.reload(rec.link, 2500);
    await p.run(`await until(() => document.querySelector('#f [name=p1]')); set('#f [name=p1]', 'brand-new-pass-9'); set('#f [name=p2]', 'brand-new-pass-9'); click('#f button'); await until(() => document.body.innerText.includes('Password changed'));`);
    ok(!(await login(demo.owner_email, demo.owner_password)).access_token, 'the old password stopped working');
    ok(!!(await login(demo.owner_email, 'brand-new-pass-9')).access_token, 'the new password works');
    // an expired / used link shows a friendly message
    await p.reload(BASE + '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired', 2000);
    ok((await p.run(`return document.body.innerText;`)).includes('This link did not work'), 'an old link shows a friendly message');
  } finally { await b3.close(); }
  console.log(`\nAll ${checks} recovery checks passed.\nThe demo owner password was changed by this test: run node tools/demo-data.mjs to reset the demo.`);
} finally {
  if (shop) await shop.close();
  if (ownerB) await ownerB.close();
}

async function approveCheck(link) {
  const b = await open('approver2');
  try {
    await b.page.goto(link, 2500);
    // (the sign-in inside the old link may be fine, but nothing is waiting)
    return await b.page.run(`await until(() => document.querySelector('#msg') && document.querySelector('#msg').textContent !== 'Loading…'); return !document.querySelector('[data-ok]');`);
  } finally { await b.close(); }
}
process.exit(0);
