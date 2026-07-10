// Mocked-logic test for api/jobs.js — stubs global fetch, drives the handler, asserts
// merge/dedupe/filter/shape. No live network.
//
// BRAVE_KEY/TAVILY_KEY/GROQ_KEY are read as MODULE-LEVEL constants in jobs.js (evaluated once at
// import time, fine for a real server process where env vars are static for its whole lifetime) --
// so this file uses a dynamic import(), deferred until AFTER every env var this test needs is set,
// rather than a static import (which ES modules hoist above all other top-level code regardless of
// where it's textually written, so any process.env mutation later in this file would have no effect
// on jobs.js's already-evaluated constants).
process.env.ADZUNA_APP_ID = 'x'
process.env.ADZUNA_APP_KEY = 'y'
process.env.BRAVE_KEY = 'test-brave-key'
process.env.GROQ_KEY = 'test-groq-key'
delete process.env.TAVILY_KEY
delete process.env.TAVILY

const { default: handler } = await import('./jobs.js')

globalThis.fetch = async (url) => {
  const u = String(url)
  const json = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) })
  if (u.includes('boards-api.greenhouse.io')) {
    return json({ jobs: [
      { id: 1, title: 'Senior Project Manager', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Remote - US' }, content: '<p>Lead AI projects</p>', updated_at: '2026-07-01' },
      { id: 2, title: 'Staff Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/2', location: { name: 'New York, NY' }, content: 'Go services', updated_at: '2026-07-01' },
    ] })
  }
  if (u.includes('api.lever.co')) {
    return json([
      { id: 'a', text: 'Project Manager, ML', hostedUrl: 'https://jobs.lever.co/beta/a', categories: { location: 'San Francisco', team: 'Product', commitment: 'Full-time' }, descriptionPlain: 'Manage ML programs', createdAt: 1719800000000 },
    ])
  }
  if (u.includes('api.ashbyhq.com')) {
    return json({ name: 'Gamma', jobs: [
      { id: 'z', title: 'Product Manager', jobUrl: 'https://jobs.ashbyhq.com/gamma/z', location: 'Remote', employmentType: 'FullTime', descriptionPlain: 'PM role', publishedAt: '2026-06-01', isRemote: true },
    ] })
  }
  if (u.includes('api.adzuna.com')) {
    return json({ results: [
      // Duplicate of the greenhouse PM (same title/company-ish) to test dedupe by URL differs → kept; test title filter passes
      { id: 99, title: 'Project Manager', company: { display_name: 'Delta' }, location: { display_name: 'Austin, TX' }, redirect_url: 'https://adzuna.example/99', category: { label: 'IT Jobs', tag: 'it-jobs' }, description: 'PM', created: '2026-07-02', salary_min: 90000, salary_max: 120000 },
    ], count: 1 })
  }
  // Brave discovery: a mix of a Workday tenant (with a locale segment, exercising WORKDAY_URL_RE's
  // optional locale clause), a SmartRecruiters board, a Recruitee board, and a genuinely custom
  // careers page with no known ATS behind it at all.
  if (u.includes('api.search.brave.com')) {
    return json({ web: { results: [
      { url: 'https://acme.wd1.myworkdayjobs.com/en-US/Acme_Careers/job/Remote/Producer_R123' },
      { url: 'https://jobs.smartrecruiters.com/AcmeSR/producer-role' },
      { url: 'https://acme3.recruitee.com/o/producer' },
      { url: 'https://customstudio.example/careers/openings' },
    ] } })
  }
  if (u.includes('wday/cxs/acme/Acme_Careers/jobs')) {
    return json({ jobPostings: [
      { title: 'Senior Producer', locationsText: 'Tokyo, Japan', externalPath: '/job/Producer_R123', postedOn: '2026-06-15', timeType: 'Full time' },
    ] })
  }
  if (u.includes('api.smartrecruiters.com') && u.includes('companies/AcmeSR')) {
    return json({ content: [
      { id: 'sr1', name: 'Producer', company: { name: 'Acme SR' }, location: { city: 'Osaka', country: 'JP' }, jobAd: { sections: { jobDescription: { text: 'Ship games' } } }, releasedDate: '2026-06-10' },
    ] })
  }
  if (u.includes('acme3.recruitee.com')) {
    return json({ offers: [
      { id: 're1', title: 'Producer', company_name: 'Acme3', city: 'Kyoto', country: 'JP', careers_url: 'https://acme3.recruitee.com/o/producer', description: 'Ship more games', published_at: '2026-06-12' },
    ] })
  }
  // Jina reader: returns PLAIN TEXT (not JSON) via .text(), matching fetchCustomCareerPage's real call.
  if (u.includes('r.jina.ai/https://customstudio.example/careers/openings')) {
    return { ok: true, text: async () => 'Careers at Custom Studio\n\nSenior Producer — Tokyo, Japan — apply at https://customstudio.example/careers/openings/123' }
  }
  if (u.includes('api.groq.com')) {
    return json({ choices: [{ message: { content: '[{"title":"Senior Producer","location":"Tokyo, Japan","url":"https://customstudio.example/careers/openings/123"}]' } }] })
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

async function run() {
  const req = { method: 'POST', headers: {}, body: {
    action: 'search', titles: 'Project Manager', industry: 'AI / Machine Learning',
    remote: false, country: 'us', resultsPerPage: 50,
  } }
  const res = mockRes()
  await handler(req, res)
  const out = res.body
  const fails = []
  const assert = (cond, msg) => { if (!cond) fails.push(msg) }

  assert(res.statusCode === 200, 'status 200, got ' + res.statusCode)
  assert(Array.isArray(out.results), 'results is array')
  const titles = out.results.map((r) => r.title)
  // Title filter: PM roles kept, "Staff Backend Engineer" dropped
  assert(titles.includes('Senior Project Manager'), 'keeps Senior Project Manager (word-overlap)')
  assert(titles.includes('Project Manager, ML'), 'keeps Project Manager, ML (lever)')
  assert(!titles.includes('Product Manager'), 'drops Product Manager (product != project)')
  assert(!titles.includes('Staff Backend Engineer'), 'drops Staff Backend Engineer (no title overlap)')
  assert(titles.includes('Project Manager'), 'keeps Adzuna Project Manager')
  // Shape check
  const sample = out.results[0]
  const keys = ['id','title','company','location','salaryMin','salaryMax','url','description','source','created']
  keys.forEach((k) => assert(k in sample, 'result has key ' + k))
  // Board jobs ranked before adzuna
  assert(out.results[out.results.length - 1].source === 'adzuna', 'adzuna sorted last')
  // sources meta
  assert(out.sources && out.sources.ats >= 2, 'sources.ats counted')

  console.log('Results (' + out.results.length + '):')
  out.results.forEach((r) => console.log('  [' + r.source + '] ' + r.title + ' @ ' + r.company + ' — ' + r.location))
  console.log('sources:', JSON.stringify(out.sources))

  // Remote filter test
  const res2 = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', titles: 'Project Manager', industry: 'AI / Machine Learning', remote: true, country: 'us' } }, res2)
  const remoteTitles = res2.body.results.filter((r) => r.source !== 'adzuna').map((r) => r.title)
  assert(remoteTitles.includes('Senior Project Manager'), 'remote keeps "Remote - US" job')
  assert(!remoteTitles.includes('Project Manager, ML'), 'remote drops SF-only job')

  // Direct-company-site scraper test: Workday (enterprise ATS) + SmartRecruiters/Recruitee found via
  // broadened discovery + a genuinely custom (no known ATS) careers page via Jina+Groq extraction.
  // (BRAVE_KEY/GROQ_KEY are already set at the top of this file, before jobs.js was imported.)
  const res3 = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', titles: 'Producer', industry: 'Media / Gaming', country: 'us' } }, res3)
  const out3 = res3.body
  assert(res3.statusCode === 200, 'direct-scraper search status 200, got ' + res3.statusCode)
  const bySource = (src) => out3.results.filter((r) => r.source === src)
  assert(bySource('workday').some((r) => r.title === 'Senior Producer' && r.company === 'Acme'), 'Workday CXS job normalized correctly, tenant/site extracted from a locale-prefixed discovered URL')
  assert(bySource('workday').some((r) => r.url.includes('/Acme_Careers/job/Producer_R123')), 'Workday job URL built from base + site + externalPath')
  assert(bySource('smartrecruiters').some((r) => r.company === 'Acme SR'), 'SmartRecruiters board found via broadened (non-ATS-scoped) discovery query')
  assert(bySource('recruitee').some((r) => r.company === 'Acme3'), 'Recruitee board found via broadened discovery query')
  assert(bySource('custom').some((r) => r.title === 'Senior Producer' && r.url === 'https://customstudio.example/careers/openings/123'), 'genuinely custom (no known ATS) careers page scraped via Jina+Groq, URL taken from the AI extraction')
  assert(bySource('custom').every((r) => r.created && !isNaN(Date.parse(r.created))), 'custom-page jobs get a real, parseable created date (an empty one sorts as the OLDEST possible posting and silently loses the freshness tiebreak against dated ATS listings, never surfacing past the results cap -- confirmed live)')
  assert(out3.sources.custom === 1, 'sources.custom reports the one extracted custom-page job, got ' + out3.sources.custom)
  assert(out3.sources.discovered >= 3, 'sources.discovered counts the workday+smartrecruiters+recruitee jobs, got ' + out3.sources.discovered)
  console.log('\nDirect-scraper sources:', JSON.stringify(out3.sources))
  console.log('Direct-scraper results:')
  out3.results.forEach((r) => console.log('  [' + r.source + '] ' + r.title + ' @ ' + r.company + ' — ' + r.location + ' — ' + r.url))

  if (fails.length) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1) }
  console.log('\nALL ASSERTIONS PASSED')
}
run().catch((e) => { console.error(e); process.exit(1) })
