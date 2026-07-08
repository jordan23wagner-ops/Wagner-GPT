// Wagner-GPT jobs proxy — multi-source job search.
//
// Backs the Job-Assistant extension's Job Search AND the Wagner-GPT "Jobs" tab. Aggregates jobs
// from several sources and returns ONE unified result shape so callers stay source-agnostic:
//   1. Adzuna              — broad aggregator (needs ADZUNA_APP_ID / ADZUNA_APP_KEY).
//   2. Company ATS boards  — public JSON from Greenhouse / Lever / Ashby / Workable career pages,
//                            selected per industry from INDUSTRY_BOARDS (this is the "jobs from
//                            company sites in your industry" ask — these ARE the companies' own
//                            career sites, just via their public JSON endpoints).
//   3. Discovery (opt)     — Brave/Tavily to find more ATS boards for the query, then fetch them
//                            (uses BRAVE_KEY / TAVILY_KEY if present; silently skipped otherwise).
//   4. JSearch + Himalayas — direct-apply aggregators (JSearch needs a RapidAPI key).
//
// POST { action:'search', titles|what, industry, where, salaryMin, salaryMax, remote, fullTime,
//        country, resultsPerPage, category, page } -> { results:[...], count, sources:{...} }
// POST { action:'categories', country }                  -> { categories:[{ tag, label }] }
//
// Result item: { id, title, company, location, salaryMin, salaryMax, salaryPredicted, url,
//                category, categoryTag, contractTime, description, created, source }

export const config = { maxDuration: 60 }

const ADZUNA_BASE = 'https://api.adzuna.com/v1/api/jobs'

// ── Curated company ATS boards per industry ─────────────────────────────────────────────────────
// industry name (matches the client's INDUSTRIES labels) -> [{ ats, slug, name }].
// ats is one of: greenhouse | lever | ashby | workable. slug is the company's board id on that ATS.
// Seed set of well-known companies; extend freely — adding a row here immediately widens coverage.
const INDUSTRY_BOARDS = {
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

function slugName(slug) {
  return String(slug || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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
const ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|brassring|jobvite|taleo|workable|bamboohr|recruitee)\.(com|io|co|net)/i

// ── Adzuna → employer URL resolution (safe, best-effort) ─────────────────────────────────────────
// Adzuna's redirect_url login-walls logged-out users (adzuna.com/details/…?apply=1&after_login → a
// Facebook/Google/email modal), so it never reaches the employer. We resolve the SHOWN Adzuna rows
// server-side to the real employer URL. Deliberately NOT a public endpoint (no ?url= SSRF surface):
// this only ever runs on redirect_urls WE got from the Adzuna API. Defense-in-depth: reject private
// IP literals on every hop, read only redirect Locations (no HTML scraping), and accept a target
// ONLY when it lands on a host that is neither Adzuna nor any other aggregator.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const AGGREGATOR_HOST_RE = /(^|\.)(adzuna|indeed|glassdoor|ziprecruiter|simplyhired|monster|dice|talent|jooble|neuvoo|jobgether|lensa|whatjobs|appcast|jobrapido|jobcase|careerjet|careerbuilder|snagajob|jobisjob|joblist|getwork|resume-library)\.(com|net|co\.uk|ca|com\.au|de|fr|io|org)$/i
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
  const primary = pick(j, ['job_apply_link', 'apply_link', 'job_google_link', 'url'])
  if (primary) return { url: primary, direct: !!(j.job_apply_is_direct || j.apply_is_direct) }
  return { url: opts[0] ? linkOf(opts[0]) : '', direct: false }
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

const ATS_FETCHERS = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby, workable: fetchWorkable, smartrecruiters: fetchSmartRecruiters, recruitee: fetchRecruitee }

async function fetchBoards(boards) {
  const settled = await Promise.allSettled(boards.map((b) => {
    const fn = ATS_FETCHERS[b.ats]
    return fn ? cached(b.ats + ':' + b.slug, () => fn(b)) : Promise.resolve([])
  }))
  return settled.flatMap((s) => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []))
}

// ── Discovery: find more ATS boards for the query via Brave/Tavily ───────────────────────────────

function boardsFromUrls(urls) {
  const seen = new Set()
  const out = []
  const patterns = [
    { re: /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9-]+)/i, ats: 'greenhouse' },
    { re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9-]+)/i, ats: 'greenhouse' },
    { re: /jobs\.lever\.co\/([a-z0-9-]+)/i, ats: 'lever' },
    { re: /jobs\.ashbyhq\.com\/([a-z0-9-]+)/i, ats: 'ashby' },
    { re: /([a-z0-9-]+)\.workable\.com/i, ats: 'workable' },
  ]
  for (const u of urls) {
    for (const p of patterns) {
      const m = String(u || '').match(p.re)
      if (m && m[1]) {
        const key = p.ats + ':' + m[1].toLowerCase()
        if (!seen.has(key) && !/^(www|apply|jobs|boards|api)$/i.test(m[1])) {
          seen.add(key)
          out.push({ ats: p.ats, slug: m[1].toLowerCase(), name: slugName(m[1]) })
        }
      }
    }
  }
  return out
}

// Accept either the _KEY convention or the bare name (this project's Vercel uses `Brave`/`Tavily`).
const BRAVE_KEY = process.env.BRAVE_KEY || process.env.Brave || process.env.BRAVE
const TAVILY_KEY = process.env.TAVILY_KEY || process.env.TAVILY || process.env.TAVILY_API_KEY || process.env.Tavily

