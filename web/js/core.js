'use strict';
// Shared helpers: talking to the engine, formatting, pop-ups, menu/router, and the scan/search box.
const App = { user: null, settings: {}, locations: [], badges: {}, cleanups: [], device: {} };

// ---------- Small helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const money = (n) => `${App.settings.currency || 'Rs'} ${num(n)}`;
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => ymd(new Date());
const nowStr = () => { const d = new Date(); return `${ymd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = (s) => { if (!s) return ''; const [y, m, d] = s.slice(0, 10).split('-'); return `${+d} ${MONTHS[+m - 1]} ${y}`; };
const fmtTime = (s) => { if (!s || s.length < 16) return ''; let h = +s.slice(11, 13); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; return `${h}:${s.slice(14, 16)} ${ap}`; };
const fmtDT = (s) => (s ? `${fmtDate(s)}, ${fmtTime(s)}` : '');
const variantText = (p) => [p.size, p.color].filter(Boolean).join(' / ');
const pname = (p) => p.name + (variantText(p) ? ` — ${variantText(p)}` : '');
const locById = (id) => App.locations.find((l) => l.id === Number(id));
const locName = (id) => locById(id)?.name || '';
const shops = () => App.locations.filter((l) => l.type === 'shop' && l.active);
const warehouses = () => App.locations.filter((l) => l.type === 'warehouse' && l.active);
// The owner on an owner device sees every place and may do everything; everyone else has their place's switches.
const isAdmin = () => !!App.user?.owner;
const can = (perm) => !!App.user && (App.user.owner || App.user.perms.includes(perm));
const canSeeCost = () => can('see_cost') || can('buy');
const myPlace = () => (App.user?.owner ? null : locById(App.user?.location_id));
const METHOD_NAMES = { cash: 'Cash', card: 'Card', online: 'Online' };
const qtyClass = (q) => (q < 0 ? 'negq' : q === 0 ? 'zero' : q <= Number(App.settings.low_stock || 2) ? 'lowq' : '');
const options = (list, selected, { blank } = {}) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
  list.map((o) => {
    const [v, t] = Array.isArray(o) ? o : typeof o === 'object' ? [o.id, o.name] : [o, o];
    return `<option value="${esc(v)}"${String(v) === String(selected ?? '') ? ' selected' : ''}>${esc(t)}</option>`;
  }).join('');

// ---------- Talking to the engine (it runs on this device; see worker.js) ----------
async function api(method, url, body) {
  const u = new URL(url, 'http://local');
  const req = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: typeof body === 'string' ? JSON.parse(body) : (body || {}) };
  let res;
  try { res = await Engine.api(req); } catch (e) { throw new Error('Could not read the data on this device: ' + e.message); }
  if (res.status === 401 && u.pathname !== '/api/login') {
    App.user = null; Setup.showLogin();
    const e = new Error('Please log in again'); e.status = 401; throw e;
  }
  if (res.status !== 200) { const e = new Error(res.body?.error || `Error ${res.status}`); e.status = res.status; e.data = res.body; throw e; }
  if (method !== 'GET') Cloud.changed(); // send it to the cloud soon
  return res.body;
}
const qs = (q) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(q || {})) if (v !== '' && v != null) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
const GET = (url, q) => api('GET', url + qs(q));
const POST = (url, body) => api('POST', url, body ?? {});
const PUT = (url, body) => api('PUT', url, body ?? {});
const DEL = (url) => api('DELETE', url);

// Disables a button while working, shows any error as a message.
async function busy(btn, fn) {
  const old = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Please wait…'; }
  try { return await fn(); }
  catch (e) { toast(e.message, 'error', 6000); return undefined; }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = old; } }
}

// ---------- Messages & pop-ups ----------
function toast(msg, type = 'ok', ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function modal({ title, body, footer = '', size = '', onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${size}" role="dialog"><div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close title="Close">✕</button></div>
    <div class="modal-body">${body}</div>${footer ? `<div class="modal-foot">${footer}</div>` : ''}</div>`;
  document.body.appendChild(wrap);
  const onKey = (e) => { if (e.key === 'Escape' && document.body.lastElementChild === wrap) { e.stopPropagation(); e.preventDefault(); close(); } };
  function close() { if (!wrap.isConnected) return; wrap.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); }
  document.addEventListener('keydown', onKey, true);
  $$('[data-close]', wrap).forEach((b) => b.addEventListener('click', close));
  setTimeout(() => { const f = wrap.querySelector('[autofocus]') || wrap.querySelector('.modal-body input:not([type=hidden]):not([type=checkbox]), .modal-body select, .modal-body textarea'); f && f.focus(); }, 30);
  return { el: wrap, close, $: (s) => wrap.querySelector(s), $$: (s) => $$(s, wrap) };
}

