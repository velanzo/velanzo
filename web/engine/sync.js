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

// What goes up for one changed record. `base` is what the change was based on (see db.js):
// a document says which version it saw; other records send only the columns that really changed.
function toSend(t, row, base) {
  if (base == null) return row;
  if (D.VERSIONED_TABLES.includes(t)) return { ...row, _base: Number(base) };
  if (!D.MERGE_COLS[t]) return row;
  let old;
  try { old = JSON.parse(base); } catch { return row; }
  const out = { id: row.id };
  for (const c of Object.keys(row)) if (c !== 'id' && old[c] !== row[c]) out[c] = row[c];
  return out;
}

// Waiting changes, one group per action (e.g. a bill with its lines and stock moves), oldest first.
// Each row is sent as it is now; a deleted row is sent as { t, k, del: 1 }.
export function outbox(maxRows = 3000) {
  if (practising()) return []; // practice changes never leave this device
  let entries = all('SELECT * FROM outbox ORDER BY seq LIMIT ?', maxRows);
  // An action is always sent whole (the cloud remembers it as done): one cut off by the limit goes next time,
  // and one bigger than the limit goes alone, all of it.
  if (entries.length === maxRows) {
    const last = entries[entries.length - 1].grp;
    entries = entries[0].grp === last ? all('SELECT * FROM outbox WHERE grp = ? ORDER BY seq', last) : entries.filter((e) => e.grp !== last);
  }
  const groups = new Map();
  for (const e of entries) {
    let g = groups.get(e.grp);
    if (!g) groups.set(e.grp, (g = { grp: e.grp, seqs: [], rows: [], seen: new Map() }));
    g.seqs.push(e.seq);
    const id = `${e.tbl}:${e.row_key}`;
    const first = g.seen.get(id);
    const row = e.del ? null : get(`SELECT * FROM ${e.tbl} WHERE ${keyCol(e.tbl)} = ?`, e.tbl === 'settings' ? e.row_key : Number(e.row_key));
    // the same record twice in one action: send it once, at its first place (parents stay before children),
    // based on what it was before the action
    const item = row ? { t: e.tbl, r: toSend(e.tbl, row, first ? first.base : e.base) } : { t: e.tbl, k: e.tbl === 'settings' ? e.row_key : Number(e.row_key), del: 1 };
    if (first) g.rows[first.i] = item;
    else { g.seen.set(id, { i: g.rows.length, base: e.base }); g.rows.push(item); }
  }
  return [...groups.values()].map(({ grp, seqs, rows }) => ({ grp, seqs, rows }));
}

export const waiting = () => get('SELECT COUNT(*) AS n FROM outbox').n;

export function pushed(seqs) {
  if (!seqs.length) return;
  tx(() => { for (const s of seqs) run('DELETE FROM outbox WHERE seq = ?', s); });
}

// The cloud refused this change (e.g. switched off for this place, or another computer changed the record first).
// Keep a note for the people here and move on. What it did on this computer is undone by downloading everything
// again as soon as nothing is waiting, so this computer never keeps showing something the cloud does not have.
export function refused(group, message) {
  tx(() => {
    run('INSERT INTO sync_errors(grp, message, rows, created_at) VALUES(?, ?, ?, ?)', group.grp, message, JSON.stringify(group.rows).slice(0, 20000), now());
    for (const s of group.seqs) run('DELETE FROM outbox WHERE seq = ?', s);
    D.setDevice({ rebuild: 1 });
  });
}

// Writes rows that came from the cloud. Records changed here and not yet sent are left alone (the cloud gets
// this device's version next). Stock: the cloud's count plus this device's unsent moves.
// → { changed, tables }: what is really different now (a computer's own changes also come back, the same as they went).
export function applyPull(rows) {
  const pending = new Set(all('SELECT tbl, row_key FROM outbox').map((e) => `${e.tbl}:${e.row_key}`));
  const out = { changed: 0, tables: [] };
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    run('UPDATE sync_ctx SET applying = 1');
    writeRows(rows, pending, out);
    run('UPDATE sync_ctx SET applying = ?', D.deviceInfo().mode === 'cloud' ? 0 : 1);
  });
  return out;
}

