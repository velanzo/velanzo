// Vouchers: a code (printed with a QR code) worth Rs or % off a bill. The owner makes them; any seller can use one.
// How often a voucher was used is counted from the bills, so a cancelled bill gives the voucher back.
import * as D from '../db.js';
import { route, fail, toInt, toMoney, str, isDate } from '../util.js';

const { all, get, run, tx, now, today, round2 } = D;

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: easy to read and type
const randomCode = () => {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  const s = Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join('');
  return `VZ-${s.slice(0, 4)}-${s.slice(4)}`;
};

// typed or scanned: case, dashes and spaces do not matter
export const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const findVoucher = (code) => {
  const n = normCode(code);
  return n ? get("SELECT * FROM vouchers WHERE REPLACE(UPPER(code), '-', '') = ?", n) : null;
};
export const usedCount = (code) => get("SELECT COUNT(*) AS n FROM sales WHERE voucher_code = ? AND status = 'done'", code).n;

export function voucherStatus(v, used = usedCount(v.code)) {
  if (!v.active) return 'off';
  if (v.expires && v.expires < today()) return 'expired';
  if (used >= v.max_uses) return 'used';
  return 'ok';
}

// Can this voucher be used on a bill worth `base` (after item and bill discounts)? → { ok, reason, v, amount }
export function tryVoucher(code, base, money = (n) => String(n)) {
  const v = findVoucher(code);
  if (!v) return { ok: false, reason: 'There is no voucher with this code.' };
  const used = usedCount(v.code);
  const st = voucherStatus(v, used);
  const out = { ok: false, v, code: v.code, kind: v.kind, value: v.value, min_bill: v.min_bill, note: v.note || '', used };
  if (st === 'off') return { ...out, reason: 'This voucher is switched off.' };
  if (st === 'expired') return { ...out, reason: `This voucher expired on ${v.expires}.` };
  if (st === 'used') return { ...out, reason: v.max_uses === 1 ? 'This voucher was already used.' : `This voucher was already used ${used} times (its limit).` };
  if (!(base > 0)) return { ...out, reason: 'There is nothing on the bill to take the voucher off.' };
  if (base < v.min_bill) return { ...out, reason: `This voucher needs a bill of at least ${money(v.min_bill)}. This bill is ${money(base)}.` };
  const amount = v.kind === 'pct' ? round2(base * Math.min(v.value, 100) / 100) : round2(Math.min(v.value, base));
  return { ...out, ok: true, amount };
}

const withStatus = (v) => {
  const used = usedCount(v.code);
  const given = get("SELECT COALESCE(SUM(voucher), 0) AS n FROM sales WHERE voucher_code = ? AND status = 'done'", v.code).n;
  return { ...v, used, given: round2(given), status: voucherStatus(v, used) };
};

route('GET', '/api/vouchers', 'owner', () => all('SELECT * FROM vouchers ORDER BY created_at DESC, id DESC LIMIT 2000').map(withStatus));

route('GET', '/api/vouchers/check', 'sell', ({ query }) => {
  const r = tryVoucher(str(query.code, 40), toMoney(query.amount), (n) => `${D.getSettings().currency} ${n}`);
  delete r.v;
  return r;
});

route('GET', '/api/vouchers/:id/bills', 'owner', ({ params }) => {
  const v = get('SELECT * FROM vouchers WHERE id = ?', toInt(params.id)) || fail(404, 'Voucher not found');
  return all(`SELECT s.id, s.bill_no, s.created_at, s.voucher, s.status, l.name AS location_name FROM sales s LEFT JOIN locations l ON l.id = s.location_id
    WHERE s.voucher_code = ? ORDER BY s.created_at DESC`, v.code);
});

route('POST', '/api/vouchers', 'owner', ({ body, user }) => tx(() => {
  const kind = body.kind === 'pct' ? 'pct' : 'amt';
  const value = toMoney(body.value);
  if (!(value > 0)) fail(400, 'Enter how much the voucher is worth');
  if (kind === 'pct' && value > 100) fail(400, 'A percentage voucher cannot be more than 100%');
  const count = Math.min(Math.max(toInt(body.count, 1), 1), 200);
  const maxUses = Math.min(Math.max(toInt(body.max_uses, 1), 1), 100000);
  const minBill = Math.max(0, toMoney(body.min_bill));
  const expires = isDate(body.expires) ? body.expires : null;
  if (expires && expires < today()) fail(400, 'The last day is already over');
  const wanted = str(body.code, 30);
  if (wanted && count > 1) fail(400, 'Choose your own code only when making one voucher');
  const out = [];
  for (let i = 0; i < count; i++) {
    let code = wanted ? wanted.toUpperCase().replace(/\s+/g, '') : randomCode();
    if (wanted && !/^[A-Z0-9-]{3,30}$/.test(code)) fail(400, 'The code can have letters, numbers and dashes only (3 to 30 characters)');
    while (findVoucher(code)) {
      if (wanted) fail(400, `The code ${code} already exists`);
      code = randomCode();
    }
    const id = D.newId();
    run(`INSERT INTO vouchers(id, code, kind, value, min_bill, expires, max_uses, note, active, user_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      id, code, kind, value, minBill, expires, maxUses, str(body.note, 120), user.id, now());
    out.push(withStatus(get('SELECT * FROM vouchers WHERE id = ?', id)));
  }
  return out;
}));

route('PUT', '/api/vouchers/:id', 'owner', ({ params, body }) => tx(() => {
  const v = get('SELECT * FROM vouchers WHERE id = ?', toInt(params.id)) || fail(404, 'Voucher not found');
  const used = usedCount(v.code);
  const next = { ...v };
  if (body.active !== undefined) next.active = body.active ? 1 : 0;
  if (body.note !== undefined) next.note = str(body.note, 120);
  if (body.expires !== undefined) next.expires = isDate(body.expires) ? body.expires : null;
  if (body.min_bill !== undefined) next.min_bill = Math.max(0, toMoney(body.min_bill));
  if (body.max_uses !== undefined) next.max_uses = Math.min(Math.max(toInt(body.max_uses, 1), 1), 100000);
  if (used > 0 && ((body.value !== undefined && toMoney(body.value) !== v.value) || (body.kind !== undefined && body.kind !== v.kind))) fail(400, 'This voucher was already used, so its value cannot change. Make a new one.');
  if (body.value !== undefined) { next.value = toMoney(body.value); if (!(next.value > 0) || (next.kind === 'pct' && next.value > 100)) fail(400, 'The value is not right'); }
  run('UPDATE vouchers SET active = ?, note = ?, expires = ?, min_bill = ?, max_uses = ?, value = ? WHERE id = ?', next.active, next.note, next.expires, next.min_bill, next.max_uses, next.value, v.id);
  return withStatus(get('SELECT * FROM vouchers WHERE id = ?', v.id));
}));

route('DELETE', '/api/vouchers/:id', 'owner', ({ params }) => tx(() => {
  const v = get('SELECT * FROM vouchers WHERE id = ?', toInt(params.id)) || fail(404, 'Voucher not found');
  if (usedCount(v.code) > 0 || get('SELECT 1 FROM sales WHERE voucher_code = ?', v.code)) fail(400, 'This voucher was used on a bill. Switch it off instead.');
  run('DELETE FROM vouchers WHERE id = ?', v.id);
}));
