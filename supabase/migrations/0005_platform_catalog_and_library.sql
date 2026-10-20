-- Platform catalog and user-library boundary. This is additive: personal
-- imports remain local-first, while platform content is addressed by a
-- catalog edition and an explicit access policy / entitlement.

create table if not exists public.catalog_works (
  id uuid primary key default gen_random_uuid(),
  canonical_title text not null check (char_length(trim(canonical_title)) between 1 and 1024),
  primary_author text,
  description text,
  subjects text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (withdrawn_at is null or published_at is not null)
);

create table if not exists public.catalog_editions (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.catalog_works(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 1024),
  contributor text,
  language_code text not null check (language_code ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  publisher text,
  published_year integer check (published_year between 0 and 9999),
  format text not null check (format in ('epub', 'pdf', 'web')),
  cover_url text,
  metadata jsonb not null default '{}'::jsonb,
  published_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (withdrawn_at is null or published_at is not null)
);

-- Object keys are intentionally not exposed to browser clients. A Worker with
-- a privileged server credential resolves an entitled reader session to an R2
-- object or another approved streaming origin.
create table if not exists public.content_assets (
  id uuid primary key default gen_random_uuid(),
  catalog_edition_id uuid not null references public.catalog_editions(id) on delete cascade,
  storage_provider text not null check (storage_provider in ('r2', 'external_stream')),
  object_key text not null check (char_length(trim(object_key)) between 1 and 2048),
  media_type text not null check (media_type in ('application/epub+zip', 'application/pdf', 'text/html')),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  unique (catalog_edition_id, storage_provider, object_key)
);

-- A policy describes what the platform is licensed to offer for one edition.
-- It is not a user grant: the Worker must additionally verify entitlement for
-- restricted modes before it opens an in-app reading session.
create table if not exists public.access_policies (
  id uuid primary key default gen_random_uuid(),
  catalog_edition_id uuid not null references public.catalog_editions(id) on delete cascade,
  territory_code text not null default 'ZZ' check (territory_code ~ '^[A-Z]{2}$'),
  mode text not null check (mode in ('download', 'stream', 'preview', 'external_reader', 'catalog_only')),
  requires_entitlement boolean not null default false,
  license_label text,
  starts_at timestamptz,
  ends_at timestamptz,
  published_at timestamptz,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at > starts_at),
  check (withdrawn_at is null or published_at is not null)
);

-- One row per item a user chose to put on their shelf. Local imports only
-- reference a browser-local book id; their binary data never enters Supabase.
-- External catalog items retain provenance but do not imply rights to fetch a
-- source file. Platform items always point at a platform catalog edition.
create table if not exists public.user_library_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_type text not null check (source_type in ('local_import', 'platform', 'external_catalog')),
  catalog_edition_id uuid references public.catalog_editions(id) on delete set null,
  local_book_id text,
  external_source text,
  external_record_id text,
  external_url text,
  shelf_status text not null default 'want_to_read' check (shelf_status in ('want_to_read', 'reading', 'finished', 'archived')),
  access_mode text not null check (access_mode in ('download', 'stream', 'preview', 'external_reader', 'catalog_only')),
  metadata jsonb not null default '{}'::jsonb,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (source_type = 'local_import'
      and local_book_id is not null
      and catalog_edition_id is null
      and external_source is null
      and external_record_id is null
      and external_url is null
      and access_mode = 'download')
    or
    (source_type = 'platform'
      and catalog_edition_id is not null
      and local_book_id is null
      and external_source is null
      and external_record_id is null
      and external_url is null)
    or
    (source_type = 'external_catalog'
      and catalog_edition_id is null
      and local_book_id is null
      and external_source is not null
      and external_record_id is not null
      and external_url is not null
      and access_mode in ('external_reader', 'preview', 'catalog_only'))
  )
);

-- Entitlements are created, revoked or expired only by trusted backend jobs.
-- Readers may inspect their own active grant but cannot mint or alter one.
create table if not exists public.user_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  catalog_edition_id uuid not null references public.catalog_editions(id) on delete cascade,
  mode text not null check (mode in ('download', 'stream', 'preview')),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  source text not null check (source in ('public_domain', 'open_license', 'purchase', 'subscription', 'institution', 'manual_grant')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at),
  check ((status = 'revoked') = (revoked_at is not null))
);

create unique index if not exists content_assets_primary_edition_idx
  on public.content_assets (catalog_edition_id) where is_primary;
create index if not exists catalog_works_discovery_idx
  on public.catalog_works (published_at desc) where published_at is not null and withdrawn_at is null;
