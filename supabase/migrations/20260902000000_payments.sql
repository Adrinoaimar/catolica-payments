-- Grupo La Católica payment ledger. Money is integer cents; all state changes audited.
create extension if not exists pgcrypto;

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('ADMIN', 'CASHIER')),
  created_at timestamptz not null default now()
);

create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.user_roles where user_id = auth.uid();
$$;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (reference ~ '^CAT-[0-9]{8}-[A-Z2-9]{6}$'),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'PEN' check (currency = 'PEN'),
  provider text not null,
  provider_payment_id text unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  provider_data jsonb not null default '{}'::jsonb
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  event_type text not null,
  previous_status text not null check (previous_status in ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')),
  new_status text not null check (new_status in ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')),
  provider text not null,
  provider_event_id text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create index if not exists payments_created_at_idx on public.payments (created_at desc);
create index if not exists payments_status_expires_at_idx on public.payments (status, expires_at) where status = 'PENDING';
create index if not exists payments_created_by_idx on public.payments (created_by);
create index if not exists payment_events_payment_id_idx on public.payment_events (payment_id, created_at desc);

alter table public.user_roles enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;

drop policy if exists user_roles_self_read on public.user_roles;
create policy user_roles_self_read on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() = 'ADMIN');

drop policy if exists payments_authenticated_read on public.payments;
create policy payments_authenticated_read on public.payments for select to authenticated
  using (public.current_app_role() in ('ADMIN', 'CASHIER'));

drop policy if exists payments_cashier_insert on public.payments;
create policy payments_cashier_insert on public.payments for insert to authenticated
  with check (public.current_app_role() in ('ADMIN', 'CASHIER') and (created_by = auth.uid() or public.current_app_role() = 'ADMIN'));

-- Frontend roles cannot mutate the ledger. Webhooks use service role or the RPC below.
drop policy if exists payments_no_client_update on public.payments;
create policy payments_no_client_update on public.payments for update to authenticated using (false) with check (false);
drop policy if exists payments_no_client_delete on public.payments;
create policy payments_no_client_delete on public.payments for delete to authenticated using (false);
drop policy if exists payment_events_authenticated_read on public.payment_events;
create policy payment_events_authenticated_read on public.payment_events for select to authenticated
  using (public.current_app_role() in ('ADMIN', 'CASHIER'));

create or replace function public.apply_payment_webhook(
  p_provider text,
  p_provider_payment_id text,
  p_reference text,
  p_amount_cents integer,
  p_currency text,
  p_provider_event_id text,
  p_event_type text,
  p_raw_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_row public.payments%rowtype;
  event_row public.payment_events%rowtype;
begin
  if p_amount_cents is null or p_amount_cents <= 0 or p_currency <> 'PEN' then
    raise exception 'invalid payment amount or currency' using errcode = '22023';
  end if;

  -- Existing provider event is a successful no-op. Unique constraint also protects races.
  select * into event_row from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    select * into payment_row from public.payments where id = event_row.payment_id;
    return jsonb_build_object('changed', false, 'duplicate', true, 'payment', to_jsonb(payment_row));
  end if;

  select * into payment_row from public.payments
    where provider = p_provider and provider_payment_id = p_provider_payment_id
      and reference = p_reference for update;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  if payment_row.amount_cents <> p_amount_cents or payment_row.currency <> p_currency then
    raise exception 'payment amount mismatch' using errcode = '22023';
  end if;
  if payment_row.status <> 'PENDING' then
    return jsonb_build_object('changed', false, 'duplicate', false, 'payment', to_jsonb(payment_row));
  end if;

  update public.payments set status = 'PAID', paid_at = now() where id = payment_row.id returning * into payment_row;
  insert into public.payment_events(payment_id, event_type, previous_status, new_status, provider, provider_event_id, raw_payload)
    values (payment_row.id, p_event_type, 'PENDING', 'PAID', p_provider, p_provider_event_id, coalesce(p_raw_payload, '{}'::jsonb))
    returning * into event_row;
  return jsonb_build_object('changed', true, 'duplicate', false, 'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
exception when unique_violation then
  select * into event_row from public.payment_events where provider = p_provider and provider_event_id = p_provider_event_id;
  select * into payment_row from public.payments where id = event_row.payment_id;
  return jsonb_build_object('changed', false, 'duplicate', true, 'payment', to_jsonb(payment_row));
end;
$$;

create or replace function public.expire_pending_payments(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare changed_count integer;
begin
  with expired as (
    update public.payments
      set status = 'EXPIRED'
      where status = 'PENDING' and expires_at is not null and expires_at <= p_now
      returning id, provider
  )
  insert into public.payment_events(payment_id, event_type, previous_status, new_status, provider, provider_event_id, raw_payload)
    select id, 'payment.expired', 'PENDING', 'EXPIRED', provider, 'expiry:' || id::text || ':' || p_now::text, '{"reason":"expires_at reached"}'::jsonb from expired;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$$;

revoke all on function public.apply_payment_webhook(text,text,text,integer,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.apply_payment_webhook(text,text,text,integer,text,text,text,jsonb) to service_role;
revoke all on function public.expire_pending_payments(timestamptz) from public, anon, authenticated;
grant execute on function public.expire_pending_payments(timestamptz) to service_role;
