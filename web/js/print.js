'use strict';
// Printing: customer bills (receipt printer), barcode labels (label printer or A4 sheet), dispatch notes.

// What this computer printed: kept on this computer (the last 60), with the page so it can be printed again.
// queue: 'receipt' (bills, dispatch receipts), 'label' (barcode labels) or 'paper' (A4 notes).
const PrintLog = {
  key: () => `vz_prints_${App.device?.id || 0}`,
  all() { try { return JSON.parse(localStorage.getItem(this.key()) || '[]'); } catch { return []; } },
  save(list) {
    // (newest first) the browser's storage is limited: if it is full, the oldest pages are dropped (the lines stay)
    for (let keep = list.length; keep >= 0; keep--) {
      try { localStorage.setItem(this.key(), JSON.stringify(list.map((e, i) => (i < keep ? e : { ...e, body: undefined, css: undefined })))); return; } catch { /* too big */ }
    }
  },
  add(e) {
    const list = this.all();
    const rec = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), at: nowStr(), user: App.user?.name || '', status: 'sending', ...e };
    if ((rec.body || '').length + (rec.css || '').length > 400000) { rec.body = undefined; rec.css = undefined; rec.big = true; }
    this.save([rec, ...list].slice(0, 60));
    return rec.id;
  },
  set(id, patch) { const list = this.all(); const e = list.find((x) => x.id === id); if (e) { Object.assign(e, patch); this.save(list); } },
  remove(id) { this.save(this.all().filter((x) => x.id !== id)); },
  clear(queue) { this.save(this.all().filter((x) => (queue ? x.queue !== queue : false))); },
  queueOf: (title, kind) => (kind === 'bill' ? 'receipt' : kind === 'label' || /^Barcode labels/.test(title) ? 'label' : 'paper'),
};

