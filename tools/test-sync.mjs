// Several devices working offline and syncing through the cloud database (Postgres in Node, same SQL as Supabase).
// Checks that everyone ends up with the same numbers and that the cloud enforces each shop's switches.
// Run: node --disable-warning=ExperimentalWarning tools/test-sync.mjs
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { startCloud } from './pg-cloud.mjs';
import { createSyncer } from '../web/engine/syncer.js';

const { rpc: cloudRpc, db } = await startCloud();
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

// A device = an engine in its own worker + a signed-in account + a syncer.
function device(name, uid) {
  const w = new Worker(new URL('./engine-worker.mjs', import.meta.url));
  let seq = 0;
  const pending = new Map();
  w.on('message', (m) => { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.out) : p.reject(new Error(m.error)); });
  const send = (kind, name2, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.postMessage({ id, kind, name: name2, args }); });
  const system = (n, ...args) => send('system', n, args);
  const rpc = (fn, args) => cloudRpc(uid, fn, args);
  const dev = {
    name, uid, system, rpc,
    syncer: createSyncer({ system, rpc }),
    sync: () => dev.syncer.syncOnce(),
    sql: (q, p) => send('sql', null, [q, p]),
    async call(method, path, body, query) {
      const r = await send('api', null, [{ method, path, body: body || {}, query: query || {} }]);
      if (r.status !== 200) { const e = new Error(`${name}: ${method} ${path} → ${r.status} ${r.body.error}`); e.status = r.status; throw e; }
      return r.body;
    },
    async status(method, path, body) { return (await send('api', null, [{ method, path, body: body || {}, query: {} }])).status; },
    stop: () => w.terminate(),
  };
  return dev;
}
const stockOf = async (d, loc, pid) => (await d.sql('SELECT qty FROM stock WHERE location_id = ? AND product_id = ?', [loc, pid]))[0]?.qty ?? 0;
const cloudStock = async (loc, pid) => (await db.query('select qty from stock where location_id = $1 and product_id = $2', [loc, pid])).rows[0]?.qty ?? 0;

// ---------- The owner starts the business on a laptop ----------
const owner = device('owner', 'aaaaaaaa-0000-0000-0000-000000000001');
await owner.rpc('create_owner', { p_email: 'owner@shop.pk' });
const od = await owner.rpc('register_owner_device', { p_label: 'Owner laptop', p_now: '2026-10-16 09:00:00' });
await owner.system('setupCloud', { ...od, label: 'Owner laptop' });
await owner.system('startBusiness', { business_name: 'Velanzo Test', owner_name: 'Owner', pin: '1234' });
const me = await owner.call('GET', '/api/me');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
const S1 = me.locations.find((l) => l.type === 'shop').id;
const bilal = await owner.call('POST', '/api/users', { name: 'Bilal', role: 'staff', location_id: WH, pin: '1111' });
const ahmed = await owner.call('POST', '/api/users', { name: 'Ahmed', role: 'staff', location_id: S1, pin: '2222', perms: ['sell', 'returns', 'receive'] });
const sup = await owner.call('POST', '/api/suppliers', { name: 'Al-Noor' });
const items = await owner.call('POST', '/api/products', { name: 'Kurta', cost_price: 1000, sale_price: 2000, variants: [{ size: 'M' }, { size: 'L' }] });
const [km, kl] = items;
await owner.call('POST', '/api/purchases', { supplier_id: sup.id, location_id: WH, items: [{ product_id: km.id, qty: 50, cost: 1000 }, { product_id: kl.id, qty: 30, cost: 1000 }] });
let r = await owner.sync();
ok(r.sent > 0 && r.refused === 0, 'owner sent the new business: ' + JSON.stringify(r));
ok(await cloudStock(WH, km.id) === 50, 'cloud worked out warehouse stock');
ok((await db.query('select count(*)::int n from users')).rows[0].n === 3, 'people reached the cloud');

