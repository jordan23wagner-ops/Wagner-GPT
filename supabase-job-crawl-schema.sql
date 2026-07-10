-- Wagner-GPT — Jobs tab crawl cache (OPTIONAL).
-- The Jobs tab works fully without this: api/jobs.js falls back to live-fetching every company's
-- ATS board on every search when this table is missing or empty for the requested industry. Running
-- this schema, then letting the api/jobs-crawl.js Vercel Cron populate it, just makes searches
-- faster by reading pre-crawled results instead of re-downloading every board each time.
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run.

create table if not exists job_crawl_cache (
  url text primary key,
  source text not null default '',
  industry text not null,
  title text not null,
  company text not null,
  location text not null default '',
  salary_min numeric,
  salary_max numeric,
  category text not null default '',
  category_tag text not null default '',
  contract_time text not null default '',
  description text not null default '',
  created text not null default '',
  crawled_at timestamptz not null default now()
);

-- The search handler's cache lookup filters by industry; a periodic cleanup (not automated here,
-- run manually if the table grows large) would filter by crawled_at.
create index if not exists job_crawl_cache_industry_idx on job_crawl_cache (industry);
create index if not exists job_crawl_cache_crawled_at_idx on job_crawl_cache (crawled_at);

-- Permissive RLS (single-user personal app), same convention as the other tables.
alter table job_crawl_cache enable row level security;
create policy "allow_all_job_crawl_cache" on job_crawl_cache
  for all using (true) with check (true);
