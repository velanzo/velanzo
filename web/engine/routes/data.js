// Backups (full JSON file), restoring them, Excel/CSV export and product import.
import * as D from '../db.js';
import { route, fail, toInt, toMoney, str, isDate, userLocation } from '../util.js';
import { defaultWarehouseId } from './inventory.js';

const { all, get, run, tx, now, today } = D;

// A file for the page to save: { __file: { name, type, content } }
const file = (name, type, content) => ({ __file: { name, type, content } });

// ---------- Full backup ----------
// Same format as every earlier version: { app, schema_version, exported_at, tables }.
export function exportData() {
  const tables = {};
  for (const t of D.BACKUP_TABLES) tables[t] = all(`SELECT * FROM ${t}`);
  return { app: 'velanzo', schema_version: D.BACKUP_VERSION, exported_at: now(), tables };
}

route('GET', '/api/backup/export', 'owner', () =>
  file(`velanzo-backup-${now().replace(/[: ]/g, '-')}.json`, 'application/json', JSON.stringify(exportData())));

// Older backups (from the single-computer version) used usernames/passwords and three roles.
function upgradeBackup(data) {
  const v = Number(data.schema_version) || 1;
  const t = { ...data.tables };
  if (v < 3) {
    t.users = (t.users || []).map((u) => ({ ...u, role: u.role === 'admin' ? 'admin' : 'staff', pin_salt: null, pin_hash: null }));
  }
  return t;
}

