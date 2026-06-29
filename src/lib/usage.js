// Lightweight client-side usage tracking so we can warn before hitting free-tier
// limits — NVIDIA's image credits are the real cap. Counts reset each calendar day.

const KEY = 'usageStats'

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
    if (raw.date !== today()) return { date: today(), chat: 0, image: 0 }
    return { date: raw.date, chat: raw.chat || 0, image: raw.image || 0 }
  } catch {
    return { date: today(), chat: 0, image: 0 }
  }
}

export function bumpUsage({ chat = 0, image = 0 }) {
  const u = loadUsage()
  u.chat += chat
  u.image += image
  try {
    localStorage.setItem(KEY, JSON.stringify(u))
  } catch {
    /* ignore */
  }
  return u
}
