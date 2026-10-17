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
  title: 'Purchases',
  allow: () => can('buy'),
  async render({ el }) {
    const st = { from: rangePresets().month[1], to: todayStr(), q: '' };
    setActions(`<a class="btn primary" href="#/purchases/new">${icon('plus')} New purchase</a>`);
    el.innerHTML = `<div class="toolbar">${rangeBarHtml(st)}<input class="input search" id="q" placeholder="Search purchase no., supplier or invoice no."></div>
      <div class="card flush" id="list"><div class="loading">Loading…</div></div>`;
    async function load() {
      const rows = await GET('/api/purchases', st);
      if (!el.isConnected) return;
      $$('[data-preset]', el).forEach((b) => { const [, f, t] = rangePresets()[b.dataset.preset]; b.classList.toggle('on', st.from === f && st.to === t); });
      $('[data-range=from]', el).value = st.from; $('[data-range=to]', el).value = st.to;
      const done = rows.filter((r) => r.status === 'done');
      $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Date</th><th>Supplier</th><th>Supplier invoice</th><th>Received at</th><th class="r">Pieces</th><th class="r">Amount</th><th class="r">Paid</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="click${r.status === 'void' ? ' void' : ''}" data-id="${r.id}"><td><b>${esc(r.purchase_no)}</b></td><td>${esc(fmtDate(r.date))}</td><td>${esc(r.supplier_name || '—')}</td><td>${esc(r.invoice_no || '')}</td><td>${esc(r.location_name)}</td>
          <td class="r">${r.total_qty}</td><td class="r"><b>${money(r.total)}</b></td><td class="r">${money(r.paid)}${r.status === 'void' ? ' <span class="pill red">cancelled</span>' : ''}</td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="5">Total (${done.length} purchases)</td><td class="r">${done.reduce((a, r) => a + r.total_qty, 0)}</td><td class="r">${money(done.reduce((a, r) => a + r.total, 0))}</td><td class="r">${money(done.reduce((a, r) => a + r.paid, 0))}</td></tr></tfoot></table></div>`
        : '<div class="empty">No purchases in this period. Click <b>New purchase</b> when stock arrives from a supplier.</div>';
    }
    bindRangeBar(el, st, load);
    let t;
    $('#q', el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); load(); }, 300); });
    $('#list', el).addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) go('purchases/' + r.dataset.id); });
    await load();
  },
});

View('purchases/new', {
  title: 'New purchase',
  nav: 'purchases',
  allow: () => can('buy'),
  async render({ el }) {
    const draftKey = `vz_purchase_${App.user.id}`;
    const blank = () => ({ supplier_id: '', invoice_no: '', date: todayStr(), location_id: isAdmin() ? warehouses()[0]?.id || '' : App.user.location_id, paid: '', notes: '', lines: [] });
    let S;
    try { S = { ...blank(), ...JSON.parse(localStorage.getItem(draftKey) || 'null') }; } catch { S = blank(); }
    const save = () => { try { localStorage.setItem(draftKey, JSON.stringify(S)); } catch { /* ignore */ } };
    let suppliers = await GET('/api/suppliers');
    const locs = isAdmin() ? App.locations.filter((l) => l.active) : App.locations.filter((l) => l.id === App.user.location_id);
    setActions(`<a class="btn" href="#/purchases">← Purchases</a>`);
    el.innerHTML = `
      <div class="card"><div class="form-grid four">
        <label class="field">Supplier<div style="display:flex;gap:6px;margin-top:5px"><select class="input" id="sup"></select><button class="btn" id="newSup" title="Add supplier">+</button></div></label>
        <label class="field">Supplier's bill / invoice no.<input class="input" id="inv" value="${esc(S.invoice_no)}"></label>
        <label class="field">Date<input class="input" type="date" id="date" value="${esc(S.date)}"></label>
        <label class="field">Stock goes into<select class="input" id="loc" ${locs.length < 2 ? 'disabled' : ''}>${options(locs, S.location_id)}</select></label>
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
        <label class="field">Amount paid to supplier now<input class="input num" id="paid" inputmode="decimal" placeholder="0" value="${esc(S.paid)}"><span class="hint">Leave 0 if you will pay later — it will show as owed.</span></label>
        <label class="field" style="grid-column: span 2">Notes<input class="input" id="notes" value="${esc(S.notes)}" placeholder="optional"></label>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;align-items:center">
        <div class="muted" id="sumTxt" style="margin-right:auto"></div>
        <button class="btn ghost" id="clr">Clear</button>
        <button class="btn ok lg" id="saveBtn">✓ Save purchase & add to stock</button>
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
    $('#paid', el).addEventListener('input', (e) => { S.paid = e.target.value; save(); });
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
        supplier_id: S.supplier_id, invoice_no: S.invoice_no, date: S.date, location_id: S.location_id, paid: S.paid, notes: S.notes,
        items: S.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, cost: l.cost, sale_price: l.sale_price })),
      });
      localStorage.removeItem(draftKey);
      ProductCache.invalidate();
      toast(`Purchase ${r.purchase_no} saved — stock added`);
      go(`purchases/${r.id}?new=1`);
    }));
  },
});

