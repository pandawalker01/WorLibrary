-- Controlled metadata-sync RPCs.  Browser clients may submit only a bounded,
-- user-owned metadata mutation through this interface.  In particular this
-- migration never accepts EPUB/PDF bytes, object keys, content URLs, or full
-- book bodies.  Original-file backup remains a later, separately encrypted
-- protocol.

alter table public.sync_changes
  add column if not exists payload jsonb not null default '{}'::jsonb;

-- Keep validation in non-public helpers so new entity handlers cannot
-- accidentally reintroduce file/object fields through a nested metadata map.
create or replace function public.controlled_sync_payload_has_forbidden_key(
  p_value jsonb
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
  v_child jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      for v_key, v_child in select key, value from jsonb_each(p_value)
      loop
        if lower(v_key) in (
          'blob', 'book_blob', 'book-blobs', 'file_bytes', 'filebytes',
          'object_key', 'objectkey', 'content_url', 'contenturl',
          'signed_url', 'signedurl', 'raw_content', 'rawcontent', 'body'
        ) or public.controlled_sync_payload_has_forbidden_key(v_child) then
          return true;
        end if;
      end loop;
    when 'array' then
      for v_child in select value from jsonb_array_elements(p_value)
      loop
        if public.controlled_sync_payload_has_forbidden_key(v_child) then return true; end if;
      end loop;
  end case;
  return false;
end;
$$;

create or replace function public.assert_controlled_sync_payload(
  p_payload jsonb,
  p_allowed_keys text[]
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'sync payload must be an object';
  end if;
  if octet_length(p_payload::text) > 65536 then
    raise exception 'sync payload exceeds metadata limit';
  end if;

  for v_key in select jsonb_object_keys(p_payload)
  loop
    if not (v_key = any(p_allowed_keys)) then
      raise exception 'unsupported sync payload key: %', v_key;
    end if;
  end loop;

  -- `metadata` is intentionally extensible, so inspect every nested object
  -- key before it is persisted or copied to the durable change feed.
  if public.controlled_sync_payload_has_forbidden_key(p_payload) then
    raise exception 'file, object, or full-content fields are not sync metadata';
  end if;
end;
$$;

-- Append one idempotent mutation.  A stale base revision is rejected rather
-- than silently overwriting a change from another device; the caller must pull
-- and merge before retrying with a new operation id.
create or replace function public.apply_metadata_sync_change(
  p_device_id uuid,
  p_operation_id uuid,
  p_entity_type text,
  p_entity_id text,
  p_operation text,
  p_base_revision bigint,
  p_payload jsonb default '{}'::jsonb
) returns table (
  sequence bigint,
  entity_revision bigint,
  operation text,
  applied boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_existing public.sync_changes%rowtype;
  v_device public.devices%rowtype;
  v_entity_uuid uuid;
  v_current_revision bigint := 0;
  v_entity_exists boolean := false;
  v_next_revision bigint;
  v_change public.sync_changes%rowtype;
  v_change_payload jsonb := '{}'::jsonb;
  v_title text;
  v_metadata jsonb;
  v_work_id uuid;
  v_edition_id uuid;
  v_setting_value jsonb;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;
  if p_device_id is null or p_operation_id is null then
    raise exception 'device id and operation id are required';
  end if;
  if p_entity_type not in ('work', 'edition', 'reading_progress', 'highlight', 'library_item', 'setting') then
    raise exception 'invalid sync entity type';
  end if;
  if p_operation not in ('upsert', 'delete') then raise exception 'invalid sync operation'; end if;
  if p_entity_id is null or char_length(p_entity_id) not between 1 and 256 then
    raise exception 'invalid sync entity id';
  end if;
  if p_base_revision is null or p_base_revision < 0 then
    raise exception 'base revision must be non-negative';
  end if;

  select * into v_device
  from public.devices
  where id = p_device_id and user_id = v_user_id and revoked_at is null
  for update;
  if not found then raise exception 'active owned device required'; end if;

  select * into v_existing
  from public.sync_changes
  where user_id = v_user_id and mutation_id = p_operation_id;
  if found then
    if v_existing.device_id <> p_device_id
       or v_existing.entity_type <> p_entity_type
       or v_existing.entity_id <> p_entity_id
       or v_existing.operation <> p_operation then
      raise exception 'operation id was already used for another mutation';
    end if;
    return query select v_existing.sequence, v_existing.entity_revision, v_existing.operation, false;
    return;
  end if;

  if p_operation = 'upsert' then
    case p_entity_type
      when 'work' then
        perform public.assert_controlled_sync_payload(p_payload, array['title', 'author', 'metadata']);
      when 'edition' then
        perform public.assert_controlled_sync_payload(p_payload, array['work_id', 'title', 'author', 'language', 'progress', 'location', 'file_name', 'file_type', 'file_size', 'cover']);
      when 'reading_progress' then
        perform public.assert_controlled_sync_payload(p_payload, array['edition_id', 'progress', 'location']);
      when 'highlight' then
        perform public.assert_controlled_sync_payload(p_payload, array['edition_id', 'book_id', 'text', 'location', 'note', 'color']);
        if coalesce(char_length(p_payload->>'text'), 0) > 32768 then raise exception 'highlight text exceeds excerpt limit'; end if;
        if coalesce(char_length(p_payload->>'note'), 0) > 16384 then raise exception 'highlight note exceeds limit'; end if;
      when 'library_item' then
        perform public.assert_controlled_sync_payload(p_payload, array['source_type', 'catalog_edition_id', 'local_book_id', 'external_source', 'external_record_id', 'external_url', 'shelf_status', 'access_mode', 'metadata']);
      when 'setting' then
        perform public.assert_controlled_sync_payload(p_payload, array['value']);
    end case;
  elsif p_payload <> '{}'::jsonb then
    raise exception 'delete mutations cannot contain a payload';
  end if;

  if p_entity_type = 'setting' then
    if p_entity_id !~ '^[a-z0-9][a-z0-9_.-]{0,127}$' then raise exception 'invalid setting key'; end if;
    select revision, true into v_current_revision, v_entity_exists from public.user_setting_values
      where user_id = v_user_id and setting_key = p_entity_id for update;
  else
    begin v_entity_uuid := p_entity_id::uuid;
    exception when invalid_text_representation then raise exception 'entity id must be a UUID'; end;
    case p_entity_type
      when 'work' then select revision, true into v_current_revision, v_entity_exists from public.works where id = v_entity_uuid and user_id = v_user_id for update;
      when 'edition' then select revision, true into v_current_revision, v_entity_exists from public.editions where id = v_entity_uuid and user_id = v_user_id for update;
      when 'reading_progress' then select revision, true into v_current_revision, v_entity_exists from public.reading_progress where edition_id = v_entity_uuid and user_id = v_user_id for update;
      when 'highlight' then select revision, true into v_current_revision, v_entity_exists from public.highlights where id = v_entity_uuid and user_id = v_user_id for update;
      when 'library_item' then select revision, true into v_current_revision, v_entity_exists from public.user_library_items where id = v_entity_uuid and user_id = v_user_id for update;
    end case;
  end if;
  v_current_revision := coalesce(v_current_revision, 0);
  v_entity_exists := coalesce(v_entity_exists, false);
  if v_current_revision <> p_base_revision then raise exception 'stale base revision'; end if;

  if not v_entity_exists and p_entity_type <> 'setting' and exists (
    select 1
    from (
      select id from public.works where p_entity_type = 'work' and id = v_entity_uuid
      union all select id from public.editions where p_entity_type = 'edition' and id = v_entity_uuid
      union all select edition_id from public.reading_progress where p_entity_type = 'reading_progress' and edition_id = v_entity_uuid
      union all select id from public.highlights where p_entity_type = 'highlight' and id = v_entity_uuid
      union all select id from public.user_library_items where p_entity_type = 'library_item' and id = v_entity_uuid
    ) as foreign_entity
  ) then
    raise exception 'entity id belongs to another account';
  end if;

  if exists (
    select 1 from public.sync_tombstones
    where user_id = v_user_id and entity_type = p_entity_type and entity_id = p_entity_id
  ) and p_operation = 'upsert' then
    raise exception 'deleted entity cannot be resurrected; create a new id';
  end if;
  if p_operation = 'delete' and not v_entity_exists then raise exception 'cannot delete a missing entity'; end if;
  v_next_revision := v_current_revision + 1;

  if p_operation = 'upsert' then
    if p_entity_type = 'work' then
      v_title := nullif(trim(p_payload->>'title'), '');
      if v_title is null then raise exception 'work title is required'; end if;
      v_metadata := coalesce(p_payload->'metadata', '{}'::jsonb);
      if jsonb_typeof(v_metadata) <> 'object' then raise exception 'work metadata must be an object'; end if;
      insert into public.works (id, user_id, title, author, metadata, revision, last_mutation_id, last_device_id, deleted_at)
      values (v_entity_uuid, v_user_id, v_title, nullif(trim(p_payload->>'author'), ''), v_metadata, v_next_revision, p_operation_id, p_device_id, null)
      on conflict (id) do update set title = excluded.title, author = excluded.author, metadata = excluded.metadata,
        revision = excluded.revision, last_mutation_id = excluded.last_mutation_id, last_device_id = excluded.last_device_id, deleted_at = null
      where public.works.user_id = v_user_id;
      v_change_payload := jsonb_build_object('title', v_title, 'author', nullif(trim(p_payload->>'author'), ''), 'metadata', v_metadata);
    elsif p_entity_type = 'edition' then
      v_title := nullif(trim(p_payload->>'title'), '');
      if v_title is null then raise exception 'edition title is required'; end if;
      if p_payload ? 'work_id' and nullif(p_payload->>'work_id', '') is not null then
        v_work_id := (p_payload->>'work_id')::uuid;
        if not exists (select 1 from public.works where id = v_work_id and user_id = v_user_id and deleted_at is null) then raise exception 'owned active work required'; end if;
      end if;
      insert into public.editions (id, user_id, work_id, title, author, language, progress, location, file_name, file_type, file_size, cover, revision, last_mutation_id, last_device_id, deleted_at)
      values (v_entity_uuid, v_user_id, v_work_id, v_title, nullif(trim(p_payload->>'author'), ''), nullif(trim(p_payload->>'language'), ''),
        coalesce((p_payload->>'progress')::numeric, 0), nullif(p_payload->>'location', ''), nullif(p_payload->>'file_name', ''), nullif(p_payload->>'file_type', ''),
        nullif(p_payload->>'file_size', '')::bigint, nullif(p_payload->>'cover', ''), v_next_revision, p_operation_id, p_device_id, null)
      on conflict (id) do update set work_id = excluded.work_id, title = excluded.title, author = excluded.author, language = excluded.language,
        progress = excluded.progress, location = excluded.location, file_name = excluded.file_name, file_type = excluded.file_type, file_size = excluded.file_size,
        cover = excluded.cover, revision = excluded.revision, last_mutation_id = excluded.last_mutation_id, last_device_id = excluded.last_device_id, deleted_at = null
      where public.editions.user_id = v_user_id;
      v_change_payload := p_payload;
    elsif p_entity_type = 'reading_progress' then
      v_edition_id := coalesce(nullif(p_payload->>'edition_id', '')::uuid, v_entity_uuid);
      if v_edition_id <> v_entity_uuid then raise exception 'progress entity and edition id must match'; end if;
      if not exists (select 1 from public.editions where id = v_edition_id and user_id = v_user_id and deleted_at is null) then raise exception 'owned active edition required'; end if;
      insert into public.reading_progress (edition_id, user_id, progress, location, revision, last_mutation_id, last_device_id, deleted_at)
      values (v_edition_id, v_user_id, coalesce((p_payload->>'progress')::numeric, 0), nullif(p_payload->>'location', ''), v_next_revision, p_operation_id, p_device_id, null)
      on conflict (edition_id) do update set progress = excluded.progress, location = excluded.location, revision = excluded.revision,
        last_mutation_id = excluded.last_mutation_id, last_device_id = excluded.last_device_id, deleted_at = null
      where public.reading_progress.user_id = v_user_id;
      v_change_payload := jsonb_build_object('edition_id', v_edition_id, 'progress', coalesce((p_payload->>'progress')::numeric, 0), 'location', nullif(p_payload->>'location', ''));
    elsif p_entity_type = 'highlight' then
      v_edition_id := (p_payload->>'edition_id')::uuid;
      if not exists (select 1 from public.editions where id = v_edition_id and user_id = v_user_id and deleted_at is null) then raise exception 'owned active edition required'; end if;
      if nullif(p_payload->>'text', '') is null or nullif(p_payload->>'location', '') is null then raise exception 'highlight text and location are required'; end if;
      insert into public.highlights (id, user_id, edition_id, book_id, text, location, note, color, revision, last_mutation_id, last_device_id, deleted_at)
      values (v_entity_uuid, v_user_id, v_edition_id, nullif(p_payload->>'book_id', ''), p_payload->>'text', p_payload->>'location', nullif(p_payload->>'note', ''),
        coalesce(nullif(p_payload->>'color', ''), 'gold'), v_next_revision, p_operation_id, p_device_id, null)
      on conflict (id) do update set edition_id = excluded.edition_id, book_id = excluded.book_id, text = excluded.text, location = excluded.location,
        note = excluded.note, color = excluded.color, revision = excluded.revision, last_mutation_id = excluded.last_mutation_id, last_device_id = excluded.last_device_id, deleted_at = null
      where public.highlights.user_id = v_user_id;
      v_change_payload := p_payload;
    elsif p_entity_type = 'library_item' then
      v_metadata := coalesce(p_payload->'metadata', '{}'::jsonb);
      if jsonb_typeof(v_metadata) <> 'object' then raise exception 'library metadata must be an object'; end if;
      if v_current_revision = 0 then
        if p_payload->>'source_type' = 'platform' and not exists (
          select 1 from public.catalog_editions e
          where e.id = nullif(p_payload->>'catalog_edition_id', '')::uuid
            and e.published_at is not null and e.published_at <= now() and e.withdrawn_at is null
        ) then raise exception 'published platform edition required'; end if;
        insert into public.user_library_items (id, user_id, source_type, catalog_edition_id, local_book_id, external_source, external_record_id, external_url, shelf_status, access_mode, metadata, revision, last_mutation_id, last_device_id, deleted_at)
        values (v_entity_uuid, v_user_id, p_payload->>'source_type', nullif(p_payload->>'catalog_edition_id', '')::uuid, nullif(p_payload->>'local_book_id', ''),
          nullif(p_payload->>'external_source', ''), nullif(p_payload->>'external_record_id', ''), nullif(p_payload->>'external_url', ''),
          coalesce(nullif(p_payload->>'shelf_status', ''), 'want_to_read'), p_payload->>'access_mode', v_metadata, v_next_revision, p_operation_id, p_device_id, null);
      else
        update public.user_library_items set shelf_status = coalesce(nullif(p_payload->>'shelf_status', ''), shelf_status), metadata = v_metadata,
          revision = v_next_revision, last_mutation_id = p_operation_id, last_device_id = p_device_id, deleted_at = null
        where id = v_entity_uuid and user_id = v_user_id;
      end if;
      select jsonb_build_object('shelf_status', shelf_status, 'metadata', metadata) into v_change_payload
      from public.user_library_items where id = v_entity_uuid and user_id = v_user_id;
    else
      v_setting_value := p_payload->'value';
      if v_setting_value is null then raise exception 'setting value is required'; end if;
      insert into public.user_setting_values (user_id, setting_key, value, revision, last_mutation_id, last_device_id, deleted_at)
      values (v_user_id, p_entity_id, v_setting_value, v_next_revision, p_operation_id, p_device_id, null)
      on conflict (user_id, setting_key) do update set value = excluded.value, revision = excluded.revision, last_mutation_id = excluded.last_mutation_id,
        last_device_id = excluded.last_device_id, deleted_at = null, updated_at = now();
      v_change_payload := jsonb_build_object('value', v_setting_value);
    end if;
  else
    if p_entity_type = 'work' then update public.works set revision = v_next_revision, last_mutation_id = p_operation_id, last_device_id = p_device_id, deleted_at = now() where id = v_entity_uuid and user_id = v_user_id;
    elsif p_entity_type = 'edition' then update public.editions set revision = v_next_revision, last_mutation_id = p_operation_id, last_device_id = p_device_id, deleted_at = now() where id = v_entity_uuid and user_id = v_user_id;
    elsif p_entity_type = 'reading_progress' then update public.reading_progress set revision = v_next_revision, last_mutation_id = p_operation_id, last_device_id = p_device_id, deleted_at = now() where edition_id = v_entity_uuid and user_id = v_user_id;
    elsif p_entity_type = 'highlight' then update public.highlights set revision = v_next_revision, last_mutation_id = p_operation_id, last_device_id = p_device_id, deleted_at = now() where id = v_entity_uuid and user_id = v_user_id;
    elsif p_entity_type = 'library_item' then update public.user_library_items set revision = v_next_revision, last_mutation_id = p_operation_id, last_device_id = p_device_id, deleted_at = now() where id = v_entity_uuid and user_id = v_user_id;
    else update public.user_setting_values set revision = v_next_revision, last_mutation_id = p_operation_id, last_device_id = p_device_id, deleted_at = now(), updated_at = now() where user_id = v_user_id and setting_key = p_entity_id;
    end if;
    insert into public.sync_tombstones (user_id, entity_type, entity_id, deleted_revision, mutation_id, device_id)
    values (v_user_id, p_entity_type, p_entity_id, v_next_revision, p_operation_id, p_device_id)
    on conflict (user_id, entity_type, entity_id) do update set deleted_revision = excluded.deleted_revision,
      mutation_id = excluded.mutation_id, device_id = excluded.device_id, deleted_at = now(), purge_after = now() + interval '90 days';
  end if;

  insert into public.sync_changes (user_id, device_id, mutation_id, entity_type, entity_id, operation, entity_revision, payload)
  values (v_user_id, p_device_id, p_operation_id, p_entity_type, p_entity_id, p_operation, v_next_revision, v_change_payload)
  returning * into v_change;
  update public.devices set last_seen_at = now() where id = p_device_id and user_id = v_user_id;
  return query select v_change.sequence, v_change.entity_revision, v_change.operation, true;
end;
$$;

-- Read a bounded, opaque-cursor change feed.  The browser receives only its
-- own sanitized mutation payloads and never an object locator or book bytes.
create or replace function public.pull_metadata_sync_changes(
  p_after_sequence bigint default 0,
  p_limit integer default 100
) returns table (
  sequence bigint,
  device_id uuid,
  operation_id uuid,
  entity_type text,
  entity_id text,
  operation text,
  entity_revision bigint,
  payload jsonb,
  occurred_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_after_sequence is null or p_after_sequence < 0 then raise exception 'invalid sync cursor'; end if;
  if p_limit is null or p_limit not between 1 and 200 then raise exception 'sync page limit must be between 1 and 200'; end if;
  return query
    select c.sequence, c.device_id, c.mutation_id, c.entity_type, c.entity_id, c.operation,
      c.entity_revision, c.payload, c.occurred_at
    from public.sync_changes c
    where c.user_id = auth.uid() and c.sequence > p_after_sequence
    order by c.sequence asc
    limit p_limit;
end;
$$;

revoke all on function public.controlled_sync_payload_has_forbidden_key(jsonb) from public, anon, authenticated;
revoke all on function public.assert_controlled_sync_payload(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.apply_metadata_sync_change(uuid, uuid, text, text, text, bigint, jsonb) from public, anon;
revoke all on function public.pull_metadata_sync_changes(bigint, integer) from public, anon;
grant execute on function public.apply_metadata_sync_change(uuid, uuid, text, text, text, bigint, jsonb) to authenticated;
grant execute on function public.pull_metadata_sync_changes(bigint, integer) to authenticated;
