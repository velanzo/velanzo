// Tiny router, input helpers and permissions shared by all route files.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

const routes = [];
// access: null = no login needed, 'any' = anyone logged in, 'owner' = the owner on an owner device,
// 'perm' or ['perm', ...] = needs one of these switches (see PERMS).
export function route(method, pattern, access, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, access, handler, literal: !keys.length });
  // literal paths (e.g. /api/purchases/new) win over parameter paths
  routes.sort((a, b) => Number(b.literal) - Number(a.literal));
}
export function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

export const toInt = (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
export const toMoney = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : d; };
export const str = (v, max = 500) => (v == null ? '' : String(v)).trim().slice(0, max);
export const need = (v, label) => { if (v === '' || v == null) fail(400, `${label} is required`); return v; };
export const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// ---------- What each place and person may do ----------
// [key, label, group]. The owner switches these on or off per place (Settings → Shops) and per person.
export const PERMS = [
  ['sell', 'Sell and print bills', 'Selling'],
  ['returns', 'Returns and exchanges', 'Selling'],
  ['discount', 'Give discounts', 'Selling'],
  ['change_price', 'Change prices on a bill', 'Selling'],
  ['void_bills', 'Cancel bills', 'Selling'],
  ['receive', 'Receive stock', 'Stock'],
  ['buy', 'Buy from suppliers', 'Stock'],
  ['send', 'Send stock to other places', 'Stock'],
  ['add_items', 'Add new items and print labels', 'Stock'],
  ['correct_stock', 'Correct stock counts', 'Stock'],
  ['expenses', 'Record expenses', 'Money'],
  ['see_cost', 'See cost price and profit', 'Money'],
  ['reports', 'See reports for this place', 'Money'],
];
export const PERM_KEYS = PERMS.map((p) => p[0]);
export const DEFAULT_PERMS = {
  shop: ['sell', 'returns', 'discount', 'receive', 'expenses'],
  warehouse: ['receive', 'buy', 'send', 'add_items', 'correct_stock', 'expenses', 'see_cost'],
};

const parsePerms = (text) => {
  if (text == null || text === '') return null;
  try { const o = JSON.parse(text); return PERM_KEYS.filter((k) => o[k]); } catch { return null; }
};
// What a place is allowed to do (its own switches, or the defaults for its type).
export const placePerms = (loc) => parsePerms(loc && loc.perms) || DEFAULT_PERMS[loc && loc.type] || [];
// What a person may do there: only what both the place and the person's own switches allow.
export function personPerms(user, loc) {
  const place = placePerms(loc);
  if (user.role === 'admin') return place;
  const own = parsePerms(user.perms);
  return own ? place.filter((k) => own.includes(k)) : place;
}
export const permsJson = (list) => JSON.stringify(Object.fromEntries(PERM_KEYS.map((k) => [k, list.includes(k) ? 1 : 0])));

// The person working: user.owner = the owner on an owner device (sees and does everything, everywhere).
export const can = (user, perm) => !!user && (user.owner || user.perms.includes(perm));
export const canSeeCost = (user) => can(user, 'see_cost') || can(user, 'buy');
export function needPerm(user, perm, what) {
  if (!can(user, perm)) fail(403, `${what || 'This'} is switched off for you. Ask the owner if you need it.`);
}

// Staff always work at their device's place; the owner (on an owner device) can choose any place.
export function userLocation(user, requested) {
  if (user.owner) return toInt(requested, 0) || null;
  if (!user.location_id) fail(400, 'This device is not linked to a shop or warehouse');
  return user.location_id;
}
