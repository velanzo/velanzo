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

// ---------- Only the approved, confirmed email can become the owner ----------
await db.query("insert into owner_allow values ('Owner@Shop.pk')"); // (case does not matter)
const U = (n) => 'dddddddd-0000-0000-0000-00000000000' + n;
await db.query("insert into auth.users values ($1, 'stranger@example.com', now()), ($2, 'owner@shop.pk', null), ($3, null, now()), ($4, 'owner@shop.pk', now()), ($5, 'owner@shop.pk', now())",
  [U(1), U(2), U(3), 'aaaaaaaa-0000-0000-0000-000000000001', U(5)]);
const refuseOwner = async (uid, re, msg) => { await assert.rejects(cloudRpc(uid, 'create_owner', {}), re, msg); checks++; };
await refuseOwner(U(1), /not approved/, 'a stranger with a confirmed email cannot become the owner');
await refuseOwner(U(2), /Confirm your email/, 'the approved email, not confirmed, cannot become the owner');
await refuseOwner(U(3), /email address/, 'an anonymous sign-in cannot become the owner');
await refuseOwner(null, /Sign in first/, 'nobody signed in cannot become the owner');

// ---------- The owner starts the business on a laptop ----------
const owner = device('owner', 'aaaaaaaa-0000-0000-0000-000000000001');
await owner.rpc('create_owner', { p_email: 'owner@shop.pk' });
const od = await owner.rpc('register_owner_device', { p_label: 'Owner laptop', p_now: '2026-10-16 09:00:00' });
await owner.system('setupCloud', { ...od, label: 'Owner laptop' });
await owner.system('startBusiness', { business_name: 'Velanzo Test', owner_name: 'Owner', pin: '1234' });
const me = await owner.call('GET', '/api/me');
ok((await db.query('select email from owners')).rows[0].email === 'owner@shop.pk', 'the approved email became the owner');
await refuseOwner(U(5), /already has an owner/, 'even the approved email cannot make a second owner');
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

// ---------- Shop and warehouse people sign in with the user ID and password the owner made ----------
await owner.rpc('set_user_login', { p_user: ahmed.id, p_login: 'Ahmed', p_password: 'ahmed-pw-1' });
await owner.rpc('set_user_login', { p_user: bilal.id, p_login: 'bilal', p_password: 'bilal-pw-1' });
async function join(name, uid, label, login, password) {
  const d = device(name, uid);
  const info = await d.rpc('login_with_id', { p_login: login, p_password: password, p_label: label, p_now: '2026-10-16 09:10:00' });
  assert.ok(info.ok, 'sign in failed: ' + info.error);
  await d.system('setupCloud', { ...info, label });
  await d.system('bindUser', info.user_id);
  await d.sync();
  return d;
}
const shop = await join('shop', 'bbbbbbbb-0000-0000-0000-000000000002', 'Shop 1 counter', 'AHMED', 'ahmed-pw-1');
const wh = await join('warehouse', 'cccccccc-0000-0000-0000-000000000003', 'Warehouse PC', 'bilal', 'bilal-pw-1');
const lu = await shop.call('GET', '/api/login-users');
ok(lu.users.map((u) => u.name).join() === 'Ahmed' && lu.bound === true, 'the shop computer belongs to Ahmed alone (bound), the user ID is not case-sensitive');
ok((await shop.system('info')).device.location_id === S1 && (await wh.system('info')).device.location_id === WH, 'each computer is at its person\'s place');
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

// ---------- Only the owner creates shops, warehouses, people and computers ----------
const shopDev = (await shop.system('info')).device.id;
t = await tamper([{ t: 'locations', r: { id: 555, name: 'Sneaky shop', code: 'SN', type: 'shop', active: 1, created_at: now } }]);
ok(!t.ok && /Only the owner/.test(t.error), 'a shop computer cannot create a shop: ' + t.error);
t = await tamper([{ t: 'users', r: { id: 556, name: 'Ghost', role: 'staff', location_id: S1, active: 1, created_at: now } }]);
ok(!t.ok && /Only the owner/.test(t.error), 'a shop computer cannot add a person: ' + t.error);
const pinBefore = (await db.query('select pin_hash from users where id = $1', [me.user.id])).rows[0].pin_hash;
const evil = (await shop.rpc('push', { p_device: shopDev, p_user: me.user.id,
  p_groups: [{ grp: 'evil-owner-pin', rows: [{ t: 'users', r: { id: me.user.id, name: 'Owner', role: 'admin', pin_salt: 'x', pin_hash: 'y', active: 1, created_at: now } }] }] })).results[0];
ok(!evil.ok && (await db.query('select pin_hash from users where id = $1', [me.user.id])).rows[0].pin_hash === pinBefore, 'a shop computer cannot change the owner\'s PIN, even pretending to be the owner');
for (const [fn, args] of [['set_user_login', { p_user: ahmed.id, p_login: 'hacker', p_password: 'hacker-pw' }], ['list_user_logins', {}], ['remove_device', { p_id: shopDev }], ['restore_begin', {}], ['register_owner_device', { p_label: 'x' }]]) {
  await assert.rejects(shop.rpc(fn, args), /Only the owner/, fn + ' is owner only');
  checks++;
}

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

