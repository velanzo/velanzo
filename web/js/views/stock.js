'use strict';
// Stock: how many pieces of each item are at the warehouse and every shop.

View('stock', {
  title: 'Stock',
  async render({ el, query }) {
    const meta = await GET('/api/product-meta');
    const st = { q: '', category: '', location_id: query.location_id || '', low: query.low === '1', zero: false };
    const many = App.locations.filter((l) => l.active).length > 1;
    if (isAdmin()) { setActions(`<button class="btn" id="xlStock">${icon('download')} Excel</button>`); $('#xlStock').addEventListener('click', () => download('/api/export/stock')); }
    el.innerHTML = `
      <div class="toolbar">
        <input class="input search" id="q" placeholder="Search by name, barcode, colour, size… (or scan)" autofocus>
        ${many ? `<select class="input" id="loc">${options(App.locations.filter((l) => l.active), st.location_id, { blank: 'All locations' })}</select>` : ''}
        <select class="input" id="cat">${options(meta.categories, '', { blank: 'All categories' })}</select>
        <label class="check"><input type="checkbox" id="low" ${st.low ? 'checked' : ''}> Low stock only</label>
        <label class="check"><input type="checkbox" id="zero"> Include items with 0</label>
      </div>
      <div class="stats" id="sum"></div>
      <div class="card flush" id="list"><div class="loading">Loading…</div></div>`;
    async function load() {
      const d = await GET('/api/stock', { q: st.q, category: st.category, location_id: st.location_id, low: st.low ? 1 : '', zero: st.zero ? 1 : '' });
      if (!el.isConnected) return;
      const showCost = canSeeCost();
      const multi = d.locations.length > 1;
      $('#sum', el).innerHTML = `
        <div class="card stat"><div class="label">Pieces${st.low ? ' (low items)' : ''}</div><div class="value">${num(d.totals.units)}</div><div class="sub">${d.rows.length} items</div></div>
        ${showCost ? `<div class="card stat"><div class="label">Value at cost</div><div class="value">${money(d.totals.cost_value)}</div></div>` : ''}
        <div class="card stat"><div class="label">Value at sale price</div><div class="value">${money(d.totals.sale_value)}</div></div>
        ${multi ? d.locations.map((l) => `<div class="card stat"><div class="label">${esc(l.name)}</div><div class="value">${num(d.totals.by_location[l.id] || 0)}</div><div class="sub">pieces</div></div>`).join('') : ''}`;
      const canAdjust = can('correct_stock');
      $('#list', el).innerHTML = d.rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Size</th><th>Colour</th><th>Barcode</th><th class="r">Price</th>
        ${d.locations.map((l) => `<th class="r">${esc(l.name)}</th>`).join('')}${multi ? '<th class="r">Total</th>' : ''}${canAdjust ? '<th></th>' : ''}</tr></thead><tbody>
        ${d.rows.map((r) => `<tr${canAdjust ? ` class="click" data-id="${r.id}"` : ''}><td><b>${esc(r.name)}</b>${r.active ? '' : ' <span class="pill">hidden</span>'}</td><td>${esc(r.size || '')}</td><td>${esc(r.color || '')}</td><td class="mono small">${esc(r.barcode)}</td><td class="r">${money(r.sale_price)}</td>
          ${d.locations.map((l) => { const q = r.qty[l.id] || 0; return `<td class="r ${qtyClass(q)}">${q}</td>`; }).join('')}
          ${multi ? `<td class="r"><b>${r.total}</b></td>` : ''}${canAdjust ? `<td class="c"><button class="btn sm" data-adj="${r.id}">Correct</button></td>` : ''}</tr>`).join('')}
        </tbody></table></div>`
        : `<div class="empty">${st.low ? `No items at ${d.low_threshold} pieces or fewer.` : 'No stock found.'}</div>`;
      $('#list', el).onclick = (e) => {
        const adj = e.target.closest('[data-adj]');
        const row = d.rows.find((r) => r.id === Number((adj || e.target.closest('[data-id]'))?.dataset[adj ? 'adj' : 'id']));
        if (!row) return;
        if (adj) openAdjust(row, st.location_id || (isAdmin() ? null : App.user.location_id), load);
        else go('products/' + row.id);
      };
    }
    let t;
    $('#q', el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); load(); }, 250); });
    $('#cat', el).addEventListener('change', (e) => { st.category = e.target.value; load(); });
    const loc = $('#loc', el);
    if (loc) loc.addEventListener('change', (e) => { st.location_id = e.target.value; load(); });
    $('#low', el).addEventListener('change', (e) => { st.low = e.target.checked; load(); });
    $('#zero', el).addEventListener('change', (e) => { st.zero = e.target.checked; load(); });
    await load();
  },
});
