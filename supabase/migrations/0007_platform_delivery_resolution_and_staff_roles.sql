-- Dynamic platform-delivery resolution and operating-staff boundary.
-- This migration deliberately remains server-only: browser sessions cannot
-- enumerate staff, content locations, licences, or delivery decisions.

create table if not exists public.platform_staff_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('content_reviewer', 'content_publisher', 'content_admin')),
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  reason text,
  primary key (user_id, role),
  check ((revoked_at is null) = (revoked_by is null))
);

create index if not exists platform_staff_roles_active_idx
  on public.platform_staff_roles (user_id, role)
  where revoked_at is null;

alter table public.platform_staff_roles enable row level security;
revoke all on public.platform_staff_roles from anon, authenticated;

-- Resolves the smallest possible internal descriptor for a protected reader
-- request. It intentionally returns an object key only to a service-role
-- resolver running behind a Worker Service Binding. The public Worker must
-- redact it before answering a browser and must never cache or log it.
create or replace function public.resolve_platform_reader_delivery(
  p_catalog_edition_id uuid,
  p_user_id uuid default null,
  p_territory_code text default 'ZZ'
) returns table (
  access_mode text,
  requires_entitlement boolean,
  content_type text,
  object_key text,
  rights_notice text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_territory_code text := upper(trim(coalesce(p_territory_code, 'ZZ')));
begin
  if v_territory_code !~ '^[A-Z]{2}$' then
    raise exception 'invalid territory code';
  end if;

  return query
  select
    policy.mode,
    policy.requires_entitlement,
    asset.media_type,
    asset.object_key,
    coalesce(policy.license_label, licence.agreement_reference)
  from public.catalog_editions edition
  join public.catalog_works work on work.id = edition.work_id
  join public.content_assets asset
    on asset.catalog_edition_id = edition.id
    and asset.is_primary
    and asset.storage_provider = 'r2'
    and asset.media_type in ('application/epub+zip', 'application/pdf')
  join public.content_source_records source_record
    on source_record.id = asset.source_record_id
    and source_record.review_status = 'verified'
    and asset.sha256 = source_record.expected_sha256
  join public.content_licenses licence
    on licence.id = asset.license_id
    and licence.id = source_record.license_id
    and licence.status = 'active'
    and (licence.starts_at is null or licence.starts_at <= now())
    and (licence.ends_at is null or licence.ends_at > now())
  join lateral (
    select policy_candidate.*
    from public.access_policies policy_candidate
    where policy_candidate.catalog_edition_id = edition.id
      and policy_candidate.license_id = licence.id
      and policy_candidate.mode in ('stream', 'preview')
      and policy_candidate.published_at is not null
      and policy_candidate.published_at <= now()
      and policy_candidate.withdrawn_at is null
      and (policy_candidate.starts_at is null or policy_candidate.starts_at <= now())
      and (policy_candidate.ends_at is null or policy_candidate.ends_at > now())
      and policy_candidate.territory_code in (v_territory_code, 'ZZ')
    order by (policy_candidate.territory_code = v_territory_code) desc, policy_candidate.created_at desc
    limit 1
  ) policy on true
  where edition.id = p_catalog_edition_id
    and edition.published_at is not null
    and edition.published_at <= now()
    and edition.withdrawn_at is null
    and work.published_at is not null
    and work.published_at <= now()
    and work.withdrawn_at is null
    and (
      not policy.requires_entitlement
      or exists (
        select 1
        from public.user_entitlements entitlement
        where entitlement.user_id = p_user_id
          and entitlement.catalog_edition_id = edition.id
          and entitlement.status = 'active'
          and entitlement.mode in (policy.mode, 'stream')
          and entitlement.starts_at <= now()
          and (entitlement.ends_at is null or entitlement.ends_at > now())
      )
    )
  limit 1;
end;
$$;

-- Publishing must make the associated, already-validated policy discoverable
-- by the resolver. Existing function callers and its service-role-only API
-- remain compatible with the previous migration.
create or replace function public.publish_platform_catalog_edition(
  p_catalog_edition_id uuid,
  p_actor_reference text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_record_id uuid;
  v_license_id uuid;
  v_asset_id uuid;
begin
  if char_length(trim(coalesce(p_actor_reference, ''))) = 0 then
    raise exception 'actor reference is required';
  end if;

  select a.id, a.source_record_id, a.license_id
    into v_asset_id, v_source_record_id, v_license_id
  from public.content_assets a
  join public.content_source_records s on s.id = a.source_record_id
  join public.content_licenses l on l.id = a.license_id and l.id = s.license_id
  where a.catalog_edition_id = p_catalog_edition_id
    and a.is_primary
    and a.sha256 = s.expected_sha256
    and s.review_status = 'verified'
    and l.status = 'active'
    and (l.starts_at is null or l.starts_at <= now())
    and (l.ends_at is null or l.ends_at > now())
  limit 1;

  if v_asset_id is null then
    raise exception 'edition requires a verified, hashed asset with an active licence';
  end if;

  if not exists (
    select 1 from public.access_policies p
    where p.catalog_edition_id = p_catalog_edition_id
      and p.license_id = v_license_id
      and p.withdrawn_at is null
      and (p.starts_at is null or p.starts_at <= now())
      and (p.ends_at is null or p.ends_at > now())
  ) then
    raise exception 'edition requires an active territorial access policy for its licence';
  end if;

  update public.catalog_works work
    set published_at = coalesce(work.published_at, now()), withdrawn_at = null
    from public.catalog_editions edition
    where edition.id = p_catalog_edition_id and work.id = edition.work_id;
  update public.catalog_editions
    set published_at = coalesce(published_at, now()), withdrawn_at = null
    where id = p_catalog_edition_id;
  update public.access_policies
    set published_at = coalesce(published_at, now()), withdrawn_at = null
    where catalog_edition_id = p_catalog_edition_id
      and license_id = v_license_id;
  insert into public.platform_content_audit_log (action, catalog_edition_id, content_asset_id, source_record_id, license_id, actor_reference)
    values ('edition_published', p_catalog_edition_id, v_asset_id, v_source_record_id, v_license_id, p_actor_reference);
end;
$$;

revoke all on function public.resolve_platform_reader_delivery(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.resolve_platform_reader_delivery(uuid, uuid, text) to service_role;
