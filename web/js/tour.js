'use strict';
// The guide that shows you where to click: dims the page, rings the thing to use, points an arrow at it and
// says what to do in plain words. It moves on by itself when you have done the step.
//
// A guide: { id, title, steps: [ step … ], outro }
// A step:  {
//   title, text                 what to say (text may contain <b>…</b>)
//   target                      CSS selector (or a function) of the thing to point at; none = a message in the middle
//   route                       the screen this step belongs to (text or RegExp, e.g. 'pos' or /^purchases\/\d+$/);
//                               if you are somewhere else the guide offers to take you there
//   done                        function that becomes true when you did it; the guide then moves on by itself
//                               (no `done` = a Next button)
//   assist                      { label, run } a button that does the typing/clicking for you
//   side                        'top' | 'bottom' | 'left' | 'right' (where the text goes; default = wherever there is room)
//   before                      runs once when the step starts (e.g. open a menu)
//   skipIf                      function; true = this step is not needed
// }
const Tour = (() => {
  let cur = null;
  let layer = null;

  const where = () => location.hash.replace(/^#\/?/, '').split('?')[0];
  const onRoute = (r) => (r instanceof RegExp ? r.test(where()) : where() === r);
  // (things inside a closed menu such as "More" have a size but are not really there)
  const inClosedMenu = (el) => { for (let d = el.parentElement && el.parentElement.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) { const sum = el.closest('summary'); if (!d.open && !(sum && sum.parentElement === d)) return true; } return false; };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && !inClosedMenu(el) && (!el.checkVisibility || el.checkVisibility());
  const find = (t) => { const el = typeof t === 'function' ? t() : t ? document.querySelector(t) : null; return visible(el) ? el : null; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Helpers for writing steps
  const helpers = {
    set(sel, value) {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    click(sel) { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; el && el.click(); },
    has: (sel) => !!find(sel),
    onRoute,
    val: (sel) => document.querySelector(sel)?.value || '',
  };

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = 'tour';
    layer.innerHTML = `<div class="tour-dim"></div><div class="tour-ring"></div>
      <div class="tour-arrow"><svg viewBox="0 0 46 46"><g class="tour-bounce"><path d="M23 4 L40 24 H29 V42 H17 V24 H6 Z"/></g></svg></div>
      <div class="tour-card" role="dialog" aria-live="polite"></div>`;
    document.body.appendChild(layer);
    layer.querySelector('.tour-card').addEventListener('click', onCardClick);
    return layer;
  }

  function onCardClick(e) {
    const b = e.target.closest('[data-t]');
    if (!b || !cur) return;
    const a = b.dataset.t;
    if (a === 'next') next();
    else if (a === 'back') back();
    else if (a === 'skip') next();
    else if (a === 'stop') stop();
    else if (a === 'go') { const s = cur.guide.steps[cur.i]; go(typeof s.go === 'string' ? s.go : s.route); }
    else if (a === 'assist') cur.guide.steps[cur.i].assist.run(helpers);
    else if (a === 'remove') { stop(); Practice.finishAsk(); }
    else if (a === 'again') { const g = cur.guide; stop(); start(g.id); }
    else if (a === 'list') { stop(); go('training'); }
  }

  async function start(id) {
    const base = Guides.find((g) => g.id === id);
    if (!base) return;
    stop();
    if (base.practice && !Practice.on) {
      const ok = await Practice.startAsk();
      if (!ok) return;
    }
    // some guides are written from what is on the screen now (e.g. the overview)
    const guide = { ...base, steps: typeof base.steps === 'function' ? base.steps(helpers) : base.steps };
    cur = { guide, i: -1, entered: -1, timer: null, finished: false, scrolled: -1, lastKey: '', missAt: 0, wasOn: -1 };
    ensureLayer();
    go_(0);
    cur.timer = setInterval(tick, 140);
    window.addEventListener('resize', tick);
    window.addEventListener('scroll', tick, true);
  }

  function go_(i) {
    const steps = cur.guide.steps;
    while (i < steps.length && steps[i].skipIf && safe(steps[i].skipIf)) i++;
    cur.i = i;
    cur.finished = i >= steps.length;
    cur.lastKey = '';
    cur.missAt = 0;
    tick();
  }
  const next = () => cur && go_(cur.i + 1);
  function back() {
    if (!cur) return;
    let i = cur.i - 1;
    while (i > 0 && cur.guide.steps[i].skipIf && safe(cur.guide.steps[i].skipIf)) i--;
    cur.entered = -1;
    cur.i = Math.max(0, i);
    cur.finished = false;
    cur.lastKey = '';
    tick();
  }
  const safe = (fn) => { try { return fn(helpers); } catch { return false; } };

  function stop() {
    if (!cur) return;
    clearInterval(cur.timer);
    window.removeEventListener('resize', tick);
    window.removeEventListener('scroll', tick, true);
    cur = null;
    if (layer) { layer.remove(); layer = null; }
  }

  function tick() {
    if (!cur || !layer) return;
    const steps = cur.guide.steps;
    if (cur.finished) return showEnd();
    const step = steps[cur.i];
    if (!step) return;

    // the screen this step needs
    const wrongRoute = step.route && !onRoute(step.route);
    if (!wrongRoute && cur.entered !== cur.i) {
      cur.entered = cur.i;
      if (step.before) safe(step.before);
    }
    // (a step that sends you to another screen is done when you arrive there, so check on the way out too)
    if (!wrongRoute) cur.wasOn = cur.i;
    if (step.done && (!wrongRoute || cur.wasOn === cur.i) && safe(step.done)) { cur.entered = -1; return next(); }

    const target = wrongRoute ? null : find(step.target);
    const n = steps.filter((s) => !(s.skipIf && safe(s.skipIf))).length;
    const pos = steps.slice(0, cur.i).filter((s) => !(s.skipIf && safe(s.skipIf))).length + 1;
    const mode = wrongRoute ? 'go' : target ? 'point' : 'center';
    // a screen that is still drawing itself: wait a moment before saying the thing is missing
    if (mode === 'center' && step.target) {
      if (!cur.missAt) cur.missAt = Date.now();
      if (Date.now() - cur.missAt < 800) { layer.classList.add('wait'); return; }
    } else cur.missAt = 0;
    layer.classList.remove('wait');
    if (target) cur.missAt = 0;
    const key = [cur.i, mode, !!step.done].join('|');
    const card = layer.querySelector('.tour-card');
    if (cur.lastKey !== key) {
      cur.lastKey = key;
      const doing = !!step.done && mode !== 'go';
      card.innerHTML = `
        <div class="tour-head"><span>Step ${pos} of ${n}</span><button data-t="stop" title="Stop the guide" aria-label="Stop the guide">✕</button></div>
        <h4>${esc(wrongRoute ? (step.goTitle || 'Let\'s go to the right screen') : step.title)}</h4>
        <div class="tour-text">${wrongRoute ? (step.goText || 'This step happens on another screen. Press the button and I will take you there.') : step.text}</div>
        ${!wrongRoute && mode === 'center' && step.target && step.done ? '<div class="tour-hint">I can\'t see it on the screen yet. Do the step before, or press Skip.</div>' : ''}
        ${doing && target ? '<div class="tour-hint">Do it now — I will move on by myself.</div>' : ''}
        <div class="tour-btns">
          ${cur.i > 0 ? '<button class="tbtn" data-t="back">← Back</button>' : ''}
          <span class="grow"></span>
          ${step.assist && mode !== 'go' ? `<button class="tbtn" data-t="assist">${esc(step.assist.label)}</button>` : ''}
          ${wrongRoute ? '<button class="tbtn main" data-t="go">Take me there</button>' : ''}
          ${!wrongRoute && step.done ? '<button class="tbtn quiet" data-t="skip">Skip this</button>' : ''}
          ${!wrongRoute && !step.done ? `<button class="tbtn main" data-t="next">${cur.i === steps.length - 1 ? 'Finish' : 'Next →'}</button>` : ''}
        </div>`;
    }

    if (target) {
      if (cur.scrolled !== cur.i) {
        cur.scrolled = cur.i;
        const r = target.getBoundingClientRect();
        if (r.top < 80 || r.bottom > innerHeight - 24) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      point(target.getBoundingClientRect(), step.side);
    } else {
      layer.classList.remove('pointing');
      layer.classList.add('centered');
      layer.querySelector('.tour-ring').style.display = 'none';
      layer.querySelector('.tour-arrow').style.display = 'none';
      card.style.cssText = '';
    }
  }

  // Ring the thing, put the arrow next to it and the text beyond the arrow (wherever there is room).
  function point(r, preferred) {
    layer.classList.add('pointing');
    layer.classList.remove('centered');
    const pad = 6;
    const ring = layer.querySelector('.tour-ring'), arrow = layer.querySelector('.tour-arrow'), card = layer.querySelector('.tour-card');
    ring.style.display = 'block';
    ring.style.cssText = `display:block;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    const vw = innerWidth, vh = innerHeight;
    const cw = Math.min(330, vw - 24);
    card.style.width = cw + 'px';
    const ch = card.offsetHeight;
    const A = 46, G = 8;
    const room = {
      bottom: vh - (r.bottom + pad) - G - A - 10 >= ch,
      top: r.top - pad - G - A - 10 >= ch,
      right: vw - (r.right + pad) - G - A - 10 >= cw,
      left: r.left - pad - G - A - 10 >= cw,
    };
    let side = preferred && room[preferred] ? preferred : ['bottom', 'top', 'right', 'left'].find((s) => room[s]);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (!side) {
      // no room around it: the text sits at the bottom of the screen, the arrow still points at the thing
      side = r.top > vh / 2 ? 'top' : 'bottom';
      arrow.style.display = 'block';
      const y = side === 'bottom' ? Math.min(r.bottom + pad + G, vh - A - 4) : Math.max(r.top - pad - G - A, 4);
      arrow.style.cssText = `display:block;left:${clamp(cx - A / 2, 4, vw - A - 4)}px;top:${y}px;transform:rotate(${side === 'bottom' ? 0 : 180}deg)`;
      card.style.left = (vw - cw) / 2 + 'px';
      card.style.top = Math.max(8, vh - ch - 14) + 'px';
      return;
    }
    let ax, ay, rot, cl, ct;
    if (side === 'bottom') { ax = cx - A / 2; ay = r.bottom + pad + G; rot = 0; cl = cx - cw / 2; ct = ay + A - 4; }
    else if (side === 'top') { ax = cx - A / 2; ay = r.top - pad - G - A; rot = 180; cl = cx - cw / 2; ct = ay - ch + 4; }
    else if (side === 'right') { ax = r.right + pad + G; ay = cy - A / 2; rot = -90; cl = ax + A - 4; ct = cy - ch / 2; }
    else { ax = r.left - pad - G - A; ay = cy - A / 2; rot = 90; cl = ax - cw + 4; ct = cy - ch / 2; }
    arrow.style.cssText = `display:block;left:${clamp(ax, 4, vw - A - 4)}px;top:${clamp(ay, 4, vh - A - 4)}px;transform:rotate(${rot}deg)`;
    card.style.left = clamp(cl, 12, vw - cw - 12) + 'px';
    card.style.top = clamp(ct, 8, vh - ch - 8) + 'px';
  }

  function showEnd() {
    const g = cur.guide;
    layer.classList.add('centered');
    layer.classList.remove('pointing');
    layer.querySelector('.tour-ring').style.display = 'none';
    layer.querySelector('.tour-arrow').style.display = 'none';
    const card = layer.querySelector('.tour-card');
    card.style.cssText = '';
    const key = 'end|' + Practice.on;
    if (cur.lastKey === key) return;
    cur.lastKey = key;
    card.innerHTML = `
      <div class="tour-head"><span>Finished</span><button data-t="stop" title="Close" aria-label="Close">✕</button></div>
      <div class="tour-big">🎉</div>
      <h4>Well done!</h4>
      <div class="tour-text">${g.outro || 'You have finished this guide.'}</div>
      ${g.practice && Practice.on ? '<div class="tour-hint">Everything you did was practice. Remove it when you are ready — it disappears completely, as if it never happened.</div>' : ''}
      <div class="tour-btns">
        <button class="tbtn" data-t="again">Do it again</button><span class="grow"></span>
        ${Practice.on ? '<button class="tbtn main" data-t="remove">Remove practice data</button>' : '<button class="tbtn main" data-t="list">All guides</button>'}
      </div>`;
  }

  return { start, stop, helpers, visible, get active() { return !!cur; } };
})();
