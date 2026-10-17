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
