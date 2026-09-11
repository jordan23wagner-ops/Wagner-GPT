// Regression tests for the 2026-09-11 Jobs-tab bug sweep. Each test here locks in a fix for a bug
// that was live in production and NOT caught by the existing suite:
//
//   1. A remote search was geo-fenced upstream — the saved location was sent to every geo-aware
//      source with no remote check, so "Remote only" silently searched one Houston suburb.
//   2. bluedoor was queried with titles[0] only, so a PM-led search could never return an
//      "AI Engineer" posting from the enterprise ATSes bluedoor uniquely covers.
//   3. Adzuna bypassed filterJob entirely, so on-site jobs leaked into Remote-only results.
//
// Style follows tests/jobs.test.mjs: stub global fetch, drive the real handler, assert on what the
// handler actually SENT (captured URLs) as well as what it returned. No live network.

process.env.ADZUNA_APP_ID = 'x'
process.env.ADZUNA_APP_KEY = 'y'
// Leave every other provider key unset so those sources no-op and the assertions stay focused.
delete process.env.JSEARCH_KEY
delete process.env.BRAVE_KEY
delete process.env.TAVILY_KEY
delete process.env.JOOBLE_KEY
delete process.env.CAREERJET_AFFID
delete process.env.REED_API_KEY
delete process.env.USAJOBS_API_KEY

const { default: handler } = await import('../api/jobs.js')

let fetched = []
const json = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) })

globalThis.fetch = async (url, opts) => {
  const u = String(url)
  fetched.push(u)
  if (u.includes('api.adzuna.com')) {
    return json({ count: 1, results: [
      // Plainly on-site: Austin location, nothing remote anywhere in the text. Adzuna has no remote
      // API param, so the ONLY thing that can keep this out of a remote search is filterJob.
      { id: 99, title: 'Project Manager', company: { display_name: 'Onsite Co' },
        location: { display_name: 'Austin, TX' }, redirect_url: 'https://adzuna.example/99',
        description: 'On-site project management role, five days a week in office.',
        created: '2026-07-02', salary_min: 150000, salary_max: 180000 },
    ] })
  }
  if (u.includes('api.bluedoor.sh') && u.includes('/jobs/search')) {
    const title = new URL(u).searchParams.get('title') || ''
    // Only the AI-Engineer-titled query returns anything — mirrors the real failure mode, where the
    // interesting posting sits behind a title that was never actually asked for.
    if (/ai engineer/i.test(title)) {
      return json({ data: [
        { job_id: 'bd-ai-1', title: 'AI Engineer', org_id: 'org1', location_text: 'Remote - US',
          apply_url: 'https://boards.greenhouse.io/bdco/jobs/7', description: 'Remote AI engineering role.',
          posted_at: '2026-07-05' },
      ] })
    }
    return json({ data: [] })
  }
  if (u.includes('api.bluedoor.sh') && u.includes('orgs/batch_lookup')) {
    return json({ data: [{ input: { org_id: 'org1' }, data: { display_name: 'BD Co' } }] })
  }
  return { ok: false, json: async () => ({}), text: async () => '' }
}

function mockRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v },
    status(c) { this.statusCode = c; return this },
    json(o) { this.body = o; return this },
    end() { return this },
  }
}
const call = async (body) => {
  fetched = []
  const res = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', country: 'us', ...body } }, res)
  return res
}

const fails = []
const assert = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? 'ok   ' : 'FAIL ') + msg) }

const STALE_LOCATION = 'Katy, TX|Cypress|Sugar Land|Houston'

