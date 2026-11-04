// Two owner computers and a shop computer working on the same records at the same time, before they have seen each
// other's changes (normal between two syncs, and for longer without internet). Whatever happens: stock is never counted
// twice, no change is applied on top of stale information, nobody gets stuck, and every computer ends up the same as the cloud.
// Run: node --disable-warning=ExperimentalWarning tools/test-multidevice.mjs
import { Worker } from 'node:worker_threads';
import { startCloud } from './pg-cloud.mjs';
import { createSyncer } from '../web/engine/syncer.js';

const { rpc: cloudRpc, db } = await startCloud();
let passed = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failures.push(msg); console.log('  ✗ FAILED: ' + msg); } };
async function scenario(title, fn) {
  console.log('\n' + title);
  try { await fn(); } catch (e) { failures.push(`${title}: ${e.message}`); console.log('  ✗ STOPPED: ' + e.message); }
}

function device(name, uid) {
  const w = new Worker(new URL('./engine-worker.mjs', import.meta.url));
  let seq = 0;
  const pending = new Map();
  w.on('message', (m) => { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.out) : p.reject(new Error(m.error)); });
  const send = (kind, n, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.postMessage({ id, kind, name: n, args }); });
  const system = (n, ...args) => send('system', n, args);
  const dev = {
    name, uid, system,
    rpc: (fn, args) => cloudRpc(uid, fn, args),
    syncWith(rpcFn) { return createSyncer({ system, rpc: rpcFn }).syncOnce(); },
    sql: (q, p) => send('sql', null, [q, p]),
    async call(method, path, body, query) {
      const r = await send('api', null, [{ method, path, body: body || {}, query: query || {} }]);
      if (r.status !== 200) { const e = new Error(`${name}: ${method} ${path} → ${r.status} ${r.body.error}`); e.status = r.status; throw e; }
      return r.body;
    },
    stop: () => w.terminate(),
  };
  dev.syncer = createSyncer({ system, rpc: dev.rpc });
  dev.sync = () => dev.syncer.syncOnce();
  return dev;
}
const stockAt = async (d, loc, pid) => (await d.sql('SELECT qty FROM stock WHERE location_id = ? AND product_id = ?', [loc, pid]))[0]?.qty ?? 0;
const cloudStock = async (loc, pid) => (await db.query('select qty from stock where location_id = $1 and product_id = $2', [loc, pid])).rows[0]?.qty ?? 0;
const errorsOn = async (d) => (await d.sql('SELECT message FROM sync_errors ORDER BY id')).map((r) => r.message);
const clearErrors = (d) => d.sql('DELETE FROM sync_errors');
// everything two owner computers should agree on
const TABLES = ['locations', 'suppliers', 'products', 'stock', 'movements', 'purchases', 'purchase_items', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses', 'vouchers'];
const snapshot = async (d) => {
  const out = {};
  for (const t of TABLES) {
    const rows = await d.sql(`SELECT * FROM ${t}`);
    out[t] = rows.map((r) => { const { rev, ...rest } = r; return JSON.stringify(Object.entries(rest).sort()); }).sort();
  }
  return out;
};
async function sameEverywhere(a, b, msg) {
  await a.sync(); await b.sync(); await a.sync();
  const [sa, sb] = [await snapshot(a), await snapshot(b)];
  const diff = TABLES.filter((t) => JSON.stringify(sa[t]) !== JSON.stringify(sb[t]));
  ok(!diff.length, `${msg}${diff.length ? ` (different: ${diff.join(', ')})` : ''}`);
}
const rejects = async (p, re, msg) => { try { await p; ok(false, msg + ' (it was allowed)'); } catch (e) { ok(re.test(e.message), `${msg}: ${e.message}`); } };

// ---------- The business: two owner computers and a shop computer ----------
const OWNER = 'aaaaaaaa-0000-0000-0000-000000000001';
await db.query("insert into owner_allow values ('owner@shop.pk') on conflict do nothing");
await db.query("insert into auth.users values ($1, 'owner@shop.pk', now()), ('bbbbbbbb-0000-0000-0000-000000000002', null, now())", [OWNER]);
const A = device('A', OWNER);
await A.rpc('create_owner', { p_email: 'owner@shop.pk' });
await A.system('setupCloud', { ...(await A.rpc('register_owner_device', { p_label: 'Laptop A' })), label: 'Laptop A' });
await A.system('startBusiness', { business_name: 'Test', owner_name: 'Owner', pin: '1234', email: 'owner@shop.pk' });
const me = await A.call('GET', '/api/me');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
const S1 = me.locations.find((l) => l.type === 'shop').id;
const ownerId = me.user.id;
await A.call('PUT', '/api/locations/' + S1, { perms: ['sell', 'returns', 'discount', 'receive', 'expenses', 'add_items', 'void_bills'] });
const ahmed = await A.call('POST', '/api/users', { name: 'Ahmed', role: 'staff', location_id: S1, pin: '2222', perms: ['sell', 'returns', 'receive', 'add_items', 'void_bills'] });
await A.sync();
await A.rpc('set_user_login', { p_user: ahmed.id, p_login: 'ahmed', p_password: 'ahmed-pw-1' });

const B = device('B', OWNER);
await B.system('setupCloud', { ...(await B.rpc('register_owner_device', { p_label: 'Laptop B' })), label: 'Laptop B' });
await B.sync();
await B.call('POST', '/api/login', { user_id: ownerId, pin: '1234' });

const SHOP = device('shop', 'bbbbbbbb-0000-0000-0000-000000000002');
const login = await SHOP.rpc('login_with_id', { p_login: 'ahmed', p_password: 'ahmed-pw-1', p_label: 'Shop counter' });
await SHOP.system('setupCloud', { ...login, label: 'Shop counter' });
await SHOP.system('bindUser', login.user_id);
await SHOP.sync();
await SHOP.call('POST', '/api/login', { user_id: ahmed.id, pin: '2222' });

let itemNo = 0;
async function newItem(stock = 0) {
  const [p] = await A.call('POST', '/api/products', { name: `Item ${++itemNo}`, cost_price: 500, sale_price: 1000, variants: [{}] });
  if (stock) await A.call('POST', '/api/stock/adjust', { product_id: p.id, location_id: WH, mode: 'set', qty: stock, reason: 'start' });
  await A.sync(); await B.sync(); await SHOP.sync();
  return p;
}
const allSynced = async () => { await A.sync(); await B.sync(); await SHOP.sync(); };

// ---------- 1. The same action on two computers ----------
await scenario('1. Two computers receive the same purchase order', async () => {
  const p = await newItem();
  const po = await A.call('POST', '/api/purchases', { location_id: WH, order: true, items: [{ product_id: p.id, qty: 10, cost: 500 }] });
  await allSynced();
  const items = (await A.call('GET', '/api/purchases/' + po.id)).items;
  await A.call('POST', `/api/purchases/${po.id}/receive`, { items: items.map((i) => ({ id: i.id, qty: 10, cost: 500 })) });
  await B.call('POST', `/api/purchases/${po.id}/receive`, { items: items.map((i) => ({ id: i.id, qty: 10, cost: 500 })) });
  await A.sync(); await B.sync();
  ok(await cloudStock(WH, p.id) === 10, `the 10 pieces are counted once (cloud has ${await cloudStock(WH, p.id)})`);
  ok((await errorsOn(B)).length === 1 && /another computer/.test((await errorsOn(B))[0]), 'the second computer is told: ' + ((await errorsOn(B))[0] || 'nothing'));
  ok(await stockAt(B, WH, p.id) === 10, 'the second computer corrects itself to 10');
  await clearErrors(B);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('2. The owner and the shop both receive the same parcel', async () => {
  const p = await newItem(20);
  const d = await A.call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: p.id, qty: 5 }] });
  await allSynced();
  await A.call('POST', `/api/dispatches/${d.id}/receive`, { items: [] });
  await SHOP.call('POST', `/api/dispatches/${d.id}/receive`, { items: [] });
  await SHOP.sync(); await A.sync();
  ok(await cloudStock(S1, p.id) === 5, `the shop has 5, not 10 (cloud has ${await cloudStock(S1, p.id)})`);
  ok(await stockAt(A, S1, p.id) === 5 && await stockAt(SHOP, S1, p.id) === 5, 'both computers show 5');
  await clearErrors(A); await clearErrors(SHOP);
});

