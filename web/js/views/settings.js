'use strict';
// Settings (owner): business details, printing, shops (with their switches), people (PIN + switches),
// devices, backup & data. Plus "My passcode" for everyone.

const SETTINGS_TABS = [
  ['business', 'Business'], ['printing', 'Bills & labels'], ['locations', 'Shops & warehouse'], ['users', 'Users'],
  ['backup', 'Backup & data'],
];

async function saveSettings(values, btn) {
  return busy(btn, async () => {
    App.settings = await PUT('/api/settings', values);
    toast('Saved');
  });
}

View('settings', { title: 'Settings', allow: isAdmin, render: () => go('settings/business') });

View('settings/:tab', {
  title: 'Settings',
  nav: 'settings',
  allow: isAdmin,
  async render({ el, params }) {
    const tab = SETTINGS_TABS.some(([k]) => k === params.tab) ? params.tab : 'business';
    el.innerHTML = `<div class="tabs">${SETTINGS_TABS.map(([k, t]) => `<a href="#/settings/${k}" class="${k === tab ? 'active' : ''}">${t}</a>`).join('')}</div><div id="tab"></div>`;
    await SETTINGS_RENDER[tab]($('#tab', el));
  },
});

// On/off switches for what a place or person may do, in groups (Selling, Stock, Money).
function permSwitchesHtml(selected, { allowed = null } = {}) {
  const groups = {};
  for (const [k, label, group] of App.permsCatalog) (groups[group] = groups[group] || []).push([k, label]);
  return Object.entries(groups).map(([g, list]) => `<div class="sw-group"><div class="sw-title">${esc(g)}</div>
    ${list.map(([k, label]) => {
      const off = allowed && !allowed.includes(k);
      return `<label class="sw-row${off ? ' disabled' : ''}"><input type="checkbox" class="switch" data-perm="${k}" ${selected.includes(k) && !off ? 'checked' : ''} ${off ? 'disabled' : ''}>
        <span>${esc(label)}${off ? ' <small class="muted">(off for this place)</small>' : ''}</span></label>`;
    }).join('')}</div>`).join('');
}
const readSwitches = (root) => $$('[data-perm]', root).filter((c) => c.checked && !c.disabled).map((c) => c.dataset.perm);
const permLabel = (k) => (App.permsCatalog.find((p) => p[0] === k) || [k, k])[1];
const DEFAULT_PLACE_PERMS = {
  shop: ['sell', 'returns', 'discount', 'receive', 'expenses'],
  warehouse: ['receive', 'buy', 'send', 'add_items', 'correct_stock', 'expenses', 'see_cost'],
};

