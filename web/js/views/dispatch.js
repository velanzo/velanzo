'use strict';
// Sending stock between places (warehouse → shop, or any place allowed to send), and receiving it.
const isSender = () => isAdmin() || can('send');
const isReceiver = () => !isAdmin() && can('receive');

const DISPATCH_STATUS = {
  in_transit: '<span class="pill warn">On the way</span>',
  received: '<span class="pill ok">Received</span>',
  cancelled: '<span class="pill red">Cancelled</span>',
};

View('dispatch', {
  title: () => (isSender() ? 'Dispatch order' : 'Receive stock'),
  allow: () => isSender() || can('receive'),
  async render({ el, query }) {
    const st = { status: query.status ?? (isSender() ? 'in_transit' : '') };
    setActions(isSender() ? `<a class="btn primary" href="#/dispatch/new">${icon('plus')} New dispatch order</a>` : '');
    el.innerHTML = `
      ${!isSender() ? '' : `<div class="tabs" id="tabs">
        <a href="#" data-s="in_transit">On the way</a><a href="#" data-s="received">Received</a><a href="#" data-s="cancelled">Cancelled</a><a href="#" data-s="">All</a></div>`}
      <div id="incoming"></div>
      <div class="card flush" id="list"><div class="loading">Loading…</div></div>`;
    async function load() {
      $$('#tabs a', el).forEach((a) => a.classList.toggle('active', a.dataset.s === st.status));
      const rows = await GET('/api/dispatches', { status: st.status });
      if (!el.isConnected) return;
      if (isReceiver()) {
        const inc = rows.filter((d) => d.status === 'in_transit' && d.to_location_id === App.user.location_id);
        $('#incoming', el).innerHTML = inc.length ? inc.map((d) => `<div class="alert info flex" style="font-size:15.5px">🚚 <div class="grow"><b>${esc(d.dispatch_no)}</b> from ${esc(d.from_name)} — ${d.total_qty} pieces, sent ${esc(fmtDT(d.created_at))}${d.notes ? ' <span class="muted">· ' + esc(d.notes) + '</span>' : ''}</div>
          <a class="btn primary" href="#/dispatch/${d.id}/receive">Check & receive</a></div>`).join('')
          : '<div class="alert ok">Nothing waiting to be received.</div>';
      }
      $('#list', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Sent</th><th>From</th><th>To</th><th class="r">Pieces</th><th class="r">Value</th><th>Status</th><th>Received</th></tr></thead><tbody>
        ${rows.map((d) => `<tr class="click" data-id="${d.id}"><td><b>${esc(d.dispatch_no)}</b></td><td>${esc(fmtDT(d.created_at))}</td><td>${esc(d.from_name)}</td><td>${esc(d.to_name)}</td>
          <td class="r">${d.total_qty}</td><td class="r">${money(d.total_value)}</td><td>${DISPATCH_STATUS[d.status]}</td>
          <td>${d.status === 'received' ? `${esc(fmtDT(d.received_at))}${d.received_qty !== d.total_qty ? ` <span class="pill red">${d.received_qty} of ${d.total_qty}</span>` : ''}` : ''}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty">${st.status === 'in_transit' ? 'Nothing is on the way right now.' : 'No dispatches yet.'}</div>`;
    }
    $$('#tabs a', el).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); st.status = a.dataset.s; load(); }));
    $('#list', el).addEventListener('click', (e) => { const r = e.target.closest('[data-id]'); if (r) go('dispatch/' + r.dataset.id); });
    await load();
  },
});

