'use strict';
// First start on a device (owner sign-in, shop/warehouse code, or one device without the cloud)
// and the "Who's working?" screen with passcodes.
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
    // The computer stays signed in, but the passcode is asked every time Velanzo opens.
    if (info.user_id) await Engine.system('lock');
    showLogin();
  }

  // ---------- A new device ----------
  function showWelcome() {
    if (!Cloud.enabled) return showLocalStart();
    show(card(`${logo}<h1>Welcome to Velanzo</h1><p class="muted">How will this device be used?</p>
      <button class="choice" id="cShop">${icon('inbox')}<span><b>I work at a shop or the warehouse</b><small>Sign in with my user ID and password</small></span></button>
      <button class="choice" id="cOwner">${icon('users')}<span><b>I'm the owner</b><small>Sign in, or start a new business</small></span></button>`));
    $('#cShop').addEventListener('click', showSignIn);
    $('#cOwner').addEventListener('click', () => showOwner('signin'));
  }

  // Not connected to the cloud: one device keeps everything (it can join the cloud later).
  function showLocalStart() {
    show(card(`${logo}<h1>Start Velanzo</h1><p class="muted">Velanzo will keep its data on this device.</p>
      <form id="f" autocomplete="off">
        <label class="field">Business name<input class="input" name="business_name" placeholder="Velanzo Clothing" required></label>
        <label class="field">Your name<input class="input" name="owner_name" placeholder="Owner" required></label>
        ${pinSetupHtml()}
        <button class="btn primary lg block">Start</button>${errBox()}
      </form>`));
    bindPinSetup($('#f'));
    $('#f').addEventListener('submit', (e) => submitBusiness(e, async (v) => {
      await Engine.system('setupLocal', { business_name: v.business_name, owner_name: v.owner_name, pin: v.pin });
      App.device = (await Engine.system('info')).device;
      boot();
    }));
  }

  async function submitBusiness(e, fn) {
    e.preventDefault();
    const v = formValues(e.target);
    if (!/^\d{4}$/.test(v.pin)) return setErr('The passcode must be 4 numbers.');
    if (v.pin !== v.pin2) return setErr('The two passcodes are not the same.');
    const btn = e.target.querySelector('button.primary');
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
      const btn = e.target.querySelector('button.primary');
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

  // A shop or warehouse person signs in with the user ID and password the owner made for them.
  function showSignIn() {
    show(card(`${logo}<h1>Sign in</h1><p class="muted">Type the user ID and password the owner gave you.</p>
      <form id="f" autocomplete="on">
        <label class="field">User ID<input class="input" name="login" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
        <label class="field">Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary lg block">Sign in</button>${errBox()}
      </form>
      <div class="setup-links"><a href="#" id="back">Back</a></div>`));
    $('#back').addEventListener('click', (e) => { e.preventDefault(); showWelcome(); });
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      const btn = e.target.querySelector('button.primary');
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        const d = await Cloud.loginWithId(v.login, v.password, deviceLabel());
        await connect({ ...d, label: deviceLabel() });
      } catch (err) {
        setErr(err.message);
        btn.disabled = false; btn.textContent = 'Sign in';
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
    // this computer now belongs to the person who signed in on it
    if (d.user_id) await Engine.system('bindUser', d.user_id);
    else if (email) await Engine.system('bindOwner', email);
    const info = await Engine.system('info');
    if (!info.has_users && d.location_id == null) return showNewBusiness(email);
    showLogin();
  }

  // The owner's first device on an empty cloud: name the business and choose a passcode.
  function showNewBusiness(email) {
    show(card(`${logo}<h1>Your business</h1><p class="muted">A few details to start.</p>
      <form id="f" autocomplete="off">
        <label class="field">Business name<input class="input" name="business_name" placeholder="Velanzo Clothing" required></label>
        <label class="field">Your name<input class="input" name="owner_name" placeholder="Owner" required></label>
        ${pinSetupHtml()}
        <button class="btn primary lg block">Start</button>${errBox()}
      </form>`));
    bindPinSetup($('#f'));
    $('#f').addEventListener('submit', (e) => submitBusiness(e, async (v) => {
      await Engine.system('startBusiness', { business_name: v.business_name, owner_name: v.owner_name, pin: v.pin, email });
      await Engine.system('bindOwner', email);
      Cloud.changed();
      boot();
    }));
  }

  // ---------- The passcode screen ----------
  // Shown every time Velanzo opens (the computer stays signed in, but locked). It belongs to one person.
  async function showLogin() {
    App.user = null;
    let d;
    try { d = await GET('/api/login-users'); } catch (e) { return showError(e.message); }
    const place = d.location ? d.location.name : 'Owner device';
    const people = d.users;
    const cloud = App.device.mode === 'cloud' && Cloud.enabled;
    show(card(`${logo}<h1>${esc(d.business_name)}</h1><p class="muted">${esc(place)}${d.bound ? '' : ' · Who\'s working?'}</p>
      ${people.length ? `<div class="people${d.bound ? ' hidden' : ''}">${people.map((u) => `<button class="person" data-id="${u.id}">
        <span class="avatar big${u.role === 'admin' ? ' owner' : ''}">${u.role === 'admin' ? icon('lock') : esc(u.name.slice(0, 1).toUpperCase())}</span>
        <span>${esc(u.name)}</span><small>${u.role === 'admin' ? 'Owner' : ''}</small></button>`).join('')}</div>`
        : '<div class="alert">Nobody can log in on this device yet. The owner adds users in <b>Settings → Users</b>.</div>'}
      <div id="pinArea"></div>
      <div class="setup-links">${cloud ? '<a href="#" id="swAcc">Switch account</a> · <a href="#" id="soBtn">Sign out</a> · ' : ''}<a href="manual/index.html" target="_blank" rel="noopener">How to use Velanzo</a></div>`, true));
    $$('.person').forEach((b) => b.addEventListener('click', () => {
      $$('.person').forEach((x) => x.classList.toggle('on', x === b));
      const u = people.find((x) => x.id === Number(b.dataset.id));
      pinPad(u, d.device, d.bound);
    }));
    if (people.length === 1) $('.person').click();
    const sw = $('#swAcc'), so = $('#soBtn');
    if (sw) sw.addEventListener('click', (e) => { e.preventDefault(); signOut(true); });
    if (so) so.addEventListener('click', (e) => { e.preventDefault(); signOut(false); });
    Cloud.syncNow(); // new people or passcode changes arrive here
  }

  // The digit pad (also for touch screens). The passcode is exactly 4 numbers and opens by itself at the 4th.
  const padHtml = () => `<div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join('')}
    <button type="button" data-k="del" aria-label="Delete">⌫</button><button type="button" data-k="0">0</button><button type="button" data-k="ok" class="ok" aria-label="OK">${icon('check')}</button></div>`;
  const dotsHtml = (n) => Array.from({ length: 4 }, (_, i) => `<span class="${i < n ? 'on' : ''}"></span>`).join('');

  function pinPad(u, device, bound) {
    const area = $('#pinArea');
    if (!u.has_pin) {
      // Just signed in (or the owner on the owner's own computer): choose a passcode now.
      if (bound || (u.role === 'admin' && device.location_id == null)) return setFirstPin(u);
      area.innerHTML = `<div class="alert">${esc(u.name)} has not chosen a passcode yet. They do it when they first sign in.</div>`;
      return;
    }
    let pin = '';
    area.innerHTML = `<div class="pin-box"><div class="pin-label">${esc(u.name)}, type your passcode</div>
      <div class="pin-dots" id="dots"></div>${padHtml()}${errBox('pinErr')}
      ${App.device.mode === 'cloud' && Cloud.enabled ? '<a href="#" class="forgot-pin" id="forgotPin">Forgot your passcode?</a>' : ''}</div>`;
    const fp = $('#forgotPin');
    if (fp) fp.addEventListener('click', (e) => { e.preventDefault(); document.removeEventListener('keydown', onKey); showForgotPin(u, device); });
    const dots = () => { $('#dots').innerHTML = dotsHtml(pin.length); };
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
      else if (pin.length < 4) pin += k;
      dots();
      if (pin.length === 4 && k !== 'del') submit();
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

  // Choosing a passcode: type 4 numbers on the pad, then once more. Fills the hidden fields pin and pin2 and
  // switches on the form's main button. (Works with the keyboard too.)
  function pinSetupHtml(label = 'Choose a 4-digit passcode') {
    return `<div class="pin-setup" id="pinSetup"><div class="pin-label" id="psLabel">${esc(label)}</div><div class="pin-dots" id="psDots">${dotsHtml(0)}</div>${padHtml()}
      <input type="hidden" name="pin"><input type="hidden" name="pin2">
      <p class="muted small" id="psHint">You type it every time Velanzo opens, like a phone.</p></div>`;
  }
  function bindPinSetup(form, label = 'Choose a 4-digit passcode') {
    const root = $('#pinSetup', form);
    const main = form.querySelector('button.primary');
    if (main) main.disabled = true;
    let first = '', cur = '';
    const paint = () => { $('#psDots', root).innerHTML = dotsHtml(cur.length); };
    const say = (t, bad) => { const h = $('#psHint', root); h.textContent = t; h.classList.toggle('neg', !!bad); };
    const done = () => {
      if (!first) { first = cur; cur = ''; $('#psLabel', root).textContent = 'Type it again to be sure'; say(''); return paint(); }
      if (cur !== first) {
        first = ''; cur = ''; $('#psLabel', root).textContent = label; say('The two were not the same. Start again.', true);
        const box = root; box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
        return paint();
      }
      form.querySelector('[name=pin]').value = first; form.querySelector('[name=pin2]').value = cur;
      $('#psLabel', root).textContent = '✓ Passcode chosen'; say('Now press the button below.');
      if (main) { main.disabled = false; main.focus(); }
      document.removeEventListener('keydown', onKey);
    };
    const press = (k) => {
      if (form.querySelector('[name=pin]').value) return; // already chosen
      if (k === 'del') cur = cur.slice(0, -1);
      else if (k === 'ok') return;
      else if (cur.length < 4) cur += k;
      paint();
      if (cur.length === 4 && k !== 'del') done();
    };
    const onKey = (e) => {
      if (!document.body.contains(root)) return document.removeEventListener('keydown', onKey);
      if (/^\d$/.test(e.key) && !/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) press(e.key);
      else if (e.key === 'Backspace' && !/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) press('del');
    };
    document.addEventListener('keydown', onKey);
    App.cleanups.push(() => document.removeEventListener('keydown', onKey));
    $$('.pin-pad button', root).forEach((b) => b.addEventListener('click', () => press(b.dataset.k)));
  }

  // The first time (right after signing in): the person chooses their own passcode.
  function setFirstPin(u) {
    $('#pinArea').innerHTML = `<form id="fp" class="pin-box" autocomplete="off"><div class="pin-label">Welcome, ${esc(u.name)}</div>${pinSetupHtml()}
      <button class="btn primary lg block">Save and open</button>${errBox('pinErr')}</form>`;
    bindPinSetup($('#fp'));
    $('#fp').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      if (!/^\d{4}$/.test(v.pin)) return setErr('The passcode must be 4 numbers.', 'pinErr');
      if (v.pin !== v.pin2) return setErr('The two passcodes are not the same.', 'pinErr');
      try {
        await Engine.system('setFirstPin', { user_id: u.id, pin: v.pin });
        await POST('/api/login', { user_id: u.id, pin: v.pin });
        Cloud.changed();
        boot();
      } catch (err) { setErr(err.message, 'pinErr'); }
    });
  }

  // Sign out of this computer (or switch to another account). Everything saved online stays; what is on this computer is
  // removed, so it first makes sure nothing is waiting to be sent.
  async function signOut(toSignIn) {
    if (typeof Practice !== 'undefined' && Practice.on) return toast('Finish practising first (the orange bar at the top).', 'error', 6000);
    let waiting = (await Engine.system('outbox', 1)).length;
    if (waiting && App.user) { try { await Cloud.syncNow(); } catch { /* offline */ } waiting = (await Engine.system('outbox', 1)).length; }
    if (waiting) return toast('Some changes have not reached the cloud yet. Unlock, connect to the internet, wait until "All saved online" shows, then sign out.', 'error', 9000);
    const ok = await confirmBox(toSignIn
      ? 'Switch account?\n\nThis computer will forget the current account, and another person can sign in. Everything is safe in the cloud.'
      : 'Sign out of this computer?\n\nEverything is safe in the cloud. To use Velanzo here again, sign in with your user ID and password.',
    { title: toSignIn ? 'Switch account' : 'Sign out', ok: toSignIn ? 'Switch account' : 'Sign out' });
    if (!ok) return;
    try { if (App.device.id && Cloud.enabled && App.device.mode === 'cloud') await Cloud.releaseDevice(App.device.id); } catch { /* the cloud is not reachable: fine */ }
    try { Cloud.stop(); await Cloud.signOut(); } catch { /* ignore */ }
    try { await Engine.system('forgetDevice', {}); } catch (e) { return toast(e.message, 'error', 8000); }
    App.device = {}; App.user = null; App.settings = {}; App.locations = [];
    toSignIn ? showSignIn() : showWelcome();
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
      const btn = e.target.querySelector('button.primary');
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
      const btn = e.target.querySelector('button.primary');
      btn.disabled = true;
      try {
        await Cloud.linkSetPassword(link, v.p1);
        show(card(`${logo}<h1>Password changed</h1><p>Use your new password the next time you sign in as the owner. Computers that are already set up keep working.</p>${back()}`));
        goOn();
      } catch (err) { setErr(err.message); btn.disabled = false; }
    });
  }

  // The owner opened the link from a passcode request: who is waiting, approve or refuse.
  async function showApprove(link) {
    show(card(`${logo}<h1>passcode requests</h1><p class="muted" id="msg">Loading…</p><div id="list"></div>${errBox()}<div style="margin-top:14px">${back('Done')}</div>`));
    goOn();
    const draw = async () => {
      let list;
      try { list = await Cloud.linkPinRequests(link); } catch (err) { $('#msg').textContent = ''; return setErr(err.message.includes('owner') ? 'Only the owner can approve this.' : err.message); }
      $('#msg').textContent = list.length ? 'Someone forgot their passcode. Approve only if you know the person is asking.' : 'Nobody is waiting for approval now. The request may have run out of time (30 minutes) or was already decided.';
      $('#list').innerHTML = list.map((r) => `<div class="alert info flex"><div class="grow"><b>${esc(r.name)}</b> · ${esc(r.place)}<br><span class="muted small">asked ${r.minutes < 1 ? 'just now' : r.minutes + ' min ago'} on ${esc(r.device || 'a computer')}</span></div>
        <button class="btn primary" data-ok="${r.id}">Approve</button><button class="btn" data-no="${r.id}">Refuse</button></div>`).join('');
      $$('[data-ok], [data-no]').forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try { await Cloud.linkDecide(link, b.dataset.ok || b.dataset.no, !!b.dataset.ok); toast(b.dataset.ok ? 'Approved. They can choose a new passcode now.' : 'Refused.'); draw(); }
        catch (err) { setErr(err.message); b.disabled = false; }
      }));
    };
    draw();
  }

  // ---------- Forgot your passcode? ----------
  function showForgotPin(u, device) {
    if (u.role === 'admin' && device.location_id != null) {
      show(card(`${logo}<h1>Owner's passcode</h1><p>The owner's passcode can only be reset on the owner's own computer or phone. Ask the owner to do it there.</p><button class="btn primary lg block" id="cont">Back</button>`));
      return $('#cont').addEventListener('click', showLogin);
    }
    const who = u.role === 'admin' ? 'We will send a link to <b>your</b> email. Open it and press <b>Approve</b>.' : 'We will send a link to the <b>owner</b>\'s email. The owner opens it and presses <b>Approve</b>.';
    show(card(`${logo}<h1>Forgot your passcode?</h1>
      <p>${who} Then you choose a new passcode here.</p>
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
        show(card(`${logo}<h1>${st === 'refused' ? 'The owner said no' : 'This request ran out of time'}</h1><p>${st === 'refused' ? 'The passcode was not changed.' : 'Please ask again.'}</p><button class="btn primary lg block" id="cont">Back</button>`));
        $('#cont').addEventListener('click', showLogin);
      }
    }, 3000);
    App.cleanups.push(() => clearInterval(timer));
    $('#back').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    $('#again').addEventListener('click', (e) => { e.preventDefault(); showForgotPin(u, device); $('#send').click(); });
  }

  function showNewPin(u, r) {
    show(card(`${logo}<h1>Approved</h1><p>${esc(u.name)}, choose your new passcode.</p>
      <form id="f" autocomplete="off">${pinSetupHtml()}<button class="btn primary lg block">Save and open</button>${errBox()}</form>`));
    bindPinSetup($('#f'));
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = formValues(e.target);
      if (!/^\d{4}$/.test(v.pin)) return setErr('The passcode must be 4 numbers.');
      if (v.pin !== v.pin2) return setErr('The two passcodes are not the same.');
      const btn = e.target.querySelector('button.primary');
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

  return { start, showLogin, showError, showSignIn, showOwner, connect, signOut };
})();
