'use strict';
// "This device": is everything saved online, installing the app, and starting again.

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); App.installPrompt = e; });

View('device', {
  title: 'This device',
  async render({ el }) {
    const d = App.device;
    const s = await GET('/api/sync/status');
    const cs = Cloud.status();
    const cloud = Cloud.enabled && d.mode === 'cloud';
    let persisted = null, usage = null;
    try { persisted = await navigator.storage.persisted(); const e = await navigator.storage.estimate(); usage = e.usage; } catch { /* not supported */ }
    const errors = isAdmin() && s.errors ? await GET('/api/sync/errors') : [];
    const installed = matchMedia('(display-mode: standalone)').matches;
    el.innerHTML = `
      <div class="grid-2" style="margin-top:0">
        <div class="card"><h3>${icon('device')} ${esc(d.label || 'This device')}</h3>
          <dl class="kv"><dt>Place</dt><dd>${d.location_id ? esc(locName(d.location_id)) : 'Owner (all shops)'}</dd>
            <dt>Device letter</dt><dd>${esc(d.code)} <span class="muted small">(in its bill numbers, e.g. S1-${esc(d.code)}0001)</span></dd>
            <dt>Data</dt><dd>${cloud ? 'Saved on this device and in the cloud' : 'Saved on this device only'}${usage ? ` · ${(usage / 1048576).toFixed(1)} MB` : ''}</dd>
            <dt>Kept safe</dt><dd>${persisted ? '<span class="pill ok">Yes</span>' : '<span class="pill warn">Not guaranteed</span> <span class="muted small">Install the app (below) so the browser keeps the data.</span>'}</dd></dl>
        </div>
        <div class="card"><h3>${icon('cloud')} Saving online</h3>
          ${cloud ? `<dl class="kv"><dt>Status</dt><dd>${cs.problem ? `<span class="pill red">${esc(cs.problem.short)}</span> ${esc(cs.problem.text)}` : !cs.online ? '<span class="pill warn">No internet</span>' : '<span class="pill ok">Connected</span>'}</dd>
            <dt>Waiting to send</dt><dd>${s.waiting ? `<b>${s.waiting}</b> change${s.waiting > 1 ? 's' : ''}` : 'Nothing — all saved'}</dd>
            <dt>Last saved</dt><dd>${s.last_sync_at ? esc(fmtDT(s.last_sync_at)) : 'Not yet'}</dd></dl>
            <button class="btn primary" id="syncBtn">${icon('cloud')} Save now</button>
            ${cs.problem?.reconnect ? '<button class="btn" id="reBtn">Connect again</button>' : ''}`
          : `<p class="muted">This device is not connected to the cloud. Everything is kept here; download a backup regularly (Settings → Backup & data).</p>
            ${Cloud.enabled && isAdmin() ? '<p>Velanzo can now use the cloud. Connect this computer to send all its data up and use Velanzo on other computers and your phone.</p><button class="btn primary" id="connectBtn">Connect to the cloud</button>' : ''}`}
        </div>
      </div>
      ${errors.length ? `<div class="card"><div class="card-head"><h3 style="margin:0">Changes the cloud did not accept</h3><div class="actions"><button class="btn sm" id="clrErr">Clear list</button></div></div>
        <p class="muted small" style="margin-top:0">These were made on this device but refused (for example because a switch was off). They are not in the cloud.</p>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Why</th></tr></thead><tbody>
        ${errors.map((x) => `<tr><td class="nowrap">${esc(fmtDT(x.created_at))}</td><td>${esc(x.message)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <div class="grid-2">
        <div class="card"><h3>Install Velanzo</h3>
          ${installed ? '<p>Velanzo is installed on this device.</p>'
            : `<p class="muted" style="margin-top:0">Installing gives Velanzo its own icon and window, and keeps its data safe. It still works without internet.</p>
              ${App.installPrompt ? '<button class="btn primary" id="instBtn">Install Velanzo</button>' : '<p class="small">In Chrome or Edge: open the browser menu (⋮) → <b>Install Velanzo</b> (or <b>Apps → Install</b>). On a phone: <b>Add to Home screen</b>.</p>'}`}
        </div>
        <div class="card"><h3>Print without the print window</h3>
          <p class="muted" style="margin-top:0">For the shop counter: make the receipt printer the Windows default printer, then start Chrome with this added at the end of its shortcut's <b>Target</b>:</p>
          <div class="mono small code-line">--kiosk-printing</div>
        </div>
      </div>
      <div class="card"><h3>Start again on this device</h3>
        <p class="muted" style="margin-top:0">${cloud ? 'Downloads everything from the cloud again, or removes Velanzo from this device (the cloud keeps the data).' : 'Removes Velanzo and all its data from this device. Download a backup first!'}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${cloud ? '<button class="btn" id="redlBtn">Download everything again</button>' : ''}
          <button class="btn danger" id="forgetBtn">Remove Velanzo from this device</button></div></div>`;

    const sb = $('#syncBtn', el);
    if (sb) sb.addEventListener('click', () => busy(sb, async () => { await Cloud.syncNow(); router(); }));
    const cb = $('#connectBtn', el);
    if (cb) cb.addEventListener('click', () => Setup.showOwner('signup', { fromLocal: true }));
    const re = $('#reBtn', el);
    if (re) re.addEventListener('click', () => (d.location_id == null ? Setup.showOwner('signin') : Setup.showSignIn()));
    const ce = $('#clrErr', el);
    if (ce) ce.addEventListener('click', () => busy(ce, async () => { await POST('/api/sync/errors/clear'); router(); }));
    const ib = $('#instBtn', el);
    if (ib) ib.addEventListener('click', async () => { App.installPrompt.prompt(); await App.installPrompt.userChoice; App.installPrompt = null; router(); });
    const rd = $('#redlBtn', el);
    if (rd) rd.addEventListener('click', () => busy(rd, async () => {
      await Cloud.syncNow();
      if ((await GET('/api/sync/status')).waiting) throw new Error('Some changes are still waiting to be sent. Connect to the internet first.');
      await Engine.system('resetLocal');
      await Cloud.syncNow();
      await loadMe();
      toast('Downloaded everything again');
      router();
    }));
    $('#forgetBtn', el).addEventListener('click', async () => {
      const st = await GET('/api/sync/status');
      if (cloud && st.waiting) return toast(`${st.waiting} change${st.waiting > 1 ? 's are' : ' is'} not in the cloud yet. Connect to the internet and wait for "All saved online" first.`, 'error', 8000);
      if (!(await confirmBox(cloud ? 'Remove Velanzo from this device? The data stays in the cloud. To use this device again you will need a new code from the owner.'
        : 'Remove Velanzo and ALL its data from this device? This cannot be undone. Make sure you downloaded a backup.', { title: 'Remove from this device', ok: 'Remove', danger: true }))) return;
      await Engine.system('forgetDevice');
      await Cloud.signOut();
      location.hash = '';
      location.reload();
    });
  },
});
