// In a real (headless) browser: a USB barcode scanner (keys typed a few ms apart, then Enter or Tab) on the sale
// screen — into the scan box, the cash box, a button, a quantity box, the "Bill saved" window — plus UPC/EAN codes
// and an unknown code. Then the printed barcodes are drawn at printer resolution (203 and 300 dpi) and read back,
// and the label and bill pages are printed to PDF to check their size and page count.
// Needs the preview with demo data:  node --disable-warning=ExperimentalWarning tools/test-scanner-print-browser.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, sleep } from './shot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, '.dev-cloud', 'demo.json'), 'utf8'));
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };

const H = `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(100); } throw new Error('timed out'); };
  const click = (sel) => { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) throw new Error('missing ' + sel); e.click(); };
  const set = (s, v) => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
  const lines = () => [...document.querySelectorAll('.cart-row')].map((r) => ({ name: r.querySelector('.iname').textContent.replace('Back', '').trim(), qty: +r.querySelector('[data-qty]').value }));`;

const dir = path.join(os.tmpdir(), 'velanzo-test-scanner');
fs.rmSync(dir, { recursive: true, force: true });
const b = await openBrowser({ profile: dir, width: 1280, height: 900 });
const p = b.page;
const run = (code) => p.js(H + code);
// a USB scanner: each character a few ms apart (real key presses, not page script), then Enter or Tab
const KEY = { '-': ['Minus', 189] };
async function scanner(code, { gap = 6, end = 'Enter' } = {}) {
  for (const ch of code) {
    const [c, vk] = KEY[ch] || [/\d/.test(ch) ? 'Digit' + ch : 'Key' + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0)];
    await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: c, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
    await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: c, windowsVirtualKeyCode: vk });
    if (gap) await sleep(gap);
  }
  const [k, vk, text] = end === 'Tab' ? ['Tab', 9, ''] : ['Enter', 13, '\r'];
  await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk, text });
  await p.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk });
  await sleep(1200);
}
try {
  await p.goto(demo.base + '/', 1500);
  await run(`await until(() => document.querySelector('#cOwner'), 30000); click('#cOwner'); await sleep(200);
    set('#f [name=email]', ${JSON.stringify(demo.owner_email)}); set('#f [name=password]', ${JSON.stringify(demo.owner_password)}); click('#f button.primary');
    await until(() => document.querySelector('.pin-pad'), 60000); for (const d of ${JSON.stringify(demo.owner_pin)}) click('.pin-pad [data-k="' + d + '"]');
    await until(() => document.querySelector('#shell')); await sleep(1200);`);
  // two items in stock at the shop, and two items with supermarket-style codes
  const items = await run(`await ProductCache.load(${demo.shop_location}, true); return ProductCache.list.filter((q) => q.loc_qty > 4 && q.sale_price > 0).slice(0, 2).map((q) => ({ barcode: q.barcode, name: q.name }));`);
  await run(`await POST('/api/products', { name: 'EAN Test', cost_price: 50, sale_price: 100, opening_location_id: ${demo.shop_location}, variants: [{ barcode: '0123456789012', opening_qty: 5 }] });
    await POST('/api/products', { name: 'UPC Test', cost_price: 50, sale_price: 100, opening_location_id: ${demo.shop_location}, variants: [{ barcode: '987654321098', opening_qty: 5 }] }); ProductCache.invalidate();`);
  await run(`localStorage.setItem('vz_pos_loc', '${demo.shop_location}'); location.hash = '#/sale-reset'; await sleep(200); location.hash = '#/pos'; await until(() => document.querySelector('#scan')); await ProductCache.load(${demo.shop_location}, true); await sleep(600);`);

  await scanner(items[0].barcode);
  let L = await run('return lines();');
  ok(L.length === 1 && L[0].name.includes(items[0].name), 'scan into the scan box: the item is on the bill');

  await run(`document.querySelector('#paid').focus();`);
  await scanner(items[1].barcode);
  L = await run('return lines();');
  ok(L.length === 2 && await run(`return document.querySelector('#paid').value === '' && !document.querySelector('.modal-wrap');`), 'scan while the cursor is in “Cash received”: the item goes on the bill, the cash box stays empty and the bill is NOT finished');

  await run(`document.querySelector('#methods [data-m=card]').focus();`);
  await scanner(items[0].barcode);
  L = await run('return lines();');
  ok(L[0].qty === 2 && await run(`return !document.querySelector('.modal-wrap');`), 'scan while a button has the focus: +1 on the bill, no button pressed');

  await run(`document.querySelector('.cart-row [data-qty]').focus();`);
  await scanner(items[0].barcode);
  L = await run('return lines();');
  ok(L[0].qty === 3, 'scan while the cursor is in a quantity box: +1, the quantity box is not filled with the barcode');

  await run(`document.querySelector('#scan').focus();`);
  await scanner(items[1].barcode, { end: 'Tab' });
  L = await run('return lines();');
  ok(L[1].qty === 2, 'a scanner that ends with Tab instead of Enter works too');

  // an unknown code that looks like a real one (one digit different)
  const fake = await run(`const c = ${JSON.stringify(items[0].barcode)}; for (let d = 1; d < 10; d++) { const f = c.slice(0, 2) + String((+c[2] + d) % 10) + c.slice(3); if (!ProductCache.byCode.has(f)) return f; } return null;`);
  const fakeExists = !fake;
  if (!fakeExists) {
    await run(`document.querySelector('#scan').focus();`);
    await scanner(fake, { gap: 120 }); // a slow scanner: the suggestion list opens half way
    L = await run('return lines();');
    ok(L.length === 2 && L[0].qty === 3 && L[1].qty === 2 && await run(`return /No item found/.test(document.querySelector('#toasts').innerText);`), 'an unknown code (one digit different) adds nothing and says “No item found”, even from a slow scanner');
  }

  await run(`document.querySelector('#scan').focus();`);
  await scanner('123456789012');
  await scanner('0987654321098');
  L = await run('return lines();');
  ok(L.some((l) => l.name.includes('EAN Test')) && L.some((l) => l.name.includes('UPC Test')), 'a 13-digit code scanned as 12 digits (and the other way round) finds the item');

  // finish the bill; on "Bill saved" the next customer's first scan starts the new bill
  await run(`click('#doneBtn'); await sleep(900); if (document.querySelector('#wGo')) click('#wGo'); await until(() => document.querySelector('#mNew'));`);
  await scanner(items[1].barcode);
  L = await run('return lines();');
  ok(L.length === 1 && L[0].name.includes(items[1].name) && await run(`return !document.querySelector('.modal-wrap');`), '“Bill saved” window: the next scan closes it and starts the new bill with that item');
  await run(`localStorage.removeItem('vz_cart_' + App.user.id); click('#clearBtn'); await sleep(300); if (document.querySelector('#cOk')) click('#cOk');`);

  // ---- Hardware page: the scanner test, per-computer printer settings, the print queue ----
  await run(`location.hash = '#/hardware'; await until(() => document.querySelector('#scanTest')); document.querySelector('#scanTest').focus();`);
  await scanner(items[0].barcode);
  ok(await run(`const t = document.querySelector('#scanRes').innerText; return t.includes(${JSON.stringify(items[0].barcode)}) && /a scanner ✓/.test(t) && /Enter ✓/.test(t) && t.includes(${JSON.stringify(items[0].name)});`), 'the scanner test on the Hardware page shows the code, “a scanner ✓”, “Enter ✓” and the item');
  await run(`document.querySelector('#scanTest').focus();`);
  await scanner(items[0].barcode, { end: 'Tab' });
  ok(await run(`return /Tab ✓/.test(document.querySelector('#scanRes').innerText);`), 'and tells when a scanner ends with Tab');

  // printer settings belong to this computer: saved in the device, not in the business settings
  await run(`set('#fb [name=bill_mm]', '64'); set('#fb [name=bill_left]', '1'); click('#fb button.primary'); await sleep(900);`);
  ok(await run(`const me = await GET('/api/me'); const biz = await GET('/api/settings'); return me.device.print.bill_mm === '64' && me.device.print.bill_left === '1' && App.settings.bill_mm === '64' && !biz.bill_mm;`), 'printer settings are saved on this computer only (the business settings do not change)');
  await run(`set('#fl [name=label_width]', '40'); set('#fl [name=label_height]', '30'); click('#fl button.primary'); await sleep(900);`);
  ok(await run(`return (await GET('/api/me')).device.print.label_width === '40' && labelCss().includes('40mm 30mm');`), 'the sticker size is saved on this computer and used by the labels');
  ok(await run(`return !!document.querySelector('#dlCheck') && !!document.querySelector('#dlFix') && document.querySelectorAll('.cmd-row').length >= 8 && document.body.innerText.includes('BlackCopper 80mm Printer Driver.exe') && document.body.innerText.includes('d2910ad801d507da');`), 'the Hardware page has the tools, the commands and the driver with its SHA-256');
  await run(`window.print = () => {}; PrintLog.save([]); click('#testBill'); await sleep(500); click('#testLbl'); await sleep(500);`);
  ok(await run(`const l = PrintLog.all(); return l.length === 2 && l[0].queue === 'label' && l[1].queue === 'receipt' && l[1].title === 'TEST-00001' && !!l[1].body;`), 'a printed bill and a label go in the print log of this computer, each in its own queue');
  await run(`location.hash = '#/hardware/queue'; await until(() => document.querySelector('[data-again]')); await sleep(300);`);
  ok(await run(`return document.querySelectorAll('[data-again]').length === 2 && /Receipt printer/.test(document.body.innerText) && /Barcode label printer/.test(document.body.innerText);`), 'the Print queue page lists both queues with a Print again button');
  await run(`document.querySelector('[data-again]').click(); await sleep(600);`);
  ok(await run(`const l = PrintLog.all(); return l.length === 3 && l[0].reprint === true;`), 'Print again sends the same page once more');
  await run(`const a = HwScripts.checkBat(), b = HwScripts.fixBat(); window.__scripts = { a, b }; PrintLog.save([]); App.settings.bill_mm = ''; App.settings.bill_left = ''; await savePrintSettings({ bill_mm: '', bill_left: '', label_width: '50', label_height: '25' });`);
  ok(await run(`const { a, b } = window.__scripts; return !/[^\\x00-\\x7f]/.test(a + b) && a.includes('#PS#') && b.includes('Verb RunAs') && a.includes('\\r\\n');`), 'the Windows scripts are plain ASCII .bat files (the fix one asks for administrator permission)');

  // ---- printed barcodes, read back at printer resolution ----
  await run(`window.__decode = (svgText, pxPerMm) => new Promise((resolve) => {
      const P = Barcode.PATTERNS;
      const wmm = parseFloat(svgText.match(/width:([\\d.]+)mm/)[1]);
      const W = Math.round(wmm * pxPerMm), Hh = 40;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = W; c.height = Hh;
        const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, W, Hh);
        const row = g.getImageData(0, 20, W, 1).data;
        const dark = []; for (let x = 0; x < W; x++) dark.push(row[x * 4] < 128);
        const a = dark.indexOf(true), z = dark.lastIndexOf(true);
        const runs = []; let cur = dark[a], n = 0;
        for (let x = a; x <= z; x++) { if (dark[x] === cur) n++; else { runs.push(n); cur = dark[x]; n = 1; } }
        runs.push(n);
        const nsym = (runs.length - 7) / 6;
        const unit = runs.reduce((s, r) => s + r, 0) / (nsym * 11 + 13);
        const w = runs.map((r) => Math.max(1, Math.min(4, Math.round(r / unit)))).join('');
        const syms = []; for (let i = 0; i < w.length;) { const len = w.length - i === 7 ? 7 : 6; syms.push(P.indexOf(w.slice(i, i + len))); i += len; }
        if (syms.includes(-1) || syms.pop() !== 106) return resolve(null);
        const check = syms.pop(); let sum = syms[0]; for (let k = 1; k < syms.length; k++) sum += syms[k] * k;
        if (sum % 103 !== check) return resolve(null);
        let set = { 103: 'A', 104: 'B', 105: 'C' }[syms[0]], out = '';
        for (const v of syms.slice(1)) { if (set === 'C') { if (v === 100) set = 'B'; else out += String(v).padStart(2, '0'); } else out += String.fromCharCode(v + 32); }
        resolve({ out, unit });
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText.replace(/ style="[^"]*"/, ' width="' + W + '" height="' + Hh + '"'));
    });`);
  const cases = [['20100015', 47], ['20400001', 35], ['8964000123457', 47], ['S1-E0001', 72], ['S1-E0001', 48], ['D-A0012', 72]];
  for (const dpi of [203, 300]) {
    const pxPerMm = dpi / 25.4;
    for (const [code, width] of cases) {
      const r = await run(`const m = Barcode.fit(${JSON.stringify(code)}, ${width}); return await __decode(Barcode.svg(${JSON.stringify(code)}, { moduleMm: m }), ${pxPerMm});`);
      ok(r && r.out === code, `printed at ${dpi} dpi on ${width} mm: “${code}” reads back (${r ? (r.unit / pxPerMm).toFixed(3) : '?'} mm per bar unit)`);
    }
  }

  // ---- the label and bill pages ----
  const docs = await run(`App.settings.label_mode = 'roll'; App.settings.label_width = '50'; App.settings.label_height = '25';
    const ps = ProductCache.list.slice(0, 2).concat([ProductCache.list.find((x) => x.barcode === '0123456789012')]);
    const labels = '<!doctype html><html><head><meta charset="utf-8"><style>' + labelCss() + '</style></head><body>' + ps.map((x) => labelHtml(x)).join('') + '</body></html>';
    const sale = (await GET('/api/sales', { from: '2000-01-01' }))[0];
    const s = await GET('/api/sales/' + sale.id);
    App.settings.bill_width = '80';
    const bill = '<!doctype html><html><head><meta charset="utf-8"><style>' + receiptCss() + '</style></head><body>' + billHtml(s) + '</body></html>';
    App.settings.bill_mm = '64'; App.settings.bill_left = '1';
    const narrow = '<!doctype html><html><head><meta charset="utf-8"><style>' + receiptCss() + '</style></head><body>' + billHtml(s) + '</body></html>';
    App.settings.bill_mm = ''; App.settings.bill_left = '';
    return { labels, bill, narrow, count: ps.length };`);
  await p.cdp.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(docs.labels).toString('base64') });
  await sleep(800);
  const fits = await p.js(`return [...document.querySelectorAll('.label')].map((l) => { const r = l.getBoundingClientRect(), s = l.querySelector('svg').getBoundingClientRect(); return { w: r.width / 3.7795, h: r.height / 3.7795, bw: s.width / 3.7795, bh: s.height / 3.7795, over: l.scrollHeight > l.clientHeight + 1 }; });`);
  ok(fits.every((f) => Math.abs(f.w - 50) < 0.2 && Math.abs(f.h - 25) < 0.2 && !f.over), 'each label is 50 × 25 mm and nothing spills over: ' + fits.map((f) => `barcode ${f.bw.toFixed(1)}×${f.bh.toFixed(1)} mm`).join(', '));
  ok(fits.every((f) => f.bh >= 6), 'every barcode is at least 6 mm tall (enough for any scanner)');
  let pdf = Buffer.from((await p.cdp.send('Page.printToPDF', { preferCSSPageSize: true, printBackground: true })).data, 'base64').toString('latin1');
  const pages = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const box = pdf.match(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/);
  ok(pages === docs.count && box && Math.abs(+box[1] - 141.7) < 1.5 && Math.abs(+box[2] - 70.9) < 1.5, `labels print one per page, ${pages} pages of ${box ? (+box[1] / 2.8346).toFixed(1) + ' × ' + (+box[2] / 2.8346).toFixed(1) : '?'} mm`);
  await p.cdp.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(docs.bill).toString('base64') });
  await sleep(800);
  const bill = await p.js(`const b = document.body.getBoundingClientRect(), s = document.querySelector('.bc svg').getBoundingClientRect(); return { w: b.width / 3.7795, bw: s.width / 3.7795, bh: s.height / 3.7795 };`);
  ok(Math.abs(bill.w - 72) < 0.3 && bill.bw <= 72 && bill.bh >= 9, `the 80 mm bill prints 72 mm wide with its barcode ${bill.bw.toFixed(1)} × ${bill.bh.toFixed(1)} mm`);
  // a printer that prints less than its paper: Print width 64 mm, 1 mm from the left
  await p.cdp.send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(docs.narrow).toString('base64') });
  await sleep(800);
  const narrow = await p.js(`const r = document.body.getBoundingClientRect(), b = document.querySelector('.bc svg').getBoundingClientRect(), t = [...document.querySelectorAll('td')].reduce((m, x) => Math.max(m, x.getBoundingClientRect().right), 0); return { left: r.left / 3.7795, w: r.width / 3.7795, bw: b.width / 3.7795, right: Math.max(r.right, t) / 3.7795 };`);
  ok(Math.abs(narrow.w - 64) < 0.3 && Math.abs(narrow.left - 1) < 0.3 && narrow.right <= 65.3 && narrow.bw <= 64, `print width 64 mm, 1 mm from the left: everything stays inside 65 mm (right edge at ${narrow.right.toFixed(1)} mm)`);
  pdf = Buffer.from((await p.cdp.send('Page.printToPDF', { paperWidth: 80 / 25.4, paperHeight: 297 / 25.4, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 })).data, 'base64').toString('latin1');
  ok(((pdf.match(/\/Type\s*\/Page[^s]/g) || []).length) === 1, 'a bill fits on one receipt page');
  console.log(`\nAll ${checks} scanner and printing checks passed.`);
} finally {
  await b.close();
}
process.exit(0);
