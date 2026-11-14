'use strict';
// Daily backup: on every computer, the first time Velanzo opens on a new day, a full backup file is written
// by itself into a folder chosen once (Settings → Backup). The last 30 days are kept there.
// "Back up now" does the same at any time. (Choosing a folder works in Chrome and Edge on a computer;
// elsewhere "Back up now" downloads the file instead.)
const Backup = (() => {
  const KEEP_DAYS = 30;
  const ls = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
  };
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const supported = typeof window.showDirectoryPicker === 'function';

  // The chosen folder is remembered in this browser (IndexedDB keeps it; localStorage cannot).
  function store(mode, fn) {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open('velanzo-backup', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onerror = () => reject(rq.error);
      rq.onsuccess = () => {
        const db = rq.result;
        const t = db.transaction('kv', mode);
        const r = fn(t.objectStore('kv'));
        t.oncomplete = () => { db.close(); resolve(r && r.result); };
        t.onerror = () => { db.close(); reject(t.error); };
      };
    });
  }
  const folder = () => store('readonly', (s) => s.get('folder')).catch(() => null);
  const saveFolder = (h) => store('readwrite', (s) => (h ? s.put(h, 'folder') : s.delete('folder')));

  async function allowed(h, ask) {
    const o = { mode: 'readwrite' };
    if ((await h.queryPermission(o)) === 'granted') return true;
    return ask ? (await h.requestPermission(o)) === 'granted' : false;
  }

  // tag: a copy made for a reason (e.g. 'before-delete'): its own name with the time, never removed by the 30-day clean-up
  async function makeFile(tag) {
    const b = await Engine.system('backupData');
    const slug = String(b.place || 'velanzo').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'velanzo';
    if (tag) { const d = new Date(); return { name: `velanzo-${tag}-${slug}-${dayOf(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`, json: b.json, tagged: true }; }
    return { name: `velanzo-backup-${slug}-${dayOf()}.json`, json: b.json, prefix: `velanzo-backup-${slug}-` };
  }

  function remember(name) {
    ls.set('vz_auto_backup_day', dayOf());
    ls.set('vz_auto_backup_at', nowStr());
    ls.set('vz_auto_backup_file', name);
  }

  // Writes today's file into the folder and removes this computer's files older than 30 days.
  async function writeTo(h, tag) {
    const f = await makeFile(tag);
    const fh = await h.getFileHandle(f.name, { create: true });
    const w = await fh.createWritable();
    await w.write(f.json);
    await w.close();
    if (f.tagged) return f.name;
    const cutoff = dayOf(new Date(Date.now() - KEEP_DAYS * 86400000));
    try {
      for await (const [n, e] of h.entries()) {
        const m = e.kind === 'file' && n.startsWith(f.prefix) && n.slice(f.prefix.length).match(/^(\d{4}-\d{2}-\d{2})\.json$/);
        if (m && m[1] < cutoff) await h.removeEntry(n);
      }
    } catch { /* old files stay: no harm */ }
    remember(f.name);
    return f.name;
  }

  let asking = null;
  // The browser wants a click before Velanzo may write to the folder again (some browsers ask after a restart).
  function askToAllow(h) {
    if (asking || document.getElementById('bkAllow')) return;
    const bar = document.createElement('div');
    bar.id = 'bkAllow';
    bar.className = 'toast new-version';
    bar.innerHTML = `Today's backup is ready to save in the folder "${esc(h.name)}". <button class="btn sm">Save backup</button> <button class="btn sm ghost" data-x>Later</button>`;
    asking = bar;
    const done = () => { bar.remove(); asking = null; };
    bar.querySelector('[data-x]').addEventListener('click', done);
    bar.querySelector('.btn:not([data-x])').addEventListener('click', async () => {
      try {
        if (!(await allowed(h, true))) return toast('The backup was not saved: the folder was not allowed.', 'error');
        const name = await writeTo(h);
        toast(`Backup saved: ${name}`, 'ok');
        done();
      } catch (e) { toast('The backup could not be saved: ' + e.message, 'error', 8000); }
    });
    document.getElementById('toasts')?.appendChild(bar);
  }

  let timer = null;
  return {
    supported,
    folder,
    lastAt: () => ls.get('vz_auto_backup_at'),
    lastFile: () => ls.get('vz_auto_backup_file'),

    // Called when Velanzo opens (and every hour while it stays open): once a day, quietly.
    async daily() {
      if (!timer) timer = setInterval(() => this.daily(), 3600000);
      if (App.demo || !supported || !App.device?.id) return;
      if (ls.get('vz_auto_backup_day') === dayOf()) return;
      const h = await folder();
      if (!h) return;
      try {
        if (await allowed(h, false)) await writeTo(h);
        else askToAllow(h);
      } catch (e) { console.warn('Daily backup failed', e); }
    },

    async chooseFolder() {
      const h = await window.showDirectoryPicker({ id: 'velanzo-backup', mode: 'readwrite', startIn: 'documents' });
      await saveFolder(h);
      return h;
    },
    forgetFolder: () => saveFolder(null),

    // "Back up now": into the folder if there is one, otherwise a download.
    async now({ tag = '' } = {}) {
      const h = supported ? await folder() : null;
      if (h) {
        if (!(await allowed(h, true))) throw new Error('The backup folder was not allowed. Choose the folder again (Settings → Backup).');
        return { name: await writeTo(h, tag), folder: h.name };
      }
      const f = await makeFile(tag);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([f.json], { type: 'application/json' }));
      a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      if (!tag) remember(f.name);
      return { name: f.name, folder: null };
    },
  };
})();
