// Wagner-GPT — Coding Mode client
// Thin wrappers around /api/github and /api/code-edit.
// Pass account = 'alicia' to use Alicia's token, omit for Jordon's.

const PW_KEY = 'codingModePassword'
export const hasCodingPassword = () => { try { return !!sessionStorage.getItem(PW_KEY) } catch { return false } }
export const setCodingPassword = (pw) => { try { sessionStorage.setItem(PW_KEY, pw) } catch { /* private mode */ } }
function authHeaders() {
  let pw = ''
  try { pw = sessionStorage.getItem(PW_KEY) || '' } catch { /* private mode */ }
  return { 'Content-Type': 'application/json', 'x-coding-password': pw }
}
// A 401 means the saved password is wrong: forget it and tell Code.jsx to show the unlock screen again.
function noteAuthFailure(status) {
  if (status !== 401) return
  try { sessionStorage.removeItem(PW_KEY) } catch { /* private mode */ }
  window.dispatchEvent(new Event('coding-locked'))
}

async function githubCall(action, args = {}) {
  const res = await fetch('/api/github', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action, ...args }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    noteAuthFailure(res.status)
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
    headers: authHeaders(),
    body: JSON.stringify({ files, instruction, projectContext, image }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    noteAuthFailure(res.status)
    const err = new Error(data.error || `Locate failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data.path
}

export async function editFile({ path, content, instruction, image }) {
  const res = await fetch('/api/code-edit', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ path, content, instruction, image }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    noteAuthFailure(res.status)
    const err = new Error(data.error || `Edit failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data.content
}
