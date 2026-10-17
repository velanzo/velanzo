'use strict';
// Bills list, bill details, reprint and cancel (owner only).

async function showBill(id, onChange) {
  let s;
  try { s = await GET('/api/sales/' + id); } catch (e) { return toast(e.message, 'error'); }
  const showProfit = canSeeCost() && s.items.every((i) => i.cost != null);
  const m = modal({
    title: `Bill ${s.bill_no}`,
    size: 'wide',
    body: `
      ${s.status === 'void' ? `<div class="alert danger">This bill was cancelled${s.voided_by_name ? ' by ' + esc(s.voided_by_name) : ''} on ${esc(fmtDT(s.voided_at))}${s.void_reason ? ': ' + esc(s.void_reason) : ''}. Stock was put back.</div>` : ''}
      <dl class="kv"><dt>Date</dt><dd>${esc(fmtDT(s.created_at))}</dd><dt>Shop</dt><dd>${esc(s.location_name)}</dd>
        <dt>Cashier</dt><dd>${esc(s.user_name || '')}</dd><dt>Payment</dt><dd>${esc(METHOD_NAMES[s.payment_method])}</dd>
        ${s.customer_name || s.customer_phone ? `<dt>Customer</dt><dd>${esc(s.customer_name)} ${esc(s.customer_phone)}</dd>` : ''}</dl>
      <div class="table-wrap" style="margin-top:14px"><table class="tbl"><thead><tr><th>Item</th><th>Barcode</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Amount</th>${showProfit ? '<th class="r">Profit</th>' : ''}</tr></thead><tbody>
      ${s.items.map((i) => `<tr><td><b>${esc(i.name)}</b> <span class="muted">${esc(variantText(i))}</span> ${i.qty < 0 ? '<span class="pill red">RETURN</span>' : ''}</td><td class="mono">${esc(i.barcode)}</td>
        <td class="r">${i.qty}</td><td class="r">${money(i.price)}</td><td class="r">${money(i.qty * i.price)}</td>${showProfit ? `<td class="r">${money(i.qty * (i.price - i.cost))}</td>` : ''}</tr>`).join('')}
      </tbody><tfoot>
        <tr><td colspan="4" class="r">Subtotal</td><td class="r">${money(s.subtotal)}</td>${showProfit ? '<td></td>' : ''}</tr>
        ${s.discount ? `<tr><td colspan="4" class="r">Discount</td><td class="r">− ${money(s.discount)}</td>${showProfit ? '<td></td>' : ''}</tr>` : ''}
        <tr><td colspan="4" class="r">${s.total < 0 ? 'Refund' : 'Total'}</td><td class="r">${money(Math.abs(s.total))}</td>${showProfit ? '<td></td>' : ''}</tr>
        ${s.change_due ? `<tr><td colspan="4" class="r muted">Cash received ${money(s.paid)} · change</td><td class="r">${money(s.change_due)}</td>${showProfit ? '<td></td>' : ''}</tr>` : ''}
      </tfoot></table></div>`,
    footer: `${(isAdmin() || can('void_bills')) && s.status === 'done' ? '<button class="btn danger left" id="bVoid">Cancel this bill</button>' : ''}
      <button class="btn" data-close>Close</button><button class="btn primary" id="bPrint">${icon('printer')} Print bill</button>`,
  });
  m.$('#bPrint').addEventListener('click', () => printBill(s));
  const v = m.$('#bVoid');
  if (v) v.addEventListener('click', async () => {
    const reason = await promptBox('Why is this bill being cancelled? Items will go back into stock.', { title: `Cancel bill ${s.bill_no}`, ok: 'Cancel bill', danger: true, placeholder: 'e.g. wrong items scanned' });
    if (reason === null) return;
    await busy(v, async () => {
      await POST(`/api/sales/${s.id}/void`, { reason });
      toast('Bill cancelled and stock put back');
      m.close();
      onChange && onChange();
    });
  });
}

