// Joins migrations 2..5 into ONE file that is safe to run again (supabase/UPDATE-ALL.sql): paste it once in Supabase.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(ROOT, 'supabase', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().slice(1);
let out = '-- Velanzo: everything added after the first file, in one go. Safe to run again.\n-- Paste all of this in Supabase -> SQL Editor -> New query -> Run.\n\n';
for (const f of files) {
  let s = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
  s = s.replace(/^create table (?!if not exists)/gm, 'create table if not exists ')
    .replace(/^create unique index (?!if not exists)/gm, 'create unique index if not exists ')
    .replace(/^create index (?!if not exists)/gm, 'create index if not exists ')
    .replace(/^create function /gm, 'create or replace function ')
    .replace(/^(alter table \w+ add column) (?!if not exists)/gm, '$1 if not exists ');
  out += `-- ===== ${f} =====\n${s}\n\n`;
}
fs.writeFileSync(path.join(ROOT, 'supabase', 'UPDATE-ALL.sql'), out);
console.log('written', files.length, 'files,', out.length, 'bytes');
