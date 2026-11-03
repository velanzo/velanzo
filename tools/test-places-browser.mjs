// In a real (headless) browser, as the owner: delete an empty warehouse, get a clear message for a place that is in use,
// and the Barcodes menu name. Needs the preview with demo data:
//   node --disable-warning=ExperimentalWarning tools/test-places-browser.mjs
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
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const go = async (h) => { location.hash = h; await sleep(900); };`;
const dir = path.join(os.tmpdir(), 'velanzo-test-places');
fs.rmSync(dir, { recursive: true, force: true });
const b = await openBrowser({ profile: dir, width: 1280, height: 900 });
const run = (code) => b.page.js(H + code);
try {
  await b.page.goto(demo.base + '/', 1500);
  await run(`await until(() => document.querySelector('#cOwner'), 30000); click('#cOwner'); await sleep(200);
    set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]');
    await until(() => document.querySelector('#shell')); await sleep(1200);`);
  ok(await run(`return [...document.querySelectorAll('nav a, #nav a, .more a')].some((a) => a.textContent.trim() === 'Barcodes') && ![...document.querySelectorAll('nav a, #nav a, .more a')].some((a) => a.textContent.trim() === 'Labels');`), 'the menu says Barcodes (not Labels)');

  await run(`await go('#/settings/locations'); await until(() => document.querySelector('#add')); click('#add'); await until(() => document.querySelector('[name=name]'));
    set('[name=name]', 'Spare warehouse'); set('[name=code]', 'W9'); set('[name=type]', 'warehouse'); click('#ls'); await until(() => [...document.querySelectorAll('.place-card')].some((c) => /Spare warehouse/.test(c.textContent)));`);
  await run(`click([...document.querySelectorAll('.place-card')].find((c) => /Spare warehouse/.test(c.textContent))); await until(() => document.querySelector('#lDel')); click('#lDel');
    await until(() => document.querySelector('#cOk')); click('#cOk'); await until(() => ![...document.querySelectorAll('.place-card')].some((c) => /Spare warehouse/.test(c.textContent)));`);
  ok(true, 'an empty warehouse is deleted from Settings → Shops & warehouse');

  await run(`click([...document.querySelectorAll('.place-card')].find((c) => /Shop 1/.test(c.textContent))); await until(() => document.querySelector('#lDel')); click('#lDel');
    await until(() => document.querySelector('#cOk')); click('#cOk'); await sleep(800);`);
  ok(await run(`return /still has|history/.test(document.body.innerText) && [...document.querySelectorAll('.place-card')].some((c) => /Shop 1/.test(c.textContent));`), 'a place in use is not deleted and the message says why');
  console.log(`\nAll ${checks} place checks passed.`);
} finally { await b.close(); }
process.exit(0);
