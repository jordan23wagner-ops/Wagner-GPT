// Mocked-logic test for api/jobs.js — stubs global fetch, drives the handler, asserts
// merge/dedupe/filter/shape. No live network.
import handler from './jobs.js'

process.env.ADZUNA_APP_ID = 'x'
process.env.ADZUNA_APP_KEY = 'y'
delete process.env.BRAVE_KEY
delete process.env.TAVILY_KEY
delete process.env.TAVILY

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

  if (fails.length) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1) }
  console.log('\nALL ASSERTIONS PASSED')
}
run().catch((e) => { console.error(e); process.exit(1) })
