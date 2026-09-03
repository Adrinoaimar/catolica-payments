-- Administrative directory and configurable quick-charge amounts.
-- All mutations are performed by server-side routes using service_role.

create table if not exists public.quick_amounts (
  id uuid primary key default gen_random_uuid(),
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 1000000),
  sort_order integer not null check (sort_order >= 0 and sort_order < 12),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists quick_amounts_amount_uq on public.quick_amounts (amount_cents);
create unique index if not exists quick_amounts_sort_order_uq on public.quick_amounts (sort_order) where active;
create index if not exists quick_amounts_active_order_idx on public.quick_amounts (sort_order) where active;

alter table public.quick_amounts enable row level security;
grant select on public.quick_amounts to authenticated;
revoke insert, update, delete, truncate on public.quick_amounts from anon, authenticated;

drop policy if exists quick_amounts_authenticated_read on public.quick_amounts;
create policy quick_amounts_authenticated_read on public.quick_amounts
  for select to authenticated
  using (active and public.current_app_role() in ('ADMIN', 'CASHIER'));

-- Safe defaults keep a newly migrated institution usable until an administrator
-- chooses its own quick amounts.
insert into public.quick_amounts (amount_cents, sort_order)
values (1000, 0), (1500, 1), (2000, 2), (2500, 3), (3000, 4), (4000, 5), (5000, 6)
on conflict (amount_cents) do nothing;

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
  -- Serialize role changes so two simultaneous demotions cannot remove the
  -- institution's final administrator.
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

create or replace function public.replace_quick_amounts(
  p_amounts jsonb,
  p_actor_id uuid
)
returns setof public.quick_amounts
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_actor_id is null or p_amounts is null or jsonb_typeof(p_amounts) <> 'array'
     or jsonb_array_length(p_amounts) < 1 or jsonb_array_length(p_amounts) > 12 then
    raise exception 'quick amounts must contain between one and twelve items' using errcode = '22023';
  end if;

  delete from public.quick_amounts;
  insert into public.quick_amounts (amount_cents, sort_order, created_by, updated_by)
    select (item->>'amount_cents')::integer, (position - 1)::integer, p_actor_id, p_actor_id
    from jsonb_array_elements(p_amounts) with ordinality as rows(item, position);

  return query
    select * from public.quick_amounts order by sort_order;
exception when unique_violation or check_violation or invalid_text_representation then
  raise exception 'invalid quick amounts' using errcode = '22023';
end;
$$;

revoke all on function public.replace_quick_amounts(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.replace_quick_amounts(jsonb, uuid) to service_role;
