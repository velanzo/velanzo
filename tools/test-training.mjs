// In a real (headless) browser: runs every Training guide the way a person would — following the arrow and
// doing what it says — and checks that practice leaves nothing behind. Needs the preview with demo data:
//   npm run dev   +   node tools/demo-data.mjs   then   node --disable-warning=ExperimentalWarning tools/test-training.mjs [--shots DIR]
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
const cloudCounts = async () => {
  const res = await rpc('pull', { p_device: 2, p_user: null, p_since: 0, p_limit: 100000 });
  const c = {};
  for (const r of res.rows) c[r.t] = (c[r.t] || 0) + 1;
  return c;
};

const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };`;

const profile = (n) => path.join(os.tmpdir(), 'velanzo-test-training-' + n);

// What a person does at each step: follow the arrow. (The helper button "Type it for me" first, then a click.)
function stepJs(tries) {
  return `
    const card = document.querySelector('#tour .tour-card');
    if (!card) return { closed: true };
    if (document.querySelector('#tour.wait')) return { wait: true };
    const title = card.querySelector('h4').textContent;
    if (title === 'Well done!') return { title, end: true };
    // let the text box finish sliding into place before judging it
    if (window.__tt !== title) { window.__tt = title; window.__ts = Date.now(); }
    if (Date.now() - window.__ts < 450) return { wait: true };
    const problems = [];
    const ring = document.querySelector('#tour .tour-ring');
    const pointing = getComputedStyle(ring).display !== 'none';
    const cr = card.getBoundingClientRect();
    if (cr.left < -1 || cr.top < -1 || cr.right > innerWidth + 1 || cr.bottom > innerHeight + 1) problems.push('text box is partly off the screen');
    let rr = null;
    if (pointing) {
      rr = ring.getBoundingClientRect();
      if (rr.width < 4 || rr.height < 4) problems.push('ring has no size');
      const overlap = !(cr.right < rr.left || cr.left > rr.right || cr.bottom < rr.top || cr.top > rr.bottom);
      if (overlap && getComputedStyle(document.querySelector('#tour')).display !== 'none') problems.push('text box covers the thing it points at');
    }
    const press = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
    let acted = '';
    const go = card.querySelector('[data-t=go]');
    const assist = card.querySelector('[data-t=assist]');
    const nextBtn = card.querySelector('[data-t=next]');
    if (go) { go.click(); acted = 'go'; }
    else if (title === 'Add one more') { press(document.querySelector('[data-inc="0"]')); acted = 'plus'; }
    else if (assist && ${tries} === 0) { assist.click(); acted = 'assist'; }
    else if (nextBtn) { nextBtn.click(); acted = 'next'; }
    else if (pointing) {
      const el = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
      if (!el) problems.push('nothing to click where the arrow points'); else { press(el); acted = 'click ' + (el.id ? '#' + el.id : el.tagName.toLowerCase()); }
    } else problems.push('no target to click');
    return { title, problems, acted, pointing };
  `;
}

async function drive(p, id, { shotAt = [], label = id } = {}) {
  const seen = [];
  const bad = [];
  try {
    await p.run(`Tour.start(${JSON.stringify(id)}); await sleep(600);
      const go = document.querySelector('#prGo'); if (go) { go.click(); await until(() => !document.querySelector('.modal-wrap')); }`);
  } catch (e) {
    console.log('  (start error: ' + JSON.stringify(await p.run("try { await Engine.system('practiceStart'); return 'no error now'; } catch (e) { return e.message; }")) + ') (screen: ' + String(await p.run('return document.body.innerText;')).replace(/\n/g, ' | ').slice(-500) + ')');
    throw e;
  }
  let tries = 0, last = '';
  for (let i = 0; i < 90; i++) {
    await sleep(380);
    const r = await p.run(stepJs(tries));
    if (r.closed) { bad.push('the guide closed by itself'); break; }
    if (r.wait) continue;
    if (r.title !== last) { tries = 0; last = r.title; seen.push(r.title); } else tries++;
    if (SHOTS && shotAt.includes(r.title) && tries === 0) { await sleep(300); await p.shot(path.join(SHOTS, `${label}-${seen.length}.png`)); }
    for (const pr of r.problems || []) bad.push(`${r.title}: ${pr}`);
    if (r.end) break;
    if (tries > 5) { bad.push(`stuck at “${r.title}”`); break; }
  }
  assert.deepEqual(bad, [], `Guide “${id}” had problems:\n  ` + bad.join('\n  '));
  if (seen[seen.length - 1] !== 'Well done!') console.log('  steps seen:', seen.slice(0, 14).join(' | '));
  ok(seen[seen.length - 1] === 'Well done!', `guide “${id}” ran to the end (${seen.length - 1} steps)`);
  if (SHOTS) { await sleep(300); await p.shot(path.join(SHOTS, `${label}-end.png`)); }
  await p.run('Tour.stop();');
  return seen;
}

async function join(name, { owner = false, who, pin, width = 1280, height = 800 } = {}) {
  fs.rmSync(profile(name), { recursive: true, force: true });
  const b = await openBrowser({ profile: profile(name), width, height });
  const p = b.page;
  p.run = (code) => p.js(H + code);
  await p.goto(BASE + '/', 1500);
  await p.run("await until(() => document.querySelector('#cShop'), 30000);");
  if (owner) {
    await p.run(`click('#cOwner'); await sleep(200);
      set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button');
      await until(() => document.querySelector('.people'), 60000);`);
  } else {
    await p.run(`click('#cShop'); await sleep(200); set('#f [name=login]', ${JSON.stringify(demo.logins[who].login)}); set('#f [name=password]', ${JSON.stringify(demo.logins[who].password)});
      click('#f button'); await until(() => document.querySelector('.people'), 30000);`);
  }
  await p.run(`click([...document.querySelectorAll('.person')].find((x) => x.textContent.includes(${JSON.stringify(who)})));
    await sleep(200); for (const d of ${JSON.stringify(pin)}) click('.pin-pad [data-k="' + d + '"]');
    await until(() => document.querySelector('#shell')); await sleep(1500);`);
  return { b, p };
}

if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const before = await cloudCounts();
let b1, b2;
try {
  // ================= a shop counter (Ahmed) =================
  ({ b: b1 } = await join('shop', { who: 'Ahmed', pin: demo.pins.Ahmed }));
  const p = b1.page;
  await p.js('location.hash = "#/training"');
  await sleep(1200);
  const guides = await p.run(`return [...document.querySelectorAll('[data-guide]')].map((b) => b.dataset.guide);`);
  ok(guides.includes('sell') && guides.includes('receive') && !guides.includes('purchase') && !guides.includes('owner'), 'Training lists only what this shop may do: ' + guides.join(', '));
  if (SHOTS) await p.shot(path.join(SHOTS, 'training-list.png'));
  const localSales = () => p.run(`return (await GET('/api/sales', { from: '2000-01-01', to: '2100-01-01' })).length;`);
  const salesBefore = await localSales();

  await drive(p, 'overview', { shotAt: ['Sale order', 'More', 'Is everything saved?'] });
  ok(!(await p.run('return Practice.on;')), 'the overview needs no practice mode');
  await drive(p, 'sell', { shotAt: ['Find the item', 'Pick the item', 'Cash received', 'Finish the sale'] });
  ok(await p.run('return Practice.on && !!document.querySelector("#practiceBar");'), 'practice mode is on, with the orange bar');
  ok(await p.run(`return document.querySelector('#syncPill').textContent === 'Practice mode';`), 'the top bar says Practice mode');
  ok((await localSales()) === salesBefore + 1, 'the practice bill was really made on this device');
  await drive(p, 'return', { shotAt: ['Money back'] });
  await drive(p, 'receive', { shotAt: ['A parcel is waiting', 'Confirm'] });
  await drive(p, 'stock');
  ok((await cloudCounts()).sales === before.sales, 'nothing from practice reached the cloud');

  // mobile width: text box and arrow stay on the screen
  await p.resize(390, 780, true);
  await p.run('location.hash = "#/training"; await sleep(500);');
  await drive(p, 'overview', { shotAt: ['Sale order', 'Is everything saved?'], label: 'phone' });
  await p.resize(1280, 800, false);

  // finish: everything goes
  await p.run('Practice.finishAsk(); await until(() => document.querySelector("#cOk")); click("#cOk");');
  await sleep(3500); // (Velanzo reloads, so it asks for the passcode)
  await p.run(`await until(() => document.querySelector('.pin-pad')); for (const d of ${JSON.stringify(demo.pins.Ahmed)}) click('.pin-pad [data-k="' + d + '"]'); await until(() => document.querySelector('#shell')); await sleep(500);`);
  ok(!(await p.run('return Practice.on || App.practice || !!document.getElementById("practiceBar");')), 'after finishing: practice is off and the bar is gone');
  ok((await p.run(`return (await GET('/api/products', { q: 'DEMO' })).length;`)) === 0, 'no DEMO items left');
  ok((await localSales()) === salesBefore, 'the practice bill is gone: as if it never happened');
  ok((await p.run(`return (await GET('/api/dispatches', { status: 'in_transit' })).every((d) => !/DEMO/.test(d.notes || ''));`)), 'no DEMO parcel left');
  await b1.close(); b1 = null;

  // ================= the owner =================
  ({ b: b2 } = await join('owner', { owner: true, who: 'Owner', pin: demo.owner_pin }));
  const o = b2.page;
  await o.js('location.hash = "#/training"');
  await sleep(1200);
  const og = await o.run(`return [...document.querySelectorAll('[data-guide]')].map((b) => b.dataset.guide);`);
  ok(og.includes('purchase') && og.includes('newitem') && og.includes('send') && og.includes('owner') && !og.includes('receive'), 'the owner sees: ' + og.join(', '));
  const products = () => o.run(`return (await GET('/api/products', { all: 1, active: 'all' })).length;`);
  const pBefore = await products();
  await drive(o, 'overview', { shotAt: ['More', 'Home'] });
  await drive(o, 'purchase', { shotAt: ['Who sent it?', 'How many arrived?', 'Save it', 'Now the labels'] });
  await drive(o, 'newitem', { shotAt: ['Sizes', 'Labels'] });
  await drive(o, 'send', { shotAt: ['Add the items', 'Send it'] });
  await drive(o, 'owner', { shotAt: ['The switches', 'Add a person'] });
  ok((await products()) > pBefore, 'the new DEMO items exist during practice');
  await o.run('Practice.finishAsk(); await until(() => document.querySelector("#cOk")); click("#cOk");');
  await sleep(3500);
  await o.run(`await until(() => document.querySelector('.pin-pad')); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]'); await until(() => document.querySelector('#shell')); await sleep(500);`);
  ok((await products()) === pBefore, 'owner: all practice items removed again');
  ok((await o.run(`return (await GET('/api/purchases', { from: '2000-01-01' })).every((x) => !/DEMO/.test(x.invoice_no || ''));`)), 'owner: no DEMO purchase left');
  const after = await cloudCounts();
  // (the two test computers that joined are the only new things; their own device rows are not practice)
  const strip = (c) => JSON.stringify(Object.entries(c).filter(([k]) => k !== 'devices').sort());
  if (strip(after) !== strip(before)) console.log('  before', JSON.stringify(before), '\n  after ', JSON.stringify(after));
  ok(strip(after) === strip(before), 'the cloud has nothing from the training: same bills, items, purchases and parcels as before');
  console.log(`\nAll ${checks} training checks passed.`);
} finally {
  if (b1) await b1.close();
  if (b2) await b2.close();
}
process.exit(0);
