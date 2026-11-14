// Delete Selected Data (More → Delete): records deleted one by one, on an owner computer and on a shop computer,
// through the cloud (part 12: shop people may delete their own place's records). Done bills, purchases and transfers
// give their stock back first. Every computer and the cloud end up with the same stock.
// Run: node --disable-warning=ExperimentalWarning tools/test-delete.mjs
import { Worker } from 'node:worker_threads';
import { startCloud } from './pg-cloud.mjs';
import { createSyncer, localNow } from '../web/engine/syncer.js';

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
    name, system,
    rpc: (fn, args) => cloudRpc(uid, fn, args),
    sql: (q, p) => send('sql', null, [q, p]),
    async call(method, path, body, query) {
      const r = await send('api', null, [{ method, path, body: body || {}, query: query || {} }]);
      if (r.status !== 200) throw new Error(`${name}: ${method} ${path} → ${r.status} ${r.body.error}`);
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
const inCloud = async (t, id) => (await db.query(`select 1 from ${t} where id = $1`, [id])).rows.length > 0;
const errorsOn = async (d) => (await d.sql('SELECT message FROM sync_errors ORDER BY id')).map((r) => r.message);

// ---------- The business: an owner computer, a second owner computer and a shop computer ----------
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
const ahmed = await A.call('POST', '/api/users', { name: 'Ahmed', role: 'staff', location_id: S1, pin: '2222', perms: ['sell', 'returns', 'receive', 'add_items', 'void_bills', 'expenses'] });
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
const allSynced = async () => { await A.sync(); await B.sync(); await SHOP.sync(); };

let itemNo = 0;
async function newItem(loc, stock) {
  const [p] = await A.call('POST', '/api/products', { name: `Item ${++itemNo}`, cost_price: 500, sale_price: 1000, variants: [{}] });
  if (stock) await A.call('POST', '/api/stock/adjust', { product_id: p.id, location_id: loc, mode: 'set', qty: stock, reason: 'start' });
  await allSynced();
  return p;
}
const del = (d, items) => d.call('POST', '/api/delete/run', { items });

await scenario('1. The owner deletes a done bill', async () => {
  const p = await newItem(WH, 10);
  const bill = await A.call('POST', '/api/sales', { location_id: WH, items: [{ product_id: p.id, qty: 3 }] });
  await allSynced();
  ok(await cloudStock(WH, p.id) === 7, 'sold: 7 left');
  const plan = await A.call('POST', '/api/delete/check', { items: [{ kind: 'sales', id: bill.id }] });
  ok(plan[0].action === 'reset', 'the check says it is done and is reset first');
  const out = await del(A, [{ kind: 'sales', id: bill.id }]);
  ok(out.deleted === 1 && out.undone === 1, 'deleted, with its stock undone');
  ok(await stockAt(A, WH, p.id) === 10, 'this computer: the 3 pieces are back (10)');
  await allSynced();
  ok(!(await inCloud('sales', bill.id)) && (await db.query('select count(*)::int n from sale_items where sale_id = $1', [bill.id])).rows[0].n === 0, 'the bill and its lines are gone in the cloud');
  ok(await cloudStock(WH, p.id) === 10, `the cloud has 10 again (${await cloudStock(WH, p.id)})`);
  ok(!(await B.sql('SELECT 1 FROM sales WHERE id = ?', [bill.id])).length && await stockAt(B, WH, p.id) === 10, 'the other owner computer: bill gone, 10 in stock');
});

await scenario('2. The shop deletes its own done bill and its own expense', async () => {
  const p = await newItem(S1, 8);
  const bill = await SHOP.call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 2 }] });
  await SHOP.call('POST', '/api/expenses', { category: 'Tea', amount: 50 });
  const exp = (await SHOP.call('GET', '/api/expenses'))[0];
  await SHOP.sync();
  ok(await cloudStock(S1, p.id) === 6 && await inCloud('expenses', exp.id), 'the bill and the expense are in the cloud');
  const out = await del(SHOP, [{ kind: 'sales', id: bill.id }, { kind: 'expenses', id: exp.id }]);
  ok(out.deleted === 2 && !out.skipped.length, 'both deleted on the shop computer');
  const r = await SHOP.sync();
  ok(r.refused === 0, 'the cloud accepts both (' + ((await errorsOn(SHOP))[0] || 'no refusals') + ')');
  ok(!(await inCloud('sales', bill.id)) && !(await inCloud('expenses', exp.id)), 'both gone in the cloud');
  ok(await cloudStock(S1, p.id) === 8 && await stockAt(SHOP, S1, p.id) === 8, 'the 2 pieces are back: 8 in the cloud and on the shop computer');
  await A.sync();
  ok(await stockAt(A, S1, p.id) === 8 && !(await A.sql('SELECT 1 FROM sales WHERE id = ?', [bill.id])).length, 'the owner computer sees it too');
});

