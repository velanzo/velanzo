'use strict';
// Products: add (with sizes × colours), edit, history, stock correction, import from Excel.

const MOVE_NAMES = { purchase: 'Purchased', opening: 'Opening stock', dispatch_out: 'Sent out', dispatch_in: 'Received', sale: 'Sold', return: 'Customer return', adjust: 'Stock correction', void: 'Cancelled' };
const QUICK_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', 'Free Size'];
let productMeta = null;
async function loadMeta(force) {
  if (!productMeta || force) productMeta = await GET('/api/product-meta');
  return productMeta;
}
const splitList = (s) => [...new Set(String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];

// opts: { forPurchase, onCreated(list) }
async function openAddProduct({ forPurchase = false, onCreated } = {}) {
  const meta = await loadMeta(true);
  const locs = isAdmin() ? App.locations.filter((l) => l.active) : App.locations.filter((l) => l.id === App.user.location_id);
  const m = modal({
    title: 'Add new item',
    size: 'wide',
    body: `
      <div class="form-grid">
        <label class="field full">Item name *<input class="input" name="name" placeholder="e.g. Lawn Kurta Embroidered" autofocus></label>
        <label class="field">Category<input class="input" name="category" list="dlCat" placeholder="e.g. Kurta, Shirt, Jeans"></label>
        <div class="form-grid" style="gap:14px">
          <label class="field">Cost price<input class="input num" name="cost_price" inputmode="decimal" placeholder="0"></label>
          <label class="field">Sale price<input class="input num" name="sale_price" inputmode="decimal" placeholder="0"></label>
        </div>
        <label class="field full">Sizes <span class="hint">— click to add, or type them separated by commas. Leave empty if there are no sizes.</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">${QUICK_SIZES.map((s) => `<button type="button" class="btn sm" data-size="${esc(s)}">${esc(s)}</button>`).join('')}</div>
          <input class="input" name="sizes" placeholder="e.g. S, M, L, XL   or   28, 30, 32, 34"></label>
        <label class="field full">Colours <span class="hint">— separated by commas. Leave empty if there is only one colour.</span>
          <input class="input" name="colors" list="dlColor" placeholder="e.g. Black, Navy Blue, Maroon"></label>
      </div>
      <datalist id="dlCat">${meta.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="dlColor">${meta.colors.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div style="margin-top:18px" id="varBox"></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="apSave">Save item${forPurchase ? ' & add to purchase' : ''}</button>`,
  });
  const keep = new Map(); // remembers typed barcode / qty per variant while sizes change
  const f = () => formValues(m.el);
  function variants() {
    const sizes = splitList(f().sizes), colors = splitList(f().colors);
    const out = [];
    for (const c of colors.length ? colors : ['']) for (const s of sizes.length ? sizes : ['']) out.push({ size: s, color: c, key: `${s}|${c}` });
    return out;
  }
  function renderVariants() {
    const vs = variants();
    m.$('#varBox').innerHTML = `<div class="muted small" style="margin-bottom:6px">This will create <b>${vs.length}</b> item${vs.length > 1 ? 's' : ''}, each with its own barcode:</div>
      <div class="table-wrap" style="max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:8px"><table class="tbl"><thead><tr><th>Item</th><th>Barcode <span class="muted" style="text-transform:none">(leave empty = make one)</span></th>
      ${forPurchase ? '' : `<th class="r">Opening stock</th>`}</tr></thead><tbody>
      ${vs.map((v) => { const k = keep.get(v.key) || {}; return `<tr data-key="${esc(v.key)}"><td><b>${esc(f().name || 'Item')}</b> <span class="muted">${esc([v.size, v.color].filter(Boolean).join(' / '))}</span></td>
        <td><input class="input sm" data-f="barcode" value="${esc(k.barcode || '')}" placeholder="auto"></td>
        ${forPurchase ? '' : `<td class="r"><input class="input sm num" style="width:90px" data-f="opening_qty" value="${esc(k.opening_qty || '')}" placeholder="0" inputmode="numeric"></td>`}</tr>`; }).join('')}
      </tbody></table></div>
      ${forPurchase ? '' : `<label class="field" style="margin-top:12px;max-width:300px">Opening stock is at<select class="input" name="opening_location_id">${options(locs, locs.find((l) => l.type === 'warehouse')?.id)}</select>
        <span class="hint">Only for stock you already have. New stock from a supplier should be entered as a Purchase.</span></label>`}`;
  }
  m.el.addEventListener('input', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) { const k = keep.get(tr.dataset.key) || {}; k[e.target.dataset.f] = e.target.value; keep.set(tr.dataset.key, k); return; }
    if (['sizes', 'colors', 'name'].includes(e.target.name)) renderVariants();
  });
  m.$$('[data-size]').forEach((b) => b.addEventListener('click', () => {
    const inp = m.$('[name=sizes]');
    const list = splitList(inp.value);
    const s = b.dataset.size;
    inp.value = (list.includes(s) ? list.filter((x) => x !== s) : [...list, s]).join(', ');
    renderVariants();
  }));
  renderVariants();
  const save = m.$('#apSave');
  save.addEventListener('click', () => busy(save, async () => {
    const v = f();
    if (!v.name) throw new Error('Enter the item name');
    const body = {
      name: v.name, category: v.category, cost_price: v.cost_price, sale_price: v.sale_price, opening_location_id: v.opening_location_id,
      variants: variants().map((x) => ({ size: x.size, color: x.color, ...(keep.get(x.key) || {}) })),
    };
    const created = await POST('/api/products', body);
    created.forEach((p) => { p.loc_qty = 0; ProductCache.add(p); });
    productMeta = null;
    toast(`${created.length} item${created.length > 1 ? 's' : ''} added`);
    m.close();
    onCreated && onCreated(created);
  }));
}