View('dispatch/new', {
  title: 'New dispatch order',
  nav: 'dispatch',
  allow: isSender,
  async render({ el }) {
    const draftKey = `vz_dispatch_${App.user.id}`;
    const fromList = isAdmin() ? App.locations.filter((l) => l.active) : App.locations.filter((l) => l.id === App.user.location_id);
    const blank = () => {
      const from = isAdmin() ? (warehouses()[0] || fromList[0])?.id : App.user.location_id;
      const fromType = locById(from)?.type;
      const to = App.locations.find((l) => l.active && l.id !== from && l.type !== fromType)?.id || App.locations.find((l) => l.active && l.id !== from)?.id;
      return { from, to, notes: '', lines: [] };
    };
    let S;
    try { S = { ...blank(), ...JSON.parse(localStorage.getItem(draftKey) || 'null') }; } catch { S = blank(); }
    if (!isAdmin()) S.from = App.user.location_id;
    const save = () => { try { localStorage.setItem(draftKey, JSON.stringify(S)); } catch { /* ignore */ } };
    setActions(`<a class="btn" href="#/dispatch">← Back</a>`);
    el.innerHTML = `
      <div class="card"><div class="form-grid three">
        <label class="field">From<select class="input" id="from" ${fromList.length < 2 ? 'disabled' : ''}>${options(fromList, S.from)}</select></label>
        <label class="field">To<select class="input" id="to"></select></label>
        <label class="field">Note (optional)<input class="input" id="notes" value="${esc(S.notes)}" placeholder="e.g. driver name, bag count"></label>
      </div></div>
      <div class="card">
        <div class="alert info" style="margin-bottom:12px">Scan each piece as you pack it — every scan adds 1. You can also type a name and change the quantity.</div>
        <input class="input scan-input" id="scan" placeholder="Scan or search item…" autocomplete="off">
        <div id="lines" style="margin-top:14px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;align-items:center;flex-wrap:wrap">
          <div class="muted" id="sumTxt" style="margin-right:auto"></div>
          <button class="btn ghost" id="clr">Clear</button>
          <button class="btn ok lg" id="send">${icon('truck')} Send dispatch</button>
        </div>
      </div>`;
    function renderTo() {
      $('#to', el).innerHTML = options(App.locations.filter((l) => l.active && l.id !== Number(S.from)), S.to);
      S.to = $('#to', el).value;
    }
    function renderLines(flash = -1) {
      const pcs = S.lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
      const val = S.lines.reduce((a, l) => a + (Number(l.qty) || 0) * l.price, 0);
      $('#lines', el).innerHTML = S.lines.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>#</th><th>Item</th><th>Barcode</th><th class="r">In stock at ${esc(locName(S.from))}</th><th class="c">Qty to send</th><th class="r">Price</th><th class="r">Value</th><th></th></tr></thead><tbody>
        ${S.lines.map((l, i) => `<tr class="${i === flash ? 'flash' : ''}"><td class="muted">${i + 1}</td><td><b>${esc(l.name)}</b> <span class="muted">${esc(variantText(l))}</span></td><td class="mono small">${esc(l.barcode)}</td>
          <td class="r ${l.qty > l.stock ? 'negq' : ''}">${l.stock}${l.qty > l.stock ? ' — not enough' : ''}</td>
          <td class="c"><div class="qty"><button data-dec="${i}" tabindex="-1">−</button><input data-q="${i}" value="${l.qty}" inputmode="numeric"><button data-inc="${i}" tabindex="-1">+</button></div></td>
          <td class="r">${money(l.price)}</td><td class="r">${money(l.qty * l.price)}</td><td><button class="icon-btn" data-rm="${i}" tabindex="-1">✕</button></td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="4">Total</td><td class="c">${pcs}</td><td></td><td class="r">${money(val)}</td><td></td></tr></tfoot></table></div>`
        : '<div class="empty">Nothing added yet.</div>';
      $('#sumTxt', el).textContent = S.lines.length ? `${S.lines.length} items · ${pcs} pieces · ${money(val)}` : '';
      const f = $('#lines tr.flash', el);
      f && f.scrollIntoView({ block: 'nearest' });
      save();
    }
    function addLine(p) {
      const i = S.lines.findIndex((l) => l.product_id === p.id);
      if (i >= 0) { S.lines[i].qty++; S.lines[i].stock = p.loc_qty; renderLines(i); }
      else { S.lines.push({ product_id: p.id, name: p.name, size: p.size, color: p.color, barcode: p.barcode, price: p.sale_price, stock: p.loc_qty || 0, qty: 1 }); renderLines(S.lines.length - 1); }
      const l = S.lines.find((x) => x.product_id === p.id);
      if (l.qty > l.stock) { beep(false); toast(`Only ${l.stock} of this item in stock at ${locName(S.from)}`, 'warn'); }
      $('#scan', el).focus();
    }
    async function refreshStock() {
      await ProductCache.load(S.from, true);
      for (const l of S.lines) { const p = ProductCache.list.find((x) => x.id === l.product_id); l.stock = p ? p.loc_qty : 0; }
      renderLines();
    }
    renderTo();
    renderLines();
    attachPicker($('#scan', el), { onPick: addLine, location: () => S.from });
    refreshStock().catch((e) => toast(e.message, 'error'));
    $('#from', el).addEventListener('change', (e) => { S.from = Number(e.target.value); renderTo(); refreshStock(); });
    $('#to', el).addEventListener('change', (e) => { S.to = e.target.value; save(); });
    $('#notes', el).addEventListener('input', (e) => { S.notes = e.target.value; save(); });
    $('#lines', el).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.inc !== undefined) S.lines[+b.dataset.inc].qty++;
      else if (b.dataset.dec !== undefined) { const l = S.lines[+b.dataset.dec]; if (l.qty > 1) l.qty--; else S.lines.splice(+b.dataset.dec, 1); }
      else if (b.dataset.rm !== undefined) S.lines.splice(+b.dataset.rm, 1);
      else return;
      renderLines();
    });
    $('#lines', el).addEventListener('change', (e) => {
      if (e.target.dataset.q === undefined) return;
      const n = parseInt(e.target.value, 10);
      if (n > 10000) toast('That quantity looks wrong (was a barcode scanned into the quantity box?)', 'error', 6000);
      else if (!n || n < 1) S.lines.splice(+e.target.dataset.q, 1);
      else S.lines[+e.target.dataset.q].qty = n;
      renderLines();
    });
    $('#clr', el).addEventListener('click', async () => {
      if (!(await confirmBox('Clear this dispatch and start again?', { ok: 'Clear', danger: true }))) return;
      localStorage.removeItem(draftKey); router();
    });
    const send = $('#send', el);
    async function submit(force) {
      const body = { from_location_id: S.from, to_location_id: S.to, notes: S.notes, force, items: S.lines.map((l) => ({ product_id: l.product_id, qty: l.qty })) };
      try {
        return await POST('/api/dispatches', body);
      } catch (e) {
        if (e.status === 409 && e.data?.shortages) {
          const list = e.data.shortages.map((s) => `• ${s.name}: sending ${s.want}, stock shows ${s.have}`).join('\n');
          if (await confirmBox(`The stock count is lower than what you are sending:\n\n${list}\n\nSend anyway? (Stock at ${locName(S.from)} will go below zero — correct it later with a stock count.)`, { title: 'Not enough stock', ok: 'Send anyway', danger: true })) return submit(true);
          return null;
        }
        throw e;
      }
    }
    send.addEventListener('click', () => busy(send, async () => {
      if (!S.lines.length) throw new Error('Add at least one item');
      if (!S.to) throw new Error('Choose where to send it');
      if (!(await looksRight('dispatch', { items: S.lines.map((l) => ({ product_id: l.product_id, qty: l.qty })) }))) return;
      const r = await submit(false);
      if (!r) return;
      localStorage.removeItem(draftKey);
      ProductCache.invalidate();
      toast(`Dispatch ${r.dispatch_no} sent`);
      go(`dispatch/${r.id}?new=1`);
    }));
    $('#scan', el).focus();
  },
});

