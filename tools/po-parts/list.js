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

