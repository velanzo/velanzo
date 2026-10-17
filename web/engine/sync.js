// This device's side of syncing with the cloud:
// - changes made here wait in the outbox until the cloud has them (so everything works offline);
// - changes from other devices come down and are written here without going back into the outbox.
import * as D from './db.js';
import { DEFAULT_PERMS, permsJson } from './util.js';
import * as S from './session.js';
import { queueEverything } from './routes/data.js';
import { isActive as practising } from './practice.js';

const { all, get, run, tx, now } = D;
const keyCol = (t) => (t === 'settings' ? 'key' : 'id');

// Waiting changes, one group per action (e.g. a bill with its lines and stock moves), oldest first.
// Each row is sent as it is now; a deleted row is sent as { t, k, del: 1 }.
export function outbox(maxRows = 3000) {
  if (practising()) return []; // practice changes never leave this device
  const entries = all('SELECT * FROM outbox ORDER BY seq LIMIT ?', maxRows);
  const groups = new Map();
  for (const e of entries) {
    let g = groups.get(e.grp);
    if (!g) groups.set(e.grp, (g = { grp: e.grp, seqs: [], rows: [], seen: new Map() }));
    g.seqs.push(e.seq);
    const id = `${e.tbl}:${e.row_key}`;
    const row = e.del ? null : get(`SELECT * FROM ${e.tbl} WHERE ${keyCol(e.tbl)} = ?`, e.tbl === 'settings' ? e.row_key : Number(e.row_key));
    const item = row ? { t: e.tbl, r: row } : { t: e.tbl, k: e.tbl === 'settings' ? e.row_key : Number(e.row_key), del: 1 };
    // the same record twice in one action: send it once, at its first place (parents stay before children)
    if (g.seen.has(id)) g.rows[g.seen.get(id)] = item;
    else { g.seen.set(id, g.rows.length); g.rows.push(item); }
  }
  // a group cut off by the row limit is sent next time, whole
  const list = [...groups.values()];
  if (entries.length === maxRows && list.length > 1) list.pop();
  return list.map(({ grp, seqs, rows }) => ({ grp, seqs, rows }));
}

export function pushed(seqs) {
  if (!seqs.length) return;
  tx(() => { for (const s of seqs) run('DELETE FROM outbox WHERE seq = ?', s); });
}

// The cloud refused this change (e.g. switched off for this place). Keep a note for the owner and move on.
export function refused(group, message) {
  tx(() => {
    run('INSERT INTO sync_errors(grp, message, rows, created_at) VALUES(?, ?, ?, ?)', group.grp, message, JSON.stringify(group.rows).slice(0, 20000), now());
    for (const s of group.seqs) run('DELETE FROM outbox WHERE seq = ?', s);
  });
}

// Writes rows that came from the cloud. Records changed here and not yet sent are left alone (the cloud gets
// this device's version next). Stock: the cloud's count plus this device's unsent moves.
export function applyPull(rows) {
  const pending = new Set(all('SELECT tbl, row_key FROM outbox').map((e) => `${e.tbl}:${e.row_key}`));
  const stockKeys = [];
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    run('UPDATE sync_ctx SET applying = 1');
    for (const item of rows) {
      const t = item.t;
      if (t === 'stock') {
        const r = item.r;
        run('INSERT INTO stock(location_id, product_id, qty) VALUES(?, ?, ?) ON CONFLICT(location_id, product_id) DO UPDATE SET qty = excluded.qty',
          r.location_id, r.product_id, r.qty);
        stockKeys.push([r.location_id, r.product_id]);
        continue;
      }
      const kc = keyCol(t);
      if (item.del) {
        if (!pending.has(`${t}:${item.k}`)) run(`DELETE FROM ${t} WHERE ${kc} = ?`, t === 'settings' ? item.k : Number(item.k));
        continue;
      }
      if (pending.has(`${t}:${item.r[kc]}`)) continue;
      upsert(t, item.r);
    }
    // unsent stock moves made here are not in the cloud's count yet
    for (const [loc, pid] of stockKeys) {
      const extra = get(
        `SELECT COALESCE(SUM(m.qty), 0) AS n FROM outbox o JOIN movements m ON o.tbl = 'movements' AND m.id = CAST(o.row_key AS INTEGER)
         WHERE m.location_id = ? AND m.product_id = ?`, loc, pid).n;
      if (extra) run('UPDATE stock SET qty = qty + ? WHERE location_id = ? AND product_id = ?', extra, loc, pid);
    }
    run('UPDATE sync_ctx SET applying = ?', D.deviceInfo().mode === 'cloud' ? 0 : 1);
  });
}

