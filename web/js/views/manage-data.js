'use strict';
// More → Delete: Delete All Data, Delete Some Data (by kind and dates) and Delete Selected Data (tick boxes on the lists).
// All and Some (owner) work like restoring a backup: Velanzo works out what stays, saves a backup of everything first,
// then replaces the data on this computer and (through the cloud) on every other one. Selected: see js/delete.js.

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
  ['sales', 'Bills (receipts) and their payments'],
  ['purchases', 'Purchases and supplier payments'],
  ['dispatches', 'Stock transfers (sent and received)'],
  ['expenses', 'Expenses'],
  ['stock', 'Stock counts (every count to 0, with its history)'],
  ['history', 'Stock history only (the counts stay the same)'],
  ['products', 'Items and barcodes (only those not on any bill, purchase or transfer that stays)'],
  ['suppliers', 'Suppliers (only those with no purchases or payments left)'],
  ['customers', 'Customers (only those with no bills or payments left)'],
];
const DATED = ['sales', 'purchases', 'dispatches', 'expenses', 'history'];
const REMOVED_WORDS = {
  sales: 'bills', sale_items: 'bill lines', purchases: 'purchases', purchase_items: 'purchase lines', supplier_payments: 'supplier payments',
  dispatches: 'transfers', dispatch_items: 'transfer lines', expenses: 'expenses', movements: 'stock history lines', stock: 'stock counts', products: 'items',
  suppliers: 'suppliers', customers: 'customers', customer_payments: 'customer payments',
};

