// Wagner-GPT — shared guards for private endpoints. The _ prefix keeps Vercel from routing this file.
import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (s) => createHash('sha256').update(String(s)).digest()

// Coding Mode spends private tokens (reads private repos, commits to GitHub), so it fails closed:
// no CODING_MODE_PASSWORD on the server means no access at all. Returns true if the request may go on;
// otherwise it has already answered.
export function requireCodingPassword(req, res) {
  const expected = process.env.CODING_MODE_PASSWORD
  if (!expected) {
    res.status(503).json({ error: 'Coding Mode is locked: set CODING_MODE_PASSWORD in Vercel.' })
    return false
  }
  const given = (req.headers && req.headers['x-coding-password']) || ''
  if (!given || !timingSafeEqual(digest(given), digest(expected))) {
    res.status(401).json({ error: 'Wrong Coding Mode password.' })
    return false
  }
  return true
}

// Keeps other websites from spending our quota through a visitor's browser, and turns away plain scripts
// that send no Origin. A determined script can fake the header, so this is a speed bump, not a lock:
// use it only for endpoints that risk quota, never for ones that touch private data.
export function requireSameOrigin(req, res) {
  const { origin, host } = req.headers || {}
  let originHost = null
  try { originHost = origin ? new URL(origin).host : null } catch { /* malformed: refused below */ }
  if (!originHost || originHost !== host) {
    res.status(403).json({ error: 'Not allowed from this origin.' })
    return false
  }
  return true
}
