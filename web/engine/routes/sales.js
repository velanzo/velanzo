// Sales (bills), expenses, dashboard and reports ("tracker and accounts").
import * as D from '../db.js';
import { route, fail, toInt, toMoney, str, isDate, userLocation, can, canSeeCost, needPerm } from '../util.js';
import { label } from './inventory.js';

const { all, get, run, tx, now, today, pad, round2 } = D;

const METHODS = ['cash', 'card', 'online'];

function saleDetail(id) {
  const s = get(
    `SELECT s.*, l.name AS location_name, l.code AS location_code, l.address AS location_address, l.phone AS location_phone,
       u.name AS user_name, v.name AS voided_by_name
     FROM sales s JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.user_id LEFT JOIN users v ON v.id = s.voided_by
     WHERE s.id = ?`, id) || fail(404, 'Bill not found');
  s.items = all(
    `SELECT i.*, p.name, p.size, p.color, p.barcode FROM sale_items i JOIN products p ON p.id = i.product_id
     WHERE i.sale_id = ? ORDER BY i.id`, id);
  return s;
}
const hideSaleCost = (user, s) => { if (!canSeeCost(user)) for (const i of s.items) delete i.cost; return s; };

route('GET', '/api/sales', 'any', ({ query, user }) => {
  const where = ['1 = 1'], params = [];
  const loc = user.owner ? toInt(query.location_id) : user.location_id;
  if (loc) { where.push('s.location_id = ?'); params.push(loc); }
  if (query.q) {
    where.push('(s.bill_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)');
    const l = `%${str(query.q, 60)}%`; params.push(l, l, l);
  } else {
    if (isDate(query.from)) { where.push('s.created_at >= ?'); params.push(query.from + ' 00:00:00'); }
    if (isDate(query.to)) { where.push('s.created_at <= ?'); params.push(query.to + ' 23:59:59'); }
  }
  if (query.status) { where.push('s.status = ?'); params.push(query.status); }
  return all(
    `SELECT s.*, l.name AS location_name, u.name AS user_name
     FROM sales s JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT 2000`, ...params);
});

route('GET', '/api/sales/by-bill/:no', 'any', ({ params, user }) => {
  const s = get('SELECT id, location_id FROM sales WHERE bill_no = ?', str(params.no, 40)) || fail(404, 'Bill not found');
  if (!user.owner && s.location_id !== user.location_id) fail(403, 'This bill is from another shop');
  return hideSaleCost(user, saleDetail(s.id));
});

route('GET', '/api/sales/:id', 'any', ({ params, user }) => {
  const s = saleDetail(toInt(params.id));
  if (!user.owner && s.location_id !== user.location_id) fail(403, 'This bill is from another shop');
  return hideSaleCost(user, s);
});

