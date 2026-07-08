// Wagner-GPT — Coding Mode GitHub proxy
//
// Serverless endpoint that lets the PWA read and commit to GitHub repos.
// Supports two accounts: GITHUB_TOKEN (Jordon) and GITHUB_TOKEN_ALICIA (Alicia).
// Pass { account: 'alicia' } in the request body to use Alicia's token.
// Same-origin only (no permissive CORS).
//
// Actions (POST body { action, account?, ...args }):
//   repos                                 -> [{ full_name, owner, repo, default_branch, private }]
//   tree   { owner, repo, branch? }       -> { branch, truncated, files: [{ path, size }] }
//   file   { owner, repo, path, branch? } -> { path, content, sha, branch }
//   commit { owner, repo, path, content,  -> { committed: true, sha, commitUrl }
//            message, sha?, branch? }

const GH = 'https://api.github.com'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { action, account } = req.body || {}

  const TOKEN = account === 'alicia'
    ? process.env.GITHUB_TOKEN_ALICIA
    : process.env.GITHUB_TOKEN

  if (!TOKEN) {
    const who = account === 'alicia' ? 'GITHUB_TOKEN_ALICIA' : 'GITHUB_TOKEN'
    return res.status(503).json({
      error: `Coding Mode is not configured. Set ${who} in Vercel.`,
    })
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
    err.status = response.status // preserve it — Code.jsx branches on 409 (sha conflict)
    throw err
  }
  return response.json()
}

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

async function getTree(token, { owner, repo, branch }) {
  requireFields({ owner, repo })
  const ref = branch || (await defaultBranch(token, owner, repo))
  const data = await gh(token, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
  const files = (data.tree || [])
    .filter((n) => n.type === 'blob')
    .map((n) => ({ path: n.path, size: n.size }))
  return { branch: ref, truncated: !!data.truncated, files }
}

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
