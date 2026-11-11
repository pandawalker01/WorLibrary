-- Narrow owner-only status projection. No object locations, hashes or bytes.
create function public.list_private_file_cleanup_jobs()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_user_id uuid := public.require_private_file_account();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('manifestId', m.id, 'editionId', m.edition_id,
    'fileName', m.file_name) order by m.delete_requested_at, m.id)
    from public.user_file_manifests m where m.user_id = v_user_id and m.upload_state = 'deleting'), '[]'::jsonb);
end;
$$;
revoke all on function public.list_private_file_cleanup_jobs() from public, anon, authenticated, service_role;
grant execute on function public.list_private_file_cleanup_jobs() to authenticated;