function confirmBox(message, { title = 'Please confirm', ok = 'Yes', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title,
      body: `<div style="white-space:pre-line">${esc(message)}</div>`,
      footer: `<button class="btn" data-close>No</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="cOk">${esc(ok)}</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    const okBtn = m.$('#cOk');
    okBtn.focus();
    okBtn.addEventListener('click', () => { answered = true; m.close(); resolve(true); });
  });
}

// The steps of a purchase order or a parcel, like a status bar: done steps ticked, the current one in colour.
function flowBar(steps, current, { cancelled = false } = {}) {
  const at = steps.indexOf(current);
  return `<div class="flow" aria-label="Steps">${steps.map((st, k) => `${k ? '<i>›</i>' : ''}<span class="${cancelled ? '' : k < at ? 'done' : k === at ? 'on' : ''}">${k < at && !cancelled ? '✓ ' : ''}${esc(st)}</span>`).join('')}${cancelled ? '<i>›</i><span class="on bad">Cancelled</span>' : ''}</div>`;
}

// Held bills: bills parked at the sale screen of this computer, to finish later.
const HeldBills = {
  key: () => `vz_held_${App.device?.id || 0}`,
  all() { try { return JSON.parse(localStorage.getItem(this.key()) || '[]'); } catch { return []; } },
  save(list) { try { localStorage.setItem(this.key(), JSON.stringify(list)); } catch { /* storage off */ } },
  add(loc, cart) { const h = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), at: nowStr(), loc, cart }; this.save([...this.all(), h]); return h; },
  take(id) { const list = this.all(); this.save(list.filter((x) => x.id !== id)); return list.find((x) => x.id === id); },
  total: (cart) => cart.items.reduce((a, l) => a + (l.ret ? -l.qty : l.qty) * l.price, 0),
};

// Before saving: asks the engine what looks unusual (a price of Rs 0, selling below cost, a big discount …).
// If anything does, shows it with "Go back" or "Continue anyway". Resolves true to go ahead.
// (Nothing is blocked: the owner sees these afterwards in Reports → Things to check.)
async function looksRight(kind, body) {
  let warnings = [];
  try { ({ warnings } = await POST('/api/check/' + kind, body)); } catch { return true; } // a check that fails never stops work
  if (!warnings.length) return true;
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title: warnings.length === 1 ? 'Please check this' : `Please check these ${warnings.length} things`,
      body: `<div class="warn-box"><div class="warn-icon">!</div><ul class="warn-list">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
        <p class="muted small" style="margin:14px 0 0">If it is right, continue. The owner can see it later in Reports.</p>`,
      footer: `<button class="btn" id="wGo">Continue anyway</button><button class="btn primary" id="wBack">Go back and fix</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    const answer = (v) => { answered = true; m.close(); resolve(v); };
    m.$('#wBack').addEventListener('click', () => answer(false));
    m.$('#wGo').addEventListener('click', () => answer(true));
    setTimeout(() => m.$('#wBack')?.focus(), 40); // Enter (or a barcode scan) means "go back", never "continue"
  });
}

function promptBox(message, { title = 'Please enter', ok = 'OK', value = '', placeholder = '', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const m = modal({
      title,
      body: `<label class="field">${esc(message)}<input class="input" id="pIn" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>`,
      footer: `<button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger solid' : 'primary'}" id="pOk">${esc(ok)}</button>`,
      onClose: () => { if (!answered) resolve(null); },
    });
    const done = () => { answered = true; const v = m.$('#pIn').value; m.close(); resolve(v); };
    m.$('#pOk').addEventListener('click', done);
    m.$('#pIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
  });
}

