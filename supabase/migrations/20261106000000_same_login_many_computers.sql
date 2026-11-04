-- Velanzo cloud database, part 9: the same login on several computers.
-- A computer that signs a person in no longer switches off the owner's other computers, a person's computer follows them when the
-- owner moves them to another place, changes that were ignored still come back to the computer, and computers can compare
-- what they hold with the cloud. Run once in Supabase (or run supabase/UPDATE-ALL.sql, which is safe to run again).

-- A person was moved to another place: the computer they signed in on goes with them, instead of stopping.
create or replace function _follow_user(p_device integer, p_user bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_user is null then return; end if;
  if exists (select 1 from devices d join users u on u.id = p_user
      where d.id = p_device and d.auth_uid = auth.uid() and d.active = 1 and d.location_id is not null
        and u.role = 'staff' and u.active = 1 and u.location_id is not null and u.location_id is distinct from d.location_id) then
    perform pg_advisory_xact_lock(4242);
    update devices set location_id = (select location_id from users where id = p_user) where id = p_device and auth_uid = auth.uid();
  end if;
end $$;

create or replace function login_with_id(p_login text, p_password text, p_label text, p_now text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_login text := lower(trim(coalesce(p_login, ''))); l user_logins; u users; loc locations; d devices;
begin
  if auth.uid() is null then raise exception 'VZ:auth:Sign in first.'; end if;
  delete from login_attempts where at < now() - interval '1 day';
  if (select count(*) from login_attempts where login = v_login and at > now() - interval '15 minutes') >= 8 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong tries. Wait 15 minutes and try again, or ask the owner for a new password.');
  end if;
  select * into l from user_logins where lower(login_id) = v_login;
  if not found or l.pw_hash is distinct from extensions.crypt(coalesce(p_password, ''), l.pw_hash) then
    insert into login_attempts (login) values (v_login);
    return jsonb_build_object('ok', false, 'error', 'Wrong user ID or password.');
  end if;
  select * into u from users where id = l.user_id and active = 1 and role = 'staff';
  if not found then return jsonb_build_object('ok', false, 'error', 'This user is switched off. Ask the owner.'); end if;
  select * into loc from locations where id = u.location_id and active = 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'The place of this user is closed. Ask the owner.'); end if;
  delete from login_attempts where login = v_login;
  perform pg_advisory_xact_lock(4242);
  -- one computer, one sign-in. (Only for a computer's own anonymous sign-in: the owner's account is on many computers at once.)
  update devices set active = 0 where auth_uid = auth.uid() and active = 1 and not _is_owner();
  insert into devices (auth_uid, label, location_id, last_user_id, created_at) values (auth.uid(), left(p_label, 60), loc.id, u.id, p_now) returning * into d;
  update devices set code = _letters(d.id) where id = d.id;
  return jsonb_build_object('ok', true, 'id', d.id, 'code', _letters(d.id), 'location_id', loc.id, 'user_id', u.id, 'user_name', u.name);
end $$;

-- A person signs out: this computer stops being a device of the business. (One writer at a time, see push().)
create or replace function release_device(p_device integer) returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(4242);
  update devices set active = 0 where id = p_device and auth_uid = auth.uid();
end $$;

-- A computer signed in again and got a new device number: the old number is no longer in use.
create or replace function replace_device(p_old integer, p_new integer) returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(4242);
  update devices o set active = 0 from devices n
  where o.id = p_old and n.id = p_new and o.id <> n.id and n.auth_uid = auth.uid() and n.active = 1
    and (o.auth_uid = auth.uid() or (o.last_user_id is not null and o.last_user_id = n.last_user_id));
end $$;

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

create or replace function push(p_device integer, p_user bigint, p_groups jsonb, p_now text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c vz_ctx;
  g jsonb;
  item jsonb;
  results jsonb := '[]';
  msg text;
  cname text;
begin
  -- one writer at a time, so change numbers are committed in order and pull() never skips one
  perform pg_advisory_xact_lock(4242);
  perform _follow_user(p_device, p_user);
  c := _context(p_device, p_user);
  create temp table if not exists _touched (location_id bigint, product_id bigint) on commit drop;
  for g in select * from jsonb_array_elements(coalesce(p_groups, '[]')) loop
    if exists (select 1 from push_log where grp = g ->> 'grp') then
      results := results || jsonb_build_array(jsonb_build_object('grp', g ->> 'grp', 'ok', true));
      continue;
    end if;
    begin
      delete from _touched where true; -- (Supabase refuses a DELETE without a WHERE)
      for item in select * from jsonb_array_elements(g -> 'rows') loop
        perform _apply(c, item ->> 't', item -> 'r', coalesce((item ->> 'del')::integer, 0) = 1, item ->> 'k');
      end loop;
      -- stock is always the sum of its history, so moves from different devices never overwrite each other
      insert into stock (location_id, product_id, qty)
        select s.location_id, s.product_id,
          (select coalesce(sum(m.qty), 0) from movements m where m.location_id = s.location_id and m.product_id = s.product_id)
        from (select distinct location_id, product_id from _touched) s
      on conflict (location_id, product_id) do update set qty = excluded.qty;
      insert into push_log (grp, device_id) values (g ->> 'grp', c.device_id);
      results := results || jsonb_build_array(jsonb_build_object('grp', g ->> 'grp', 'ok', true));
    exception when others then
      get stacked diagnostics cname = constraint_name;
      msg := sqlerrm;
      if msg like 'VZ:device:%' or msg like 'VZ:removed:%' then raise; end if;
      if sqlstate = '23505' then
        msg := case cname when 'products_barcode' then 'This barcode is already used by another item.'
          when 'locations_code' then 'This short code is already used by another place.'
          else 'This number is already used (' || coalesce(cname, 'duplicate') || ').' end;
      end if;
      -- 'retry': a problem on the cloud's side, not a refusal. The device keeps the change and sends it again later.
      results := results || jsonb_build_array(jsonb_build_object('grp', g ->> 'grp', 'ok', false,
        'retry', (msg not like 'VZ:%' and sqlstate not like '22%' and sqlstate not like '23%'),
        'error', regexp_replace(msg, '^VZ:[a-z]+:', '')));
    end;
  end loop;
  perform _seen(c, p_now);
  return jsonb_build_object('results', results);
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
  perform _follow_user(p_device, p_user);
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
                else jsonb_build_object('t', t, 'r', case when t in ('purchases', 'dispatches', 'sales') then r - 'synced_at' else r - 'rev' - 'synced_at' end) end order by rev), '[]'),
         max(rev), count(*)
    into out_rows, max_rev, n from page;
  select value into epoch from meta where key = 'epoch';
  perform _seen(c, p_now);
  return jsonb_build_object('rows', out_rows, 'cursor', coalesce(max_rev, p_since), 'more', n >= p_limit, 'epoch', epoch, 'v', 9, 'location_id', c.location_id,
    'scope', case when v_owner then 'owner' else v_loc::text || ':' || array_to_string(array(select unnest(v_perms) order by 1), ',') end);
