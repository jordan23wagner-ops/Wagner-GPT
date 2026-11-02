// Security regression: Coding Mode endpoints spend private tokens (read and COMMIT to GitHub) and must
// fail closed without the password. Found live 2026-11-01: api/github.js answered with no auth at all.
import test from 'node:test'
import assert from 'node:assert/strict'

const { default: github } = await import('../api/github.js')
const { default: codeEdit } = await import('../api/code-edit.js')
const { default: codeLocate } = await import('../api/code-locate.js')
const { default: transcribe } = await import('../api/transcribe.js')

const realFetch = globalThis.fetch
let upstream = 0
globalThis.fetch = async () => { upstream++; return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }) }
test.after(() => { globalThis.fetch = realFetch })

function call(handler, { body = {}, headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(c) { this.statusCode = c; return this },
      json(d) { resolve({ status: this.statusCode, body: d }); return this },
    }
    Promise.resolve(handler({ method: 'POST', headers, body }, res))
  })
}

function setEnv(pw) {
  if (pw === undefined) delete process.env.CODING_MODE_PASSWORD
  else process.env.CODING_MODE_PASSWORD = pw
  process.env.GITHUB_TOKEN = 'test-token'
  process.env.OLLAMA_CLOUD_KEY = 'test-key'
  process.env.GROQ_KEY = 'test-key'
}

for (const [name, handler] of [['github', github], ['code-edit', codeEdit], ['code-locate', codeLocate]]) {
  const body = { action: 'commit', owner: 'o', repo: 'r', path: 'p', content: 'c', message: 'm', instruction: 'i', files: [] }

  test(`${name}: no password configured on the server -> refused, nothing sent upstream`, async () => {
    setEnv(undefined); upstream = 0
    const r = await call(handler, { body, headers: { 'x-coding-password': 'anything' } })
    assert.equal(r.status, 503); assert.equal(upstream, 0)
  })
  test(`${name}: missing password -> 401, nothing sent upstream`, async () => {
    setEnv('correct horse'); upstream = 0
    const r = await call(handler, { body })
    assert.equal(r.status, 401); assert.equal(upstream, 0)
  })
  test(`${name}: wrong password -> 401, nothing sent upstream`, async () => {
    setEnv('correct horse'); upstream = 0
    const r = await call(handler, { body, headers: { 'x-coding-password': 'correct hors' } })
    assert.equal(r.status, 401); assert.equal(upstream, 0)
  })
}

test('github: the right password gets through', async () => {
  setEnv('correct horse'); upstream = 0
  const r = await call(github, { body: { action: 'repos' }, headers: { 'x-coding-password': 'correct horse' } })
  assert.equal(r.status, 200); assert.equal(upstream, 1)
})

test('transcribe: another site is refused, nothing sent upstream', async () => {
  setEnv('correct horse'); upstream = 0
  const r = await call(transcribe, { body: { audio: 'AAAA', mimeType: 'audio/webm' }, headers: { host: 'wagner-gpt.vercel.app', origin: 'https://evil.example' } })
  assert.equal(r.status, 403); assert.equal(upstream, 0)
})
test('transcribe: no Origin at all (curl, scripts) is refused', async () => {
  setEnv('correct horse'); upstream = 0
  const r = await call(transcribe, { body: { audio: 'AAAA', mimeType: 'audio/webm' }, headers: { host: 'wagner-gpt.vercel.app' } })
  assert.equal(r.status, 403); assert.equal(upstream, 0)
})
test('transcribe: the app itself still works', async () => {
  setEnv('correct horse'); upstream = 0
  const r = await call(transcribe, { body: { audio: 'AAAA', mimeType: 'audio/webm' }, headers: { host: 'wagner-gpt.vercel.app', origin: 'https://wagner-gpt.vercel.app' } })
  assert.notEqual(r.status, 403); assert.equal(upstream, 1)
})