// Replaces everything on this device with the backup. The page first empties the cloud (owner only),
// then the restored records are sent up as new changes.
export function importData(data, { capture = true } = {}) {
  if (!data || data.app !== 'velanzo' || !data.tables) fail(400, 'This file is not a Velanzo backup');
  if (Number(data.schema_version) > D.BACKUP_VERSION) fail(400, 'This backup was made by a newer version of Velanzo. Update first, then restore.');
  const tables = upgradeBackup(data);
  const users = Array.isArray(tables.users) ? tables.users : [];
  if (!users.some((u) => u.role === 'admin' && u.active)) fail(400, 'This backup has no active owner, so nobody could log in. Restore cancelled.');
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    run('UPDATE sync_ctx SET applying = 1');
    for (const t of [...D.BACKUP_TABLES].reverse()) run(`DELETE FROM ${t}`);
    run('DELETE FROM outbox');
    for (const t of D.BACKUP_TABLES) {
      const rows = tables[t];
      if (!Array.isArray(rows) || !rows.length) continue;
      // Only copy columns this version knows — lets old backups load into newer versions.
      const cols = new Set(D.tableColumns(t));
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (!keys.length) continue;
        run(`INSERT INTO ${t} (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, ...keys.map((k) => row[k]));
      }
    }
    // Keep this device's counters above the restored ids.
    const dev = D.deviceInfo().id;
    if (dev) {
      let max = 0;
      for (const t of D.SYNC_TABLES) if (t !== 'settings') max = Math.max(max, get(`SELECT COALESCE(MAX(id), 0) AS n FROM ${t} WHERE id >= ? AND id < ?`, dev * 1e9, (dev + 1) * 1e9).n);
      if (max) run("INSERT INTO counters(name, value) VALUES('id', ?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)", max - dev * 1e9);
    }
    if (capture) queueEverything();
    run('UPDATE sync_ctx SET applying = ?', capture ? 0 : 1);
  });
  const counts = {};
  for (const t of D.BACKUP_TABLES) counts[t] = get(`SELECT COUNT(*) AS n FROM ${t}`).n;
  return counts;
}

// ---------- Managing data: clear everything, or only some kinds of history, optionally for some dates ----------
// How much of each kind is stored (for the Backup & data screen).
export function dataSummary() {
  const one = (sql) => get(sql);
  return {
    sales: one('SELECT COUNT(*) AS n, MIN(substr(created_at, 1, 10)) AS first, MAX(substr(created_at, 1, 10)) AS last FROM sales'),
    purchases: one('SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM purchases'),
    dispatches: one('SELECT COUNT(*) AS n, MIN(substr(created_at, 1, 10)) AS first, MAX(substr(created_at, 1, 10)) AS last FROM dispatches'),
    expenses: one('SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM expenses'),
    movements: one('SELECT COUNT(*) AS n, MIN(substr(created_at, 1, 10)) AS first, MAX(substr(created_at, 1, 10)) AS last FROM movements'),
    products: one('SELECT COUNT(*) AS n FROM products'),
    suppliers: one('SELECT COUNT(*) AS n FROM suppliers'),
  };
}

const CLEAR_KINDS = ['sales', 'purchases', 'dispatches', 'expenses', 'history'];

// Works out what would be left after clearing: { removed: counts, data: a backup of what stays }.
// The page then restores that data everywhere, the same way as restoring a backup. Nothing is changed here.
//   what        which kinds: sales (bills), purchases (and supplier payments), dispatches (stock sent), expenses, history (stock log)
//   from / to   only things dated in this range (empty = no limit)
//   everything  start fresh: all of the above plus stock counts, items and suppliers (places, people and settings stay)
export function clearPlan({ what = [], from = '', to = '', everything = false } = {}) {
  const data = exportData();
  const t = data.tables;
  const removed = {};
  const inRange = (s) => { const d = String(s || '').slice(0, 10); return (!from || d >= from) && (!to || d <= to); };
  const drop = (table, test) => {
    const keep = [], gone = new Set();
    for (const r of t[table]) (test(r) ? gone.add(r.id) : keep.push(r));
    t[table] = keep;
    removed[table] = (removed[table] || 0) + gone.size;
    return gone;
  };
  const dropChildren = (table, col, ids) => { if (ids.size) drop(table, (r) => ids.has(r[col])); };

  if (everything) {
    for (const tb of ['sale_items', 'sales', 'purchase_items', 'purchases', 'supplier_payments', 'dispatch_items', 'dispatches', 'expenses', 'movements', 'stock', 'products', 'suppliers']) {
      removed[tb] = t[tb].length; t[tb] = [];
    }
    return { removed, data, everything: true };
  }
  for (const k of what) if (!CLEAR_KINDS.includes(k)) fail(400, 'Unknown kind of data: ' + k);
  if (from && !isDate(from)) fail(400, 'The start date is not a valid date');
  if (to && !isDate(to)) fail(400, 'The end date is not a valid date');
  if (!what.length) fail(400, 'Choose what to clear');

  if (what.includes('sales')) dropChildren('sale_items', 'sale_id', drop('sales', (r) => inRange(r.created_at)));
  if (what.includes('purchases')) {
    dropChildren('purchase_items', 'purchase_id', drop('purchases', (r) => inRange(r.date)));
    drop('supplier_payments', (r) => inRange(r.date));
  }
  // parcels still on the way are kept: their stock has left the sender and not arrived yet
  if (what.includes('dispatches')) dropChildren('dispatch_items', 'dispatch_id', drop('dispatches', (r) => r.status !== 'in_transit' && inRange(r.created_at)));
  if (what.includes('expenses')) drop('expenses', (r) => inRange(r.date));
  if (what.includes('history')) {
    drop('movements', (r) => inRange(r.created_at));
    // Stock counts stay as they are: whatever the removed history added up to is carried forward as one line.
    const sums = new Map();
    for (const m of t.movements) { const k = m.product_id + ':' + m.location_id; sums.set(k, (sums.get(k) || 0) + m.qty); }
    const stamp = now();
    let carried = 0;
    for (const s of t.stock) {
      const diff = s.qty - (sums.get(s.product_id + ':' + s.location_id) || 0);
      if (!diff) continue;
      t.movements.push({ id: D.newId(), product_id: s.product_id, location_id: s.location_id, qty: diff, type: 'opening', ref_type: null, ref_id: null,
        note: 'Balance carried forward (older history cleared)', user_id: null, created_at: stamp });
      carried++;
    }
    removed.carried_forward = carried;
  }
  return { removed, data, everything: false };
}

route('GET', '/api/data/summary', 'owner', () => dataSummary());
route('POST', '/api/data/clear-plan', 'owner', ({ body }) => {
  const plan = clearPlan({ what: Array.isArray(body.what) ? body.what : [], from: str(body.from, 10), to: str(body.to, 10), everything: !!body.everything });
  return plan;
});

// Marks every record on this device as "to send" (after a restore, or when a device joins the cloud for the first time).
export function queueEverything(tables = D.SYNC_TABLES) {
  let n = 0;
  for (const t of tables) {
    const key = t === 'settings' ? 'key' : 'id';
    const rows = all(`SELECT ${key} AS k FROM ${t}`);
    // Send in chunks of 500 records, parents before children.
    for (let i = 0; i < rows.length; i += 500) {
      const grp = `upload-${t}-${i}-${Date.now()}`;
      for (const r of rows.slice(i, i + 500)) run('INSERT INTO outbox(grp, tbl, row_key) VALUES(?, ?, ?)', grp, t, String(r.k));
      n++;
    }
  }
  return n;
}

route('POST', '/api/backup/import', 'owner', ({ body }) => ({ counts: importData(body.data || body, { capture: D.deviceInfo().mode === 'cloud' }) }));

// ---------- Excel (CSV) export ----------
const EXPORTS = {
  products: { sql: `SELECT p.barcode, p.name, p.category, p.size, p.color, p.cost_price, p.sale_price,
      COALESCE((SELECT SUM(qty) FROM stock WHERE product_id = p.id), 0) AS total_stock, CASE p.active WHEN 1 THEN 'yes' ELSE 'no' END AS active
      FROM products p ORDER BY p.name, p.color, p.size` },
  stock: { sql: `SELECT l.name AS location, p.barcode, p.name, p.category, p.size, p.color, s.qty, p.cost_price, p.sale_price,
      ROUND(s.qty * p.cost_price, 2) AS cost_value, ROUND(s.qty * p.sale_price, 2) AS sale_value
      FROM stock s JOIN products p ON p.id = s.product_id JOIN locations l ON l.id = s.location_id WHERE s.qty <> 0 ORDER BY l.type DESC, l.name, p.name` },
  sales: { date: 's.created_at', sql: `SELECT s.bill_no, s.created_at AS date_time, l.name AS shop, s.items_qty, s.subtotal, s.discount, s.voucher_code, s.voucher, s.total, s.paid, s.change_due,
      s.payment_method, s.customer_name, s.customer_phone, u.name AS cashier, s.status, s.void_reason
      FROM sales s JOIN locations l ON l.id = s.location_id LEFT JOIN users u ON u.id = s.user_id WHERE {DATE} ORDER BY s.id` },
  sale_items: { date: 's.created_at', sql: `SELECT s.bill_no, s.created_at AS date_time, l.name AS shop, p.barcode, p.name, p.size, p.color, p.category,
      i.qty, i.list_price, i.price, ROUND(i.qty * i.price, 2) AS amount, i.cost, ROUND(i.qty * (i.price - i.cost), 2) AS profit, s.status
      FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN locations l ON l.id = s.location_id JOIN products p ON p.id = i.product_id
      WHERE {DATE} ORDER BY s.id, i.id` },
  purchases: { date: 'pu.date', sql: `SELECT pu.purchase_no, pu.date, su.name AS supplier, pu.invoice_no, l.name AS received_at, pu.total_qty, pu.total, pu.paid, pu.status, pu.notes
      FROM purchases pu LEFT JOIN suppliers su ON su.id = pu.supplier_id JOIN locations l ON l.id = pu.location_id WHERE {DATE} ORDER BY pu.id` },
  purchase_items: { date: 'pu.date', sql: `SELECT pu.purchase_no, pu.date, su.name AS supplier, p.barcode, p.name, p.size, p.color, i.qty, i.cost, ROUND(i.qty * i.cost, 2) AS amount, pu.status
      FROM purchase_items i JOIN purchases pu ON pu.id = i.purchase_id LEFT JOIN suppliers su ON su.id = pu.supplier_id JOIN products p ON p.id = i.product_id
      WHERE {DATE} ORDER BY pu.id, i.id` },
  dispatches: { date: 'd.created_at', sql: `SELECT d.dispatch_no, d.created_at AS sent_at, f.name AS from_location, t.name AS to_location, d.status, d.total_qty, d.received_qty, d.total_value, d.received_at, d.notes
      FROM dispatches d JOIN locations f ON f.id = d.from_location_id JOIN locations t ON t.id = d.to_location_id WHERE {DATE} ORDER BY d.id` },
  dispatch_items: { date: 'd.created_at', sql: `SELECT d.dispatch_no, d.created_at AS sent_at, f.name AS from_location, t.name AS to_location, p.barcode, p.name, p.size, p.color,
      i.qty AS sent_qty, i.received_qty, i.price, d.status
      FROM dispatch_items i JOIN dispatches d ON d.id = i.dispatch_id JOIN locations f ON f.id = d.from_location_id JOIN locations t ON t.id = d.to_location_id
      JOIN products p ON p.id = i.product_id WHERE {DATE} ORDER BY d.id, i.id` },
  expenses: { date: 'e.date', sql: `SELECT e.date, l.name AS location, e.category, e.amount, e.note, u.name AS added_by
      FROM expenses e LEFT JOIN locations l ON l.id = e.location_id LEFT JOIN users u ON u.id = e.user_id WHERE {DATE} ORDER BY e.date, e.id` },
  suppliers: { sql: `SELECT s.name, s.phone, s.address, s.notes,
      COALESCE((SELECT SUM(total) FROM purchases WHERE supplier_id = s.id AND status = 'done'), 0) AS purchased,
      COALESCE((SELECT SUM(paid) FROM purchases WHERE supplier_id = s.id AND status = 'done'), 0) + COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE supplier_id = s.id), 0) AS paid
      FROM suppliers s ORDER BY s.name` },
  movements: { date: 'm.created_at', sql: `SELECT m.created_at AS date_time, l.name AS location, p.barcode, p.name, p.size, p.color, m.qty, m.type, m.note, u.name AS user
      FROM movements m JOIN products p ON p.id = m.product_id JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.user_id
      WHERE {DATE} ORDER BY m.id` },
};

function toCsv(rows) {
  if (!rows.length) return 'No data for this period\r\n';
  const cols = Object.keys(rows[0]);
  const q = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n') + '\r\n';
}

route('GET', '/api/export/:name', 'owner', ({ params, query }) => {
  const name = params.name.replace(/\.csv$/, '');
  const def = EXPORTS[name] || fail(404, 'Unknown export');
  const w = [], p = [];
  if (def.date) {
    const timed = def.date.endsWith('created_at');
    if (isDate(query.from)) { w.push(`${def.date} >= ?`); p.push(query.from + (timed ? ' 00:00:00' : '')); }
    if (isDate(query.to)) { w.push(`${def.date} <= ?`); p.push(query.to + (timed ? ' 23:59:59' : '')); }
  }
  const rows = all(def.sql.replace('{DATE}', w.length ? w.join(' AND ') : '1 = 1'), ...p);
  const range = def.date && (query.from || query.to) ? `-${query.from || 'start'}-to-${query.to || today()}` : '';
  return file(`velanzo-${name}${range}.csv`, 'text/csv;charset=utf-8', '\uFEFF' + toCsv(rows));
});

// ---------- Import products (with opening stock) from a spreadsheet ----------
route('POST', '/api/import/products', 'add_items', ({ body, user }) => tx(() => {
  const rows = Array.isArray(body.rows) ? body.rows : fail(400, 'No rows to import');
  if (rows.length > 20000) fail(400, 'Too many rows (max 20,000 at a time)');
  const loc = userLocation(user, body.location_id) || defaultWarehouseId();
  const errors = [];
  let created = 0, updated = 0, stocked = 0;
  rows.forEach((r, i) => {
    const line = i + 2; // row 1 is the header in the spreadsheet
    const barcode = str(r.barcode, 60);
    const name = str(r.name, 120);
    const size = str(r.size, 30), color = str(r.color, 40);
    const qty = r.qty === undefined || r.qty === '' ? 0 : toInt(r.qty, NaN);
    if (!Number.isFinite(qty)) { errors.push(`Row ${line}: quantity "${r.qty}" is not a number`); return; }
    let p = barcode ? get('SELECT * FROM products WHERE barcode = ?', barcode) : null;
    if (!p && !barcode && name) {
      p = get("SELECT * FROM products WHERE name = ? COLLATE NOCASE AND IFNULL(size, '') = ? COLLATE NOCASE AND IFNULL(color, '') = ? COLLATE NOCASE", name, size, color);
    }
    const has = (k) => r[k] !== undefined && String(r[k]).trim() !== '';
    if (p) {
      run('UPDATE products SET name = ?, category = ?, size = ?, color = ?, cost_price = ?, sale_price = ?, active = 1, updated_at = ? WHERE id = ?',
        name || p.name, has('category') ? str(r.category, 60) : p.category, has('size') ? size : p.size, has('color') ? color : p.color,
        has('cost_price') ? toMoney(r.cost_price) : p.cost_price, has('sale_price') ? toMoney(r.sale_price) : p.sale_price, now(), p.id);
      updated++;
    } else {
      if (!name) { errors.push(`Row ${line}: item name is missing`); return; }
      p = { id: D.newId() };
      run('INSERT INTO products(id, barcode, name, category, size, color, cost_price, sale_price, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
        p.id, barcode || D.newBarcode(), name, str(r.category, 60), size, color, toMoney(r.cost_price), toMoney(r.sale_price), now());
      created++;
    }
    if (qty) { D.moveStock(p.id, loc, qty, 'opening', null, null, user.id, 'Imported from file'); stocked += qty; }
  });
  if (errors.length) fail(400, `Nothing was imported. Please fix these rows and try again:\n${errors.slice(0, 15).join('\n')}${errors.length > 15 ? `\n…and ${errors.length - 15} more` : ''}`);
  return { created, updated, stocked };
}));

