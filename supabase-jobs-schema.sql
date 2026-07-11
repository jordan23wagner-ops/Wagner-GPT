-- Wagner-GPT — Jobs tab schema (OPTIONAL).
-- The Jobs tab works fully on localStorage without this. Run this only if you want the
-- résumé bank, application tracker, and contact/EEO profile to sync across devices.
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run.

-- One JSON blob row PER PERSON holding { resumes, tracked, profile, memory, target }, matching
-- the garden_state pattern. Row id 1 = Jordan (the original pre-switcher row, so his data is
-- untouched), row id 2 = Alicia. Rows are created on first sync via upsert — no seed needed.
create table if not exists job_data (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0
);

-- Permissive RLS (single-user personal app), same convention as the other tables.
alter table job_data enable row level security;
create policy "allow_all_job_data" on job_data
  for all using (true) with check (true);
