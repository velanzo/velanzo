// Things that look unusual. Nothing here stops a save:
// - before saving, the screen asks /api/check/<kind> and shows the warnings with "Go back" or "Continue anyway";
// - afterwards the owner's "Things to check" report finds the same kinds of things in what was saved (unusual()).
import * as D from './db.js';
import { route, toInt, toMoney, str, isDate, can, canSeeCost, userLocation, lineDiscount } from './util.js';
import { label } from './routes/inventory.js';

const { all, get, today } = D;

const setting = (k, d) => { const n = Number(D.getSettings()[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const LIMITS = () => ({
  discount: setting('warn_discount', 20), // % of the bill
  expense: setting('warn_expense', 50000), // one expense
  pieces: 500, // of one item in one purchase or parcel
  billPieces: 50, // of one item on one bill
  costJump: 50, // % up or down from the last purchase
  adjust: 10, // pieces changed by one stock correction
});
const money = (n) => `${D.getSettings().currency || 'Rs'} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const q = (p) => `“${label(p)}”`;
const pct = (a, b) => Math.round((Math.abs(a - b) / b) * 100);
const product = (id) => get('SELECT * FROM products WHERE id = ?', toInt(id));
// the cost of the last real purchase of an item (or its price list cost)
function lastCost(p) {
  const r = get(`SELECT pi.cost FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id
    WHERE pi.product_id = ? AND pu.status IN ('done', 'ordered') AND pi.cost > 0 ORDER BY pu.created_at DESC LIMIT 1`, p.id);
  return r ? r.cost : p.cost_price;
}
function priceWarnings(p, sale, cost, seeCost, out) {
  if (!(sale > 0)) out.push(`${q(p)} has no selling price (${money(0)}). Bills would sell it for nothing.`);
  else if (cost > 0 && sale < cost) out.push(seeCost ? `${q(p)} sells for ${money(sale)}, below its cost ${money(cost)}.` : `${q(p)} sells below its cost price.`);
}
function costWarnings(p, cost, out) {
  if (!(cost > 0)) { out.push(`${q(p)} costs ${money(0)}. Is the cost missing?`); return; }
  const last = lastCost(p);
  if (last > 0 && pct(cost, last) >= LIMITS().costJump) out.push(`${q(p)} costs ${money(cost)} now, ${money(last)} last time (${cost > last ? 'up' : 'down'} ${pct(cost, last)}%).`);
}

// ---------- Before saving ----------
const CHECKS = {
  sale(body, user) {
    const out = [], L = LIMITS();
    const loc = userLocation(user, body.location_id);
    const seeCost = canSeeCost(user);
    const lines = (Array.isArray(body.items) ? body.items : []).map((it) => {
      const p = product(it.product_id);
      if (!p) return null;
      const list = can(user, 'change_price') && it.price !== undefined && it.price !== '' ? toMoney(it.price) : p.sale_price;
      const qty = toInt(it.qty);
      const off = qty > 0 ? lineDiscount(it.disc, list) : 0;
      return { p, qty, price: Math.round((list - off) * 100) / 100, list, off };
    }).filter(Boolean);
    const qtyOf = new Map();
    for (const l of lines) qtyOf.set(l.p.id, (qtyOf.get(l.p.id) || 0) + l.qty);
    for (const l of lines) {
      if (l.qty <= 0) continue;
      if (!(l.price > 0)) out.push(`${q(l.p)} is sold for ${money(0)}.`);
      else if (l.p.cost_price > 0 && l.price < l.p.cost_price) out.push(seeCost ? `${q(l.p)} is sold for ${money(l.price)}, below its cost ${money(l.p.cost_price)}.` : `${q(l.p)} is sold below its cost price.`);
      if (l.qty >= L.billPieces) out.push(`${l.qty} pieces of ${q(l.p)} on one bill. Is the quantity right?`);
    }
    if (loc) {
      for (const [pid, n] of qtyOf) {
        if (n <= 0) continue;
        const have = D.stockQty(pid, loc);
        if (n > have) out.push(`Only ${Math.max(have, 0)} of ${q(product(pid))} in stock here, but ${n} on this bill.`);
      }
    }
    const subtotal = lines.reduce((a, l) => a + l.qty * l.price, 0);
    const discount = Math.max(0, toMoney(body.discount));
    const warned = out.length;
    for (const l of lines) {
      if (l.off > 0 && l.list > 0 && (l.off / l.list) * 100 > L.discount) out.push(`${q(l.p)} has ${Math.round((l.off / l.list) * 100)}% off (${money(l.off)} on ${money(l.list)}).`);
    }
    if (discount > 0 && subtotal > 0 && (discount / subtotal) * 100 > L.discount) out.push(`The discount ${money(discount)} is ${Math.round((discount / subtotal) * 100)}% of the bill.`);
    // item discounts and the bill discount together
    const full = lines.reduce((a, l) => a + (l.qty > 0 ? l.qty * l.list : 0), 0);
    const allOff = lines.reduce((a, l) => a + l.qty * (l.list - l.price), 0) + discount;
    if (out.length === warned && full > 0 && (allOff / full) * 100 > L.discount) out.push(`In all, ${money(allOff)} is taken off ${money(full)} (${Math.round((allOff / full) * 100)}%).`);
    if (lines.some((l) => l.qty > 0) && subtotal - discount <= 0) out.push(`The bill total is ${money(Math.max(0, subtotal - discount))}.`);
    return out;
  },

  purchase(body) {
    const out = [], L = LIMITS();
    const items = (Array.isArray(body.items) ? body.items : []).map((it) => ({ p: product(it.product_id), qty: toInt(it.qty), cost: toMoney(it.cost), sale: it.sale_price === undefined || it.sale_price === '' || it.sale_price === null ? null : toMoney(it.sale_price) })).filter((i) => i.p);
    for (const i of items) {
      costWarnings(i.p, i.cost, out);
      priceWarnings(i.p, i.sale ?? i.p.sale_price, i.cost, true, out);
      if (i.qty >= L.pieces) out.push(`${i.qty} pieces of ${q(i.p)}. Is the quantity right?`);
    }
    const total = items.reduce((a, i) => a + i.qty * i.cost, 0);
    if (items.length && total <= 0) out.push(`This ${body.order ? 'order' : 'purchase'} totals ${money(0)}.`);
    const paid = toMoney(body.paid);
    if (!body.order && paid > total + 0.001) out.push(`Paid ${money(paid)} is more than the total ${money(total)}.`);
    const inv = str(body.invoice_no, 60), sup = toInt(body.supplier_id);
    if (inv && sup) {
      const dup = get("SELECT purchase_no FROM purchases WHERE supplier_id = ? AND invoice_no = ? COLLATE NOCASE AND status <> 'void' LIMIT 1", sup, inv);
      if (dup) out.push(`Invoice ${inv} from this supplier was already entered (${dup.purchase_no}).`);
    }
    if (body.order && isDate(body.expected_date) && body.expected_date < today()) out.push('The expected date is in the past.');
    if (!body.order && isDate(body.date) && body.date > today()) out.push('The purchase date is in the future.');
    return out;
  },

  receive(body) {
    const out = [], L = LIMITS();
    const pu = get('SELECT * FROM purchases WHERE id = ?', toInt(body.id));
    if (!pu) return out;
    const counted = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [toInt(i.id), i]));
    let total = 0;
    for (const l of all('SELECT * FROM purchase_items WHERE purchase_id = ?', pu.id)) {
      const p = product(l.product_id);
      if (!p) continue;
      const c = counted.get(l.id) || {};
      const qty = c.qty !== undefined && c.qty !== '' ? toInt(c.qty) : l.qty;
      const cost = c.cost !== undefined && c.cost !== '' ? toMoney(c.cost) : l.cost;
      total += qty * cost;
      if (qty <= 0) continue;
      const ordered = l.ordered_qty ?? l.qty;
      if (qty > ordered) out.push(`${qty} of ${q(p)} arrived, but ${ordered} were ordered.`);
      if (qty >= L.pieces) out.push(`${qty} pieces of ${q(p)}. Is the quantity right?`);
      if (!(cost > 0)) out.push(`${q(p)} costs ${money(0)}. Is the cost missing?`);
      priceWarnings(p, l.planned_price ?? p.sale_price, cost, true, out);
    }
    const paid = toMoney(body.paid);
    if (paid > total + 0.001) out.push(`Paid ${money(paid)} is more than the total ${money(total)}.`);
    return out;
  },

  product(body, user) {
    const out = [];
    const seeCost = canSeeCost(user);
    const old = body.id ? product(body.id) : null;
    const sale = toMoney(body.sale_price ?? old?.sale_price);
    const cost = seeCost ? toMoney(body.cost_price ?? old?.cost_price) : (old?.cost_price || 0);
    const name = str(body.name ?? old?.name, 120) || 'This item';
    const it = { name, size: '', color: '' };
    if (!(sale > 0)) out.push(`The selling price of “${name}” is ${money(0)}. Bills would sell it for nothing.`);
    else if (cost > 0 && sale < cost) out.push(seeCost ? `Selling price ${money(sale)} is below the cost ${money(cost)}.` : 'The selling price is below the cost price.');
    if (seeCost && !old && !(cost > 0)) out.push('The cost price is empty, so profit reports will be wrong for this item.');
    if (old && old.sale_price > 0 && sale > 0 && pct(sale, old.sale_price) >= 50) out.push(`The selling price changes from ${money(old.sale_price)} to ${money(sale)}.`);
    if (!old) {
      const variants = Array.isArray(body.variants) && body.variants.length ? body.variants : [{}];
      const pieces = variants.reduce((a, v) => a + toInt(v.opening_qty), 0);
      if (pieces >= LIMITS().pieces) out.push(`${pieces} pieces of opening stock for “${it.name}”. Is that right?`);
    }
    return out;
  },

  adjust(body, user) {
    const out = [];
    const loc = userLocation(user, body.location_id);
    const p = product(body.product_id);
    if (!loc || !p) return out;
    const current = D.stockQty(p.id, loc);
    const n = toInt(body.qty, NaN);
    if (!Number.isFinite(n)) return out;
    const diff = body.mode === 'set' ? n - current : n;
    const after = current + diff;
    if (after < 0) out.push(`Stock of ${q(p)} would become ${after}.`);
    if (Math.abs(diff) >= LIMITS().adjust || (current >= 4 && Math.abs(diff) > current / 2)) out.push(`This changes stock of ${q(p)} by ${diff > 0 ? '+' : ''}${diff} (from ${current} to ${after}).`);
    return out;
  },

  expense(body, user) {
    const out = [];
    const amount = toMoney(body.amount);
    if (amount >= LIMITS().expense) out.push(`${money(amount)} is a big expense. Is the amount right?`);
    if (isDate(body.date) && body.date > today()) out.push('The date is in the future.');
    const loc = userLocation(user, body.location_id);
    const same = get('SELECT 1 FROM expenses WHERE date = ? AND category = ? COLLATE NOCASE AND amount = ? AND IFNULL(location_id, 0) = ? LIMIT 1',
      isDate(body.date) ? body.date : today(), str(body.category, 60) || 'Other', amount, loc || 0);
    if (same && amount > 0) out.push(`The same expense (${str(body.category, 60) || 'Other'}, ${money(amount)}) is already recorded for that day.`);
    return out;
  },

  payment(body) {
    const out = [];
    const s = get('SELECT * FROM suppliers WHERE id = ?', toInt(body.supplier_id));
    if (!s) return out;
    const owed = get(`SELECT (SELECT COALESCE(SUM(total - paid), 0) FROM purchases WHERE supplier_id = ? AND status = 'done')
      - (SELECT COALESCE(SUM(amount), 0) FROM supplier_payments WHERE supplier_id = ?) AS due`, s.id, s.id).due;
    const amount = toMoney(body.amount);
    if (amount > owed + 0.001) out.push(owed > 0 ? `You owe ${s.name} only ${money(owed)}, but this pays ${money(amount)}.` : `You owe ${s.name} nothing at the moment.`);
    if (isDate(body.date) && body.date > today()) out.push('The date is in the future.');
    return out;
  },

  dispatch(body) {
    const out = [];
    const merged = new Map();
    for (const it of Array.isArray(body.items) ? body.items : []) merged.set(toInt(it.product_id), (merged.get(toInt(it.product_id)) || 0) + toInt(it.qty));
    for (const [pid, n] of merged) {
      const p = product(pid);
      if (!p || n <= 0) continue;
      if (!(p.sale_price > 0)) out.push(`${q(p)} has no selling price (${money(0)}). The shop would sell it for nothing.`);
      if (n >= LIMITS().pieces) out.push(`${n} pieces of ${q(p)}. Is the quantity right?`);
    }
    return out;
  },

};

route('POST', '/api/check/:kind', 'any', ({ params, body, user }) => {
  const fn = CHECKS[params.kind];
  return { warnings: fn ? [...new Set(fn(body || {}, user))] : [] };
});

// ---------- After saving: what the owner should look at ----------
// level: 'high' (money lost or stock wrong) or 'check' (worth a look). Dates are "YYYY-MM-DD".
export function unusual({ from, to, location_id }) {
  const L = LIMITS();
  const f = `${from} 00:00:00`, t = `${to} 23:59:59`;
  const loc = toInt(location_id) || null;
  const out = [];
  const add = (level, kind, title, detail, row = {}) => out.push({ level, kind, title, detail, user: row.user_name || '', place: row.location_name || '', at: row.at || '', link: row.link || '' });
  const inLoc = (col) => (loc ? ` AND ${col} = ${loc}` : '');

  // bills: sold for nothing or below cost, big discounts, cancelled
  for (const r of all(`SELECT s.id, s.bill_no, s.created_at AS at, u.name AS user_name, l.name AS location_name, p.name, p.size, p.color, si.qty, si.price, si.cost
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
      LEFT JOIN users u ON u.id = s.user_id LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.status = 'done' AND si.qty > 0 AND (si.price <= 0 OR (si.cost > 0 AND si.price < si.cost)) AND s.created_at BETWEEN ? AND ?${inLoc('s.location_id')}
      ORDER BY s.created_at DESC LIMIT 300`, f, t)) {
    add('high', 'Sold at a loss', `Bill ${r.bill_no}: ${r.qty} × ${label(r)} for ${money(r.price)}`, `Cost ${money(r.cost)} each, so ${money((r.cost - r.price) * r.qty)} lost.`, { ...r, link: `bill:${r.id}` });
  }
  for (const r of all(`SELECT s.id, s.bill_no, s.subtotal, s.discount, s.created_at AS at, u.name AS user_name, l.name AS location_name FROM sales s
      LEFT JOIN users u ON u.id = s.user_id LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.status = 'done' AND s.discount > 0 AND s.subtotal > 0 AND s.discount * 100.0 / s.subtotal > ? AND s.created_at BETWEEN ? AND ?${inLoc('s.location_id')}
      ORDER BY s.created_at DESC LIMIT 200`, L.discount, f, t)) {
    add('check', 'Big discount', `Bill ${r.bill_no}: ${money(r.discount)} off ${money(r.subtotal)}`, `${Math.round((r.discount / r.subtotal) * 100)}% discount.`, { ...r, link: `bill:${r.id}` });
  }
  for (const r of all(`SELECT s.id, s.bill_no, p.name, p.size, p.color, si.qty, si.price, si.list_price, s.created_at AS at, u.name AS user_name, l.name AS location_name
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
      LEFT JOIN users u ON u.id = s.user_id LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.status = 'done' AND si.qty > 0 AND si.list_price > 0 AND (si.list_price - si.price) * 100.0 / si.list_price > ? AND s.created_at BETWEEN ? AND ?${inLoc('s.location_id')}
      ORDER BY s.created_at DESC LIMIT 200`, L.discount, f, t)) {
    add('check', 'Big item discount', `Bill ${r.bill_no}: ${label(r)} ${money(r.list_price)} → ${money(r.price)}`, `${Math.round(((r.list_price - r.price) / r.list_price) * 100)}% off.`, { ...r, link: `bill:${r.id}` });
  }
  // a voucher with a limit that was used more often than allowed (two shops used it before they synced)
  for (const r of all(`SELECT v.code, v.max_uses, COUNT(*) AS n, MAX(s.created_at) AS at FROM vouchers v JOIN sales s ON s.voucher_code = v.code
      WHERE s.status = 'done' GROUP BY v.code, v.max_uses HAVING COUNT(*) > v.max_uses ORDER BY at DESC LIMIT 100`)) {
    add('high', 'Voucher used too often', `Voucher ${r.code} was used ${r.n} times`, `It allows ${r.max_uses}. Two shops probably used it before their computers synced.`, { ...r, link: 'vouchers' });
  }
  for (const r of all(`SELECT s.id, s.bill_no, s.total, s.void_reason, s.voided_at AS at, u.name AS user_name, l.name AS location_name FROM sales s
      LEFT JOIN users u ON u.id = s.voided_by LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.status = 'void' AND s.voided_at BETWEEN ? AND ?${inLoc('s.location_id')} ORDER BY s.voided_at DESC LIMIT 200`, f, t)) {
    add('check', 'Bill cancelled', `Bill ${r.bill_no} (${money(r.total)}) was cancelled`, r.void_reason ? `Reason: ${r.void_reason}` : 'No reason given.', { ...r, link: `bill:${r.id}` });
  }

  // purchases: missing cost, cost jumps, overpaid
  const purchases = all(`SELECT pu.*, pu.created_at AS at, u.name AS user_name, l.name AS location_name, su.name AS supplier_name FROM purchases pu
      LEFT JOIN users u ON u.id = pu.user_id LEFT JOIN locations l ON l.id = pu.location_id LEFT JOIN suppliers su ON su.id = pu.supplier_id
      WHERE pu.status IN ('done', 'ordered') AND pu.created_at BETWEEN ? AND ?${inLoc('pu.location_id')} ORDER BY pu.created_at DESC LIMIT 300`, f, t);
  for (const pu of purchases) {
    const what = `${pu.status === 'ordered' ? 'Order' : 'Purchase'} ${pu.purchase_no}${pu.supplier_name ? ' from ' + pu.supplier_name : ''}`;
    const row = { ...pu, link: `purchases/${pu.id}` };
    if (pu.total_qty > 0 && pu.total <= 0) add('high', 'Purchase at Rs 0', `${what} totals ${money(0)}`, 'The costs are missing, so profit will look too high.', row);
    if (pu.status === 'done' && pu.paid > pu.total + 0.001) add('check', 'Paid too much', `${what}: paid ${money(pu.paid)} for ${money(pu.total)}`, `${money(pu.paid - pu.total)} more than the bill.`, row);
    for (const l of all(`SELECT pi.*, p.name, p.size, p.color, (SELECT pi2.cost FROM purchase_items pi2 JOIN purchases p2 ON p2.id = pi2.purchase_id
        WHERE pi2.product_id = pi.product_id AND p2.status IN ('done', 'ordered') AND p2.created_at < ? AND pi2.cost > 0 ORDER BY p2.created_at DESC LIMIT 1) AS last_cost
        FROM purchase_items pi JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ?`, pu.created_at, pu.id)) {
      if (!(l.cost > 0) && pu.total > 0) add('high', 'Cost missing', `${what}: ${label(l)} at ${money(0)}`, 'Profit for this item will look too high.', row);
      else if (l.last_cost > 0 && l.cost > 0 && pct(l.cost, l.last_cost) >= L.costJump) add('check', 'Cost changed a lot', `${what}: ${label(l)} at ${money(l.cost)}`, `Last time ${money(l.last_cost)} (${l.cost > l.last_cost ? 'up' : 'down'} ${pct(l.cost, l.last_cost)}%).`, row);
    }
  }

  // stock: big corrections, parcels that arrived short or over
  for (const r of all(`SELECT m.*, m.created_at AS at, p.name, p.size, p.color, u.name AS user_name, l.name AS location_name FROM movements m
      JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id LEFT JOIN locations l ON l.id = m.location_id
      WHERE m.type = 'adjust' AND ABS(m.qty) >= ? AND m.created_at BETWEEN ? AND ?${inLoc('m.location_id')} ORDER BY m.created_at DESC LIMIT 200`, L.adjust, f, t)) {
    add(r.qty < 0 ? 'high' : 'check', 'Big stock correction', `${label(r)}: ${r.qty > 0 ? '+' : ''}${r.qty} pieces`, r.note || 'Stock correction', { ...r, link: 'stock' });
  }
  for (const r of all(`SELECT d.id, d.dispatch_no, d.received_at AS at, u.name AS user_name, l.name AS location_name, p.name, p.size, p.color, di.qty, di.received_qty
      FROM dispatch_items di JOIN dispatches d ON d.id = di.dispatch_id JOIN products p ON p.id = di.product_id
      LEFT JOIN users u ON u.id = d.received_by LEFT JOIN locations l ON l.id = d.to_location_id
      WHERE d.status = 'received' AND di.received_qty IS NOT NULL AND di.received_qty <> di.qty AND d.received_at BETWEEN ? AND ?${inLoc('d.to_location_id')}
      ORDER BY d.received_at DESC LIMIT 200`, f, t)) {
    add(r.received_qty < r.qty ? 'high' : 'check', r.received_qty < r.qty ? 'Parcel arrived short' : 'Parcel had extra', `${r.dispatch_no}: ${label(r)}`, `${r.qty} sent, ${r.received_qty} counted.`, { ...r, link: `dispatch/${r.id}` });
  }

  // money out: big expenses
  for (const r of all(`SELECT e.*, e.created_at AS at, u.name AS user_name, l.name AS location_name FROM expenses e
      LEFT JOIN users u ON u.id = e.user_id LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.amount >= ? AND e.created_at BETWEEN ? AND ?${inLoc('e.location_id')} ORDER BY e.created_at DESC LIMIT 100`, L.expense, f, t)) {
    add('check', 'Big expense', `${r.category}: ${money(r.amount)}`, r.note || '', { ...r, link: 'expenses' });
  }

  // right now (whatever the dates): items without a proper price, stock below zero
  for (const p of all("SELECT * FROM products WHERE active = 1 AND (sale_price <= 0 OR (cost_price > 0 AND sale_price < cost_price)) ORDER BY name LIMIT 200")) {
    add('high', 'Price problem', `${label(p)} sells for ${money(p.sale_price)}`, p.sale_price <= 0 ? 'No selling price: set one in Stock.' : `Below its cost ${money(p.cost_price)}.`, { link: `products/${p.id}` });
  }
  for (const r of all(`SELECT s.qty, p.id, p.name, p.size, p.color, l.name AS location_name FROM stock s JOIN products p ON p.id = s.product_id JOIN locations l ON l.id = s.location_id
      WHERE s.qty < 0${inLoc('s.location_id')} ORDER BY p.name LIMIT 200`)) {
    add('high', 'Stock below zero', `${label(r)}: ${r.qty} at ${r.location_name}`, 'More was sold or sent than was there. Count it and correct the stock.', { ...r, link: `products/${r.id}` });
  }
  return out;
}
