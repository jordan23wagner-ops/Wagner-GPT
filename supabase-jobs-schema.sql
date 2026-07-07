-- Wagner-GPT — Jobs tab schema (OPTIONAL).
-- The Jobs tab works fully on localStorage without this. Run this only if you want the
-- résumé bank, application tracker, and contact/EEO profile to sync across devices.
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run.

-- Single JSON blob holding { resumes, tracked, profile } (singleton row, id always 1),
-- matching the garden_state pattern.
create table if not exists job_data (
  id int primary key default 1,
  data jsonb not null default '{}'::jsonb,
  updated_at bigint not null default 0
);

-- Permissive RLS (single-user personal app), same convention as the other tables.
alter table job_data enable row level security;
create policy "allow_all_job_data" on job_data
  for all using (true) with check (true);
