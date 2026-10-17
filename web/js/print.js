'use strict';
// Printing: customer bills (receipt printer), barcode labels (label printer or A4 sheet), dispatch notes.

// Prints through the browser's print window (Chrome started with --kiosk-printing prints straight to the default printer).
// kind / pageSize say what is being printed: 'bill' (receipt), 'label' or 'a4'.
async function printDoc(bodyHtml, css, title = 'Print', kind = 'a4', pageSize) { // eslint-disable-line no-unused-vars
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
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); }, 200);
}

// ---------- Customer bill ----------
function receiptCss() {
  const w = App.settings.bill_width === '58' ? 48 : 72;
  return `@page { margin: 0; }
  * { box-sizing: border-box; }
  body { width: ${w}mm; margin: 0 auto; padding: 3mm 0 6mm; font: ${w < 60 ? 11 : 12}px/1.35 Arial, Helvetica, sans-serif; color: #000; }
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
  .bc svg { width: 60%; height: 34px; }
  .foot { white-space: pre-line; margin-top: 4px; }
  .ret { font-weight: 700; }`;
}

function billHtml(s) {
  const S = App.settings;
  const sold = s.items.filter((i) => i.qty > 0).reduce((a, i) => a + i.qty, 0);
  const returned = s.items.filter((i) => i.qty < 0).reduce((a, i) => a - i.qty, 0);
  const lines = s.items.map((i) => `
    <tr><td class="item" colspan="4">${esc(i.name)}${variantText(i) ? ' (' + esc(variantText(i)) + ')' : ''}${i.qty < 0 ? ' <span class="ret">[RETURN]</span>' : ''}</td></tr>
    <tr><td class="sub">${esc(i.barcode)}</td><td>${i.qty}</td><td>${num(i.price)}</td><td>${num(i.qty * i.price)}</td></tr>`).join('');
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
    <div class="row total"><span>${s.total < 0 ? 'REFUND' : 'TOTAL'}</span><span>${esc(S.currency)} ${num(Math.abs(s.total))}</span></div>
    ${s.total > 0 ? `<div class="row"><span>Paid (${esc(METHOD_NAMES[s.payment_method] || s.payment_method)})</span><span>${num(s.paid)}</span></div>` : ''}
    ${s.change_due ? `<div class="row b"><span>Change</span><span>${num(s.change_due)}</span></div>` : ''}
    <div class="hr"></div>
    <div class="c foot">${esc(S.bill_footer)}</div>
    <div class="c bc">${Barcode.svg(s.bill_no, { height: 34 })}</div>`;
}

function printBill(sale) { printDoc(billHtml(sale), receiptCss(), sale.bill_no, 'bill'); }

// ---------- Barcode labels ----------
// items: [{ product, copies }]
function labelHtml(p) {
  const S = App.settings;
  return `<div class="label">
    <div class="biz">${esc(S.business_name)}</div>
    ${S.label_show_name !== '0' ? `<div class="name">${esc(p.name)}</div>` : ''}
    ${variantText(p) ? `<div class="var">${esc(variantText(p))}</div>` : ''}
    <div class="bcw">${Barcode.svg(p.barcode, { height: 40, quiet: 6 })}</div>
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
  .label > .bcw { width: 100%; flex: 1 1 auto; min-height: 0; max-height: ${Math.round(h * 0.42)}mm; display: flex; }
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
      <div class="c bc">${Barcode.svg(d.dispatch_no, { height: 34 })}</div>`, receiptCss(), d.dispatch_no, 'bill');
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
