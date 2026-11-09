-- Velanzo cloud database, part 11: customers, bills confirmed now and paid later, and the payments customers bring.
-- Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).
-- A bill's open balance = total − what was paid at the counter − its customer payments.

create table if not exists customers (id bigint primary key, name text not null, phone text, address text, notes text,
  created_at text not null, rev bigint, synced_at timestamptz);
create table if not exists customer_payments (id bigint primary key, customer_id bigint not null, sale_id bigint, location_id bigint not null,
  date text not null, amount double precision not null, method text, note text, user_id bigint, created_at text not null,
  rev bigint, synced_at timestamptz);
create index if not exists customer_payments_sale on customer_payments (sale_id);
alter table sales add column if not exists customer_id bigint;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'customers_stamp') then
    create trigger customers_stamp before insert or update on customers for each row execute function _stamp();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'customer_payments_stamp') then
    create trigger customer_payments_stamp before insert or update on customer_payments for each row execute function _stamp();
  end if;
end $$;
alter table customers enable row level security;
alter table customer_payments enable row level security;
revoke all on customers, customer_payments from anon, authenticated;

create or replace function _record_name(t text) returns text language sql immutable as $$
  select case t when 'purchases' then 'purchase' when 'dispatches' then 'parcel' when 'sales' then 'bill' when 'products' then 'item'
    when 'suppliers' then 'supplier' when 'locations' then 'place' when 'users' then 'person' when 'vouchers' then 'voucher'
    when 'expenses' then 'expense' when 'movements' then 'stock change' when 'sale_items' then 'bill line'
    when 'purchase_items' then 'purchase line' when 'dispatch_items' then 'parcel line' when 'supplier_payments' then 'payment'
    when 'customers' then 'customer' when 'customer_payments' then 'customer payment' else 'record' end
$$;
revoke execute on function _record_name(text) from public, anon, authenticated;

-- The rules for every other kind of record stay in _apply_core (the _apply of the parts before this one);
-- _apply handles customers and their payments and hands everything else on.
-- (A later part that redefines _apply must keep this: rename the old one to _apply_core again, as below.)
do $$ begin
  if exists (select 1 from pg_proc where proname = '_apply_core') then
    drop function _apply_core(vz_ctx, text, jsonb, boolean, text);
  end if;
  alter function _apply(vz_ctx, text, jsonb, boolean, text) rename to _apply_core;
end $$;
revoke execute on function _apply_core(vz_ctx, text, jsonb, boolean, text) from public, anon, authenticated;

