// Wagner-GPT — Coding Mode edit endpoint (Phase 8)
//
// Takes a file's current contents + a plain-English instruction and returns the COMPLETE
// rewritten file. Non-streaming (we need the whole file before showing a diff) and
// password-gated with the same secret as api/github.js.
//
// Model: qwen3-coder on Ollama Cloud (free, code-tuned) with a llama-3.3 NIM fallback.
// The system prompt forces "return only the full file in one fenced block" so we can
// extract it deterministically; we still defensively strip stray prose/fences.

import crypto from 'crypto'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const SECRET = process.env.CODING_MODE_PASSWORD
  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY

  if (!SECRET) {
    return res.status(503).json({ error: 'Coding Mode is not configured (CODING_MODE_PASSWORD unset).' })
  }
  if (!OLLAMA_CLOUD_KEY && !NVIDIA_NIM_KEY) {
    return res.status(500).json({ error: 'No model API keys configured.' })
  }

  const { password, path, content, instruction } = req.body || {}
  if (!passwordOk(password, SECRET)) {
    return res.status(401).json({ error: 'Wrong Coding Mode password.' })
  }
  if (typeof content !== 'string' || !instruction) {
    return res.status(400).json({ error: 'Missing file content or instruction.' })
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `File: ${path || '(unknown)'}\n\n` +
        `Current contents:\n\`\`\`\n${content}\n\`\`\`\n\n` +
        `Instruction: ${instruction}\n\n` +
        `Return the COMPLETE updated file. Output nothing but one fenced code block ` +
        `containing the entire file from first line to last.`,
    },
  ]

  try {
    let raw
    if (OLLAMA_CLOUD_KEY) {
      try {
        raw = await completeOllama(messages, 'qwen3-coder:480b', OLLAMA_CLOUD_KEY)
      } catch (err) {
        if (!NVIDIA_NIM_KEY) throw err
        raw = await completeNim(messages, 'meta/llama-3.3-70b-instruct', NVIDIA_NIM_KEY)
      }
    } else {
      raw = await completeNim(messages, 'meta/llama-3.3-70b-instruct', NVIDIA_NIM_KEY)
    }
    const updated = extractFile(raw)
    if (!updated.trim()) return res.status(502).json({ error: 'The model returned an empty file.' })
    return res.status(200).json({ content: updated })
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Edit failed.' })
  }
}

const SYSTEM_PROMPT =
  'You are a precise code-editing assistant. You receive the full contents of a single ' +
  'file and an instruction. Apply ONLY the requested change, preserving the existing ' +
  'style, indentation, and unrelated code exactly. Do not add explanations or comments ' +
  'about what you changed. Respond with the COMPLETE updated file inside a single fenced ' +
  'code block (```), and nothing else before or after it.'

function passwordOk(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false }
  return crypto.timingSafeEqual(a, b)
}

// Pull the file out of the model's reply. Prefer the first fenced block; if the model
// ignored the fence instruction, fall back to the whole trimmed reply.
function extractFile(text) {
  const s = String(text || '')
  const fence = s.match(/```[^\n]*\n([\s\S]*?)```/)
  if (fence) return fence[1].replace(/\n$/, '')
  return s.trim()
}

// ---- Providers (non-streaming) ----

async function completeOllama(messages, model, apiKey) {
  const response = await fetch('https://ollama.com/api/chat', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.1 } }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Ollama ${response.status}: ${body.slice(0, 150)}`)
  }
  const data = await response.json()
  const out = data && data.message && data.message.content
  if (!out) throw new Error('Ollama returned no content.')
  return out
}

async function completeNim(messages, model, apiKey) {
  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 8192, stream: false }),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`NIM ${response.status}: ${body.slice(0, 150)}`)
  }
  const data = await response.json()
  const out = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (!out) throw new Error('NIM returned no content.')
  return out
}
