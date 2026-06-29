// Wagner-GPT chat backend (streaming)
// Strategy: try Ollama Cloud first (free), fall back to NVIDIA NIM (dev credits) on failure.
// Image generation: NVIDIA NIM FLUX.1-dev primary, Hugging Face FLUX.1-schnell fallback.
// Each provider has a different streaming format; we normalize both into a single
// newline-delimited JSON (NDJSON) stream to the client:
//   {"delta":"token text"}\n   (zero or more)
//   {"image":"<base64 jpeg>","mediaType":"image/jpeg","prompt":"..."}\n   (AI-generated image)
//   {"done":true,"provider":"ollama"}\n   (terminal success)
//   {"error":"message"}\n   (terminal failure, only if NOTHING streamed yet)
//
// Image generation is exposed to the chat model as a `generate_image` tool. When the
// model decides to call it (e.g. "draw a garden"), we run the prompt through NVIDIA
// NIM's FLUX.1-dev endpoint and stream the result as an {"image":...} event.
//
// Fallback caveat: once we've flushed the first delta the HTTP response is committed,
// so provider fallback is only possible BEFORE the first token. The wroteAny flag
// reflects this.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { messages, newMessage, image, model, webSearch } = req.body

  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY
  const HUGGINGFACE_KEY = process.env.HUGGINGFACE_KEY
  const TAVILY_KEY = process.env.TAVILY_KEY

  if (!OLLAMA_CLOUD_KEY && !NVIDIA_NIM_KEY) {
    return res.status(500).json({ error: 'No API keys configured (need OLLAMA_CLOUD_KEY and/or NVIDIA_NIM_KEY).' })
  }

  // Provider-specific model IDs for each dropdown choice.
  // Ollama Cloud tags must match exactly what `GET https://ollama.com/api/tags`
  // returns for this account (no `:cloud` suffix). NIM IDs must be live in the
  // catalog at https://integrate.api.nvidia.com/v1/models (EOL models 410/Gone).
  const MODEL_MAP = {
    m3:       { ollama: 'minimax-m3',              nim: 'minimaxai/minimax-m3',          order: ['ollama', 'nim'] },
    // NIM fallback is text-only (images are stripped), so gemma's backstop is just a
    // reliable text model. The NIM gemma deployments 404/time-out; llama-3.3 is steady.
    gemma:    { ollama: 'gemma4:31b',              nim: 'meta/llama-3.3-70b-instruct',   order: ['ollama', 'nim'] },
    // Smarter free Ollama Cloud models (no vision). gpt-oss is a fast MoE with strong
    // reasoning + reliable tool-calling; qwen3-coder is tuned for code. llama-3.3 is the
    // text-only NIM backstop for both.
    gptoss:   { ollama: 'gpt-oss:120b',            nim: 'meta/llama-3.3-70b-instruct',   order: ['ollama', 'nim'] },
    qwen:     { ollama: 'qwen3-coder:480b',        nim: 'meta/llama-3.3-70b-instruct',   order: ['ollama', 'nim'] }
  }

  // Resolve the effective model.
  //  - 'auto' classifies the query: M3 for reasoning/coding/math, Gemma otherwise.
  //  - Image requests ALWAYS route to Gemma — it reliably drives the generate_image
  //    tool; M3 frequently refuses to call it. This holds even if the user manually
  //    selected M3, so "draw me X" just works without a manual model switch.
  const wantsImage = isImageRequest(newMessage)
  let effectiveModel = model
  if (model === 'auto') {
    effectiveModel = wantsImage ? 'gemma' : classifyQuery(newMessage)
  } else if (wantsImage && model === 'm3') {
    effectiveModel = 'gemma'
  }

  const ids = MODEL_MAP[effectiveModel]
  if (!ids) {
    return res.status(400).json({ error: `Unknown model: ${model}` })
  }

  // Optional web search (Tavily): run BEFORE the model so we can inject current
  // results as context. Skipped for image requests (no point searching "draw a cat").
  let searchData = null
  if (webSearch && TAVILY_KEY && newMessage && !wantsImage) {
    try {
      searchData = await runWebSearch(newMessage, TAVILY_KEY)
    } catch (err) {
      console.error('Web search failed:', err.message)
    }
  }

  // Build a normalized message list (text + optional image part).
  const history = (messages || []).map(m => ({ role: m.role, content: m.content }))
  const userTurn = {
    role: 'user',
    content: image
      ? [
          { type: 'text', text: newMessage },
          { type: 'image_url', image_url: { url: `data:${image.mediaType || 'image/jpeg'};base64,${image.data}` } }
        ]
      : newMessage
  }
  // Prepend search results as a system message when we have them.
  const fullMessages = searchData
    ? [buildSearchSystem(newMessage, searchData), ...history, userTurn]
    : [...history, userTurn]

  // Stream headers. We commit these immediately; everything after is NDJSON chunks.
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')

  // Shared writer + a flag tracking whether any token has been flushed.
  const state = { wroteAny: false }
  const writeDelta = (text) => {
    if (!text) return
    state.wroteAny = true
    res.write(JSON.stringify({ delta: text }) + '\n')
  }

  const errors = []

  // Offer the image tool when any image provider is available.
  const hasImageProvider = NVIDIA_NIM_KEY || HUGGINGFACE_KEY
  const tools = hasImageProvider ? [IMAGE_TOOL] : undefined

  // 1) Try Ollama Cloud first (free path).
  if (OLLAMA_CLOUD_KEY) {
    try {
      const { toolCall } = await streamOllama(fullMessages, ids.ollama, OLLAMA_CLOUD_KEY, writeDelta, tools)
      if (toolCall) {
        await runImageTool(toolCall, newMessage, NVIDIA_NIM_KEY, HUGGINGFACE_KEY, res, writeDelta)
      }
      if (searchData) writeDelta(sourcesMarkdown(searchData))
      res.write(JSON.stringify({ done: true, provider: 'ollama', model: effectiveModel }) + '\n')
      return res.end()
    } catch (err) {
      console.error('Ollama failed:', err.message)
      errors.push(`Ollama: ${err.message}`)
      // Only safe to fall through if we haven't sent any tokens yet.
      if (state.wroteAny) {
        res.write(JSON.stringify({ error: `Stream interrupted (Ollama): ${err.message}` }) + '\n')
        return res.end()
      }
      // else: fall through to NIM
    }
  }

  // 2) Fall back to NVIDIA NIM (dev credits).
  if (NVIDIA_NIM_KEY && !state.wroteAny) {
    try {
      await streamNim(fullMessages, ids.nim, NVIDIA_NIM_KEY, writeDelta)
      if (searchData) writeDelta(sourcesMarkdown(searchData))
      res.write(JSON.stringify({ done: true, provider: 'nim', model: effectiveModel }) + '\n')
      return res.end()
    } catch (err) {
      console.error('NIM failed:', err.message)
      errors.push(`NIM: ${err.message}`)
      if (state.wroteAny) {
        res.write(JSON.stringify({ error: `Stream interrupted (NIM): ${err.message}` }) + '\n')
        return res.end()
      }
    }
  }

  // Both providers failed before emitting anything.
  const msg = 'All available models failed. ' + (errors[errors.length - 1] || 'Please try again shortly.')
  res.write(JSON.stringify({ error: msg }) + '\n')
  return res.end()
}


