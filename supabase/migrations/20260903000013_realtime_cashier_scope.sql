-- Scope the safe Realtime projection to the same Lima-day boundary used by
-- the authenticated list API. Admins retain the full operational stream.
alter table public.payment_updates add column if not exists created_by uuid;
alter table public.payment_updates add column if not exists created_at timestamptz;

drop policy if exists payment_updates_authenticated_read on public.payment_updates;
create policy payment_updates_authenticated_read on public.payment_updates
  for select to authenticated
  using (
    public.current_app_role() = 'ADMIN'
    or (
      public.current_app_role() = 'CASHIER'
      and created_at >= ((now() at time zone 'America/Lima')::date at time zone 'America/Lima')
      and created_at < (((now() at time zone 'America/Lima')::date + 1) at time zone 'America/Lima')
    )
  );

create or replace function public.refresh_payment_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.payment_updates where id = old.id;
    return old;
  end if;

  insert into public.payment_updates (id, reference, changed_at, created_by, created_at)
    values (new.id, new.reference, now(), new.created_by, new.created_at)
    on conflict (id) do update
      set reference = excluded.reference,
          changed_at = excluded.changed_at,
          created_by = excluded.created_by,
          created_at = excluded.created_at;
  return new;
end;
$$;

insert into public.payment_updates (id, reference, changed_at, created_by, created_at)
  select id, reference, coalesce(paid_at, created_at, now()), created_by, created_at
  from public.payments
  on conflict (id) do update
    set reference = excluded.reference,
        created_by = excluded.created_by,
        created_at = excluded.created_at;
