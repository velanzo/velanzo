'use strict';
// Accounts: suppliers (what we owe) and expenses. (Reports are in reports.js.)

View('suppliers', {
  title: 'Suppliers',
  allow: () => can('buy'),
  async render({ el }) {
    setActions(`<button class="btn primary" id="addSup">${icon('plus')} New supplier</button>`);
    async function load() {
      const rows = await GET('/api/suppliers');
      if (!el.isConnected) return;
      const due = rows.reduce((a, r) => a + (r.due || 0), 0);
      el.innerHTML = `${canSeeCost() ? `<div class="stats"><div class="card stat"><div class="label">Total owed to suppliers</div><div class="value">${money(due)}</div></div></div>` : ''}
        <div class="card flush">${rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Supplier</th><th>Phone</th><th>City / address</th><th class="r">Bought (total)</th>${canSeeCost() ? '<th class="r">Paid</th><th class="r">Still owed</th>' : ''}</tr></thead><tbody>
        ${rows.map((s) => `<tr class="click" data-id="${s.id}"><td><b>${esc(s.name)}</b></td><td>${esc(s.phone || '')}</td><td>${esc(s.address || '')}</td><td class="r">${money(s.purchased)}</td>
          ${canSeeCost() ? `<td class="r">${money(s.paid)}</td><td class="r"><b class="${s.due > 0 ? 'neg' : ''}">${money(s.due)}</b></td>` : ''}</tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">No suppliers yet.</div>'}</div>`;
      $('.card.flush', el).addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) go('suppliers/' + r.dataset.id); });
    }
    $('#addSup').addEventListener('click', () => openSupplierForm(null, load));
    await load();
  },
});

View('suppliers/:id', {
  title: 'Supplier',
  nav: 'suppliers',
  allow: () => can('buy'),
  async render({ el, params }) {
    const d = await GET('/api/suppliers/' + params.id);
    const s = d.supplier;
    setTitle(s.name);
    setActions(`<a class="btn" href="#/suppliers">← Suppliers</a><button class="btn" id="editSup">Edit</button>${canSeeCost() ? '<button class="btn primary" id="paySup">Record payment</button>' : ''}`);
    el.innerHTML = `
      <div class="stats">
        <div class="card stat"><div class="label">Bought in total</div><div class="value">${money(s.purchased)}</div></div>
        ${canSeeCost() ? `<div class="card stat"><div class="label">Paid</div><div class="value">${money(s.paid)}</div></div>
        <div class="card stat"><div class="label">Still owed</div><div class="value ${s.due > 0 ? 'neg' : ''}">${money(s.due)}</div></div>` : ''}
      </div>
      <div class="card"><dl class="kv"><dt>Phone</dt><dd>${esc(s.phone || '—')}</dd><dt>Address</dt><dd>${esc(s.address || '—')}</dd>${s.notes ? `<dt>Notes</dt><dd>${esc(s.notes)}</dd>` : ''}</dl></div>
      <div class="grid-2">
        <div class="card flush"><div style="padding:18px 18px 0"><h3>Purchases</h3></div>${d.purchases.length ? `<table class="tbl"><thead><tr><th>No.</th><th>Date</th><th class="r">Pieces</th><th class="r">Amount</th><th class="r">Paid then</th></tr></thead><tbody>
          ${d.purchases.map((p) => `<tr class="click${p.status === 'void' ? ' void' : ''}" data-pid="${p.id}"><td>${esc(p.purchase_no)}</td><td>${esc(fmtDate(p.date))}</td><td class="r">${p.total_qty}</td><td class="r">${money(p.total)}</td><td class="r">${money(p.paid)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No purchases yet.</div>'}</div>
        ${canSeeCost() ? `<div class="card flush"><div style="padding:18px 18px 0"><h3>Later payments</h3></div>${d.payments.length ? `<table class="tbl"><thead><tr><th>Date</th><th>How</th><th>Note</th><th class="r">Amount</th></tr></thead><tbody>
          ${d.payments.map((p) => `<tr><td>${esc(fmtDate(p.date))}</td><td>${esc(p.method || '')}</td><td>${esc(p.note || '')}</td><td class="r">${money(p.amount)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No payments recorded.</div>'}</div>` : ''}
      </div>`;
    el.addEventListener('click', (e) => { const r = e.target.closest('[data-pid]'); if (r) go('purchases/' + r.dataset.pid); });
    $('#editSup').addEventListener('click', () => openSupplierForm(s, () => router()));
    const pay = $('#paySup');
    if (pay) pay.addEventListener('click', () => {
      const m = modal({
        title: `Payment to ${s.name}`,
        body: `<div class="form-grid">
          <label class="field">Amount<input class="input num big" name="amount" inputmode="decimal" value="${s.due > 0 ? s.due : ''}" autofocus></label>
          <label class="field">Date<input class="input" type="date" name="date" value="${todayStr()}"></label>
          <label class="field">Paid by<select class="input" name="method"><option>cash</option><option>bank transfer</option><option>cheque</option><option>online</option></select></label>
          <label class="field">Note<input class="input" name="note" placeholder="optional"></label></div>`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pSave">Save payment</button>`,
      });
      const b = m.$('#pSave');
      b.addEventListener('click', () => busy(b, async () => { const v = formValues(m.el); if (!(await looksRight('payment', { ...v, supplier_id: s.id }))) return; await POST(`/api/suppliers/${s.id}/payments`, v); toast('Payment saved'); m.close(); router(); }));
    });
  },
});