create index if not exists catalog_editions_work_language_idx
  on public.catalog_editions (work_id, language_code, published_at desc);
create index if not exists catalog_editions_discovery_idx
  on public.catalog_editions (published_at desc) where published_at is not null and withdrawn_at is null;
create index if not exists access_policies_edition_territory_idx
  on public.access_policies (catalog_edition_id, territory_code, mode) where withdrawn_at is null;
create index if not exists user_library_items_user_updated_idx
  on public.user_library_items (user_id, updated_at desc);
create unique index if not exists user_library_items_platform_unique_idx
  on public.user_library_items (user_id, catalog_edition_id) where source_type = 'platform';
create unique index if not exists user_library_items_local_unique_idx
  on public.user_library_items (user_id, local_book_id) where source_type = 'local_import';
create unique index if not exists user_library_items_external_unique_idx
  on public.user_library_items (user_id, external_source, external_record_id) where source_type = 'external_catalog';
create index if not exists user_entitlements_reader_idx
  on public.user_entitlements (user_id, catalog_edition_id, mode, status, ends_at);

create trigger catalog_works_updated_at before update on public.catalog_works
  for each row execute function public.set_updated_at();
create trigger catalog_editions_updated_at before update on public.catalog_editions
  for each row execute function public.set_updated_at();
create trigger access_policies_updated_at before update on public.access_policies
  for each row execute function public.set_updated_at();
create trigger user_library_items_updated_at before update on public.user_library_items
  for each row execute function public.set_updated_at();
create trigger user_entitlements_updated_at before update on public.user_entitlements
  for each row execute function public.set_updated_at();

alter table public.catalog_works enable row level security;
alter table public.catalog_editions enable row level security;
alter table public.content_assets enable row level security;
alter table public.access_policies enable row level security;
alter table public.user_library_items enable row level security;
alter table public.user_entitlements enable row level security;

revoke all on public.catalog_works, public.catalog_editions, public.content_assets,
  public.access_policies, public.user_library_items, public.user_entitlements from anon;
revoke all on public.catalog_works, public.catalog_editions, public.content_assets,
  public.access_policies, public.user_library_items, public.user_entitlements from authenticated;

-- The platform directory is browser-readable but never browser-writable.
-- Content object locations remain server-only, even for entitled users.
grant select on public.catalog_works, public.catalog_editions, public.access_policies,
  public.user_library_items, public.user_entitlements to authenticated;
grant insert, delete on public.user_library_items to authenticated;
-- A shelf item cannot be rebound by the browser to a different source. Users
-- may only change their own reading state / user metadata after adding it.
grant update (shelf_status, metadata) on public.user_library_items to authenticated;

drop policy if exists "published catalog works are readable" on public.catalog_works;
create policy "published catalog works are readable" on public.catalog_works for select to authenticated
  using (published_at is not null and published_at <= now() and withdrawn_at is null);

drop policy if exists "published catalog editions are readable" on public.catalog_editions;
create policy "published catalog editions are readable" on public.catalog_editions for select to authenticated
  using (
    published_at is not null and published_at <= now() and withdrawn_at is null
    and exists (
      select 1 from public.catalog_works w
      where w.id = work_id and w.published_at is not null and w.published_at <= now() and w.withdrawn_at is null
    )
  );

drop policy if exists "published access policies are readable" on public.access_policies;
create policy "published access policies are readable" on public.access_policies for select to authenticated
  using (
    published_at is not null and published_at <= now() and withdrawn_at is null
    and exists (
      select 1 from public.catalog_editions e
      where e.id = catalog_edition_id and e.published_at is not null and e.published_at <= now() and e.withdrawn_at is null
    )
  );

drop policy if exists "own user library items are readable" on public.user_library_items;
create policy "own user library items are readable" on public.user_library_items for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "own user library items can be added" on public.user_library_items;
create policy "own user library items can be added" on public.user_library_items for insert to authenticated
  with check (
    user_id = auth.uid()
    and (
      source_type <> 'platform'
      or exists (
        select 1 from public.catalog_editions e
        where e.id = catalog_edition_id and e.published_at is not null and e.published_at <= now() and e.withdrawn_at is null
      )
    )
  );

drop policy if exists "own user library items can be updated" on public.user_library_items;
create policy "own user library items can be updated" on public.user_library_items for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own user library items can be deleted" on public.user_library_items;
create policy "own user library items can be deleted" on public.user_library_items for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists "own user entitlements are readable" on public.user_entitlements;
create policy "own user entitlements are readable" on public.user_entitlements for select to authenticated
  using (user_id = auth.uid());
