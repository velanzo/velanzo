// The connection to the cloud (Supabase): signing in, setting up devices, and keeping this device in sync.
// Everything still works without internet; changes wait on this device and go up when it's back.
import { createSyncer, localNow } from '../engine/syncer.js';

export function createCloud() {
  const cfg = window.VELANZO_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  let sb = null, timer = null, soon = null, active = false, lastRun = 0;
  const st = { online: navigator.onLine, syncing: false, lastSync: null, problem: null };

  function client() {
    if (!enabled) throw new Error('Velanzo is not connected to the cloud yet');
    if (!sb) {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'velanzo-auth', detectSessionInUrl: false },
      });
    }
    return sb;
  }

  const siteUrl = () => location.origin + location.pathname;

  // Cloud errors start with "VZ:<kind>:"; no connection is kind "offline".
  class CloudError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
  function asError(err) {
    const m = String((err && err.message) || err || '');
    const vz = m.match(/^VZ:([a-z]+):([\s\S]*)$/);
    if (vz) return new CloudError(vz[1], vz[2].trim());
    if (/statement timeout|too large/i.test(m)) return new CloudError('slow', m); // (not "no internet": the syncer sends less at a time)
    if (/fetch|network|load failed|timed? ?out|offline/i.test(m) || !navigator.onLine) return new CloudError('offline', 'No internet connection');
    // Sent without a cloud sign-in (the passcode still opens the app, so nothing else shows it).
    if (/permission denied for function/i.test(m)) return new CloudError('auth', 'This computer is no longer signed in to the cloud. Open "This device" and click "Connect again". Your changes are kept here.');
    if (/could not find the function|schema cache/i.test(m)) return new CloudError('update', 'The cloud database is not up to date yet. The owner must run supabase/UPDATE-ALL.sql once in Supabase (SQL Editor).');
    if (/invalid login credentials/i.test(m)) return new CloudError('login', 'Wrong email or password');
    if (/email not confirmed/i.test(m)) return new CloudError('confirm', 'Please confirm your email first: open the link we sent you, then sign in.');
    return new CloudError('other', m);
  }
  const NOT_SIGNED_IN = 'This computer is no longer signed in to the cloud. Open "This device" and click "Connect again". Your work on this computer is kept.';
  // Renews the sign-in → 'ok', 'gone' (really signed out) or 'offline' (the cloud could not be asked: nothing is wrong with the sign-in).
  async function renewSession() {
    let r;
    try { r = await client().auth.refreshSession(); } catch { return 'offline'; }
    if (r.data?.session) return 'ok';
    const e = r.error;
    return e && e.name !== 'AuthSessionMissingError' && (e.name === 'AuthRetryableFetchError' || !e.status || e.status >= 500) ? 'offline' : 'gone';
  }
  const CALL_LIMIT = 60000; // a call that never answers must not stop syncing for ever
  async function rpc(fn, args, tried) {
    let res;
    try {
      res = await Promise.race([client().rpc(fn, args || {}), new Promise((_, no) => { setTimeout(() => no(new CloudError('offline', 'The cloud did not answer.')), CALL_LIMIT); })]);
    } catch (e) { throw e instanceof CloudError ? e : asError(e); }
    if (res.error) {
      // The sign-in ran out (a laptop that slept, for example), or could not be renewed for a moment: try once more
      // before saying anything. Only a sign-in that is really gone needs a person.
      if (/\bjwt\b|\bjws|permission denied for function/i.test(String(res.error.message))) {
        const how = tried ? 'gone' : await renewSession();
        if (how === 'ok') return rpc(fn, args, true);
        if (how === 'offline') throw new CloudError('offline', 'No internet connection');
        throw new CloudError('auth', NOT_SIGNED_IN);
      }
      throw asError(res.error);
    }
    return res.data;
  }
  // Only this computer signs out. (By default Supabase ends the sign-in on every computer using the same account.)
  async function signOutHere() {
    if (!enabled) return;
    try { await client().auth.signOut({ scope: 'local' }); } catch { /* no internet */ }
    // without internet the sign-in would stay on this computer: remove it anyway
    try {
      if (localStorage.getItem('velanzo-auth')) { sb?.auth.stopAutoRefresh?.(); localStorage.removeItem('velanzo-auth'); sb = null; }
    } catch { /* storage off */ }
  }
  async function auth(fn) {
    let res;
    try { res = await fn(client().auth); } catch (e) { throw asError(e); }
    if (res.error) throw asError(res.error);
    return res.data;
  }

  const syncer = createSyncer({
    system: (name, ...args) => Engine.system(name, ...args),
    rpc,
    onProgress: (p) => { if (Cloud.onProgress) Cloud.onProgress(p); },
  });

  async function syncNow() {
    if (!enabled || App.device.mode !== 'cloud') return null;
    lastRun = Date.now();
    st.syncing = true;
    paint();
    try {
      const out = await syncer.syncOnce();
      st.online = true;
      st.lastSync = localNow();
      st.problem = null;
      if (out && out.reset) toast('This device downloaded everything again.');
      if (out && out.refused) toast(`${out.refused} change${out.refused > 1 ? 's were' : ' was'} not accepted by the cloud: ${out.refusedMessages[0]}`, 'error', 9000);
      if (out && out.changed) { ProductCache.invalidate(); await remoteChanged(out.tables); }
      return out;
    } catch (e) {
      const err = e instanceof CloudError ? e : asError(e);
      if (err.kind === 'offline') st.online = false;
      // (it keeps trying: as soon as the sign-in works again, this goes away by itself)
      else if (err.kind === 'removed') st.problem = { short: 'Device removed', text: 'This computer was removed from Velanzo. Click "Connect again" to sign in. Your work on this computer is kept.', reconnect: true };
      else if (err.kind === 'device' || err.kind === 'auth') st.problem = { short: 'Not connected', text: NOT_SIGNED_IN, reconnect: true };
      else st.problem = { short: err.kind === 'update' ? 'Cloud needs updating' : e.stage === 'download' ? 'Not up to date' : 'Not saved', text: err.message };
      return null;
    } finally {
      st.syncing = false;
      if (App.user) refreshBadges(); else paint();
    }
  }
  const paint = () => { if (typeof paintSync === 'function') paintSync(); };

  return {
    enabled,
    status: () => st,
    rpc,
    syncNow,
    // Something was saved here: send it soon (a few changes in a row go together).
    changed() {
      if (!active) return;
      clearTimeout(soon);
      soon = setTimeout(syncNow, 1200);
    },
    // About to change a document or delete something: get the latest first (a few seconds at most), so this computer
    // sees right away if another computer already did it.
    async fresh() {
      if (!active || !navigator.onLine) return;
      await Promise.race([syncNow(), new Promise((r) => { setTimeout(r, 3000); })]);
    },
    // Keep syncing while the app is open: every 5 seconds while it is on the screen (every minute when hidden), and as soon as the internet comes back.
    start() {
      if (!enabled || active || App.device.mode !== 'cloud') return;
      active = true;
      syncNow();
      let ticks = 0;
      timer = setInterval(() => { ticks++; if (!document.hidden || ticks % 12 === 0) syncNow(); }, 5000);
      window.addEventListener('online', () => { st.online = true; syncNow(); });
      window.addEventListener('offline', () => { st.online = false; paint(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
      window.addEventListener('focus', () => { if (Date.now() - lastRun > 5000) syncNow(); });
    },
    stop() { active = false; clearInterval(timer); },

    // ---------- Accounts and devices ----------
    session: async () => (enabled ? (await client().auth.getSession()).data.session : null),
    signUp: (email, password) => auth((a) => a.signUp({ email, password })),
    async signIn(email, password) {
      const d = await auth((a) => a.signInWithPassword({ email, password }));
      st.problem = null; // signed in again: saving may start again
      return d;
    },
    signOut: signOutHere,
    whoami: () => rpc('velanzo_whoami'),
    // The owner's phone or computer: sees every shop.
    async registerOwnerDevice(email, label) {
      const me = await rpc('velanzo_whoami');
      if (!me.is_owner) await rpc('create_owner', { p_email: email || null });
      return rpc('register_owner_device', { p_label: label, p_now: localNow() });
    },
    // A shop or warehouse computer, with a code the owner made.
    async joinWithCode(code, label) {
      const s = (await client().auth.getSession()).data.session;
      if (!s) await auth((a) => a.signInAnonymously());
      return rpc('claim_device', { p_code: code, p_label: label, p_now: localNow() });
    },
    // A shop or warehouse person signs in with the user ID and password the owner made for them.
    async loginWithId(login, password, label) {
      let s = (await client().auth.getSession()).data.session;
      // A person's computer has its own sign-in. An owner's sign-in left on this computer belongs to the owner's other computers.
      if (s && !s.user?.is_anonymous) { await signOutHere(); s = null; }
      if (!s) await auth((a) => a.signInAnonymously());
      const r = await rpc('login_with_id', { p_login: login, p_password: password, p_label: label, p_now: localNow() });
      if (!r.ok) throw new CloudError('login', r.error);
      st.problem = null;
      return r;
    },
    // The owner makes or changes a person's user ID and password.
    setUserLogin: (userId, login, password) => rpc('set_user_login', { p_user: userId, p_login: login, p_password: password }),
    listUserLogins: () => rpc('list_user_logins'),
    // This computer stops being a device of the business (sign out).
    releaseDevice: (id) => rpc('release_device', { p_device: id }),
    // This computer signed in again and has a new number: the old one is no longer in use.
    replaceDevice: (oldId, newId) => rpc('replace_device', { p_old: oldId, p_new: newId }),
    removeDevice: (id) => rpc('remove_device', { p_id: id }),
    restoreBegin: () => rpc('restore_begin'),

    // ---------- Links in emails ----------
    // Forgot the owner password: Supabase emails a link that opens this page again.
    resetPassword: (email) => auth((a) => a.resetPasswordForEmail(email, { redirectTo: siteUrl() })),
    // The page was opened from an email link (…#access_token=…&type=recovery | magiclink | signup): take what it carries out of the address.
    takeLink() {
      const h = location.hash.replace(/^#/, '');
      if (!/(^|&)(access_token|error|error_code)=/.test(h)) return null;
      const q = new URLSearchParams(h);
      history.replaceState(null, '', location.pathname + location.search);
      if (q.get('error') || q.get('error_code')) return { error: true, expired: /expired|invalid/i.test(q.get('error_code') + ' ' + q.get('error_description')) };
      return { type: q.get('type'), access_token: q.get('access_token'), refresh_token: q.get('refresh_token') };
    },
    // Work with a link's sign-in on its own, never touching this device's own sign-in
    // (the owner may open the link on a shop computer; that must not change the shop computer).
    async withLink(link, fn) {
      const c = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'velanzo-link' },
      });
      const { error } = await c.auth.setSession({ access_token: link.access_token, refresh_token: link.refresh_token });
      if (error) throw asError(error);
      return fn(c);
    },
    async linkSetPassword(link, password) {
      await this.withLink(link, async (c) => { const { error } = await c.auth.updateUser({ password }); if (error) throw asError(error); });
    },
    linkPinRequests: (link) => Cloud.withLink(link, async (c) => { const { data, error } = await c.rpc('list_pin_resets'); if (error) throw asError(error); return data; }),
    linkDecide: (link, id, approve) => Cloud.withLink(link, async (c) => { const { error } = await c.rpc('decide_pin_reset', { p_id: id, p_approve: approve }); if (error) throw asError(error); }),

    // ---------- Forgotten PIN ----------
    // Asks for a new PIN for one person on this computer; a link goes to the owner's email to approve it.
    async requestPinReset(userId) {
      const r = await rpc('request_pin_reset', { p_device: App.device.id, p_user: userId });
      await auth((a) => a.signInWithOtp({ email: r.email, options: { emailRedirectTo: siteUrl(), shouldCreateUser: false } }));
      return r;
    },
    checkPinReset: (id) => rpc('check_pin_reset', { p_device: App.device.id, p_id: id }),
    usePinReset: (id) => rpc('use_pin_reset', { p_device: App.device.id, p_id: id }),
    CloudError,
  };
}