// ---------- Forgotten PIN: the owner approves with a link sent to their email ----------
const whDev = (await wh.system('info')).device.id;
let req = await shop.rpc('request_pin_reset', { p_device: shopDev, p_user: ahmed.id });
ok(req.id && req.email === 'owner@shop.pk', 'Ahmed asks for a new PIN; the link goes to the owner email');
const status = (d, dev, id) => d.rpc('check_pin_reset', { p_device: dev, p_id: id });
ok(await status(shop, shopDev, req.id) === 'pending', 'waiting for the owner');
await assert.rejects(shop.rpc('use_pin_reset', { p_device: shopDev, p_id: req.id }), /not approved/); checks++;
await assert.rejects(shop.rpc('list_pin_resets', {}), /Only the owner/); checks++;
await assert.rejects(shop.rpc('decide_pin_reset', { p_id: req.id, p_approve: true }), /Only the owner/); checks++;
const waiting = await owner.rpc('list_pin_resets', {});
ok(waiting.length === 1 && waiting[0].name === 'Ahmed' && waiting[0].place === 'Shop 1', 'the owner sees who is waiting: ' + JSON.stringify(waiting));
ok(await status(wh, whDev, req.id) === 'unknown', 'another computer cannot see the request');
await owner.rpc('decide_pin_reset', { p_id: req.id, p_approve: true });
ok(await status(shop, shopDev, req.id) === 'approved', 'approved');
await shop.rpc('use_pin_reset', { p_device: shopDev, p_id: req.id });
ok(await status(shop, shopDev, req.id) === 'used', 'the permission is used up after one PIN change');
await assert.rejects(shop.rpc('use_pin_reset', { p_device: shopDev, p_id: req.id }), /not approved/); checks++;
await assert.rejects(shop.rpc('request_pin_reset', { p_device: shopDev, p_user: bilal.id }), /does not work at this place/); checks++;
await assert.rejects(shop.rpc('request_pin_reset', { p_device: shopDev, p_user: me.user.id }), /only be reset on an owner computer/); checks++;
req = await shop.rpc('request_pin_reset', { p_device: shopDev, p_user: ahmed.id });
await owner.rpc('decide_pin_reset', { p_id: req.id, p_approve: false });
ok(await status(shop, shopDev, req.id) === 'refused', 'the owner can refuse');
await assert.rejects(owner.rpc('decide_pin_reset', { p_id: req.id, p_approve: true }), /no longer waiting/); checks++;
req = await shop.rpc('request_pin_reset', { p_device: shopDev, p_user: ahmed.id });
await db.query("update pin_resets set created_at = now() - interval '31 minutes' where id = $1", [req.id]);
ok(await status(shop, shopDev, req.id) === 'expired' && (await owner.rpc('list_pin_resets', {})).length === 0, 'an old request expires');
await assert.rejects(owner.rpc('decide_pin_reset', { p_id: req.id, p_approve: true }), /no longer waiting/); checks++;
req = await shop.rpc('request_pin_reset', { p_device: shopDev, p_user: ahmed.id });
await owner.rpc('decide_pin_reset', { p_id: req.id, p_approve: true });
await db.query("update pin_resets set decided_at = now() - interval '16 minutes' where id = $1", [req.id]);
ok(await status(shop, shopDev, req.id) === 'expired', 'an approval that is not used within 15 minutes expires');
await owner.rpc('request_pin_reset', { p_device: (await owner.system('info')).device.id, p_user: me.user.id });
ok(true, 'the owner can ask too (on an owner computer)');
await assert.rejects((async () => { for (let i = 0; i < 6; i++) await shop.rpc('request_pin_reset', { p_device: shopDev, p_user: ahmed.id }); })(), /Too many requests/); checks++;
ok(true, 'too many requests are stopped');

// ---------- The cloud is missing a person: the owner computer can send places and people again ----------
await db.query('delete from users where id = $1', [bilal.id]);
await assert.rejects(owner.rpc('set_user_login', { p_user: bilal.id, p_login: 'bilal2', p_password: 'bilal-pw-2' }), /not saved in the cloud yet/); checks++;
await owner.system('requeue', ['settings', 'locations', 'users']);
r = await owner.sync();
ok(r.refused === 0 && (await db.query('select 1 from users where id = $1', [bilal.id])).rows.length === 1, 'the person is back in the cloud after sending again');
await owner.rpc('set_user_login', { p_user: bilal.id, p_login: 'bilal', p_password: 'bilal-pw-1' });
ok(true, 'and a login can be made for them again');
await assert.rejects(shop.system('requeue', ['locations']), /Only the owner/); checks++;

