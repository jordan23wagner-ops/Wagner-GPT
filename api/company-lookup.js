// ── Company lookup: jobs straight from ONE company's own board/careers page ─────────────────────
// A separate, additive endpoint (POST { company: "Anthropic" } or { company: "anthropic.com" })
// that answers "what is THIS company hiring for right now?" from the company's own source — never
// a third-party aggregator's index. Deliberately its own endpoint + its own UI button for the QA
// phase; consolidation into the main multi-source search comes later, once it's proven.
//
// Resolution order (cheapest, most authoritative first):
//   1. INDUSTRY_BOARDS seed — the hand-curated per-industry list in api/jobs.js. Exact/substring
//      name match, no network involved in the match itself.
//   2. ats_board_registry — the bulk-imported Supabase table (~2.7k validated boards). Name/slug
//      ilike match, then fetched via the same ATS_FETCHERS the main search uses.
//   3. One targeted web search ("«company» careers jobs") — the SAME braveOrTavily helper the main
//      search's discovery uses. Results are picked apart two ways, same as discovery does:
//      boardsFromUrls() recognizes known-ATS urls (company on Greenhouse/Lever/... just not in our
//      registry), customCareerPageCandidates() flags the company's own custom page.
//   4. If the input LOOKS like a domain, also try https://{domain}/careers and /jobs directly.
//   5. Custom pages go through the EXISTING fetchCustomCareerPage — schema.org JobPosting
//      structured data first (free, authoritative), Groq LLM extraction with the verbatim-URL
//      anti-hallucination check only as a fallback. Reused verbatim, not reimplemented.
//
// Every response carries { method } ('seed' | 'registry' | 'ats-discovered' | 'scraped') so the QA
// UI can badge exactly HOW each result set was resolved, plus { tried } for the not-found case so
// "no jobs found" is diagnosable rather than a dead end.
import {
  INDUSTRY_BOARDS, ATS_FETCHERS, fetchBoards, slugName,
  braveOrTavily, boardsFromUrls, customCareerPageCandidates, fetchCustomCareerPage,
} from './jobs.js'

export const config = { maxDuration: 60 }

// Same publishable (anon, RLS-protected) key convention as api/jobs.js / api/jobs-crawl.js.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mfzzcrsgslkpvzvtveao.supabase.co'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7-pjVrDnXLzAAjxXawBpWw_mCVTSR-Z'

const norm = (s) => String(s || '').trim().toLowerCase()
// "anthropic.com", "www.anthropic.com/careers" → looks like a domain; "Anthropic" doesn't.
function asDomain(input) {
  const s = norm(input).replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s) ? s : null
}
// "anthropic.com" → "anthropic"; used to match domains against seed/registry names and slugs.
function domainStem(domain) { return String(domain || '').split('.')[0] }

// 1. Hand-curated seed: exact name match first, then whole-word prefix (so "stripe" matches
// "Stripe" but "an" doesn't match "Anthropic"). Also match the ATS slug itself.
function seedMatches(q) {
  const stem = asDomain(q) ? domainStem(asDomain(q)) : norm(q)
  const out = []
  const seen = new Set() // the same company appears under several industries (e.g. Stripe) — fetch its board once, not once per industry
  for (const boards of Object.values(INDUSTRY_BOARDS)) {
    for (const b of boards) {
      const name = norm(b.name)
      const slug = norm(b.slug || b.tenant || '')
      const key = `${b.ats}:${slug}`
      if (seen.has(key)) continue
      if (name === stem || slug === stem || name.startsWith(stem + ' ')) { seen.add(key); out.push(b) }
    }
  }
  return out
}

