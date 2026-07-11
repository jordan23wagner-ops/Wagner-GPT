// Wagner-GPT jobs proxy — multi-source job search.
//
// Backs the Job-Assistant extension's Job Search AND the Wagner-GPT "Jobs" tab. Aggregates jobs
// from several sources and returns ONE unified result shape so callers stay source-agnostic:
//   1. Adzuna              — broad aggregator (needs ADZUNA_APP_ID / ADZUNA_APP_KEY).
//   2. Company ATS boards  — public JSON from Greenhouse / Lever / Ashby / Workable / SmartRecruiters
//                            / Recruitee / Workday career pages, selected per industry from
//                            INDUSTRY_BOARDS (this is the "jobs from company sites in your industry"
//                            ask — these ARE the companies' own career sites, just via their public
//                            JSON endpoints). Workday in particular is how most large enterprises
//                            (the companies too big to be on a startup-oriented ATS) run their job
//                            boards — see fetchWorkday.
//   3. Discovery (opt)     — Brave/Tavily search "{query} careers" (no longer scoped to specific ATS
//                            platforms) to find more boards AND, from the SAME result set, genuinely
//                            custom company career pages with no public API at all (a real
//                            "CompanyName.com/careers" with no known ATS behind it) — those go
//                            through fetchCustomCareerPage (Jina reader + one Groq extraction call)
//                            instead of a structured fetcher. Uses BRAVE_KEY/TAVILY_KEY (discovery)
//                            and GROQ_KEY (custom-page extraction) if present; silently skipped
//                            otherwise.
//   4. JSearch + Himalayas — direct-apply aggregators (JSearch needs a RapidAPI key).
//   5. The Muse            — free, no key: broad recent listings (themuse.com).
//   6. Jooble               — free API key (JOOBLE_KEY): global aggregator.
//   7. Careerjet            — free affiliate id (CAREERJET_AFFID): global aggregator.
//   8. Reed                 — free API key (REED_API_KEY): UK jobs only, only called for country:'gb'.
//   9. USAJobs              — free API key + registered email (USAJOBS_API_KEY + USAJOBS_EMAIL): US
//                            federal jobs only, only called for country:'us'. Treated as a DIRECT
//                            source (it's the government's own official board), not an aggregator.
//   Sources 6-9 are all silently skipped (empty results, no error) when their env var isn't set --
//   none of them require signing up to get the other sources working.
//
// POST { action:'search', titles|what, industry, where, salaryMin, salaryMax, remote, fullTime,
//        country, resultsPerPage, category, page } -> { results:[...], count, sources:{...} }
// POST { action:'categories', country }                  -> { categories:[{ tag, label }] }
//
// Result item: { id, title, company, location, salaryMin, salaryMax, salaryPredicted, url,
//                category, categoryTag, contractTime, description, created, source }

export const config = { maxDuration: 60 }

const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs'

// ── Supabase-backed crawl cache (item #3 of the roadmap) ────────────────────────────────────────
// Same project/anon-key + permissive-RLS convention as src/lib/supabase.js and job_data (see
// supabase-job-crawl-schema.sql) -- the anon key is publishable by design, RLS is what governs
// access, and it's already committed in the frontend bundle, so reusing it here server-side adds no
// new exposure. Raw REST (PostgREST) via fetch rather than the @supabase/supabase-js SDK, matching
// this file's existing all-fetch style and keeping it trivially mockable in jobs.test.mjs.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mfzzcrsgslkpvzvtveao.supabase.co'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7-pjVrDnXLzAAjxXawBpWw_mCVTSR-Z'

// Cache-hit path for the search handler: read pre-crawled ATS-board jobs for an industry instead of
// live-fetching every company's board on every request. Returns null (not []) on ANY failure --
// table doesn't exist yet (schema not run), industry never crawled, or the request itself failed --
// so the caller can tell "no cached data, fall back to live" apart from "cached data, but empty",
// which never regresses search results below today's always-live behavior.
// A falsy `industry` means "All Industries" -- read the freshest crawled jobs across every industry
// (capped) instead of one. This is what makes the "All Industries" search sweep every field at once.
async function fetchBoardsFromCache(industry) {
  try {
    const q = industry
      ? `industry=eq.${encodeURIComponent(industry)}&select=*`
      : `select=*&order=created.desc&limit=1000`
    const r = await fetch(`${SUPABASE_URL}/rest/v1/job_crawl_cache?${q}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return null
    const rows = await r.json()
    if (!Array.isArray(rows) || !rows.length) return null
    return rows.map((row) => ({
      id: 'cache_' + Buffer.from(String(row.url)).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24),
      title: row.title || '', company: row.company || '', location: row.location || '',
      salaryMin: row.salary_min || null, salaryMax: row.salary_max || null, salaryPredicted: false,
      url: row.url || '', category: row.category || '', categoryTag: row.category_tag || '',
      contractTime: row.contract_time || '', description: row.description || '', created: row.created || '',
      source: row.source || 'ats',
    })).filter((j) => j.url)
  } catch { return null }
}

// Write path, used by api/jobs-crawl.js's scheduled crawl (not called from the search handler
// itself). Upserts on the url primary key (see supabase-job-crawl-schema.sql) so re-crawling the
// same posting updates it in place instead of accumulating duplicates.
export async function upsertCrawlCache(industry, jobs) {
  if (!jobs || !jobs.length) return { ok: true, count: 0 }
  const rows = jobs.slice(0, 500).map((j) => ({
    url: j.url, source: j.source || '', industry, title: j.title || '', company: j.company || '',
    location: j.location || '', salary_min: j.salaryMin || null, salary_max: j.salaryMax || null,
    category: j.category || '', category_tag: j.categoryTag || '', contract_time: j.contractTime || '',
    description: (j.description || '').slice(0, 2000), created: j.created || '',
    crawled_at: new Date().toISOString(),
  }))
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/job_crawl_cache`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(15000),
    })
    return { ok: r.ok, count: r.ok ? rows.length : 0 }
  } catch { return { ok: false, count: 0 } }
}

// ── Curated company ATS boards per industry ─────────────────────────────────────────────────────
// industry name (matches the client's INDUSTRIES labels) -> [{ ats, slug, name }] (or, for workday
// specifically, [{ ats:'workday', tenant, dataCenter, site, name }] — Workday has no single universal
// slug the way Greenhouse/Lever do, so a tenant is identified by all three together; discovery
// extracts them straight out of a found myworkdayjobs.com URL, see WORKDAY_URL_RE below).
// ats is one of: greenhouse | lever | ashby | workable | smartrecruiters | recruitee | workday.
// slug is the company's board id on that ATS. Seed set of well-known companies; extend freely —
// adding a row here immediately widens coverage.
export const INDUSTRY_BOARDS = {
  'Software / IT': [
    { ats: 'greenhouse', slug: 'stripe', name: 'Stripe' },
    { ats: 'greenhouse', slug: 'databricks', name: 'Databricks' },
    { ats: 'greenhouse', slug: 'dropbox', name: 'Dropbox' },
    { ats: 'greenhouse', slug: 'gitlab', name: 'GitLab' },
    { ats: 'greenhouse', slug: 'cloudflare', name: 'Cloudflare' },
    { ats: 'greenhouse', slug: 'asana', name: 'Asana' },
    { ats: 'greenhouse', slug: 'twilio', name: 'Twilio' },
    { ats: 'greenhouse', slug: 'samsara', name: 'Samsara' },
    { ats: 'lever', slug: 'netflix', name: 'Netflix' },
    { ats: 'ashby', slug: 'ramp', name: 'Ramp' },
    { ats: 'ashby', slug: 'linear', name: 'Linear' },
    { ats: 'ashby', slug: 'notion', name: 'Notion' },
    { ats: 'ashby', slug: 'vercel', name: 'Vercel' },
    { ats: 'smartrecruiters', slug: 'Square', name: 'Block (Square)' },
    { ats: 'smartrecruiters', slug: 'Visa', name: 'Visa' },
  ],
  'Cybersecurity': [
    { ats: 'greenhouse', slug: 'cloudflare', name: 'Cloudflare' },
    { ats: 'greenhouse', slug: 'crowdstrike', name: 'CrowdStrike' },
    { ats: 'greenhouse', slug: 'okta', name: 'Okta' },
    { ats: 'greenhouse', slug: 'snyk', name: 'Snyk' },
    { ats: 'greenhouse', slug: 'hashicorp', name: 'HashiCorp' },
    { ats: 'greenhouse', slug: 'sentinelone', name: 'SentinelOne' },
    { ats: 'lever', slug: 'tenable', name: 'Tenable' },
    { ats: 'ashby', slug: 'wiz', name: 'Wiz' },
    { ats: 'ashby', slug: 'abnormal', name: 'Abnormal Security' },
  ],
  'AI / Machine Learning': [
    { ats: 'greenhouse', slug: 'databricks', name: 'Databricks' },
    { ats: 'greenhouse', slug: 'anthropic', name: 'Anthropic' },
    { ats: 'greenhouse', slug: 'runwayml', name: 'Runway' },
    { ats: 'ashby', slug: 'openai', name: 'OpenAI' },
    { ats: 'ashby', slug: 'huggingface', name: 'Hugging Face' },
    { ats: 'ashby', slug: 'scale', name: 'Scale AI' },
    { ats: 'ashby', slug: 'perplexity', name: 'Perplexity' },
    { ats: 'ashby', slug: 'mistral', name: 'Mistral AI' },
    { ats: 'lever', slug: 'cohere', name: 'Cohere' },
  ],
  'Oil & Gas / Energy': [
    { ats: 'greenhouse', slug: 'tesla', name: 'Tesla Energy' },
    { ats: 'greenhouse', slug: 'sunrun', name: 'Sunrun' },
    { ats: 'greenhouse', slug: 'commonwealthfusion', name: 'Commonwealth Fusion' },
    { ats: 'lever', slug: 'form-energy', name: 'Form Energy' },
    { ats: 'ashby', slug: 'crusoe', name: 'Crusoe Energy' },
    { ats: 'smartrecruiters', slug: 'Bosch', name: 'Bosch' },
  ],
  'Healthcare Tech': [
    { ats: 'greenhouse', slug: 'oscar', name: 'Oscar Health' },
    { ats: 'greenhouse', slug: 'devoted', name: 'Devoted Health' },
    { ats: 'greenhouse', slug: 'tempus', name: 'Tempus' },
    { ats: 'greenhouse', slug: 'cedar', name: 'Cedar' },
    { ats: 'greenhouse', slug: 'included', name: 'Included Health' },
    { ats: 'lever', slug: 'ro', name: 'Ro' },
    { ats: 'ashby', slug: 'commure', name: 'Commure' },
  ],
  'Manufacturing': [
    { ats: 'greenhouse', slug: 'tesla', name: 'Tesla' },
    { ats: 'greenhouse', slug: 'relativity', name: 'Relativity Space' },
    { ats: 'greenhouse', slug: 'zoox', name: 'Zoox' },
    { ats: 'lever', slug: 'anduril', name: 'Anduril' },
    { ats: 'ashby', slug: 'hadrian', name: 'Hadrian' },
    { ats: 'smartrecruiters', slug: 'Bosch', name: 'Bosch' },
  ],
  'Engineering': [
    { ats: 'greenhouse', slug: 'spacex', name: 'SpaceX' },
    { ats: 'greenhouse', slug: 'relativity', name: 'Relativity Space' },
    { ats: 'greenhouse', slug: 'nuro', name: 'Nuro' },
    { ats: 'lever', slug: 'anduril', name: 'Anduril' },
    { ats: 'ashby', slug: 'ramp', name: 'Ramp' },
  ],
  'Finance / Fintech': [
    { ats: 'greenhouse', slug: 'stripe', name: 'Stripe' },
    { ats: 'greenhouse', slug: 'affirm', name: 'Affirm' },
    { ats: 'greenhouse', slug: 'robinhood', name: 'Robinhood' },
    { ats: 'greenhouse', slug: 'sofi', name: 'SoFi' },
    { ats: 'greenhouse', slug: 'coinbase', name: 'Coinbase' },
    { ats: 'ashby', slug: 'ramp', name: 'Ramp' },
    { ats: 'ashby', slug: 'mercury', name: 'Mercury' },
    { ats: 'smartrecruiters', slug: 'Visa', name: 'Visa' },
  ],
  'Retail / Consumer': [
    { ats: 'greenhouse', slug: 'instacart', name: 'Instacart' },
    { ats: 'greenhouse', slug: 'faire', name: 'Faire' },
    { ats: 'greenhouse', slug: 'gopuff', name: 'Gopuff' },
    { ats: 'lever', slug: 'shipbob', name: 'ShipBob' },
    { ats: 'smartrecruiters', slug: 'McDonalds', name: "McDonald's" },
    { ats: 'smartrecruiters', slug: 'IKEA', name: 'IKEA' },
  ],
  'Product Management': [
    { ats: 'greenhouse', slug: 'stripe', name: 'Stripe' },
    { ats: 'greenhouse', slug: 'databricks', name: 'Databricks' },
    { ats: 'greenhouse', slug: 'asana', name: 'Asana' },
    { ats: 'greenhouse', slug: 'coinbase', name: 'Coinbase' },
    { ats: 'ashby', slug: 'notion', name: 'Notion' },
    { ats: 'ashby', slug: 'ramp', name: 'Ramp' },
    { ats: 'lever', slug: 'netflix', name: 'Netflix' },
  ],
  'Media / Gaming': [
    { ats: 'lever', slug: 'netflix', name: 'Netflix' },
    { ats: 'greenhouse', slug: 'discord', name: 'Discord' },
    { ats: 'greenhouse', slug: 'roblox', name: 'Roblox' },
    { ats: 'smartrecruiters', slug: 'Ubisoft', name: 'Ubisoft' },
    { ats: 'smartrecruiters', slug: 'Twitch', name: 'Twitch' },
  ],
}

