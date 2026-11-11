-- Draft forward migration. Requires review and the staging migration gate.
-- Does not enable the product UI or assert real R2/Supabase acceptance.
create table public.user_file_library_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  accepted_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not enabled or accepted_at is not null)
);
alter table public.user_file_library_preferences enable row level security;
revoke all on public.user_file_library_preferences from public, anon, authenticated;
grant all on public.user_file_library_preferences to service_role;
create policy "own private file consent" on public.user_file_library_preferences
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create function public.require_private_file_account()
returns uuid language plpgsql stable security invoker set search_path = public as $$
begin
  if auth.uid() is null
    or coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
    or coalesce((auth.jwt()->'app_metadata'->>'is_anonymous')::boolean, false) then
    raise exception 'stable account required';
  end if;
  return auth.uid();
end;
$$;
revoke all on function public.require_private_file_account() from public, anon, authenticated;

create function public.get_private_file_library_state()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_id uuid := public.require_private_file_account();
begin
  return jsonb_build_object(
    'enabled', coalesce((select enabled from public.user_file_library_preferences where user_id = v_user_id), false),
    'consented', exists(select 1 from public.user_file_library_preferences where user_id = v_user_id and accepted_at is not null),
    'quotaBytes', coalesce((select included_bytes from public.user_storage_quotas where user_id = v_user_id), 1073741824),
    'usedBytes', coalesce((select used_bytes from public.user_storage_quotas where user_id = v_user_id), 0),
    'reservedBytes', coalesce((select reserved_bytes from public.user_storage_quotas where user_id = v_user_id), 0)
  );
end;
$$;

create function public.set_private_file_library_enabled(p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_id uuid := public.require_private_file_account();
begin
  if p_enabled is null then raise exception 'explicit enabled choice required'; end if;
  insert into public.user_file_library_preferences (user_id, enabled, accepted_at)
    values (v_user_id, p_enabled, case when p_enabled then now() else null end)
    on conflict (user_id) do update set enabled = excluded.enabled,
      accepted_at = coalesce(user_file_library_preferences.accepted_at, excluded.accepted_at), updated_at = now();
  return public.get_private_file_library_state();
end;
$$;
revoke all on function public.get_private_file_library_state() from public, anon, authenticated;
revoke all on function public.set_private_file_library_enabled(boolean) from public, anon, authenticated;
grant execute on function public.get_private_file_library_state() to authenticated;
grant execute on function public.set_private_file_library_enabled(boolean) to authenticated;

-- File admission remains service-only. Consent is dedicated private state,
-- never an arbitrary metadata setting, payload or file-bearing metadata RPC.
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
  if not exists(select 1 from public.user_file_library_preferences
    where user_id = p_user_id and enabled and accepted_at is not null) then
    raise exception 'private file consent required';
  end if;
  if not exists(select 1 from public.editions where id = p_edition_id
    and user_id = p_user_id and deleted_at is null) then
    raise exception 'owned active edition required';
  end if;
  -- Serialise begin calls for this account without reversing the existing
  -- manifest-then-quota lock order used by completion and deletion.
  perform pg_advisory_xact_lock(hashtextextended('private-user-file:' || p_user_id::text, 0));
  -- A cloud deletion does not authorise the same edition to reappear after
  -- 30 days. A deliberate fresh import must have a new edition identity.
  if exists(select 1 from public.user_file_tombstones where user_id = p_user_id and edition_id = p_edition_id) then
    raise exception 'file deletion tombstone is active';
  end if;
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
