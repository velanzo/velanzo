// Fills the preview's stand-in cloud with a made-up business: two weeks of purchases, dispatches, bills,
// expenses — made by three devices (owner laptop, warehouse PC, Shop 1 counter) and synced like the real thing.
// For the user-guide pictures and for trying Velanzo out.
//   1. npm run dev            (in another window)
//   2. node --disable-warning=ExperimentalWarning tools/demo-data.mjs [http://localhost:4000]
// It EMPTIES the stand-in cloud first. Logins are written to .dev-cloud/demo.json.
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSyncer } from '../web/engine/syncer.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const DEMO = { owner_email: 'owner@demo.local', owner_password: 'demo-pass-123', owner_pin: '1234', pins: { Bilal: '1111', Ahmed: '2222', Sara: '3333' } };

let seed = 7;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const dayAt = (ago, h, m) => { const d = new Date(); d.setDate(d.getDate() - ago); d.setHours(h, m, between(0, 59), 0); return d.getTime(); };
const minsAgo = (mins) => Date.now() - mins * 60000;
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ---------- talking to the stand-in cloud like supabase-js does ----------
async function post(p, body, token) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${p}: ${data && (data.message || data.msg)}`);
  return data;
}
const rpcAs = (token) => (fn, args) => post(`/cloud/rest/v1/rpc/${fn}`, args, token);

function device(name, token) {
  const w = new Worker(new URL('./engine-worker.mjs', import.meta.url));
  let seq = 0;
  const pending = new Map();
  w.on('message', (m) => { const p = pending.get(m.id); pending.delete(m.id); m.ok ? p.resolve(m.out) : p.reject(new Error(`${name}: ${m.error}`)); });
  const send = (kind, n, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); w.postMessage({ id, kind, name: n, args }); });
  const system = (n, ...args) => send('system', n, args);
  const rpc = rpcAs(token);
  const syncer = createSyncer({ system, rpc });
  return {
    name, system, rpc,
    at: (ms) => send('clock', null, [ms]),
    sync: async () => { await send('clock', null, [null]); return syncer.syncOnce(); },
    async call(method, p, body) {
      const r = await send('api', null, [{ method, path: p, body: body || {}, query: {} }]);
      if (r.status !== 200) throw new Error(`${name}: ${method} ${p} → ${r.body.error}`);
      return r.body;
    },
    stop: () => w.terminate(),
  };
}

await post('/cloud/dev/reset');

// ---------- the owner starts the business ----------
const ownerSession = await post('/cloud/auth/v1/signup', { email: DEMO.owner_email, password: DEMO.owner_password });
const ownerRpc = rpcAs(ownerSession.access_token);
await ownerRpc('create_owner', { p_email: DEMO.owner_email });
const od = await ownerRpc('register_owner_device', { p_label: 'Owner laptop', p_now: null });
const owner = device('owner', ownerSession.access_token);
await owner.system('setupCloud', { ...od, label: 'Owner laptop' });
await owner.at(dayAt(22, 9, 0));
await owner.system('startBusiness', { business_name: 'Velanzo Clothing', owner_name: 'Owner', pin: DEMO.owner_pin, email: DEMO.owner_email });
await owner.call('PUT', '/api/settings', { business_name: 'Velanzo Clothing', currency: 'Rs', business_address: 'Main Market, City Centre', business_phone: '0300 1234567' });
const me = await owner.call('GET', '/api/me');
const WH = me.locations.find((l) => l.type === 'warehouse').id;
const S1 = me.locations.find((l) => l.type === 'shop').id;
await owner.call('PUT', `/api/locations/${S1}`, { name: 'Shop 1', address: 'Main Market, City Centre', phone: '0300 1234567' });
await owner.call('PUT', `/api/locations/${WH}`, { name: 'Main warehouse' });
const people = {
  Bilal: await owner.call('POST', '/api/users', { name: 'Bilal', role: 'staff', location_id: WH, pin: DEMO.pins.Bilal }),
  Ahmed: await owner.call('POST', '/api/users', { name: 'Ahmed', role: 'staff', location_id: S1, pin: DEMO.pins.Ahmed }),
  Sara: await owner.call('POST', '/api/users', { name: 'Sara', role: 'staff', location_id: S1, pin: DEMO.pins.Sara, perms: ['sell', 'receive', 'expenses'] }),
};
const sup = {};
for (const [k, name, address] of [['noor', 'Al-Noor Textiles', 'Cloth Market'], ['city', 'City Garments', 'Industrial Area'], ['denim', 'Denim House', 'Factory Road']]) {
  sup[k] = (await owner.call('POST', '/api/suppliers', { name, address })).id;
}
const catalog = [
  { name: 'Lawn Kurta Embroidered', category: 'Kurta', cost: 1200, price: 2450, sizes: ['S', 'M', 'L', 'XL'], colors: ['Blue', 'Peach'], sup: 'noor', qty: [12, 18] },
  { name: 'Abaya Classic', category: 'Abaya', cost: 2200, price: 4500, sizes: ['Free Size'], colors: ['Black'], sup: 'noor', qty: [12, 16] },
  { name: 'Cotton Shirt Formal', category: 'Shirt', cost: 900, price: 1990, sizes: ['M', 'L', 'XL'], colors: ['White', 'Sky Blue'], sup: 'city', qty: [12, 16] },
  { name: 'Polo T-Shirt', category: 'T-Shirt', cost: 650, price: 1450, sizes: ['S', 'M', 'L', 'XL'], colors: ['Black', 'Navy'], sup: 'city', qty: [10, 14] },
  { name: 'Kids Frock', category: 'Kids', cost: 800, price: 1750, sizes: ['2-3Y', '4-5Y', '6-7Y'], colors: ['Pink'], sup: 'city', qty: [8, 12] },
  { name: 'Denim Jeans Slim', category: 'Jeans', cost: 1500, price: 3200, sizes: ['30', '32', '34', '36'], colors: ['Blue'], sup: 'denim', qty: [10, 14] },
];
const products = [];
for (const c of catalog) {
  const variants = [];
  for (const color of c.colors) for (const size of c.sizes) variants.push({ size, color });
  for (const p of await owner.call('POST', '/api/products', { name: c.name, category: c.category, cost_price: c.cost, sale_price: c.price, variants })) products.push({ ...p, sup: c.sup, qtyRange: c.qty });
}
await owner.sync();

// ---------- the warehouse PC and the Shop 1 counter join with codes ----------
async function join(name, loc, label, person) {
  const s = await post('/cloud/auth/v1/signup', {});
  const code = await ownerRpc('create_setup_code', { p_location: loc });
  const d = device(name, s.access_token);
  const info = await d.rpc('claim_device', { p_code: code, p_label: label, p_now: null });
  await d.system('setupCloud', { ...info, label });
  await d.sync();
  await d.call('POST', '/api/login', { user_id: people[person].id, pin: DEMO.pins[person] });
  return d;
}
const wh = await join('warehouse', WH, 'Warehouse PC', 'Bilal');
const shop = await join('shop', S1, 'Shop 1 counter', 'Ahmed');

// ---------- two weeks of work ----------
const whStock = {}, shopStock = {};
for (const [k, ago, paidAll, invoice] of [['noor', 20, false, 'ANT-2231'], ['city', 18, true, 'CG-1187'], ['denim', 12, false, 'DH-0094']]) {
  await wh.at(dayAt(ago, 11, 20));
  const items = products.filter((p) => p.sup === k).map((p) => ({ product_id: p.id, qty: between(...p.qtyRange), cost: p.cost_price }));
  const total = items.reduce((a, i) => a + i.qty * i.cost, 0);
  await wh.call('POST', '/api/purchases', { supplier_id: sup[k], invoice_no: invoice, date: ymd(dayAt(ago, 11, 20)), paid: paidAll ? total : k === 'noor' ? 60000 : 0, items });
  for (const i of items) whStock[i.product_id] = (whStock[i.product_id] || 0) + i.qty;
}
await wh.sync();

async function dispatch(ago, share, receive, missing = 0) {
  const items = [];
  for (const p of products) {
    const q = share ? Math.floor((whStock[p.id] || 0) * share) : Math.min(3, (whStock[p.id] || 0) - 1);
    if (q > 0) items.push({ product_id: p.id, qty: q });
  }
  if (!share) items.splice(7);
  await wh.at(ago ? dayAt(ago, 10, 15) : minsAgo(75));
  const r = await wh.call('POST', '/api/dispatches', { to_location_id: S1, items, notes: receive ? '' : 'Driver: Imran, 2 bags' });
  for (const i of items) whStock[i.product_id] -= i.qty;
  await wh.sync();
  if (!receive) return;
  await shop.sync();
  await shop.at(dayAt(ago, 16, 40));
  const d = await shop.call('GET', `/api/dispatches/${r.id}`);
  const got = d.items.map((it, n) => ({ id: it.id, received_qty: n === 0 ? it.qty - missing : it.qty }));
  await shop.call('POST', `/api/dispatches/${r.id}/receive`, { items: got });
  for (const it of d.items) shopStock[it.product_id] = (shopStock[it.product_id] || 0) + got.find((g) => g.id === it.id).received_qty;
  await shop.sync();
}

async function sellDays(fromAgo, toAgo) {
  for (let ago = fromAgo; ago >= toAgo; ago--) {
    const n = between(2, 5);
    const times = ago
      ? Array.from({ length: n }, () => [between(11, 20), between(0, 59)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([h, m]) => dayAt(ago, h, m))
      : Array.from({ length: n }, () => between(5, 600)).sort((a, b) => b - a).map(minsAgo);
    for (const t of times) {
      const lines = [];
      for (let k = between(1, 3); k > 0; k--) {
        const avail = products.filter((p) => (shopStock[p.id] || 0) > 0 && !lines.some((l) => l.product_id === p.id));
        if (!avail.length) break;
        const p = pick(avail);
        lines.push({ product_id: p.id, qty: rand() < 0.15 && shopStock[p.id] > 1 ? 2 : 1 });
      }
      if (!lines.length) continue;
      const sub = lines.reduce((a, l) => a + l.qty * products.find((p) => p.id === l.product_id).sale_price, 0);
      const discount = rand() < 0.3 ? pick([50, 100, 150, 200]) : 0;
      const r = rand();
      const method = r < 0.6 ? 'cash' : r < 0.85 ? 'card' : 'online';
      await shop.at(t);
      await shop.call('POST', '/api/sales', { items: lines, discount, payment_method: method, paid: method === 'cash' ? Math.ceil((sub - discount) / 500) * 500 : '' });
      for (const l of lines) shopStock[l.product_id] -= l.qty;
    }
  }
  await shop.sync();
}

await dispatch(15, 0.6, true);
await sellDays(13, 9);
await dispatch(8, 0.6, true, 1);
await sellDays(8, 1);
// an exchange: a kurta comes back for another size
const kurtaM = products.find((p) => p.name.startsWith('Lawn') && p.size === 'M' && p.color === 'Blue');
const kurtaL = products.find((p) => p.name.startsWith('Lawn') && p.size === 'L' && p.color === 'Blue');
await shop.at(dayAt(1, 21, 15));
await shop.call('POST', '/api/sales', { items: [{ product_id: kurtaM.id, qty: -1 }, { product_id: kurtaL.id, qty: 1 }], customer_name: 'Exchange (size)' });
await sellDays(0, 0);
await dispatch(0, 0, false); // today's parcel is still on the way

// expenses, a supplier payment and a stock correction
for (const [d, ago, loc, category, amount, note] of [[shop, 15, S1, 'Rent', 35000, 'October rent'], [shop, 9, S1, 'Electricity', 8200, 'Shop bill'],
  [wh, 6, WH, 'Transport', 2500, 'Loader to shop'], [shop, 3, S1, 'Food / Tea', 900, ''], [shop, 1, S1, 'Packing', 1800, 'Shopping bags']]) {
  await d.at(dayAt(ago, 18, 30));
  await d.call('POST', '/api/expenses', { date: ymd(dayAt(ago, 18, 30)), location_id: loc, category, amount, note });
}
await wh.at(dayAt(5, 15, 0));
await wh.call('POST', `/api/suppliers/${sup.noor}/payments`, { amount: 30000, date: ymd(dayAt(5, 15, 0)), method: 'bank transfer', note: 'Part payment' });
await wh.at(minsAgo(40));
const polo = products.find((p) => p.name.startsWith('Polo') && p.size === 'M' && p.color === 'Black');
await wh.call('POST', '/api/stock/adjust', { location_id: WH, product_id: polo.id, qty: -1, reason: 'Damaged' });
for (const d of [wh, shop, owner]) await d.sync();
for (const d of [wh, shop, owner]) await d.sync();

fs.mkdirSync(path.join(ROOT, '.dev-cloud'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.dev-cloud', 'demo.json'), JSON.stringify({ ...DEMO, base: BASE, shop_location: S1, warehouse_location: WH }, null, 2));
const sales = (await owner.call('GET', '/api/reports', null)).summary;
console.log(`Demo business ready: ${products.length} items. Logins are in .dev-cloud/demo.json.`, sales ? '' : '');
for (const d of [owner, wh, shop]) await d.stop();
process.exit(0);
