-- Administrative cancellation. Provider cancellation happens first in the
-- server route; this SECURITY DEFINER RPC commits ledger state and audit event
-- only after that external operation succeeds.

create or replace function public.cancel_payment(
  p_payment_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_reference text,
  p_provider_event_id text,
  p_event_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_cancelled_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_row public.payments%rowtype;
  event_row public.payment_events%rowtype;
  payload jsonb;
begin
  if p_payment_id is null
     or nullif(trim(p_provider), '') is null
     or nullif(trim(p_provider_payment_id), '') is null
     or nullif(trim(p_reference), '') is null
     or nullif(trim(p_provider_event_id), '') is null
     or p_event_id is null
     or p_actor_id is null
     or p_cancelled_at is null
     or (p_reason is not null and length(p_reason) > 500) then
    raise exception 'invalid administrative cancellation' using errcode = '22023';
  end if;

  -- A retried request is a successful no-op. Unique constraint protects races.
  select * into event_row
    from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    select * into payment_row from public.payments where id = event_row.payment_id;
    return jsonb_build_object('changed', false, 'duplicate', true,
      'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;

  select * into payment_row
    from public.payments
    where id = p_payment_id
      and provider = p_provider
      and provider_payment_id = p_provider_payment_id
      and reference = p_reference
    for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;

  -- Terminal rows are immutable. In particular, PAID can never become
  -- CANCELLED, even if an administrator retries after a concurrent webhook.
  if payment_row.status <> 'PENDING' then
    return jsonb_build_object('changed', false, 'duplicate', false,
      'payment', to_jsonb(payment_row));
  end if;

  payload := jsonb_build_object('source', 'admin_cancel', 'actor_id', p_actor_id::text)
    || case when nullif(trim(coalesce(p_reason, '')), '') is null
            then '{}'::jsonb
            else jsonb_build_object('reason', trim(p_reason)) end;

  update public.payments
    set status = 'CANCELLED', cancelled_at = p_cancelled_at
    where id = payment_row.id
    returning * into payment_row;

  insert into public.payment_events(
    id, payment_id, event_type, previous_status, new_status, provider,
    provider_event_id, raw_payload, created_at
  ) values (
    p_event_id, payment_row.id, 'payment.cancelled.admin', 'PENDING', 'CANCELLED',
    p_provider, p_provider_event_id, payload, p_cancelled_at
  ) returning * into event_row;

  return jsonb_build_object('changed', true, 'duplicate', false,
    'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
exception when unique_violation then
  -- Concurrent retry committed same provider event. Return committed row.
  select * into event_row from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    select * into payment_row from public.payments where id = event_row.payment_id;
    return jsonb_build_object('changed', false, 'duplicate', true,
      'payment', to_jsonb(payment_row), 'event', to_jsonb(event_row));
  end if;
  raise;
end;
$$;

revoke all on function public.cancel_payment(uuid, text, text, text, text, uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cancel_payment(uuid, text, text, text, text, uuid, uuid, text, timestamptz)
  to service_role;
