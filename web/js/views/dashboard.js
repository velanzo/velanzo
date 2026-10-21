'use strict';
// The owner's home: today's numbers, every shop and the warehouse live, and the latest activity.

// The last 14 days as bars, with the amount on hover.
function salesChart(daily) {
  return chart({ type: 'bars', height: 190, labels: daily.map((d) => fmtDate(d.day).replace(/ d{4}$/, '')), series: [{ name: 'Sales', values: daily.map((d) => d.total) }],
    fmt: money, tip: (i) => [`${daily[i].bills} bills`] });
}

View('dashboard', {
  title: () => `Today, ${fmtDate(todayStr()).replace(/ \d{4}$/, '')}`,
  allow: isAdmin,
  async render({ el }) {
    const [d, live, chk] = await Promise.all([GET('/api/dashboard'), GET('/api/live'), GET('/api/reports/unusual', { from: todayStr().slice(0, 8) + '01', to: todayStr() }).catch(() => ({ high: 0, items: [] }))]);
    setActions(`<a class="btn" href="#/reports">${icon('chart')} Reports</a>`);
    let lastBackup = null;
    try { lastBackup = localStorage.getItem('vz_last_backup'); } catch { /* ignore */ }
    const backupOld = !lastBackup || (Date.now() - new Date(lastBackup.replace(' ', 'T'))) > 7 * 864e5;
    el.innerHTML = `
      ${backupOld ? `<div class="alert flex">${icon('download')}<div class="grow">${lastBackup ? 'Your last backup from this device is more than a week old.' : 'Keep a copy of your data: download a backup now and then.'}</div><a class="btn sm" href="#/settings/backup">Back up now</a></div>` : ''}
      ${chk.high ? `<a class="alert danger flex attn" href="#/reports/check"><span class="attn-n">${chk.high}</span><div class="grow"><b>${chk.high === 1 ? '1 thing needs' : chk.high + ' things need'} your attention this month</b><div class="small">${esc([...new Set(chk.items.filter((i) => i.level === 'high').map((i) => i.kind))].slice(0, 4).join(' · '))}</div></div><span class="btn sm">See them</span></a>` : ''}
      <div class="big-stats">
        <a class="big-stat" href="#/sales"><span>Sales today</span><b id="todayVal">${money(d.today.total)}</b><small id="todaySub">${d.today.bills} bills</small></a>
        <a class="big-stat" href="#/reports"><span>Profit this month</span><b class="${d.month.net_profit < 0 ? 'neg' : ''}">${money(d.month.net_profit)}</b><small>after ${money(d.month.expenses)} expenses</small></a>
        <a class="big-stat" href="#/suppliers"><span>You owe suppliers</span><b>${money(d.supplier_due)}</b><small>unpaid purchases</small></a>
      </div>
      <h3 class="sec-title">Your shops and warehouse <span class="live-tag">Live</span></h3>
      <div class="place-live" id="liveLocs"></div>
      <div class="grid-live">
        <div class="card flush"><div class="card-head pad"><h3>Latest</h3><div class="actions"><a class="btn sm" href="#/activity">See everything</a></div></div><div class="feed" id="liveFeed"></div></div>
        <div class="card"><h3>Sales — last 14 days</h3>${salesChart(d.daily)}
          <div class="mini-links">${d.low_stock ? `<a href="#/stock?low=1">${d.low_stock} items low at shops</a>` : '<span class="muted">No items low at shops</span>'}
          ${d.transit.n ? ` · <a href="#/dispatch">${d.transit.n} parcel${d.transit.n > 1 ? 's' : ''} on the way</a>` : ''}</div></div>
      </div>`;
    paintLive(el, live);
    drawCharts(el);
    // Keep the live part fresh while the owner watches (skipped while the window is minimised / in the background).
    const timer = setInterval(async () => {
      if (document.hidden || !el.isConnected) return;
      try { paintLive(el, await GET('/api/live')); } catch { /* try again next time */ }
    }, 15000);
    onCleanup(() => clearInterval(timer));
    el.addEventListener('click', (e) => {
      const r = e.target.closest('[data-href]');
      if (r) return go(r.dataset.href);
      const b = e.target.closest('[data-bill]');
      if (b) showBill(+b.dataset.bill);
    });
  },
});

