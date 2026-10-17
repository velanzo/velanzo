// Who is working on this device right now (chosen on the "Who's working?" screen with a PIN).
import * as D from './db.js';
import { personPerms, PERM_KEYS } from './util.js';

// PINs are never stored, only a slow one-way hash of them (PBKDF2), so the hash can't easily be turned back.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 120000 }, key, 256);
  return hex(bits);
}
export async function makePin(pin) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return { pin_salt: salt, pin_hash: await hashPin(pin, salt) };
}
export async function checkPin(pin, user) {
  if (!user.pin_hash || !user.pin_salt) return false;
  return (await hashPin(pin, user.pin_salt)) === user.pin_hash;
}
export const validPin = (pin) => /^\d{4,6}$/.test(String(pin || ''));

// People who may log in on this device: the owner(s), plus staff of this device's place.
export function loginUsers() {
  const dev = D.deviceInfo();
  if (dev.location_id == null) return D.all("SELECT * FROM users WHERE active = 1 AND role = 'admin' ORDER BY name");
  return D.all("SELECT * FROM users WHERE active = 1 AND (role = 'admin' OR location_id = ?) ORDER BY role = 'admin', name", dev.location_id);
}

export function setCurrent(userId) {
  D.setDevice({ user_id: userId || null });
}

// The person working, with what they may do here.
export function currentUser() {
  const dev = D.deviceInfo();
  const id = Number(D.get("SELECT value FROM device WHERE key = 'user_id'")?.value) || 0;
  if (!id || !dev.id) return null;
  const u = D.get('SELECT * FROM users WHERE id = ? AND active = 1', id);
  if (!u) return null;
  const ownerDevice = dev.location_id == null;
  if (ownerDevice && u.role !== 'admin') return null;
  if (!ownerDevice && u.role !== 'admin' && u.location_id !== dev.location_id) return null;
  const loc = ownerDevice ? null : D.get('SELECT * FROM locations WHERE id = ?', dev.location_id);
  return {
    id: u.id, name: u.name, role: u.role, email: u.email,
    owner: ownerDevice,
    location_id: ownerDevice ? null : dev.location_id,
    perms: ownerDevice ? [...PERM_KEYS] : personPerms(u, loc),
    has_pin: !!u.pin_hash,
  };
}