// ── Small utilities ─────────────────────────────────────────────────────────────────────────────

// Strip HTML tags/entities/urls to readable text (ported from src/lib/rag.js cleanText).
function cleanText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// fetch JSON with a hard timeout; returns null on any failure (never throws) so one bad board
// can't sink the whole fan-out.
async function fetchJson(url, { ms = 8000, headers } = {}) {
  try {
    const r = await fetch(url, { headers: headers || { Accept: 'application/json' }, signal: AbortSignal.timeout(ms) })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

export function slugName(slug) {
  return String(slug || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Words the Workday bulk-import candidate list turned up as a `site` value for thousands of rows
// where `tenant` was ALSO bogus (see below) — a generic recruiting-site label, not a company name.
// Confirmed live via direct registry inspection: real distinguishing signal is gone for these, so
// showing one of these as if it were the employer would be confidently WRONG, not just imprecise.
const GENERIC_WORKDAY_SITE_RE = /^(external(careers?(site2?)?)?|ext|careers?(site)?|jobs?|broadbeanexternal|global|corporate(careers)?|earlycareers|gti|externalsite|site|main|default|corp|jobsearch|recruit(ing|ment)?|staffing|talent(community)?|applicants|openings|opportunities|current|portal|\d+)$/i
// Some fraction of the bulk-imported Workday candidates have a corrupted `tenant` — literally a
// Workday DATA-CENTER code ("wd1", "wd5", "wd12", ...) rather than the company's real tenant slug,
// confirmed live: ~6,000 registry rows all showed company_name "Wd1"/"Wd5"/etc, the data-center
// label mechanically title-cased. `site` is the only field with any chance of holding the real
// identifier for these; when it's ALSO one of the generic labels above there's genuinely nothing
// left to derive a name from, and returning null (→ an honest "Unknown employer" upstream) beats
// guessing wrong. Root cause is in the external bulk-import dataset's own field encoding for this
// subset, not fixable by re-deriving from data this app already has — flagged, not fully solved.
export function workdayFallbackName(tenant, site) {
  if (!/^wd\d+$/i.test(String(tenant || ''))) return slugName(tenant)
  const s = String(site || '').trim()
  if (!s || GENERIC_WORKDAY_SITE_RE.test(s.replace(/[-_\s]+/g, ''))) return null
  return slugName(s)
}

// Warm-lambda TTL cache. Board contents change hourly at most, but every search used to re-download
// entire boards (multi-MB JSON for big companies) plus re-run Brave/Tavily discovery — twice the
// cost for two consecutive searches with tweaked filters. Cached job objects are only ever read or
// flagged idempotently (j.direct), never structurally mutated, so sharing them across requests is safe.
const CACHE_TTL_MS = 10 * 60 * 1000
const _cache = new Map()
function cached(key, fn) {
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value)
  return Promise.resolve(fn()).then((value) => {
    const empty = Array.isArray(value) ? !value.length : !value
    if (!empty) {
      _cache.set(key, { at: Date.now(), value })
      if (_cache.size > 200) _cache.delete(_cache.keys().next().value)
    }
    return value
  })
}

// ── JSearch (Google for Jobs via RapidAPI) — direct employer/ATS apply links ────────────────────
// The one broad source that flags DIRECT links: each job's apply_options[] carries is_direct, and
// job_apply_is_direct on the primary link. We pick the direct option (preferring known ATS/company
// publishers) so "Apply" lands on the real posting, not an aggregator. Needs a free RapidAPI key.
const JSEARCH_KEY = process.env.JSEARCH_KEY || process.env.RAPIDAPI_KEY || process.env.JSEARCH || process.env.RAPID_API_KEY
const DIRECT_PUBLISHER_RE = /greenhouse|lever|ashby|workday|icims|smartrecruiters|taleo|workable|bamboohr|recruitee|jobvite|career|company/i
// Known ATS hosts (mirror of the client's regex in src/Jobs.jsx — serverless can't import it).
const ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|brassring|jobvite|taleo|workable|bamboohr|recruitee|zohorecruit)\.(com|io|co|net)/i

// ── Adzuna → employer URL resolution (safe, best-effort) ─────────────────────────────────────────
// Adzuna's redirect_url login-walls logged-out users (adzuna.com/details/…?apply=1&after_login → a
// Facebook/Google/email modal), so it never reaches the employer. We resolve the SHOWN Adzuna rows
// server-side to the real employer URL. Deliberately NOT a public endpoint (no ?url= SSRF surface):
// this only ever runs on redirect_urls WE got from the Adzuna API. Defense-in-depth: reject private
// IP literals on every hop, read only redirect Locations (no HTML scraping), and accept a target
// ONLY when it lands on a host that is neither Adzuna nor any other aggregator.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
// linkedin added after a live test surfaced linkedin.com/jobs/search as a "custom careers page" --
// exactly the site this whole feature exists to skip, and a clear miss not having it listed already.
// careercircle added after a live test surfaced its /browse-jobs/category/... listing page as a
// "custom careers page": it's a job aggregator (like indeed/ziprecruiter), not a single employer's
// site, so the AI-fallback extraction had no one real posting to describe -- it fabricated entries
// with an empty description and a "just scraped" timestamp standing in for a real posting date.
// builtin[a-z]* added after the identical pattern surfaced on builtincolorado.com/builtinnyc.com --
// Built In is a tech job board with a regional edition per city (builtin.com, builtinnyc, builtinsf,
// builtinboston, builtinaustin, builtincolorado, builtinchicago, builtinla, builtinseattle, ...); a
// prefix match covers the whole family rather than chasing city editions one live failure at a time.
// The rest of this list (wellfound/angel, otta, theladders, flexjobs, remoteok, weworkremotely,
// remote.co, virtualvocations, powertofly, hired, vettery, ripplematch, idealist, themuse,
// efinancialcareers, mediabistro, clearancejobs, joinhandshake, higheredjobs, workatastartup) was
// added preemptively rather than one live failure at a time: every host added so far has been a
// well-known multi-employer job board, the exact category this feature exists to skip, so listing
// the rest of that category up front should cut down future live-diagnose-then-patch rounds.
// themuse/jooble/careerjet are now ALSO first-class sources fetched directly (see fetchTheMuse/
// fetchJooble/fetchCareerjet/fetchReed below), not just excluded from custom-page discovery --
// they're still someone else's aggregator, not any single employer's own site, so they still
// belong here for the final direct-vs-aggregator labeling. reed added to the same list for the
// same reason.
const AGGREGATOR_HOST_RE = /(^|\.)(adzuna|indeed|glassdoor|ziprecruiter|simplyhired|monster|dice|talent|jooble|neuvoo|jobgether|lensa|whatjobs|appcast|jobrapido|jobcase|careerjet|careerbuilder|snagajob|jobisjob|joblist|getwork|resume-library|linkedin|careercircle|builtin[a-z]*|wellfound|angel|otta|theladders|flexjobs|remoteok|weworkremotely|remote|virtualvocations|powertofly|hired|vettery|ripplematch|idealist|themuse|efinancialcareers|mediabistro|clearancejobs|joinhandshake|higheredjobs|workatastartup|reed|himalayas)\.(com|net|co\.uk|ca|com\.au|de|fr|io|org|co|app|co\.in|co\.jp)$/i
const PRIVATE_HOST_RE = /^(localhost$|\[?::1\]?$|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|172\.(1[6-9]|2\d|3[01])\.)/i
function safeHost(u) { try { return new URL(u).hostname; } catch { return ''; } }
function isAdzunaHost(h) { return /(^|\.)adzuna\.[a-z.]+$/i.test(h); }
// A "direct apply" job is one whose final URL opens on a real employer/ATS host — NOT an aggregator.
// Computed by host so it's honest regardless of a source's self-reported flag.
function isEmployerHost(h) { return !!h && !isAdzunaHost(h) && !AGGREGATOR_HOST_RE.test(h); }
// Follow up to 4 redirect hops (Location headers only) starting from an Adzuna redirect_url, and
// return the first host that is a real employer/ATS (off Adzuna AND off every other aggregator).
// Returns null if it hits a login wall, a private host, a non-redirect, or never leaves aggregators.
async function resolveAdzunaUrl(rawUrl, deadline) {
  let url = rawUrl
  for (let hop = 0; hop < 4; hop++) {
    const host = safeHost(url)
    if (!host || PRIVATE_HOST_RE.test(host)) return null
    if (!isAdzunaHost(host) && !AGGREGATOR_HOST_RE.test(host)) return url // reached a clean employer/ATS host
    const budget = deadline - Date.now()
    if (budget < 400) return null
    let r
    try {
      r = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(Math.min(2500, budget)) })
    } catch { return null }
    if (r.status < 300 || r.status >= 400) return null // terminal page still on an aggregator host
    const loc = r.headers.get('location')
    if (!loc) return null
    try { url = new URL(loc, url).href } catch { return null }
    if (/\/authenticate|\/login\b|after_login=|interstitial=/i.test(url)) return null // Adzuna login wall
  }
  return null
}
function pick(o, keys) { for (const k of keys) { const v = o && o[k]; if (v !== undefined && v !== null && v !== '') return v } return undefined }
function jsearchApplyLink(j) {
  const opts = Array.isArray(j.apply_options) ? j.apply_options : (Array.isArray(j.apply_links) ? j.apply_links : [])
  const linkOf = (o) => o && (o.apply_link || o.link || o.url)
  const isDir = (o) => o && (o.is_direct || o.direct)
  const direct = opts.filter((o) => isDir(o) && linkOf(o))
  const preferred = direct.find((o) => DIRECT_PUBLISHER_RE.test(o.publisher || '') || ATS_HOST_RE.test((linkOf(o) || '').replace(/^https?:\/\//, '')))
  if (preferred) return { url: linkOf(preferred), direct: true }
  if (direct[0]) return { url: linkOf(direct[0]), direct: true }
  // No job_google_link fallback: it's a google.com/search results page, not a posting — and since
  // google isn't (and shouldn't be — careers.google.com is a real employer host) in
  // AGGREGATOR_HOST_RE, the honest host recompute badged it "✓ direct apply". Same for the old
  // last-resort opts[0] (an unvetted apply option of any aggregator). A row with no acceptable
  // link gets url:'' and is dropped by the .filter((j) => j.url) below — better no result than an
  // Apply that opens a search page.
  const primary = pick(j, ['job_apply_link', 'apply_link'])
  if (primary) return { url: primary, direct: !!(j.job_apply_is_direct || j.apply_is_direct) }
  return { url: '', direct: false }
}
async function jsearchCall(path, params) {
  try {
    const r = await fetch(`https://jsearch.p.rapidapi.com${path}?${params.toString()}`, {
      headers: { 'X-RapidAPI-Key': JSEARCH_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
      signal: AbortSignal.timeout(18000), // v5 /search-v2 can be slow; the function has a 60s budget
    })
    if (!r.ok) { let t = ''; try { t = (await r.text()).slice(0, 160); } catch (e) {} return { ok: false, status: r.status, error: 'HTTP ' + r.status + (t ? ': ' + t.replace(/\s+/g, ' ') : '') } }
    return { ok: true, data: await r.json() }
  } catch (e) { return { ok: false, error: (e && e.message) || 'fetch failed' } }
}
async function fetchJSearch(what, where, remote, country) {
  if (!JSEARCH_KEY) return { results: [], configured: false }
  const q = [what, where].filter(Boolean).join(' in ').trim() || what
  const params = new URLSearchParams({ query: q + (remote ? ' remote' : ''), page: '1', num_pages: '1', country: country || 'us', date_posted: 'month' })
  if (remote) params.set('work_from_home', 'true')
  // JSearch v5 uses /search-v2 (jobs at data.jobs); the classic API uses /search (jobs at data[]).
  // Try v2 first, fall back to classic on 404 — works on either subscription.
  let call = await jsearchCall('/search-v2', params)
  if (!call.ok && call.status === 404) call = await jsearchCall('/search', params)
  if (!call.ok) return { results: [], configured: true, error: call.error, raw: 0 }
  const d = call.data
  const jobs = Array.isArray(d && d.data) ? d.data
    : (d && d.data && Array.isArray(d.data.jobs)) ? d.data.jobs
    : (Array.isArray(d && d.jobs) ? d.jobs : [])
  const results = jobs.map((j) => {
    const link = jsearchApplyLink(j)
    const loc = [pick(j, ['job_city', 'city']), pick(j, ['job_state', 'state']), pick(j, ['job_country', 'country'])].filter(Boolean).join(', ')
    return {
      id: 'js_' + (pick(j, ['job_id', 'id']) || Math.random().toString(36).slice(2)),
      title: pick(j, ['job_title', 'title']) || '',
      company: pick(j, ['employer_name', 'company_name', 'company']) || (j.employer && j.employer.name) || '',
      location: loc || (pick(j, ['job_is_remote', 'is_remote']) ? 'Remote' : ''),
      salaryMin: pick(j, ['job_min_salary', 'min_salary', 'salary_min']) || null,
      salaryMax: pick(j, ['job_max_salary', 'max_salary', 'salary_max']) || null,
      salaryPredicted: false,
      url: link.url, direct: link.direct,
      category: pick(j, ['job_publisher', 'publisher']) || '', categoryTag: '',
      contractTime: pick(j, ['job_employment_type', 'employment_type']) || '',
      description: cleanText(pick(j, ['job_description', 'description']) || '').slice(0, 2000),
      created: pick(j, ['job_posted_at_datetime_utc', 'job_posted_at', 'posted_at']) || '',
      source: 'jsearch',
    }
  }).filter((j) => j.url)
  return { results, configured: true, raw: jobs.length }
}

// ── Himalayas — free, no key: remote jobs with a DIRECT applicationLink ──────────────────────────
async function fetchHimalayas() {
  const d = await fetchJson('https://himalayas.app/jobs/api?limit=50', { ms: 8000 })
  const jobs = (d && (d.jobs || d.data)) || []
  return jobs.map((j) => ({
    id: 'hi_' + (j.guid || j.id || Math.random().toString(36).slice(2)),
    title: j.title || '',
    company: j.companyName || (j.company && j.company.name) || '',
    location: (Array.isArray(j.locationRestrictions) && j.locationRestrictions.join(', ')) || 'Remote',
    salaryMin: j.minSalary || null, salaryMax: j.maxSalary || null, salaryPredicted: false,
    url: j.applicationLink || j.url || '', direct: !!j.applicationLink,
    category: (Array.isArray(j.categories) && j.categories[0]) || '', categoryTag: '',
    contractTime: (Array.isArray(j.employmentType) && j.employmentType[0]) || '',
    description: cleanText(j.description || j.excerpt || '').slice(0, 2000),
    created: j.pubDate || j.publishedDate || '',
    source: 'himalayas',
  })).filter((j) => j.url)
}

// ── The Muse — free, no key: broad listings with a direct posting link ─────────────────────────
// No server-side category/keyword filter (Muse's `category` param only accepts a fixed list of
// exact category names, not free-text titles -- passing an arbitrary title through it would just
// silently return zero results); mirrors Himalayas' approach of pulling a broad recent set and
// letting the handler's own title/location filter narrow it down.
async function fetchTheMuse() {
  const d = await fetchJson('https://www.themuse.com/api/public/jobs?page=0', { ms: 8000 })
  const items = (d && d.results) || []
  return items.map((j) => ({
    id: 'tm_' + (j.id || Math.random().toString(36).slice(2)),
    title: j.name || '',
    company: (j.company && j.company.name) || '',
    location: (Array.isArray(j.locations) ? j.locations.map((l) => l && l.name).filter(Boolean).join(', ') : ''),
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: (j.refs && j.refs.landing_page) || '',
    category: (Array.isArray(j.categories) && j.categories[0] && j.categories[0].name) || '', categoryTag: '',
    contractTime: (Array.isArray(j.levels) && j.levels[0] && j.levels[0].name) || '',
    description: cleanText(j.contents || '').slice(0, 2000),
    created: j.publication_date || '',
    source: 'themuse',
  })).filter((j) => j.url)
}

// ── Jooble — free API key (jooble.org/api/about); global, keyword+location POST ────────────────
const JOOBLE_KEY = process.env.JOOBLE_KEY || process.env.Jooble || process.env.JOOBLE
async function fetchJooble(what, where) {
  if (!JOOBLE_KEY) return []
  let d
  try {
    const r = await fetch(`https://jooble.org/api/${encodeURIComponent(JOOBLE_KEY)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: what || '', location: where || '' }),
      signal: AbortSignal.timeout(8000),
    })
    d = r.ok ? await r.json() : null
  } catch { d = null }
  const jobs = (d && d.jobs) || []
  return jobs.map((j) => ({
    id: 'jo_' + (j.id || Math.random().toString(36).slice(2)),
    title: j.title || '',
    company: j.company || '',
    location: j.location || '',
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: j.link || '',
    category: '', categoryTag: '',
    contractTime: j.type || '',
    description: cleanText(j.snippet || '').slice(0, 2000),
    created: j.updated || '',
    source: 'jooble',
  })).filter((j) => j.url)
}

// ── Careerjet — free affiliate id (careerjet.com/partners); global via locale_code ──────────────
const CAREERJET_AFFID = process.env.CAREERJET_AFFID || process.env.CareerjetAffid
const CAREERJET_LOCALE = { us: 'en_US', gb: 'en_GB', ca: 'en_CA', au: 'en_AU' }
async function fetchCareerjet(what, where, country) {
  if (!CAREERJET_AFFID) return []
  const params = new URLSearchParams({
    affid: CAREERJET_AFFID,
    keywords: what || '',
    location: where || '',
    locale_code: CAREERJET_LOCALE[country] || 'en_US',
    user_ip: '127.0.0.1',
    user_agent: 'Mozilla/5.0 (compatible; Wagner-GPT/1.0)',
    pagesize: '20',
  })
  const d = await fetchJson(`http://public-api.careerjet.com/search?${params.toString()}`, { ms: 8000 })
  const jobs = (d && d.jobs) || []
  return jobs.map((j) => ({
    id: 'cj_' + (j.url ? String(j.url).slice(-40) : Math.random().toString(36).slice(2)),
    title: j.title || '',
    company: j.company || '',
    location: j.locations || '',
    salaryMin: j.salary_min || null, salaryMax: j.salary_max || null, salaryPredicted: false,
    url: j.url || '',
    category: '', categoryTag: '',
    contractTime: '',
    description: cleanText(j.description || '').slice(0, 2000),
    created: j.date || '',
    source: 'careerjet',
  })).filter((j) => j.url)
}

// ── Reed — free API key (reed.co.uk/developers), UK jobs only; only called for country:'gb' ─────
const REED_API_KEY = process.env.REED_API_KEY || process.env.ReedApiKey
async function fetchReed(what, where) {
  if (!REED_API_KEY) return []
  const params = new URLSearchParams({ keywords: what || '' })
  if (where) params.set('locationName', where)
  const d = await fetchJson(`https://www.reed.co.uk/api/1.0/search?${params.toString()}`, {
    ms: 8000,
    headers: { Authorization: 'Basic ' + Buffer.from(REED_API_KEY + ':').toString('base64'), Accept: 'application/json' },
  })
  const jobs = (d && d.results) || []
  return jobs.map((j) => ({
    id: 're_' + (j.jobId || Math.random().toString(36).slice(2)),
    title: j.jobTitle || '',
    company: j.employerName || '',
    location: j.locationName || '',
    salaryMin: j.minimumSalary || null, salaryMax: j.maximumSalary || null, salaryPredicted: false,
    url: j.jobUrl || '',
    category: '', categoryTag: '',
    contractTime: j.contractType || j.jobType || '',
    description: cleanText(j.jobDescription || '').slice(0, 2000),
    created: j.date || '',
    source: 'reed',
  })).filter((j) => j.url)
}

// ── USAJobs — free API key + registered email (developer.usajobs.gov); US federal jobs only, only
// called for country:'us'. Requires BOTH a key and an email (USAJobs rejects requests whose
// User-Agent isn't the exact email registered with the key), so both must be set or it no-ops.
const USAJOBS_API_KEY = process.env.USAJOBS_API_KEY || process.env.UsaJobsApiKey
const USAJOBS_EMAIL = process.env.USAJOBS_EMAIL || process.env.USAJOBS_USER_AGENT
async function fetchUsaJobs(what, where) {
  if (!USAJOBS_API_KEY || !USAJOBS_EMAIL) return []
  const params = new URLSearchParams({ Keyword: what || '' })
  if (where) params.set('LocationName', where)
  const d = await fetchJson(`https://data.usajobs.gov/api/search?${params.toString()}`, {
    ms: 8000,
    headers: { Host: 'data.usajobs.gov', 'User-Agent': USAJOBS_EMAIL, 'Authorization-Key': USAJOBS_API_KEY, Accept: 'application/json' },
  })
  const items = (d && d.SearchResult && d.SearchResult.SearchResultItems) || []
  return items.map((it) => {
    const j = it.MatchedObjectDescriptor || {}
    const rem = Array.isArray(j.PositionRemuneration) ? j.PositionRemuneration[0] : null
    return {
      id: 'uj_' + (it.MatchedObjectId || Math.random().toString(36).slice(2)),
      title: j.PositionTitle || '',
      company: j.OrganizationName || j.DepartmentName || '',
      location: j.PositionLocationDisplay || '',
      salaryMin: rem ? (Number(rem.MinimumRange) || null) : null,
      salaryMax: rem ? (Number(rem.MaximumRange) || null) : null,
      salaryPredicted: false,
      url: j.PositionURI || '',
      category: '', categoryTag: '',
      contractTime: (Array.isArray(j.PositionSchedule) && j.PositionSchedule[0] && j.PositionSchedule[0].Name) || '',
      description: cleanText((j.UserArea && j.UserArea.Details && j.UserArea.Details.JobSummary) || '').slice(0, 2000),
      created: j.PositionStartDate || '',
      source: 'usajobs',
    }
  }).filter((j) => j.url)
}

// ── Per-ATS board fetchers → normalized results ─────────────────────────────────────────────────

async function fetchGreenhouse({ slug, name }) {
  const d = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`)
  const jobs = (d && d.jobs) || []
  return jobs.map((j) => ({
    id: 'gh_' + slug + '_' + j.id,
    title: j.title || '',
    company: name || slugName(slug),
    location: (j.location && j.location.name) || '',
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: j.absolute_url || '',
    category: '', categoryTag: '',
    contractTime: '',
    description: cleanText(j.content || '').slice(0, 2000),
    created: j.updated_at || j.first_published || '',
    source: 'greenhouse',
  }))
}

async function fetchLever({ slug, name }) {
  const arr = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`)
  const jobs = Array.isArray(arr) ? arr : []
  return jobs.map((j) => ({
    id: 'lv_' + slug + '_' + (j.id || ''),
    title: j.text || '',
    company: name || slugName(slug),
    location: (j.categories && j.categories.location) || '',
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: j.hostedUrl || j.applyUrl || '',
    category: (j.categories && j.categories.team) || '', categoryTag: '',
    contractTime: (j.categories && j.categories.commitment) || '',
    description: cleanText(j.descriptionPlain || j.description || '').slice(0, 2000),
    created: j.createdAt ? new Date(j.createdAt).toISOString() : '',
    source: 'lever',
  }))
}

async function fetchAshby({ slug, name }) {
  const d = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`)
  const jobs = (d && d.jobs) || []
  return jobs.map((j) => ({
    id: 'ay_' + slug + '_' + (j.id || ''),
    title: j.title || '',
    company: (d && d.name) || name || slugName(slug),
    location: j.location || (j.isRemote ? 'Remote' : ''),
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: j.jobUrl || j.applyUrl || '',
    category: j.department || j.team || '', categoryTag: '',
    contractTime: j.employmentType || '',
    description: cleanText(j.descriptionPlain || '').slice(0, 2000),
    created: j.publishedAt || '',
    source: 'ashby',
  }))
}

async function fetchWorkable({ slug, name }) {
  const d = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`)
  const jobs = (d && (d.jobs || d.results)) || []
  return jobs.map((j) => ({
    id: 'wk_' + slug + '_' + (j.shortcode || j.id || ''),
    title: j.title || '',
    company: name || slugName(slug),
    location: [j.city, j.state, j.country].filter(Boolean).join(', ') || (j.telecommuting ? 'Remote' : ''),
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: j.url || j.application_url || (j.shortcode ? `https://apply.workable.com/${slug}/j/${j.shortcode}/` : ''),
    category: j.department || '', categoryTag: '',
    contractTime: j.employment_type || '',
    description: cleanText(j.description || '').slice(0, 2000),
    created: j.published_on || j.created_at || '',
    source: 'workable',
  }))
}

async function fetchSmartRecruiters({ slug, name }) {
  const d = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`)
  const jobs = (d && d.content) || []
  return jobs.map((j) => ({
    id: 'sr_' + slug + '_' + (j.id || ''),
    title: j.name || '',
    company: (j.company && j.company.name) || name || slugName(slug),
    location: [j.location && j.location.city, j.location && j.location.region, j.location && j.location.country].filter(Boolean).join(', ') || (j.location && j.location.remote ? 'Remote' : ''),
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
    category: (j.function && j.function.label) || (j.department && j.department.label) || '', categoryTag: '',
    contractTime: (j.typeOfEmployment && j.typeOfEmployment.label) || '',
    description: cleanText((j.jobAd && j.jobAd.sections && j.jobAd.sections.jobDescription && j.jobAd.sections.jobDescription.text) || '').slice(0, 2000),
    created: j.releasedDate || '',
    source: 'smartrecruiters',
  }))
}
async function fetchRecruitee({ slug, name }) {
  const d = await fetchJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`)
  const jobs = (d && d.offers) || []
  return jobs.map((j) => ({
    id: 're_' + slug + '_' + (j.id || ''),
    title: j.title || '',
    company: j.company_name || name || slugName(slug),
    location: j.location || [j.city, j.country].filter(Boolean).join(', ') || (j.remote ? 'Remote' : ''),
    salaryMin: (j.salary && j.salary.min) || null, salaryMax: (j.salary && j.salary.max) || null, salaryPredicted: false,
    url: j.careers_url || j.careers_apply_url || '',
    category: j.department || '', categoryTag: '',
    contractTime: j.employment_type_code || '',
    description: cleanText(j.description || '').slice(0, 2000),
    created: j.published_at || '',
    source: 'recruitee',
  })).filter((j) => j.url)
}

// Workday's CXS API — the job-board backend for the vast majority of large enterprises (the
// "Sony-sized companies" case Greenhouse/Lever/Ashby don't reach, since those skew tech-startup).
// The request/response shape is IDENTICAL across every Workday tenant; the only per-company unknowns
// are which tenant/dataCenter/site a given company uses (there's no universal slug lookup the way
// Greenhouse has boards-api.greenhouse.io/v1/boards/{slug} — this is a discovery problem, solved
// below by extracting these three pieces straight out of a myworkdayjobs.com URL Brave/Tavily finds).
async function fetchWorkday({ tenant, dataCenter, site, name }) {
  const base = `https://${encodeURIComponent(tenant)}.${encodeURIComponent(dataCenter)}.myworkdayjobs.com`
  let d
  try {
    const r = await fetch(`${base}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
      signal: AbortSignal.timeout(8000),
    })
    d = r.ok ? await r.json() : null
  } catch { d = null }
  const jobs = (d && d.jobPostings) || []
  const companyName = name || workdayFallbackName(tenant, site) || 'Unknown employer (Workday)'
  return jobs.map((j) => ({
    id: 'wd_' + tenant + '_' + site + '_' + (j.bulletFields && j.bulletFields[0] || j.externalPath || Math.random().toString(36).slice(2)),
    title: j.title || '',
    company: companyName,
    location: j.locationsText || (Array.isArray(j.additionalLocations) ? j.additionalLocations.join(', ') : ''),
    salaryMin: null, salaryMax: null, salaryPredicted: false,
    url: j.externalPath ? `${base}/${site}${j.externalPath}` : '',
    category: '', categoryTag: '',
    contractTime: j.timeType || '',
    description: '', // CXS's list endpoint doesn't include the full description; the detail endpoint needs a second per-job call, not worth the latency for a search result list
    created: j.postedOn || '',
    source: 'workday',
  })).filter((j) => j.url)
}

export const ATS_FETCHERS = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby, workable: fetchWorkable, smartrecruiters: fetchSmartRecruiters, recruitee: fetchRecruitee, workday: fetchWorkday }

export async function fetchBoards(boards) {
  const settled = await Promise.allSettled(boards.map((b) => {
    const fn = ATS_FETCHERS[b.ats]
    const key = b.ats === 'workday' ? `workday:${b.tenant}:${b.dataCenter}:${b.site}` : `${b.ats}:${b.slug}`
    return fn ? cached(key, () => fn(b)) : Promise.resolve([])
  }))
  return settled.flatMap((s) => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []))
}

// ── Discovery: find more ATS boards for the query via Brave/Tavily ───────────────────────────────

// Workday needs THREE identifiers out of one URL (tenant/dataCenter/site), not just a slug — handled
// separately below since its board shape differs from every other {ats,slug} fetcher. Real Workday
// career-site URLs sometimes carry a locale segment before the site name
// (…myworkdayjobs.com/en-US/Company_Careers/job/…) and sometimes don't; the optional locale clause
// covers both without extracting the locale itself as if it were the site. A wrong extraction here
// just means fetchWorkday's CXS call 404s for that tenant (handled gracefully, returns no jobs) — not
// a hard failure, so this doesn't need to be perfect, just a reasonable best effort.
const WORKDAY_URL_RE = /([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:wday\/cxs\/[a-z0-9-]+\/)?(?:[a-z]{2}-[A-Z]{2}\/)?([a-z0-9_-]+)/i

function boardsFromUrls(urls) {
  const seen = new Set()
  const out = []
  const patterns = [
    { re: /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9-]+)/i, ats: 'greenhouse' },
    { re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9-]+)/i, ats: 'greenhouse' },
    { re: /jobs\.lever\.co\/([a-z0-9-]+)/i, ats: 'lever' },
    { re: /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, ats: 'ashby' },
    { re: /([a-z0-9-]+)\.workable\.com/i, ats: 'workable' },
    { re: /(?:jobs|careers)\.smartrecruiters\.com\/([a-zA-Z0-9]+)/i, ats: 'smartrecruiters' },
    { re: /([a-z0-9-]+)\.recruitee\.com/i, ats: 'recruitee' },
  ]
  for (const u of urls) {
    const wd = String(u || '').match(WORKDAY_URL_RE)
    if (wd) {
      const [, tenant, dataCenter, site] = wd
      const key = 'workday:' + tenant.toLowerCase() + ':' + site.toLowerCase()
      if (!seen.has(key)) { seen.add(key); out.push({ ats: 'workday', tenant: tenant.toLowerCase(), dataCenter: dataCenter.toLowerCase(), site, name: slugName(tenant) }) }
      continue
    }
    for (const p of patterns) {
      const m = String(u || '').match(p.re)
      if (m && m[1]) {
        const key = p.ats + ':' + m[1].toLowerCase() // dedup is case-insensitive; the STORED slug below is not
        if (!seen.has(key) && !/^(www|apply|jobs|boards|api)$/i.test(m[1])) {
          seen.add(key)
          // Preserve the slug's original casing -- SmartRecruiters company IDs are case-sensitive
          // (see the seed data above: 'Square', 'Visa', 'IKEA'), so lowercasing it here would silently
          // 404 every SmartRecruiters board found via discovery. Harmless for the other ATS platforms,
          // whose slugs are conventionally already lowercase in the wild.
          out.push({ ats: p.ats, slug: m[1], name: slugName(m[1]) })
        }
      }
    }
  }
  return out
}

// A discovered URL that ISN'T on any known ATS platform but still looks like a company's own careers
// page (career/job in the path, not an aggregator) -- this is the genuinely-custom-site case
// (a "Sony.com/careers" with no public JSON API at all), handled by structured schema.org data first
// and Jina+AI extraction as a fallback. One candidate per hostname, so one company's page isn't
// sampled multiple times. cap raised from 3 then 4 then 5: checking one more candidate is cheap on
// average now that most real career pages resolve via free structured-data parsing, not a paid Groq
// call each time, and now that finalizeCustomJobCandidates + fetchCustomCareerPageViaAi's own
// URL-verification filter reject fabricated "postings" for free too (no wasted Groq call turns into
// a wasted result the way it used to).
function customCareerPageCandidates(urls, cap = 6) {
  const seen = new Set()
  const out = []
  for (const u of urls) {
    const host = safeHost(u)
    if (!host || seen.has(host)) continue
    if (AGGREGATOR_HOST_RE.test(host) || ATS_HOST_RE.test(host)) continue
    if (!/career|jobs?\b/i.test(u)) continue
    seen.add(host)
    out.push({ url: u, name: slugName(host.replace(/^www\./, '').split('.')[0]) })
    if (out.length >= cap) break
  }
  return out
}

// Accept either the _KEY convention or the bare name (this project's Vercel uses `Brave`/`Tavily`).
const BRAVE_KEY = process.env.BRAVE_KEY || process.env.Brave || process.env.BRAVE
const TAVILY_KEY = process.env.TAVILY_KEY || process.env.TAVILY || process.env.TAVILY_API_KEY || process.env.Tavily
const GROQ_KEY = process.env.GROQ_KEY || process.env.Groq || process.env.GROQ

async function braveOrTavily(q, count) {
  try {
    if (BRAVE_KEY) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}&safesearch=moderate`
      const r = await fetch(url, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY }, signal: AbortSignal.timeout(6000) })
      if (r.ok) { const d = await r.json(); return (d?.web?.results || []).map((x) => x.url) }
    } else if (TAVILY_KEY) {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: TAVILY_KEY, query: q, max_results: count, search_depth: 'basic' }),
        signal: AbortSignal.timeout(6000),
      })
      if (r.ok) { const d = await r.json(); return (d?.results || []).map((x) => x.url) }
    }
  } catch { /* discovery is best-effort */ }
  return []
}

