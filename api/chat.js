// Wagner-GPT chat backend (streaming)
// Strategy: try Ollama Cloud first (free), then Cerebras and Groq (both host the same
// gpt-oss-120b model on separate free-tier quota pools — no quality drop, just different
// infra), falling back to NVIDIA NIM (dev credits, weaker model) last.
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
  // CORS: allow the Job-Assistant browser extension (and any client) to call this free
  // chat backend cross-origin. The endpoint is already unauthenticated and public to the
  // PWA, so reflecting the origin doesn't widen exposure — it just lets a
  // chrome-extension:// origin through the preflight. No credentials are used.
  const origin = req.headers.origin
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { messages, newMessage, image, images, model, webSearch, document, style, memory, customInstructions, aboutYou } = req.body

  // Normalize uploads to a list: prefer the new `images` array, fall back to the legacy
  // single `image`. Each entry is { data: base64, mediaType }.
  const imageList = Array.isArray(images) && images.length ? images : (image ? [image] : [])

  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY
  const HUGGINGFACE_KEY = process.env.HUGGINGFACE_KEY
  const TAVILY_KEY = process.env.TAVILY_KEY || process.env.TAVILY_API_KEY || process.env.TAVILY
  // Both optional — absent means those fallback tiers are just skipped, same as
  // NVIDIA_NIM_KEY/HUGGINGFACE_KEY already behave when unset.
  const CEREBRAS_KEY = process.env.CEREBRAS_KEY
  const GROQ_KEY = process.env.GROQ_KEY
  const GEMINI_KEY = process.env.GEMINI_KEY
  const BRAVE_KEY = process.env.BRAVE_KEY

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
    // Cerebras and Groq both host gpt-oss-120b for free (different accounts, GPU-time
    // billed vs request/token-rate billed — a genuinely separate quota pool from Ollama's),
    // so they slot in ahead of NIM for BOTH routes: exact model match for gptoss (no
    // quality drop), and — same as NIM already does today for qwen — a different-but-
    // still-capable generalist standing in for the code-tuned model when Ollama's out.
    gptoss:   { ollama: 'gpt-oss:120b', cerebras: 'gpt-oss-120b', groq: 'openai/gpt-oss-120b', nim: 'meta/llama-3.3-70b-instruct', order: ['ollama', 'cerebras', 'groq', 'nim'] },
    qwen:     { ollama: 'qwen3-coder:480b', cerebras: 'gpt-oss-120b', groq: 'openai/gpt-oss-120b', nim: 'meta/llama-3.3-70b-instruct', order: ['ollama', 'cerebras', 'groq', 'nim'] }
    // Evaluated glm-5 and deepseek-v3.1:671b — neither tag resolves on the free tier
    // (both fall back to NIM) and DeepSeek is slow. gpt-oss:120b stays the smart pick.
  }

  // Resolve the effective model.
  //  - 'auto' routes by intent: Qwen3-Coder for code, GPT-OSS for everything else,
  //    and Gemma whenever vision or image generation is involved (the others are
  //    text-only and can't see uploads or drive the generate_image tool).
  //  - Image requests / photo uploads ALWAYS route to Gemma, even under a manual
  //    non-Gemma selection, so "draw me X" and "what's in this photo?" just work.
  const wantsImage = isImageRequest(newMessage)
  const hasVisionInput = imageList.length > 0
  let effectiveModel = model
  if (model === 'auto') {
    if (wantsImage || hasVisionInput) effectiveModel = 'gemma'
    else effectiveModel = classifyQuery(newMessage)
  } else if ((wantsImage || hasVisionInput) && model !== 'gemma' && model !== 'm3') {
    // Manual GPT-OSS / Qwen can't see images or generate them — fall to Gemma.
    effectiveModel = 'gemma'
  } else if (wantsImage && model === 'm3') {
    effectiveModel = 'gemma'
  }

  const ids = MODEL_MAP[effectiveModel]
  if (!ids) {
    return res.status(400).json({ error: `Unknown model: ${model}` })
  }

  // Photo-informed generation: when a photo is attached AND the user asks to change/show
  // it ("show this garden in full summer bloom"), read the photo with the vision model to
  // build a prompt, then generate a fresh image of that requested future state.
  // NOTE: true pixel-level editing of the exact photo isn't available on the free hosted
  // tier — NVIDIA's hosted FLUX.1 Kontext only accepts its own demo images — so this is an
  // AI re-imagining based on the photo, and we label it as such in the reply.
  const hasGen = NVIDIA_NIM_KEY || HUGGINGFACE_KEY
  if (hasVisionInput && hasGen && (wantsImage || isEditRequest(newMessage))) {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    try {
      // Turn the photo + request into a vivid generation prompt (best-effort; on failure
      // we just generate from the user's raw words).
      let genPrompt = newMessage
      if (GEMINI_KEY) {
        try { genPrompt = await describeWithGemini(imageList.map((i) => i.data), newMessage, GEMINI_KEY) }
        catch (e) {
          console.error('Gemini vision prompt failed, trying Ollama:', e.message)
          if (OLLAMA_CLOUD_KEY) {
            try { genPrompt = await describeForEdit(imageList.map((i) => i.data), newMessage, OLLAMA_CLOUD_KEY) }
            catch (e2) { console.error('Ollama vision prompt failed:', e2.message) }
          }
        }
      } else if (OLLAMA_CLOUD_KEY) {
        try { genPrompt = await describeForEdit(imageList.map((i) => i.data), newMessage, OLLAMA_CLOUD_KEY) }
        catch (e) { console.error('vision prompt failed:', e.message) }
      }
      let b64 = null
      const errs = []
      if (NVIDIA_NIM_KEY) {
        try { b64 = await generateImage(genPrompt, NVIDIA_NIM_KEY) }
        catch (e) { errs.push(`NIM: ${e.message}`); console.error('NIM gen failed:', e.message) }
      }
      // HF's free endpoint frequently network-fails; wrap so it can't mask other errors.
      if (!b64 && HUGGINGFACE_KEY) {
        try { b64 = await generateImageHF(genPrompt, HUGGINGFACE_KEY) }
        catch (e) { errs.push(`HF: ${e.message}`); console.error('HF gen failed:', e.message) }
      }
      // Pollinations: free, no key, no aggressive filter — the reliable last resort.
      if (!b64) {
        try { b64 = await generateImagePollinations(genPrompt) }
        catch (e) { errs.push(`Pollinations: ${e.message}`); console.error('Pollinations gen failed:', e.message) }
      }
      if (!b64) throw new Error(errs.join(' · ') || 'image generation failed')
      res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt: genPrompt }) + '\n')
      res.write(JSON.stringify({ delta: '\n\n_An AI re-imagining based on your photo — not a pixel-edit of the original._' }) + '\n')
      res.write(JSON.stringify({ done: true, provider: 'nim', model: 'vision-gen', quota: null }) + '\n')
    } catch (err) {
      console.error('photo-informed gen failed:', err.message)
      res.write(JSON.stringify({ error: `Couldn't create the image: ${err.message}` }) + '\n')
    }
    return res.end()
  }

  // Optional web search (Tavily): run BEFORE the model so we can inject current
  // results as context. Skipped for image requests (no point searching "draw a cat").
  let searchData = null
  if (webSearch && newMessage && !wantsImage && (BRAVE_KEY || TAVILY_KEY)) {
    try {
      searchData = BRAVE_KEY
        ? await runBraveSearch(newMessage, BRAVE_KEY)
        : await runWebSearch(newMessage, TAVILY_KEY)
    } catch (err) {
      console.error('Primary search failed, trying fallback:', err.message)
      if (BRAVE_KEY && TAVILY_KEY) {
        try { searchData = await runWebSearch(newMessage, TAVILY_KEY) }
        catch (err2) { console.error('Fallback search also failed:', err2.message) }
      }
    }
  }

  // Build a normalized message list (text + optional image part).
  const history = (messages || []).map(m => ({ role: m.role, content: m.content }))
  const userTurn = {
    role: 'user',
    content: imageList.length
      ? [
          { type: 'text', text: newMessage },
          ...imageList.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType || 'image/jpeg'};base64,${img.data}` },
          })),
        ]
      : newMessage
  }
  // Prepend any context system messages: persona + memory first (highest priority),
  // then style guidance, attached document, and web search.
  const systemMsgs = []

  // Custom instructions / "about you" — always applied when set.
  const personaBits = []
  if (aboutYou && String(aboutYou).trim()) personaBits.push(`About the user: ${String(aboutYou).trim()}`)
  if (customInstructions && String(customInstructions).trim()) personaBits.push(`How the user wants you to respond: ${String(customInstructions).trim()}`)
  if (personaBits.length) systemMsgs.push({ role: 'system', content: personaBits.join('\n\n') })

  // Relevant long-term memories retrieved client-side for this query.
  if (Array.isArray(memory) && memory.length) {
    const lines = memory.map((m) => `- ${m}`).join('\n')
    systemMsgs.push({ role: 'system', content: `Relevant things you remember about the user:\n${lines}` })
  }

  const styleMsg = STYLE_PROMPTS[style]
  if (styleMsg) systemMsgs.push({ role: 'system', content: styleMsg })
  if (document && document.text) {
    systemMsgs.push({
      role: 'system',
      content:
        `The user attached a document named "${document.name}". The text below may be the ` +
        `full document or the excerpts most relevant to the question. Use it to answer, ` +
        `summarize, or rewrite as asked, and say so if it looks incomplete for the ask. ` +
        `Document contents:\n\n${document.text}`,
    })
  }
  if (searchData) systemMsgs.push(buildSearchSystem(newMessage, searchData))
  const fullMessages = [...systemMsgs, ...history, userTurn]

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
      // Ollama Cloud's API doesn't expose rate-limit headers, so quota is always null here —
      // the frontend shows "no quota data" rather than a fabricated number.
      res.write(JSON.stringify({ done: true, provider: 'ollama', model: effectiveModel, quota: null }) + '\n')
      return res.end()
    } catch (err) {
      console.error('Ollama failed:', err.message)
      errors.push(`Ollama: ${err.message}`)
      // Only safe to fall through if we haven't sent any tokens yet.
      if (state.wroteAny) {
        res.write(JSON.stringify({ error: `Stream interrupted (Ollama): ${err.message}` }) + '\n')
        return res.end()
      }
      // else: fall through to the text-only fallbacks below
    }
  }

  // 2) Plain-text fallbacks, in priority order: Cerebras and Groq both host the SAME
  // gpt-oss-120b model Ollama serves (no quality drop for the gptoss route; qwen's code-
  // tuned model has no equivalent so it degrades the same way it already does to NIM
  // today), on completely separate quota pools — only NIM (weaker model) is the last
  // resort. None of these support tools (image generation), same as NIM's existing
  // behavior. `model` is undefined for a route with no match on that provider (m3/gemma
  // have none), so those are skipped automatically.
  const textFallbacks = [
    { name: 'cerebras', key: CEREBRAS_KEY, model: ids.cerebras, url: 'https://api.cerebras.ai/v1/chat/completions' },
    { name: 'groq',     key: GROQ_KEY,     model: ids.groq,     url: 'https://api.groq.com/openai/v1/chat/completions' },
    { name: 'gemini',   key: GEMINI_KEY,   model: 'gemini-2.0-flash', gemini: true },
    { name: 'nim',      key: NVIDIA_NIM_KEY, model: ids.nim,    url: 'https://integrate.api.nvidia.com/v1/chat/completions' },
  ]

  for (const fb of textFallbacks) {
    if (!fb.key || !fb.model || state.wroteAny) continue
    try {
      let quota = null
      if (fb.gemini) {
        // Gemini's API doesn't expose rate-limit headers either — quota stays null.
        await streamGemini(fullMessages, fb.key, writeDelta)
      } else {
        const r = await streamOpenAICompatible(fb.url, fullMessages, fb.model, fb.key, writeDelta, fb.name)
        quota = r && r.quota
      }
      if (searchData) writeDelta(sourcesMarkdown(searchData))
      res.write(JSON.stringify({ done: true, provider: fb.name, model: effectiveModel, quota }) + '\n')
      return res.end()
    } catch (err) {
      console.error(`${fb.name} failed:`, err.message)
      errors.push(`${fb.name}: ${err.message}`)
      if (state.wroteAny) {
        res.write(JSON.stringify({ error: `Stream interrupted (${fb.name}): ${err.message}` }) + '\n')
        return res.end()
      }
      // else: fall through to the next provider in the list
    }
  }

  // Every available provider failed before emitting anything.
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
  /\b(draw|paint|sketch|render|generate|create|make|design|show (me|her|him|them|us))\b[^.?!]*\b(image|picture|photo|pic|art|drawing|painting|illustration|logo|wallpaper|portrait|headshot|scene|landscape|icon|avatar)\b|\b(draw|paint|sketch)\s+(me\s+)?(a|an|the|some)\b/i

function isImageRequest(text) {
  return typeof text === 'string' && IMAGE_INTENT_RE.test(text)
}

// Does this read like a request to TRANSFORM an uploaded photo (image-to-image)? Only
// consulted when an image is actually attached, so it can be fairly liberal — the cost of
// a false positive is editing instead of describing. Intentionally excludes pure
// questions ("what's in this?", "describe this") which should stay as vision Q&A.
const EDIT_INTENT_RE =
  /\b(edit|change|turn|transform|convert|add|remove|replace|repaint|restyle|redesign|recolou?r|enhance|improve|professional|portrait|headshot|make (it|this|the|them|her|him|them|us)|show (it|this|the|me|her|him|them|us)|what (would|will) (it|this|the)|in (summer|winter|spring|autumn|fall)|fully grown|matured?|next (year|season|month)|years? (from now|later)|in (full )?bloom|blooming|grown( up)?|future)\b/i

function isEditRequest(text) {
  return typeof text === 'string' && EDIT_INTENT_RE.test(text)
}

// Auto routing for text queries: coding-flavored prompts go to Qwen3-Coder; everything
// else goes to GPT-OSS 120B, the smartest fast generalist. (Vision/image requests are
// handled earlier and never reach here.)
const CODING_RE =
  /\b(code|coding|program|programming|function|debug|bug|stack trace|algorithm|regex|sql|python|javascript|typescript|java|c\+\+|c#|rust|golang|\bgo\b|php|ruby|swift|kotlin|html|css|react|vue|node|api|json|yaml|docker|kubernetes|compile|refactor|syntax error|terminal|command line|\bgit\b|leetcode)\b/i

function classifyQuery(text) {
  if (typeof text !== 'string') return 'gptoss'
  return CODING_RE.test(text) ? 'qwen' : 'gptoss'
}

// Response-style guidance, injected as a system message so the user controls verbosity
// and whether code is included. 'default' adds nothing.
const STYLE_PROMPTS = {
  quick: 'Answer as briefly as possible — at most 2-3 sentences. Skip preamble and do not include code unless the user explicitly asks for it.',
  info: 'Explain clearly in prose. Do NOT include code blocks or code examples unless the user explicitly requests code. Focus on concepts and information.',
  code: 'When relevant, include practical, well-formatted code examples with short explanations.',
  teach: 'You are a patient, encouraging teacher. Explain the WHY behind every answer, not just the what. Use simple language and real-world analogies. For code, show it step by step with comments explaining what each part does and why. Never make the learner feel bad for not knowing something — celebrate curiosity.',
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

// Run a fetch with a hard deadline so a slow/hanging provider can't consume the whole
// 60s function budget (which manifested as "times out" / truncated black images). On
// timeout we abort and throw so the caller falls back to the next provider.
async function fetchWithTimeout(url, options, ms, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${label} timed out after ${ms / 1000}s`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// A real 1024² JPEG is well over this; anything smaller is an empty/black/truncated
// result, which we reject so the caller can fall back instead of showing a black box.
const MIN_IMAGE_B64 = 6000

// FLUX.1-dev accepts width/height only from a fixed set; 1024 square is the safe default.
// 20 steps keeps quality high while shaving latency to stay well inside the function cap.
async function generateImage(prompt, nimKey) {
  const response = await fetchWithTimeout('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev', {
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
      steps: 20,
      cfg_scale: 3.5,
      seed: Math.floor(Math.random() * 1e9)
    })
  }, 35000, 'NIM image')
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${response.status} ${body.slice(0, 150)}`)
  }
  const data = await response.json()
  const art = (data && data.artifacts && data.artifacts[0]) || {}
  const b64 = art.base64
  if (!b64) throw new Error('no image returned')
  // Only reject on an EXPLICIT content-filter result (NVIDIA returns a black image with a
  // CONTENT_FILTERED reason when its safety filter trips, and it false-positives). Other
  // non-success reason values vary by deployment and may still carry a valid image, so we
  // do NOT reject them — the size guard below still catches truly-empty results. We carry
  // the raw reason in the error so it's visible if it really is a filter.
  const reason = String(art.finishReason || art.finish_reason || '').toUpperCase()
  if (reason.includes('FILTER')) {
    throw new Error(`content-filtered (${reason || 'unknown'})`)
  }
  if (b64.length < MIN_IMAGE_B64) throw new Error('image came back empty')
  return b64
}

// Vision-guided prompt builder: show the uploaded photo to Gemma (Ollama, non-streaming)
// and have it write a single vivid text-to-image prompt describing the subject with the
// requested style or transformation applied. The result feeds generateImage()/generateImageHF().
// Best-effort — caller falls back to raw text on any failure.
async function describeForEdit(imageBase64List, instruction, ollamaKey) {
  const imgs = Array.isArray(imageBase64List) ? imageBase64List : [imageBase64List]
  const messages = [
    {
      role: 'system',
      content:
        'You write prompts for a text-to-image model. Look at the attached photo(s) and the ' +
        'user request, then output ONE vivid, detailed prompt (max 100 words) that: ' +
        '(1) describes the main subject(s) — for people: approximate age group, clothing, hair color and style, expression, and pose; for scenes: key elements, colors, and composition; ' +
        '(2) describes the setting, lighting, and atmosphere; ' +
        '(3) applies the requested style or transformation. ' +
        'Keep the description tasteful and appropriate for all audiences. Do not reference names. ' +
        'Output only the prompt text — no preamble, no quotes, no explanation.',
    },
    { role: 'user', content: instruction || 'Apply the requested style to this photo.', images: imgs },
  ]
  const response = await fetchWithTimeout('https://ollama.com/api/chat', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${ollamaKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gemma4:31b', messages, stream: false }),
  }, 30000, 'vision prompt')
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`${response.status} ${body.slice(0, 120)}`)
  }
  const data = await response.json()
  const out = data && data.message && data.message.content
  if (!out || !out.trim()) throw new Error('empty vision prompt')
  return out.trim().slice(0, 1500)
}

// Hugging Face Inference API: FLUX.1-schnell (free, rate-limited, no credit pool).
// Returns raw image bytes; we base64-encode them for the NDJSON stream.
async function generateImageHF(prompt, hfKey) {
  const response = await fetchWithTimeout(
    'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${hfKey}`,
        'Content-Type': 'application/json',
        'Accept': 'image/jpeg',
      },
      body: JSON.stringify({ inputs: String(prompt).slice(0, 1500) }),
    },
    30000, 'HuggingFace image'
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HF ${response.status} ${body.slice(0, 150)}`)
  }
  const buf = await response.arrayBuffer()
  // Buffer is faster and safer than a per-byte String.fromCharCode loop (which can choke
  // on a megabyte-sized image).
  const b64 = Buffer.from(buf).toString('base64')
  if (b64.length < MIN_IMAGE_B64) throw new Error('HF returned empty image')
  return b64
}

// Pollinations.ai: free, no API key, and NOT behind NVIDIA's aggressive CONTENT_FILTERED
// gate — our reliable fallback when NIM filters a benign prompt or HF is down. Simple GET
// returns the image bytes directly.
async function generateImagePollinations(prompt) {
  const p = encodeURIComponent(String(prompt).slice(0, 1500))
  const seed = Math.floor(Math.random() * 1e9)
  const url = `https://image.pollinations.ai/prompt/${p}?width=1024&height=1024&nologo=true&seed=${seed}`
  const response = await fetchWithTimeout(url, { method: 'GET', headers: { 'Accept': 'image/jpeg' } }, 45000, 'Pollinations image')
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Pollinations ${response.status} ${body.slice(0, 120)}`)
  }
  const buf = await response.arrayBuffer()
  const b64 = Buffer.from(buf).toString('base64')
  if (b64.length < MIN_IMAGE_B64) throw new Error('Pollinations returned empty image')
  return b64
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

  // Try NVIDIA NIM first (higher quality), then HuggingFace, then Pollinations (free,
  // no key, no aggressive filter — always available as a last resort).
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
      console.error('HuggingFace FLUX failed, trying Pollinations:', err.message)
    }
  }

  try {
    const b64 = await generateImagePollinations(prompt)
    res.write(JSON.stringify({ image: b64, mediaType: 'image/jpeg', prompt }) + '\n')
    return
  } catch (err) {
    console.error('Pollinations failed:', err.message)
    onDelta(`\n\n⚠️ Couldn't generate the image: ${err.message}`)
  }
}