// ---------- A problem on the cloud's side is not a refusal: the change is kept and sent again ----------
await owner.call('POST', '/api/expenses', { date: '2026-10-16', category: 'Tea', amount: 55, location_id: S1 });
const waitingBefore = (await owner.system('outbox', 5000)).length;
const flaky = createSyncer({ system: (n, ...args) => owner.system(n, ...args),
  rpc: async (fn, args) => (fn === 'push' ? { results: args.p_groups.map((g) => ({ grp: g.grp, ok: false, retry: true, error: 'the cloud had a hiccup' })) } : owner.rpc(fn, args)) });
await assert.rejects(flaky.syncOnce(), /had a problem saving/); checks++;
ok((await owner.system('outbox', 5000)).length === waitingBefore && waitingBefore > 0, 'after a problem on the cloud side the change is still waiting (not thrown away)');
r = await owner.sync();
ok(r.refused === 0 && (await owner.system('outbox', 5000)).length === 0, 'and it is sent when the cloud works again');

// ---------- The SQL files must not hold a DELETE with no WHERE (Supabase refuses those) ----------
const fsm = await import('node:fs');
const mdir = new URL('../supabase/migrations/', import.meta.url);
const sqlCode = (f) => fsm.readFileSync(new URL(f, mdir), 'utf8').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const unsafeDelete = /\bdelete\s+from\s+\w+\s*;/i;
for (const f of fsm.readdirSync(mdir).filter((x) => x.endsWith('.sql') && x >= '20261017')) {
  ok(!unsafeDelete.test(sqlCode(f)), f + ': no DELETE without WHERE');
}
// (the first file was run before this rule existed; part 3 replaces its one function)
ok(unsafeDelete.test(sqlCode('20261016000000_velanzo.sql')) && !unsafeDelete.test(sqlCode('20261018000000_push_fix.sql')), 'the one old unsafe DELETE is replaced by part 3');

// ---------- Purchase orders: ordered today, counted into stock when the goods arrive ----------
const henley = (await wh.call('POST', '/api/products', { name: 'Henley Shirt', category: 'Shirt', cost_price: 800, sale_price: 1800, variants: [{ color: 'Black' }] }))[0];
const order = await wh.call('POST', '/api/purchases', { order: true, expected_date: '2026-10-30', supplier_id: sup.id, location_id: WH, items: [{ product_id: henley.id, qty: 10, cost: 800, sale_price: 1850 }] });
ok(await stockOf(wh, WH, henley.id) === 0, 'an order adds nothing to stock');
const ordRow = (await wh.sql('SELECT status, expected_date, total, total_qty FROM purchases WHERE id = ?', [order.id]))[0];
ok(ordRow.status === 'ordered' && ordRow.expected_date === '2026-10-30' && ordRow.total === 8000 && ordRow.total_qty === 10, 'the order is saved: 10 pieces, 8000, due 30 Oct');
r = await wh.sync();
ok(r.refused === 0, 'the order reaches the cloud');
ok((await db.query("select status from purchases where id = $1", [order.id])).rows[0].status === 'ordered' && await cloudStock(WH, henley.id) === 0, 'cloud: ordered, no stock');
const dueBefore = Number((await wh.call('GET', '/api/suppliers/' + sup.id)).supplier.purchased);
// ten days later: 9 arrive
const lines = (await wh.call('GET', '/api/purchases/' + order.id)).items;
await wh.call('POST', `/api/purchases/${order.id}/receive`, { invoice_no: 'SUP-77', paid: 3000, items: [{ id: lines[0].id, qty: 9, cost: 820 }] });
ok(await stockOf(wh, WH, henley.id) === 9, 'received 9 of the 10 ordered: stock is 9');
const got = await wh.call('GET', '/api/purchases/' + order.id);
ok(got.status === 'done' && got.total_qty === 9 && got.total === 7380 && got.paid === 3000 && got.invoice_no === 'SUP-77' && got.items[0].ordered_qty === 10 && got.received_at, 'order is now a received purchase: 9 pieces, 7380, ordered 10 kept');
ok((await wh.sql('SELECT cost_price, sale_price FROM products WHERE id = ?', [henley.id]))[0].sale_price === 1850, 'the planned sale price is applied on arrival');
await assert.rejects(wh.call('POST', `/api/purchases/${order.id}/receive`, { items: [] }), /already received/); checks++;
r = await wh.sync();
ok(r.refused === 0, 'receiving reaches the cloud without a refusal: ' + JSON.stringify(r));
ok(await cloudStock(WH, henley.id) === 9, 'cloud stock is 9 after receiving');
const cp = (await db.query('select status, total_qty, total, paid from purchases where id = $1', [order.id])).rows[0];
ok(cp.status === 'done' && cp.total_qty === 9 && Number(cp.total) === 7380, 'cloud purchase updated');
ok((await db.query('select qty, cost, ordered_qty from purchase_items where purchase_id = $1', [order.id])).rows[0].qty === 9, 'cloud purchase line updated');
await owner.sync();
ok(await stockOf(owner, WH, henley.id) === 9, 'the owner computer sees the stock too');
ok(Number((await wh.call('GET', '/api/suppliers/' + sup.id)).supplier.purchased) - dueBefore === 7380, 'it counts as bought (7380) only once received, not when ordered');
// nothing arrived / cancel
const o2 = await wh.call('POST', '/api/purchases', { order: true, location_id: WH, items: [{ product_id: henley.id, qty: 5, cost: 800 }] });
const l2 = (await wh.call('GET', '/api/purchases/' + o2.id)).items;
await assert.rejects(wh.call('POST', `/api/purchases/${o2.id}/receive`, { items: [{ id: l2[0].id, qty: 0 }] }), /Nothing arrived/); checks++;
await wh.call('POST', `/api/purchases/${o2.id}/cancel-order`, { reason: 'supplier ran out' });
ok(await stockOf(wh, WH, henley.id) === 9 && (await wh.call('GET', '/api/purchases/' + o2.id)).status === 'void', 'a cancelled order changes no stock');
await assert.rejects(wh.call('POST', `/api/purchases/${o2.id}/cancel-order`, {}), /not arrived/); checks++;
r = await wh.sync();
ok(r.refused === 0 && (await db.query('select status from purchases where id = $1', [o2.id])).rows[0].status === 'void', 'the cancellation reaches the cloud');
// the cloud keeps its rules: a shop cannot order or receive, and a normal purchase line never changes
await assert.rejects(shop.call('POST', '/api/purchases', { order: true, items: [{ product_id: henley.id, qty: 1, cost: 1 }] }), /./); checks++;
const normal = (await db.query("select i.id, i.purchase_id, i.qty from purchase_items i join purchases p on p.id = i.purchase_id where i.ordered_qty is null limit 1")).rows[0];
const evilLine = (await wh.rpc('push', { p_device: whDev, p_user: bilal.id, p_groups: [{ grp: 'evil-line-' + Math.random(), rows: [{ t: 'purchase_items', r: { id: normal.id, purchase_id: normal.purchase_id, product_id: km.id, qty: 999, cost: 1 } }] }] })).results[0];
ok((await db.query('select qty from purchase_items where id = $1', [normal.id])).rows[0].qty === normal.qty, 'a line of a normal purchase cannot be changed afterwards');
const o3 = await wh.call('POST', '/api/purchases', { order: true, location_id: WH, items: [{ product_id: henley.id, qty: 4, cost: 800 }] });
await wh.sync();
const evilStatus = (await shop.rpc('push', { p_device: shopDev, p_user: ahmed.id, p_groups: [{ grp: 'evil-po-' + Math.random(), rows: [{ t: 'purchases', r: { ...(await db.query('select * from purchases where id = $1', [o3.id])).rows[0], status: 'done' } }] }] })).results[0];
ok(!evilStatus.ok, 'a shop cannot receive the warehouse order: ' + evilStatus.error);

