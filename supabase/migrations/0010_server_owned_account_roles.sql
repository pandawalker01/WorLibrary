-- Server-owned account roles for product operations.
--
-- A normal user has no row in this table. Elevated roles are deliberately not
-- profile fields, user settings, or JWT claims: they are checked server-side
-- and a revocation takes effect immediately on the next server-side request.

create table if not exists public.account_role_assignments (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('community_moderator', 'support_agent', 'platform_admin')),
  granted_at timestamptz not null default now(),
  granted_by_user_id uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by_user_id uuid references auth.users(id) on delete set null,
  reason text,
  primary key (user_id, role),
  check ((revoked_at is null) = (revoked_by_user_id is null))
);

create index if not exists account_role_assignments_active_user_idx
  on public.account_role_assignments (user_id, role)
  where revoked_at is null;

-- Keep a server-only audit trail for every grant, re-grant and revocation.
-- `actor_reference` is an internal staff or ticket reference, never an email.
create table if not exists public.account_role_audit_log (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('community_moderator', 'support_agent', 'platform_admin')),
  action text not null check (action in ('granted', 'revoked')),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_reference text not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists account_role_audit_log_target_created_idx
  on public.account_role_audit_log (target_user_id, created_at desc);

alter table public.account_role_assignments enable row level security;
alter table public.account_role_audit_log enable row level security;

-- No browser role, including authenticated, may enumerate or change either
-- assignments or audit records. There are intentionally no RLS policies.
revoke all on table public.account_role_assignments from public, anon, authenticated;
revoke all on table public.account_role_audit_log from public, anon, authenticated;

-- The only supported mutation path is an internal service-role caller. It
-- records an audit event atomically and never accepts a browser-supplied
-- profile field or token claim as proof of authority.
create or replace function public.set_server_account_role(
  p_target_user_id uuid,
  p_role text,
  p_active boolean,
  p_actor_reference text,
  p_actor_user_id uuid default null,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := lower(trim(coalesce(p_role, '')));
  v_actor_reference text := trim(coalesce(p_actor_reference, ''));
begin
  if p_target_user_id is null then
    raise exception 'target user is required';
  end if;
  if v_role not in ('community_moderator', 'support_agent', 'platform_admin') then
    raise exception 'unsupported server account role';
  end if;
  if char_length(v_actor_reference) = 0 then
    raise exception 'actor reference is required';
  end if;

  if p_active then
    insert into public.account_role_assignments (
      user_id, role, granted_at, granted_by_user_id, revoked_at, revoked_by_user_id, reason
    ) values (
      p_target_user_id, v_role, now(), p_actor_user_id, null, null, nullif(trim(p_reason), '')
    )
    on conflict (user_id, role) do update
      set granted_at = excluded.granted_at,
          granted_by_user_id = excluded.granted_by_user_id,
          revoked_at = null,
          revoked_by_user_id = null,
          reason = excluded.reason;

    insert into public.account_role_audit_log (
      target_user_id, role, action, actor_user_id, actor_reference, reason
    ) values (
      p_target_user_id, v_role, 'granted', p_actor_user_id, v_actor_reference, nullif(trim(p_reason), '')
    );
  else
    update public.account_role_assignments
      set revoked_at = now(),
          revoked_by_user_id = p_actor_user_id,
          reason = nullif(trim(p_reason), '')
      where user_id = p_target_user_id
        and role = v_role
        and revoked_at is null;

    if not found then
      raise exception 'active server account role not found';
    end if;

    insert into public.account_role_audit_log (
      target_user_id, role, action, actor_user_id, actor_reference, reason
    ) values (
      p_target_user_id, v_role, 'revoked', p_actor_user_id, v_actor_reference, nullif(trim(p_reason), '')
    );
  end if;
end;
$$;

revoke all on function public.set_server_account_role(uuid, text, boolean, text, uuid, text) from public, anon, authenticated;
grant execute on function public.set_server_account_role(uuid, text, boolean, text, uuid, text) to service_role;
