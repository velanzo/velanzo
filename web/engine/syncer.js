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
    const out = { sent: 0, refused: 0, received: 0, refusedMessages: [] };
    let trouble = '';

    // 1. Send what was done here (oldest first, each action whole). Nothing is sent while the passcode screen is up
    //    (nobody is working, so the cloud could not tell who did it); it all goes once someone unlocks.
    const mayPush = info.user_id || info.device.location_id == null;
    for (let round = 0; mayPush && round < 200; round++) {
      const groups = await system('outbox', 3000);
      if (!groups.length) break;
      const res = await rpc('push', { ...who, p_groups: groups.map((g) => ({ grp: g.grp, rows: g.rows })), p_now: now() });
      const byGrp = new Map(res.results.map((r) => [r.grp, r]));
      const done = [];
      for (const g of groups) {
        const r = byGrp.get(g.grp);
        if (!r) continue;
        if (r.ok) { done.push(...g.seqs); out.sent++; }
        else if (r.retry) trouble = r.error; // the cloud had a problem (not a refusal): keep the change, send it again later
        else { await system('refused', g, r.error); out.refused++; out.refusedMessages.push(r.error); }
      }
      await system('pushed', done);
      if (!done.length) break; // nothing moved: do not ask again and again
    }
    if (trouble) throw new Error(`The cloud had a problem saving (${trouble}). Your changes are kept on this computer and will be sent again.`);

    // 2. Download what changed elsewhere.
    let st = info.sync;
    for (let round = 0; round < 10000; round++) {
      const res = await rpc('pull', { ...who, p_since: st.cursor, p_limit: 2000, p_now: now() });
      const changed = st.cursor > 0 && ((st.scope && res.scope !== st.scope) || (st.epoch && res.epoch !== st.epoch));
      if (changed) {
        // What this device may see changed, or the owner restored a backup: download everything again.
        // (Anything still waiting here is sent first — next time round.)
        if ((await system('outbox', 1)).length) break;
        await system('resetLocal');
        st = { cursor: 0 };
        out.reset = true;
        continue;
      }
      if (res.rows.length) await system('applyPull', res.rows);
      st = { cursor: res.cursor, scope: res.scope, epoch: res.epoch };
      await system('saveState', { cursor: res.cursor, scope: res.scope, epoch: res.epoch, last_sync_at: now() });
      out.received += res.rows.length;
      onProgress(out);
      if (!res.more) break;
    }
    return out;
  }

  return { syncOnce };
}
