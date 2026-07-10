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

import { INDUSTRY_BOARDS, fetchBoards, upsertCrawlCache } from './jobs.js'

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || ''
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
  }

  const industries = Object.keys(INDUSTRY_BOARDS)
  const settled = await Promise.allSettled(
    industries.map(async (industry) => {
      const jobs = await fetchBoards(INDUSTRY_BOARDS[industry])
      const { ok, count } = await upsertCrawlCache(industry, jobs)
      return { industry, fetched: jobs.length, upserted: count, ok }
    })
  )
  const summary = settled.map((s, i) => (
    s.status === 'fulfilled' ? s.value : { industry: industries[i], fetched: 0, upserted: 0, ok: false, error: String(s.reason && s.reason.message || s.reason) }
  ))
  const totalFetched = summary.reduce((n, s) => n + (s.fetched || 0), 0)
  const totalUpserted = summary.reduce((n, s) => n + (s.upserted || 0), 0)
  console.log('[jobs-crawl] done', JSON.stringify(summary))

  return res.status(200).json({ ok: true, industries: industries.length, totalFetched, totalUpserted, summary })
}