function formValues(root) {
  const out = {};
  for (const el of $$('[name]', root)) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value.trim();
  }
  return out;
}

// Short beep for scanner feedback (good = high, problem = low)
let audioCtx;
function beep(good = true) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = good ? 1400 : 240;
    o.type = good ? 'sine' : 'square';
    g.gain.value = good ? 0.08 : 0.06;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + (good ? 0.07 : 0.3));
  } catch { /* no sound available */ }
}

// Files (Excel exports, backups) are made by the engine and saved from here.
async function download(url) {
  const out = await GET(url);
  saveFile(out.__file);
}
function saveFile({ name, type, content }) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function downloadText(filename, text, type = 'text/csv') {
  const blob = new Blob(['﻿' + text], { type: type + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Reads CSV text (as saved by Excel / Google Sheets) into rows of objects using the header row.
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsText(file);
  });
}

// ---------- Date range bar (Today / Yesterday / 7 days / This month / Last month) ----------
function rangePresets() {
  const t = todayStr();
  const ms = t.slice(0, 8) + '01';
  const lmEnd = addDays(ms, -1);
  return {
    today: ['Today', t, t],
    yesterday: ['Yesterday', addDays(t, -1), addDays(t, -1)],
    week: ['Last 7 days', addDays(t, -6), t],
    month: ['This month', ms, t],
    last_month: ['Last month', lmEnd.slice(0, 8) + '01', lmEnd],
    days90: ['Last 3 months', addDays(t, -89), t],
    year: ['This year', t.slice(0, 4) + '-01-01', t],
  };
}
// long: also "Last 3 months" and "This year" (for reports)
function rangeBarHtml(state, { long = false } = {}) {
  const pre = rangePresets();
  if (!long) { delete pre.days90; delete pre.year; }
  return `<div class="seg range-presets">${Object.entries(pre).map(([k, [label, f, t]]) =>
    `<button type="button" data-preset="${k}" class="${state.from === f && state.to === t ? 'on' : ''}">${label}</button>`).join('')}</div>
    <input type="date" class="input" data-range="from" value="${esc(state.from)}" title="From">
    <span class="muted">to</span>
    <input type="date" class="input" data-range="to" value="${esc(state.to)}" title="To">`;
}
function bindRangeBar(root, state, onChange) {
  const pre = rangePresets();
  $$('[data-preset]', root).forEach((b) => b.addEventListener('click', () => {
    const [, f, t] = pre[b.dataset.preset];
    state.from = f; state.to = t; onChange();
  }));
  $$('[data-range]', root).forEach((inp) => inp.addEventListener('change', () => {
    state[inp.dataset.range] = inp.value;
    if (state.from && state.to && state.from > state.to) state[inp.dataset.range === 'from' ? 'to' : 'from'] = inp.value;
    onChange();
  }));
}

// ---------- Icons ----------
const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  cart: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  bag: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  truck: '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  wallet: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  barcode: '<path d="M3 5v14M7 5v14M11 5v14M14 5v14M18 5v14M21 5v14"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  device: '<rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

