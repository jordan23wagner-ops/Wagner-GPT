// Phase 5 — Deep Research endpoint.
// Decomposes the question → runs 3-4 Brave/Tavily searches → fetches top pages via
// Jina AI reader (free, no key) → streams a synthesized report back as NDJSON:
//   {"step":"..."} — progress updates shown in the UI
//   {"delta":"..."} — streamed synthesis tokens
//   {"done":true,"sources":[...]} — terminal event with citation list
//   {"error":"..."} — terminal failure

export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const GROQ_KEY  = process.env.GROQ_KEY
  const BRAVE_KEY = process.env.BRAVE_KEY
  const TAVILY    = process.env.TAVILY_KEY || process.env.TAVILY || process.env.TAVILY_API_KEY

  if (!GROQ_KEY)           return res.status(503).json({ error: 'GROQ_KEY not configured.' })
  if (!BRAVE_KEY && !TAVILY) return res.status(503).json({ error: 'No search key (BRAVE_KEY or TAVILY_KEY).' })

  const { question, memory = [], customInstructions = '', aboutYou = '' } = req.body || {}
  if (!question?.trim()) return res.status(400).json({ error: 'Missing question.' })

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.statusCode = 200

  const emit = (obj) => res.write(JSON.stringify(obj) + '\n')

  try {
    // 1. Decompose into sub-queries
    emit({ step: 'Planning research strategy…' })
    const queries = await decomposeQuestion(question, GROQ_KEY)

    // 2. Search each sub-query
    const allResults = []
    for (const q of queries) {
      emit({ step: `Searching: "${q.slice(0, 55)}"` })
      try {
        const hits = BRAVE_KEY
          ? await braveSearch(q, BRAVE_KEY)
          : await tavilySearch(q, TAVILY)
        allResults.push(...hits)
      } catch { /* best-effort: skip failed searches */ }
    }

    if (!allResults.length) {
      emit({ error: 'No search results found — try rephrasing the question.' })
      return res.end()
    }

    // 3. Fetch full page text for top unique URLs via Jina AI reader (free tier)
    const uniq = [...new Map(allResults.map(r => [r.url, r])).values()].slice(0, 5)
    emit({ step: `Reading ${uniq.length} source${uniq.length !== 1 ? 's' : ''}…` })
    const sourceDocs = await fetchJina(uniq.map(r => r.url))

    // 4. Synthesize the report, streaming back deltas
    emit({ step: 'Writing research report…' })
    await streamSynthesis(question, allResults, sourceDocs, memory, customInstructions, aboutYou, GROQ_KEY, emit)

    // 5. Done — send citations
    emit({ done: true, sources: allResults.slice(0, 8).map(r => ({ title: r.title || r.url, url: r.url })) })
  } catch (err) {
    emit({ error: err.message || 'Deep research failed.' })
  }

  res.end()
}

// ─── Question decomposition ─────────────────────────────────────────────────

async function decomposeQuestion(question, groqKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{
        role: 'user',
        content:
          'Break this research question into 3-4 specific search queries for a web search engine.\n' +
          'Return ONLY a JSON array of query strings, nothing else.\n' +
          `Question: ${question}\n` +
          'Output: ["query one", "query two", "query three"]',
      }],
      temperature: 0.2,
      max_tokens: 220,
      stream: false,
    }),
  })
  const data = await res.json().catch(() => ({}))
  const text = data?.choices?.[0]?.message?.content || ''
  try {
    const match = text.match(/\[[\s\S]*?\]/)
    if (match) {
      const arr = JSON.parse(match[0])
      if (Array.isArray(arr) && arr.length) return arr.slice(0, 4).map(String)
    }
  } catch { /* fall through */ }
  return [question]
}

// ─── Search providers ────────────────────────────────────────────────────────

async function braveSearch(query, key) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&safesearch=moderate`
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': key },
  })
  if (!res.ok) throw new Error(`Brave ${res.status}`)
  const data = await res.json()
  return (data?.web?.results || []).slice(0, 5).map(r => ({
    url: r.url,
    title: r.title || r.url,
    snippet: r.description || '',
  }))
}

async function tavilySearch(query, key) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: 5, search_depth: 'basic' }),
  })
  if (!res.ok) throw new Error(`Tavily ${res.status}`)
  const data = await res.json()
  return (data?.results || []).slice(0, 5).map(r => ({
    url: r.url,
    title: r.title || r.url,
    snippet: r.content || '',
  }))
}

// ─── Jina AI reader — extracts clean text from any URL, free, no API key ────

async function fetchJina(urls) {
  const results = []
  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const r = await fetch(`https://r.jina.ai/${url}`, {
          headers: { Accept: 'text/plain', 'X-Return-Format': 'text' },
          signal: AbortSignal.timeout(8000),
        })
        if (!r.ok) return
        const text = await r.text()
        results.push({ url, text: text.slice(0, 4000) })
      } catch { /* skip unreachable pages */ }
    })
  )
  return results
}

// ─── Report synthesis (streaming) ───────────────────────────────────────────

async function streamSynthesis(question, searchResults, sourceDocs, memory, customInstructions, aboutYou, groqKey, emit) {
  const snippets = searchResults.slice(0, 8).map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`
  ).join('\n\n')

  const jinaBlocks = sourceDocs.slice(0, 3).map((d, i) =>
    `--- Full text of source ${i + 1}: ${d.url} ---\n${d.text}`
  ).join('\n\n')

  const systemParts = [
    'You are a thorough research assistant. Write a comprehensive, well-structured report that directly answers the question.',
    'Format your response with **bold section headers**, inline citations like [1] or [2] from the numbered sources, and a brief Conclusion at the end.',
    'Be detailed but concise — no padding or repetition.',
    memory.length   ? `Relevant user context:\n${memory.join('\n')}` : null,
    aboutYou        ? `About the user: ${aboutYou}` : null,
    customInstructions ? `Instructions: ${customInstructions}` : null,
  ].filter(Boolean).join('\n\n')

  const userPrompt = [
    `Question: ${question}`,
    `Search result snippets:\n${snippets}`,
    jinaBlocks ? `Full page content:\n${jinaBlocks}` : null,
  ].filter(Boolean).join('\n\n')

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemParts },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
      max_tokens: 2048,
      stream: true,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Synthesis ${res.status}: ${body.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const obj = JSON.parse(payload)
        const text = obj?.choices?.[0]?.delta?.content
        if (text) emit({ delta: text })
      } catch { /* skip malformed chunks */ }
    }
  }
}
