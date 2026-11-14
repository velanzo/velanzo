// Delete Selected Data (More → Delete): records ticked on the lists are deleted one by one.
// A done bill, purchase or parcel is first undone the same way as "Reset to draft" (its stock goes back), then deleted.
// Staff may delete only their own place's records, with the same switches the cloud checks (see cloud part 12).
import * as D from '../db.js';
import { route, fail, toInt, can } from '../util.js';

const { all, get, run, tx } = D;

export const DELETE_KINDS = ['sales', 'purchases', 'dispatches', 'expenses', 'products', 'suppliers', 'customers'];

// What happens to one record: { action: 'delete' | 'reset' (undo its stock, then delete) | 'skip', why, label }
function check(user, kind, id) {
  const own = (loc) => user.owner || loc === user.location_id;
  const skip = (label, why) => ({ action: 'skip', label, why });
  switch (kind) {
    case 'sales': {
      const s = get('SELECT * FROM sales WHERE id = ?', id);
      if (!s) return skip('Bill', 'already deleted');
      const label = `Bill ${s.bill_no}`;
      if (!own(s.location_id)) return skip(label, 'it is from another shop');
      if (s.status === 'done') {
        if (!can(user, 'void_bills')) return skip(label, 'cancelling bills is switched off for you');
        return { action: 'reset', label };
      }
      if (!can(user, 'sell') && !can(user, 'void_bills')) return skip(label, 'selling is switched off for you');
      return { action: 'delete', label };
    }
    case 'purchases': {
      const p = get('SELECT * FROM purchases WHERE id = ?', id);
      if (!p) return skip('Purchase', 'already deleted');
      const label = `Purchase ${p.purchase_no}`;
      if (!own(p.location_id)) return skip(label, 'it is for another place');
      if (!can(user, 'buy')) return skip(label, 'buying is switched off for you');
      if (p.status === 'done') return user.owner ? { action: 'reset', label } : skip(label, 'its goods arrived: only the owner can undo it');
      return { action: 'delete', label };
    }
    case 'dispatches': {
      const d = get('SELECT * FROM dispatches WHERE id = ?', id);
      if (!d) return skip('Transfer', 'already deleted');
      const label = `Transfer ${d.dispatch_no}`;
      if (!own(d.from_location_id)) return skip(label, 'only the sending place can delete it');
      if (!can(user, 'send')) return skip(label, 'sending stock is switched off for you');
      if (d.status === 'received') return user.owner ? { action: 'reset', label } : skip(label, 'it was received: only the owner can undo it');
      if (d.status === 'in_transit') return { action: 'reset', label };
      return { action: 'delete', label };
    }
    case 'expenses': {
      const e = get('SELECT * FROM expenses WHERE id = ?', id);
      if (!e) return skip('Expense', 'already deleted');
      const label = `Expense ${e.category} ${e.amount}`;
      if (!user.owner && e.location_id !== user.location_id) return skip(label, 'it is for another place');
      if (!can(user, 'expenses')) return skip(label, 'expenses are switched off for you');
      return { action: 'delete', label };
    }
    case 'products': {
      const p = get('SELECT * FROM products WHERE id = ?', id);
      if (!p) return skip('Item', 'already deleted');
      const label = `Item ${p.name}${p.size ? ' ' + p.size : ''}${p.color ? ' ' + p.color : ''}`;
      if (!can(user, 'add_items') && !can(user, 'buy')) return skip(label, 'adding items is switched off for you');
      if (get('SELECT 1 AS x FROM sale_items WHERE product_id = ? UNION ALL SELECT 1 FROM purchase_items WHERE product_id = ? UNION ALL SELECT 1 FROM dispatch_items WHERE product_id = ? LIMIT 1', id, id, id)) {
        return skip(label, 'it is on bills, purchases or transfers');
      }
      if (!user.owner && get('SELECT 1 AS x FROM stock WHERE product_id = ? AND qty <> 0', id)) return skip(label, 'it still has stock: only the owner can delete it');
      return { action: 'delete', label };
    }
    case 'suppliers': {
      const s = get('SELECT * FROM suppliers WHERE id = ?', id);
      if (!s) return skip('Supplier', 'already deleted');
      const label = `Supplier ${s.name}`;
      if (!can(user, 'buy')) return skip(label, 'buying is switched off for you');
      if (get('SELECT 1 AS x FROM purchases WHERE supplier_id = ? UNION ALL SELECT 1 FROM supplier_payments WHERE supplier_id = ? LIMIT 1', id, id)) return skip(label, 'it has purchases or payments');
      return { action: 'delete', label };
    }
    case 'customers': {
      const c = get('SELECT * FROM customers WHERE id = ?', id);
      if (!c) return skip('Customer', 'already deleted');
      const label = `Customer ${c.name}`;
      if (!can(user, 'sell')) return skip(label, 'selling is switched off for you');
      if (get('SELECT 1 AS x FROM sales WHERE customer_id = ? UNION ALL SELECT 1 FROM customer_payments WHERE customer_id = ? LIMIT 1', id, id)) return skip(label, 'it has bills or payments');
      return { action: 'delete', label };
    }
    default: fail(400, 'Unknown kind of record: ' + kind);
  }
}

