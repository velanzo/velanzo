-- Velanzo cloud database, part 2: only the approved email can become the owner, and forgotten PINs.
-- Run this once in Supabase (SQL Editor) after the first file. Never edit it afterwards.

-- ---------- 1. Who may become the owner ----------
-- The one email address of the business owner is put here ONCE by whoever sets Velanzo up (see docs/SETUP-CLOUD.md):
--     insert into owner_allow (email) values ('owner@example.com');
-- Only that email, confirmed through the link Supabase sends, can ever create the owner account.
-- (An entry '*' means "any confirmed email" and is only for testing.)
create table owner_allow (email text primary key);
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
create table pin_resets (
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
create function request_pin_reset(p_device integer, p_user bigint) returns jsonb language plpgsql security definer set search_path = public as $$
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
create function check_pin_reset(p_device integer, p_id uuid) returns text language plpgsql security definer set search_path = public as $$
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
create function use_pin_reset(p_device integer, p_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if check_pin_reset(p_device, p_id) <> 'approved' then raise exception 'VZ:perm:This PIN reset is not approved, or it has run out of time.'; end if;
  update pin_resets set status = 'used' where id = p_id;
end $$;

-- The owner sees who is waiting for approval.
create function list_pin_resets() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'name', u.name, 'place', coalesce(l.name, 'Owner computer'), 'device', d.label, 'minutes', floor(extract(epoch from (now() - pr.created_at)) / 60))
      order by pr.created_at desc)
    from pin_resets pr join users u on u.id = pr.user_id join devices d on d.id = pr.device_id left join locations l on l.id = d.location_id
    where pr.status = 'pending' and pr.created_at > now() - interval '30 minutes'), '[]'::jsonb);
end $$;

-- The owner approves or refuses.
create function decide_pin_reset(p_id uuid, p_approve boolean) returns void language plpgsql security definer set search_path = public as $$
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
