// Ghost-job heuristics — flags likely-fake or long-dead postings so a tailoring pass isn't wasted on
// one. Pure, source-agnostic signals only (works across every job source in the results list, not
// just ones with their own crawl history): posting age, missing salary, urgency language, and
// "evergreen" generic postings are the well-documented, cheap-to-detect patterns from the 2024-2026
// "ghost jobs" discussion (r/jobs, r/recruitinghell) — repost frequency and unrealistic-experience
// requirements were left out of this pass: the former needs a persisted per-job sighting history this
// app doesn't keep, the latter needs real NLP to do without a high false-positive rate.
//
// This is advisory, not a filter — callers decide whether to hide/deprioritize/just show a badge.
// Score is a rough severity count, not a probability; each contributing reason is surfaced so the
// badge's tooltip can say WHY, not just flag something as suspicious with no explanation.

const URGENCY_RE = /\b(immediate(ly)?\s+hir\w*|urgent(ly)?\s+hir\w*|apply\s+now|act\s+(now|fast)|hiring\s+now|start\s+asap|asap\s+start)\b/i
const EVERGREEN_RE = /\b(general\s+application|future\s+opportunit\w*|talent\s+(pool|community|network)|always\s+hiring|expression\s+of\s+interest|ongoing\s+recruitment|open\s+application)\b/i

// ageInfo / salInfo are the SAME objects Jobs.jsx already computes per job (ageInfo(job.created),
// salaryInfo(job)) — passed in rather than recomputed here to avoid a second regex pass per card.
export function ghostJobRisk(job, ageInfo, salInfo) {
  const reasons = []
  let score = 0

  if (ageInfo && ageInfo.stale) {
    const days = Math.floor((Date.now() - ageInfo.ts) / 86400000)
    if (days > 90) { reasons.push(`posted ${ageInfo.text} — unusually long for an open role`); score += 2 }
    else { reasons.push(`posted ${ageInfo.text}`); score += 1 }
  }

  const title = String(job.title || '')
  const desc = String(job.description || '')
  if (EVERGREEN_RE.test(title) || EVERGREEN_RE.test(desc)) { reasons.push('reads like a generic "always hiring" posting, not one open role'); score += 2 }
  if (URGENCY_RE.test(title) || URGENCY_RE.test(desc)) { reasons.push('urgency language ("apply now", "immediate hire") common in filler postings'); score += 1 }
  if (!salInfo) { reasons.push('no salary disclosed'); score += 1 }
  const descLen = desc.trim().length
  if (descLen > 0 && descLen < 150) { reasons.push('unusually thin description'); score += 1 }

  if (score < 2) return null
  return { level: score >= 4 ? 'high' : 'medium', reasons, score }
}
