-- Draft cutover: old unconditional Worker writers must be stopped first.
-- Never silently discard or adopt deterministic legacy keys.
do $$ begin
  if exists(select 1 from public.user_file_chunks) or exists(select 1 from public.user_file_manifests) then
    raise exception 'legacy private chunks or manifests require a reviewed cutover plan';
  end if;
end $$;

create table public.private_file_write_intents (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  manifest_id uuid not null references public.user_file_manifests(id) on delete cascade,
  manifest_version integer not null check (manifest_version > 0),
  chunk_index integer not null check (chunk_index >= 0),
  chunk_hash text not null check (chunk_hash ~ '^[0-9a-f]{64}$'),
  chunk_bytes integer not null check (chunk_bytes between 1 and 8388608),
  object_key text not null unique,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  fenced_at timestamptz,
  check (object_key = 'private-intents/' || id::text)
);
create unique index private_file_current_chunk_intent on public.private_file_write_intents
  (manifest_id, manifest_version, chunk_index) where fenced_at is null;
create index private_file_intent_cleanup on public.private_file_write_intents (user_id, manifest_id);
alter table public.private_file_write_intents enable row level security;
revoke all on public.private_file_write_intents from public, anon, authenticated, service_role;

create function public.prepare_private_file_chunk(
  p_user_id uuid, p_manifest_id uuid, p_chunk_index integer, p_hash text, p_size integer
) returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.user_file_manifests%rowtype; i public.private_file_write_intents%rowtype; v_id uuid;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into m from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  perform public.assert_private_file_upload_allowed(p_user_id, m.edition_id);
  if m.upload_state <> 'uploading' or m.deleted_at is not null
    or m.upload_expires_at is null or m.upload_expires_at <= now() then raise exception 'upload is not active'; end if;
  if p_chunk_index is null or p_chunk_index < 0 or p_chunk_index >= m.chunk_count
    or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_size is null
    or p_size <> least(m.chunk_size::bigint, m.plaintext_size - p_chunk_index::bigint * m.chunk_size) then
    raise exception 'invalid chunk';
  end if;
  select * into i from public.private_file_write_intents where manifest_id = p_manifest_id
    and manifest_version = m.active_version and chunk_index = p_chunk_index and fenced_at is null for update;
  if found then
    if i.chunk_hash <> p_hash or i.chunk_bytes <> p_size then raise exception 'chunk intent conflict'; end if;
  else
    v_id := gen_random_uuid();
    insert into public.private_file_write_intents(id, user_id, manifest_id, manifest_version,
      chunk_index, chunk_hash, chunk_bytes, object_key)
      values(v_id, p_user_id, p_manifest_id, m.active_version, p_chunk_index, p_hash, p_size,
        'private-intents/' || v_id::text) returning * into i;
  end if;
  return jsonb_build_object('id', i.id, 'key', i.object_key, 'size', i.chunk_bytes, 'hash', i.chunk_hash);
end;
$$;

create function public.commit_private_file_chunk(p_user_id uuid, p_intent_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.user_file_manifests%rowtype; i public.private_file_write_intents%rowtype;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into i from public.private_file_write_intents where id = p_intent_id and user_id = p_user_id;
  if not found then raise exception 'intent not found'; end if;
  select * into m from public.user_file_manifests where id = i.manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  select * into strict i from public.private_file_write_intents where id = p_intent_id for update;
  perform public.assert_private_file_upload_allowed(p_user_id, m.edition_id);
  if m.upload_state <> 'uploading' or m.deleted_at is not null or i.fenced_at is not null
    or i.manifest_version <> m.active_version or m.upload_expires_at is null
    or m.upload_expires_at <= now() then raise exception 'upload is not active'; end if;
  if i.committed_at is not null then return; end if;
  insert into public.user_file_chunks(user_id, manifest_id, manifest_version, chunk_index,
    cipher_hash, ciphertext_size, object_key, uploaded_at)
    values(p_user_id, i.manifest_id, i.manifest_version, i.chunk_index,
      i.chunk_hash, i.chunk_bytes, i.object_key, now())
    on conflict(manifest_id, manifest_version, chunk_index) do update set
      cipher_hash = excluded.cipher_hash, ciphertext_size = excluded.ciphertext_size,
      object_key = excluded.object_key, uploaded_at = now(), deleted_at = null;
  update public.private_file_write_intents set committed_at = now() where id = p_intent_id;
end;
$$;

create function public.get_private_file_cleanup_intents(p_user_id uuid, p_manifest_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.user_file_manifests%rowtype;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into m from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  if m.upload_state not in ('deleting', 'deleted') then raise exception 'deletion was not requested'; end if;
  -- Include unconfirmed, failed, in-flight and already fenced identities.
  -- These keys must never be recycled or removed by TTL/GC.
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'key', object_key) order by created_at, id)
    from public.private_file_write_intents where user_id = p_user_id and manifest_id = p_manifest_id), '[]'::jsonb);
end;
$$;

create function public.ack_private_file_body_fence(p_user_id uuid, p_intent_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare i public.private_file_write_intents%rowtype; m public.user_file_manifests%rowtype;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into i from public.private_file_write_intents where id = p_intent_id and user_id = p_user_id;
  if not found then raise exception 'intent not found'; end if;
  select * into m from public.user_file_manifests where id = i.manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  if i.fenced_at is not null then return; end if;
  if m.upload_state not in ('deleting', 'deleted') then raise exception 'deletion was not requested'; end if;
  -- Only Worker may acknowledge, after writing and confirming an empty fence.
  update public.private_file_write_intents set fenced_at = now() where id = p_intent_id;
end;
$$;

create or replace function public.finish_user_file_delete(p_user_id uuid, p_manifest_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.user_file_manifests%rowtype;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into m from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then return; end if;
  if m.upload_state not in ('deleting', 'deleted') then raise exception 'deletion was not requested'; end if;
  if exists(select 1 from public.private_file_write_intents where manifest_id = p_manifest_id and fenced_at is null) then
    raise exception 'body cleanup is incomplete';
  end if;
  if m.upload_state = 'deleted' then return; end if;
  update public.user_file_chunks set deleted_at = now() where manifest_id = p_manifest_id and deleted_at is null;
  update public.user_file_manifests set upload_state = 'deleted', delete_completed_at = now(), reserved_bytes = 0 where id = p_manifest_id;
  if m.delete_quota_bucket = 'used' then
    update public.user_storage_quotas set used_bytes = greatest(0, used_bytes - m.plaintext_size), updated_at = now() where user_id = p_user_id;
  else
    update public.user_storage_quotas set reserved_bytes = greatest(0, reserved_bytes - m.reserved_bytes), updated_at = now() where user_id = p_user_id;
  end if;
end;
$$;

create or replace function public.record_user_file_chunk(
  p_user_id uuid, p_manifest_id uuid, p_chunk_index integer, p_cipher_hash text,
  p_ciphertext_size integer, p_object_key text
) returns void language plpgsql security definer set search_path = public as $$
begin raise exception 'registered immutable write intent required'; end;
$$;
revoke all on function public.record_user_file_chunk(uuid, uuid, integer, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.prepare_private_file_chunk(uuid, uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.commit_private_file_chunk(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_private_file_cleanup_intents(uuid, uuid) from public, anon, authenticated;
revoke all on function public.ack_private_file_body_fence(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prepare_private_file_chunk(uuid, uuid, integer, text, integer),
  public.commit_private_file_chunk(uuid, uuid), public.get_private_file_cleanup_intents(uuid, uuid),
  public.ack_private_file_body_fence(uuid, uuid) to service_role;
