-- Editable account profile and private avatar-object foundation.
--
-- Login email deliberately remains in auth.users and is never copied into
-- this table. `display_name`, `bio` and the private-bucket object reference
-- are the only browser-editable profile fields. Staff roles remain in the
-- server-only account_role_assignments table from 0010.

alter table public.profiles
  add column if not exists bio text,
  add column if not exists avatar_path text,
  add column if not exists is_public boolean not null default false;

alter table public.profiles
  drop constraint if exists profiles_display_name_safe,
  add constraint profiles_display_name_safe check (
    display_name is null or (
      char_length(btrim(display_name)) between 1 and 80
      and display_name !~ '[[:cntrl:]]'
    )
  ),
  drop constraint if exists profiles_bio_safe,
  add constraint profiles_bio_safe check (
    bio is null or (char_length(btrim(bio)) <= 500 and bio !~ '[[:cntrl:]]')
  ),
  drop constraint if exists profiles_avatar_path_safe,
  add constraint profiles_avatar_path_safe check (
    avatar_path is null or avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/avatar/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpe?g|webp)$'
  );

-- A profile avatar is private by default. Public profile avatars can be read
-- only when the owner explicitly enables a public profile and points to that
-- exact object. It is not a general-purpose user-file bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-avatars',
  'profile-avatars',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Normalize user-controlled profile text and make an avatar reference valid
-- only when it points to an owned, allowed image object. This trigger never
-- accepts an email or an arbitrary other-account storage path.
create or replace function public.validate_account_profile()
returns trigger
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_mime_type text;
  v_size_text text;
  v_size bigint;
begin
  new.display_name := nullif(btrim(coalesce(new.display_name, '')), '');
  new.bio := nullif(btrim(coalesce(new.bio, '')), '');

  if tg_op = 'UPDATE' and new.is_anonymous is distinct from old.is_anonymous then
    raise exception 'anonymous account state is server-owned';
  end if;

  if new.is_anonymous and new.is_public then
    raise exception 'anonymous accounts cannot publish a profile';
  end if;

  if new.avatar_path is null then
    return new;
  end if;

  if new.avatar_path !~ ('^' || new.id::text || '/avatar/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(png|jpe?g|webp)$') then
    raise exception 'avatar path must belong to the profile owner';
  end if;

  select o.metadata ->> 'mimetype', o.metadata ->> 'size'
    into v_mime_type, v_size_text
  from storage.objects o
  where o.bucket_id = 'profile-avatars'
    and o.name = new.avatar_path
    and o.owner_id = new.id;

  if not found then
    raise exception 'owned avatar object is required before saving its reference';
  end if;
  if v_mime_type not in ('image/jpeg', 'image/png', 'image/webp') then
    raise exception 'avatar object must be a supported image';
  end if;
  if v_size_text !~ '^[0-9]+$' then
    raise exception 'avatar object size metadata is invalid';
  end if;
  v_size := v_size_text::bigint;
  if v_size < 1 or v_size > 5242880 then
    raise exception 'avatar object exceeds the 5 MiB limit';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_validate_account_profile on public.profiles;
create trigger profiles_validate_account_profile
  before insert or update on public.profiles
  for each row execute function public.validate_account_profile();

-- Replace the original broad profile policy with private ownership plus a
-- minimal read-only public projection. Updates are still owner-only, and the
-- validation trigger protects immutable server-owned fields and avatar links.
drop policy if exists "own profile" on public.profiles;
drop policy if exists "read own profile" on public.profiles;
drop policy if exists "write own profile" on public.profiles;
drop policy if exists "read published profile" on public.profiles;

create policy "read own profile" on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy "read published profile" on public.profiles
  for select to anon, authenticated
  using (is_public = true and is_anonymous = false);

create policy "write own profile" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "profile avatar owner read" on storage.objects;
drop policy if exists "profile avatar owner insert" on storage.objects;
drop policy if exists "profile avatar owner update" on storage.objects;
drop policy if exists "profile avatar owner delete" on storage.objects;
drop policy if exists "published profile avatar read" on storage.objects;

create policy "profile avatar owner read" on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid());

create policy "profile avatar owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-avatars'
    and owner_id = auth.uid()
    and name ~ ('^' || auth.uid()::text || '/avatar/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(png|jpe?g|webp)$')
  );

create policy "profile avatar owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid())
  with check (
    bucket_id = 'profile-avatars'
    and owner_id = auth.uid()
    and name ~ ('^' || auth.uid()::text || '/avatar/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(png|jpe?g|webp)$')
  );

create policy "profile avatar owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-avatars' and owner_id = auth.uid());

create policy "published profile avatar read" on storage.objects
  for select to anon, authenticated
  using (
    bucket_id = 'profile-avatars'
    and exists (
      select 1 from public.profiles p
      where p.id = storage.objects.owner_id
        and p.is_public = true
        and p.is_anonymous = false
        and p.avatar_path = storage.objects.name
    )
  );

grant select, update on public.profiles to authenticated;
revoke insert, delete on public.profiles from authenticated, anon;

-- Boundary: this migration only creates Storage policy and metadata checks.
-- The browser must not claim an avatar was saved until a later dedicated
-- upload API has uploaded a validated image into profile-avatars and this
-- profile row has successfully referenced that exact owned object.
