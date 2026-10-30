-- Velanzo cloud database, part 7: discounts and vouchers. A bill line can carry a discount (it keeps the price before
-- the discount), a bill can use one voucher, and the owner makes vouchers (a code worth Rs or % off) that every shop can use.
-- Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).

alter table sale_items add column if not exists list_price double precision;
alter table sales add column if not exists voucher_code text;
alter table sales add column if not exists voucher double precision not null default 0;

create table if not exists vouchers (id bigint primary key, code text not null, kind text not null default 'amt', value double precision not null,
  min_bill double precision not null default 0, expires text, max_uses integer not null default 1, note text, active integer not null default 1,
  user_id bigint, created_at text not null, rev bigint, synced_at timestamptz);
create unique index if not exists vouchers_code on vouchers (upper(code));
create index if not exists vouchers_rev on vouchers (rev);
alter table vouchers enable row level security;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'vouchers_stamp') then
    create trigger vouchers_stamp before insert or update on vouchers for each row execute function _stamp();
  end if;
end $$;
revoke all on vouchers from anon, authenticated;

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
      execute format('delete from %I where %I::text = $1', t, kc) using v_key;
      insert into tombstones as tb (tbl, k) values (t, v_key) on conflict (tbl, k) do update set k = excluded.k;
    end if;
    return;
  end if;

  -- history lines and bill/purchase lines never change once written
  if not is_new and t in ('movements', 'supplier_payments', 'sale_items') then return; end if;
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
      cols := array['name', 'category', 'size', 'color', 'barcode', 'sale_price', 'active', 'updated_at'];
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
    end if;
  end if;
  if t = 'movements' then
    insert into _touched values ((r ->> 'location_id')::bigint, (r ->> 'product_id')::bigint);
  end if;
end $$;

create or replace function pull(p_device integer, p_user bigint, p_since bigint, p_limit integer default 2000, p_now text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c vz_ctx;
  v_owner boolean;
  v_loc bigint;
  v_perms text[];
  v_cost boolean;
  v_buy boolean;
  out_rows jsonb;
  max_rev bigint;
  n integer;
  epoch text;
begin
  c := _context(p_device, p_user);
  v_owner := c.owner; v_loc := c.location_id; v_perms := c.place_perms;
  v_cost := v_owner or 'see_cost' = any(v_perms) or 'buy' = any(v_perms);
  v_buy := v_owner or 'buy' = any(v_perms);
  with x (t, rev, r) as (
    select 'settings', s.rev, to_jsonb(s) from settings s where s.rev > p_since
    union all select 'locations', x.rev, to_jsonb(x) from locations x where x.rev > p_since
    -- everyone's name (for "sent by" etc.), but PINs only of the people who can log in on this device
    -- everyone's name (for "sent by" etc.); the passcode hash and switches only of the person this computer belongs to
    union all select 'users', x.rev, case when v_owner or x.id = (select last_user_id from devices where id = c.device_id) then to_jsonb(x)
      else to_jsonb(x) - 'pin_salt' - 'pin_hash' - 'perms' end from users x where x.rev > p_since
    union all select 'devices', x.rev, to_jsonb(x) - 'auth_uid' - 'seen_ts' from devices x where x.rev > p_since and (v_owner or x.id = c.device_id)
    union all select 'suppliers', x.rev, to_jsonb(x) from suppliers x where x.rev > p_since and v_buy
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
    union all select 'expenses', x.rev, to_jsonb(x) from expenses x where x.rev > p_since and (v_owner or x.location_id = v_loc)
    union all select 'vouchers', x.rev, to_jsonb(x) from vouchers x where x.rev > p_since
    union all select 'tombstones', x.rev, to_jsonb(x) from tombstones x where x.rev > p_since
  ), page as (
    select * from x order by rev limit p_limit
  )
  select coalesce(jsonb_agg(
           case when t = 'tombstones' then jsonb_build_object('t', r ->> 'tbl', 'k', r ->> 'k', 'del', 1)
                else jsonb_build_object('t', t, 'r', r - 'rev' - 'synced_at') end order by rev), '[]'),
         max(rev), count(*)
    into out_rows, max_rev, n from page;
  select value into epoch from meta where key = 'epoch';
  perform _seen(c, p_now);
  return jsonb_build_object('rows', out_rows, 'cursor', coalesce(max_rev, p_since), 'more', n >= p_limit, 'epoch', epoch,
    'scope', case when v_owner then 'owner' else v_loc::text || ':' || array_to_string(array(select unnest(v_perms) order by 1), ',') end);
end $$;

create or replace function restore_begin() returns text language plpgsql security definer set search_path = public as $$
declare e text := gen_random_uuid()::text;
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can restore a backup.'; end if;
  perform pg_advisory_xact_lock(4242);
  truncate settings, locations, users, suppliers, products, stock, movements, purchases, purchase_items, supplier_payments,
    dispatches, dispatch_items, sales, sale_items, expenses, vouchers, tombstones, push_log;
  update meta set value = e where key = 'epoch';
  return e;
end $$;
