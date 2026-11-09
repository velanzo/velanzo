'use strict';
// Customers: who they are, what they still owe, and the money they bring later (set against their oldest bills first).

// The "Payment received" box. sale: for that one bill only. done(): after it is saved.
function receivePayment(customer, { sale = null, owed = 0, done } = {}) {
  const m = modal({
    title: `Payment from ${customer.name}`,
    body: `<p style="margin-top:0">Still owed${sale ? ` on bill <b>${esc(sale.bill_no)}</b>` : ''}: <b class="neg">${money(owed)}</b></p>
      <div class="form-grid">
        <label class="field">Amount received<input class="input num big" id="pAmt" inputmode="decimal" value="${round2(owed)}" autofocus></label>
        <label class="field">Paid by<select class="input" id="pMethod">${options([['cash', 'Cash'], ['card', 'Card'], ['online', 'Online']], 'cash')}</select></label>
        <label class="field full">Note (optional)<input class="input" id="pNote" placeholder="e.g. paid by her son"></label></div>
      ${sale ? '' : '<p class="muted small" style="margin-bottom:0">The money goes to the oldest bills first. Less than the full amount is fine: the rest stays owed.</p>'}`,
    footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="pOk">Save payment</button>',
  });
  const b = m.$('#pOk');
  const save = () => busy(b, async () => {
    const r = await POST(`/api/customers/${customer.id}/payments`, { amount: m.$('#pAmt').value, method: m.$('#pMethod').value, note: m.$('#pNote').value, sale_id: sale ? sale.id : '' });
    m.close();
    toast(r.owed > 0 ? `Payment saved. ${customer.name} still owes ${money(r.owed)}.` : `Payment saved. ${customer.name} owes nothing now.`, 'ok', 5000);
    if (done) done();
  });
  b.addEventListener('click', save);
  m.$('#pAmt').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// Add or change a customer → the saved customer.
function editCustomer(c) {
  return new Promise((resolve) => {
    let saved = null;
    const m = modal({
      title: c ? c.name : 'New customer',
      body: `<div class="form-grid">
        <label class="field">Name<input class="input" name="name" value="${esc(c?.name || '')}" autofocus></label>
        <label class="field">Phone<input class="input" name="phone" value="${esc(c?.phone || '')}" inputmode="tel"></label>
        <label class="field full">Address<input class="input" name="address" value="${esc(c?.address || '')}"></label>
        <label class="field full">Notes<input class="input" name="notes" value="${esc(c?.notes || '')}"></label></div>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="cSave">Save</button>',
      onClose: () => resolve(saved),
    });
    const b = m.$('#cSave');
    b.addEventListener('click', () => busy(b, async () => {
      const v = formValues(m.el);
      saved = c ? await PUT('/api/customers/' + c.id, v) : await POST('/api/customers', v);
      m.close();
    }));
  });
}

// Choose who a bill is for: search by name or phone, or add a new customer → the customer, or null.
function pickCustomer() {
  return new Promise((resolve) => {
    let picked = null, list = [];
    const m = modal({
      title: 'Which customer?',
      body: `<input class="input" id="cq" placeholder="Search by name or phone" autocomplete="off" autofocus>
        <div id="cList" class="pick-list" style="margin-top:10px;max-height:300px;overflow:auto"></div>`,
      footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="cNew">＋ New customer</button>',
      onClose: () => resolve(picked),
    });
    const paint = () => {
      m.$('#cList').innerHTML = list.length ? `<table class="tbl"><tbody>${list.map((c, i) => `<tr class="click" data-i="${i}"><td><b>${esc(c.name)}</b></td><td>${esc(c.phone || '')}</td>
        <td class="r">${c.owed > 0 ? `<span class="pill red">owes ${money(c.owed)}</span>` : ''}</td></tr>`).join('')}</tbody></table>`
        : '<div class="muted">No customer found. Press <b>New customer</b> to add one.</div>';
    };
    let t;
    const load = async () => { try { list = await GET('/api/customers', { q: m.$('#cq').value.trim() }); } catch (e) { list = []; toast(e.message, 'error'); } paint(); };
    m.$('#cq').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    m.$('#cq').addEventListener('keydown', (e) => { if (e.key === 'Enter' && list.length === 1) { picked = list[0]; m.close(); } });
    m.$('#cList').addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) { picked = list[+r.dataset.i]; m.close(); } });
    m.$('#cNew').addEventListener('click', async () => {
      const q = m.$('#cq').value.trim();
      const c = await editCustomer(/^[\d+ -]{6,}$/.test(q) ? { phone: q } : { name: q });
      if (c) { picked = c; m.close(); }
    });
    load();
  });
}

View('customers', {
  title: 'Customers',
  allow: () => isAdmin() || can('sell'),
  async render({ el }) {
    setActions(`<button class="btn primary" id="addCust">${icon('plus')} New customer</button>`);
    el.innerHTML = `<div class="toolbar"><input class="input search" id="q" placeholder="Search by name or phone"></div>
      <div class="stats" id="sum"></div><div class="card flush" id="list"><div class="loading">Loading…</div></div>`;
    const load = async () => {
      const rows = await GET('/api/customers', { q: $('#q', el).value.trim() });
      if (!el.isConnected) return;
      const owing = rows.filter((r) => r.owed > 0);
      $('#sum', el).innerHTML = `<div class="card stat"><div class="label">Customers owe</div><div class="value ${owing.length ? 'neg' : ''}">${money(owing.reduce((a, r) => a + r.owed, 0))}</div>
        <div class="sub">${owing.length} customer${owing.length === 1 ? '' : 's'} with open bills</div></div>
        <div class="card stat"><div class="label">Customers</div><div class="value">${rows.length}</div></div>`;
      $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Phone</th><th class="r">Open bills</th><th>Last bill</th><th class="r">Still owes</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="click" data-id="${r.id}"><td><b>${esc(r.name)}</b></td><td>${esc(r.phone || '')}</td><td class="r">${r.open_bills || ''}</td>
          <td>${r.last_bill ? esc(fmtDate(r.last_bill)) : '<span class="muted">—</span>'}</td><td class="r">${r.owed > 0 ? `<b class="neg">${money(r.owed)}</b>` : '<span class="muted">nothing</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No customers yet. They are added on the sale screen with <b>Confirm — pays later</b>, or here with <b>New customer</b>.</div>';
    };
    let t;
    $('#q', el).addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    $('#list', el).addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) go('customers/' + r.dataset.id); });
    $('#addCust').addEventListener('click', async () => { const c = await editCustomer(null); if (c) go('customers/' + c.id); });
    await load();
  },
});

View('customers/:id', {
  title: 'Customer',
  nav: 'customers',
  allow: () => isAdmin() || can('sell'),
  async render({ el, params }) {
    const c = await GET('/api/customers/' + params.id);
    setTitle(c.name);
    setActions(`<button class="btn" id="editC">Edit</button>${c.owed > 0 ? '<button class="btn primary" id="payC">Payment received</button>' : ''}`);
    el.innerHTML = `
      <div class="stats">
        <div class="card stat"><div class="label">Still owes</div><div class="value ${c.owed > 0 ? 'neg' : ''}">${money(c.owed)}</div><div class="sub">${c.bills.filter((b) => b.open > 0).length} open bill(s)</div></div>
        <div class="card stat"><div class="label">Bought in all</div><div class="value">${money(c.bills.filter((b) => b.status === 'done').reduce((a, b) => a + b.total, 0))}</div><div class="sub">${c.bills.length} bill(s)</div></div>
        <div class="card stat"><div class="label">Contact</div><div class="value" style="font-size:18px">${esc(c.phone || '—')}</div><div class="sub">${esc(c.address || '')}</div></div>
      </div>
      ${c.notes ? `<div class="alert info">${esc(c.notes)}</div>` : ''}
      <div class="card flush"><div class="card-head pad"><h3>Bills</h3></div>${c.bills.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Bill no.</th><th>Date</th>${isAdmin() ? '<th>Shop</th>' : ''}
        <th class="r">Total</th><th class="r">Paid at counter</th><th class="r">Paid later</th><th class="r">Still owed</th></tr></thead><tbody>
        ${c.bills.map((b) => `<tr class="click${b.status === 'void' ? ' void' : ''}" data-bill="${b.id}"><td><b>${esc(b.bill_no)}</b>${b.status === 'void' ? ' <span class="pill red">cancelled</span>' : ''}</td>
          <td>${esc(fmtDT(b.created_at))}</td>${isAdmin() ? `<td>${esc(b.location_name)}</td>` : ''}<td class="r">${money(b.total)}</td><td class="r">${money(b.paid_now)}</td>
          <td class="r">${b.paid_later ? money(b.paid_later) : ''}</td><td class="r">${b.open > 0 ? `<b class="neg">${money(b.open)}</b>` : '<span class="pill ok">paid</span>'}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No bills yet.</div>'}</div>
      <div class="card flush"><div class="card-head pad"><h3>Payments brought later</h3></div>${c.payments.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>For bill</th><th>Paid by</th><th>Taken by</th><th>Note</th><th class="r">Amount</th></tr></thead><tbody>
        ${c.payments.map((p) => `<tr><td>${esc(fmtDate(p.date))}</td><td>${esc(p.bill_no || '')}</td><td>${esc(METHOD_NAMES[p.method] || p.method || '')}</td><td>${esc(p.user_name || '')}</td><td>${esc(p.note || '')}</td><td class="r">${money(p.amount)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No payments yet.</div>'}</div>`;
    $('#editC').addEventListener('click', async () => { if (await editCustomer(c)) router(); });
    const pay = $('#payC');
    if (pay) pay.addEventListener('click', () => receivePayment(c, { owed: c.owed, done: () => router() }));
    el.addEventListener('click', (e) => { const r = e.target.closest('[data-bill]'); if (r) showBill(+r.dataset.bill, () => router()); });
  },
});