// Deliberately NOT scoped to `site:greenhouse.io OR ...` anymore -- that scoping meant a genuine
// custom-domain career page (no public JSON API at all) could never surface from discovery, no matter
// how well it matched the query. A broad "{query} careers" search costs the same one API call and
// lets boardsFromUrls / customCareerPageCandidates each pick out what they recognize from the SAME
// result set, covering both the "on a known ATS platform" and "fully custom site" cases at once.
async function discoverBoards(query) {
  const urls = await braveOrTavily(`${query} careers`, 10)
  return { boards: boardsFromUrls(urls).slice(0, 8), customPages: customCareerPageCandidates(urls) }
}

// Fetch a custom company careers page (no known ATS) via the keyless Jina reader, then one Groq call
// to extract postings into the same normalized shape every other source uses. Best-effort: any
// failure (unreachable page, no GROQ_KEY, malformed AI output) returns an empty list, never throws.
// Shared validation/dedupe for BOTH extraction paths below (structured data and AI fallback) -- same
// safety net either way, since a bad candidate can come from either source:
//  - title/company/url all required; url must be absolute and DIFFERENT from the source page (a job
//    without its own confirmed posting url previously fell back to the source page's url, silently
//    pointing "Apply" at a generic job-board/category hub -- e.g. a Ross Stores careers category
//    page, a Rigzone listings page -- rather than an actual specific posting).
//  - company must be a real name, different from the discovered site's own name (confirmed live:
//    Rigzone, an oil & gas INDUSTRY JOB BOARD that hosts OTHER companies' postings on its own domain,
//    was labeled as the "company" for every posting when the old code used the site's own name
//    unconditionally).
//  - a url claimed by more than one DIFFERENT company is dropped entirely, not deduped to one --
//    confirmed live: several genuinely different real employer names (NES Fircroft, SBM Offshore,
//    Vestas, Baker Hughes) all traced back to near-identical URLs with no per-posting date/ID, the
//    signature of one shared search/listing page rather than distinct postings. A real job posting
//    never shares its exact apply url with a different company's posting.
// Confirmed live (ACBSP's "What Does A Manufacturing Manager Do?" / Ross's "STORE MANAGER" category
// links): the AI fallback sometimes returns the SAME page as an anchor-fragment URL for every "job"
// it lists -- e.g. https://site.example/careers#store-manager -- which is a different STRING from
// the source page url (so the old exact-match check missed it) but not a different page at all.
// Stripping the fragment before comparing catches this without needing the model to get it right.
function stripUrlFragment(u) { return String(u || '').split('#')[0] }
function finalizeCustomJobCandidates(raw, { url, name, scrapedAt }) {
  const sourcePage = stripUrlFragment(url)
  const candidates = raw.filter((j) => {
    if (!j || !j.title || !j.url || !/^https?:\/\//i.test(j.url) || stripUrlFragment(j.url) === sourcePage) return false
    const company = String(j.company || '').trim()
    return !!company && company.toLowerCase() !== String(name || '').toLowerCase()
  })
  const urlCounts = new Map()
  for (const j of candidates) urlCounts.set(j.url, (urlCounts.get(j.url) || 0) + 1)
  return candidates
    .filter((j) => urlCounts.get(j.url) === 1)
    .slice(0, 10)
    .map((j, i) => ({
      id: 'cc_' + safeHost(url) + '_' + i,
      title: String(j.title || ''),
      company: String(j.company).trim(),
      location: String(j.location || ''),
      salaryMin: j.salaryMin || null, salaryMax: j.salaryMax || null, salaryPredicted: false,
      url: j.url,
      category: '', categoryTag: '', contractTime: String(j.contractTime || ''),
      description: String(j.description || ''),
      // created prefers a REAL posting date (schema.org's datePosted) over "just scraped now" -- an
      // empty/missing date parses to NaN in the results sort, which treats it as the OLDEST possible
      // posting, so a custom job with no date always lost the freshness tiebreak against hundreds of
      // dated ATS listings and got silently truncated by the results cap, confirmed live. "Just
      // scraped" is still a far more honest fallback than "oldest thing that exists" for the (rarer,
      // now that structured data is tried first) case where no real date is available at all.
      created: j.created || scrapedAt,
      source: 'custom',
    }))
}

// ── schema.org/JobPosting structured data (JSON-LD) -- tried FIRST, before any AI guessing ────────
// Most ATS platforms and a growing number of individual company career pages embed this markup
// specifically so Google indexes them for "Google for Jobs". When present it's authoritative: the
// real hiring employer, real posting/expiry dates, and a real description come straight from the
// page's own structured data -- no AI extraction, no hallucination risk, no cost. Needs the page's
// RAW html (Jina's plain-text reader strips <script> tags entirely, which is exactly where this
// markup lives), so this uses a plain fetch instead of the Jina reader.
// TEMPORARY diagnostic logging (remove once the "structured data never fires" question is settled):
// confirmed live that custom-page results still show every sign of the AI fallback (empty
// description, identical "now" timestamps) even after this path was added -- meaning either the raw
// fetch is being blocked (bot detection), or the site only injects JobPosting JSON-LD via client-side
// JS that a plain server-side fetch can never see (common on modern SPA career sites). These logs
// (visible in Vercel's own Logs tab) distinguish the two without guessing.
// Routed through Jina's reader (X-Return-Format: html) rather than a direct fetch -- confirmed live
// via diagnostic logging that a direct fetch fails two different ways: some sites 403 it outright
// (bot detection sees no JS execution, no cookies, an anonymous datacenter IP), and modern
// client-rendered career sites (confirmed on CareerCircle) inject their content -- including any
// JobPosting structured data -- via JavaScript AFTER the initial server response, which a direct
// fetch can never see no matter how it's fetched. Jina already renders JS server-side (it's why the
// AI-fallback path has been getting real data off CareerCircle at all) and presents its own
// established reader identity rather than an anonymous IP, so reusing it here should pick up
// client-injected markup and fare better against basic bot walls, without adding a full headless-
// browser dependency to this function.
async function fetchRawHtml(pageUrl) {
  try {
    const r = await fetch(`https://r.jina.ai/${pageUrl}`, { headers: { Accept: 'text/html', 'X-Return-Format': 'html' }, signal: AbortSignal.timeout(10000) })
    if (!r.ok) { console.log('[structured-data] jina html fetch failed', pageUrl, 'status', r.status); return '' }
    const html = await r.text()
    console.log('[structured-data] jina html fetch ok', pageUrl, 'bytes', html.length, 'has ld+json script tag:', /application\/ld\+json/i.test(html))
    return html
  } catch (e) { console.log('[structured-data] jina html fetch threw', pageUrl, (e && e.message) || e); return '' }
}
function isJobPostingType(type) {
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))
}
// Real JobPosting markup isn't always a flat top-level node or a flat @graph array -- sites also
// nest it under a WebPage's mainEntity, an ItemList's itemListElement, etc. Walk the whole parsed
// tree (bounded depth) so those shapes aren't silently missed, and track every @type encountered
// so a "0 matches" result can be explained (wrong type present vs. genuinely no JobPosting at all).
function collectJobPostingNodes(value, out, seenTypes, depth) {
  if (!value || depth > 6) return
  if (Array.isArray(value)) { for (const v of value) collectJobPostingNodes(v, out, seenTypes, depth + 1); return }
  if (typeof value !== 'object') return
  const type = value['@type']
  if (type) seenTypes.add(Array.isArray(type) ? type.join('+') : String(type))
  if (isJobPostingType(type)) out.push(value)
  for (const key of Object.keys(value)) {
    if (key === '@type') continue
    collectJobPostingNodes(value[key], out, seenTypes, depth + 1)
  }
}
function extractJsonLdJobPostings(html) {
  const out = []
  const seenTypes = new Set()
  let scriptCount = 0
  let parseFailures = 0
  const scriptRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = scriptRe.exec(html))) {
    scriptCount++
    let parsed
    try { parsed = JSON.parse(m[1]) } catch { parseFailures++; continue }
    collectJobPostingNodes(parsed, out, seenTypes, 0)
  }
  console.log('[structured-data] ld+json scripts', scriptCount, 'parseFailures', parseFailures, 'types seen', Array.from(seenTypes).join('|') || '(none)', 'JobPosting matches', out.length)
  return out
}
function jsonLdOrgName(hiringOrganization) {
  if (!hiringOrganization) return ''
  if (typeof hiringOrganization === 'string') return hiringOrganization
  return String(hiringOrganization.name || '')
}
function jsonLdLocationText(node) {
  const loc = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation
  const addr = loc && loc.address
  if (addr) {
    const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean)
    if (parts.length) return parts.join(', ')
  }
  if (node.jobLocationType === 'TELECOMMUTE' || node.applicantLocationRequirements) return 'Remote'
  return ''
}
async function fetchStructuredJobPostings({ url, name }) {
  const html = await fetchRawHtml(url)
  if (!html) return []
  const nodes = extractJsonLdJobPostings(html)
  console.log('[structured-data] JobPosting nodes found', url, nodes.length)
  if (!nodes.length) return []
  const now = Date.now()
  const raw = nodes
    // Expired postings shouldn't surface at all -- validThrough is exactly the freshness signal the
    // AI-extraction path can never reliably have, since it can't be trusted to find a real date.
    .filter((n) => !n.validThrough || isNaN(Date.parse(n.validThrough)) || Date.parse(n.validThrough) >= now)
    .map((n) => {
      const sal = n.baseSalary && n.baseSalary.value
      const directUrl = typeof n.url === 'string' && /^https?:\/\//i.test(n.url) ? n.url
        : (typeof n.mainEntityOfPage === 'string' && /^https?:\/\//i.test(n.mainEntityOfPage) ? n.mainEntityOfPage : '')
      return {
        title: String(n.title || ''),
        company: jsonLdOrgName(n.hiringOrganization),
        location: jsonLdLocationText(n),
        salaryMin: sal ? (sal.minValue || sal.value || null) : null,
        salaryMax: sal ? (sal.maxValue || sal.value || null) : null,
        url: directUrl,
        contractTime: n.employmentType || '',
        description: cleanText(typeof n.description === 'string' ? n.description : '').slice(0, 2000),
        created: n.datePosted && !isNaN(Date.parse(n.datePosted)) ? n.datePosted : '',
      }
    })
  return finalizeCustomJobCandidates(raw, { url, name, scrapedAt: new Date().toISOString() })
}

// ── AI extraction fallback -- only reached when the page has no usable structured data at all ────
async function fetchCustomCareerPageViaAi({ url, name }) {
  if (!GROQ_KEY) return []
  let text = ''
  try {
    // 'markdown' (Jina's default reader format), not 'text' -- confirmed live: 'text' mode strips
    // every link's href entirely, leaving the model with ONLY visible link text (e.g. "NES Fircroft —
    // apply here") and no real URL to cite. Asked to always return a url per posting anyway, an
    // upgraded 70B model didn't return fewer fabrications than the old 8B one, it returned MORE
    // convincing ones -- plausible job titles, real company names, and invented-but-plausible-looking
    // sequential URLs (rigzone.com/jobs/.../jid-1234567 through jid-1234574) for a page whose own
    // structured data confirmed zero real JobPosting nodes existed. Markdown preserves `[text](href)`
    // links, so a real url is actually available to quote instead of invent.
    const r = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'text/plain', 'X-Return-Format': 'markdown' }, signal: AbortSignal.timeout(8000) })
    if (!r.ok) return []
    text = (await r.text()).slice(0, 6000)
  } catch { return [] }
  if (!text.trim()) return []
  let data
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Item #4 of the "3 to 8" roadmap: bumped from llama-3.1-8b-instant. This extraction task
        // (find the real hiring employer, reject job-board/FAQ/category pages, never invent a URL)
        // needs more careful instruction-following than an 8B model reliably gives -- confirmed live
        // this session, the 8B model repeatedly returned FAQ headings and category nav links as if
        // they were postings (see finalizeCustomJobCandidates' anchor-fragment fix) despite the
        // prompt explicitly forbidding it. llama-3.3-70b-versatile is already used for a similar
        // extraction/ranking task in api/deep-research.js, so this isn't an unverified model choice.
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content:
            'This is the text of a page found while searching for a SPECIFIC company\'s own careers page.\n' +
            'First check: is this actually one company\'s own job listings (not a job board, aggregator, ' +
            'search-results page, or a generic "browse by category" hub with no individual postings)? ' +
            'If it is a job board/aggregator/category hub, or you cannot confirm a single employer, return [].\n' +
            'Also reject the WHOLE PAGE (return []) if it is career-advice/informational content -- an ' +
            '"about this occupation" article, a "how to become a..." guide, an FAQ, or a generic landing ' +
            'page listing job CATEGORIES (e.g. "Store Manager", "District Manager") rather than actual ' +
            'open positions with a real location and apply link. Section headings and category names are ' +
            'NOT job postings even if they contain a job title.\n' +
            'BE CAREFUL: some sites (e.g. industry job boards) publish OTHER companies\' individual job ' +
            'postings on their own domain — a page can look like one specific posting while still being a ' +
            'THIRD PARTY listing for a DIFFERENT real employer. For each posting, find the ACTUAL HIRING ' +
            'EMPLOYER stated in the posting text itself (not the name of the website/board hosting it). ' +
            'If you cannot find a specific named employer in the page text that is different from the ' +
            'site/board itself, omit that item — do not guess, and never use the site/board\'s own name as ' +
            'the employer.\n' +
            'List up to 10 real, currently-open, INDIVIDUAL job postings, each with its own specific ' +
            'posting URL (not the same page URL, not a search/category link).\n' +
            'Return ONLY a JSON array, nothing else. Each item: {"title":"...","company":"the actual hiring employer named in the posting text","location":"...","url":"the exact absolute URL of THAT SPECIFIC posting"}.\n' +
            'Never invent or guess a URL or a company name — if you cannot find either with confidence, omit that item entirely.\n\n' +
            `Page URL: ${url}\nPage text:\n${text}`,
        }],
        temperature: 0.1,
        max_tokens: 1200,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    })
    data = r.ok ? await r.json() : null
  } catch { return [] }
  const content = data?.choices?.[0]?.message?.content || ''
  let jobs = []
  try {
    const match = content.match(/\[[\s\S]*\]/)
    if (match) jobs = JSON.parse(match[0])
  } catch { return [] }
  if (!Array.isArray(jobs)) return []
  // Deterministic anti-hallucination backstop: a real url must appear VERBATIM somewhere in the
  // fetched page text, or it was invented -- no amount of prompt instruction ("never invent a url")
  // reliably stops a model from doing it anyway, confirmed live even on a 70B model, so this doesn't
  // rely on the model's honesty at all. Matches on the URL's path+query (not scheme/host), so this
  // still catches a relative link the model correctly resolved to an absolute URL.
  const verified = jobs.filter((j) => {
    if (!j || typeof j.url !== 'string') return false
    try {
      const u = new URL(j.url, url)
      const needle = u.pathname + u.search
      return needle.length > 1 && text.includes(needle)
    } catch { return false }
  })
  return finalizeCustomJobCandidates(verified, { url, name, scrapedAt: new Date().toISOString() })
}