// Groq and Cerebras both return real-time remaining-quota headers on every response
// (different header names each) — unlike Ollama, which exposes no quota API at all.
// Logging them gives ground-truth headroom visibility in Vercel's function logs, cheaper
// than building a persisted tracking table for two providers whose limits already
// self-enforce via the normal 429-and-fall-through path anyway.
// Returns the parsed quota (or null if this provider didn't send any) AND still logs it —
// logs remain useful for anyone checking Vercel directly, but the return value is what lets
// the frontend show real, provider-reported headroom instead of self-tracked guesswork.
function logRateLimitHeaders(label, response) {
  const h = response.headers
  const reqRemaining = h.get('x-ratelimit-remaining-requests') || h.get('x-ratelimit-remaining-requests-day')
  const reqLimit = h.get('x-ratelimit-limit-requests') || h.get('x-ratelimit-limit-requests-day')
  const tokRemaining = h.get('x-ratelimit-remaining-tokens') || h.get('x-ratelimit-remaining-tokens-minute')
  const tokLimit = h.get('x-ratelimit-limit-tokens') || h.get('x-ratelimit-limit-tokens-minute')
  const resetRequests = h.get('x-ratelimit-reset-requests') || h.get('x-ratelimit-reset-requests-day')
  const resetTokens = h.get('x-ratelimit-reset-tokens') || h.get('x-ratelimit-reset-tokens-minute')
  if (reqRemaining == null && tokRemaining == null) return null
  console.log(`[quota] ${label}: requests remaining=${reqRemaining ?? '?'} tokens remaining=${tokRemaining ?? '?'}`)
  return {
    remainingRequests: reqRemaining != null ? Number(reqRemaining) : null,
    limitRequests: reqLimit != null ? Number(reqLimit) : null,
    remainingTokens: tokRemaining != null ? Number(tokRemaining) : null,
    limitTokens: tokLimit != null ? Number(tokLimit) : null,
    resetRequests: resetRequests || null,
    resetTokens: resetTokens || null,
  }
}

