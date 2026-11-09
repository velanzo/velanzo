// Customers: who bought on credit, what they still owe, and the payments they bring later.
// A bill's open balance = its total − what was paid at the counter − the customer payments made against it.
import * as D from '../db.js';
import { route, fail, toInt, toMoney, str, need, can } from '../util.js';

const { all, get, run, tx, now, today, round2 } = D;

const METHODS = ['cash', 'card', 'online'];
// what is still owed on bill s (never below 0: a bill paid in full, or a return, owes nothing)
export const OPEN_SQL = `MAX(0, ROUND(s.total - (s.paid - s.change_due) - COALESCE((SELECT SUM(cp.amount) FROM customer_payments cp WHERE cp.sale_id = s.id), 0), 2))`;
// a shop computer sees its own shop's bills; the owner sees every shop
const placeSql = (user, alias = 's') => (user.owner ? ['', []] : [` AND ${alias}.location_id = ?`, [user.location_id]]);
const mayUse = (user) => { if (!(can(user, 'sell') || user.owner)) fail(403, 'Customers are for people who sell'); };

function customerFields(body) {
  return {
    name: need(str(body.name, 80), 'Customer name'),
    phone: str(body.phone, 40),
    address: str(body.address, 200),
    notes: str(body.notes, 300),
  };
}

// Open bills of a customer (oldest first): what a payment is set against.
function openBills(user, customerId, saleId) {
  const [w, p] = placeSql(user);
  return all(
    `SELECT s.id, s.bill_no, s.location_id, s.total, s.created_at, ${OPEN_SQL} AS open FROM sales s
     WHERE s.customer_id = ? AND s.status = 'done'${saleId ? ' AND s.id = ?' : ''}${w} ORDER BY s.created_at, s.id`,
    customerId, ...(saleId ? [saleId] : []), ...p).filter((b) => b.open > 0);
}

route('GET', '/api/customers', 'any', ({ query, user }) => {
  mayUse(user);
  const [w, p] = placeSql(user);
  const where = [], params = [];
  if (query.q) { where.push('(c.name LIKE ? OR c.phone LIKE ?)'); const l = `%${str(query.q, 60)}%`; params.push(l, l); }
  const rows = all(
    `SELECT c.*, COALESCE(SUM(b.open), 0) AS owed, COUNT(CASE WHEN b.open > 0 THEN 1 END) AS open_bills, MAX(b.created_at) AS last_bill
     FROM customers c LEFT JOIN (SELECT s.customer_id, s.created_at, ${OPEN_SQL} AS open FROM sales s WHERE s.status = 'done' AND s.customer_id IS NOT NULL${w}) b
       ON b.customer_id = c.id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY c.id ORDER BY owed DESC, c.name COLLATE NOCASE LIMIT 2000`, ...p, ...params);
  for (const r of rows) r.owed = round2(r.owed);
  return rows;
});

route('GET', '/api/customers/:id', 'any', ({ params, user }) => {
  mayUse(user);
  const id = toInt(params.id);
  const c = get('SELECT * FROM customers WHERE id = ?', id) || fail(404, 'Customer not found');
  const [w, p] = placeSql(user);
  c.bills = all(
    `SELECT s.id, s.bill_no, s.created_at, s.total, s.paid - s.change_due AS paid_now, s.status, l.name AS location_name,
       COALESCE((SELECT SUM(cp.amount) FROM customer_payments cp WHERE cp.sale_id = s.id), 0) AS paid_later, ${OPEN_SQL} AS open
     FROM sales s JOIN locations l ON l.id = s.location_id WHERE s.customer_id = ?${w} ORDER BY s.created_at DESC, s.id DESC LIMIT 500`, id, ...p);
  const [wp, pp] = placeSql(user, 'cp');
  c.payments = all(
    `SELECT cp.*, s.bill_no, u.name AS user_name FROM customer_payments cp LEFT JOIN sales s ON s.id = cp.sale_id LEFT JOIN users u ON u.id = cp.user_id
     WHERE cp.customer_id = ?${wp} ORDER BY cp.created_at DESC, cp.id DESC LIMIT 500`, id, ...pp);
  c.owed = round2(c.bills.filter((b) => b.status === 'done').reduce((a, b) => a + b.open, 0));
  return c;
});

route('POST', '/api/customers', 'sell', ({ body }) => {
  const f = customerFields(body);
  if (f.phone) {
    const dup = get('SELECT name FROM customers WHERE phone = ?', f.phone);
    if (dup) fail(409, `${dup.name} already has the phone number ${f.phone}. Choose that customer instead.`);
  }
  const id = D.newId();
  run('INSERT INTO customers(id, name, phone, address, notes, created_at) VALUES(?, ?, ?, ?, ?, ?)', id, f.name, f.phone, f.address, f.notes, now());
  return get('SELECT * FROM customers WHERE id = ?', id);
});

route('PUT', '/api/customers/:id', 'sell', ({ params, body }) => {
  const id = toInt(params.id);
  const c = get('SELECT * FROM customers WHERE id = ?', id) || fail(404, 'Customer not found');
  const f = customerFields({ ...c, ...body });
  if (f.phone && get('SELECT 1 AS x FROM customers WHERE phone = ? AND id <> ?', f.phone, id)) fail(409, `Another customer already has the phone number ${f.phone}.`);
  run('UPDATE customers SET name = ?, phone = ?, address = ?, notes = ? WHERE id = ?', f.name, f.phone, f.address, f.notes, id);
  return get('SELECT * FROM customers WHERE id = ?', id);
});

// Money a customer brings: set against one bill (sale_id), or against the oldest open bills first.
route('POST', '/api/customers/:id/payments', 'sell', ({ params, body, user }) => tx(() => {
  const id = toInt(params.id);
  const c = get('SELECT * FROM customers WHERE id = ?', id) || fail(404, 'Customer not found');
  const amount = toMoney(body.amount);
  if (amount <= 0) fail(400, 'Enter the amount received');
  const bills = openBills(user, id, toInt(body.sale_id) || null);
  const owed = round2(bills.reduce((a, b) => a + b.open, 0));
  if (!owed) fail(400, `${c.name} owes nothing${body.sale_id ? ' on this bill' : ''}.`);
  if (amount > owed + 0.004) fail(400, `That is more than ${c.name} owes${body.sale_id ? ' on this bill' : ''} (${D.getSettings().currency} ${owed}).`);
  const method = METHODS.includes(body.method) ? body.method : 'cash';
  let left = amount;
  const made = [];
  for (const b of bills) {
    if (left <= 0) break;
    const part = round2(Math.min(left, b.open));
    run('INSERT INTO customer_payments(id, customer_id, sale_id, location_id, date, amount, method, note, user_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      D.newId(), id, b.id, b.location_id, today(), part, method, str(body.note, 200), user.id, now());
    made.push({ bill_no: b.bill_no, amount: part });
    left = round2(left - part);
  }
  return { paid: made, owed: round2(owed - amount) };
}));