// ---------- Drafts: purchase orders and dispatches start as a draft; reset to draft ----------
{
  const h0 = await stockOf(wh, WH, henley.id);
  const dr = await wh.call('POST', '/api/purchases', { draft: true, supplier_id: sup.id, location_id: WH, items: [{ product_id: henley.id, qty: 3, cost: 800 }, { product_id: km.id, qty: 2, cost: 1000 }] });
  ok(dr.status === 'draft' && await stockOf(wh, WH, henley.id) === h0, 'a draft purchase moves no stock');
  r = await wh.sync();
  ok(r.refused === 0 && (await db.query('select status from purchases where id = $1', [dr.id])).rows[0].status === 'draft', 'the draft reaches the cloud');
  await wh.call('PUT', '/api/purchases/' + dr.id, { supplier_id: sup.id, invoice_no: 'Q-1', items: [{ product_id: henley.id, qty: 6, cost: 810 }] });
  r = await wh.sync();
  const cl = (await db.query('select qty, cost from purchase_items where purchase_id = $1', [dr.id])).rows;
  ok(r.refused === 0 && cl.length === 1 && cl[0].qty === 6 && Number(cl[0].cost) === 810, 'changing a draft (one line taken out, one changed) reaches the cloud: ' + JSON.stringify(r.refusedMessages));
  await wh.call('POST', `/api/purchases/${dr.id}/confirm`);
  await wh.call('POST', `/api/purchases/${dr.id}/reset`);
  r = await wh.sync();
  ok(r.refused === 0 && (await db.query('select status from purchases where id = $1', [dr.id])).rows[0].status === 'draft', 'confirmed, then reset to draft: the cloud agrees');
  await wh.call('POST', `/api/purchases/${dr.id}/confirm`);
  const ln = (await wh.call('GET', '/api/purchases/' + dr.id)).items;
  await wh.call('POST', `/api/purchases/${dr.id}/receive`, { items: ln.map((l) => ({ id: l.id, qty: l.qty })) });
  ok(await stockOf(wh, WH, henley.id) === h0 + 6, 'confirmed and received: +6 in stock');
  await assert.rejects(wh.call('POST', `/api/purchases/${dr.id}/reset`), /Only the owner/); checks++;
  r = await wh.sync();
  ok(r.refused === 0 && await cloudStock(WH, henley.id) === h0 + 6, 'the cloud has the received draft: ' + JSON.stringify(r.refusedMessages) + ' cloud ' + await cloudStock(WH, henley.id) + ' h0 ' + h0);
  const evil = await wh.rpc('push', { p_device: whDev, p_user: bilal.id, p_groups: [{ grp: 'evil-reset-' + Math.random(), rows: [{ t: 'purchases', r: { ...(await db.query('select * from purchases where id = $1', [dr.id])).rows[0], status: 'draft', rev: undefined, synced_at: undefined } }] }] });
  ok(!evil.results[0].ok && (await db.query('select status from purchases where id = $1', [dr.id])).rows[0].status === 'done', 'a tampered warehouse app cannot reset received goods: ' + evil.results[0].error);
  await owner.sync();
  await owner.call('POST', `/api/purchases/${dr.id}/reset`);
  r = await owner.sync();
  ok(r.refused === 0 && await cloudStock(WH, henley.id) === h0 && (await db.query('select status from purchases where id = $1', [dr.id])).rows[0].status === 'draft', 'the owner resets received goods: the 6 pieces leave stock again, everywhere');
  await wh.sync();
  ok(await stockOf(wh, WH, henley.id) === h0 && (await wh.call('GET', '/api/purchases/' + dr.id)).status === 'draft', 'the warehouse sees it back as a draft');
  await wh.call('PUT', '/api/purchases/' + dr.id, { supplier_id: sup.id, items: [{ product_id: henley.id, qty: 5, cost: 810 }] });
  r = await wh.sync();
  ok(r.refused === 0, 'and can change it again');

  // a direct purchase (no order) reset by the owner becomes an editable draft too
  const dp = await wh.call('POST', '/api/purchases', { location_id: WH, items: [{ product_id: kl.id, qty: 4, cost: 1000 }] });
  await wh.sync(); await owner.sync();
  await owner.call('POST', `/api/purchases/${dp.id}/reset`);
  r = await owner.sync();
  ok(r.refused === 0 && (await db.query('select ordered_qty from purchase_items where purchase_id = $1', [dp.id])).rows[0].ordered_qty === 4, 'goods that arrived without an order: the owner resets them to an editable draft');
  await wh.sync();
  await wh.call('PUT', '/api/purchases/' + dp.id, { location_id: WH, items: [{ product_id: kl.id, qty: 3, cost: 1000 }] });
  r = await wh.sync();
  ok(r.refused === 0 && (await db.query('select qty from purchase_items where purchase_id = $1', [dp.id])).rows[0].qty === 3, 'the warehouse can change that draft');

  // dispatches
  const m0 = await stockOf(wh, WH, km.id), s0 = await cloudStock(S1, km.id);
  const dd = await wh.call('POST', '/api/dispatches', { draft: true, from_location_id: WH, to_location_id: S1, items: [{ product_id: km.id, qty: 2 }] });
  ok(dd.status === 'draft' && await stockOf(wh, WH, km.id) === m0, 'a draft dispatch moves no stock');
  r = await wh.sync(); await shop.sync();
  ok(r.refused === 0 && !(await shop.call('GET', '/api/dispatches', null, {})).some((d) => d.id === dd.id) && await shop.status('GET', '/api/dispatches/' + dd.id) === 403, 'the shop does not see a draft parcel');
  await wh.call('PUT', '/api/dispatches/' + dd.id, { to_location_id: S1, items: [{ product_id: km.id, qty: 3 }, { product_id: kl.id, qty: 1 }] });
  r = await wh.sync();
  ok(r.refused === 0 && (await db.query('select count(*)::int n from dispatch_items where dispatch_id = $1', [dd.id])).rows[0].n === 2, 'changing a draft parcel reaches the cloud: ' + JSON.stringify(r.refusedMessages));
  await wh.call('POST', `/api/dispatches/${dd.id}/send`, { force: true });
  ok(await stockOf(wh, WH, km.id) === m0 - 3, 'sent: the pieces leave the warehouse');
  await wh.call('POST', `/api/dispatches/${dd.id}/reset`);
  ok(await stockOf(wh, WH, km.id) === m0, 'reset to draft while on the way: back in the warehouse');
  await wh.call('POST', `/api/dispatches/${dd.id}/send`, { force: true });
  r = await wh.sync();
  ok(r.refused === 0 && await cloudStock(WH, km.id) === m0 - 3 && (await db.query('select status from dispatches where id = $1', [dd.id])).rows[0].status === 'in_transit', 'send, reset, send again: the cloud agrees');
  await shop.sync();
  const sd = await shop.call('GET', '/api/dispatches/' + dd.id);
  await shop.call('POST', `/api/dispatches/${dd.id}/receive`, { items: sd.items.map((i) => ({ id: i.id, received_qty: i.qty })) });
  r = await shop.sync();
  ok(r.refused === 0 && await cloudStock(S1, km.id) === s0 + 3, 'the shop receives it');
  await wh.sync();
  await assert.rejects(wh.call('POST', `/api/dispatches/${dd.id}/reset`), /Only the owner/); checks++;
  await owner.sync();
  await owner.call('POST', `/api/dispatches/${dd.id}/reset`);
  r = await owner.sync();
  ok(r.refused === 0 && await cloudStock(S1, km.id) === s0 && await cloudStock(WH, km.id) === m0, 'the owner resets a received parcel: the shop gives the pieces back to the warehouse');
  await shop.sync(); await wh.sync();
  ok(await stockOf(shop, S1, km.id) === s0 && await stockOf(wh, WH, km.id) === m0 && (await wh.call('GET', '/api/dispatches/' + dd.id)).status === 'draft', 'both places agree, and it is a draft again');
  await wh.call('POST', `/api/dispatches/${dd.id}/cancel`);
  r = await wh.sync();
  ok(r.refused === 0 && await stockOf(wh, WH, km.id) === m0, 'a draft parcel is cancelled without moving stock');

  // the owner resets a bill: it is cancelled and its lines come back for a held bill
  const k0 = await stockOf(shop, S1, kl.id);
  const bill = await shop.call('POST', '/api/sales', { location_id: S1, items: [{ product_id: kl.id, qty: 1 }] });
  await shop.sync(); await owner.sync();
  await assert.rejects(shop.call('POST', `/api/sales/${bill.id}/reset`), /./); checks++;
  const back = await owner.call('POST', `/api/sales/${bill.id}/reset`);
  ok(back.items.length === 1 && back.items[0].product_id === kl.id && back.items[0].qty === 1, 'resetting a bill gives its lines back');
  r = await owner.sync(); await shop.sync();
  ok(r.refused === 0 && await stockOf(shop, S1, kl.id) === k0 && (await db.query('select status, void_reason from sales where id = $1', [bill.id])).rows[0].void_reason === 'Reset to draft', 'the bill is cancelled everywhere and the piece is back in the shop');
}

