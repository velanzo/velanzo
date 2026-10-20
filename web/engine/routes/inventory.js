// Products, stock, suppliers, purchases and dispatches (warehouse → shop, or between any places).
import * as D from '../db.js';
import { route, fail, toInt, toMoney, str, need, isDate, userLocation, canSeeCost } from '../util.js';

const { all, get, run, tx, now, today, round2 } = D;

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL'];
export function sizeRank(s) {
  const u = String(s || '').toUpperCase().trim();
  const i = SIZE_ORDER.indexOf(u);
  if (i >= 0) return i;
  const n = parseFloat(u);
  return Number.isFinite(n) ? 100 + n : 10000;
}
export function sortProducts(rows) {
  return rows.sort((a, b) =>
    a.name.localeCompare(b.name) ||
    String(a.color || '').localeCompare(String(b.color || '')) ||
    sizeRank(a.size) - sizeRank(b.size) ||
    String(a.size || '').localeCompare(String(b.size || '')));
}
// Every word typed must match the name, barcode, category, colour or size.
function searchWhere(q, where, params) {
  for (const w of str(q, 100).split(/\s+/).filter(Boolean)) {
    where.push('(p.name LIKE ? OR p.barcode LIKE ? OR p.category LIKE ? OR p.color LIKE ? OR p.size = ? COLLATE NOCASE)');
    const like = `%${w}%`;
    params.push(like, like, like, like, w);
  }
}
const hideCost = (user, rows) => {
  if (!canSeeCost(user)) for (const r of rows) delete r.cost_price;
  return rows;
};
export const label = (p) => p.name + ([p.size, p.color].filter(Boolean).length ? ` (${[p.size, p.color].filter(Boolean).join(', ')})` : '');

export function defaultWarehouseId() {
  const w = get("SELECT id FROM locations WHERE type = 'warehouse' AND active = 1 ORDER BY id LIMIT 1");
  return w ? w.id : fail(400, 'Add a warehouse first (Settings → Shops & Warehouse)');
}
function location(id) {
  return get('SELECT * FROM locations WHERE id = ?', id) || fail(400, 'Unknown shop/warehouse');
}

// ---------- Products ----------
route('GET', '/api/products', 'any', ({ query, user }) => {
  const where = [], params = [];
  if (query.active !== 'all') where.push('p.active = 1');
  if (query.category) { where.push('p.category = ?'); params.push(query.category); }
  searchWhere(query.q, where, params);
  const limit = query.all ? 200000 : Math.min(toInt(query.limit, 1000), 5000);
  const rows = all(
    `SELECT p.*,
       COALESCE((SELECT SUM(qty) FROM stock s WHERE s.product_id = p.id), 0) AS stock_total,
       COALESCE((SELECT qty FROM stock s WHERE s.product_id = p.id AND s.location_id = ?), 0) AS loc_qty
     FROM products p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.name LIMIT ?`,
    toInt(query.location_id, 0), ...params, limit
  );
  return hideCost(user, sortProducts(rows));
});

route('GET', '/api/products/lookup', 'any', ({ query, user }) => {
  const code = need(str(query.code, 80), 'Barcode');
  const p = get(
    `SELECT p.*, COALESCE((SELECT qty FROM stock s WHERE s.product_id = p.id AND s.location_id = ?), 0) AS loc_qty
     FROM products p WHERE p.barcode = ?`, toInt(query.location_id, 0), code);
  if (!p) fail(404, `No item with barcode ${code}`);
  return hideCost(user, [p])[0];
});

route('GET', '/api/product-meta', 'any', () => ({
  categories: all("SELECT DISTINCT category AS v FROM products WHERE category <> '' ORDER BY category").map((r) => r.v),
  sizes: all("SELECT DISTINCT size AS v FROM products WHERE size <> ''").map((r) => r.v).sort((a, b) => sizeRank(a) - sizeRank(b)),
  colors: all("SELECT DISTINCT color AS v FROM products WHERE color <> '' ORDER BY color").map((r) => r.v),
}));

