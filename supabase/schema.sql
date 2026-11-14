-- Longevity Plate — database schema. Run once in Supabase → SQL Editor.

-- One JSON document per path, mirroring the app's document store.
create table if not exists public.docs (
  path        text primary key,
  parent      text not null,
  owner       uuid default auth.uid() references auth.users on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);
create index if not exists docs_parent_idx on public.docs (parent);
alter table public.docs enable row level security;

-- People who can see the owner tools (community statistics).
create table if not exists public.admins (user_id uuid primary key references auth.users on delete cascade);
alter table public.admins enable row level security;
drop policy if exists "admins see themselves" on public.admins;
create policy "admins see themselves" on public.admins for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

-- AI usage counter (written only by the Edge Function with the service key).
create table if not exists public.ai_usage (
  user_id uuid references auth.users on delete cascade,
  day     date not null,
  calls   int  not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;

-- Rules ---------------------------------------------------------------
-- 1. Each person's profile, reports and meals: only that person.
drop policy if exists "own data" on public.docs;
create policy "own data" on public.docs for all to authenticated
  using      (path like 'data/users/' || auth.uid()::text || '/%')
  with check (path like 'data/users/' || auth.uid()::text || '/%');

-- 2. Anonymous research: each person writes their own row; only admins read all rows.
drop policy if exists "research own" on public.docs;
create policy "research own" on public.docs for all to authenticated
  using      (path = 'research/' || auth.uid()::text)
  with check (path = 'research/' || auth.uid()::text);
drop policy if exists "research admin read" on public.docs;
create policy "research admin read" on public.docs for select to authenticated
  using (path like 'research/%' and public.is_admin());

-- 3. Community statistics: everyone signed in reads, admins write.
drop policy if exists "insights read" on public.docs;
create policy "insights read" on public.docs for select to authenticated using (path like 'insights/%');
drop policy if exists "insights write" on public.docs;
create policy "insights write" on public.docs for all to authenticated
  using (path like 'insights/%' and public.is_admin()) with check (path like 'insights/%' and public.is_admin());

-- 4. Cached interface translations: anyone reads, signed in people write.
drop policy if exists "i18n read" on public.docs;
create policy "i18n read" on public.docs for select to anon, authenticated using (path like 'i18n/%');
drop policy if exists "i18n write" on public.docs;
create policy "i18n write" on public.docs for insert to authenticated with check (path like 'i18n/%');
drop policy if exists "i18n update" on public.docs;
create policy "i18n update" on public.docs for update to authenticated using (path like 'i18n/%') with check (path like 'i18n/%');

-- After you sign in once, make yourself admin (replace the email):
-- insert into public.admins (user_id) select id from auth.users where email = 'you@example.com';
