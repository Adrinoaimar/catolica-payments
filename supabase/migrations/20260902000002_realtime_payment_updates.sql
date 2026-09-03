-- Safe Realtime projection. Never subscribe clients to public.payments:
-- that table contains provider_data, which is server-only metadata.
create table if not exists public.payment_updates (
  id uuid primary key references public.payments(id) on delete cascade,
  reference text not null unique check (reference ~ '^CAT-[0-9]{8}-[A-Z2-9]{6}$'),
  changed_at timestamptz not null default now()
);

alter table public.payment_updates enable row level security;

drop policy if exists payment_updates_authenticated_read on public.payment_updates;
create policy payment_updates_authenticated_read on public.payment_updates
  for select to authenticated
  using (public.current_app_role() in ('ADMIN', 'CASHIER'));

revoke insert, update, delete, truncate on public.payment_updates from anon, authenticated;
revoke all on public.payment_updates from anon;

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

  insert into public.payment_updates (id, reference, changed_at)
    values (new.id, new.reference, now())
    on conflict (id) do update
      set reference = excluded.reference, changed_at = excluded.changed_at;
  return new;
end;
$$;

drop trigger if exists payments_realtime_projection on public.payments;
create trigger payments_realtime_projection
  after insert or update or delete on public.payments
  for each row execute function public.refresh_payment_update();

-- Seed projection for payments created before this migration.
insert into public.payment_updates (id, reference, changed_at)
  select id, reference, coalesce(paid_at, created_at, now())
  from public.payments
  on conflict (id) do update
    set reference = excluded.reference, changed_at = excluded.changed_at;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication p
       join pg_publication_rel pr on pr.prpubid = p.oid
       where p.pubname = 'supabase_realtime'
         and pr.prrelid = 'public.payment_updates'::regclass
     ) then
    alter publication supabase_realtime add table public.payment_updates;
  end if;
end;
$$;

