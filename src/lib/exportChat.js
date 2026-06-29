// Client-side conversation export — no dependencies, no serverless function.
//   - Word: an HTML document served with a .doc extension + msword mime. Opens natively
//     in Microsoft Word / Google Docs / Pages.
//   - PDF: opens a print-optimized window and triggers the browser's print dialog, where
//     the user picks "Save as PDF". Works everywhere, including mobile Safari/Chrome.

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function bodyHtml(title, messages) {
  const rows = (messages || [])
    .map((m) => {
      const who = m.role === 'user' ? 'You' : 'Assistant'
      const color = m.role === 'user' ? '#2563eb' : '#047857'
      const text = escapeHtml(m.content).replace(/\n/g, '<br/>')
      const img = m.image
        ? `<div><img src="${m.image}" style="max-width:480px;border-radius:8px;margin:6px 0"/></div>`
        : ''
      return `<div style="margin:0 0 16px;page-break-inside:avoid"><div style="font-weight:600;color:${color};margin-bottom:2px">${who}</div><div>${text}</div>${img}</div>`
    })
    .join('')
  return `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${rows}`
}

function safeName(t) {
  return (t || 'chat').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'chat'
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportWord(title, messages) {
  const html =
    `<!DOCTYPE html><html xmlns:o="urn:schemas-microsoft-com:office:office" ` +
    `xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#111">` +
    `${bodyHtml(title, messages)}</body></html>`
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  triggerDownload(blob, `${safeName(title)}.doc`)
}

export function exportPdf(title, messages) {
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;` +
    `margin:32px;color:#111;line-height:1.45}@page{margin:18mm}</style></head>` +
    `<body>${bodyHtml(title, messages)}` +
    `<script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>` +
    `</body></html>`
  const w = window.open('', '_blank')
  if (!w) return false // popup blocked
  w.document.open()
  w.document.write(html)
  w.document.close()
  return true
}
