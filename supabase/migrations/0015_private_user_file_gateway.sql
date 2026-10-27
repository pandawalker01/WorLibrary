-- Server-only transaction boundary for the private user-file Worker gateway.
-- Browser roles retain SELECT-only access to manifests and quotas; object keys
-- and chunk bookkeeping never cross this boundary.

alter table public.user_file_manifests
  add column if not exists upload_expires_at timestamptz,
  add column if not exists delete_requested_at timestamptz,
  add column if not exists delete_completed_at timestamptz,
  add column if not exists tombstone_until timestamptz;

create table if not exists public.user_file_tombstones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  edition_id uuid not null references public.editions(id) on delete cascade,
  deleted_manifest_id uuid not null,
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (user_id, edition_id)
);

alter table public.user_file_tombstones enable row level security;
revoke all on public.user_file_tombstones from anon, authenticated;

create or replace function public.begin_user_file_upload(
  p_user_id uuid, p_edition_id uuid, p_file_name text, p_media_type text,
  p_plaintext_size bigint, p_chunk_size integer, p_chunk_count integer,
  p_idempotency_key uuid, p_plaintext_hash text
) returns table(manifest_id uuid, upload_state text, uploaded_chunks integer[])
language plpgsql security definer set search_path = public as $$
declare
  v_manifest public.user_file_manifests%rowtype;
  v_quota public.user_storage_quotas%rowtype;