// ---------- Menu ----------
// Each person only sees what their place's switches (and their own) allow.
const NAV = [
  { href: 'dashboard', label: 'Home', icon: 'home', show: () => isAdmin() },
  { href: 'home', label: 'Home', icon: 'home', show: () => !isAdmin() && !can('sell') },
  { href: 'purchases', label: 'Purchase', icon: 'bag', show: () => can('buy') },
  { href: 'dispatch', label: 'Dispatch order', icon: 'truck', show: () => can('send'), badge: 'incoming' },
  { href: 'dispatch', label: 'Receive stock', icon: 'inbox', show: () => can('receive') && !can('send'), badge: 'incoming' },
  { href: 'pos', label: 'Sale order', icon: 'cart', show: () => can('sell') },
  { href: 'sales', label: 'Bills', icon: 'file', show: () => can('sell') || isAdmin() },
  { href: 'labels', label: 'Labels', icon: 'printer', show: () => can('add_items') || can('buy') },
  { href: 'products', label: 'Items', icon: 'tag', show: () => can('add_items') || can('buy') },
  { href: 'stock', label: 'Stock', icon: 'box', show: () => true },
  { href: 'expenses', label: 'Expenses', icon: 'wallet', show: () => can('expenses') },
  { href: 'suppliers', label: 'Suppliers', icon: 'users', show: () => can('buy') },
  { href: 'reports', label: 'Reports', icon: 'chart', show: () => isAdmin() || (can('reports') && can('see_cost')) },
  { href: 'activity', label: 'Activity', icon: 'activity', show: () => isAdmin() },
  { href: 'settings', label: 'Settings', icon: 'sliders', show: () => isAdmin() },
  { href: 'training', label: 'Training', icon: 'help', show: () => true },
];
// When there are many, these stay on the bar and the rest go under "More".
// The first six stay on the bar (a seventh too on a wide screen); the rest go under "More".
const MAIN_TABS = { owner: ['dashboard', 'purchases', 'dispatch', 'pos', 'sales', 'stock', 'reports'], staff: ['home', 'purchases', 'dispatch', 'pos', 'sales', 'labels', 'stock'] };
const homeFor = () => (isAdmin() ? 'dashboard' : can('sell') ? 'pos' : 'home');

function navHtml() {
  const visible = NAV.filter((n) => n.show());
  const base = visible.filter((n) => n.href !== 'training'); // Training always lives under More
  const mainList = MAIN_TABS[isAdmin() ? 'owner' : 'staff'];
  const wide = base.length <= 6 ? base : base.filter((n) => mainList.includes(n.href)).slice(0, 7);
  const main = wide.slice(0, 6);
  const extra = wide.slice(6); // shown on the bar only on a wide screen, under More on a narrow one
  const more = visible.filter((n) => !wide.includes(n));
  const link = (n, cls = '') => `<a href="#/${n.href}" data-nav="${n.href}"${cls ? ` class="${cls}"` : ''}>${icon(n.icon)}<span>${esc(n.label)}</span>${n.badge ? `<span class="badge hidden" data-badge="${n.badge}"></span>` : ''}</a>`;
  const inMore = [...extra.map((n) => link(n, 'narrow-only')), ...more.map((n) => link(n))];
  return main.map((n) => link(n)).join('') + extra.map((n) => link(n, 'wide-only')).join('') + (inMore.length ? `<details class="more" id="moreMenu"><summary>${icon('menu')}<span>More</span></summary>
    <div class="more-list">${inMore.join('')}</div></details>` : '');
}

function renderShell() {
  const u = App.user;
  const place = isAdmin() ? 'All shops' : locName(u.location_id);
  $('#app').innerHTML = `
  <div class="shell" id="shell">
    <header class="appbar"><div class="appbar-in">
      <a class="brand" href="#/${homeFor()}"><span class="logo">V</span><span class="brand-text"><b>${esc(App.settings.business_name)}</b><small>${esc(place)}</small></span></a>
      <nav class="tabnav" id="nav">${navHtml()}</nav>
      <div class="appbar-right">
        <button class="sync-pill" id="syncPill" type="button"></button>
        <details class="user-menu" id="userMenu"><summary><span class="avatar">${esc((u.name || '?').slice(0, 1).toUpperCase())}</span><span class="uname">${esc(u.name)}</span></summary>
          <div class="more-list right">
            <a href="#" id="switchBtn">${icon('lock')}<span>Lock (type the passcode again)</span></a>
            ${App.device.mode === 'cloud' ? `<a href="#" id="signOutBtn">${icon('device')}<span>Sign out / switch account</span></a>` : ''}
            <a href="#/account">${icon('lock')}<span>My passcode</span></a>
            <a href="#/device">${icon('device')}<span>This device</span></a>
            ${AppInstall.installed() ? '' : `<a href="#" id="getAppBtn">${icon('download')}<span>Get the app (PC, Android, iPhone)</span></a>`}
            <a href="#/training">${icon('help')}<span>Training</span></a>
            <a href="manual/index.html" target="_blank" rel="noopener">${icon('file')}<span>Written guide</span></a>
          </div></details>
      </div>
    </div></header>
    <main class="main">
      <div class="page-head"><h1 id="pageTitle"></h1><div class="actions" id="pageActions"></div></div>
      <div class="view" id="view"></div>
    </main>
  </div>`;
  const so = $('#signOutBtn');
  if (so) so.addEventListener('click', (e) => { e.preventDefault(); closeMenus(); Setup.signOut(true); });
  $('#switchBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await POST('/api/logout'); } catch { /* ignore */ }
    App.user = null; location.hash = ''; Setup.showLogin();
  });
  $('#syncPill').addEventListener('click', () => go('device'));
  const ga = $('#getAppBtn');
  if (ga) ga.addEventListener('click', (e) => { e.preventDefault(); closeMenus(); AppInstall.open(); });
  // menus close when something is picked or when clicking elsewhere
  document.addEventListener('click', closeMenus);
  paintSync();
}
function closeMenus(e) {
  for (const d of $$('details.more, details.user-menu')) if (d.open && (!e || !d.contains(e.target) || e.target.closest('a'))) d.open = false;
}