async function openEditProduct(p, onSaved) {
  const meta = await loadMeta();
  const m = modal({
    title: 'Edit item',
    body: `<div class="form-grid">
      <label class="field full">Item name<input class="input" name="name" value="${esc(p.name)}"></label>
      <label class="field">Size<input class="input" name="size" value="${esc(p.size || '')}"></label>
      <label class="field">Colour<input class="input" name="color" list="dlColor2" value="${esc(p.color || '')}"></label>
      <label class="field">Category<input class="input" name="category" list="dlCat2" value="${esc(p.category || '')}"></label>
      <label class="field">Barcode<input class="input mono" name="barcode" value="${esc(p.barcode)}"><span class="hint">Change only if the printed labels are wrong.</span></label>
      <label class="field">Cost price<input class="input num" name="cost_price" value="${esc(p.cost_price ?? '')}"></label>
      <label class="field">Sale price<input class="input num" name="sale_price" value="${esc(p.sale_price)}"></label>
      <label class="check full"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Item is in use (untick to hide old items from lists)</label>
      </div>
      <datalist id="dlCat2">${meta.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="dlColor2">${meta.colors.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="epSave">Save</button>`,
  });
  const save = m.$('#epSave');
  save.addEventListener('click', () => busy(save, async () => {
    const out = await PUT('/api/products/' + p.id, formValues(m.el));
    ProductCache.invalidate();
    productMeta = null;
    toast('Item saved');
    m.close();
    onSaved && onSaved(out);
  }));
}

