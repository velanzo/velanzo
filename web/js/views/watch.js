'use strict';
// The phone report for a "Reports only" person (and the owner, at #/watch/sales): two tabs.
//   Sales: total sale → paid → still owed, what customers owe in all, and every bill (tap one to see it);
//          profit, cash and expenses folded away at the bottom.
//   Stock: every item with how many are at each place (search, low, out of stock, negative, place, category, items with 0).
// Made for a phone: small type, one column, the period always at the top. Today is shown first.

const WS = { kind: 'today', from: '', to: '', loc: '' }; // the period (kept when switching tabs)
const WSTOCK = { q: '', filter: 'all', loc: '', category: '', zero: false, shown: 60 };

const wMonthStart = (d) => d.slice(0, 8) + '01';
function wSetKind(kind) {
  const t = todayStr();
  WS.kind = kind;
  if (kind === 'today') { WS.from = t; WS.to = t; }
  if (kind === 'yesterday') { WS.from = addDays(t, -1); WS.to = WS.from; }
  if (kind === 'week') { WS.from = addDays(t, -6); WS.to = t; }
  if (kind === 'month') { WS.from = wMonthStart(t); WS.to = t; }
}
const wShort = (s) => { const [, m, d] = s.split('-'); return `${+d} ${MONTHS[+m - 1]}`; };
const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function wPeriodText() {
  const t = todayStr();
  if (WS.from === WS.to) {
    const wd = WDAYS[new Date(WS.from + 'T00:00:00').getDay()];
    return `${WS.from === t ? 'Today' : WS.from === addDays(t, -1) ? 'Yesterday' : wd}, ${fmtDate(WS.from)}`;
  }
  if (WS.kind === 'month' && WS.from.slice(0, 7) === WS.to.slice(0, 7)) return `${MONTHS[+WS.from.slice(5, 7) - 1]} ${WS.from.slice(0, 4)}${WS.to === t ? ' (so far)' : ''}`;
  return `${wShort(WS.from)} – ${fmtDate(WS.to)}`;
}
const wMoney = (n) => money(Math.round(Number(n || 0)));
const wNeg = (n) => (n < 0 ? ' neg' : '');

