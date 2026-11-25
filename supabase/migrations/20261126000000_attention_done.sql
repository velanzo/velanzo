-- Velanzo cloud database, part 15: Attention. Something unusual (a big stock correction, a sale at a loss …) stays on
-- the Attention list until someone presses Done. checks_done keeps those "Done" marks, so every computer sees them.
-- Also: sync_check now counts customers and customer payments (computers that had customers kept repairing themselves).
-- Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).

create table if not exists checks_done (id bigint primary key, k text not null, kind text, title text, note text,
  user_id bigint, created_at text not null, rev bigint, synced_at timestamptz);
create index if not exists checks_done_k on checks_done (k);
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'checks_done_stamp') then
    create trigger checks_done_stamp before insert or update on checks_done for each row execute function _stamp();
  end if;
end $$;
alter table checks_done enable row level security;
revoke all on checks_done from anon, authenticated;

-- _apply handles checks_done and hands everything else on to the _apply of part 12 (kept as _apply_v12).
-- (Running this file again first drops the old _apply_v12: parts 11 and 12 have just made _apply again.)
do $$ begin
  if exists (select 1 from pg_proc where proname = '_apply_v12') then
    drop function _apply_v12(vz_ctx, text, jsonb, boolean, text);
  end if;
  alter function _apply(vz_ctx, text, jsonb, boolean, text) rename to _apply_v12;
end $$;
revoke execute on function _apply_v12(vz_ctx, text, jsonb, boolean, text) from public, anon, authenticated;

create or replace function _apply(c vz_ctx, t text, r jsonb, del boolean, del_key text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_key text := coalesce(del_key, r ->> 'id');
begin
  if t <> 'checks_done' then
    perform _apply_v12(c, t, r, del, del_key);
    return;
  end if;
  if v_key is null then raise exception 'VZ:bad:A checks_done record has no id'; end if;
  if del then
    -- "Not done after all": only the owner
    if not c.owner then perform _deny('Only the owner can undo Done.'); end if;
    delete from checks_done where id::text = v_key;
    insert into tombstones as tb (tbl, k) values (t, v_key) on conflict (tbl, k) do update set k = excluded.k;
    return;
  end if;
  -- a Done mark is history: once written it never changes
  if exists (select 1 from checks_done where id::text = v_key) then return; end if;
  if not c.owner and not ('reports' = any(c.perms)) then perform _deny('Marking things as done is for people who see reports.'); end if;
  insert into checks_done select * from jsonb_populate_record(null::checks_done, r);
end $$;
revoke execute on function _apply(vz_ctx, text, jsonb, boolean, text) from public, anon, authenticated;

-- Downloads now include the Done marks (for everyone who may see costs, like the reports that use them).
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
    union all select 'checks_done', x.rev, to_jsonb(x) from checks_done x where x.rev > p_since and v_cost
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

-- "Does this computer hold the same as the cloud?": the same tables and rules as pull (now with customers,
-- customer payments and the Done marks).
create or replace function sync_check(p_device integer, p_user bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c vz_ctx;
  v_owner boolean;
  v_loc bigint;
  v_buy boolean;
  v_sell boolean;
  v_cost boolean;
  out_tables jsonb;
  max_rev bigint;
begin
  c := _context(p_device, p_user);
  v_owner := c.owner; v_loc := c.location_id;
  v_buy := v_owner or 'buy' = any(c.place_perms);
  v_sell := v_owner or 'sell' = any(c.place_perms);
  v_cost := v_owner or 'see_cost' = any(c.place_perms) or 'buy' = any(c.place_perms);
  with x (t, rev, v) as (
    select 'settings', s.rev, 0::numeric from settings s
    union all select 'locations', y.rev, 0 from locations y
    union all select 'users', y.rev, 0 from users y
    union all select 'suppliers', y.rev, 0 from suppliers y where v_buy
    union all select 'customers', y.rev, 0 from customers y where v_sell
    union all select 'supplier_payments', y.rev, 0 from supplier_payments y where v_buy
    union all select 'products', y.rev, round((y.sale_price * 100)::numeric) from products y
    union all select 'stock', y.rev, y.qty from stock y where y.qty <> 0
    union all select 'movements', y.rev, 0 from movements y where v_owner or y.location_id = v_loc
    union all select 'purchases', y.rev, y.rev from purchases y where v_buy and (v_owner or y.location_id = v_loc)
    union all select 'purchase_items', y.rev, 0 from purchase_items y join purchases p on p.id = y.purchase_id where v_buy and (v_owner or p.location_id = v_loc)
    union all select 'dispatches', y.rev, y.rev from dispatches y where v_owner or y.from_location_id = v_loc or y.to_location_id = v_loc
    union all select 'dispatch_items', y.rev, 0 from dispatch_items y join dispatches d on d.id = y.dispatch_id where v_owner or d.from_location_id = v_loc or d.to_location_id = v_loc
    union all select 'sales', y.rev, y.rev from sales y where v_owner or y.location_id = v_loc
    union all select 'sale_items', y.rev, 0 from sale_items y join sales s on s.id = y.sale_id where v_owner or s.location_id = v_loc
    union all select 'customer_payments', y.rev, 0 from customer_payments y where v_owner or y.location_id = v_loc
    union all select 'expenses', y.rev, 0 from expenses y where v_owner or y.location_id = v_loc
    union all select 'vouchers', y.rev, 0 from vouchers y
    union all select 'checks_done', y.rev, 0 from checks_done y where v_cost
    union all select '_tombstones', y.rev, 0 from tombstones y
  ), g as (
    select t, count(*) as n, coalesce(sum(v), 0) as s, max(rev) as m from x group by t
  )
  select coalesce(jsonb_object_agg(t, jsonb_build_object('n', n, 's', s)), '{}'), coalesce(max(m), 0) into out_tables, max_rev from g;
  return jsonb_build_object('tables', out_tables - '_tombstones', 'max_rev', max_rev);
end $$;
revoke execute on function sync_check(integer, bigint) from public, anon;
grant execute on function sync_check(integer, bigint) to authenticated;

create or replace function restore_begin() returns text language plpgsql security definer set search_path = public as $$
declare e text := gen_random_uuid()::text;
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can restore a backup.'; end if;
  perform pg_advisory_xact_lock(4242);
  truncate settings, locations, users, suppliers, customers, products, stock, movements, purchases, purchase_items, supplier_payments,
    dispatches, dispatch_items, sales, sale_items, customer_payments, expenses, vouchers, checks_done, tombstones, push_log;
  update meta set value = e where key = 'epoch';
  return e;
end $$;

create or replace function _record_name(t text) returns text language sql immutable as $$
  select case t when 'purchases' then 'purchase' when 'dispatches' then 'parcel' when 'sales' then 'bill' when 'products' then 'item'
    when 'suppliers' then 'supplier' when 'locations' then 'place' when 'users' then 'person' when 'vouchers' then 'voucher'
    when 'expenses' then 'expense' when 'movements' then 'stock change' when 'sale_items' then 'bill line'
    when 'purchase_items' then 'purchase line' when 'dispatch_items' then 'parcel line' when 'supplier_payments' then 'payment'
    when 'customers' then 'customer' when 'customer_payments' then 'customer payment' when 'checks_done' then 'Done mark' else 'record' end
$$;
revoke execute on function _record_name(text) from public, anon, authenticated;
