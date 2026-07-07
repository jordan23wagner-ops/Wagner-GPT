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

// Hand a batch of jobs to the extension to auto-apply. Each job: { url, title, company, resumeText }.
// The extension opens each posting (paced) and auto-fills, stopping before the final Submit.
// Returns true if the extension acknowledged, false if it isn't installed.
export function sendApply(jobs, opts = {}) {
  return new Promise((resolve) => {
    if (!extensionPresent()) { resolve(false); return }
    const nonce = 'a' + Math.random().toString(36).slice(2)
    const onMsg = (e) => {
      if (e.source === window && e.data && e.data.source === 'alicia-ext' && e.data.type === 'APPLY_ACK' && e.data.nonce === nonce) {
        window.removeEventListener('message', onMsg); resolve(true)
      }
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ source: 'wagner-jobs', type: 'ALICIA_APPLY', nonce, jobs, options: opts }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(extensionPresent()) }, 2000)
  })
}
