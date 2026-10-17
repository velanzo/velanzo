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
  }
  // the signed-in accounts (Supabase keeps these in auth.users)
  await db.exec('create schema if not exists auth; create table if not exists auth.users (id uuid primary key, email text, email_confirmed_at timestamptz)');
  // Runs every migration file once (a database made before this list existed already has the first one).
  await db.exec('create table if not exists dev_migrations (name text primary key)');
  if (!fresh) await db.exec("insert into dev_migrations values ('20261016000000_velanzo.sql') on conflict do nothing");
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if ((await db.query('select 1 from dev_migrations where name = $1', [f])).rows.length) continue;
    // one transaction: a file is either fully applied and recorded, or not at all (even if the preview is stopped suddenly)
    await db.exec(`begin;
${fs.readFileSync(path.join(dir, f), 'utf8')}
insert into dev_migrations values ('${f}');
commit;`);
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
