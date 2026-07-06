// Wagner-GPT — Coding Mode client
// Thin wrappers around /api/github and /api/code-edit.
// Pass account = 'alicia' to use Alicia's token, omit for Jordon's.

async function githubCall(action, args = {}) {
  const res = await fetch('/api/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...args }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

export const listRepos = (account) => githubCall('repos', { account })
export const getTree = (owner, repo, branch, account) => githubCall('tree', { owner, repo, branch, account })
export const getFile = (owner, repo, path, branch, account) => githubCall('file', { owner, repo, path, branch, account })
export const commitFile = (args) => githubCall('commit', args)

export async function locateFile(files, instruction, projectContext, image) {
  const res = await fetch('/api/code-locate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, instruction, projectContext, image }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Locate failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data.path
}

export async function editFile({ path, content, instruction, image }) {
  const res = await fetch('/api/code-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, instruction, image }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Edit failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data.content
}
