// Takes the pictures of every screen for the user guide (web/manual/img/*.webp), on the local preview
// filled by tools/demo-data.mjs. Each "device" (owner laptop, Shop 1 counter, warehouse PC, owner phone) is its
// own headless browser with its own saved data, set up through the real screens.
//   node --disable-warning=ExperimentalWarning tools/screenshots.mjs [only-these-names…]
// Also: --out DIR (default web/manual/img), --png (PNG instead of WebP, for checking).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, sleep } from './shot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev-cloud', 'demo.json'), 'utf8'));
const BASE = demo.base;
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = opt('out', path.join(ROOT, 'web', 'manual', 'img'));
const EXT = args.includes('--png') ? 'png' : 'webp';
const only = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const want = (name) => !only.length || only.includes(name);
const PROFILES = path.join(os.tmpdir(), 'velanzo-shot-profiles');
fs.rmSync(PROFILES, { recursive: true, force: true });

async function ownerToken() {
  const r = await fetch(`${BASE}/cloud/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: demo.owner_email, password: demo.owner_password }) });
  return (await r.json()).access_token;
}

// ---------- page helpers (run inside the page) ----------
const H = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out waiting'); };
  const set = (sel, v) => { const e = document.querySelector(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
  const pin = async (name, digits) => { click(await until(() => byText('.person', name))); await sleep(150); for (const d of digits + 'k') click(document.querySelector('.pin-pad [data-k="' + (d === 'k' ? 'ok' : d) + '"]')); await until(() => document.querySelector('#view')); await sleep(900); };
  const scan = (code) => { const s = document.querySelector('#scan'); s.focus(); s.value = code; s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
  const clean = () => document.querySelectorAll('.toast').forEach((t) => t.remove());
  const paper = async (body, css, w, h) => {
    const o = document.createElement('div'); o.id = 'paperView';
    o.style.cssText = 'position:fixed;inset:0;background:#e4e6eb;z-index:999;display:flex;justify-content:center;align-items:flex-start;padding:28px';
    const f = document.createElement('iframe');
    f.style.cssText = 'width:' + w + 'px;height:' + h + 'px;border:0;background:#fff;box-shadow:0 6px 30px rgba(0,0,0,.18)';
    f.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' + body + '</body></html>';
    o.appendChild(f); document.body.appendChild(o); await sleep(700);
    f.style.height = '60px'; await sleep(100); f.style.height = (f.contentDocument.documentElement.scrollHeight + 16) + 'px'; await sleep(150);
  };
  const unpaper = () => { const o = document.getElementById('paperView'); if (o) o.remove(); };
`;

async function newDevice(name, { width = 1366, height = 800, mobile = false } = {}) {
  const b = await openBrowser({ profile: path.join(PROFILES, name), width, height, mobile, scale: mobile ? 2 : 1 });
  const p = b.page;
  p.run = (code) => p.js(H + code);
  p.go = async (hash, wait = 1300) => { await p.run(`location.hash = ${JSON.stringify(hash)};`); await sleep(wait); };
  p.snap = async (file, o = {}) => { if (!want(file)) return; await p.run('clean();'); await sleep(150); await p.shot(path.join(OUT, `${file}.${EXT}`), o); console.log('  ' + file); };
  return { b, p };
}

// The area around the printed paper, for a tight picture.
const cardClip = (p) => p.js("const b = document.querySelector('.login-card').getBoundingClientRect(); return { x: Math.max(0, b.x - 40), y: Math.max(0, b.y - 30), width: b.width + 80, height: b.height + 60 };");
const paperClip = (p) => p.js("const b = document.querySelector('#paperView iframe').getBoundingClientRect(); return { x: Math.max(0, b.x - 24), y: Math.max(0, b.y - 18), width: b.width + 48, height: b.height + 40 };");

fs.mkdirSync(OUT, { recursive: true });

// ---------- Shop 1 counter ----------
{
  const { b, p } = await newDevice('shop');
  await p.goto(BASE + '/', 2500);
  await p.snap('welcome', { clip: await cardClip(p) });
  await p.run(`click('#cShop'); await sleep(200); set('#f [name=login]', ${JSON.stringify(demo.logins.Ahmed.login)}); set('#f [name=password]', ${JSON.stringify(demo.logins.Ahmed.password)});`);
  await p.snap('join-code', { clip: await cardClip(p) });
  await p.run(`click('#f button.primary'); await until(() => document.querySelector('.pin-pad'), 40000); await sleep(500);`);
  await p.snap('who-is-working', { clip: await cardClip(p) });
  await p.run(`for (const d of '22') click(document.querySelector('.pin-pad [data-k="' + d + '"]'));`);
  await p.snap('pin', { clip: await cardClip(p) });
  await p.run(`for (const d of '22') click(document.querySelector('.pin-pad [data-k="' + d + '"]')); await until(() => document.querySelector('#scan')); await sleep(1500);`);
  await p.run(`const list = ProductCache.list.filter((x) => x.loc_qty > 1); scan(list[0].barcode); await sleep(400); scan(list[3].barcode); await sleep(400); scan(list[0].barcode); await sleep(400); set('#paid', '11000'); await sleep(300);`);
  await p.snap('sell-cart');
  await p.run(`click('#doneBtn'); await until(() => document.querySelector('.modal-wrap')); await sleep(500);`);
  await p.snap('sell-done');
  const billNo = await p.run("return document.querySelector('.modal-head h3').textContent.split(' ')[1];");
  await p.run(`const s = await GET('/api/sales/by-bill/' + ${JSON.stringify(billNo)}); await paper(billHtml(s), receiptCss(), 330, 744);`);
  await p.snap('print-bill', { clip: await paperClip(p) });
  await p.run('unpaper();');
  await p.run(`click('#mNew'); await sleep(300); click('#retBtn'); await sleep(200); scan(ProductCache.list.find((x) => x.loc_qty > 1).barcode); await sleep(400); click('#retBtn'); await sleep(200); scan(ProductCache.list.filter((x) => x.loc_qty > 1)[2].barcode); await sleep(400);`);
  await p.snap('sell-exchange');
  await p.run(`click('#clearBtn'); await sleep(300); const ok = document.querySelector('#cOk'); if (ok) ok.click(); await sleep(300);`);
  await p.go('#/sales');
  await p.snap('bills');
  await p.go('#/dispatch');
  await p.snap('receive-list');
  await p.run(`const a = document.querySelector('a[href*="/receive"]'); if (a) { a.click(); await sleep(1500); }`);
  await p.snap('receive-check', { full: true });
  await p.go('#/stock');
  await b.close();
}

// ---------- Warehouse PC ----------
{
  const { b, p } = await newDevice('warehouse');
  await p.goto(BASE + '/', 2500);
  await p.run(`click('#cShop'); await sleep(200); set('#f [name=login]', ${JSON.stringify(demo.logins.Bilal.login)}); set('#f [name=password]', ${JSON.stringify(demo.logins.Bilal.password)}); click('#f button.primary'); await until(() => document.querySelector('.pin-pad'), 40000); for (const d of '1111') click('.pin-pad [data-k="' + d + '"]');`);
  await p.snap('warehouse-home');
  await p.go('#/purchases');
  await p.snap('purchases');
  await p.go('#/purchases/new', 1800);
  await p.run(`const sel = document.querySelector('[name=supplier_id]'); if (sel) { sel.value = sel.options[1].value; sel.dispatchEvent(new Event('change', { bubbles: true })); } const list = ProductCache.list; for (const i of [0, 1, 2]) { scan(list[i].barcode); await sleep(300); }`);
  await p.snap('purchase-new');
  await p.go('#/labels', 1500);
  await p.snap('labels');
  await p.run(`const list = ProductCache.list.length ? ProductCache.list : await GET('/api/products');
    const sheet = list.slice(0, 6).map((x) => labelHtml(x)).join('');
    await paper('<div style="display:flex;flex-wrap:wrap;gap:12px;padding:16px">' + sheet + '</div>', labelCss().replace(/page-break-after: always; break-after: page;/g, '') + ' .label{outline:1px dashed #bbb}', 640, 300);`);
  await p.snap('print-labels', { clip: await paperClip(p) });
  await p.run('unpaper();');
  await p.go('#/dispatch/new', 1800);
  await p.run(`const list = ProductCache.list.filter((x) => x.loc_qty > 2); for (const i of [0, 1, 2, 0]) { scan(list[i].barcode); await sleep(300); }`);
  await p.snap('dispatch-new');
  await p.go('#/dispatch');
  await p.snap('dispatch-list');
  await p.go('#/products');
  await p.snap('items');
  await b.close();
}

// ---------- Owner laptop ----------
{
  const { b, p } = await newDevice('owner');
  await p.goto(BASE + '/', 2500);
  await p.run(`click('#cOwner'); await sleep(200);`);
  await p.snap('owner-signin', { clip: await cardClip(p) });
  await p.run(`set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of '1234') click('.pin-pad [data-k="' + d + '"]'); await sleep(1500);`);
  await p.snap('owner-home');
  await p.go('#/activity');
  await p.snap('activity');
  await p.go('#/reports', 1600);
  await p.snap('reports');
  await p.go('#/stock');
  await p.snap('stock');
  await p.go('#/settings/locations');
  await p.snap('settings-shops');
  await p.run(`click('.place-card:nth-child(2)'); await sleep(500);`);
  await p.snap('settings-shop-switches');
  await p.run(`document.querySelector('.modal-wrap [data-close]').click(); await sleep(200);`);
  await p.go('#/settings/users');
  await p.snap('settings-people');
  await p.run(`click(byText('tbody tr', 'Sara')); await sleep(500);`);
  await p.snap('settings-person');
  await p.run(`document.querySelector('.modal-wrap [data-close]').click(); await sleep(200);`);
  await p.run(`click('#add'); await sleep(500);`);
  await p.snap('settings-device-code');
  await p.run(`document.querySelector('.modal-wrap [data-close]').click(); await sleep(200);`);
  await p.run(`document.querySelector('.modal-wrap [data-close]').click(); await sleep(200);`);
  await p.go('#/settings/business');
  await p.snap('settings-business');
  await p.go('#/settings/printing');
  await p.snap('settings-printing');
  await p.go('#/settings/backup');
  await p.snap('settings-backup');
  await p.go('#/device');
  await p.snap('this-device');
  await b.close();
}

// ---------- Owner phone ----------
{
  const { b, p } = await newDevice('phone', { width: 390, height: 844, mobile: true });
  await p.goto(BASE + '/', 2500);
  await p.run(`click('#cOwner'); await sleep(200); set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of '1234') click('.pin-pad [data-k="' + d + '"]'); await sleep(1500);`);
  await p.snap('phone-home');
  await b.close();
}
console.log('done →', OUT);
process.exit(0);