// ---- Auto-routing heuristics ----
//
// Cheap, deterministic intent detection so 'auto' mode and image-request switching
// cost zero extra API calls. Tuned to be permissive on image intent (cheap to be
// wrong — Gemma just answers normally) and conservative on the M3 reasoning route.

// Does this read like an image-generation request?
const IMAGE_INTENT_RE =
  /\b(draw|paint|sketch|render|generate|create|make|design|show me)\b[^.?!]*\b(image|picture|photo|pic|art|drawing|painting|illustration|logo|wallpaper|portrait|scene|landscape|icon|avatar)\b|\b(draw|paint|sketch)\s+(me\s+)?(a|an|the|some)\b/i

function isImageRequest(text) {
  return typeof text === 'string' && IMAGE_INTENT_RE.test(text)
}

// M3 is the stronger reasoner (code, math, logic, structured analysis). Everything
// else — creative writing, casual chat, vision — goes to Gemma, the safe default.
const REASONING_RE =
  /\b(code|coding|program|programming|function|debug|bug|stack trace|algorithm|regex|sql|python|javascript|typescript|c\+\+|rust|golang|compile|refactor|math|calculate|equation|solve|derivative|integral|proof|logic|analy[sz]e|analysis|compare|trade-?offs?|step by step|reason|optimi[sz]e|complexity|architecture|formula|spreadsheet)\b/i

