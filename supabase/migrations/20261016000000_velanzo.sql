-- Velanzo cloud database (Supabase / Postgres).
--
-- Each device (shop counter, warehouse PC, owner's phone) keeps its own copy and works offline.
-- Devices send their changes with push() and get everyone else's with pull().
-- Devices never touch the tables directly: row level security is on with no policies, and the functions
-- below decide what each device may see and change (the shop's switches, then the person's switches).

create sequence velanzo_rev;                   -- every change gets the next number; pull() asks "what changed after N?"
create sequence velanzo_device_no start 2;     -- device 1 is the computer that ran without the cloud

-- ---------- Shop data (same columns as on the devices, plus rev / synced_at) ----------
create table settings (key text primary key, value text, rev bigint, synced_at timestamptz);
create table locations (id bigint primary key, name text not null, code text not null, type text not null check (type in ('warehouse', 'shop')),
  address text, phone text, perms text, active integer not null default 1, created_at text not null, rev bigint, synced_at timestamptz);
create unique index locations_code on locations (upper(code));
create table users (id bigint primary key, name text not null, role text not null check (role in ('admin', 'staff')), location_id bigint,
  perms text, pin_salt text, pin_hash text, email text, active integer not null default 1, created_at text not null, rev bigint, synced_at timestamptz);
create table devices (id integer primary key default nextval('velanzo_device_no'), auth_uid uuid not null, label text, location_id bigint, code text,
  active integer not null default 1, last_seen_at text, last_user_id bigint, seen_ts timestamptz, created_at text, rev bigint, synced_at timestamptz);
create table suppliers (id bigint primary key, name text not null, phone text, address text, notes text, created_at text not null, rev bigint, synced_at timestamptz);
create table products (id bigint primary key, barcode text not null, name text not null, category text, size text, color text,
  cost_price double precision, sale_price double precision not null default 0, active integer not null default 1,
  created_at text not null, updated_at text, rev bigint, synced_at timestamptz);
create unique index products_barcode on products (upper(barcode));
create table stock (location_id bigint not null, product_id bigint not null, qty integer not null default 0, rev bigint, synced_at timestamptz,
  primary key (location_id, product_id));
create table movements (id bigint primary key, product_id bigint not null, location_id bigint not null, qty integer not null, type text not null,
  ref_type text, ref_id bigint, note text, user_id bigint, created_at text not null, rev bigint, synced_at timestamptz);
create index movements_loc_prod on movements (location_id, product_id);
create table purchases (id bigint primary key, purchase_no text not null unique, supplier_id bigint, location_id bigint not null, invoice_no text,
  date text not null, total double precision not null default 0, paid double precision not null default 0, total_qty integer not null default 0,
  notes text, status text not null default 'done', user_id bigint, created_at text not null, rev bigint, synced_at timestamptz);
create table purchase_items (id bigint primary key, purchase_id bigint not null, product_id bigint not null, qty integer not null,
  cost double precision not null, rev bigint, synced_at timestamptz);
create index purchase_items_purchase on purchase_items (purchase_id);
create table supplier_payments (id bigint primary key, supplier_id bigint not null, date text not null, amount double precision not null,
  method text, note text, user_id bigint, created_at text not null, rev bigint, synced_at timestamptz);
create table dispatches (id bigint primary key, dispatch_no text not null unique, from_location_id bigint not null, to_location_id bigint not null,
  status text not null default 'in_transit', total_qty integer not null default 0, total_value double precision not null default 0,
  received_qty integer, notes text, created_by bigint, created_at text not null, received_by bigint, received_at text, rev bigint, synced_at timestamptz);
create table dispatch_items (id bigint primary key, dispatch_id bigint not null, product_id bigint not null, qty integer not null,
  received_qty integer, price double precision not null, cost double precision, rev bigint, synced_at timestamptz);
create index dispatch_items_dispatch on dispatch_items (dispatch_id);
create table sales (id bigint primary key, bill_no text not null, location_id bigint not null, customer_name text, customer_phone text,
  subtotal double precision not null, discount double precision not null default 0, total double precision not null,
  paid double precision not null default 0, change_due double precision not null default 0, payment_method text not null default 'cash',
  items_qty integer not null default 0, status text not null default 'done', user_id bigint, created_at text not null,
  void_reason text, voided_by bigint, voided_at text, rev bigint, synced_at timestamptz);
create unique index sales_bill_no on sales (upper(bill_no));
create table sale_items (id bigint primary key, sale_id bigint not null, product_id bigint not null, qty integer not null,
  price double precision not null, cost double precision, rev bigint, synced_at timestamptz);
create index sale_items_sale on sale_items (sale_id);
create table expenses (id bigint primary key, location_id bigint, date text not null, category text not null, amount double precision not null,
  note text, user_id bigint, created_at text not null, rev bigint, synced_at timestamptz);
-- deleted records, so other devices delete them too
create table tombstones (tbl text not null, k text not null, rev bigint, synced_at timestamptz, primary key (tbl, k));

-- ---------- Bookkeeping ----------
create table owners (auth_uid uuid primary key, email text, created_at timestamptz not null default now());
create table setup_codes (code_hash text primary key, location_id bigint, created_by uuid, expires_at timestamptz not null, used_at timestamptz);
create table claim_attempts (auth_uid uuid, at timestamptz not null default now());
create table push_log (grp text primary key, device_id integer, at timestamptz not null default now());
create table meta (key text primary key, value text);
insert into meta values ('epoch', gen_random_uuid()::text);

create function _stamp() returns trigger language plpgsql as $$
begin
  new.rev := nextval('velanzo_rev');
  new.synced_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['settings', 'locations', 'users', 'devices', 'suppliers', 'products', 'stock', 'movements', 'purchases',
    'purchase_items', 'supplier_payments', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses', 'tombstones'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function _stamp()', t || '_stamp', t);
    execute format('create index %I on %I (rev)', t || '_rev', t);
  end loop;
  foreach t in array array['settings', 'locations', 'users', 'devices', 'suppliers', 'products', 'stock', 'movements', 'purchases',
    'purchase_items', 'supplier_payments', 'dispatches', 'dispatch_items', 'sales', 'sale_items', 'expenses', 'tombstones',
    'owners', 'setup_codes', 'claim_attempts', 'push_log', 'meta'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- ---------- Helpers ----------
-- 1 → A, 2 → B, … 27 → AA: the letter in this device's bill numbers
create function _letters(n integer) returns text language plpgsql immutable as $$
declare s text := '';
begin
  while n > 0 loop
    n := n - 1;
    s := chr(65 + n % 26) || s;
    n := n / 26;
  end loop;
  return s;
end $$;

create function _is_owner() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from owners where auth_uid = auth.uid())
$$;

-- What a place may do: its switches, or the defaults for its type (same as the app's DEFAULT_PERMS).
create function _place_perms(l locations) returns text[] language sql immutable as $$
  select case
    when l.perms is null or l.perms = '' then
      case l.type when 'shop' then array['sell', 'returns', 'discount', 'receive', 'expenses']
        else array['receive', 'buy', 'send', 'add_items', 'correct_stock', 'expenses', 'see_cost'] end
    else array(select key from jsonb_each_text(l.perms::jsonb) where value in ('1', 'true')) end
$$;

create type vz_ctx as (device_id integer, owner boolean, location_id bigint, user_id bigint, place_perms text[], perms text[]);

-- Which device is calling, where it is, and what the person working on it may do.
-- Errors start with "VZ:<kind>:" so the app can show the right message.
create function _context(p_device integer, p_user bigint) returns vz_ctx language plpgsql stable security definer set search_path = public as $$
declare d devices; u users; l locations; c vz_ctx;
begin
  select * into d from devices where id = p_device and auth_uid = auth.uid();
  if not found then raise exception 'VZ:device:This device is not set up for Velanzo. Set it up again with a code from the owner.'; end if;
  if d.active <> 1 then raise exception 'VZ:removed:The owner removed this device from Velanzo.'; end if;
  c.device_id := d.id; c.location_id := d.location_id; c.user_id := p_user;
  if d.location_id is null then
    if not _is_owner() then raise exception 'VZ:device:Only the owner can use this device.'; end if;
    c.owner := true; c.place_perms := '{}'; c.perms := '{}';
    return c;
  end if;
  c.owner := false;
  select * into l from locations where id = d.location_id;
  if not found then raise exception 'VZ:device:The shop this device belongs to no longer exists.'; end if;
  c.place_perms := _place_perms(l);
  c.perms := c.place_perms;
  select * into u from users where id = p_user and active = 1;
  if not found then
    c.perms := '{}';                   -- nobody logged in: may only download (for the login screen)
  elsif u.role = 'staff' then
    if u.location_id is distinct from d.location_id then raise exception 'VZ:perm:% does not work at this place.', u.name; end if;
    if coalesce(u.perms, '') <> '' then
      c.perms := array(select x from unnest(c.place_perms) x
        where x in (select key from jsonb_each_text(u.perms::jsonb) where value in ('1', 'true')));
    end if;
  end if;
  return c;
end $$;

create function _need(c vz_ctx, perm text, what text) returns void language plpgsql immutable as $$
begin
  if not c.owner and not (perm = any(c.perms)) then
    raise exception 'VZ:perm:% is switched off for this person or place.', what;
  end if;
end $$;

create function _deny(what text) returns void language plpgsql immutable as $$
begin
  raise exception 'VZ:perm:%', what;
end $$;

-- Checks one record sent by a device and writes it.
-- New records: inserted. Existing records: only the columns that person may change are updated.
create function _apply(c vz_ctx, t text, r jsonb, del boolean, del_key text) returns void
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
      if is_new or (r ->> 'id')::bigint is distinct from c.user_id then perform _deny('Only the owner can add or change people.'); end if;
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

-- Remembers when each device was last online and who was working on it (for the owner's "Right now").
create function _seen(c vz_ctx, p_now text) returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from devices where id = c.device_id and (seen_ts is null or seen_ts < now() - interval '60 seconds'
      or last_user_id is distinct from coalesce(c.user_id, last_user_id))) then
    perform pg_advisory_xact_lock(4242);
    update devices set last_seen_at = coalesce(p_now, last_seen_at), last_user_id = coalesce(c.user_id, last_user_id), seen_ts = now()
    where id = c.device_id;
  end if;
end $$;

-- ---------- What devices call ----------

-- Sends this device's changes. p_groups = [{ grp, rows: [{ t, r } | { t, k, del: 1 }] }]; each group is saved whole or not at all.
-- Returns { results: [{ grp, ok, error? }] }. A group already received before is answered ok again.
create function push(p_device integer, p_user bigint, p_groups jsonb, p_now text default null) returns jsonb
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
      delete from _touched;
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
      results := results || jsonb_build_array(jsonb_build_object('grp', g ->> 'grp', 'ok', false,
        'error', regexp_replace(msg, '^VZ:[a-z]+:', '')));
    end;
  end loop;
  perform _seen(c, p_now);
  return jsonb_build_object('results', results);
end $$;

-- Changes after p_since that this device may see. Returns { rows, cursor, more, scope, epoch }.
-- scope changes when the place's switches change, epoch when the owner restores a backup: the device then downloads everything again.
create function pull(p_device integer, p_user bigint, p_since bigint, p_limit integer default 2000, p_now text default null) returns jsonb
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
    union all select 'users', x.rev, case when v_owner or x.location_id = v_loc or x.role = 'admin' then to_jsonb(x)
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

-- ---------- Setting up devices ----------

-- What the signed-in account is: { has_owner, is_owner }
create function velanzo_whoami() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('has_owner', exists (select 1 from owners), 'is_owner', _is_owner())
$$;

-- The very first account to call this becomes the owner. Nobody else can after that.
create function create_owner(p_email text default null) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'VZ:auth:Sign in first.'; end if;
  perform pg_advisory_xact_lock(4243);
  if _is_owner() then return jsonb_build_object('ok', true); end if;
  if exists (select 1 from owners) then raise exception 'VZ:perm:This Velanzo already has an owner. Ask the owner for a device code.'; end if;
  insert into owners (auth_uid, email) values (auth.uid(), p_email);
  return jsonb_build_object('ok', true);
end $$;

-- The owner signs in on a new phone or computer: it becomes an owner device (sees every shop).
create function register_owner_device(p_label text, p_now text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare d devices;
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  perform pg_advisory_xact_lock(4242);
  insert into devices (auth_uid, label, location_id, created_at) values (auth.uid(), left(p_label, 60), null, p_now) returning * into d;
  update devices set code = _letters(d.id) where id = d.id;
  return jsonb_build_object('id', d.id, 'code', _letters(d.id), 'location_id', null);
end $$;

-- The owner makes a one-time code for a shop or warehouse computer (valid 24 hours), e.g. "K7QM-3XPA".
create function create_setup_code(p_location bigint) returns text language plpgsql volatile security definer set search_path = public as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b bytea := uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid());
  code text := '';
  i integer;
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  if not exists (select 1 from locations where id = p_location) then
    raise exception 'VZ:bad:This place has not reached the cloud yet. Wait until "All saved online" shows, then try again.';
  end if;
  for i in 0..7 loop code := code || substr(alphabet, get_byte(b, i) % 32 + 1, 1); end loop;
  delete from setup_codes where expires_at < now() or used_at is not null;
  insert into setup_codes (code_hash, location_id, created_by, expires_at)
    values (encode(sha256(convert_to(code, 'UTF8')), 'hex'), p_location, auth.uid(), now() + interval '24 hours');
  return substr(code, 1, 4) || '-' || substr(code, 5, 4);
end $$;

-- A shop or warehouse computer types the owner's code (it is signed in anonymously) and becomes that place's device.
create function claim_device(p_code text, p_label text, p_now text default null) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  sc setup_codes;
  d devices;
begin
  if auth.uid() is null then raise exception 'VZ:auth:Sign in first.'; end if;
  if (select count(*) from claim_attempts where auth_uid = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'VZ:wait:Too many wrong codes. Wait an hour and try again.';
  end if;
  select * into sc from setup_codes where code_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex')
    and used_at is null and expires_at > now() for update;
  if not found then
    insert into claim_attempts (auth_uid) values (auth.uid());
    raise exception 'VZ:code:This code is wrong or too old. Ask the owner for a new one.';
  end if;
  update setup_codes set used_at = now() where code_hash = sc.code_hash;
  perform pg_advisory_xact_lock(4242);
  insert into devices (auth_uid, label, location_id, created_at) values (auth.uid(), left(p_label, 60), sc.location_id, p_now) returning * into d;
  update devices set code = _letters(d.id) where id = d.id;
  return jsonb_build_object('id', d.id, 'code', _letters(d.id), 'location_id', sc.location_id);
end $$;

-- The owner removes a lost or old device: it can no longer download or send anything.
create function remove_device(p_id integer) returns void language plpgsql security definer set search_path = public as $$
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  perform pg_advisory_xact_lock(4242);
  update devices set active = 0 where id = p_id;
end $$;

-- Before restoring a backup: empties the shop data. Every device then downloads again (new epoch),
-- and the owner's device sends up the restored data.
create function restore_begin() returns text language plpgsql security definer set search_path = public as $$
declare e text := gen_random_uuid()::text;
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can restore a backup.'; end if;
  perform pg_advisory_xact_lock(4242);
  truncate settings, locations, users, suppliers, products, stock, movements, purchases, purchase_items, supplier_payments,
    dispatches, dispatch_items, sales, sale_items, expenses, tombstones, push_log;
  update meta set value = e where key = 'epoch';
  return e;
end $$;

-- ---------- Who may call what ----------
-- Supabase lets every signed-in user call functions by default; only the ones above are meant for devices.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function push(integer, bigint, jsonb, text), pull(integer, bigint, bigint, integer, text), velanzo_whoami(),
  create_owner(text), register_owner_device(text, text), create_setup_code(bigint), claim_device(text, text, text),
  remove_device(integer), restore_begin() to authenticated;
