'use strict';
// Training: guided practice. Pick a guide and Velanzo points at what to click, says what to do, and moves on
// when you have done it. Guides that need real work (making a bill, receiving stock …) run in PRACTICE MODE:
// the real screens with DEMO items, and when you finish everything is removed as if it never happened.

// ---------- Practice mode (the orange bar at the top) ----------
const DRAFT_KEYS = ['vz_cart_', 'vz_purchase_', 'vz_dispatch_', 'vz_labels'];
const Practice = {
  on: false,
  async refresh() {
    try { this.on = !!(await Engine.system('info')).practice; } catch { /* keep as is */ }
    this.paint();
  },
  paint() {
    App.practice = this.on;
    document.body.classList.toggle('practicing', this.on);
    if (!this.on) document.documentElement.style.removeProperty('--pbar-h');
    let bar = document.getElementById('practiceBar');
    if (!this.on) { bar && bar.remove(); paintSync(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'practiceBar';
      bar.innerHTML = `<span class="pb-text"><b>🎓 PRACTICE MODE</b><span> — nothing here is real. Everything you do is removed when you finish.</span></span>
        <a href="#/training">Guides</a><button type="button" id="pbFinish">Finish &amp; remove practice</button>`;
      document.body.insertBefore(bar, document.body.firstChild);
      const fit = () => document.documentElement.style.setProperty('--pbar-h', bar.offsetHeight + 'px');
      fit(); window.addEventListener('resize', fit);
      bar.querySelector('#pbFinish').addEventListener('click', () => this.finishAsk());
    }
    paintSync();
  },

  // Explains what practice is, then starts it. Resolves true when practice is on.
  startAsk() {
    return new Promise((resolve) => {
      let started = false;
      const m = modal({
        title: 'Start practising?',
        body: `<p style="margin-top:0">This guide uses the <b>real screens</b> with <b>DEMO</b> things (a DEMO T-Shirt, a DEMO Supplier …) so you can try everything safely.</p>
          <ul class="tick-list">
            <li>Nothing is sent online and nobody else sees it.</li>
            <li>When you finish, everything you did is <b>removed completely</b> — bills, stock, numbers, all of it, as if it never happened.</li>
            <li><b>Don't make real sales or real stock changes</b> until you have finished practising — they would be removed too.</li>
          </ul>`,
        footer: '<button class="btn" data-close>Not now</button><button class="btn primary" id="prGo">Start practice</button>',
        onClose: () => { if (!started) resolve(false); },
      });
      const b = m.$('#prGo');
      b.addEventListener('click', () => busy(b, async () => {
        this.saveDrafts();
        await Engine.system('practiceStart');
        this.on = true;
        ProductCache.invalidate();
        await loadMe();
        this.paint();
        if (path() === 'training') router();
        started = true;
        m.close();
        resolve(true);
      }));
    });
  },

  async finishAsk() {
    if (!(await confirmBox('Remove all the practice data and go back to your real data?\n\nEverything you made while practising is deleted completely.', { title: 'Finish practising', ok: 'Remove practice data', danger: true }))) return;
    Tour.stop();
    try {
      await Engine.system('practiceFinish');
    } catch (e) { return toast(e.message, 'error', 7000); }
    this.restoreDrafts();
    this.on = false;
    ProductCache.invalidate();
    location.hash = '#/training';
    location.reload(); // start clean on the real data
  },

  // half-finished bills etc. kept in this browser are put aside during practice and back afterwards
  saveDrafts() {
    try {
      const saved = {};
      for (const k of Object.keys(localStorage)) if (DRAFT_KEYS.some((p) => k.startsWith(p))) { saved[k] = localStorage.getItem(k); localStorage.removeItem(k); }
      localStorage.setItem('vz_practice_drafts', JSON.stringify(saved));
    } catch { /* storage off */ }
  },
  restoreDrafts() {
    try {
      for (const k of Object.keys(localStorage)) if (DRAFT_KEYS.some((p) => k.startsWith(p))) localStorage.removeItem(k);
      const saved = JSON.parse(localStorage.getItem('vz_practice_drafts') || '{}');
      for (const [k, v] of Object.entries(saved)) localStorage.setItem(k, v);
      localStorage.removeItem('vz_practice_drafts');
    } catch { /* storage off */ }
  },
};

// ---------- The guides ----------
const navTarget = (href) => () => {
  const a = document.querySelector(`#nav a[data-nav="${href}"]`);
  return Tour.visible(a) ? a : document.querySelector('#moreMenu summary'); // inside "More"? point at More first
};
// the DEMO T-Shirt in the search list (it always has stock)
const pickDemo = () => [...document.querySelectorAll('.picker-item')].find((e) => /T-Shirt/.test(e.textContent)) || document.querySelector('.picker-item');
const path = () => location.hash.replace(/^#\/?/, '').split('?')[0];
const NAV_TEXT = {
  Home: 'Your starting screen. The owner sees today\'s sales and every shop live; others see their main buttons.',
  Sell: 'Make a bill: scan the items, take the money, print the bill.',
  Bills: 'Every bill ever made. Find one, print it again or cancel it.',
  'Receive stock': 'Parcels sent to your shop. Count them and press confirm.',
  'Send stock': 'Send items to a shop or the warehouse, and see what is on the way.',
  'Stock arrived': 'Write down stock that came from a supplier.',
  Labels: 'Print barcode stickers for your items.',
  Items: 'All your items with sizes, colours, prices and barcodes. Add new ones here.',
  Stock: 'How many pieces of each item are at every shop and the warehouse.',
  Expenses: 'Write down money you spend (rent, tea, transport …).',
  Suppliers: 'The people you buy from, and what you owe them.',
  Reports: 'Sales, profit and what sells best.',
  Activity: 'Everything that happened, with who did it and when.',
  Settings: 'Your business details, shops, people, computers and backups.',
  Training: 'This screen — guides that show you how to do things.',
};

const Guides = [
  {
    id: 'overview', title: 'Full overview', icon: 'home', time: '2 min', practice: false,
    desc: 'A tour of the whole screen: the menu, the save status and your name. Start here.',
    show: () => true,
    outro: 'That is the whole screen. To practise a job, like making a bill or receiving stock, pick one of the other guides.',
    steps: () => {
      const main = $$('#nav > a').map((a) => ({ key: a.dataset.nav, label: a.querySelector('span')?.textContent.trim() }));
      const more = $$('#moreMenu .more-list a').map((a) => a.querySelector('span')?.textContent.trim());
      const steps = [{
        title: 'Welcome to Velanzo', text: 'This short tour shows you around. Press <b>Next</b> to move on, or <b>✕</b> to stop at any time.',
      }];
      for (const m of main) {
        steps.push({
          title: m.label, text: NAV_TEXT[m.label] || '', side: 'bottom',
          target: () => document.querySelector(`#nav > a[data-nav="${m.key}"]`),
        });
      }
      if (more.length) {
        steps.push({
          title: 'More', side: 'bottom', target: '#moreMenu .more-list',
          before: () => { const d = $('#moreMenu'); if (d) d.open = true; },
          text: 'The rest are under <b>More</b>:<ul class="tour-list">' + more.map((l) => `<li><b>${esc(l)}</b> — ${esc(NAV_TEXT[l] || '')}</li>`).join('') + '</ul>',
        });
      }
      steps.push({
        title: 'Is everything saved?', side: 'bottom', target: '#syncPill',
        before: () => { const d = $('#moreMenu'); if (d) d.open = false; },
        text: 'This tells you if your work is saved online. <b>All saved online</b> is what you want. With no internet you can keep working — it says how many things are waiting and sends them by itself later.',
      });
      steps.push({
        title: 'Your name', side: 'bottom', target: '.user-menu summary',
        text: 'Click your name to <b>switch person</b>, change <b>My PIN</b>, see <b>This device</b>, open the written guide or come back to <b>Training</b>.',
      });
      return steps;
    },
  },

  {
    id: 'sell', title: 'Making a bill (selling)', icon: 'cart', time: '3 min', practice: true,
    desc: 'Scan an item, take the money, finish the sale and find the bill afterwards.',
    show: () => can('sell'),
    outro: 'That is how every sale works: scan, take the money, Done. Try <b>Return or exchange</b> next if you take items back.',
    steps: [
      { title: 'Open the Sell screen', text: 'Click <b>Sell</b> in the top bar. This is the screen you use for every customer.', target: navTarget('pos'), done: () => path() === 'pos', skipIf: () => path() === 'pos' },
      { route: 'pos', title: 'Find the item', target: '#scan', done: (h) => h.has('.picker-item'),
        text: 'Click this box and type <b>DEMO T-Shirt</b>. At a real counter you just <b>scan the barcode</b> with the scanner and the item is added by itself.',
        assist: { label: 'Type it for me', run: (h) => h.set('#scan', 'DEMO T-Shirt') } },
      { route: 'pos', title: 'Pick the item', target: pickDemo, done: (h) => h.has('.cart-row'),
        text: 'Click <b>DEMO T-Shirt</b> in the list. (A scanned item goes straight on the bill, without this step.)' },
      { route: 'pos', title: 'Add one more', target: '.cart-row .qty', side: 'right', done: () => Number(document.querySelector('.cart-row [data-qty]')?.value) >= 2,
        text: 'The item is on the bill. Click the <b>+</b> to add a second piece. (Scanning the same item again does this too.)' },
      { route: 'pos', title: 'Discount (optional)', target: '#discLink', side: 'top', skipIf: () => !can('discount'),
        text: 'To give a discount, click <b>% Discount</b> and type the amount or the percent. We\'ll skip it now.' },
      { route: 'pos', title: 'How they pay', target: '#methods', side: 'left',
        text: 'Choose <b>Cash</b>, <b>Card</b> or <b>Online</b>. Cash is already chosen.' },
      { route: 'pos', title: 'Cash received', target: '#paid', side: 'left', done: () => Number(document.querySelector('#paid')?.value) > 0,
        text: 'Type how much cash the customer gave you — more than the total, for example <b>5000</b>. Velanzo shows the <b>change</b> to give back.',
        assist: { label: 'Type 5000 for me', run: (h) => h.set('#paid', '5000') } },
      { route: 'pos', title: 'Finish the sale', target: '#doneBtn', side: 'left', done: (h) => h.has('.modal-wrap'),
        text: 'Click <b>Done</b>. The bill is saved and the stock goes down. (In real life the bill prints now. In practice nothing prints.)' },
      { route: 'pos', title: 'Bill saved', target: '#mNew', done: (h) => !h.has('.modal-wrap'),
        text: 'This shows the bill number and the change to give. Click <b>New sale</b> to be ready for the next customer.' },
      { title: 'Find the bill again', target: navTarget('sales'), done: () => path() === 'sales',
        text: 'Every bill is kept. Click <b>Bills</b> to see it.' },
      { route: 'sales', title: 'Your bill is here', target: '#view .tbl tbody tr', side: 'bottom',
        text: 'The newest bill is at the top. Click a bill to see its items, print it again or cancel it.' },
    ],
  },

  {
    id: 'return', title: 'Taking an item back (return or exchange)', icon: 'file', time: '2 min', practice: true,
    desc: 'The customer brings something back: put it back in stock and give the money back.',
    show: () => can('returns') && can('sell'),
    outro: 'For an <b>exchange</b>, scan the returned item first, press <b>Return or exchange</b> again, then scan the new item. The bill shows the difference.',
    steps: [
      { title: 'Open the Sell screen', text: 'Returns are made on the <b>Sell</b> screen. Click <b>Sell</b>.', target: navTarget('pos'), done: () => path() === 'pos', skipIf: () => path() === 'pos' },
      { route: 'pos', title: 'Switch to taking back', target: '#retBtn', side: 'top', done: () => !!document.querySelector('#retBtn.on'),
        text: 'Click <b>↩ Return or exchange</b>. The screen changes colour so you know items are coming back.' },
      { route: 'pos', title: 'Find the item', target: '#scan', done: (h) => h.has('.picker-item'),
        text: 'Scan what the customer returns, or type <b>DEMO T-Shirt</b> here.',
        assist: { label: 'Type it for me', run: (h) => h.set('#scan', 'DEMO T-Shirt') } },
      { route: 'pos', title: 'Pick the item', target: pickDemo, done: (h) => h.has('.cart-row.ret-line'),
        text: 'Click <b>DEMO T-Shirt</b>.' },
      { route: 'pos', title: 'Money back', target: '.pos-side', side: 'left',
        text: 'It says <b>Give back to the customer</b> with the amount. The piece goes back into stock when you finish.' },
      { route: 'pos', title: 'Finish', target: '#doneBtn', side: 'left', done: (h) => h.has('.modal-wrap'),
        text: 'Click <b>Done</b>.' },
      { route: 'pos', title: 'Saved', target: '#mNew', done: (h) => !h.has('.modal-wrap'),
        text: 'The refund bill is saved. Click <b>New sale</b>.' },
    ],
  },

  {
    id: 'purchase', title: 'Stock arrived (buying from a supplier)', icon: 'bag', time: '4 min', practice: true,
    desc: 'Write down stock that came from a supplier, add it to the warehouse and get the labels ready.',
    show: () => can('buy'),
    outro: 'That is the whole buying flow: <b>Stock arrived → labels → stick on the items</b>. Next you send the stock to a shop with the <b>Send stock</b> guide.',
    steps: [
      { title: 'Open Stock arrived', text: 'Click <b>Stock arrived</b>. Every time goods come from a supplier, you start here.', target: navTarget('purchases'), done: () => /^purchases/.test(path()), skipIf: () => /^purchases/.test(path()) },
      { route: 'purchases', title: 'Start a new purchase', target: '#pageActions .btn', done: () => path() === 'purchases/new',
        text: 'Click <b>New purchase</b>.' },
      { route: 'purchases/new', title: 'Who sent it?', target: '#sup', done: () => !!document.querySelector('#sup')?.value,
        text: 'Choose the supplier. Pick <b>DEMO Supplier</b>. (A new supplier? Use the <b>+</b> button next to it.)',
        assist: { label: 'Choose it for me', run: (h) => { const s = document.querySelector('#sup'); const o = [...s.options].find((x) => /DEMO/.test(x.text)); if (o) h.set('#sup', o.value); } } },
      { route: 'purchases/new', title: 'Supplier\'s bill number', target: '#inv', done: () => !!document.querySelector('#inv')?.value.trim(),
        text: 'Copy the number from the supplier\'s paper bill, so you can find it later. Type <b>DEMO-1001</b>.',
        assist: { label: 'Type it for me', run: (h) => h.set('#inv', 'DEMO-1001') } },
      { route: 'purchases/new', title: 'Where does it go?', target: '#loc',
        text: 'The place the stock goes into — usually your <b>warehouse</b>. It is already chosen.' },
      { route: 'purchases/new', title: 'Add the item', target: '#scan', done: (h) => h.has('.picker-item'),
        text: 'Scan an item you already have, or type its name. Type <b>DEMO T-Shirt</b>. For something you never bought before, use <b>New item</b> instead (see the guide “Adding a new item”).',
        assist: { label: 'Type it for me', run: (h) => h.set('#scan', 'DEMO T-Shirt') } },
      { route: 'purchases/new', title: 'Pick it', target: pickDemo, done: (h) => h.has('#lines tbody tr'),
        text: 'Click <b>DEMO T-Shirt</b>.' },
      { route: 'purchases/new', title: 'How many arrived?', target: '#lines [data-f=qty]', side: 'top', done: () => Number(document.querySelector('#lines [data-f=qty]')?.value) >= 2,
        text: 'Type how many pieces came, for example <b>12</b>.',
        assist: { label: 'Type 12 for me', run: (h) => h.set('#lines [data-f=qty]', '12') } },
      { route: 'purchases/new', title: 'What did you pay?', target: '#lines [data-f=cost]', side: 'top',
        text: '<b>Cost price</b> is what you paid for one piece. It is filled in from the item — change it if the price is different this time.' },
      { route: 'purchases/new', title: 'Paid the supplier?', target: '#paid', side: 'top',
        text: 'If you paid the supplier now, type the amount. Leave it empty to pay later — it will show as money you owe.' },
      { route: 'purchases/new', title: 'Save it', target: '#saveBtn', side: 'top', done: () => /^purchases\/\d+$/.test(path()),
        text: 'Click <b>Save purchase &amp; add to stock</b>. The pieces are now in your warehouse stock.' },
      { route: /^purchases\/\d+$/, title: 'Now the labels', target: '#lblBtn', side: 'left', done: () => path() === 'labels',
        text: 'Saved. Every piece needs a barcode sticker. Click <b>Print barcode labels</b>.' },
      { route: 'labels', title: 'Labels ready to print', target: '#qList',
        text: 'These are the stickers waiting to be printed — one per piece. Change the number if you want more or less.' },
      { route: 'labels', title: 'Print', target: '#printBtn', side: 'top',
        text: 'This sends them to your label printer. We won\'t print during practice. Stick the labels on the items, and they are ready to sell or send.' },
    ],
  },

  {
    id: 'newitem', title: 'Adding a new item (sizes & colours)', icon: 'tag', time: '3 min', practice: true,
    desc: 'Make an item with several sizes at once. Each size gets its own barcode.',
    show: () => can('add_items') || can('buy'),
    outro: 'Done! Each size now has its own barcode. Add the stock with <b>Stock arrived</b>, then print the labels.',
    steps: [
      { title: 'Open Items', text: 'Click <b>Items</b>.', target: navTarget('products'), done: () => /^products/.test(path()), skipIf: () => /^products/.test(path()) },
      { route: /^products$/, title: 'Add an item', target: '#addBtn', side: 'bottom', done: (h) => h.has('.modal-wrap'),
        text: 'Click <b>Add new item</b>.' },
      { route: /^products$/, title: 'Its name', target: '.modal-wrap [name=name]', done: () => !!document.querySelector('.modal-wrap [name=name]')?.value.trim(),
        text: 'Type the name, for example <b>DEMO Jeans</b>.',
        assist: { label: 'Type it for me', run: (h) => h.set('.modal-wrap [name=name]', 'DEMO Jeans') } },
      { route: /^products$/, title: 'Price', target: '.modal-wrap [name=sale_price]', done: () => Number(document.querySelector('.modal-wrap [name=sale_price]')?.value) > 0,
        text: 'The price you sell it for. Type <b>1500</b>. (<b>Cost price</b> is what you pay — it helps with profit reports.)',
        assist: { label: 'Type 1500 for me', run: (h) => h.set('.modal-wrap [name=sale_price]', '1500') } },
      { route: /^products$/, title: 'Sizes', target: '.modal-wrap [name=sizes]', done: () => !!document.querySelector('.modal-wrap [name=sizes]')?.value.trim(),
        text: 'Click the size buttons above, or type them separated by commas: <b>M, L</b>. Leave it empty if the item has no sizes.',
        assist: { label: 'Type M, L for me', run: (h) => h.set('.modal-wrap [name=sizes]', 'M, L') } },
      { route: /^products$/, title: 'One barcode each', target: '.modal-wrap #varBox', side: 'top',
        text: 'Velanzo makes a separate item for each size (and colour), each with its own barcode. You can also type a barcode that is already printed on the item.' },
      { route: /^products$/, title: 'Save', target: '.modal-wrap #apSave', side: 'top', done: () => document.querySelector('.modal-head h3')?.textContent === 'Barcode labels',
        text: 'Click <b>Save item</b>.' },
      { route: /^products$/, title: 'Labels', target: '#cOk', side: 'top', done: () => path() === 'labels',
        text: 'Velanzo asks if you want to print the barcode labels. Click <b>Go to labels</b>.' },
      { route: 'labels', title: 'Labels for the new item', target: '#qList',
        text: 'The new sizes are already in the label list, ready to print.' },
    ],
  },

  {
    id: 'send', title: 'Sending stock to a shop', icon: 'truck', time: '3 min', practice: true,
    desc: 'Pack items, send them to a shop and see them go “on the way”.',
    show: () => isAdmin() || can('send'),
    outro: 'The parcel is now <b>on the way</b>. The shop sees it under <b>Receive stock</b>, counts it and confirms. Stock only moves into the shop when they confirm.',
    steps: [
      { title: 'Open Send stock', text: 'Click <b>Send stock</b>.', target: navTarget('dispatch'), done: () => /^dispatch/.test(path()), skipIf: () => /^dispatch/.test(path()) },
      { route: 'dispatch', title: 'Start a new parcel', target: '#pageActions .btn', done: () => path() === 'dispatch/new',
        text: 'Click <b>Send stock</b>.' },
      { route: 'dispatch/new', title: 'From → To', target: '#to', side: 'bottom',
        text: '<b>From</b> is where the stock is now. In <b>To</b>, choose the shop it is going to.' },
      { route: 'dispatch/new', title: 'Add the items', target: '#scan', done: (h) => h.has('.picker-item'),
        text: 'Scan each piece as you pack it — every scan adds 1. Or type a name. Type <b>DEMO T-Shirt</b>.',
        assist: { label: 'Type it for me', run: (h) => h.set('#scan', 'DEMO T-Shirt') } },
      { route: 'dispatch/new', title: 'Pick it', target: pickDemo, done: (h) => h.has('#lines tbody tr'),
        text: 'Click <b>DEMO T-Shirt</b>.' },
      { route: 'dispatch/new', title: 'How many?', target: '#lines .qty', side: 'top', done: () => Number(document.querySelector('#lines [data-q]')?.value) >= 3,
        text: 'Set the number of pieces you are sending: use <b>+</b> or type <b>5</b>. It warns you if the stock is not enough.',
        assist: { label: 'Make it 5 for me', run: (h) => h.set('#lines [data-q]', '5') } },
      { route: 'dispatch/new', title: 'Send it', target: '#send', side: 'top', done: () => /^dispatch\/\d+$/.test(path()),
        text: 'Click <b>Send dispatch</b>. The pieces leave your stock right away and show as <b>on the way</b>.' },
      { route: /^dispatch\/\d+$/, title: 'Sent', target: '#printBtn', side: 'bottom',
        text: 'Print the <b>dispatch note</b> and put it in the parcel, so the shop can check it. (We don\'t print during practice.)' },
    ],
  },

  {
    id: 'receive', title: 'Receiving a parcel', icon: 'inbox', time: '2 min', practice: true,
    desc: 'A parcel arrives: check it against the note and add it to your stock.',
    show: () => !isAdmin() && can('receive'),
    outro: 'That is it. If a piece is missing, change the number before you confirm — the owner then sees the difference.',
    steps: [
      { title: 'Open Receive stock', text: 'Click <b>Receive stock</b>.', target: navTarget('dispatch'), done: () => /^dispatch/.test(path()), skipIf: () => /^dispatch/.test(path()) },
      { route: 'dispatch', title: 'A parcel is waiting', target: () => [...document.querySelectorAll('#incoming .alert')].find((a) => /DEMO/.test(a.textContent))?.querySelector('.btn'), done: () => /^dispatch\/\d+\/receive$/.test(path()),
        text: 'Parcels on their way to you are listed here. Use the one marked <b>DEMO</b> (made for practice) and click <b>Check &amp; receive</b>.' },
      { route: /^dispatch\/\d+\/receive$/, title: 'Count the parcel', target: '#lines', side: 'top',
        text: 'Compare with the dispatch note. <b>Sent</b> is what the sender packed. <b>Received</b> is what you count.' },
      { route: /^dispatch\/\d+\/receive$/, title: 'Scan to count (optional)', target: '#scan',
        text: 'You can scan every piece and Velanzo counts for you. Or just leave the numbers if everything is there.' },
      { route: /^dispatch\/\d+\/receive$/, title: 'Something missing?', target: '#lines input', side: 'top',
        text: 'If a piece is missing or extra, type the number you really got. It will be shown as a difference.' },
      { route: /^dispatch\/\d+\/receive$/, title: 'Confirm', target: '#okBtn', side: 'top', done: () => /^dispatch\/\d+$/.test(path()),
        text: 'Click <b>Confirm received</b>. The pieces are added to your shop\'s stock.' },
      { title: 'Check your stock', target: navTarget('stock'), done: () => path() === 'stock',
        text: 'Click <b>Stock</b> to see the new pieces.' },
      { route: 'stock', title: 'Your stock went up', side: 'top', target: () => [...document.querySelectorAll('#list tbody tr')].find((r) => /DEMO/.test(r.textContent)),
        text: 'The <b>DEMO T-Shirt</b> pieces are in your stock now.' },
    ],
  },

  {
    id: 'stock', title: 'Checking your stock', icon: 'box', time: '1 min', practice: false,
    desc: 'See how many pieces are where, and find what is running low.',
    show: () => true,
    outro: 'To fix a wrong count, press <b>Correct</b> next to an item (if your shop allows it).',
    steps: [
      { title: 'Open Stock', text: 'Click <b>Stock</b>.', target: navTarget('stock'), done: () => path() === 'stock', skipIf: () => path() === 'stock' },
      { route: 'stock', title: 'Find an item', target: '#q', text: 'Type a name, colour or size — or scan a barcode — to find an item.' },
      { route: 'stock', title: 'Low stock', target: '#low', side: 'bottom', text: 'Tick this to see only items that are running low, so you know what to order.' },
      { route: 'stock', title: 'The numbers', target: '#list tbody tr', side: 'bottom', text: 'One row per item, with the pieces at each place. Red means it is low or gone.' },
    ],
  },

  {
    id: 'owner', title: 'Setting up shops, people & switches', icon: 'sliders', time: '4 min', practice: false,
    desc: 'Decide what each shop and each person may do. For the owner.',
    show: () => isAdmin(),
    outro: 'Remember: a person can only do what <b>both</b> their shop and their own switches allow. Everything saved here is saved for real, so no changes were made in this tour.',
    steps: [
      { title: 'Open Settings', text: 'Click <b>Settings</b>.', target: navTarget('settings'), done: () => /^settings/.test(path()), skipIf: () => /^settings/.test(path()) },
      { route: /^settings/, title: 'Shops & warehouse', target: '.tabs a[href="#/settings/locations"]', done: () => path() === 'settings/locations', skipIf: () => path() === 'settings/locations',
        text: 'Click <b>Shops &amp; warehouse</b>.' },
      { route: 'settings/locations', title: 'Each place has a card', target: '.place-card', side: 'bottom', done: (h) => h.has('.modal-wrap'),
        text: 'The green labels show what this place may do. Click the card to open its switches.' },
      { route: 'settings/locations', title: 'The switches', target: '.modal-wrap .sw-row', side: 'bottom',
        text: 'Switch things on or off for this whole place — for example, take away <b>Buy from suppliers</b> from a shop. Nobody working there can do it, whatever their own switches say.' },
      { route: 'settings/locations', title: 'Close it', target: '.modal-wrap .modal-head [data-close]', side: 'bottom', done: (h) => !h.has('.modal-wrap'),
        text: 'Click ✕ to close without changing anything.' },
      { route: /^settings/, title: 'People', target: '.tabs a[href="#/settings/users"]', done: () => path() === 'settings/users',
        text: 'Now click <b>People</b>.' },
      { route: 'settings/users', title: 'Add a person', target: '#add', side: 'bottom',
        text: 'Click here to add someone: their <b>name</b>, <b>which place</b> they work at and a <b>PIN</b>. You can switch things off for just that person — never more than their place allows.' },
      { route: 'settings/users', title: 'Their PIN', target: '#view .tbl', side: 'top',
        text: 'Everyone taps their name and types their PIN at the computer. The list shows who has a PIN and what each person can do.' },
      { route: /^settings/, title: 'Devices', target: '.tabs a[href="#/settings/devices"]', done: () => path() === 'settings/devices',
        text: 'Click <b>Devices</b>.' },
      { route: 'settings/devices', title: 'Add a computer', target: '#add', side: 'bottom',
        text: 'To set up a shop or warehouse computer, click here to get a one-time <b>code</b>. Type it on that computer and it is connected. If a computer is lost, <b>Remove</b> it here.' },
    ],
  },
];

// ---------- The Training screen ----------
View('training', {
  title: 'Training',
  async render({ el }) {
    const list = Guides.filter((g) => g.show());
    el.innerHTML = `
      ${Practice.on ? `<div class="alert flex"><span>🎓 <b>Practice mode is on.</b> Everything you do is practice and will be removed when you finish.</span>
        <button class="btn danger" id="trFinish" style="margin-left:auto">Finish &amp; remove practice</button></div>` : ''}
      <div class="train-intro"><h2>Learn by doing</h2>
        <p>Pick a guide. Velanzo points at what to click and tells you what to do, step by step. It moves on by itself when you have done each step.</p>
        <p class="muted small">Guides marked <span class="pill blue">practice</span> use DEMO items on the real screens. When you finish, everything you did is removed — as if it never happened.</p></div>
      <div class="guide-grid">${list.map((g) => `<div class="card guide">
        <div class="g-icon">${icon(g.icon)}</div>
        <div class="g-body"><h3>${esc(g.title)}</h3><p>${esc(g.desc)}</p>
          <div class="g-meta"><span class="muted small">⏱ ${esc(g.time)}</span>${g.practice ? ' <span class="pill blue">practice</span>' : ''}</div></div>
        <button class="btn primary" data-guide="${g.id}">Start ${icon('arrow')}</button></div>`).join('')}</div>`;
    $$('[data-guide]', el).forEach((b) => b.addEventListener('click', () => Tour.start(b.dataset.guide)));
    const f = $('#trFinish', el);
    f && f.addEventListener('click', () => Practice.finishAsk());
  },
});
