-- Atomic ledger operations used by serverless routes.
-- Apply after 20260902000000_payments.sql.

-- Role lookup is only needed by authenticated clients and server-side code.
revoke all on function public.current_app_role() from public, anon;
grant execute on function public.current_app_role() to authenticated, service_role;

-- Ledger mutations must pass through authenticated serverless routes and the
-- SECURITY DEFINER functions below. Authenticated browsers can read, never
-- insert or alter payment rows directly.
drop policy if exists payments_cashier_insert on public.payments;

-- Replace the initial PAID-only overload with the terminal-status-aware RPC.
drop function if exists public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb);

create or replace function public.apply_payment_webhook(
  p_provider text,
  p_provider_payment_id text,
  p_reference text,
  p_amount_cents integer,
  p_currency text,
  p_provider_event_id text,
  p_event_type text,
  p_raw_payload jsonb,
  p_new_status text
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
  if nullif(trim(p_provider), '') is null
     or nullif(trim(p_provider_payment_id), '') is null
     or nullif(trim(p_reference), '') is null
     or nullif(trim(p_provider_event_id), '') is null
     or nullif(trim(p_event_type), '') is null
     or length(trim(p_provider_payment_id)) > 200
     or length(trim(p_reference)) > 200
     or length(trim(p_provider_event_id)) > 200
     or length(trim(p_event_type)) > 200
     or p_amount_cents is null or p_amount_cents <= 0 or p_currency is distinct from 'PEN' then
    raise exception 'invalid payment webhook' using errcode = '22023';
  end if;
  if p_new_status is null or p_new_status not in ('PAID', 'FAILED', 'EXPIRED', 'CANCELLED') then
    raise exception 'invalid payment webhook status' using errcode = '22023';
  end if;

  select * into payment_row from public.payments
    where provider = p_provider and provider_payment_id = p_provider_payment_id
      and reference = p_reference for update;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  if payment_row.amount_cents <> p_amount_cents or payment_row.currency <> p_currency then
    raise exception 'payment amount mismatch' using errcode = '22023';
  end if;

  -- Existing provider event is a successful no-op only when it belongs to
  -- this exact payment. A reused event ID must never return another payment.
  select * into event_row from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    if event_row.payment_id <> payment_row.id then
      raise exception 'provider event ID belongs to another payment' using errcode = '22023';
    end if;
    return jsonb_build_object('changed', false, 'duplicate', true, 'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;
  if payment_row.status <> 'PENDING' then
    return jsonb_build_object('changed', false, 'duplicate', false, 'payment', to_jsonb(payment_row));
  end if;

  update public.payments
    set status = p_new_status,
        paid_at = case when p_new_status = 'PAID' then now() else null end,
        cancelled_at = case when p_new_status = 'CANCELLED' then now() else null end
    where id = payment_row.id
    returning * into payment_row;
  insert into public.payment_events(
    payment_id, event_type, previous_status, new_status, provider,
    provider_event_id, raw_payload
  ) values (
    payment_row.id, p_event_type, 'PENDING', p_new_status, p_provider,
    p_provider_event_id, coalesce(p_raw_payload, '{}'::jsonb)
  ) returning * into event_row;
  return jsonb_build_object('changed', true, 'duplicate', false, 'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
exception when unique_violation then
  -- Another concurrent invocation inserted this event. Return its committed
  -- result instead of failing/reapplying the financial transition.
  select * into event_row from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    if event_row.payment_id <> payment_row.id then
      raise exception 'provider event ID belongs to another payment' using errcode = '22023';
    end if;
    return jsonb_build_object('changed', false, 'duplicate', true, 'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;
  raise;
end;
$$;

create or replace function public.expire_payment(
  p_payment_id uuid,
  p_at timestamptz
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
  if p_payment_id is null or p_at is null then
    raise exception 'invalid expiry request' using errcode = '22023';
  end if;
  select * into payment_row from public.payments where id = p_payment_id for update;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  if payment_row.status <> 'PENDING' then
    return jsonb_build_object('changed', false, 'payment', to_jsonb(payment_row));
  end if;
  update public.payments set status = 'EXPIRED' where id = payment_row.id returning * into payment_row;
  insert into public.payment_events(
    payment_id, event_type, previous_status, new_status, provider,
    provider_event_id, raw_payload, created_at
  ) values (
    payment_row.id, 'payment.expired', 'PENDING', 'EXPIRED', payment_row.provider,
    'expiry:' || payment_row.id::text || ':' || extract(epoch from p_at)::text,
    '{"reason":"expires_at reached"}'::jsonb, p_at
  ) returning * into event_row;
  return jsonb_build_object('changed', true, 'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
end;
$$;

create or replace function public.record_cash_payment(
  p_id uuid,
  p_reference text,
  p_amount_cents integer,
  p_created_by uuid,
  p_created_at timestamptz,
  p_paid_at timestamptz,
  p_provider_data jsonb,
  p_event_id uuid,
  p_event_provider_id text,
  p_event_created_at timestamptz
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
  if p_id is null or p_event_id is null or nullif(trim(p_reference), '') is null
     or p_amount_cents is null or p_amount_cents <= 0
     or nullif(trim(p_event_provider_id), '') is null
     or p_created_at is null or p_paid_at is null or p_event_created_at is null then
    raise exception 'invalid cash payment' using errcode = '22023';
  end if;
  insert into public.payments(
    id, reference, amount_cents, currency, provider, provider_payment_id,
    status, created_by, created_at, expires_at, paid_at, cancelled_at, provider_data
  ) values (
    p_id, p_reference, p_amount_cents, 'PEN', 'CASH', null,
    'PAID', p_created_by, p_created_at, null, p_paid_at, null,
    coalesce(p_provider_data, '{"method":"cash"}'::jsonb)
  ) returning * into payment_row;
  insert into public.payment_events(
    id, payment_id, event_type, previous_status, new_status, provider,
    provider_event_id, raw_payload, created_at
  ) values (
    p_event_id, payment_row.id, 'cash.recorded', 'PENDING', 'PAID', 'CASH',
    p_event_provider_id, '{}'::jsonb, p_event_created_at
  ) returning * into event_row;
  return jsonb_build_object('payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
end;
$$;

revoke all on function public.expire_payment(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.expire_payment(uuid, timestamptz) to service_role;
revoke all on function public.record_cash_payment(uuid, text, integer, uuid, timestamptz, timestamptz, jsonb, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_cash_payment(uuid, text, integer, uuid, timestamptz, timestamptz, jsonb, uuid, text, timestamptz) to service_role;
revoke all on function public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb, text) to service_role;
