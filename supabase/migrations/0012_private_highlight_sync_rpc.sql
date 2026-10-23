-- Private highlight sync is deliberately narrower than the general metadata
-- mutation RPC.  A browser can submit only one excerpt record for its own
-- active device; it cannot smuggle an original book, cover, object locator,
-- file metadata, or an arbitrary JSON extension through this endpoint.

alter table public.highlights
  add column if not exists is_highlighted boolean not null default true;

create or replace function public.apply_private_highlight_sync_change(
  p_device_id uuid,
  p_operation_id uuid,
  p_highlight_id uuid,
  p_operation text,
  p_base_revision bigint,
  p_edition_id uuid default null,
  p_text text default null,
  p_location text default null,
  p_note text default null,
  p_color text default null,
  p_is_highlighted boolean default null
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
  v_color text;
  v_payload jsonb;
  v_sequence bigint;
  v_entity_revision bigint;
  v_applied boolean;
begin
  if v_user_id is null then
    raise exception 'authentication required';
  end if;
  if p_device_id is null or p_operation_id is null or p_highlight_id is null then
    raise exception 'device id, operation id, and highlight id are required';
  end if;
  if p_operation not in ('upsert', 'delete') then
    raise exception 'invalid highlight operation';
  end if;
  if p_base_revision is null or p_base_revision < 0 then
    raise exception 'base revision must be non-negative';
  end if;

  -- Check before constructing any payload.  `apply_metadata_sync_change`
  -- repeats this ownership check transactionally, so a revoked device cannot
  -- race between this wrapper and the durable write.
  if not exists (
    select 1 from public.devices
    where id = p_device_id and user_id = v_user_id and revoked_at is null
  ) then
    raise exception 'active owned device required';
  end if;

  if p_operation = 'delete' then
    if p_edition_id is not null or p_text is not null
       or p_location is not null or p_note is not null or p_color is not null
       or p_is_highlighted is not null then
      raise exception 'highlight delete cannot contain a payload';
    end if;
    return query select * from public.apply_metadata_sync_change(
      p_device_id, p_operation_id, 'highlight', p_highlight_id::text,
      'delete', p_base_revision, '{}'::jsonb
    );
    return;
  end if;

  if p_edition_id is null or nullif(trim(p_text), '') is null
     or nullif(trim(p_location), '') is null or p_is_highlighted is null then
    raise exception 'highlight edition, text, location, and display state are required';
  end if;
  if char_length(p_text) > 32768 then
    raise exception 'highlight text exceeds excerpt limit';
  end if;
  if char_length(p_location) > 4096 then
    raise exception 'highlight location exceeds limit';
  end if;
  if p_note is not null and char_length(p_note) > 16384 then
    raise exception 'highlight note exceeds limit';
  end if;
  v_color := coalesce(nullif(trim(p_color), ''), 'gold');
  if v_color not in ('gold', 'rose', 'blue') then
    raise exception 'invalid highlight color';
  end if;

  -- This is the complete payload whitelist.  Do not add a generic metadata
  -- field here: highlight text is the only user text replicated by design.
  -- The existing generic RPC owns revisions/tombstones and has no display
  -- state field, so its known-safe subset is applied first and this wrapper
  -- atomically adds the boolean to both the row and durable change payload.
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'edition_id', p_edition_id,
    'text', p_text,
    'location', p_location,
    'note', nullif(p_note, ''),
    'color', v_color,
    'is_highlighted', p_is_highlighted
  ));

  select applied_change.sequence, applied_change.entity_revision, applied_change.applied
    into v_sequence, v_entity_revision, v_applied
  from public.apply_metadata_sync_change(
    p_device_id, p_operation_id, 'highlight', p_highlight_id::text,
    'upsert', p_base_revision, v_payload - 'is_highlighted'
  ) as applied_change;
  if v_applied then
    update public.highlights
      set is_highlighted = p_is_highlighted
      where id = p_highlight_id and user_id = v_user_id;
    update public.sync_changes
      set payload = v_payload
      where user_id = v_user_id and mutation_id = p_operation_id;
  end if;
  return query select v_sequence, v_entity_revision, 'upsert'::text, v_applied;
end;
$$;

revoke all on function public.apply_private_highlight_sync_change(uuid, uuid, uuid, text, bigint, uuid, text, text, text, text, boolean)
  from public, anon;
grant execute on function public.apply_private_highlight_sync_change(uuid, uuid, uuid, text, bigint, uuid, text, text, text, text, boolean)
  to authenticated;
