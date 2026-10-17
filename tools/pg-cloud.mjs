// A stand-in for the Supabase database, for tests and the local preview: Postgres (PGlite) running in Node,
// with the real migration and a small stand-in for Supabase's auth.uid().
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startCloud(dataDir) {
  const db = new PGlite(dataDir);
  const fresh = !(await db.query("select 1 from pg_tables where tablename = 'meta'")).rows.length;
  if (fresh) {
    await db.exec(`
      do $$ begin create role anon; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      create schema if not exists auth;
      create or replace function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
    const dir = path.join(ROOT, 'supabase', 'migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  // Calls a function as the signed-in account `uid` (like supabase.rpc). Errors keep their text.
  let queue = Promise.resolve();
  async function rpc(uid, fn, args = {}) {
    const run = async () => {
      const names = Object.keys(args);
      const sql = `select ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
      const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
      const res = await db.query(sql, vals);
      return res.rows[0].r;
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }
  return { db, rpc };
}