// 2. Bulk-imported registry (validated OR classified rows — classification only adds an industry
// label; a validated-but-unclassified board is just as fetchable).
// Matching is deliberately STRICT: a bare `ilike *stem*` substring filter returned other
// companies' boards as if they were the requested one — confirmed live, "fly.io" matched
// Flynncompanies, Flywire, AppsFlyer, Flywheel and Zipline, and the endpoint served THEIR jobs
// under a fly.io lookup. Returning the wrong company's jobs is strictly worse than returning
// nothing, so a row must match exactly (name or slug) or as a whole-word prefix of the name.
async function registryMatches(q) {
  const stem = asDomain(q) ? domainStem(asDomain(q)) : norm(q)
  try {
    // The prefix ilike keeps the query cheap server-side; the real gate is the post-filter below.
    const filter = `or=(company_name.ilike.${encodeURIComponent(stem + '*')},slug.ilike.${encodeURIComponent(stem)})`
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ats_board_registry?status=in.(validated,classified)&${filter}` +
      `&order=job_count.desc&limit=10&select=ats,slug,tenant,data_center,site,company_name,job_count`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(8000) }
    )
    if (!r.ok) return []
    const rows = await r.json()
    if (!Array.isArray(rows)) return []
    const strict = rows.filter((row) => {
      const name = norm(row.company_name)
      const slug = norm(row.slug || row.tenant || '')
      return name === stem || slug === stem || name.startsWith(stem + ' ')
    })
    // Exact name match outranks whole-word-prefix matches ("Stripe" beats "Stripe Events LLC").
    strict.sort((a, b) => (norm(b.company_name) === stem) - (norm(a.company_name) === stem))
    return strict.map((row) => (
      row.ats === 'workday'
        ? { ats: 'workday', tenant: row.tenant, dataCenter: row.data_center, site: row.site, name: row.company_name }
        : { ats: row.ats, slug: row.slug, name: row.company_name }
    ))
  } catch { return [] }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  const company = String((req.body && req.body.company) || '').trim()
  if (!company || company.length > 120) { res.status(400).json({ error: 'Pass { company: "name or domain" }.' }); return }

  const tried = []
  const finish = (jobs, method) => {
    // Belt-and-suspenders URL dedupe (seed dedupe above already prevents the common cause — the
    // same board listed under several industries — but two DIFFERENT matched boards can still
    // surface the same posting).
    const seen = new Set()
    const unique = jobs.filter((j) => {
      const k = (j.url || j.id || '').toLowerCase()
      if (!k || seen.has(k)) return false
      seen.add(k)
      return true
    })
    // Tag every job so the UI can badge lookup results distinctly during QA; `direct: true` is
    // honest here by construction — every path below IS the company's own board/page.
    res.status(200).json({
      results: unique.map((j) => ({ ...j, direct: true, companyLookup: true })),
      method, company, tried,
    })
  }

  // ── 1+2: known boards (seed, then registry) — no scraping involved ──
  const seed = seedMatches(company)
  if (seed.length) {
    tried.push(`seed match: ${seed.map((b) => `${b.ats}:${b.slug || b.tenant}`).join(', ')}`)
    const jobs = await fetchBoards(seed.slice(0, 3))
    if (jobs.length) { finish(jobs, 'seed'); return }
  }
  const reg = await registryMatches(company)
  if (reg.length) {
    tried.push(`registry match: ${reg.map((b) => `${b.ats}:${b.slug || b.tenant}`).join(', ')}`)
    const jobs = await fetchBoards(reg.slice(0, 3))
    if (jobs.length) { finish(jobs, 'registry'); return }
  }

  // ── 3: one targeted search, picked apart the same two ways discovery uses ──
  const domain = asDomain(company)
  const searchQ = domain ? `${domainStem(domain)} careers jobs site:${domain} OR "${domainStem(domain)}" careers` : `"${company}" careers jobs`
  const urls = await braveOrTavily(searchQ, 10)
  tried.push(`search: ${urls.length} results`)

  const discovered = boardsFromUrls(urls).slice(0, 3)
  if (discovered.length) {
    tried.push(`ats urls in results: ${discovered.map((b) => `${b.ats}:${b.slug || b.tenant}`).join(', ')}`)
    const jobs = await fetchBoards(discovered)
    if (jobs.length) { finish(jobs, 'ats-discovered'); return }
  }

  // ── 4+5: the company's own custom page — structured data first, AI extraction fallback ──
  const candidates = customCareerPageCandidates(urls, 3)
  if (domain) {
    // Try the obvious paths on the company's own domain FIRST — more authoritative than whatever
    // the search surfaced, and free to attempt.
    candidates.unshift(
      { url: `https://${domain}/careers`, name: slugName(domainStem(domain)) },
      { url: `https://${domain}/jobs`, name: slugName(domainStem(domain)) },
    )
  }
  // Keep only candidates on the company's own domain when we KNOW the domain — a "«name» careers"
  // search happily returns Indeed/LinkedIn profile pages, which are exactly what this feature
  // exists to avoid.
  const scoped = domain ? candidates.filter((c) => (c.url || '').includes(domain)) : candidates
  for (const cand of scoped.slice(0, 4)) {
    tried.push(`scrape: ${cand.url}`)
    try {
      // name: '' on purpose. finalizeCustomJobCandidates rejects postings whose company EQUALS the
      // passed name -- the right guard for DISCOVERY (where "the site's own name as employer" is
      // the signature of a job board hosting other companies' postings, e.g. the Rigzone case its
      // comment documents), but exactly backwards for a TARGETED lookup: on anthropic.com/careers,
      // every real posting's hiringOrganization IS Anthropic. Passing an empty name disarms only
      // that one equality check; every other validation (real per-posting URL, non-empty company,
      // shared-URL dedupe, expiry filtering) still applies unchanged.
      const jobs = await fetchCustomCareerPage({ url: cand.url, name: '' })
      if (jobs.length) { finish(jobs, 'scraped'); return }
    } catch { /* keep trying the next candidate */ }
  }

  res.status(200).json({
    results: [], company, tried,
    message: `Couldn't find a careers page with open listings for "${company}". If you know their careers URL, try entering their domain (e.g. company.com) instead of the name.`,
  })
}