// ---------- Shop and warehouse computers join with codes ----------
async function join(name, uid, loc, label) {
  const d = device(name, uid);
  const code = await owner.rpc('create_setup_code', { p_location: loc });
  const info = await d.rpc('claim_device', { p_code: code, p_label: label, p_now: '2026-10-16 09:10:00' });
  await d.system('setupCloud', { ...info, label });
  await d.sync();
  return d;
}
const shop = await join('shop', 'bbbbbbbb-0000-0000-0000-000000000002', S1, 'Shop 1 counter');
const wh = await join('warehouse', 'cccccccc-0000-0000-0000-000000000003', WH, 'Warehouse PC');
const lu = await shop.call('GET', '/api/login-users');
ok(lu.users.map((u) => u.name).sort().join() === 'Ahmed,Owner', 'shop sees only its people + owner: ' + lu.users.map((u) => u.name));
await shop.call('POST', '/api/login', { user_id: ahmed.id, pin: '2222' });
await wh.call('POST', '/api/login', { user_id: bilal.id, pin: '1111' });
ok((await shop.sql('SELECT cost_price FROM products WHERE id = ?', [km.id]))[0].cost_price == null, 'shop did not receive cost prices');
ok((await shop.sql('SELECT COUNT(*) AS n FROM purchases'))[0].n === 0 && (await shop.sql('SELECT COUNT(*) AS n FROM suppliers'))[0].n === 0, 'shop did not receive purchases/suppliers');
ok((await wh.sql('SELECT cost_price FROM products WHERE id = ?', [km.id]))[0].cost_price === 1000, 'warehouse (buys) sees cost');
ok(await stockOf(shop, WH, km.id) === 50, 'shop can see warehouse stock');

// ---------- Warehouse sends a parcel while offline, then syncs ----------
const dsp = await wh.call('POST', '/api/dispatches', { to_location_id: S1, items: [{ product_id: km.id, qty: 10 }, { product_id: kl.id, qty: 5 }] });
ok(/^D-D0001$/.test(dsp.dispatch_no), 'warehouse device letter in dispatch no: ' + dsp.dispatch_no);
ok(await stockOf(wh, WH, km.id) === 40, 'warehouse stock dropped locally (offline)');
r = await wh.sync();
ok(r.sent === 1 && r.refused === 0, 'dispatch sent');
await shop.sync();
ok((await shop.call('GET', '/api/badges')).incoming === 1, 'shop sees the parcel coming');

// ---------- Shop receives (one missing) and sells while offline ----------
const dd = await shop.call('GET', `/api/dispatches/${dsp.id}`);
const lineM = dd.items.find((i) => i.product_id === km.id);
await shop.call('POST', `/api/dispatches/${dsp.id}/receive`, { items: [{ id: lineM.id, received_qty: 9 }] });
const bills = [];
for (let i = 0; i < 3; i++) bills.push(await shop.call('POST', '/api/sales', { items: [{ product_id: km.id, qty: 1 }] }));
bills.push(await shop.call('POST', '/api/sales', { items: [{ product_id: km.id, qty: -1 }, { product_id: kl.id, qty: 1 }] }));
ok(bills[0].bill_no === 'S1-C0001' && bills[3].bill_no === 'S1-C0004', 'shop bill numbers: ' + bills.map((b) => b.bill_no));
ok(await stockOf(shop, S1, km.id) === 7 && await stockOf(shop, S1, kl.id) === 4, 'shop stock offline');
ok((await shop.call('GET', '/api/badges')).waiting === 5, 'five actions waiting to send');
// meanwhile the owner corrects Shop 1 stock from their laptop (offline too)
await owner.sync();
await owner.call('POST', '/api/stock/adjust', { location_id: S1, product_id: kl.id, qty: 2, reason: 'Found 2' });
// both come online
r = await shop.sync();
ok(r.sent === 5 && r.refused === 0, 'shop sent receive + 4 bills: ' + JSON.stringify(r));
await owner.sync();
r = await shop.sync();
ok(await stockOf(shop, S1, kl.id) === 6 && await cloudStock(S1, kl.id) === 6, 'shop and cloud agree after both changed Shop 1 stock');
ok(await stockOf(owner, S1, km.id) === 7, 'owner sees shop stock');
ok((await db.query('select cost from sale_items where sale_id = $1', [bills[0].id])).rows[0].cost === 1000, 'cloud filled in the cost of sold items');
await owner.sync();
const rep = await owner.call('GET', '/api/reports', null, { from: '2000-01-01', to: '2999-12-31' });
ok(rep.summary.bills === 4 && rep.summary.net_sales === 6000 && rep.summary.cogs === 3000, 'owner report from shop bills: ' + JSON.stringify(rep.summary));
const ownerDisp = await owner.call('GET', `/api/dispatches/${dsp.id}`);
ok(ownerDisp.status === 'received' && ownerDisp.received_qty === 14, 'owner sees the parcel received with one missing');

