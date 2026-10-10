-- Durable, per-user request ledger for AI/OCR gateways. Original books and
-- selected text are deliberately never stored here: only request identity,
-- operation type and a charge state are retained.

create table if not exists public.ai_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (char_length(request_id) between 1 and 128),
  kind text not null check (kind in ('translate', 'explain', 'ocr')),
  usage_day date not null default (now() at time zone 'utc')::date,
  status text not null default 'consumed' check (status in ('consumed', 'released')),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  unique (user_id, request_id)
);

create index if not exists ai_usage_ledger_daily_idx
  on public.ai_usage_ledger (user_id, usage_day, status);

alter table public.ai_usage_ledger enable row level security;
revoke all on public.ai_usage_ledger from anon;
-- The browser never needs to read or insert this ledger. Only the SECURITY
-- DEFINER RPC below is executable by authenticated users.
revoke all on public.ai_usage_ledger from authenticated;

create or replace function public.consume_ai_quota(
  p_request_id text,
  p_kind text,
  p_daily_limit integer
)
returns table (allowed boolean, charged boolean, used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_day date := (now() at time zone 'utc')::date;
  v_used integer;
begin
  if v_user_id is null then
    raise exception 'authenticated user required' using errcode = '28000';
  end if;
  if p_daily_limit < 1 or p_daily_limit > 1000000 then
    raise exception 'invalid daily limit' using errcode = '22023';
  end if;
  if p_kind not in ('translate', 'explain', 'ocr') or char_length(trim(p_request_id)) not between 1 and 128 then
    raise exception 'invalid usage request' using errcode = '22023';
  end if;

  -- Serialize only one user's current-day accounting. This prevents two
  -- concurrent gateway calls both observing the last remaining quota slot.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || v_day::text, 0));

  if exists (
    select 1 from public.ai_usage_ledger
    where user_id = v_user_id and request_id = trim(p_request_id) and status = 'consumed'
  ) then
    select count(*)::integer into v_used from public.ai_usage_ledger
      where user_id = v_user_id and usage_day = v_day and status = 'consumed';
    return query select true, false, v_used;
    return;
  end if;

  select count(*)::integer into v_used from public.ai_usage_ledger
    where user_id = v_user_id and usage_day = v_day and status = 'consumed';
  if v_used >= p_daily_limit then
    return query select false, false, v_used;
    return;
  end if;

  insert into public.ai_usage_ledger (user_id, request_id, kind, usage_day)
    values (v_user_id, trim(p_request_id), p_kind, v_day);
  return query select true, true, v_used + 1;
end;
$$;

revoke all on function public.consume_ai_quota(text, text, integer) from public;
grant execute on function public.consume_ai_quota(text, text, integer) to authenticated;
