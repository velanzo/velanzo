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

