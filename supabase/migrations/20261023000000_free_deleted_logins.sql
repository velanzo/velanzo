-- Velanzo cloud database: the user ID of a deleted person can be used again.
-- Run this once in Supabase (SQL Editor). Never edit it afterwards.

create or replace function set_user_login(p_user bigint, p_login text, p_password text) returns void language plpgsql security definer set search_path = public as $$
declare v_login text := lower(trim(coalesce(p_login, '')));
begin
  if not _is_owner() then raise exception 'VZ:perm:Only the owner can do this.'; end if;
  if v_login !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then raise exception 'VZ:bad:The user ID must be 3 to 30 letters or numbers (no spaces).'; end if;
  if not exists (select 1 from users where id = p_user and role = 'staff') then raise exception 'VZ:bad:This person is not saved in the cloud yet. Wait until "All saved online" shows, then try again.'; end if;
  -- a login left behind by a deleted person no longer belongs to anyone
  delete from user_logins ul where lower(ul.login_id) = v_login and ul.user_id <> p_user and not exists (select 1 from users where id = ul.user_id);
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
