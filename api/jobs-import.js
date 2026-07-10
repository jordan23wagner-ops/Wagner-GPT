// Wagner-GPT — bulk ATS-board import pipeline for the Jobs tab's company-board coverage.
//
// Distinct from api/jobs-crawl.js (which re-crawls a KNOWN, curated board list daily): this is a
// one-time-ish growth path that discovers NEW boards from a public dataset, validates each one live,
// and classifies survivors into the app's industries -- see supabase-ats-board-registry-schema.sql.
//
// Source dataset: Feashliaa/job-board-aggregator (github.com/Feashliaa/job-board-aggregator),
// data/*_companies.json -- Common-Crawl-derived slug lists for Greenhouse/Lever/Ashby/Workday,
// ~28,700 raw candidates combined. Licensed CC BY-NC 4.0 (attribution required; non-commercial use
// only -- fine for Wagner-GPT, a personal non-commercial tool). Most raw candidates will turn out
// dead (a Common Crawl snapshot isn't a liveness check) or junk (numeric/test slugs) -- that's
// exactly what live validation below is for; nothing reaches ats_board_registry as "validated"
// without a real, current job count from the real ATS API.
//
// Two actions, both resumable AND internally looping across many sub-batches per call (bounded by an
// overall wall-clock deadline, not a fixed sub-batch count) -- ~28,700 candidates at ~100/sub-batch
// would otherwise need ~290 separate manually-triggered calls, which isn't realistic to drive by
// hand. Each call now does as much work as fits in its own ~50s slice of Vercel's 60s ceiling, so the
// whole pipeline takes on the order of tens of calls, not hundreds:
//   action:'import'   {offset,limit,maxMs} -- validates candidates live via the SAME fetchGreenhouse/
//                       fetchLever/fetchAshby/fetchWorkday functions api/jobs.js uses for real search
//                       (not reimplemented here), upserting 'validated' or 'dead' rows as it goes.
//                       Call again with the returned nextOffset until done:true.
//   action:'classify'  {limit,maxMs} -- repeatedly pulls batches of 'validated' (unclassified) rows
//                       and one Groq call per batch assigns each an industry (+ cleans up the company
//                       name using real job-title context). Self-draining -- classified rows drop out
//                       of future batches automatically, no offset needed. Call repeatedly until
//                       done:true (done:false just means the deadline was hit with more still queued).
//
// See README's "Bulk board import" section for how to trigger this.

import { ATS_FETCHERS, slugName, INDUSTRY_BOARDS } from './jobs.js'

export const config = { maxDuration: 60 }

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mfzzcrsgslkpvzvtveao.supabase.co'
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_7-pjVrDnXLzAAjxXawBpWw_mCVTSR-Z'
const GROQ_KEY = process.env.GROQ_KEY || process.env.Groq || process.env.GROQ
const INDUSTRIES = Object.keys(INDUSTRY_BOARDS)

const DATASET_BASE = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data'
const DATASET_FILES = [
  { ats: 'greenhouse', file: 'greenhouse_companies.json' },
  { ats: 'lever', file: 'lever_companies.json' },
  { ats: 'ashby', file: 'ashby_companies.json' },
  { ats: 'workday', file: 'workday_companies.json' },
]

async function fetchJsonUrl(url, ms = 10000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

// Fixed order (greenhouse, lever, ashby, workday) so an {offset,limit} slice addresses the same
// candidates across calls within one import run -- the raw dataset files don't change mid-run.
async function loadCandidates() {
  const lists = await Promise.all(DATASET_FILES.map((d) => fetchJsonUrl(`${DATASET_BASE}/${d.file}`)))
  const out = []
  DATASET_FILES.forEach((d, i) => {
    const arr = Array.isArray(lists[i]) ? lists[i] : []
    for (const raw of arr) {
      if (d.ats === 'workday') {
        // Workday entries are "tenant|dataCenter|site" -- see WORKDAY_URL_RE in api/jobs.js for the
        // same three-part identity requirement (a plain slug isn't unique for Workday).
        const parts = String(raw).split('|')
        if (parts.length !== 3 || parts.some((p) => !p)) continue
        const [tenant, dataCenter, site] = parts
        out.push({ ats: 'workday', tenant, dataCenter, site, id: `workday:${tenant}:${dataCenter}:${site}` })
      } else {
        const slug = String(raw)
        out.push({ ats: d.ats, slug, id: `${d.ats}:${slug}` })
      }
    }
  })
  return out
}

// Common Crawl picks up plenty of noise -- a purely-numeric slug/tenant/site is essentially never a
// real, distinguishable company (internal test boards, anonymized ids), so skip it before spending a
// live request on it at all.
function looksLikeJunk(c) {
  if (c.ats === 'workday') return /^\d+$/.test(c.tenant) || /^\d+$/.test(c.site)
  return /^\d+$/.test(c.slug)
}

async function validateOne(c) {
  const fn = ATS_FETCHERS[c.ats]
  if (!fn) return { ...c, jobs: [] }
  const jobs = await fn(c).catch(() => [])
  return { ...c, jobs: Array.isArray(jobs) ? jobs : [] }
}

// Bounded worker pool + hard deadline (mirrors the Adzuna-URL-resolve pattern already in api/jobs.js)
// so a batch that hits a run of slow/timing-out candidates can't blow past Vercel's 60s ceiling --
// it just processes fewer than requested and reports the real count via nextOffset, never silently
// skipping the unprocessed remainder.
async function validateBatch(batch, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  const results = []
  let idx = 0
  const worker = async () => {
    while (idx < batch.length && Date.now() < deadline) {
      const c = batch[idx++]
      results.push(await validateOne(c))
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(15, batch.length) }, worker))
  return results
}