function upsert(t, row) {
  const cols = D.tableColumns(t).filter((c) => c in row);
  const kc = keyCol(t);
  const set = cols.filter((c) => c !== kc).map((c) => `"${c}" = excluded."${c}"`).join(', ');
  run(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT(${kc}) DO ${set ? 'UPDATE SET ' + set : 'NOTHING'}`, ...cols.map((c) => row[c]));
}

// ---------- Sync bookkeeping kept on this device ----------
export function state() {
  const d = Object.fromEntries(all("SELECT key, value FROM device WHERE key IN ('cursor', 'epoch', 'scope', 'last_sync_at')").map((r) => [r.key, r.value]));
  return { cursor: Number(d.cursor) || 0, epoch: d.epoch || '', scope: d.scope || '', last_sync_at: d.last_sync_at || null };
}
export function saveState(values) { D.setDevice(values); }

// Forget everything that came from the cloud (it is downloaded again). Only done when nothing is waiting to be sent.
export function resetLocal() {
  if (get('SELECT COUNT(*) AS n FROM outbox').n) throw new Error('Changes are still waiting to be sent');
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    run('UPDATE sync_ctx SET applying = 1');
    for (const t of [...D.SYNC_TABLES, 'stock', 'devices']) run(`DELETE FROM ${t}`);
    run("DELETE FROM device WHERE key IN ('cursor', 'scope', 'epoch')");
    run('UPDATE sync_ctx SET applying = 0');
  });
}

// ---------- Setting up this device ----------
// Not connected to the cloud: one device keeps everything (device number 1). It can join the cloud later.
export function setupLocal({ business_name, owner_name, pin_salt, pin_hash }) {
  if (D.deviceInfo().id) throw new Error('This device is already set up');
  D.setDevice({ id: 1, code: 'A', mode: 'local', label: 'This computer' });
  run('UPDATE sync_ctx SET applying = 1'); // nothing to send while there is no cloud
  return startBusiness({ business_name, owner_name, pin_salt, pin_hash });
}

// Joined the cloud as device number `id` (with letter `code`), at a place or (location_id null) as an owner device.
export function setupCloud({ id, code, location_id, label }) {
  const old = D.deviceInfo();
  const hadLocalData = old.mode === 'local' && get('SELECT COUNT(*) AS n FROM users').n > 0;
  D.setDevice({ id, code, location_id: location_id ?? null, mode: 'cloud', label });
  run('UPDATE sync_ctx SET applying = 0');
  // An owner computer that was used without the cloud brings its data up with it.
  if (hadLocalData) queueEverything();
  return { uploaded: hadLocalData };
}

// First start of a new business: settings, the two starting places and the owner.
export function startBusiness({ business_name, owner_name, pin_salt, pin_hash, email }) {
  return tx(() => {
    D.beginGroup();
    if (business_name) run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'business_name', business_name);
    if (!get('SELECT COUNT(*) AS n FROM locations').n) {
      run("INSERT INTO locations(id, name, code, type, perms, created_at) VALUES(?, 'Main warehouse', 'WH', 'warehouse', ?, ?)", D.newId(), permsJson(DEFAULT_PERMS.warehouse), now());
      run("INSERT INTO locations(id, name, code, type, perms, created_at) VALUES(?, 'Shop 1', 'S1', 'shop', ?, ?)", D.newId(), permsJson(DEFAULT_PERMS.shop), now());
    }
    const id = D.newId();
    run("INSERT INTO users(id, name, role, pin_salt, pin_hash, email, created_at) VALUES(?, ?, 'admin', ?, ?, ?, ?)",
      id, owner_name || 'Owner', pin_salt, pin_hash, email || null, now());
    S.setCurrent(id);
    return { user_id: id };
  });
}