// ---------- The cloud refuses what the shop is not allowed to do (even if someone tampers with the app) ----------
const now = '2026-10-16 12:00:00';
const tamper = async (rows) => (await shop.rpc('push', { p_device: (await shop.system('info')).device.id, p_user: ahmed.id, p_groups: [{ grp: 'evil-' + Math.random(), rows }] })).results[0];
let t = await tamper([{ t: 'purchases', r: { id: 99, purchase_no: 'P-X', location_id: S1, date: '2026-10-16', total: 1, paid: 0, total_qty: 1, status: 'done', created_at: now } }]);
ok(!t.ok && /Buying/.test(t.error), 'shop cannot enter purchases: ' + t.error);
t = await tamper([{ t: 'sales', r: { id: 98, bill_no: 'X-1', location_id: WH, subtotal: 1, discount: 0, total: 1, paid: 1, change_due: 0, payment_method: 'cash', items_qty: 1, status: 'done', created_at: now } }]);
ok(!t.ok && /own shop/.test(t.error), 'shop cannot bill for the warehouse: ' + t.error);
t = await tamper([{ t: 'products', r: { ...km, sale_price: 1, cost_price: 0 } }]);
ok(!t.ok, 'shop cannot change items: ' + t.error);
t = await tamper([{ t: 'sales', r: { id: 97, bill_no: 'X-2', location_id: S1, subtotal: 100, discount: 50, total: 50, paid: 50, change_due: 0, payment_method: 'cash', items_qty: 1, status: 'done', created_at: now } }]);
ok(!t.ok && /discount/i.test(t.error), 'discount switched off for Ahmed: ' + t.error);
t = await tamper([{ t: 'movements', r: { id: 96, product_id: km.id, location_id: S1, qty: 100, type: 'adjust', created_at: now } }]);
ok(!t.ok && /Correcting/.test(t.error), 'shop cannot add stock out of thin air: ' + t.error);
t = await tamper([{ t: 'users', r: { id: ahmed.id, name: 'Ahmed', role: 'admin', location_id: null, active: 1, created_at: now } }]);
ok((await db.query('select role, location_id from users where id = $1', [ahmed.id])).rows[0].role === 'staff', 'staff cannot make themselves owner (only their own PIN may change)');
t = await tamper([{ t: 'expenses', k: 1, del: 1 }]);
ok(!t.ok, 'staff cannot delete');
ok(await cloudStock(S1, km.id) === 7, 'cloud stock unchanged by refused changes');

