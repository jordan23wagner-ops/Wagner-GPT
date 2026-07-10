-- Wagner-GPT — ATS board registry (OPTIONAL).
-- Populated by api/jobs-import.js, a batched pipeline that bulk-imports company ATS-board candidates
-- from a public dataset (see README's "Bulk board import" section for the source + license), validates
-- each one live against the real ATS API (the same fetchGreenhouse/fetchLever/fetchAshby/fetchWorkday
-- functions api/jobs.js already uses for search), and classifies survivors into one of the app's
-- industries with a Groq call. api/jobs-crawl.js reads classified rows from here and adds them to each
-- industry's crawl list alongside the hand-curated INDUSTRY_BOARDS seed -- this is how the Jobs tab's
-- company-board coverage grows past a hand-typed list without editing code for every new company.
-- Run in: Supabase Dashboard → SQL Editor → New query → paste → Run.

create table if not exists ats_board_registry (
  -- greenhouse/lever/ashby: "{ats}:{slug}". workday: "workday:{tenant}:{data_center}:{site}" (a plain
  -- slug isn't a unique identifier for Workday -- see WORKDAY_URL_RE in api/jobs.js).
  id text primary key,
  ats text not null,
  slug text,                                    -- null for workday
  tenant text, data_center text, site text,     -- workday only
  company_name text not null default '',        -- from validated job data (Ashby's own org name when available, else slug-derived title-case)
  sample_titles text not null default '',       -- a few real job titles from validation, comma-joined -- classify's only real signal beyond company_name, since re-fetching at classify time would double the live-request load for no benefit
  industry text,                                 -- one of the app's INDUSTRY_BOARDS keys; null until classified
  status text not null default 'candidate',     -- candidate -> validated | dead -> classified
  job_count int not null default 0,              -- live job count from the last validation, a freshness/sanity signal
  source text not null default 'import',         -- 'import' (bulk dataset) | 'bootstrap' (future: self-discovered from live search results)
  checked_at timestamptz,
  created_at timestamptz not null default now()
);

-- jobs-crawl.js's per-industry lookup filters by (status, industry); the import pipeline's resume
-- logic filters by status alone (e.g. "next unclassified batch").
create index if not exists ats_board_registry_status_industry_idx on ats_board_registry (status, industry);

-- Permissive RLS (single-user personal app), same convention as the other tables.
alter table ats_board_registry enable row level security;
create policy "allow_all_ats_board_registry" on ats_board_registry
  for all using (true) with check (true);
