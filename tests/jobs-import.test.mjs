// Mocked-logic test for api/jobs-import.js — stubs global fetch, drives the handler, asserts the
// import (validate) and classify batches, resumability, junk-filtering, and CRON_SECRET gate. No live
// network. Mirrors jobs.test.mjs's conventions (see that file's header comment for why the dynamic
// import is required — GROQ_KEY is a module-level const in jobs-import.js, evaluated once at import
// time, so env vars must be set BEFORE the import, not after).
process.env.GROQ_KEY = 'test-groq-key'

const { default: handler } = await import('../api/jobs-import.js')

const upsertedBatches = [] // capture every POST body sent to ats_board_registry, across all calls
let classifyTestPhase = 'default' // 'poison'/'ratelimit' switch the registry-GET/Groq mocks for the tests below
let rateLimitCallCount = 0
const groqCallBodies = [] // every Groq request body sent during the 'ratelimit' phase, to prove no bisection occurred

globalThis.fetch = async (url, opts) => {
  const u = String(url)
  const method = (opts && opts.method) || 'GET'
  const body = (opts && opts.body) || ''
  const json = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) })

  // The four raw dataset files. A small, deliberately mixed fixture:
  //  - greenhouse: one real-looking slug (validates, returns jobs), one purely-numeric junk slug
  //    (must be filtered BEFORE any live request is made -- no mock exists for it, so if the junk
  //    filter regresses, the test would either hang on an unmocked branch or hit the catch-all).
  //  - lever: one real-looking slug that validates, one that returns empty (a live but "dead" board).
  //  - ashby: one slug whose board API returns a real org `name` -- proves that enrichment flows
  //    through to company_name instead of falling back to a slug-derived title-case.
  //  - workday: one well-formed "tenant|dc|site" entry, one malformed entry (only two parts) that
  //    must be skipped during parsing, and one with a numeric tenant (junk, filtered pre-validation).
  if (u.includes('raw.githubusercontent.com') && u.includes('greenhouse_companies.json')) {
    return json(['realcompany-inc', '48291058'])
  }
  if (u.includes('raw.githubusercontent.com') && u.includes('lever_companies.json')) {
    return json(['activecompany', 'deadcompany'])
  }
  if (u.includes('raw.githubusercontent.com') && u.includes('ashby_companies.json')) {
    return json(['ashbyco'])
  }
  if (u.includes('raw.githubusercontent.com') && u.includes('workday_companies.json')) {
    return json(['acme|wd1|acme_careers', 'malformed|wd2', '99887766|wd3|numeric_tenant'])
  }

  if (u.includes('boards-api.greenhouse.io') && u.includes('realcompany-inc')) {
    return json({ jobs: [
      { id: 1, title: 'Software Engineer', absolute_url: 'https://boards.greenhouse.io/realcompany-inc/jobs/1', location: { name: 'Remote' }, content: 'Build things', updated_at: '2026-07-01' },
      { id: 2, title: 'Staff Engineer', absolute_url: 'https://boards.greenhouse.io/realcompany-inc/jobs/2', location: { name: 'NYC' }, content: 'Build more things', updated_at: '2026-07-01' },
    ] })
  }
  if (u.includes('api.lever.co') && u.includes('activecompany')) {
    return json([
      { id: 'a', text: 'Product Manager', hostedUrl: 'https://jobs.lever.co/activecompany/a', categories: { location: 'Remote' }, descriptionPlain: 'Ship products', createdAt: 1719800000000 },
    ])
  }
  if (u.includes('api.lever.co') && u.includes('deadcompany')) {
    return json([]) // live board, zero postings -- must end up 'dead', not 'validated'
  }
  if (u.includes('api.ashbyhq.com') && u.includes('ashbyco')) {
    return json({ name: 'Ashby Co Real Name', jobs: [
      { id: 'z', title: 'Recruiter', jobUrl: 'https://jobs.ashbyhq.com/ashbyco/z', location: 'Remote', employmentType: 'FullTime', descriptionPlain: 'Hire people', publishedAt: '2026-06-01' },
    ] })
  }
  if (u.includes('acme.wd1.myworkdayjobs.com')) {
    return json({ jobPostings: [
      { title: 'Ops Manager', locationsText: 'Austin, TX', externalPath: '/job/Ops_R1', postedOn: '2026-06-15', timeType: 'Full time' },
    ] })
  }

  // ats_board_registry: POST (upsert, both import and classify use this) and GET (classify's
  // unclassified-batch query).
  if (u.includes('ats_board_registry') && method === 'POST') {
    upsertedBatches.push(JSON.parse(body))
    return { ok: true, json: async () => ([]) }
  }
  if (u.includes('ats_board_registry') && u.includes('status=eq.validated')) {
    if (classifyTestPhase === 'poison') {
      return json([
        { id: 'greenhouse:poisonco', ats: 'greenhouse', company_name: 'Poison Co "weird" data', sample_titles: 'Odd\nTitle' },
        { id: 'greenhouse:goodco', ats: 'greenhouse', company_name: 'Good Co', sample_titles: 'Software Engineer' },
      ])
    }
    if (classifyTestPhase === 'ratelimit') {
      return json([
        { id: 'greenhouse:ratelimitco1', ats: 'greenhouse', company_name: 'RateLimitCo1', sample_titles: 'Engineer' },
        { id: 'greenhouse:ratelimitco2', ats: 'greenhouse', company_name: 'RateLimitCo2', sample_titles: 'Manager' },
      ])
    }
    return json([
      { id: 'greenhouse:realcompany-inc', ats: 'greenhouse', company_name: 'Realcompany Inc', sample_titles: 'Software Engineer, Staff Engineer' },
      { id: 'lever:activecompany', ats: 'lever', company_name: 'Activecompany', sample_titles: 'Product Manager' },
    ])
  }

  if (u.includes('api.groq.com') && classifyTestPhase === 'poison') {
    // Confirmed live: one poisoned row can make the WHOLE batch's JSON unparseable. Reproduce that
    // for the 2-row batch (malformed, no closing bracket), but let the bisected 1-row retries
    // succeed individually -- goodco classifies fine on its own; poisonco keeps failing even in
    // isolation (simulates a row that's genuinely never going to parse, not just batch-poisoned).
    if (body.includes('Poison Co') && body.includes('Good Co')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '[{"industry":"Software / IT"' } }] }) } // malformed: unterminated
    }
    if (body.includes('Good Co') && !body.includes('Poison Co')) {
      return json({ choices: [{ message: { content: '[{"industry":"Software / IT","company_name":"Good Co"}]' } }] })
    }
    if (body.includes('Poison Co') && !body.includes('Good Co')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'not even json' } }] }) }
    }
  }
  // Confirmed live: a per-MINUTE rate limit (TPM), not the old per-day one -- the right response is a
  // short wait + retry the SAME batch, never a split. Fails the FULL 2-row batch with 429 exactly
  // once, then succeeds on retry; groqCallBodies (checked below) proves every call sent both company
  // names together -- if bisection had incorrectly triggered here, some call would contain only one.
  if (u.includes('api.groq.com') && classifyTestPhase === 'ratelimit') {
    groqCallBodies.push(body)
    rateLimitCallCount++
    if (rateLimitCallCount === 1) {
      return { ok: false, status: 429, json: async () => ({}), text: async () => JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` ... tokens per minute (TPM) ... Please try again in 2s.', type: 'tokens', code: 'rate_limit_exceeded' } }) }
    }
    return json({ choices: [{ message: { content:
      '[{"industry":"Software / IT","company_name":"RateLimitCo1"},{"industry":"Product Management","company_name":"RateLimitCo2"}]'
    } }] })
  }
  if (u.includes('api.groq.com')) {
    return json({ choices: [{ message: { content:
      '[{"industry":"Software / IT","company_name":"Real Company Inc."},' +
      '{"industry":"Product Management","company_name":"Active Company"}]'
    } }] })
  }

  return { ok: false, json: async () => ({}), text: async () => '' }
}

function mockRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this },
    json(o) { this.body = o; return this },
    end() { return this },
  }
}

async function run() {
  const fails = []
  const assert = (cond, msg) => { if (!cond) fails.push(msg) }

  // ── action:'import' ──
  const res1 = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'import', offset: 0, limit: 100 } }, res1)
  assert(res1.statusCode === 200, 'import status 200, got ' + res1.statusCode)
  const out1 = res1.body
  // Junk filtering: total usable candidates = 2 greenhouse - 1 junk + 2 lever + 1 ashby + 3 workday - 2 junk(malformed+numeric) = 5
  assert(out1.total === 5, 'junk (numeric greenhouse slug, malformed workday entry, numeric workday tenant) filtered before slicing -- got total=' + out1.total)
  assert(out1.processed === 5, 'all 5 usable candidates processed in one batch (well under the limit), got ' + out1.processed)
  assert(out1.validated === 4, 'realcompany-inc (greenhouse), activecompany (lever), ashbyco (ashby), acme (workday) all validate with real jobs, got validated=' + out1.validated)
  assert(out1.dead === 1, 'deadcompany (lever, live board but zero postings) must be "dead" not "validated", got dead=' + out1.dead)
  assert(out1.done === true, 'nextOffset >= total means done, got nextOffset=' + out1.nextOffset + ' total=' + out1.total)
  // Workday's malformed/numeric entries must never even reach a live fetch -- no mock exists for
  // them, so if they weren't filtered, upsertedBatches would be missing rows or the call would 404
  // silently; the strongest direct check is that the workday row that DID validate is present with
  // correctly-parsed tenant/dataCenter/site.
  const importBatch = upsertedBatches[0]
  const wdRow = importBatch.find((r) => r.id === 'workday:acme:wd1:acme_careers')
  assert(!!wdRow, 'well-formed workday entry (acme|wd1|acme_careers) parsed and validated')
  assert(wdRow && wdRow.tenant === 'acme' && wdRow.data_center === 'wd1' && wdRow.site === 'acme_careers', 'workday tenant/data_center/site parsed correctly from the pipe-delimited entry')
  assert(!importBatch.some((r) => r.id && r.id.includes('malformed')), 'malformed workday entry (only 2 of 3 pipe segments) never reaches validation/upsert at all')
  assert(!importBatch.some((r) => r.slug === '48291058'), 'purely-numeric greenhouse slug (junk) never reaches validation/upsert at all')
  assert(!importBatch.some((r) => r.tenant === '99887766'), 'purely-numeric workday tenant (junk) never reaches validation/upsert at all')
  // Company-name enrichment: Ashby's own board name flows through; Greenhouse/Lever fall back to a
  // slug-derived title-case (those ATS endpoints don't return an org display name at all).
  const ashbyRow = importBatch.find((r) => r.id === 'ashby:ashbyco')
  assert(ashbyRow && ashbyRow.company_name === 'Ashby Co Real Name', 'Ashby board\'s own real org name used as company_name, not a slug-derived guess -- got ' + (ashbyRow && ashbyRow.company_name))
  const ghRow = importBatch.find((r) => r.id === 'greenhouse:realcompany-inc')
  assert(ghRow && ghRow.company_name === 'Realcompany Inc', 'Greenhouse (no org-name field available) falls back to slug-derived title-case -- got ' + (ghRow && ghRow.company_name))
  const deadRow = importBatch.find((r) => r.id === 'lever:deadcompany')
  assert(deadRow && deadRow.status === 'dead' && deadRow.job_count === 0, 'a live board with zero postings is correctly marked dead with job_count 0')
  assert(ghRow && ghRow.sample_titles === 'Software Engineer, Staff Engineer', 'sample_titles captured from the first few validated jobs, for the later classify step to use -- got "' + (ghRow && ghRow.sample_titles) + '"')

  // Resumability: an offset past the end of the usable list returns done:true with nothing processed.
  const res2 = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'import', offset: 5, limit: 100 } }, res2)
  assert(res2.body.processed === 0 && res2.body.done === true, 'offset at/past total returns processed:0, done:true (nothing left to do)')

  // Internal looping: a small sub-batch limit (2) forces the 5-item usable list to take 3 internal
  // loop rounds within ONE call -- proves runImport actually loops across sub-batches bounded by the
  // overall deadline, not just processing one sub-batch and returning (which the earlier limit:100
  // assertions couldn't distinguish, since everything fit in a single sub-batch there).
  upsertedBatches.length = 0
  const res2b = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'import', offset: 0, limit: 2, maxMs: 50000 } }, res2b)
  assert(res2b.body.processed === 5 && res2b.body.done === true, 'a single call with a small sub-batch limit still drains the whole usable list via internal looping, got processed=' + res2b.body.processed + ' done=' + res2b.body.done)
  assert(upsertedBatches.length === 3, 'limit:2 over 5 usable candidates takes exactly 3 internal sub-batch rounds (2+2+1), each upserting separately, got ' + upsertedBatches.length)

  // ── action:'classify' ──
  const res3 = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'classify', limit: 30 } }, res3)
  assert(res3.statusCode === 200, 'classify status 200, got ' + res3.statusCode)
  assert(res3.body.classified === 2, 'both unclassified rows get an industry assigned from the batched Groq call, got ' + res3.body.classified)
  const classifyBatch = upsertedBatches.find((b) => b.some((r) => r.status === 'classified'))
  assert(!!classifyBatch, 'classify step upserts rows with status:"classified"')
  const ghClassified = classifyBatch && classifyBatch.find((r) => r.id === 'greenhouse:realcompany-inc')
  assert(ghClassified && ghClassified.industry === 'Software / IT', 'realcompany-inc classified into Software / IT per the mocked Groq response, got ' + (ghClassified && ghClassified.industry))
  assert(ghClassified && ghClassified.company_name === 'Real Company Inc.', 'classify also cleans up the display name (slug-derived "Realcompany Inc" -> "Real Company Inc.")')

  // ── Bisection recovery: one poisoned row must not silently discard the whole batch ──
  // Confirmed live: a 30-company batch containing one row with messy data came back with ZERO
  // classifications (Groq's whole-batch JSON output unparseable). goodco+poisonco reproduces that at
  // 2-row scale: the full-batch call returns malformed JSON, so classifyBatch must bisect down to
  // single-row batches -- goodco succeeds in isolation, poisonco keeps failing even alone (simulates
  // a row that's genuinely never going to parse, not just batch-poisoned).
  classifyTestPhase = 'poison'
  upsertedBatches.length = 0
  const res3b = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'classify', limit: 30 } }, res3b)
  assert(res3b.body.classified === 1, 'bisection recovers goodco\'s classification even though the full 2-row batch failed to parse, got classified=' + res3b.body.classified)
  const poisonUpserts = upsertedBatches.flat()
  assert(poisonUpserts.some((r) => r.id === 'greenhouse:goodco' && r.status === 'classified'), 'goodco (the non-poisoned row) gets classified via a bisected single-row retry, not lost along with poisonco')
  assert(!poisonUpserts.some((r) => r.id === 'greenhouse:poisonco'), 'poisonco (permanently unparseable even in isolation) is never upserted -- stays "validated" for a later attempt, not incorrectly tagged')
  classifyTestPhase = 'default'

  // ── Rate-limit recovery: a 429 must get a backoff+retry of the SAME batch, never bisection ──
  // Confirmed live: gpt-oss-120b's free tier hits a fast-resetting per-minute (TPM) limit. Splitting
  // a rate-limited batch into smaller pieces just means MORE requests competing for the same limited
  // per-minute budget -- the fix under test is that a 429 gets one short-wait retry of the FULL
  // original batch, never a bisected sub-batch.
  classifyTestPhase = 'ratelimit'
  rateLimitCallCount = 0
  groqCallBodies.length = 0
  upsertedBatches.length = 0
  const res3c = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'classify', limit: 30 } }, res3c)
  assert(res3c.body.classified === 2, 'both companies classified once the retry succeeds, got classified=' + res3c.body.classified)
  assert(groqCallBodies.length === 2, 'exactly 2 Groq calls made (the failing 429 + the retry) -- more than 2 would mean bisection incorrectly triggered on a rate-limit failure, got ' + groqCallBodies.length)
  assert(groqCallBodies.every((b) => b.includes('RateLimitCo1') && b.includes('RateLimitCo2')), 'every Groq call (both the failed attempt and the retry) sent the FULL 2-row batch together -- no bisection/splitting occurred on a rate-limit failure')
  classifyTestPhase = 'default'

  // ── CRON_SECRET auth gate (same pattern as jobs-crawl.js) ──
  process.env.CRON_SECRET = 'test-cron-secret'
  const resUnauth = mockRes()
  await handler({ method: 'GET', headers: {}, query: { action: 'import' } }, resUnauth)
  assert(resUnauth.statusCode === 401, 'unauthenticated request rejected once CRON_SECRET is set, got ' + resUnauth.statusCode)
  const resAuth = mockRes()
  await handler({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' }, query: { action: 'import', offset: '0', limit: '100' } }, resAuth)
  assert(resAuth.statusCode === 200, 'request with the correct bearer token accepted, got ' + resAuth.statusCode)
  delete process.env.CRON_SECRET

  if (fails.length) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1) }
  console.log('ALL ASSERTIONS PASSED')
}
run().catch((e) => { console.error(e); process.exit(1) })