begin
  if p_file_name !~ '^[^[:cntrl:]\\/]{1,240}$'
    or p_media_type not in ('application/epub+zip', 'application/pdf')
    or p_plaintext_size < 1 or p_plaintext_size > 1073741824
    or p_chunk_size < 262144 or p_chunk_size > 8388608
    or p_chunk_count <> ceil(p_plaintext_size::numeric / p_chunk_size)::integer
    or p_plaintext_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid private file manifest';
  end if;
  if exists (select 1 from public.user_file_tombstones where user_id = p_user_id and edition_id = p_edition_id and expires_at > now()) then
    raise exception 'file deletion tombstone is active';
  end if;
  insert into public.user_storage_quotas (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_manifest from public.user_file_manifests where user_id = p_user_id and idempotency_key = p_idempotency_key for update;
  if found then
    if v_manifest.edition_id <> p_edition_id or v_manifest.plaintext_hash <> p_plaintext_hash then raise exception 'idempotency key conflict'; end if;
  else
    select * into v_quota from public.user_storage_quotas where user_id = p_user_id for update;
    if v_quota.used_bytes + v_quota.reserved_bytes + p_plaintext_size > v_quota.included_bytes then raise exception 'storage quota exceeded'; end if;
    insert into public.user_file_manifests (user_id, edition_id, plaintext_hash, plaintext_size, media_type, file_name, chunk_size, chunk_count, idempotency_key, reserved_bytes, upload_expires_at)
    values (p_user_id, p_edition_id, p_plaintext_hash, p_plaintext_size, p_media_type, p_file_name, p_chunk_size, p_chunk_count, p_idempotency_key, p_plaintext_size, now() + interval '24 hours')
    returning * into v_manifest;
    update public.user_storage_quotas set reserved_bytes = reserved_bytes + p_plaintext_size, updated_at = now() where user_id = p_user_id;
  end if;
  return query select v_manifest.id, v_manifest.upload_state, coalesce(array(select chunk_index from public.user_file_chunks where manifest_id = v_manifest.id and manifest_version = v_manifest.active_version and deleted_at is null order by chunk_index), '{}'::integer[]);
end;
$$;

create or replace function public.record_user_file_chunk(
  p_user_id uuid, p_manifest_id uuid, p_chunk_index integer, p_cipher_hash text,
  p_ciphertext_size integer, p_object_key text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype;
begin
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found or v_manifest.upload_state <> 'uploading' or v_manifest.upload_expires_at <= now() then raise exception 'upload is not active'; end if;
  if p_chunk_index < 0 or p_chunk_index >= v_manifest.chunk_count or p_ciphertext_size < 1 or p_ciphertext_size > v_manifest.chunk_size or p_cipher_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid chunk'; end if;
  insert into public.user_file_chunks (user_id, manifest_id, manifest_version, chunk_index, cipher_hash, ciphertext_size, object_key, uploaded_at)
  values (p_user_id, p_manifest_id, v_manifest.active_version, p_chunk_index, p_cipher_hash, p_ciphertext_size, p_object_key, now())
  on conflict (manifest_id, manifest_version, chunk_index) do update set cipher_hash = excluded.cipher_hash, ciphertext_size = excluded.ciphertext_size, object_key = excluded.object_key, uploaded_at = now(), deleted_at = null;
end;
$$;

create or replace function public.complete_user_file_upload(p_user_id uuid, p_manifest_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype; v_count integer; v_size bigint;
begin
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  if v_manifest.upload_state = 'active' then return true; end if;
  if v_manifest.upload_state <> 'uploading' then raise exception 'manifest is not uploadable'; end if;
  update public.user_file_manifests set upload_state = 'verifying' where id = p_manifest_id;
  select count(*), coalesce(sum(ciphertext_size), 0) into v_count, v_size from public.user_file_chunks where manifest_id = p_manifest_id and manifest_version = v_manifest.active_version and deleted_at is null;
  if v_count <> v_manifest.chunk_count or v_size <> v_manifest.plaintext_size then
    update public.user_file_manifests set upload_state = 'uploading' where id = p_manifest_id;
    raise exception 'upload is incomplete';
  end if;
  update public.user_file_manifests set upload_state = 'active', reserved_bytes = 0, upload_expires_at = null where id = p_manifest_id;
  update public.user_storage_quotas set reserved_bytes = greatest(0, reserved_bytes - v_manifest.reserved_bytes), used_bytes = used_bytes + v_manifest.reserved_bytes, updated_at = now() where user_id = p_user_id;
  return true;
end;
$$;

create or replace function public.request_user_file_delete(p_user_id uuid, p_manifest_id uuid)
returns table(manifest_id uuid, object_keys text[]) language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype;
begin
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then return; end if;
  if v_manifest.upload_state <> 'deleted' then
    insert into public.user_file_tombstones (user_id, edition_id, deleted_manifest_id) values (p_user_id, v_manifest.edition_id, p_manifest_id) on conflict (user_id, edition_id) do update set deleted_manifest_id = excluded.deleted_manifest_id, deleted_at = now(), expires_at = now() + interval '30 days';
    update public.user_file_manifests set upload_state = 'deleting', delete_requested_at = now(), deleted_at = now() where id = p_manifest_id;
  end if;
  return query select v_manifest.id, coalesce(array(select object_key from public.user_file_chunks where manifest_id = p_manifest_id and deleted_at is null), '{}'::text[]);
end;
$$;

create or replace function public.finish_user_file_delete(p_user_id uuid, p_manifest_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_reserved bigint;
begin
  select reserved_bytes into v_reserved from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then return; end if;
  update public.user_file_chunks set deleted_at = now() where manifest_id = p_manifest_id and deleted_at is null;
  update public.user_file_manifests set upload_state = 'deleted', delete_completed_at = now(), reserved_bytes = 0 where id = p_manifest_id;
  update public.user_storage_quotas set reserved_bytes = greatest(0, reserved_bytes - coalesce(v_reserved, 0)), used_bytes = greatest(0, used_bytes - (select plaintext_size from public.user_file_manifests where id = p_manifest_id)), updated_at = now() where user_id = p_user_id;
end;
$$;

revoke all on function public.begin_user_file_upload(uuid, uuid, text, text, bigint, integer, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.record_user_file_chunk(uuid, uuid, integer, text, integer, text) from public, anon, authenticated;
revoke all on function public.complete_user_file_upload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.request_user_file_delete(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_user_file_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.begin_user_file_upload(uuid, uuid, text, text, bigint, integer, integer, uuid, text) to service_role;
grant execute on function public.record_user_file_chunk(uuid, uuid, integer, text, integer, text) to service_role;
grant execute on function public.complete_user_file_upload(uuid, uuid) to service_role;
grant execute on function public.request_user_file_delete(uuid, uuid) to service_role;
grant execute on function public.finish_user_file_delete(uuid, uuid) to service_role;