await scenario('3. Two computers cancel the same bill', async () => {
  const p = await newItem(10);
  const bill = await A.call('POST', '/api/sales', { location_id: WH, items: [{ product_id: p.id, qty: 2 }] });
  await allSynced();
  await A.call('POST', `/api/sales/${bill.id}/void`, { reason: 'one' });
  await B.call('POST', `/api/sales/${bill.id}/void`, { reason: 'two' });
  await A.sync(); await B.sync();
  ok(await cloudStock(WH, p.id) === 10, `the 2 pieces come back once (cloud has ${await cloudStock(WH, p.id)}, should be 10)`);
  await clearErrors(B);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('4. One computer cancels a parcel while another receives it', async () => {
  const p = await newItem(20);
  const d = await A.call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: p.id, qty: 5 }] });
  await allSynced();
  await A.call('POST', `/api/dispatches/${d.id}/cancel`, {});
  await SHOP.call('POST', `/api/dispatches/${d.id}/receive`, { items: [] });
  await A.sync(); await SHOP.sync(); await A.sync();
  const total = await cloudStock(WH, p.id) + await cloudStock(S1, p.id);
  ok(total === 20, `no pieces appear from nowhere (cloud total ${total}, should be 20)`);
  ok(await stockAt(SHOP, S1, p.id) === await cloudStock(S1, p.id), 'the shop computer agrees with the cloud');
  await clearErrors(A); await clearErrors(SHOP);
});

