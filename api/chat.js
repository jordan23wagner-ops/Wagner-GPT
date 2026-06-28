// Wagner-GPT chat backend (streaming)
// Strategy: try Ollama Cloud first (free), fall back to NVIDIA NIM (dev credits) on failure.
// Each provider has a different streaming format; we normalize both into a single
// newline-delimited JSON (NDJSON) stream to the client:
//   {"delta":"token text"}\n   (zero or more)
//   {"done":true,"provider":"ollama"}\n   (terminal success)
//   {"error":"message"}\n   (terminal failure, only if NOTHING streamed yet)
//
// Fallback caveat: once we've flushed the first delta the HTTP response is committed,
// so provider fallback is only possible BEFORE the first token. The wroteAny flag
// reflects this.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { messages, newMessage, image, model } = req.body

  const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY

  if (!OLLAMA_API_KEY && !NVIDIA_NIM_KEY) {
    return res.status(500).json({ error: 'No API keys configured (need OLLAMA_API_KEY and/or NVIDIA_NIM_KEY).' })
  }

  // Provider-specific model IDs for each dropdown choice.
  const MODEL_MAP = {
    m3:       { ollama: 'minimax-m3:cloud',        nim: 'minimaxai/minimax-m3',        order: ['ollama', 'nim'] },
    gemma: { ollama: 'gemma4:cloud', nim: 'google/gemma-3-27b-it', order: ['ollama', 'nim'] },
    qwen:     { ollama: 'qwen3.5:cloud', nim: 'qwen/qwen2.5-vl-72b-instruct', order: ['ollama', 'nim'] }
  }

  const ids = MODEL_MAP[model]
  if (!ids) {
    return res.status(400).json({ error: `Unknown model: ${model}` })
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
  const fullMessages = [...history, userTurn]

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

  // 1) Try Ollama Cloud first (free path).
  if (OLLAMA_API_KEY) {
    try {
      await streamOllama(fullMessages, ids.ollama, OLLAMA_API_KEY, writeDelta)
      res.write(JSON.stringify({ done: true, provider: 'ollama' }) + '\n')
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
      res.write(JSON.stringify({ done: true, provider: 'nim' }) + '\n')
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
async function streamOllama(messages, model, apiKey, onDelta) {
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

  const response = await openWithRetry('https://ollama.com/api/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages: ollamaMessages, stream: true })
  })

  let got = false
  for await (const line of iterLines(response)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try { obj = JSON.parse(trimmed) } catch { continue }
    if (obj.error) throw new Error(String(obj.error).slice(0, 200))
    const piece = obj && obj.message && obj.message.content
    if (piece) { got = true; onDelta(piece) }
    if (obj.done) break
  }
  if (!got) throw new Error('empty response')
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
