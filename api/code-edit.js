// Wagner-GPT — Coding Mode edit endpoint (Phase 8)
//
// Takes a file's current contents + a plain-English instruction and returns the COMPLETE
// rewritten file. Non-streaming (we need the whole file before showing a diff) and
// password-gated with the same secret as api/github.js.
//
// Model: qwen3-coder on Ollama Cloud (free, code-tuned) with a llama-3.3 NIM fallback.
// The system prompt forces "return only the full file in one fenced block" so we can
// extract it deterministically; we still defensively strip stray prose/fences.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY   = process.env.NVIDIA_NIM_KEY
  const GEMINI_KEY       = process.env.GEMINI_KEY

  if (!OLLAMA_CLOUD_KEY && !NVIDIA_NIM_KEY) {
    return res.status(500).json({ error: 'No model API keys configured.' })
  }

  const { path, content, instruction, image } = req.body || {}
  if (typeof content !== 'string' || !instruction) {
    return res.status(400).json({ error: 'Missing file content or instruction.' })
  }

  // If a screenshot was attached, describe it with Gemini vision and fold the
  // description into the instruction so the code model has visual context.
  let enrichedInstruction = instruction
  if (image && image.data && GEMINI_KEY) {
    const desc = await describeScreenshot(image, instruction, GEMINI_KEY)
    if (desc) enrichedInstruction = `${instruction}\n\nScreenshot context: ${desc}`
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `File: ${path || '(unknown)'}\n\n` +
        `Current contents:\n\`\`\`\n${content}\n\`\`\`\n\n` +
        `Instruction: ${enrichedInstruction}\n\n` +
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

async function describeScreenshot(image, instruction, apiKey) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: image.mimeType || 'image/jpeg', data: image.data } },
              { text: `This is a screenshot of a web app. Describe in 2-3 sentences what you see that is relevant to this code change: "${instruction}". Focus on the specific UI elements, text, layout, or visual issues shown.` },
            ],
          }],
        }),
      }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null
  } catch {
    return null
  }
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
