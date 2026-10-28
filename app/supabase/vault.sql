-- open-eyes Browser sync: one encrypted vault per user. The app encrypts spaces and sessions
-- with a key from the user's sync passphrase before uploading, so these columns hold only
-- the salt (not secret) and ciphertext. Run once in the Supabase SQL editor.

create table if not exists public.vaults (
  user_id uuid primary key references auth.users (id) on delete cascade,
  salt text not null,
  iv text not null,
  tag text not null,
  data text not null check (length(data) <= 8 * 1024 * 1024),
  -- Raised by every upload; an upload made from an older version is refused, never merged.
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.vaults enable row level security;

-- Each user reaches only their own vault; nobody else's, whatever key the app ships with.
create policy "read own vault" on public.vaults for select to authenticated using ((select auth.uid()) = user_id);
create policy "create own vault" on public.vaults for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update own vault" on public.vaults for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "delete own vault" on public.vaults for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.vaults from anon;
