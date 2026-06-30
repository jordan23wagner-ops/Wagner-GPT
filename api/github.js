// Wagner-GPT — Coding Mode GitHub proxy (Phase 8)
//
// A password-gated serverless doorway that lets the PWA read and commit to the user's
// GitHub repos WITHOUT ever exposing the GitHub token to the browser. The token lives
// only in the Vercel env var GITHUB_TOKEN; every call is checked against a shared secret
// in CODING_MODE_PASSWORD before anything touches GitHub.
//
// SECURITY: this endpoint can write to the user's repos, so it is fail-closed. If
// CODING_MODE_PASSWORD or GITHUB_TOKEN is unset, every request is rejected. We do NOT
// emit permissive CORS headers — the PWA calls this same-origin, and not reflecting
// arbitrary origins keeps a stray cross-site page from poking it. The password is
// compared in constant time.
//
// Actions (POST body { action, password, ...args }):
//   repos                                 -> [{ full_name, owner, repo, default_branch, private }]
//   tree   { owner, repo, branch? }       -> { branch, truncated, files: [{ path, size }] }
//   file   { owner, repo, path, branch? } -> { path, content, sha, branch }
//   commit { owner, repo, path, content,  -> { committed: true, sha, commitUrl }
//            message, sha?, branch? }

import crypto from 'crypto'

const GH = 'https://api.github.com'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const TOKEN = process.env.GITHUB_TOKEN
  const SECRET = process.env.CODING_MODE_PASSWORD

  // Fail closed: refuse to do anything until both secrets are configured in Vercel.
  if (!TOKEN || !SECRET) {
    return res.status(503).json({
      error: 'Coding Mode is not configured. Set GITHUB_TOKEN and CODING_MODE_PASSWORD in Vercel.',
    })
  }

  const { action, password } = req.body || {}

  if (!passwordOk(password, SECRET)) {
    return res.status(401).json({ error: 'Wrong Coding Mode password.' })
  }

  try {
    switch (action) {
      case 'repos':  return res.status(200).json(await listRepos(TOKEN))
      case 'tree':   return res.status(200).json(await getTree(TOKEN, req.body))
      case 'file':   return res.status(200).json(await getFile(TOKEN, req.body))
      case 'commit': return res.status(200).json(await commitFile(TOKEN, req.body))
      default:       return res.status(400).json({ error: `Unknown action: ${action}` })
    }
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message || 'GitHub request failed.' })
  }
}

// Constant-time password check that doesn't leak length via early return.
function passwordOk(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Still burn a comparison against a same-length buffer to avoid timing signal.
    crypto.timingSafeEqual(b, b)
    return false
  }
  return crypto.timingSafeEqual(a, b)
}

// ---- GitHub REST helpers ----

async function gh(token, path, options = {}) {
  const response = await fetch(`${GH}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Wagner-GPT-Coding-Mode',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    let detail = body.slice(0, 200)
    try { detail = JSON.parse(body).message || detail } catch { /* keep raw */ }
    const err = new Error(`GitHub ${response.status}: ${detail}`)
    err.status = response.status === 404 ? 404 : 502
    throw err
  }
  return response.json()
}

// The user's own repos, most-recently-pushed first.
async function listRepos(token) {
  const data = await gh(token, '/user/repos?per_page=100&sort=pushed&affiliation=owner')
  return data.map((r) => ({
    full_name: r.full_name,
    owner: r.owner.login,
    repo: r.name,
    default_branch: r.default_branch,
    private: r.private,
  }))
}

async function defaultBranch(token, owner, repo) {
  const data = await gh(token, `/repos/${owner}/${repo}`)
  return data.default_branch
}

// Recursive file listing of a branch. Filters to blobs (files), drops directories.
async function getTree(token, { owner, repo, branch }) {
  requireFields({ owner, repo })
  const ref = branch || (await defaultBranch(token, owner, repo))
  const data = await gh(token, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
  const files = (data.tree || [])
    .filter((n) => n.type === 'blob')
    .map((n) => ({ path: n.path, size: n.size }))
  return { branch: ref, truncated: !!data.truncated, files }
}

// Read a single file's text contents + its blob sha (needed to commit an update).
async function getFile(token, { owner, repo, path, branch }) {
  requireFields({ owner, repo, path })
  const ref = branch || (await defaultBranch(token, owner, repo))
  const data = await gh(
    token,
    `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`
  )
  if (Array.isArray(data)) {
    const err = new Error('That path is a folder, not a file.')
    err.status = 400
    throw err
  }
  if (data.encoding !== 'base64' || data.content == null) {
    const err = new Error('That file is too large or not a text file to open here.')
    err.status = 400
    throw err
  }
  return {
    path: data.path,
    content: Buffer.from(data.content, 'base64').toString('utf8'),
    sha: data.sha,
    branch: ref,
  }
}

// Create or update a file in one commit. `sha` must be the file's current blob sha when
// updating an existing file; omit it to create a new file.
async function commitFile(token, { owner, repo, path, content, message, sha, branch }) {
  requireFields({ owner, repo, path, content, message })
  const ref = branch || (await defaultBranch(token, owner, repo))
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: ref,
  }
  if (sha) body.sha = sha
  const data = await gh(token, `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  return {
    committed: true,
    sha: data.content && data.content.sha,
    commitUrl: data.commit && data.commit.html_url,
  }
}

// Encode each path segment but keep the slashes between folders.
function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/')
}

function requireFields(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') {
      const err = new Error(`Missing required field: ${k}`)
      err.status = 400
      throw err
    }
  }
}