function wPeriodBar() {
  const kinds = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['month', 'Month']];
  const places = isAdmin() ? App.locations.filter((l) => l.active && l.type === 'shop') : [];
  return `<div class="w-period">
    <div class="w-seg">${kinds.map(([k, l]) => `<button type="button" data-kind="${k}" class="${WS.kind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="w-dates"><input type="date" class="input" data-d="from" value="${esc(WS.from)}" max="${todayStr()}" aria-label="From"><span class="muted">to</span><input type="date" class="input" data-d="to" value="${esc(WS.to)}" max="${todayStr()}" aria-label="To"></div>
    <div class="w-nav"><b>${esc(wPeriodText())}</b></div>
    ${places.length > 1 ? `<select class="input w-loc" id="wLoc">${options(places, WS.loc, { blank: 'All shops' })}</select>` : ''}
  </div>`;
}
function wBindPeriod(el, reload) {
  $$('[data-kind]', el).forEach((b) => b.addEventListener('click', () => {
    wSetKind(b.dataset.kind);
    reload();
  }));
  $$('[data-d]', el).forEach((i) => i.addEventListener('change', () => {
    if (!i.value) return;
    WS[i.dataset.d] = i.value; WS.kind = 'custom';
    if (WS.from > WS.to) WS[i.dataset.d === 'from' ? 'to' : 'from'] = i.value;
    reload();
  }));
  $('#wLoc', el)?.addEventListener('change', (e) => { WS.loc = e.target.value; reload(); });
}

const wRow = (label, value, cls = '', sub = '') => `<div class="w-row ${cls}"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span><b>${value}</b></div>`;
const wCard = (title, body, extra = '') => `<section class="w-card"><div class="w-card-h"><h3>${title}</h3>${extra}</div>${body}</section>`;

View('watch/sales', {
  title: 'Sales',
  nav: 'watch-sales',
  cls: 'watch',
  allow: () => isAdmin() || (can('reports') && can('see_cost')),
  async render({ el }) {
    if (!WS.from) wSetKind('today');
    const draw = async () => {
      el.innerHTML = `${wPeriodBar()}<div id="wBody"><div class="loading">Loading…</div></div>`;
      wBindPeriod(el, draw);
      const q = { from: WS.from, to: WS.to, location_id: WS.loc };
      let r, d;
      try { [r, d] = await Promise.all([GET('/api/reports', q), GET('/api/reports/day', q)]); }
      catch (e) { if (el.isConnected) $('#wBody', el).innerHTML = `<div class="w-card empty error">${esc(e.message)}</div>`; return; }
      if (!el.isConnected) return;
      $('#wBody', el).innerHTML = wSalesHtml(r, d);
      $('#wBody', el).onclick = (e) => { const b = e.target.closest('[data-bill]'); if (b) wShowBill(+b.dataset.bill); };
    };
    await draw();
  },
});

function wSalesHtml(r, d) {
  const s = r.summary, c = d.cash, t = d.totals;
  const multiDay = r.from !== r.to;
  // 1. total sale → paid → still owed (of the bills in these dates)
  const paid = round2(t.sold - t.owed_today);
  const top = `<div class="w-tiles">
    <div class="w-tile"><span>Total sale</span><b>${wMoney(t.sold)}</b><small>${num(t.bills)} bill${t.bills === 1 ? '' : 's'}</small></div>
    <div class="w-tile ok"><span>Paid</span><b>${wMoney(paid)}</b><small>money received</small></div>
    <div class="w-tile${t.owed_today > 0 ? ' bad' : ''}"><span>Still owed</span><b>${wMoney(t.owed_today)}</b><small>on credit</small></div></div>`;
  // 2. what customers owe in all (any date)
  const owe = wCard('Customers owe you', d.balances.length
    ? `<ul class="w-list">${d.balances.map((b) => `<li><div><b>${esc(b.name)}</b><small>${[b.phone, `${b.bills} bill${b.bills === 1 ? '' : 's'}`].filter(Boolean).map(esc).join(' · ')}</small></div><b class="neg">${wMoney(b.owed)}</b></li>`).join('')}</ul>`
    : '<p class="w-empty">Nobody owes anything.</p>', `<b class="w-card-total${t.owed_all > 0 ? ' neg' : ''}">${wMoney(t.owed_all)}</b>`);
  // 3. every bill, newest first: tap one to see it
  const bills = d.sales.slice().reverse();
  const list = wCard(`Bills (${num(t.bills)})`, bills.length
    ? `<ul class="w-list w-bills">${bills.map((b) => `<li class="click${b.status === 'done' ? '' : ' void'}" data-bill="${b.id}">
        <div><b>${esc(b.bill_no)}${b.customer_name ? ` <em>${esc(b.customer_name)}</em>` : ''}</b><small>${[multiDay ? wShort(b.created_at.slice(0, 10)) : '', fmtTime(b.created_at), d.location_id || !isAdmin() ? '' : b.location_name].filter(Boolean).map(esc).join(' · ')}</small></div>
        <div class="r"><b>${wMoney(b.total)}</b>${b.status !== 'done' ? '<small>cancelled</small>' : b.open > 0 ? `<small class="neg">owes ${wMoney(b.open)}</small>` : '<small class="okc">paid</small>'}</div></li>`).join('')}</ul>`
    : '<p class="w-empty">No bills in these dates.</p>', `<b class="w-card-total">${wMoney(t.sold)}</b>`);
  const profit = wCard('Profit', `
    ${wRow('Sales', wMoney(s.net_sales), '', `${num(s.bills)} bill${s.bills === 1 ? '' : 's'}`)}
    ${wRow('Cost of goods (COGS)', '− ' + wMoney(s.cogs), 'minus')}
    ${wRow('Gross profit', wMoney(s.gross_profit), 'total' + wNeg(s.gross_profit))}
    ${wRow('Expenses', '− ' + wMoney(s.expenses), 'minus')}
    ${wRow('Net profit', wMoney(s.net_profit), 'grand' + wNeg(s.net_profit))}`);
  const cash = wCard('Cash in &amp; out', `
    ${wRow('Cash in', wMoney(c.in), 'in')}
    ${wRow('Cash out', '− ' + wMoney(c.out), 'minus')}
    ${wRow('Balance', wMoney(c.net), 'grand' + wNeg(c.net))}`);
  const ex = d.expenses.slice().reverse();
  const expenses = wCard('Expenses', ex.length
    ? `<ul class="w-list">${ex.map((e) => `<li><div><b>${esc(e.category)}</b><small>${[multiDay ? wShort(e.date) : '', e.note].filter(Boolean).map(esc).join(' · ')}</small></div><b>${wMoney(e.amount)}</b></li>`).join('')}</ul>`
    : '<p class="w-empty">No expenses.</p>', `<b class="w-card-total">${wMoney(s.expenses)}</b>`);
  return `${top}${owe}${list}<details class="w-more-box"><summary>Profit, cash &amp; expenses</summary>${profit}${cash}${expenses}</details>`;
}

// One bill, simply: what was bought at what price, and how it was paid. Nothing can be changed here.
async function wShowBill(id) {
  let s;
  try { s = await GET('/api/sales/' + id); } catch (e) { return toast(e.message, 'error'); }
  const paidNow = round2(s.paid - s.change_due), later = round2((s.payments || []).reduce((a, p) => a + p.amount, 0));
  modal({
    title: `Bill ${s.bill_no}`,
    body: `<div class="w-bill">
      <p class="muted" style="margin:0 0 8px">${esc(fmtDT(s.created_at))} · ${esc(s.location_name)}${s.user_name ? ' · ' + esc(s.user_name) : ''}${s.customer?.name || s.customer_name ? `<br>Customer: <b>${esc(s.customer?.name || s.customer_name)}</b>${s.customer?.phone ? ' · ' + esc(s.customer.phone) : ''}` : ''}</p>
      ${s.status !== 'done' ? `<div class="alert danger">Cancelled${s.void_reason ? ': ' + esc(s.void_reason) : ''}</div>` : ''}
      <ul class="w-list">${s.items.map((i) => `<li><div><b>${esc(i.name)}</b><small>${[variantText(i), `${i.qty} × ${wMoney(i.price)}`].filter(Boolean).map(esc).join(' · ')}</small></div><b>${wMoney(i.qty * i.price)}</b></li>`).join('')}</ul>
      ${s.discount ? wRow('Discount', '− ' + wMoney(s.discount), 'minus') : ''}${s.voucher ? wRow(`Voucher ${esc(s.voucher_code || '')}`, '− ' + wMoney(s.voucher), 'minus') : ''}
      ${wRow('Total', wMoney(s.total), 'grand')}
      ${wRow(`Paid (${esc(s.payment_method || 'cash')})`, wMoney(paidNow))}${later ? wRow('Paid later', wMoney(later)) : ''}
      ${s.status === 'done' ? wRow('Still owed', wMoney(s.open), s.open > 0 ? 'neg' : 'muted-row') : ''}</div>`,
    footer: '<button class="btn" data-close>Close</button>',
  });
}

View('watch/stock', {
  title: 'Stock',
  nav: 'watch-stock',
  cls: 'watch',
  async render({ el }) {
    const places = App.locations.filter((l) => l.active);
    const meta = await GET('/api/product-meta');
    const chips = [['all', 'All'], ['low', 'Low'], ['out', 'Out of stock'], ['neg', 'Negative']];
    el.innerHTML = `<div class="w-period">
        <input class="input w-search" id="wq" type="search" placeholder="Search item, size, colour, barcode" value="${esc(WSTOCK.q)}" autocomplete="off">
        <div class="w-seg">${chips.map(([k, l]) => `<button type="button" data-f="${k}" class="${WSTOCK.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="w-two">
          ${places.length > 1 ? `<select class="input w-loc" id="wsLoc">${options(places, WSTOCK.loc, { blank: 'All places' })}</select>` : ''}
          <select class="input w-loc" id="wsCat">${options(meta.categories, WSTOCK.category, { blank: 'All categories' })}</select>
        </div>
        <label class="check w-check${WSTOCK.filter === 'all' ? '' : ' hidden'}" id="wsZeroL"><input type="checkbox" id="wsZero" ${WSTOCK.zero ? 'checked' : ''}> Include items with 0</label>
      </div><div id="wsSum"></div><div id="wsList"><div class="loading">Loading…</div></div>`;
    let rows = [], data = null;
    const paint = () => {
      const list = $('#wsList', el);
      if (!data) return;
      const locs = data.locations, multi = locs.length > 1;
      const shown = rows.slice(0, WSTOCK.shown);
      list.innerHTML = rows.length ? `<section class="w-card flush"><ul class="w-list w-stock">${shown.map((r) => `<li>
          <div><b>${esc(r.name)}</b><small>${[variantText(r), money(r.sale_price)].filter(Boolean).map(esc).join(' · ')}</small>
            ${multi ? `<span class="w-locs">${locs.map((l) => { const q = r.qty[l.id] || 0; return `<i class="${qtyClass(q)}">${esc(l.code || l.name)} <b>${q}</b></i>`; }).join('')}</span>` : ''}</div>
          <b class="w-qty ${qtyClass(r.total)}">${r.total}</b></li>`).join('')}</ul>
        ${rows.length > shown.length ? `<button type="button" class="w-more" id="wsMore">Show more (${rows.length - shown.length} left)</button>` : ''}</section>`
        : `<p class="w-empty top">${WSTOCK.filter === 'neg' ? 'No item is below 0 anywhere.' : WSTOCK.filter === 'out' ? 'Nothing is out of stock.' : WSTOCK.filter === 'low' ? `No items at ${data.low_threshold} pieces or fewer.` : 'No stock found.'}</p>`;
      $('#wsMore', el)?.addEventListener('click', () => { WSTOCK.shown += 100; paint(); });
    };
    const load = async () => {
      const f = WSTOCK.filter;
      try { data = await GET('/api/stock', { q: WSTOCK.q, location_id: WSTOCK.loc, category: WSTOCK.category, low: f === 'low' || f === 'out' ? 1 : '', neg: f === 'neg' ? 1 : '', zero: f === 'all' && WSTOCK.zero ? 1 : '' }); }
      catch (e) { if (el.isConnected) $('#wsList', el).innerHTML = `<div class="w-card empty error">${esc(e.message)}</div>`; return; }
      if (!el.isConnected) return;
      rows = f === 'out' ? data.rows.filter((r) => r.total <= 0) : data.rows;
      const t = data.totals;
      $('#wsSum', el).innerHTML = `<p class="w-sum"><b>${num(t.units)}</b> pieces · ${num(rows.length)} items${t.cost_value != null ? ` · cost <b>${wMoney(t.cost_value)}</b>` : ''} · sale <b>${wMoney(t.sale_value)}</b></p>`;
      paint();
    };
    let timer;
    $('#wq', el).addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => { WSTOCK.q = e.target.value.trim(); WSTOCK.shown = 60; load(); }, 250); });
    $$('[data-f]', el).forEach((b) => b.addEventListener('click', () => {
      WSTOCK.filter = b.dataset.f; WSTOCK.shown = 60;
      $$('[data-f]', el).forEach((x) => x.classList.toggle('on', x === b));
      $('#wsZeroL', el).classList.toggle('hidden', WSTOCK.filter !== 'all');
      load();
    }));
    $('#wsLoc', el)?.addEventListener('change', (e) => { WSTOCK.loc = e.target.value; WSTOCK.shown = 60; load(); });
    $('#wsCat', el).addEventListener('change', (e) => { WSTOCK.category = e.target.value; WSTOCK.shown = 60; load(); });
    $('#wsZero', el).addEventListener('change', (e) => { WSTOCK.zero = e.target.checked; WSTOCK.shown = 60; load(); });
    await load();
  },
});
