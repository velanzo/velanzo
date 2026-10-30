// Reports: trends over time, stock and the money in it, suppliers, staff, and things to check.
// Everything is worked out on this device from the data it has (the owner's devices have everything).
import * as D from '../db.js';
import { route, toInt, isDate, needPerm, can } from '../util.js';
import { salesMetrics, expensesTotal } from './sales.js';
import { label } from './inventory.js';
import { unusual } from '../checks.js';

const { all, get, today, round2 } = D;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (d) => D.now(d).slice(0, 10);
const day = (s) => new Date(s + 'T00:00:00');
const addDays = (s, n) => { const d = day(s); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((day(b) - day(a)) / 86400000);
const monthStart = () => today().slice(0, 8) + '01';

// The dates asked for, and the place: the owner may choose any place, others see only their own.
function scope(query, user) {
  let from = isDate(query.from) ? query.from : monthStart();
  let to = isDate(query.to) ? query.to : today();
  if (from > to) [from, to] = [to, from];
  const loc = user.owner ? toInt(query.location_id) || null : user.location_id;
  return { from, to, loc };
}
const locSql = (col, loc) => (loc ? ` AND ${col} = ${Number(loc)}` : '');

// ---------- Trends ----------
function bucketOf(dayStr, group) {
  if (group === 'month') return dayStr.slice(0, 7);
  if (group === 'week') { const d = day(dayStr); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); } // weeks start on Monday
  return dayStr;
}
function bucketLabel(key, group) {
  if (group === 'month') return `${MONTHS[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;
  return `${+key.slice(8, 10)} ${MONTHS[+key.slice(5, 7) - 1]}`;
}

route('GET', '/api/reports/trends', 'reports', ({ query, user }) => {
  needPerm(user, 'see_cost', 'Seeing profit');
  const { from, to, loc } = scope(query, user);
  const span = daysBetween(from, to) + 1;
  const group = ['day', 'week', 'month'].includes(query.group) ? query.group : span <= 35 ? 'day' : span <= 140 ? 'week' : 'month';
  const p = [from + ' 00:00:00', to + ' 23:59:59'];

  const sales = all(`SELECT substr(s.created_at, 1, 10) AS day, s.location_id AS loc, COUNT(*) AS bills, SUM(s.total) AS total
    FROM sales s WHERE s.status = 'done' AND s.created_at BETWEEN ? AND ?${locSql('s.location_id', loc)} GROUP BY 1, 2`, ...p);
  const lines = all(`SELECT substr(s.created_at, 1, 10) AS day, SUM(i.qty * i.cost) AS cogs, SUM(CASE WHEN i.qty > 0 THEN i.qty ELSE 0 END) AS items
    FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.status = 'done' AND s.created_at BETWEEN ? AND ?${locSql('s.location_id', loc)} GROUP BY 1`, ...p);
  const exps = all(`SELECT date AS day, SUM(amount) AS amount FROM expenses WHERE date BETWEEN ? AND ?${locSql('location_id', loc)} GROUP BY 1`, from, to);

  // every bucket in the range, even empty ones (so the chart has no gaps)
  const keys = [];
  for (let d = from; d <= to; d = addDays(d, 1)) { const k = bucketOf(d, group); if (keys[keys.length - 1] !== k) keys.push(k); }
  const B = new Map(keys.map((k) => [k, { key: k, label: bucketLabel(k, group), sales: 0, cogs: 0, bills: 0, items: 0, expenses: 0 }]));
  const shopIds = [...new Set(sales.map((r) => r.loc))];
  const byShop = new Map(shopIds.map((id) => [id, new Map(keys.map((k) => [k, 0]))]));
  for (const r of sales) { const b = B.get(bucketOf(r.day, group)); b.sales += r.total; b.bills += r.bills; byShop.get(r.loc).set(bucketOf(r.day, group), byShop.get(r.loc).get(bucketOf(r.day, group)) + r.total); }
  for (const r of lines) { const b = B.get(bucketOf(r.day, group)); b.cogs += r.cogs || 0; b.items += r.items || 0; }
  for (const r of exps) { const b = B.get(bucketOf(r.day, group)); if (b) b.expenses += r.amount; }
  const buckets = [...B.values()].map((b) => ({ ...b, sales: round2(b.sales), profit: round2(b.sales - b.cogs), net: round2(b.sales - b.cogs - b.expenses), expenses: round2(b.expenses), cogs: round2(b.cogs) }));

  // the same number of days just before, to compare with
  const prevTo = addDays(from, -1), prevFrom = addDays(from, -span);
  const totals = (f, t) => {
    const m = salesMetrics(f, t, loc), e = expensesTotal(f, t, loc);
    return { sales: m.net_sales, profit: m.gross_profit, net: round2(m.gross_profit - e), bills: m.bills, items: m.items_sold, avg_bill: m.bills ? round2(m.net_sales / m.bills) : 0, expenses: e, discounts: m.discounts };
  };

  // busiest days of the week and hours of the day
  const weekday = Array.from({ length: 7 }, (_, i) => ({ day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i], sales: 0, bills: 0 }));
  for (const r of all(`SELECT substr(s.created_at, 1, 10) AS day, SUM(s.total) AS total, COUNT(*) AS bills FROM sales s
      WHERE s.status = 'done' AND s.created_at BETWEEN ? AND ?${locSql('s.location_id', loc)} GROUP BY 1`, ...p)) {
    const w = weekday[(day(r.day).getDay() + 6) % 7]; w.sales += r.total; w.bills += r.bills;
  }
  const hours = all(`SELECT CAST(substr(s.created_at, 12, 2) AS INTEGER) AS hour, SUM(s.total) AS sales, COUNT(*) AS bills FROM sales s
      WHERE s.status = 'done' AND s.created_at BETWEEN ? AND ?${locSql('s.location_id', loc)} GROUP BY 1 ORDER BY 1`, ...p);

  const names = new Map(all('SELECT id, name FROM locations').map((l) => [l.id, l.name]));
  return {
    from, to, group, location_id: loc, prev_from: prevFrom, prev_to: prevTo,
    now: totals(from, to), before: totals(prevFrom, prevTo),
    buckets,
    shops: shopIds.map((id) => ({ id, name: names.get(id) || '?', series: keys.map((k) => round2(byShop.get(id).get(k))), total: round2([...byShop.get(id).values()].reduce((a, b) => a + b, 0)) })).sort((a, b) => b.total - a.total),
    weekday: weekday.map((w) => ({ ...w, sales: round2(w.sales) })),
    hours: hours.map((h) => ({ ...h, sales: round2(h.sales) })),
  };
});

// ---------- Stock and the money in it ----------
route('GET', '/api/reports/stock', 'reports', ({ query, user }) => {
  needPerm(user, 'see_cost', 'Seeing cost and stock value');
  const { loc } = scope(query, user);
  const low = toInt(D.getSettings().low_stock, 2);
  const since30 = addDays(today(), -29) + ' 00:00:00';

  const places = all(`SELECT l.id, l.name, l.type, COALESCE(SUM(CASE WHEN s.qty > 0 THEN s.qty END), 0) AS pieces,
      COUNT(CASE WHEN s.qty > 0 THEN 1 END) AS items, COUNT(CASE WHEN s.qty < 0 THEN 1 END) AS below_zero,
      COALESCE(SUM(CASE WHEN s.qty > 0 THEN s.qty * p.cost_price END), 0) AS cost_value,
      COALESCE(SUM(CASE WHEN s.qty > 0 THEN s.qty * p.sale_price END), 0) AS sale_value
    FROM locations l LEFT JOIN stock s ON s.location_id = l.id LEFT JOIN products p ON p.id = s.product_id
    WHERE l.active = 1${locSql('l.id', loc)} GROUP BY l.id ORDER BY l.type DESC, l.id`)
    .map((r) => ({ ...r, cost_value: round2(r.cost_value), sale_value: round2(r.sale_value), profit_inside: round2(r.sale_value - r.cost_value) }));

  // how fast each item sells at each place (last 30 days) → how many days the stock lasts
  const sold = new Map(all(`SELECT s.location_id AS loc, i.product_id AS pid, SUM(i.qty) AS n FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'done' AND i.qty > 0 AND s.created_at >= ? GROUP BY 1, 2`, since30).map((r) => [`${r.loc}:${r.pid}`, r.n]));
  const runningOut = [];
  for (const r of all(`SELECT s.location_id AS loc, l.name AS location_name, s.qty, p.* FROM stock s JOIN products p ON p.id = s.product_id
      JOIN locations l ON l.id = s.location_id WHERE l.active = 1 AND l.type = 'shop' AND p.active = 1${locSql('s.location_id', loc)}`)) {
    const n = sold.get(`${r.loc}:${r.id}`) || 0;
    if (!n) continue;
    const perDay = n / 30;
    const daysLeft = r.qty <= 0 ? 0 : Math.floor(r.qty / perDay);
    if (daysLeft <= 14 || r.qty <= low) runningOut.push({ id: r.id, name: label(r), barcode: r.barcode, location: r.location_name, qty: r.qty, sold30: n, days_left: daysLeft });
  }
  runningOut.sort((a, b) => a.days_left - b.days_left || b.sold30 - a.sold30);

  // stock that is not selling: money standing still
  const lastSale = new Map(all(`SELECT i.product_id AS pid, MAX(s.created_at) AS at FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'done' AND i.qty > 0${locSql('s.location_id', loc)} GROUP BY 1`).map((r) => [r.pid, r.at]));
  const slow = [];
  for (const r of all(`SELECT p.*, SUM(s.qty) AS qty FROM stock s JOIN products p ON p.id = s.product_id JOIN locations l ON l.id = s.location_id
      WHERE l.active = 1 AND s.qty > 0${locSql('s.location_id', loc)} GROUP BY p.id`)) {
    const last = lastSale.get(r.id) || null;
    const since = last ? last.slice(0, 10) : r.created_at.slice(0, 10);
    const idle = daysBetween(since, today());
    if (idle < 60) continue;
    slow.push({ id: r.id, name: label(r), barcode: r.barcode, qty: r.qty, cost_value: round2(r.qty * r.cost_price), last_sold: last, idle_days: idle });
  }
  slow.sort((a, b) => b.cost_value - a.cost_value);

  // on the way: parcels between places, and purchase orders not yet arrived
  const parcels = all(`SELECT d.id, d.dispatch_no, d.created_at, d.total_qty, d.total_value, f.name AS from_name, t.name AS to_name,
      (SELECT COALESCE(SUM(qty * cost), 0) FROM dispatch_items WHERE dispatch_id = d.id) AS cost_value
    FROM dispatches d JOIN locations f ON f.id = d.from_location_id JOIN locations t ON t.id = d.to_location_id
    WHERE d.status = 'in_transit'${loc ? ` AND (d.from_location_id = ${Number(loc)} OR d.to_location_id = ${Number(loc)})` : ''} ORDER BY d.created_at`)
    .map((r) => ({ ...r, cost_value: round2(r.cost_value), days: daysBetween(r.created_at.slice(0, 10), today()) }));
  const orders = can(user, 'buy') ? all(`SELECT pu.id, pu.purchase_no, pu.created_at, pu.expected_date, pu.total, pu.total_qty, su.name AS supplier_name, l.name AS location_name
    FROM purchases pu LEFT JOIN suppliers su ON su.id = pu.supplier_id LEFT JOIN locations l ON l.id = pu.location_id
    WHERE pu.status = 'ordered'${locSql('pu.location_id', loc)} ORDER BY COALESCE(pu.expected_date, pu.date)`)
    .map((r) => ({ ...r, late: !!r.expected_date && r.expected_date < today() })) : [];

  const sum = (rows, k) => round2(rows.reduce((a, r) => a + (r[k] || 0), 0));
  return {
    location_id: loc,
    totals: { pieces: sum(places, 'pieces'), cost_value: sum(places, 'cost_value'), sale_value: sum(places, 'sale_value'), slow_value: sum(slow, 'cost_value'),
      on_the_way: round2(sum(parcels, 'cost_value') + sum(orders, 'total')), below_zero: sum(places, 'below_zero') },
    places, running_out: runningOut.slice(0, 60), slow: slow.slice(0, 60), slow_count: slow.length, parcels, orders,
  };
});

// ---------- Suppliers: what was bought, paid and is still owed (and since when) ----------
route('GET', '/api/reports/suppliers', 'buy', ({ query, user }) => {
  needPerm(user, 'see_cost', 'Seeing what suppliers are owed');
  const { from, to, loc } = scope(query, user);
  const t = today();
  const rows = [];
  for (const s of all('SELECT * FROM suppliers ORDER BY name')) {
    const purchases = all(`SELECT date, total, paid, total_qty FROM purchases WHERE supplier_id = ? AND status = 'done'${locSql('location_id', loc)} ORDER BY date, created_at`, s.id);
    const payments = all('SELECT date, amount FROM supplier_payments WHERE supplier_id = ? ORDER BY date', s.id);
    const orders = get(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS value FROM purchases WHERE supplier_id = ? AND status = 'ordered'${locSql('location_id', loc)}`, s.id);
    // later payments pay the oldest bills first: what is left unpaid, and how old it is
    let credit = payments.reduce((a, p) => a + p.amount, 0);
    const aging = { under30: 0, d30_60: 0, over60: 0 };
    let oldest = null;
    for (const p of purchases) {
      let due = p.total - p.paid;
      if (due <= 0) continue;
      const use = Math.min(credit, due); credit -= use; due -= use;
      if (due <= 0.004) continue;
      oldest = oldest || p.date;
      const age = daysBetween(p.date, t);
      aging[age > 60 ? 'over60' : age > 30 ? 'd30_60' : 'under30'] += due;
    }
    const inRange = purchases.filter((p) => p.date >= from && p.date <= to);
    const bought = inRange.reduce((a, p) => a + p.total, 0);
    const paidAtPurchase = inRange.reduce((a, p) => a + p.paid, 0);
    const paidLater = loc ? 0 : payments.filter((p) => p.date >= from && p.date <= to).reduce((a, p) => a + p.amount, 0);
    const owed = aging.under30 + aging.d30_60 + aging.over60;
    const allTime = purchases.reduce((a, p) => a + p.total, 0);
    if (!allTime && !orders.n && !payments.length) continue;
    rows.push({
      id: s.id, name: s.name, phone: s.phone,
      bought: round2(bought), pieces: inRange.reduce((a, p) => a + p.total_qty, 0), purchases: inRange.length,
      paid: round2(paidAtPurchase + paidLater), owed: round2(owed), oldest_unpaid: oldest, oldest_days: oldest ? daysBetween(oldest, t) : 0,
      under30: round2(aging.under30), d30_60: round2(aging.d30_60), over60: round2(aging.over60),
      overpaid: round2(Math.max(0, credit)), orders: orders.n, orders_value: round2(orders.value),
      last_purchase: purchases.length ? purchases[purchases.length - 1].date : null,
    });
  }
  rows.sort((a, b) => b.owed - a.owed || b.bought - a.bought);
  const sum = (k) => round2(rows.reduce((a, r) => a + r[k], 0));
  return { from, to, location_id: loc, suppliers: rows, totals: { bought: sum('bought'), paid: sum('paid'), owed: sum('owed'), over60: sum('over60'), d30_60: sum('d30_60'), under30: sum('under30'), orders_value: sum('orders_value') } };
});

