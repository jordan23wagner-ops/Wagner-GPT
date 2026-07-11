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
    // TEMPORARY: surface the real PostgREST error body. Added after a silent upsert failure went
    // undiagnosed for a full run -- classify upserts were 400ing (a NOT NULL violation on `ats`,
    // which the classify payload omitted) but upserted:false told us nothing about WHY. Remove once
    // a live run confirms classify persists cleanly.
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.log('[upsert] non-ok', r.status, rows.length, 'rows', errText.slice(0, 400))
    }
    return { ok: r.ok }
  } catch (e) { console.log('[upsert] threw', (e && e.message) || e); return { ok: false } }
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

// Strip characters that could break the prompt's informal company_name="..."/sample_titles="..."
// quoting or otherwise confuse the model's own JSON generation -- confirmed live: some batches of 30
// were coming back with zero classifications (a full-batch parse failure), most likely because one
// row's messy Common-Crawl-derived text (stray quotes, control characters) threw off the model's
// output for the WHOLE batch, not just that one row.
// maxLen tightened from a flat 200 to field-appropriate caps (60 for company_name, 50 for
// sample_titles) after confirmed-live evidence the whole classify run was going to take ~5-9 days on
// Groq's free 100K-tokens/day quota -- a real company name is essentially never near 200 chars, so
// that cap was pure wasted tokens on every single one of ~13,500 companies needing classification.
function sanitizeForPrompt(s, maxLen) {
  return String(s || '').replace(/["\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

// TEMPORARY diagnostic logging (see the classify:0 investigation) -- callGroqClassify previously
// swallowed every failure into a bare `null` with no way to tell a network error, a Groq error
// response (rate limit, auth, quota), and an unparseable-but-200 response apart from the console.
// Remove once the root cause of the classified:0 streak is confirmed and fixed.
async function callGroqClassify(rows) {
  const listing = rows.map((r, i) => `${i}. "${sanitizeForPrompt(r.company_name, 60)}" (${sanitizeForPrompt(r.sample_titles, 50)})`).join('\n')
  // Trimmed from a more verbose version after confirmed-live evidence the classify phase would take
  // ~5-9 days on Groq's free 100K-tokens/day quota -- every token here is paid ~450 times (once per
  // batch of ~30 companies, across ~450 batches for the current backlog), so shaving the fixed
  // instruction cost compounds.
  const prompt =
    `Industries: ${INDUSTRIES.join('|')}\n` +
    'For each numbered company: pick exactly one industry from the list. Clean up the name if it looks ' +
    'like a raw url slug (e.g. "baker-hughes-inc" -> "Baker Hughes"), else keep it as-is. If unsure, use ' +
    '"Software / IT". Reply with ONLY a JSON array, same order, one item per line: ' +
    '{"industry":"...","company_name":"..."}\n\n' + listing
  let r
  try {
    r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Switched from llama-3.3-70b-versatile after confirmed live: Groq's free tier caps that
        // model at 100K tokens/day, and it's the SAME model/quota pool fetchCustomCareerPageViaAi
        // (in jobs.js) uses for live search -- classify was starving live search of its own daily
        // budget. gpt-oss-120b gets 200K tokens/day on a SEPARATE pool, and is already a proven Groq
        // model id in this codebase (api/chat.js's 'gptoss' route), not a guess. Unverified: its exact
        // JSON-formatting style for this task, since it's never been used here for structured
        // array-extraction before (only open-ended chat) -- if the [classify] diagnostic logs show a
        // formatting mismatch (e.g. markdown-fenced output) rather than a clean JSON array, that's the
        // first thing to adjust, not the token/quota math above.
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, max_tokens: 4000, stream: false,
      }),
      signal: AbortSignal.timeout(25000),
    })
  } catch (e) {
    console.log('[classify] groq fetch threw', rows.length, 'rows', (e && e.message) || e)
    return { ok: false, reason: 'error' }
  }
  if (!r.ok) {
    const errText = await r.text().catch(() => '')
    // Confirmed live: gpt-oss-120b's free tier hits a per-MINUTE token limit (TPM), not the old
    // per-day one -- it resets in ~20-30s, not an hour. Distinguishing this from other failures
    // matters because the right response is completely different (see classifyBatch below): a
    // short wait + retry the SAME batch, not bisect it into smaller pieces. Bisecting a rate-limited
    // batch just means MORE separate requests competing for the same limited per-minute budget,
    // which can make the rate limit worse, not better.
    const isRateLimit = r.status === 429 || /rate.?limit/i.test(errText)
    console.log('[classify] groq non-ok', r.status, rows.length, 'rows', isRateLimit ? '(rate limit)' : '', errText.slice(0, 500))
    return { ok: false, reason: isRateLimit ? 'rate_limit' : 'error' }
  }
  const data = await r.json().catch(() => null)
  const content = data?.choices?.[0]?.message?.content || ''
  const finishReason = data?.choices?.[0]?.finish_reason
  try {
    const match = content.match(/\[[\s\S]*\]/)
    if (!match) {
      console.log('[classify] no json array in response', rows.length, 'rows finish_reason=' + finishReason, 'content:', content.slice(0, 300))
      return { ok: false, reason: 'parse_error' }
    }
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) {
      console.log('[classify] parsed but not an array', rows.length, 'rows', typeof parsed)
      return { ok: false, reason: 'parse_error' }
    }
    return { ok: true, parsed }
  } catch (e) {
    console.log('[classify] JSON.parse threw', rows.length, 'rows finish_reason=' + finishReason, 'error:', (e && e.message) || e, 'content:', content.slice(0, 300))
    return { ok: false, reason: 'parse_error' }
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

// One batched Groq call classifies + cleans up names for many rows at once (cheap: this is a coarse
// "which of 11 buckets" categorization, not the extraction-quality-critical work fetchCustomCareerPage
// does). Positional: classified[i] corresponds to rows[i]. If the model drops/reorders items (returns
// a shorter array, or something unparseable), the mismatched rows just come back with industry:null
// here, get filtered out below, and stay 'validated' -- eligible for a later classify batch rather
// than being incorrectly tagged. A wrong-industry classification is a minor quality issue (unlike a
// fabricated job posting), so this doesn't need the same hardened defenses as fetchCustomCareerPage.
//
// Two different failure modes get two different responses:
//   - rate_limit: short fixed backoff, then retry the SAME batch size once. Confirmed live this is a
//     fast-resetting per-minute limit, not the old per-day one -- bisecting here would just add MORE
//     requests competing for the same limited per-minute budget. If the retry also fails, give up for
//     this call (leave 'validated' for a future one) rather than looping indefinitely on one batch.
//   - parse_error/error: bisect. Confirmed live that a single row's messy data can poison an entire
//     batch's JSON output, silently discarding every other classification in it. Splitting isolates
//     whichever row(s) are actually the problem to their own single-row batch instead of discarding
//     everything.
async function classifyBatch(rows) {
  if (!rows.length || !GROQ_KEY) return []
  let result = await callGroqClassify(rows)
  if (!result.ok && result.reason === 'rate_limit') {
    await sleep(2500)
    result = await callGroqClassify(rows)
  }
  if (!result.ok) {
    if (result.reason === 'rate_limit' || rows.length === 1) return [] // still rate-limited after one retry, or isolated down to one row and it STILL fails -- leave 'validated' for a later attempt
    const mid = Math.ceil(rows.length / 2)
    const [a, b] = await Promise.all([classifyBatch(rows.slice(0, mid)), classifyBatch(rows.slice(mid))])
    return [...a, ...b]
  }
  const parsed = result.parsed
  return rows
    .map((r, i) => {
      const p = parsed[i]
      const industry = p && INDUSTRIES.includes(p.industry) ? p.industry : null
      const company_name = (p && String(p.company_name || '').trim()) || r.company_name
      // ats MUST be carried through: it's a NOT NULL column with no default, and the merge-duplicates
      // upsert's INSERT half fails a NOT NULL violation (which ON CONFLICT does NOT rescue) if it's
      // omitted -- confirmed live, this silently no-op'd the ENTIRE classify phase (upserted:false,
      // 0 rows ever persisted) until fixed. fetchUnclassifiedBatch already selects it.
      return { id: r.id, ats: r.ats, industry, company_name }
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
    const updates = classified.map((c) => ({ id: c.id, ats: c.ats, industry: c.industry, company_name: c.company_name, status: 'classified', checked_at: new Date().toISOString() }))
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
      const limit = Math.min(150, Math.max(1, parseInt(params.limit, 10) || 50))
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
