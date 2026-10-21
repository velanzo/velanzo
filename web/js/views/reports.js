'use strict';
// Reports: Overview (profit), Trends (charts over time), Stock & money, Suppliers, Staff, and Things to check.
// The dates and the place chosen stay the same when switching between the tabs.

const REPORT_TABS = [
  ['overview', 'Overview', 'chart'],
  ['trends', 'Trends', 'activity'],
  ['stock', 'Stock & money', 'box'],
  ['suppliers', 'Suppliers', 'truck'],
  ['staff', 'Staff', 'users'],
  ['check', 'Things to check', 'help'],
];
const RS = { from: '', to: '', loc: '', group: '' };
const canReports = () => isAdmin() || (can('reports') && can('see_cost'));
const pctChange = (now, before) => (before ? Math.round(((now - before) / Math.abs(before)) * 100) : null);
// "▲ 12%" in green when it went the good way, "▼ 8%" in red when not (an arrow and a word, never colour alone)
function deltaHtml(now, before, { goodUp = true } = {}) {
  const p = pctChange(now, before);
  if (p === null) return now ? '<span class="delta flat">nothing before</span>' : '';
  if (p === 0) return '<span class="delta flat">● same</span>';
  const good = (p > 0) === goodUp;
  return `<span class="delta ${good ? 'up' : 'down'}">${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
}
const statHtml = (label, value, sub = '', cls = '') => `<div class="card stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
const tableCard = (title, head, rows, empty, extra = '') => `<div class="card flush"><div class="card-head pad"><h3>${title}</h3>${extra}</div><div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${rows || `<tr><td colspan="20" class="muted">${empty}</td></tr>`}</tbody></table></div></div>`;

function reportsView(tab) {
  return {
    title: 'Reports',
    nav: 'reports',
    allow: canReports,
    async render({ el }) {
      if (!RS.from) { RS.from = rangePresets().month[1]; RS.to = todayStr(); }
      const tabs = REPORT_TABS.filter(([k]) => k !== 'suppliers' || can('buy'));
      const usesDates = tab !== 'stock';
      setActions(`<button class="btn" id="prBtn">${icon('printer')} Print</button>${isAdmin() && tab === 'overview' ? `<button class="btn" id="xlBtn">${icon('download')} Excel (bill lines)</button>` : ''}`);
      el.innerHTML = `<div class="tabs report-tabs no-print">${tabs.map(([k, label, ic]) => `<a href="#/reports/${k}" class="${k === tab ? 'active' : ''}">${icon(ic)}${label}${k === 'check' ? ' <span class="badge hidden" id="chkBadge"></span>' : ''}</a>`).join('')}</div>
        <div class="toolbar no-print">${usesDates ? rangeBarHtml(RS, { long: true }) : '<span class="muted">Stock as it is right now</span>'}
          ${isAdmin() ? `<select class="input" id="fLoc">${options(App.locations, RS.loc, { blank: 'Whole business' })}</select>` : ''}</div>
        <div id="rep"><div class="loading">Loading…</div></div>`;
      const box = $('#rep', el);
      const load = async () => {
        $$('[data-preset]', el).forEach((b) => { const [, f, t] = rangePresets()[b.dataset.preset]; b.classList.toggle('on', RS.from === f && RS.to === t); });
        $$('[data-range]', el).forEach((i) => { i.value = RS[i.dataset.range]; });
        const q = { from: RS.from, to: RS.to, location_id: RS.loc };
        GET('/api/reports/unusual', q).then((u) => {
          const b = $('#chkBadge', el);
          if (b) { b.textContent = u.high; b.classList.toggle('hidden', !u.high); }
        }).catch(() => {});
        try { await REPORT_RENDER[tab](box, q); } catch (e) { box.innerHTML = `<div class="empty error">${esc(e.message)}</div>`; return; }
        if (el.isConnected) drawCharts(box);
      };
      if (usesDates) bindRangeBar(el, RS, load);
      const fLoc = $('#fLoc', el);
      if (fLoc) fLoc.addEventListener('change', () => { RS.loc = fLoc.value; load(); });
      $('#prBtn').addEventListener('click', () => window.print());
      if ($('#xlBtn')) $('#xlBtn').addEventListener('click', () => download(`/api/export/sale_items${qs({ from: RS.from, to: RS.to })}`));
      box.addEventListener('click', (e) => {
        const r = e.target.closest('[data-link]');
        if (!r) return;
        const l = r.dataset.link;
        if (l.startsWith('bill:')) showBill(+l.slice(5)); else go(l);
      });
      await load();
    },
  };
}
View('reports', reportsView('overview'));
for (const [k] of REPORT_TABS) View('reports/' + k, reportsView(k));

const placeText = (q) => (q.location_id ? locName(q.location_id) : 'Whole business');

const REPORT_RENDER = {
  // ---------- Overview: the profit sum for the dates ----------
  async overview(box, q) {
    const r = await GET('/api/reports', q);
    const s = r.summary;
    const pct = (a, b) => (b ? ` <span class="muted small">(${Math.round((a / b) * 100)}%)</span>` : '');
    const daily = [...r.daily].reverse();
    box.innerHTML = `
      <div class="muted" style="margin-bottom:10px">${esc(fmtDate(r.from))} – ${esc(fmtDate(r.to))} · ${esc(placeText(q))}</div>
      <div class="stats">
        ${statHtml('Sales', money(s.net_sales), `${s.bills} bills · ${s.items_sold} pieces`)}
        ${statHtml('Cost of items sold', money(s.cogs))}
        ${statHtml('Gross profit', money(s.gross_profit), s.net_sales ? Math.round((s.gross_profit / s.net_sales) * 100) + '% margin' : '—', s.gross_profit < 0 ? 'bad' : '')}
        ${statHtml('Expenses', money(s.expenses))}
        ${statHtml('Net profit', `<span class="${s.net_profit < 0 ? 'neg' : 'plus'}">${money(s.net_profit)}</span>`, 'after expenses', s.net_profit < 0 ? 'bad' : '')}
      </div>
      ${daily.length > 1 ? `<div class="card"><h3>Day by day</h3>${chart({ type: 'bars', labels: daily.map((d) => fmtDate(d.day).replace(/ \d{4}$/, '')), series: [{ name: 'Sales', values: daily.map((d) => d.total) }, { name: 'Profit', values: daily.map((d) => d.profit) }], fmt: money, tip: (i) => [`${daily[i].bills} bills`] })}</div>` : ''}
      <div class="grid-2">
        <div class="card"><h3>Sales breakdown</h3><table class="tbl">
          <tr><td>Items sold (before discount)</td><td class="r">${money(s.gross_sales)}</td></tr>
          <tr><td>Customer returns</td><td class="r neg">− ${money(s.returns)} <span class="muted small">(${s.items_returned} pcs)</span></td></tr>
          <tr><td>Discounts given</td><td class="r neg">− ${money(s.discounts)}</td></tr>
          <tr><td><b>Net sales</b></td><td class="r"><b>${money(s.net_sales)}</b></td></tr>
          <tr><td>Cost of those items</td><td class="r">− ${money(s.cogs)}</td></tr>
          <tr><td><b>Gross profit</b></td><td class="r"><b>${money(s.gross_profit)}</b></td></tr>
          <tr><td>Expenses</td><td class="r">− ${money(s.expenses)}</td></tr>
          <tr><td><b>Net profit</b></td><td class="r"><b class="${s.net_profit < 0 ? 'neg' : ''}">${money(s.net_profit)}</b></td></tr></table></div>
        <div class="card"><h3>Buying & payments</h3><table class="tbl">
          <tr><td>Purchases from suppliers</td><td class="r">${money(r.purchases.total)} <span class="muted small">(${r.purchases.qty} pcs, ${r.purchases.n} bills)</span></td></tr>
          <tr><td>Paid at time of purchase</td><td class="r">${money(r.purchases.paid_now)}</td></tr>
          <tr><td>Supplier payments made later</td><td class="r">${money(r.purchases.paid_later)}</td></tr></table>
          <h3 style="margin-top:18px">Payment methods</h3><table class="tbl">
          ${r.by_method.map((m) => `<tr><td>${esc(METHOD_NAMES[m.method] || m.method)} <span class="muted small">(${m.bills} bills)</span></td><td class="r">${money(m.total)}${pct(m.total, s.net_sales)}</td></tr>`).join('') || '<tr><td class="muted">No sales</td></tr>'}</table></div>
      </div>
      ${r.by_location.length > 1 || !q.location_id ? `<div class="grid-2">${tableCard('By shop', '<th>Location</th><th class="r">Bills</th><th class="r">Net sales</th><th class="r">Gross profit</th><th class="r">Expenses</th><th class="r">Net profit</th>',
        r.by_location.map((l) => `<tr><td><b>${esc(l.name)}</b></td><td class="r">${l.bills}</td><td class="r">${money(l.net_sales)}</td><td class="r">${money(l.gross_profit)}</td><td class="r">${money(l.expenses)}</td><td class="r"><b class="${l.net_profit < 0 ? 'neg' : ''}">${money(l.net_profit)}</b></td></tr>`).join(''), 'No activity')}
        <div class="card"><h3>Sales by category</h3>${r.by_category.length ? hbars(r.by_category.slice(0, 10).map((c) => ({ name: c.category, value: c.amount, sub: `${c.qty} pcs · profit ${money(c.profit)}` })), { fmt: money }) : '<div class="muted">No sales</div>'}</div></div>` : ''}
      <div class="grid-2">
        ${tableCard('Best sellers', '<th>Item</th><th class="r">Pieces</th><th class="r">Sales</th><th class="r">Profit</th>',
          r.top_products.slice(0, 15).map((p) => `<tr><td><b>${esc(p.name)}</b> <span class="muted">${esc(variantText(p))}</span></td><td class="r">${p.qty}</td><td class="r">${money(p.amount)}</td><td class="r ${p.profit < 0 ? 'neg' : ''}">${money(p.profit)}</td></tr>`).join(''), 'No sales')}
        <div class="card"><h3>Expenses by type</h3>${r.expenses_by_category.length ? hbars(r.expenses_by_category.map((c) => ({ name: c.category, value: c.amount })), { fmt: money, color: SERIES[1] }) : '<div class="muted">No expenses</div>'}</div>
      </div>
      <div style="margin-top:16px">${tableCard('Day by day', '<th>Date</th><th class="r">Bills</th><th class="r">Pieces</th><th class="r">Discount</th><th class="r">Sales</th><th class="r">Cost</th><th class="r">Gross profit</th><th class="r">Expenses</th><th class="r">Net</th>',
        r.daily.map((d) => `<tr><td>${esc(fmtDate(d.day))}</td><td class="r">${d.bills}</td><td class="r">${d.items}</td><td class="r">${money(d.discount)}</td><td class="r">${money(d.total)}</td><td class="r">${money(d.cogs)}</td><td class="r">${money(d.profit)}</td><td class="r">${money(d.expenses)}</td><td class="r"><b class="${d.net < 0 ? 'neg' : ''}">${money(d.net)}</b></td></tr>`).join(''), 'Nothing in this period')}</div>`;
  },

  // ---------- Trends: how sales and profit move, compared with the period before ----------
  async trends(box, q) {
    const r = await GET('/api/reports/trends', { ...q, group: RS.group });
    const n = r.now, b = r.before;
    const vs = `vs ${fmtDate(r.prev_from).replace(/ \d{4}$/, '')} – ${fmtDate(r.prev_to).replace(/ \d{4}$/, '')}`;
    const labels = r.buckets.map((x) => x.label);
    const hourLabel = (h) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
    const best = [...r.weekday].sort((a, c) => c.sales - a.sales)[0];
    box.innerHTML = `
      <div class="muted" style="margin-bottom:10px">${esc(fmtDate(r.from))} – ${esc(fmtDate(r.to))} · ${esc(placeText(q))} · arrows compare with ${esc(vs.slice(3))}</div>
      <div class="stats">
        ${statHtml('Sales', money(n.sales), deltaHtml(n.sales, b.sales))}
        ${statHtml('Gross profit', money(n.profit), deltaHtml(n.profit, b.profit))}
        ${statHtml('Net profit', `<span class="${n.net < 0 ? 'neg' : ''}">${money(n.net)}</span>`, deltaHtml(n.net, b.net))}
        ${statHtml('Bills', num(n.bills), deltaHtml(n.bills, b.bills))}
        ${statHtml('Average bill', money(Math.round(n.avg_bill)), deltaHtml(n.avg_bill, b.avg_bill))}
        ${statHtml('Pieces sold', num(n.items), deltaHtml(n.items, b.items))}
      </div>
      <div class="card"><div class="card-head"><h3>Sales and profit</h3><div class="actions"><div class="seg no-print" id="grp">${['day', 'week', 'month'].map((g) => `<button type="button" data-g="${g}" class="${r.group === g ? 'on' : ''}">By ${g}</button>`).join('')}</div></div></div>
        ${chart({ type: 'lines', area: true, height: 260, labels, series: [{ name: 'Sales', values: r.buckets.map((x) => x.sales) }, { name: 'Profit', values: r.buckets.map((x) => x.profit) }], fmt: money, tip: (i) => [`${r.buckets[i].bills} bills · ${r.buckets[i].items} pieces`, `Expenses ${money(r.buckets[i].expenses)}`] })}</div>
      ${r.shops.length > 1 ? `<div class="card"><h3>Sales by shop</h3>${chart({ type: 'lines', height: 240, labels, series: r.shops.slice(0, 8).map((s) => ({ name: s.name, values: s.series })), fmt: money })}</div>` : ''}
      <div class="grid-2">
        <div class="card"><h3>Busiest days of the week</h3>${n.bills ? chart({ type: 'bars', height: 200, labels: r.weekday.map((w) => w.day), series: [{ name: 'Sales', values: r.weekday.map((w) => w.sales) }], fmt: money, tip: (i) => [`${r.weekday[i].bills} bills`] }) + `<div class="muted small">Best day: <b>${esc(best.day)}</b></div>` : '<div class="muted">No sales yet</div>'}</div>
        <div class="card"><h3>Busiest hours</h3>${r.hours.length ? chart({ type: 'bars', height: 200, labels: r.hours.map((h) => hourLabel(h.hour)), series: [{ name: 'Sales', values: r.hours.map((h) => h.sales) }], fmt: money, tip: (i) => [`${r.hours[i].bills} bills`] }) : '<div class="muted">No sales yet</div>'}</div>
      </div>
      <div style="margin-top:16px">${tableCard(`By ${r.group}`, '<th>Period</th><th class="r">Bills</th><th class="r">Pieces</th><th class="r">Sales</th><th class="r">Gross profit</th><th class="r">Expenses</th><th class="r">Net</th>',
        [...r.buckets].reverse().map((x) => `<tr><td>${esc(r.group === 'week' ? 'Week of ' + x.label : x.label)}</td><td class="r">${x.bills}</td><td class="r">${x.items}</td><td class="r">${money(x.sales)}</td><td class="r">${money(x.profit)}</td><td class="r">${money(x.expenses)}</td><td class="r"><b class="${x.net < 0 ? 'neg' : ''}">${money(x.net)}</b></td></tr>`).join(''), 'Nothing in this period')}</div>`;
    $$('#grp [data-g]', box).forEach((btn) => btn.addEventListener('click', async () => { RS.group = btn.dataset.g; await REPORT_RENDER.trends(box, q); drawCharts(box); }));
  },

  // ---------- Stock & money: what the stock is worth, what runs out, what stands still, what is on the way ----------
  async stock(box, q) {
    const r = await GET('/api/reports/stock', q);
    const t = r.totals;
    const daysPill = (d) => `<span class="pill ${d <= 3 ? 'red' : d <= 7 ? 'warn' : 'blue'}">${d <= 0 ? 'Sold out' : d === 1 ? '1 day' : d + ' days'}</span>`;
    box.innerHTML = `
      <div class="stats">
        ${statHtml('Stock value (cost)', money(t.cost_value), `${num(t.pieces)} pieces`)}
        ${statHtml('Stock value (selling price)', money(t.sale_value), `${money(t.sale_value - t.cost_value)} profit inside`)}
        ${statHtml('Not selling (60+ days)', money(t.slow_value), `${r.slow_count} item${r.slow_count === 1 ? '' : 's'} standing still`, t.slow_value > 0 ? 'warn' : '')}
        ${statHtml('On the way', money(t.on_the_way), `${r.parcels.length} parcel${r.parcels.length === 1 ? '' : 's'} · ${r.orders.length} order${r.orders.length === 1 ? '' : 's'}`)}
        ${t.below_zero ? statHtml('Below zero', num(t.below_zero), 'items need a count', 'bad') : ''}
      </div>
      <div class="card"><h3>Stock value by place</h3>${r.places.length ? chart({ type: 'bars', height: 220, labels: r.places.map((p) => p.name), series: [{ name: 'At cost', values: r.places.map((p) => p.cost_value) }, { name: 'At selling price', values: r.places.map((p) => p.sale_value) }], fmt: money, tip: (i) => [`${num(r.places[i].pieces)} pieces · ${r.places[i].items} items`] }) : '<div class="muted">No places</div>'}</div>
      <div class="grid-2">
        ${tableCard('Running out at shops', '<th>Item</th><th>Shop</th><th class="r">In stock</th><th class="r">Sold (30 days)</th><th class="r">Lasts</th>',
          r.running_out.map((x) => `<tr class="click" data-link="products/${x.id}"><td><b>${esc(x.name)}</b></td><td>${esc(x.location)}</td><td class="r ${x.qty <= 0 ? 'negq' : ''}">${x.qty}</td><td class="r">${x.sold30}</td><td class="r">${daysPill(x.days_left)}</td></tr>`).join(''), 'Nothing is running out', '<span class="muted small">at the speed of the last 30 days</span>')}
        ${tableCard('Not selling (60+ days)', '<th>Item</th><th class="r">Pieces</th><th class="r">Money in it</th><th>Last sold</th>',
          r.slow.map((x) => `<tr class="click" data-link="products/${x.id}"><td><b>${esc(x.name)}</b></td><td class="r">${x.qty}</td><td class="r">${money(x.cost_value)}</td><td>${x.last_sold ? esc(fmtDate(x.last_sold)) : '<span class="muted">never</span>'}</td></tr>`).join(''), 'Everything sold in the last 60 days')}
      </div>
      <div class="grid-2">
        ${tableCard('Parcels on the way', '<th>Parcel</th><th>From → to</th><th class="r">Pieces</th><th class="r">Value (cost)</th><th class="r">Days</th>',
          r.parcels.map((x) => `<tr class="click" data-link="dispatch/${x.id}"><td><b>${esc(x.dispatch_no)}</b></td><td>${esc(x.from_name)} → ${esc(x.to_name)}</td><td class="r">${x.total_qty}</td><td class="r">${money(x.cost_value)}</td><td class="r">${x.days > 2 ? `<span class="pill warn">${x.days}</span>` : x.days}</td></tr>`).join(''), 'No parcels on the way')}
        ${tableCard('Purchase orders waiting', '<th>Order</th><th>Supplier</th><th class="r">Pieces</th><th class="r">Value</th><th>Expected</th>',
          r.orders.map((x) => `<tr class="click" data-link="purchases/${x.id}"><td><b>${esc(x.purchase_no)}</b></td><td>${esc(x.supplier_name || '—')}</td><td class="r">${x.total_qty}</td><td class="r">${money(x.total)}</td><td>${x.expected_date ? `${esc(fmtDate(x.expected_date))}${x.late ? ' <span class="pill red">late</span>' : ''}` : '<span class="muted">—</span>'}</td></tr>`).join(''), 'No orders waiting')}
      </div>
      <div style="margin-top:16px">${tableCard('Each place', '<th>Place</th><th class="r">Pieces</th><th class="r">Items</th><th class="r">Value at cost</th><th class="r">Value at selling price</th><th class="r">Profit inside</th>',
        r.places.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.below_zero ? ` <span class="pill red">${p.below_zero} below zero</span>` : ''}</td><td class="r">${num(p.pieces)}</td><td class="r">${p.items}</td><td class="r">${money(p.cost_value)}</td><td class="r">${money(p.sale_value)}</td><td class="r">${money(p.profit_inside)}</td></tr>`).join(''), 'No places')}</div>`;
  },

  // ---------- Suppliers: bought, paid, owed and how long it has been owed ----------
  async suppliers(box, q) {
    const r = await GET('/api/reports/suppliers', q);
    const t = r.totals;
    const AGE = [['under30', 'Under 30 days', '#86b6ef'], ['d30_60', '30–60 days', '#2a78d6'], ['over60', 'Over 60 days', '#104281']];
    const ageBar = (s) => (s.owed > 0 ? `<div class="age-bar" title="${AGE.map(([k, l]) => `${l}: ${money(s[k])}`).join('\n')}">${AGE.map(([k, , c]) => (s[k] > 0 ? `<span style="width:${(s[k] / s.owed) * 100}%;background:${c}"></span>` : '')).join('')}</div>` : '');
    box.innerHTML = `
      <div class="muted" style="margin-bottom:10px">Bought and paid: ${esc(fmtDate(r.from))} – ${esc(fmtDate(r.to))}. Owed: as of today.</div>
      <div class="stats">
        ${statHtml('You owe suppliers', money(t.owed), 'as of today')}
        ${statHtml('Owed over 60 days', money(t.over60), t.over60 > 0 ? 'oldest bills: pay these first' : 'nothing old', t.over60 > 0 ? 'bad' : '')}
        ${statHtml('Bought', money(t.bought), 'in these dates')}
        ${statHtml('Paid', money(t.paid), 'in these dates')}
        ${statHtml('Orders waiting', money(t.orders_value), 'not arrived yet')}
      </div>
      ${t.owed > 0 ? `<div class="card"><h3>Who you owe the most</h3>${hbars(r.suppliers.filter((s) => s.owed > 0).slice(0, 10).map((s) => ({ name: s.name, value: s.owed, sub: s.oldest_unpaid ? `oldest unpaid ${s.oldest_days} days` : '' })), { fmt: money })}</div>` : ''}
      <div style="margin-top:16px">${tableCard('Suppliers', '<th>Supplier</th><th class="r">Bought</th><th class="r">Paid</th><th class="r">Owed now</th><th style="min-width:150px">How old</th><th>Oldest unpaid</th><th class="r">Orders waiting</th>',
        r.suppliers.map((s) => `<tr class="click" data-link="suppliers/${s.id}"><td><b>${esc(s.name)}</b>${s.overpaid ? ` <span class="pill warn">paid ${money(s.overpaid)} extra</span>` : ''}</td><td class="r">${money(s.bought)}</td><td class="r">${money(s.paid)}</td>
          <td class="r"><b>${money(s.owed)}</b></td><td>${ageBar(s)}</td><td>${s.oldest_unpaid ? `${esc(fmtDate(s.oldest_unpaid))} <span class="pill ${s.oldest_days > 60 ? 'red' : s.oldest_days > 30 ? 'warn' : ''}">${s.oldest_days} days</span>` : '<span class="muted">—</span>'}</td>
          <td class="r">${s.orders ? `${s.orders} · ${money(s.orders_value)}` : '<span class="muted">—</span>'}</td></tr>`).join(''), 'No suppliers yet',
        `<div class="legend" style="margin-left:auto">${AGE.map(([, l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}</div>`)}</div>`;
  },

  // ---------- Staff: what each person did ----------
  async staff(box, q) {
    const r = await GET('/api/reports/staff', q);
    const p = r.people;
    const sellers = p.filter((x) => x.bills);
    const seeCost = canSeeCost();
    box.innerHTML = `
      <div class="muted" style="margin-bottom:10px">${esc(fmtDate(r.from))} – ${esc(fmtDate(r.to))} · ${esc(placeText(q))}</div>
      ${sellers.length ? `<div class="grid-2" style="margin-top:0">
        <div class="card"><h3>Sales by person</h3>${hbars(sellers.map((x) => ({ name: x.name, value: x.sales, sub: `${x.bills} bills · average ${money(Math.round(x.avg_bill))}` })), { fmt: money })}</div>
        <div class="card"><h3>Discounts given</h3>${sellers.some((x) => x.discount) ? hbars(sellers.filter((x) => x.discount).map((x) => ({ name: x.name, value: x.discount, sub: `on ${x.discount_bills} bill${x.discount_bills === 1 ? '' : 's'} · ${x.sales ? Math.round((x.discount / (x.sales + x.discount)) * 100) : 0}% of their sales` })), { fmt: money, color: SERIES[1] }) : '<div class="muted">No discounts</div>'}</div>
      </div>` : ''}
      <div style="margin-top:16px">${tableCard('Selling', `<th>Person</th><th class="r">Bills</th><th class="r">Sales</th><th class="r">Average bill</th><th class="r">Pieces</th><th class="r">Discounts</th><th class="r">Returns</th><th class="r">Cancelled bills</th>${seeCost ? '<th class="r">Profit</th>' : ''}`,
        sellers.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td class="r">${x.bills}</td><td class="r">${money(x.sales)}</td><td class="r">${money(Math.round(x.avg_bill))}</td><td class="r">${x.items}</td><td class="r">${x.discount ? money(x.discount) : '—'}</td><td class="r">${x.returned_items ? `${x.returned_items} pcs · ${money(x.returns)}` : '—'}</td>
          <td class="r">${x.cancelled ? `<span class="pill red">${x.cancelled}</span> ${money(x.cancelled_value)}` : '—'}</td>${seeCost ? `<td class="r ${x.profit < 0 ? 'neg' : ''}">${money(x.profit)}</td>` : ''}</tr>`).join(''), 'No bills in these dates')}</div>
      <div style="margin-top:16px">${tableCard('Other work', '<th>Person</th><th class="r">Purchases entered</th><th class="r">Parcels sent</th><th class="r">Parcels received</th><th class="r">Stock corrections</th><th class="r">Expenses</th>',
        p.filter((x) => x.purchases || x.sent || x.received || x.corrections || x.expenses).map((x) => `<tr><td><b>${esc(x.name)}</b></td><td class="r">${x.purchases || '—'}</td><td class="r">${x.sent || '—'}</td><td class="r">${x.received || '—'}</td><td class="r">${x.corrections ? `<b>${x.corrections}</b>` : '—'}</td><td class="r">${x.expenses || '—'}</td></tr>`).join(''), 'Nothing else in these dates')}</div>`;
  },

  // ---------- Things to check: what looks wrong (also what someone continued past a warning) ----------
  async check(box, q) {
    const r = await GET('/api/reports/unusual', q);
    const high = r.items.filter((i) => i.level === 'high'), look = r.items.filter((i) => i.level !== 'high');
    const row = (i) => `<div class="check-row ${i.level}${i.link ? ' click' : ''}" ${i.link ? `data-link="${esc(i.link)}"` : ''}>
      <span class="check-ic">${i.level === 'high' ? '!' : '?'}</span>
      <div class="grow"><div><span class="pill ${i.level === 'high' ? 'red' : 'warn'}">${esc(i.kind)}</span> <b>${esc(i.title)}</b></div>
        <div class="muted small">${esc(i.detail)}</div>
        <div class="muted small">${[i.place, i.user && 'by ' + i.user, i.at && fmtDT(i.at)].filter(Boolean).map(esc).join(' · ') || 'right now'}</div></div>
      ${i.link ? `<span class="check-go">${icon('arrow')}</span>` : ''}</div>`;
    box.innerHTML = r.items.length ? `
      <div class="stats">
        ${statHtml('Need attention', num(high.length), 'money lost or stock wrong', high.length ? 'bad' : '')}
        ${statHtml('Worth a look', num(look.length), 'unusual, maybe fine', look.length ? 'warn' : '')}
      </div>
      <p class="muted" style="margin:0 0 12px">These were saved even though they look unusual (people may continue past a warning). Click one to open it.</p>
      ${high.length ? `<div class="card flush check-list"><div class="card-head pad"><h3>Need attention</h3></div>${high.map(row).join('')}</div>` : ''}
      ${look.length ? `<div class="card flush check-list" style="margin-top:16px"><div class="card-head pad"><h3>Worth a look</h3></div>${look.map(row).join('')}</div>` : ''}`
      : `<div class="card empty-good"><div class="eg-ic">${icon('check')}</div><b>Nothing unusual</b><div class="muted">No sales at a loss, big discounts, missing costs or stock problems in these dates.</div></div>`;
  },
};