function classifyQuery(text) {
  return typeof text === 'string' && REASONING_RE.test(text) ? 'm3' : 'gemma'
}

// ---- Web search (Tavily) ----
//
// Tavily is LLM-optimized: one call returns a synthesized answer plus ranked source
// snippets. We inject those as a system message so the model answers from current
// info, then append a clickable Sources list to the reply.

async function runWebSearch(query, key) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: String(query).slice(0, 400),
      max_results: 5,
      include_answer: true,
      search_depth: 'basic',
    }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Tavily ${response.status} ${body.slice(0, 120)}`)
  }
  const data = await response.json()
  const results = Array.isArray(data.results) ? data.results.slice(0, 5) : []
  if (!results.length && !data.answer) throw new Error('no results')
  return { answer: data.answer || '', results }
}

function buildSearchSystem(query, search) {
  const today = new Date().toISOString().slice(0, 10)
  const lines = search.results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${String(r.content || '').slice(0, 500)}`)
    .join('\n\n')
  return {
    role: 'system',
    content:
      `Today's date is ${today}. The user enabled web search; current results are below. ` +
      `Answer using them, cite inline like [1], [2], and be concise. If the results don't ` +
      `cover the question, say so.\n\nQuery: ${query}\n\n` +
      (search.answer ? `Quick summary: ${search.answer}\n\n` : '') +
      `Results:\n${lines}`,
  }
}

function sourcesMarkdown(search) {
  if (!search.results.length) return ''
  return (
    '\n\n**Sources:**\n' +
    search.results.map((r, i) => `${i + 1}. [${r.title}](${r.url})`).join('\n')
  )
}

// ---- Provider streamers ----
//
// Each streamer connects with stream:true, reads the body, parses provider-specific
// chunks, and calls onDelta(text) for each token. Connect-time failures (network /
// non-OK status) are retried with backoff BEFORE the first byte is read. Once the
// body is streaming we no longer retry.

const MAX_RETRIES = 2
const BASE_DELAY_MS = 600
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const backoff = (attempt) => BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250)

// Open a streaming POST with connect retry on 429/5xx/network. Returns the Response
// once status is OK; throws on exhausted retries.
async function openWithRetry(url, options) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response
    try {
      response = await fetch(url, options)
    } catch (netErr) {
      if (attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }
      throw new Error('network error')
    }

    if (response.ok) return response

    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }

    const body = await response.text().catch(() => '')
    throw new Error(`${response.status} ${body.slice(0, 200)}`)
  }
  throw new Error('exhausted retries')
}

// Iterate decoded text chunks from a fetch Response body, yielding complete lines.
// Buffers partial lines across chunks. Works with both Web ReadableStream (reader)
// and Node Readable (async iterator) bodies.
async function* iterLines(response) {
  const decoder = new TextDecoder()
  let buffer = ''

  function* drain() {
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      yield line
    }
  }

  const body = response.body
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      yield* drain()
    }
  } else {
    // Node stream fallback
    for await (const chunk of body) {
      buffer += (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
      yield* drain()
    }
  }

  if (buffer.length) yield buffer
}

// Ollama Cloud: native /api/chat, stream:true -> NDJSON, one JSON object per line:
//   { "message": { "content": "..." }, "done": false }
// M3 supports vision; images go as a separate images:[base64] array on the message.
async function streamOllama(messages, model, apiKey, onDelta, tools) {
  const ollamaMessages = messages.map(m => {
    if (Array.isArray(m.content)) {
      const text = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      const imgs = m.content
        .filter(c => c.type === 'image_url')
        .map(c => (c.image_url.url.split(',')[1]))
      return imgs.length ? { role: m.role, content: text, images: imgs } : { role: m.role, content: text }
    }
    return { role: m.role, content: m.content }
  })

  const payload = { model, messages: ollamaMessages, stream: true }
  if (tools && tools.length) payload.tools = tools

  const response = await openWithRetry('https://ollama.com/api/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  let got = false
  let toolCall = null
  for await (const line of iterLines(response)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try { obj = JSON.parse(trimmed) } catch { continue }
    if (obj.error) throw new Error(String(obj.error).slice(0, 200))
    const m = obj && obj.message
    if (m) {
      if (!toolCall && Array.isArray(m.tool_calls)) {
        const tc = m.tool_calls.find(t => t.function && t.function.name === 'generate_image')
        if (tc) toolCall = tc
      }
      if (m.content) { got = true; onDelta(m.content) }
    }
    if (obj.done) break
  }
  // A tool call is a valid outcome even when the model emits no text.
  if (!got && !toolCall) throw new Error('empty response')
  return { toolCall }
}

// ---- Image generation (generate_image tool -> NVIDIA NIM FLUX.1-dev) ----

// Tool schema advertised to the chat model. Description is deliberately explicit so
// the model reliably routes "draw / paint / create / show a picture" requests here.
const IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image from a text description. Call this whenever the user asks you to draw, paint, create, generate, render, or show a picture/image/photo of something.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'A detailed, vivid description of the image to generate.' }
      },
      required: ['prompt']
    }
  }
}