route('GET', '/api/products/:id', 'any', ({ params, user }) => {
  const id = toInt(params.id);
  const p = get('SELECT * FROM products WHERE id = ?', id) || fail(404, 'Item not found');
  const stock = all(
    `SELECT l.id AS location_id, l.name, l.type, COALESCE(s.qty, 0) AS qty
     FROM locations l LEFT JOIN stock s ON s.location_id = l.id AND s.product_id = ?
     WHERE l.active = 1 OR s.qty <> 0 ORDER BY l.type DESC, l.id`, id);
  const movements = all(
    `SELECT m.*, l.name AS location_name, u.name AS user_name,
       CASE m.ref_type
         WHEN 'sale' THEN (SELECT bill_no FROM sales WHERE id = m.ref_id)
         WHEN 'purchase' THEN (SELECT purchase_no FROM purchases WHERE id = m.ref_id)
         WHEN 'dispatch' THEN (SELECT dispatch_no FROM dispatches WHERE id = m.ref_id)
       END AS ref_no
     FROM movements m JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.user_id
     WHERE m.product_id = ? ${user.owner ? '' : 'AND m.location_id = ' + Number(user.location_id)} ORDER BY m.created_at DESC, m.id DESC LIMIT 500`, id);
  const sold = get(
    `SELECT COALESCE(SUM(i.qty), 0) AS qty FROM sale_items i JOIN sales s ON s.id = i.sale_id
     WHERE i.product_id = ? AND s.status = 'done'`, id).qty;
  return { product: hideCost(user, [p])[0], stock, movements, sold };
});