// ---------- Staff: who sold what, discounts, returns, cancelled bills, and other work ----------
route('GET', '/api/reports/staff', 'reports', ({ query, user }) => {
  const { from, to, loc } = scope(query, user);
  const seeCost = can(user, 'see_cost');
  const p = [from + ' 00:00:00', to + ' 23:59:59'];
  const people = new Map();
  const person = (id, name) => {
    if (!people.has(id)) people.set(id, { id, name: name || 'Unknown', bills: 0, sales: 0, items: 0, discount: 0, discount_bills: 0, returns: 0, returned_items: 0, profit: 0,
      cancelled: 0, cancelled_value: 0, purchases: 0, sent: 0, received: 0, corrections: 0, expenses: 0 });
    return people.get(id);
  };
  for (const r of all(`SELECT s.user_id AS id, u.name, COUNT(*) AS bills, SUM(s.total) AS sales, SUM(s.discount) AS discount, SUM(CASE WHEN s.discount > 0 THEN 1 ELSE 0 END) AS discount_bills
      FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.status = 'done' AND s.created_at BETWEEN ? AND ?${locSql('s.location_id', loc)} GROUP BY 1`, ...p)) {
    Object.assign(person(r.id, r.name), { bills: r.bills, sales: round2(r.sales), discount: round2(r.discount), discount_bills: r.discount_bills });
  }
  for (const r of all(`SELECT s.user_id AS id, u.name, SUM(CASE WHEN i.qty > 0 THEN i.qty ELSE 0 END) AS items, SUM(CASE WHEN i.qty < 0 THEN -i.qty * i.price ELSE 0 END) AS returns,
      SUM(CASE WHEN i.qty < 0 THEN -i.qty ELSE 0 END) AS returned_items, SUM(i.qty * (i.price - COALESCE(i.cost, 0))) AS profit,
      SUM(CASE WHEN i.qty > 0 AND i.list_price IS NOT NULL THEN i.qty * (i.list_price - i.price) ELSE 0 END) AS line_disc
      FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'done' AND s.created_at BETWEEN ? AND ?${locSql('s.location_id', loc)} GROUP BY 1`, ...p)) {
    const pp = person(r.id, r.name);
    Object.assign(pp, { items: r.items, returns: round2(r.returns), returned_items: r.returned_items, profit: round2(r.profit), discount: round2(pp.discount + r.line_disc) });
  }
  for (const r of all(`SELECT s.user_id AS id, u.name, COUNT(*) AS n, SUM(s.total) AS v FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.status = 'void' AND s.created_at BETWEEN ? AND ?${locSql('s.location_id', loc)} GROUP BY 1`, ...p)) {
    Object.assign(person(r.id, r.name), { cancelled: r.n, cancelled_value: round2(r.v) });
  }
  const count = (sql, key) => { for (const r of all(sql, ...p)) person(r.id, r.name)[key] = r.n; };
  count(`SELECT x.user_id AS id, u.name, COUNT(*) AS n FROM purchases x LEFT JOIN users u ON u.id = x.user_id WHERE x.status <> 'void' AND x.created_at BETWEEN ? AND ?${locSql('x.location_id', loc)} GROUP BY 1`, 'purchases');
  count(`SELECT x.created_by AS id, u.name, COUNT(*) AS n FROM dispatches x LEFT JOIN users u ON u.id = x.created_by WHERE x.created_at BETWEEN ? AND ?${locSql('x.from_location_id', loc)} GROUP BY 1`, 'sent');
  count(`SELECT x.received_by AS id, u.name, COUNT(*) AS n FROM dispatches x LEFT JOIN users u ON u.id = x.received_by WHERE x.status = 'received' AND x.received_at BETWEEN ? AND ?${locSql('x.to_location_id', loc)} GROUP BY 1`, 'received');
  count(`SELECT x.user_id AS id, u.name, COUNT(*) AS n FROM movements x LEFT JOIN users u ON u.id = x.user_id WHERE x.type = 'adjust' AND x.created_at BETWEEN ? AND ?${locSql('x.location_id', loc)} GROUP BY 1`, 'corrections');
  count(`SELECT x.user_id AS id, u.name, COUNT(*) AS n FROM expenses x LEFT JOIN users u ON u.id = x.user_id WHERE x.created_at BETWEEN ? AND ?${locSql('x.location_id', loc)} GROUP BY 1`, 'expenses');
  const rows = [...people.values()].filter((r) => r.id != null).map((r) => ({ ...r, avg_bill: r.bills ? round2(r.sales / r.bills) : 0, ...(seeCost ? {} : { profit: undefined }) }));
  rows.sort((a, b) => b.sales - a.sales || b.bills - a.bills);
  return { from, to, location_id: loc, people: rows };
});

// ---------- Things to check ----------
route('GET', '/api/reports/unusual', 'reports', ({ query, user }) => {
  needPerm(user, 'see_cost', 'Seeing these checks');
  const { from, to, loc } = scope(query, user);
  const items = unusual({ from, to, location_id: loc });
  return { from, to, location_id: loc, items, high: items.filter((i) => i.level === 'high').length };
});
