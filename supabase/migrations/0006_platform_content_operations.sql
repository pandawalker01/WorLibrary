-- Controlled platform-content operations. This migration intentionally adds no
-- browser write path for catalog, asset, licence, territory, or entitlement
-- data. Trusted backend jobs use the RPCs below with a service-role database
-- connection; clients continue to see only the published directory surface.

create table if not exists public.content_licenses (
  id uuid primary key default gen_random_uuid(),
  licensor_name text not null check (char_length(trim(licensor_name)) between 1 and 512),
  agreement_reference text not null check (char_length(trim(agreement_reference)) between 1 and 512),
  rights_scope text[] not null check (cardinality(rights_scope) > 0 and rights_scope <@ array['download', 'stream', 'preview', 'external_reader', 'catalog_only']::text[]),
  territory_codes text[] not null default array['ZZ']::text[] check (cardinality(territory_codes) > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'active', 'expired', 'revoked')),
  approved_at timestamptz,
  revoked_at timestamptz,
  evidence_object_key text check (evidence_object_key is null or char_length(trim(evidence_object_key)) between 1 and 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check ((status = 'active') = (approved_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);

create table if not exists public.content_source_records (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (char_length(trim(source_name)) between 1 and 512),
  source_record_id text not null check (char_length(trim(source_record_id)) between 1 and 1024),
  provenance_url text check (provenance_url is null or provenance_url ~ '^https://'),
  source_terms_reference text not null check (char_length(trim(source_terms_reference)) between 1 and 2048),
  license_id uuid not null references public.content_licenses(id) on delete restrict,
  acquired_at timestamptz not null default now(),
  expected_sha256 text not null check (expected_sha256 ~ '^[a-f0-9]{64}$'),
  review_status text not null default 'pending' check (review_status in ('pending', 'verified', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_name, source_record_id),
  check ((review_status = 'verified') = (reviewed_at is not null and reviewed_by is not null))
);

-- These nullable links let existing, already migrated development data remain
-- valid. Production publication is gated by the RPC below and requires them.
alter table public.content_assets
  add column if not exists source_record_id uuid references public.content_source_records(id) on delete restrict,
  add column if not exists license_id uuid references public.content_licenses(id) on delete restrict;

alter table public.access_policies
  add column if not exists license_id uuid references public.content_licenses(id) on delete restrict;

create table if not exists public.platform_content_audit_log (
  id bigint generated always as identity primary key,
  action text not null check (action in ('intake_verified', 'edition_published', 'edition_withdrawn', 'license_revoked')),
  catalog_edition_id uuid references public.catalog_editions(id) on delete set null,
  content_asset_id uuid references public.content_assets(id) on delete set null,
  source_record_id uuid references public.content_source_records(id) on delete set null,
  license_id uuid references public.content_licenses(id) on delete set null,
  actor_reference text not null check (char_length(trim(actor_reference)) between 1 and 512),
  reason text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists content_source_records_license_review_idx
  on public.content_source_records (license_id, review_status, reviewed_at desc);
create index if not exists content_assets_source_license_idx
  on public.content_assets (source_record_id, license_id);
create index if not exists access_policies_license_territory_idx
  on public.access_policies (license_id, territory_code) where withdrawn_at is null;
create index if not exists platform_content_audit_edition_idx
  on public.platform_content_audit_log (catalog_edition_id, occurred_at desc);

create trigger content_licenses_updated_at before update on public.content_licenses
  for each row execute function public.set_updated_at();
create trigger content_source_records_updated_at before update on public.content_source_records
  for each row execute function public.set_updated_at();

alter table public.content_licenses enable row level security;
alter table public.content_source_records enable row level security;
alter table public.platform_content_audit_log enable row level security;

revoke all on public.content_licenses, public.content_source_records, public.platform_content_audit_log from anon, authenticated;
revoke all on public.content_assets from anon, authenticated;
revoke insert, update, delete on public.catalog_works, public.catalog_editions, public.access_policies, public.user_entitlements from authenticated;

-- A verified source, an active licence, a matching immutable hash, and at
-- least one territorial policy tied to that licence are mandatory before an
-- edition is visible. The object key itself is never selected by a client.
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

  update public.catalog_works w
    set published_at = coalesce(w.published_at, now()), withdrawn_at = null
    from public.catalog_editions e
    where e.id = p_catalog_edition_id and w.id = e.work_id;
  update public.catalog_editions
    set published_at = coalesce(published_at, now()), withdrawn_at = null
    where id = p_catalog_edition_id;
  insert into public.platform_content_audit_log (action, catalog_edition_id, content_asset_id, source_record_id, license_id, actor_reference)
    values ('edition_published', p_catalog_edition_id, v_asset_id, v_source_record_id, v_license_id, p_actor_reference);
end;
$$;

create or replace function public.withdraw_platform_catalog_edition(
  p_catalog_edition_id uuid,
  p_actor_reference text,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_actor_reference, ''))) = 0 then
    raise exception 'actor reference is required';
  end if;
  update public.catalog_editions set withdrawn_at = now() where id = p_catalog_edition_id;
  update public.access_policies set withdrawn_at = coalesce(withdrawn_at, now()) where catalog_edition_id = p_catalog_edition_id;
  insert into public.platform_content_audit_log (action, catalog_edition_id, actor_reference, reason)
    values ('edition_withdrawn', p_catalog_edition_id, p_actor_reference, p_reason);
end;
$$;

create or replace function public.revoke_platform_content_license(
  p_license_id uuid,
  p_actor_reference text,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_actor_reference, ''))) = 0 then
    raise exception 'actor reference is required';
  end if;
  update public.content_licenses set status = 'revoked', revoked_at = now() where id = p_license_id;
  update public.access_policies set withdrawn_at = coalesce(withdrawn_at, now()) where license_id = p_license_id;
  insert into public.platform_content_audit_log (action, license_id, actor_reference, reason)
    values ('license_revoked', p_license_id, p_actor_reference, p_reason);
end;
$$;

revoke all on function public.publish_platform_catalog_edition(uuid, text) from public, anon, authenticated;
revoke all on function public.withdraw_platform_catalog_edition(uuid, text, text) from public, anon, authenticated;
revoke all on function public.revoke_platform_content_license(uuid, text, text) from public, anon, authenticated;
grant execute on function public.publish_platform_catalog_edition(uuid, text) to service_role;
grant execute on function public.withdraw_platform_catalog_edition(uuid, text, text) to service_role;
grant execute on function public.revoke_platform_content_license(uuid, text, text) to service_role;