async function upsertRegistryRows(rows) {
  if (!rows.length) return { ok: true }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ats_board_registry`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(15000),
    })
    return { ok: r.ok }
  } catch { return { ok: false } }
}

function toRegistryRow(v) {
  const jobs = v.jobs
  // jobs[0].company already prefers a real org name where the ATS provides one (Ashby's own d.name)
  // over a slug-derived fallback -- reading it off here gets that enrichment for free without
  // special-casing any one ATS.
  const fromJob = jobs.length ? String(jobs[0].company || '').trim() : ''
  const fallbackName = slugName(v.ats === 'workday' ? v.tenant : v.slug)
  const sampleTitles = jobs.slice(0, 3).map((j) => j.title).filter(Boolean).join(', ')
  const base = v.ats === 'workday'
    ? { id: v.id, ats: 'workday', slug: null, tenant: v.tenant, data_center: v.dataCenter, site: v.site }
    : { id: v.id, ats: v.ats, slug: v.slug, tenant: null, data_center: null, site: null }
  return {
    ...base,
    company_name: fromJob || fallbackName,
    sample_titles: sampleTitles,
    status: jobs.length ? 'validated' : 'dead',
    job_count: jobs.length,
    source: 'import',
    checked_at: new Date().toISOString(),
  }
}

// Loops over many sub-batches within ONE call, not just one -- ~28,700 raw candidates at ~100 per
// sub-batch would otherwise need ~290 separate manually-triggered HTTP calls to fully import, which
// isn't a realistic ask. Bounded by an overall wall-clock deadline (not a fixed sub-batch count) so
// each call does as much work as fits in its own ~55s slice of Vercel's 60s ceiling, then hands back
// a nextOffset the caller can pass to the next call -- the whole ~28,700-candidate import now takes
// on the order of tens of calls, not hundreds, realistic to drive with a short loop (PowerShell,
// Node, or a browser console loop).
async function runImport(offset, limit, overallDeadlineMs) {
  const overallDeadline = Date.now() + overallDeadlineMs
  const all = await loadCandidates()
  // Junk is filtered BEFORE slicing so offset addresses the USABLE list -- a sub-batch never comes
  // back mostly-empty just because it happened to land on a run of numeric-junk slugs.
  const usable = all.filter((c) => !looksLikeJunk(c))
  const total = usable.length
  let cursor = offset
  let processed = 0, validatedCount = 0, deadCount = 0, allOk = true
  while (cursor < total && Date.now() < overallDeadline) {
    const subBatch = usable.slice(cursor, cursor + limit)
    if (!subBatch.length) break
    const remaining = overallDeadline - Date.now()
    if (remaining < 5000) break // not enough budget left to safely start (and upsert) another sub-batch
    const validated = await validateBatch(subBatch, remaining - 3000) // leave slack for the upsert call itself
    if (!validated.length) break // deadline hit mid-sub-batch with nothing completed -- stop cleanly
    const rows = validated.map(toRegistryRow)
    const { ok } = await upsertRegistryRows(rows)
    allOk = allOk && ok
    validatedCount += rows.filter((r) => r.status === 'validated').length
    deadCount += rows.filter((r) => r.status === 'dead').length
    processed += validated.length
    cursor += validated.length
  }
  return { total, processed, upserted: allOk, validated: validatedCount, dead: deadCount, nextOffset: cursor, done: cursor >= total }
}

async function fetchUnclassifiedBatch(limit) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ats_board_registry?status=eq.validated&select=id,ats,company_name,sample_titles&limit=${limit}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) return []
    const rows = await r.json()
    return Array.isArray(rows) ? rows : []
  } catch { return [] }
}

// One batched Groq call classifies + cleans up names for many rows at once (cheap: this is a coarse
// "which of 11 buckets" categorization, not the extraction-quality-critical work fetchCustomCareerPage
// does). Positional: classified[i] corresponds to rows[i]. If the model drops/reorders items (returns
// a shorter array, or something unparseable), the mismatched rows just come back with industry:null
// here, get filtered out below, and stay 'validated' -- eligible for a later classify batch rather
// than being incorrectly tagged. A wrong-industry classification is a minor quality issue (unlike a
// fabricated job posting), so this doesn't need the same hardened defenses as fetchCustomCareerPage.
async function classifyBatch(rows) {
  if (!rows.length || !GROQ_KEY) return []
  const listing = rows.map((r, i) => `${i}. company_name="${r.company_name}" sample_titles="${r.sample_titles}"`).join('\n')
  const prompt =
    `Classify each numbered company below into EXACTLY ONE of these industries: ${INDUSTRIES.join(' | ')}\n` +
    'Also clean up company_name if it looks like a raw url slug (e.g. "baker-hughes-inc" -> "Baker Hughes") -- ' +
    'keep it unchanged if it already reads like a real proper company name.\n' +
    'If you genuinely cannot tell which industry fits from the name/titles given, use "Software / IT" as the ' +
    'default -- never omit an item, every input line needs exactly one output item in the same order.\n' +
    'Return ONLY a JSON array, nothing else, one object per line above IN THE SAME ORDER. Each item: ' +
    '{"industry":"...","company_name":"..."}.\n\n' + listing
  let data
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, max_tokens: 4000, stream: false,
      }),
      signal: AbortSignal.timeout(25000),
    })
    data = r.ok ? await r.json() : null
  } catch { return [] }
  const content = data?.choices?.[0]?.message?.content || ''
  let parsed = []
  try {
    const match = content.match(/\[[\s\S]*\]/)
    if (match) parsed = JSON.parse(match[0])
  } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return rows
    .map((r, i) => {
      const p = parsed[i]
      const industry = p && INDUSTRIES.includes(p.industry) ? p.industry : null
      const company_name = (p && String(p.company_name || '').trim()) || r.company_name
      return { id: r.id, industry, company_name }
    })
    .filter((r) => !!r.industry)
}

// Same "loop within the deadline" shape as runImport -- self-draining (classified rows drop out of
// future status:'validated' queries automatically), so this just keeps pulling+classifying batches
// until either the backlog is empty (done:true) or the deadline is hit (done:false, call again).
async function runClassify(limit, overallDeadlineMs) {
  const overallDeadline = Date.now() + overallDeadlineMs
  let processed = 0, classifiedCount = 0, allOk = true
  while (Date.now() < overallDeadline) {
    const rows = await fetchUnclassifiedBatch(limit)
    if (!rows.length) return { processed, classified: classifiedCount, upserted: allOk, done: true }
    const classified = await classifyBatch(rows)
    const updates = classified.map((c) => ({ id: c.id, industry: c.industry, company_name: c.company_name, status: 'classified', checked_at: new Date().toISOString() }))
    const { ok } = await upsertRegistryRows(updates)
    allOk = allOk && ok
    processed += rows.length
    classifiedCount += updates.length
    if (rows.length < limit) return { processed, classified: classifiedCount, upserted: allOk, done: true }
  }
  return { processed, classified: classifiedCount, upserted: allOk, done: false }
}

export default async function handler(req, res) {
  const CRON_SECRET = process.env.CRON_SECRET
  if (CRON_SECRET) {
    const auth = req.headers['authorization'] || req.headers['Authorization'] || ''
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' })
  }
  const params = req.method === 'POST' ? (req.body || {}) : (req.query || {})
  const action = String(params.action || 'import')

  try {
    if (action === 'import') {
      const offset = Math.max(0, parseInt(params.offset, 10) || 0)
      const limit = Math.min(300, Math.max(1, parseInt(params.limit, 10) || 100))
      const maxMs = Math.min(55000, Math.max(1000, parseInt(params.maxMs, 10) || 50000))
      const result = await runImport(offset, limit, maxMs)
      return res.status(200).json({ ok: true, action, ...result })
    }
    if (action === 'classify') {
      const limit = Math.min(100, Math.max(1, parseInt(params.limit, 10) || 30))
      const maxMs = Math.min(55000, Math.max(1000, parseInt(params.maxMs, 10) || 50000))
      const result = await runClassify(limit, maxMs)
      return res.status(200).json({ ok: true, action, ...result })
    }
    return res.status(400).json({ error: 'Unknown action: ' + action })
  } catch (err) {
    console.error('jobs-import failed:', err && err.message)
    return res.status(502).json({ error: 'Import failed: ' + ((err && err.message) || 'unknown') })
  }
}
