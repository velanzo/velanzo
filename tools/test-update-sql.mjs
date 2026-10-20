// The one-file update must work on a cloud that only has the first file, and again when run twice.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`do $$ begin create role anon; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  create schema if not exists auth; create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;`);
await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '20261016000000_velanzo.sql'), 'utf8'));
const sql = fs.readFileSync(path.join(ROOT, 'supabase', 'UPDATE-ALL.sql'), 'utf8');
await db.exec(sql);
await db.exec(sql);
const fns = ['request_pin_reset', 'login_with_id', 'set_user_login'];
for (const f of fns) {
  const r = await db.query('select 1 from pg_proc where proname = $1', [f]);
  if (!r.rows.length) { console.error('missing function ' + f); process.exit(1); }
}
console.log('UPDATE-ALL.sql ran twice on a cloud with only the first file; the functions exist.');
