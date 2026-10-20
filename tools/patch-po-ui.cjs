// One-off helper: puts the purchase order screens into web/js/views/purchases.js.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const f = path.join(root, 'web', 'js', 'views', 'purchases.js');
let s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const rep = (x, y) => { if (!s.includes(x)) throw new Error('missing: ' + x.slice(0, 80)); s = s.replace(x, () => y); };
const part = (n) => fs.readFileSync(path.join(__dirname, 'po-parts', n), 'utf8').replace(/\r\n/g, '\n');

// 1. the list
const a = s.indexOf("View('purchases', {");
const b = s.indexOf("View('purchases/new', {");
s = s.slice(0, a) + part('list.js') + s.slice(b);

// 2. new purchase / new purchase order
rep("  title: 'New purchase',\n  nav: 'purchases',\n  allow: () => can('buy'),\n  async render({ el }) {\n    const draftKey = `vz_purchase_${App.user.id}`;",
  "  title: 'Stock arrived',\n  nav: 'purchases',\n  allow: () => can('buy'),\n  async render({ el, query }) {\n    const order = query.order === '1'; // a purchase order: nothing is added to stock until the goods arrive\n    if (order) setTitle('New purchase order');\n    const draftKey = `vz_purchase_${App.user.id}${order ? '_order' : ''}`;");
rep("location_id: isAdmin() ? warehouses()[0]?.id || '' : App.user.location_id, paid: '', notes: '', lines: [] });",
  "location_id: isAdmin() ? warehouses()[0]?.id || '' : App.user.location_id, paid: '', notes: '', expected_date: '', lines: [] });");
rep("    el.innerHTML = `\n      <div class=\"card\"><div class=\"form-grid four\">",
  "    el.innerHTML = `\n      ${order ? '<div class=\"alert info\">Order what you need from the supplier. <b>Nothing is added to stock now.</b> New items can be made right here (<b>New item</b>) — Velanzo gives each one its barcode. When the goods arrive, open this order and press <b>Receive stock</b>, count them, and print the labels.</div>' : ''}\n      <div class=\"card\"><div class=\"form-grid four\">");
rep("<label class=\"field\">Date<input class=\"input\" type=\"date\" id=\"date\" value=\"${esc(S.date)}\"></label>\n        <label class=\"field\">Stock goes into<select",
  "<label class=\"field\">${order ? 'Order date' : 'Date'}<input class=\"input\" type=\"date\" id=\"date\" value=\"${esc(S.date)}\"></label>\n        ${order ? `<label class=\"field\">Expected on<input class=\"input\" type=\"date\" id=\"exp\" value=\"${esc(S.expected_date)}\"></label>` : ''}\n        <label class=\"field\">${order ? 'Goes to' : 'Stock goes into'}<select");
rep("        <label class=\"field\">Amount paid to supplier now<input class=\"input num\" id=\"paid\" inputmode=\"decimal\" placeholder=\"0\" value=\"${esc(S.paid)}\"><span class=\"hint\">Leave 0 if you will pay later — it will show as owed.</span></label>\n        <label class=\"field\" style=\"grid-column: span 2\">Notes",
  "        ${order ? '' : `<label class=\"field\">Amount paid to supplier now<input class=\"input num\" id=\"paid\" inputmode=\"decimal\" placeholder=\"0\" value=\"${esc(S.paid)}\"><span class=\"hint\">Leave 0 if you will pay later — it will show as owed.</span></label>`}\n        <label class=\"field\" style=\"grid-column: span ${order ? 3 : 2}\">Notes");
rep("<button class=\"btn ok lg\" id=\"saveBtn\">✓ Save purchase & add to stock</button>", "<button class=\"btn ok lg\" id=\"saveBtn\">${order ? '✓ Save purchase order' : '✓ Save purchase & add to stock'}</button>");
rep("    $('#paid', el).addEventListener('input', (e) => { S.paid = e.target.value; save(); });",
  "    $('#paid', el)?.addEventListener('input', (e) => { S.paid = e.target.value; save(); });\n    $('#exp', el)?.addEventListener('change', (e) => { S.expected_date = e.target.value; save(); });");
rep("        supplier_id: S.supplier_id, invoice_no: S.invoice_no, date: S.date, location_id: S.location_id, paid: S.paid, notes: S.notes,",
  "        supplier_id: S.supplier_id, invoice_no: S.invoice_no, date: S.date, location_id: S.location_id, paid: S.paid, notes: S.notes, order, expected_date: S.expected_date,");
