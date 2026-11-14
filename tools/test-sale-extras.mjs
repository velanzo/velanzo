// Sale order: cash bills rounded to the nearest 10 (round off) and the order date (a sale entered for an earlier day).
// Run: node --disable-warning=ExperimentalWarning tools/test-sale-extras.mjs
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
const ok = (c, m) => { assert.ok(c, m); checks++; console.log('  ✓ ' + m); };
const refused = async (p, re, m) => { try { await p; } catch (e) { ok(re.test(e.message), `${m}: ${e.message}`); return; } assert.fail(m + ' (it was allowed)'); };
globalThis.__vzClock = () => new Date('2026-11-14T15:30:00');

await E.system.setupLocal({ business_name: 'Sale Test', owner_name: 'Owner', pin: '1234' });
const me = await call('GET', '/api/me');
const S1 = me.locations.find((l) => l.type === 'shop').id;
const [p] = await call('POST', '/api/products', { name: 'Shirt', sale_price: 999, cost_price: 500, variants: [{ size: 'M' }] });
D.moveStock(p.id, S1, 10, 'opening', null, null, me.user.id, 'start');

// ---- cash bills are rounded to the nearest 10 by themselves ----
let s = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }] });
ok(s.total === 1000 && s.round_off === 1 && s.subtotal === 999, 'cash bill of 999: total 1,000, round off +1');
s = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 2 }], discount: 4, paid: 2000 });
ok(s.total === 1990 && s.round_off === -4 && s.change_due === 10, 'cash bill of 1,994: total 1,990, round off −4, change from 2,000 is 10');
s = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }], payment_method: 'card' });
ok(s.total === 999 && s.round_off === 0, 'a card bill is not rounded');
const net = D.get("SELECT SUM(total) AS n FROM sales WHERE status = 'done'").n;
ok(net === 1000 + 1990 + 999, 'sales totals include the round off');
await refused(call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }], paid: 995 }), /less than the bill total/, 'cash under the rounded total is refused');

// ---- order date ----
s = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }], date: '2026-11-10' });
ok(s.created_at.startsWith('2026-11-10 '), 'a sale for 10 Nov is dated 10 Nov: ' + s.created_at);
ok(D.all("SELECT created_at FROM movements WHERE ref_type = 'sale' AND ref_id = ?", s.id).every((m) => m.created_at.startsWith('2026-11-10')), 'its stock change is dated 10 Nov too');
const list = await call('GET', '/api/sales', {}, { from: '2026-11-10', to: '2026-11-10' });
ok(list.length === 1 && list[0].id === s.id, 'it shows among the bills of 10 Nov');
s = await call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }], date: '2026-11-14' });
ok(s.created_at.startsWith('2026-11-14'), "today's date: a normal sale");
await refused(call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }], date: '2026-11-20' }), /future/, 'a future date is refused');
await refused(call('POST', '/api/sales', { location_id: S1, items: [{ product_id: p.id, qty: 1 }], date: 'last week' }), /not a valid date/, 'a wrong date is refused');

console.log(`\nAll ${checks} sale order checks passed.`);
