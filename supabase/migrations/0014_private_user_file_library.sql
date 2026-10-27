-- Private user EPUB/PDF manifests and chunk bookkeeping.
-- Binary bytes are never stored in Postgres; object_key is service-only.

create table if not exists public.user_file_manifests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  plaintext_hash text not null check (plaintext_hash ~ '^[0-9a-f]{64}$'),
  plaintext_size bigint not null check (plaintext_size > 0),
  media_type text not null check (media_type in ('application/epub+zip', 'application/pdf')),
  file_name text not null check (char_length(file_name) between 1 and 240),
  encryption_version text not null default 'managed-v1' check (encryption_version in ('managed-v1')),
  chunk_size integer not null check (chunk_size between 262144 and 8388608),
  chunk_count integer not null check (chunk_count between 1 and 100000),
  active_version integer not null default 1 check (active_version > 0),
  upload_state text not null default 'uploading' check (upload_state in ('uploading', 'verifying', 'active', 'failed', 'deleting', 'deleted')),
  idempotency_key uuid not null,
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  unique (user_id, edition_id, plaintext_hash)
);

create table if not exists public.user_file_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  manifest_id uuid not null references public.user_file_manifests(id) on delete cascade,
  manifest_version integer not null check (manifest_version > 0),
  chunk_index integer not null check (chunk_index >= 0),
  cipher_hash text not null check (cipher_hash ~ '^[0-9a-f]{64}$'),
  ciphertext_size integer not null check (ciphertext_size > 0 and ciphertext_size <= 8388608),
  nonce text,
  object_key text not null,
  uploaded_at timestamptz,
  deleted_at timestamptz,
  unique (manifest_id, manifest_version, chunk_index),
  unique (user_id, object_key)
);

create table if not exists public.user_storage_quotas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  included_bytes bigint not null default 1073741824 check (included_bytes >= 0),
  used_bytes bigint not null default 0 check (used_bytes >= 0),
  reserved_bytes bigint not null default 0 check (reserved_bytes >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists user_file_manifests_user_idx on public.user_file_manifests (user_id, updated_at desc);
create index if not exists user_file_manifests_edition_idx on public.user_file_manifests (user_id, edition_id);
create index if not exists user_file_chunks_manifest_idx on public.user_file_chunks (manifest_id, manifest_version, chunk_index);

alter table public.user_file_manifests enable row level security;
alter table public.user_file_chunks enable row level security;
alter table public.user_storage_quotas enable row level security;

revoke all on public.user_file_manifests, public.user_file_chunks, public.user_storage_quotas from anon, authenticated;
grant select on public.user_file_manifests to authenticated;
grant select on public.user_storage_quotas to authenticated;

drop policy if exists "users read own file manifests" on public.user_file_manifests;
create policy "users read own file manifests" on public.user_file_manifests
  for select to authenticated using (user_id = auth.uid() and deleted_at is null);

drop policy if exists "users read own storage quota" on public.user_storage_quotas;
create policy "users read own storage quota" on public.user_storage_quotas
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "users never read file chunks" on public.user_file_chunks;
-- No browser role receives SELECT on chunks: object locations and chunk rows are
-- resolved only by the authenticated Worker/service-role upload gateway.

create or replace function public.touch_user_file_manifest()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_file_manifests_updated_at on public.user_file_manifests;
create trigger user_file_manifests_updated_at before update on public.user_file_manifests
for each row execute function public.touch_user_file_manifest();

revoke all on function public.touch_user_file_manifest() from public, anon, authenticated;

