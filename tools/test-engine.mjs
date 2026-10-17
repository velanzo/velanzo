// Runs the shop flows through the engine on one device (no cloud) and checks the numbers.
// Run: node --disable-warning=ExperimentalWarning tools/test-engine.mjs
import assert from 'node:assert/strict';
import * as E from '../web/engine/index.js';
import { nodeAdapter } from '../web/engine/node-adapter.js';
import * as D from '../web/engine/db.js';

E.init(nodeAdapter());
const call = async (method, path, body, query) => {
  const r = await E.handle({ method, path, body: body || {}, query: query || {} });
  if (r.status !== 200) { const e = new Error(`${method} ${path} → ${r.status} ${r.body.error}`); e.status = r.status; e.body = r.body; throw e; }
  return r.body;
};
const expectStatus = async (status, method, path, body) => {
  const r = await E.handle({ method, path, body: body || {}, query: {} });
  assert.equal(r.status, status, `${method} ${path} should be ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

// ---- set up (no cloud) ----
await expectStatus(401, 'GET', '/api/me');
await E.system.setupLocal({ business_name: 'Test Clothing', owner_name: 'Owner', pin: '1234' });
const me = await call('GET', '/api/me');
ok(me.user.owner && me.user.role === 'admin', 'owner logged in after setup');
ok(me.locations.length === 2, 'two starting places');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
const S1 = me.locations.find((l) => l.type === 'shop').id;
ok(WH > 1e9 && S1 > 1e9, 'ids carry the device number');
ok(me.locations.find((l) => l.id === S1).perms.includes('sell'), 'shop can sell by default');

await call('POST', '/api/logout');
await expectStatus(401, 'POST', '/api/login', { user_id: me.user.id, pin: '9999' });
await call('POST', '/api/login', { user_id: me.user.id, pin: '1234' });

// ---- people ----
const bilal = await call('POST', '/api/users', { name: 'Bilal', role: 'staff', location_id: WH, pin: '1111' });
const ahmed = await call('POST', '/api/users', { name: 'Ahmed', role: 'staff', location_id: S1, pin: '2222', perms: ['sell', 'receive'] });
ok(!bilal.perms && ahmed.perms.sell && !ahmed.perms.discount, 'person switches saved');
await expectStatus(400, 'POST', '/api/users', { name: 'X', role: 'staff', location_id: S1, pin: '12' });

// ---- supplier, purchase with new items ----
const sup = await call('POST', '/api/suppliers', { name: 'Al-Noor Textiles', phone: '0300' });
const made = await call('POST', '/api/products', {
  name: 'Lawn Kurta', category: 'Kurta', cost_price: 1200, sale_price: 2450,
  variants: [{ size: 'M', color: 'Blue' }, { size: 'L', color: 'Blue' }, { size: 'M', color: 'Red', opening_qty: 5 }],
});
ok(made.length === 3 && made.every((p) => /^201\d{5}$/.test(p.barcode)), 'device barcodes 201xxxxx: ' + made.map((p) => p.barcode));
const [km, kl, kr] = made;
const pur = await call('POST', '/api/purchases', {
  supplier_id: sup.id, location_id: WH, paid: 10000,
  items: [{ product_id: km.id, qty: 20, cost: 1200 }, { product_id: kl.id, qty: 10, cost: 1250, sale_price: 2500 }],
});
ok(/^P-A0001$/.test(pur.purchase_no), 'purchase number with device letter: ' + pur.purchase_no);
const pd = await call('GET', `/api/purchases/${pur.id}`);
ok(pd.total === 36500 && pd.items.length === 2, 'purchase total');
ok(D.stockQty(km.id, WH) === 20 && D.stockQty(kr.id, WH) === 5, 'warehouse stock after purchase');
ok((await call('GET', `/api/products/${kl.id}`)).product.sale_price === 2500, 'purchase updated sale price');

// ---- dispatch to the shop and receive with one missing ----
await expectStatus(409, 'POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: km.id, qty: 50 }] });
const dsp = await call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, notes: 'bag 1',
  items: [{ product_id: km.id, qty: 8 }, { product_id: km.id, qty: 2 }, { product_id: kr.id, qty: 3 }] });
ok(dsp.dispatch_no === 'D-A0001', 'dispatch number');
ok(D.stockQty(km.id, WH) === 10, 'stock left warehouse');
ok((await call('GET', '/api/badges')).incoming === 1, 'one dispatch on the way');
const dd = await call('GET', `/api/dispatches/${dsp.id}`);
const line = dd.items.find((i) => i.product_id === km.id);
ok(line.qty === 10, 'repeated scans merged');
await call('POST', `/api/dispatches/${dsp.id}/receive`, { items: [{ id: line.id, received_qty: 9 }] });
ok(D.stockQty(km.id, S1) === 9 && D.stockQty(kr.id, S1) === 3, 'shop stock after receiving');

// ---- sales, return/exchange, void ----
const s1 = await call('POST', '/api/sales', { location_id: S1, payment_method: 'cash', paid: 5000, items: [{ product_id: km.id, qty: 2 }] });
ok(s1.bill_no === 'S1-A0001' && s1.total === 4900 && s1.change_due === 100, 'bill made: ' + s1.bill_no);
const s2 = await call('POST', '/api/sales', { location_id: S1, payment_method: 'card', discount: 200, items: [{ product_id: km.id, qty: 1 }, { product_id: kr.id, qty: 1 }] });
ok(s2.total === 4700, 'discount applied');
const ex = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: km.id, qty: -1 }, { product_id: kr.id, qty: 1 }] });
ok(ex.total === 0, 'even exchange');
ok(D.stockQty(km.id, S1) === 7 && D.stockQty(kr.id, S1) === 1, 'shop stock after sales');
await call('POST', `/api/sales/${s2.id}/void`, { reason: 'wrong items' });
ok(D.stockQty(km.id, S1) === 8 && D.stockQty(kr.id, S1) === 2, 'void put stock back');
ok((await call('GET', `/api/sales/by-bill/${s1.bill_no}`)).id === s1.id, 'find bill by number');

// ---- corrections, expenses ----
await call('POST', '/api/stock/adjust', { location_id: WH, product_id: kl.id, qty: -1, reason: 'Damaged' });
ok(D.stockQty(kl.id, WH) === 9, 'stock correction');
await call('POST', '/api/expenses', { location_id: S1, amount: 900, category: 'Food / Tea' });
const exps = await call('GET', '/api/expenses', null, { location_id: S1 });
await call('DELETE', `/api/expenses/${exps[0].id}`);
await call('POST', '/api/expenses', { location_id: S1, amount: 5000, category: 'Rent' });
await call('POST', `/api/suppliers/${sup.id}/payments`, { amount: 6500 });

// ---- reports, dashboard, live, activity, exports ----
const t = D.today();
const rep = await call('GET', '/api/reports', null, { from: t, to: t });
ok(rep.summary.net_sales === 4900 && rep.summary.bills === 2, 'report sales ' + JSON.stringify(rep.summary));
ok(rep.summary.cogs === 2400 && rep.summary.expenses === 5000, 'report cost and expenses');
const dash = await call('GET', '/api/dashboard');
ok(dash.today.total === 4900 && dash.supplier_due === 36500 - 10000 - 6500, 'dashboard numbers');
const live = await call('GET', '/api/live');
ok(live.activity.length >= 8, 'activity feed has events: ' + live.activity.map((a) => a.kind).join(','));
const csv = await call('GET', '/api/export/sales', null, {});
ok(csv.__file.name.endsWith('.csv') && csv.__file.content.includes('S1-A0001'), 'csv export');

// ---- every stock count matches its history ----
const bad = D.all(`SELECT s.location_id, s.product_id, s.qty, (SELECT COALESCE(SUM(qty), 0) FROM movements m WHERE m.location_id = s.location_id AND m.product_id = s.product_id) AS hist
  FROM stock s WHERE s.qty <> (SELECT COALESCE(SUM(qty), 0) FROM movements m WHERE m.location_id = s.location_id AND m.product_id = s.product_id)`);
ok(bad.length === 0, 'stock = sum of history: ' + JSON.stringify(bad));

// ---- backup round trip ----
const bk = JSON.parse((await call('GET', '/api/backup/export')).__file.content);
ok(bk.app === 'velanzo' && bk.schema_version === 3 && bk.tables.sales.length === 3, 'backup file');
const before = Object.fromEntries(D.BACKUP_TABLES.map((x) => [x, D.all(`SELECT * FROM ${x}`)]));
await call('POST', '/api/backup/import', { data: bk });
for (const x of D.BACKUP_TABLES) ok(JSON.stringify(D.all(`SELECT * FROM ${x}`)) === JSON.stringify(before[x]), `restore kept ${x}`);
const s3 = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: km.id, qty: 1 }] });
ok(s3.bill_no === 'S1-A0004', 'numbering continues after restore: ' + s3.bill_no);
ok(D.get('SELECT COUNT(*) AS n FROM outbox').n === 0, 'nothing queued for the cloud in local mode');

// ---- an old backup (single-computer version) loads ---- (run at the end)
const old = { app: 'velanzo', schema_version: 2, exported_at: '2026-10-01 10:00:00', tables: {
  settings: [{ key: 'business_name', value: 'Old Shop' }],
  locations: [{ id: 1, name: 'Main Warehouse', code: 'WH', type: 'warehouse', address: null, phone: null, active: 1, created_at: '2026-01-01 00:00:00' },
    { id: 2, name: 'Shop 1', code: 'S1', type: 'shop', address: null, phone: null, active: 1, created_at: '2026-01-01 00:00:00' }],
  users: [{ id: 1, username: 'admin', name: 'Owner', password_hash: 'x:y', role: 'admin', location_id: null, active: 1, created_at: '2026-01-01 00:00:00' },
    { id: 2, username: 'ahmed', name: 'Ahmed', password_hash: 'x:y', role: 'shop', location_id: 2, active: 1, created_at: '2026-01-01 00:00:00' }],
  products: [{ id: 1, barcode: '10000001', name: 'Shirt', category: '', size: 'M', color: '', cost_price: 500, sale_price: 900, active: 1, created_at: '2026-01-01 00:00:00', updated_at: null }],
  stock: [{ location_id: 2, product_id: 1, qty: 4 }],
  counters: [{ name: 'barcode', value: 10000001 }], sessions: [],
} };

// ---- the same database as a shop device (Shop 1) with switches ----
{
  const ahmed2 = D.get("SELECT * FROM users WHERE name = 'Ahmed' AND id > 1000");
  D.setDevice({ location_id: S1, mode: 'cloud' });
  D.run('UPDATE sync_ctx SET applying = 0');
  const lu = await call('GET', '/api/login-users');
  ok(lu.users.some((u) => u.name === 'Ahmed') && !lu.users.some((u) => u.name === 'Bilal'), 'only Shop 1 people (and owner) can log in here');
  await call('POST', '/api/login', { user_id: ahmed2.id, pin: '2222' });
  const m2 = await call('GET', '/api/me');
  ok(!m2.user.owner && m2.user.location_id === S1 && m2.user.perms.join() === 'sell,receive', 'Ahmed may only sell and receive: ' + m2.user.perms);
  const sale = await call('POST', '/api/sales', { location_id: WH, items: [{ product_id: km.id, qty: 1 }] });
  ok(sale.location_id === S1, 'staff always sell at their own shop');
  ok(!('cost' in sale.items[0]), 'cost hidden from Ahmed');
  await expectStatus(403, 'POST', '/api/sales', { discount: 50, items: [{ product_id: km.id, qty: 1 }] });
  await expectStatus(403, 'POST', '/api/sales', { items: [{ product_id: km.id, qty: -1 }] });
  await expectStatus(403, 'POST', '/api/purchases', { items: [{ product_id: km.id, qty: 1, cost: 1 }] });
  await expectStatus(403, 'POST', '/api/stock/adjust', { product_id: km.id, qty: 1 });
  await expectStatus(403, 'POST', '/api/expenses', { amount: 10 });
  await expectStatus(403, 'GET', '/api/reports');
  await expectStatus(403, 'PUT', '/api/settings', { business_name: 'x' });
  ok(!('cost_price' in (await call('GET', '/api/products'))[0]), 'product cost hidden');
  const priced = await call('POST', '/api/sales', { items: [{ product_id: km.id, qty: 1, price: 1 }] });
  ok(priced.total === 2450, 'price change ignored without the switch');

  // the outbox groups each action with all its rows
  const ob = E.system.outbox();
  ok(ob.length === 2 && ob[0].rows.map((r) => r.t).join() === 'sales,sale_items,movements', 'outbox groups: ' + ob.map((g) => g.rows.map((r) => r.t).join('+')).join(' | '));
  E.system.pushed(ob[0].seqs);
  ok(E.system.outbox().length === 1, 'pushed group removed');

  // rows coming from the cloud: an unsent local change wins; stock = cloud count + unsent moves
  const pendingSale = ob[1].rows.find((r) => r.t === 'sales').r;
  E.system.applyPull([
    { t: 'sales', r: { ...pendingSale, customer_name: 'from cloud' } },
    { t: 'stock', r: { location_id: S1, product_id: km.id, qty: 100 } },
    { t: 'products', r: { ...km, name: 'Lawn Kurta (new name)', cost_price: null } },
  ]);
  ok(D.get('SELECT customer_name FROM sales WHERE id = ?', pendingSale.id).customer_name !== 'from cloud', 'unsent local change kept');
  ok(D.stockQty(km.id, S1) === 99, 'cloud stock plus unsent sale: ' + D.stockQty(km.id, S1));
  ok(D.get('SELECT name FROM products WHERE id = ?', km.id).name === 'Lawn Kurta (new name)', 'cloud change applied');
  ok(E.system.outbox().length === 1, 'pulled rows are not sent back');
  await call('POST', '/api/logout');
}

D.setDevice({ location_id: null, mode: 'local' });
D.run('UPDATE sync_ctx SET applying = 1');
await call('POST', '/api/login', { user_id: me.user.id, pin: '1234' });
const counts = (await call('POST', '/api/backup/import', { data: old })).counts;
ok(counts.users === 2 && counts.products === 1 && D.get('SELECT role FROM users WHERE id = 2').role === 'staff', 'old backup converted');

console.log(`\nAll ${checks} checks passed.`);