View('expenses', {
  title: 'Expenses',
  allow: () => can('expenses') || isAdmin(),
  async render({ el }) {
    const cats = await GET('/api/expense-categories');
    const st = { from: rangePresets().month[1], to: todayStr(), loc: '' };
    const locs = App.locations.filter((l) => l.active);
    el.innerHTML = `
      <div class="card"><h3>Add expense</h3><form id="expForm" class="form-grid four" style="align-items:end">
        <label class="field">Date<input class="input" type="date" name="date" value="${todayStr()}"></label>
        ${isAdmin() ? `<label class="field">For<select class="input" name="location_id">${options(locs, '', { blank: 'Business (general)' })}</select></label>` : ''}
        <label class="field">Type<input class="input" name="category" list="dlExp" placeholder="e.g. Rent"></label>
        <label class="field">Amount<input class="input num" name="amount" inputmode="decimal"></label>
        <label class="field" style="grid-column: span ${isAdmin() ? 3 : 2}">Details<input class="input" name="note" placeholder="optional"></label>
        <button class="btn primary">Add expense</button>
      </form><datalist id="dlExp">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="toolbar" style="margin-top:16px">${rangeBarHtml(st)}${isAdmin() ? `<select class="input" id="fLoc">${options(locs, '', { blank: 'All' })}</select>` : ''}</div>
      <div class="card flush" id="list"></div>`;
    async function load() {
      const rows = await GET('/api/expenses', { from: st.from, to: st.to, location_id: st.loc });
      if (!el.isConnected) return;
      $$('[data-preset]', el).forEach((b) => { const [, f, t] = rangePresets()[b.dataset.preset]; b.classList.toggle('on', st.from === f && st.to === t); });
      $('[data-range=from]', el).value = st.from; $('[data-range=to]', el).value = st.to;
      $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>For</th><th>Type</th><th>Details</th><th>Added by</th><th class="r">Amount</th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.location_name || 'Business')}</td><td>${esc(r.category)}</td><td>${esc(r.note || '')}</td><td>${esc(r.user_name || '')}</td><td class="r">${money(r.amount)}</td>
          ${isAdmin() ? `<td class="c"><button class="icon-btn" data-del="${r.id}" title="Delete">✕</button></td>` : ''}</tr>`).join('')}
        </tbody><tfoot><tr><td colspan="5">Total</td><td class="r">${money(rows.reduce((a, r) => a + r.amount, 0))}</td>${isAdmin() ? '<td></td>' : ''}</tr></tfoot></table></div>`
        : '<div class="empty">No expenses in this period.</div>';
    }
    bindRangeBar(el, st, load);
    const fl = $('#fLoc', el);
    if (fl) fl.addEventListener('change', () => { st.loc = fl.value; load(); });
    $('#expForm', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const b = e.target.querySelector('button');
      busy(b, async () => {
        const v = formValues(e.target);
        if (!(await looksRight('expense', v))) return;
        await POST('/api/expenses', v);
        toast('Expense added');
        e.target.amount.value = ''; e.target.note.value = '';
        await load();
        e.target.category.focus();
      });
    });
    $('#list', el).addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del]');
      if (!b || !(await confirmBox('Delete this expense?', { ok: 'Delete', danger: true }))) return;
      await busy(b, async () => { await DEL('/api/expenses/' + b.dataset.del); load(); });
    });
    await load();
  },
});
