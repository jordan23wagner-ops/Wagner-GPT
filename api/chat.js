// Wagner-GPT chat backend
// Strategy: try Ollama Cloud first (free), fall back to NVIDIA NIM (dev credits) on failure.
// Each provider has a different API shape, handled separately below.

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
  // Ollama tags are overridable here without touching logic if a tag changes.
  const MODEL_MAP = {
    m3:       { ollama: 'minimax-m3:cloud',        nim: 'minimaxai/minimax-m3' },
    deepseek: { ollama: 'deepseek-v4-flash:cloud', nim: 'deepseek-ai/deepseek-v4-flash' },
    qwen:     { ollama: 'deepseek-v4-pro:cloud',   nim: 'deepseek-ai/deepseek-v4-pro' }
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

  const errors = []

  // 1) Try Ollama Cloud first (free path).
  if (OLLAMA_API_KEY) {
    try {
      const content = await callOllama(fullMessages, ids.ollama, OLLAMA_API_KEY)
      return res.status(200).json({ response: content, provider: 'ollama' })
    } catch (err) {
      console.error('Ollama failed:', err.message)
      errors.push(`Ollama: ${err.message}`)
      // fall through to NIM
    }
  }

  // 2) Fall back to NVIDIA NIM (dev credits).
  if (NVIDIA_NIM_KEY) {
    try {
      const content = await callNim(fullMessages, ids.nim, NVIDIA_NIM_KEY)
      return res.status(200).json({ response: content, provider: 'nim' })
    } catch (err) {
      console.error('NIM failed:', err.message)
      errors.push(`NIM: ${err.message}`)
    }
  }

  // Both providers failed (or only one configured and it failed).
  const status = errors.some(e => e.includes('429')) ? 429 : 502
  return res.status(status).json({
    error: 'All available models failed. ' + (errors[errors.length - 1] || 'Please try again shortly.')
  })
}


// ---- Provider callers ----

const MAX_RETRIES = 2
const BASE_DELAY_MS = 600
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const backoff = (attempt) => BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 250)

// Ollama Cloud: native /api/chat. M3 supports vision, so images pass through.
// Response shape: { message: { content: "..." } }
async function callOllama(messages, model, apiKey) {
  // Ollama's native format wants images as a separate `images: [base64]` array on the message,
  // not inline content parts. Reshape if needed.
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response
    try {
      response = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, messages: ollamaMessages, stream: false })
      })
    } catch (netErr) {
      if (attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }
      throw new Error('network error')
    }

    if (response.ok) {
      const data = await response.json()
      const content = data?.message?.content
      if (!content) throw new Error('empty response')
      return content
    }

    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }

    const body = await response.text()
    throw new Error(`${response.status} ${body.slice(0, 200)}`)
  }
  throw new Error('exhausted retries')
}

// NVIDIA NIM: OpenAI-compatible. Text-only — strip images.
// Response shape: { choices: [{ message: { content: "..." } }] }
async function callNim(messages, model, apiKey) {
  const textMessages = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : m.content
  }))

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response
    try {
      response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, messages: textMessages, temperature: 0.7, max_tokens: 2048 })
      })
    } catch (netErr) {
      if (attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }
      throw new Error('network error')
    }

    if (response.ok) {
      const data = await response.json()
      const content = data?.choices?.[0]?.message?.content
      if (!content) throw new Error('empty response')
      return content
    }

    const retryable = response.status === 429 || response.status >= 500
    if (retryable && attempt < MAX_RETRIES) { await sleep(backoff(attempt)); continue }

    const body = await response.text()
    throw new Error(`${response.status} ${body.slice(0, 200)}`)
  }
  throw new Error('exhausted retries')
}