// ---------- User ID and password: the rules ----------
await assert.rejects(owner.rpc('set_user_login', { p_user: ahmed.id, p_login: 'bilal', p_password: 'whatever1' }), /already taken/); checks++;
await assert.rejects(owner.rpc('set_user_login', { p_user: ahmed.id, p_login: 'a b', p_password: 'whatever1' }), /3 to 30/); checks++;
await assert.rejects(owner.rpc('set_user_login', { p_user: ahmed.id, p_login: 'ahmed', p_password: '123' }), /at least 6/); checks++;
await owner.rpc('set_user_login', { p_user: ahmed.id, p_login: 'ahmed.shop1', p_password: null });
const ids = await owner.rpc('list_user_logins', {});
ok(ids[ahmed.id] === 'ahmed.shop1' && ids[bilal.id] === 'bilal' && !JSON.stringify(ids).includes('pw'), 'the owner sees the user IDs (never the passwords); the ID can change without a new password');
ok(!(await db.query('select pw_hash from user_logins where user_id = $1', [ahmed.id])).rows[0].pw_hash.includes('ahmed-pw-1'), 'passwords are stored hashed');
const guest = device('guest', 'dddddddd-0000-0000-0000-0000000000a1');
let bad = await guest.rpc('login_with_id', { p_login: 'ahmed.shop1', p_password: 'wrong-password', p_label: 'x' });
ok(bad.ok === false && /Wrong user ID or password/.test(bad.error), 'a wrong password is refused');
bad = await guest.rpc('login_with_id', { p_login: 'nobody', p_password: 'wrong-password', p_label: 'x' });
ok(bad.ok === false && /Wrong user ID or password/.test(bad.error), 'an unknown user ID gives the same answer');
for (let i = 0; i < 8; i++) await guest.rpc('login_with_id', { p_login: 'ahmed.shop1', p_password: 'wrong-' + i, p_label: 'x' });
bad = await guest.rpc('login_with_id', { p_login: 'ahmed.shop1', p_password: 'ahmed-pw-1', p_label: 'x' });
ok(bad.ok === false && /Too many wrong tries/.test(bad.error), 'after 8 wrong tries even the right password waits (counted per user ID, so a new anonymous account does not help)');
await db.query('delete from login_attempts');
const guestIn = await guest.rpc('login_with_id', { p_login: 'AHMED.SHOP1', p_password: 'ahmed-pw-1', p_label: 'Second computer' });
ok(guestIn.ok && guestIn.location_id === S1 && guestIn.user_id === ahmed.id, 'the right password signs in (any capitals in the ID)');
const guestIn2 = await guest.rpc('login_with_id', { p_login: 'ahmed.shop1', p_password: 'ahmed-pw-1', p_label: 'Second computer' });
ok((await db.query('select count(*)::int n from devices where auth_uid = $1 and active = 1', ['dddddddd-0000-0000-0000-0000000000a1'])).rows[0].n === 1 && guestIn2.id !== guestIn.id, 'one computer, one sign-in: an earlier sign-in of the same computer is closed');
await owner.rpc('set_user_login', { p_user: ahmed.id, p_login: 'ahmed.shop1', p_password: 'new-password-2' });
bad = await guest.rpc('login_with_id', { p_login: 'ahmed.shop1', p_password: 'ahmed-pw-1', p_label: 'x' });
ok(bad.ok === false, 'after the owner sets a new password the old one stops working');
await db.query("update users set active = 0 where id = $1", [bilal.id]);
bad = await guest.rpc('login_with_id', { p_login: 'bilal', p_password: 'bilal-pw-1', p_label: 'x' });
ok(bad.ok === false && /switched off/.test(bad.error), 'a switched-off user cannot sign in');
await db.query("update users set active = 1 where id = $1", [bilal.id]);
await guest.rpc('release_device', { p_device: guestIn2.id });
ok((await db.query('select active from devices where id = $1', [guestIn2.id])).rows[0].active === 0, 'signing out closes the computer in the cloud');
await shop.rpc('release_device', { p_device: guestIn.id });
await shop.rpc('release_device', { p_device: guestIn2.id });
ok((await db.query('select active from devices where id = $1', [shopDev])).rows[0].active === 1, 'a computer cannot sign out another one');
// a brand-new user: signs in, chooses their own passcode, and it reaches the cloud
const newbie = await owner.call('POST', '/api/users', { name: 'Newbie', role: 'staff', location_id: S1 });
await owner.sync();
await owner.rpc('set_user_login', { p_user: newbie.id, p_login: 'newbie', p_password: 'newbie-pw-1' });
const nb = device('newbie', 'dddddddd-0000-0000-0000-0000000000a2');
const nbIn = await nb.rpc('login_with_id', { p_login: 'newbie', p_password: 'newbie-pw-1', p_label: 'Newbie computer' });
await nb.system('setupCloud', { ...nbIn, label: 'Newbie computer' });
await nb.system('bindUser', nbIn.user_id);
await nb.sync();
const nbUsers = await nb.call('GET', '/api/login-users');
ok(nbUsers.bound && nbUsers.users.length === 1 && nbUsers.users[0].name === 'Newbie' && nbUsers.users[0].has_pin === false, 'a newly signed-in computer shows the one user, who has no passcode yet');
await assert.rejects(nb.system('setFirstPin', { user_id: ahmed.id, pin: '1111' }), /Not allowed/); checks++;
await assert.rejects(nb.system('setFirstPin', { user_id: newbie.id, pin: '12' }), /4 numbers/); checks++;
await assert.rejects(nb.system('setFirstPin', { user_id: newbie.id, pin: '123456' }), /4 numbers/); checks++;
await nb.system('setFirstPin', { user_id: newbie.id, pin: '4321' });
await nb.call('POST', '/api/login', { user_id: newbie.id, pin: '4321' });
r = await nb.sync();
ok(r.refused === 0 && (await db.query('select pin_hash from users where id = $1', [newbie.id])).rows[0].pin_hash, 'the passcode they chose reached the cloud (a person may change their own passcode)');
await assert.rejects(nb.system('setFirstPin', { user_id: newbie.id, pin: '9999' }), /Not allowed/); checks++;
await nb.system('lock');
await nb.system('forgetDevice', {});
ok((await nb.sql('SELECT COUNT(*) AS n FROM users'))[0].n === 0 && (await nb.system('info')).device.id === 0, 'signing out clears the computer (nothing was waiting)');
await nb.stop();
await guest.stop();