// Generic OpenAI-compatible chat-completions streamer (SSE `data: {...}` lines). NIM,
// Cerebras, and Groq all speak this exact wire format — only the base URL, model catalog,
// and key differ — so one function serves all three text-only fallback tiers.
//   data: { "choices": [{ "delta": { "content": "..." } }] }
//   data: [DONE]
// Text-only -- strip images.
async function streamOpenAICompatible(baseUrl, messages, model, apiKey, onDelta, label) {
  const textMessages = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
      : m.content
  }))

  const response = await openWithRetry(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages: textMessages, temperature: 0.7, max_tokens: 2048, stream: true })
  })
  const quota = logRateLimitHeaders(label, response)

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
  return { quota }
}

// Brave Search: 2000 free searches/month — primary provider when key is set.
// Returns the same shape as runWebSearch so downstream code is unchanged.
async function runBraveSearch(query, key) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(String(query).slice(0, 400))}&count=5`
  const response = await fetch(url, {
    headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Brave ${response.status} ${body.slice(0, 120)}`)
  }
  const data = await response.json()
  const raw = Array.isArray(data.web?.results) ? data.web.results.slice(0, 5) : []
  if (!raw.length) throw new Error('no results')
  const results = raw.map((r) => ({ title: r.title || '', url: r.url || '', content: r.description || '' }))
  return { answer: '', results }
}