const SETTINGS_RENDER = {
  async business(el) {
    const S = App.settings;
    el.innerHTML = `<div class="card" style="max-width:760px"><form id="f" class="form-grid">
      <label class="field full">Business name<input class="input" name="business_name" value="${esc(S.business_name)}"><span class="hint">Shown on bills, labels and at the top of the screen.</span></label>
      <label class="field">Phone<input class="input" name="business_phone" value="${esc(S.business_phone)}"></label>
      <label class="field">Currency sign<input class="input" name="currency" value="${esc(S.currency)}" placeholder="Rs"></label>
      <label class="field full">Address<input class="input" name="business_address" value="${esc(S.business_address)}"><span class="hint">Each shop can also have its own address (Shops & warehouse) — that one is printed on its bills.</span></label>
      <label class="field">"Low stock" means this many or fewer<input class="input num" name="low_stock" value="${esc(S.low_stock)}" inputmode="numeric"></label>
      <div class="full"><h3 style="margin:8px 0 2px">Warnings</h3><div class="hint" style="margin:0">Before saving something unusual, Velanzo asks "Please check this" (for example a price of ${esc(S.currency || 'Rs')} 0 or selling below cost). You decide when these two warn:</div></div>
      <label class="field">Warn when a discount is more than (%)<input class="input num" name="warn_discount" value="${esc(S.warn_discount)}" inputmode="numeric"></label>
      <label class="field">Warn when one expense is more than<input class="input num" name="warn_expense" value="${esc(S.warn_expense)}" inputmode="numeric"></label>
      <div class="full"><button class="btn primary">Save</button></div></form></div>`;
    $('#f', el).addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveSettings(formValues(e.target), e.target.querySelector('button'));
      const b = $('.brand-text b'); if (b) b.textContent = App.settings.business_name;
    });
  },

  async printing(el) {
    const S = App.settings;
    const sample = { name: 'Lawn Kurta Embroidered', size: 'M', color: 'Blue', barcode: '10000001', sale_price: 2450 };
    el.innerHTML = `<div class="grid-2" style="margin-top:0"><div class="card"><h3>Customer bill (receipt printer)</h3><form id="fb" class="form-grid">
        <label class="field">Paper width<select class="input" name="bill_width">${options([['80', '80 mm (standard)'], ['58', '58 mm (small)']], S.bill_width)}</select></label>
        <label class="field">Print bill automatically after each sale<select class="input" name="auto_print_bill">${options([['1', 'Yes'], ['0', 'No — I will press Print']], S.auto_print_bill)}</select></label>
        <label class="field">Print width (mm)<input class="input num" name="bill_mm" value="${esc(S.bill_mm || '')}" placeholder="${S.bill_width === '58' ? 48 : 72}" inputmode="numeric"><span class="hint">Leave empty for normal. If the right side of a bill is cut off, type a smaller number (try 64).</span></label>
        <label class="field">Space from the left (mm)<input class="input num" name="bill_left" value="${esc(S.bill_left || '')}" placeholder="centred" inputmode="decimal"><span class="hint">Leave empty to centre. If the left side is cut off, try 2.</span></label>
        <label class="field full">Message at the bottom of the bill<textarea class="input" name="bill_footer">${esc(S.bill_footer)}</textarea></label>
        <label class="field">Dispatch note paper<select class="input" name="dispatch_paper">${options([['a4', 'A4 / normal printer'], ['receipt', 'Receipt printer']], S.dispatch_paper)}</select></label>
        <div class="full" style="display:flex;gap:8px"><button class="btn primary">Save</button><button type="button" class="btn" id="testBill">${icon('printer')} Print test bill</button><button type="button" class="btn" id="ruler">${icon('printer')} Print ruler</button></div></form></div>
      <div class="card"><h3>Barcode labels</h3><form id="fl" class="form-grid">
        <label class="field">Printer type<select class="input" name="label_mode">${options([['roll', 'Label printer (roll of stickers)'], ['a4', 'Normal printer (A4 sticker sheet)']], S.label_mode)}</select></label>
        <label class="field">Labels across (A4 only)<input class="input num" name="label_columns" value="${esc(S.label_columns)}" inputmode="numeric"></label>
        <label class="field">Label width (mm)<input class="input num" name="label_width" value="${esc(S.label_width)}" inputmode="numeric"></label>
        <label class="field">Label height (mm)<input class="input num" name="label_height" value="${esc(S.label_height)}" inputmode="numeric"></label>
        <label class="check"><input type="checkbox" name="label_show_name" ${S.label_show_name !== '0' ? 'checked' : ''}> Show item name</label>
        <label class="check"><input type="checkbox" name="label_show_price" ${S.label_show_price !== '0' ? 'checked' : ''}> Show price</label>
        <div class="full" id="lprev"></div>
        <div class="full" style="display:flex;gap:8px"><button class="btn primary">Save</button><button type="button" class="btn" id="testLbl">${icon('printer')} Print test label</button></div></form>
        <div class="hint" style="margin-top:10px">Common sizes: 50×25, 38×25, 40×30 mm. Measure one sticker on your roll.</div></div></div>
      <div class="card" style="margin-top:16px"><h3>Test the barcode scanner</h3>
        <p class="muted small" style="margin:0 0 10px">Click in the box and scan any barcode (an item's label, or a code on a box). Velanzo shows what the scanner sent.</p>
        <input class="input" id="scanTest" placeholder="Scan here…" autocomplete="off" style="max-width:420px">
        <div id="scanRes" style="margin-top:12px"></div></div>`;
    const lvals = () => { const v = formValues($('#fl', el)); v.label_show_name = v.label_show_name ? '1' : '0'; v.label_show_price = v.label_show_price ? '1' : '0'; return v; };
    const preview = () => {
      const old = App.settings;
      App.settings = { ...old, ...lvals() };
      $('#lprev', el).innerHTML = labelPreviewHtml(sample);
      App.settings = old;
    };
    preview();
    $('#fl', el).addEventListener('input', preview);
    $('#fb', el).addEventListener('submit', (e) => { e.preventDefault(); saveSettings(formValues(e.target), e.target.querySelector('button')); });
    $('#fl', el).addEventListener('submit', (e) => { e.preventDefault(); saveSettings(lvals(), e.target.querySelector('button')); });
    $('#ruler', el).addEventListener('click', () => {
      const old = App.settings;
      App.settings = { ...old, ...formValues($('#fb', el)) };
      printRuler();
      App.settings = old;
    });
    $('#testBill', el).addEventListener('click', () => {
      const old = App.settings;
      App.settings = { ...old, ...formValues($('#fb', el)) };
      printBill({ bill_no: 'TEST-00001', created_at: nowStr(), location_name: shops()[0]?.name || 'Shop', user_name: App.user.name, status: 'done',
        items: [{ ...sample, qty: 2, price: 2450 }, { name: 'Cotton Shirt', size: 'L', color: 'White', barcode: '10000002', qty: 1, price: 1800 }],
        subtotal: 6700, discount: 200, total: 6500, paid: 7000, change_due: 500, payment_method: 'cash' });
      App.settings = old;
    });
    // what the scanner sends: the code, how fast, and which key it presses at the end
    const st = $('#scanTest', el), res = $('#scanRes', el);
    let times = [], idle = null;
    const report = async (endKey) => {
      clearTimeout(idle);
      const code = st.value.trim();
      const n = times.length;
      const avg = n > 1 ? (times[n - 1] - times[0]) / (n - 1) : 0;
      times = [];
      if (!code) return;
      let item = null;
      try { item = await GET('/api/products/lookup', { code }); } catch { /* not an item */ }
      const fast = n >= 6 && avg <= Scanner.AVG;
      const rows = [
        ['Received', `<b class="mono">${esc(code)}</b> (${code.length} characters)`],
        ['Speed', `${Math.round(avg)} ms between characters — ${fast ? '<span class="pill ok">a scanner ✓</span>' : n < 6 ? '<span class="pill warn">too short to tell</span>' : '<span class="pill warn">as slow as typing</span>'}`],
        ['Ends with', endKey ? `<span class="pill ok">${endKey} ✓</span>` : '<span class="pill red">nothing</span>'],
        ['Item', item ? `<span class="pill ok">✓</span> ${esc(pname(item))} · ${money(item.sale_price)}` : '<span class="muted">not an item in Velanzo (that is fine for a test)</span>'],
      ];
      const tips = [];
      if (!endKey) tips.push('The scanner does not press Enter after the code. In its manual, scan the setting barcode for <b>“Add Enter / CR suffix”</b>.');
      if (n >= 6 && !fast) tips.push('This is as slow as a person typing. It still works in the scan box, but if the cursor is in another box the scan stays there. In the scanner\'s manual, choose a faster <b>USB keyboard speed</b>.');
      if (/[^\x20-\x7e]/.test(code)) tips.push('Strange characters arrived: set the Windows keyboard to <b>English (US)</b> on this computer.');
      res.innerHTML = `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>${tips.map((t) => `<div class="alert" style="margin:10px 0 0">${t}</div>`).join('')}`;
      st.value = '';
    };
    st.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); report(e.key); return; }
      if (e.key.length === 1) { times.push(performance.now()); clearTimeout(idle); idle = setTimeout(() => report(''), 600); } // no Enter at all
    });
    $('#testLbl', el).addEventListener('click', () => {
      const old = App.settings;
      App.settings = { ...old, ...lvals() };
      printLabels([{ product: sample, copies: 1 }]);
      App.settings = old;
    });
  },

  async locations(el) {
    const locs = await GET('/api/locations');
    App.locations = locs;
    el.innerHTML = `<div class="alert info">Add a shop here when you open one. Each place has its own stock, bill numbers and people. Use the switches to choose what each place may do.</div>
      <div class="card-head"><h3 style="margin:0">Shops & warehouses</h3><div class="actions"><button class="btn primary" id="add">${icon('plus')} Add a place</button></div></div>
      <div class="place-grid">${locs.map((l) => `<button class="card place-card${l.active ? '' : ' closed'}" data-id="${l.id}">
        <div class="pc-head"><b>${esc(l.name)}</b><span class="pill">${l.type === 'shop' ? 'Shop' : 'Warehouse'} · ${esc(l.code)}</span>${l.active ? '' : '<span class="pill">Closed</span>'}</div>
        <div class="pc-perms">${l.perms.length ? l.perms.map((k) => `<span class="pill ok">${esc(permLabel(k))}</span>`).join('') : '<span class="muted">Can\'t do anything yet</span>'}</div>
        ${l.address ? `<div class="muted small">${esc(l.address)}</div>` : ''}</button>`).join('')}</div>`;
    const open = (l) => {
      const nextCode = 'S' + (locs.filter((x) => x.type === 'shop').length + 1);
      const m = modal({
        title: l ? l.name : 'Add a shop or warehouse',
        size: 'wide',
        body: `<div class="form-grid">
          <label class="field">Name<input class="input" name="name" value="${esc(l?.name || '')}" placeholder="Shop 2 — Mall Road"></label>
          <label class="field">Short code<input class="input mono" name="code" value="${esc(l?.code || nextCode)}" maxlength="4"><span class="hint">Starts its bill numbers, e.g. ${esc(l?.code || nextCode)}-A0001</span></label>
          <label class="field">Type<select class="input" name="type">${options([['shop', 'Shop'], ['warehouse', 'Warehouse']], l?.type || 'shop')}</select></label>
          <label class="field">Phone<input class="input" name="phone" value="${esc(l?.phone || '')}"></label>
          <label class="field full">Address (printed on this shop's bills)<input class="input" name="address" value="${esc(l?.address || '')}"></label>
          ${l ? `<label class="check full"><input type="checkbox" name="active" ${l.active ? 'checked' : ''}> Open (untick if this place is closed — its history is kept)</label>` : ''}</div>
          <h3 style="margin:18px 0 4px">What this place can do</h3>
          <p class="muted small" style="margin:0 0 6px">People who work here can only do what is switched on. You can also switch things off for one person (Settings → People).</p>
          <div id="sw">${permSwitchesHtml(l ? l.perms : DEFAULT_PLACE_PERMS.shop)}</div>
          <a href="#" id="usual" class="small">Use the usual switches for a ${l?.type === 'warehouse' ? 'warehouse' : 'shop'}</a>`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ls">Save</button>`,
      });
      const typeSel = m.$('[name=type]');
      const usual = () => { m.$('#sw').innerHTML = permSwitchesHtml(DEFAULT_PLACE_PERMS[typeSel.value]); m.$('#usual').textContent = `Use the usual switches for a ${typeSel.value}`; };
      m.$('#usual').addEventListener('click', (e) => { e.preventDefault(); usual(); });
      if (!l) typeSel.addEventListener('change', usual);
      const b = m.$('#ls');
      b.addEventListener('click', () => busy(b, async () => {
        const v = formValues(m.el);
        for (const k of Object.keys(v)) if (k.startsWith('perm')) delete v[k];
        v.perms = readSwitches(m.$('#sw'));
        if (l) await PUT('/api/locations/' + l.id, v); else await POST('/api/locations', v);
        await loadMe();
        toast('Saved');
        m.close();
        SETTINGS_RENDER.locations(el);
      }));
    };
    $('#add', el).addEventListener('click', () => open(null));
    $$('.place-card', el).forEach((c) => c.addEventListener('click', () => open(locs.find((l) => l.id === +c.dataset.id))));
  },

  // One list: each person with their user ID, place, computer and passcode. (Computers used to be a separate list.)
  async users(el) {
    const cloud = Cloud.enabled && App.device.mode === 'cloud';
    const users = await GET('/api/users');
    let devs = [], logins = {};
    if (cloud) {
      devs = await GET('/api/devices');
      try { logins = await Cloud.listUserLogins(); } catch { /* offline: the IDs are shown when the internet is back */ }
    }
    const computerOf = (u) => devs.filter((d) => d.active && d.last_user_id === u.id && d.location_id != null).sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''))[0];
    const lastSeen = (d) => (d && d.last_seen_at ? fmtDT(d.last_seen_at) : 'never');
    const what = (u) => {
      if (u.role === 'admin') return 'Everything, everywhere';
      const loc = locById(u.location_id);
      if (!u.perms) return `Same as ${esc(loc?.name || 'their place')}`;
      const list = (loc?.perms || []).filter((k) => u.perms[k]);
      return list.length ? list.map((k) => esc(permLabel(k))).join(', ') : 'Nothing switched on';
    };
    el.innerHTML = `<div class="alert info">You make a <b>user ID and password</b> for each person. They sign in with it once on their computer, then choose their own 4-digit passcode. The computer stays signed in and asks the passcode every time Velanzo opens.</div>
      <div class="card flush"><div class="card-head pad"><h3>Users</h3><div class="actions"><button class="btn primary" id="add">${icon('plus')} Add a user</button></div></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Name</th><th>User ID</th><th>Works at</th><th>Can do</th><th>Computer</th><th>Passcode</th><th></th></tr></thead><tbody>
      ${users.map((u) => { const d = computerOf(u); return `<tr class="click" data-id="${u.id}"><td><b>${esc(u.name)}</b>${u.id === App.user.id ? ' <span class="pill blue">you</span>' : ''}${u.active ? '' : ' <span class="pill">Switched off</span>'}</td>
        <td>${u.role === 'admin' ? '<span class="muted small">email sign-in</span>' : logins[u.id] ? `<span class="mono">${esc(logins[u.id])}</span>` : '<span class="pill red">No user ID yet</span>'}</td>
        <td>${u.role === 'admin' ? '<span class="pill blue">Owner</span>' : esc(locName(u.location_id))}</td><td class="small">${what(u)}</td>
        <td class="small">${u.role === 'admin' ? 'Owner computers' : d ? `${esc(d.label || 'Computer')}<br><span class="muted">online ${esc(lastSeen(d))}</span>` : '<span class="muted">not signed in yet</span>'}</td>
        <td>${u.has_pin ? '<span class="pill ok">Chosen</span>' : '<span class="muted small">chosen at first sign-in</span>'}</td>
        <td class="r">${d && u.role !== 'admin' ? `<button class="btn sm danger" data-rm="${d.id}" data-name="${esc(u.name)}">Remove computer</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div></div>
      ${cloud ? '' : '<div class="alert" style="margin-top:16px">Velanzo keeps its data on this computer only (no cloud), so people do not sign in with an ID here. Connect it to the cloud to use several computers.</div>'}`;

    const open = (u) => {
      const places = App.locations.filter((l) => l.active);
      const isOwnerRow = u?.role === 'admin';
      const m = modal({
        title: u ? u.name : 'Add a user',
        size: 'wide',
        body: `<div class="form-grid">
          <label class="field">Name<input class="input" name="name" value="${esc(u?.name || '')}" placeholder="Ahmed"></label>
          ${isOwnerRow ? '' : `<label class="field" id="locF">Works at<select class="input" name="location_id">${options(places, u?.location_id || places.find((l) => l.type === 'shop')?.id)}</select></label>`}
          ${isOwnerRow || !cloud ? '' : `<label class="field">User ID<input class="input" name="login" value="${esc(u ? (logins[u.id] || '') : '')}" placeholder="ahmed.shop1" autocapitalize="none" autocomplete="off" spellcheck="false"><span class="hint">3 or more letters or numbers, no spaces. They type this to sign in.</span></label>
          <label class="field">${u && logins[u.id] ? 'New password (leave empty to keep)' : 'Password'}<input class="input" name="password" type="text" autocomplete="off" placeholder="at least 6 characters"><span class="hint">Tell them the password.</span></label>`}
          ${isOwnerRow ? '' : `<label class="field">${u ? 'New passcode (leave empty to keep)' : 'Passcode (optional)'}<input class="input pin-input" name="pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 numbers"><span class="hint">${cloud ? 'Leave empty and the person chooses it themselves when they first sign in (then only they know it).' : '4 numbers.'}</span></label>`}
          ${u ? `<label class="check full"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Can sign in (untick when someone leaves)</label>` : ''}</div>
          ${isOwnerRow ? '<p class="muted small">The owner signs in with their email. They choose their own passcode on each owner computer.</p>' : `<div id="permBox"><h3 style="margin:18px 0 4px">What this person can do</h3>
          <label class="check"><input type="checkbox" id="same" ${!u || !u.perms ? 'checked' : ''}> Same as their place</label>
          <div id="sw"></div></div>`}`,
        footer: `<button class="btn" data-close>Cancel</button><button class="btn primary" id="us">Save</button>`,
      });
      const locSel = m.$('[name=location_id]'), same = m.$('#same');
      const paint = () => {
        if (!same) return;
        const allowed = locById(locSel.value)?.perms || [];
        const current = u?.perms ? Object.keys(u.perms).filter((k) => u.perms[k]) : allowed;
        m.$('#sw').innerHTML = same.checked ? `<p class="muted small">${allowed.map(permLabel).join(', ') || 'Nothing is switched on for this place yet.'}</p>` : permSwitchesHtml(current, { allowed });
      };
      [locSel, same].filter(Boolean).forEach((x) => x.addEventListener('change', paint));
      paint();
      const b = m.$('#us');
      b.addEventListener('click', () => busy(b, async () => {
        const v = formValues(m.el);
        const login = (v.login || '').trim(), password = v.password || '';
        delete v.same; delete v.login; delete v.password;
        if (!v.pin) delete v.pin;
        else if (!/^[0-9]{4}$/.test(v.pin)) throw new Error('The passcode must be exactly 4 numbers.');
        if (isOwnerRow) { v.role = 'admin'; v.location_id = null; } else { v.role = 'staff'; v.perms = same.checked ? null : readSwitches(m.$('#sw')); }
        if (!u && cloud && (!login || password.length < 6)) throw new Error('Type a user ID and a password of at least 6 characters.');
        if (password && password.length < 6) throw new Error('The password must be at least 6 characters.');
        const saved = u ? await PUT('/api/users/' + u.id, v) : await POST('/api/users', v);
        if (cloud && !isOwnerRow && (login || password)) {
          // the person must be in the cloud before they can get a login
          await Cloud.syncNow();
          try { await Cloud.setUserLogin(saved.id, login || logins[saved.id], password || null); }
          catch (e) { toast(`${u ? 'Saved, but' : 'The user was saved, but'} the sign-in was not set: ${e.message}`, 'error', 9000); m.close(); return SETTINGS_RENDER.users(el); }
        }
        toast(!u && cloud ? `Saved. Give ${v.name} the user ID and password.` : 'Saved');
        m.close();
        SETTINGS_RENDER.users(el);
      }));
    };
    $('#add', el).addEventListener('click', () => open(null));
    $('tbody', el).addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        e.stopPropagation();
        (async () => {
          if (!(await confirmBox(`Remove ${rm.dataset.name}'s computer? It stops working at once and must sign in again. Do this if it was lost, stolen or replaced.`, { title: 'Remove computer', ok: 'Remove', danger: true }))) return;
          await busy(rm, async () => { await Cloud.removeDevice(Number(rm.dataset.rm)); await Cloud.syncNow(); toast('Computer removed'); SETTINGS_RENDER.users(el); });
        })();
        return;
      }
      const r = e.target.closest('[data-id]');
      if (r) open(users.find((u) => u.id === +r.dataset.id));
    });
  },

  async backup(el) {
    const st = { from: '', to: '' };
    let last = null;
    try { last = localStorage.getItem('vz_last_backup'); } catch { /* ignore */ }
    const EXPORTS = [
      ['products', 'Items (price list)'], ['stock', 'Stock at each place'], ['sales', 'Bills'], ['sale_items', 'Bill lines (every item sold)'],
      ['purchases', 'Purchases'], ['purchase_items', 'Purchase lines'], ['dispatches', 'Stock sent'], ['dispatch_items', 'Stock sent (lines)'],
      ['expenses', 'Expenses'], ['suppliers', 'Suppliers & dues'], ['movements', 'Full stock history'],
    ];
    const cloud = Cloud.enabled && App.device.mode === 'cloud';
    el.innerHTML = `
      <div class="grid-2" style="margin-top:0">
        <div class="card"><h3>Full backup</h3>
          <p class="muted" style="margin-top:0">One file with <b>all</b> your data. Keep copies on Google Drive or a USB stick. The same file can be loaded into a new version of the software.</p>
          <p class="small">${last ? `Last backup from this device: <b>${esc(fmtDT(last))}</b>` : '<span class="neg">No backup downloaded on this device yet.</span>'}</p>
          <button class="btn primary" id="bkBtn">${icon('download')} Download full backup</button>
        </div>
        <div class="card"><h3>Restore from a backup</h3>
          <p class="muted" style="margin-top:0">Replaces <b>everything</b> with the backup file${cloud ? ', on every device' : ''}. Download a backup of the current data first.</p>
          <input type="file" id="restoreFile" accept=".json,application/json" class="input" style="padding-top:7px">
          <button class="btn danger" id="restoreBtn" style="margin-top:10px" disabled>Restore this backup…</button>
        </div>
      </div>
      <div class="card" style="margin-top:16px"><h3>Export to Excel</h3>
        <p class="muted" style="margin-top:0">Downloads a file that opens in Excel or Google Sheets. Dates are optional (empty = everything).</p>
        <div class="toolbar">${rangeBarHtml(st)}<button class="btn ghost" id="allTime">All time</button></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${EXPORTS.map(([k, t]) => `<button class="btn" data-exp="${k}">${icon('download')} ${t}</button>`).join('')}</div>
      </div>
      <div class="card"><h3>Import items from Excel</h3>
        <p class="muted" style="margin-top:0">Add many items (and their current stock) at once — useful when starting.</p>
        <button class="btn" id="impBtn">${icon('upload')} Import items…</button></div>
      <div class="card" id="manageCard"><h3>Manage data</h3><div id="mdBody" class="loading">Loading…</div></div>`;
    const refreshRange = () => {
      $$('[data-preset]', el).forEach((b) => { const [, f, t] = rangePresets()[b.dataset.preset]; b.classList.toggle('on', st.from === f && st.to === t); });
      $('[data-range=from]', el).value = st.from; $('[data-range=to]', el).value = st.to;
    };
    bindRangeBar(el, st, refreshRange);
    $('#allTime', el).addEventListener('click', () => { st.from = ''; st.to = ''; refreshRange(); });
    $$('[data-exp]', el).forEach((b) => b.addEventListener('click', () => busy(b, () => download(`/api/export/${b.dataset.exp}${qs({ from: st.from, to: st.to })}`))));
    $('#impBtn', el).addEventListener('click', () => openImportProducts());
    const bk = $('#bkBtn', el);
    bk.addEventListener('click', () => busy(bk, async () => {
      await download('/api/backup/export');
      try { localStorage.setItem('vz_last_backup', nowStr()); } catch { /* ignore */ }
      SETTINGS_RENDER.backup(el);
    }));
    const file = $('#restoreFile', el), rb = $('#restoreBtn', el);
    file.addEventListener('change', () => { rb.disabled = !file.files[0]; });
    rb.addEventListener('click', async () => {
      const f = file.files[0];
      if (!f) return;
      let data;
      try { data = JSON.parse(await readFileText(f)); } catch { return toast('This file is not a valid backup', 'error'); }
      if (data.app !== 'velanzo') return toast('This file is not a Velanzo backup', 'error');
      const t = data.tables || {};
      const n = (k) => (t[k] || []).length;
      const ok = await confirmBox(`Restore the backup from ${data.exported_at}?\n\nIt has ${n('products')} items, ${n('sales')} bills, ${n('purchases')} purchases and ${n('users')} people.\n\nALL current data${cloud ? ' on every device' : ''} will be replaced.`, { title: 'Restore backup', ok: 'Replace all data', danger: true });
      if (!ok) return;
      await busy(rb, async () => {
        await replaceEverywhere(data);
        alert('Backup restored.');
        location.reload();
      });
    });
    manageData(el, cloud).catch((e) => { const b = $('#mdBody', el); if (b) b.textContent = e.message; });
  },
};

View('account', {
  title: 'My passcode',
  async render({ el }) {
    el.innerHTML = `<div class="card" style="max-width:460px"><form id="pf" autocomplete="off">
      <label class="field">Current passcode<input class="input pin-input" type="password" name="current" inputmode="numeric" maxlength="4" autofocus></label><br>
      <label class="field">New passcode<input class="input pin-input" type="password" name="pin" inputmode="numeric" maxlength="4" placeholder="4 to 6 numbers"></label><br>
      <label class="field">New passcode again<input class="input pin-input" type="password" name="pin2" inputmode="numeric" maxlength="4"></label><br>
      <button class="btn primary">Change passcode</button></form></div>`;
    $('#pf', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      if (v.pin !== v.pin2) return toast('The two new passcodes are different', 'error');
      busy(e.target.querySelector('button'), async () => {
        await POST('/api/me/pin', v);
        toast('Passcode changed');
        e.target.reset();
      });
    });
  },
});
