// Keeps this device and the cloud in step: first sends the changes made here, then downloads everyone else's.
// Used by the page (rpc = Supabase) and by the tests (rpc = local Postgres).
//   system(name, ...args) → calls the engine's system functions (outbox, pushed, applyPull …)
//   rpc(fn, args)         → calls a cloud function and returns its result (throws on errors)

const pad = (n) => String(n).padStart(2, '0');
export function localNow(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function createSyncer({ system, rpc, now = localNow, onProgress = () => {} }) {
  let running = null;

  // Several callers at once share one run.
  function syncOnce() {
    if (!running) running = run().finally(() => { running = null; });
    return running;
  }

  async function run() {
    const info = await system('info');
    if (info.device.mode !== 'cloud' || info.practice) return { skipped: true };
    const who = { p_device: info.device.id, p_user: info.user_id };
    const out = { sent: 0, refused: 0, received: 0, changed: 0, tables: [], refusedMessages: [] };

    // A problem while sending never stops the downloading: other computers' work still arrives,
    // and what was made here stays on this computer and is sent again.
    let sendProblem = null;
    try { await send(info, who, out); } catch (e) { sendProblem = e; }
    try { await download(info, who, out); } catch (e) { if (!sendProblem) { e.stage = 'download'; throw e; } }
    if (sendProblem) throw sendProblem;
    return out;
  }

  // 1. Send what was done here (oldest first, each action whole). Nothing is sent while the passcode screen is up
  //    (nobody is working, so the cloud could not tell who did it); it all goes once someone unlocks.
  async function send(info, who, out) {
    let trouble = '';
    const mayPush = info.user_id || info.device.location_id == null;
    for (let round = 0; mayPush && round < 200; round++) {
      const groups = await system('outbox', 3000);
      if (!groups.length) break;
      const res = await rpc('push', { ...who, p_groups: groups.map((g) => ({ grp: g.grp, rows: g.rows })), p_now: now() });
      const byGrp = new Map(res.results.map((r) => [r.grp, r]));
      const done = [];
      let refused = 0;
      for (const g of groups) {
        const r = byGrp.get(g.grp);
        if (!r) continue;
        if (r.ok) { done.push(...g.seqs); out.sent++; }
        else if (r.retry) trouble = r.error; // the cloud had a problem (not a refusal): keep the change, send it again later
        else { await system('refused', g, r.error); out.refused++; refused++; out.refusedMessages.push(r.error); }
      }
      await system('pushed', done);
      if (!done.length && !refused) break; // nothing moved: do not ask again and again
    }
    if (trouble) throw new Error(`The cloud had a problem saving (${trouble}). Your changes are kept on this computer and will be sent again.`);
  }

  // 2. Download what changed elsewhere.
  async function download(info, who, out) {
    let st = info.sync;
    let again = false, moved = false;
    for (let round = 0; round < 10000; round++) {
      const res = await rpc('pull', { ...who, p_since: st.cursor, p_limit: 2000, p_now: now() });
      // What this device may see changed, or the owner restored a backup: download everything again.
      moved = st.cursor > 0 && ((st.scope && res.scope !== st.scope) || (st.epoch && res.epoch !== st.epoch));
      // The cloud sends more than it used to (version numbers): get that for everything, once.
      if (moved || (st.cursor > 0 && res.v > st.v)) { again = true; break; }
      if (res.rows.length) {
        const r = await system('applyPull', res.rows);
        if (r) { out.changed += r.changed || 0; out.tables = [...new Set([...out.tables, ...(r.tables || [])])]; }
      }
      st = { cursor: res.cursor, scope: res.scope, epoch: res.epoch, v: res.v || 0 };
      await system('saveState', { cursor: res.cursor, scope: res.scope, epoch: res.epoch, sync_v: res.v || 0, last_sync_at: now() });
      out.received += res.rows.length;
      onProgress(out);
      if (!res.more) break;
    }
    // A refused change or a clash while downloading (or someone pressed "Download everything again").
    const asked = (await system('info')).sync.rebuild;
    if (again || asked) {
      // (Anything still waiting here is sent first — next time round.)
      if (await system('waiting')) return;
      await downloadEverything(who, out);
      if (moved || asked) out.reset = true;
    }
  }

  async function downloadEverything(who, out) {
    const rows = [];
    let res, cursor = 0;
    do {
      res = await rpc('pull', { ...who, p_since: cursor, p_limit: 2000, p_now: now() });
      rows.push(...res.rows);
      cursor = res.cursor;
      onProgress({ ...out, received: rows.length });
    } while (res.more);
    const r = await system('replaceAll', rows, { cursor, scope: res.scope, epoch: res.epoch, sync_v: res.v || 0, last_sync_at: now() });
    out.received += rows.length;
    out.changed += r.changed;
    out.tables = [...new Set([...out.tables, ...r.tables])];
  }

  return { syncOnce };
}
