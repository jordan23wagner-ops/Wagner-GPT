// Given a repo file tree and a plain-English instruction, ask the model which file to edit.
// Returns { path } — just the path string, validated against the tree.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const OLLAMA_KEY = process.env.OLLAMA_CLOUD_KEY
  const NIM_KEY = process.env.NVIDIA_NIM_KEY

  if (!OLLAMA_KEY && !NIM_KEY) return res.status(500).json({ error: 'No model keys configured.' })

  const { files, instruction, projectContext } = req.body || {}
  if (!Array.isArray(files) || !instruction) {
    return res.status(400).json({ error: 'Missing files or instruction.' })
  }

  // Filter out binary/build paths, keep source files only
  const relevant = files
    .filter((f) => !/(node_modules|\.git|dist\/|build\/|\.next\/|__pycache__|\.min\.)/.test(f.path))
    .filter((f) => /\.(js|jsx|ts|tsx|html|css|scss|py|json|md|txt|vue|svelte|rb|go|rs|java|c|cpp|h|cs|php|yaml|yml|toml)$/.test(f.path))
    .map((f) => f.path)
    .slice(0, 300)

  const contextBlock = projectContext
    ? `Project context:\n${projectContext}\n\n`
    : ''

  const messages = [
    {
      role: 'system',
      content:
        'You are a code navigation assistant. Given a list of repository files and a change request, ' +
        'identify the single most appropriate file to edit. ' +
        'Respond with ONLY the exact file path — no explanation, no punctuation, nothing else.',
    },
    {
      role: 'user',
      content:
        `${contextBlock}Repository files:\n${relevant.join('\n')}\n\n` +
        `Change request: ${instruction}\n\n` +
        `Which single file should be edited? Reply with only the file path.`,
    },
  ]

  try {
    let raw
    if (OLLAMA_KEY) {
      try {
        raw = await complete(messages, 'gptoss:120b', OLLAMA_KEY, 'ollama')
      } catch (err) {
        if (!NIM_KEY) throw err
        raw = await complete(messages, 'meta/llama-3.3-70b-instruct', NIM_KEY, 'nim')
      }
    } else {
      raw = await complete(messages, 'meta/llama-3.3-70b-instruct', NIM_KEY, 'nim')
    }

    const path = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '').trim()
    if (!path) return res.status(502).json({ error: 'Model could not identify a file to edit.' })

    // Validate the path actually exists in the tree
    const known = files.map((f) => f.path)
    if (!known.includes(path)) {
      // Try a fuzzy match — model sometimes adds/drops a leading slash
      const cleaned = path.replace(/^\//, '')
      const match = known.find((p) => p === cleaned || p.endsWith('/' + cleaned) || cleaned.endsWith('/' + p))
      if (!match) return res.status(502).json({ error: `Could not find "${path}" in the repo. Try being more specific.` })
      return res.status(200).json({ path: match })
    }

    return res.status(200).json({ path })
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Failed to locate file.' })
  }
}

async function complete(messages, model, apiKey, provider) {
  const url = provider === 'ollama'
    ? 'https://ollama.com/api/chat'
    : 'https://integrate.api.nvidia.com/v1/chat/completions'

  const body = provider === 'ollama'
    ? { model, messages, stream: false, options: { temperature: 0 } }
    : { model, messages, temperature: 0, max_tokens: 256, stream: false }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${provider} ${response.status}: ${text.slice(0, 150)}`)
  }
  const data = await response.json()
  const content = provider === 'ollama'
    ? data?.message?.content
    : data?.choices?.[0]?.message?.content
  if (!content) throw new Error(`${provider} returned no content.`)
  return content
}