// Entry point used by the search handler: try structured data first (free, authoritative, no AI
// involved at all), and only reach for the AI-extraction fallback when the page has none.
async function fetchCustomCareerPage({ url, name }) {
  try {
    const structured = await fetchStructuredJobPostings({ url, name })
    if (structured.length) return structured
  } catch { /* fall through to AI extraction */ }
  return fetchCustomCareerPageViaAi({ url, name })
}

// ── Adzuna source ────────────────────────────────────────────────────────────────────────────────

async function fetchAdzuna(body, country) {
  const APP_ID = process.env.ADZUNA_APP_ID
  const APP_KEY = process.env.ADZUNA_APP_KEY
  if (!APP_ID || !APP_KEY) return { results: [], configured: false }
  const auth = `app_id=${encodeURIComponent(APP_ID)}&app_key=${encodeURIComponent(APP_KEY)}`
  const page = Math.max(1, parseInt(body.page, 10) || 1)
  const perPage = Math.min(50, Math.max(1, parseInt(body.resultsPerPage, 10) || 25))
  const params = new URLSearchParams()
  params.set('results_per_page', String(perPage))
  let what = String(body.what || body.titles || '').trim()
  if (body.remote) what = (what + ' remote').trim()
  if (what) params.set('what', what)
  if (body.whatExclude) params.set('what_exclude', String(body.whatExclude))
  if (body.where) {
    params.set('where', String(body.where))
    // Adzuna's default radius is tiny (~5km) — a suburb search like "Katy, TX" would miss the
    // rest of its own metro. 40km ≈ a normal hybrid-commute radius; overridable via body.distance.
    params.set('distance', String(parseInt(body.distance, 10) || 40))
  }
  const sMin = parseInt(body.salaryMin, 10); if (sMin > 0) params.set('salary_min', String(sMin))
  const sMax = parseInt(body.salaryMax, 10); if (sMax > 0) params.set('salary_max', String(sMax))
  if (body.category) params.set('category', String(body.category))
  if (body.fullTime) params.set('full_time', '1')
  params.set('sort_by', body.sortBy === 'salary' ? 'salary' : (body.sortBy === 'date' ? 'date' : 'relevance'))
  params.set('content-type', 'application/json')
  const d = await fetchJson(`${ADZUNA_BASE}/${country}/search/${page}?${auth}&${params.toString()}`, { ms: 9000 })
  const results = ((d && d.results) || []).map((j) => ({
    id: 'az_' + j.id,
    title: j.title || '',
    company: (j.company && j.company.display_name) || '',
    location: (j.location && j.location.display_name) || '',
    salaryMin: j.salary_min || null,
    salaryMax: j.salary_max || null,
    salaryPredicted: j.salary_is_predicted === '1' || j.salary_is_predicted === true,
    url: j.redirect_url || '',
    category: (j.category && j.category.label) || '',
    categoryTag: (j.category && j.category.tag) || '',
    contractTime: j.contract_time || '',
    description: cleanText(j.description || '').slice(0, 2000),
    created: j.created || '',
    source: 'adzuna',
  }))
  return { results, configured: true }
}

