// Runs the engine in Node (tests and tools) on the built-in SQLite.
import { DatabaseSync } from 'node:sqlite';

export function nodeAdapter(file = ':memory:') {
  const db = new DatabaseSync(file);
  const cache = new Map();
  const st = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  return {
    exec: (sql) => db.exec(sql),
    all: (sql, p) => st(sql).all(...p),
    get: (sql, p) => st(sql).get(...p),
    run: (sql, p) => st(sql).run(...p),
    close: () => db.close(),
  };
}