// Prints through the browser's print window (Chrome started with --kiosk-printing prints straight to the default printer).
// kind / pageSize say what is being printed: 'bill' (receipt), 'label' or 'a4'.
async function printDoc(bodyHtml, css, title = 'Print', kind = 'a4', pageSize, opts = {}) { // eslint-disable-line no-unused-vars
  const queue = PrintLog.queueOf(title, kind);
  const logId = opts.noLog ? 0 : PrintLog.add({ queue, kind, title, pageSize, body: bodyHtml, css, reprint: !!opts.reprint, pages: (bodyHtml.match(/class="label"/g) || []).length || 1 });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}</style></head><body>${bodyHtml}</body></html>`;
  const old = document.getElementById('printFrame');
  if (old) old.remove();
  const f = document.createElement('iframe');
  f.id = 'printFrame';
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(html);
  d.close();
  setTimeout(() => {
    // printing moves the cursor into the print page; bring it back, or the next barcode scan would be lost
    const prev = document.activeElement;
    const back = () => { window.focus(); if (prev && prev.isConnected && prev !== f) prev.focus(); };
    f.contentWindow.addEventListener('afterprint', () => { back(); if (logId) PrintLog.set(logId, { status: 'sent' }); });
    f.contentWindow.focus();
    try { f.contentWindow.print(); } catch (e) { if (logId) PrintLog.set(logId, { status: 'failed', error: String(e.message || e) }); }
    back();
    // (print() waits while the print window is open; a browser that never says "afterprint" is counted as sent a little later)
    if (logId) setTimeout(() => { const e = PrintLog.all().find((x) => x.id === logId); if (e && e.status === 'sending') PrintLog.set(logId, { status: 'sent' }); }, 3000);
  }, 200);
}

// ---------- Customer bill ----------
// How wide the printing really is. Normally 72 mm (80 mm paper) or 48 mm (58 mm paper); some printers print less than
// that (a roll narrower than the printer expects), so Settings → Bills & labels has "Print width" and "Space from the left".
function billMm() {
  const S = App.settings;
  const own = Number(S.bill_mm);
  return own >= 40 && own <= 80 ? own : S.bill_width === '58' ? 48 : 72;
}
function receiptCss() {
  const w = billMm();
  const left = App.settings.bill_left;
  const margin = left !== '' && left != null && Number.isFinite(Number(left)) ? `0 0 0 ${Math.max(0, Math.min(20, Number(left)))}mm` : '0 auto';
  return `@page { margin: 0; }
  * { box-sizing: border-box; }
  body { width: ${w}mm; margin: ${margin}; padding: 3mm 0 6mm; font: ${w < 60 ? 11 : 12}px/1.35 Arial, Helvetica, sans-serif; color: #000; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; }
  .biz { font-size: ${w < 60 ? 16 : 19}px; font-weight: 700; letter-spacing: .5px; }
  .hr { border-top: 1px dashed #000; margin: 5px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: inherit; }
  th { font-size: 10.5px; text-align: right; border-bottom: 1px solid #000; padding: 2px 0; }
  th:first-child { text-align: left; }
  td { padding: 1px 0; vertical-align: top; text-align: right; }
  td.item { text-align: left; padding-top: 4px; font-weight: 600; }
  td.sub { text-align: left; font-size: 10.5px; }
  .total { font-size: ${w < 60 ? 15 : 17}px; font-weight: 700; }
  .void { border: 2px solid #000; padding: 3px; text-align: center; font-weight: 700; font-size: 16px; margin: 4px 0; }
  .bc { display: flex; justify-content: center; margin-top: 4px; }
  .bc svg.stretch { width: 100%; height: 10mm; }
  .foot { white-space: pre-line; margin-top: 4px; }
  .ret { font-weight: 700; }`;
}

function billHtml(s) {
  const S = App.settings;
  const sold = s.items.filter((i) => i.qty > 0).reduce((a, i) => a + i.qty, 0);
  const returned = s.items.filter((i) => i.qty < 0).reduce((a, i) => a - i.qty, 0);
  const lines = s.items.map((i) => `
    <tr><td class="item" colspan="4">${esc(i.name)}${variantText(i) ? ' (' + esc(variantText(i)) + ')' : ''}${i.qty < 0 ? ' <span class="ret">[RETURN]</span>' : ''}</td></tr>
    <tr><td class="sub">${esc(i.barcode)}</td><td>${i.qty}</td><td>${num(i.list_price ?? i.price)}</td><td>${num(i.qty * (i.list_price ?? i.price))}</td></tr>${i.list_price != null ? `
    <tr><td class="sub" colspan="3">Discount (${num(i.list_price - i.price)} each)</td><td>- ${num(i.qty * (i.list_price - i.price))}</td></tr>` : ''}`).join('');
  return `
    <div class="c biz">${esc(S.business_name)}</div>
    ${s.location_address || S.business_address ? `<div class="c">${esc(s.location_address || S.business_address)}</div>` : ''}
    ${s.location_phone || S.business_phone ? `<div class="c">Ph: ${esc(s.location_phone || S.business_phone)}</div>` : ''}
    <div class="hr"></div>
    ${s.status === 'void' ? '<div class="void">CANCELLED BILL</div>' : ''}
    <div class="row"><span>Bill: <b>${esc(s.bill_no)}</b></span><span>${esc(fmtDate(s.created_at))}</span></div>
    <div class="row"><span>${esc(s.location_name)}</span><span>${esc(fmtTime(s.created_at))}</span></div>
    <div class="row"><span>Cashier: ${esc(s.user_name || '')}</span></div>
    ${s.customer_name || s.customer_phone ? `<div>Customer: ${esc(s.customer_name)} ${esc(s.customer_phone)}</div>` : ''}
    <div class="hr"></div>
    <table><thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${lines}</tbody></table>
    <div class="hr"></div>
    <div class="row"><span>Items</span><span>${sold}${returned ? ` sold, ${returned} returned` : ''}</span></div>
    <div class="row"><span>Subtotal</span><span>${num(s.subtotal)}</span></div>
    ${s.discount ? `<div class="row"><span>Discount</span><span>- ${num(s.discount)}</span></div>` : ''}
    ${s.voucher_code ? `<div class="row"><span>Voucher ${esc(s.voucher_code)}</span><span>- ${num(s.voucher)}</span></div>` : ''}
    <div class="row total"><span>${s.total < 0 ? 'REFUND' : 'TOTAL'}</span><span>${esc(S.currency)} ${num(Math.abs(s.total))}</span></div>
    ${s.total > 0 ? `<div class="row"><span>Paid (${esc(METHOD_NAMES[s.payment_method] || s.payment_method)})</span><span>${num(s.paid)}</span></div>` : ''}
    ${s.change_due ? `<div class="row b"><span>Change</span><span>${num(s.change_due)}</span></div>` : ''}
    <div class="hr"></div>
    <div class="c foot">${esc(S.bill_footer)}</div>
    <div class="c bc">${receiptBarcode(s.bill_no)}</div>`;
}

// a barcode on a receipt (bill or dispatch note), sharp on a thermal printer
function receiptBarcode(text) {
  const w = billMm();
  const m = Barcode.fit(text, w);
  return m ? Barcode.svg(text, { moduleMm: m, heightMm: 10 }) : Barcode.svg(text, { height: 34, cls: 'bc stretch' });
}

// A ruler 0–80 mm with the edges marked: shows how much of the paper the printer really prints (see Settings → Print width)
function printRuler() {
  let t = '';
  for (let mm = 0; mm <= 80; mm++) {
    const big = mm % 10 === 0, mid = mm % 5 === 0;
    t += `<div style="position:absolute;left:${mm}mm;top:0;width:0.35mm;height:${big ? 9 : mid ? 6 : 3}mm;background:#000"></div>`;
    if (big) t += `<div style="position:absolute;left:${mm}mm;top:9.5mm;font:700 11px Arial;transform:translateX(-30%)">${mm}</div>`;
  }
  const w = billMm();
  printDoc(`<div style="position:relative;width:${w}mm;height:34mm">${t}
    <div style="position:absolute;left:0;top:16mm;width:${w}mm;height:3mm;border-left:0.6mm solid #000;border-right:0.6mm solid #000"></div>
    <div style="position:absolute;left:0;top:20mm;width:${w}mm;text-align:center;font:11px Arial">bars = ${w} mm (the bill width now)</div>
    <div style="position:absolute;left:0;top:26mm;width:${w}mm;font:700 13px Arial;display:flex;justify-content:space-between"><span>LEFT</span><span>RIGHT</span></div></div>`, receiptCss(), 'Ruler', 'bill');
}

function printBill(sale) { printDoc(billHtml(sale), receiptCss(), sale.bill_no, 'bill'); }

// ---------- Barcode labels ----------
// items: [{ product, copies }]
function labelHtml(p) {
  const S = App.settings;
  const w = Math.max(20, Number(S.label_width) || 50), h = Math.max(12, Number(S.label_height) || 25);
  const m = Barcode.fit(p.barcode, w - 3); // (1.5 mm padding each side)
  const bc = m ? Barcode.svg(p.barcode, { height: 40, moduleMm: m }) : Barcode.svg(p.barcode, { height: 40, quiet: 6 });
  return `<div class="label">
    ${h >= 22 ? `<div class="biz">${esc(S.business_name)}</div>` : ''}
    ${S.label_show_name !== '0' ? `<div class="name">${esc(p.name)}</div>` : ''}
    ${variantText(p) ? `<div class="var">${esc(variantText(p))}</div>` : ''}
    <div class="bcw">${bc}</div>
    <div class="code">${esc(p.barcode)}</div>
    ${S.label_show_price !== '0' ? `<div class="price">${esc(S.currency)} ${num(p.sale_price)}</div>` : ''}
  </div>`;
}

function labelCss() {
  const S = App.settings;
  const w = Math.max(20, Number(S.label_width) || 50);
  const h = Math.max(12, Number(S.label_height) || 25);
  const small = h < 22;
  const base = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; }
  .label { width: ${w}mm; height: ${h}mm; padding: 0.8mm 1.5mm; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .label > div { flex-shrink: 0; }
  .biz { font-size: ${small ? 6 : 7}pt; font-weight: 700; letter-spacing: .4px; line-height: 1.1; }
  .name { font-size: ${small ? 6 : 7}pt; line-height: 1.1; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .var { font-size: ${small ? 6 : 7.5}pt; font-weight: 700; line-height: 1.1; }
  .label > .bcw { width: 100%; flex: 1 1 auto; min-height: 0; max-height: ${Math.round(h * 0.45)}mm; display: flex; justify-content: center; }
  .bcw svg { width: 100%; height: 100%; }
  .code { font-size: ${small ? 6 : 7}pt; letter-spacing: 1px; line-height: 1.1; }
  .price { font-size: ${small ? 7 : 9}pt; font-weight: 700; line-height: 1.15; }`;
  if (S.label_mode === 'a4') {
    const cols = Math.max(1, Math.min(8, Number(S.label_columns) || 4));
    return base + `
    @page { size: A4; margin: 8mm; }
    .sheet { display: grid; grid-template-columns: repeat(${cols}, ${w}mm); gap: 2mm; justify-content: center; }
    .label { outline: 0.2mm dashed #bbb; break-inside: avoid; }`;
  }
  return base + `
  @page { size: ${w}mm ${h}mm; margin: 0; }
  .label { page-break-after: always; break-after: page; }
  .label:last-child { page-break-after: auto; break-after: auto; }`;
}

function printLabels(items) {
  const all = [];
  for (const it of items) for (let i = 0; i < it.copies; i++) all.push(labelHtml(it.product));
  if (!all.length) return toast('Nothing to print — set how many labels you need', 'error');
  if (all.length > 3000) return toast('Too many labels at once (max 3000). Print in smaller batches.', 'error');
  const body = App.settings.label_mode === 'a4' ? `<div class="sheet">${all.join('')}</div>` : all.join('');
  const S = App.settings;
  if (S.label_mode === 'a4') printDoc(body, labelCss(), 'Barcode labels', 'a4', 'A4');
  else printDoc(body, labelCss(), 'Barcode labels', 'label', { width: (Number(S.label_width) || 50) * 1000, height: (Number(S.label_height) || 25) * 1000 });
}

function labelPreviewHtml(p) {
  const S = App.settings;
  const w = Number(S.label_width) || 50, h = Number(S.label_height) || 25;
  const scale = 3.2; // px per mm on screen
  return `<div class="label-preview" style="width:${w * scale}px;height:${h * scale}px">
    <div class="lp-biz">${esc(S.business_name)}</div>
    ${S.label_show_name !== '0' ? `<div class="lp-name">${esc(p.name)}${variantText(p) ? ' · ' + esc(variantText(p)) : ''}</div>` : ''}
    <div class="lp-bc" style="max-height:${h * scale * 0.42}px">${Barcode.svg(p.barcode, { height: 40, quiet: 6 })}</div>
    <div class="lp-code">${esc(p.barcode)}</div>
    ${S.label_show_price !== '0' ? `<div class="lp-price">${esc(S.currency)} ${num(p.sale_price)}</div>` : ''}
  </div>`;
}

// ---------- Dispatch note ----------
function printDispatch(d) {
  const S = App.settings;
  const receipt = S.dispatch_paper === 'receipt';
  const rows = d.items.map((i, n) => receipt
    ? `<tr><td class="item" colspan="3">${esc(i.name)}${variantText(i) ? ' (' + esc(variantText(i)) + ')' : ''}</td></tr>
       <tr><td class="sub">${esc(i.barcode)}</td><td>${i.qty}</td><td>${num(i.qty * i.price)}</td></tr>`
    : `<tr><td>${n + 1}</td><td>${esc(i.barcode)}</td><td>${esc(i.name)}</td><td>${esc(i.size || '')}</td><td>${esc(i.color || '')}</td>
       <td class="r">${i.qty}</td>${d.status === 'received' ? `<td class="r">${i.received_qty ?? ''}</td>` : ''}<td class="r">${num(i.price)}</td><td class="r">${num(i.qty * i.price)}</td></tr>`).join('');
  const status = { in_transit: 'On the way', received: 'Received', cancelled: 'CANCELLED' }[d.status];
  if (receipt) {
    printDoc(`
      <div class="c biz">${esc(S.business_name)}</div>
      <div class="c b">DISPATCH NOTE ${esc(d.dispatch_no)}</div>
      <div class="hr"></div>
      <div class="row"><span>From</span><b>${esc(d.from_name)}</b></div>
      <div class="row"><span>To</span><b>${esc(d.to_name)}</b></div>
      <div class="row"><span>Date</span><span>${esc(fmtDT(d.created_at))}</span></div>
      <div class="row"><span>Status</span><span>${status}</span></div>
      <div class="hr"></div>
      <table><thead><tr><th>Item</th><th>Qty</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="hr"></div>
      <div class="row total"><span>Total pieces</span><span>${d.total_qty}</span></div>
      <div class="row"><span>Total value</span><span>${esc(S.currency)} ${num(d.total_value)}</span></div>
      ${d.notes ? `<div class="hr"></div><div>${esc(d.notes)}</div>` : ''}
      <div class="hr"></div><br>Sent by: ____________<br><br>Received by: ________
      <div class="c bc">${receiptBarcode(d.dispatch_no)}</div>`, receiptCss(), d.dispatch_no, 'bill');
    return;
  }
  printDoc(`
    <div class="head"><div><div class="biz">${esc(S.business_name)}</div><div>${esc(S.business_address)} ${esc(S.business_phone)}</div></div>
      <div class="r"><div class="title">DISPATCH NOTE</div><div class="no">${esc(d.dispatch_no)}</div><div class="bc">${Barcode.svg(d.dispatch_no, { height: 30 })}</div></div></div>
    <table class="info"><tr><td><b>From:</b> ${esc(d.from_name)}</td><td><b>To:</b> ${esc(d.to_name)}</td><td><b>Date:</b> ${esc(fmtDT(d.created_at))}</td><td><b>Status:</b> ${status}</td></tr></table>
    <table class="items"><thead><tr><th>#</th><th>Barcode</th><th>Item</th><th>Size</th><th>Colour</th><th class="r">Qty</th>${d.status === 'received' ? '<th class="r">Received</th>' : ''}<th class="r">Price</th><th class="r">Value</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="5">Total</td><td class="r">${d.total_qty}</td>${d.status === 'received' ? `<td class="r">${d.received_qty ?? ''}</td>` : ''}<td></td><td class="r">${esc(S.currency)} ${num(d.total_value)}</td></tr></tfoot></table>
    ${d.notes ? `<p><b>Notes:</b> ${esc(d.notes)}</p>` : ''}
    <div class="sign"><div>Sent by (${esc(d.created_by_name || '')})</div><div>Checked by</div><div>Received by</div></div>`,
  `@page { size: A4; margin: 12mm; }
   body { font: 12px/1.4 Arial, Helvetica, sans-serif; color: #000; margin: 0; }
   .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #000; padding-bottom: 8px; }
   .biz { font-size: 20px; font-weight: 700; } .title { font-size: 16px; font-weight: 700; letter-spacing: 1px; } .no { font-size: 15px; }
   .bc svg { width: 160px; height: 30px; } .r { text-align: right; }
   table { width: 100%; border-collapse: collapse; margin-top: 10px; }
   .info td { padding: 6px 4px; }
   .items th, .items td { border: 1px solid #888; padding: 4px 6px; text-align: left; }
   .items th { background: #eee; } .items td.r, .items th.r { text-align: right; }
   tfoot td { font-weight: 700; }
   .sign { display: flex; justify-content: space-between; margin-top: 60px; gap: 30px; }
   .sign div { flex: 1; border-top: 1px solid #000; padding-top: 4px; text-align: center; }`, d.dispatch_no, 'a4', 'A4');
}

// ---------- Vouchers ----------
// One printed voucher: the shop, what it is worth, the QR code (a scanner types the code), the code and the rules.
function voucherCardHtml(v, mm = 0.75) {
  const S = App.settings;
  const worth = v.kind === 'pct' ? `${num(v.value)}% OFF` : `${esc(S.currency)} ${num(v.value)} OFF`;
  const rules = [
    v.min_bill > 0 ? `On a bill of ${esc(S.currency)} ${num(v.min_bill)} or more` : 'On any bill',
    v.expires ? `Valid till ${esc(fmtDate(v.expires))}` : '',
    v.max_uses > 1 ? `Can be used ${v.max_uses} times` : 'One use only',
  ].filter(Boolean);
  return `<div class="vch">
    <div class="biz">${esc(S.business_name)}</div>
    <div class="vt">VOUCHER</div>
    <div class="vw">${worth}</div>
    ${v.note ? `<div class="vn">${esc(v.note)}</div>` : ''}
    <div class="vq">${QR.svg(v.code, { moduleMm: mm })}</div>
    <div class="vc">${esc(v.code)}</div>
    <div class="vr">${rules.map((r) => `<div>${r}</div>`).join('')}</div>
    <div class="vs">Show this at the counter</div>
  </div>`;
}
// mode 'receipt': one voucher after another on the receipt printer; 'a4': cut-out cards, two across
function printVouchers(list, mode = 'receipt') {
  if (!list.length) return toast('Choose at least one voucher to print', 'error');
  if (mode === 'a4') {
    printDoc(`<div class="sheet">${list.map((v) => voucherCardHtml(v, 1)).join('')}</div>`,
      `@page { size: A4; margin: 10mm; } * { box-sizing: border-box; }
       body { margin: 0; font: 12px/1.35 Arial, Helvetica, sans-serif; color: #000; }
       .sheet { display: grid; grid-template-columns: 1fr 1fr; }
       .vch { border: 1px dashed #000; padding: 6mm 5mm; text-align: center; height: 88mm; break-inside: avoid; display: flex; flex-direction: column; align-items: center; justify-content: center; }
       .biz { font-size: 16px; font-weight: 700; } .vt { letter-spacing: 3px; font-size: 11px; margin-top: 2px; }
       .vw { font-size: 26px; font-weight: 800; margin: 4px 0; } .vn { font-size: 12px; }
       .vq svg { display: block; } .vc { font: 700 15px 'Courier New', monospace; letter-spacing: 1px; margin: 2px 0 4px; }
       .vr { font-size: 11px; } .vs { font-size: 10px; margin-top: 4px; }`, 'Vouchers', 'a4', 'A4');
    return;
  }
  printDoc(list.map((v) => voucherCardHtml(v)).join(''),
    `${receiptCss()}
     .vch { text-align: center; break-after: page; page-break-after: always; padding-bottom: 4mm; }
     .vch:last-child { break-after: auto; page-break-after: auto; }
     .vt { letter-spacing: 3px; font-size: 11px; } .vw { font-size: 22px; font-weight: 800; margin: 3px 0; } .vn { font-size: 11px; }
     .vq { display: flex; justify-content: center; margin: 3px 0; } .vc { font: 700 14px 'Courier New', monospace; letter-spacing: 1px; margin-bottom: 3px; }
     .vr { font-size: 10.5px; } .vs { font-size: 10px; margin-top: 3px; border-top: 1px dashed #000; padding-top: 3px; }`, 'Vouchers', 'bill');
}
