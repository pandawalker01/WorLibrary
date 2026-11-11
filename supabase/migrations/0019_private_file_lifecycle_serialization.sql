-- Forward-only private-file serialization. Local SQL fixtures are not a
-- substitute for real Supabase/R2 acceptance or remote migration approval.
alter table public.user_file_library_preferences
  add column mutation_epoch bigint not null default 0 check (mutation_epoch >= 0);

create function public.lock_private_file_account(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user_id is null then raise exception 'private file account required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('private-user-file:' || p_user_id::text, 0));
  -- Every writer updates the same fence after taking the advisory lock. A
  -- REPEATABLE READ transaction with an old snapshot must fail serialization,
  -- not use pre-pause/deletion state after waiting for the account lock.
  insert into public.user_file_library_preferences (user_id, mutation_epoch)
    values (p_user_id, 1)
    on conflict (user_id) do update
      set mutation_epoch = user_file_library_preferences.mutation_epoch + 1;
end;
$$;
revoke all on function public.lock_private_file_account(uuid) from public, anon, authenticated, service_role;

create function public.assert_private_file_upload_allowed(p_user_id uuid, p_edition_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.user_file_library_preferences
    where user_id = p_user_id and enabled and accepted_at is not null for share;
  if not found then raise exception 'private file consent required'; end if;
  -- SHARE also orders us against metadata's soft deletion of this edition;
  -- no metadata RPC or metadata lock protocol is changed here.
  perform 1 from public.editions where id = p_edition_id
    and user_id = p_user_id and deleted_at is null for share;
  if not found then raise exception 'owned active edition required'; end if;
  if exists(select 1 from public.user_file_tombstones where user_id = p_user_id and edition_id = p_edition_id) then
    raise exception 'file deletion tombstone is active';
  end if;
end;
$$;
revoke all on function public.assert_private_file_upload_allowed(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.set_private_file_library_enabled(p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_id uuid := public.require_private_file_account();
begin
  if p_enabled is null then raise exception 'explicit enabled choice required'; end if;
  perform public.lock_private_file_account(v_user_id);
  insert into public.user_file_library_preferences (user_id, enabled, accepted_at)
    values (v_user_id, p_enabled, case when p_enabled then now() else null end)
    on conflict (user_id) do update set enabled = excluded.enabled,
      accepted_at = coalesce(user_file_library_preferences.accepted_at, excluded.accepted_at), updated_at = now();
  return public.get_private_file_library_state();
end;
$$;

create or replace function public.record_user_file_chunk(
  p_user_id uuid, p_manifest_id uuid, p_chunk_index integer, p_cipher_hash text,
  p_ciphertext_size integer, p_object_key text
) returns void language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  perform public.assert_private_file_upload_allowed(p_user_id, v_manifest.edition_id);
  if v_manifest.upload_state <> 'uploading' or v_manifest.deleted_at is not null
    or v_manifest.upload_expires_at is null or v_manifest.upload_expires_at <= now() then raise exception 'upload is not active'; end if;
  if p_chunk_index is null or p_chunk_index < 0 or p_chunk_index >= v_manifest.chunk_count
    or p_ciphertext_size is null or p_ciphertext_size < 1
    or p_ciphertext_size <> least(v_manifest.chunk_size::bigint, v_manifest.plaintext_size - p_chunk_index::bigint * v_manifest.chunk_size)
    or p_cipher_hash is null or p_cipher_hash !~ '^[0-9a-f]{64}$'
    or p_object_key is distinct from ('private/' || p_user_id::text || '/' || p_manifest_id::text || '/v' || v_manifest.active_version::text || '/' || p_chunk_index::text) then
    raise exception 'invalid chunk';
  end if;
  insert into public.user_file_chunks (user_id, manifest_id, manifest_version, chunk_index, cipher_hash, ciphertext_size, object_key, uploaded_at)
    values (p_user_id, p_manifest_id, v_manifest.active_version, p_chunk_index, p_cipher_hash, p_ciphertext_size, p_object_key, now())
    on conflict (manifest_id, manifest_version, chunk_index) do update
      set cipher_hash = excluded.cipher_hash, ciphertext_size = excluded.ciphertext_size,
          object_key = excluded.object_key, uploaded_at = now(), deleted_at = null;
end;
$$;

create or replace function public.complete_user_file_upload(p_user_id uuid, p_manifest_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype; v_count integer; v_size bigint;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  perform public.assert_private_file_upload_allowed(p_user_id, v_manifest.edition_id);
  if v_manifest.upload_state = 'active' then return true; end if;
  if v_manifest.upload_state <> 'uploading' or v_manifest.deleted_at is not null
    or v_manifest.upload_expires_at is null or v_manifest.upload_expires_at <= now() then raise exception 'manifest is not uploadable'; end if;
  select count(*), coalesce(sum(c.ciphertext_size), 0) into v_count, v_size
    from public.user_file_chunks c where c.manifest_id = p_manifest_id
      and c.manifest_version = v_manifest.active_version and c.deleted_at is null;
  if v_count <> v_manifest.chunk_count or v_size <> v_manifest.plaintext_size then raise exception 'upload is incomplete'; end if;
  update public.user_file_manifests set upload_state = 'active', reserved_bytes = 0,
    upload_expires_at = null, delete_quota_bucket = 'used' where id = p_manifest_id;
  update public.user_storage_quotas set reserved_bytes = greatest(0, reserved_bytes - v_manifest.reserved_bytes),
    used_bytes = used_bytes + v_manifest.reserved_bytes, updated_at = now() where user_id = p_user_id;
  return true;
end;
$$;

create or replace function public.request_user_file_delete(p_user_id uuid, p_manifest_id uuid)
returns table(manifest_id uuid, object_keys text[]) language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found then return; end if;
  -- Deletion is allowed while paused, or after metadata soft deletion.
  insert into public.user_file_tombstones (user_id, edition_id, deleted_manifest_id)
    values (p_user_id, v_manifest.edition_id, p_manifest_id)
    on conflict (user_id, edition_id) do update set deleted_manifest_id = excluded.deleted_manifest_id,
      deleted_at = now(), expires_at = now() + interval '30 days';
  if v_manifest.upload_state not in ('deleted', 'deleting') then
    update public.user_file_manifests set upload_state = 'deleting', delete_requested_at = now(), deleted_at = now(),
      delete_quota_bucket = case when v_manifest.upload_state = 'active' then 'used' else 'reserved' end
      where id = p_manifest_id;
  end if;
  return query select v_manifest.id, coalesce(array(select c.object_key from public.user_file_chunks c
    where c.manifest_id = p_manifest_id and c.deleted_at is null), '{}'::text[]);
end;
$$;

create or replace function public.finish_user_file_delete(p_user_id uuid, p_manifest_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found or v_manifest.upload_state = 'deleted' then return; end if;
  if v_manifest.upload_state <> 'deleting' then raise exception 'deletion was not requested'; end if;
  update public.user_file_chunks set deleted_at = now() where manifest_id = p_manifest_id and deleted_at is null;
  update public.user_file_manifests set upload_state = 'deleted', delete_completed_at = now(), reserved_bytes = 0 where id = p_manifest_id;
  if v_manifest.delete_quota_bucket = 'used' then
    update public.user_storage_quotas set used_bytes = greatest(0, used_bytes - v_manifest.plaintext_size), updated_at = now() where user_id = p_user_id;
  else
    update public.user_storage_quotas set reserved_bytes = greatest(0, reserved_bytes - v_manifest.reserved_bytes), updated_at = now() where user_id = p_user_id;
  end if;
end;
$$;

create or replace function public.reap_expired_user_file_uploads(p_user_id uuid)
returns table(manifest_id uuid, object_keys text[]) language plpgsql security definer set search_path = public as $$
begin
  perform public.lock_private_file_account(p_user_id);
  update public.user_file_manifests set upload_state = 'deleting', deleted_at = now(),
    delete_requested_at = now(), delete_quota_bucket = 'reserved'
    where user_id = p_user_id and upload_state in ('uploading', 'verifying') and upload_expires_at <= now();
  -- Include previously pending deletion so a failed R2 cleanup is retryable.
  return query select m.id, coalesce(array(select c.object_key from public.user_file_chunks c
    where c.manifest_id = m.id and c.deleted_at is null), '{}'::text[])
    from public.user_file_manifests m where m.user_id = p_user_id and m.upload_state = 'deleting';
end;
$$;

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
  if p_user_id is null or p_edition_id is null or p_idempotency_key is null
    or p_file_name is null or p_media_type is null or p_plaintext_size is null
    or p_chunk_size is null or p_chunk_count is null or p_plaintext_hash is null
    or p_file_name !~ '^[^[:cntrl:]\\/]{1,240}$'
    or p_media_type not in ('application/epub+zip', 'application/pdf')
    or p_plaintext_size < 1 or p_plaintext_size > 1073741824
    or p_chunk_size <> 8388608
    or p_chunk_count <> ceil(p_plaintext_size::numeric / 8388608)::integer
    or p_plaintext_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid private file manifest';
  end if;
  perform public.lock_private_file_account(p_user_id);
  perform public.assert_private_file_upload_allowed(p_user_id, p_edition_id);
  insert into public.user_storage_quotas (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_manifest from public.user_file_manifests
    where user_id = p_user_id and idempotency_key = p_idempotency_key for update;
  if not found then
    select * into v_manifest from public.user_file_manifests
      where user_id = p_user_id and edition_id = p_edition_id and plaintext_hash = p_plaintext_hash for update;
  end if;
  if found then
    if v_manifest.edition_id <> p_edition_id or v_manifest.plaintext_hash <> p_plaintext_hash
      or v_manifest.file_name <> p_file_name or v_manifest.media_type <> p_media_type
      or v_manifest.plaintext_size <> p_plaintext_size or v_manifest.chunk_size <> p_chunk_size
      or v_manifest.chunk_count <> p_chunk_count then raise exception 'idempotency key conflict'; end if;
    if v_manifest.upload_state in ('deleting', 'failed', 'verifying') then raise exception 'upload is not active'; end if;
    if v_manifest.upload_state = 'deleted' then
      -- Expired uploads have no user-deletion tombstone. Reuse only after
      -- finish_user_file_delete confirmed object cleanup and released quota.
      select * into v_quota from public.user_storage_quotas where user_id = p_user_id for update;
      if v_quota.used_bytes + v_quota.reserved_bytes + p_plaintext_size > v_quota.included_bytes then raise exception 'storage quota exceeded'; end if;
      update public.user_file_manifests set upload_state = 'uploading', deleted_at = null,
        delete_requested_at = null, delete_completed_at = null, reserved_bytes = p_plaintext_size,
        delete_quota_bucket = 'reserved', upload_expires_at = now() + interval '24 hours'
        where id = v_manifest.id returning * into v_manifest;
      update public.user_storage_quotas set reserved_bytes = reserved_bytes + p_plaintext_size, updated_at = now() where user_id = p_user_id;
    elsif v_manifest.upload_state = 'uploading' and v_manifest.upload_expires_at <= now() then
      raise exception 'expired upload cleanup required';
    end if;
  else
    select * into v_quota from public.user_storage_quotas where user_id = p_user_id for update;
    if v_quota.used_bytes + v_quota.reserved_bytes + p_plaintext_size > v_quota.included_bytes then raise exception 'storage quota exceeded'; end if;
    insert into public.user_file_manifests (user_id, edition_id, plaintext_hash, plaintext_size, media_type, file_name, chunk_size, chunk_count, idempotency_key, reserved_bytes, upload_expires_at)
      values (p_user_id, p_edition_id, p_plaintext_hash, p_plaintext_size, p_media_type, p_file_name, p_chunk_size, p_chunk_count, p_idempotency_key, p_plaintext_size, now() + interval '24 hours')
      returning * into v_manifest;
    update public.user_storage_quotas set reserved_bytes = reserved_bytes + p_plaintext_size, updated_at = now() where user_id = p_user_id;
  end if;
  return query select v_manifest.id, v_manifest.upload_state,
    coalesce(array(select c.chunk_index from public.user_file_chunks c where c.manifest_id = v_manifest.id
      and c.manifest_version = v_manifest.active_version and c.deleted_at is null order by c.chunk_index), '{}'::integer[]);
end;
$$;
revoke all on function public.begin_user_file_upload(uuid, uuid, text, text, bigint, integer, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.begin_user_file_upload(uuid, uuid, text, text, bigint, integer, integer, uuid, text) to service_role;

revoke all on function public.set_private_file_library_enabled(boolean) from public, anon, authenticated;
grant execute on function public.set_private_file_library_enabled(boolean) to authenticated;
revoke all on function public.record_user_file_chunk(uuid, uuid, integer, text, integer, text) from public, anon, authenticated;
grant execute on function public.record_user_file_chunk(uuid, uuid, integer, text, integer, text) to service_role;
revoke all on function public.complete_user_file_upload(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_user_file_upload(uuid, uuid) to service_role;
revoke all on function public.request_user_file_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_user_file_delete(uuid, uuid) to service_role;
revoke all on function public.finish_user_file_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finish_user_file_delete(uuid, uuid) to service_role;
revoke all on function public.reap_expired_user_file_uploads(uuid) from public, anon, authenticated;
grant execute on function public.reap_expired_user_file_uploads(uuid) to service_role;