// Gemini 2.0 Flash vision: given base64 image(s) + instruction, returns a vivid
// text-to-image prompt. Used in place of Ollama/Gemma when GEMINI_KEY is set —
// Gemini Flash has stronger scene and portrait understanding.
async function describeWithGemini(imageBase64List, instruction, apiKey) {
  const imgs = Array.isArray(imageBase64List) ? imageBase64List : [imageBase64List]
  const systemText =
    'You write prompts for a text-to-image model. Look at the attached photo(s) and the ' +
    'user request, then output ONE vivid, detailed prompt (max 100 words) that: ' +
    '(1) describes the main subject(s) — for people: approximate age group, clothing, hair color and style, expression, and pose; for scenes: key elements, colors, and composition; ' +
    '(2) describes the setting, lighting, and atmosphere; ' +
    '(3) applies the requested style or transformation. ' +
    'Keep the description tasteful and appropriate for all audiences. Do not reference names. ' +
    'Output only the prompt text — no preamble, no quotes, no explanation.'
  const parts = [
    { text: systemText + '\n\nRequest: ' + (instruction || 'Apply the requested style to this photo.') },
    ...imgs.map((img) => ({ inlineData: { mimeType: 'image/jpeg', data: img } })),
  ]
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }] }) },
    30000, 'Gemini vision'
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Gemini ${response.status}: ${body.slice(0, 150)}`)
  }
  const data = await response.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text?.trim()) throw new Error('Gemini returned empty vision prompt')
  return text.trim().slice(0, 1500)
}

// Gemini 2.0 Flash streaming chat. Different wire format from OpenAI-compatible
// providers: SSE events carry candidates[0].content.parts[0].text. System messages
// go into systemInstruction; assistant role maps to 'model'.
async function streamGemini(messages, apiKey, onDelta) {
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => ({ text: Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : (m.content || '') }))
    .filter((p) => p.text)

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : (m.content || '') }],
    }))
    .filter((m) => m.parts[0].text)

  if (!contents.length) throw new Error('no messages for Gemini')

  const body = { contents, generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } }
  if (systemParts.length) body.systemInstruction = { parts: systemParts }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  )
  if (!response.ok) {
    const errBody = await response.text().catch(() => '')
    throw new Error(`Gemini ${response.status}: ${errBody.slice(0, 150)}`)
  }

  let got = false
  for await (const line of iterLines(response)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    let obj
    try { obj = JSON.parse(payload) } catch { continue }
    const piece = obj?.candidates?.[0]?.content?.parts?.[0]?.text
    if (piece) { got = true; onDelta(piece) }
  }
  if (!got) throw new Error('Gemini returned empty response')
}
