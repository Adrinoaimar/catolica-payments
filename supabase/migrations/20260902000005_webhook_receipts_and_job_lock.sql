-- Operational hardening for real webhooks and scheduled reconciliation.
-- Receipts keep delivery identity/hash/outcome only; raw provider payloads stay
-- in payment_events and are never exposed through PostgREST.
create table if not exists public.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  outcome text not null check (outcome in ('ACCEPTED', 'DUPLICATE', 'REJECTED', 'ERROR')),
  error_code text check (error_code is null or length(error_code) between 1 and 100),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);

create index if not exists webhook_receipts_received_at_idx
  on public.webhook_receipts (provider, received_at desc);

alter table public.webhook_receipts enable row level security;
revoke all on public.webhook_receipts from anon, authenticated;
grant all on public.webhook_receipts to service_role;

-- A short-lived database lease prevents two scheduler invocations from
-- querying the same provider rows at the same time. The RPC returns NULL when
-- another live lease owns the job.
create table if not exists public.job_locks (
  job_name text primary key check (job_name ~ '^[a-z][a-z0-9_-]{1,63}$'),
  lock_token uuid not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.job_locks enable row level security;
revoke all on public.job_locks from anon, authenticated;
grant all on public.job_locks to service_role;

create or replace function public.acquire_job_lock(
  p_job_name text,
  p_lease_seconds integer default 600
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_token uuid := gen_random_uuid();
  v_acquired uuid;
begin
  if p_job_name is null or p_job_name !~ '^[a-z][a-z0-9_-]{1,63}$'
     or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'Invalid job lock request' using errcode = '22023';
  end if;

  insert into public.job_locks (job_name, lock_token, locked_until, updated_at)
    values (p_job_name, v_token, v_now + make_interval(secs => p_lease_seconds), v_now)
    on conflict (job_name) do update
      set lock_token = excluded.lock_token,
          locked_until = excluded.locked_until,
          updated_at = excluded.updated_at
      where public.job_locks.locked_until <= v_now
    returning lock_token into v_acquired;

  return v_acquired;
end;
$$;

create or replace function public.release_job_lock(
  p_job_name text,
  p_lock_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_job_name is null or p_lock_token is null then return false; end if;
  delete from public.job_locks
    where job_name = p_job_name and lock_token = p_lock_token;
  return found;
end;
$$;

revoke all on function public.acquire_job_lock(text, integer) from public, anon, authenticated;
revoke all on function public.release_job_lock(text, uuid) from public, anon, authenticated;
grant execute on function public.acquire_job_lock(text, integer) to service_role;
grant execute on function public.release_job_lock(text, uuid) to service_role;
