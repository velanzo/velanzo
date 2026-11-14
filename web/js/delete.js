'use strict';
// Deleting (More → Delete): the 5-second confirm box, the safety backup made first, and "select mode", where every
// row of the lists (bills, purchases, transfers, items, expenses, suppliers, customers) gets a tick box.

// Asks before deleting. The red button only works after 5 seconds, so nobody deletes by a quick click. → true / false
function deleteConfirm({ title = 'Delete?', html, ok = 'Delete' }) {
  return new Promise((resolve) => {
    let done = false, left = 5, timer = null;
    const m = modal({
      title,
      body: html,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn danger solid" id="dcGo" disabled>${esc(ok)} (${left})</button>`,
      onClose: () => { clearInterval(timer); if (!done) resolve(false); },
    });
    const b = m.$('#dcGo');
    timer = setInterval(() => {
      left--;
      if (left > 0) { b.textContent = `${ok} (${left})`; return; }
      clearInterval(timer);
      b.textContent = ok;
      b.disabled = false;
    }, 1000);
    b.addEventListener('click', () => { done = true; m.close(); resolve(true); });
  });
}

// The copy of everything made just before deleting: into the backup folder if this computer has one, otherwise a download.
async function backupBeforeDelete() {
  if (App.demo) return null; // (the demo is never backed up)
  return Backup.now({ tag: 'before-delete' });
}

