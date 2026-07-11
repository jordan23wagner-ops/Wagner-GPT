// Lightweight client-side usage tracking so we can warn before hitting free-tier
// limits — NVIDIA's image credits are the real cap. Counts reset each calendar day.

const KEY = 'usageStats'
// Separate key, NOT date-scoped: the last real quota reading a provider sent us. Providers
// that don't expose rate-limit headers (Ollama, Gemini) never write here — that's honest,
// not a bug, so the UI must treat "no entry" as "unknown," never as "zero used."
const QUOTA_KEY = 'usageQuota'

// Conservative soft ceilings (see HANDOFF "Usage & Limits"). We warn early so a long
// chat session doesn't get throttled mid-conversation.
export const IMAGE_DAILY_SOFT_LIMIT = 25
export const CHAT_DAILY_SOFT_LIMIT = 400

function today() {
  return new Date().toISOString().slice(0, 10)
}

export function loadUsage() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    if (raw.date !== today()) return { date: today(), chat: 0, image: 0, byProvider: {} }
    return { date: raw.date, chat: raw.chat || 0, image: raw.image || 0, byProvider: raw.byProvider || {} }
  } catch {
    return { date: today(), chat: 0, image: 0, byProvider: {} }
  }
}

// `provider` is which backend actually answered (ollama/cerebras/groq/gemini/nim) — self-tracked
// request counts, reset daily. This is a LOCAL count of requests THIS browser made, not an
// authoritative "requests left" number (we don't know the account's real daily cap for most
// providers) — the UI should present it as "today's usage," not "quota remaining."
export function bumpUsage({ chat = 0, image = 0, provider = null }) {
  const u = loadUsage()
  u.chat += chat
  u.image += image
  if (provider) u.byProvider[provider] = (u.byProvider[provider] || 0) + 1
  try {
    localStorage.setItem(KEY, JSON.stringify(u))
  } catch {
    /* ignore */
  }
  return u
}

// The last provider-reported quota (remaining/limit requests + tokens), keyed by provider so
// switching between Cerebras/Groq/NIM doesn't clobber each other's most recent reading. Not
// date-scoped — daily/per-minute reset timing is the provider's own business, not ours to guess.
export function loadQuota() {
  try { return JSON.parse(localStorage.getItem(QUOTA_KEY) || '{}') } catch { return {} }
}
export function saveQuota(provider, quota) {
  if (!provider || !quota) return loadQuota()
  const all = loadQuota()
  all[provider] = { ...quota, at: Date.now() }
  try { localStorage.setItem(QUOTA_KEY, JSON.stringify(all)) } catch { /* ignore */ }
  return all
}