rep("      toast(`Purchase ${r.purchase_no} saved — stock added`);\n      go(`purchases/${r.id}?new=1`);",
  "      toast(order ? `Purchase order ${r.purchase_no} saved — nothing is in stock until it arrives` : `Purchase ${r.purchase_no} saved — stock added`);\n      go(order ? `purchases/${r.id}?placed=1` : `purchases/${r.id}?new=1`);");
rep("Scan/search an existing item, or click <b>New item</b> for something you have never bought before.", "Scan/search an existing item, or click <b>New item</b> for something you have never bought before.");

// 3. the detail screen
rep("    setTitle(`Purchase ${p.purchase_no}`);\n    setActions(`<a class=\"btn\" href=\"#/purchases\">← Purchases</a>${isAdmin() && p.status === 'done' ? '<button class=\"btn danger\" id=\"voidBtn\">Cancel purchase</button>' : ''}<button class=\"btn primary\" id=\"lblBtn\">${icon('printer')} Print barcode labels</button>`);",
  "    const ordered = p.status === 'ordered';\n    setTitle(`${ordered ? 'Purchase order' : 'Purchase'} ${p.purchase_no}`);\n    setActions(`<a class=\"btn\" href=\"#/purchases\">← Purchase</a>${ordered ? '<button class=\"btn danger\" id=\"cancelOrder\">Cancel order</button>' : (isAdmin() && p.status === 'done' ? '<button class=\"btn danger\" id=\"voidBtn\">Cancel purchase</button>' : '')}${ordered ? `<a class=\"btn primary\" href=\"#/purchases/${p.id}/receive\">${icon('inbox')} Receive stock</a>` : `<button class=\"btn primary\" id=\"lblBtn\">${icon('printer')} Print barcode labels</button>`}`);");
rep("      ${query.new ? `<div class=\"alert ok\">✓ Saved. ${p.total_qty} pieces were added to ${esc(p.location_name)}. Next step: print barcode labels and stick them on the items.</div>` : ''}",
  "      ${query.placed ? `<div class=\"alert ok\">✓ Purchase order saved. <b>Nothing is in stock yet.</b> When the goods arrive, open this order and press <b>Receive stock</b>.</div>` : ''}\n      ${query.arrived ? `<div class=\"alert ok\">✓ Received. ${p.total_qty} pieces were added to ${esc(p.location_name)}${p.items.some((i) => i.ordered_qty != null && i.ordered_qty !== i.qty) ? ' (not everything arrived — see the numbers below)' : ''}. <b>Next step:</b> print the barcode labels and stick one on each piece.</div>` : ''}\n      ${query.new ? `<div class=\"alert ok\">✓ Saved. ${p.total_qty} pieces were added to ${esc(p.location_name)}. Next step: print barcode labels and stick them on the items.</div>` : ''}\n      ${ordered ? `<div class=\"alert info flex\">📦 <div class=\"grow\"><b>On order</b>${p.expected_date ? ` — expected ${esc(fmtDate(p.expected_date))}` : ''}. The pieces are not in stock until they arrive.</div><a class=\"btn primary\" href=\"#/purchases/${p.id}/receive\">Receive stock</a></div>` : ''}");
rep("<dt>Total</dt><dd><b>${money(p.total)}</b> · paid now ${money(p.paid)}</dd>", "<dt>${ordered ? 'Order total' : 'Total'}</dt><dd><b>${money(p.total)}</b>${ordered ? '' : ` · paid now ${money(p.paid)}`}</dd>");
rep("<td class=\"r\">${i.qty}</td><td class=\"r\">${money(i.cost)}</td>", "<td class=\"r\">${i.qty}${!ordered && i.ordered_qty != null && i.ordered_qty !== i.qty ? ` <span class=\"muted small\">(ordered ${i.ordered_qty})</span>` : ''}</td><td class=\"r\">${money(i.cost)}</td>");
rep("    $('#lblBtn').addEventListener('click', () => {", "    const lb = $('#lblBtn');\n    if (lb) lb.addEventListener('click', () => {");
rep("    const v = $('#voidBtn');", "    const co = $('#cancelOrder');\n    if (co) co.addEventListener('click', async () => {\n      const reason = await promptBox('Why is this order cancelled? (Nothing was in stock, so stock does not change.)', { title: `Cancel order ${p.purchase_no}`, ok: 'Cancel order', danger: true });\n      if (reason === null) return;\n      await busy(co, async () => { await POST(`/api/purchases/${p.id}/cancel-order`, { reason }); toast('Order cancelled'); router(); });\n    });\n    const v = $('#voidBtn');");

// 4. the receive screen (after the detail screen)
s = s.trimEnd() + '\n\n' + part('receive.js').trimEnd() + '\n';
fs.writeFileSync(f, s);
console.log('purchases.js patched');