function paintLive(el, live) {
  const shopsToday = live.locations.filter((l) => l.type === 'shop');
  const total = shopsToday.reduce((a, l) => a + l.sales, 0), bills = shopsToday.reduce((a, l) => a + l.bills, 0);
  $('#todayVal', el).textContent = money(total);
  $('#todaySub', el).textContent = `${bills} bills`;
  $('#liveLocs', el).innerHTML = liveLocationsHtml(live);
  $('#liveFeed', el).innerHTML = live.activity.length
    ? live.activity.slice(0, 8).map((a) => activityRowHtml(a, live.at)).join('')
    : '<div class="empty">Nothing has happened in the last 7 days.</div>';
}

// ---------- Live: one card per place — who is working, what it did today ----------
function liveLocationsHtml(live) {
  return live.locations.map((l) => {
    const people = [...new Set(live.online.filter((p) => p.location_id === l.id).map((p) => p.name))];
    const open = people.length > 0;
    const main = l.type === 'shop' || l.bills
      ? `${money(l.sales)} <small>· ${l.bills} bill${l.bills === 1 ? '' : 's'}</small>`
      : [l.pieces_bought && `${num(l.pieces_bought)} pieces bought`, l.pieces_sent && `${num(l.pieces_sent)} pieces sent`].filter(Boolean).join(' · ') || '<small>Nothing yet today</small>';
    const extra = [l.last_activity && `Last ${l.type === 'shop' ? 'activity' : 'activity'} ${agoText(l.last_activity, live.at)}`,
      l.pieces_received && `received ${num(l.pieces_received)} pieces`, l.coming && `${l.coming} parcel${l.coming > 1 ? 's' : ''} coming`].filter(Boolean).join(' · ');
    return `<a class="card place-now" href="#/sales?location_id=${l.id}">
      <div class="pn-head"><span class="dot${open ? ' on' : ''}"></span><b>${esc(l.name)}</b>
        <span class="pn-who ${open ? 'on' : ''}">${open ? 'Open · ' + people.map(esc).join(', ') : 'Nobody online'}</span></div>
      <div class="pn-main">${main}</div>
      <div class="muted small">${esc(extra) || '&nbsp;'}</div></a>`;
  }).join('');
}

// "just now", "5 min ago", "3:40 pm" (today) or the full date. Both times come from the server's clock.
function agoText(at, serverNow) {
  const s = (new Date(serverNow.replace(' ', 'T')) - new Date(at.replace(' ', 'T'))) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return at.slice(0, 10) === serverNow.slice(0, 10) ? fmtTime(at) : fmtDT(at);
}

// ---------- One line of the activity feed ----------
const pcsText = (n) => `${num(n)} pc${Math.abs(n) === 1 ? '' : 's'}`;
const ACTIVITY = {
  sale: ['🧾', 'ok', (a) => `Bill <b>${esc(a.ref)}</b> · ${pcsText(a.qty)} · <b>${money(a.amount)}</b> <span class="muted">${esc(METHOD_NAMES[a.note] || '')}</span>`],
  return: ['↩️', 'warn', (a) => `Return on <b>${esc(a.ref)}</b> · ${pcsText(a.qty2)} back · refund <b>${money(Math.abs(a.amount))}</b>`],
  exchange: ['🔁', 'warn', (a) => `Exchange <b>${esc(a.ref)}</b> · ${pcsText(a.qty2)} back, ${pcsText(a.qty)} out · ${a.amount < 0 ? 'refund' : 'paid'} <b>${money(Math.abs(a.amount))}</b>`],
  bill_void: ['✖', 'red', (a) => `Bill <b>${esc(a.ref)}</b> cancelled (${money(a.amount)})${a.note ? ` — ${esc(a.note)}` : ''}`],
  purchase: ['📦', 'blue', (a) => `Purchase <b>${esc(a.ref)}</b>${a.other ? ` from ${esc(a.other)}` : ''} · ${pcsText(a.qty)} · ${money(a.amount)}`],
  dispatch: ['🚚', 'blue', (a) => `Sent <b>${esc(a.ref)}</b> to <b>${esc(a.other)}</b> · ${pcsText(a.qty)} · ${money(a.amount)}`],
  received: ['📥', 'blue', (a) => `Received <b>${esc(a.ref)}</b> from ${esc(a.other)} · ${num(a.qty)} of ${pcsText(a.qty2)}${a.qty < a.qty2 ? ` <span class="pill red">${a.qty2 - a.qty} missing</span>` : ''}`],
  cancel_purchase: ['✖', 'red', (a) => `Purchase <b>${esc(a.ref)}</b> cancelled · ${pcsText(a.qty)} taken out of stock`],
  cancel_dispatch: ['✖', 'red', (a) => `Dispatch <b>${esc(a.ref)}</b> cancelled · ${pcsText(a.qty)} back in stock`],
  adjust: ['✏️', '', (a) => `Stock corrected: <b>${esc(a.ref)}</b>${a.other ? ` (${esc(a.other)})` : a.qty2 > 1 ? ` (${a.qty2} sizes/colours)` : ''} <b class="${a.qty < 0 ? 'neg' : 'plus'}">${a.qty > 0 ? '+' : ''}${a.qty}</b>${a.note ? ` — ${esc(a.note)}` : ''}`],
  opening: ['🏷️', '', (a) => `New item <b>${esc(a.ref)}</b>${a.other ? ` (${esc(a.other)})` : a.qty2 > 1 ? ` (${a.qty2} sizes/colours)` : ''} · opening stock ${pcsText(a.qty)}`],
  expense: ['💸', 'money', (a) => `Expense: <b>${esc(a.ref)}</b> · ${money(a.amount)}${a.note ? ` — ${esc(a.note)}` : ''}`],
  payment: ['💰', 'money', (a) => `Paid supplier <b>${esc(a.ref)}</b> · ${money(a.amount)}${a.other ? ` <span class="muted">${esc(METHOD_NAMES[a.other] || a.other)}</span>` : ''}`],
};
function activityRowHtml(a, serverNow) {
  const [ic, tone, text] = ACTIVITY[a.kind] || ['•', '', (x) => esc(x.kind)];
  const link = a.link_type === 'sale' ? `data-bill="${a.link_id}"`
    : a.link_type === 'purchase' ? `data-href="purchases/${a.link_id}"`
    : a.link_type === 'dispatch' ? `data-href="dispatch/${a.link_id}"`
    : a.link_type === 'product' ? `data-href="products/${a.link_id}"`
    : a.link_type === 'supplier' ? `data-href="suppliers/${a.link_id}"` : '';
  const where = [a.location_name, a.user_name].filter(Boolean).map(esc).join(' · ');
  return `<div class="feed-row${link ? ' click' : ''}" ${link}><span class="feed-ic ${tone}">${ic}</span>
    <div class="grow"><div>${text(a)}</div><div class="muted small">${where}${where ? ' · ' : ''}${esc(agoText(a.at, serverNow))}</div></div></div>`;
}

