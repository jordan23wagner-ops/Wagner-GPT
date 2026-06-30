// Wagner-GPT — Coding Mode client (Phase 8)
//
// Thin wrappers around /api/github and /api/code-edit. The Coding Mode password is held
// only in sessionStorage (cleared when the tab closes) and attached to every call; it is
// never persisted to localStorage or sent anywhere but our own backend.

const PW_KEY = 'codingPassword'

export const getPassword = () => sessionStorage.getItem(PW_KEY) || ''
export const setPassword = (pw) => sessionStorage.setItem(PW_KEY, pw || '')
export const clearPassword = () => sessionStorage.removeItem(PW_KEY)
export const hasPassword = () => !!getPassword()

async function githubCall(action, args = {}) {
  const res = await fetch('/api/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, password: getPassword(), ...args }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

export const listRepos = () => githubCall('repos')
export const getTree = (owner, repo, branch) => githubCall('tree', { owner, repo, branch })
export const getFile = (owner, repo, path, branch) => githubCall('file', { owner, repo, path, branch })
export const commitFile = (args) => githubCall('commit', args)

// Ask the model to rewrite a file per an instruction. Returns the full new file text.
export async function editFile({ path, content, instruction }) {
  const res = await fetch('/api/code-edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: getPassword(), path, content, instruction }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `Edit failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data.content
}

// Verify the password by making the cheapest authenticated call (repo list). Returns the
// repos on success so the caller can populate the picker in the same round-trip.
export async function unlock(pw) {
  setPassword(pw)
  try {
    return await listRepos()
  } catch (err) {
    clearPassword()
    throw err
  }
}
