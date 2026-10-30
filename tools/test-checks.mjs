// Warnings before saving (/api/check/…) and the reports (trends, stock, suppliers, staff, things to check), on one device.
// Run: node --disable-warning=ExperimentalWarning tools/test-checks.mjs
import assert from 'node:assert/strict';
import * as E from '../web/engine/index.js';
import * as D from '../web/engine/db.js';
import { nodeAdapter } from '../web/engine/node-adapter.js';

E.init(nodeAdapter());
const call = async (method, path, body, query) => {
  const r = await E.handle({ method, path, body: body || {}, query: query || {} });
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${r.body.error}`);
  return r.body;
};
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('  ✓ ' + msg); };
const warn = async (kind, body) => (await call('POST', '/api/check/' + kind, body)).warnings;
const has = (list, re) => list.some((w) => re.test(w));

await E.system.setupLocal({ business_name: 'Test', owner_name: 'Owner', pin: '1234' });
const me = await call('GET', '/api/me');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
const S1 = me.locations.find((l) => l.type === 'shop').id;

// the real mistake: an item with selling price 0
let w = await warn('product', { name: 'henley', cost_price: 111, sale_price: 0, variants: [{}] });
ok(has(w, /selling price of “henley” is Rs 0/), 'new item at Rs 0 is flagged: ' + w[0]);
ok((await warn('product', { name: 'Shirt', cost_price: 500, sale_price: 900, variants: [{}] })).length === 0, 'a normal item has no warnings');
ok(has(await warn('product', { name: 'Shirt', cost_price: 500, sale_price: 400, variants: [{}] }), /below the cost/), 'selling price below cost is flagged');
const [henley] = await call('POST', '/api/products', { name: 'henley', cost_price: 111, sale_price: 0, variants: [{}] });
const [shirt] = await call('POST', '/api/products', { name: 'Shirt', cost_price: 500, sale_price: 900, variants: [{}] });
const sup = await call('POST', '/api/suppliers', { name: 'asd' });

w = await warn('purchase', { supplier_id: sup.id, location_id: WH, order: true, expected_date: '2001-01-01', items: [{ product_id: henley.id, qty: 10, cost: 111 }] });
ok(has(w, /henley.*no selling price/) && has(w, /expected date is in the past/), 'purchase order: no selling price and a past date are flagged');
ok(has(await warn('purchase', { location_id: WH, items: [{ product_id: shirt.id, qty: 5, cost: 0 }] }), /costs Rs 0/), 'a cost of Rs 0 is flagged');
ok(has(await warn('purchase', { location_id: WH, items: [{ product_id: shirt.id, qty: 5, cost: 500 }], paid: 9000 }), /more than the total/), 'paying more than the total is flagged');
await call('POST', '/api/purchases', { supplier_id: sup.id, location_id: WH, invoice_no: '123111', paid: 1000, items: [{ product_id: henley.id, qty: 10, cost: 111 }, { product_id: shirt.id, qty: 20, cost: 500 }] });
ok(has(await warn('purchase', { supplier_id: sup.id, location_id: WH, invoice_no: '123111', items: [{ product_id: shirt.id, qty: 1, cost: 500 }] }), /already entered/), 'the same supplier invoice twice is flagged');
ok(has(await warn('purchase', { location_id: WH, items: [{ product_id: shirt.id, qty: 1, cost: 1000 }] }), /up 100%/), 'a cost far from last time is flagged');

ok(has(await warn('dispatch', { items: [{ product_id: henley.id, qty: 5 }] }), /no selling price/), 'sending an item with no selling price is flagged');
await call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: henley.id, qty: 5 }, { product_id: shirt.id, qty: 10 }] });
const parcels = await call('GET', '/api/dispatches', null, { status: 'in_transit' });
const d = await call('GET', '/api/dispatches/' + parcels[0].id);
await call('POST', `/api/dispatches/${d.id}/receive`, { items: d.items.map((i) => ({ id: i.id, received_qty: i.product_id === shirt.id ? 8 : i.qty })) });

w = await warn('sale', { location_id: S1, items: [{ product_id: henley.id, qty: 5 }] });
ok(has(w, /henley.*sold for Rs 0/) && has(w, /bill total is Rs 0/), 'a bill selling at Rs 0 is flagged');
ok(has(await warn('sale', { location_id: S1, items: [{ product_id: shirt.id, qty: 9 }] }), /Only 8 of “Shirt” in stock/), 'selling more than the stock is flagged');
ok(has(await warn('sale', { location_id: S1, items: [{ product_id: shirt.id, qty: 1 }], discount: 400 }), /44% of the bill/), 'a big discount is flagged');
ok((await warn('sale', { location_id: S1, items: [{ product_id: shirt.id, qty: 1 }] })).length === 0, 'a normal bill has no warnings');
await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: henley.id, qty: 5 }] });
await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: shirt.id, qty: 2 }], discount: 600 });

ok(has(await warn('adjust', { product_id: shirt.id, location_id: S1, mode: 'set', qty: 30 }), /by \+24 \(from 6 to 30\)/), 'a big stock correction is flagged');
ok(has(await warn('expense', { category: 'Rent', amount: 60000 }), /big expense/), 'a big expense is flagged');
ok(has(await warn('payment', { supplier_id: sup.id, amount: 50000 }), /only Rs 10,110/), 'paying a supplier more than owed is flagged');
await call('POST', '/api/stock/adjust', { product_id: shirt.id, location_id: S1, mode: 'set', qty: 30, reason: 'count' });

// ---- reports ----
const u = await call('GET', '/api/reports/unusual', null, {});
const kinds = new Set(u.items.map((i) => i.kind));
ok(['Sold at a loss', 'Big discount', 'Price problem', 'Parcel arrived short', 'Big stock correction'].every((k) => kinds.has(k)), 'things to check: ' + [...kinds].join(', '));
ok(u.items.find((i) => i.kind === 'Sold at a loss').detail.includes('Rs 555 lost'), 'the loss on the Rs 0 bill is worked out (5 × Rs 111)');

const tr = await call('GET', '/api/reports/trends', null, {});
ok(tr.group === 'day' && tr.buckets.length >= 1 && tr.now.bills === 2, `trends: ${tr.buckets.length} days, ${tr.now.bills} bills`);
ok(tr.now.sales === 1200 && tr.shops.length === 1 && tr.weekday.length === 7, 'trends: sales Rs 1,200 at one shop, by weekday');

const st = await call('GET', '/api/reports/stock', null, {});
ok(st.places.length === 2 && st.totals.cost_value > 0, 'stock: value per place');
ok(st.running_out.some((r) => r.name === 'henley'), 'stock: henley (sold out) is running out');

const sr = await call('GET', '/api/reports/suppliers', null, {});
ok(sr.suppliers[0].name === 'asd' && sr.suppliers[0].owed === 10110 && sr.suppliers[0].under30 === 10110, 'suppliers: Rs 10,110 owed to asd, all under 30 days');

const staff = await call('GET', '/api/reports/staff', null, {});
ok(staff.people[0].bills === 2 && staff.people[0].discount === 600 && staff.people[0].corrections === 1, 'staff: bills, discounts and corrections per person');
// ---- discounts on a bill line, and vouchers ----
w = await warn('sale', { location_id: S1, items: [{ product_id: shirt.id, qty: 1, disc: '50%' }] });
ok(has(w, /“Shirt” has 50% off/), 'a big discount on one item is flagged: ' + w[0]);
ok((await warn('sale', { location_id: S1, items: [{ product_id: shirt.id, qty: 1, disc: '5%' }] })).length === 0, 'a small item discount has no warning');
w = await warn('sale', { location_id: S1, items: [{ product_id: shirt.id, qty: 1, disc: '15%' }], discount: 100 });
ok(has(w, /In all, .* is taken off/), 'item and bill discounts together over the limit are flagged: ' + w[0]);
const [vA] = await call('POST', '/api/vouchers', { kind: 'amt', value: 100, max_uses: 1 });
const b1 = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: shirt.id, qty: 1, disc: '50%' }], voucher: vA.code });
ok(b1.total === 350 && b1.voucher === 100 && b1.items[0].list_price === 900 && b1.items[0].price === 450, 'item discount 900 -> 450, then the voucher: 350');
D.run('UPDATE sales SET voucher_code = ? WHERE id = ?', vA.code, (await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: shirt.id, qty: 1 }] })).id); // a second bill claiming the same voucher (as two offline shops could)
const u2 = await call('GET', '/api/reports/unusual', null, {});
ok(u2.items.some((i) => i.kind === 'Voucher used too often'), 'a limited voucher used twice shows in Things to check');
ok(u2.items.some((i) => i.kind === 'Big item discount'), 'a big item discount shows in Things to check');
console.log(`\nAll ${checks} warning and report checks passed.`);
