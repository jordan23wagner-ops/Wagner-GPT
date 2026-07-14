// Mocked-logic test for api/company-lookup.js -- stubs global fetch, drives the handler, asserts
// the resolution ladder (seed -> registry -> search/ATS-discovery -> own-page scrape -> not-found)
// and the response shape. No live network. Same conventions as tests/jobs.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert'

process.env.BRAVE_KEY = 'test-brave-key'
delete process.env.TAVILY_KEY
delete process.env.TAVILY

const { default: handler } = await import('../api/company-lookup.js')

// Minimal req/res doubles matching what the Vercel handler actually touches.
function drive(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: null,
      status(c) { this.statusCode = c; return this },
      json(payload) { resolve({ status: this.statusCode, payload }) },
    }
    handler({ method: 'POST', body }, res)
  })
}

const GH_ANTHROPIC = {
  jobs: [
    { id: 1, title: 'Research Engineer', absolute_url: 'https://boards.greenhouse.io/anthropic/jobs/1', location: { name: 'San Francisco' }, content: 'Do research.', updated_at: '2026-07-01' },
    { id: 2, title: 'Product Manager', absolute_url: 'https://boards.greenhouse.io/anthropic/jobs/2', location: { name: 'Remote' }, content: 'Ship product.', updated_at: '2026-07-02' },
  ],
}

const CUSTOM_PAGE_HTML = `<!doctype html><html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting',
  title: 'Widget Engineer', datePosted: '2026-07-01',
  hiringOrganization: { '@type': 'Organization', name: 'Widgetco' },
  jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
  url: 'https://widgetco.example/careers/widget-engineer-42',
})}</script></head><body>Careers</body></html>`

test('company-lookup: seed fast path (Anthropic) fetches its Greenhouse board directly, no search/scrape involved', async () => {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).includes('boards-api.greenhouse.io/v1/boards/anthropic')) {
      return { ok: true, json: async () => GH_ANTHROPIC }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const { status, payload } = await drive({ company: 'Anthropic' })
  assert.strictEqual(status, 200)
  assert.strictEqual(payload.method, 'seed')
  assert.strictEqual(payload.results.length, 2)
  assert.strictEqual(payload.results[0].company, 'Anthropic')
  assert.strictEqual(payload.results[0].companyLookup, true)
  assert.strictEqual(payload.results[0].direct, true)
  assert.ok(!calls.some((u) => u.includes('search.brave.com')), 'the seed fast path must never reach the web search')
  assert.ok(!calls.some((u) => u.includes('r.jina.ai')), 'the seed fast path must never scrape')
})

test('company-lookup: unknown company with a domain resolves via its own /careers page (structured data), search+registry both empty', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('ats_board_registry')) return { ok: true, json: async () => [] }
    if (u.includes('search.brave.com')) return { ok: true, json: async () => ({ web: { results: [] } }) }
    if (u.startsWith('https://r.jina.ai/https://widgetco.example/careers')) {
      return { ok: true, text: async () => CUSTOM_PAGE_HTML }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const { status, payload } = await drive({ company: 'widgetco.example' })
  assert.strictEqual(status, 200)
  assert.strictEqual(payload.method, 'scraped')
  assert.strictEqual(payload.results.length, 1)
  assert.strictEqual(payload.results[0].title, 'Widget Engineer')
  assert.strictEqual(payload.results[0].url, 'https://widgetco.example/careers/widget-engineer-42')
  assert.strictEqual(payload.results[0].companyLookup, true)
})

test('company-lookup: nothing findable anywhere returns a clear message, not an error', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('ats_board_registry')) return { ok: true, json: async () => [] }
    if (u.includes('search.brave.com')) return { ok: true, json: async () => ({ web: { results: [] } }) }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
  const { status, payload } = await drive({ company: 'Zzqx Nonexistent Co 12345' })
  assert.strictEqual(status, 200)
  assert.deepStrictEqual(payload.results, [])
  assert.ok(payload.message && /couldn't find a careers page/i.test(payload.message), `expected a clear not-found message, got: ${payload.message}`)
  assert.ok(Array.isArray(payload.tried) && payload.tried.length > 0, 'the not-found response should say what was tried, for diagnosability')
})

test('company-lookup: rejects a missing/empty company', async () => {
  const { status, payload } = await drive({})
  assert.strictEqual(status, 400)
  assert.ok(payload.error)
})
