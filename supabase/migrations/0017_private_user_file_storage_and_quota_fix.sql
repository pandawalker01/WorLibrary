-- Forward-only correction for the P0 private object store. The original
-- `managed-v1` label did not represent application-layer encryption, and the
-- delete path must remember whether an active file had already charged used
-- quota before its state changes to `deleting`.

alter table public.user_file_manifests
  rename column encryption_version to storage_mode;

alter table public.user_file_manifests
  drop constraint if exists user_file_manifests_encryption_version_check;

alter table public.user_file_manifests
  alter column storage_mode set default 'private-r2-v1';

update public.user_file_manifests
  set storage_mode = 'private-r2-v1'
  where storage_mode = 'managed-v1';

alter table public.user_file_manifests
  add constraint user_file_manifests_storage_mode_check
  check (storage_mode in ('private-r2-v1'));

alter table public.user_file_manifests
  add column if not exists delete_quota_bucket text;

update public.user_file_manifests
  set delete_quota_bucket = case when upload_state = 'active' then 'used' else 'reserved' end
  where delete_quota_bucket is null;

alter table public.user_file_manifests
  alter column delete_quota_bucket set default 'reserved',
  alter column delete_quota_bucket set not null,
  add constraint user_file_manifests_delete_quota_bucket_check
  check (delete_quota_bucket in ('used', 'reserved'));

comment on column public.user_file_manifests.storage_mode is
  'Private object-storage access mode. P0 does not claim application-layer encryption.';

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
  update public.user_file_manifests set upload_state = 'active', reserved_bytes = 0, upload_expires_at = null, delete_quota_bucket = 'used' where id = p_manifest_id;
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
  if v_manifest.upload_state not in ('deleted', 'deleting') then
    insert into public.user_file_tombstones (user_id, edition_id, deleted_manifest_id) values (p_user_id, v_manifest.edition_id, p_manifest_id) on conflict (user_id, edition_id) do update set deleted_manifest_id = excluded.deleted_manifest_id, deleted_at = now(), expires_at = now() + interval '30 days';
    update public.user_file_manifests
      set upload_state = 'deleting', delete_requested_at = now(), deleted_at = now(),
          delete_quota_bucket = case when v_manifest.upload_state = 'active' then 'used' else 'reserved' end
      where id = p_manifest_id;
  end if;
  return query select v_manifest.id, coalesce(array(select object_key from public.user_file_chunks where manifest_id = p_manifest_id and deleted_at is null), '{}'::text[]);
end;
$$;

create or replace function public.finish_user_file_delete(p_user_id uuid, p_manifest_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_manifest public.user_file_manifests%rowtype; v_quota_bucket text;
begin
  select * into v_manifest from public.user_file_manifests where id = p_manifest_id and user_id = p_user_id for update;
  if not found or v_manifest.upload_state = 'deleted' then return; end if;
  -- Active files are charged to used_bytes. Uploading, verifying and deleting
  -- files only release reserved_bytes unless request_user_file_delete recorded
  -- that an active file had already converted its reservation to used_bytes.
  if v_manifest.upload_state = 'active' then
    v_quota_bucket := 'used';
  elsif v_manifest.upload_state in ('uploading', 'verifying') then
    v_quota_bucket := 'reserved';
  elsif v_manifest.upload_state = 'deleting' then
    v_quota_bucket := v_manifest.delete_quota_bucket;
  else
    v_quota_bucket := 'reserved';
  end if;
  update public.user_file_chunks set deleted_at = now() where manifest_id = p_manifest_id and deleted_at is null;
  update public.user_file_manifests set upload_state = 'deleted', delete_completed_at = now(), reserved_bytes = 0 where id = p_manifest_id;
  if v_quota_bucket = 'used' then
    update public.user_storage_quotas set used_bytes = greatest(0, used_bytes - v_manifest.plaintext_size), updated_at = now() where user_id = p_user_id;
  else
    update public.user_storage_quotas set reserved_bytes = greatest(0, reserved_bytes - v_manifest.reserved_bytes), updated_at = now() where user_id = p_user_id;
  end if;
end;
$$;

create or replace function public.reap_expired_user_file_uploads(p_user_id uuid)
returns table(manifest_id uuid, object_keys text[]) language plpgsql security definer set search_path = public as $$
begin
  return query
  with expired as (
    update public.user_file_manifests
      set upload_state = 'deleting', deleted_at = now(), delete_requested_at = now(), delete_quota_bucket = 'reserved'
      where user_id = p_user_id and upload_state in ('uploading', 'verifying') and upload_expires_at <= now()
      returning id
  )
  select expired.id, coalesce(array(select object_key from public.user_file_chunks where manifest_id = expired.id and deleted_at is null), '{}'::text[])
  from expired;
end;
$$;