route('POST', '/api/products', ['add_items', 'buy'], ({ body, user }) => tx(() => {
  const name = need(str(body.name, 120), 'Item name');
  const category = str(body.category, 60);
  const cost = canSeeCost(user) ? toMoney(body.cost_price) : 0;
  const price = toMoney(body.sale_price);
  const variants = Array.isArray(body.variants) && body.variants.length ? body.variants : [{}];
  if (variants.length > 300) fail(400, 'Too many sizes × colours at once (max 300)');
  const openingLoc = userLocation(user, body.opening_location_id) || defaultWarehouseId();
  const created = [];
  for (const v of variants) {
    const size = str(v.size, 30), color = str(v.color, 40);
    const dup = get("SELECT * FROM products WHERE name = ? COLLATE NOCASE AND IFNULL(size, '') = ? COLLATE NOCASE AND IFNULL(color, '') = ? COLLATE NOCASE", name, size, color);
    if (dup) fail(409, `"${label(dup)}" already exists (barcode ${dup.barcode}). Search for it instead of adding it again.`);
    let barcode = str(v.barcode, 60);
    if (barcode && get('SELECT 1 FROM products WHERE barcode = ?', barcode)) fail(409, `Barcode ${barcode} is already used by another item`);
    if (!barcode) barcode = D.newBarcode();
    const id = D.newId();
    run(
      'INSERT INTO products(id, barcode, name, category, size, color, cost_price, sale_price, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, barcode, name, category, size, color, cost, price, now());
    const opening = toInt(v.opening_qty, 0);
    if (opening) D.moveStock(id, openingLoc, opening, 'opening', null, null, user.id, 'Opening stock');
    created.push(get('SELECT * FROM products WHERE id = ?', id));
  }
  return hideCost(user, created);
}));

route('PUT', '/api/products/:id', 'add_items', ({ params, body, user }) => {
  const id = toInt(params.id);
  const p = get('SELECT * FROM products WHERE id = ?', id) || fail(404, 'Item not found');
  const f = {
    name: need(str(body.name ?? p.name, 120), 'Item name'),
    category: str(body.category ?? p.category, 60),
    size: str(body.size ?? p.size, 30),
    color: str(body.color ?? p.color, 40),
    barcode: need(str(body.barcode ?? p.barcode, 60), 'Barcode'),
    cost: canSeeCost(user) ? toMoney(body.cost_price ?? p.cost_price) : p.cost_price,
    price: toMoney(body.sale_price ?? p.sale_price),
    active: body.active === undefined ? p.active : (body.active ? 1 : 0),
  };
  run('UPDATE products SET name = ?, category = ?, size = ?, color = ?, barcode = ?, cost_price = ?, sale_price = ?, active = ?, updated_at = ? WHERE id = ?',
    f.name, f.category, f.size, f.color, f.barcode, f.cost, f.price, f.active, now(), id);
  return hideCost(user, [get('SELECT * FROM products WHERE id = ?', id)])[0];
});

// ---------- Stock ----------
route('GET', '/api/stock', 'any', ({ query, user }) => {
  let locs = all('SELECT id, name, code, type FROM locations WHERE active = 1 ORDER BY type DESC, id');
  if (toInt(query.location_id)) locs = locs.filter((l) => l.id === toInt(query.location_id));
  const locIds = new Set(locs.map((l) => l.id));
  const where = ['1 = 1'], params = [];
  if (query.category) { where.push('p.category = ?'); params.push(query.category); }
  searchWhere(query.q, where, params);
  const products = all(`SELECT p.id, p.barcode, p.name, p.category, p.size, p.color, p.cost_price, p.sale_price, p.active FROM products p WHERE ${where.join(' AND ')}`, ...params);
  const byProduct = new Map();
  const everStocked = new Set();
  for (const s of all('SELECT location_id, product_id, qty FROM stock')) {
    if (!locIds.has(s.location_id)) continue;
    everStocked.add(s.product_id);
    if (!s.qty) continue;
    let m = byProduct.get(s.product_id);
    if (!m) byProduct.set(s.product_id, (m = {}));
    m[s.location_id] = s.qty;
  }
  const low = toInt(D.getSettings().low_stock, 2);
  let rows = products.map((p) => {
    const qty = byProduct.get(p.id) || {};
    return { ...p, qty, total: Object.values(qty).reduce((a, b) => a + b, 0) };
  });
  if (query.low === '1') rows = rows.filter((r) => r.active && everStocked.has(r.id) && r.total <= low);
  else if (query.zero !== '1') rows = rows.filter((r) => r.total !== 0);
  sortProducts(rows);
  const totals = { units: 0, cost_value: 0, sale_value: 0, by_location: {} };
  for (const r of rows) {
    totals.units += r.total;
    totals.cost_value += r.total * r.cost_price;
    totals.sale_value += r.total * r.sale_price;
    for (const [l, q] of Object.entries(r.qty)) totals.by_location[l] = (totals.by_location[l] || 0) + q;
  }
  totals.cost_value = round2(totals.cost_value);
  totals.sale_value = round2(totals.sale_value);
  if (!canSeeCost(user)) delete totals.cost_value;
  return { locations: locs, rows: hideCost(user, rows), totals, low_threshold: low };
});

route('POST', '/api/stock/adjust', 'correct_stock', ({ body, user }) => tx(() => {
  const loc = userLocation(user, body.location_id) || fail(400, 'Choose a location');
  location(loc);
  const pid = toInt(body.product_id);
  get('SELECT id FROM products WHERE id = ?', pid) || fail(404, 'Item not found');
  const current = D.stockQty(pid, loc);
  const n = toInt(body.qty, NaN);
  if (!Number.isFinite(n)) fail(400, 'Enter a quantity');
  const diff = body.mode === 'set' ? n - current : n;
  const reason = str(body.reason, 200) || 'Stock correction';
  D.moveStock(pid, loc, diff, 'adjust', null, null, user.id, reason);
  return { qty: current + diff, change: diff };
}));

route('GET', '/api/movements', 'any', ({ query, user }) => {
  const where = ['1 = 1'], params = [];
  if (!user.owner) { where.push('m.location_id = ?'); params.push(user.location_id); }
  if (toInt(query.product_id)) { where.push('m.product_id = ?'); params.push(toInt(query.product_id)); }
  if (toInt(query.location_id)) { where.push('m.location_id = ?'); params.push(toInt(query.location_id)); }
  if (query.type) { where.push('m.type = ?'); params.push(query.type); }
  if (isDate(query.from)) { where.push('m.created_at >= ?'); params.push(query.from + ' 00:00:00'); }
  if (isDate(query.to)) { where.push('m.created_at <= ?'); params.push(query.to + ' 23:59:59'); }
  return all(
    `SELECT m.*, p.name, p.size, p.color, p.barcode, l.name AS location_name, u.name AS user_name
     FROM movements m JOIN products p ON p.id = m.product_id JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.user_id
     WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT 1000`, ...params);
});

// ---------- Suppliers ----------
const SUPPLIER_TOTALS = `
  COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id = s.id AND status = 'done'), 0) AS purchased,
  COALESCE((SELECT SUM(paid) FROM purchases WHERE supplier_id = s.id AND status = 'done'), 0)
    + COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id = s.id), 0) AS paid`;

function withDue(user, rows) {
  for (const r of rows) {
    r.purchased = round2(r.purchased); r.paid = round2(r.paid); r.due = round2(r.purchased - r.paid);
    if (!canSeeCost(user)) { delete r.paid; delete r.due; }
  }
  return rows;
}

route('GET', '/api/suppliers', 'buy', ({ user }) =>
  withDue(user, all(`SELECT s.*, ${SUPPLIER_TOTALS} FROM suppliers s ORDER BY s.name`)));

route('GET', '/api/suppliers/:id', 'buy', ({ params, user }) => {
  const id = toInt(params.id);
  const s = get(`SELECT s.*, ${SUPPLIER_TOTALS} FROM suppliers s WHERE s.id = ?`, id) || fail(404, 'Supplier not found');
  return {
    supplier: withDue(user, [s])[0],
    purchases: all('SELECT * FROM purchases WHERE supplier_id = ? ORDER BY id DESC', id),
    payments: canSeeCost(user) ? all('SELECT sp.*, u.name AS user_name FROM supplier_payments sp LEFT JOIN users u ON u.id = sp.user_id WHERE supplier_id = ? ORDER BY date DESC, id DESC', id) : [],
  };
});

route('POST', '/api/suppliers', 'buy', ({ body }) => {
  const id = D.newId();
  run('INSERT INTO suppliers(id, name, phone, address, notes, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    id, need(str(body.name, 100), 'Supplier name'), str(body.phone, 40), str(body.address, 200), str(body.notes, 500), now());
  return get('SELECT * FROM suppliers WHERE id = ?', id);
});

route('PUT', '/api/suppliers/:id', 'buy', ({ params, body }) => {
  const id = toInt(params.id);
  const s = get('SELECT * FROM suppliers WHERE id = ?', id) || fail(404, 'Supplier not found');
  run('UPDATE suppliers SET name = ?, phone = ?, address = ?, notes = ? WHERE id = ?',
    need(str(body.name ?? s.name, 100), 'Supplier name'), str(body.phone ?? s.phone, 40), str(body.address ?? s.address, 200), str(body.notes ?? s.notes, 500), id);
  return get('SELECT * FROM suppliers WHERE id = ?', id);
});

route('POST', '/api/suppliers/:id/payments', 'buy', ({ params, body, user }) => {
  const id = toInt(params.id);
  get('SELECT id FROM suppliers WHERE id = ?', id) || fail(404, 'Supplier not found');
  const amount = toMoney(body.amount);
  if (amount <= 0) fail(400, 'Enter the amount paid');
  run('INSERT INTO supplier_payments(id, supplier_id, date, amount, method, note, user_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    D.newId(), id, isDate(body.date) ? body.date : today(), amount, str(body.method, 30) || 'cash', str(body.note, 200), user.id, now());
});

// ---------- Purchases (stock coming in from suppliers) ----------
route('GET', '/api/purchases', 'buy', ({ query, user }) => {
  const where = ['1 = 1'], params = [];
  if (!user.owner) { where.push('p.location_id = ?'); params.push(user.location_id); }
  if (isDate(query.from)) { where.push('p.date >= ?'); params.push(query.from); }
  if (isDate(query.to)) { where.push('p.date <= ?'); params.push(query.to); }
  if (['ordered', 'done', 'void'].includes(query.status)) { where.push('p.status = ?'); params.push(query.status); }
  if (toInt(query.supplier_id)) { where.push('p.supplier_id = ?'); params.push(toInt(query.supplier_id)); }
  if (query.q) { where.push('(p.purchase_no LIKE ? OR p.invoice_no LIKE ? OR s.name LIKE ?)'); const l = `%${str(query.q, 60)}%`; params.push(l, l, l); }
  return all(
    `SELECT p.*, s.name AS supplier_name, l.name AS location_name, u.name AS user_name
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id JOIN locations l ON l.id = p.location_id LEFT JOIN users u ON u.id = p.user_id
     WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 500`, ...params);
});

route('GET', '/api/purchases/:id', 'buy', ({ params, user }) => {
  const id = toInt(params.id);
  const p = get(
    `SELECT p.*, s.name AS supplier_name, s.phone AS supplier_phone, l.name AS location_name, u.name AS user_name
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id JOIN locations l ON l.id = p.location_id LEFT JOIN users u ON u.id = p.user_id
     WHERE p.id = ?`, id) || fail(404, 'Purchase not found');
  if (!user.owner && p.location_id !== user.location_id) fail(403, 'This purchase is from another place');
  p.items = all(
    `SELECT i.*, pr.name, pr.size, pr.color, pr.barcode, pr.category, pr.sale_price
     FROM purchase_items i JOIN products pr ON pr.id = i.product_id WHERE i.purchase_id = ? ORDER BY i.id`, id);
  return p;
});

route('POST', '/api/purchases', 'buy', ({ body, user }) => tx(() => {
  const loc = userLocation(user, body.location_id) || defaultWarehouseId();
  location(loc);
  const supplierId = toInt(body.supplier_id) || null;
  if (supplierId) get('SELECT id FROM suppliers WHERE id = ?', supplierId) || fail(400, 'Unknown supplier');
  const items = (Array.isArray(body.items) ? body.items : []).map((it) => {
    const p = get('SELECT * FROM products WHERE id = ?', toInt(it.product_id)) || fail(400, 'An item in the list no longer exists');
    const qty = toInt(it.qty);
    if (qty <= 0) fail(400, `Enter a quantity for ${label(p)}`);
    if (qty > 100000) fail(400, `Quantity ${qty} for ${label(p)} looks wrong`);
    const cost = toMoney(it.cost);
    if (cost < 0) fail(400, `Cost cannot be negative (${label(p)})`);
    return { p, qty, cost, sale: it.sale_price === undefined || it.sale_price === '' ? null : toMoney(it.sale_price) };
  });
  if (!items.length) fail(400, 'Add at least one item');
  const total = round2(items.reduce((a, i) => a + i.qty * i.cost, 0));
  const qty = items.reduce((a, i) => a + i.qty, 0);
  const order = !!body.order; // a purchase order: nothing is in stock until the goods arrive (see /receive)
  const paid = order ? 0 : Math.max(0, toMoney(body.paid));
  const no = D.deviceNo('P-', 'purchase');
  const id = D.newId();
  run(
    "INSERT INTO purchases(id, purchase_no, supplier_id, location_id, invoice_no, date, total, paid, total_qty, notes, status, expected_date, user_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, no, supplierId, loc, str(body.invoice_no, 60), isDate(body.date) ? body.date : today(), total, paid, qty, str(body.notes, 500),
    order ? 'ordered' : 'done', order && isDate(body.expected_date) ? body.expected_date : null, user.id, now());
  if (order) {
    for (const i of items) run('INSERT INTO purchase_items(id, purchase_id, product_id, qty, cost, ordered_qty, planned_price) VALUES(?, ?, ?, ?, ?, ?, ?)', D.newId(), id, i.p.id, i.qty, i.cost, i.qty, i.sale);
    return { id, purchase_no: no };
  }
  for (const i of items) {
    run('INSERT INTO purchase_items(id, purchase_id, product_id, qty, cost) VALUES(?, ?, ?, ?, ?)', D.newId(), id, i.p.id, i.qty, i.cost);
    D.moveStock(i.p.id, loc, i.qty, 'purchase', 'purchase', id, user.id, null);
    run('UPDATE products SET cost_price = ?, sale_price = COALESCE(?, sale_price), active = 1, updated_at = ? WHERE id = ?', i.cost, i.sale, now(), i.p.id);
  }
  return { id, purchase_no: no };
}));

// The goods of a purchase order arrived: count them, and only now the pieces are added to stock.
route('POST', '/api/purchases/:id/receive', 'buy', ({ params, body, user }) => tx(() => {
  const id = toInt(params.id);
  const p = get('SELECT * FROM purchases WHERE id = ?', id) || fail(404, 'Purchase order not found');
  if (!user.owner && p.location_id !== user.location_id) fail(403, 'This order is for another place');
  if (p.status === 'done') fail(400, 'This order was already received');
  if (p.status !== 'ordered') fail(400, 'This order was cancelled');
  const counted = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [toInt(i.id), i]));
  let total = 0, got = 0;
  for (const l of all('SELECT * FROM purchase_items WHERE purchase_id = ?', id)) {
    const c = counted.get(l.id);
    const qty = c && c.qty !== undefined && c.qty !== '' ? toInt(c.qty) : l.qty;
    if (qty < 0) fail(400, 'A quantity cannot be negative');
    if (qty > 100000) fail(400, `Quantity ${qty} looks wrong`);
    const cost = c && c.cost !== undefined && c.cost !== '' ? toMoney(c.cost) : l.cost;
    if (cost < 0) fail(400, 'Cost cannot be negative');
    run('UPDATE purchase_items SET qty = ?, cost = ?, ordered_qty = COALESCE(ordered_qty, ?) WHERE id = ?', qty, cost, l.qty, l.id);
    if (qty > 0) {
      D.moveStock(l.product_id, p.location_id, qty, 'purchase', 'purchase', id, user.id, qty !== (l.ordered_qty ?? l.qty) ? `Received ${qty} (ordered ${l.ordered_qty ?? l.qty})` : null);
      run('UPDATE products SET cost_price = ?, sale_price = COALESCE(?, sale_price), active = 1, updated_at = ? WHERE id = ?', cost, l.planned_price, now(), l.product_id);
    }
    total += qty * cost; got += qty;
  }
  if (!got) fail(400, 'Nothing arrived, so there is nothing to add. If the order will not come, cancel it instead.');
  const paid = Math.max(0, toMoney(body.paid));
  run("UPDATE purchases SET status = 'done', total = ?, total_qty = ?, paid = ?, invoice_no = COALESCE(NULLIF(?, ''), invoice_no), date = ?, received_at = ?, notes = COALESCE(NULLIF(?, ''), notes) WHERE id = ?",
    round2(total), got, paid, str(body.invoice_no, 60), isDate(body.date) ? body.date : today(), now(), str(body.notes, 500), id);
  return { id, received_qty: got };
}));

// Cancel an order that has not arrived. Nothing was in stock, so nothing changes in stock.
route('POST', '/api/purchases/:id/cancel-order', 'buy', ({ params, body, user }) => tx(() => {
  const id = toInt(params.id);
  const p = get('SELECT * FROM purchases WHERE id = ?', id) || fail(404, 'Purchase order not found');
  if (!user.owner && p.location_id !== user.location_id) fail(403, 'This order is for another place');
  if (p.status !== 'ordered') fail(400, 'Only an order that has not arrived can be cancelled this way');
  run("UPDATE purchases SET status = 'void', notes = TRIM(IFNULL(notes, '') || ' [Order cancelled: ' || ? || ']') WHERE id = ?", str(body.reason, 200), id);
}));

route('POST', '/api/purchases/:id/void', 'owner', ({ params, body, user }) => tx(() => {
  const id = toInt(params.id);
  const p = get('SELECT * FROM purchases WHERE id = ?', id) || fail(404, 'Purchase not found');
  if (p.status !== 'done') fail(400, 'This purchase is already cancelled');
  for (const i of all('SELECT * FROM purchase_items WHERE purchase_id = ?', id)) {
    D.moveStock(i.product_id, p.location_id, -i.qty, 'void', 'purchase', id, user.id, 'Purchase cancelled: ' + str(body.reason, 200));
  }
  run("UPDATE purchases SET status = 'void', notes = TRIM(IFNULL(notes, '') || ' [Cancelled: ' || ? || ']') WHERE id = ?", str(body.reason, 200), id);
}));

// ---------- Dispatches (warehouse → shop, or shop → warehouse) ----------
function canSeeDispatch(user, d) {
  return user.owner || d.from_location_id === user.location_id || d.to_location_id === user.location_id;
}

route('GET', '/api/dispatches', 'any', ({ query, user }) => {
  const where = ['1 = 1'], params = [];
  if (query.status) { where.push('d.status = ?'); params.push(query.status); }
  if (!user.owner) { where.push('(d.from_location_id = ? OR d.to_location_id = ?)'); params.push(user.location_id, user.location_id); }
  if (query.direction === 'incoming' && !user.owner) { where.push('d.to_location_id = ?'); params.push(user.location_id); }
  if (query.direction === 'outgoing' && !user.owner) { where.push('d.from_location_id = ?'); params.push(user.location_id); }
  if (toInt(query.location_id)) { where.push('(d.from_location_id = ? OR d.to_location_id = ?)'); params.push(toInt(query.location_id), toInt(query.location_id)); }
  if (query.q) { where.push('d.dispatch_no LIKE ?'); params.push(`%${str(query.q, 40)}%`); }
  return all(
    `SELECT d.*, f.name AS from_name, t.name AS to_name, u.name AS created_by_name, r.name AS received_by_name
     FROM dispatches d JOIN locations f ON f.id = d.from_location_id JOIN locations t ON t.id = d.to_location_id
     LEFT JOIN users u ON u.id = d.created_by LEFT JOIN users r ON r.id = d.received_by
     WHERE ${where.join(' AND ')} ORDER BY d.status = 'in_transit' DESC, d.id DESC LIMIT 500`, ...params);
});

route('GET', '/api/dispatches/:id', 'any', ({ params, user }) => {
  const id = toInt(params.id);
  const d = get(
    `SELECT d.*, f.name AS from_name, t.name AS to_name, u.name AS created_by_name, r.name AS received_by_name
     FROM dispatches d JOIN locations f ON f.id = d.from_location_id JOIN locations t ON t.id = d.to_location_id
     LEFT JOIN users u ON u.id = d.created_by LEFT JOIN users r ON r.id = d.received_by WHERE d.id = ?`, id) || fail(404, 'Dispatch not found');
  if (!canSeeDispatch(user, d)) fail(403, 'This dispatch is not for your shop');
  d.items = all(
    `SELECT i.*, p.name, p.size, p.color, p.barcode, p.category FROM dispatch_items i JOIN products p ON p.id = i.product_id
     WHERE i.dispatch_id = ? ORDER BY p.name, p.color, i.id`, id);
  if (!canSeeCost(user)) for (const i of d.items) delete i.cost;
  return d;
});

route('POST', '/api/dispatches', 'send', ({ body, user }) => tx(() => {
  const from = userLocation(user, body.from_location_id) || defaultWarehouseId();
  const to = toInt(body.to_location_id);
  location(from);
  const toLoc = location(to);
  if (!toLoc.active) fail(400, `${toLoc.name} is switched off`);
  if (from === to) fail(400, 'Choose a different destination');
  // combine repeated scans of the same item into one line
  const merged = new Map();
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const pid = toInt(it.product_id), qty = toInt(it.qty);
    if (qty <= 0) continue;
    if (qty > 100000) fail(400, `Quantity ${qty} looks wrong`);
    merged.set(pid, (merged.get(pid) || 0) + qty);
  }
  if (!merged.size) fail(400, 'Add at least one item');
  const lines = [];
  const shortages = [];
  for (const [pid, qty] of merged) {
    const p = get('SELECT * FROM products WHERE id = ?', pid) || fail(400, 'An item in the list no longer exists');
    const have = D.stockQty(pid, from);
    if (qty > have) shortages.push({ name: label(p), barcode: p.barcode, want: qty, have });
    lines.push({ p, qty });
  }
  if (shortages.length && !body.force) fail(409, 'Not enough stock for some items', { shortages });
  const no = D.deviceNo('D-', 'dispatch');
  const totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const totalValue = round2(lines.reduce((a, l) => a + l.qty * l.p.sale_price, 0));
  const id = D.newId();
  run(
    'INSERT INTO dispatches(id, dispatch_no, from_location_id, to_location_id, total_qty, total_value, notes, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, no, from, to, totalQty, totalValue, str(body.notes, 500), user.id, now());
  for (const l of lines) {
    run('INSERT INTO dispatch_items(id, dispatch_id, product_id, qty, price, cost) VALUES(?, ?, ?, ?, ?, ?)', D.newId(), id, l.p.id, l.qty, l.p.sale_price, l.p.cost_price);
    D.moveStock(l.p.id, from, -l.qty, 'dispatch_out', 'dispatch', id, user.id, `Sent to ${toLoc.name}`);
  }
  return { id, dispatch_no: no };
}));

route('POST', '/api/dispatches/:id/receive', 'receive', ({ params, body, user }) => tx(() => {
  const id = toInt(params.id);
  const d = get('SELECT * FROM dispatches WHERE id = ?', id) || fail(404, 'Dispatch not found');
  if (!user.owner && user.location_id !== d.to_location_id) fail(403, 'Only the receiving place can receive this dispatch');
  if (d.status !== 'in_transit') fail(400, 'This dispatch was already ' + (d.status === 'received' ? 'received' : 'cancelled'));
  const counted = new Map((Array.isArray(body.items) ? body.items : []).map((i) => [toInt(i.id), Math.max(0, toInt(i.received_qty))]));
  const fromLoc = location(d.from_location_id);
  let total = 0;
  for (const i of all('SELECT * FROM dispatch_items WHERE dispatch_id = ?', id)) {
    const rq = counted.has(i.id) ? counted.get(i.id) : i.qty;
    run('UPDATE dispatch_items SET received_qty = ? WHERE id = ?', rq, i.id);
    D.moveStock(i.product_id, d.to_location_id, rq, 'dispatch_in', 'dispatch', id, user.id, `Received from ${fromLoc.name}` + (rq !== i.qty ? ` (sent ${i.qty})` : ''));
    total += rq;
  }
  run("UPDATE dispatches SET status = 'received', received_qty = ?, received_by = ?, received_at = ? WHERE id = ?", total, user.id, now(), id);
  return { received_qty: total, sent_qty: d.total_qty };
}));

route('POST', '/api/dispatches/:id/cancel', 'send', ({ params, user }) => tx(() => {
  const id = toInt(params.id);
  const d = get('SELECT * FROM dispatches WHERE id = ?', id) || fail(404, 'Dispatch not found');
  if (!user.owner && user.location_id !== d.from_location_id) fail(403, 'Only the sender can cancel this dispatch');
  if (d.status !== 'in_transit') fail(400, 'Only dispatches that are still on the way can be cancelled');
  for (const i of all('SELECT * FROM dispatch_items WHERE dispatch_id = ?', id)) {
    D.moveStock(i.product_id, d.from_location_id, i.qty, 'void', 'dispatch', id, user.id, 'Dispatch cancelled');
  }
  run("UPDATE dispatches SET status = 'cancelled' WHERE id = ?", id);
}));

