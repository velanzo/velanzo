// Live view for the owner: who is working right now, what each shop and the warehouse did today,
// and one feed of everything that happens (bills, returns, purchases, dispatches, corrections, expenses, payments).
import * as D from '../db.js';
import { route, toInt, isDate } from '../util.js';

const { all, now, today, round2 } = D;

const ONLINE_MINUTES = 3;

// Every part returns the same columns:
// at, kind, location_id, user_id, ref, qty, qty2, amount, note, other, link_type, link_id
// {W} is replaced by that part's own date filter (and location filter) so the indexes are used.
const PARTS = [
  // Bills (kind is worked out below: sale / return / exchange)
  { col: 's.created_at', loc: 's.location_id', sql: `SELECT s.created_at AS at, 'bill' AS kind, s.location_id, s.user_id, s.bill_no AS ref,
      (SELECT COALESCE(SUM(qty), 0) FROM sale_items WHERE sale_id = s.id AND qty > 0) AS qty,
      (SELECT COALESCE(-SUM(qty), 0) FROM sale_items WHERE sale_id = s.id AND qty < 0) AS qty2,
      s.total AS amount, s.payment_method AS note, NULL AS other, 'sale' AS link_type, s.id AS link_id
    FROM sales s WHERE {W}` },
  { col: 's.voided_at', loc: 's.location_id', sql: `SELECT s.voided_at, 'bill_void', s.location_id, s.voided_by, s.bill_no, s.items_qty, NULL, s.total, s.void_reason, NULL, 'sale', s.id
    FROM sales s WHERE s.voided_at IS NOT NULL AND {W}` },
  { col: 'p.created_at', loc: 'p.location_id', sql: `SELECT p.created_at, 'purchase', p.location_id, p.user_id, p.purchase_no, p.total_qty, NULL, p.total, NULL, sup.name, 'purchase', p.id
    FROM purchases p LEFT JOIN suppliers sup ON sup.id = p.supplier_id WHERE {W}` },
  { col: 'd.created_at', loc: 'd.from_location_id', sql: `SELECT d.created_at, 'dispatch', d.from_location_id, d.created_by, d.dispatch_no, d.total_qty, NULL, d.total_value, d.notes, tl.name, 'dispatch', d.id
    FROM dispatches d JOIN locations tl ON tl.id = d.to_location_id WHERE {W}` },
  { col: 'd.received_at', loc: 'd.to_location_id', sql: `SELECT d.received_at, 'received', d.to_location_id, d.received_by, d.dispatch_no, d.received_qty, d.total_qty, d.total_value, NULL, fl.name, 'dispatch', d.id
    FROM dispatches d JOIN locations fl ON fl.id = d.from_location_id WHERE d.received_at IS NOT NULL AND {W}` },
  // Cancelled purchases and dispatches (bills have their own row above)
  { col: 'm.created_at', loc: 'm.location_id', sql: `SELECT MIN(m.created_at), 'cancel_' || m.ref_type, m.location_id, m.user_id,
      CASE m.ref_type WHEN 'purchase' THEN (SELECT purchase_no FROM purchases WHERE id = m.ref_id) ELSE (SELECT dispatch_no FROM dispatches WHERE id = m.ref_id) END,
      ABS(SUM(m.qty)), NULL, NULL, MIN(m.note), NULL, m.ref_type, m.ref_id
    FROM movements m WHERE m.type = 'void' AND m.ref_type IN ('purchase', 'dispatch') AND {W} GROUP BY m.ref_type, m.ref_id, m.location_id` },
  // Stock corrections and new items with opening stock (one row per item name, all its sizes/colours together)
  { col: 'm.created_at', loc: 'm.location_id', sql: `SELECT m.created_at, m.type, m.location_id, m.user_id, p.name, SUM(m.qty), COUNT(*), NULL, m.note,
      CASE WHEN COUNT(*) = 1 THEN TRIM(COALESCE(MIN(p.size), '') || ' ' || COALESCE(MIN(p.color), '')) END, 'product', MIN(m.product_id)
    FROM movements m JOIN products p ON p.id = m.product_id WHERE m.type IN ('adjust', 'opening') AND {W}
    GROUP BY m.type, m.created_at, m.location_id, m.user_id, p.name, m.note` },
  { col: 'e.created_at', loc: 'e.location_id', sql: `SELECT e.created_at, 'expense', e.location_id, e.user_id, e.category, NULL, NULL, e.amount, e.note, NULL, NULL, NULL
    FROM expenses e WHERE {W}` },
  { col: 'sp.created_at', loc: null, sql: `SELECT sp.created_at, 'payment', NULL, sp.user_id, sup.name, NULL, NULL, sp.amount, sp.note, sp.method, 'supplier', sp.supplier_id
    FROM supplier_payments sp JOIN suppliers sup ON sup.id = sp.supplier_id WHERE {W}` },
];

