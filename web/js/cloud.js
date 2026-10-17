// The connection to the cloud (Supabase): signing in, setting up devices, and keeping this device in sync.
// Everything still works without internet; changes wait on this device and go up when it's back.
import { createSyncer, localNow } from '../engine/syncer.js';

export function createCloud() {
  const cfg = window.VELANZO_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey);
  let sb = null, timer = null, soon = null, active = false;
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

  // Cloud errors start with "VZ:<kind>:"; no connection is kind "offline".
  class CloudError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
  function asError(err) {
    const m = String((err && err.message) || err || '');
    const vz = m.match(/^VZ:([a-z]+):([\s\S]*)$/);
    if (vz) return new CloudError(vz[1], vz[2].trim());
    if (/fetch|network|load failed|timed? ?out|offline/i.test(m) || !navigator.onLine) return new CloudError('offline', 'No internet connection');
    if (/invalid login credentials/i.test(m)) return new CloudError('login', 'Wrong email or password');
    if (/email not confirmed/i.test(m)) return new CloudError('confirm', 'Please confirm your email first: open the link we sent you, then sign in.');
    return new CloudError('other', m);
  }
  async function rpc(fn, args) {
    let res;
    try { res = await client().rpc(fn, args || {}); } catch (e) { throw asError(e); }
    if (res.error) throw asError(res.error);
    return res.data;
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
    if (!enabled || App.device.mode !== 'cloud' || st.problem?.stop) return null;
    st.syncing = true;
    paint();
    try {
      const out = await syncer.syncOnce();
      st.online = true;
      st.lastSync = localNow();
      st.problem = null;
      if (out && out.received) { ProductCache.invalidate(); if (out.reset) toast('This device downloaded everything again.'); }
      if (out && out.refused) toast(`${out.refused} change${out.refused > 1 ? 's were' : ' was'} not accepted by the cloud: ${out.refusedMessages[0]}`, 'error', 9000);
      return out;
    } catch (e) {
      const err = e instanceof CloudError ? e : asError(e);
      if (err.kind === 'offline') st.online = false;
      else if (err.kind === 'removed') st.problem = { stop: true, short: 'Device removed', text: err.message };
      else if (err.kind === 'device' || err.kind === 'auth') st.problem = { stop: true, short: 'Not connected', text: err.message, reconnect: true };
      else st.problem = { short: 'Not saved', text: err.message };
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
    // Keep syncing while the app is open: every 20 seconds, and as soon as the internet comes back.
    start() {
      if (!enabled || active || App.device.mode !== 'cloud') return;
      active = true;
      syncNow();
      timer = setInterval(syncNow, 20000);
      window.addEventListener('online', () => { st.online = true; syncNow(); });
      window.addEventListener('offline', () => { st.online = false; paint(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
    },
    stop() { active = false; clearInterval(timer); },

    // ---------- Accounts and devices ----------
    session: async () => (enabled ? (await client().auth.getSession()).data.session : null),
    signUp: (email, password) => auth((a) => a.signUp({ email, password })),
    signIn: (email, password) => auth((a) => a.signInWithPassword({ email, password })),
    signOut: () => (enabled ? client().auth.signOut().catch(() => {}) : null),
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
    createSetupCode: (locationId) => rpc('create_setup_code', { p_location: locationId }),
    removeDevice: (id) => rpc('remove_device', { p_id: id }),
    restoreBegin: () => rpc('restore_begin'),
    CloudError,
  };
}