// ---------- An action refused by the cloud is noted for the owner (not retried forever) ----------
await owner.call('PUT', `/api/locations/${S1}`, { perms: ['sell', 'receive'] });   // returns now off for Shop 1
await owner.sync();
await shop.call('POST', '/api/sales', { items: [{ product_id: km.id, qty: -1 }] }); // made on the shop before it heard about it
r = await shop.sync();
ok(r.refused === 1 && /returns/i.test(r.refusedMessages[0]), 'return refused after the owner switched returns off: ' + JSON.stringify(r));
ok(r.reset === true, 'shop re-downloaded after its switches changed');
ok((await shop.call('GET', '/api/badges')).errors === 1 && (await shop.call('GET', '/api/badges')).waiting === 0, 'refusal noted, nothing stuck');
ok(await stockOf(shop, S1, km.id) === 7, 'after re-download the shop matches the cloud again');
const me2 = await shop.call('GET', '/api/me');
ok(!me2.user.perms.includes('returns'), 'Ahmed lost returns: ' + me2.user.perms);

// ---------- Same item renamed on two devices: the later one wins, nobody breaks ----------
await wh.call('PUT', `/api/products/${km.id}`, { name: 'Kurta (warehouse name)' });
await owner.call('PUT', `/api/products/${km.id}`, { name: 'Kurta (owner name)' });
await wh.sync(); await owner.sync(); await wh.sync(); await shop.sync();
const names = await Promise.all([owner, wh, shop].map(async (d) => (await d.sql('SELECT name FROM products WHERE id = ?', [km.id]))[0].name));
ok(new Set(names).size === 1 && names[0] === 'Kurta (owner name)', 'everyone has the same name: ' + names);

// ---------- Owner deletes an expense: it disappears everywhere ----------
await wh.call('POST', '/api/expenses', { amount: 300, category: 'Tea' });
await wh.sync(); await owner.sync();
const exp = (await owner.call('GET', '/api/expenses'))[0];
await owner.call('DELETE', `/api/expenses/${exp.id}`);
await owner.sync(); await wh.sync();
ok((await wh.sql('SELECT COUNT(*) AS n FROM expenses'))[0].n === 0, 'deleted expense removed on the warehouse too');

// ---------- Every device agrees with the cloud ----------
const cloudRows = (await db.query('select location_id, product_id, qty from stock order by 1, 2')).rows;
for (const d of [owner, wh, shop]) {
  for (const c of cloudRows) ok(await stockOf(d, c.location_id, c.product_id) === c.qty, `${d.name} stock ${c.location_id}/${c.product_id} = ${c.qty}`);
}
const hist = (await db.query(`select s.location_id, s.product_id from stock s where s.qty <> (select coalesce(sum(qty), 0) from movements m where m.location_id = s.location_id and m.product_id = s.product_id)`)).rows;
ok(hist.length === 0, 'cloud stock = sum of its history');

// ---------- Owner online list: who is working where ----------
const live = await owner.call('GET', '/api/live');
ok(live.online.some((o) => o.name === 'Ahmed' && o.device === 'Shop 1 counter'), 'owner sees Ahmed working on the Shop 1 counter: ' + JSON.stringify(live.online));

// ---------- Restore a backup: everyone downloads again ----------
const backup = JSON.parse((await owner.call('GET', '/api/backup/export')).__file.content);
await owner.rpc('restore_begin');
await owner.call('POST', '/api/backup/import', { data: backup });
r = await owner.sync();
ok(r.refused === 0 && r.sent > 5, 'restored data sent up: ' + JSON.stringify({ sent: r.sent, refused: r.refused }));
r = await shop.sync();
ok(r.reset === true, 'shop downloaded everything again after the restore');
ok(await stockOf(shop, S1, km.id) === 7 && (await shop.sql('SELECT COUNT(*) AS n FROM sales'))[0].n === 4, 'shop data back after restore');

// ---------- A removed device stops working ----------
await owner.rpc('remove_device', { p_id: (await wh.system('info')).device.id });
await assert.rejects(wh.sync(), /removed/);
checks++;

for (const d of [owner, shop, wh]) await d.stop();
console.log(`\nAll ${checks} sync checks passed.`);
process.exit(0);