end $$;

create or replace function sync_check(p_device integer, p_user bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  c vz_ctx;
  v_owner boolean;
  v_loc bigint;
  v_buy boolean;
  out_tables jsonb;
  max_rev bigint;
begin
  c := _context(p_device, p_user);
  v_owner := c.owner; v_loc := c.location_id;
  v_buy := v_owner or 'buy' = any(c.place_perms);
  with x (t, rev, v) as (
    select 'settings', s.rev, 0::numeric from settings s
    union all select 'locations', y.rev, 0 from locations y
    union all select 'users', y.rev, 0 from users y
    union all select 'suppliers', y.rev, 0 from suppliers y where v_buy
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
    union all select 'expenses', y.rev, 0 from expenses y where v_owner or y.location_id = v_loc
    union all select 'vouchers', y.rev, 0 from vouchers y
    union all select '_tombstones', y.rev, 0 from tombstones y
  ), g as (
    select t, count(*) as n, coalesce(sum(v), 0) as s, max(rev) as m from x group by t
  )
  select coalesce(jsonb_object_agg(t, jsonb_build_object('n', n, 's', s)), '{}'), coalesce(max(m), 0) into out_tables, max_rev from g;
  return jsonb_build_object('tables', out_tables - '_tombstones', 'max_rev', max_rev);
end $$;

revoke execute on function _follow_user(integer, bigint) from public, anon, authenticated;
revoke execute on function replace_device(integer, integer), sync_check(integer, bigint) from public, anon;
grant execute on function replace_device(integer, integer), sync_check(integer, bigint) to authenticated;

-- Sending a lot at once (after a long time offline) may take a while on a small server.
do $$ begin
  execute 'alter role authenticated set statement_timeout = ''30s''';
exception when others then null;
end $$;
notify pgrst, 'reload config';