function openAdjust(p, locId, onDone) {
  const locs = isAdmin() ? App.locations.filter((l) => l.active) : App.locations.filter((l) => l.id === App.user.location_id);
  const m = modal({
    title: 'Correct stock',
    body: `<div style="margin-bottom:12px"><b>${esc(p.name)}</b> <span class="muted">${esc(variantText(p))} · ${esc(p.barcode)}</span></div>
      <div class="form-grid">
        <label class="field">Location<select class="input" name="location_id">${options(locs, locId || locs[0]?.id)}</select></label>
        <label class="field">What happened?<select class="input" name="mode">
          <option value="set">I counted it — set the exact number</option><option value="remove">Remove pieces (damaged / lost)</option><option value="add">Add pieces (found)</option></select></label>
        <label class="field">Quantity<input class="input num big" name="qty" inputmode="numeric" autofocus></label>
        <label class="field">Reason<input class="input" name="reason" list="dlReason" placeholder="e.g. Counted in stock check"></label>
      </div>
      <datalist id="dlReason"><option value="Stock count"><option value="Damaged"><option value="Lost / stolen"><option value="Found extra"><option value="Given as gift / sample"></datalist>
      <div class="alert info" id="adjNow" style="margin:14px 0 0"></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="adjSave">Save correction</button>`,
  });
  const showNow = async () => {
    const lid = Number(m.$('[name=location_id]').value);
    try {
      const d = await GET('/api/products/' + p.id);
      const q = d.stock.find((s) => s.location_id === lid)?.qty ?? 0;
      m.$('#adjNow').innerHTML = `The system currently shows <b>${q}</b> at ${esc(locName(lid))}.`;
    } catch { /* ignore */ }
  };
  m.$('[name=location_id]').addEventListener('change', showNow);
  showNow();
  const save = m.$('#adjSave');
  save.addEventListener('click', () => busy(save, async () => {
    const v = formValues(m.el);
    const n = parseInt(v.qty, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error('Enter a quantity (0 or more)');
    const body = { product_id: p.id, location_id: v.location_id, reason: v.reason, mode: v.mode === 'set' ? 'set' : 'add', qty: v.mode === 'remove' ? -n : n };
    const r = await POST('/api/stock/adjust', body);
    ProductCache.invalidate();
    toast(`Stock is now ${r.qty} (${r.change >= 0 ? '+' : ''}${r.change})`);
    m.close();
    onDone && onDone();
  }));
}

const IMPORT_FIELDS = {
  barcode: ['barcode', 'code', 'bar_code'],
  name: ['name', 'item', 'item_name', 'product', 'product_name', 'article'],
  category: ['category', 'type'],
  size: ['size'],
  color: ['color', 'colour'],
  cost_price: ['cost_price', 'cost', 'purchase_price'],
  sale_price: ['sale_price', 'price', 'retail_price', 'selling_price'],
  qty: ['qty', 'quantity', 'stock', 'opening_stock', 'total_stock'],
};
function mapImportRow(r) {
  const out = {};
  for (const [k, names] of Object.entries(IMPORT_FIELDS)) { const n = names.find((x) => r[x] !== undefined); if (n) out[k] = r[n]; }
  return out;
}

function openImportProducts(onDone) {
  const locs = isAdmin() ? App.locations.filter((l) => l.active) : App.locations.filter((l) => l.id === App.user.location_id);
  let rows = [];
  const m = modal({
    title: 'Import items from Excel',
    size: 'wide',
    body: `<ol style="margin:0 0 14px;padding-left:20px;line-height:1.7">
        <li><a href="#" id="tplLink">Download the template</a> and open it in Excel.</li>
        <li>Fill one row per item (per size/colour). Columns: <b>name</b>, category, size, color, cost_price, sale_price, qty, barcode.<br>
          <span class="muted small">Leave <b>barcode</b> empty to make new barcodes. Items with an existing barcode get updated; <b>qty</b> is added to stock.</span></li>
        <li>In Excel choose <b>File → Save As → CSV UTF-8</b>, then pick that file below.</li></ol>
      <div class="form-grid">
        <label class="field">CSV file<input class="input" type="file" id="impFile" accept=".csv,text/csv" style="padding-top:7px"></label>
        <label class="field">Put the quantities into stock at<select class="input" id="impLoc">${options(locs, locs.find((l) => l.type === 'warehouse')?.id)}</select></label>
      </div>
      <div id="impPrev" style="margin-top:14px"></div>`,
    footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="impGo" disabled>Import</button>`,
  });
  m.$('#tplLink').addEventListener('click', (e) => {
    e.preventDefault();
    downloadText('velanzo-items-template.csv', 'name,category,size,color,cost_price,sale_price,qty,barcode\r\nLawn Kurta,Kurta,M,Blue,1200,2450,10,\r\nLawn Kurta,Kurta,L,Blue,1200,2450,8,\r\n');
  });
  m.$('#impFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      rows = parseCsv(await readFileText(file)).map(mapImportRow).filter((r) => r.name || r.barcode);
    } catch (err) { rows = []; toast(err.message, 'error'); }
    const qty = rows.reduce((a, r) => a + (parseInt(r.qty, 10) || 0), 0);
    m.$('#impPrev').innerHTML = rows.length ? `<div class="alert info">Found <b>${rows.length}</b> rows and <b>${qty}</b> pieces. First rows:</div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Category</th><th>Size</th><th>Colour</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Qty</th><th>Barcode</th></tr></thead><tbody>
      ${rows.slice(0, 6).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.category)}</td><td>${esc(r.size)}</td><td>${esc(r.color)}</td><td class="r">${esc(r.cost_price)}</td><td class="r">${esc(r.sale_price)}</td><td class="r">${esc(r.qty)}</td><td>${esc(r.barcode || 'new')}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="alert danger">No rows found. Check that the first row has the column names (name, size, …).</div>';
    m.$('#impGo').disabled = !rows.length;
  });
  const go2 = m.$('#impGo');
  go2.addEventListener('click', () => busy(go2, async () => {
    const r = await POST('/api/import/products', { rows, location_id: m.$('#impLoc').value });
    ProductCache.invalidate();
    productMeta = null;
    m.close();
    modal({ title: 'Import finished', body: `<p><b>${r.created}</b> new items added, <b>${r.updated}</b> existing items updated, <b>${r.stocked}</b> pieces added to stock.</p><p class="muted">New items need barcode labels — go to <b>Barcode labels</b> to print them.</p>`, footer: '<button class="btn primary" data-close>OK</button>' });
    onDone && onDone();
  }));
}

