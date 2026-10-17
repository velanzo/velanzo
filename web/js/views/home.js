'use strict';
// Home for people who don't sell (e.g. the warehouse): one big button per job, and what's on the way.

View('home', {
  title: () => locName(App.user.location_id) || 'Home',
  allow: () => !isAdmin(),
  async render({ el }) {
    const tiles = [
      can('buy') && ['purchases/new', 'bag', 'Purchase', 'Enter what came from a supplier'],
      (can('add_items') || can('buy')) && ['labels', 'printer', 'Print labels', 'Barcode stickers for items'],
      can('send') && ['dispatch/new', 'truck', 'Send to a shop', 'Scan items into a parcel'],
      can('receive') && ['dispatch', 'inbox', 'Receive stock', 'Check a parcel that arrived'],
      can('sell') && ['pos', 'cart', 'Sale order', 'Make a bill'],
      ['stock', 'box', 'Stock', 'What is here and at each shop'],
      can('expenses') && ['expenses', 'wallet', 'Expenses', 'Tea, transport, bills'],
    ].filter(Boolean);
    const here = App.user.location_id;
    const rows = await GET('/api/dispatches', { status: 'in_transit' });
    const coming = rows.filter((d) => d.to_location_id === here);
    const going = rows.filter((d) => d.from_location_id === here);
    el.innerHTML = `
      ${coming.map((d) => `<div class="alert info flex">${icon('truck')}<div class="grow"><b>${esc(d.dispatch_no)}</b> from ${esc(d.from_name)} — ${d.total_qty} pieces</div>
        ${can('receive') ? `<a class="btn primary" href="#/dispatch/${d.id}/receive">Check & receive</a>` : ''}</div>`).join('')}
      <div class="tiles">${tiles.map(([href, ic, title, sub]) => `<a class="tile" href="#/${href}">${icon(ic)}<b>${esc(title)}</b><span>${esc(sub)}</span></a>`).join('')}</div>
      <h3 style="margin-top:22px">On the way</h3>
      <div class="card flush">${going.length ? `<div class="list">${going.map((d) => `<a class="list-row" href="#/dispatch/${d.id}">${icon('truck')}
          <span class="grow"><b>${esc(d.dispatch_no)}</b> to ${esc(d.to_name)} · ${d.total_qty} pieces</span><span class="muted">sent ${esc(fmtDT(d.created_at))}</span></a>`).join('')}</div>`
        : '<div class="empty">Nothing sent is on the way right now.</div>'}</div>`;
  },
});
