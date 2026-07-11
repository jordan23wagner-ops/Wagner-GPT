// aliciaBridge.js — talks to the Alicia browser extension from the web app via window.postMessage.
//
// The extension injects a content script (bridge.js) on this origin that:
//   • announces itself: window.postMessage({ source:'alicia-ext', type:'PRESENT', version })
//     and sets document.documentElement.dataset.aliciaExt = version
//   • relays { source:'wagner-jobs', type:'ALICIA_APPLY', ... } page messages to the extension
//     background, which opens each posting and starts an autofill session (stopping before Submit).
// No extension ID or externally_connectable needed — the content script bridges page ↔ background.

export function extensionPresent() {
  try { return !!(document.documentElement && document.documentElement.dataset.aliciaExt) } catch { return false }
}
export function extensionVersion() {
  try { return document.documentElement.dataset.aliciaExt || null } catch { return null }
}

// Resolve once the extension announces itself, or after a short timeout (not installed).
export function waitForExtension(timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (extensionPresent()) { resolve(true); return }
    let done = false
    const finish = (v) => { if (done) return; done = true; window.removeEventListener('message', onMsg); resolve(v) }
    const onMsg = (e) => { if (e.source === window && e.data && e.data.source === 'alicia-ext' && e.data.type === 'PRESENT') finish(true) }
    window.addEventListener('message', onMsg)
    setTimeout(() => finish(extensionPresent()), timeoutMs)
  })
}

// Hand a batch of jobs (up to 10) to the extension for auto-fill. Each job: { url, title, company,
// resumeText }. THE EXTENSION opens each posting tab itself (chrome.tabs.create from its privileged
// background context — not subject to popup-blocking the way page-JS window.open is) and binds the
// fill session to the exact tab it creates, eliminating the URL-matching race that silently failed
// on custom-domain postings (confirmed live: Stripe, Databricks). The caller must NOT window.open()
// these jobs itself when the extension is present — that would open duplicate tabs.
// Resolves { ok, count, requested, tabIds } — ok/count reflect how many tabs the extension actually
// opened and bound, not just that the message was received, so the caller can report honestly.
export function sendApply(jobs, opts = {}) {
  return new Promise((resolve) => {
    if (!extensionPresent()) { resolve({ ok: false, count: 0, requested: jobs.length, tabIds: [] }); return }
    const nonce = 'a' + Math.random().toString(36).slice(2)
    const onMsg = (e) => {
      if (e.source === window && e.data && e.data.source === 'alicia-ext' && e.data.type === 'APPLY_ACK' && e.data.nonce === nonce) {
        window.removeEventListener('message', onMsg)
        resolve({ ok: !!e.data.ok, count: e.data.count || 0, requested: e.data.requested || jobs.length, tabIds: e.data.tabIds || [] })
      }
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ source: 'wagner-jobs', type: 'ALICIA_APPLY', nonce, jobs, options: opts }, '*')
    // Opening up to 10 real tabs takes longer than the old single-window.open path — give the
    // extension room to finish before giving up on it.
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ ok: false, count: 0, requested: jobs.length, tabIds: [] }) }, 8000)
  })
}

// Push the app's résumé/profile into the extension so autofill always uses what THIS app has
// (one source of truth instead of two independent résumé stores).
// data: { resumeText, resumeName, resumeFile: {name,type,b64}, profile }
export function sendSync(data) {
  return new Promise((resolve) => {
    if (!extensionPresent()) { resolve(false); return }
    const nonce = 's' + Math.random().toString(36).slice(2)
    const onMsg = (e) => {
      if (e.source === window && e.data && e.data.source === 'alicia-ext' && e.data.type === 'SYNC_ACK' && e.data.nonce === nonce) {
        window.removeEventListener('message', onMsg); resolve(!!e.data.ok)
      }
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ source: 'wagner-jobs', type: 'ALICIA_SYNC', nonce, data }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(false) }, 2500)
  })
}

// Subscribe to live fill-status events forwarded from the extension while it auto-fills an
// application tab. payload: { result: {status, filled, ...}, url, origUrl, explicit }.
// Returns an unsubscribe function.
export function onFillStatus(cb) {
  const onMsg = (e) => {
    if (e.source === window && e.data && e.data.source === 'alicia-ext' && e.data.type === 'FILL_STATUS') {
      try { cb(e.data.payload || {}) } catch { /* subscriber error — ignore */ }
    }
  }
  window.addEventListener('message', onMsg)
  return () => window.removeEventListener('message', onMsg)
}
