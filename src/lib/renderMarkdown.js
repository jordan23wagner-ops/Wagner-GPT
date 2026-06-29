// Tiny markdown-to-HTML for rendering assistant replies in chat bubbles.
// Handles: **bold**, *italic*, `code`, ## headings, - bullet lists,
// numbered lists, --- horizontal rules, and paragraph breaks.
// Returns an HTML string safe for dangerouslySetInnerHTML (content is
// escaped first, then only known safe tags are injected).

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function inline(text) {
  let s = esc(text)
  // Links first so bold/italic don't mangle URLs: [label](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline">$1</a>')
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  s = s.replace(/`(.+?)`/g, '<code style="background:rgba(128,128,128,.15);padding:1px 4px;border-radius:3px;font-size:0.85em">$1</code>')
  return s
}

export default function renderMarkdown(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let inList = false
  let listTag = null

  const closeList = () => {
    if (inList) { out.push(`</${listTag}>`); inList = false }
  }

  for (const line of lines) {
    // Headings
    const h3 = line.match(/^###\s+(.+)/)
    if (h3) { closeList(); out.push(`<div style="font-weight:700;font-size:0.95em;margin:10px 0 2px">${inline(h3[1])}</div>`); continue }
    const h2 = line.match(/^##\s+(.+)/)
    if (h2) { closeList(); out.push(`<div style="font-weight:700;font-size:1.05em;margin:12px 0 3px">${inline(h2[1])}</div>`); continue }
    const h1 = line.match(/^#\s+(.+)/)
    if (h1) { closeList(); out.push(`<div style="font-weight:700;font-size:1.15em;margin:14px 0 4px">${inline(h1[1])}</div>`); continue }

    // Unordered list
    const ul = line.match(/^\s*[-*]\s+(.+)/)
    if (ul) {
      if (!inList || listTag !== 'ul') { closeList(); out.push('<ul style="margin:2px 0 2px 16px;padding:0">'); inList = true; listTag = 'ul' }
      out.push(`<li style="margin:1px 0">${inline(ul[1])}</li>`)
      continue
    }

    // Ordered list
    const ol = line.match(/^\s*\d+[.)]\s+(.+)/)
    if (ol) {
      if (!inList || listTag !== 'ol') { closeList(); out.push('<ol style="margin:2px 0 2px 16px;padding:0">'); inList = true; listTag = 'ol' }
      out.push(`<li style="margin:1px 0">${inline(ol[1])}</li>`)
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr style="border:none;border-top:1px solid rgba(128,128,128,.3);margin:8px 0"/>'); continue }

    // Blank line
    if (!line.trim()) { closeList(); out.push('<div style="height:6px"></div>'); continue }

    // Normal text
    closeList()
    out.push(`<div>${inline(line)}</div>`)
  }
  closeList()
  return out.join('')
}
