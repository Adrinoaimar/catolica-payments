-- Distributed rate limits for authenticated operations and verified webhooks.
-- Vercel functions are ephemeral, so an in-memory counter is not a security
-- boundary. The edge/WAF should still enforce IP limits before this layer.
create table if not exists public.api_rate_limits (
  bucket_key text primary key check (bucket_key ~ '^[a-z][a-z0-9:_-]{1,127}$'),
  window_started_at timestamptz not null default now(),
  request_count integer not null check (request_count >= 0 and request_count <= 100000)
);

alter table public.api_rate_limits enable row level security;
revoke all on public.api_rate_limits from anon, authenticated;
grant all on public.api_rate_limits to service_role;

create or replace function public.consume_api_rate_limit(
  p_bucket_key text,
  p_limit integer,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.api_rate_limits%rowtype;
begin
  if p_bucket_key is null or p_bucket_key !~ '^[a-z][a-z0-9:_-]{1,127}$'
     or p_limit is null or p_limit < 1 or p_limit > 10000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'invalid rate limit request' using errcode = '22023';
  end if;

  -- Insert-or-ignore closes the first-request race; the subsequent row lock
  -- serializes all callers for this bucket.
  insert into public.api_rate_limits(bucket_key, window_started_at, request_count)
    values (p_bucket_key, v_now, 0)
    on conflict (bucket_key) do nothing;
  select * into v_row from public.api_rate_limits
    where bucket_key = p_bucket_key for update;

  if v_now >= v_row.window_started_at + make_interval(secs => p_window_seconds) then
    update public.api_rate_limits
      set window_started_at = v_now, request_count = 1
      where bucket_key = p_bucket_key;
    return true;
  end if;

  if v_row.request_count >= p_limit then return false; end if;
  update public.api_rate_limits
    set request_count = request_count + 1
    where bucket_key = p_bucket_key;
  return true;
end;
$$;

revoke all on function public.consume_api_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_api_rate_limit(text, integer, integer) to service_role;
