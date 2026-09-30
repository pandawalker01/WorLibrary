-- Production hardening. This migration is intentionally additive and safe to
-- run after 0001 in a fresh or existing Supabase project.

create index if not exists editions_user_updated_idx on public.editions (user_id, updated_at desc);
create index if not exists works_user_updated_idx on public.works (user_id, updated_at desc);
create index if not exists highlights_user_created_idx on public.highlights (user_id, created_at desc);
create index if not exists progress_user_updated_idx on public.reading_progress (user_id, updated_at desc);
create index if not exists devices_user_seen_idx on public.devices (user_id, last_seen_at desc);

-- A client can only address rows belonging to its own JWT subject. Explicit
-- grants keep the PostgREST surface least-privilege if project defaults change.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.devices, public.works,
  public.editions, public.reading_progress, public.highlights, public.user_settings to authenticated;
revoke all on public.profiles, public.devices, public.works, public.editions,
  public.reading_progress, public.highlights, public.user_settings from anon;

-- Keep progress and settings timestamps correct even when clients send an
-- explicit timestamp during offline reconciliation.
create or replace function public.set_updated_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Prevent an authenticated user from attaching a row to another user's work.
drop policy if exists "own editions" on public.editions;
create policy "own editions" on public.editions for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and (work_id is null or exists (
    select 1 from public.works w where w.id = work_id and w.user_id = auth.uid()
  )));

drop policy if exists "own progress" on public.reading_progress;
create policy "own progress" on public.reading_progress for all
  using (user_id = auth.uid() and exists (
    select 1 from public.editions e where e.id = edition_id and e.user_id = auth.uid()
  ))
  with check (user_id = auth.uid() and exists (
    select 1 from public.editions e where e.id = edition_id and e.user_id = auth.uid()
  ));

drop policy if exists "own highlights" on public.highlights;
create policy "own highlights" on public.highlights for all
  using (user_id = auth.uid() and (edition_id is null or exists (
    select 1 from public.editions e where e.id = edition_id and e.user_id = auth.uid()
  )))
  with check (user_id = auth.uid() and (edition_id is null or exists (
    select 1 from public.editions e where e.id = edition_id and e.user_id = auth.uid()
  )));
