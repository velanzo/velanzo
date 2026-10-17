'use strict';
// First start on a device (owner sign-in, shop/warehouse code, or one device without the cloud)
// and the "Who's working?" screen with PINs.
const Setup = (() => {
  const card = (inner, wide) => `<div class="login"><div class="login-card${wide ? ' wide' : ''}">${inner}</div></div>`;
  const logo = '<div class="setup-logo">V</div>';
  const show = (html) => { while (App.cleanups.length) { try { App.cleanups.pop()(); } catch { /* ignore */ } } $('#app').innerHTML = html; };
  // A name for this device in the owner's list, e.g. "Windows computer", "Android phone".
  const deviceLabel = () => {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    return `${os} ${/Mobi|Android|iPhone/i.test(ua) ? 'phone' : 'computer'}`.trim().replace(/^iPhone phone$/, 'iPhone');
  };
  const errBox = (id = 'setupErr') => `<div class="err" id="${id}"></div>`;
  const setErr = (msg, id = 'setupErr') => { const e = $('#' + id); if (e) e.textContent = msg || ''; };

  async function start() {
    const link = Cloud.enabled ? Cloud.takeLink() : null;
    if (link) return showLink(link);
    try {
      await Engine.open();
    } catch (e) {
      if (/BUSY/.test(e.message)) return showError('Velanzo is already open in another tab or window on this device. Close the other one, then try again.', 'Already open');
      return showError('This browser cannot keep Velanzo\'s data. Please use Google Chrome or Microsoft Edge (not a private window).', 'Can\'t store data');
    }
    // Ask the browser to keep our data even when the disk is nearly full.
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* not supported */ }
    const info = await Engine.system('info');
    App.device = info.device;
    if (!info.device.id) return emailConfirmed ? showOwner('signin') : showWelcome();
    Cloud.start();
    if (info.user_id) return boot();
    showLogin();
  }

  // ---------- A new device ----------
  function showWelcome() {
    if (!Cloud.enabled) return showLocalStart();
    show(card(`${logo}<h1>Welcome to Velanzo</h1><p class="muted">How will this device be used?</p>
      <button class="choice" id="cShop">${icon('inbox')}<span><b>Shop or warehouse computer</b><small>I have a code from the owner</small></span></button>
      <button class="choice" id="cOwner">${icon('users')}<span><b>I'm the owner</b><small>Sign in, or start a new business</small></span></button>`));
    $('#cShop').addEventListener('click', showJoin);
    $('#cOwner').addEventListener('click', () => showOwner('signin'));
  }

  // Not connected to the cloud: one device keeps everything (it can join the cloud later).
  function showLocalStart() {
    show(card(`${logo}<h1>Start Velanzo</h1><p class="muted">Velanzo will keep its data on this device.</p>
      <form id="f" autocomplete="off">
        <label class="field">Business name<input class="input" name="business_name" placeholder="Velanzo Clothing" required></label>
        <label class="field">Your name<input class="input" name="owner_name" placeholder="Owner" required></label>
        ${pinFields()}
        <button class="btn primary lg block">Start</button>${errBox()}
      </form>`));
    $('#f').addEventListener('submit', (e) => submitBusiness(e, async (v) => {
      await Engine.system('setupLocal', { business_name: v.business_name, owner_name: v.owner_name, pin: v.pin });
      App.device = (await Engine.system('info')).device;
      boot();
    }));
  }

  const pinFields = () => `<div class="form-grid"><label class="field">Choose a PIN<input class="input pin-input" name="pin" inputmode="numeric" type="password" maxlength="6" placeholder="4 to 6 numbers" required></label>
    <label class="field">PIN again<input class="input pin-input" name="pin2" inputmode="numeric" type="password" maxlength="6" required></label></div>
    <p class="muted small">You type this PIN to open Velanzo, like a phone.</p>`;
  async function submitBusiness(e, fn) {
    e.preventDefault();
    const v = formValues(e.target);
    if (!/^\d{4,6}$/.test(v.pin)) return setErr('The PIN must be 4 to 6 numbers.');
    if (v.pin !== v.pin2) return setErr('The two PINs are not the same.');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try { await fn(v); } catch (err) { setErr(err.message); btn.disabled = false; }
  }

  // The owner signs in (or creates the account the first time).
  // fromLocal: this computer used Velanzo without the cloud and now brings its data up.
  function showOwner(mode, { fromLocal = false } = {}) {
    const signup = mode === 'signup';
    show(card(`${logo}<h1>${signup ? 'Create your owner account' : 'Owner sign in'}</h1>
      <p class="muted">${signup ? 'For a new business. You will use this email and password to sign in on your phone or computer.' : 'Use the email and password of your Velanzo owner account.'}</p>
      <form id="f">
        <label class="field">Email<input class="input" name="email" type="email" autocomplete="username" required></label>
        <label class="field">Password<input class="input" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? 8 : 1}" required>
          ${signup ? '<small class="muted">At least 8 characters.</small>' : ''}</label>
        <button class="btn primary lg block">${signup ? 'Create account' : 'Sign in'}</button>${errBox()}
      </form>
      <div class="setup-links">${signup ? '<a href="#" id="toggle">I already have an account</a>' : '<a href="#" id="forgot">Forgot your password?</a> · <a href="#" id="toggle">New business? Create an owner account</a>'} · <a href="#" id="back">Back</a></div>`));
    const fg = $('#forgot');
    if (fg) fg.addEventListener('click', (e) => { e.preventDefault(); showForgotPassword(fromLocal); });
    $('#toggle').addEventListener('click', (e) => { e.preventDefault(); showOwner(signup ? 'signin' : 'signup', { fromLocal }); });
    $('#back').addEventListener('click', (e) => { e.preventDefault(); if (fromLocal) boot(); else showWelcome(); });
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Please wait…';
      try {
        if (signup) {
          const r = await Cloud.signUp(v.email, v.password);
          if (!r.session) {
            show(card(`${logo}<h1>Check your email</h1><p>We sent a link to <b>${esc(v.email)}</b>. Open it to confirm your account, then come back here and sign in.</p>
              <button class="btn primary lg block" id="ok">Sign in</button>`));
            $('#ok').addEventListener('click', () => showOwner('signin', { fromLocal }));
            return;
          }
        } else {
          await Cloud.signIn(v.email, v.password);
        }
        if (fromLocal && (await Cloud.whoami()).has_owner) {
          throw new Error("This cloud already has a business. To bring this computer's data: download a backup here (Settings → Backup & data), then restore it on an owner device that is connected.");
        }
        const d = await Cloud.registerOwnerDevice(v.email, deviceLabel());
        await connect({ ...d, label: deviceLabel() }, v.email);
      } catch (err) {
        setErr(err.message);
        btn.disabled = false; btn.textContent = signup ? 'Create account' : 'Sign in';
      }
    });
  }

  // A shop or warehouse computer joins with the owner's code.
  function showJoin() {
    show(card(`${logo}<h1>Connect this computer</h1>
      <p class="muted">Ask the owner for a code. On their Velanzo: <b>Settings → Devices → Add a computer</b>.</p>
      <form id="f" autocomplete="off">
        <label class="field">Code from the owner<input class="input code-input" name="code" placeholder="ABCD-1234" maxlength="9" required autofocus></label>
        <button class="btn primary lg block">Connect</button>${errBox()}
      </form>
      <div class="setup-links"><a href="#" id="back">Back</a></div>`));
    $('#back').addEventListener('click', (e) => { e.preventDefault(); showWelcome(); });
    $('#f [name=code]').addEventListener('input', (e) => {
      const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      e.target.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
    });
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        const d = await Cloud.joinWithCode(formValues(e.target).code, deviceLabel());
        await connect({ ...d, label: deviceLabel() });
      } catch (err) {
        setErr(err.message);
        btn.disabled = false; btn.textContent = 'Connect';
      }
    });
  }

  // Set this device up as cloud device number d.id, download everything, then start or log in.
  async function connect(d, email) {
    await Engine.system('setupCloud', { id: d.id, code: d.code, location_id: d.location_id, label: d.label });
    App.device = (await Engine.system('info')).device;
    show(card(`${logo}<h1>Getting your data…</h1><p class="muted" id="prog">Connecting</p><div class="progress"><div></div></div>`));
    Cloud.onProgress = (p) => { const el = $('#prog'); if (el) el.textContent = `${num(p.received)} records downloaded`; };
    const out = await Cloud.syncNow();
    Cloud.onProgress = null;
    if (!out) throw new Error(Cloud.status().problem?.text || 'Could not download the data. Check the internet and try again.');
    Cloud.start();
    const info = await Engine.system('info');
    if (!info.has_users && d.location_id == null) return showNewBusiness(email);
    showLogin();
  }

  // The owner's first device on an empty cloud: name the business and choose a PIN.
  function showNewBusiness(email) {
    show(card(`${logo}<h1>Your business</h1><p class="muted">A few details to start.</p>
      <form id="f" autocomplete="off">
        <label class="field">Business name<input class="input" name="business_name" placeholder="Velanzo Clothing" required></label>
        <label class="field">Your name<input class="input" name="owner_name" placeholder="Owner" required></label>
        ${pinFields()}
        <button class="btn primary lg block">Start</button>${errBox()}
      </form>`));
    $('#f').addEventListener('submit', (e) => submitBusiness(e, async (v) => {
      await Engine.system('startBusiness', { business_name: v.business_name, owner_name: v.owner_name, pin: v.pin, email });
      Cloud.changed();
      boot();
    }));
  }

  // ---------- Who's working? ----------
  async function showLogin() {
    App.user = null;
    let d;
    try { d = await GET('/api/login-users'); } catch (e) { return showError(e.message); }
    const place = d.location ? d.location.name : 'Owner device';
    const people = d.users;
    show(card(`${logo}<h1>${esc(d.business_name)}</h1><p class="muted">${esc(place)} · Who's working?</p>
      ${people.length ? `<div class="people">${people.map((u) => `<button class="person" data-id="${u.id}">
        <span class="avatar big${u.role === 'admin' ? ' owner' : ''}">${u.role === 'admin' ? icon('lock') : esc(u.name.slice(0, 1).toUpperCase())}</span>
        <span>${esc(u.name)}</span><small>${u.role === 'admin' ? 'Owner' : ''}</small></button>`).join('')}</div>`
        : '<div class="alert">Nobody can log in on this device yet. The owner adds people in <b>Settings → People</b>.</div>'}
      <div id="pinArea"></div>
      <div class="setup-links"><a href="manual/index.html" target="_blank" rel="noopener">How to use Velanzo</a></div>`, true));
    $$('.person').forEach((b) => b.addEventListener('click', () => {
      $$('.person').forEach((x) => x.classList.toggle('on', x === b));
      const u = people.find((x) => x.id === Number(b.dataset.id));
      pinPad(u, d.device);
    }));
    if (people.length === 1) $('.person').click();
    Cloud.syncNow(); // new people or PIN changes from the owner arrive here
  }

  function pinPad(u, device) {
    const area = $('#pinArea');
    if (!u.has_pin) {
      if (u.role === 'admin' && device.location_id == null) return setFirstPin(u);
      area.innerHTML = `<div class="alert">${esc(u.name)} has no PIN yet. The owner sets it in <b>Settings → People</b>.</div>`;
      return;
    }
    let pin = '';
    area.innerHTML = `<div class="pin-box"><div class="pin-label">${esc(u.name)}, type your PIN</div>
      <div class="pin-dots" id="dots"></div>
      <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
        <button data-k="del" aria-label="Delete">⌫</button><button data-k="0">0</button><button data-k="ok" class="ok" aria-label="OK">${icon('check')}</button></div>
      ${errBox('pinErr')}
      ${App.device.mode === 'cloud' && Cloud.enabled ? '<a href="#" class="forgot-pin" id="forgotPin">Forgot your PIN?</a>' : ''}</div>`;
    const fp = $('#forgotPin');
    if (fp) fp.addEventListener('click', (e) => { e.preventDefault(); document.removeEventListener('keydown', onKey); showForgotPin(u, device); });
    const dots = () => { $('#dots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<span class="${i < pin.length ? 'on' : ''}"></span>`).join(''); };
    const submit = async () => {
      if (pin.length < 4) return;
      try {
        await POST('/api/login', { user_id: u.id, pin });
        document.removeEventListener('keydown', onKey);
        boot();
      } catch (e) {
        pin = ''; dots(); setErr(e.message, 'pinErr');
        const box = $('.pin-box'); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
      }
    };
    const press = (k) => {
      setErr('', 'pinErr');
      if (k === 'del') pin = pin.slice(0, -1);
      else if (k === 'ok') return submit();
      else if (pin.length < 6) pin += k;
      dots();
    };
    const onKey = (e) => {
      if (!$('#dots')) return document.removeEventListener('keydown', onKey);
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
    };
    document.addEventListener('keydown', onKey);
    App.cleanups.push(() => document.removeEventListener('keydown', onKey));
    $$('.pin-pad button', area).forEach((b) => b.addEventListener('click', () => press(b.dataset.k)));
    dots();
  }

  // An owner without a PIN (e.g. right after restoring a backup from the old version) chooses one on their own device.
  function setFirstPin(u) {
    $('#pinArea').innerHTML = `<form id="fp" class="pin-box" autocomplete="off"><div class="pin-label">${esc(u.name)}, choose your PIN</div>${pinFields()}
      <button class="btn primary lg block">Save and open</button>${errBox('pinErr')}</form>`;
    $('#fp').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      if (!/^\d{4,6}$/.test(v.pin)) return setErr('The PIN must be 4 to 6 numbers.', 'pinErr');
      if (v.pin !== v.pin2) return setErr('The two PINs are not the same.', 'pinErr');
      try {
        await Engine.system('setFirstPin', { user_id: u.id, pin: v.pin });
        await POST('/api/login', { user_id: u.id, pin: v.pin });
        boot();
      } catch (err) { setErr(err.message, 'pinErr'); }
    });
  }

  // ---------- Email links ----------
  let emailConfirmed = false;
  const mask = (email) => String(email).replace(/^(.).*(@.*)$/, '$1***$2');
  const back = (label = 'Continue') => `<button class="btn primary lg block" id="cont">${label}</button>`;
  const goOn = () => { const b = $('#cont'); if (b) b.addEventListener('click', () => start()); };

  // The page was opened from a link in an email.
  async function showLink(link) {
    if (link.error) {
      show(card(`${logo}<h1>This link did not work</h1><p>${link.expired ? 'It has run out of time, or it was already used.' : 'Something went wrong with the link.'} Please ask for a new one.</p>${back()}`));
      return goOn();
    }
    if (link.type === 'recovery') return showNewPassword(link);
    if (link.type === 'magiclink') return showApprove(link);
    emailConfirmed = true; // the owner confirmed the email address
    show(card(`${logo}<h1>Email confirmed</h1><p>Thank you. Now sign in to finish setting up.</p>${back('Sign in')}`));
    goOn();
  }

  function showForgotPassword(fromLocal) {
    show(card(`${logo}<h1>Forgot your password?</h1><p class="muted">Type the email of your owner account. We will send you a link to choose a new password.</p>
      <form id="f"><label class="field">Email<input class="input" name="email" type="email" autocomplete="username" required></label>
        <button class="btn primary lg block">Send the link</button>${errBox()}</form>
      <div class="setup-links"><a href="#" id="back">Back</a></div>`));
    $('#back').addEventListener('click', (e) => { e.preventDefault(); showOwner('signin', { fromLocal }); });
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = formValues(e.target).email;
      const btn = e.target.querySelector('button');
      btn.disabled = true; btn.textContent = 'Please wait…';
      try {
        await Cloud.resetPassword(email);
        show(card(`${logo}<h1>Check your email</h1><p>If <b>${esc(email)}</b> is the owner's email, a link is on its way. Open it on this computer or your phone, then choose a new password. It can take a minute; look in Spam too.</p>
          <button class="btn primary lg block" id="ok">Back to sign in</button>`));
        $('#ok').addEventListener('click', () => showOwner('signin', { fromLocal }));
      } catch (err) { setErr(err.message); btn.disabled = false; btn.textContent = 'Send the link'; }
    });
  }

  function showNewPassword(link) {
    show(card(`${logo}<h1>Choose a new password</h1>
      <form id="f"><label class="field">New password<input class="input" name="p1" type="password" autocomplete="new-password" minlength="8" required><small class="muted">At least 8 characters.</small></label>
        <label class="field">New password again<input class="input" name="p2" type="password" autocomplete="new-password" minlength="8" required></label>
        <button class="btn primary lg block">Save the new password</button>${errBox()}</form>`));
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      if (v.p1 !== v.p2) return setErr('The two passwords are not the same.');
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await Cloud.linkSetPassword(link, v.p1);
        show(card(`${logo}<h1>Password changed</h1><p>Use your new password the next time you sign in as the owner. Computers that are already set up keep working.</p>${back()}`));
        goOn();
      } catch (err) { setErr(err.message); btn.disabled = false; }
    });
  }

  // The owner opened the link from a PIN request: who is waiting, approve or refuse.
  async function showApprove(link) {
    show(card(`${logo}<h1>PIN requests</h1><p class="muted" id="msg">Loading…</p><div id="list"></div>${errBox()}<div style="margin-top:14px">${back('Done')}</div>`));
    goOn();
    const draw = async () => {
      let list;
      try { list = await Cloud.linkPinRequests(link); } catch (err) { $('#msg').textContent = ''; return setErr(err.message.includes('owner') ? 'Only the owner can approve this.' : err.message); }
      $('#msg').textContent = list.length ? 'Someone forgot their PIN. Approve only if you know the person is asking.' : 'Nobody is waiting for approval now. The request may have run out of time (30 minutes) or was already decided.';
      $('#list').innerHTML = list.map((r) => `<div class="alert info flex"><div class="grow"><b>${esc(r.name)}</b> · ${esc(r.place)}<br><span class="muted small">asked ${r.minutes < 1 ? 'just now' : r.minutes + ' min ago'} on ${esc(r.device || 'a computer')}</span></div>
        <button class="btn primary" data-ok="${r.id}">Approve</button><button class="btn" data-no="${r.id}">Refuse</button></div>`).join('');
      $$('[data-ok], [data-no]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try { await Cloud.linkDecide(link, b.dataset.ok || b.dataset.no, !!b.dataset.ok); toast(b.dataset.ok ? 'Approved. They can choose a new PIN now.' : 'Refused.'); draw(); }
        catch (err) { setErr(err.message); b.disabled = false; }
      }));
    };
    draw();
  }

  // ---------- Forgot your PIN? ----------
  function showForgotPin(u, device) {
    if (u.role === 'admin' && device.location_id != null) {
      show(card(`${logo}<h1>Owner's PIN</h1><p>The owner's PIN can only be reset on the owner's own computer or phone. Ask the owner to do it there.</p><button class="btn primary lg block" id="cont">Back</button>`));
      return $('#cont').addEventListener('click', showLogin);
    }
    const who = u.role === 'admin' ? 'We will send a link to <b>your</b> email. Open it and press <b>Approve</b>.' : 'We will send a link to the <b>owner</b>\'s email. The owner opens it and presses <b>Approve</b>.';
    show(card(`${logo}<h1>Forgot your PIN?</h1>
      <p>${who} Then you choose a new PIN here.</p>
      <button class="btn primary lg block" id="send">Send the link</button>${errBox()}
      <div class="setup-links"><a href="#" id="back">Back</a></div>`));
    $('#back').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    $('#send').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true; btn.textContent = 'Please wait…';
      try { showWaiting(u, device, await Cloud.requestPinReset(u.id)); }
      catch (err) { setErr(err.message); btn.disabled = false; btn.textContent = 'Send the link'; }
    });
  }

  function showWaiting(u, device, r) {
    show(card(`${logo}<h1>Waiting for approval</h1>
      <p>A link was sent to <b>${esc(mask(r.email))}</b>. ${u.role === 'admin' ? 'Open it and press Approve.' : 'The owner must open it and press Approve.'} This screen continues by itself.</p>
      <p class="muted small">The link works for 30 minutes. Look in Spam if it does not arrive.</p>
      <div class="progress"><div></div></div>${errBox()}
      <div class="setup-links"><a href="#" id="again">Send the link again</a> · <a href="#" id="back">Cancel</a></div>`));
    const timer = setInterval(async () => {
      let st;
      try { st = await Cloud.checkPinReset(r.id); } catch { return; } // offline: keep waiting
      if (st === 'approved') { clearInterval(timer); showNewPin(u, r); }
      else if (st === 'refused' || st === 'expired' || st === 'unknown') {
        clearInterval(timer);
        show(card(`${logo}<h1>${st === 'refused' ? 'The owner said no' : 'This request ran out of time'}</h1><p>${st === 'refused' ? 'The PIN was not changed.' : 'Please ask again.'}</p><button class="btn primary lg block" id="cont">Back</button>`));
        $('#cont').addEventListener('click', showLogin);
      }
    }, 3000);
    App.cleanups.push(() => clearInterval(timer));
    $('#back').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    $('#again').addEventListener('click', (e) => { e.preventDefault(); showForgotPin(u, device); $('#send').click(); });
  }

  function showNewPin(u, r) {
    show(card(`${logo}<h1>Approved</h1><p>${esc(u.name)}, choose your new PIN.</p>
      <form id="f" autocomplete="off">${pinFields()}<button class="btn primary lg block">Save and open</button>${errBox()}</form>`));
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      if (!/^\d{4,6}$/.test(v.pin)) return setErr('The PIN must be 4 to 6 numbers.');
      if (v.pin !== v.pin2) return setErr('The two PINs are not the same.');
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      try {
        await Cloud.usePinReset(r.id);           // the approval works once
        await Engine.system('resetPin', { user_id: u.id, pin: v.pin });
        await POST('/api/login', { user_id: u.id, pin: v.pin });
        Cloud.changed();
        boot();
      } catch (err) { setErr(err.message); btn.disabled = false; }
    });
  }

  function showError(message, title = 'Something went wrong') {
    show(card(`${logo}<h1>${esc(title)}</h1><p>${esc(message)}</p><button class="btn primary lg block" onclick="location.reload()">Try again</button>`));
  }

  return { start, showLogin, showError, showJoin, showOwner, connect };
})();