async function discoverBoards(query) {
  const braveKey = BRAVE_KEY
  const tavilyKey = TAVILY_KEY
  const q = `${query} careers (site:greenhouse.io OR site:lever.co OR site:ashbyhq.com)`
  let urls = []
  try {
    if (braveKey) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&safesearch=moderate`
      const r = await fetch(url, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': braveKey }, signal: AbortSignal.timeout(6000) })
      if (r.ok) { const d = await r.json(); urls = (d?.web?.results || []).map((x) => x.url) }
    } else if (tavilyKey) {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query: q, max_results: 10, search_depth: 'basic' }),
        signal: AbortSignal.timeout(6000),
      })
      if (r.ok) { const d = await r.json(); urls = (d?.results || []).map((x) => x.url) }
    }
  } catch { /* discovery is best-effort */ }
  return boardsFromUrls(urls).slice(0, 8)
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
  if (body.where) params.set('where', String(body.where))
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
      const words = phrase.split(/\s+/).filter((w) => w.length > 2)
      return words.length ? [{ phrase, words }] : []
    })
}

// Keep a job if any requested title phrase overlaps its title (all significant words of at least one
// phrase are present, OR the whole phrase is a substring). Empty title filter keeps everything.
function titleMatches(jobTitle, terms) {
  if (!terms.length) return true
  const t = String(jobTitle || '').toLowerCase()
  return terms.some(({ phrase, words }) => t.includes(phrase) || words.every((w) => t.includes(w)))
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
    const seedBoards = INDUSTRY_BOARDS[industry] || []

    // Kick off every source in parallel.
    const tasks = []
    tasks.push(fetchAdzuna(body, country).then((r) => ({ kind: 'adzuna', ...r })).catch(() => ({ kind: 'adzuna', results: [] })))
    tasks.push(fetchJSearch(titles || industry, body.where, body.remote, country).then((r) => ({ kind: 'jsearch', ...r })).catch(() => ({ kind: 'jsearch', results: [] })))
    tasks.push(cached('himalayas', fetchHimalayas).then((results) => ({ kind: 'himalayas', results })).catch(() => ({ kind: 'himalayas', results: [] })))
    if (seedBoards.length) tasks.push(fetchBoards(seedBoards).then((results) => ({ kind: 'ats', results })).catch(() => ({ kind: 'ats', results: [] })))
    // Discovery is best-effort; only when we have a query to search on.
    const discoveryQuery = [titles, industry].filter(Boolean).join(' ').trim()
    if (discoveryQuery && (BRAVE_KEY || TAVILY_KEY)) {
      const boards = await cached('discover:' + discoveryQuery.toLowerCase(), () => discoverBoards(discoveryQuery))
      if (boards.length) tasks.push(fetchBoards(boards).then((results) => ({ kind: 'discovered', results })).catch(() => ({ kind: 'discovered', results: [] })))
    }

    const settled = await Promise.allSettled(tasks)
    const bucket = { adzuna: [], jsearch: [], himalayas: [], ats: [], discovered: [] }
    let adzunaConfigured = false, jsearchConfigured = false, jsearchError = null, jsearchRaw = 0
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue
      const v = s.value
      if (v.kind === 'adzuna') { adzunaConfigured = !!v.configured; bucket.adzuna = v.results || [] }
      else if (v.kind === 'jsearch') { jsearchConfigured = !!v.configured; bucket.jsearch = v.results || []; jsearchError = v.error || null; jsearchRaw = v.raw || 0 }
      else if (v.kind === 'himalayas') bucket.himalayas = v.results || []
      else if (v.kind === 'ats') bucket.ats = v.results || []
      else if (v.kind === 'discovered') bucket.discovered = v.results || []
    }

    // Filter the non-Adzuna sources by title + remote/location + salary/contract (Adzuna gets these
    // filters server-side via its API params; the direct sources ranked FIRST must honor them too).
    const terms = tokenizeTitles(titles)
    const wantRemote = !!body.remote
    const where = String(body.where || '').trim().toLowerCase()
    const salaryFloor = parseInt(body.salaryMin, 10) || 0
    const wantFullTime = !!body.fullTime
    const filterJob = (j) => {
      if (!titleMatches(j.title, terms)) return false
      if (wantRemote && !looksRemote(j)) return false
      if (where && !wantRemote) {
        const loc = (j.location || '').toLowerCase()
        if (loc && !loc.includes(where) && !looksRemote(j)) return false
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
    const boardResults = [...bucket.ats, ...bucket.discovered].filter(filterJob)
    const jsearchResults = bucket.jsearch.filter(filterJob)
    const himalayasResults = bucket.himalayas.filter(filterJob)

    // Mark each result direct/aggregator; ATS boards + Himalayas are always direct.
    boardResults.forEach((j) => { j.direct = true })
    himalayasResults.forEach((j) => { j.direct = true })
    bucket.adzuna.forEach((j) => { j.direct = false })

    // Dedupe preferring DIRECT-link sources over Adzuna's aggregator link for the same job.
    let merged = dedupe([...boardResults, ...jsearchResults, ...himalayasResults, ...bucket.adzuna])

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
        ats: bucket.ats.length,
        discovered: bucket.discovered.length,
        directCount: merged.filter((j) => j.direct !== false).length,
      },
    })
  } catch (err) {
    console.error('jobs proxy failed:', err && err.message)
    return res.status(502).json({ error: 'Job search failed: ' + ((err && err.message) || 'unknown') })
  }
}