View('dispatch/:id', {
  title: 'Dispatch',
  nav: 'dispatch',
  async render({ el, params, query }) {
    const d = await GET('/api/dispatches/' + params.id);
    setTitle(`Dispatch ${d.dispatch_no}`);
    const canReceive = d.status === 'in_transit' && (isAdmin() || (can('receive') && App.user.location_id === d.to_location_id));
    const canCancel = d.status === 'in_transit' && (isAdmin() || (can('send') && App.user.location_id === d.from_location_id));
    setActions(`<a class="btn" href="#/dispatch">← Back</a>${canCancel ? '<button class="btn danger" id="cancelBtn">Cancel dispatch</button>' : ''}
      <button class="btn" id="printBtn">${icon('printer')} Print dispatch note</button>${canReceive ? `<a class="btn primary" href="#/dispatch/${d.id}/receive">Check & receive</a>` : ''}`);
    const diff = d.items.filter((i) => i.received_qty !== null && i.received_qty !== i.qty);
    el.innerHTML = `
      ${query.new ? `<div class="alert ok">✓ Sent. ${d.total_qty} pieces left ${esc(d.from_name)} and are now "on the way". ${esc(d.to_name)} will see it under <b>Receive stock</b>. Print the dispatch note and send it with the parcel.</div>` : ''}
      ${diff.length ? `<div class="alert danger">⚠ ${diff.length} item${diff.length > 1 ? 's' : ''} did not match: ${d.received_qty} pieces received out of ${d.total_qty} sent.</div>` : ''}
      <div class="card"><dl class="kv">
        <dt>Status</dt><dd>${DISPATCH_STATUS[d.status]}</dd>
        <dt>From → To</dt><dd><b>${esc(d.from_name)}</b> → <b>${esc(d.to_name)}</b></dd>
        <dt>Sent</dt><dd>${esc(fmtDT(d.created_at))} by ${esc(d.created_by_name || '')}</dd>
        ${d.status === 'received' ? `<dt>Received</dt><dd>${esc(fmtDT(d.received_at))} by ${esc(d.received_by_name || '')}</dd>` : ''}
        <dt>Pieces</dt><dd>${d.total_qty}${d.received_qty !== null ? ` sent · ${d.received_qty} received` : ''}</dd>
        <dt>Value (sale price)</dt><dd>${money(d.total_value)}</dd>${d.notes ? `<dt>Note</dt><dd>${esc(d.notes)}</dd>` : ''}</dl></div>
      <div class="card flush"><div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Barcode</th><th class="r">Sent</th>${d.status === 'received' ? '<th class="r">Received</th>' : ''}<th class="r">Price</th><th class="r">Value</th></tr></thead><tbody>
        ${d.items.map((i) => `<tr><td><b>${esc(i.name)}</b> <span class="muted">${esc(variantText(i))}</span></td><td class="mono">${esc(i.barcode)}</td><td class="r">${i.qty}</td>
          ${d.status === 'received' ? `<td class="r ${i.received_qty !== i.qty ? 'negq' : ''}">${i.received_qty}</td>` : ''}<td class="r">${money(i.price)}</td><td class="r">${money(i.qty * i.price)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    $('#printBtn').addEventListener('click', () => printDispatch(d));
    if (query.new && !App.practice) setTimeout(() => printDispatch(d), 300);
    const c = $('#cancelBtn');
    if (c) c.addEventListener('click', async () => {
      if (!(await confirmBox(`Cancel ${d.dispatch_no}? The ${d.total_qty} pieces go back into stock at ${d.from_name}.`, { ok: 'Cancel dispatch', danger: true }))) return;
      await busy(c, async () => { await POST(`/api/dispatches/${d.id}/cancel`); toast('Dispatch cancelled'); router(); });
    });
  },
});

View('dispatch/:id/receive', {
  title: 'Receive stock',
  nav: 'dispatch',
  async render({ el, params }) {
    const d = await GET('/api/dispatches/' + params.id);
    if (d.status !== 'in_transit') return go('dispatch/' + d.id);
    setTitle(`Receive ${d.dispatch_no}`);
    setActions(`<a class="btn" href="#/dispatch/${d.id}">← Back</a>`);
    const got = new Map(d.items.map((i) => [i.id, i.qty]));
    let counting = false;
    el.innerHTML = `
      <div class="card"><dl class="kv"><dt>From</dt><dd><b>${esc(d.from_name)}</b></dd><dt>Sent</dt><dd>${esc(fmtDT(d.created_at))} by ${esc(d.created_by_name || '')}</dd><dt>Pieces sent</dt><dd><b>${d.total_qty}</b></dd>${d.notes ? `<dt>Note</dt><dd>${esc(d.notes)}</dd>` : ''}</dl></div>
      <div class="card">
        <div class="alert info" style="margin-bottom:12px">Check the parcel: either scan every piece (counts start from 0 when you scan the first piece), or simply correct the "Received" numbers. Then press <b>Confirm received</b>.</div>
        <input class="input scan-input" id="scan" placeholder="Scan pieces to count them (optional)…" autocomplete="off">
        <div id="lines" style="margin-top:14px"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;align-items:center;flex-wrap:wrap">
          <div id="sumTxt" style="margin-right:auto"></div>
          <button class="btn ok lg" id="okBtn">✓ Confirm received</button>
        </div>
      </div>`;
    function render(flashId) {
      const total = [...got.values()].reduce((a, b) => a + b, 0);
      $('#lines', el).innerHTML = `<div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Barcode</th><th class="r">Sent</th><th class="c">Received</th><th></th></tr></thead><tbody>
        ${d.items.map((i) => { const g = got.get(i.id); return `<tr class="${i.id === flashId ? 'flash' : ''}"><td><b>${esc(i.name)}</b> <span class="muted">${esc(variantText(i))}</span></td><td class="mono">${esc(i.barcode)}</td><td class="r">${i.qty}</td>
          <td class="c"><input class="input sm num" style="width:80px;text-align:center" data-id="${i.id}" value="${g}" inputmode="numeric"></td>
          <td>${g === i.qty ? '<span class="pill ok">OK</span>' : g < i.qty ? `<span class="pill red">${i.qty - g} missing</span>` : `<span class="pill warn">${g - i.qty} extra</span>`}</td></tr>`; }).join('')}
        </tbody></table></div>`;
      $('#sumTxt', el).innerHTML = `Received <b>${total}</b> of ${d.total_qty} pieces ${total === d.total_qty ? '<span class="pill ok">all good</span>' : '<span class="pill red">does not match</span>'}`;
      const f = $('#lines tr.flash', el);
      f && f.scrollIntoView({ block: 'nearest' });
    }
    render();
    ProductCache.set(d.items.map((i) => ({ id: i.product_id, name: i.name, size: i.size, color: i.color, barcode: i.barcode, sale_price: i.price, category: i.category })));
    attachPicker($('#scan', el), {
      showStock: false,
      onPick: (p) => {
        const line = d.items.find((i) => i.product_id === p.id);
        if (!line) { beep(false); return toast(`${p.name} is not in this dispatch`, 'error'); }
        if (!counting) { counting = true; for (const k of got.keys()) got.set(k, 0); }
        got.set(line.id, got.get(line.id) + 1);
        if (got.get(line.id) > line.qty) { beep(false); toast(`More ${p.name} than were sent`, 'warn'); }
        render(line.id);
      },
    });
    $('#lines', el).addEventListener('change', (e) => {
      if (!e.target.dataset.id) return;
      got.set(+e.target.dataset.id, Math.max(0, parseInt(e.target.value, 10) || 0));
      render();
    });
    const ok = $('#okBtn', el);
    ok.addEventListener('click', async () => {
      const total = [...got.values()].reduce((a, b) => a + b, 0);
      if (total !== d.total_qty && !(await confirmBox(`You are receiving ${total} pieces but ${d.total_qty} were sent.\nOnly ${total} will be added to your stock and the difference will be shown to the owner.\n\nContinue?`, { ok: 'Yes, receive', danger: true }))) return;
      await busy(ok, async () => {
        await POST(`/api/dispatches/${d.id}/receive`, { items: [...got].map(([id, q]) => ({ id, received_qty: q })) });
        ProductCache.invalidate();
        toast(`${total} pieces added to your stock`);
        go('dispatch/' + d.id);
      });
    });
    $('#scan', el).focus();
  },
});