route('POST', '/api/sales', 'sell', ({ body, user }) => tx(() => {
  const locId = userLocation(user, body.location_id) || fail(400, 'Choose which shop this sale is for');
  const loc = get('SELECT * FROM locations WHERE id = ?', locId) || fail(400, 'Unknown shop');
  const canChangePrice = can(user, 'change_price');
  const lines = (Array.isArray(body.items) ? body.items : []).map((it) => {
    const p = get('SELECT * FROM products WHERE id = ?', toInt(it.product_id)) || fail(400, 'An item on the bill no longer exists');
    const qty = toInt(it.qty);
    if (!qty) fail(400, `Quantity missing for ${label(p)}`);
    if (Math.abs(qty) > 10000) fail(400, `Quantity ${qty} for ${label(p)} looks wrong`);
    const price = canChangePrice && it.price !== undefined && it.price !== '' ? toMoney(it.price) : p.sale_price;
    if (price < 0) fail(400, 'Price cannot be negative');
    return { p, qty, price };
  });
  if (!lines.length) fail(400, 'The bill is empty');
  if (lines.some((l) => l.qty < 0)) needPerm(user, 'returns', 'Taking returns');
  const subtotal = round2(lines.reduce((a, l) => a + l.qty * l.price, 0));
  const discount = round2(Math.min(Math.max(0, toMoney(body.discount)), Math.max(0, subtotal)));
  if (discount > 0) needPerm(user, 'discount', 'Giving discounts');
  const total = round2(subtotal - discount);
  const method = METHODS.includes(body.payment_method) ? body.payment_method : 'cash';
  let paid = total, change = 0;
  if (method === 'cash' && total > 0 && body.paid !== undefined && body.paid !== '' && body.paid !== null) {
    paid = toMoney(body.paid);
    if (paid < total) fail(400, 'Cash received is less than the bill total');
    change = round2(paid - total);
  }
  const billNo = D.deviceNo(`${loc.code}-`, 'bill');
  const id = D.newId();
  run(
    `INSERT INTO sales(id, bill_no, location_id, customer_name, customer_phone, subtotal, discount, total, paid, change_due, payment_method, items_qty, user_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, billNo, loc.id, str(body.customer_name, 80), str(body.customer_phone, 40), subtotal, discount, total, paid, change, method,
    lines.reduce((a, l) => a + l.qty, 0), user.id, now());
  for (const l of lines) {
    run('INSERT INTO sale_items(id, sale_id, product_id, qty, price, cost) VALUES(?, ?, ?, ?, ?, ?)', D.newId(), id, l.p.id, l.qty, l.price, l.p.cost_price);
    D.moveStock(l.p.id, loc.id, -l.qty, l.qty > 0 ? 'sale' : 'return', 'sale', id, user.id, null);
  }
  return hideSaleCost(user, saleDetail(id));
}));

route('POST', '/api/sales/:id/void', 'void_bills', ({ params, body, user }) => tx(() => {
  const s = saleDetail(toInt(params.id));
  if (!user.owner && s.location_id !== user.location_id) fail(403, 'This bill is from another shop');
  if (s.status !== 'done') fail(400, 'This bill is already cancelled');
  const reason = str(body.reason, 200);
  for (const i of s.items) D.moveStock(i.product_id, s.location_id, i.qty, 'void', 'sale', s.id, user.id, 'Bill cancelled' + (reason ? ': ' + reason : ''));
  run("UPDATE sales SET status = 'void', void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ?", reason, user.id, now(), s.id);
}));

// ---------- Expenses ----------
route('GET', '/api/expenses', 'any', ({ query, user }) => {
  const where = ['1 = 1'], params = [];
  const loc = user.owner ? toInt(query.location_id) : user.location_id;
  if (loc) { where.push('e.location_id = ?'); params.push(loc); }
  if (isDate(query.from)) { where.push('e.date >= ?'); params.push(query.from); }
  if (isDate(query.to)) { where.push('e.date <= ?'); params.push(query.to); }
  return all(
    `SELECT e.*, l.name AS location_name, u.name AS user_name FROM expenses e
     LEFT JOIN locations l ON l.id = e.location_id LEFT JOIN users u ON u.id = e.user_id
     WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC LIMIT 2000`, ...params);
});

route('GET', '/api/expense-categories', 'any', () => {
  const used = all('SELECT DISTINCT category AS v FROM expenses ORDER BY category').map((r) => r.v);
  return [...new Set(['Rent', 'Salaries', 'Electricity', 'Transport', 'Packing', 'Food / Tea', 'Repairs', 'Other', ...used])];
});

route('POST', '/api/expenses', 'expenses', ({ body, user }) => {
  const loc = userLocation(user, body.location_id);
  const amount = toMoney(body.amount);
  if (amount <= 0) fail(400, 'Enter the amount');
  const category = str(body.category, 60) || 'Other';
  run('INSERT INTO expenses(id, location_id, date, category, amount, note, user_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    D.newId(), loc, isDate(body.date) ? body.date : today(), category, amount, str(body.note, 300), user.id, now());
});

route('DELETE', '/api/expenses/:id', 'owner', ({ params }) => {
  run('DELETE FROM expenses WHERE id = ?', toInt(params.id));
});

// ---------- Reports ----------
function salesWhere(from, to, locId) {
  const w = ["s.status = 'done'", 's.created_at >= ?', 's.created_at <= ?'];
  const p = [from + ' 00:00:00', to + ' 23:59:59'];
  if (locId) { w.push('s.location_id = ?'); p.push(locId); }
  return { W: w.join(' AND '), p };
}

function salesMetrics(from, to, locId) {
  const { W, p } = salesWhere(from, to, locId);
  const h = get(`SELECT COUNT(*) AS bills, COALESCE(SUM(total), 0) AS net_sales, COALESCE(SUM(discount), 0) AS discounts FROM sales s WHERE ${W}`, ...p);
  const l = get(
    `SELECT COALESCE(SUM(CASE WHEN i.qty > 0 THEN i.qty * i.price END), 0) AS gross_sales,
            COALESCE(SUM(CASE WHEN i.qty < 0 THEN -i.qty * i.price END), 0) AS returns,
            COALESCE(SUM(CASE WHEN i.qty > 0 THEN i.qty END), 0) AS items_sold,
            COALESCE(SUM(CASE WHEN i.qty < 0 THEN -i.qty END), 0) AS items_returned,
            COALESCE(SUM(i.qty * i.cost), 0) AS cogs
     FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${W}`, ...p);
  const out = { ...h, ...l, gross_profit: h.net_sales - l.cogs };
  for (const k of ['net_sales', 'discounts', 'gross_sales', 'returns', 'cogs', 'gross_profit']) out[k] = round2(out[k]);
  return out;
}

function expensesTotal(from, to, locId) {
  const w = ['date >= ?', 'date <= ?'], p = [from, to];
  if (locId) { w.push('location_id = ?'); p.push(locId); }
  return round2(get(`SELECT COALESCE(SUM(amount), 0) AS n FROM expenses WHERE ${w.join(' AND ')}`, ...p).n);
}

function monthStart() { return today().slice(0, 8) + '01'; }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return D.now(d).slice(0, 10); }

route('GET', '/api/dashboard', 'owner', () => {
  const t = today(), ms = monthStart();
  const shops = all("SELECT * FROM locations WHERE active = 1 ORDER BY type DESC, id");
  const todayByLoc = all(
    `SELECT s.location_id, COUNT(*) AS bills, COALESCE(SUM(s.total), 0) AS total FROM sales s
     WHERE s.status = 'done' AND s.created_at >= ? GROUP BY s.location_id`, t + ' 00:00:00');
  const month = salesMetrics(ms, t);
  const monthExpenses = expensesTotal(ms, t);
  const dailyRows = all(
    `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(total), 0) AS total, COUNT(*) AS bills FROM sales
     WHERE status = 'done' AND created_at >= ? GROUP BY day`, daysAgo(13) + ' 00:00:00');
  const daily = [];
  for (let i = 13; i >= 0; i--) {
    const day = daysAgo(i);
    const r = dailyRows.find((x) => x.day === day);
    daily.push({ day, total: round2(r ? r.total : 0), bills: r ? r.bills : 0 });
  }
  const stockValue = all(
    `SELECT l.id, l.name, l.type, COALESCE(SUM(s.qty), 0) AS units,
            COALESCE(SUM(s.qty * p.cost_price), 0) AS cost_value, COALESCE(SUM(s.qty * p.sale_price), 0) AS sale_value
     FROM locations l LEFT JOIN stock s ON s.location_id = l.id AND s.qty > 0 LEFT JOIN products p ON p.id = s.product_id
     WHERE l.active = 1 GROUP BY l.id ORDER BY l.type DESC, l.id`);
  const transit = get(`SELECT COUNT(*) AS n, COALESCE(SUM(total_qty), 0) AS qty, COALESCE(SUM(total_value), 0) AS value FROM dispatches WHERE status = 'in_transit'`);
  const low = toInt(D.getSettings().low_stock, 2);
  const lowCount = get(
    `SELECT COUNT(*) AS n FROM stock s JOIN locations l ON l.id = s.location_id JOIN products p ON p.id = s.product_id
     WHERE l.type = 'shop' AND l.active = 1 AND p.active = 1 AND s.qty <= ?`, low).n;
  const supplierDue = get(
    `SELECT COALESCE((SELECT SUM(total - paid) FROM purchases WHERE status = 'done' AND supplier_id IS NOT NULL), 0)
          - COALESCE((SELECT SUM(amount) FROM supplier_payments), 0) AS n`).n;
  const top = all(
    `SELECT p.id, p.name, p.size, p.color, SUM(i.qty) AS qty, SUM(i.qty * i.price) AS amount
     FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
     WHERE s.status = 'done' AND s.created_at >= ? GROUP BY p.id HAVING SUM(i.qty) > 0 ORDER BY qty DESC LIMIT 8`, ms + ' 00:00:00');
  const recent = all(
    `SELECT s.id, s.bill_no, s.created_at, s.total, s.items_qty, s.payment_method, s.status, l.name AS location_name
     FROM sales s JOIN locations l ON l.id = s.location_id ORDER BY s.id DESC LIMIT 8`);
  return {
    today: {
      total: round2(todayByLoc.reduce((a, r) => a + r.total, 0)),
      bills: todayByLoc.reduce((a, r) => a + r.bills, 0),
      by_location: shops.filter((l) => l.type === 'shop').map((l) => {
        const r = todayByLoc.find((x) => x.location_id === l.id);
        return { id: l.id, name: l.name, bills: r ? r.bills : 0, total: round2(r ? r.total : 0) };
      }),
    },
    month: { ...month, expenses: monthExpenses, net_profit: round2(month.gross_profit - monthExpenses) },
    daily,
    stock_value: stockValue.map((r) => ({ ...r, cost_value: round2(r.cost_value), sale_value: round2(r.sale_value) })),
    transit: { ...transit, value: round2(transit.value) },
    low_stock: lowCount,
    supplier_due: round2(supplierDue),
    top,
    recent,
  };
});

route('GET', '/api/reports', 'reports', ({ query, user }) => {
  needPerm(user, 'see_cost', 'Seeing profit');
  const from = isDate(query.from) ? query.from : monthStart();
  const to = isDate(query.to) ? query.to : today();
  const loc = user.owner ? toInt(query.location_id) || null : user.location_id;
  const { W, p } = salesWhere(from, to, loc);
  const summary = salesMetrics(from, to, loc);
  const expenses = expensesTotal(from, to, loc);
  summary.expenses = expenses;
  summary.net_profit = round2(summary.gross_profit - expenses);

  const pw = ["status = 'done'", 'date >= ?', 'date <= ?'], pp = [from, to];
  if (loc) { pw.push('location_id = ?'); pp.push(loc); }
  const purchases = get(`SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(total_qty), 0) AS qty, COALESCE(SUM(paid), 0) AS paid FROM purchases WHERE ${pw.join(' AND ')}`, ...pp);
  const laterPayments = loc ? 0 : get('SELECT COALESCE(SUM(amount), 0) AS n FROM supplier_payments WHERE date >= ? AND date <= ?', from, to).n;

  const byLocation = all("SELECT * FROM locations ORDER BY type DESC, id")
    .filter((l) => !loc || l.id === loc)
    .map((l) => {
      const m = salesMetrics(from, to, l.id);
      const e = expensesTotal(from, to, l.id);
      return { id: l.id, name: l.name, type: l.type, ...m, expenses: e, net_profit: round2(m.gross_profit - e) };
    })
    .filter((r) => r.bills || r.expenses);

  const byMethod = all(`SELECT payment_method AS method, COUNT(*) AS bills, COALESCE(SUM(total), 0) AS total FROM sales s WHERE ${W} GROUP BY payment_method`, ...p);
  const byCategory = all(
    `SELECT COALESCE(NULLIF(pr.category, ''), 'No category') AS category, SUM(i.qty) AS qty, SUM(i.qty * i.price) AS amount, SUM(i.qty * (i.price - i.cost)) AS profit
     FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products pr ON pr.id = i.product_id
     WHERE ${W} GROUP BY 1 ORDER BY amount DESC`, ...p);
  const topProducts = all(
    `SELECT pr.id, pr.name, pr.size, pr.color, pr.barcode, SUM(i.qty) AS qty, SUM(i.qty * i.price) AS amount, SUM(i.qty * (i.price - i.cost)) AS profit
     FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products pr ON pr.id = i.product_id
     WHERE ${W} GROUP BY pr.id ORDER BY qty DESC LIMIT 30`, ...p);
  const dailySales = all(`SELECT substr(s.created_at, 1, 10) AS day, COUNT(*) AS bills, SUM(s.total) AS total, SUM(s.discount) AS discount FROM sales s WHERE ${W} GROUP BY day`, ...p);
  const dailyCost = all(`SELECT substr(s.created_at, 1, 10) AS day, SUM(i.qty * i.cost) AS cogs, SUM(CASE WHEN i.qty > 0 THEN i.qty END) AS items FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${W} GROUP BY day`, ...p);
  const ew = ['date >= ?', 'date <= ?'], ep = [from, to];
  if (loc) { ew.push('location_id = ?'); ep.push(loc); }
  const dailyExp = all(`SELECT date AS day, SUM(amount) AS amount FROM expenses WHERE ${ew.join(' AND ')} GROUP BY date`, ...ep);
  const expByCategory = all(`SELECT category, SUM(amount) AS amount FROM expenses WHERE ${ew.join(' AND ')} GROUP BY category ORDER BY amount DESC`, ...ep);
  const days = [...new Set([...dailySales, ...dailyExp].map((r) => r.day))].sort().reverse();
  const daily = days.map((day) => {
    const s = dailySales.find((r) => r.day === day) || {};
    const c = dailyCost.find((r) => r.day === day) || {};
    const e = dailyExp.find((r) => r.day === day) || {};
    const total = round2(s.total || 0), cogs = round2(c.cogs || 0), exp = round2(e.amount || 0);
    return { day, bills: s.bills || 0, items: c.items || 0, discount: round2(s.discount || 0), total, cogs, profit: round2(total - cogs), expenses: exp, net: round2(total - cogs - exp) };
  });
  const r2 = (rows, keys) => rows.map((r) => { for (const k of keys) r[k] = round2(r[k]); return r; });
  return {
    from, to, location_id: loc,
    summary,
    purchases: { ...purchases, total: round2(purchases.total), paid_now: round2(purchases.paid), paid_later: round2(laterPayments) },
    by_location: byLocation,
    by_method: r2(byMethod, ['total']),
    by_category: r2(byCategory, ['amount', 'profit']),
    top_products: r2(topProducts, ['amount', 'profit']),
    expenses_by_category: r2(expByCategory, ['amount']),
    daily,
  };
});

export { salesMetrics, expensesTotal };
