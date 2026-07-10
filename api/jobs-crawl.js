// Wagner-GPT — scheduled crawl for the Jobs tab's ATS-board cache (item #3 of the "3 to 8" roadmap:
// a persistent Supabase-backed index instead of live-scraping every search). Triggered by Vercel
// Cron (see vercel.json); can also be triggered manually via GET/POST once CRON_SECRET is set.
//
// Scope (v1): re-crawls every industry's curated ATS boards (INDUSTRY_BOARDS) and upserts the
// results into job_crawl_cache (see supabase-job-crawl-schema.sql). api/jobs.js's search handler
// reads from that cache instead of live-fetching every company's board on every request.
//
// Discovery (Brave/Tavily) and custom-page AI extraction (Jina+Groq) stay LIVE-ONLY, bounded per
// search request exactly as today -- they're the slow/costly part (rate-limited search APIs, paid
// Groq calls), and re-running them on a fixed schedule for all 11 industries regardless of demand
// would burn that budget on industries nobody's actually searching. ATS boards are free public JSON
// with no such cost, so crawling all of them up front is a clean win with no downside.
//
// Requires no new env var to function (falls back to the same public anon key + permissive RLS
// already used by src/lib/supabase.js), but CRON_SECRET is strongly recommended -- Vercel Cron sends
// it automatically as `Authorization: Bearer $CRON_SECRET` when the env var is set, and without it
// this endpoint would be triggerable by anyone who finds the URL (low-cost abuse: it can't leak data
// or spend paid-API budget, but it can still burn your Vercel function-invocation minutes).
//
// Also crawls ats_board_registry (api/jobs-import.js's bulk-import output, see
// supabase-ats-board-registry-schema.sql) alongside the hand-curated INDUSTRY_BOARDS seed -- this is
// how imported boards actually start contributing to search results, not just sitting in the registry.

import { INDUSTRY_BOARDS, fetchBoards, upsertCrawlCache } from './jobs.js'

export const config = { maxDuration: 60 }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mfzzcrsgslkpvzvtveao.supabase.co'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7-pjVrDnXLzAAjxXawBpWw_mCVTSR-Z'

// Capped, NOT "every classified board for this industry" -- as api/jobs-import.js's bulk import runs,
// a single industry could eventually hold thousands of registry rows, and this whole function shares
// one 60s budget across all 11 industries with no concurrency throttle inside fetchBoards(). Ordered
// by job_count desc so the most active boards (most likely to actually contribute a result) get
// crawled first; anything past the cap just waits for a future run instead of risking a timeout or
// tripping rate limits on Greenhouse/Lever/etc's shared public endpoints. Deliberately conservative
// for this first rollout (worst case ~50*11=550 extra requests on top of the existing curated-seed
// baseline, on top of whatever's still running from the un-throttled fetchBoards fan-out) -- raise
// once a live run is confirmed to complete cleanly within budget.
const REGISTRY_BOARDS_PER_INDUSTRY = 50

async function fetchRegistryBoards(industry) {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/ats_board_registry?status=eq.classified&industry=eq.${encodeURIComponent(industry)}` +
      `&order=job_count.desc&limit=${REGISTRY_BOARDS_PER_INDUSTRY}&select=ats,slug,tenant,data_center,site,company_name`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }, signal: AbortSignal.timeout(8000) }
    )
    if (!r.ok) return []
    const rows = await r.json()
    if (!Array.isArray(rows)) return []
    return rows.map((row) => (
      row.ats === 'workday'
        ? { ats: 'workday', tenant: row.tenant, dataCenter: row.data_center, site: row.site, name: row.company_name }
        : { ats: row.ats, slug: row.slug, name: row.company_name }
    ))
  } catch { return [] }
}

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || ''
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
  }

  const industries = Object.keys(INDUSTRY_BOARDS)
  const settled = await Promise.allSettled(
    industries.map(async (industry) => {
      const registryBoards = await fetchRegistryBoards(industry)
      const boards = [...INDUSTRY_BOARDS[industry], ...registryBoards]
      const jobs = await fetchBoards(boards)
      const { ok, count } = await upsertCrawlCache(industry, jobs)
      return { industry, boardCount: boards.length, registryBoardCount: registryBoards.length, fetched: jobs.length, upserted: count, ok }
    })
  )
  const summary = settled.map((s, i) => (
    s.status === 'fulfilled' ? s.value : { industry: industries[i], boardCount: 0, registryBoardCount: 0, fetched: 0, upserted: 0, ok: false, error: String(s.reason && s.reason.message || s.reason) }
  ))
  const totalFetched = summary.reduce((n, s) => n + (s.fetched || 0), 0)
  const totalUpserted = summary.reduce((n, s) => n + (s.upserted || 0), 0)
  console.log('[jobs-crawl] done', JSON.stringify(summary))

  return res.status(200).json({ ok: true, industries: industries.length, totalFetched, totalUpserted, summary })
}