View('sales', {
  title: 'Bills',
  allow: () => can('sell') || isAdmin(),
  async render({ el, query }) {
    const st = { from: query.from || todayStr(), to: query.to || todayStr(), loc: query.location_id || '', q: '' };
    el.innerHTML = `
      <div class="toolbar">${rangeBarHtml(st)}
        ${isAdmin() ? `<select class="input" id="fLoc">${options(shops(), st.loc, { blank: 'All shops' })}</select>` : ''}
        <input class="input search" id="fQ" placeholder="Find bill no. (or scan bill barcode), customer name or phone">
      </div>
      <div class="stats" id="sumBox"></div>
      <div class="card flush" id="list"><div class="loading">Loading…</div></div>`;

    async function load() {
      const rows = await GET('/api/sales', { from: st.from, to: st.to, location_id: st.loc, q: st.q });
      if (!el.isConnected) return;
      $('.toolbar', el).querySelectorAll('[data-preset]').forEach((b) => {
        const [, f, t] = rangePresets()[b.dataset.preset];
        b.classList.toggle('on', !st.q && st.from === f && st.to === t);
      });
      $('[data-range=from]', el).value = st.from;
      $('[data-range=to]', el).value = st.to;
      const done = rows.filter((r) => r.status === 'done');
      const sum = (k) => done.reduce((a, r) => a + r[k], 0);
      const byMethod = (m) => done.filter((r) => r.payment_method === m).reduce((a, r) => a + r.total, 0);
      $('#sumBox', el).innerHTML = `
        <div class="card stat"><div class="label">${st.q ? 'Matching bills' : 'Sales'}</div><div class="value">${money(sum('total'))}</div><div class="sub">${done.length} bills · ${sum('items_qty')} pieces</div></div>
        <div class="card stat"><div class="label">Cash</div><div class="value">${money(byMethod('cash'))}</div></div>
        <div class="card stat"><div class="label">Card</div><div class="value">${money(byMethod('card'))}</div></div>
        <div class="card stat"><div class="label">Online</div><div class="value">${money(byMethod('online'))}</div></div>
        <div class="card stat"><div class="label">Discounts given</div><div class="value">${money(sum('discount'))}</div></div>`;
      $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Bill no.</th><th>Date & time</th>${isAdmin() ? '<th>Shop</th>' : ''}<th>Customer</th><th class="r">Pieces</th><th>Payment</th><th>Cashier</th><th class="r">Total</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="click${r.status === 'void' ? ' void' : ''}" data-id="${r.id}"><td><b>${esc(r.bill_no)}</b></td><td>${esc(fmtDT(r.created_at))}</td>${isAdmin() ? `<td>${esc(r.location_name)}</td>` : ''}
          <td>${esc(r.customer_name || '')} <span class="muted">${esc(r.customer_phone || '')}</span></td><td class="r">${r.items_qty}</td><td>${esc(METHOD_NAMES[r.payment_method])}</td><td>${esc(r.user_name || '')}</td>
          <td class="r nowrap"><b class="${r.total < 0 ? 'neg' : ''}">${money(r.total)}</b>${r.status === 'void' ? ' <span class="pill red">cancelled</span>' : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No bills for this period.</div>';
    }

    bindRangeBar(el, st, () => { st.q = ''; $('#fQ', el).value = ''; load(); });
    const fl = $('#fLoc', el);
    if (fl) fl.addEventListener('change', () => { st.loc = fl.value; load(); });
    let t;
    $('#fQ', el).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); load(); }, 300); });
    $('#fQ', el).addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const q = e.target.value.trim();
      if (!q) return;
      try { const s = await GET('/api/sales/by-bill/' + encodeURIComponent(q)); e.target.select(); showBill(s.id, load); } catch { /* not an exact bill no. */ }
    });
    $('#list', el).addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) showBill(+r.dataset.id, load); });
    await load();
  },
});
