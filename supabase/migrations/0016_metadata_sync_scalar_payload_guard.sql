-- JSON metadata leaves are ordinary scalar values. The previous recursive
-- guard handled objects and arrays but raised CASE_NOT_FOUND on scalar leaves.
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
    else
      return false;
  end case;
  return false;
end;
$$;
