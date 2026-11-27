// Paying a received purchase later, deleting drafts, negative stock, and the passcode asked once a day.
// Run: node --disable-warning=ExperimentalWarning tools/test-purchase-pay.mjs
import assert from 'node:assert/strict';
import * as E from '../web/engine/index.js';
import { nodeAdapter } from '../web/engine/node-adapter.js';
import * as D from '../web/engine/db.js';

E.init(nodeAdapter());
const call = async (method, path, body, query) => {
  const r = await E.handle({ method, path, body: body || {}, query: query || {} });
  if (r.status !== 200) { const e = new Error(`${method} ${path} → ${r.status} ${r.body.error}`); e.status = r.status; throw e; }
  return r.body;
};
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('  ✓ ' + msg); };
const refused = async (fn, msg) => { let e = null; try { await fn(); } catch (x) { e = x; } ok(e && e.status === 400, `${msg}: ${e?.message}`); };

await E.system.setupLocal({ business_name: 'Pay Test', owner_name: 'Owner', pin: '1234' });
const me = await call('GET', '/api/me');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
ok(me.settings.pay_on_receive === '0', 'paying when goods arrive is off by default');

// ---- the passcode: remembered on this device until the end of the day ----
ok((await E.system.info()).unlocked_today === true, 'after setup the device counts as unlocked today');
D.setDevice({ unlocked_on: '2000-01-01' });
ok((await E.system.info()).unlocked_today === false, 'unlocked on another day: the passcode is asked again');
await call('POST', '/api/login', { user_id: me.user.id, pin: '1234' });
ok((await E.system.info()).unlocked_today === true, 'typing the passcode unlocks it for today');
E.system.lock();
ok((await E.system.info()).unlocked_today === false && !(await E.system.info()).user_id, '"Lock" asks for the passcode again');
await call('POST', '/api/login', { user_id: me.user.id, pin: '1234' });

// ---- a purchase with no supplier, received with nothing paid, then paid later ----
const [shirt] = await call('POST', '/api/products', { name: 'Sweat Shirt', cost_price: 680, sale_price: 1699, variants: [{ size: 'S' }] });
const order = await call('POST', '/api/purchases', { location_id: WH, order: true, items: [{ product_id: shirt.id, qty: 5, cost: 680 }] });
await call('POST', `/api/purchases/${order.id}/receive`, { paid: 0 });
let p = await call('GET', `/api/purchases/${order.id}`);
ok(p.status === 'done' && p.total === 3400 && p.paid_total === 0 && p.due === 3400, 'received with nothing paid: Rs 3,400 owed');
await refused(() => call('POST', `/api/purchases/${order.id}/payments`, { amount: 5000 }), 'paying more than is owed is refused');
await refused(() => call('POST', `/api/purchases/${order.id}/payments`, { amount: 0 }), 'paying 0 is refused');
let r = await call('POST', `/api/purchases/${order.id}/payments`, { amount: 1400, method: 'cash' });
ok(r.due === 2000, 'part paid: Rs 2,000 still owed');
r = await call('POST', `/api/purchases/${order.id}/payments`, { amount: 2000, method: 'bank transfer' });
p = await call('GET', `/api/purchases/${order.id}`);
ok(r.due === 0 && p.due === 0 && p.paid_total === 3400 && p.payments.length === 2, 'paid in full, both payments listed');
ok(p.payments.every((x) => x.supplier_id === 0 && x.purchase_id === order.id), 'payments of a purchase with no supplier have supplier 0');
await refused(() => call('POST', `/api/purchases/${order.id}/payments`, { amount: 1 }), 'a fully paid purchase cannot be paid again');
const listed = (await call('GET', '/api/purchases')).find((x) => x.id === order.id);
ok(listed.paid_total === 3400 && listed.due === 0, 'the purchase list shows what was paid later');

// ---- with a supplier: the payment also lowers what the supplier is owed ----
const sup = await call('POST', '/api/suppliers', { name: 'Al-Noor' });
const pu = await call('POST', '/api/purchases', { supplier_id: sup.id, location_id: WH, paid: 500, items: [{ product_id: shirt.id, qty: 2, cost: 680 }] });
ok((await call('GET', `/api/suppliers/${sup.id}`)).supplier.due === 860, 'supplier owed 860 after paying 500 of 1,360');
await call('POST', `/api/purchases/${pu.id}/payments`, { amount: 860 });
ok((await call('GET', `/api/suppliers/${sup.id}`)).supplier.due === 0, 'paying the purchase clears what the supplier is owed');
ok((await call('GET', '/api/dashboard')).supplier_due === 0, 'Home: nothing owed to suppliers (payments for a purchase with no supplier are not taken off)');

// ---- an order dated earlier keeps its date when it is confirmed and received ----
const back = await call('POST', '/api/purchases', { location_id: WH, draft: true, date: '2026-11-01', items: [{ product_id: shirt.id, qty: 2, cost: 680 }] });
await call('POST', `/api/purchases/${back.id}/confirm`);
ok((await call('GET', `/api/purchases/${back.id}`)).date === '2026-11-01', 'confirmed: the order keeps its date (1 Nov)');
await call('POST', `/api/purchases/${back.id}/receive`, {});
const got = await call('GET', `/api/purchases/${back.id}`);
ok(got.status === 'done' && got.date === '2026-11-01' && got.received_at.slice(0, 10) === D.today(), 'received today: the date stays 1 Nov, received_at is today');

// ---- drafts can be deleted ----
const draft = await call('POST', '/api/purchases', { location_id: WH, draft: true, items: [{ product_id: shirt.id, qty: 1, cost: 680 }] });
r = await call('POST', '/api/delete/run', { items: [{ kind: 'purchases', id: draft.id }] });
ok(r.deleted === 1 && !D.get('SELECT id FROM purchases WHERE id = ?', draft.id), 'a draft purchase order is deleted');

// ---- negative stock ----
const [cap] = await call('POST', '/api/products', { name: 'Cap', sale_price: 0, variants: [{ opening_qty: 1 }] });
await call('POST', '/api/stock/adjust', { location_id: WH, product_id: cap.id, qty: -3, reason: 'Sold before it was entered' });
const neg = await call('GET', '/api/stock', null, { neg: '1' });
ok(neg.rows.length === 1 && neg.rows[0].id === cap.id && neg.rows[0].total === -2, 'Negative stock only: just the cap, at −2');

console.log(`\nAll ${checks} purchase payment, draft, negative stock and passcode checks passed.`);
