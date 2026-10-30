'use strict';
// Vouchers (owner): make a code worth Rs or % off, print it with a QR code, see who used it.
// On the sale screen the voucher is scanned or typed and becomes a line that takes money off the bill.

View('vouchers', {
  title: 'Vouchers',
  allow: () => isAdmin(),
  async render({ el }) {
    const st = { show: 'ready', q: '', picked: new Set() };
    let list = [];
    setActions(`<button class="btn primary" id="newV">${icon('plus')} Make vouchers</button>`);
    el.innerHTML = `
      <div class="stats" id="stats"></div>
      <div class="toolbar" style="margin-top:16px">
        <div class="seg" id="vShow"><button data-s="ready">Ready to use</button><button data-s="used">Used up</button><button data-s="gone">Expired / off</button><button data-s="all">All</button></div>
        <input class="input" id="vQ" placeholder="Find a code" style="max-width:200px" autocomplete="off">
        <span class="grow"></span>
        <button class="btn" id="vPrintR">${icon('printer')} Print on receipt printer</button>
        <button class="btn" id="vPrintA">${icon('printer')} Print on A4</button>
      </div>
      <div class="card flush" id="vList"></div>`;
    const stat = (n, label) => `<div class="card stat"><div class="label">${label}</div><div class="value">${n}</div></div>`;
    const worth = (v) => (v.kind === 'pct' ? `${v.value}% off` : `${money(v.value)} off`);
    const rules = (v) => [v.min_bill > 0 ? `bill of ${money(v.min_bill)}+` : '', v.expires ? `till ${fmtDate(v.expires)}` : 'no end date', v.max_uses > 1 ? `${v.max_uses} uses` : 'one use'].filter(Boolean).join(' · ');
    const pill = (v) => ({ ok: v.used ? `<span class="pill amber">Used ${v.used} of ${v.max_uses}</span>` : '<span class="pill green">Ready</span>', used: '<span class="pill">Used up</span>', expired: '<span class="pill red">Expired</span>', off: '<span class="pill red">Switched off</span>' }[v.status]);
    const shown = () => list.filter((v) => (st.show === 'all' || (st.show === 'ready' && v.status === 'ok') || (st.show === 'used' && v.status === 'used') || (st.show === 'gone' && (v.status === 'expired' || v.status === 'off')))
      && (!st.q || v.code.toLowerCase().includes(st.q.toLowerCase().replace(/\s+/g, '')) || (v.note || '').toLowerCase().includes(st.q.toLowerCase())));

    function paint() {
      const ready = list.filter((v) => v.status === 'ok').length;
      $('#stats', el).innerHTML = stat(list.length, 'vouchers made') + stat(ready, 'ready to use') + stat(list.reduce((a, v) => a + v.used, 0), 'times used') + stat(money(list.reduce((a, v) => a + v.given, 0)), 'given off in bills');
      $$('#vShow button', el).forEach((b) => b.classList.toggle('on', b.dataset.s === st.show));
      const rows = shown();
      $('#vList', el).innerHTML = rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th style="width:34px"><input type="checkbox" id="vAll" title="Select all"></th><th>Code</th><th>Worth</th><th>Rules</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>
        ${rows.map((v) => `<tr><td><input type="checkbox" data-pick="${v.id}"${st.picked.has(v.id) ? ' checked' : ''}></td><td class="mono"><b>${esc(v.code)}</b></td><td>${esc(worth(v))}</td><td class="muted">${esc(rules(v))}</td><td>${esc(v.note || '')}</td><td>${pill(v)}</td>
          <td class="r nowrap">${v.used ? `<button class="btn sm" data-bills="${v.id}">Bills</button> ` : ''}<button class="btn sm" data-toggle="${v.id}">${v.active ? 'Switch off' : 'Switch on'}</button>${v.used ? '' : ` <button class="icon-btn" data-del="${v.id}" title="Delete">✕</button>`}</td></tr>`).join('')}
        </tbody></table></div>`
        : `<div class="empty">${list.length ? 'No vouchers here.' : 'No vouchers yet. Press “Make vouchers”.'}</div>`;
      const n = st.picked.size;
      $('#vPrintR', el).lastChild.textContent = ` Print ${n ? n + ' selected' : 'on receipt printer'}`;
      $('#vPrintA', el).lastChild.textContent = ` Print ${n ? 'on A4' : 'on A4'}`;
    }
    async function load() { list = await GET('/api/vouchers'); if (el.isConnected) paint(); }

    el.addEventListener('click', async (e) => {
      const t = e.target.closest('button, input');
      if (!t) return;
      if (t.closest('#vShow')) { st.show = t.dataset.s; paint(); }
      else if (t.id === 'vAll') { for (const v of shown()) (t.checked ? st.picked.add(v.id) : st.picked.delete(v.id)); paint(); }
      else if (t.dataset.pick) { const id = Number(t.dataset.pick); t.checked ? st.picked.add(id) : st.picked.delete(id); paint(); }
      else if (t.dataset.toggle) {
        const v = list.find((x) => x.id === Number(t.dataset.toggle));
        await busy(t, async () => { await PUT('/api/vouchers/' + v.id, { active: !v.active }); await load(); });
      } else if (t.dataset.del) {
        if (await confirmBox('Delete this voucher? It was never used.', { ok: 'Delete', danger: true })) await busy(t, async () => { await DEL('/api/vouchers/' + t.dataset.del); st.picked.delete(Number(t.dataset.del)); await load(); });
      } else if (t.dataset.bills) {
        const v = list.find((x) => x.id === Number(t.dataset.bills));
        const bills = await GET(`/api/vouchers/${v.id}/bills`);
        const m = modal({ title: `Bills that used ${v.code}`, body: `<div class="table-wrap"><table class="tbl"><thead><tr><th>Bill</th><th>When</th><th>Shop</th><th class="r">Taken off</th><th></th></tr></thead><tbody>
          ${bills.map((b) => `<tr class="click" data-bill="${b.id}"><td><b>${esc(b.bill_no)}</b></td><td>${esc(fmtDT(b.created_at))}</td><td>${esc(b.location_name || '')}</td><td class="r">${money(b.voucher)}</td><td>${b.status === 'void' ? '<span class="pill red">Cancelled</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`, footer: '<button class="btn primary" data-close>Close</button>' });
        m.el.addEventListener('click', (ev) => { const r = ev.target.closest('[data-bill]'); if (r) { m.close(); showBill(Number(r.dataset.bill)); } });
      }
    });
    $('#vQ', el).addEventListener('input', (e) => { st.q = e.target.value.trim(); paint(); });
    const printPicked = (mode) => {
      const pick = st.picked.size ? list.filter((v) => st.picked.has(v.id)) : shown().slice(0, 50);
      if (!st.picked.size && pick.length) toast(`Nothing ticked: printing the ${pick.length} shown (up to 50)`);
      printVouchers(pick, mode);
    };
    $('#vPrintR', el).addEventListener('click', () => printPicked('receipt'));
    $('#vPrintA', el).addEventListener('click', () => printPicked('a4'));

    $('#newV').addEventListener('click', () => {
      const m = modal({
        title: 'Make vouchers',
        body: `<form id="vForm" class="form-grid">
          <div class="field"><span>Worth</span><div class="disc-in" style="width:auto"><input class="input num" name="value" inputmode="decimal" placeholder="e.g. 500" autofocus>
            <div class="seg" id="vKind"><button type="button" data-k="amt" class="on">${esc(App.settings.currency)}</button><button type="button" data-k="pct">%</button></div></div></div>
          <label class="field">How many vouchers<input class="input num" name="count" inputmode="numeric" value="1"></label>
          <label class="field">Only on a bill of at least <input class="input num" name="min_bill" inputmode="decimal" placeholder="no minimum"></label>
          <label class="field">Last day to use it<input class="input" type="date" name="expires"></label>
          <label class="field">Each can be used (times)<input class="input num" name="max_uses" inputmode="numeric" value="1"></label>
          <label class="field">Note (shown on the voucher)<input class="input" name="note" placeholder="e.g. Diwali gift" maxlength="60"></label>
          <label class="field" id="ownCode">Your own code (optional)<input class="input" name="code" placeholder="e.g. DIWALI10" autocapitalize="characters"></label>
        </form>`,
        footer: '<button class="btn" data-close>Cancel</button><button class="btn primary" id="vMake">Make</button>',
      });
      let kind = 'amt';
      m.el.addEventListener('click', (e) => { const b = e.target.closest('#vKind button'); if (b) { kind = b.dataset.k; $$('#vKind button', m.el).forEach((x) => x.classList.toggle('on', x === b)); } });
      const go = m.$('#vMake');
      const make = () => busy(go, async () => {
        const v = formValues(m.$('#vForm'));
        const made = await POST('/api/vouchers', { ...v, kind });
        m.close();
        st.picked = new Set(made.map((x) => x.id)); st.show = 'ready';
        await load();
        toast(`${made.length} voucher${made.length === 1 ? '' : 's'} made. Ticked below: print them now.`);
      });
      go.addEventListener('click', make);
      m.$('#vForm').addEventListener('submit', (e) => { e.preventDefault(); make(); });
    });
    await load();
  },
});