View('products', {
  title: 'Products',
  allow: () => can('add_items') || can('buy') || isAdmin(),
  async render({ el }) {
    const st = { q: '', category: '', hidden: false };
    const meta = await loadMeta(true);
    setActions(`<button class="btn" id="impBtn">${icon('upload')} Import from Excel</button><button class="btn primary" id="addBtn">${icon('plus')} Add item</button>`);
    el.innerHTML = `
      <div class="toolbar">
        <input class="input search" id="q" placeholder="Search by name, barcode, colour, size… (or scan)" autofocus>
        <select class="input" id="cat">${options(meta.categories, '', { blank: 'All categories' })}</select>
        <label class="check"><input type="checkbox" id="hid"> Show hidden items</label>
        <button class="btn" id="lblBtn" disabled>${icon('printer')} Labels for selected</button>
      </div>
      <div class="card flush" id="list"><div class="loading">Loading…</div></div>`;
    let rows = [];
    const selected = new Set();
    async function load() {
      rows = await GET('/api/products', { q: st.q, category: st.category, active: st.hidden ? 'all' : '' });
      if (!el.isConnected) return;
      $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th style="width:34px"><input type="checkbox" id="selAll"></th><th>Item</th><th>Size</th><th>Colour</th><th>Category</th><th>Barcode</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Stock (all)</th></tr></thead><tbody>
        ${rows.map((p) => `<tr class="click" data-id="${p.id}"><td><input type="checkbox" data-sel="${p.id}" ${selected.has(p.id) ? 'checked' : ''}></td>
          <td><b>${esc(p.name)}</b>${p.active ? '' : ' <span class="pill">hidden</span>'}</td><td>${esc(p.size || '')}</td><td>${esc(p.color || '')}</td><td>${esc(p.category || '')}</td>
          <td class="mono">${esc(p.barcode)}</td><td class="r">${money(p.cost_price)}</td><td class="r">${money(p.sale_price)}</td><td class="r ${qtyClass(p.stock_total)}">${p.stock_total}</td></tr>`).join('')}
        </tbody></table></div>${rows.length >= 1000 ? '<div class="empty small">Showing the first 1000 items — type in the search box to find others.</div>' : ''}`
        : `<div class="empty">${st.q || st.category ? 'No items match your search.' : 'No items yet. Click <b>Add item</b> or <b>Import from Excel</b> to start.'}</div>`;
      updateSel();
    }
    function updateSel() {
      const b = $('#lblBtn', el);
      b.disabled = !selected.size;
      b.innerHTML = `${icon('printer')} Labels for selected${selected.size ? ` (${selected.size})` : ''}`;
    }
    let t;
    $('#q', el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); load(); }, 250); });
    $('#cat', el).addEventListener('change', (e) => { st.category = e.target.value; load(); });
    $('#hid', el).addEventListener('change', (e) => { st.hidden = e.target.checked; load(); });
    $('#list', el).addEventListener('click', (e) => {
      if (e.target.id === 'selAll') { rows.forEach((p) => (e.target.checked ? selected.add(p.id) : selected.delete(p.id))); $$('[data-sel]', el).forEach((c) => { c.checked = e.target.checked; }); return updateSel(); }
      if (e.target.dataset.sel) { const id = +e.target.dataset.sel; e.target.checked ? selected.add(id) : selected.delete(id); return updateSel(); }
      const r = e.target.closest('[data-id]');
      if (r) go('products/' + r.dataset.id);
    });
    $('#lblBtn', el).addEventListener('click', async () => {
      const all = await GET('/api/products', { active: 'all', all: 1 });
      addToLabelQueue(all.filter((p) => selected.has(p.id)).map((p) => ({ product: p, copies: Math.max(1, p.stock_total) })));
      go('labels');
    });
    $('#addBtn').addEventListener('click', () => openAddProduct({ onCreated: (list) => { if (list.length) { addToLabelQueue(list.map((p) => ({ product: p, copies: 1 }))); load(); askLabels(list); } } }));
    $('#impBtn').addEventListener('click', () => openImportProducts(load));
    await load();
  },
});

async function askLabels(list) {
  if (await confirmBox(`Print barcode labels for the ${list.length} new item${list.length > 1 ? 's' : ''} now?\nThey were added to the label list.`, { title: 'Barcode labels', ok: 'Go to labels' })) go('labels');
}

View('products/:id', {
  title: 'Item details',
  nav: 'products',
  allow: () => can('add_items') || can('buy') || isAdmin(),
  async render({ el, params }) {
    const d = await GET('/api/products/' + params.id);
    const p = d.product;
    setTitle(p.name + (variantText(p) ? ` — ${variantText(p)}` : ''));
    setActions(`<a class="btn" href="#/products">← All products</a><button class="btn" id="adjBtn">Correct stock</button><button class="btn" id="lblBtn">${icon('printer')} Labels</button><button class="btn primary" id="editBtn">Edit</button>`);
    el.innerHTML = `
      <div class="grid-2" style="margin-top:0">
        <div class="card"><div style="display:flex;gap:18px;flex-wrap:wrap">
          <dl class="kv grow"><dt>Barcode</dt><dd class="mono">${esc(p.barcode)}</dd><dt>Category</dt><dd>${esc(p.category || '—')}</dd><dt>Size</dt><dd>${esc(p.size || '—')}</dd><dt>Colour</dt><dd>${esc(p.color || '—')}</dd>
            <dt>Cost price</dt><dd>${money(p.cost_price)}</dd><dt>Sale price</dt><dd><b>${money(p.sale_price)}</b></dd>
            <dt>Profit per piece</dt><dd>${money(p.sale_price - p.cost_price)} ${p.sale_price ? `<span class="muted">(${Math.round(((p.sale_price - p.cost_price) / p.sale_price) * 100)}%)</span>` : ''}</dd>
            <dt>Total sold</dt><dd>${d.sold} pieces</dd><dt>Status</dt><dd>${p.active ? '<span class="pill ok">In use</span>' : '<span class="pill">Hidden</span>'}</dd></dl>
          <div>${labelPreviewHtml(p)}</div></div></div>
        <div class="card flush"><div style="padding:18px 18px 0"><h3>Stock now</h3></div><table class="tbl"><thead><tr><th>Location</th><th class="r">Pieces</th></tr></thead><tbody>
          ${d.stock.map((s) => `<tr><td>${esc(s.name)} <span class="pill">${s.type}</span></td><td class="r ${qtyClass(s.qty)}"><b>${s.qty}</b></td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td class="r">${d.stock.reduce((a, s) => a + s.qty, 0)}</td></tr></tfoot></table></div>
      </div>
      <div class="card flush" style="margin-top:16px"><div style="padding:18px 18px 0"><h3>History — where this item moved</h3></div>
        ${d.movements.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date & time</th><th>What</th><th>Location</th><th class="r">Change</th><th>Reference</th><th>By</th><th>Note</th></tr></thead><tbody>
        ${d.movements.map((mv) => `<tr><td class="nowrap">${esc(fmtDT(mv.created_at))}</td><td>${esc(MOVE_NAMES[mv.type] || mv.type)}</td><td>${esc(mv.location_name)}</td>
          <td class="r"><b class="${mv.qty < 0 ? 'neg' : 'plus'}">${mv.qty > 0 ? '+' : ''}${mv.qty}</b></td>
          <td>${mv.ref_no ? (mv.ref_type === 'purchase' ? `<a href="#/purchases/${mv.ref_id}">${esc(mv.ref_no)}</a>` : mv.ref_type === 'dispatch' ? `<a href="#/dispatch/${mv.ref_id}">${esc(mv.ref_no)}</a>` : `<a href="#" data-bill="${mv.ref_id}">${esc(mv.ref_no)}</a>`) : ''}</td>
          <td>${esc(mv.user_name || '')}</td><td class="muted">${esc(mv.note || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No movements yet.</div>'}
      </div>`;
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-bill]'); if (b) { e.preventDefault(); showBill(+b.dataset.bill); } });
    $('#editBtn').addEventListener('click', () => openEditProduct(p, () => router()));
    $('#adjBtn').addEventListener('click', () => openAdjust(p, isAdmin() ? null : App.user.location_id, () => router()));
    $('#lblBtn').addEventListener('click', () => { addToLabelQueue([{ product: p, copies: 1 }]); go('labels'); });
  },
});
