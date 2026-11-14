'use strict';
// Demo mode (More → Demo mode): a separate, empty business on this computer to try things and learn Velanzo.
// It is its own book: the real data is never touched, nothing is sent online, nobody else sees it.
// What is done in the demo stays there for next time, until "Start the demo again (empty)".
const Demo = (() => {
  const KEY = 'vz_demo', FRESH = 'vz_demo_fresh';
  const DRAFTS = ['vz_cart_', 'vz_purchase_', 'vz_dispatch_', 'vz_labels'];
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ } };

  // Half-finished bills and orders kept in this browser belong to one book: put them aside and bring the other book's back.
  function swapDrafts(saveAs, bringBack) {
    try {
      const mine = {};
      for (const k of Object.keys(localStorage)) if (DRAFTS.some((p) => k.startsWith(p))) { mine[k] = localStorage.getItem(k); localStorage.removeItem(k); }
      localStorage.setItem(saveAs, JSON.stringify(mine));
      const back = JSON.parse(localStorage.getItem(bringBack) || '{}');
      for (const [k, v] of Object.entries(back)) localStorage.setItem(k, v);
      localStorage.removeItem(bringBack);
    } catch { /* storage off */ }
  }

  // Before switching: whatever is waiting goes online first (a few seconds at most), then Velanzo opens the other book.
  async function switchTo(on) {
    if (!on && App.practice) return toast('Finish practising first (the orange bar at the top)', 'error');
    try { await Promise.race([Cloud.syncNow(), new Promise((r) => { setTimeout(r, 5000); })]); } catch { /* offline: it waits on this computer */ }
    Cloud.stop();
    if (on) swapDrafts('vz_real_drafts', 'vz_demo_drafts'); else swapDrafts('vz_demo_drafts', 'vz_real_drafts');
    set(KEY, on ? '1' : null);
    location.hash = '';
    location.reload();
  }

  return {
    // (asked before the database opens)
    on: () => get(KEY) === '1',
    takeFresh() { const f = get(FRESH) === '1'; set(FRESH, null); return f; },

    ask() {
      if (App.practice) return toast('Finish practising first (the orange bar at the top)', 'error');
      const m = modal({
        title: 'Turn on Demo mode?',
        body: `<p style="margin-top:0">Demo mode opens a <b>separate, empty</b> Velanzo on this computer, to try things and learn.</p>
          <ul class="tick-list">
            <li>Your real data is <b>not touched</b>. Nothing in the demo is sent online and nobody else sees it.</li>
            <li>What you do in the demo is kept for next time.</li>
            <li>While the demo is on, this computer does not get changes from the other computers. They arrive as soon as you leave the demo.</li>
            <li>To leave: <b>More → Leave Demo mode</b>. You will type your passcode again.</li>
          </ul>`,
        footer: '<button class="btn" data-close>Not now</button><button class="btn primary" id="dmGo">Turn on Demo mode</button>',
      });
      const b = m.$('#dmGo');
      b.addEventListener('click', () => busy(b, () => switchTo(true)));
    },
    leave: () => switchTo(false),
    async startFresh() {
      if (!App.demo) return;
      const ok = await confirmBox('Remove everything in the demo and start it again empty?\n\nYour real data is not touched.', { title: 'Start the demo again', ok: 'Start again empty', danger: true });
      if (!ok) return;
      set(FRESH, '1');
      try { for (const k of Object.keys(localStorage)) if (DRAFTS.some((p) => k.startsWith(p))) localStorage.removeItem(k); } catch { /* storage off */ }
      location.hash = '';
      location.reload();
    },
    // The line under the top bar while the demo is on.
    stripHtml: () => `<div class="demo-strip"><span class="grow"><b>DEMO MODE</b><span class="ds-more"> — a separate, empty Velanzo to try things. Your real data is not touched.</span></span>
      <button type="button" id="demoFresh">Start again empty</button><button type="button" id="demoLeave">Leave Demo mode</button></div>`,
    bindStrip(root) {
      root.querySelector('#demoFresh')?.addEventListener('click', () => this.startFresh());
      root.querySelector('#demoLeave')?.addEventListener('click', () => this.leave());
    },
  };
})();