create or replace function _apply(c vz_ctx, t text, r jsonb, del boolean, del_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_key text := coalesce(del_key, r ->> 'id');
  old jsonb;
  cols text[];
  is_new boolean;
begin
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

-- Downloads now include customers (every computer that sells) and customer payments (each shop its own, the owner all).
-- v 10: computers download everything again once, so they get the customers made before they updated.
create or replace function pull(p_device integer, p_user bigint, p_since bigint, p_limit integer default 2000, p_now text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c vz_ctx;
  v_owner boolean;
  v_loc bigint;
  v_perms text[];
  v_cost boolean;
  v_buy boolean;
  v_sell boolean;
  out_rows jsonb;
  max_rev bigint;
  n integer;
  epoch text;
begin
  perform _follow_user(p_device, p_user);
  c := _context(p_device, p_user);
  v_owner := c.owner; v_loc := c.location_id; v_perms := c.place_perms;
  v_cost := v_owner or 'see_cost' = any(v_perms) or 'buy' = any(v_perms);
  v_buy := v_owner or 'buy' = any(v_perms);
  v_sell := v_owner or 'sell' = any(v_perms);
  with x (t, rev, r) as (
    select 'settings', s.rev, to_jsonb(s) from settings s where s.rev > p_since
    union all select 'locations', x.rev, to_jsonb(x) from locations x where x.rev > p_since
    -- everyone's name (for "sent by" etc.); the passcode hash and switches only of the person this computer belongs to
    union all select 'users', x.rev, case when v_owner or x.id = (select last_user_id from devices where id = c.device_id) then to_jsonb(x)
      else to_jsonb(x) - 'pin_salt' - 'pin_hash' - 'perms' end from users x where x.rev > p_since
    union all select 'devices', x.rev, to_jsonb(x) - 'auth_uid' - 'seen_ts' from devices x where x.rev > p_since and (v_owner or x.id = c.device_id)
    union all select 'suppliers', x.rev, to_jsonb(x) from suppliers x where x.rev > p_since and v_buy
    union all select 'customers', x.rev, to_jsonb(x) from customers x where x.rev > p_since and v_sell
    union all select 'supplier_payments', x.rev, to_jsonb(x) from supplier_payments x where x.rev > p_since and v_buy
    union all select 'products', x.rev, case when v_cost then to_jsonb(x) else to_jsonb(x) - 'cost_price' end from products x where x.rev > p_since
    union all select 'stock', x.rev, to_jsonb(x) from stock x where x.rev > p_since
    union all select 'movements', x.rev, to_jsonb(x) from movements x where x.rev > p_since and (v_owner or x.location_id = v_loc)
    union all select 'purchases', x.rev, to_jsonb(x) from purchases x where x.rev > p_since and v_buy and (v_owner or x.location_id = v_loc)
    union all select 'purchase_items', x.rev, to_jsonb(x) from purchase_items x join purchases p on p.id = x.purchase_id
      where x.rev > p_since and v_buy and (v_owner or p.location_id = v_loc)
    union all select 'dispatches', x.rev, to_jsonb(x) from dispatches x where x.rev > p_since and (v_owner or x.from_location_id = v_loc or x.to_location_id = v_loc)
    union all select 'dispatch_items', x.rev, case when v_cost then to_jsonb(x) else to_jsonb(x) - 'cost' end
      from dispatch_items x join dispatches d on d.id = x.dispatch_id
      where x.rev > p_since and (v_owner or d.from_location_id = v_loc or d.to_location_id = v_loc)
    union all select 'sales', x.rev, to_jsonb(x) from sales x where x.rev > p_since and (v_owner or x.location_id = v_loc)
    union all select 'sale_items', x.rev, case when v_cost then to_jsonb(x) else to_jsonb(x) - 'cost' end
      from sale_items x join sales s on s.id = x.sale_id where x.rev > p_since and (v_owner or s.location_id = v_loc)
    union all select 'customer_payments', x.rev, to_jsonb(x) from customer_payments x where x.rev > p_since and (v_owner or x.location_id = v_loc)
    union all select 'expenses', x.rev, to_jsonb(x) from expenses x where x.rev > p_since and (v_owner or x.location_id = v_loc)
    union all select 'vouchers', x.rev, to_jsonb(x) from vouchers x where x.rev > p_since
    union all select 'tombstones', x.rev, to_jsonb(x) from tombstones x where x.rev > p_since
  ), page as (
    select * from x order by rev limit p_limit
  )
  select coalesce(jsonb_agg(
           case when t = 'tombstones' then jsonb_build_object('t', r ->> 'tbl', 'k', r ->> 'k', 'del', 1)
                else jsonb_build_object('t', t, 'r', case when t in ('purchases', 'dispatches', 'sales') then r - 'synced_at' else r - 'rev' - 'synced_at' end) end order by rev), '[]'),
         max(rev), count(*)
    into out_rows, max_rev, n from page;
  select value into epoch from meta where key = 'epoch';
  perform _seen(c, p_now);
  return jsonb_build_object('rows', out_rows, 'cursor', coalesce(max_rev, p_since), 'more', n >= p_limit, 'epoch', epoch, 'v', 10, 'location_id', c.location_id,
    'scope', case when v_owner then 'owner' else v_loc::text || ':' || array_to_string(array(select unnest(v_perms) order by 1), ',') end);
end $$;

create or replace function restore_begin() returns text language plpgsql security definer set search_path = public as $$
declare e text := gen_random_uuid()::text;
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can restore a backup.'; end if;
  perform pg_advisory_xact_lock(4242);
  truncate settings, locations, users, suppliers, customers, products, stock, movements, purchases, purchase_items, supplier_payments,
    dispatches, dispatch_items, sales, sale_items, customer_payments, expenses, vouchers, tombstones, push_log;
  update meta set value = e where key = 'epoch';
  return e;
end $$;
