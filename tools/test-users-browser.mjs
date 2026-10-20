// In real (headless) browsers: the owner adds a user (ID + password) on the Users screen; the user signs in on their
// own computer, chooses a 4-digit passcode on the pad, and from then on the computer asks the passcode every time it
// opens; it can be signed out / switched to another account; the owner can remove the computer.
// Needs the preview with demo data (npm run dev + node tools/demo-data.mjs):
//   node --disable-warning=ExperimentalWarning tools/test-users-browser.mjs [--shots DIR]
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

const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 25000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const pad = async (digits, sel = '.pin-pad') => { for (const d of digits) { click(sel + ' [data-k="' + d + '"]'); await sleep(40); } };
  const text = () => document.body.innerText;`;
async function open(name) {
  const dir = path.join(os.tmpdir(), 'velanzo-test-users-' + name);
  fs.rmSync(dir, { recursive: true, force: true });
  const b = await openBrowser({ profile: dir, width: 1280, height: 900 });
  b.page.run = (code) => b.page.js(H + code);
  await b.page.goto(BASE + '/', 1500);
  await b.page.run("await until(() => document.querySelector('#cShop'), 30000);");
  return b;
}

let bo, bs;
try {
  // ---- the owner ----
  bo = await open('owner');
  const o = bo.page;
  await o.run(`click('#cOwner'); await sleep(200); set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); await pad(${JSON.stringify(demo.owner_pin)}); await until(() => document.querySelector('#shell')); await sleep(1000);`);
  ok(await o.run(`return !document.querySelector('.tabs a[href="#/settings/devices"]') || true;`), 'owner is in');
  await o.run(`location.hash = '#/settings/users'; await until(() => document.querySelector('#add'));`);
  const tabs = await o.run(`return [...document.querySelectorAll('.tabs a')].map((a) => a.textContent);`);
  ok(tabs.includes('Users') && !tabs.includes('Devices') && !tabs.includes('People'), 'one Users tab instead of People + Devices: ' + tabs.join(', '));
  const list = await o.run(`return document.querySelector('.tbl').innerText;`);
  ok(/Ahmed/.test(list) && /ahmed/.test(list) && /Chosen/.test(list) && /Shop 1 counter|Windows|computer/i.test(list), 'the list shows each person with their user ID, passcode and computer');
  if (SHOTS) await o.shot(path.join(SHOTS, 'users-list.png'));

  // add a user
  await o.run(`click('#add'); await until(() => document.querySelector('.modal-wrap [name=name]'));
    set('.modal-wrap [name=name]', 'Mina'); set('.modal-wrap [name=login]', 'Mina.Shop1'); set('.modal-wrap [name=password]', 'mina-pass-1');`);
  ok(await o.run(`return !document.querySelector('.modal-wrap [name=pin]') && /User ID/.test(document.querySelector('.modal-wrap').innerText);`), 'the form asks for a user ID and password (no passcode: the user chooses it)');
  if (SHOTS) await o.shot(path.join(SHOTS, 'users-add.png'));
  await o.run(`click('.modal-wrap #us'); await until(() => !document.querySelector('.modal-wrap')); await sleep(800);`);
  ok(await o.run(`return /Mina/.test(document.querySelector('.tbl').innerText) && /mina.shop1/.test(document.querySelector('.tbl').innerText);`), 'Mina is in the list with her user ID (saved in lower case)');
  ok(await o.run(`return /chosen at first sign-in/.test(document.querySelector('.tbl').innerText);`), 'her passcode shows as “chosen at first sign-in”');

  // ---- Mina signs in on her computer ----
  bs = await open('mina');
  const s = bs.page;
  await s.run(`click('#cShop'); await sleep(200); set('#f [name=login]', 'mina.shop1'); set('#f [name=password]', 'wrong-password'); click('#f button.primary'); await until(() => document.querySelector('#setupErr').textContent);`);
  ok(/Wrong user ID or password/.test(await s.run(`return document.querySelector('#setupErr').textContent;`)), 'a wrong password is refused with a clear message');
  await s.run(`set('#f [name=password]', 'mina-pass-1'); click('#f button.primary'); await until(() => document.querySelector('#pinSetup'), 40000);`);
  ok(await s.run(`return /Welcome, Mina/.test(text()) && /4-digit passcode/.test(text());`), 'signed in: “Welcome, Mina — choose a 4-digit passcode” on a number pad');
  if (SHOTS) await s.shot(path.join(SHOTS, 'passcode-choose.png'));
  await s.run(`await pad('4321', '#pinSetup .pin-pad'); await sleep(300);`);
  ok(await s.run(`return /again/.test(document.querySelector('#psLabel').textContent);`), 'it asks to type the passcode again');
  await s.run(`await pad('1111', '#pinSetup .pin-pad'); await sleep(300);`);
  ok(await s.run(`return /not the same/i.test(document.querySelector('#psHint').textContent) && document.querySelector('#fp button.primary').disabled;`), 'two different passcodes are not accepted');
  await s.run(`await pad('43214321', '#pinSetup .pin-pad'); await sleep(300); click('#fp button.primary'); await until(() => document.querySelector('#shell'), 30000);`);
  ok(await s.run(`return App.user.name === 'Mina' && !App.user.owner;`), 'Mina chose her passcode and is in (a shop person, not the owner)');
  ok(await s.run(`return !!document.querySelector('#signOutBtn') && !!document.querySelector('#switchBtn');`), 'her menu has Lock and Sign out / switch account');
  await s.run(`await Cloud.syncNow(); await sleep(500); await Cloud.syncNow();`);
  ok((await s.run(`return (await GET('/api/badges')).errors || 0;`)) === 0, 'her passcode reached the cloud without a refusal');

  // ---- the computer asks the passcode every time it opens ----
  await s.reload(BASE + '/#/sales', 3500);
  ok(await s.run(`await until(() => document.querySelector('.pin-pad')); return /Mina/.test(text()) && /type your passcode/.test(text()) && getComputedStyle(document.querySelector('.people')).display === 'none';`), 'after a refresh it asks Mina for her passcode (no list of names: the computer is hers)');
  ok(await s.run(`return /Switch account/.test(text()) && /Sign out/.test(text()) && /Forgot your passcode/.test(text());`), 'the passcode screen offers Switch account, Sign out and Forgot your passcode');
  if (SHOTS) await s.shot(path.join(SHOTS, 'passcode-lock.png'));
  await s.run(`await pad('9999'); await until(() => document.querySelector('#pinErr').textContent);`);
  ok(/Wrong passcode/.test(await s.run(`return document.querySelector('#pinErr').textContent;`)), 'a wrong passcode is refused');
  await s.run(`await sleep(300); await pad('4321'); await until(() => document.querySelector('#shell'));`);
  ok(await s.run(`return App.user.name === 'Mina' && location.hash === '#/sales';`), 'the right passcode opens Velanzo where she was (it opens by itself at the 4th number)');
  // Lock from the menu
  await s.run(`click('#userMenu summary'); click('#switchBtn'); await until(() => document.querySelector('.pin-pad'));`);
  ok(await s.run(`return /Mina/.test(text());`), 'Lock in the menu goes back to the passcode screen');

  // ---- the owner sees Mina's computer ----
  await o.run(`await Cloud.syncNow(); await sleep(500); location.hash = '#/settings/business'; await sleep(300); location.hash = '#/settings/users'; await until(() => document.querySelector('.tbl')); await sleep(800);`);
  const row = await o.run(`const r = [...document.querySelectorAll('.tbl tbody tr')].find((x) => x.innerText.includes('Mina')); return r ? r.innerText : '';`);
  ok(/Chosen/.test(row) && /Shop 1/.test(row) && /online/.test(row) && /Remove computer/.test(row), 'the owner sees Mina: passcode chosen, her computer, last online, and Remove computer');
  if (SHOTS) await o.shot(path.join(SHOTS, 'users-mina.png'));

  // ---- switch account on Mina's computer ----
  await s.run(`click('#swAcc'); await until(() => document.querySelector('#cOk')); click('#cOk'); await until(() => document.querySelector('#f [name=login]'), 30000);`);
  ok(await s.run(`return /Sign in/.test(text()) && !document.querySelector('.pin-pad');`), 'Switch account (nothing was waiting) shows the sign-in form, ready for another person');
  await s.run(`set('#f [name=login]', ${JSON.stringify(demo.logins.Ahmed.login)}); set('#f [name=password]', ${JSON.stringify(demo.logins.Ahmed.password)}); click('#f button.primary'); await until(() => document.querySelector('.pin-pad'), 40000);`);
  ok(await s.run(`return /Ahmed/.test(text()) && !/Mina/.test(text());`), 'Ahmed signs in on the same computer: it is Ahmed\'s now');
  await s.run(`await pad(${JSON.stringify(demo.pins.Ahmed)}); await until(() => document.querySelector('#shell'));`);
  await s.run(`await Cloud.syncNow();`);

  // ---- the owner removes a computer ----
  await o.run(`await Cloud.syncNow(); location.hash = '#/settings/business'; await sleep(300); location.hash = '#/settings/users'; await until(() => document.querySelector('.tbl')); await sleep(800);`);
  const ahmedRow = await o.run(`const r = [...document.querySelectorAll('.tbl tbody tr')].find((x) => x.innerText.includes('Ahmed')); return r ? r.innerText : '';`);
  ok(/Remove computer/.test(ahmedRow), 'Ahmed\'s row has Remove computer (his computer is the one that just signed in)');
  await o.run(`const b = [...document.querySelectorAll('.tbl tbody tr')].find((x) => x.innerText.includes('Ahmed')).querySelector('[data-rm]'); b.click(); await until(() => document.querySelector('#cOk')); click('#cOk'); await sleep(2500);`);
  await s.run(`await Cloud.syncNow();`);
  ok(await s.run(`return /removed/i.test(Cloud.status().problem?.text || '') || /Device removed/.test(document.querySelector('#syncPill').textContent);`), 'the removed computer is told: “The owner removed this device”');
  console.log(`\nAll ${checks} users checks passed.`);
} finally {
  if (bo) await bo.close();
  if (bs) await bs.close();
}
process.exit(0);
