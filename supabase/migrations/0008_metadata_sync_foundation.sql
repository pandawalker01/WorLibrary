-- Metadata-sync foundation. This migration deliberately does not upload book
-- bytes or enable browser-side generic conflict writes. It establishes the
-- auditable, user-scoped records required before the client can move from the
-- legacy full-scan sync to mutation RPCs in a later migration.

alter table public.devices
  add column if not exists client_instance_id uuid,
  add column if not exists platform text check (platform in ('web', 'desktop', 'ios', 'android')),
  add column if not exists app_version text,
  add column if not exists last_sync_cursor bigint not null default 0,
  add column if not exists revoked_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists devices_user_client_instance_idx
  on public.devices (user_id, client_instance_id)
  where client_instance_id is not null;

alter table public.works
  add column if not exists revision bigint not null default 0 check (revision >= 0),
  add column if not exists last_mutation_id uuid,
  add column if not exists last_device_id uuid references public.devices(id) on delete set null,
  add column if not exists deleted_at timestamptz;
alter table public.editions
  add column if not exists revision bigint not null default 0 check (revision >= 0),
  add column if not exists last_mutation_id uuid,
  add column if not exists last_device_id uuid references public.devices(id) on delete set null,
  add column if not exists deleted_at timestamptz;
alter table public.reading_progress
  add column if not exists revision bigint not null default 0 check (revision >= 0),
  add column if not exists last_mutation_id uuid,
  add column if not exists last_device_id uuid references public.devices(id) on delete set null,
  add column if not exists deleted_at timestamptz;
alter table public.highlights
  add column if not exists revision bigint not null default 0 check (revision >= 0),
  add column if not exists last_mutation_id uuid,
  add column if not exists last_device_id uuid references public.devices(id) on delete set null,
  add column if not exists deleted_at timestamptz;
alter table public.user_library_items
  add column if not exists revision bigint not null default 0 check (revision >= 0),
  add column if not exists last_mutation_id uuid,
  add column if not exists last_device_id uuid references public.devices(id) on delete set null,
  add column if not exists deleted_at timestamptz;

create index if not exists works_user_sync_idx on public.works (user_id, revision) where deleted_at is null;
create index if not exists editions_user_sync_idx on public.editions (user_id, revision) where deleted_at is null;
create index if not exists progress_user_sync_idx on public.reading_progress (user_id, revision) where deleted_at is null;
create index if not exists highlights_user_sync_idx on public.highlights (user_id, revision) where deleted_at is null;
create index if not exists user_library_items_user_sync_idx on public.user_library_items (user_id, revision) where deleted_at is null;

create table if not exists public.user_setting_values (
  user_id uuid not null references auth.users(id) on delete cascade,
  setting_key text not null check (setting_key ~ '^[a-z0-9][a-z0-9_.-]{0,127}$'),
  value jsonb not null,
  revision bigint not null default 0 check (revision >= 0),
  last_mutation_id uuid,
  last_device_id uuid references public.devices(id) on delete set null,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, setting_key)
);

create table if not exists public.sync_tombstones (
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (entity_type in ('work', 'edition', 'reading_progress', 'highlight', 'library_item', 'setting')),
  entity_id text not null check (char_length(entity_id) between 1 and 256),
  deleted_revision bigint not null check (deleted_revision >= 0),
  mutation_id uuid not null,
  device_id uuid references public.devices(id) on delete set null,
  deleted_at timestamptz not null default now(),
  purge_after timestamptz not null default (now() + interval '90 days'),
  primary key (user_id, entity_type, entity_id),
  unique (user_id, mutation_id)
);

create table if not exists public.sync_changes (
  sequence bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete set null,
  mutation_id uuid not null,
  entity_type text not null check (entity_type in ('work', 'edition', 'reading_progress', 'highlight', 'library_item', 'setting')),
  entity_id text not null check (char_length(entity_id) between 1 and 256),
  operation text not null check (operation in ('upsert', 'delete')),
  entity_revision bigint not null check (entity_revision >= 0),
  occurred_at timestamptz not null default now(),
  unique (user_id, mutation_id)
);