View('delete', {
  title: 'Delete',
  async render({ el }) {
    const owner = isAdmin();
    const cloud = Cloud.enabled && App.device.mode === 'cloud';
    const sum = owner ? await GET('/api/data/summary') : null;
    const card = (n, title, text, inner) => `<div class="card del-card"><div class="del-num">${n}</div><div class="grow"><h3 style="margin:0 0 4px">${title}</h3><p class="muted" style="margin-top:0">${text}</p>${inner}</div></div>`;
    const dates = (x) => (!x || !x.first ? '' : x.first === x.last ? fmtDate(x.first) : `${fmtDate(x.first)} – ${fmtDate(x.last)}`);
    el.innerHTML = `<div class="alert info" style="margin-top:0">${icon('download')} Before anything is deleted, Velanzo asks you, waits 5 seconds, and saves a backup of everything first${Backup.supported ? ' (into the backup folder chosen in Settings → Backup, otherwise your Downloads)' : ' (into your Downloads)'}.</div>
      ${card(1, 'Delete Selected Data', `Tick the records you want to delete on the lists (bills, purchases, transfers, items, expenses, suppliers, customers), then click <b>Delete selected</b>.${owner ? '' : ' You can delete your own place\'s records.'}`,
        '<button class="btn danger" id="selStart">Start selecting…</button>')}
      ${owner ? card(2, 'Delete Some Data', `Choose what to delete${cloud ? ' (on every computer)' : ''}. Deleted bills, purchases and transfers take their stock changes with them, as if they never happened. Shops, warehouse, people and settings stay.`,
        `<div class="clear-kinds">${CLEAR_KINDS.map(([k, t]) => `<label class="check"><input type="checkbox" data-kind="${k}"> ${esc(t)}${sum && sum[k] ? ` <span class="muted small">(${num(sum[k].n)}${dates(sum[k]) ? ', ' + esc(dates(sum[k])) : ''})</span>` : ''}</label>`).join('')}</div>
        <div class="form-grid three" style="margin-top:12px;max-width:760px">
          <label class="field">From date <span class="hint">(empty = from the start)</span><input class="input" type="date" id="clFrom"></label>
          <label class="field">Up to date <span class="hint">(empty = until today)</span><input class="input" type="date" id="clTo"></label>
          <label class="field">Quick pick<select class="input" id="clQuick"><option value="">—</option><option value="30">Older than 1 month</option><option value="90">Older than 3 months</option><option value="180">Older than 6 months</option><option value="365">Older than 1 year</option></select></label>
        </div><p class="hint" style="margin-top:4px">Dates only count for bills, purchases, transfers, expenses and stock history.</p>
        <button class="btn danger" id="clSome">Delete the chosen data…</button>`) : ''}
      ${owner ? card(3, 'Delete All Data', `Deletes <b>all</b> bills, purchases, transfers, expenses, stock, items, suppliers and customers${cloud ? ' on every computer' : ''}. Your shops, warehouse, people, passcodes and settings stay. Use it to start the real business after trying things out.`,
        '<button class="btn danger solid" id="clAll">Delete all data…</button>') : ''}`;

    $('#selStart', el).addEventListener('click', () => {
      const first = ['sales', 'purchases', 'dispatch', 'products', 'expenses', 'suppliers', 'customers'].find((h) => NAV.some((n) => n.href === h && n.show()));
      SelectMode.start(first);
    });
    if (!owner) return;
    $('#clQuick', el).addEventListener('change', (e) => {
      if (!e.target.value) return;
      $('#clFrom', el).value = '';
      $('#clTo', el).value = addDays(todayStr(), -Number(e.target.value));
    });

    async function run(body, title, btn) {
      if (App.practice) return toast('Finish practising first (the orange bar at the top)', 'error');
      if (cloud && !navigator.onLine) return toast('Deleting all or some data needs the internet, so every computer is updated', 'error');
      let plan;
      try { plan = await POST('/api/data/clear-plan', body); } catch (e) { return toast(e.message, 'error', 6000); }
      const gone = Object.entries(plan.removed).filter(([k, n]) => n && REMOVED_WORDS[k]);
      if (!gone.length) return toast('There is nothing to delete for those choices', 'warn', 5000);
      const skipped = [['products_skipped', 'items'], ['suppliers_skipped', 'suppliers'], ['customers_skipped', 'customers']].filter(([k]) => plan.removed[k]);
      const range = plan.everything || (!body.from && !body.to) ? '' : `<p style="margin-top:0">Dates: <b>${body.from ? esc(fmtDate(body.from)) : 'from the start'} – ${body.to ? esc(fmtDate(body.to)) : 'today'}</b></p>`;
      const html = `${range}<p style="margin-top:0">This permanently deletes${cloud ? ', on every computer' : ''}:</p>
        <ul class="del-list">${gone.map(([k, n]) => `<li><b>${num(n)}</b> ${REMOVED_WORDS[k]}</li>`).join('')}</ul>
        ${skipped.length ? `<p class="muted">Left as they are (still used): ${skipped.map(([k, w]) => `${num(plan.removed[k])} ${w}`).join(', ')}.</p>` : ''}
        <p class="muted small" style="margin-bottom:0">${App.demo ? 'This is the demo: nothing real is touched.' : 'A backup of everything is saved first, so it can be brought back (Settings → Backup → Restore).'}</p>`;
      if (!(await deleteConfirm({ title, html, ok: 'Delete' }))) return;
      await busy(btn, async () => {
        const bk = await backupBeforeDelete();
        await replaceEverywhere(plan.data);
        ProductCache.invalidate();
        alert(`Done. The data was deleted${cloud ? ' on every computer' : ''}.${bk ? `\n\nThe backup made first: ${bk.name}${bk.folder ? ` (in the folder "${bk.folder}")` : ' (in your Downloads)'}` : ''}`);
        location.reload();
      });
    }

    const some = $('#clSome', el), all = $('#clAll', el);
    some.addEventListener('click', () => {
      const what = $$('[data-kind]:checked', el).map((c) => c.dataset.kind);
      if (!what.length) return toast('Tick what you want to delete', 'error');
      const dated = what.some((k) => DATED.includes(k));
      run({ what, from: dated ? $('#clFrom', el).value : '', to: dated ? $('#clTo', el).value : '' }, 'Delete the chosen data?', some);
    });
    all.addEventListener('click', () => run({ everything: true }, 'Delete ALL data and start fresh?', all));
  },
});
