-- Velanzo cloud database, part 5: every shop or warehouse person signs in with a user ID and password made by the owner.
-- Run once in the SQL Editor, after parts 1 to 4.
--
-- The owner makes the login (Settings -> Users). The person signs in on their computer; that computer then belongs to
-- them and their place. Passwords live only here (hashed with bcrypt) and are never sent to any computer.
-- The one-time device codes of part 1 are switched off: a login replaces them.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table user_logins (
  user_id bigint primary key,
  login_id text not null,
  pw_hash text not null,
  created_at timestamptz not null default now(),
  changed_at timestamptz
);
create unique index user_logins_login on user_logins (lower(login_id));
alter table user_logins enable row level security;
revoke all on user_logins from anon, authenticated;

create table login_attempts (login text not null, at timestamptz not null default now());
create index login_attempts_login on login_attempts (login, at);
alter table login_attempts enable row level security;
revoke all on login_attempts from anon, authenticated;

-- The owner makes (or changes) a person's user ID and password. The person must already exist (it is sent by the owner's computer first).
create function set_user_login(p_user bigint, p_login text, p_password text) returns void language plpgsql security definer set search_path = public as $$
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
create function login_with_id(p_login text, p_password text, p_label text, p_now text default null) returns jsonb language plpgsql security definer set search_path = public as $$
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
create function release_device(p_device integer) returns void language plpgsql security definer set search_path = public as $$
begin
  update devices set active = 0 where id = p_device and auth_uid = auth.uid();
end $$;

-- Who has a user ID (the owner's list shows it). Never the passwords.
create function list_user_logins() returns jsonb language plpgsql stable security definer set search_path = public as $$
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