// ---------- The computer asks for the passcode every time; while it waits nothing is sent ----------
await shop.call('POST', '/api/sales', { items: [{ product_id: km.id, qty: 1 }] });
await shop.system('lock');
const heldBefore = (await shop.system('outbox', 5000)).length;
await shop.sync();
ok(heldBefore > 0 && (await shop.system('outbox', 5000)).length === heldBefore, 'while the passcode screen is up the changes wait on the computer (the cloud would not know who made them)');
await assert.rejects(shop.system('forgetDevice', {}), /have not reached the cloud/); checks++;
await shop.call('POST', '/api/login', { user_id: ahmed.id, pin: '2222' });
r = await shop.sync();
ok(r.refused === 0 && (await shop.system('outbox', 5000)).length === 0, 'after the passcode they are sent');

// ---------- Discounts on a bill line, and vouchers ----------
const v1 = (await owner.call('POST', '/api/vouchers', { kind: 'amt', value: 300, min_bill: 1000, note: 'Diwali' }))[0];
const vp = await owner.call('POST', '/api/vouchers', { kind: 'pct', value: 10, count: 2, max_uses: 5 });
ok(/^VZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(v1.code) && vp.length === 2 && vp[0].code !== vp[1].code, 'the owner made vouchers with readable codes');
r = await owner.sync();
ok(r.refused === 0, 'vouchers reached the cloud');
await shop.sync();
ok((await shop.sql('SELECT COUNT(*) AS n FROM vouchers'))[0].n === 3, 'the shop computer has the vouchers');
await assert.rejects(shop.call('POST', '/api/vouchers', { kind: 'amt', value: 50 }), /owner/); checks++;
let c = await shop.call('GET', '/api/vouchers/check', null, { code: v1.code.toLowerCase().replace(/-/g, ''), amount: 2000 });
ok(c.ok && c.amount === 300, 'a typed code (small letters, no dashes) works: takes off 300');
c = await shop.call('GET', '/api/vouchers/check', null, { code: v1.code, amount: 500 });
ok(!c.ok && /at least/.test(c.reason), 'a bill below the voucher\'s minimum is refused: ' + c.reason);
c = await shop.call('GET', '/api/vouchers/check', null, { code: 'NOPE-1234', amount: 2000 });
ok(!c.ok && /no voucher/.test(c.reason), 'an unknown code is refused');
const vb = await shop.call('POST', '/api/sales', { items: [{ product_id: km.id, qty: 1 }], voucher: v1.code });
ok(vb.subtotal === 2000 && vb.voucher === 300 && vb.voucher_code === v1.code && vb.total === 1700, 'a bill with the voucher: 2000 - 300 = 1700');
await assert.rejects(shop.call('POST', '/api/sales', { items: [{ product_id: km.id, qty: 1 }], voucher: v1.code }), /already used/); checks++;
await assert.rejects(shop.call('POST', '/api/sales', { items: [{ product_id: km.id, qty: 1, disc: '10%' }] }), /Giving discounts/); checks++;
r = await shop.sync();
ok(r.refused === 0, 'the bill with a voucher reached the cloud');
const cloudBill = (await db.query('select voucher_code, voucher, total from sales where id = $1', [vb.id])).rows[0];
ok(cloudBill.voucher_code === v1.code && cloudBill.voucher === 300 && cloudBill.total === 1700, 'the cloud has the voucher on the bill');
await owner.sync();
const ob = await owner.call('POST', '/api/sales', { location_id: S1, items: [{ product_id: km.id, qty: 2, disc: '10%' }, { product_id: kl.id, qty: 1, disc: '150' }], discount: 200, voucher: vp[0].code });
// (2 x 1800) + 1850 = 5450; bill discount 200 -> 5250; voucher 10% = 525; total 4725
ok(ob.items[0].price === 1800 && ob.items[0].list_price === 2000 && ob.items[1].price === 1850 && ob.subtotal === 5450 && ob.voucher === 525 && ob.total === 4725, 'item discounts, bill discount and voucher add up: ' + ob.total);
await owner.sync(); await shop.sync();
ok((await shop.sql('SELECT list_price FROM sale_items WHERE sale_id = ? ORDER BY id', [ob.id]))[0]?.list_price === 2000, 'item discounts reach the shop computer, with the price before the discount');
const rep2 = await owner.call('GET', '/api/reports', null, { from: '2020-01-01', to: '2099-12-31' });
ok(rep2.summary.discounts >= 525 + 200 + 400 + 150, 'reports count item, bill and voucher discounts together');
await owner.call('POST', `/api/sales/${vb.id}/void`, { reason: 'test' });
c = await owner.call('GET', '/api/vouchers/check', null, { code: v1.code, amount: 2000 });
ok(c.ok, 'cancelling the bill gives the voucher back');
const list = await owner.call('GET', '/api/vouchers');
ok(list.find((v) => v.code === vp[0].code).used === 1 && list.find((v) => v.code === vp[0].code).status === 'ok', 'the voucher list counts how often each was used');
await assert.rejects(owner.call('DELETE', '/api/vouchers/' + vp[0].id), /Switch it off/); checks++;
await owner.call('PUT', '/api/vouchers/' + vp[1].id, { active: false });
c = await owner.call('GET', '/api/vouchers/check', null, { code: vp[1].code, amount: 2000 });
ok(!c.ok && /switched off/.test(c.reason), 'a switched-off voucher is refused');
r = await owner.sync();
ok(r.refused === 0, 'changes to vouchers and the cancelled bill reached the cloud');

// ---------- A removed device stops working ----------
await owner.rpc('remove_device', { p_id: (await wh.system('info')).device.id });
await assert.rejects(wh.sync(), /removed/);
checks++;

for (const d of [owner, shop, wh]) await d.stop();
console.log(`\nAll ${checks} sync checks passed.`);
process.exit(0);