// ── Merge / dedupe / filter ──────────────────────────────────────────────────────────────────────

function tokenizeTitles(titles) {
  return String(titles || '')
    .toLowerCase()
    .split(/[,/|]+/).map((s) => s.trim()).filter(Boolean)
    .flatMap((phrase) => {
      // Keep 2-letter tokens: dropping them turned "AI Engineer" into just ["engineer"], which
      // matched EVERY engineering posting. "ai", "it", "qa", "bi", "ux" are real title words.
      const words = phrase.split(/\s+/).filter((w) => w.length >= 2)
      return words.length ? [{ phrase, words: words.map((w) => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')) }] : []
    })
}

// Keep a job if any requested title phrase overlaps its title (all significant words of at least one
// phrase are present as WHOLE words, OR the whole phrase is a substring). Word-boundary matching
// matters for the short tokens: bare .includes('ai') matched "Maintenance", "Trainer", etc.
// Empty title filter keeps everything.
function titleMatches(jobTitle, terms) {
  if (!terms.length) return true
  const t = String(jobTitle || '').toLowerCase()
  return terms.some(({ phrase, words }) => t.includes(phrase) || words.every((re) => re.test(t)))
}

function looksRemote(job) {
  return /remote|anywhere|work from home|wfh|distributed/i.test((job.location || '') + ' ' + (job.title || ''))
}

function dedupe(jobs) {
  // The same job seen through two sources always has two DIFFERENT URLs (boards.greenhouse.io/...
  // vs adzuna.com/land/...), so URL identity alone never catches cross-source duplicates. Also key
  // on company|title|city — direct sources are merged first, so the direct link wins over the same
  // job's aggregator link. City keeps a company's multi-location postings of the same title distinct.
  const seenUrl = new Set()
  const seenJob = new Set()
  const out = []
  for (const j of jobs) {
    if (!j || !j.title) continue
    const urlKey = (j.url || '').split('?')[0].toLowerCase()
    const city = String(j.location || '').split(',')[0].toLowerCase().replace(/[^a-z]/g, '') || (looksRemote(j) ? 'remote' : '')
    const jobKey = (j.company && j.title) ? (j.company + '|' + j.title + '|' + city).toLowerCase() : ''
    if ((urlKey && seenUrl.has(urlKey)) || (jobKey && seenJob.has(jobKey))) continue
    if (urlKey) seenUrl.add(urlKey)
    if (jobKey) seenJob.add(jobKey)
    out.push(j)
  }
  return out
}

// ── Handler ──────────────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const origin = req.headers.origin
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body || {}
  const country = (String(body.country || 'us').toLowerCase().replace(/[^a-z]/g, '')) || 'us'
  // `where` accepts pipe-separated alternatives ("Katy, TX|Cypress|Sugar Land|Houston") so
  // "remote preferred, hybrid near home OK" is expressible: the LOCAL substring filter accepts a
  // job matching ANY alternative, while the geo-aware upstream APIs (Adzuna/Jooble/etc, which
  // radius-search a single place) get only the FIRST segment. Must run before the fetch tasks are
  // created — they read body.where. No '|' → exactly the old single-substring behavior.
  const whereAlts = String(body.where || '').toLowerCase().split('|').map((s) => s.trim()).filter(Boolean)
  if (whereAlts.length > 1) body.where = String(body.where).split('|')[0].trim()

  try {
    // ── categories (Adzuna) ──
    if (body.action === 'categories') {
      const APP_ID = process.env.ADZUNA_APP_ID, APP_KEY = process.env.ADZUNA_APP_KEY
      if (!APP_ID || !APP_KEY) return res.status(200).json({ categories: [] })
      const auth = `app_id=${encodeURIComponent(APP_ID)}&app_key=${encodeURIComponent(APP_KEY)}`
      const d = await fetchJson(`${ADZUNA_BASE}/${country}/categories?${auth}`, { ms: 8000 })
      const categories = ((d && d.results) || [])
        .filter((c) => c && c.tag && c.label).map((c) => ({ tag: c.tag, label: c.label }))
      return res.status(200).json({ categories })
    }

    // ── search (multi-source) ──
    const titles = String(body.titles || body.what || '').trim()
    const industry = String(body.industry || '').trim()
    // "Any industry" / "All Industries": sweep every field at once (the aggregators aren't
    // industry-scoped anyway; this widens the curated/registry board coverage to the union across
    // industries, reads the cross-industry crawl cache, and drops the industry word from discovery).
    // Seed capped so a cache-miss fallback can't fan out live to every board in one request.
    const isAll = /^(all industries|any industry)$/i.test(industry) || !industry
    const seedBoards = isAll ? Object.values(INDUSTRY_BOARDS).flat().slice(0, 40) : (INDUSTRY_BOARDS[industry] || [])

    // Kick off every source in parallel.
    const tasks = []
    tasks.push(fetchAdzuna(body, country).then((r) => ({ kind: 'adzuna', ...r })).catch(() => ({ kind: 'adzuna', results: [] })))
    tasks.push(fetchJSearch(titles || industry, body.where, body.remote, country).then((r) => ({ kind: 'jsearch', ...r })).catch(() => ({ kind: 'jsearch', results: [] })))
    tasks.push(cached('himalayas', fetchHimalayas).then((results) => ({ kind: 'himalayas', results })).catch(() => ({ kind: 'himalayas', results: [] })))
    tasks.push(cached('themuse', fetchTheMuse).then((results) => ({ kind: 'themuse', results })).catch(() => ({ kind: 'themuse', results: [] })))
    tasks.push(fetchJooble(titles || industry, body.where).then((results) => ({ kind: 'jooble', results })).catch(() => ({ kind: 'jooble', results: [] })))
    tasks.push(fetchCareerjet(titles || industry, body.where, country).then((results) => ({ kind: 'careerjet', results })).catch(() => ({ kind: 'careerjet', results: [] })))
    // Reed is UK-only; USAJobs is US federal-only -- calling either outside its own country would
    // just mix in irrelevant results, so each only fires for the matching country selection.
    if (country === 'gb') tasks.push(fetchReed(titles || industry, body.where).then((results) => ({ kind: 'reed', results })).catch(() => ({ kind: 'reed', results: [] })))
    if (country === 'us') tasks.push(fetchUsaJobs(titles || industry, body.where).then((results) => ({ kind: 'usajobs', results })).catch(() => ({ kind: 'usajobs', results: [] })))
    // Cache-hit skips the live per-company ATS fetch entirely (the slow/heavy part of every search);
    // any miss (table not set up, industry never crawled, request failed) transparently falls back to
    // today's always-live fetchBoards(), so this can only ever make results faster, never worse.
    if (seedBoards.length) {
      tasks.push((async () => {
        const cachedRows = await fetchBoardsFromCache(isAll ? null : industry)
        if (cachedRows) return { kind: 'ats', results: cachedRows, atsFromCache: true }
        const live = await fetchBoards(seedBoards).catch(() => [])
        return { kind: 'ats', results: live, atsFromCache: false }
      })().catch(() => ({ kind: 'ats', results: [], atsFromCache: false })))
    }
    // Discovery is best-effort; only when we have a query to search on. In All-Industries mode the
    // industry word is dropped from the query (it isn't a real search term).
    const discoveryQuery = [titles, isAll ? '' : industry].filter(Boolean).join(' ').trim()
    if (discoveryQuery && (BRAVE_KEY || TAVILY_KEY)) {
      const { boards, customPages } = await cached('discover:' + discoveryQuery.toLowerCase(), () => discoverBoards(discoveryQuery))
      if (boards.length) tasks.push(fetchBoards(boards).then((results) => ({ kind: 'discovered', results })).catch(() => ({ kind: 'discovered', results: [] })))
      // Custom (non-ATS) career pages: one Jina fetch + one Groq extraction call each, bounded to a
      // handful of candidates so this can never meaningfully threaten the request's time/cost budget.
      if (customPages.length && GROQ_KEY) {
        tasks.push(
          Promise.allSettled(customPages.map((p) => cached('custom:' + p.url, () => fetchCustomCareerPage(p))))
            .then((rs) => ({ kind: 'custom', results: rs.flatMap((r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : [])) }))
            .catch(() => ({ kind: 'custom', results: [] }))
        )
      }
    }

    const settled = await Promise.allSettled(tasks)
    const bucket = {
      adzuna: [], jsearch: [], himalayas: [], ats: [], discovered: [], custom: [],
      themuse: [], jooble: [], careerjet: [], reed: [], usajobs: [],
    }
    let adzunaConfigured = false, jsearchConfigured = false, jsearchError = null, jsearchRaw = 0
    let atsFromCache = false
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue
      const v = s.value
      if (v.kind === 'adzuna') { adzunaConfigured = !!v.configured; bucket.adzuna = v.results || [] }
      else if (v.kind === 'jsearch') { jsearchConfigured = !!v.configured; bucket.jsearch = v.results || []; jsearchError = v.error || null; jsearchRaw = v.raw || 0 }
      else if (v.kind === 'himalayas') bucket.himalayas = v.results || []
      else if (v.kind === 'ats') { bucket.ats = v.results || []; atsFromCache = !!v.atsFromCache }
      else if (v.kind === 'discovered') bucket.discovered = v.results || []
      else if (v.kind === 'custom') bucket.custom = v.results || []
      else if (v.kind === 'themuse') bucket.themuse = v.results || []
      else if (v.kind === 'jooble') bucket.jooble = v.results || []
      else if (v.kind === 'careerjet') bucket.careerjet = v.results || []
      else if (v.kind === 'reed') bucket.reed = v.results || []
      else if (v.kind === 'usajobs') bucket.usajobs = v.results || []
    }

    // Filter the non-Adzuna sources by title + remote/location + salary/contract (Adzuna gets these
    // filters server-side via its API params; the direct sources ranked FIRST must honor them too).
    const terms = tokenizeTitles(titles)
    const wantRemote = !!body.remote
    const salaryFloor = parseInt(body.salaryMin, 10) || 0
    const wantFullTime = !!body.fullTime
    const filterJob = (j) => {
      if (!titleMatches(j.title, terms)) return false
      if (wantRemote && !looksRemote(j)) return false
      if (whereAlts.length && !wantRemote) {
        const loc = (j.location || '').toLowerCase()
        if (loc && !whereAlts.some((w) => loc.includes(w)) && !looksRemote(j)) return false
      }
      // Salary floor drops only postings whose KNOWN top-of-range is below it — most direct boards
      // don't publish salary, and those stay in rather than vanishing silently.
      if (salaryFloor) {
        const top = j.salaryMax || j.salaryMin
        if (top && top < salaryFloor) return false
      }
      if (wantFullTime && j.contractTime && /part[ _-]?time|intern(ship)?\b|contract|temporary|seasonal/i.test(String(j.contractTime))) return false
      return true
    }
    const boardResults = [...bucket.ats, ...bucket.discovered, ...bucket.custom].filter(filterJob)
    const jsearchResults = bucket.jsearch.filter(filterJob)
    const himalayasResults = bucket.himalayas.filter(filterJob)
    const themuseResults = bucket.themuse.filter(filterJob)
    const joobleResults = bucket.jooble.filter(filterJob)
    const careerjetResults = bucket.careerjet.filter(filterJob)
    const reedResults = bucket.reed.filter(filterJob)
    const usajobsResults = bucket.usajobs.filter(filterJob)

    // Mark each result direct/aggregator; ATS boards + Himalayas + USAJobs are direct (USAJobs IS the
    // federal government's own official job board, not a third-party aggregator over other sites'
    // postings, the same way a company's own Workday board is direct). The Muse/Jooble/Careerjet/Reed
    // are aggregators over other companies' postings, same as Adzuna.
    boardResults.forEach((j) => { j.direct = true })
    himalayasResults.forEach((j) => { j.direct = true })
    usajobsResults.forEach((j) => { j.direct = true })
    bucket.adzuna.forEach((j) => { j.direct = false })
    themuseResults.forEach((j) => { j.direct = false })
    joobleResults.forEach((j) => { j.direct = false })
    careerjetResults.forEach((j) => { j.direct = false })
    reedResults.forEach((j) => { j.direct = false })

    // Dedupe preferring DIRECT-link sources over any aggregator's link for the same job.
    let merged = dedupe([
      ...boardResults, ...jsearchResults, ...himalayasResults, ...usajobsResults,
      ...bucket.adzuna, ...themuseResults, ...joobleResults, ...careerjetResults, ...reedResults,
    ])

    // Honest host-based direct flag BEFORE ranking too — rank() used to read the sources'
    // self-reported flags, so a mis-flagged row (e.g. a JSearch link to an aggregator) ranked on
    // the wrong tier even though the final labeling pass would correct its badge. (The recompute
    // runs again after the Adzuna resolve pass below, since resolution changes hosts.)
    merged.forEach((j) => { j.direct = isEmployerHost(safeHost(j.url)) })

    // Order: direct links first (company boards / JSearch-direct / Himalayas), Adzuna last;
    // freshest first within each rank so the cap keeps recent postings, not one giant board's tail.
    const cap = Math.min(80, Math.max(20, parseInt(body.resultsPerPage, 10) || 50))
    const rank = (j) => (j.source === 'adzuna' ? 2 : (j.direct === false ? 1 : 0))
    const postedAt = (j) => { const t = Date.parse(j.created || ''); return isNaN(t) ? 0 : t }
    merged.sort((a, b) => (rank(a) - rank(b)) || (postedAt(b) - postedAt(a)))
    merged = merged.slice(0, cap)

    // Best-effort: resolve the SHOWN Adzuna rows to the employer URL so Apply skips Adzuna's login
    // wall. Only runs when Adzuna rows survived (all-direct searches pay nothing); bounded worker
    // pool + hard 7s deadline so it can never threaten the 60s budget. A resolved row becomes a
    // direct-apply row (its Adzuna link kept as `adzunaUrl` fallback); unresolved rows stay labeled.
    const adzunaRows = merged.filter((j) => j.source === 'adzuna' && j.url && isAdzunaHost(safeHost(j.url)))
    if (adzunaRows.length) {
      const deadline = Date.now() + 7000
      let idx = 0
      const worker = async () => {
        while (idx < adzunaRows.length && Date.now() < deadline) {
          const j = adzunaRows[idx++]
          const real = await resolveAdzunaUrl(j.url, deadline).catch(() => null)
          if (real) { j.adzunaUrl = j.url; j.url = real; j.resolved = true; j.direct = true }
        }
      }
      await Promise.allSettled(Array.from({ length: Math.min(6, adzunaRows.length) }, worker))
    }

    // Recompute `direct` by the FINAL host for every row — honest labeling/filtering regardless of a
    // source's own flag: resolved Adzuna rows and JSearch links to an ATS count as direct; links to
    // adzuna/linkedin/indeed do not.
    merged.forEach((j) => { j.direct = isEmployerHost(safeHost(j.url)) })

    return res.status(200).json({
      results: merged,
      count: merged.length,
      sources: {
        adzuna: bucket.adzuna.length, adzunaConfigured,
        jsearch: jsearchResults.length, jsearchConfigured, jsearchError, jsearchRaw,
        himalayas: himalayasResults.length,
        ats: bucket.ats.length, atsFromCache,
        discovered: bucket.discovered.length,
        custom: bucket.custom.length,
        themuse: themuseResults.length,
        jooble: joobleResults.length, joobleConfigured: !!JOOBLE_KEY,
        careerjet: careerjetResults.length, careerjetConfigured: !!CAREERJET_AFFID,
        reed: reedResults.length, reedConfigured: !!REED_API_KEY,
        usajobs: usajobsResults.length, usajobsConfigured: !!(USAJOBS_API_KEY && USAJOBS_EMAIL),
        directCount: merged.filter((j) => j.direct !== false).length,
      },
    })
  } catch (err) {
    console.error('jobs proxy failed:', err && err.message)
    return res.status(502).json({ error: 'Job search failed: ' + ((err && err.message) || 'unknown') })
  }
}
