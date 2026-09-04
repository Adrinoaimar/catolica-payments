-- Preserve provider-confirmed captures that race or follow local expiry.
-- A late PAID event transitions EXPIRED -> PAID and records the prior state;
-- it is never silently discarded from the financial ledger.
drop function if exists public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb, text);

create or replace function public.apply_payment_webhook(
  p_provider text,
  p_provider_payment_id text,
  p_reference text,
  p_amount_cents integer,
  p_currency text,
  p_provider_event_id text,
  p_event_type text,
  p_raw_payload jsonb,
  p_new_status text,
  p_paid_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_row public.payments%rowtype;
  event_row public.payment_events%rowtype;
  previous_status text;
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
     or p_currency is distinct from 'PEN'
     or p_new_status is null
     or p_new_status not in ('PAID', 'FAILED', 'EXPIRED', 'CANCELLED')
     or (p_new_status = 'PAID' and p_paid_at is null) then
    raise exception 'invalid payment webhook' using errcode = '22023';
  end if;

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
    if event_row.payment_id <> payment_row.id or event_row.new_status <> p_new_status then
      raise exception 'provider event ID has conflicting payment data' using errcode = '22023';
    end if;
    return jsonb_build_object('changed', false, 'duplicate', true,
      'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;

  -- Only a late provider capture may reopen an expired row. FAILED,
  -- CANCELLED and EXPIRED events remain terminal no-ops after local expiry.
  if payment_row.status <> 'PENDING'
     and not (payment_row.status = 'EXPIRED' and p_new_status = 'PAID') then
    return jsonb_build_object('changed', false, 'duplicate', false, 'payment', to_jsonb(payment_row));
  end if;

  previous_status := payment_row.status;
  update public.payments
    set status = p_new_status,
        paid_at = case when p_new_status = 'PAID' then p_paid_at else null end,
        cancelled_at = case when p_new_status = 'CANCELLED' then coalesce(p_paid_at, now()) else null end
    where id = payment_row.id
    returning * into payment_row;
  insert into public.payment_events(
    payment_id, event_type, previous_status, new_status, provider,
    provider_event_id, raw_payload
  ) values (
    payment_row.id, p_event_type, previous_status, p_new_status, p_provider,
    p_provider_event_id, coalesce(p_raw_payload, '{}'::jsonb)
  ) returning * into event_row;
  return jsonb_build_object('changed', true, 'duplicate', false,
    'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
exception when unique_violation then
  select * into event_row from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    select * into payment_row from public.payments where id = event_row.payment_id;
    if event_row.new_status <> p_new_status then
      raise exception 'provider event ID has conflicting payment data' using errcode = '22023';
    end if;
    return jsonb_build_object('changed', false, 'duplicate', true,
      'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;
  raise;
end;
$$;

-- Remove the legacy bulk expiry RPC. It could expire TAYPI rows without
-- asking the provider; expiry is now provider-aware in the API scheduler.
drop function if exists public.expire_pending_payments(timestamptz);

revoke all on function public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_payment_webhook(text, text, text, integer, text, text, text, jsonb, text, timestamptz)
  to service_role;
