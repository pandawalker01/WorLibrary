create extension if not exists "pgcrypto";

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  name text, last_seen_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table if not exists public.works (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  title text not null, author text, metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.editions (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  work_id uuid references public.works(id) on delete cascade, title text not null, author text,
  language text, progress numeric not null default 0 check (progress >= 0 and progress <= 100), location text,
  file_name text, file_type text, file_size bigint, cover text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.reading_progress (
  edition_id uuid primary key references public.editions(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade,
  progress numeric not null default 0 check (progress >= 0 and progress <= 100), location text, updated_at timestamptz not null default now()
);
create table if not exists public.highlights (
  id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  edition_id uuid references public.editions(id) on delete cascade, book_id text, text text not null, location text not null,
  note text, color text not null default 'gold', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade, settings jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger works_updated_at before update on public.works for each row execute function public.set_updated_at();
create trigger editions_updated_at before update on public.editions for each row execute function public.set_updated_at();
create trigger progress_updated_at before update on public.reading_progress for each row execute function public.set_updated_at();
create trigger highlights_updated_at before update on public.highlights for each row execute function public.set_updated_at();
create trigger settings_updated_at before update on public.user_settings for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.devices enable row level security;
alter table public.works enable row level security;
alter table public.editions enable row level security;
alter table public.reading_progress enable row level security;
alter table public.highlights enable row level security;
alter table public.user_settings enable row level security;

create policy "own profile" on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy "own devices" on public.devices for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own works" on public.works for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own editions" on public.editions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own progress" on public.reading_progress for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own highlights" on public.highlights for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own settings" on public.user_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin insert into public.profiles (id, is_anonymous) values (new.id, coalesce((new.raw_app_meta_data->>'is_anonymous')::boolean, false)) on conflict (id) do nothing; return new; end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