View('purchases/:id', {
  title: 'Purchase',
  nav: 'purchases',
  allow: () => can('buy'),
  async render({ el, params, query }) {
    const p = await GET('/api/purchases/' + params.id);
    setTitle(`Purchase ${p.purchase_no}`);
    setActions(`<a class="btn" href="#/purchases">← Purchases</a>${isAdmin() && p.status === 'done' ? '<button class="btn danger" id="voidBtn">Cancel purchase</button>' : ''}<button class="btn primary" id="lblBtn">${icon('printer')} Print barcode labels</button>`);
    el.innerHTML = `
      ${query.new ? `<div class="alert ok">✓ Saved. ${p.total_qty} pieces were added to ${esc(p.location_name)}. Next step: print barcode labels and stick them on the items.</div>` : ''}
      ${p.status === 'void' ? '<div class="alert danger">This purchase was cancelled — its stock was removed again.</div>' : ''}
      <div class="card"><dl class="kv">
        <dt>Supplier</dt><dd>${p.supplier_id ? `<a href="#/suppliers/${p.supplier_id}">${esc(p.supplier_name)}</a>` : '—'} ${esc(p.supplier_phone || '')}</dd>
        <dt>Supplier invoice</dt><dd>${esc(p.invoice_no || '—')}</dd><dt>Date</dt><dd>${esc(fmtDate(p.date))}</dd><dt>Received at</dt><dd>${esc(p.location_name)}</dd>
        <dt>Entered by</dt><dd>${esc(p.user_name || '')} · ${esc(fmtDT(p.created_at))}</dd>
        <dt>Total</dt><dd><b>${money(p.total)}</b> · paid now ${money(p.paid)}</dd>${p.notes ? `<dt>Notes</dt><dd>${esc(p.notes)}</dd>` : ''}</dl></div>
      <div class="card flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Barcode</th><th class="r">Qty</th><th class="r">Cost</th><th class="r">Sale price now</th><th class="r">Amount</th></tr></thead><tbody>
        ${p.items.map((i) => `<tr class="click" data-pid="${i.product_id}"><td><b>${esc(i.name)}</b> <span class="muted">${esc(variantText(i))}</span></td><td class="mono">${esc(i.barcode)}</td><td class="r">${i.qty}</td><td class="r">${money(i.cost)}</td><td class="r">${money(i.sale_price)}</td><td class="r">${money(i.qty * i.cost)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">Total</td><td class="r">${p.total_qty}</td><td></td><td></td><td class="r">${money(p.total)}</td></tr></tfoot></table></div></div>`;
    $('.tbl', el).addEventListener('click', (e) => { const r = e.target.closest('[data-pid]'); if (r) go('products/' + r.dataset.pid); });
    $('#lblBtn').addEventListener('click', () => {
      addToLabelQueue(p.items.map((i) => ({ product: { id: i.product_id, name: i.name, size: i.size, color: i.color, barcode: i.barcode, sale_price: i.sale_price }, copies: i.qty })), true);
      go('labels');
    });
    const v = $('#voidBtn');
    if (v) v.addEventListener('click', async () => {
      const reason = await promptBox('Why cancel this purchase? Its pieces will be removed from stock.', { title: `Cancel ${p.purchase_no}`, ok: 'Cancel purchase', danger: true });
      if (reason === null) return;
      await busy(v, async () => { await POST(`/api/purchases/${p.id}/void`, { reason }); toast('Purchase cancelled'); router(); });
    });
  },
});
