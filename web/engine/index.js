// The Velanzo engine: all the shop logic, working on this device's own database.
// The page talks to it like a small server: handle({ method, path, query, body }) → { status, body }.
import * as D from './db.js';
import { match, HttpError, can } from './util.js';
import * as S from './session.js';
import * as Sync from './sync.js';
import * as Practice from './practice.js';
import './routes/core.js';
import './routes/inventory.js';
import './routes/sales.js';
import './routes/data.js';
import './routes/activity.js';

export function init(adapter) { D.init(adapter); }

export async function handle({ method = 'GET', path, query = {}, body = {} }) {
  const m = match(method, path);
  if (!m) return { status: 404, body: { error: 'Not found' } };
  const user = S.currentUser();
  const a = m.route.access;
  if (a !== null) {
    if (!user) return { status: 401, body: { error: 'Please log in again' } };
    const allowed = a === 'any' ? true : a === 'owner' ? user.owner : (Array.isArray(a) ? a : [a]).some((p) => can(user, p));
    if (!allowed) return { status: 403, body: { error: a === 'owner' ? 'Only the owner can do this' : 'This is switched off for you. Ask the owner if you need it.' } };
  }
  try {
    if (method !== 'GET') D.beginGroup();
    const out = await m.route.handler({ params: m.params, query, body, user });
    return { status: 200, body: out === undefined ? { ok: true } : out };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message, ...e.extra } };
    const msg = String((e && e.message) || e);
    if (msg.includes('UNIQUE constraint failed')) {
      const field = msg.split('.').pop().replace(/_/g, ' ');
      return { status: 409, body: { error: `This ${field} is already used. Please choose a different one.` } };
    }
    console.error(e);
    return { status: 500, body: { error: 'Something went wrong: ' + msg } };
  }
}

// Things the page itself does (setting up this device, syncing) — not available as API routes.
export const system = {
  info: () => ({
    device: D.deviceInfo(),
    has_users: D.get('SELECT COUNT(*) AS n FROM users').n > 0,
    user_id: S.currentUser()?.id || null,
    sync: Sync.state(),
    practice: Practice.isActive(),
  }),
  setupLocal: async ({ business_name, owner_name, pin }) => Sync.setupLocal({ business_name, owner_name, ...(await S.makePin(pin)) }),
  setupCloud: (args) => Sync.setupCloud(args),
  startBusiness: async ({ business_name, owner_name, pin, email }) => Sync.startBusiness({ business_name, owner_name, email, ...(await S.makePin(pin)) }),
  practiceStatus: () => Practice.status(),
  practiceStart: () => Practice.start(),
  practiceFinish: () => Practice.finish(),
  outbox: (max) => Sync.outbox(max),
  pushed: (seqs) => Sync.pushed(seqs),
  refused: (group, message) => Sync.refused(group, message),
  applyPull: (rows) => Sync.applyPull(rows),
  saveState: (values) => Sync.saveState(values),
  resetLocal: () => Sync.resetLocal(),
  // An owner with no PIN yet (e.g. after restoring a backup from the old version) chooses one on an owner device.
  setFirstPin: async ({ user_id, pin }) => {
    const u = D.get('SELECT * FROM users WHERE id = ? AND active = 1', user_id);
    if (!u || u.role !== 'admin' || u.pin_hash || D.deviceInfo().location_id != null) throw new Error('Not allowed');
    if (!S.validPin(pin)) throw new Error('The PIN must be 4 to 6 numbers');
    const p = await S.makePin(pin);
    D.beginGroup();
    D.run('UPDATE users SET pin_salt = ?, pin_hash = ? WHERE id = ?', p.pin_salt, p.pin_hash, user_id);
  },
  forgetDevice: () => {
    // "Remove this device": everything on it is deleted (the cloud keeps the data).
    for (const t of [...D.SYNC_TABLES, 'stock', 'devices', 'device', 'counters', 'outbox', 'sync_errors']) D.run(`DELETE FROM ${t}`);
  },
};
