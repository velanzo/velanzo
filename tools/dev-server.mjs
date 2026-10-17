// Local preview of Velanzo, with a stand-in for Supabase (sign-in + the cloud functions) on Postgres in Node.
//   node tools/dev-server.mjs            → http://localhost:4000 (cloud stand-in, data kept in .dev-cloud/)
//   node tools/dev-server.mjs --no-cloud → the website only, as if no cloud were set up
// To try two devices at once, open http://localhost:4000 and http://127.0.0.1:4000 (each keeps its own data).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT) || 4000;
const CLOUD = !process.argv.includes('--no-cloud');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json',
  '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf',
};

let cloud = null;
if (CLOUD) {
  const { startCloud } = await import('./pg-cloud.mjs');
  cloud = await startCloud(path.join(ROOT, '.dev-cloud'));
  await cloud.db.exec(`create table if not exists dev_auth_users (id uuid primary key, email text unique, password text, anonymous boolean, created_at timestamptz default now());
    create table if not exists dev_auth_tokens (token text primary key, user_id uuid);`);
}

// ---------- Sign-in stand-in (the parts of Supabase Auth the app uses) ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
async function session(user) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, exp, role: 'authenticated', aud: 'authenticated', email: user.email || '', is_anonymous: !!user.anonymous })}.dev`;
  const refresh = crypto.randomBytes(16).toString('hex');
  await cloud.db.query('insert into dev_auth_tokens values ($1, $2)', [refresh, user.id]);
  return {
    access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh,
    user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email || '', is_anonymous: !!user.anonymous, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}
const uidFrom = (req) => {
  const t = String(req.headers.authorization || '').replace(/^Bearer /, '').split('.');
  try { return JSON.parse(Buffer.from(t[1], 'base64url').toString()).sub || null; } catch { return null; }
};
const hash = (pw) => crypto.createHash('sha256').update('dev:' + pw).digest('hex');
const authError = (res, status, msg, code) => send(res, status, { code: status, error_code: code, msg, error: code, error_description: msg, message: msg });

async function handleAuth(req, res, url, body) {
  const p = url.pathname.replace('/cloud/auth/v1', '');
  if (p === '/signup' && req.method === 'POST') {
    if (body.email) {
      if ((await cloud.db.query('select 1 from dev_auth_users where email = $1', [body.email.toLowerCase()])).rows.length) return authError(res, 422, 'User already registered', 'user_already_exists');
      const u = { id: crypto.randomUUID(), email: body.email.toLowerCase() };
      await cloud.db.query('insert into dev_auth_users (id, email, password, anonymous) values ($1, $2, $3, false)', [u.id, u.email, hash(body.password)]);
      return send(res, 200, await session(u));
    }
    const u = { id: crypto.randomUUID(), anonymous: true };
    await cloud.db.query('insert into dev_auth_users (id, anonymous) values ($1, true)', [u.id]);
    return send(res, 200, await session(u));
  }
  if (p === '/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');
    if (grant === 'password') {
      const r = (await cloud.db.query('select * from dev_auth_users where email = $1 and password = $2', [String(body.email || '').toLowerCase(), hash(body.password)])).rows[0];
      if (!r) return authError(res, 400, 'Invalid login credentials', 'invalid_credentials');
      return send(res, 200, await session(r));
    }
    if (grant === 'refresh_token') {
      const r = (await cloud.db.query('select u.* from dev_auth_tokens t join dev_auth_users u on u.id = t.user_id where t.token = $1', [body.refresh_token])).rows[0];
      if (!r) return authError(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
      return send(res, 200, await session(r));
    }
  }
  if (p === '/user') {
    const id = uidFrom(req);
    const r = id && (await cloud.db.query('select * from dev_auth_users where id = $1', [id])).rows[0];
    if (!r) return authError(res, 401, 'Not signed in', 'no_authorization');
    return send(res, 200, (await session(r)).user);
  }
  if (p === '/logout') { res.writeHead(204); return res.end(); }
  return authError(res, 404, 'Not found', 'not_found');
}

// ---------- Cloud functions stand-in (PostgREST /rpc) ----------
async function handleRpc(req, res, url, body) {
  const fn = url.pathname.split('/').pop();
  const allowed = ['push', 'pull', 'velanzo_whoami', 'create_owner', 'register_owner_device', 'create_setup_code', 'claim_device', 'remove_device', 'restore_begin'];
  if (!allowed.includes(fn)) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${fn}` });
  try {
    const out = await cloud.rpc(uidFrom(req), fn, body);
    return send(res, 200, out === undefined ? null : out);
  } catch (e) {
    return send(res, 400, { code: e.code || 'P0001', message: e.message, details: null, hint: null });
  }
}

// Preview only: empty the stand-in cloud (used by tools/demo-data.mjs).
async function resetCloud(res) {
  const tables = (await cloud.db.query("select tablename from pg_tables where schemaname = 'public'")).rows.map((r) => r.tablename).filter((x) => x !== 'meta');
  await cloud.db.exec(`truncate ${tables.map((x) => '"' + x + '"').join(', ')}; alter sequence velanzo_device_no restart with 2; update meta set value = gen_random_uuid()::text where key = 'epoch';`);
  return send(res, 200, { ok: true });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (CLOUD && url.pathname.startsWith('/cloud/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { /* empty */ }
    await new Promise((r) => setTimeout(r, Number(process.env.LATENCY) || 0));
    if (url.pathname === '/cloud/dev/reset' && req.method === 'POST') return resetCloud(res);
    if (url.pathname.startsWith('/cloud/auth/v1')) return handleAuth(req, res, url, body);
    if (url.pathname.startsWith('/cloud/rest/v1/rpc/')) return handleRpc(req, res, url, body);
    return send(res, 404, { message: 'Not found' });
  }
  // The preview's config.js points the app at the stand-in.
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    // (tests can pretend the cloud isn't set up yet by creating .dev-cloud/no-config)
    const on = CLOUD && !fs.existsSync(path.join(ROOT, '.dev-cloud', 'no-config'));
    return res.end(on ? "window.VELANZO_CONFIG = { supabaseUrl: location.origin + '/cloud', supabaseAnonKey: 'dev' };" : 'window.VELANZO_CONFIG = {};');
  }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(WEB, p));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`\n  Velanzo preview: http://localhost:${PORT}   (second device: http://127.0.0.1:${PORT})`);
  console.log(CLOUD ? '  Cloud stand-in is on (data in .dev-cloud/).\n' : '  No cloud: one device only.\n');
});