function activity({ from, to, locationId, limit }) {
  const parts = [], params = [];
  for (const p of PARTS) {
    let w = `${p.col} >= ? AND ${p.col} <= ?`;
    const ps = [from, to];
    if (locationId) {
      if (!p.loc) continue; // supplier payments are not tied to a shop
      w += ` AND ${p.loc} = ?`; ps.push(locationId);
    }
    parts.push(`SELECT * FROM (${p.sql.replace('{W}', w)})`);
    params.push(...ps);
  }
  const rows = all(`${parts.join('\nUNION ALL\n')}\nORDER BY 1 DESC LIMIT ?`, ...params, limit);
  const locs = new Map(all('SELECT id, name, type FROM locations').map((l) => [l.id, l]));
  const users = new Map(all('SELECT id, name FROM users').map((u) => [u.id, u.name]));
  return rows.map((r) => {
    let kind = r.kind;
    if (kind === 'bill') kind = !r.qty2 ? 'sale' : !r.qty ? 'return' : 'exchange';
    const loc = locs.get(r.location_id);
    return {
      at: r.at, kind, ref: r.ref, qty: r.qty, qty2: r.qty2, amount: r.amount == null ? null : round2(r.amount),
      note: r.note, other: r.other, link_type: r.link_type, link_id: r.link_id,
      location_id: r.location_id, location_name: loc ? loc.name : '', location_type: loc ? loc.type : '',
      user_name: users.get(r.user_id) || '',
    };
  });
}

// Devices that talked to the cloud in the last few minutes (each one checks in every minute while open),
// with the person logged in on them.
function online() {
  return all(
    `SELECT u.id AS user_id, u.name, u.role, d.location_id, l.name AS location_name, d.label AS device, d.last_seen_at
     FROM devices d JOIN users u ON u.id = d.last_user_id LEFT JOIN locations l ON l.id = d.location_id
     WHERE d.active = 1 AND d.last_seen_at >= ?
     ORDER BY d.location_id IS NULL, l.type DESC, l.id, u.name`,
    now(new Date(Date.now() - ONLINE_MINUTES * 60000)));
}

// Each location today: last time anything happened there, bills and sales, pieces in and out.
function locationsToday() {
  const t = today() + ' 00:00:00';
  const by = (sql) => new Map(all(sql, t).map((r) => [r.id, r]));
  const sales = by(`SELECT location_id AS id, COUNT(*) AS bills, COALESCE(SUM(total), 0) AS total FROM sales WHERE status = 'done' AND created_at >= ? GROUP BY location_id`);
  const sent = by(`SELECT from_location_id AS id, SUM(total_qty) AS n FROM dispatches WHERE status <> 'cancelled' AND created_at >= ? GROUP BY from_location_id`);
  const got = by(`SELECT to_location_id AS id, SUM(received_qty) AS n FROM dispatches WHERE received_at >= ? GROUP BY to_location_id`);
  const bought = by(`SELECT location_id AS id, SUM(total_qty) AS n FROM purchases WHERE status = 'done' AND created_at >= ? GROUP BY location_id`);
  const coming = new Map(all("SELECT to_location_id AS id, COUNT(*) AS n FROM dispatches WHERE status = 'in_transit' GROUP BY to_location_id").map((r) => [r.id, r.n]));
  const last = new Map(all('SELECT location_id AS id, MAX(created_at) AS at FROM movements GROUP BY location_id').map((r) => [r.id, r.at]));
  return all('SELECT id, name, type FROM locations WHERE active = 1 ORDER BY type DESC, id').map((l) => ({
    id: l.id, name: l.name, type: l.type,
    last_activity: last.get(l.id) || null,
    bills: sales.get(l.id)?.bills || 0,
    sales: round2(sales.get(l.id)?.total || 0),
    pieces_sent: sent.get(l.id)?.n || 0,
    pieces_received: got.get(l.id)?.n || 0,
    pieces_bought: bought.get(l.id)?.n || 0,
    coming: coming.get(l.id) || 0,
  }));
}

function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return now(d).slice(0, 10); }

// Polled by the owner's dashboard every few seconds.
route('GET', '/api/live', 'owner', () => ({
  at: now(),
  online: online(),
  locations: locationsToday(),
  activity: activity({ from: daysAgo(7) + ' 00:00:00', to: '9999', limit: 30 }),
}));

// Full activity log with filters.
route('GET', '/api/activity', 'owner', ({ query }) => {
  const from = isDate(query.from) ? query.from : today();
  const to = isDate(query.to) ? query.to : today();
  return activity({ from: from + ' 00:00:00', to: to + ' 23:59:59', locationId: toInt(query.location_id) || null, limit: 2000 });
});
