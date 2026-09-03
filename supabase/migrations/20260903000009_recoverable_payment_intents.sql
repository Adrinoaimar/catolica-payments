-- Persist a digital payment intent before contacting the external provider.
-- The follow-up attach is deliberately separate from the financial status
-- transition so a crashed request can be recovered by the reconciliation job.

create or replace function public.attach_payment_provider(
  p_payment_id uuid,
  p_provider text,
  p_provider_payment_id text,
  p_provider_data jsonb,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_row public.payments%rowtype;
begin
  if p_payment_id is null
     or nullif(trim(p_provider), '') is null
     or nullif(trim(p_provider_payment_id), '') is null
     or length(trim(p_provider_payment_id)) > 200 then
    raise exception 'invalid provider attachment' using errcode = '22023';
  end if;

  select * into payment_row
    from public.payments
    where id = p_payment_id
    for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if payment_row.provider <> p_provider then
    raise exception 'payment provider mismatch' using errcode = '22023';
  end if;

  -- Retries after a response/DB race are safe. A different external ID must
  -- never replace the first one attached to this intent.
  if payment_row.provider_payment_id is not null then
    if payment_row.provider_payment_id <> p_provider_payment_id then
      raise exception 'provider payment ID mismatch' using errcode = '22023';
    end if;
    return jsonb_build_object('attached', false, 'duplicate', true, 'payment', to_jsonb(payment_row));
  end if;
  if payment_row.status <> 'PENDING' then
    raise exception 'payment intent is not pending' using errcode = '22023';
  end if;

  update public.payments
    set provider_payment_id = p_provider_payment_id,
        provider_data = coalesce(p_provider_data, '{}'::jsonb),
        expires_at = coalesce(p_expires_at, payment_row.expires_at)
    where id = payment_row.id
    returning * into payment_row;

  return jsonb_build_object('attached', true, 'duplicate', false, 'payment', to_jsonb(payment_row));
exception when unique_violation then
  -- The unique provider_payment_id constraint is the final cross-intent
  -- guard. Surface a stable conflict rather than silently attaching another
  -- checkout to this intent.
  raise exception 'provider payment ID already exists' using errcode = '23505';
end;
$$;

revoke all on function public.attach_payment_provider(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.attach_payment_provider(uuid, text, text, jsonb, timestamptz) to service_role;