// Full activity log: everything at every shop and the warehouse, by day.
View('activity', {
  title: 'Activity',
  allow: isAdmin,
  async render({ el, query }) {
    const st = { from: query.from || todayStr(), to: query.to || todayStr(), loc: query.location_id || '' };
    const locs = App.locations.filter((l) => l.active);
    el.innerHTML = `
      <div class="toolbar">${rangeBarHtml(st)}
        <select class="input" id="fLoc">${options(locs, st.loc, { blank: 'All shops & warehouse' })}</select>
      </div>
      <div class="card flush" id="list"><div class="loading">Loading…</div></div>`;

    async function load() {
      const [rows, live] = await Promise.all([GET('/api/activity', { from: st.from, to: st.to, location_id: st.loc }), GET('/api/live')]);
      if (!el.isConnected) return;
      $('.toolbar', el).querySelectorAll('[data-preset]').forEach((b) => {
        const [, f, t] = rangePresets()[b.dataset.preset];
        b.classList.toggle('on', st.from === f && st.to === t);
      });
      $('[data-range=from]', el).value = st.from;
      $('[data-range=to]', el).value = st.to;
      let day = '';
      $('#list', el).innerHTML = rows.length ? `<div class="feed">${rows.map((a) => {
        const head = a.at.slice(0, 10) !== day && st.from !== st.to ? `<div class="feed-day">${esc(fmtDate(day = a.at.slice(0, 10)))}</div>` : '';
        return head + activityRowHtml(a, live.at);
      }).join('')}</div>${rows.length >= 2000 ? '<div class="empty small">Showing the latest 2000 — choose fewer days to see the rest.</div>' : ''}`
        : '<div class="empty">Nothing happened in this period.</div>';
    }

    bindRangeBar(el, st, load);
    $('#fLoc', el).addEventListener('change', (e) => { st.loc = e.target.value; load(); });
    $('#list', el).addEventListener('click', (e) => {
      const r = e.target.closest('[data-href]');
      if (r) return go(r.dataset.href);
      const b = e.target.closest('[data-bill]');
      if (b) showBill(+b.dataset.bill, load);
    });
    const timer = setInterval(() => { if (!document.hidden && el.isConnected && st.to >= todayStr()) load().catch(() => {}); }, 20000);
    onCleanup(() => clearInterval(timer));
    await load();
  },
});