async function refreshBadges() {
  try {
    App.badges = await GET('/api/badges');
    $$('[data-badge]').forEach((b) => {
      const n = App.badges[b.dataset.badge] || 0;
      b.textContent = n; b.classList.toggle('hidden', !n);
    });
    paintSync();
  } catch { /* ignore */ }
}

// The small status at the top: is everything saved to the cloud?
function paintSync() {
  const pill = $('#syncPill');
  if (!pill) return;
  const s = Cloud.status(), b = App.badges || {};
  let cls = '', text = '', title = '';
  if (App.practice) { cls = 'warn'; text = 'Practice mode'; title = 'You are practising. Nothing is saved or sent anywhere.'; }
  else if (!Cloud.enabled || App.device.mode !== 'cloud') { cls = 'local'; text = 'On this device'; title = 'Not connected to the cloud. Data is kept on this device only.'; }
  else if (s.problem) { cls = 'bad'; text = s.problem.short; title = s.problem.text; }
  else if (b.errors) { cls = 'bad'; text = `${b.errors} not saved`; title = 'Some changes were refused by the cloud. Tap to see them.'; }
  else if (s.syncing) { cls = 'busy'; text = 'Saving…'; }
  else if (!s.online) { cls = 'warn'; text = b.waiting ? `No internet · ${b.waiting} waiting` : 'No internet'; title = 'Keep working. Everything is saved on this device and sent when the internet is back.'; }
  else if (b.waiting) { cls = 'busy'; text = `${b.waiting} waiting`; }
  else { cls = 'ok'; text = 'All saved online'; title = s.lastSync ? `Last saved ${fmtTime(s.lastSync)}` : ''; }
  pill.className = 'sync-pill ' + cls;
  pill.textContent = text;
  pill.title = title;
}

// ---------- Router ----------
const Views = [];
function View(pattern, def) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  Views.push({ pattern, re, keys, literal: !keys.length, ...def });
  Views.sort((a, b) => Number(b.literal) - Number(a.literal));
}
const go = (path) => { location.hash = '#/' + path; };
function onCleanup(fn) { App.cleanups.push(fn); }
function setActions(html) { const el = $('#pageActions'); if (el) el.innerHTML = html; return el; }
function setTitle(t) { const el = $('#pageTitle'); if (el) el.textContent = t; document.title = `${t} · ${App.settings.business_name || 'Velanzo'}`; }

