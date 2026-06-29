// Client-side document export — zero dependencies, no serverless function.
//
// Two modes:
//   1. Whole-chat export (Word / PDF) — from the history sidebar.
//   2. Per-reply export — user taps a button under an AI reply to download
//      that reply as a formatted Word or PDF document.
//
// The AI often writes document-like content (resumes, to-do lists, letters).
// We convert basic markdown (bold, headers, lists) to styled HTML so the
// exported file looks like a real document, not raw text.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Lightweight markdown → HTML for document formatting.
// Handles: **bold**, *italic*, ## headings, - bullet lists, numbered lists,
// blank-line paragraph breaks. Keeps it simple — no nested lists or tables.
function mdToHtml(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let inList = false
  let listType = null

  const closeList = () => {
    if (inList) { out.push(listType === 'ol' ? '</ol>' : '</ul>'); inList = false }
  }

  for (const raw of lines) {
    const line = raw

    // Headings
    const h3 = line.match(/^###\s+(.+)/)
    if (h3) { closeList(); out.push(`<h3 style="font-size:16px;margin:18px 0 6px;font-weight:600">${formatInline(h3[1])}</h3>`); continue }
    const h2 = line.match(/^##\s+(.+)/)
    if (h2) { closeList(); out.push(`<h2 style="font-size:18px;margin:20px 0 8px;font-weight:700">${formatInline(h2[1])}</h2>`); continue }
    const h1 = line.match(/^#\s+(.+)/)
    if (h1) { closeList(); out.push(`<h1 style="font-size:22px;margin:24px 0 10px;font-weight:700">${formatInline(h1[1])}</h1>`); continue }

    // Unordered list
    const ul = line.match(/^\s*[-*]\s+(.+)/)
    if (ul) {
      if (!inList || listType !== 'ul') { closeList(); out.push('<ul style="margin:4px 0 4px 20px">'); inList = true; listType = 'ul' }
      out.push(`<li style="margin:2px 0">${formatInline(ul[1])}</li>`)
      continue
    }

    // Ordered list
    const ol = line.match(/^\s*\d+[.)]\s+(.+)/)
    if (ol) {
      if (!inList || listType !== 'ol') { closeList(); out.push('<ol style="margin:4px 0 4px 20px">'); inList = true; listType = 'ol' }
      out.push(`<li style="margin:2px 0">${formatInline(ol[1])}</li>`)
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr style="border:none;border-top:1px solid #ccc;margin:16px 0"/>'); continue }

    // Blank line = paragraph break
    if (!line.trim()) { closeList(); out.push('<div style="height:10px"></div>'); continue }

    // Normal text
    closeList()
    out.push(`<p style="margin:3px 0;line-height:1.5">${formatInline(line)}</p>`)
  }
  closeList()
  return out.join('\n')
}

function formatInline(text) {
  let s = escapeHtml(text)
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  s = s.replace(/`(.+?)`/g, '<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:13px">$1</code>')
  return s
}

// ---- Shared helpers ----

function safeName(t) {
  return (t || 'document').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'document'
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

const DOC_STYLE =
  'font-family:Calibri,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;color:#111;line-height:1.5;max-width:680px;margin:0 auto;padding:32px 24px'

const WORD_PREAMBLE =
  '<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">' +
  '<head><meta charset="utf-8">'

// ---- Whole-chat export (existing, used by sidebar) ----

function chatBodyHtml(title, messages) {
  const rows = (messages || [])
    .map((m) => {
      const who = m.role === 'user' ? 'You' : 'Assistant'
      const color = m.role === 'user' ? '#2563eb' : '#047857'
      const content = m.role === 'assistant' ? mdToHtml(m.content) : `<p>${escapeHtml(m.content).replace(/\n/g, '<br/>')}</p>`
      const img = m.image
        ? `<div><img src="${m.image}" style="max-width:480px;border-radius:8px;margin:6px 0"/></div>`
        : ''
      return `<div style="margin:0 0 16px;page-break-inside:avoid"><div style="font-weight:600;color:${color};margin-bottom:4px">${who}</div>${content}${img}</div>`
    })
    .join('')
  return `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${rows}`
}

export function exportWord(title, messages) {
  const html =
    `${WORD_PREAMBLE}<title>${escapeHtml(title)}</title></head>` +
    `<body style="${DOC_STYLE}">${chatBodyHtml(title, messages)}</body></html>`
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  triggerDownload(blob, `${safeName(title)}.doc`)
}

export function exportPdf(title, messages) {
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{${DOC_STYLE}}@page{margin:18mm}@media print{.no-print{display:none}}</style></head>` +
    `<body>${chatBodyHtml(title, messages)}` +
    `<div class="no-print" style="text-align:center;margin:32px 0"><button onclick="window.print()" ` +
    `style="padding:12px 32px;font-size:16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer">` +
    `Save as PDF</button></div>` +
    `<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>` +
    `</body></html>`
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}

// ---- Per-reply document export ----

function replyDocHtml(content, title, asWord) {
  const body = mdToHtml(content)
  if (asWord) {
    return (
      `${WORD_PREAMBLE}<title>${escapeHtml(title)}</title></head>` +
      `<body style="${DOC_STYLE}">${body}</body></html>`
    )
  }
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{${DOC_STYLE}}@page{margin:18mm}@media print{.no-print{display:none}}</style></head>` +
    `<body>${body}` +
    `<div class="no-print" style="text-align:center;margin:32px 0"><button onclick="window.print()" ` +
    `style="padding:12px 32px;font-size:16px;border-radius:8px;border:none;background:#2563eb;color:#fff;cursor:pointer">` +
    `Save as PDF</button></div>` +
    `<script>window.onload=function(){setTimeout(function(){window.print()},400)}<\/script>` +
    `</body></html>`
  )
}

// Derive a filename from the first heading or first ~40 chars of content.
function titleFromContent(content) {
  const heading = String(content || '').match(/^#+\s+(.{1,50})/m)
  if (heading) return heading[1].trim()
  const first = String(content || '').trim().split('\n')[0].replace(/[*#_]/g, '').trim()
  return first.slice(0, 40) || 'document'
}

export function exportReplyWord(content) {
  const title = titleFromContent(content)
  const html = replyDocHtml(content, title, true)
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  triggerDownload(blob, `${safeName(title)}.doc`)
}

export function exportReplyPdf(content) {
  const title = titleFromContent(content)
  const html = replyDocHtml(content, title, false)
  const w = window.open('', '_blank')
  if (!w) return false
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}
