-- Neon PostgreSQL schema for Catolica Payments.
-- Apply this file with the Neon SQL Editor or any PostgreSQL migration runner.
-- Firebase UIDs are text; the API verifies them before calling these functions.
create extension if not exists pgcrypto;

create table if not exists public.user_roles (
  user_id text primary key,
  role text not null check (role in ('ADMIN', 'CASHIER')),
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (reference ~ '^CAT-[0-9]{8}-[A-Z2-9]{6}$'),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'PEN' check (currency = 'PEN'),
  provider text not null,
  provider_payment_id text unique,
  idempotency_key text unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED')),
  created_by text,
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

create table if not exists public.quick_amounts (
  id uuid primary key default gen_random_uuid(), amount_cents integer not null check (amount_cents > 0 and amount_cents <= 1000000),
  sort_order integer not null check (sort_order >= 0 and sort_order < 12), active boolean not null default true,
  created_by text, updated_by text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists quick_amounts_amount_uq on public.quick_amounts (amount_cents);
create unique index if not exists quick_amounts_sort_order_uq on public.quick_amounts (sort_order) where active;
insert into public.quick_amounts (amount_cents, sort_order)
values (1000, 0), (1500, 1), (2000, 2), (2500, 3), (3000, 4), (4000, 5), (5000, 6)
on conflict (amount_cents) do nothing;

create table if not exists public.webhook_receipts (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null,
  body_sha256 text not null, outcome text not null check (outcome in ('ACCEPTED', 'DUPLICATE', 'REJECTED', 'ERROR')),
  error_code text, received_at timestamptz not null default now(), processed_at timestamptz,
  unique (provider, provider_event_id)
);
create table if not exists public.job_locks (
  job_name text primary key, lock_token uuid not null, locked_until timestamptz not null, updated_at timestamptz not null default now()
);
create table if not exists public.api_rate_limits (
  bucket_key text primary key, window_started_at timestamptz not null default now(), request_count integer not null default 0
);

create or replace function public.apply_payment_webhook(
  p_provider text, p_provider_payment_id text, p_reference text, p_amount_cents integer, p_currency text,
  p_provider_event_id text, p_event_type text, p_raw_payload jsonb, p_new_status text, p_paid_at timestamptz
) returns jsonb language plpgsql security definer set search_path = public as $$
declare payment_row public.payments%rowtype; event_row public.payment_events%rowtype; previous_status text;
begin
  if nullif(trim(p_provider), '') is null or nullif(trim(p_provider_payment_id), '') is null or nullif(trim(p_reference), '') is null
     or nullif(trim(p_provider_event_id), '') is null or nullif(trim(p_event_type), '') is null or p_amount_cents is null or p_amount_cents <= 0
     or p_currency is distinct from 'PEN' or p_new_status not in ('PAID','FAILED','EXPIRED','CANCELLED')
     or (p_new_status = 'PAID' and p_paid_at is null) then raise exception 'invalid payment webhook' using errcode = '22023'; end if;
  select * into payment_row from public.payments where provider = p_provider and provider_payment_id = p_provider_payment_id and reference = p_reference for update;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  if payment_row.amount_cents <> p_amount_cents or payment_row.currency <> p_currency then raise exception 'payment amount mismatch' using errcode = '22023'; end if;
  select * into event_row from public.payment_events where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    if event_row.payment_id <> payment_row.id or event_row.new_status <> p_new_status then raise exception 'provider event ID has conflicting payment data' using errcode = '22023'; end if;
    return jsonb_build_object('changed', false, 'duplicate', true, 'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;
  if payment_row.status <> 'PENDING' and not (payment_row.status = 'EXPIRED' and p_new_status = 'PAID') then
    return jsonb_build_object('changed', false, 'duplicate', false, 'payment', to_jsonb(payment_row));
  end if;
  previous_status := payment_row.status;
  update public.payments set status = p_new_status, paid_at = case when p_new_status = 'PAID' then p_paid_at else null end,
    cancelled_at = case when p_new_status = 'CANCELLED' then coalesce(p_paid_at, now()) else null end where id = payment_row.id returning * into payment_row;
  insert into public.payment_events(payment_id,event_type,previous_status,new_status,provider,provider_event_id,raw_payload)
    values(payment_row.id,p_event_type,previous_status,p_new_status,p_provider,p_provider_event_id,coalesce(p_raw_payload,'{}'::jsonb)) returning * into event_row;
  return jsonb_build_object('changed', true, 'duplicate', false, 'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
exception when unique_violation then
  select * into event_row from public.payment_events where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then select * into payment_row from public.payments where id = event_row.payment_id; return jsonb_build_object('changed',false,'duplicate',true,'payment',to_jsonb(payment_row),'event',to_jsonb(event_row)); end if;
  raise;
end; $$;

create or replace function public.attach_payment_provider(p_payment_id uuid, p_provider text, p_provider_payment_id text, p_provider_data jsonb, p_expires_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare payment_row public.payments%rowtype;
begin
  select * into payment_row from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  if payment_row.provider <> p_provider or nullif(trim(p_provider_payment_id),'') is null then raise exception 'invalid provider attachment' using errcode = '22023'; end if;
  if payment_row.provider_payment_id is not null then
    if payment_row.provider_payment_id <> p_provider_payment_id then raise exception 'provider payment ID mismatch' using errcode = '22023'; end if;
    return jsonb_build_object('attached',false,'duplicate',true,'payment',to_jsonb(payment_row));
  end if;
  update public.payments set provider_payment_id=p_provider_payment_id, provider_data=coalesce(p_provider_data,'{}'::jsonb), expires_at=coalesce(p_expires_at,expires_at) where id=p_payment_id returning * into payment_row;
  return jsonb_build_object('attached',true,'duplicate',false,'payment',to_jsonb(payment_row));
exception when unique_violation then raise exception 'provider payment ID already exists' using errcode = '23505';
end; $$;

create or replace function public.expire_payment(p_payment_id uuid, p_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare payment_row public.payments%rowtype; event_row public.payment_events%rowtype;
begin
  select * into payment_row from public.payments where id=p_payment_id for update;
  if not found then raise exception 'payment not found' using errcode='P0002'; end if;
  if payment_row.status <> 'PENDING' then return jsonb_build_object('changed',false,'payment',to_jsonb(payment_row)); end if;
  update public.payments set status='EXPIRED' where id=p_payment_id returning * into payment_row;
  insert into public.payment_events(payment_id,event_type,previous_status,new_status,provider,provider_event_id,raw_payload,created_at)
    values(payment_row.id,'payment.expired','PENDING','EXPIRED',payment_row.provider,'expiry:'||payment_row.id::text||':'||extract(epoch from p_at)::text,'{"reason":"expires_at reached"}'::jsonb,p_at) returning * into event_row;
  return jsonb_build_object('changed',true,'payment',to_jsonb(payment_row),'event',to_jsonb(event_row));
end; $$;

create or replace function public.record_cash_payment(p_id uuid,p_reference text,p_amount_cents integer,p_created_by text,p_created_at timestamptz,p_paid_at timestamptz,p_provider_data jsonb,p_event_id uuid,p_event_provider_id text,p_event_created_at timestamptz,p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare payment_row public.payments%rowtype; event_row public.payment_events%rowtype;
begin
  insert into public.payments(id,reference,amount_cents,currency,provider,status,created_by,created_at,paid_at,provider_data,idempotency_key)
  values(p_id,p_reference,p_amount_cents,'PEN','CASH','PAID',p_created_by,p_created_at,p_paid_at,coalesce(p_provider_data,'{"method":"cash"}'::jsonb),nullif(trim(p_idempotency_key),'')) returning * into payment_row;
  insert into public.payment_events(id,payment_id,event_type,previous_status,new_status,provider,provider_event_id,raw_payload,created_at)
  values(p_event_id,payment_row.id,'cash.recorded','PENDING','PAID','CASH',p_event_provider_id,'{}'::jsonb,p_event_created_at) returning * into event_row;
  return jsonb_build_object('payment',to_jsonb(payment_row),'event',to_jsonb(event_row));
end; $$;

create or replace function public.cancel_payment(p_payment_id uuid,p_provider text,p_provider_payment_id text,p_reference text,p_provider_event_id text,p_event_id uuid,p_actor_id text,p_reason text,p_cancelled_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public as $$
declare payment_row public.payments%rowtype; event_row public.payment_events%rowtype; payload jsonb;
begin
  select * into payment_row from public.payments where id=p_payment_id and provider=p_provider and provider_payment_id=p_provider_payment_id and reference=p_reference for update;
  if not found then raise exception 'payment not found' using errcode='P0002'; end if;
  select * into event_row from public.payment_events where provider=p_provider and provider_event_id=p_provider_event_id;
  if found then select * into payment_row from public.payments where id=event_row.payment_id; return jsonb_build_object('changed',false,'duplicate',true,'payment',to_jsonb(payment_row),'event',to_jsonb(event_row)); end if;
  if payment_row.status <> 'PENDING' then return jsonb_build_object('changed',false,'payment',to_jsonb(payment_row)); end if;
  payload := jsonb_build_object('source','admin_cancel','actor_id',p_actor_id) || case when nullif(trim(coalesce(p_reason,'')),'') is null then '{}'::jsonb else jsonb_build_object('reason',trim(p_reason)) end;
  update public.payments set status='CANCELLED',cancelled_at=p_cancelled_at where id=p_payment_id returning * into payment_row;
  insert into public.payment_events(id,payment_id,event_type,previous_status,new_status,provider,provider_event_id,raw_payload,created_at)
  values(p_event_id,p_payment_id,'payment.cancelled.admin','PENDING','CANCELLED',p_provider,p_provider_event_id,payload,p_cancelled_at) returning * into event_row;
  return jsonb_build_object('changed',true,'payment',to_jsonb(payment_row),'event',to_jsonb(event_row));
end; $$;

create or replace function public.admin_set_user_role(p_user_id text,p_role text,p_actor_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare role_value text := upper(trim(coalesce(p_role,'')));
begin
  if nullif(trim(p_user_id),'') is null or role_value not in ('ADMIN','CASHIER') then raise exception 'invalid user role assignment' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('catolica:user-role-admin',0));
  if p_user_id=p_actor_id and role_value <> 'ADMIN' then raise exception 'administrator cannot remove own admin role' using errcode='P0001'; end if;
  if role_value='CASHIER' and exists(select 1 from public.user_roles where user_id=p_user_id and role='ADMIN') and (select count(*) from public.user_roles where role='ADMIN') <= 1 then raise exception 'institution must retain one administrator' using errcode='P0001'; end if;
  insert into public.user_roles(user_id,role) values(p_user_id,role_value) on conflict(user_id) do update set role=excluded.role;
  return jsonb_build_object('user_id',p_user_id,'role',role_value);
end; $$;

create or replace function public.replace_quick_amounts(p_amounts jsonb,p_actor_id text)
returns setof public.quick_amounts language plpgsql security definer set search_path=public as $$
begin
  delete from public.quick_amounts;
  insert into public.quick_amounts(amount_cents,sort_order,created_by,updated_by)
    select (item->>'amount_cents')::integer,(position-1)::integer,p_actor_id,p_actor_id from jsonb_array_elements(p_amounts) with ordinality as rows(item,position);
  return query select * from public.quick_amounts order by sort_order;
end; $$;

create or replace function public.acquire_job_lock(p_job_name text,p_lease_seconds integer default 600)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_now timestamptz:=clock_timestamp(); v_token uuid:=gen_random_uuid(); v_acquired uuid;
begin
  insert into public.job_locks(job_name,lock_token,locked_until,updated_at) values(p_job_name,v_token,v_now+make_interval(secs=>p_lease_seconds),v_now)
  on conflict(job_name) do update set lock_token=excluded.lock_token,locked_until=excluded.locked_until,updated_at=excluded.updated_at where public.job_locks.locked_until<=v_now returning lock_token into v_acquired;
  return v_acquired;
end; $$;
create or replace function public.release_job_lock(p_job_name text,p_lock_token uuid) returns boolean language plpgsql security definer set search_path=public as $$ begin delete from public.job_locks where job_name=p_job_name and lock_token=p_lock_token; return found; end; $$;
create or replace function public.consume_api_rate_limit(p_bucket_key text,p_limit integer,p_window_seconds integer default 60)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_now timestamptz:=clock_timestamp(); v_row public.api_rate_limits%rowtype;
begin
  insert into public.api_rate_limits(bucket_key,window_started_at,request_count) values(p_bucket_key,v_now,0) on conflict(bucket_key) do nothing;
  select * into v_row from public.api_rate_limits where bucket_key=p_bucket_key for update;
  if v_now >= v_row.window_started_at+make_interval(secs=>p_window_seconds) then update public.api_rate_limits set window_started_at=v_now,request_count=1 where bucket_key=p_bucket_key; return true; end if;
  if v_row.request_count >= p_limit then return false; end if;
  update public.api_rate_limits set request_count=request_count+1 where bucket_key=p_bucket_key; return true;
end; $$;
