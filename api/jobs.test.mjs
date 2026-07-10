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

globalThis.fetch = async (url, opts) => {
  const u = String(url)
  const body = (opts && opts.body) || ''
  // Both the structured-data path and the AI-fallback path now hit r.jina.ai/{url} -- they differ
  // only by this header, matching the real fetchRawHtml/fetchCustomCareerPageViaAi calls.
  const returnFormat = (opts && opts.headers && opts.headers['X-Return-Format']) || ''
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
      // LinkedIn's own generic job-search page -- confirmed live to surface as a "custom careers page"
      // before linkedin was added to AGGREGATOR_HOST_RE; must be excluded as a custom-page candidate.
      { url: 'https://www.linkedin.com/jobs/search?keywords=Producer' },
      // An INDUSTRY JOB BOARD (not a single employer) that hosts other companies' individual postings
      // on its own domain -- confirmed live via Rigzone (an oil & gas job board). Its host isn't a
      // known aggregator, so it becomes a custom-page candidate; the fix under test is rejecting it
      // by company name, not by host, since an exhaustive niche-job-board host list is impossible.
      { url: 'https://jobboardexample.com/careers/listing-123' },
      // A shared SEARCH/LISTING page (not a specific posting) where the AI still names real, distinct
      // companies per line -- confirmed live via Rigzone entries for different real employers (NES
      // Fircroft, SBM Offshore, Vestas, Baker Hughes) all tracing back to the same generic URL
      // pattern with no per-posting date/ID, unlike a confirmed-good batch's distinct slugs.
      { url: 'https://industryboardexample.com/jobs-listing' },
      // A real company's own careers page with schema.org/JobPosting JSON-LD markup embedded --
      // must resolve via the free structured-data path WITHOUT ever calling Jina or Groq at all.
      { url: 'https://realcompany.example/careers/opening-1' },
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
  // Both fetchRawHtml (structured-data path) and fetchCustomCareerPageViaAi (AI fallback) now hit
  // r.jina.ai/{url}, differing only by X-Return-Format: 'html' vs 'text' -- these mocks branch on
  // returnFormat to mirror that exactly, matching the real code's two-stage try-structured-then-AI flow.
  if (u.includes('r.jina.ai/https://customstudio.example/careers/openings')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><body>Careers at Custom Studio — no structured data here</body></html>' }
    return { ok: true, text: async () => 'Careers at Custom Studio\n\nSenior Producer — Tokyo, Japan — apply at https://customstudio.example/careers/openings/123' }
  }
  // Should never actually be requested if linkedin.com is correctly excluded as a candidate -- present
  // so the test can prove exclusion (not just an unrelated fetch failure) is what keeps it out.
  if (u.includes('r.jina.ai/https://www.linkedin.com/jobs/search')) {
    return { ok: true, text: async () => 'LinkedIn Jobs\n\nProducer — search results' }
  }
  // The industry-job-board page: markup names the site itself as if it were the employer (the
  // real-world Rigzone shape) -- must be rejected since "company" equals the board's own name.
  if (u.includes('r.jina.ai/https://jobboardexample.com/careers/listing-123')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><body>Job Board Example — no structured data here</body></html>' }
    return { ok: true, text: async () => 'Job Board Example — Listing #123\n\nSenior Analyst posted on Job Board Example' }
  }
  if (u.includes('r.jina.ai/https://industryboardexample.com/jobs-listing')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><body>Industry Board Example — no structured data here</body></html>' }
    return { ok: true, text: async () => 'Industry Board Example — Process Operations Manager roles\n\nNES Corp — apply here\nSBM Corp — apply here' }
  }
  // A real company's own careers page with schema.org/JobPosting JSON-LD embedded -- returned via
  // Jina's html-render format (matching fetchRawHtml's real call, which routes through Jina rather
  // than a direct fetch since a direct fetch was confirmed live to either get 403'd by bot detection
  // or, on client-rendered sites, simply never see JS-injected markup at all). Deliberately has NO
  // text-format or api.groq.com mock for this URL, since a correct implementation should resolve this
  // entirely from structured data and never need either.
  if (u.includes('r.jina.ai/https://realcompany.example/careers/opening-1') && returnFormat === 'html') {
    return {
      ok: true,
      text: async () => '<html><head><script type="application/ld+json">' +
        JSON.stringify({
          '@context': 'https://schema.org', '@type': 'JobPosting',
          title: 'Live Events Producer', // must contain "producer" to pass this test's own title filter (search titles: 'Producer')
          hiringOrganization: { '@type': 'Organization', name: 'Real Company Inc.' },
          jobLocation: { '@type': 'Place', address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
          datePosted: '2026-07-01', validThrough: '2026-12-31', employmentType: 'FULL_TIME',
          description: 'Produce live events for Real Company.',
          url: 'https://realcompany.example/careers/opening-1-detail',
        }) +
        '</script></head><body>Careers at Real Company</body></html>',
    }
  }
  if (u.includes('api.groq.com')) {
    if (body.includes('jobboardexample.com')) {
      return json({ choices: [{ message: { content:
        '[{"title":"Senior Analyst","company":"Jobboardexample","location":"Remote","url":"https://jobboardexample.com/careers/listing-123-detail"}]'
      } }] })
    }
    if (body.includes('industryboardexample.com')) {
      // Two DIFFERENT real-looking companies sharing the exact same URL -- the shared-listing-page
      // signature. Both must be dropped, not just deduped down to one.
      return json({ choices: [{ message: { content:
        '[{"title":"Process Operations Manager","company":"NES Corp","location":"Remote","url":"https://industryboardexample.com/a-process-operations-manager-jobs/"},' +
        '{"title":"Process Operations Manager","company":"SBM Corp","location":"Remote","url":"https://industryboardexample.com/a-process-operations-manager-jobs/"}]'
      } }] })
    }
    // Second item deliberately has NO real posting url (the AI couldn't confirm one, e.g. it only
    // found a category/listing page) -- must be dropped rather than falling back to the source page.
    return json({ choices: [{ message: { content:
      '[{"title":"Senior Producer","company":"Custom Studio Inc.","location":"Tokyo, Japan","url":"https://customstudio.example/careers/openings/123"},' +
      '{"title":"Studio Overview","company":"Custom Studio Inc.","location":"","url":""}]'
    } }] })
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
  assert(!out3.results.some((r) => r.company === 'Linkedin' || /linkedin\.com/i.test(r.url)), 'linkedin.com is excluded as a custom-page candidate entirely -- confirmed live it surfaced as a fake "custom careers page" (linkedin.com/jobs/search) before this fix')
  assert(bySource('workday').some((r) => r.title === 'Senior Producer' && r.company === 'Acme'), 'Workday CXS job normalized correctly, tenant/site extracted from a locale-prefixed discovered URL')
  assert(bySource('workday').some((r) => r.url.includes('/Acme_Careers/job/Producer_R123')), 'Workday job URL built from base + site + externalPath')
  assert(bySource('smartrecruiters').some((r) => r.company === 'Acme SR'), 'SmartRecruiters board found via broadened (non-ATS-scoped) discovery query')
  assert(bySource('recruitee').some((r) => r.company === 'Acme3'), 'Recruitee board found via broadened discovery query')
  assert(bySource('custom').some((r) => r.title === 'Senior Producer' && r.company === 'Custom Studio Inc.' && r.url === 'https://customstudio.example/careers/openings/123'), 'genuinely custom (no known ATS) careers page scraped via Jina+Groq, real employer name and URL taken from the AI extraction')
  assert(bySource('custom').every((r) => r.created && !isNaN(Date.parse(r.created))), 'custom-page jobs get a real, parseable created date (an empty one sorts as the OLDEST possible posting and silently loses the freshness tiebreak against dated ATS listings, never surfacing past the results cap -- confirmed live)')
  assert(!bySource('custom').some((r) => r.title === 'Studio Overview'), 'a job with no confirmed specific posting url is dropped entirely, never falls back to the generic source page url (confirmed live: this previously surfaced linkedin.com/jobs/search and a Rigzone listings page as if they were real postings)')
  assert(!out3.results.some((r) => r.company === 'Jobboardexample'), 'a job whose "company" is just the board/site\'s own name (not a real distinct employer) is dropped -- confirmed live: Rigzone, an oil & gas industry job board hosting OTHER companies\' postings, was labeled as the "company" for every single posting it surfaced')
  assert(!out3.results.some((r) => r.company === 'NES Corp' || r.company === 'SBM Corp'), 'two DIFFERENT real-looking companies sharing the exact same posting url are both dropped, not deduped to one -- confirmed live: real distinct Rigzone employer names (NES Fircroft, SBM Offshore, Vestas, Baker Hughes) all traced back to near-identical URLs with no per-posting date/ID, the signature of one shared listing page rather than distinct postings')
  const structuredJob = bySource('custom').find((r) => r.company === 'Real Company Inc.')
  assert(!!structuredJob, 'a company career page with schema.org/JobPosting JSON-LD resolves via the free structured-data path -- no r.jina.ai or api.groq.com mock exists for this URL, so this only passes if fetchStructuredJobPostings actually worked')
  assert(structuredJob && structuredJob.url === 'https://realcompany.example/careers/opening-1-detail', 'structured-data job URL comes from the JSON-LD "url" field, not the discovered page URL')
  assert(structuredJob && structuredJob.created === '2026-07-01', 'structured-data job uses the REAL datePosted from JSON-LD, not a "just scraped" timestamp -- got ' + (structuredJob && structuredJob.created))
  assert(structuredJob && structuredJob.description.includes('Produce live events'), 'structured-data job carries a REAL description from JSON-LD -- AI/Jina extraction never populates this field at all')
  assert(structuredJob && structuredJob.location === 'Austin, TX, US', 'structured-data job location built from JSON-LD address fields, got ' + (structuredJob && structuredJob.location))
  assert(out3.sources.custom === 2, 'sources.custom reports the AI-extracted job plus the structured-data job, got ' + out3.sources.custom)
  assert(out3.sources.discovered >= 3, 'sources.discovered counts the workday+smartrecruiters+recruitee jobs, got ' + out3.sources.discovered)
  console.log('\nDirect-scraper sources:', JSON.stringify(out3.sources))
  console.log('Direct-scraper results:')
  out3.results.forEach((r) => console.log('  [' + r.source + '] ' + r.title + ' @ ' + r.company + ' — ' + r.location + ' — ' + r.url))

  if (fails.length) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1) }
  console.log('\nALL ASSERTIONS PASSED')
}
run().catch((e) => { console.error(e); process.exit(1) })