async function router() {
  if (!App.user) return;
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  if (!path) return go(homeFor());
  let found = null, params = {};
  for (const v of Views) {
    const m = path.match(v.re);
    if (m) { found = v; v.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
  }
  if (!found || (found.allow && !found.allow())) return go(homeFor());
  while (App.cleanups.length) { try { App.cleanups.pop()(); } catch { /* ignore */ } }
  if (!$('#shell')) renderShell();
  const nav = found.nav || path.split('/')[0];
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  setTitle(typeof found.title === 'function' ? found.title(params) : found.title);
  setActions('');
  // fresh element each time so a slow, older page can never draw over a newer one
  const old = $('#view');
  const el = document.createElement('div');
  el.id = 'view';
  el.className = 'view ' + (found.cls || '');
  el.innerHTML = '<div class="loading">Loading…</div>';
  old.replaceWith(el);
  window.scrollTo(0, 0);
  try {
    await found.render({ el, params, query: Object.fromEntries(new URLSearchParams(query || '')) });
  } catch (e) {
    if (el.isConnected) el.innerHTML = `<div class="card empty error">${esc(e.message)}</div>`;
  }
  refreshBadges();
}

// ---------- Get the app (install Velanzo on a PC, Android phone or iPhone/iPad) ----------
const AppInstall = (() => {
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; App.installPrompt = e; document.dispatchEvent(new Event('vz-installable')); });
  window.addEventListener('appinstalled', () => { prompt = null; App.installPrompt = null; try { localStorage.setItem('vz_installed', '1'); } catch { /* ignore */ } });
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'your browser';
  // the steps for each kind of device (shown when the browser cannot install by itself)
  function stepsHtml() {
    const iphone = `<h4>iPhone / iPad</h4><ol class="ga-steps"><li>Open this page in <b>Safari</b>.</li><li>Tap <b>Share</b> <span class="ga-icon">⇪</span> at the bottom (on iPad: at the top).</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li></ol>`;
    const andr = `<h4>Android phone or tablet</h4><ol class="ga-steps"><li>Open this page in <b>Chrome</b>.</li><li>Tap the menu <span class="ga-icon">⋮</span> → <b>Install app</b> (or <b>Add to Home screen</b>).</li></ol>`;
    const pc = `<h4>Windows PC or Mac</h4><ol class="ga-steps"><li>Open this page in <b>Chrome</b> or <b>Edge</b>.</li><li>Click the install icon <span class="ga-icon">⊕</span> at the right end of the address bar, or the menu <span class="ga-icon">⋮</span> → <b>Cast, save and share → Install page as app</b> (Edge: <b>Apps → Install this site as an app</b>).</li></ol>`;
    const first = ios ? iphone : android ? andr : pc;
    return first + [iphone, andr, pc].filter((x) => x !== first).join('');
  }
  function open() {
    const m = modal({
      title: 'Get the Velanzo app',
      body: `<div class="get-app">
        ${installed() ? '<div class="alert ok">✓ You are using the Velanzo app on this device.</div>' : ''}
        <p style="margin-top:0">The app opens in its own window with its own icon, starts faster, keeps its data safe on this device, and works without internet. It is free and always up to date.</p>
        ${prompt ? '<button class="btn primary lg block" id="gaInstall">Install Velanzo on this device</button>' : ''}
        ${!prompt && ios && browser !== 'Safari' ? '<div class="alert">On iPhone and iPad, install it from <b>Safari</b>.</div>' : ''}
        ${!prompt && !ios && !android && /Firefox|Safari/.test(browser) ? `<div class="alert">${browser} on a computer cannot install apps: open this page in <b>Chrome</b> or <b>Edge</b>.</div>` : ''}
        ${stepsHtml()}
        <p class="muted small" style="margin-bottom:0">Address: <b>${esc(location.origin + location.pathname)}</b></p></div>`,
      footer: '<button class="btn" data-close>Close</button>',
    });
    const b = m.$('#gaInstall');
    if (b) b.addEventListener('click', async () => {
      prompt.prompt();
      const r = await prompt.userChoice.catch(() => null);
      prompt = null; App.installPrompt = null;
      m.close();
      if (r && r.outcome === 'accepted') toast('Velanzo is installed. Open it from its icon.');
    });
  }
  return { open, installed, canPrompt: () => !!prompt, ios, android };
})();

