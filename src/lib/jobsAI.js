// jobsAI.js — AI helpers for the Jobs tab: résumé-fit ranking, tailoring, match scoring, and the
// deep-rewrite gap Q&A. All calls go to the shared /api/chat NDJSON endpoint (same contract as the
// rest of the app). Guardrail baked into every tailoring prompt: never invent experience — only use
// what's in the provided résumé(s) or the candidate's confirmed memory.

export function stripThinking(t) {
  if (!t) return t
  let c = t.replace(/<think>[\s\S]*?<\/think>/gi, '')
  if (/<\/think>/i.test(c)) c = c.replace(/[\s\S]*<\/think>/i, '')
  return c.replace(/<\/?think>/gi, '').trim()
}

// Single system+user turn.
export async function backendText(sys, user) {
  return backendChat([{ role: 'system', content: sys }, { role: 'user', content: user }])
}

// Multi-turn: history is [{role,content}…]; the last entry is sent as newMessage.
export async function backendChat(history) {
  const last = history[history.length - 1]
  const resp = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: history.slice(0, -1), newMessage: last.content, model: 'auto' }),
  })
  if (!resp.ok || !resp.body) throw new Error('Backend ' + resp.status)
  const reader = resp.body.getReader(), dec = new TextDecoder()
  let buf = '', text = ''
  const handle = (line) => {
    const ln = line.trim(); if (!ln) return
    let ev
    try { ev = JSON.parse(ln) } catch { return } // malformed line — skip it, NOT backend errors
    if (ev.delta) text += ev.delta
    else if (ev.error) throw new Error(ev.error) // must propagate: a swallowed error returns '' and downstream saves an empty résumé
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1) }
  }
  if (buf) handle(buf)
  return text
}

function tryJson(raw, kind) {
  const clean = stripThinking(raw).replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(clean) } catch { /* */ }
  const re = kind === 'array' ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/
  const m = clean.match(re)
  if (m) { try { return JSON.parse(m[0]) } catch { /* */ } }
  return null
}

// ── Ranking ──
export function lexicalRank(results, resume) {
  // Score = fraction of the JOB's vocabulary covered by the résumé. (The old résumé-side denominator
  // saturated every job at the 95 cap once the résumé was long, making the fallback ranking useless.)
  const resumeToks = new Set((resume || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3))
  return results.map((j) => {
    const jobToks = new Set(((j.title || '') + ' ' + (j.description || '') + ' ' + (j.category || ''))
      .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3))
    if (!resumeToks.size || !jobToks.size) return { i: 0, score: 50, reason: '' }
    let hits = 0
    jobToks.forEach((w) => { if (resumeToks.has(w)) hits++ })
    const score = Math.min(95, Math.round((hits / jobToks.size) * 140))
    return { i: 0, score, reason: '' }
  })
}
export async function aiRank(results, resume) {
  const sys = 'You are Alicia, a job-fit rater. Given the candidate résumé and a numbered list of jobs, ' +
    'score each job 0-100 for how well the candidate fits it (skills, seniority, domain), and give a ' +
    'terse 6-12 word reason. Respond ONLY with a strict JSON array, no prose, no code fences: ' +
    '[{"i":<job number>,"score":<0-100>,"reason":"<short>"}]'
  const lines = results.map((j, i) =>
    (i + 1) + '. ' + (j.title || '') + ' @ ' + (j.company || '') + ' | ' + (j.location || '') +
    ' | ' + (j.category || '') + ' | ' + (j.description || '').slice(0, 240)).join('\n')
  const user = 'Résumé:\n' + (resume || '').slice(0, 6000) + '\n\nJobs:\n' + lines
  const arr = tryJson(await backendText(sys, user), 'array')
  if (!Array.isArray(arr)) throw new Error('bad rank json')
  return arr
}

