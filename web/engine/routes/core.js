// Logging in with a PIN, settings, shops/warehouses (with their switches) and people.
import * as D from '../db.js';
import { route, fail, toInt, str, need, PERMS, PERM_KEYS, placePerms, permsJson } from '../util.js';
import * as S from '../session.js';

const { all, get, run, tx, now } = D;

const publicUser = (u) => u && ({
  id: u.id, name: u.name, role: u.role, location_id: u.location_id, active: u.active, created_at: u.created_at,
  perms: u.perms ? JSON.parse(u.perms) : null, has_pin: !!u.pin_hash, email: u.email || '',
});
const publicLocation = (l) => l && ({ ...l, perms: placePerms(l), custom_perms: !!l.perms });

// ---------- Logging in ----------
// The "Who's working?" screen: names that may log in on this device.
route('GET', '/api/login-users', null, () => ({
  business_name: D.getSettings().business_name,
  device: D.deviceInfo(),
  location: D.deviceInfo().location_id ? publicLocation(get('SELECT * FROM locations WHERE id = ?', D.deviceInfo().location_id)) : null,
  users: S.loginUsers().map((u) => ({ id: u.id, name: u.name, role: u.role, has_pin: !!u.pin_hash })),
  bound: !!Number(D.get("SELECT value FROM device WHERE key = 'bound_user'")?.value),
}));

// Wrong passcodes: after 5 tries, wait 30 seconds (then 60, 120 …).
const tries = new Map();
export const clearLockout = (id) => tries.delete(id);
route('POST', '/api/login', null, async ({ body }) => {
  const id = toInt(body.user_id);
  const t = tries.get(id) || { n: 0, until: 0 };
  if (Date.now() < t.until) fail(429, `Too many wrong passcodes. Wait ${Math.ceil((t.until - Date.now()) / 1000)} seconds.`);
  const u = S.loginUsers().find((x) => x.id === id) || fail(404, 'This person cannot log in on this device');
  if (!(await S.checkPin(String(body.pin || ''), u))) {
    t.n++;
    if (t.n >= 5) t.until = Date.now() + 30000 * 2 ** Math.min(4, t.n - 5);
    tries.set(id, t);
    fail(401, 'Wrong passcode');
  }
  tries.delete(id);
  S.setCurrent(id);
  return { ok: true };
});

route('POST', '/api/logout', 'any', () => { S.setCurrent(null); });

route('GET', '/api/me', 'any', ({ user }) => ({
  user,
  settings: D.getSettings(),
  locations: all('SELECT * FROM locations ORDER BY type DESC, id').map(publicLocation),
  device: D.deviceInfo(),
  perms_catalog: PERMS,
}));

route('POST', '/api/me/pin', 'any', async ({ user, body }) => {
  const u = get('SELECT * FROM users WHERE id = ?', user.id);
  if (u.pin_hash && !(await S.checkPin(String(body.current || ''), u))) fail(400, 'Your current passcode is wrong');
  if (!S.validPin(body.pin)) fail(400, 'The new passcode must be 4 numbers');
  const p = await S.makePin(body.pin);
  run('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?', p.pin_salt, p.pin_hash, user.id);
});

// Small numbers next to menu items, and how many changes are waiting to go to the cloud.
route('GET', '/api/badges', 'any', ({ user }) => {
  const incoming = user.owner
    ? get("SELECT COUNT(*) AS n FROM dispatches WHERE status = 'in_transit'").n
    : get("SELECT COUNT(*) AS n FROM dispatches WHERE status = 'in_transit' AND to_location_id = ?", user.location_id).n;
  return { incoming, ...syncStatus() };
});

export function syncStatus() {
  const d = Object.fromEntries(all("SELECT key, value FROM device WHERE key IN ('last_sync_at', 'mode')").map((r) => [r.key, r.value]));
  return {
    waiting: get('SELECT COUNT(DISTINCT grp) AS n FROM outbox').n,
    errors: get('SELECT COUNT(*) AS n FROM sync_errors').n,
    last_sync_at: d.last_sync_at || null,
    mode: d.mode || '',
  };
}
route('GET', '/api/sync/status', 'any', () => syncStatus());
route('GET', '/api/sync/errors', 'owner', () => all('SELECT * FROM sync_errors ORDER BY id DESC LIMIT 200'));
route('POST', '/api/sync/errors/clear', 'owner', () => { run('DELETE FROM sync_errors'); });

// ---------- Settings ----------
route('GET', '/api/settings', 'any', () => D.getSettings());

route('PUT', '/api/settings', 'owner', ({ body }) => {
  tx(() => {
    for (const k of Object.keys(D.DEFAULT_SETTINGS)) {
      if (body[k] === undefined) continue;
      const v = str(body[k], 2000);
      const old = get('SELECT value FROM settings WHERE key = ?', k);
      if (!old || old.value !== v) run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
    }
  });
  return D.getSettings();
});

// ---------- Places (warehouse + shops) ----------
route('GET', '/api/locations', 'any', () => all('SELECT * FROM locations ORDER BY type DESC, id').map(publicLocation));