// pinch to zoom on iPhone/iPad (Safari ignores "user-scalable=no")
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- Barcode scanners ----------
// A USB scanner "types" the code very fast and then presses Enter (some press Tab). A scan always goes to the
// page's scan box: if the cursor was on a button, in the cash or a quantity box, or nowhere, that box gets its old
// text back and the Enter does not press anything there. (Typing in a name or barcode box keeps the scan there.)
const Scanner = (() => {
  // one scan: keys on average at most AVG ms apart (a person types 100+ ms apart), no single gap over GAP ms
  // (a hiccup, e.g. a Bluetooth scanner), at least MIN characters
  const AVG = 35, GAP = 90, MIN = 6;
  let buf = '', first = 0, last = 0, start = null;
  const visible = (x) => x && x.offsetParent !== null;
  const scanBox = () => [...document.querySelectorAll('input.scan-input')].find(visible);
  const numberBox = (t) => t && t.tagName === 'INPUT' && (['numeric', 'decimal'].includes(t.inputMode) || t.type === 'number' || t.classList.contains('num'));
  const misplaced = (t) => !t || t === document.body || t.tagName === 'BUTTON' || t.tagName === 'A' || numberBox(t);
  function toBox(box, code) {
    box.focus();
    box.value = code;
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  document.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return; // (our own Enter sent to the scan box)
    const now = performance.now();
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (now - last > GAP) {
        buf = '';
        first = now;
        const t = document.activeElement;
        start = { el: t, value: t && 'value' in t ? t.value : null };
      }
      buf += e.key;
      last = now;
      if (buf.length > 1 && misplaced(start.el) && scanBox() && start.el?.tagName !== 'INPUT') e.preventDefault();
      return;
    }
    const isEnd = e.key === 'Enter' || e.key === 'Tab';
    const code = buf;
    buf = '';
    if (!isEnd || code.length < MIN || now - last > GAP || (last - first) / (code.length - 1) > AVG) return;
    const t = document.activeElement;
    const box = scanBox();
    if (t === box) { // the scan box handles it; a Tab is an Enter
      if (e.key === 'Tab') { e.preventDefault(); box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      return;
    }
    if (!box || !misplaced(start?.el)) return; // a name, barcode or search box keeps what was scanned
    e.preventDefault();
    e.stopPropagation(); // the Enter must not press a button or finish a bill
    if (start?.el && start.value !== null && 'value' in start.el) { start.el.value = start.value; start.el.dispatchEvent(new Event('input', { bubbles: true })); }
    const modalEl = [...document.querySelectorAll('.modal-wrap')].pop();
    if (modalEl) {
      const closeBtn = modalEl.dataset.scanClose ? modalEl.querySelector('[data-close]') : null;
      if (!closeBtn) { toast('Close this window first, then scan again', 'warn'); return; }
      closeBtn.click(); // e.g. "Bill saved": the next customer's first scan starts the new bill
    }
    toBox(box, code);
  }, true);
  return { AVG, GAP, MIN };
})();

// ---------- Product list cache + scan/search box ----------
const ProductCache = {
  list: [], byCode: new Map(), loc: null, at: 0,
  async load(locId, force = false) {
    locId = locId || '';
    if (!force && this.loc === locId && Date.now() - this.at < 60000 && this.list.length) return this.list;
    this.set(await GET('/api/products', { all: 1, location_id: locId }));
    this.loc = locId; this.at = Date.now();
    return this.list;
  },
  set(list) { this.list = list; this.byCode = new Map(list.map((p) => [p.barcode.toLowerCase(), p])); this.at = 0; },
  add(p) { if (!this.byCode.has(p.barcode.toLowerCase())) { this.list.push(p); this.byCode.set(p.barcode.toLowerCase(), p); } },
  invalidate() { this.at = 0; },
  search(q, limit = 40) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    for (const p of this.list) {
      if (!p._hay) p._hay = `${p.name} ${p.barcode} ${p.category || ''} ${p.color || ''}`.toLowerCase();
      const size = String(p.size || '').toLowerCase();
      if (words.every((w) => w === size || p._hay.includes(w))) { out.push(p); if (out.length >= limit) break; }
    }
    return out;
  },
};

