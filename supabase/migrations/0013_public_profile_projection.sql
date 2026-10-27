-- Public community identity is projected away from private account profiles.
-- Authentication ids, email, roles, devices and reading data never receive a
-- browser-readable grant through this table.

alter table public.profiles
  add column if not exists public_id uuid not null default gen_random_uuid();

create unique index if not exists profiles_public_id_unique
  on public.profiles (public_id);

alter table public.profiles
  drop constraint if exists profiles_public_requires_name,
  add constraint profiles_public_requires_name check (
    is_public = false or display_name is not null
  );

create table if not exists public.public_profiles (
  public_id uuid primary key,
  owner_id uuid not null unique references public.profiles(id) on delete cascade,
  display_name text not null,
  bio text,
  has_avatar boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint public_profiles_display_name_safe check (
    char_length(btrim(display_name)) between 1 and 80
    and display_name !~ '[[:cntrl:]]'
  ),
  constraint public_profiles_bio_safe check (
    bio is null or (char_length(btrim(bio)) <= 500 and bio !~ '[[:cntrl:]]')
  )
);

alter table public.public_profiles enable row level security;

create or replace function public.sync_public_profile_projection()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.is_public = true and new.is_anonymous = false and new.display_name is not null then
    insert into public.public_profiles (
      public_id, owner_id, display_name, bio, has_avatar, updated_at
    ) values (
      new.public_id, new.id, new.display_name, new.bio,
      new.avatar_path is not null, now()
    )
    on conflict (owner_id) do update set
      public_id = excluded.public_id,
      display_name = excluded.display_name,
      bio = excluded.bio,
      has_avatar = excluded.has_avatar,
      updated_at = excluded.updated_at;
  else
    delete from public.public_profiles where owner_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_sync_public_projection on public.profiles;
create trigger profiles_sync_public_projection
  after insert or update of display_name, bio, avatar_path, is_public, is_anonymous
  on public.profiles
  for each row execute function public.sync_public_profile_projection();

insert into public.public_profiles (
  public_id, owner_id, display_name, bio, has_avatar, updated_at
)
select public_id, id, display_name, bio, avatar_path is not null, now()
from public.profiles
where is_public = true and is_anonymous = false and display_name is not null
on conflict (owner_id) do update set
  public_id = excluded.public_id,
  display_name = excluded.display_name,
  bio = excluded.bio,
  has_avatar = excluded.has_avatar,
  updated_at = excluded.updated_at;

-- Private profiles are owner-readable only. Public clients receive only the
-- explicitly granted projection columns, never owner_id/auth.uid().
drop policy if exists "read published profile" on public.profiles;
drop policy if exists "read public profile projection" on public.public_profiles;
create policy "read public profile projection" on public.public_profiles
  for select to anon, authenticated
  using (true);

revoke all on table public.public_profiles from public, anon, authenticated;
grant select (public_id, display_name, bio, has_avatar, updated_at)
  on public.public_profiles to anon, authenticated;

-- A private Storage path embeds the owner id and must not become a public URL.
-- A later authenticated media gateway may serve a validated avatar by the
-- opaque public_id; until then public pages expose only has_avatar.
drop policy if exists "published profile avatar read" on storage.objects;

revoke all on function public.sync_public_profile_projection() from public, anon, authenticated;

