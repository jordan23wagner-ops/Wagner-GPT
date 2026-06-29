-- Wagner-GPT Supabase schema.
-- Run this in: Supabase Dashboard → SQL Editor → New query → paste → Run.

-- Conversations (chat history)
create table if not exists conversations (
  id bigint primary key,
  title text not null default 'New chat',
  messages jsonb not null default '[]'::jsonb,
  created_at bigint not null default 0,
  updated_at bigint not null default 0
);

-- Garden state (singleton row, id always 1)
create table if not exists garden_state (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0
);

-- Enable RLS with permissive policies (single-user personal app).
alter table conversations enable row level security;
create policy "allow_all_conversations" on conversations
  for all using (true) with check (true);

alter table garden_state enable row level security;
create policy "allow_all_garden" on garden_state
  for all using (true) with check (true);
