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

// Register a batch of jobs with the extension for auto-fill. Each job: { url, title, company,
// resumeText }. The WEB APP opens the posting tabs; the extension fills whichever opened tab matches
// (following redirects, stopping before Submit). Resolves TRUE only when the extension's background
// worker actually acknowledges handling it — so the caller can report honestly whether it worked.
export function sendApply(jobs, opts = {}) {
  return new Promise((resolve) => {
    if (!extensionPresent()) { resolve(false); return }
    const nonce = 'a' + Math.random().toString(36).slice(2)
    const onMsg = (e) => {
      if (e.source === window && e.data && e.data.source === 'alicia-ext' && e.data.type === 'APPLY_ACK' && e.data.nonce === nonce) {
        window.removeEventListener('message', onMsg); resolve(!!e.data.ok)
      }
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ source: 'wagner-jobs', type: 'ALICIA_APPLY', nonce, jobs, options: opts }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(false) }, 2500)
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
