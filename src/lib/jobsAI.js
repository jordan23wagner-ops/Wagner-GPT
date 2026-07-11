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
// Short tokens that carry real job-matching signal. The generic length filter (>3) exists to drop
// stopwords, but it also dropped exactly the acronyms this matching lives on — "SQL", "AWS", "AI",
// "QA", "PMP" — so an AI/BI/QA-heavy job ranked on its filler words only. Exact-token match (not
// substring), so admitting these adds no noise.
const SHORT_SIGNAL = new Set(['ai', 'ml', 'bi', 'ux', 'ui', 'qa', 'pm', 'hr', 'it', 'pmp', 'pmo', 'sql', 'aws', 'gcp', 'api', 'erp', 'crm', 'sap', 'etl', 'sre', 'csm'])
const signalTok = (w) => w.length > 3 || SHORT_SIGNAL.has(w)
export function lexicalRank(results, resume) {
  // Score = fraction of the JOB's vocabulary covered by the résumé. (The old résumé-side denominator
  // saturated every job at the 95 cap once the résumé was long, making the fallback ranking useless.)
  const resumeToks = new Set((resume || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(signalTok))
  return results.map((j) => {
    const jobToks = new Set(((j.title || '') + ' ' + (j.description || '') + ' ' + (j.category || ''))
      .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(signalTok))
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
    // null, NOT 50, when the model returned nothing usable: 50 sat exactly on the deep-rewrite
    // pass threshold, so a parse failure silently counted as a passing score. Callers must treat
    // null as "not scored" (show —, don't auto-skip, don't auto-select).
    score: typeof obj.score === 'number' ? Math.max(0, Math.min(100, obj.score)) : null,
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
    // Closed-world rule, not an enumerated blocklist: the old "never invent employers/titles/dates/
    // degrees/skills" list left the most commonly fabricated content — metrics, team sizes, scope,
    // achievement framing — technically permitted.
    '1. Use ONLY facts explicitly stated in the candidate material (their résumés + confirmed facts below). Do not add, infer, estimate, or embellish ANYTHING that is not there: no employers, titles, dates, degrees, certifications, or skills — and no numbers, percentages, dollar amounts, metrics, team sizes, budgets, scope, or achievements the material does not state. If the material gives no metric for something, do not state one.\n' +
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
    'they actually have (not things the assistant guessed). Stay as close to the candidate\'s own wording ' +
    'as possible — never upgrade, quantify, or embellish what they said ("helped on a team project" must ' +
    'NOT become "led a team"; do not add numbers they did not say). Respond ONLY with a strict JSON array ' +
    'of short strings (max 10), no prose: ["Python","Helped deliver a team project",...]. Empty array if nothing concrete.'
  const arr = tryJson(await backendText(sys, convo), 'array')
  return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 10) : []
}

// ── Post-tailor grounding check: claims in the draft that the source material doesn't support ──
// The tailoring prompt alone doesn't bind the model; this is the verification step. Returns an
// array of unsupported-claim strings (empty = clean), or null when the check itself failed —
// callers must show "not verified" for null, never treat it as clean.
export async function groundingCheck(draft, { activeText, otherTexts = [], memory = [] }) {
  const sys = 'You are a strict résumé fact auditor. Compare the DRAFT against the SOURCES. List every ' +
    'specific claim in the DRAFT that the SOURCES do not support: invented or altered employers, titles, ' +
    'dates, degrees, certifications, or skills, and any number, percentage, metric, team size, budget, or ' +
    'scope not present in the SOURCES. Rewording, reordering, or summarizing content that IS in the ' +
    'sources is fine and must NOT be listed. Respond ONLY with a strict JSON array of short strings ' +
    '(max 10), no prose. Empty array [] if everything is supported.'
  const sources = [activeText || '', ...otherTexts.filter(Boolean).slice(0, 2), ...(memory || []).map((m) => (m && m.text) || '')]
    .filter(Boolean).join('\n\n--- source break ---\n\n')
  const user = 'SOURCES:\n' + sources.slice(0, 9000) + '\n\nDRAFT:\n' + (draft || '').slice(0, 6000)
  const arr = tryJson(await backendText(sys, user), 'array')
  return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()).slice(0, 10) : null
}
