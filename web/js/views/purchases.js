'use strict';
// Purchases: stock bought from suppliers comes into the warehouse.

function openSupplierForm(s, onSaved) {
  const m = modal({
    title: s ? 'Edit supplier' : 'New supplier',
    body: `<div class="form-grid">
      <label class="field full">Name *<input class="input" name="name" value="${esc(s?.name || '')}"></label>
      <label class="field">Phone<input class="input" name="phone" value="${esc(s?.phone || '')}"></label>
      <label class="field">Address / city<input class="input" name="address" value="${esc(s?.address || '')}"></label>
      <label class="field full">Notes<textarea class="input" name="notes">${esc(s?.notes || '')}</textarea></label></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="sSave">Save</button>`,
  });
  const b = m.$('#sSave');
  b.addEventListener('click', () => busy(b, async () => {
    const out = s ? await PUT('/api/suppliers/' + s.id, formValues(m.el)) : await POST('/api/suppliers', formValues(m.el));
    toast('Supplier saved');
    m.close();
    onSaved && onSaved(out);
  }));
}

View('purchases', {
  title: 'Purchase',
  allow: () => can('buy'),
  async render({ el, query }) {
    const st = { from: rangePresets().month[1], to: todayStr(), q: '', tab: query.tab || 'all' };
    setActions(`<a class="btn" href="#/purchases/new">Stock arrived (no order)</a><a class="btn primary" href="#/purchases/new?order=1">${icon('plus')} New purchase order</a>`);
    el.innerHTML = `<div class="tabs" id="tabs"><a href="#" data-t="all">All</a><a href="#" data-t="ordered">On order</a><a href="#" data-t="done">Received</a></div>
      <div id="due"></div>
      <div class="toolbar" id="bar">${rangeBarHtml(st)}<input class="input search" id="q" placeholder="Search purchase no., supplier or invoice no."></div>
      <div class="card flush" id="list"><div class="loading">Loading…</div></div>`;
    const status = (r) => {
      if (r.status === 'ordered') {
        const late = r.expected_date && r.expected_date < todayStr();
        return `<span class="pill ${late ? 'red' : 'warn'}">On order</span> <span class="muted small">${r.expected_date ? (late ? 'was due ' : 'due ') + esc(fmtDate(r.expected_date)) : 'no date'}</span>`;
      }
      return r.status === 'void' ? '<span class="pill red">cancelled</span>' : '<span class="pill ok">Received</span>';
    };
    async function load() {
      const [rows, ordered] = await Promise.all([GET('/api/purchases', { ...st, tab: undefined }), GET('/api/purchases', { status: 'ordered' })]);
      if (!el.isConnected) return;
      $$('[data-preset]', el).forEach((b) => { const [, f, t] = rangePresets()[b.dataset.preset]; b.classList.toggle('on', st.from === f && st.to === t); });
      $('[data-range=from]', el).value = st.from; $('[data-range=to]', el).value = st.to;
      $$('#tabs a', el).forEach((a) => {
        a.classList.toggle('active', a.dataset.t === st.tab);
        if (a.dataset.t === 'ordered') a.textContent = `On order${ordered.length ? ` (${ordered.length})` : ''}`;
      });
      $('#bar', el).classList.toggle('hidden', st.tab === 'ordered');
      const late = ordered.filter((o) => o.expected_date && o.expected_date < todayStr());
      $('#due', el).innerHTML = ordered.length && st.tab !== 'ordered'
        ? `<div class="alert ${late.length ? 'danger' : 'info'} flex">📦 <div class="grow"><b>${ordered.length} order${ordered.length > 1 ? 's' : ''} waiting for goods</b>${late.length ? ` — ${late.length} late` : ''}.</div><a class="btn" href="#/purchases?tab=ordered" data-t-link="ordered">Show them</a></div>` : '';
      const rest = rows.filter((r) => r.status !== 'ordered');
      const shown = st.tab === 'ordered' ? ordered : st.tab === 'done' ? rest.filter((r) => r.status === 'done') : [...ordered, ...rest];
      const done = rest.filter((r) => r.status === 'done');
      $('#list', el).innerHTML = shown.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Date</th><th>Supplier</th><th>Status</th><th>Supplier invoice</th><th>Goes to</th><th class="r">Pieces</th><th class="r">Amount</th><th class="r">Paid</th></tr></thead><tbody>
        ${shown.map((r) => `<tr class="click${r.status === 'void' ? ' void' : ''}" data-id="${r.id}"><td><b>${esc(r.purchase_no)}</b></td><td>${esc(fmtDate(r.date))}</td><td>${esc(r.supplier_name || '—')}</td><td>${status(r)}</td><td>${esc(r.invoice_no || '')}</td><td>${esc(r.location_name)}</td>
          <td class="r">${r.total_qty}</td><td class="r"><b>${money(r.total)}</b></td><td class="r">${r.status === 'ordered' ? '—' : money(r.paid)}</td></tr>`).join('')}
        </tbody>${st.tab === 'ordered' ? '' : `<tfoot><tr><td colspan="6">Received (${done.length} purchases)</td><td class="r">${done.reduce((a, r) => a + r.total_qty, 0)}</td><td class="r">${money(done.reduce((a, r) => a + r.total, 0))}</td><td class="r">${money(done.reduce((a, r) => a + r.paid, 0))}</td></tr></tfoot>`}</table></div>`
        : `<div class="empty">${st.tab === 'ordered' ? 'No orders are waiting for goods.' : 'Nothing in this period. Click <b>New purchase order</b> when you order stock from a supplier.'}</div>`;
    }
    bindRangeBar(el, st, load);
    $$('#tabs a', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); st.tab = a.dataset.t; load(); }));
    el.addEventListener('click', (e) => { const l = e.target.closest('[data-t-link]'); if (l) { e.preventDefault(); st.tab = 'ordered'; load(); } });
    let t;
    $('#q', el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); load(); }, 300); });
    $('#list', el).addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) go('purchases/' + r.dataset.id); });
    await load();
  },
});

View('purchases/new', {
  title: 'Stock arrived',
  nav: 'purchases',
  allow: () => can('buy'),
  async render({ el, query }) {
    const order = query.order === '1'; // a purchase order: nothing is added to stock until the goods arrive
    if (order) setTitle('New purchase order');
    const draftKey = `vz_purchase_${App.user.id}${order ? '_order' : ''}`;
    const blank = () => ({ supplier_id: '', invoice_no: '', date: todayStr(), location_id: isAdmin() ? warehouses()[0]?.id || '' : App.user.location_id, paid: '', notes: '', expected_date: '', lines: [] });
    let S;
    try { S = { ...blank(), ...JSON.parse(localStorage.getItem(draftKey) || 'null') }; } catch { S = blank(); }
    const save = () => { try { localStorage.setItem(draftKey, JSON.stringify(S)); } catch { /* ignore */ } };
    let suppliers = await GET('/api/suppliers');
    const locs = isAdmin() ? App.locations.filter((l) => l.active) : App.locations.filter((l) => l.id === App.user.location_id);
    setActions(`<a class="btn" href="#/purchases">← Purchases</a>`);
    el.innerHTML = `
      ${order ? '<div class="alert info">Order what you need from the supplier. <b>Nothing is added to stock now.</b> New items can be made right here (<b>New item</b>) — Velanzo gives each one its barcode. When the goods arrive, open this order and press <b>Receive stock</b>, count them, and print the labels.</div>' : ''}
      <div class="card"><div class="form-grid four">
        <label class="field">Supplier<div style="display:flex;gap:6px;margin-top:5px"><select class="input" id="sup"></select><button class="btn" id="newSup" title="Add supplier">+</button></div></label>
        <label class="field">Supplier's bill / invoice no.<input class="input" id="inv" value="${esc(S.invoice_no)}"></label>
        <label class="field">${order ? 'Order date' : 'Date'}<input class="input" type="date" id="date" value="${esc(S.date)}"></label>
        ${order ? `<label class="field">Expected on<input class="input" type="date" id="exp" value="${esc(S.expected_date)}"></label>` : ''}
        <label class="field">${order ? 'Goes to' : 'Stock goes into'}<select class="input" id="loc" ${locs.length < 2 ? 'disabled' : ''}>${options(locs, S.location_id)}</select></label>
      </div></div>
      <div class="card">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <div class="grow" style="min-width:260px"><input class="input scan-input" id="scan" placeholder="Scan or search an item you already have…" autocomplete="off"></div>
          <span class="muted">or</span>
          <button class="btn primary lg" id="newItem">${icon('plus')} New item (with sizes / colours)</button>
        </div>
        <div id="lines" style="margin-top:14px"></div>
      </div>
      <div class="card"><div class="form-grid three">
        ${order ? '' : `<label class="field">Amount paid to supplier now<input class="input num" id="paid" inputmode="decimal" placeholder="0" value="${esc(S.paid)}"><span class="hint">Leave 0 if you will pay later — it will show as owed.</span></label>`}
        <label class="field" style="grid-column: span ${order ? 3 : 2}">Notes<input class="input" id="notes" value="${esc(S.notes)}" placeholder="optional"></label>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;align-items:center">
        <div class="muted" id="sumTxt" style="margin-right:auto"></div>
        <button class="btn ghost" id="clr">Clear</button>
        <button class="btn ok lg" id="saveBtn">${order ? '✓ Save purchase order' : '✓ Save purchase & add to stock'}</button>
      </div></div>`;

    function renderSup() {
      $('#sup', el).innerHTML = options(suppliers, S.supplier_id, { blank: '— No supplier / not known —' });
    }
    function renderLines(flash = -1) {
      const total = S.lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0);
      const pcs = S.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
      $('#lines', el).innerHTML = S.lines.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>Item</th><th>Barcode</th><th class="r">Qty</th><th class="r">Cost price (each)</th><th class="r">Sale price</th><th class="r">Amount</th><th></th></tr></thead><tbody>
        ${S.lines.map((l, i) => `<tr class="${i === flash ? 'flash' : ''}"><td class="muted">${i + 1}</td><td><b>${esc(l.name)}</b> <span class="muted">${esc(variantText(l))}</span></td><td class="mono small">${esc(l.barcode)}</td>
          <td class="r"><input class="input sm num" style="width:80px" data-i="${i}" data-f="qty" value="${esc(l.qty)}" inputmode="numeric"></td>
          <td class="r"><input class="input sm num" style="width:110px" data-i="${i}" data-f="cost" value="${esc(l.cost)}" inputmode="decimal"></td>
          <td class="r"><input class="input sm num" style="width:110px" data-i="${i}" data-f="sale_price" value="${esc(l.sale_price)}" inputmode="decimal"></td>
          <td class="r nowrap" data-amt="${i}">${money((Number(l.qty) || 0) * (Number(l.cost) || 0))}</td><td><button class="icon-btn" data-rm="${i}">✕</button></td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="3">Total</td><td class="r" id="tPcs">${pcs}</td><td></td><td></td><td class="r nowrap" id="tAmt">${money(total)}</td><td></td></tr></tfoot></table></div>`
        : '<div class="empty">No items yet. Scan/search an existing item, or click <b>New item</b> for something you have never bought before.</div>';
      $('#sumTxt', el).textContent = S.lines.length ? `${S.lines.length} lines · ${pcs} pieces · ${money(total)}` : '';
      const f = $('#lines tr.flash', el);
      if (f) { f.scrollIntoView({ block: 'nearest' }); $('#scan', el).focus(); }
      save();
    }
    function addLine(p) {
      const i = S.lines.findIndex((l) => l.product_id === p.id);
      if (i >= 0) { S.lines[i].qty = (Number(S.lines[i].qty) || 0) + 1; return renderLines(i); }
      S.lines.push({ product_id: p.id, name: p.name, size: p.size, color: p.color, barcode: p.barcode, qty: 1, cost: p.cost_price || '', sale_price: p.sale_price || '' });
      renderLines(S.lines.length - 1);
    }
    renderSup();
    renderLines();
    attachPicker($('#scan', el), { onPick: addLine, location: () => S.location_id, showStock: true });
    ProductCache.load(S.location_id, true).catch((e) => toast(e.message, 'error'));

    $('#sup', el).addEventListener('change', (e) => { S.supplier_id = e.target.value; save(); });
    $('#inv', el).addEventListener('input', (e) => { S.invoice_no = e.target.value; save(); });
    $('#date', el).addEventListener('change', (e) => { S.date = e.target.value; save(); });
    $('#loc', el).addEventListener('change', (e) => { S.location_id = e.target.value; save(); });
    $('#paid', el)?.addEventListener('input', (e) => { S.paid = e.target.value; save(); });
    $('#exp', el)?.addEventListener('change', (e) => { S.expected_date = e.target.value; save(); });
    $('#notes', el).addEventListener('input', (e) => { S.notes = e.target.value; save(); });
    $('#newSup', el).addEventListener('click', () => openSupplierForm(null, async (s) => { suppliers = await GET('/api/suppliers'); S.supplier_id = s.id; renderSup(); save(); }));
    $('#newItem', el).addEventListener('click', () => openAddProduct({ forPurchase: true, onCreated: (list) => list.forEach(addLine) }));
    $('#lines', el).addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.i === undefined) return;
      S.lines[+t.dataset.i][t.dataset.f] = t.value;
      const l = S.lines[+t.dataset.i];
      $(`[data-amt="${t.dataset.i}"]`, el).textContent = money((Number(l.qty) || 0) * (Number(l.cost) || 0));
      $('#tPcs', el).textContent = S.lines.reduce((a, x) => a + (Number(x.qty) || 0), 0);
      const total = S.lines.reduce((a, x) => a + (Number(x.qty) || 0) * (Number(x.cost) || 0), 0);
      $('#tAmt', el).textContent = money(total);
      $('#sumTxt', el).textContent = `${S.lines.length} lines · ${$('#tPcs', el).textContent} pieces · ${money(total)}`;
      save();
    });
    $('#lines', el).addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { S.lines.splice(+b.dataset.rm, 1); renderLines(); } });
    $('#lines', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.i !== undefined) { e.preventDefault(); $('#scan', el).focus(); } });
    $('#clr', el).addEventListener('click', async () => {
      if (!(await confirmBox('Clear this purchase and start again?', { ok: 'Clear', danger: true }))) return;
      localStorage.removeItem(draftKey);
      router();
    });
    const sb = $('#saveBtn', el);
    sb.addEventListener('click', () => busy(sb, async () => {
      if (!S.lines.length) throw new Error('Add at least one item');
      const bad = S.lines.find((l) => !(parseInt(l.qty, 10) > 0));
      if (bad) throw new Error(`Enter the quantity for ${bad.name}`);
      const huge = S.lines.find((l) => parseInt(l.qty, 10) > 10000);
      if (huge) throw new Error(`Quantity ${huge.qty} for ${huge.name} looks wrong — please check it`);
      const r = await POST('/api/purchases', {
        supplier_id: S.supplier_id, invoice_no: S.invoice_no, date: S.date, location_id: S.location_id, paid: S.paid, notes: S.notes, order, expected_date: S.expected_date,
        items: S.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, cost: l.cost, sale_price: l.sale_price })),
      });
      localStorage.removeItem(draftKey);
      ProductCache.invalidate();
      toast(order ? `Purchase order ${r.purchase_no} saved — nothing is in stock until it arrives` : `Purchase ${r.purchase_no} saved — stock added`);
      go(order ? `purchases/${r.id}?placed=1` : `purchases/${r.id}?new=1`);
    }));
  },
});

View('purchases/:id', {
  title: 'Purchase',
  nav: 'purchases',
  allow: () => can('buy'),
  async render({ el, params, query }) {
    const p = await GET('/api/purchases/' + params.id);
    const ordered = p.status === 'ordered';
    setTitle(`${ordered ? 'Purchase order' : 'Purchase'} ${p.purchase_no}`);
    setActions(`<a class="btn" href="#/purchases">← Purchase</a>${ordered ? '<button class="btn danger" id="cancelOrder">Cancel order</button>' : (isAdmin() && p.status === 'done' ? '<button class="btn danger" id="voidBtn">Cancel purchase</button>' : '')}${ordered ? `<a class="btn primary" href="#/purchases/${p.id}/receive">${icon('inbox')} Receive stock</a>` : `<button class="btn primary" id="lblBtn">${icon('printer')} Print barcode labels</button>`}`);
    el.innerHTML = `
      ${query.placed ? `<div class="alert ok">✓ Purchase order saved. <b>Nothing is in stock yet.</b> When the goods arrive, open this order and press <b>Receive stock</b>.</div>` : ''}
      ${query.arrived ? `<div class="alert ok">✓ Received. ${p.total_qty} pieces were added to ${esc(p.location_name)}${p.items.some((i) => i.ordered_qty != null && i.ordered_qty !== i.qty) ? ' (not everything arrived — see the numbers below)' : ''}. <b>Next step:</b> print the barcode labels and stick one on each piece.</div>` : ''}
      ${query.new ? `<div class="alert ok">✓ Saved. ${p.total_qty} pieces were added to ${esc(p.location_name)}. Next step: print barcode labels and stick them on the items.</div>` : ''}
      ${ordered ? `<div class="alert info flex">📦 <div class="grow"><b>On order</b>${p.expected_date ? ` — expected ${esc(fmtDate(p.expected_date))}` : ''}. The pieces are not in stock until they arrive.</div><a class="btn primary" href="#/purchases/${p.id}/receive">Receive stock</a></div>` : ''}
      ${p.status === 'void' ? '<div class="alert danger">This purchase was cancelled — its stock was removed again.</div>' : ''}
      <div class="card"><dl class="kv">
        <dt>Supplier</dt><dd>${p.supplier_id ? `<a href="#/suppliers/${p.supplier_id}">${esc(p.supplier_name)}</a>` : '—'} ${esc(p.supplier_phone || '')}</dd>
        <dt>Supplier invoice</dt><dd>${esc(p.invoice_no || '—')}</dd><dt>Date</dt><dd>${esc(fmtDate(p.date))}</dd><dt>Received at</dt><dd>${esc(p.location_name)}</dd>
        <dt>Entered by</dt><dd>${esc(p.user_name || '')} · ${esc(fmtDT(p.created_at))}</dd>
        <dt>${ordered ? 'Order total' : 'Total'}</dt><dd><b>${money(p.total)}</b>${ordered ? '' : ` · paid now ${money(p.paid)}`}</dd>${p.notes ? `<dt>Notes</dt><dd>${esc(p.notes)}</dd>` : ''}</dl></div>
      <div class="card flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Barcode</th><th class="r">Qty</th><th class="r">Cost</th><th class="r">Sale price now</th><th class="r">Amount</th></tr></thead><tbody>
        ${p.items.map((i) => `<tr class="click" data-pid="${i.product_id}"><td><b>${esc(i.name)}</b> <span class="muted">${esc(variantText(i))}</span></td><td class="mono">${esc(i.barcode)}</td><td class="r">${i.qty}${!ordered && i.ordered_qty != null && i.ordered_qty !== i.qty ? ` <span class="muted small">(ordered ${i.ordered_qty})</span>` : ''}</td><td class="r">${money(i.cost)}</td><td class="r">${money(i.sale_price)}</td><td class="r">${money(i.qty * i.cost)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">Total</td><td class="r">${p.total_qty}</td><td></td><td></td><td class="r">${money(p.total)}</td></tr></tfoot></table></div></div>`;
    $('.tbl', el).addEventListener('click', (e) => { const r = e.target.closest('[data-pid]'); if (r) go('products/' + r.dataset.pid); });
    const lb = $('#lblBtn');
    if (lb) lb.addEventListener('click', () => {
      addToLabelQueue(p.items.map((i) => ({ product: { id: i.product_id, name: i.name, size: i.size, color: i.color, barcode: i.barcode, sale_price: i.sale_price }, copies: i.qty })), true);
      go('labels');
    });
    const co = $('#cancelOrder');
    if (co) co.addEventListener('click', async () => {
      const reason = await promptBox('Why is this order cancelled? (Nothing was in stock, so stock does not change.)', { title: `Cancel order ${p.purchase_no}`, ok: 'Cancel order', danger: true });
      if (reason === null) return;
      await busy(co, async () => { await POST(`/api/purchases/${p.id}/cancel-order`, { reason }); toast('Order cancelled'); router(); });
    });
    const v = $('#voidBtn');
    if (v) v.addEventListener('click', async () => {
      const reason = await promptBox('Why cancel this purchase? Its pieces will be removed from stock.', { title: `Cancel ${p.purchase_no}`, ok: 'Cancel purchase', danger: true });
      if (reason === null) return;
      await busy(v, async () => { await POST(`/api/purchases/${p.id}/void`, { reason }); toast('Purchase cancelled'); router(); });
    });
  },
});

// The goods of a purchase order arrived: count them, then the pieces are added to stock.
View('purchases/:id/receive', {
  title: 'Receive purchase order',
  nav: 'purchases',
  allow: () => can('buy'),
  async render({ el, params }) {
    const p = await GET('/api/purchases/' + params.id);
    if (p.status !== 'ordered') return go('purchases/' + p.id);
    setTitle(`Receive ${p.purchase_no}`);
    setActions(`<a class="btn" href="#/purchases/${p.id}">← Back</a>`);
    const st = new Map(p.items.map((i) => [i.id, { qty: String(i.qty), cost: String(i.cost) }]));
    el.innerHTML = `
      <div class="card"><dl class="kv"><dt>Supplier</dt><dd>${p.supplier_id ? esc(p.supplier_name) : '—'}</dd><dt>Ordered</dt><dd>${esc(fmtDate(p.date))}${p.expected_date ? ` · expected ${esc(fmtDate(p.expected_date))}` : ''}</dd>
        <dt>Goes to</dt><dd>${esc(p.location_name)}</dd><dt>Pieces ordered</dt><dd><b>${p.total_qty}</b></dd></dl></div>
      <div class="card">
        <div class="alert info" style="margin-bottom:12px">Open the parcel and <b>count the pieces</b>. Type what really arrived in <b>Received</b> (it starts at what you ordered). The barcode labels come in the next step, so nothing needs to be scanned now.</div>
        <div id="lines"></div>
        <div class="form-grid three" style="margin-top:16px">
          <label class="field">Supplier's bill / invoice no.<input class="input" id="inv" value="${esc(p.invoice_no || '')}" placeholder="from the paper bill"></label>
          <label class="field">Amount paid to supplier now<input class="input num" id="paid" inputmode="decimal" placeholder="0"><span class="hint">Leave 0 if you will pay later — it will show as owed.</span></label>
          <label class="field">Notes<input class="input" id="notes" value="${esc(p.notes || '')}" placeholder="optional"></label>
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;align-items:center;flex-wrap:wrap">
          <div id="sumTxt" style="margin-right:auto"></div>
          <button class="btn ok lg" id="okBtn">✓ Confirm received &amp; add to stock</button>
        </div>
      </div>`;
    const num0 = (v) => Number(v) || 0;
    function render() {
      const got = [...st.values()].reduce((a, x) => a + (parseInt(x.qty, 10) || 0), 0);
      const total = p.items.reduce((a, i) => a + (parseInt(st.get(i.id).qty, 10) || 0) * num0(st.get(i.id).cost), 0);
      $('#sumTxt', el).innerHTML = `Received <b>${got}</b> of ${p.total_qty} pieces ${got === p.total_qty ? '<span class="pill ok">all arrived</span>' : got === 0 ? '<span class="pill red">nothing</span>' : '<span class="pill warn">not all</span>'} · bill total <b>${money(total)}</b>`;
      $$('[data-amt]', el).forEach((c) => { const x = st.get(Number(c.dataset.amt)); c.textContent = money((parseInt(x.qty, 10) || 0) * num0(x.cost)); });
    }
    $('#lines', el).innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th class="r">Ordered</th><th class="c">Received</th><th class="r">Cost price (each)</th><th class="r">Amount</th></tr></thead><tbody>
      ${p.items.map((i) => `<tr><td><b>${esc(i.name)}</b> <span class="muted">${esc(variantText(i))}</span></td><td class="r">${i.qty}</td>
        <td class="c"><input class="input sm num" style="width:80px;text-align:center" data-q="${i.id}" value="${i.qty}" inputmode="numeric"></td>
        <td class="r"><input class="input sm num" style="width:110px" data-c="${i.id}" value="${esc(i.cost)}" inputmode="decimal"></td><td class="r nowrap" data-amt="${i.id}"></td></tr>`).join('')}
      </tbody></table></div>`;
    $('#lines', el).addEventListener('input', (e) => {
      const q = e.target.dataset.q, c = e.target.dataset.c;
      if (q) st.get(Number(q)).qty = e.target.value;
      else if (c) st.get(Number(c)).cost = e.target.value;
      render();
    });
    render();
    const ok = $('#okBtn', el);
    ok.addEventListener('click', async () => {
      const got = [...st.values()].reduce((a, x) => a + (parseInt(x.qty, 10) || 0), 0);
      if (!got) return toast('Type how many pieces arrived', 'error');
      if (got !== p.total_qty && !(await confirmBox(`You counted ${got} pieces but ${p.total_qty} were ordered.\nOnly ${got} will be added to stock; the order is then closed.\n\nContinue?`, { title: 'Not all arrived', ok: 'Yes, add what arrived', danger: true }))) return;
      await busy(ok, async () => {
        await POST(`/api/purchases/${p.id}/receive`, {
          invoice_no: $('#inv', el).value.trim(), paid: $('#paid', el).value, notes: $('#notes', el).value.trim(),
          items: p.items.map((i) => ({ id: i.id, qty: st.get(i.id).qty, cost: st.get(i.id).cost })),
        });
        ProductCache.invalidate();
        toast(`${got} pieces added to stock`);
        go(`purchases/${p.id}?arrived=1`);
      });
    });
  },
});
