// Training / practice mode: try things for real, then everything is put back exactly as it was.
// Run: node --disable-warning=ExperimentalWarning tools/test-practice.mjs
import assert from 'node:assert/strict';
import * as E from '../web/engine/index.js';
import { nodeAdapter } from '../web/engine/node-adapter.js';
import * as D from '../web/engine/db.js';

E.init(nodeAdapter());
const call = async (method, path, body, query) => {
  const r = await E.handle({ method, path, body: body || {}, query: query || {} });
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${r.body.error}`);
  return r.body;
};
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };

// Everything this device holds, as one text (to compare before and after).
const TABLES = [...D.SYNC_TABLES, 'stock', 'devices', 'device', 'counters', 'outbox', 'sync_errors'];
const dump = () => JSON.stringify(TABLES.map((t) => [t, D.all(`SELECT * FROM ${t} ORDER BY 1, 2`)]));

await E.system.setupLocal({ business_name: 'Practice Test', owner_name: 'Owner', pin: '1234' });
const me = await call('GET', '/api/me');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
const S1 = me.locations.find((l) => l.type === 'shop').id;
await call('POST', '/api/users', { name: 'Ahmed', role: 'staff', location_id: S1, pin: '2222' });
const [real] = await call('POST', '/api/products', { name: 'Real Shirt', sale_price: 1000, cost_price: 500, opening_location_id: S1, variants: [{ opening_qty: 10 }] });
await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: real.id, qty: 2 }] });

// ---- owner device, no cloud ----
const before = dump();
ok((await E.system.info()).practice === false, 'not practising to begin with');
await E.system.practiceStart();
ok((await E.system.info()).practice === true, 'practice started');
const demo = await call('GET', '/api/products', null, { q: 'DEMO' });
ok(demo.length === 2 && demo.every((p) => p.name.startsWith('DEMO')), 'two DEMO items to practise with');
ok(D.get('SELECT name FROM suppliers WHERE name LIKE ?', 'DEMO%'), 'a DEMO supplier');
ok(D.stockQty(demo[0].id, S1) === 20 && D.stockQty(demo[0].id, WH) === 20, 'DEMO stock at every place');

// do a lot of real things
const bill = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: demo[0].id, qty: 2 }, { product_id: real.id, qty: 1 }], payment_method: 'cash' });
ok(bill.bill_no && D.stockQty(real.id, S1) === 7, 'a bill was made, real stock moved: ' + bill.bill_no + ' qty ' + D.stockQty(real.id, S1));
const pur = await call('POST', '/api/purchases', { location_id: WH, items: [{ product_id: demo[1].id, qty: 10, cost: 400 }], supplier_id: D.get('SELECT id FROM suppliers WHERE name LIKE ?', 'DEMO%').id });
const disp = await call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: demo[1].id, qty: 5 }] });
await call('POST', `/api/dispatches/${disp.id}/receive`, {});
await call('POST', '/api/expenses', { date: '2026-10-16', category: 'Tea', amount: 100 });
await call('POST', '/api/products', { name: 'Another new item', sale_price: 10, variants: [{}] });
ok(pur.purchase_no && disp.dispatch_no, `purchase ${pur.purchase_no} and dispatch ${disp.dispatch_no} made`);
ok(D.get('SELECT COUNT(*) AS n FROM movements').n > 5, 'history written');

// ---- finish: as if it never happened ----
await E.system.practiceFinish();
ok((await E.system.info()).practice === false, 'practice finished');
ok(dump() === before, 'every table, counter and number is exactly as before');
const next = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: real.id, qty: 1 }] });
ok(next.bill_no === 'S1-A0002' || /-A0002$/.test(next.bill_no), 'the next real bill number carries on: ' + next.bill_no);
ok((await call('GET', '/api/products', null, { q: 'DEMO' })).length === 0, 'no DEMO items left');

// ---- a shop device in the cloud: nothing leaves, parcel to receive, owner data untouched ----
D.run("INSERT INTO sync_ctx(applying, grp) SELECT 0, 'x' WHERE NOT EXISTS (SELECT 1 FROM sync_ctx)");
D.setDevice({ mode: 'cloud', location_id: S1 });
D.run('UPDATE sync_ctx SET applying = 0');
await call('POST', '/api/logout');
const ahmed = D.get("SELECT id FROM users WHERE name = 'Ahmed'").id;
await call('POST', '/api/login', { user_id: ahmed, pin: '2222' });
await call('POST', '/api/sales', { items: [{ product_id: real.id, qty: 1 }] });
const waiting = E.system.outbox().length;
ok(waiting > 0, 'a real bill is waiting to be sent');
const shopBefore = dump();
await E.system.practiceStart();
ok(E.system.outbox().length === 0, 'nothing waits to be sent while practising (the real ' + waiting + ' stay safe)');
const parcel = (await call('GET', '/api/dispatches', null, { status: 'in_transit' })).find((d) => d.to_location_id === S1);
ok(parcel && parcel.notes.startsWith('DEMO'), 'a DEMO parcel is on its way to this shop');
await call('POST', `/api/dispatches/${parcel.id}/receive`, {});
const demo2 = await call('GET', '/api/products', null, { q: 'DEMO' });
await call('POST', '/api/sales', { items: [{ product_id: demo2[0].id, qty: 1 }] });
ok(E.system.outbox().length === 0, 'still nothing to send after selling and receiving');
await E.system.practiceFinish();
ok(dump() === shopBefore, 'shop device back exactly as before (including what was waiting to be sent)');
ok(E.system.outbox().length === waiting, 'the real waiting changes are still waiting');
ok((await E.system.info()).practice === false, 'not practising any more');

console.log(`\nAll ${checks} practice checks passed.`);
