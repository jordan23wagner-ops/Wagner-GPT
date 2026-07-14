// Focused test for the scrape-tier reliability fix in api/jobs.js: a bounded retry around
// TRANSIENT upstream failures (thrown fetch error / timeout / 5xx / 429) vs. a genuine,
// successfully-parsed empty result (never retried), plus the warm-lambda cache that now wraps
// fetchCustomCareerPage so an immediate repeat lookup of the same company doesn't re-scrape from
// scratch. No live network -- stubs globalThis.fetch, same convention as tests/jobs.test.mjs /
// tests/company-lookup.test.mjs.
//
// GROQ_KEY is a module-level constant in jobs.js (evaluated once at import time), so it's left
// unset here BEFORE the dynamic import -- with no key, fetchCustomCareerPageViaAi short-circuits
// to [] immediately, which keeps these cases deterministic: only the schema.org/JSON-LD path
// (fetchStructuredJobPostings -> fetchRawHtml) needs to be stubbed at all.
import { test } from 'node:test'
import assert from 'node:assert'

delete process.env.GROQ_KEY
delete process.env.Groq
delete process.env.GROQ

const { fetchCustomCareerPage } = await import('../api/jobs.js')

function jobPostingHtml(postingUrl) {
  return `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting',
    title: 'Retry Test Engineer', datePosted: '2026-07-01',
    hiringOrganization: { '@type': 'Organization', name: 'RetryCo' },
    jobLocation: { address: { addressLocality: 'Remote' } },
    url: postingUrl,
  })}</script></head><body>Careers</body></html>`
}

test('scrape reliability: a transient fetch failure (thrown network error) is retried and can then succeed', async () => {
  const url = 'https://retry-succeeds.example/careers'
  const jinaUrl = `https://r.jina.ai/${url}`
  let calls = 0
  globalThis.fetch = async (u) => {
    if (String(u) === jinaUrl) {
      calls++
      if (calls === 1) throw new Error('simulated transient network error')
      return { ok: true, text: async () => jobPostingHtml('https://retry-succeeds.example/careers/eng-1') }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const jobs = await fetchCustomCareerPage({ url, name: '' })
  assert.strictEqual(calls, 2, 'expected exactly one retry after the first (thrown) failure')
  assert.strictEqual(jobs.length, 1)
  assert.strictEqual(jobs[0].title, 'Retry Test Engineer')
})

test('scrape reliability: a genuine successfully-parsed empty result (200 OK, zero postings) is NOT retried', async () => {
  const url = 'https://genuinely-empty.example/careers'
  const jinaUrl = `https://r.jina.ai/${url}`
  let calls = 0
  globalThis.fetch = async (u) => {
    if (String(u) === jinaUrl) {
      calls++
      return { ok: true, text: async () => '<!doctype html><html><body>No open roles right now.</body></html>' }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const jobs = await fetchCustomCareerPage({ url, name: '' })
  assert.strictEqual(calls, 1, 'a 200 OK with zero JobPosting nodes is a genuine empty result -- must not be retried')
  assert.deepStrictEqual(jobs, [])
})

test('scrape reliability: a warm cache serves the prior non-empty result without re-fetching', async () => {
  // Same url+name as the first test, on purpose -- that call already populated the cache (only
  // non-empty results are ever cached) since fetchCustomCareerPage is now wrapped in `cached()`.
  const url = 'https://retry-succeeds.example/careers'
  const jinaUrl = `https://r.jina.ai/${url}`
  let calls = 0
  globalThis.fetch = async (u) => {
    if (String(u) === jinaUrl) { calls++; return { ok: true, text: async () => jobPostingHtml('https://retry-succeeds.example/careers/eng-1') } }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const jobs = await fetchCustomCareerPage({ url, name: '' })
  assert.strictEqual(calls, 0, 'expected the cache to serve this without any network call')
  assert.strictEqual(jobs.length, 1)
  assert.strictEqual(jobs[0].title, 'Retry Test Engineer')
})

test('scrape reliability: the empty result from the genuine-empty case above was NOT cached (re-fetches every time)', async () => {
  const url = 'https://genuinely-empty.example/careers'
  const jinaUrl = `https://r.jina.ai/${url}`
  let calls = 0
  globalThis.fetch = async (u) => {
    if (String(u) === jinaUrl) { calls++; return { ok: true, text: async () => '<!doctype html><html><body>Still nothing.</body></html>' } }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const jobs = await fetchCustomCareerPage({ url, name: '' })
  assert.strictEqual(calls, 1, 'an empty result must never be cached -- it should hit the network again, not be pinned as the answer')
  assert.deepStrictEqual(jobs, [])
})
