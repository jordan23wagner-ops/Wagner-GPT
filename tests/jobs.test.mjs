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
process.env.JOOBLE_KEY = 'test-jooble-key'
process.env.CAREERJET_AFFID = 'test-careerjet-affid'
process.env.REED_API_KEY = 'test-reed-key'
process.env.USAJOBS_API_KEY = 'test-usajobs-key'
process.env.USAJOBS_EMAIL = 'test@example.com'
delete process.env.TAVILY_KEY
delete process.env.TAVILY

const { default: handler } = await import('../api/jobs.js')
const { default: crawlHandler } = await import('../api/jobs-crawl.js')

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
  if (u.includes('themuse.com/api/public/jobs')) {
    return json({ results: [
      { id: 501, name: 'Project Manager', company: { name: 'Muse Co' }, locations: [{ name: 'Remote' }], categories: [{ name: 'Product Management' }], levels: [{ name: 'Mid Level' }], contents: '<p>Manage products at Muse Co</p>', publication_date: '2026-07-01', refs: { landing_page: 'https://www.themuse.com/jobs/museco/project-manager' } },
    ] })
  }
  if (u.includes('jooble.org/api/test-jooble-key')) {
    return json({ jobs: [
      { id: 601, title: 'Project Manager', company: 'Jooble Co', location: 'Remote', snippet: 'Manage jooble projects', link: 'https://jooble.org/jdp/601', updated: '2026-07-02', type: 'Full-time' },
    ] })
  }
  if (u.includes('public-api.careerjet.com/search')) {
    return json({ jobs: [
      { title: 'Project Manager', company: 'Careerjet Co', locations: 'Remote', description: 'Manage careerjet projects', url: 'https://careerjet.com/job/701', date: '2026-07-03', salary_min: 80000, salary_max: 100000 },
    ] })
  }
  if (u.includes('data.usajobs.gov/api/search')) {
    return json({ SearchResult: { SearchResultItems: [
      { MatchedObjectId: 801, MatchedObjectDescriptor: {
        PositionTitle: 'Project Manager', OrganizationName: 'USAJobs Agency', PositionLocationDisplay: 'Washington, DC',
        PositionURI: 'https://www.usajobs.gov/job/801', PositionStartDate: '2026-07-04',
        PositionRemuneration: [{ MinimumRange: '90000', MaximumRange: '110000' }],
        PositionSchedule: [{ Name: 'Full-time' }],
        UserArea: { Details: { JobSummary: 'Manage federal projects' } },
      } },
    ] } })
  }
  if (u.includes('reed.co.uk/api/1.0/search')) {
    return json({ results: [
      { jobId: 901, jobTitle: 'Project Manager', employerName: 'Reed Co', locationName: 'London', jobUrl: 'https://reed.co.uk/job/901', jobDescription: 'Manage reed projects', date: '2026-07-05', minimumSalary: 50000, maximumSalary: 60000, jobType: 'Full-time' },
    ] })
  }
  // Supabase crawl cache -- POST (upsertCrawlCache, used only by api/jobs-crawl.js) must be checked
  // BEFORE the GET branch below since both hit the same table URL.
  if (u.includes('supabase.co/rest/v1/job_crawl_cache') && opts && opts.method === 'POST') {
    return { ok: true, json: async () => ([]) }
  }
  // Cache HIT, deliberately scoped to a single dedicated industry ("Manufacturing") not used by any
  // other test in this file -- proves the search handler actually took the cache path (skipping the
  // live per-company board fetch entirely) rather than merely tolerating cache data alongside live
  // data. No greenhouse mock exists for the fake company below, so this title can ONLY appear in
  // results if fetchBoardsFromCache's row was used, not a live (impossible-to-succeed) board fetch.
  if (u.includes('supabase.co/rest/v1/job_crawl_cache') && u.includes('industry=eq.Manufacturing')) {
    return json([
      { url: 'https://boards.greenhouse.io/cachedco/jobs/999', source: 'greenhouse', industry: 'Manufacturing', title: 'Plant Manager', company: 'CachedCo', location: 'Detroit, MI', salary_min: null, salary_max: null, category: '', category_tag: '', contract_time: '', description: 'Run the plant', created: '2026-07-01' },
    ])
  }
  // "Any industry" cache read: no industry=eq filter, ordered by created desc -- returns cross-industry
  // rows so one search sweeps every field. Two DIFFERENT industries' cached jobs come back together.
  if (u.includes('supabase.co/rest/v1/job_crawl_cache') && u.includes('order=created.desc') && !u.includes('industry=eq')) {
    return json([
      { url: 'https://boards.greenhouse.io/oilco/jobs/1', source: 'greenhouse', industry: 'Oil & Gas / Energy', title: 'Project Manager', company: 'OilCo', location: 'Houston, TX', salary_min: 130000, salary_max: 160000, category: '', category_tag: '', contract_time: '', description: 'Run energy projects', created: '2026-07-05' },
      { url: 'https://boards.greenhouse.io/medco/jobs/2', source: 'greenhouse', industry: 'Healthcare Tech', title: 'Program Manager', company: 'MedCo', location: 'Remote', salary_min: 125000, salary_max: 150000, category: '', category_tag: '', contract_time: '', description: 'Run health programs', created: '2026-07-06' },
    ])
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
      // CareerCircle's own browse/category listing page -- confirmed live to surface as a "custom
      // careers page" before careercircle was added to AGGREGATOR_HOST_RE, producing fabricated
      // entries (empty description, "just scraped" timestamp standing in for a real posting date)
      // since a job-board category page has no single real posting for the AI to describe.
      { url: 'https://www.careercircle.com/browse-jobs/category/manufacturing-and-production/producer' },
      // Built In's regional tech job board -- confirmed live to surface builtincolorado.com/jobs/...
      // as a "custom careers page" and fabricate 10 empty-description entries (Boeing, BAE Systems,
      // True Anomaly, ...) all attributed to Built In's own domain, since it's a multi-employer
      // listing page, not any one of those companies' actual careers site.
      { url: 'https://www.builtincolorado.com/jobs/dev-engineering' },
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
      // A career-advice/FAQ page (the confirmed-live ACBSP/Ross shape): the AI fallback returns
      // several "postings" that are really just section headings, each with a URL that's the SAME
      // page plus an anchor fragment (e.g. #store-manager) -- a different STRING from the source
      // page url but not a different page. Must be rejected entirely, not just deduped to one.
      { url: 'https://careeradviceexample.com/careers/manager' },
      // The confirmed-live Rigzone shape (found AFTER upgrading to a 70B model): a listing page
      // whose own structured data has zero real JobPosting nodes, and whose page text just names
      // companies with no per-posting link at all -- yet the AI fallback invented a plausible,
      // distinct, sequential-looking fake url per company (rigzone.com/jobs/.../jid-1234567 through
      // jid-1234574) instead of correctly returning []. Real company names + no shared-URL-collision
      // meant NEITHER the company-name check nor the duplicate-URL check caught this -- only a
      // deterministic "does this url actually appear in the source text" check can.
      { url: 'https://fakeurlexample.com/a-manager-jobs/' },
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
  // Should never actually be requested if careercircle.com is correctly excluded as a candidate --
  // present so the test can prove exclusion (not just an unrelated fetch failure) is what keeps it
  // out, and reproduces the exact live bug (a fabricated no-description/no-real-date entry) if the
  // exclusion regresses.
  if (u.includes('r.jina.ai/https://www.careercircle.com/browse-jobs/category')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><body>CareerCircle — Producer jobs</body></html>' }
    return { ok: true, text: async () => 'CareerCircle Jobs\n\nProducer — apply at https://www.careercircle.com/job/1' }
  }
  if (u.includes('api.groq.com') && body.includes('careercircle.com')) {
    return json({ choices: [{ message: { content:
      '[{"title":"Producer","company":"Careercircle","location":"","url":"https://www.careercircle.com/job/1"}]'
    } }] })
  }
  // Should never actually be requested if builtincolorado.com is correctly excluded as a candidate --
  // reproduces the exact live bug (10 fabricated no-description entries for different real companies
  // sharing the board's own domain) if the exclusion regresses.
  if (u.includes('r.jina.ai/https://www.builtincolorado.com/jobs/dev-engineering')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><body>Built In Colorado — Software Engineer jobs</body></html>' }
    return { ok: true, text: async () => 'Built In Colorado — Software Engineer roles\n\nBoeing — apply here\nTrue Anomaly — apply here' }
  }
  if (u.includes('api.groq.com') && body.includes('builtincolorado.com')) {
    return json({ choices: [{ message: { content:
      '[{"title":"Software Engineer","company":"Boeing","location":"","url":"https://www.builtincolorado.com/job/1"},' +
      '{"title":"Software Engineer","company":"True Anomaly","location":"","url":"https://www.builtincolorado.com/job/2"}]'
    } }] })
  }
  // The industry-job-board page: markup names the site itself as if it were the employer (the
  // real-world Rigzone shape) -- must be rejected since "company" equals the board's own name.
  if (u.includes('r.jina.ai/https://jobboardexample.com/careers/listing-123')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><body>Job Board Example — no structured data here</body></html>' }
    // The real posting url IS present in the source markdown (unlike the fabricated-url case below),
    // so this test keeps independently exercising the company-name-matches-board-name rejection --
    // it isn't just passing because the URL-verification filter short-circuited it first.
    return { ok: true, text: async () => 'Job Board Example — [Senior Analyst](https://jobboardexample.com/careers/listing-123-detail) posted on Job Board Example' }
  }
  if (u.includes('r.jina.ai/https://industryboardexample.com/jobs-listing')) {
    // Confirmed live (careers.acbsp.org / jobdescription.org): "has ld+json script tag: true" yet
    // "JobPosting nodes found: 0" -- one real cause is a malformed/truncated JSON-LD block that
    // JSON.parse throws on. Included here (alongside the valid-but-non-JobPosting Organization block)
    // so extractJsonLdJobPostings's parseFailures counter is exercised and the page still correctly
    // falls through to the AI fallback rather than the parse error aborting the whole request.
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><head>' +
      '<script type="application/ld+json">{ this is not valid json </script>' +
      '<script type="application/ld+json">' + JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Industry Board Example' }) + '</script>' +
      '</head><body>Industry Board Example — no JobPosting markup here</body></html>' }
    // Both companies' links resolve to the SAME real url (present in the source markdown, so the
    // URL-verification filter doesn't reject them) -- this test keeps independently exercising the
    // duplicate-URL-across-different-companies rejection, not just the newer URL-verification filter.
    return { ok: true, text: async () => 'Industry Board Example — [Process Operations Manager roles](https://industryboardexample.com/a-process-operations-manager-jobs/)\n\nNES Corp — apply here\nSBM Corp — apply here' }
  }
  // A real company's own careers page with schema.org/JobPosting JSON-LD embedded -- returned via
  // Jina's html-render format (matching fetchRawHtml's real call, which routes through Jina rather
  // than a direct fetch since a direct fetch was confirmed live to either get 403'd by bot detection
  // or, on client-rendered sites, simply never see JS-injected markup at all). Deliberately has NO
  // text-format or api.groq.com mock for this URL, since a correct implementation should resolve this
  // entirely from structured data and never need either.
  // The JobPosting is deliberately NESTED three levels deep (WebPage -> mainEntity -> JobPosting,
  // itself inside an @graph array) rather than a flat top-level node -- confirmed live that some
  // real sites' JSON-LD shapes this way, which the original flat/@graph-only extractor silently
  // missed ("ld+json tag exists, 0 JobPosting nodes found"). Also carries an unrelated BreadcrumbList
  // sibling node to prove the walk doesn't stop at the first non-matching type.
  if (u.includes('r.jina.ai/https://realcompany.example/careers/opening-1') && returnFormat === 'html') {
    return {
      ok: true,
      text: async () => '<html><head><script type="application/ld+json">' +
        JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'BreadcrumbList', itemListElement: [] },
            {
              '@type': 'WebPage',
              mainEntity: {
                '@type': 'JobPosting',
                title: 'Live Events Producer', // must contain "producer" to pass this test's own title filter (search titles: 'Producer')
                hiringOrganization: { '@type': 'Organization', name: 'Real Company Inc.' },
                jobLocation: { '@type': 'Place', address: { addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
                datePosted: '2026-07-01', validThrough: '2026-12-31', employmentType: 'FULL_TIME',
                description: 'Produce live events for Real Company.',
                url: 'https://realcompany.example/careers/opening-1-detail',
              },
            },
          ],
        }) +
        '</script></head><body>Careers at Real Company</body></html>',
    }
  }
  // Career-advice page: no structured data, and the AI fallback (mocked below) returns several
  // "postings" that are really just FAQ/section headings on the SAME page, each url differing from
  // the source page only by an anchor fragment -- the confirmed-live ACBSP/Ross failure shape.
  if (u.includes('r.jina.ai/https://careeradviceexample.com/careers/manager')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><body>Career advice — no structured data here</body></html>' }
    return { ok: true, text: async () => 'What Does A Producer Do?\nHow To Become A Producer?\nGet Producer Jobs Emailed To You\nSearch For Producer Jobs' }
  }
  if (u.includes('api.groq.com') && body.includes('careeradviceexample.com')) {
    return json({ choices: [{ message: { content:
      '[{"title":"What Does A Producer Do?","company":"Career Advice Example","location":"","url":"https://careeradviceexample.com/careers/manager#what-does-a-producer-do"},' +
      '{"title":"How To Become A Producer?","company":"Career Advice Example","location":"","url":"https://careeradviceexample.com/careers/manager#how-to-become-a-producer"},' +
      '{"title":"Get Producer Jobs Emailed To You","company":"Career Advice Example","location":"","url":"https://careeradviceexample.com/careers/manager#get-jobs-emailed"},' +
      '{"title":"Search For Producer Jobs","company":"Career Advice Example","location":"","url":"https://careeradviceexample.com/careers/manager#search-jobs"}]'
    } }] })
  }
  // Rigzone shape: the page names real companies with NO per-posting link at all (plain text, not
  // even a markdown link) -- there is no real url anywhere for the model to honestly cite.
  if (u.includes('r.jina.ai/https://fakeurlexample.com/a-manager-jobs/')) {
    if (returnFormat === 'html') return { ok: true, text: async () => '<html><head><script type="application/ld+json">' + JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage' }) + '</script></head><body>Fake URL Example — Manager roles</body></html>' }
    return { ok: true, text: async () => 'Fake URL Example — Manager roles\n\nAcme Corp — apply here\nGlobex Corp — apply here' }
  }
  if (u.includes('api.groq.com') && body.includes('fakeurlexample.com')) {
    // The model invents a plausible, distinct, sequential-looking url per real company instead of
    // correctly returning [] -- exactly the confirmed-live Rigzone hallucination, reproduced here.
    return json({ choices: [{ message: { content:
      '[{"title":"Warehouse Manager","company":"Acme Corp","location":"Remote","url":"https://fakeurlexample.com/jobs/warehouse-manager-jobs-116/jid-1234567"},' +
      '{"title":"Plant Manager","company":"Globex Corp","location":"Remote","url":"https://fakeurlexample.com/jobs/plant-manager-jobs-116/jid-1234568"}]'
    } }] })
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
  // New aggregator sources (item #2 of the roadmap): The Muse (keyless), Jooble, Careerjet, USAJobs
  // (country:'us', treated as direct) all normalized and merged in.
  assert(out.results.some((r) => r.source === 'themuse' && r.company === 'Muse Co'), 'The Muse job normalized (no key required)')
  assert(out.results.some((r) => r.source === 'jooble' && r.company === 'Jooble Co'), 'Jooble job normalized')
  assert(out.results.some((r) => r.source === 'careerjet' && r.company === 'Careerjet Co'), 'Careerjet job normalized')
  assert(out.results.some((r) => r.source === 'usajobs' && r.company === 'USAJobs Agency'), 'USAJobs job normalized (fires for country:us)')
  assert(!out.results.some((r) => r.source === 'reed'), 'Reed does not fire for country:us (UK-only source)')
  const usajobsJob = out.results.find((r) => r.source === 'usajobs')
  assert(usajobsJob && usajobsJob.direct === true, 'USAJobs treated as a direct source (the government\'s own official board), not an aggregator')
  const themuseJob = out.results.find((r) => r.source === 'themuse')
  assert(themuseJob && themuseJob.direct === false, 'The Muse treated as an aggregator, not a direct employer link')

  console.log('Results (' + out.results.length + '):')
  out.results.forEach((r) => console.log('  [' + r.source + '] ' + r.title + ' @ ' + r.company + ' — ' + r.location))
  console.log('sources:', JSON.stringify(out.sources))

  // Remote filter test
  const res2 = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', titles: 'Project Manager', industry: 'AI / Machine Learning', remote: true, country: 'us' } }, res2)
  const remoteTitles = res2.body.results.filter((r) => r.source !== 'adzuna').map((r) => r.title)
  assert(remoteTitles.includes('Senior Project Manager'), 'remote keeps "Remote - US" job')
  assert(!remoteTitles.includes('Project Manager, ML'), 'remote drops SF-only job')

  // Country-gated source test: Reed (UK-only) fires for country:'gb' and USAJobs (US-only) does not.
  const resGb = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', titles: 'Project Manager', country: 'gb' } }, resGb)
  assert(resGb.body.results.some((r) => r.source === 'reed' && r.company === 'Reed Co'), 'Reed job normalized and fires for country:gb')
  assert(!resGb.body.results.some((r) => r.source === 'usajobs'), 'USAJobs does not fire for country:gb (US-only source)')

  // Crawl-cache test (item #3 of the roadmap): a search for the "Manufacturing" industry should read
  // pre-crawled ATS results straight from job_crawl_cache instead of live-fetching every seed board.
  const resCache = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', titles: 'Manager', industry: 'Manufacturing', country: 'us' } }, resCache)
  assert(resCache.body.results.some((r) => r.company === 'CachedCo' && r.title === 'Plant Manager' && r.source === 'greenhouse'), 'cached ATS row surfaces in results -- can only happen via the cache path, since no live-fetch mock exists for this fake company')
  assert(resCache.body.sources && resCache.body.sources.atsFromCache === true, 'sources.atsFromCache reports true on a cache hit')

  // "Any industry" sweep: one search pulls jobs from MULTIPLE industries' cache at once (no industry
  // filter). OilCo (Oil & Gas) and MedCo (Healthcare) both come back for a title-only search.
  const resAll = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', titles: 'Project Manager, Program Manager', industry: 'Any industry', country: 'us' } }, resAll)
  assert(resAll.body.results.some((r) => r.company === 'OilCo') && resAll.body.results.some((r) => r.company === 'MedCo'), 'Any-industry search returns jobs from DIFFERENT industries at once (OilCo + MedCo), via the cross-industry cache read')
  assert(resAll.body.sources && resAll.body.sources.atsFromCache === true, 'Any-industry search reports atsFromCache on the cross-industry cache hit')

  // Direct-company-site scraper test: Workday (enterprise ATS) + SmartRecruiters/Recruitee found via
  // broadened discovery + a genuinely custom (no known ATS) careers page via Jina+Groq extraction.
  // (BRAVE_KEY/GROQ_KEY are already set at the top of this file, before jobs.js was imported.)
  const res3 = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'search', titles: 'Producer', industry: 'Media / Gaming', country: 'us' } }, res3)
  const out3 = res3.body
  assert(res3.statusCode === 200, 'direct-scraper search status 200, got ' + res3.statusCode)
  const bySource = (src) => out3.results.filter((r) => r.source === src)
  assert(!out3.results.some((r) => r.company === 'Linkedin' || /linkedin\.com/i.test(r.url)), 'linkedin.com is excluded as a custom-page candidate entirely -- confirmed live it surfaced as a fake "custom careers page" (linkedin.com/jobs/search) before this fix')
  assert(!out3.results.some((r) => /careercircle\.com/i.test(r.url)), 'careercircle.com is excluded as a custom-page candidate entirely -- confirmed live its /browse-jobs/category page surfaced as a fake "custom careers page" producing empty-description, fabricated-timestamp entries before this fix')
  assert(!out3.results.some((r) => /builtincolorado\.com/i.test(r.url)), 'builtincolorado.com (Built In\'s regional tech job board) is excluded as a custom-page candidate entirely -- confirmed live it surfaced as a fake "custom careers page" and fabricated 10 empty-description entries for different real companies before this fix')
  assert(!out3.results.some((r) => /careeradviceexample\.com/i.test(r.url)), 'career-advice-page "postings" that are really FAQ/section headings on the same page (url differing only by a #anchor fragment) are rejected entirely -- confirmed live via ACBSP\'s "What Does A Manufacturing Manager Do?" and Ross\'s "STORE MANAGER" category links, both fabricated as fake jobs before this fix')
  assert(!out3.results.some((r) => /fakeurlexample\.com/i.test(r.url) || r.company === 'Acme Corp' || r.company === 'Globex Corp'), 'a plausible-looking but entirely FABRICATED url (not present anywhere in the fetched source text) is rejected even when the company name is real/distinct and no other candidate shares that exact url -- confirmed live via Rigzone AFTER upgrading to a 70B model: it invented sequential-looking fake urls (jid-1234567 through jid-1234574) for real companies instead of correctly returning [], which neither the company-name check nor the duplicate-URL check alone could catch')
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

  // Crawl endpoint test (api/jobs-crawl.js): re-fetches every industry's ATS boards and upserts into
  // job_crawl_cache via the mocked POST above. Unauthenticated since CRON_SECRET isn't set in this
  // test env -- exercises the "no secret configured, allow the request" path.
  const resCrawl = mockRes()
  await crawlHandler({ method: 'GET', headers: {} }, resCrawl)
  assert(resCrawl.statusCode === 200, 'crawl endpoint status 200, got ' + resCrawl.statusCode)
  assert(resCrawl.body && resCrawl.body.industries === 11, 'crawl endpoint processes every INDUSTRY_BOARDS industry, got ' + (resCrawl.body && resCrawl.body.industries))
  const aiSummary = resCrawl.body && resCrawl.body.summary && resCrawl.body.summary.find((s) => s.industry === 'AI / Machine Learning')
  assert(aiSummary && aiSummary.fetched >= 2, 'crawl fetched multiple ATS jobs for a seeded industry (Databricks/Cohere/Gamma mocks), got ' + (aiSummary && aiSummary.fetched))
  assert(aiSummary && aiSummary.ok && aiSummary.upserted === aiSummary.fetched, 'crawl upserted every fetched job for that industry (mocked POST returns ok:true)')

  // CRON_SECRET auth test: once set, the crawl endpoint rejects requests without a matching bearer token.
  process.env.CRON_SECRET = 'test-cron-secret'
  const resUnauth = mockRes()
  await crawlHandler({ method: 'GET', headers: {} }, resUnauth)
  assert(resUnauth.statusCode === 401, 'crawl endpoint rejects an unauthenticated request once CRON_SECRET is set, got ' + resUnauth.statusCode)
  const resAuth = mockRes()
  await crawlHandler({ method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } }, resAuth)
  assert(resAuth.statusCode === 200, 'crawl endpoint accepts a request with the correct bearer token, got ' + resAuth.statusCode)
  delete process.env.CRON_SECRET

  if (fails.length) { console.error('\nFAILURES:\n - ' + fails.join('\n - ')); process.exit(1) }
  console.log('\nALL ASSERTIONS PASSED')
}
run().catch((e) => { console.error(e); process.exit(1) })