await scenario('5. Two computers change the same draft order', async () => {
  const p = await newItem(), q = await newItem();
  const po = await A.call('POST', '/api/purchases', { location_id: WH, draft: true, items: [{ product_id: p.id, qty: 1, cost: 500 }] });
  await allSynced();
  await A.call('PUT', '/api/purchases/' + po.id, { items: [{ product_id: p.id, qty: 3, cost: 500 }] });
  await B.call('PUT', '/api/purchases/' + po.id, { items: [{ product_id: q.id, qty: 7, cost: 500 }] });
  await A.sync(); await B.sync(); await A.sync();
  const lines = (await db.query('select qty from purchase_items where purchase_id = $1', [po.id])).rows;
  ok(lines.length === 1, `the order has one set of lines, not both mixed together (${lines.length} lines)`);
  const head = (await db.query('select total_qty from purchases where id = $1', [po.id])).rows[0];
  ok(lines.reduce((a, l) => a + l.qty, 0) === head.total_qty, 'its total matches its lines');
  await clearErrors(B);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('6. One computer confirms a draft while another cancels it', async () => {
  const p = await newItem();
  const po = await A.call('POST', '/api/purchases', { location_id: WH, draft: true, items: [{ product_id: p.id, qty: 1, cost: 500 }] });
  await allSynced();
  await A.call('POST', `/api/purchases/${po.id}/confirm`);
  await B.call('POST', `/api/purchases/${po.id}/cancel-order`, { reason: 'no' });
  await A.sync(); await B.sync();
  ok((await db.query('select status from purchases where id = $1', [po.id])).rows[0].status === 'ordered', 'the first one counts (confirmed)');
  ok((await B.sql('SELECT status FROM purchases WHERE id = ?', [po.id]))[0].status === 'ordered', 'the other computer shows it confirmed, and was told');
  await clearErrors(B);
});

// ---------- 2. One computer working alone must never be stopped by these checks ----------
await scenario('7. One computer doing several steps quickly is not stopped', async () => {
  const p = await newItem();
  const po = await A.call('POST', '/api/purchases', { location_id: WH, draft: true, items: [{ product_id: p.id, qty: 4, cost: 500 }] });
  await A.call('PUT', '/api/purchases/' + po.id, { items: [{ product_id: p.id, qty: 6, cost: 500 }] });
  await A.call('POST', `/api/purchases/${po.id}/confirm`);
  const items = (await A.call('GET', '/api/purchases/' + po.id)).items;
  await A.call('POST', `/api/purchases/${po.id}/receive`, { items: items.map((i) => ({ id: i.id, qty: 6, cost: 500 })) });
  let r = await A.sync();
  ok(r.refused === 0 && await cloudStock(WH, p.id) === 6, 'draft, edit, confirm, receive without syncing in between: all accepted, 6 pieces');
  // now again, with a sync after each step but the row still "old" on this computer
  await A.call('POST', `/api/purchases/${po.id}/reset`);
  r = await A.sync();
  ok(r.refused === 0 && await cloudStock(WH, p.id) === 0, 'reset to draft accepted, the pieces leave');
  await A.call('POST', `/api/purchases/${po.id}/confirm`);
  await A.sync();
  await A.call('POST', `/api/purchases/${po.id}/cancel-order`, { reason: 'changed my mind' });
  r = await A.sync();
  ok(r.refused === 0 && (await errorsOn(A)).length === 0, 'confirm, then cancel: accepted');
  await B.sync();
});

await scenario('8. Taking turns on two computers is fine', async () => {
  const p = await newItem();
  const po = await A.call('POST', '/api/purchases', { location_id: WH, draft: true, items: [{ product_id: p.id, qty: 2, cost: 500 }] });
  await A.sync(); await B.sync();
  await B.call('POST', `/api/purchases/${po.id}/confirm`);
  await B.sync(); await A.sync();
  const items = (await A.call('GET', '/api/purchases/' + po.id)).items;
  await A.call('POST', `/api/purchases/${po.id}/receive`, { items: items.map((i) => ({ id: i.id, qty: 2, cost: 500 })) });
  const r = await A.sync();
  ok(r.refused === 0 && await cloudStock(WH, p.id) === 2, 'B confirms, then A receives: accepted');
  await B.sync();
  ok(await stockAt(B, WH, p.id) === 2, 'B sees the 2 pieces');
});

// ---------- 3. Changing different things on the same record ----------
await scenario('9. Two computers change different things on the same item', async () => {
  const p = await newItem();
  await A.call('PUT', '/api/products/' + p.id, { sale_price: 1500 });
  await B.call('PUT', '/api/products/' + p.id, { name: 'Renamed item' });
  await A.sync(); await B.sync(); await A.sync();
  const row = (await db.query('select name, sale_price from products where id = $1', [p.id])).rows[0];
  ok(row.sale_price === 1500 && row.name === 'Renamed item', `both changes are kept (name "${row.name}", price ${row.sale_price})`);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('10. Receiving goods changes the price while another computer renames the item', async () => {
  const p = await newItem();
  const po = await A.call('POST', '/api/purchases', { location_id: WH, order: true, items: [{ product_id: p.id, qty: 1, cost: 700, sale_price: 1800 }] });
  await allSynced();
  const items = (await A.call('GET', '/api/purchases/' + po.id)).items;
  await A.call('POST', `/api/purchases/${po.id}/receive`, { items: items.map((i) => ({ id: i.id, qty: 1, cost: 700 })) });
  await B.call('PUT', '/api/products/' + p.id, { category: 'Shirts' });
  await A.sync(); await B.sync(); await A.sync();
  const row = (await db.query('select category, sale_price, cost_price from products where id = $1', [p.id])).rows[0];
  ok(row.sale_price === 1800 && row.cost_price === 700 && row.category === 'Shirts', `new price stays (price ${row.sale_price}, cost ${row.cost_price}, category ${row.category})`);
});

await scenario("11. The owner renames a person just after they changed their passcode", async () => {
  const before = (await db.query('select pin_hash from users where id = $1', [ahmed.id])).rows[0].pin_hash;
  await SHOP.call('POST', '/api/me/pin', { current: '2222', pin: '3333' });
  await A.call('PUT', '/api/users/' + ahmed.id, { name: 'Ahmed K' });
  await SHOP.sync(); await A.sync(); await SHOP.sync();
  const row = (await db.query('select name, pin_hash from users where id = $1', [ahmed.id])).rows[0];
  ok(row.name === 'Ahmed K' && row.pin_hash !== before, `the new name and the new passcode are both kept (name ${row.name}, passcode ${row.pin_hash !== before ? 'new' : 'OLD'})`);
});

// ---------- 4. The same number or code made on two computers ----------
await scenario('12. Two computers add an item with the same barcode', async () => {
  const [a] = await A.call('POST', '/api/products', { name: 'From A', barcode: '5551234', cost_price: 100, sale_price: 200, variants: [{ barcode: '5551234' }] });
  const [b] = await B.call('POST', '/api/products', { name: 'From B', barcode: '5551234', cost_price: 100, sale_price: 200, variants: [{ barcode: '5551234' }] });
  await A.sync();
  let stuck = null;
  try { await B.sync(); } catch (e) { stuck = e.message; }
  ok(!stuck, 'the second computer is not stuck' + (stuck ? `: ${stuck}` : ''));
  ok((await errorsOn(B)).some((m) => /barcode/.test(m)), 'it is told why its item was not accepted');
  const onB = await B.sql('SELECT id, name FROM products WHERE barcode = ?', ['5551234']);
  ok(onB.length === 1 && onB[0].id === a.id, 'it now shows the item that is in the cloud');
  ok(b.id !== a.id, '(two different items were made)');
  await clearErrors(B);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('13. Two computers add a shop with the same short code', async () => {
  await A.call('POST', '/api/locations', { name: 'Mall shop', code: 'S2', type: 'shop' });
  await B.call('POST', '/api/locations', { name: 'Road shop', code: 'S2', type: 'shop' });
  await A.sync();
  let stuck = null;
  try { await B.sync(); } catch (e) { stuck = e.message; }
  ok(!stuck, 'the second computer is not stuck' + (stuck ? `: ${stuck}` : ''));
  const onB = await B.sql("SELECT name FROM locations WHERE code = 'S2'");
  ok(onB.length === 1 && onB[0].name === 'Mall shop', 'it shows the shop that is in the cloud');
  await clearErrors(B);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('14. A locked computer (nothing can be sent) meets the same barcode', async () => {
  await SHOP.call('POST', '/api/products', { name: 'Shop item', cost_price: 0, sale_price: 200, variants: [{ barcode: '7770001' }] });
  await SHOP.system('lock');
  await A.call('POST', '/api/products', { name: 'Owner item', cost_price: 0, sale_price: 200, variants: [{ barcode: '7770001' }] });
  await A.sync();
  let stuck = null;
  try { await SHOP.sync(); } catch (e) { stuck = e.message; }
  ok(!stuck, 'downloading does not stop' + (stuck ? `: ${stuck}` : ''));
  await SHOP.call('POST', '/api/login', { user_id: ahmed.id, pin: '3333' }).catch(() => SHOP.call('POST', '/api/login', { user_id: ahmed.id, pin: '2222' }));
  await SHOP.sync();
  const rows = await SHOP.sql("SELECT name FROM products WHERE barcode = '7770001'");
  ok(rows.length === 1 && rows[0].name === 'Owner item', 'after unlocking it shows the item that is in the cloud');
  ok((await SHOP.sql('SELECT COUNT(*) AS n FROM outbox'))[0].n === 0, 'nothing is left waiting');
  await clearErrors(SHOP);
});

// ---------- 5. Deleting on one computer ----------
await scenario('15. A shop is deleted while another computer just sold there', async () => {
  const shop = await A.call('POST', '/api/locations', { name: 'Pop-up', code: 'PU', type: 'shop' });
  await allSynced();
  const p = await newItem();
  await B.call('POST', '/api/sales', { location_id: shop.id, items: [{ product_id: p.id, qty: 1 }] });
  await B.sync();
  await A.call('DELETE', '/api/locations/' + shop.id); // A has not seen the bill yet
  await A.sync();
  ok((await db.query('select 1 from locations where id = $1', [shop.id])).rows.length === 1, 'the shop stays in the cloud because it has a bill');
  ok((await A.sql('SELECT 1 FROM locations WHERE id = ?', [shop.id])).length === 1, 'the computer that tried gets it back');
  ok((await errorsOn(A)).some((m) => /Pop-up|history|bill/i.test(m)), 'and is told why: ' + (await errorsOn(A)).join(' | '));
  await clearErrors(A);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('16. A bill is made at a shop that was already deleted', async () => {
  const p = await newItem();
  const shop = await A.call('POST', '/api/locations', { name: 'Gone', code: 'GN', type: 'shop' });
  await allSynced();
  await A.call('DELETE', '/api/locations/' + shop.id);
  await A.sync();
  await B.call('POST', '/api/sales', { location_id: shop.id, items: [{ product_id: p.id, qty: 1 }] });
  await B.sync();
  ok((await db.query('select 1 from sales where location_id = $1', [shop.id])).rows.length === 0, 'the cloud refuses a bill for a shop that no longer exists');
  ok((await errorsOn(B)).length === 1, 'the computer is told: ' + (await errorsOn(B)).join(' | '));
  await clearErrors(B);
  await sameEverywhere(A, B, 'both computers end up the same');
});

await scenario('17. A record is changed on a computer after it was deleted on another', async () => {
  const [v] = await A.call('POST', '/api/vouchers', { kind: 'amt', value: 100 });
  await allSynced();
  await A.call('DELETE', '/api/vouchers/' + v.id);
  await B.call('PUT', '/api/vouchers/' + v.id, { note: 'changed' });
  await A.sync(); await B.sync(); await A.sync();
  ok((await db.query('select 1 from vouchers where id = $1', [v.id])).rows.length === 0, 'the deleted record does not come back');
  ok((await B.sql('SELECT 1 FROM vouchers WHERE id = ?', [v.id])).length === 0, 'and it is gone from the other computer too');
  await clearErrors(B);
});

await scenario('18. A voucher is deleted while another computer just used it', async () => {
  const [v] = await A.call('POST', '/api/vouchers', { kind: 'amt', value: 100 });
  await allSynced();
  const p = await newItem();
  await B.call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }], voucher: v.code });
  await B.sync();
  await A.call('DELETE', '/api/vouchers/' + v.id);
  await A.sync();
  ok((await db.query('select 1 from vouchers where id = $1', [v.id])).rows.length === 1, 'the voucher stays because a bill used it');
  await clearErrors(A);
  await sameEverywhere(A, B, 'both computers end up the same');
});

// ---------- 6. A problem on one side never stops the rest ----------
await scenario('19. A cloud problem while sending does not stop downloads', async () => {
  const p = await newItem();
  await B.call('POST', '/api/expenses', { amount: 50, category: 'Tea' });
  await A.call('PUT', '/api/products/' + p.id, { name: 'Changed on A' });
  await A.sync();
  const flaky = async (fn, args) => {
    if (fn === 'push') return { results: args.p_groups.map((g) => ({ grp: g.grp, ok: false, retry: true, error: 'something broke' })) };
    return B.rpc(fn, args);
  };
  let err = null;
  try { await B.syncWith(flaky); } catch (e) { err = e; }
  ok(err && /something broke/.test(err.message), 'the problem is reported');
  ok((await B.sql('SELECT name FROM products WHERE id = ?', [p.id]))[0].name === 'Changed on A', "the other computer's change still arrived");
  ok((await B.sql('SELECT COUNT(*) AS n FROM outbox'))[0].n > 0, 'what was made here is kept, to send again');
  await B.sync();
  ok((await B.sql('SELECT COUNT(*) AS n FROM outbox'))[0].n === 0, 'and it goes up once the cloud is well');
});

await scenario('20. A very big single action is sent whole', async () => {
  const before = (await db.query('select count(*)::int n from products')).rows[0].n;
  await B.call('POST', '/api/products', { name: 'Many sizes', cost_price: 1, sale_price: 2, variants: Array.from({ length: 40 }, (_, i) => ({ size: 'S' + i })) });
  const small = await B.system('outbox', 10); // (the limit is much smaller than this action)
  ok(small.length === 1 && small[0].rows.length === 40, `the action is not cut in two (${small[0]?.rows.length} of 40 records)`);
  await B.sync();
  ok((await db.query('select count(*)::int n from products')).rows[0].n === before + 40, 'all 40 reach the cloud');
  await A.sync();
});

await scenario('21. Data this version does not know does not stop it', async () => {
  await B.system('applyPull', [{ t: 'something_new', r: { id: 1, x: 2 } }, { t: 'products', r: { id: 99999, barcode: 'UNKNOWNCOL', name: 'Future', sale_price: 1, active: 1, created_at: '2026-01-01', some_new_column: 5 } }]);
  ok((await B.sql("SELECT name FROM products WHERE barcode = 'UNKNOWNCOL'")).length === 1, 'a new kind of record is skipped, new columns are ignored');
  await B.sql('DELETE FROM products WHERE id = 99999');
});

// ---------- 7. A refused change leaves nothing behind ----------
await scenario('22. A change the cloud refuses disappears from the computer', async () => {
  const p = await newItem(5);
  await SHOP.sync();
  // a sale made by a person whose switch was just turned off on the owner's computer
  await A.call('PUT', '/api/users/' + ahmed.id, { perms: ['receive'] });
  await A.sync();
  const stockBefore = await stockAt(SHOP, S1, p.id);
  const bill = await SHOP.call('POST', '/api/sales', { items: [{ product_id: p.id, qty: 1 }] });
  ok(await stockAt(SHOP, S1, p.id) === stockBefore - 1, '(the shop computer took it off its stock)');
  await SHOP.sync();
  ok((await SHOP.sql('SELECT 1 FROM sales WHERE id = ?', [bill.id])).length === 0, 'the refused bill is gone from the shop computer');
  ok(await stockAt(SHOP, S1, p.id) === await cloudStock(S1, p.id), 'its stock matches the cloud again');
  ok((await errorsOn(SHOP)).length === 1, 'and the refusal stays listed: ' + (await errorsOn(SHOP)).join(' | '));
  await clearErrors(SHOP);
  await A.call('PUT', '/api/users/' + ahmed.id, { perms: ['sell', 'returns', 'receive', 'add_items', 'void_bills'] });
  await A.sync();
});

// ---------- 8. Computers that already have data when this version arrives ----------
await scenario('23. A computer updated to this version gets the version numbers once, and repairs itself', async () => {
  const p = await newItem();
  const po = await A.call('POST', '/api/purchases', { location_id: WH, draft: true, items: [{ product_id: p.id, qty: 1, cost: 500 }] });
  await allSynced();
  // as it was before this version: no version numbers, and something on it that the cloud does not have
  await B.sql('UPDATE purchases SET rev = NULL');
  await B.sql("UPDATE device SET value = '0' WHERE key = 'sync_v'");
  await B.sql('UPDATE sync_ctx SET applying = 1');
  await B.sql("INSERT INTO suppliers(id, name, created_at) VALUES(999999, 'Left behind', '2026-01-01')");
  await B.sql('UPDATE sync_ctx SET applying = 0');
  const r = await B.sync();
  ok((await B.sql('SELECT rev FROM purchases WHERE id = ?', [po.id]))[0].rev > 0, 'it has the version numbers now');
  ok((await B.sql('SELECT 1 FROM suppliers WHERE id = 999999')).length === 0, 'what the cloud does not have is gone');
  ok(!r.reset, '(done quietly, nobody needs to know)');
  const again = await B.sync();
  ok(again.received === 0 || again.changed === 0, 'it happens only once');
});

await scenario('24. "Download everything again" works, and nothing is lost if changes are waiting', async () => {
  await B.call('POST', '/api/expenses', { amount: 75, category: 'Tea' });
  await B.system('requestRebuild');
  await B.sync();
  ok((await B.sql('SELECT COUNT(*) AS n FROM expenses WHERE amount = 75'))[0].n === 1, 'the waiting change went up first and is still here');
  ok((await db.query('select count(*)::int n from expenses where amount = 75')).rows[0].n === 1, 'and it is in the cloud');
  ok(!(await B.system('info')).sync.rebuild, 'done');
});

await sameEverywhere(A, B, '\nFinally: the two owner computers hold exactly the same data');
for (const d of [A, B, SHOP]) await d.stop();
console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed:\n - ${failures.join('\n - ')}` : `\nAll ${passed} multi-computer checks passed.`);
process.exit(failures.length ? 1 : 0);
