'use strict';
// Barcode labels: build a list (from a purchase, selected products or scanning) and print.

const LABEL_KEY = 'vz_labels';
function getLabelQueue() { try { return JSON.parse(localStorage.getItem(LABEL_KEY) || '[]'); } catch { return []; } }
function setLabelQueue(q) { try { localStorage.setItem(LABEL_KEY, JSON.stringify(q)); } catch { /* ignore */ } }
function addToLabelQueue(items, replace = false) {
  const q = replace ? [] : getLabelQueue();
  for (const it of items) {
    const p = it.product;
    const ex = q.find((x) => x.product.id === p.id);
    if (ex) ex.copies += it.copies;
    else q.push({ product: { id: p.id, name: p.name, size: p.size, color: p.color, barcode: p.barcode, sale_price: p.sale_price }, copies: it.copies });
  }
  setLabelQueue(q);
}

View('labels', {
  title: 'Barcode labels',
  allow: () => can('add_items') || can('buy'),
  async render({ el }) {
    const S = App.settings;
    let queue = getLabelQueue();
    const purchases = await GET('/api/purchases', { from: addDays(todayStr(), -60) });
    el.innerHTML = `
      <div class="alert info flex"><span>Labels: <b>${esc(S.label_width)} × ${esc(S.label_height)} mm</b>, ${S.label_mode === 'a4' ? `A4 sticker sheet, ${esc(S.label_columns)} across` : 'label printer (one label per sticker)'}.</span>
        ${isAdmin() ? '<a href="#/settings/printing" style="margin-left:auto">Change label size</a>' : ''}</div>
      <div class="grid-2" style="margin-top:0;grid-template-columns:1fr 320px">
        <div class="card">
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <div class="grow" style="min-width:240px"><input class="input scan-input" id="scan" placeholder="Scan or search an item to add a label…" autocomplete="off"></div>
            <select class="input" id="fromPur" style="width:auto;height:50px"><option value="">+ Add all items from a purchase…</option>
              ${purchases.filter((p) => p.status === 'done').map((p) => `<option value="${p.id}">${esc(p.purchase_no)} · ${esc(fmtDate(p.date))} · ${esc(p.supplier_name || '')} (${p.total_qty} pcs)</option>`).join('')}</select>
          </div>
          <div id="qList" style="margin-top:14px"></div>
        </div>
        <div class="card" style="text-align:center"><h3>Preview</h3><div id="prev" class="muted">Add an item to see the label.</div>
          <div class="hint" style="margin-top:12px">Tip: set the printer's paper size to the label size in Windows printer settings, and turn off headers/footers and margins in the print window.</div></div>
      </div>`;

    function render() {
      setLabelQueue(queue);
      const total = queue.reduce((a, x) => a + (Number(x.copies) || 0), 0);
      $('#qList', el).innerHTML = queue.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Barcode</th><th class="r">Price</th><th class="c">Labels</th><th></th></tr></thead><tbody>
        ${queue.map((x, i) => `<tr><td><b>${esc(x.product.name)}</b> <span class="muted">${esc(variantText(x.product))}</span></td><td class="mono">${esc(x.product.barcode)}</td><td class="r">${money(x.product.sale_price)}</td>
          <td class="c"><div class="qty"><button data-dec="${i}">−</button><input data-c="${i}" value="${x.copies}" inputmode="numeric"><button data-inc="${i}">+</button></div></td>
          <td><button class="icon-btn" data-rm="${i}">✕</button></td></tr>`).join('')}</tbody></table></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">
          <button class="btn ghost" id="clr">Clear list</button>
          <button class="btn" id="one">Print 1 of each (test)</button>
          <button class="btn primary lg" id="printBtn">${icon('printer')} Print ${total} label${total === 1 ? '' : 's'}</button></div>`
        : '<div class="empty">The list is empty. Scan an item, pick a purchase above, or select items on the Products page.</div>';
      $('#prev', el).innerHTML = queue.length ? labelPreviewHtml(queue[0].product) : 'Add an item to see the label.';
    }
    async function freshQueue() {
      // use today's name & price, in case they changed after the item was added to the list
      const list = await ProductCache.load('', true);
      const byId = new Map(list.map((p) => [p.id, p]));
      queue = queue.map((x) => ({ ...x, product: byId.get(x.product.id) || x.product }));
      render();
      return queue;
    }
    attachPicker($('#scan', el), {
      showStock: false,
      onPick: (p) => {
        const ex = queue.find((x) => x.product.id === p.id);
        if (ex) ex.copies++; else queue.push({ product: p, copies: 1 });
        render();
      },
    });
    ProductCache.load('', true).catch(() => {});
    $('#fromPur', el).addEventListener('change', async (e) => {
      if (!e.target.value) return;
      const p = await GET('/api/purchases/' + e.target.value);
      e.target.value = '';
      addToLabelQueue(p.items.map((i) => ({ product: { id: i.product_id, name: i.name, size: i.size, color: i.color, barcode: i.barcode, sale_price: i.sale_price }, copies: i.qty })));
      queue = getLabelQueue();
      render();
      toast(`Added ${p.total_qty} labels from ${p.purchase_no}`);
    });
    $('#qList', el).addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.inc !== undefined) queue[+b.dataset.inc].copies++;
      else if (b.dataset.dec !== undefined) queue[+b.dataset.dec].copies = Math.max(0, queue[+b.dataset.dec].copies - 1);
      else if (b.dataset.rm !== undefined) queue.splice(+b.dataset.rm, 1);
      else if (b.id === 'clr') { if (!(await confirmBox('Remove all items from the label list?', { ok: 'Clear', danger: true }))) return; queue = []; }
      else if (b.id === 'printBtn') { await busy(b, freshQueue); return printLabels(queue.map((x) => ({ product: x.product, copies: Number(x.copies) || 0 }))); }
      else if (b.id === 'one') { await busy(b, freshQueue); return printLabels(queue.map((x) => ({ product: x.product, copies: 1 }))); }
      else return;
      render();
    });
    $('#qList', el).addEventListener('change', (e) => {
      if (e.target.dataset.c === undefined) return;
      queue[+e.target.dataset.c].copies = Math.max(0, parseInt(e.target.value, 10) || 0);
      render();
    });
    render();
    $('#scan', el).focus();
  },
});