// FLUX.1-dev accepts width/height only from a fixed set; 1024 square is the safe default.
async function generateImage(prompt, nimKey) {
  const response = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${nimKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      prompt: String(prompt).slice(0, 1500),
      width: 1024,
      height: 1024,
      steps: 25,
      cfg_scale: 3.5,
      seed: Math.floor(Math.random() * 1e9)
    })
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${response.status} ${body.slice(0, 150)}`)
  }
  const data = await response.json()
  const b64 = data && data.artifacts && data.artifacts[0] && data.artifacts[0].base64
  if (!b64) throw new Error('no image returned')
  return b64
}

// Hugging Face Inference API: FLUX.1-schnell (free, rate-limited, no credit pool).
// Returns raw image bytes; we base64-encode them for the NDJSON stream.
async function generateImageHF(prompt, hfKey) {
  const response = await fetch(
    'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfKey}`,
        'Content-Type': 'application/json',
        'Accept': 'image/jpeg',
      },
      body: JSON.stringify({ inputs: String(prompt).slice(0, 1500) }),
    }
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HF ${response.status} ${body.slice(0, 150)}`)
  }
  const buf = await response.arrayBuffer()
  if (!buf || buf.byteLength < 1000) throw new Error('HF returned empty image')
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// Execute a generate_image tool call: pull the prompt, try NIM then HF, stream the image.
// Never throws — on failure it streams a short note so the request still completes.
async function runImageTool(toolCall, fallbackPrompt, nimKey, hfKey, res, onDelta) {
  let prompt = fallbackPrompt
  try {
    const args = toolCall.function.arguments
    const parsed = typeof args === 'string' ? JSON.parse(args) : args
    if (parsed && parsed.prompt) prompt = parsed.prompt
  } catch { /* fall back to the user's raw message */ }

  if (!nimKey && !hfKey) {
    onDelta('\n\n⚠️ Image generation isn\'t configured (no NIM or HuggingFace key).')
    return
  }

  // Try NVIDIA NIM first (faster, higher quality), fall back to HuggingFace.
  if (nimKey) {
    try {
      const b64 = await generateImage(prompt, nimKey)
      res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt }) + '\n')
      return
    } catch (err) {
      console.error('NIM FLUX failed, trying HuggingFace:', err.message)
    }
  }

  if (hfKey) {
    try {
      const b64 = await generateImageHF(prompt, hfKey)
      res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt }) + '\n')
      return
    } catch (err) {
      console.error('HuggingFace FLUX failed:', err.message)
      onDelta(`\n\n⚠️ Couldn't generate the image: ${err.message}`)
      return
    }
  }

  onDelta('\n\n⚠️ All image providers failed.')
}

// NVIDIA NIM: OpenAI-compatible, stream:true -> SSE lines:
//   data: { "choices": [{ "delta": { "content": "..." } }] }
//   data: [DONE]
// Text-only -- strip images.
async function streamNim(messages, model, apiKey, onDelta) {
  const textMessages = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : m.content
  }))

  const response = await openWithRetry('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages: textMessages, temperature: 0.7, max_tokens: 2048, stream: true })
  })

  let got = false
  for await (const line of iterLines(response)) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') break
    let obj
    try { obj = JSON.parse(payload) } catch { continue }
    const piece = obj && obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content
    if (piece) { got = true; onDelta(piece) }
  }
  if (!got) throw new Error('empty response')
}