create table if not exists public.reading_events (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.devices(id) on delete restrict,
  edition_id uuid references public.editions(id) on delete set null,
  operation_id uuid not null,
  kind text not null check (kind in ('session', 'completed')),
  occurred_at timestamptz not null default now(),
  duration_ms bigint not null default 0 check (duration_ms >= 0 and duration_ms <= 86400000),
  pages_delta integer not null default 0 check (pages_delta >= 0),
  metadata jsonb not null default '{}'::jsonb,
  unique (user_id, operation_id)
);

create table if not exists public.reading_statistics (
  user_id uuid not null references auth.users(id) on delete cascade,
  edition_id uuid references public.editions(id) on delete set null,
  day date not null,
  reading_ms bigint not null default 0 check (reading_ms >= 0),
  sessions integer not null default 0 check (sessions >= 0),
  pages_read integer not null default 0 check (pages_read >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, edition_id, day)
);

create index if not exists sync_changes_user_sequence_idx on public.sync_changes (user_id, sequence);
create index if not exists sync_tombstones_user_purge_idx on public.sync_tombstones (user_id, purge_after);
create index if not exists reading_events_user_occurred_idx on public.reading_events (user_id, occurred_at desc);

alter table public.user_setting_values enable row level security;
alter table public.sync_tombstones enable row level security;
alter table public.sync_changes enable row level security;
alter table public.reading_events enable row level security;
alter table public.reading_statistics enable row level security;

revoke all on public.user_setting_values, public.sync_tombstones, public.sync_changes, public.reading_events, public.reading_statistics from anon;
revoke insert, update, delete on public.user_setting_values, public.sync_tombstones, public.sync_changes, public.reading_events, public.reading_statistics from authenticated;
grant select on public.user_setting_values, public.sync_tombstones, public.sync_changes, public.reading_events, public.reading_statistics to authenticated;

create policy "own setting values are readable" on public.user_setting_values for select to authenticated using (user_id = auth.uid());
create policy "own sync tombstones are readable" on public.sync_tombstones for select to authenticated using (user_id = auth.uid());
create policy "own sync changes are readable" on public.sync_changes for select to authenticated using (user_id = auth.uid());
create policy "own reading events are readable" on public.reading_events for select to authenticated using (user_id = auth.uid());
create policy "own reading statistics are readable" on public.reading_statistics for select to authenticated using (user_id = auth.uid());

-- Registering an instance is the only browser-writable device operation. A
-- later mutation RPC must reject revoked devices and use this device id in
-- every change log entry.
create or replace function public.register_sync_device(
  p_client_instance_id uuid,
  p_platform text,
  p_app_version text default null,
  p_metadata jsonb default '{}'::jsonb
) returns public.devices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.devices;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_client_instance_id is null then raise exception 'client instance id is required'; end if;
  if p_platform not in ('web', 'desktop', 'ios', 'android') then raise exception 'invalid platform'; end if;
  insert into public.devices (user_id, client_instance_id, platform, app_version, metadata, last_seen_at)
    values (auth.uid(), p_client_instance_id, p_platform, nullif(trim(p_app_version), ''), coalesce(p_metadata, '{}'::jsonb), now())
  on conflict (user_id, client_instance_id) where client_instance_id is not null
    do update set last_seen_at = now(), platform = excluded.platform, app_version = excluded.app_version,
      metadata = excluded.metadata
    where public.devices.revoked_at is null
  returning * into v_device;
  if v_device.id is null then raise exception 'device is revoked'; end if;
  return v_device;
end;
$$;

revoke all on function public.register_sync_device(uuid, text, text, jsonb) from public, anon;
grant execute on function public.register_sync_device(uuid, text, text, jsonb) to authenticated;
