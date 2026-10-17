'use strict';
// Manage data (Settings → Backup & data): see what is stored, clear some of it (by kind and by dates) or clear
// everything. Clearing works like restoring a backup: Velanzo works out what stays, downloads a safety copy of
// everything, then replaces the data on this computer and (through the cloud) on every other one.

// Replaces all data with `data` (a backup): on this computer, and on every computer through the cloud.
async function replaceEverywhere(data) {
  const cloud = Cloud.enabled && App.device.mode === 'cloud';
  if (cloud) {
    if (!navigator.onLine) throw new Error('This needs the internet, so every computer can be updated');
    await Cloud.syncNow();
    await Cloud.restoreBegin();
  }
  await POST('/api/backup/import', { data });
  if (!cloud) return;
  // Send everything up now (a sync that was already running may have started too early), and wait until it is all there.
  let left = 1, refused = 0, why = '';
  for (let i = 0; i < 150 && left; i++) {
    const out = await Cloud.syncNow();
    if (out && out.refused) { refused += out.refused; why = out.refusedMessages[0]; }
    left = (await Engine.system('outbox', 1)).length;
    if (left) await new Promise((r) => setTimeout(r, 800));
  }
  if (refused) throw new Error(`The cloud did not accept ${refused} change${refused > 1 ? 's' : ''}: ${why}. Download a backup and restore it again.`);
  if (left) throw new Error('Not everything reached the cloud yet. Keep Velanzo open with internet and it will finish by itself.');
}

const CLEAR_KINDS = [
  ['sales', 'Bills (and their lines)'],
  ['purchases', 'Purchases and supplier payments'],
  ['dispatches', 'Stock sent between places (parcels still on the way stay)'],
  ['expenses', 'Expenses'],
  ['history', 'Stock history (the stock counts stay the same)'],
];
const REMOVED_WORDS = {
  sales: 'bills', sale_items: 'bill lines', purchases: 'purchases', purchase_items: 'purchase lines', supplier_payments: 'supplier payments',
  dispatches: 'parcels', dispatch_items: 'parcel lines', expenses: 'expenses', movements: 'stock history lines', stock: 'stock counts', products: 'items', suppliers: 'suppliers',
};

async function manageData(el, cloud) {
  const box = $('#mdBody', el);
  const sum = await GET('/api/data/summary');
  if (!box.isConnected) return;
  const dates = (x) => (!x.first ? '' : x.first === x.last ? esc(fmtDate(x.first)) : `${esc(fmtDate(x.first))} – ${esc(fmtDate(x.last))}`);
  const row = (label, x) => `<tr><td>${label}</td><td class="r"><b>${num(x.n)}</b></td><td class="muted">${dates(x)}</td></tr>`;
  box.className = '';
  box.innerHTML = `<p class="muted" style="margin-top:0">What is stored now${cloud ? ' (the same on every computer)' : ''}:</p>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>Kind</th><th class="r">How many</th><th>Dates</th></tr></thead><tbody>
      ${row('Bills', sum.sales)}${row('Purchases', sum.purchases)}${row('Stock sent', sum.dispatches)}${row('Expenses', sum.expenses)}${row('Stock history lines', sum.movements)}
      <tr><td>Items</td><td class="r"><b>${num(sum.products.n)}</b></td><td></td></tr>
      <tr><td>Suppliers</td><td class="r"><b>${num(sum.suppliers.n)}</b></td><td></td></tr></tbody></table></div>

    <h4 style="margin:22px 0 6px">Clear some data</h4>
    <p class="muted" style="margin-top:0">Choose what to clear and for which dates. Your items, stock counts, people and settings stay.</p>
    <div class="clear-kinds">${CLEAR_KINDS.map(([k, t]) => `<label class="check"><input type="checkbox" data-kind="${k}"> ${esc(t)}</label>`).join('')}</div>
    <div class="form-grid three" style="margin-top:12px;max-width:760px">
      <label class="field">From date <span class="hint">(empty = from the start)</span><input class="input" type="date" id="clFrom"></label>
      <label class="field">Up to date <span class="hint">(empty = until today)</span><input class="input" type="date" id="clTo"></label>
      <label class="field">Quick pick<select class="input" id="clQuick"><option value="">—</option><option value="30">Older than 1 month</option><option value="90">Older than 3 months</option><option value="180">Older than 6 months</option><option value="365">Older than 1 year</option></select></label>
    </div>
    <button class="btn danger" id="clSome" style="margin-top:12px">Clear the chosen data…</button>

    <div class="danger-zone"><h4 style="margin:0 0 6px">Clear all data (start fresh)</h4>
      <p class="muted" style="margin-top:0">Deletes <b>all</b> bills, purchases, stock sent, expenses, stock history, stock counts, items and suppliers${cloud ? ' — on every computer' : ''}. Your shops, warehouse, people, PINs and settings stay. Use it to start the real business after trying things out.</p>
      <button class="btn danger solid" id="clAll">Clear all data…</button></div>`;

  $('#clQuick', el).addEventListener('change', (e) => {
    if (!e.target.value) return;
    $('#clFrom', el).value = '';
    $('#clTo', el).value = addDays(todayStr(), -Number(e.target.value));
  });

  async function run(body, question, btn) {
    if (App.practice) return toast('Finish practising first (the orange bar at the top)', 'error');
    if (cloud && !navigator.onLine) return toast('Clearing needs the internet, so every computer is updated', 'error');
    let plan;
    try { plan = await POST('/api/data/clear-plan', body); } catch (e) { return toast(e.message, 'error', 6000); }
    const gone = Object.entries(plan.removed).filter(([k, n]) => n && REMOVED_WORDS[k]);
    if (!gone.length) return toast('There is nothing to clear for those choices', 'warn', 5000);
    const range = plan.everything ? '' : `\nDates: ${body.from ? fmtDate(body.from) : 'from the start'} – ${body.to ? fmtDate(body.to) : 'today'}`;
    const list = gone.map(([k, n]) => `• ${num(n)} ${REMOVED_WORDS[k]}`).join('\n');
    const note = `A backup file is downloaded first, so you can get everything back.${cloud ? '\nEvery computer is updated.' : ''}`;
    if (!(await confirmBox(`${question}${range}\n\nThis permanently deletes:\n${list}\n\n${note}`, { title: 'Clear data', ok: 'Continue', danger: true }))) return;
    const word = await promptBox('To be sure, type CLEAR here.', { title: 'Are you sure?', ok: 'Clear data now', danger: true, placeholder: 'CLEAR' });
    if (word === null) return;
    if (word.trim().toUpperCase() !== 'CLEAR') return toast('Not cleared — you did not type CLEAR', 'error');
    await busy(btn, async () => {
      await download('/api/backup/export'); // the safety copy
      try { localStorage.setItem('vz_last_backup', nowStr()); } catch { /* ignore */ }
      await replaceEverywhere(plan.data);
      ProductCache.invalidate();
      alert(`Done. The data was cleared${cloud ? ' on every computer' : ''}. The backup file is in your Downloads.`);
      location.reload();
    });
  }

  const some = $('#clSome', el), all = $('#clAll', el);
  some.addEventListener('click', () => {
    const what = $$('[data-kind]:checked', el).map((c) => c.dataset.kind);
    if (!what.length) return toast('Tick what you want to clear', 'error');
    run({ what, from: $('#clFrom', el).value, to: $('#clTo', el).value }, 'Clear the chosen data?', some);
  });
  all.addEventListener('click', () => run({ everything: true }, 'Clear ALL data and start fresh?', all));
}
