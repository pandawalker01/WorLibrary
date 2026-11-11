-- Draft forward-only: deploy together with the immutable-object Worker protocol.
-- This intentionally makes the old, unverified completion route fail closed.
alter table public.user_file_manifests
  add column chunk_generation bigint not null default 0 check (chunk_generation >= 0);

create function public.bump_private_file_chunk_generation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (old.manifest_id, old.user_id, old.manifest_version)
    is distinct from (new.manifest_id, new.user_id, new.manifest_version) then
    raise exception 'chunk identity is immutable';
  end if;
  update public.user_file_manifests set chunk_generation = chunk_generation + 1
    where id = case when tg_op = 'DELETE' then old.manifest_id else new.manifest_id end;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.bump_private_file_chunk_generation() from public, anon, authenticated, service_role;
create trigger private_file_chunk_generation
  after insert or update or delete on public.user_file_chunks
  for each row execute function public.bump_private_file_chunk_generation();

-- Internal service-only snapshot. Never forward object locations to browsers.
create function public.get_private_file_verification_snapshot(p_user_id uuid, p_manifest_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype; v_chunks jsonb;
begin
  perform public.lock_private_file_account(p_user_id);
  select * into v_manifest from public.user_file_manifests
    where id = p_manifest_id and user_id = p_user_id for update;
  if not found then raise exception 'manifest not found'; end if;
  perform public.assert_private_file_upload_allowed(p_user_id, v_manifest.edition_id);
  if v_manifest.upload_state not in ('uploading', 'active') or v_manifest.deleted_at is not null
    or (v_manifest.upload_state = 'uploading' and
      (v_manifest.upload_expires_at is null or v_manifest.upload_expires_at <= now())) then
    raise exception 'manifest is not verifiable';
  end if;
  select jsonb_agg(jsonb_build_object('index', c.chunk_index, 'key', c.object_key,
    'size', c.ciphertext_size, 'hash', c.cipher_hash) order by c.chunk_index)
    into v_chunks from public.user_file_chunks c
    where c.manifest_id = p_manifest_id and c.user_id = p_user_id
      and c.manifest_version = v_manifest.active_version and c.deleted_at is null;
  if coalesce(jsonb_array_length(v_chunks), 0) <> v_manifest.chunk_count
    or exists (select 1 from jsonb_array_elements(v_chunks) c
      where (c->>'index')::integer >= v_manifest.chunk_count
        or (c->>'size')::bigint <> least(v_manifest.chunk_size::bigint,
          v_manifest.plaintext_size - (c->>'index')::bigint * v_manifest.chunk_size)) then
    raise exception 'upload is incomplete';
  end if;
  return jsonb_build_object('generation', v_manifest.chunk_generation,
    'manifest', jsonb_build_object('size', v_manifest.plaintext_size, 'hash', v_manifest.plaintext_hash,
      'chunkSize', v_manifest.chunk_size, 'chunkCount', v_manifest.chunk_count), 'chunks', v_chunks);
end;
$$;
revoke all on function public.get_private_file_verification_snapshot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_private_file_verification_snapshot(uuid, uuid) to service_role;

-- Only the Worker, after actual-byte verification of the snapshot, may invoke.
-- SQL does not itself read R2 or prove the service-supplied digest is genuine.
create function public.complete_verified_user_file_upload(
  p_user_id uuid, p_manifest_id uuid, p_generation bigint, p_verified_size bigint, p_verified_hash text
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype; v_snapshot jsonb;
begin
  -- Snapshot reacquires the account fence and manifest lock in the same tx;
  -- all validation below is against current state, never a browser receipt.
  v_snapshot := public.get_private_file_verification_snapshot(p_user_id, p_manifest_id);
  select * into strict v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id;
  if p_generation is null or p_generation <> v_manifest.chunk_generation then
    raise exception 'verification snapshot changed';
  end if;
  if p_verified_size is distinct from v_manifest.plaintext_size
    or p_verified_hash is distinct from v_manifest.plaintext_hash then
    raise exception 'verified file descriptor mismatch';
  end if;
  if v_manifest.upload_state = 'active' then return true; end if;
  update public.user_file_manifests set upload_state = 'active', reserved_bytes = 0,
    upload_expires_at = null, delete_quota_bucket = 'used' where id = p_manifest_id;
  update public.user_storage_quotas set reserved_bytes = greatest(0, reserved_bytes - v_manifest.reserved_bytes),
    used_bytes = used_bytes + v_manifest.reserved_bytes, updated_at = now() where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.complete_verified_user_file_upload(uuid, uuid, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.complete_verified_user_file_upload(uuid, uuid, bigint, bigint, text) to service_role;

-- Remove the legacy bypass even for service_role, and fail closed for any old
-- definer caller. No remote application is authorized by this draft migration.
create or replace function public.complete_user_file_upload(p_user_id uuid, p_manifest_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  raise exception 'verified completion required';
end;
$$;
revoke all on function public.complete_user_file_upload(uuid, uuid) from public, anon, authenticated, service_role;
