// Practice mode (Training): people try Velanzo for real, with real screens, on demo data that is marked DEMO.
// When they finish, everything goes back exactly as it was before — as if the practice never happened.
//
// How: when practice starts, this device's data is copied aside; the copy is put back at the end.
// While practising nothing is sent to the cloud and nothing new is downloaded.
import * as D from './db.js';
import * as S from './session.js';

const { all, get, run, tx, now } = D;

// Everything that makes up this device's data and sync position.
const KEEP = [...D.SYNC_TABLES, 'stock', 'devices', 'device', 'counters', 'outbox', 'sync_errors'];
const copyOf = (t) => `_practice_${t}`;

export const isActive = () => !!get("SELECT 1 AS x FROM device WHERE key = 'practice'");
export const status = () => ({ active: isActive(), since: get("SELECT value FROM device WHERE key = 'practice'")?.value || null });

export function start() {
  if (isActive()) return status();
  const user = S.currentUser();
  if (!user) throw new Error('Please log in first');
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    for (const t of KEEP) {
      D.exec(`DROP TABLE IF EXISTS ${copyOf(t)}`);
      D.exec(`CREATE TABLE ${copyOf(t)} AS SELECT * FROM ${t}`);
    }
    run("INSERT INTO device(key, value) VALUES('practice', ?)", now());
    seed(user);
  });
  return status();
}

// Puts everything back and forgets the practice.
export function finish() {
  if (!isActive()) return status();
  for (const t of KEEP) {
    if (!get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", copyOf(t))) {
      throw new Error('The saved copy of your data is missing, so nothing was changed.');
    }
  }
  D.exec('PRAGMA foreign_keys = OFF');
  tx(() => {
    run('UPDATE sync_ctx SET applying = 1');
    for (const t of KEEP) {
      run(`DELETE FROM ${t}`);
      run(`INSERT INTO ${t} SELECT * FROM ${copyOf(t)}`);
      D.exec(`DROP TABLE ${copyOf(t)}`);
    }
    run('UPDATE sync_ctx SET applying = ?', D.deviceInfo().mode === 'cloud' ? 0 : 1);
  });
  return status();
}

// Things to practise with: a supplier, two items, stock at every place, and (for a place that receives stock)
// a parcel that is "on the way".
function seed(user) {
  const t = now();
  D.beginGroup();
  run('INSERT INTO suppliers(id, name, phone, address, created_at) VALUES(?, ?, ?, ?, ?)', D.newId(), 'DEMO Supplier', '0300 0000000', 'Demo market', t);
  const items = [];
  for (const size of ['M', 'L']) {
    const id = D.newId();
    run('INSERT INTO products(id, barcode, name, category, size, color, cost_price, sale_price, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, D.newBarcode(), 'DEMO T-Shirt', 'Demo', size, 'Blue', 400, 900, t, t);
    items.push(id);
  }
  const places = all('SELECT * FROM locations WHERE active = 1 ORDER BY id');
  for (const p of places) for (const id of items) D.moveStock(id, p.id, 20, 'opening', null, null, user.id, 'DEMO practice stock');

  const mine = user.owner ? null : places.find((p) => p.id === user.location_id);
  if (mine && user.perms.includes('receive')) {
    const from = places.find((p) => p.id !== mine.id && p.type === 'warehouse') || places.find((p) => p.id !== mine.id);
    if (from) {
      const id = D.newId();
      run('INSERT INTO dispatches(id, dispatch_no, from_location_id, to_location_id, total_qty, total_value, notes, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, D.deviceNo('D-', 'dispatch'), from.id, mine.id, items.length * 5, items.length * 5 * 900, 'DEMO parcel — for practice', user.id, t);
      for (const pid of items) {
        run('INSERT INTO dispatch_items(id, dispatch_id, product_id, qty, price, cost) VALUES(?, ?, ?, ?, ?, ?)', D.newId(), id, pid, 5, 900, 400);
        D.moveStock(pid, from.id, -5, 'dispatch_out', 'dispatch', id, user.id, `Sent to ${mine.name}`);
      }
    }
  }
}
