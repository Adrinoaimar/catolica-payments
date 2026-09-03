-- Retry-safe create requests. The key is opaque metadata, never returned to
-- clients, and is unique across the institution's payment ledger.
alter table public.payments add column if not exists idempotency_key text;
alter table public.payments drop constraint if exists payments_idempotency_key_format;
alter table public.payments add constraint payments_idempotency_key_format
  check (idempotency_key is null or idempotency_key ~ '^[!-~]{16,200}$');
create unique index if not exists payments_idempotency_key_uq
  on public.payments (idempotency_key) where idempotency_key is not null;

-- Keep the cash audit RPC atomic while allowing the same client retry key.
drop function if exists public.record_cash_payment(uuid, text, integer, uuid, timestamptz, timestamptz, jsonb, uuid, text, timestamptz);
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
  p_event_created_at timestamptz,
  p_idempotency_key text
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
    idempotency_key, status, created_by, created_at, expires_at, paid_at, cancelled_at, provider_data
  ) values (
    p_id, p_reference, p_amount_cents, 'PEN', 'CASH', null,
    nullif(trim(p_idempotency_key), ''), 'PAID', p_created_by, p_created_at, null, p_paid_at, null,
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

revoke all on function public.record_cash_payment(uuid, text, integer, uuid, timestamptz, timestamptz, jsonb, uuid, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.record_cash_payment(uuid, text, integer, uuid, timestamptz, timestamptz, jsonb, uuid, text, timestamptz, text) to service_role;