// ── 1. A remote search must not be geo-fenced upstream ────────────────────────────────────────
{
  const res = await call({ titles: 'Project Manager', where: STALE_LOCATION, remote: true })
  assert(res.statusCode === 200, 'remote search returns 200')

  const adzunaUrls = fetched.filter((u) => u.includes('api.adzuna.com'))
  assert(adzunaUrls.length > 0, 'remote: Adzuna was actually called')
  assert(adzunaUrls.every((u) => !new URL(u).searchParams.get('where')),
    'remote: Adzuna receives NO where param (was where=Katy, TX + distance=40)')
  assert(adzunaUrls.every((u) => !new URL(u).searchParams.get('distance')),
    'remote: Adzuna receives no distance radius')

  const bdUrls = fetched.filter((u) => u.includes('api.bluedoor.sh') && u.includes('/jobs/search'))
  assert(bdUrls.length > 0, 'remote: bluedoor was actually called')
  assert(bdUrls.every((u) => !new URL(u).searchParams.get('location_text')),
    'remote: bluedoor receives NO location_text (was location_text AND workplace_type=remote — an intersection matching almost nothing)')
  assert(bdUrls.every((u) => new URL(u).searchParams.get('workplace_type') === 'remote'),
    'remote: bluedoor still receives workplace_type=remote')
}

// ── 1b. A NON-remote search must still geo-fence, using the first pipe alternative ─────────────
{
  const res = await call({ titles: 'Project Manager', where: STALE_LOCATION, remote: false })
  assert(res.statusCode === 200, 'non-remote search returns 200')
  const adzunaUrls = fetched.filter((u) => u.includes('api.adzuna.com'))
  assert(adzunaUrls.some((u) => new URL(u).searchParams.get('where') === 'Katy, TX'),
    'non-remote: Adzuna still geo-fenced to the first pipe alternative (behavior preserved)')
}

// ── 2. bluedoor fans out across the title list instead of querying only the first ──────────────
{
  const res = await call({
    titles: 'Project Manager, Program Manager, Technical Program Manager, AI Engineer',
    remote: true,
  })
  const bdTitles = fetched
    .filter((u) => u.includes('api.bluedoor.sh') && u.includes('/jobs/search'))
    .map((u) => new URL(u).searchParams.get('title'))

  assert(bdTitles.length >= 2, `bluedoor issued multiple title queries (got ${bdTitles.length}, was always 1)`)
  assert(bdTitles.includes('Project Manager'), 'bluedoor still queries the first title')
  assert(bdTitles.includes('AI Engineer'), 'bluedoor also queries "AI Engineer" — the whole point of the fix')
  assert(bdTitles.length <= 4, `bluedoor fan-out capped at 4 for the anonymous rate limit (got ${bdTitles.length})`)
  assert(new Set(bdTitles).size === bdTitles.length, 'bluedoor issues no duplicate title queries')

  const aiJob = res.body.results.find((r) => r.title === 'AI Engineer')
  assert(!!aiJob, 'the AI Engineer posting actually reaches the results (was unreachable at any salary/location)')
  assert(aiJob && aiJob.company === 'BD Co', 'org batch lookup still resolves the company name after the merge')
}

// ── 3. Adzuna goes through filterJob like every other source ───────────────────────────────────
{
  const res = await call({ titles: 'Project Manager', remote: true })
  const onsite = res.body.results.find((r) => r.company === 'Onsite Co')
  assert(!onsite, 'remote: the on-site Adzuna job is filtered out (used to be merged in unfiltered)')
  assert(res.body.sources.adzuna === 0, 'sources.adzuna reports the FILTERED count')
  assert(res.body.sources.adzunaRaw === 1, 'sources.adzunaRaw still reports what Adzuna returned, so the drop is visible')
}
{
  const res = await call({ titles: 'Project Manager', remote: false })
  const onsite = res.body.results.find((r) => r.company === 'Onsite Co')
  assert(!!onsite, 'non-remote: the same Adzuna job is kept — the filter is remote-driven, not a blanket exclusion')
}

if (fails.length) { console.error('\n' + fails.length + ' ASSERTION(S) FAILED'); process.exit(1) }
console.log('\n# ALL ASSERTIONS PASSED')
