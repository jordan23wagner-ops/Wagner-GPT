-- Wagner-GPT shareable links (Phase 7).
-- Run in: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- Stores a read-only snapshot of a conversation under an unguessable id (the share
-- slug, generated client-side). Anyone with the link can view it; the long random id
-- is the access token.

create table if not exists shared_chats (
  id text primary key,
  title text default 'Shared chat',
  messages jsonb not null default '[]'::jsonb,
  created_at bigint not null default 0
);

alter table shared_chats enable row level security;
create policy "allow_all_shared" on shared_chats for all using (true) with check (true);
