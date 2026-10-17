// Runs the Velanzo engine next to the page, on a SQLite database saved on this device (browser storage, OPFS).
// The page sends { id, kind: 'api' | 'system', ... } and gets { id, ok, out | error } back.
import sqlite3InitModule from './vendor/sqlite/index.mjs';
import * as E from './engine/index.js';

let ready;
let queue = Promise.resolve();

async function open() {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: (...a) => console.warn(...a) });
  let db, persistent = true;
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'velanzo' });
    db = new pool.OpfsSAHPoolDb('/velanzo.db');
  } catch (e) {
    // Another tab already has the database open, or this browser cannot store data.
    const busy = /access handle|NoModificationAllowed|locked|in use/i.test(String(e && (e.name + e.message)));
    throw new Error(busy ? 'BUSY' : 'NO_STORAGE: ' + (e && e.message));
  }
  E.init({
    exec: (sql) => db.exec(sql),
    all: (sql, p) => db.selectObjects(sql, p.length ? p : undefined),
    get: (sql, p) => db.selectObject(sql, p.length ? p : undefined),
    run: (sql, p) => { db.exec({ sql, bind: p.length ? p : undefined }); return { changes: db.changes() }; },
  });
  return { persistent };
}

self.onmessage = (ev) => {
  const { id, kind, name, args } = ev.data;
  // One request at a time, in order (a PIN check takes a moment; nothing may slip in between).
  queue = queue.then(async () => {
    try {
      if (!ready) ready = open();
      const info = await ready;
      let out;
      if (kind === 'open') out = info;
      else if (kind === 'api') out = await E.handle(args[0]);
      else out = await E.system[name](...(args || []));
      self.postMessage({ id, ok: true, out });
    } catch (e) {
      if (/^(BUSY|NO_STORAGE)/.test(e.message)) ready = null;
      self.postMessage({ id, ok: false, error: e.message || String(e) });
    }
  });
};
