'use strict';
// Sell screen: scan items → bill → print. Return/exchange mode takes items back.

View('pos', {
  title: 'Sale order',
  allow: () => can('sell'),
  cls: 'pos-view',
  async render({ el }) {
    const cartKey = `vz_cart_${App.user.id}`;
    const canEditPrice = can('change_price');
    const blank = () => ({ items: [], ret: false, discount: '', discType: 'amt', method: 'cash', paid: '', cname: '', cphone: '' });
    let S;
    try { S = { ...blank(), ...JSON.parse(localStorage.getItem(cartKey) || 'null') }; } catch { S = blank(); }
    const save = () => { try { localStorage.setItem(cartKey, JSON.stringify(S)); } catch { /* storage off */ } };

    let locId;
    if (isAdmin()) {
      const saved = Number(localStorage.getItem('vz_pos_loc'));
      locId = shops().some((l) => l.id === saved) ? saved : shops()[0]?.id;
      if (!locId) { el.innerHTML = '<div class="card empty">Add a shop first in <a href="#/settings/locations">Settings → Shops & warehouse</a>.</div>'; return; }
    } else {
      locId = App.user.location_id;
    }

    const canReturn = can('returns'), canDiscount = can('discount');
    el.innerHTML = `
    <div class="pos" id="pos">
      <section class="pos-left">
        ${isAdmin() ? `<div class="pos-shop">Selling at <select class="input" id="posLoc">${options(shops(), locId)}</select></div>` : ''}
        <input id="scan" class="input scan-input" placeholder="Scan an item, or type its name" autocomplete="off">
        <div class="ret-banner">↩ Taking items back — scan what the customer returns, then tap “Return or exchange” again to sell the new items.</div>
        <div class="pos-cart" id="cart"></div>
        <div class="pos-links">
          ${canReturn ? '<a href="#" id="retBtn">↩ Return or exchange</a>' : ''}
          ${canDiscount ? '<a href="#" id="discLink">% Discount</a>' : ''}
          <a href="#" id="custLink">👤 Customer</a>
          <a href="#" id="clearBtn" class="muted">Clear</a>
        </div>
      </section>
      <aside class="card pos-side">
        <div class="tot-label" id="tLabel">Total</div>
        <div class="tot" id="sTotal"></div>
        <div class="tot-sub"><span id="sCount">0</span><span> · </span><span id="sSub"></span></div>
        <div id="discRow" class="hidden"><div class="sum-row"><span>Discount</span>
          <div class="disc-in"><input class="input" id="disc" inputmode="decimal" placeholder="0" value="${esc(S.discount)}">
          <div class="seg" id="discType"><button data-t="amt">${esc(App.settings.currency)}</button><button data-t="pct">%</button></div></div></div></div>
        <div class="pay-methods" id="methods"><button data-m="cash">Cash</button><button data-m="card">Card</button><button data-m="online">Online</button></div>
        <div id="cashBox">
          <div class="sum-row"><span>Cash received</span><input class="input num cash-in" id="paid" inputmode="decimal" placeholder="Exact" value="${esc(S.paid)}"></div>
          <div class="sum-row change-row" id="changeRow"><span id="chgLabel">Change</span><b id="sChange">—</b></div>
        </div>
        <div id="custBox" class="hidden">
          <input class="input" id="cname" placeholder="Customer name" value="${esc(S.cname)}">
          <input class="input" id="cphone" placeholder="Phone number" value="${esc(S.cphone)}"></div>
        <button class="btn primary huge" id="doneBtn">${icon('check')} ${App.settings.auto_print_bill === '1' ? 'Done — print bill' : 'Done'}</button>
        <div class="muted small c">Keys: F2 scan · ${canReturn ? 'F4 return · ' : ''}F9 done</div>
      </aside>
    </div>`;

    // the big total says it all: no page title on this screen
    $('.page-head').classList.add('hidden');
    onCleanup(() => $('.page-head') && $('.page-head').classList.remove('hidden'));
    const scan = $('#scan', el);
    const focusScan = () => { if (!document.querySelector('.modal-wrap')) scan.focus(); };

    function totals() {
      const sub = round2(S.items.reduce((a, l) => a + (l.ret ? -l.qty : l.qty) * l.price, 0));
      let disc = Number(S.discount) || 0;
      if (S.discType === 'pct') disc = round2(Math.max(sub, 0) * Math.min(disc, 100) / 100);
      disc = round2(Math.min(Math.max(disc, 0), Math.max(sub, 0)));
      const total = round2(sub - disc);
      const cashGiven = S.method === 'cash' && S.paid !== '' ? Number(S.paid) : null;
      const change = cashGiven !== null && total > 0 ? round2(cashGiven - total) : null;
      return { sub, disc, total, cashGiven, change, count: S.items.reduce((a, l) => a + (l.ret ? 0 : l.qty), 0), retCount: S.items.reduce((a, l) => a + (l.ret ? l.qty : 0), 0) };
    }

    function renderTotals() {
      const t = totals();
      $('#sCount', el).textContent = t.retCount ? `${t.count} sold, ${t.retCount} back` : `${t.count} piece${t.count === 1 ? '' : 's'}`;
      $('#sSub', el).textContent = t.disc ? `${money(t.disc)} discount` : '';
      $('#sSub', el).previousSibling.textContent = t.disc ? ' · ' : '';
      $('#sTotal', el).textContent = money(Math.abs(t.total));
      $('#tLabel', el).textContent = t.total < 0 ? 'Give back to the customer' : 'Total';
      $('.pos-side', el).classList.toggle('refund', t.total < 0);
      $('#discRow', el).classList.toggle('hidden', !(S.showDisc || Number(S.discount)));
      $('#custBox', el).classList.toggle('hidden', !(S.showCust || S.cname || S.cphone));
      $$('#discType button', el).forEach((b) => b.classList.toggle('on', b.dataset.t === S.discType));
      $$('#methods button', el).forEach((b) => b.classList.toggle('on', b.dataset.m === S.method));
      $('#cashBox', el).classList.toggle('hidden', S.method !== 'cash' || t.total <= 0);
      const row = $('#changeRow', el);
      if (t.change === null) { $('#sChange', el).textContent = '—'; row.classList.remove('short'); $('#chgLabel', el).textContent = 'Change'; }
      else if (t.change < 0) { $('#sChange', el).textContent = money(-t.change); row.classList.add('short'); $('#chgLabel', el).textContent = 'Still to pay'; }
      else { $('#sChange', el).textContent = money(t.change); row.classList.remove('short'); $('#chgLabel', el).textContent = 'Change'; }
      $('#pos', el).classList.toggle('ret', S.ret);
      const rb = $('#retBtn', el);
      if (rb) { rb.classList.toggle('on', S.ret); rb.textContent = S.ret ? '↩ Taking back — tap to stop' : '↩ Return or exchange'; }
    }

    function renderCart(flashIndex = -1) {
      const box = $('#cart', el);
      if (!S.items.length) {
        box.innerHTML = `<div class="cart-empty">${icon('barcode')}<b>Scan an item to start</b>Or type its name in the box above.</div>`;
      } else {
        box.innerHTML = S.items.map((l, i) => {
          const amt = (l.ret ? -l.qty : l.qty) * l.price;
          const left = l.stock - (l.ret ? -l.qty : l.qty);
          return `<div class="cart-row${l.ret ? ' ret-line' : ''}${i === flashIndex ? ' flash' : ''}">
            <div class="grow"><div class="iname">${esc(l.name)}${l.ret ? ' <span class="pill red">Back</span>' : ''}</div>
              <div class="muted small">${esc(variantText(l) || '')}${variantText(l) ? ' · ' : ''}${canEditPrice ? `<input class="input sm num price-in" data-price="${i}" value="${l.price}" inputmode="decimal">` : money(l.price)}${!l.ret && left < 0 ? ' · <span class="neg">only ' + Math.max(0, l.stock) + ' here</span>' : ''}</div></div>
            <div class="qty"><button data-dec="${i}" tabindex="-1" aria-label="One less">−</button><input data-qty="${i}" value="${l.qty}" inputmode="numeric"><button data-inc="${i}" tabindex="-1" aria-label="One more">+</button></div>
            <div class="amt${amt < 0 ? ' neg' : ''}">${num(amt)}</div>
            <button class="icon-btn" data-rm="${i}" title="Remove" tabindex="-1">✕</button></div>`;
        }).join('');
        const fl = box.querySelector('.cart-row.flash');
        fl && fl.scrollIntoView({ block: 'nearest' });
      }
      renderTotals();
      save();
    }

    function addProduct(p) {
      const i = S.items.findIndex((l) => l.id === p.id && l.ret === S.ret);
      if (i >= 0) S.items[i].qty++;
      else S.items.push({ id: p.id, name: p.name, size: p.size, color: p.color, barcode: p.barcode, price: p.sale_price, qty: 1, ret: S.ret, stock: p.loc_qty || 0 });
      const idx = i >= 0 ? i : S.items.length - 1;
      const l = S.items[idx];
      if (!l.ret && l.qty > l.stock) toast(`Stock shows only ${Math.max(0, l.stock)} of this item at ${locName(locId)}. Sale is still allowed.`, 'warn', 4000);
      renderCart(idx);
      focusScan();
    }

    attachPicker(scan, { onPick: addProduct, location: () => locId });

    const cart = $('#cart', el);
    cart.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.inc !== undefined) S.items[+b.dataset.inc].qty++;
      else if (b.dataset.dec !== undefined) { const l = S.items[+b.dataset.dec]; if (l.qty > 1) l.qty--; else S.items.splice(+b.dataset.dec, 1); }
      else if (b.dataset.rm !== undefined) S.items.splice(+b.dataset.rm, 1);
      else return;
      renderCart();
      focusScan();
    });
    cart.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.qty !== undefined) {
        const n = parseInt(t.value, 10);
        if (n > 500) toast('That quantity looks wrong (was a barcode scanned into the quantity box?). Click the scan box first.', 'error', 6000);
        else if (!n || n < 1) S.items.splice(+t.dataset.qty, 1);
        else S.items[+t.dataset.qty].qty = n;
      } else if (t.dataset.price !== undefined) {
        const n = Number(t.value);
        if (Number.isFinite(n) && n >= 0) S.items[+t.dataset.price].price = round2(n);
      } else return;
      renderCart();
    });
    cart.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.target.blur(); focusScan(); } });

    $('#disc', el).addEventListener('input', (e) => { S.discount = e.target.value.trim(); renderTotals(); save(); });
    $('#discType', el).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.discType = b.dataset.t; renderTotals(); save(); } });
    $('#methods', el).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.method = b.dataset.m; renderTotals(); save(); } });
    $('#paid', el).addEventListener('input', (e) => { S.paid = e.target.value.trim(); renderTotals(); save(); });
    $('#paid', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') complete(); });
    $('#cname', el).addEventListener('input', (e) => { S.cname = e.target.value; save(); });
    $('#cphone', el).addEventListener('input', (e) => { S.cphone = e.target.value; save(); });
    const toggleRet = () => { if (!canReturn) return; S.ret = !S.ret; renderTotals(); save(); focusScan(); };
    const link = (id, fn) => { const a = $(id, el); if (a) a.addEventListener('click', (e) => { e.preventDefault(); fn(); }); };
    link('#retBtn', toggleRet);
    link('#discLink', () => { S.showDisc = true; renderTotals(); $('#disc', el).focus(); });
    link('#custLink', () => { S.showCust = true; renderTotals(); $('#cname', el).focus(); });
    $('#clearBtn', el).addEventListener('click', async (e) => {
      e.preventDefault();
      if (S.items.length && !(await confirmBox('Remove all items from this bill?', { ok: 'Clear bill', danger: true }))) return;
      S = blank(); el.querySelector('#disc').value = ''; el.querySelector('#paid').value = ''; el.querySelector('#cname').value = ''; el.querySelector('#cphone').value = '';
      renderCart(); focusScan();
    });
    if (isAdmin()) {
      $('#posLoc', el).addEventListener('change', async (e) => {
        locId = Number(e.target.value);
        localStorage.setItem('vz_pos_loc', locId);
        await ProductCache.load(locId, true);
        for (const l of S.items) { const p = ProductCache.list.find((x) => x.id === l.id); l.stock = p ? p.loc_qty : 0; }
        renderCart(); focusScan();
      });
    }

    let completing = false;
    async function complete() {
      if (completing || document.querySelector('.modal-wrap')) return;
      if (!S.items.length) { toast('The bill is empty — scan an item first', 'error'); return focusScan(); }
      const t = totals();
      if (t.cashGiven !== null && t.total > 0 && t.cashGiven < t.total) { toast(`Cash received is less than the total (${money(t.total)})`, 'error'); return $('#paid', el).focus(); }
      completing = true;
      const btn = $('#doneBtn', el);
      const body = {
        location_id: locId,
        items: S.items.map((l) => ({ product_id: l.id, qty: l.ret ? -l.qty : l.qty, price: l.price })),
        discount: t.disc,
        payment_method: S.method,
        paid: t.cashGiven ?? '',
        customer_name: S.cname,
        customer_phone: S.cphone,
      };
      if (!(await looksRight('sale', body))) { completing = false; return focusScan(); }
      const sale = await busy(btn, () => POST('/api/sales', body));
      completing = false;
      if (!sale) return;
      for (const i of sale.items) { const p = ProductCache.list.find((x) => x.id === i.product_id); if (p) p.loc_qty -= i.qty; }
      S = blank();
      ['#disc', '#paid', '#cname', '#cphone'].forEach((s) => { el.querySelector(s).value = ''; });
      renderCart();
      if (App.settings.auto_print_bill === '1' && !App.practice) printBill(sale); // (no printing while practising)
      const m = modal({
        title: `Bill ${sale.bill_no} saved`,
        body: `<div class="done-big"><div class="tick">✓</div>
          <div class="amt">${sale.total < 0 ? 'Refund ' : ''}${money(Math.abs(sale.total))}</div>
          <div class="muted">${METHOD_NAMES[sale.payment_method]} · ${sale.items.length} line${sale.items.length > 1 ? 's' : ''}</div>
          ${sale.change_due ? `<div class="chg" style="margin-top:10px">Give change: ${money(sale.change_due)}</div>` : ''}</div>`,
        footer: `<button class="btn" id="mPrint">${icon('printer')} ${App.settings.auto_print_bill === '1' ? 'Print again' : 'Print bill'}</button><button class="btn primary" id="mNew" autofocus>New sale (Enter)</button>`,
        onClose: focusScan,
      });
      m.$('#mPrint').addEventListener('click', () => printBill(sale));
      m.$('#mNew').addEventListener('click', m.close);
      m.$('#mNew').focus();
    }
    $('#doneBtn', el).addEventListener('click', complete);

    const onKey = (e) => {
      if (document.querySelector('.modal-wrap')) return;
      if (e.key === 'F2') { e.preventDefault(); focusScan(); }
      else if (e.key === 'F4') { e.preventDefault(); toggleRet(); }
      else if (e.key === 'F9') { e.preventDefault(); complete(); }
    };
    document.addEventListener('keydown', onKey);
    onCleanup(() => document.removeEventListener('keydown', onKey));

    renderCart();
    focusScan();
    try { await ProductCache.load(locId, true); } catch (e) { toast(e.message, 'error'); }
    for (const l of S.items) { const p = ProductCache.list.find((x) => x.id === l.id); if (p) l.stock = p.loc_qty; }
    renderCart();
  },
});
