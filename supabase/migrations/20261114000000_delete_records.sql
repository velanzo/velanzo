-- Velanzo cloud database, part 12: Delete Selected Data (More -> Delete).
-- Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).
-- Until now only the owner could delete records. Now shop and warehouse people may delete their OWN place's bills,
-- purchases, transfers and expenses (and items, suppliers and customers nothing points at), with the same switches as
-- for making them. A done bill needs "Cancel bills"; a purchase whose goods arrived or a received transfer stays owner-only.

create or replace function _staff_delete_check(c vz_ctx, t text, old jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  L bigint := c.location_id;
  v_id bigint := (old ->> 'id')::bigint;
begin
  case t
    when 'sales' then
      if (old ->> 'location_id')::bigint is distinct from L then perform _deny('This bill is from another shop.'); end if;
      if old ->> 'status' = 'done' then perform _need(c, 'void_bills', 'Cancelling bills');
      elsif not ('sell' = any(c.perms) or 'void_bills' = any(c.perms)) then perform _deny('Selling is switched off for this person or place.'); end if;
    when 'customer_payments' then
      if (old ->> 'location_id')::bigint is distinct from L then perform _deny('This payment is from another shop.'); end if;
      perform _need(c, 'sell', 'Selling');
    when 'purchases' then
      if (old ->> 'location_id')::bigint is distinct from L then perform _deny('This purchase is for another place.'); end if;
      perform _need(c, 'buy', 'Buying from suppliers');
      if old ->> 'status' = 'done' then perform _deny('Only the owner can delete a purchase whose goods arrived.'); end if;
    when 'dispatches' then
      if (old ->> 'from_location_id')::bigint is distinct from L then perform _deny('Only the sending place can delete this transfer.'); end if;
      perform _need(c, 'send', 'Sending stock');
      if old ->> 'status' = 'received' then perform _deny('Only the owner can delete a transfer that was received.'); end if;
    when 'expenses' then
      if (old ->> 'location_id')::bigint is distinct from L then perform _deny('This expense is for another place.'); end if;
      perform _need(c, 'expenses', 'Expenses');
    when 'products' then
      if not ('add_items' = any(c.perms) or 'buy' = any(c.perms)) then perform _deny('Adding and changing items is switched off for this person or place.'); end if;
      if exists (select 1 from sale_items where product_id = v_id) or exists (select 1 from purchase_items where product_id = v_id)
         or exists (select 1 from dispatch_items where product_id = v_id) then
        raise exception 'VZ:conflict:% is on bills, purchases or transfers, so it was not deleted.', old ->> 'name';
      end if;
      if exists (select 1 from stock where product_id = v_id and qty <> 0) then perform _deny('This item still has stock: only the owner can delete it.'); end if;
    when 'suppliers' then
      perform _need(c, 'buy', 'Buying from suppliers');
      if exists (select 1 from purchases where supplier_id = v_id) or exists (select 1 from supplier_payments where supplier_id = v_id) then
        raise exception 'VZ:conflict:% has purchases or payments, so the supplier was not deleted.', old ->> 'name';
      end if;
    when 'customers' then
      perform _need(c, 'sell', 'Selling');
      if exists (select 1 from sales where customer_id = v_id) or exists (select 1 from customer_payments where customer_id = v_id) then
        raise exception 'VZ:conflict:% has bills or payments, so the customer was not deleted.', old ->> 'name';
      end if;
    else perform _deny('Only the owner can delete records.');
  end case;
end $$;
revoke execute on function _staff_delete_check(vz_ctx, text, jsonb) from public, anon, authenticated;

-- A shop or warehouse person deletes one record. Lines are checked through their bill, purchase or transfer
-- (which may already be gone: it can be deleted first in the same action).
create or replace function _staff_delete(c vz_ctx, t text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  old jsonb;
  par jsonb;
  pt text;
begin
  execute format('select to_jsonb(x) from %I x where id::text = $1', t) into old using p_key;
  if old is null then return; end if; -- (already gone, or never reached the cloud)
  if t in ('sale_items', 'purchase_items', 'dispatch_items') then
    pt := case t when 'sale_items' then 'sales' when 'purchase_items' then 'purchases' else 'dispatches' end;
    execute format('select to_jsonb(x) from %I x where id::text = $1', pt) into par
      using old ->> case t when 'sale_items' then 'sale_id' when 'purchase_items' then 'purchase_id' else 'dispatch_id' end;
    if par is not null then perform _staff_delete_check(c, pt, par); end if;
  else
    perform _staff_delete_check(c, t, old);
  end if;
  execute format('delete from %I where id::text = $1', t) using p_key;
  insert into tombstones as tb (tbl, k) values (t, p_key) on conflict (tbl, k) do update set k = excluded.k;
end $$;
revoke execute on function _staff_delete(vz_ctx, text, text) from public, anon, authenticated;

-- _apply as in part 11 (customers), plus: deletions by shop and warehouse people go through _staff_delete.
create or replace function _apply(c vz_ctx, t text, r jsonb, del boolean, del_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_key text := coalesce(del_key, r ->> 'id');
  old jsonb;
  cols text[];
  is_new boolean;
begin
  if del and not c.owner and t in ('sales', 'sale_items', 'customer_payments', 'purchases', 'purchase_items', 'dispatches', 'dispatch_items',
                                   'expenses', 'products', 'suppliers', 'customers') then
    perform _staff_delete(c, t, coalesce(del_key, r ->> 'id'));
    return;
  end if;
  if t not in ('customers', 'customer_payments') then
    perform _apply_core(c, t, r, del, del_key);
    return;
  end if;
  if v_key is null then raise exception 'VZ:bad:A % record has no id', t; end if;
  execute format('select to_jsonb(x) from %I x where id::text = $1', t) into old using v_key;
  is_new := old is null;
  if is_new and not del and exists (select 1 from tombstones tb where tb.tbl = t and tb.k = v_key) then
    raise exception 'VZ:conflict:This % was deleted on another computer, so the change could not be saved.', _record_name(t);
  end if;

  if del then
    if not c.owner then perform _deny('Only the owner can delete records.'); end if;
    if not is_new then
      if t = 'customers' and (exists (select 1 from sales where customer_id = v_key::bigint)
                              or exists (select 1 from customer_payments where customer_id = v_key::bigint)) then
        raise exception 'VZ:conflict:% has bills or payments, so the customer was not deleted.', old ->> 'name';
      end if;
      execute format('delete from %I where id::text = $1', t) using v_key;
      insert into tombstones as tb (tbl, k) values (t, v_key) on conflict (tbl, k) do update set k = excluded.k;
    end if;
    return;
  end if;

  if t = 'customers' then
    if not c.owner then
      if not ('sell' = any(c.perms)) then perform _deny('Adding customers is for people who sell.'); end if;
      cols := array['name', 'phone', 'address', 'notes'];
    end if;
  else
    -- a payment is history: once written it never changes
    if not is_new then return; end if;
    if not exists (select 1 from customers where id = (r ->> 'customer_id')::bigint) then
      raise exception 'VZ:conflict:The customer of this payment is not in the cloud.';
    end if;
    if r ->> 'sale_id' is not null and not exists (select 1 from sales where id = (r ->> 'sale_id')::bigint) then
      raise exception 'VZ:conflict:The bill of this payment is not in the cloud.';
    end if;
    if not c.owner then
      if not ('sell' = any(c.perms)) then perform _deny('Taking customer payments is for people who sell.'); end if;
      if (r ->> 'location_id')::bigint is distinct from c.location_id then perform _deny('Payments can only be taken for this device''s own shop.'); end if;
    end if;
  end if;

  if is_new then
    execute format('insert into %I select * from jsonb_populate_record(null::%I, $1)', t, t) using r;
  else
    if cols is null then
      select array_agg(a.attname::text) into cols from pg_attribute a
      where a.attrelid = t::regclass and a.attnum > 0 and not a.attisdropped
        and a.attname::text not in ('id', 'rev', 'synced_at') and r ? a.attname::text;
    end if;
    cols := array(select c2 from unnest(cols) c2 where r ? c2);
    if array_length(cols, 1) > 0 then
      execute format('update %I set (%s) = (select %s from jsonb_populate_record(null::%I, $1)) where id::text = $2',
        t, (select string_agg(quote_ident(x), ', ') from unnest(cols) x), (select string_agg(quote_ident(x), ', ') from unnest(cols) x), t)
        using r, v_key;
    else
      execute format('update %I set id = id where id::text = $1', t) using v_key;
    end if;
  end if;
end $$;
revoke execute on function _apply(vz_ctx, text, jsonb, boolean, text) from public, anon, authenticated;