// Turns an input into a scan + search box. Barcode scanners type the code and press Enter.
// The same printed code can reach us as 12 digits (UPC) or 13 with a 0 in front (EAN), depending on the scanner.
function codeVariants(q) {
  const v = [q];
  if (/^\d{12}$/.test(q)) v.push('0' + q);
  if (/^0\d{12}$/.test(q)) v.push(q.slice(1));
  return v;
}

function attachPicker(input, { onPick, location = () => '', showStock = true, showPrice = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'picker';
  input.replaceWith(wrap);
  wrap.appendChild(input);
  const box = document.createElement('div');
  box.className = 'picker-list';
  wrap.appendChild(box);
  let results = [], active = 0, timer = null, moved = false;
  const hide = () => { box.style.display = 'none'; };
  const show = () => {
    if (!results.length) return hide();
    box.innerHTML = results.map((p, i) => `<div class="picker-item${i === active ? ' on' : ''}" data-i="${i}">
      <div class="pi-main"><div class="pi-name">${esc(p.name)}</div><div class="pi-sub">${esc(variantText(p) || '—')} · ${esc(p.barcode)}${p.category ? ' · ' + esc(p.category) : ''}</div></div>
      <div class="pi-right">${showPrice ? `<b>${money(p.sale_price)}</b>` : ''}${showStock ? `<div class="${p.loc_qty > 0 ? 'muted' : 'neg'}">Stock: ${p.loc_qty ?? 0}</div>` : ''}</div></div>`).join('');
    box.style.display = 'block';
    const on = box.querySelector('.on');
    on && on.scrollIntoView({ block: 'nearest' });
  };
  const pick = (p) => { input.value = ''; results = []; hide(); onPick(p); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    moved = false;
    timer = setTimeout(() => {
      const q = input.value.trim();
      results = q.length >= 2 ? ProductCache.search(q) : [];
      active = 0; show();
    }, 80);
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); moved = true; active = Math.min(active + 1, results.length - 1); show(); }
    else if (e.key === 'ArrowUp' && results.length) { e.preventDefault(); moved = true; active = Math.max(active - 1, 0); show(); }
    else if (e.key === 'Escape') { if (box.style.display === 'block') { e.stopPropagation(); hide(); } }
    else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) return;
      // a code (digits, or no spaces) must match exactly; only a typed name may take the first suggestion
      const codeLike = /^\d+$/.test(q) || (/^\S+$/.test(q) && /\d/.test(q) && q.length >= 6);
      let p = null;
      for (const c of codeVariants(q)) { p = ProductCache.byCode.get(c.toLowerCase()); if (p) break; }
      if (!p && box.style.display === 'block' && results[active] && (moved || !codeLike)) p = results[active];
      if (!p && /^\S+$/.test(q)) {
        try { p = await GET('/api/products/lookup', { code: q, location_id: location() }); ProductCache.add(p); } catch { /* not found */ }
      }
      if (!p && !codeLike) { const r = ProductCache.search(q); if (r.length === 1) p = r[0]; }
      if (p) { beep(true); pick(p); }
      else { beep(false); input.select(); toast(`No item found for "${q}"`, 'error'); }
    }
  });
  box.addEventListener('mousedown', (e) => {
    const it = e.target.closest('[data-i]');
    if (!it) return;
    e.preventDefault();
    pick(results[+it.dataset.i]);
    input.focus();
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
}

// ---------- Starting up ----------
async function loadMe() {
  const me = await GET('/api/me');
  App.user = me.user;
  App.settings = me.settings;
  App.locations = me.locations;
  App.device = me.device;
  App.permsCatalog = me.perms_catalog;
  return me;
}

async function boot() {
  try {
    await loadMe();
  } catch (e) {
    if (e.status === 401) return Setup.showLogin();
    return Setup.showError(e.message);
  }
  await Practice.refresh();
  renderShell();
  router();
  // Every half minute: refresh the menu counters and the "saved online" status.
  if (!App.heartbeat) App.heartbeat = setInterval(() => { if (App.user) refreshBadges(); }, 30000);
}