function writeRows(rows, pending, out) {
  const stockBefore = new Map();
  const changedIn = new Set();
  const note = (t) => { out.changed++; changedIn.add(t); };
  for (const item of rows) {
    const t = item.t;
    if (t === 'stock') {
      const r = item.r;
      const k = `${r.location_id}:${r.product_id}`;
      if (!stockBefore.has(k)) stockBefore.set(k, [r.location_id, r.product_id, get('SELECT qty FROM stock WHERE location_id = ? AND product_id = ?', r.location_id, r.product_id)?.qty ?? 0]);
      run('INSERT INTO stock(location_id, product_id, qty) VALUES(?, ?, ?) ON CONFLICT(location_id, product_id) DO UPDATE SET qty = excluded.qty',
        r.location_id, r.product_id, r.qty);
      continue;
    }
    if (!D.tableColumns(t).length) continue; // a kind of record this version does not know yet
    const kc = keyCol(t);
    if (item.del) {
      if (pending.has(`${t}:${item.k}`)) continue;
      const key = t === 'settings' ? item.k : Number(item.k);
      const had = get(`SELECT 1 AS x FROM ${t} WHERE ${kc} = ?`, key);
      run(`DELETE FROM ${t} WHERE ${kc} = ?`, key);
      if (had && t !== 'devices') note(t);
      continue;
    }
    if (pending.has(`${t}:${item.r[kc]}`)) continue;
    let differs;
    try {
      differs = upsert(t, item.r);
    } catch (e) {
      // Another record here already has this barcode, code or number (it never reached the cloud, or is about to be refused).
      // The cloud is right: skip this one for now and download everything again once nothing is waiting.
      if (!/UNIQUE constraint failed/.test(String(e && e.message))) throw e;
      D.setDevice({ rebuild: 1 });
      continue;
    }
    if (differs && t !== 'devices') note(t); // (a device's "last seen" changes all the time)
  }
  // unsent stock moves made here are not in the cloud's count yet
  for (const [loc, pid, before] of stockBefore.values()) {
    const extra = get(
      `SELECT COALESCE(SUM(m.qty), 0) AS n FROM outbox o JOIN movements m ON o.tbl = 'movements' AND m.id = CAST(o.row_key AS INTEGER)
       WHERE m.location_id = ? AND m.product_id = ?`, loc, pid).n;
    if (extra) run('UPDATE stock SET qty = qty + ? WHERE location_id = ? AND product_id = ?', extra, loc, pid);
    if (get('SELECT qty FROM stock WHERE location_id = ? AND product_id = ?', loc, pid)?.qty !== before) note('stock');
  }
  out.tables = [...changedIn];
}

// Returns whether the record is now different from what was here.
function upsert(t, row) {
  const cols = D.tableColumns(t).filter((c) => c in row);
  if (!cols.length) return false;
  const kc = keyCol(t);
  const old = get(`SELECT * FROM ${t} WHERE ${kc} = ?`, row[kc]);
  const set = cols.filter((c) => c !== kc).map((c) => `"${c}" = excluded."${c}"`).join(', ');
  run(`INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT(${kc}) DO ${set ? 'UPDATE SET ' + set : 'NOTHING'}`, ...cols.map((c) => row[c]));
  return !old || cols.some((c) => c !== 'rev' && old[c] !== row[c]);
}

// Everything the cloud has, in one go: this computer's copy is replaced at once, so the screens never see it half done.
export function replaceAll(rows, st) {
  if (waiting()) throw new Error('Changes are still waiting to be sent');
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    run('UPDATE sync_ctx SET applying = 1');
    for (const t of [...D.SYNC_TABLES, 'stock', 'devices']) run(`DELETE FROM ${t}`);
    writeRows(rows, new Set(), { changed: 0, tables: [] });
    D.setDevice({ ...st, rebuild: null });
    run('UPDATE sync_ctx SET applying = 0');
  });
  return { changed: 1, tables: ['settings', 'locations', 'users', 'products', 'stock'] };
}

// "Download everything again": the next sync does it, once nothing is waiting.
export const requestRebuild = () => D.setDevice({ rebuild: 1 });

// ---------- Sync bookkeeping kept on this device ----------
export function state() {
  const d = Object.fromEntries(all("SELECT key, value FROM device WHERE key IN ('cursor', 'epoch', 'scope', 'last_sync_at', 'rebuild', 'sync_v')").map((r) => [r.key, r.value]));
  return { cursor: Number(d.cursor) || 0, epoch: d.epoch || '', scope: d.scope || '', last_sync_at: d.last_sync_at || null, rebuild: !!d.rebuild, v: Number(d.sync_v) || 0 };
}
export function saveState(values) { D.setDevice(values); }

// Forget everything that came from the cloud (it is downloaded again). Only done when nothing is waiting to be sent.
export function resetLocal() {
  if (get('SELECT COUNT(*) AS n FROM outbox').n) throw new Error('Changes are still waiting to be sent');
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    run('UPDATE sync_ctx SET applying = 1');
    for (const t of [...D.SYNC_TABLES, 'stock', 'devices']) run(`DELETE FROM ${t}`);
    run("DELETE FROM device WHERE key IN ('cursor', 'scope', 'epoch', 'rebuild', 'sync_v')");
    run('UPDATE sync_ctx SET applying = 0');
  });
}

// Marks some kinds of records (or everything) as "to send" again, e.g. when the cloud is missing records.
// Only on an owner computer, which holds the master copy of these.
export function requeue(tables) {
  if (D.deviceInfo().location_id != null) throw new Error('Only the owner computer can do this');
  const ok = (tables || []).filter((t) => D.SYNC_TABLES.includes(t));
  if (!ok.length) throw new Error('Nothing to send');
  return tx(() => { D.beginGroup(); return queueEverything(D.SYNC_TABLES.filter((t) => ok.includes(t))); });
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
