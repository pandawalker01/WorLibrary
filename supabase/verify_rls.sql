-- Run this in the Supabase SQL editor after applying migrations.
-- It checks schema/policy presence; cross-user behavior is covered in docs/supabase-staging.md.
do $$
declare
  required_table text;
  required_tables constant text[] := array['profiles', 'devices', 'works', 'editions', 'reading_progress', 'highlights', 'user_settings'];
begin
  foreach required_table in array required_tables loop
    if to_regclass('public.' || required_table) is null then
      raise exception 'missing table public.%', required_table;
    end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'editions' and policyname = 'own editions') then
    raise exception 'missing RLS policy own editions';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'highlights' and policyname = 'own highlights') then
    raise exception 'missing RLS policy own highlights';
  end if;
end;
$$;

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles', 'devices', 'works', 'editions', 'reading_progress', 'highlights', 'user_settings')
order by tablename;
