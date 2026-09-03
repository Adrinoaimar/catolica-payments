-- Backport webhook identity hardening for projects that already applied the
-- earlier atomic-operation migrations.
-- A duplicate delivery is valid only for the same payment and terminal state;
-- a reused provider event ID must never return another payment.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_events_provider_event_id_length'
      and conrelid = 'public.payment_events'::regclass
  ) then
    alter table public.payment_events
      add constraint payment_events_provider_event_id_length
      check (length(provider_event_id) between 1 and 200) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_events_event_type_length'
      and conrelid = 'public.payment_events'::regclass
  ) then
    alter table public.payment_events
      add constraint payment_events_event_type_length
      check (length(event_type) between 1 and 200) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'payments_provider_payment_id_length'
      and conrelid = 'public.payments'::regclass
  ) then
    alter table public.payments
      add constraint payments_provider_payment_id_length
      check (provider_payment_id is null or length(provider_payment_id) between 1 and 200) not valid;
  end if;
end;
$$;

-- Installations that already ran the original eight-argument RPC must not
-- retain a weaker overload alongside the hardened nine-argument function.
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
     or p_amount_cents is null or p_amount_cents <= 0
     or p_currency is distinct from 'PEN' then
    raise exception 'invalid payment webhook' using errcode = '22023';
  end if;
  if p_new_status is null or p_new_status not in ('PAID', 'FAILED', 'EXPIRED', 'CANCELLED') then
    raise exception 'invalid payment webhook status' using errcode = '22023';
  end if;

  -- Lock the addressed row before checking a prior event. This makes the
  -- duplicate decision identity-bound even when deliveries race each other.
  select * into payment_row from public.payments
    where provider = p_provider and provider_payment_id = p_provider_payment_id
      and reference = p_reference for update;
  if not found then raise exception 'payment not found' using errcode = 'P0002'; end if;
  if payment_row.amount_cents <> p_amount_cents or payment_row.currency <> p_currency then
    raise exception 'payment amount mismatch' using errcode = '22023';
  end if;

  select * into event_row from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    if event_row.payment_id <> payment_row.id then
      raise exception 'provider event ID belongs to another payment' using errcode = '22023';
    end if;
    if event_row.new_status <> p_new_status then
      raise exception 'provider event ID has a conflicting status' using errcode = '22023';
    end if;
    return jsonb_build_object('changed', false, 'duplicate', true,
      'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
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
  return jsonb_build_object('changed', true, 'duplicate', false,
    'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
exception when unique_violation then
  -- Another concurrent invocation inserted this event. It is a duplicate only
  -- if the committed row belongs to the payment addressed by this call.
  select * into event_row from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    if event_row.payment_id <> payment_row.id or event_row.new_status <> p_new_status then
      raise exception 'provider event ID has conflicting payment data' using errcode = '22023';
    end if;
    return jsonb_build_object('changed', false, 'duplicate', true,
      'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;
  raise;
end;
$$;

revoke all on function public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb, text)
  to service_role;
