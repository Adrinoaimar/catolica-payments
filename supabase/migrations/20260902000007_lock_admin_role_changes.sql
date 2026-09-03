-- Backport the administrator-role race fix for projects that already ran
-- 20260902000004_admin_settings.sql.
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  role_value text := upper(trim(coalesce(p_role, '')));
begin
  if p_user_id is null or p_actor_id is null or role_value not in ('ADMIN', 'CASHIER') then
    raise exception 'invalid user role assignment' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('catolica:user-role-admin', 0));
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  if p_user_id = p_actor_id and role_value <> 'ADMIN' then
    raise exception 'administrator cannot remove own admin role' using errcode = 'P0001';
  end if;
  if role_value = 'CASHIER'
     and exists (select 1 from public.user_roles where user_id = p_user_id and role = 'ADMIN')
     and (select count(*) from public.user_roles where role = 'ADMIN') <= 1 then
    raise exception 'institution must retain one administrator' using errcode = 'P0001';
  end if;

  insert into public.user_roles (user_id, role)
    values (p_user_id, role_value)
    on conflict (user_id) do update set role = excluded.role;
  return jsonb_build_object('user_id', p_user_id, 'role', role_value);
end;
$$;

revoke all on function public.admin_set_user_role(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_user_role(uuid, text, uuid) to service_role;