// ── Match score for one résumé vs one job → { score, matched, missing, summary } ──
export async function matchScore(resumeText, job) {
  const sys = 'You are a résumé/job match rater. Respond ONLY with strict JSON, no prose, no code fences: ' +
    '{"score":<0-100>,"matched":["kw",...],"missing":["kw",...],"summary":"<one sentence>"}'
  const user = 'JOB: ' + (job.title || '') + ' @ ' + (job.company || '') + '\n' +
    (job.description || '').slice(0, 2500) + '\n\nRÉSUMÉ:\n' + (resumeText || '').slice(0, 6000)
  const obj = tryJson(await backendText(sys, user), 'object') || {}
  return {
    score: typeof obj.score === 'number' ? Math.max(0, Math.min(100, obj.score)) : 50,
    matched: Array.isArray(obj.matched) ? obj.matched.slice(0, 12) : [],
    missing: Array.isArray(obj.missing) ? obj.missing.slice(0, 12) : [],
    summary: obj.summary || '',
  }
}

function memoryBlock(memory) {
  const list = (memory || []).map((m) => m.text).filter(Boolean)
  if (!list.length) return ''
  return '\n\nADDITIONAL CONFIRMED FACTS the candidate explicitly approved (you MAY use these; they ' +
    'are true — but do NOT go beyond them or invent anything else):\n- ' + list.join('\n- ')
}

// ── Quick tailor: one call, using the active résumé + other saved résumés + confirmed memory ──
export async function quickTailor(job, { activeText, otherTexts = [], memory = [] }) {
  const sys = 'You tailor a résumé to a specific job. Rules:\n' +
    '1. Use ONLY facts present in the candidate material (their résumés + confirmed facts below). NEVER invent employers, titles, dates, degrees, or skills.\n' +
    '2. Re-order, re-word, and re-emphasize existing experience toward this job\'s requirements. You may pull relevant details from the secondary résumés if present.\n' +
    '3. Keep it truthful, ATS-friendly, and one cohesive résumé. Output ONLY the full tailored résumé text — no preamble, no commentary.'
  // Hard cap: the caller filters out tailored résumés, but never let the prompt grow unboundedly —
  // feeding dozens of near-duplicate résumés back in slows the call and recycles AI output as source.
  const others = otherTexts.filter(Boolean).slice(0, 2).map((t, i) => `\n\n[Secondary résumé ${i + 1}]\n${t.slice(0, 3000)}`).join('')
  const user = 'JOB: ' + (job.title || '') + ' @ ' + (job.company || '') + '\n' +
    (job.description || '').slice(0, 2500) + memoryBlock(memory) +
    '\n\n[Primary résumé]\n' + (activeText || '').slice(0, 6000) + others +
    '\n\nProduce the tailored résumé now.'
  return stripThinking(await backendText(sys, user))
}

// ── Deep rewrite: gap Q&A ──
// Kick off a consolidated interview about gaps across the selected jobs. Returns the opening question.
export function deepSystemPrompt() {
  return 'You are Alicia, helping a candidate strengthen ONE résumé that will be tailored to several ' +
    'related jobs. Interview them to surface real experience their current résumé does not clearly show. ' +
    'Rules:\n' +
    '1. Ask ONE focused question at a time about gaps: skills, tools, achievements, scope, or metrics the ' +
    'target jobs want but the résumé doesn\'t evidence.\n' +
    '2. Never put words in their mouth or assume experience — ask, don\'t assert.\n' +
    '3. After 3-6 questions, or when the user says "done"/"generate", reply with exactly the token ' +
    '[[DONE]] and nothing else.'
}
export function deepIntro(baseResume, jobs) {
  const reqs = jobs.map((j) => `- ${j.title} @ ${j.company}: ${(j.description || '').slice(0, 400)}`).join('\n')
  return 'Target jobs:\n' + reqs + '\n\nCurrent résumé:\n' + (baseResume || '(none provided)').slice(0, 4000) +
    '\n\nBegin: ask your first targeted question about a gap you see.'
}

// After the Q&A, extract concrete confirmable skills/facts from the transcript.
export async function extractConfirmedFacts(history) {
  const convo = history.filter((m) => m.role !== 'system').map((m) => `${m.role}: ${m.content}`).join('\n')
  const sys = 'From this interview, extract concrete skills, tools, or accomplishments the CANDIDATE stated ' +
    'they actually have (not things the assistant guessed). Respond ONLY with a strict JSON array of short ' +
    'strings (max 10), no prose: ["Python","Led a 5-person team",...]. Empty array if nothing concrete.'
  const arr = tryJson(await backendText(sys, convo), 'array')
  return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 10) : []
}