// Undoes a done record's stock (like Reset to draft), then deletes it with its lines.
function remove(user, kind, id, action) {
  const note = 'Deleted';
  switch (kind) {
    case 'sales': {
      const s = get('SELECT * FROM sales WHERE id = ?', id);
      if (action === 'reset') for (const i of all('SELECT * FROM sale_items WHERE sale_id = ?', id)) D.moveStock(i.product_id, s.location_id, i.qty, 'void', 'sale', id, user.id, `Bill ${s.bill_no} deleted`);
      for (const r of all('SELECT id FROM customer_payments WHERE sale_id = ?', id)) run('DELETE FROM customer_payments WHERE id = ?', r.id);
      for (const r of all('SELECT id FROM sale_items WHERE sale_id = ?', id)) run('DELETE FROM sale_items WHERE id = ?', r.id);
      run('DELETE FROM sales WHERE id = ?', id);
      break;
    }
    case 'purchases': {
      const p = get('SELECT * FROM purchases WHERE id = ?', id);
      if (action === 'reset') for (const l of all('SELECT * FROM purchase_items WHERE purchase_id = ?', id)) if (l.qty) D.moveStock(l.product_id, p.location_id, -l.qty, 'void', 'purchase', id, user.id, `Purchase ${p.purchase_no} deleted`);
      for (const r of all('SELECT id FROM purchase_items WHERE purchase_id = ?', id)) run('DELETE FROM purchase_items WHERE id = ?', r.id);
      run('DELETE FROM purchases WHERE id = ?', id);
      break;
    }
    case 'dispatches': {
      const d = get('SELECT * FROM dispatches WHERE id = ?', id);
      if (action === 'reset') {
        for (const i of all('SELECT * FROM dispatch_items WHERE dispatch_id = ?', id)) {
          if (d.status === 'received' && i.received_qty) D.moveStock(i.product_id, d.to_location_id, -i.received_qty, 'void', 'dispatch', id, user.id, `Transfer ${d.dispatch_no} deleted`);
          D.moveStock(i.product_id, d.from_location_id, i.qty, 'void', 'dispatch', id, user.id, `Transfer ${d.dispatch_no} deleted`);
        }
      }
      for (const r of all('SELECT id FROM dispatch_items WHERE dispatch_id = ?', id)) run('DELETE FROM dispatch_items WHERE id = ?', r.id);
      run('DELETE FROM dispatches WHERE id = ?', id);
      break;
    }
    case 'products':
      // (the owner: whatever is still in stock is taken out first, so every place's count stays right)
      for (const s of all('SELECT * FROM stock WHERE product_id = ? AND qty <> 0', id)) D.moveStock(id, s.location_id, -s.qty, 'adjust', null, null, user.id, `${note}: item deleted`);
      run('DELETE FROM products WHERE id = ?', id);
      break;
    default:
      run(`DELETE FROM ${kind} WHERE id = ?`, id);
  }
}

const items = (body) => (Array.isArray(body.items) ? body.items : []).slice(0, 5000).map((x) => ({ kind: String(x.kind), id: toInt(x.id) }));

route('POST', '/api/delete/check', 'any', ({ body, user }) => items(body).map((x) => ({ ...x, ...check(user, x.kind, x.id) })));

route('POST', '/api/delete/run', 'any', ({ body, user }) => tx(() => {
  const out = { deleted: 0, undone: 0, skipped: [] };
  for (const x of items(body)) {
    const c = check(user, x.kind, x.id);
    if (c.action === 'skip') { out.skipped.push({ ...x, ...c }); continue; }
    D.beginGroup(); // each record goes to the cloud on its own: one refused never holds back the others
    remove(user, x.kind, x.id, c.action);
    out.deleted++;
    if (c.action === 'reset') out.undone++;
  }
  return out;
}));
