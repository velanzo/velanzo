// Database helpers and schema. The same code runs in the browser (SQLite in a Web Worker, saved on this
// device) and in Node for tests (node:sqlite). The adapter hides the difference.
//
// Every record id is unique across all devices: id = device number × 1,000,000,000 + a counter.
// Data from the old single-computer version keeps its small ids (device 0).

let A = null; // adapter: { exec(sql), all(sql, params), get(sql, params), run(sql, params) → { changes } }

const fix = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
export const all = (sql, ...p) => A.all(sql, fix(p));
export const get = (sql, ...p) => A.get(sql, fix(p));
export const run = (sql, ...p) => A.run(sql, fix(p));
export const exec = (sql) => A.exec(sql);

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  exec('BEGIN IMMEDIATE');
  depth++;
  try {
    const out = fn();
    exec('COMMIT');
    return out;
  } catch (e) {
    exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

export const pad = (n, l = 2) => String(n).padStart(l, '0');
// Local date-time text, e.g. "2026-10-16 14:05:09" (sorts correctly as text).
// (The demo-data tool sets globalThis.__vzClock to make two weeks of history; the app never does.)
export function now(d = globalThis.__vzClock ? globalThis.__vzClock() : new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export const today = () => now().slice(0, 10);
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------- Schema ----------
// Tables shared with the cloud (and in backups), in parent → child order.
export const SYNC_TABLES = ['settings', 'locations', 'users', 'suppliers', 'products', 'movements', 'purchases', 'purchase_items',
  'supplier_payments', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses'];
export const BACKUP_TABLES = [...SYNC_TABLES.slice(0, 5), 'stock', ...SYNC_TABLES.slice(5)];
export const BACKUP_VERSION = 3;

// Each entry is one schema version of this device's database. Never edit an old entry; add a new one.
const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE COLLATE NOCASE,
    type TEXT NOT NULL CHECK (type IN ('warehouse','shop')),
    address TEXT, phone TEXT,
    perms TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','staff')),
    location_id INTEGER REFERENCES locations(id),
    perms TEXT,
    pin_salt TEXT, pin_hash TEXT,
    email TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    label TEXT, location_id INTEGER, code TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT, last_user_id INTEGER,
    created_at TEXT
  );
  CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT, address TEXT, notes TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    barcode TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    category TEXT, size TEXT, color TEXT,
    cost_price REAL,
    sale_price REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE INDEX idx_products_name ON products(name);
  CREATE TABLE stock (
    location_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (location_id, product_id)
  );
  CREATE TABLE movements (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL,
    location_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    type TEXT NOT NULL,
    ref_type TEXT, ref_id INTEGER, note TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_mov_product ON movements(product_id, id);
  CREATE INDEX idx_mov_location ON movements(location_id, created_at);
  CREATE INDEX idx_mov_created ON movements(created_at);
  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY,
    purchase_no TEXT NOT NULL UNIQUE,
    supplier_id INTEGER,
    location_id INTEGER NOT NULL,
    invoice_no TEXT,
    date TEXT NOT NULL,
    total REAL NOT NULL DEFAULT 0,
    paid REAL NOT NULL DEFAULT 0,
    total_qty INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_purchases_created ON purchases(created_at);
  CREATE TABLE purchase_items (
    id INTEGER PRIMARY KEY,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    cost REAL NOT NULL
  );
  CREATE INDEX idx_pitems ON purchase_items(purchase_id);
  CREATE TABLE supplier_payments (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    method TEXT, note TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE dispatches (
    id INTEGER PRIMARY KEY,
    dispatch_no TEXT NOT NULL UNIQUE,
    from_location_id INTEGER NOT NULL,
    to_location_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_transit',
    total_qty INTEGER NOT NULL DEFAULT 0,
    total_value REAL NOT NULL DEFAULT 0,
    received_qty INTEGER,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL,
    received_by INTEGER,
    received_at TEXT
  );
  CREATE INDEX idx_dispatches_created ON dispatches(created_at);
  CREATE TABLE dispatch_items (
    id INTEGER PRIMARY KEY,
    dispatch_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    received_qty INTEGER,
    price REAL NOT NULL,
    cost REAL
  );
  CREATE INDEX idx_ditems ON dispatch_items(dispatch_id);
  CREATE TABLE sales (
    id INTEGER PRIMARY KEY,
    bill_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    location_id INTEGER NOT NULL,
    customer_name TEXT, customer_phone TEXT,
    subtotal REAL NOT NULL,
    discount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    paid REAL NOT NULL DEFAULT 0,
    change_due REAL NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    items_qty INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'done',
    user_id INTEGER,
    created_at TEXT NOT NULL,
    void_reason TEXT, voided_by INTEGER, voided_at TEXT
  );
  CREATE INDEX idx_sales_date ON sales(created_at);
  CREATE TABLE sale_items (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    price REAL NOT NULL,
    cost REAL
  );
  CREATE INDEX idx_sitems ON sale_items(sale_id);
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    location_id INTEGER,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_expenses_created ON expenses(created_at);

  -- This device only (never sent anywhere)
  CREATE TABLE device (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  -- Changes made here that the cloud has not got yet. grp = one action (e.g. one bill with its lines).
  CREATE TABLE outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT NOT NULL, tbl TEXT NOT NULL, row_key TEXT NOT NULL, del INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE sync_ctx (applying INTEGER NOT NULL, grp TEXT);
  INSERT INTO sync_ctx VALUES (0, 'start');
  -- Changes the cloud refused (shown to the owner)
  CREATE TABLE sync_errors (id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT, message TEXT, rows TEXT, created_at TEXT);
  ${SYNC_TABLES.map(outboxTriggers).join('\n')}
  `,
  // Purchase orders: ordered today, counted into stock when the goods arrive.
  `
  ALTER TABLE purchases ADD COLUMN expected_date TEXT;
  ALTER TABLE purchases ADD COLUMN received_at TEXT;
  ALTER TABLE purchase_items ADD COLUMN ordered_qty INTEGER;
  ALTER TABLE purchase_items ADD COLUMN planned_price REAL;
  `,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

// Every insert/update/delete made by this device is noted in the outbox (but not changes that came from the cloud).
function outboxTriggers(t) {
  const key = t === 'settings' ? 'key' : 'id';
  const when = 'WHEN (SELECT applying FROM sync_ctx) = 0';
  return `
  CREATE TRIGGER ${t}_ob_i AFTER INSERT ON ${t} ${when} BEGIN INSERT INTO outbox(grp, tbl, row_key) VALUES ((SELECT grp FROM sync_ctx), '${t}', NEW.${key}); END;
  CREATE TRIGGER ${t}_ob_u AFTER UPDATE ON ${t} ${when} BEGIN INSERT INTO outbox(grp, tbl, row_key) VALUES ((SELECT grp FROM sync_ctx), '${t}', NEW.${key}); END;
  CREATE TRIGGER ${t}_ob_d AFTER DELETE ON ${t} ${when} BEGIN INSERT INTO outbox(grp, tbl, row_key, del) VALUES ((SELECT grp FROM sync_ctx), '${t}', OLD.${key}, 1); END;`;
}

export const DEFAULT_SETTINGS = {
  business_name: 'Velanzo',
  business_address: '',
  business_phone: '',
  currency: 'Rs',
  bill_footer: 'Thank you for shopping with us!\nExchange within 7 days with this bill.',
  bill_width: '80',
  bill_mm: '', // print width in mm (blank = from the paper width: 72 or 48)
  bill_left: '', // space from the left edge in mm (blank = centred)
  auto_print_bill: '1',
  label_mode: 'roll',
  label_width: '50',
  label_height: '25',
  label_columns: '4',
  label_show_price: '1',
  label_show_name: '1',
  dispatch_paper: 'a4',
  low_stock: '2',
  warn_discount: '20',
  warn_expense: '50000',
};

export function init(adapter) {
  A = adapter;
  exec('PRAGMA foreign_keys = OFF');
  const v = get('PRAGMA user_version').user_version;
  for (let i = v; i < MIGRATIONS.length; i++) {
    tx(() => {
      exec(MIGRATIONS[i]);
      exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
}

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

// ---------- This device ----------
export function deviceInfo() {
  const d = Object.fromEntries(all('SELECT key, value FROM device').map((r) => [r.key, r.value]));
  return {
    id: Number(d.id) || 0,
    code: d.code || '',
    location_id: d.location_id ? Number(d.location_id) : null,
    mode: d.mode || '',          // 'cloud' or 'local' (not connected to the cloud)
    label: d.label || '',
    print: (() => { try { return JSON.parse(d.print || '{}') || {}; } catch { return {}; } })(), // this computer's printer settings
  };
}
export function setDevice(values) {
  tx(() => {
    for (const [k, v] of Object.entries(values)) {
      if (v === null || v === undefined) run('DELETE FROM device WHERE key = ?', k);
      else run('INSERT INTO device(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
    }
  });
}

export function nextCounter(name, start = 1) {
  const r = get('SELECT value FROM counters WHERE name = ?', name);
  const v = r ? r.value + 1 : start;
  run('INSERT INTO counters(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', name, v);
  return v;
}

// A new record id no other device can ever make.
export function newId() {
  const dev = deviceInfo().id;
  if (!dev) throw new Error('This device is not set up yet');
  return dev * 1e9 + nextCounter('id');
}

// Bill, purchase and dispatch numbers carry this device's letter, so two devices never make the same number.
export const deviceNo = (prefix, counter) => `${prefix}${deviceInfo().code}${pad(nextCounter(counter), 4)}`;

// Shop-made barcodes: 8 digits starting with 2, then the device number and a counter (2 01 00001 …).
export function newBarcode() {
  const dev = deviceInfo().id;
  for (;;) {
    const code = String(20000000 + dev * 100000 + nextCounter('barcode'));
    if (!get('SELECT 1 FROM products WHERE barcode = ?', code)) return code;
  }
}

// Every stock change goes through here: updates the stock count and writes a history line.
export function moveStock(productId, locationId, qty, type, refType, refId, userId, note) {
  if (!qty) return;
  run(
    'INSERT INTO stock(location_id, product_id, qty) VALUES(?, ?, ?) ON CONFLICT(location_id, product_id) DO UPDATE SET qty = qty + excluded.qty',
    locationId, productId, qty
  );
  run(
    'INSERT INTO movements(id, product_id, location_id, qty, type, ref_type, ref_id, note, user_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    newId(), productId, locationId, qty, type, refType, refId, note, userId, now()
  );
}

export function stockQty(productId, locationId) {
  const r = get('SELECT qty FROM stock WHERE product_id = ? AND location_id = ?', productId, locationId);
  return r ? r.qty : 0;
}

const colCache = new Map();
export function tableColumns(table) {
  if (!colCache.has(table)) colCache.set(table, all(`PRAGMA table_info(${table})`).map((c) => c.name));
  return colCache.get(table);
}

// Starts a new "action" for the outbox: everything written until the next call is sent to the cloud together.
let grpSeq = 0;
export function beginGroup() {
  run('UPDATE sync_ctx SET grp = ?', `${deviceInfo().id}-${Date.now()}-${++grpSeq}`);
}
