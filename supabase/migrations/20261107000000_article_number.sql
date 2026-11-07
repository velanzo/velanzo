-- Velanzo cloud database, part 10: an item's article number (its style code, printed on the label).
-- Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).

alter table products add column if not exists article_no text;

create or replace function _apply(c vz_ctx, t text, r jsonb, del boolean, del_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  kc text := case when t = 'settings' then 'key' else 'id' end;
  v_key text := coalesce(del_key, r ->> kc);
  old jsonb;
  par jsonb;
  cols text[];
  L bigint := c.location_id;
  is_new boolean;
begin
  if t not in ('settings', 'locations', 'users', 'suppliers', 'products', 'movements', 'purchases', 'purchase_items',
    'supplier_payments', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses', 'vouchers') then
    raise exception 'VZ:bad:Unknown kind of record: %', t;
  end if;
  if v_key is null then raise exception 'VZ:bad:A % record has no id', t; end if;
  execute format('select to_jsonb(x) from %I x where %I::text = $1', t, kc) into old using v_key;
  is_new := old is null;

  -- Deleted on another computer: a change made without knowing that cannot bring it back.
  if is_new and not del and t <> 'settings' and exists (select 1 from tombstones tb where tb.tbl = t and tb.k = v_key) then
    raise exception 'VZ:conflict:This % was deleted on another computer, so the change could not be saved.', _record_name(t);
  end if;
  -- A document (order, parcel, bill) changed on old information: another computer changed it first. Refused as a whole
  -- action, stock moves included, so nothing is ever received or cancelled twice. (A computer never clashes with itself.)
  if not is_new and not del and t in ('purchases', 'dispatches', 'sales') and r ? '_base'
     and (old ->> 'rev') is distinct from (r ->> '_base') and (old ->> 'changed_by') is distinct from c.device_id::text then
    raise exception 'VZ:conflict:% % was changed on another computer first, so this change was not applied. Check it and do it again if it is still needed.',
      initcap(_record_name(t)), coalesce(old ->> 'purchase_no', old ->> 'dispatch_no', old ->> 'bill_no', '');
  end if;

  if del then
    if not c.owner then
      -- a place may take lines out of its own purchase order or parcel until it is done; nothing else is deleted except by the owner
      if t not in ('purchase_items', 'dispatch_items') then perform _deny('Only the owner can delete records.'); end if;
      if is_new then return; end if; -- (a line made and taken out again before it reached the cloud)
      if t = 'purchase_items' then
        perform _need(c, 'buy', 'Buying from suppliers');
        select to_jsonb(p) into par from purchases p where p.id = (old ->> 'purchase_id')::bigint;
        if par is null or par ->> 'status' not in ('draft', 'ordered') or (par ->> 'location_id')::bigint is distinct from L then perform _deny('Only lines of a draft or an order can be removed.'); end if;
      else
        perform _need(c, 'send', 'Sending stock');
        select to_jsonb(d) into par from dispatches d where d.id = (old ->> 'dispatch_id')::bigint;
        if par is null or par ->> 'status' not in ('draft', 'in_transit') or (par ->> 'from_location_id')::bigint is distinct from L then perform _deny('Only lines of a draft parcel can be removed.'); end if;
      end if;
    end if;
    if not is_new then
      -- another computer may have used it in the meantime
      if (t = 'locations' and (exists (select 1 from users where location_id = v_key::bigint)
            or exists (select 1 from devices where location_id = v_key::bigint and active = 1)
            or exists (select 1 from stock where location_id = v_key::bigint and qty <> 0)
            or exists (select 1 from movements where location_id = v_key::bigint)
            or exists (select 1 from sales where location_id = v_key::bigint)
            or exists (select 1 from purchases where location_id = v_key::bigint)
            or exists (select 1 from expenses where location_id = v_key::bigint)
            or exists (select 1 from dispatches where from_location_id = v_key::bigint or to_location_id = v_key::bigint)))
         or (t = 'users' and (exists (select 1 from movements where user_id = v_key::bigint)
            or exists (select 1 from sales where user_id = v_key::bigint)
            or exists (select 1 from purchases where user_id = v_key::bigint)
            or exists (select 1 from supplier_payments where user_id = v_key::bigint)
            or exists (select 1 from expenses where user_id = v_key::bigint)
            or exists (select 1 from vouchers where user_id = v_key::bigint)
            or exists (select 1 from dispatches where created_by = v_key::bigint or received_by = v_key::bigint)))
         or (t = 'vouchers' and exists (select 1 from sales where voucher_code = old ->> 'code')) then
        raise exception 'VZ:conflict:% was used on another computer in the meantime, so it was not deleted. Close or switch it off instead.', coalesce(old ->> 'name', old ->> 'code');
      end if;
      execute format('delete from %I where %I::text = $1', t, kc) using v_key;
      insert into tombstones as tb (tbl, k) values (t, v_key) on conflict (tbl, k) do update set k = excluded.k;
    end if;
    return;
  end if;

  -- history lines and bill/purchase lines never change once written
  if not is_new and t in ('movements', 'supplier_payments', 'sale_items') then return; end if;
  -- what a new record points at must be in the cloud (it may have been deleted or refused meanwhile)
  if is_new then
    if (t in ('sales', 'purchases', 'movements') and not exists (select 1 from locations where id = (r ->> 'location_id')::bigint))
       or (t = 'expenses' and r ->> 'location_id' is not null and not exists (select 1 from locations where id = (r ->> 'location_id')::bigint))
       or (t = 'dispatches' and (not exists (select 1 from locations where id = (r ->> 'from_location_id')::bigint)
                                 or not exists (select 1 from locations where id = (r ->> 'to_location_id')::bigint))) then
      raise exception 'VZ:conflict:The shop or warehouse of this % was deleted on another computer.', _record_name(t);
    end if;
    if t in ('movements', 'sale_items', 'purchase_items', 'dispatch_items') and not exists (select 1 from products where id = (r ->> 'product_id')::bigint) then
      raise exception 'VZ:conflict:An item on this % is not in the cloud (it was refused or deleted on another computer).', _record_name(t);
    end if;
    if (t = 'sale_items' and not exists (select 1 from sales where id = (r ->> 'sale_id')::bigint))
       or (t = 'purchase_items' and not exists (select 1 from purchases where id = (r ->> 'purchase_id')::bigint))
       or (t = 'dispatch_items' and not exists (select 1 from dispatches where id = (r ->> 'dispatch_id')::bigint)) then
      raise exception 'VZ:conflict:The document of this % is not in the cloud.', _record_name(t);
    end if;
  end if;
  -- a purchase line can change only while it belongs to a purchase order (it is counted when the goods arrive)
  -- (the owner may: resetting received goods to a draft makes their lines editable again)
  if not is_new and t = 'purchase_items' and old ->> 'ordered_qty' is null and not c.owner then return; end if;

  if not c.owner then
    case t
    when 'settings', 'locations' then
      perform _deny('Only the owner can change settings, shops and the warehouse.');
    when 'vouchers' then
      perform _deny('Only the owner can make or change vouchers.');
    when 'users' then
      -- people may change their own PIN, and nobody but the owner may touch an owner's row (even from a shop computer)
      if is_new or (r ->> 'id')::bigint is distinct from c.user_id or old ->> 'role' is distinct from 'staff' then perform _deny('Only the owner can add or change people.'); end if;
      cols := array['pin_salt', 'pin_hash'];  -- people may change their own PIN
    when 'suppliers' then
      perform _need(c, 'buy', 'Buying from suppliers');
      cols := array['name', 'phone', 'address', 'notes'];
    when 'supplier_payments' then
      perform _need(c, 'buy', 'Paying suppliers');
    when 'products' then
      if not ('add_items' = any(c.perms) or 'buy' = any(c.perms)) then perform _deny('Adding and changing items is switched off for this person or place.'); end if;
      cols := array['name', 'category', 'size', 'color', 'barcode', 'sale_price', 'active', 'updated_at', 'article_no'];
      if 'see_cost' = any(c.perms) or 'buy' = any(c.perms) then cols := cols || array['cost_price']; end if;
    when 'movements' then
      if (r ->> 'location_id')::bigint is distinct from L then perform _deny('Stock can only be changed at this device''s own place.'); end if;
      case r ->> 'type'
        when 'sale' then perform _need(c, 'sell', 'Selling');
        when 'return' then perform _need(c, 'returns', 'Taking returns');
        when 'purchase' then perform _need(c, 'buy', 'Buying from suppliers');
        when 'dispatch_out' then perform _need(c, 'send', 'Sending stock');
        when 'dispatch_in' then perform _need(c, 'receive', 'Receiving stock');
        when 'adjust' then perform _need(c, 'correct_stock', 'Correcting stock');
        when 'opening' then
          if not ('add_items' = any(c.perms) or 'buy' = any(c.perms)) then perform _deny('Adding items is switched off for this person or place.'); end if;
        when 'void' then
          case r ->> 'ref_type'
            when 'sale' then perform _need(c, 'void_bills', 'Cancelling bills');
            when 'dispatch' then perform _need(c, 'send', 'Cancelling dispatches');
            else perform _deny('Only the owner can cancel this.');
          end case;
        else perform _deny('Unknown kind of stock change.');
      end case;
    when 'purchases' then
      perform _need(c, 'buy', 'Buying from suppliers');
      if is_new then
        if (r ->> 'location_id')::bigint is distinct from L then perform _deny('Purchases can only be entered for this device''s own place.'); end if;
      elsif (old ->> 'location_id')::bigint is distinct from L then
        perform _deny('This purchase is for another place.');
      elsif old ->> 'status' in ('draft', 'ordered') and r ->> 'status' in ('draft', 'ordered', 'done', 'void') then
        -- a draft or an order: changed, confirmed, reset to draft, received or cancelled
        cols := array['status', 'supplier_id', 'invoice_no', 'date', 'expected_date', 'notes', 'total', 'total_qty', 'paid', 'received_at'];
      elsif old ->> 'status' is not distinct from r ->> 'status' then
        cols := array['notes']; -- the same record again: only the notes may differ
      else
        perform _deny('Only the owner can cancel or reset a purchase whose goods arrived.');
      end if;
    when 'purchase_items' then
      perform _need(c, 'buy', 'Buying from suppliers');
      select to_jsonb(p) into par from purchases p where p.id = (r ->> 'purchase_id')::bigint;
      if par is null or (par ->> 'location_id')::bigint is distinct from L then perform _deny('This purchase is from another place.'); end if;
      if not is_new then cols := array['qty', 'cost', 'ordered_qty', 'planned_price']; end if;
    when 'dispatches' then
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (r ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
      elsif (old ->> 'from_location_id')::bigint = L and old ->> 'status' in ('draft', 'in_transit') and r ->> 'status' in ('draft', 'in_transit', 'cancelled') then
        -- the sender: a draft changed or sent, a parcel on the way reset to draft or cancelled
        perform _need(c, 'send', 'Sending stock');
        cols := array['status', 'to_location_id', 'notes', 'total_qty', 'total_value', 'created_at'];
      elsif (old ->> 'to_location_id')::bigint = L and r ->> 'status' = 'received' and old ->> 'status' = 'in_transit' then
        perform _need(c, 'receive', 'Receiving stock');
        cols := array['status', 'received_qty', 'received_by', 'received_at'];
      elsif L in ((old ->> 'from_location_id')::bigint, (old ->> 'to_location_id')::bigint) and old ->> 'status' is not distinct from r ->> 'status' then
        cols := array['notes']; -- the same record again
      else
        perform _deny('This dispatch can''t be changed from here (only the owner can reset a received one).');
      end if;
    when 'dispatch_items' then
      select to_jsonb(d) into par from dispatches d where d.id = (coalesce(old, r) ->> 'dispatch_id')::bigint;
      if par is null then perform _deny('Unknown dispatch.'); end if;
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (par ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
      elsif (par ->> 'from_location_id')::bigint = L then
        perform _need(c, 'send', 'Sending stock');
        if par ->> 'status' not in ('draft', 'in_transit') then perform _deny('This parcel was already received.'); end if;
        cols := array['qty', 'price', 'received_qty']; -- the sender's lines (received_qty only goes back to empty on a reset)
      else
        perform _need(c, 'receive', 'Receiving stock');
        if (par ->> 'to_location_id')::bigint is distinct from L then perform _deny('Only the receiving place can count this dispatch.'); end if;
        cols := array['received_qty'];
      end if;
    when 'sales' then
      if is_new then
        perform _need(c, 'sell', 'Selling');
        if (r ->> 'location_id')::bigint is distinct from L then perform _deny('Bills can only be made for this device''s own shop.'); end if;
        if coalesce((r ->> 'discount')::numeric, 0) > 0 then perform _need(c, 'discount', 'Giving discounts'); end if;
      else
        perform _need(c, 'void_bills', 'Cancelling bills');
        if (old ->> 'location_id')::bigint is distinct from L then perform _deny('This bill is from another shop.'); end if;
        cols := array['status', 'void_reason', 'voided_by', 'voided_at'];
      end if;
    when 'sale_items' then
      select to_jsonb(s) into par from sales s where s.id = (r ->> 'sale_id')::bigint;
      if par is null or (par ->> 'location_id')::bigint is distinct from L then perform _deny('This bill is from another shop.'); end if;
      if (r ->> 'qty')::integer < 0 then perform _need(c, 'returns', 'Taking returns'); end if;
      if (r ->> 'list_price') is not null and (r ->> 'list_price')::numeric > (r ->> 'price')::numeric then perform _need(c, 'discount', 'Giving discounts'); end if;
      -- the cost of what was sold comes from the cloud's own price list (the shop may not see costs)
      r := r || jsonb_build_object('cost', (select cost_price from products where id = (r ->> 'product_id')::bigint));
    when 'expenses' then
      perform _need(c, 'expenses', 'Recording expenses');
      if (coalesce(old, r) ->> 'location_id')::bigint is distinct from L then perform _deny('Expenses can only be recorded for this device''s own place.'); end if;
      cols := array['date', 'category', 'amount', 'note'];
    end case;
  end if;

  if is_new then
    if t = 'dispatch_items' and not c.owner then
      r := r || jsonb_build_object('cost', (select cost_price from products where id = (r ->> 'product_id')::bigint));
    end if;
    execute format('insert into %I select * from jsonb_populate_record(null::%I, $1)', t, t) using r;
  else
    if cols is null then -- the owner may change every column sent
      select array_agg(a.attname::text) into cols from pg_attribute a
      where a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped
        and a.attname::text not in (kc, 'rev', 'synced_at') and r ? a.attname::text;
    end if;
    -- a computer may change only the allowed columns it actually sent (a missing one is left as it is)
    if cols is not null then cols := array(select c2 from unnest(cols) c2 where r ? c2); end if;
    if cols is not null and array_length(cols, 1) > 0 then
      execute format('update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where %I::text = $2',
        t, (select string_agg(quote_ident(x), ', ') from unnest(cols) x), (select string_agg(quote_ident(x), ', ') from unnest(cols) x), t, kc)
        using r, v_key;
    else
      -- nothing was changed (or nothing it may change): the record still comes back, so the computer ends up with what the cloud has
      execute format('update %I set %I = %I where %I::text = $1', t, kc, kc, kc) using v_key;
    end if;
  end if;
  if t in ('purchases', 'dispatches', 'sales') then
    execute format('update %I set changed_by = $1 where id = $2::bigint', t) using c.device_id, v_key;
  end if;
  if t = 'movements' then
    insert into _touched values ((r ->> 'location_id')::bigint, (r ->> 'product_id')::bigint);
  end if;
end $$;