await scenario('3. The shop cannot delete what is not its own', async () => {
  const p = await newItem(WH, 5);
  const po = await A.call('POST', '/api/purchases', { location_id: S1, items: [{ product_id: p.id, qty: 4, cost: 500 }] });
  await A.call('POST', '/api/expenses', { category: 'Rent', amount: 900, location_id: WH });
  const whExp = (await A.call('GET', '/api/expenses', null, { location_id: WH })).find((e) => e.category === 'Rent');
  await allSynced();
  const local = await SHOP.call('POST', '/api/delete/check', { items: [{ kind: 'expenses', id: whExp.id }, { kind: 'purchases', id: po.id }] });
  ok(local.every((x) => x.action === 'skip'), 'the shop computer skips them: ' + local.map((x) => x.why).join('; '));
  // even if it tried anyway, the cloud refuses
  const info = await SHOP.system('info');
  const push = (rows) => SHOP.rpc('push', { p_device: info.device.id, p_user: ahmed.id, p_groups: [{ grp: 'test-' + Math.random(), rows }], p_now: localNow() });
  let res = await push([{ t: 'expenses', k: whExp.id, del: 1 }]);
  ok(!res.results[0].ok && await inCloud('expenses', whExp.id), 'the cloud refuses another place\'s expense: ' + res.results[0].error);
  res = await push([{ t: 'purchases', k: po.id, del: 1 }]);
  ok(!res.results[0].ok && await inCloud('purchases', po.id), 'the cloud refuses a received purchase: ' + res.results[0].error);
});

await scenario('4. The owner deletes a received purchase and a received transfer', async () => {
  const p = await newItem(WH, 0);
  const po = await A.call('POST', '/api/purchases', { location_id: WH, items: [{ product_id: p.id, qty: 10, cost: 500 }] });
  const d = await A.call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: p.id, qty: 4 }] });
  await A.call('POST', `/api/dispatches/${d.id}/receive`, {});
  await allSynced();
  ok(await cloudStock(WH, p.id) === 6 && await cloudStock(S1, p.id) === 4, 'before: 6 at the warehouse, 4 at the shop');
  let out = await del(A, [{ kind: 'dispatches', id: d.id }]);
  ok(out.deleted === 1 && await stockAt(A, WH, p.id) === 10 && await stockAt(A, S1, p.id) === 0, 'transfer deleted: the 4 pieces are back at the warehouse');
  out = await del(A, [{ kind: 'purchases', id: po.id }]);
  ok(out.deleted === 1 && await stockAt(A, WH, p.id) === 0, 'purchase deleted: its 10 pieces are out of stock again');
  await allSynced();
  ok(await cloudStock(WH, p.id) === 0 && await cloudStock(S1, p.id) === 0 && !(await inCloud('purchases', po.id)) && !(await inCloud('dispatches', d.id)), 'the cloud agrees');
  ok(await stockAt(SHOP, S1, p.id) === 0, 'and the shop computer');
});

await scenario('5. Items: unused ones are deleted, used ones skipped', async () => {
  const unused = await newItem(WH, 3);
  const used = await newItem(WH, 3);
  await A.call('POST', '/api/sales', { location_id: WH, items: [{ product_id: used.id, qty: 1 }] });
  const shopTry = await SHOP.call('POST', '/api/delete/check', { items: [{ kind: 'products', id: unused.id }] });
  ok(shopTry[0].action === 'skip' && /stock/.test(shopTry[0].why), 'the shop may not delete an item that still has stock: ' + shopTry[0].why);
  const out = await del(A, [{ kind: 'products', id: unused.id }, { kind: 'products', id: used.id }]);
  ok(out.deleted === 1 && out.skipped.length === 1 && /bills/.test(out.skipped[0].why), 'one deleted, the used one skipped: ' + out.skipped[0]?.why);
  await allSynced();
  ok(!(await inCloud('products', unused.id)) && await inCloud('products', used.id), 'the cloud: unused item gone, used item kept');
  ok(await cloudStock(WH, unused.id) === 0, 'its stock was taken out first (0 in the cloud)');
  const [fresh] = await A.call('POST', '/api/products', { name: 'Shop-made', sale_price: 10, variants: [{}] });
  await allSynced();
  const out2 = await del(SHOP, [{ kind: 'products', id: fresh.id }]);
  const r = await SHOP.sync();
  ok(out2.deleted === 1 && r.refused === 0 && !(await inCloud('products', fresh.id)), 'the shop deletes an unused item with no stock');
});

await scenario('6. Everything matches at the end', async () => {
  await allSynced();
  const local = await A.sql('SELECT location_id, product_id, qty FROM stock WHERE qty <> 0 ORDER BY location_id, product_id');
  const cloud = (await db.query('select location_id::float8 as l, product_id::float8 as p, qty from stock where qty <> 0 order by location_id, product_id')).rows;
  ok(JSON.stringify(local.map((x) => [x.location_id, x.product_id, x.qty])) === JSON.stringify(cloud.map((x) => [x.l, x.p, x.qty])), 'every stock count on the owner computer equals the cloud');
  ok(!(await errorsOn(A)).length && !(await errorsOn(SHOP)).length, 'no refused changes left on any computer');
});

for (const d of [A, B, SHOP]) await d.stop();
console.log(failures.length ? `\n${failures.length} FAILED, ${passed} passed:\n - ${failures.join('\n - ')}` : `\nAll ${passed} delete checks passed.`);
process.exit(failures.length ? 1 : 0);
