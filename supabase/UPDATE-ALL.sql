-- Velanzo: everything added after the first file, in one go. Safe to run again.
-- Paste all of this in Supabase -> SQL Editor -> New query -> Run.

-- ===== 20261017000000_owner_lock_and_pin_reset.sql =====
-- Velanzo cloud database, part 2: only the approved email can become the owner, and forgotten PINs.
-- Run this once in Supabase (SQL Editor) after the first file. Never edit it afterwards.

-- ---------- 1. Who may become the owner ----------
-- The one email address of the business owner is put here ONCE by whoever sets Velanzo up (see docs/SETUP-CLOUD.md):
--     insert into owner_allow (email) values ('owner@example.com');
-- Only that email, confirmed through the link Supabase sends, can ever create the owner account.
-- (An entry '*' means "any confirmed email" and is only for testing.)
create table if not exists owner_allow (email text primary key);
alter table owner_allow enable row level security;
revoke all on owner_allow from anon, authenticated;

create or replace function create_owner(p_email text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_mail text; v_confirmed timestamptz;
begin
  if auth.uid() is null then raise exception 'VZ:auth:Sign in first.'; end if;
  perform pg_advisory_xact_lock(4243);
  if _is_owner() then return jsonb_build_object('ok', true); end if;
  if exists (select 1 from owners) then raise exception 'VZ:perm:This Velanzo already has an owner. Ask the owner for a device code.'; end if;
  select lower(u.email), u.email_confirmed_at into v_mail, v_confirmed from auth.users u where u.id = auth.uid();
  if v_mail is null or v_mail = '' then raise exception 'VZ:perm:Sign in with an email address to create the owner account.'; end if;
  if v_confirmed is null then raise exception 'VZ:perm:Confirm your email first: open the link we sent you, then sign in again.'; end if;
  if not exists (select 1 from owner_allow where lower(email) = v_mail or email = '*') then
    raise exception 'VZ:perm:This email address is not approved to create the owner account.';
  end if;
  insert into owners (auth_uid, email) values (auth.uid(), v_mail);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- 2. Nobody but the owner may change an owner's record ----------
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
    'supplier_payments', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses') then
    raise exception 'VZ:bad:Unknown kind of record: %', t;
  end if;
  if v_key is null then raise exception 'VZ:bad:A % record has no id', t; end if;
  execute format('select to_jsonb(x) from %I x where %I::text = $1', t, kc) into old using v_key;
  is_new := old is null;

  if del then
    if not c.owner then perform _deny('Only the owner can delete records.'); end if;
    if not is_new then
      execute format('delete from %I where %I::text = $1', t, kc) using v_key;
      insert into tombstones as tb (tbl, k) values (t, v_key) on conflict (tbl, k) do update set k = excluded.k;
    end if;
    return;
  end if;

  -- history lines and bill/purchase lines never change once written
  if not is_new and t in ('movements', 'purchase_items', 'supplier_payments', 'sale_items') then return; end if;

  if not c.owner then
    case t
    when 'settings', 'locations' then
      perform _deny('Only the owner can change settings, shops and the warehouse.');
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
      if not is_new then perform _deny('Only the owner can cancel a purchase.'); end if;
      perform _need(c, 'buy', 'Buying from suppliers');
      if (r ->> 'location_id')::bigint is distinct from L then perform _deny('Purchases can only be entered for this device''s own place.'); end if;
    when 'purchase_items' then
      perform _need(c, 'buy', 'Buying from suppliers');
      select to_jsonb(p) into par from purchases p where p.id = (r ->> 'purchase_id')::bigint;
      if par is null or (par ->> 'location_id')::bigint is distinct from L then perform _deny('This purchase is from another place.'); end if;
    when 'dispatches' then
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (r ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
      elsif (old ->> 'to_location_id')::bigint = L and r ->> 'status' = 'received' and old ->> 'status' = 'in_transit' then
        perform _need(c, 'receive', 'Receiving stock');
        cols := array['status', 'received_qty', 'received_by', 'received_at'];
      elsif (old ->> 'from_location_id')::bigint = L and r ->> 'status' = 'cancelled' and old ->> 'status' = 'in_transit' then
        perform _need(c, 'send', 'Cancelling dispatches');
        cols := array['status'];
      else
        perform _deny('This dispatch can''t be changed from here (it may already be received or cancelled).');
      end if;
    when 'dispatch_items' then
      select to_jsonb(d) into par from dispatches d where d.id = (coalesce(old, r) ->> 'dispatch_id')::bigint;
      if par is null then perform _deny('Unknown dispatch.'); end if;
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (par ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
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

-- ---------- 3. Forgotten PIN: the owner approves with a link sent to the owner's email ----------
-- A person who forgot their PIN asks on their own computer. A link goes to the owner's email; opening it lets the owner
-- approve. Then that person chooses a new PIN on their own computer. Nobody ever sees anyone else's PIN.
create table if not exists pin_resets (
  id uuid primary key default gen_random_uuid(),
  device_id integer not null,
  user_id bigint not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'used', 'refused')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table pin_resets enable row level security;
revoke all on pin_resets from anon, authenticated;

-- A computer asks for a new PIN for one of its people. Returns the request and where the link must be sent.
create or replace function request_pin_reset(p_device integer, p_user bigint) returns jsonb language plpgsql security definer set search_path = public as $$
declare d devices; u users; v_email text; v_id uuid;
begin
  select * into d from devices where id = p_device and auth_uid = auth.uid() and active = 1;
  if not found then raise exception 'VZ:device:This device is not set up for Velanzo.'; end if;
  select * into u from users where id = p_user and active = 1;
  if not found then raise exception 'VZ:bad:Unknown person.'; end if;
  if d.location_id is null then
    if u.role <> 'admin' then raise exception 'VZ:perm:Only owners sign in on this computer.'; end if;
  elsif u.role <> 'staff' then
    raise exception 'VZ:perm:The owner''s PIN can only be reset on an owner computer.';
  elsif u.location_id is distinct from d.location_id then
    raise exception 'VZ:perm:% does not work at this place.', u.name;
  end if;
  if (select count(*) from pin_resets where device_id = d.id and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'VZ:perm:Too many requests. Please wait a while, or ask the owner to set a new PIN in Settings.';
  end if;
  select email into v_email from owners order by created_at limit 1;
  if v_email is null or v_email = '' then raise exception 'VZ:perm:No owner email is on record, so a link cannot be sent. Ask the owner to set a new PIN in Settings.'; end if;
  update pin_resets set status = 'refused', decided_at = now() where device_id = d.id and user_id = u.id and status in ('pending', 'approved');
  insert into pin_resets (device_id, user_id) values (d.id, u.id) returning id into v_id;
  return jsonb_build_object('id', v_id, 'email', v_email);
end $$;

-- The asking computer checks whether the owner has decided: pending, approved, refused, used or expired.
create or replace function check_pin_reset(p_device integer, p_id uuid) returns text language plpgsql security definer set search_path = public as $$
declare r pin_resets;
begin
  select pr.* into r from pin_resets pr join devices d on d.id = pr.device_id
    where pr.id = p_id and pr.device_id = p_device and d.auth_uid = auth.uid() and d.active = 1;
  if not found then return 'unknown'; end if;
  if r.status = 'pending' and r.created_at < now() - interval '30 minutes' then return 'expired'; end if;
  if r.status = 'approved' and r.decided_at < now() - interval '15 minutes' then return 'expired'; end if;
  return r.status;
end $$;

-- The asking computer chose its new PIN: the permission can be used only once.
create or replace function use_pin_reset(p_device integer, p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if check_pin_reset(p_device, p_id) <> 'approved' then raise exception 'VZ:perm:This PIN reset is not approved, or it has run out of time.'; end if;
  update pin_resets set status = 'used' where id = p_id;
end $$;

-- The owner sees who is waiting for approval.
create or replace function list_pin_resets() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', u.name, 'place', coalesce(l.name, 'Owner computer'), 'device', d.label, 'minutes', floor(extract(epoch from (now() - pr.created_at)) / 60))
      order by pr.created_at desc)
    from pin_resets pr join users u on u.id = pr.user_id join devices d on d.id = pr.device_id left join locations l on l.id = d.location_id
    where pr.status = 'pending' and pr.created_at > now() - interval '30 minutes'), '[]'::jsonb);
end $$;

-- The owner approves or refuses.
create or replace function decide_pin_reset(p_id uuid, p_approve boolean) returns void language plpgsql security definer set search_path = public as $$
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  update pin_resets set status = case when p_approve then 'approved' else 'refused' end, decided_at = now()
    where id = p_id and status = 'pending' and created_at > now() - interval '30 minutes';
  if not found then raise exception 'VZ:bad:This request is no longer waiting (it may be old, or already decided).'; end if;
end $$;

revoke execute on function request_pin_reset(integer, bigint), check_pin_reset(integer, uuid), use_pin_reset(integer, uuid),
  list_pin_resets(), decide_pin_reset(uuid, boolean) from public, anon;
grant execute on function request_pin_reset(integer, bigint), check_pin_reset(integer, uuid), use_pin_reset(integer, uuid),
  list_pin_resets(), decide_pin_reset(uuid, boolean) to authenticated;


-- ===== 20261018000000_push_fix.sql =====
-- Velanzo cloud database, part 3: fix for saving changes on Supabase. Run once in the SQL Editor, after parts 1 and 2.
-- Supabase refuses a DELETE with no WHERE; push() had one (emptying its scratch list), so every save failed.
-- Also: when the cloud itself has a problem (not a refusal), push() now says "retry", and the device keeps the change.

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


-- ===== 20261019000000_purchase_orders.sql =====
-- Velanzo cloud database, part 4: purchase orders (ordered today, counted into stock when the goods arrive).
-- Run once in the SQL Editor, after parts 1 to 3.
alter table purchases add column if not exists expected_date text;
alter table purchases add column if not exists received_at text;
alter table purchase_items add column if not exists ordered_qty integer;
alter table purchase_items add column if not exists planned_price double precision;

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
    'supplier_payments', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses') then
    raise exception 'VZ:bad:Unknown kind of record: %', t;
  end if;
  if v_key is null then raise exception 'VZ:bad:A % record has no id', t; end if;
  execute format('select to_jsonb(x) from %I x where %I::text = $1', t, kc) into old using v_key;
  is_new := old is null;

  if del then
    if not c.owner then perform _deny('Only the owner can delete records.'); end if;
    if not is_new then
      execute format('delete from %I where %I::text = $1', t, kc) using v_key;
      insert into tombstones as tb (tbl, k) values (t, v_key) on conflict (tbl, k) do update set k = excluded.k;
    end if;
    return;
  end if;

  -- history lines and bill/purchase lines never change once written
  if not is_new and t in ('movements', 'supplier_payments', 'sale_items') then return; end if;
  -- a purchase line can change only while it belongs to a purchase order (it is counted when the goods arrive)
  if not is_new and t = 'purchase_items' and old ->> 'ordered_qty' is null then return; end if;

  if not c.owner then
    case t
    when 'settings', 'locations' then
      perform _deny('Only the owner can change settings, shops and the warehouse.');
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
      elsif old ->> 'status' = 'ordered' and (old ->> 'location_id')::bigint = L and r ->> 'status' in ('done', 'void') then
        cols := array['status', 'total', 'total_qty', 'paid', 'invoice_no', 'date', 'received_at', 'notes']; -- the goods arrived, or the order was cancelled
      elsif old ->> 'status' is not distinct from r ->> 'status' then
        -- the same record again (e.g. an order made and cancelled before the first save reached the cloud): only the notes may differ
        cols := array['notes'];
      else
        perform _deny('Only the owner can cancel a purchase.');
      end if;
    when 'purchase_items' then
      perform _need(c, 'buy', 'Buying from suppliers');
      select to_jsonb(p) into par from purchases p where p.id = (r ->> 'purchase_id')::bigint;
      if par is null or (par ->> 'location_id')::bigint is distinct from L then perform _deny('This purchase is from another place.'); end if;
      if not is_new then cols := array['qty', 'cost', 'ordered_qty']; end if;
    when 'dispatches' then
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (r ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
      elsif (old ->> 'to_location_id')::bigint = L and r ->> 'status' = 'received' and old ->> 'status' = 'in_transit' then
        perform _need(c, 'receive', 'Receiving stock');
        cols := array['status', 'received_qty', 'received_by', 'received_at'];
      elsif (old ->> 'from_location_id')::bigint = L and r ->> 'status' = 'cancelled' and old ->> 'status' = 'in_transit' then
        perform _need(c, 'send', 'Cancelling dispatches');
        cols := array['status'];
      else
        perform _deny('This dispatch can''t be changed from here (it may already be received or cancelled).');
      end if;
    when 'dispatch_items' then
      select to_jsonb(d) into par from dispatches d where d.id = (coalesce(old, r) ->> 'dispatch_id')::bigint;
      if par is null then perform _deny('Unknown dispatch.'); end if;
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (par ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
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


-- ===== 20261020000000_user_logins.sql =====
-- Velanzo cloud database, part 5: every shop or warehouse person signs in with a user ID and password made by the owner.
-- Run once in the SQL Editor, after parts 1 to 4.
--
-- The owner makes the login (Settings -> Users). The person signs in on their computer; that computer then belongs to
-- them and their place. Passwords live only here (hashed with bcrypt) and are never sent to any computer.
-- The one-time device codes of part 1 are switched off: a login replaces them.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists user_logins (
  user_id bigint primary key,
  login_id text not null,
  pw_hash text not null,
  created_at timestamptz not null default now(),
  changed_at timestamptz
);
create unique index if not exists user_logins_login on user_logins (lower(login_id));
alter table user_logins enable row level security;
revoke all on user_logins from anon, authenticated;

create table if not exists login_attempts (login text not null, at timestamptz not null default now());
create index if not exists login_attempts_login on login_attempts (login, at);
alter table login_attempts enable row level security;
revoke all on login_attempts from anon, authenticated;

-- The owner makes (or changes) a person's user ID and password. The person must already exist (it is sent by the owner's computer first).
create or replace function set_user_login(p_user bigint, p_login text, p_password text) returns void language plpgsql security definer set search_path = public as $$
declare v_login text := lower(trim(coalesce(p_login, '')));
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  if v_login !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then raise exception 'VZ:bad:The user ID must be 3 to 30 letters or numbers (no spaces).'; end if;
  if not exists (select 1 from users where id = p_user and role = 'staff') then raise exception 'VZ:bad:This person is not saved in the cloud yet. Wait until "All saved online" shows, then try again.'; end if;
  if exists (select 1 from user_logins where lower(login_id) = v_login and user_id <> p_user) then raise exception 'VZ:bad:This user ID is already taken. Choose another.'; end if;
  if p_password is null or p_password = '' then
    -- only the user ID changes; the password stays
    if not exists (select 1 from user_logins where user_id = p_user) then raise exception 'VZ:bad:Type a password for this user.'; end if;
    update user_logins set login_id = v_login, changed_at = now() where user_id = p_user;
    return;
  end if;
  if length(p_password) < 6 then raise exception 'VZ:bad:The password must be at least 6 characters.'; end if;
  insert into user_logins (user_id, login_id, pw_hash) values (p_user, v_login, extensions.crypt(p_password, extensions.gen_salt('bf')))
    on conflict (user_id) do update set login_id = excluded.login_id, pw_hash = excluded.pw_hash, changed_at = now();
end $$;

-- A person signs in on a computer. Wrong tries are counted per user ID (a failed try is recorded and answered, not raised,
-- because a raised error would undo the record). The computer becomes a device of the person's place.
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
  update devices set active = 0 where auth_uid = auth.uid() and active = 1; -- one computer, one sign-in
  insert into devices (auth_uid, label, location_id, last_user_id, created_at) values (auth.uid(), left(p_label, 60), loc.id, u.id, p_now) returning * into d;
  update devices set code = _letters(d.id) where id = d.id;
  return jsonb_build_object('ok', true, 'id', d.id, 'code', _letters(d.id), 'location_id', loc.id, 'user_id', u.id, 'user_name', u.name);
end $$;

-- A person signs out: this computer stops being a device of the business.
create or replace function release_device(p_device integer) returns void language plpgsql security definer set search_path = public as $$
begin
  update devices set active = 0 where id = p_device and auth_uid = auth.uid();
end $$;

-- Who has a user ID (the owner's list shows it). Never the passwords.
create or replace function list_user_logins() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  return coalesce((select jsonb_object_agg(user_id::text, login_id) from user_logins), '{}'::jsonb);
end $$;

-- A computer changes only the columns it really sent (so a half-filled record can never blank a passcode).
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
    'supplier_payments', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses') then
    raise exception 'VZ:bad:Unknown kind of record: %', t;
  end if;
  if v_key is null then raise exception 'VZ:bad:A % record has no id', t; end if;
  execute format('select to_jsonb(x) from %I x where %I::text = $1', t, kc) into old using v_key;
  is_new := old is null;

  if del then
    if not c.owner then perform _deny('Only the owner can delete records.'); end if;
    if not is_new then
      execute format('delete from %I where %I::text = $1', t, kc) using v_key;
      insert into tombstones as tb (tbl, k) values (t, v_key) on conflict (tbl, k) do update set k = excluded.k;
    end if;
    return;
  end if;

  -- history lines and bill/purchase lines never change once written
  if not is_new and t in ('movements', 'supplier_payments', 'sale_items') then return; end if;
  -- a purchase line can change only while it belongs to a purchase order (it is counted when the goods arrive)
  if not is_new and t = 'purchase_items' and old ->> 'ordered_qty' is null then return; end if;

  if not c.owner then
    case t
    when 'settings', 'locations' then
      perform _deny('Only the owner can change settings, shops and the warehouse.');
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
      elsif old ->> 'status' = 'ordered' and (old ->> 'location_id')::bigint = L and r ->> 'status' in ('done', 'void') then
        cols := array['status', 'total', 'total_qty', 'paid', 'invoice_no', 'date', 'received_at', 'notes']; -- the goods arrived, or the order was cancelled
      elsif old ->> 'status' is not distinct from r ->> 'status' then
        -- the same record again (e.g. an order made and cancelled before the first save reached the cloud): only the notes may differ
        cols := array['notes'];
      else
        perform _deny('Only the owner can cancel a purchase.');
      end if;
    when 'purchase_items' then
      perform _need(c, 'buy', 'Buying from suppliers');
      select to_jsonb(p) into par from purchases p where p.id = (r ->> 'purchase_id')::bigint;
      if par is null or (par ->> 'location_id')::bigint is distinct from L then perform _deny('This purchase is from another place.'); end if;
      if not is_new then cols := array['qty', 'cost', 'ordered_qty']; end if;
    when 'dispatches' then
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (r ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
      elsif (old ->> 'to_location_id')::bigint = L and r ->> 'status' = 'received' and old ->> 'status' = 'in_transit' then
        perform _need(c, 'receive', 'Receiving stock');
        cols := array['status', 'received_qty', 'received_by', 'received_at'];
      elsif (old ->> 'from_location_id')::bigint = L and r ->> 'status' = 'cancelled' and old ->> 'status' = 'in_transit' then
        perform _need(c, 'send', 'Cancelling dispatches');
        cols := array['status'];
      else
        perform _deny('This dispatch can''t be changed from here (it may already be received or cancelled).');
      end if;
    when 'dispatch_items' then
      select to_jsonb(d) into par from dispatches d where d.id = (coalesce(old, r) ->> 'dispatch_id')::bigint;
      if par is null then perform _deny('Unknown dispatch.'); end if;
      if is_new then
        perform _need(c, 'send', 'Sending stock');
        if (par ->> 'from_location_id')::bigint is distinct from L then perform _deny('Stock can only be sent from this device''s own place.'); end if;
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

-- Passcode hashes: a 4-number passcode could be guessed from its hash in seconds, so a computer now receives only the
-- hash of the person who signed in on it (the owner's computers receive everyone's). Names are still shared.
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

-- The one-time device codes are replaced by logins.
revoke execute on function claim_device(text, text, text), create_setup_code(bigint) from public, anon, authenticated;
revoke execute on function set_user_login(bigint, text, text), login_with_id(text, text, text, text), release_device(integer), list_user_logins() from public, anon;
grant execute on function set_user_login(bigint, text, text), login_with_id(text, text, text, text), release_device(integer), list_user_logins() to authenticated;


