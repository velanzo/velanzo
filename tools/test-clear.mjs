// Managing data: clear everything, or only some kinds of history, optionally only for some dates.
// Run: node --disable-warning=ExperimentalWarning tools/test-clear.mjs
import assert from 'node:assert/strict';
import * as E from '../web/engine/index.js';
import { nodeAdapter } from '../web/engine/node-adapter.js';
import * as D from '../web/engine/db.js';
import { clearPlan, dataSummary, importData } from '../web/engine/routes/data.js';

E.init(nodeAdapter());
const call = async (method, path, body, query) => {
  const r = await E.handle({ method, path, body: body || {}, query: query || {} });
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${r.body.error}`);
  return r.body;
};
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };
const day = (d) => { globalThis.__vzClock = () => new Date(`2026-10-${String(d).padStart(2, '0')}T12:00:00`); };

await E.system.setupLocal({ business_name: 'Clear Test', owner_name: 'Owner', pin: '1234' });
const me = await call('GET', '/api/me');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
const S1 = me.locations.find((l) => l.type === 'shop').id;
const sup = await call('POST', '/api/suppliers', { name: 'Al-Noor' });
const [a, b] = await call('POST', '/api/products', { name: 'Shirt', sale_price: 1000, cost_price: 500, variants: [{ size: 'M' }, { size: 'L' }] });

day(1);
await call('POST', '/api/purchases', { location_id: WH, supplier_id: sup.id, items: [{ product_id: a.id, qty: 50, cost: 500 }, { product_id: b.id, qty: 50, cost: 500 }], paid: 1000 });
day(2);
const d1 = await call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: a.id, qty: 20 }, { product_id: b.id, qty: 20 }] });
await call('POST', `/api/dispatches/${d1.id}/receive`, {});
for (const d of [3, 5, 8, 12]) { day(d); await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: a.id, qty: 2 }, { product_id: b.id, qty: 1 }] }); }
day(4); await call('POST', '/api/expenses', { date: '2026-10-04', category: 'Tea', amount: 100, location_id: S1 });
day(9); await call('POST', '/api/expenses', { date: '2026-10-09', category: 'Rent', amount: 5000, location_id: S1 });
day(10);
const d2 = await call('POST', '/api/dispatches', { from_location_id: WH, to_location_id: S1, items: [{ product_id: a.id, qty: 5 }] }); // still on the way

const stockOf = (t) => JSON.stringify([...t.stock].sort((x, y) => x.product_id - y.product_id || x.location_id - y.location_id));
const full = clearPlan({ what: ['sales'] }); // (only to read the untouched data)
const before = full.data.tables;
const sum = dataSummary();
ok(sum.sales.n === 4 && sum.sales.first === '2026-10-03' && sum.sales.last === '2026-10-12', 'summary: 4 bills from 3 to 12 Oct');
ok(sum.dispatches.n === 2 && sum.expenses.n === 2 && sum.products.n === 2, 'summary counts');

// ---- bills before a date ----
let p = clearPlan({ what: ['sales'], to: '2026-10-06' });
ok(p.removed.sales === 2 && p.removed.sale_items === 4 && p.data.tables.sales.length === 2, 'bills up to 6 Oct: 2 bills and their 4 lines removed');
ok(p.data.tables.sale_items.every((i) => p.data.tables.sales.some((s) => s.id === i.sale_id)), 'no orphan bill lines');
ok(stockOf(p.data.tables) === stockOf(before), 'stock counts unchanged');
ok(p.data.tables.purchases.length === 1 && p.data.tables.expenses.length === 2, 'nothing else touched');

// ---- bills between two dates ----
p = clearPlan({ what: ['sales'], from: '2026-10-05', to: '2026-10-08' });
ok(p.removed.sales === 2 && p.data.tables.sales.map((s) => s.created_at.slice(8, 10)).join() === '03,12', 'bills from 5 to 8 Oct removed, the others stay');

// ---- several kinds ----
p = clearPlan({ what: ['expenses', 'purchases'], to: '2026-10-04' });
ok(p.removed.expenses === 1 && p.removed.purchases === 1 && p.removed.supplier_payments === 0, 'expenses and purchases up to 4 Oct');

// ---- parcels: the one still on the way is kept ----
p = clearPlan({ what: ['dispatches'] });
ok(p.removed.dispatches === 1 && p.data.tables.dispatches.length === 1 && p.data.tables.dispatches[0].id === d2.id && p.data.tables.dispatch_items.length === 1, 'parcels: received ones removed, the one on the way is kept');

// ---- stock history: counts stay, history adds up ----
p = clearPlan({ what: ['history'], to: '2026-10-08' });
const t = p.data.tables;
const sums = new Map();
for (const m of t.movements) sums.set(m.product_id + ':' + m.location_id, (sums.get(m.product_id + ':' + m.location_id) || 0) + m.qty);
ok(t.stock.every((s) => (sums.get(s.product_id + ':' + s.location_id) || 0) === s.qty), 'after clearing history, kept history still adds up to every stock count');
ok(stockOf(t) === stockOf(before) && p.removed.carried_forward > 0 && t.movements.length < before.movements.length, 'stock counts unchanged; older history replaced by balance lines');

// ---- restoring the kept data really leaves exactly that ----
const stock0 = D.stockQty(a.id, S1);
importData(p.data, { capture: false });
ok(D.stockQty(a.id, S1) === stock0, 'after restoring: stock count unchanged');
ok((await call('GET', '/api/products/' + a.id)).movements.length > 0, 'item history still opens');
importData(clearPlan({ what: ['sales'] }).data, { capture: false });

// ---- everything ----
p = clearPlan({ everything: true });
const e = p.data.tables;
ok(['sales', 'sale_items', 'purchases', 'purchase_items', 'dispatches', 'dispatch_items', 'expenses', 'movements', 'stock', 'products', 'suppliers', 'supplier_payments'].every((k) => e[k].length === 0), 'clear everything: all business data gone');
ok(e.users.length === before.users.length && e.locations.length === 2 && e.settings.length === before.settings.length, 'places, people and settings stay');
importData(p.data, { capture: false });
ok(D.get('SELECT COUNT(*) AS n FROM products').n === 0 && (await call('GET', '/api/me')).locations.length === 2, 'restored: empty business, same places');
const fresh = await call('POST', '/api/products', { name: 'New start', sale_price: 10, variants: [{}] });
ok(fresh.length === 1, 'new items can be added again');

// ---- bad input ----
await assert.rejects(async () => clearPlan({ what: [] }), /Choose what to clear/);
await assert.rejects(async () => clearPlan({ what: ['sales'], from: 'yesterday' }), /not a valid date/);
await assert.rejects(async () => clearPlan({ what: ['users'] }), /Unknown kind/);
ok(true, 'bad requests are refused');

console.log(`\nAll ${checks} clear-data checks passed.`);