function locationFields(body) {
  return {
    name: need(str(body.name, 80), 'Name'),
    code: need(str(body.code, 6).toUpperCase().replace(/[^A-Z0-9]/g, ''), 'Short code'),
    type: body.type === 'warehouse' ? 'warehouse' : 'shop',
    address: str(body.address, 200),
    phone: str(body.phone, 40),
  };
}
const cleanPerms = (list) => (Array.isArray(list) ? PERM_KEYS.filter((k) => list.includes(k)) : null);

route('POST', '/api/locations', 'owner', ({ body }) => {
  const f = locationFields(body);
  const perms = cleanPerms(body.perms);
  const id = D.newId();
  run('INSERT INTO locations(id, name, code, type, address, phone, perms, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    id, f.name, f.code, f.type, f.address, f.phone, perms ? permsJson(perms) : null, now());
  return publicLocation(get('SELECT * FROM locations WHERE id = ?', id));
});

route('PUT', '/api/locations/:id', 'owner', ({ params, body }) => {
  const id = toInt(params.id);
  const loc = get('SELECT * FROM locations WHERE id = ?', id) || fail(404, 'Place not found');
  const f = locationFields({ ...loc, ...body });
  const active = body.active === undefined ? loc.active : (body.active ? 1 : 0);
  const perms = body.perms === undefined ? loc.perms : (cleanPerms(body.perms) ? permsJson(cleanPerms(body.perms)) : null);
  run('UPDATE locations SET name = ?, code = ?, type = ?, address = ?, phone = ?, perms = ?, active = ? WHERE id = ?',
    f.name, f.code, f.type, f.address, f.phone, perms, active, id);
  return publicLocation(get('SELECT * FROM locations WHERE id = ?', id));
});

// ---------- People ----------
route('GET', '/api/users', 'owner', () => all('SELECT * FROM users ORDER BY active DESC, role, name').map(publicUser));

function checkUserLocation(role, locationId) {
  if (role === 'admin') return null;
  const loc = get('SELECT * FROM locations WHERE id = ?', toInt(locationId)) || fail(400, 'Choose where this person works');
  return loc.id;
}
const activeOwners = (exceptId) => get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", exceptId).n;

route('POST', '/api/users', 'owner', async ({ body }) => {
  const role = body.role === 'admin' ? 'admin' : 'staff';
  const name = need(str(body.name, 80), 'Name');
  // (the person chooses their own passcode when they first sign in; an owner may still set one for an owner)
  if (body.pin && !S.validPin(body.pin)) fail(400, 'The passcode must be 4 numbers');
  const pin = body.pin ? await S.makePin(body.pin) : { pin_salt: null, pin_hash: null };
  const loc = checkUserLocation(role, body.location_id);
  const perms = role === 'admin' ? null : cleanPerms(body.perms);
  const id = D.newId();
  run('INSERT INTO users(id, name, role, location_id, perms, pin_salt, pin_hash, email, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, role, loc, perms ? permsJson(perms) : null, pin.pin_salt, pin.pin_hash, str(body.email, 120) || null, now());
  return publicUser(get('SELECT * FROM users WHERE id = ?', id));
});

route('PUT', '/api/users/:id', 'owner', async ({ params, body, user }) => {
  const id = toInt(params.id);
  const u = get('SELECT * FROM users WHERE id = ?', id) || fail(404, 'Person not found');
  const role = body.role === undefined ? u.role : (body.role === 'admin' ? 'admin' : 'staff');
  const active = body.active === undefined ? u.active : (body.active ? 1 : 0);
  if (u.role === 'admin' && (role !== 'admin' || !active) && activeOwners(id) === 0) fail(400, 'There must always be at least one owner');
  if (id === user.id && !active) fail(400, 'You cannot switch yourself off');
  const name = need(str(body.name ?? u.name, 80), 'Name');
  const loc = checkUserLocation(role, body.location_id ?? u.location_id);
  const perms = role === 'admin' ? null : body.perms === undefined ? u.perms : (cleanPerms(body.perms) ? permsJson(cleanPerms(body.perms)) : null);
  let pin = null;
  if (body.pin) {
    if (!S.validPin(body.pin)) fail(400, 'The passcode must be 4 numbers');
    pin = await S.makePin(body.pin);
  }
  tx(() => {
    run('UPDATE users SET name = ?, role = ?, location_id = ?, perms = ?, active = ?, email = ? WHERE id = ?',
      name, role, loc, perms, active, body.email === undefined ? u.email : (str(body.email, 120) || null), id);
    if (pin) run('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?', pin.pin_salt, pin.pin_hash, id);
  });
  return publicUser(get('SELECT * FROM users WHERE id = ?', id));
});

// ---------- Devices (computers and phones set up for Velanzo) ----------
route('GET', '/api/devices', 'owner', () => all(
  `SELECT d.*, l.name AS location_name, u.name AS user_name FROM devices d
   LEFT JOIN locations l ON l.id = d.location_id LEFT JOIN users u ON u.id = d.last_user_id
   ORDER BY d.active DESC, d.location_id IS NULL, l.name, d.id`));