// ---------- Select mode ----------
const SelectMode = (() => {
  // which list shows which kind of record
  const LISTS = { sales: 'sales', purchases: 'purchases', dispatch: 'dispatches', products: 'products', expenses: 'expenses', suppliers: 'suppliers', customers: 'customers' };
  const WORDS = { sales: 'Bills', purchases: 'Purchases', dispatches: 'Transfers', products: 'Items', expenses: 'Expenses', suppliers: 'Suppliers', customers: 'Customers' };
  const sel = new Map(); // "kind:id" → { kind, id, label }
  let on = false, observer = null, busyNow = false;

  const kindHere = () => (App.view ? LISTS[App.view.pattern] : null);

  // Puts a tick box in front of every row of the list on the screen (again after the list redraws).
  function decorate() {
    const kind = kindHere();
    const view = $('#view');
    if (!on || !kind || !view) return;
    for (const table of view.querySelectorAll('table.tbl')) {
      const rows = table.querySelectorAll('tbody > tr[data-id]');
      if (!rows.length || table.closest('.modal-wrap')) continue;
      const head = table.querySelector('thead tr');
      if (head && !head.querySelector('.del-sel')) head.insertAdjacentHTML('afterbegin', '<th class="del-sel"></th>');
      for (const tf of table.querySelectorAll('tfoot tr')) if (!tf.querySelector('.del-sel')) tf.insertAdjacentHTML('afterbegin', '<td class="del-sel"></td>');
      for (const tr of rows) {
        if (tr.querySelector('.del-sel')) continue;
        const key = `${kind}:${tr.dataset.id}`;
        tr.insertAdjacentHTML('afterbegin', `<td class="del-sel"><input type="checkbox" data-delsel="${esc(key)}"${sel.has(key) ? ' checked' : ''} aria-label="Select to delete"></td>`);
        tr.classList.toggle('del-on', sel.has(key));
      }
    }
  }

  function toggle(tr, box, want) {
    const kind = kindHere();
    const key = box.dataset.delsel;
    const label = (tr.querySelector('td:not(.del-sel):not(.sel)')?.textContent || '').trim().slice(0, 60);
    if (want) sel.set(key, { kind, id: Number(key.split(':')[1]), label: `${WORDS[kind].replace(/s$/, '')} ${label}` });
    else sel.delete(key);
    box.checked = want;
    tr.classList.toggle('del-on', want);
    paintBar();
  }

  // In select mode a click on a row ticks it (it does not open it).
  function onClick(e) {
    if (!on) return;
    const tr = e.target.closest('#view table.tbl tbody > tr[data-id]');
    if (!tr || !tr.querySelector('.del-sel')) return;
    const box = tr.querySelector('[data-delsel]');
    if (e.target === box) { e.stopPropagation(); setTimeout(() => toggle(tr, box, box.checked)); return; }
    if (e.target.closest('a, button, select, input, textarea, label')) return;
    e.stopPropagation(); e.preventDefault();
    toggle(tr, box, !box.checked);
  }

  function paintBar() {
    let bar = $('#selBar');
    if (!on) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'selBar';
      document.body.appendChild(bar);
      bar.addEventListener('click', (e) => {
        if (e.target.closest('#selDel')) run();
        else if (e.target.closest('#selClear')) { sel.clear(); $$('[data-delsel]').forEach((b) => { b.checked = false; b.closest('tr')?.classList.remove('del-on'); }); paintBar(); }
        else if (e.target.closest('#selStop')) stop();
        else { const a = e.target.closest('[data-go]'); if (a) go(a.dataset.go); }
      });
    }
    const where = Object.entries(LISTS).filter(([href]) => NAV.some((n) => n.href === href && n.show()));
    bar.innerHTML = `<div class="sel-in"><b>Select to delete</b>
      <span class="sel-where">${where.map(([href, k]) => `<a href="#" data-go="${href}" class="${kindHere() === k ? 'on' : ''}">${WORDS[k]}</a>`).join('')}</span>
      <span class="grow"></span><span><b>${sel.size}</b> selected</span>
      ${sel.size ? '<button type="button" class="btn sm" id="selClear">Untick all</button>' : ''}
      <button type="button" class="btn sm danger solid" id="selDel"${sel.size ? '' : ' disabled'}>Delete selected</button>
      <button type="button" class="btn sm" id="selStop">Done</button></div>`;
    bar.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
  }

  function start(where) {
    if (App.practice) return toast('Finish practising first (the orange bar at the top)', 'error');
    on = true;
    document.body.classList.add('selecting');
    if (!observer) {
      observer = new MutationObserver(() => decorate());
      observer.observe($('#app'), { childList: true, subtree: true });
      document.addEventListener('click', onClick, true);
    }
    paintBar();
    if (where) go(where); else decorate();
  }
  function stop() {
    on = false;
    sel.clear();
    document.body.classList.remove('selecting');
    paintBar();
    if (App.view) router({ quiet: true }); // (the tick boxes go)
  }

  async function run() {
    if (busyNow || !sel.size) return;
    const items = [...sel.values()].map(({ kind, id }) => ({ kind, id }));
    let plan;
    try { plan = await POST('/api/delete/check', { items }); } catch (e) { return toast(e.message, 'error'); }
    const del = plan.filter((x) => x.action !== 'skip'), reset = plan.filter((x) => x.action === 'reset'), skip = plan.filter((x) => x.action === 'skip');
    const list = (xs, why) => `<ul class="del-list">${xs.slice(0, 12).map((x) => `<li>${esc(x.label)}${why ? ` <span class="muted">— ${esc(x.why)}</span>` : ''}</li>`).join('')}${xs.length > 12 ? `<li class="muted">and ${xs.length - 12} more</li>` : ''}</ul>`;
    if (!del.length) {
      return modal({ title: 'Nothing can be deleted', body: `<p style="margin-top:0">None of the selected records can be deleted:</p>${list(skip, true)}`, footer: '<button class="btn primary" data-close>OK</button>' });
    }
    const cloud = Cloud.enabled && App.device.mode === 'cloud';
    const html = `<p style="margin-top:0"><b>${del.length}</b> record${del.length > 1 ? 's' : ''} will be deleted${cloud ? ' on every computer' : ''}:</p>${list(del)}
      ${reset.length ? `<div class="alert" style="margin:10px 0"><b>${reset.length} of them ${reset.length > 1 ? 'are' : 'is'} done</b> (a finished bill, received purchase or sent transfer). ${reset.length > 1 ? 'They are' : 'It is'} reset to draft first: the stock and money go back as if it never happened, then ${reset.length > 1 ? 'they are' : 'it is'} deleted.</div>` : ''}
      ${skip.length ? `<p style="margin-bottom:4px"><b>${skip.length}</b> will be left as they are:</p>${list(skip, true)}` : ''}
      <p class="muted small" style="margin-bottom:0">${App.demo ? 'This is the demo: nothing real is touched.' : 'A backup of everything is saved first, so it can be brought back.'} Deleting cannot be undone here.</p>`;
    if (!(await deleteConfirm({ title: 'Delete the selected records?', html, ok: `Delete ${del.length}` }))) return;
    busyNow = true;
    try {
      await backupBeforeDelete();
      const out = await POST('/api/delete/run', { items: del.map(({ kind, id }) => ({ kind, id })) });
      Cloud.changed();
      ProductCache.invalidate();
      sel.clear();
      toast(`Deleted ${out.deleted} record${out.deleted === 1 ? '' : 's'}${out.skipped.length ? ` (${out.skipped.length} left as they were)` : ''}.`, 'ok', 6000);
      paintBar();
      router({ quiet: true });
    } catch (e) {
      toast('Nothing was deleted: ' + e.message, 'error', 9000);
    } finally { busyNow = false; }
  }

  return { start, stop, isOn: () => on, decorate };
})();
