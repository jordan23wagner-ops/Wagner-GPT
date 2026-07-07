import React, { useState, useEffect, useRef } from 'react'
import {
  Search, Loader2, FileText, Trash2, Star, StarOff, Upload, ExternalLink,
  Plus, Pencil, X, Bookmark, Zap,
} from 'lucide-react'
import { extractResumeText, fileToStored } from './lib/resumeParse'
import {
  loadResumes, saveResumes, loadTracked, saveTracked, activeResume, syncDown,
} from './lib/jobsStore'

// Industries mirror the backend's INDUSTRY_BOARDS keys (plus "Any"). The `name` is sent to
// /api/jobs as `industry` so the backend can pick company ATS boards; `category` maps the
// industry onto an Adzuna category label (resolved live against the category list).
const INDUSTRIES = [
  { name: 'Any industry', match: null },
  { name: 'Software / IT', match: /it jobs/i },
  { name: 'Cybersecurity', match: /it jobs/i },
  { name: 'AI / Machine Learning', match: /it jobs/i },
  { name: 'Oil & Gas / Energy', match: /energy|oil/i },
  { name: 'Healthcare Tech', match: /healthcare|nursing/i },
  { name: 'Manufacturing', match: /manufacturing/i },
  { name: 'Engineering', match: /engineering/i },
]

const COUNTRIES = [
  { v: 'us', label: 'United States' }, { v: 'gb', label: 'United Kingdom' },
  { v: 'ca', label: 'Canada' }, { v: 'au', label: 'Australia' },
]

// Known ATS hosts our extension can auto-fill — used to badge "auto-fill ready" cards.
const ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|brassring|jobvite|taleo|workable|bamboohr)\.(com|io|co|net)/i

const uid = (p) => p + Math.random().toString(36).slice(2, 9)

// ── backend text (NDJSON delta stream, same contract as App.jsx /api/chat) ──
function stripThinking(t) {
  if (!t) return t
  let c = t.replace(/<think>[\s\S]*?<\/think>/gi, '')
  if (/<\/think>/i.test(c)) c = c.replace(/[\s\S]*<\/think>/i, '')
  return c.replace(/<\/?think>/gi, '').trim()
}
async function backendText(sys, user) {
  const resp = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: sys }], newMessage: user, model: 'auto' }),
  })
  if (!resp.ok || !resp.body) throw new Error('Backend ' + resp.status)
  const reader = resp.body.getReader(), dec = new TextDecoder()
  let buf = '', text = ''
  const handle = (line) => {
    const ln = line.trim(); if (!ln) return
    try { const ev = JSON.parse(ln); if (ev.delta) text += ev.delta; else if (ev.error) throw new Error(ev.error) } catch { /* skip */ }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1) }
  }
  if (buf) handle(buf)
  return text
}

// ── résumé-fit ranking (AI, with lexical fallback) — ported from jobsearch.js ──
function lexicalRank(results, resume) {
  const rt = (resume || '').toLowerCase()
  const toks = {}
  rt.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).forEach((w) => { if (w.length > 3) toks[w] = 1 })
  const keys = Object.keys(toks)
  return results.map((j) => {
    const hay = ((j.title || '') + ' ' + (j.description || '') + ' ' + (j.category || '')).toLowerCase()
    let hits = 0
    keys.forEach((w) => { if (hay.indexOf(w) >= 0) hits++ })
    const score = keys.length ? Math.min(95, Math.round((hits / Math.min(keys.length, 40)) * 100)) : 50
    return { i: 0, score, reason: '' }
  })
}
async function aiRank(results, resume) {
  const sys = 'You are Alicia, a job-fit rater. Given the candidate résumé and a numbered list of jobs, ' +
    'score each job 0-100 for how well the candidate fits it (skills, seniority, domain), and give a ' +
    'terse 6-12 word reason. Respond ONLY with a strict JSON array, no prose, no code fences: ' +
    '[{"i":<job number>,"score":<0-100>,"reason":"<short>"}]'
  const lines = results.map((j, i) =>
    (i + 1) + '. ' + (j.title || '') + ' @ ' + (j.company || '') + ' | ' + (j.location || '') +
    ' | ' + (j.category || '') + ' | ' + (j.description || '').slice(0, 240)).join('\n')
  const user = 'Résumé:\n' + (resume || '').slice(0, 6000) + '\n\nJobs:\n' + lines
  const raw = await backendText(sys, user)
  const clean = stripThinking(raw).replace(/^```json\s*/i, '').replace(/```$/, '').trim()
  let arr = null
  try { arr = JSON.parse(clean) } catch { const m = clean.match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]) } catch { /* */ } } }
  if (!Array.isArray(arr)) throw new Error('bad rank json')
  return arr
}

// Parse a definitive salary out of the job description text. Company postings often state the
// real range ("$120,000–$150,000", "$120k-$150k", "$60/hr") — that's the source of truth, so we
// prefer it over Adzuna's estimated number. Returns { min, max, period:'year'|'hour' } | null.
function money(tok) {
  const k = /k$/i.test(tok.replace(/\s/g, ''))
  const n = parseFloat(tok.replace(/[\s,$]/g, '').replace(/k$/i, ''))
  return Number.isFinite(n) ? (k ? n * 1000 : n) : NaN
}
function parseListedSalary(text) {
  if (!text) return null
  const t = String(text).slice(0, 2000)
  const amt = '\\$\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?[kK]?'
  // Hourly range or single.
  let m = new RegExp(amt + '\\s*(?:-|–|—|to)\\s*' + amt + '\\s*(?:\\/|per\\s+|an?\\s+)?\\s*(?:hour|hr)\\b', 'i').exec(t)
    || new RegExp(amt + '\\s*(?:\\/|per\\s+|an?\\s+)\\s*(?:hour|hr)\\b', 'i').exec(t)
  if (m) {
    const nums = m[0].match(new RegExp(amt, 'g')).map(money).filter((n) => n >= 7 && n <= 500)
    if (nums.length) return { min: nums[0], max: nums[1] ?? null, period: 'hour' }
  }
  // Annual range of two $ amounts.
  const rangeRe = new RegExp(amt + '\\s*(?:-|–|—|to)\\s*' + amt, 'g')
  let match
  while ((match = rangeRe.exec(t))) {
    const nums = match[0].match(new RegExp(amt, 'g')).map(money)
    if (nums.length >= 2 && nums.every((n) => n >= 20000 && n <= 1000000)) return { min: nums[0], max: nums[1], period: 'year' }
  }
  // Single annual amount with a year context nearby.
  const single = new RegExp('(' + amt + ')\\s*(?:\\/|per\\s+|a\\s+)?\\s*(?:year|yr|annum|annually)', 'i').exec(t)
    || new RegExp('(?:salary|base|compensation|pay)[^.$]{0,40}?(' + amt + ')', 'i').exec(t)
  if (single) { const n = money(single[1]); if (n >= 20000 && n <= 1000000) return { min: n, max: null, period: 'year' } }
  return null
}
function fmtSalary(min, max, period) {
  const fmt = period === 'hour'
    ? (n) => '$' + (Math.round(n * 100) / 100)
    : (n) => '$' + Math.round(n / 1000) + 'k'
  const body = min && max ? fmt(min) + '–' + fmt(max) : fmt(min || max)
  return body + (period === 'hour' ? '/hr' : '')
}
// Returns { text, listed } — listed:true means pulled verbatim from the posting (source of truth).
function salaryInfo(j) {
  const listed = parseListedSalary(j.description || '')
  if (listed) return { text: fmtSalary(listed.min, listed.max, listed.period), listed: true }
  if (j.salaryMin || j.salaryMax) return { text: fmtSalary(j.salaryMin, j.salaryMax, 'year') + (j.salaryPredicted ? ' est.' : ''), listed: false }
  return null
}
function fitColor(score) {
  if (score >= 75) return '#2e7d32'
  if (score >= 50) return '#7a6a12'
  return '#7a3a3a'
}

export default function Jobs() {
  const [view, setView] = useState('search') // search | resumes | tracker
  const [resumes, setResumes] = useState(loadResumes)
  const [tracked, setTracked] = useState(loadTracked)

  // Pull any cloud snapshot on mount (best-effort; no-ops without the table).
  useEffect(() => {
    let alive = true
    syncDown().then((d) => {
      if (!alive || !d) return
      if (Array.isArray(d.resumes)) setResumes(d.resumes)
      if (Array.isArray(d.tracked)) setTracked(d.tracked)
    })
    return () => { alive = false }
  }, [])

  // Persist on change.
  useEffect(() => { saveResumes(resumes) }, [resumes])
  useEffect(() => { saveTracked(tracked) }, [tracked])

  const active = activeResume(resumes)

  const addToTracker = (job) => {
    setTracked((prev) => {
      if (job.url && prev.some((t) => t.url === job.url)) return prev
      return [{
        id: uid('tj_'), title: job.title || 'Untitled role', company: job.company || '',
        location: job.location || '', url: job.url || '', description: (job.description || '').slice(0, 2000),
        status: 'saved', notes: '', savedAt: Date.now(),
      }, ...prev]
    })
  }

  const TabBtn = ({ id, label, Icon }) => (
    <button
      onClick={() => setView(id)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${
        view === id ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'bg-[var(--surface-2)] text-[var(--muted)]'
      }`}
    >
      <Icon size={15} /> {label}
    </button>
  )

  return (
    <div className="flex-1 overflow-y-auto bg-[var(--bg)]">
      <div className="max-w-3xl mx-auto p-4 space-y-4 text-[var(--text)]">
        <div className="flex items-center gap-2 flex-wrap">
          <TabBtn id="search" label="Search" Icon={Search} />
          <TabBtn id="resumes" label={`Résumés${resumes.length ? ` (${resumes.length})` : ''}`} Icon={FileText} />
          <TabBtn id="tracker" label={`Tracker${tracked.length ? ` (${tracked.length})` : ''}`} Icon={Bookmark} />
          <span className="ml-auto text-xs text-[var(--muted)] truncate max-w-[45%]">
            {active ? `Active résumé: ${active.name}` : 'No active résumé — add one for fit ranking'}
          </span>
        </div>

        {view === 'search' && <SearchView activeResume={active} onSave={addToTracker} trackedUrls={tracked.map((t) => t.url)} />}
        {view === 'resumes' && <ResumesView resumes={resumes} setResumes={setResumes} onGoSearch={() => setView('search')} />}
        {view === 'tracker' && <TrackerView tracked={tracked} setTracked={setTracked} />}
      </div>
    </div>
  )
}

// ─────────────────────────── Search ───────────────────────────
function SearchView({ activeResume, onSave, trackedUrls }) {
  const [titles, setTitles] = useState('')
  const [industry, setIndustry] = useState('AI / Machine Learning')
  const [location, setLocation] = useState('')
  const [salaryMin, setSalaryMin] = useState('')
  const [country, setCountry] = useState('us')
  const [remote, setRemote] = useState(false)
  const [fullTime, setFullTime] = useState(true)
  const [aiFit, setAiFit] = useState(true)
  const [categories, setCategories] = useState([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState([])
  const [sources, setSources] = useState(null)

  useEffect(() => {
    fetch('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'categories', country }),
    }).then((r) => r.json()).then((d) => setCategories((d && d.categories) || [])).catch(() => setCategories([]))
  }, [country])

  const resolveCategory = () => {
    const ind = INDUSTRIES.find((i) => i.name === industry)
    if (!ind || !ind.match || !categories.length) return ''
    const hit = categories.find((c) => ind.match.test(c.label))
    return hit ? hit.tag : ''
  }

  const doSearch = async () => {
    setBusy(true); setResults([]); setSources(null); setStatus('Searching company boards + aggregators…')
    try {
      const resp = await fetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'search', titles: titles.trim(), industry, category: resolveCategory(),
          where: location.trim(), salaryMin: salaryMin.trim(), remote, fullTime, country, resultsPerPage: 60,
        }),
      })
      const d = await resp.json()
      if (d && d.error) { setStatus(d.error); setResults([]); return }
      let list = (d && d.results) || []
      setSources(d && d.sources)
      if (!list.length) { setStatus('No jobs found — try broader titles, fewer filters, or a different industry.'); return }
      const resume = (activeResume && activeResume.text) || ''
      setStatus(`Found ${list.length} — ranking by fit…`)
      let scores
      if (aiFit && resume) {
        try { scores = await aiRank(list, resume) } catch { scores = lexicalRank(list, resume) }
      } else { scores = lexicalRank(list, resume) }
      const byI = {}
      scores.forEach((s, idx) => { const k = (typeof s.i === 'number' && s.i >= 1) ? s.i - 1 : idx; byI[k] = s })
      list = list.map((j, idx) => { const s = byI[idx] || {}; return { ...j, _score: typeof s.score === 'number' ? s.score : 50, _reason: s.reason || '' } })
      list.sort((a, b) => (b._score || 0) - (a._score || 0))
      setResults(list)
      setStatus(`Showing ${list.length} jobs, best fit first${resume ? '' : ' (add a résumé for smarter ranking)'}.`)
    } catch (err) {
      setStatus('Search failed: ' + ((err && err.message) || 'unknown') + '.')
    } finally { setBusy(false) }
  }

  const field = 'w-full bg-[var(--input-bg)] text-[var(--text)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]'
  const lbl = 'block text-xs text-[var(--muted)] mb-1'

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className={lbl}>Job titles (comma-separated)</label>
          <input className={field} value={titles} onChange={(e) => setTitles(e.target.value)}
            placeholder="Project Manager, Program Manager" onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
        </div>
        <div>
          <label className={lbl}>Industry</label>
          <select className={field} value={industry} onChange={(e) => setIndustry(e.target.value)}>
            {INDUSTRIES.map((i) => <option key={i.name} value={i.name}>{i.name}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>Location</label>
          <input className={field} value={location} onChange={(e) => setLocation(e.target.value)}
            placeholder="City, state, or ZIP (blank = anywhere)" onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
        </div>
        <div>
          <label className={lbl}>Minimum salary (USD/yr)</label>
          <input className={field} type="number" value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} placeholder="e.g. 90000" />
        </div>
        <div>
          <label className={lbl}>Country</label>
          <select className={field} value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2 flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} /> Remote only</label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={fullTime} onChange={(e) => setFullTime(e.target.checked)} /> Full-time</label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={aiFit} onChange={(e) => setAiFit(e.target.checked)} /> Rank by résumé fit (AI)</label>
          <button onClick={doSearch} disabled={busy}
            className="ml-auto flex items-center gap-1.5 bg-[var(--accent)] text-[var(--accent-text)] font-semibold px-4 py-2 rounded-lg text-sm disabled:opacity-50 hover:bg-[var(--accent-hover)]">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Search jobs
          </button>
        </div>
      </div>

      {status && <div className="text-sm text-[var(--muted)] px-1">{status}</div>}
      {sources && (
        <div className="text-xs text-[var(--muted)] px-1">
          Sources — company boards: {sources.ats}{sources.discovered ? ` (+${sources.discovered} discovered)` : ''} · aggregator: {sources.adzuna}
          {!sources.adzunaConfigured && ' (Adzuna key not set — company boards only)'}
        </div>
      )}

      <div className="space-y-3">
        {results.map((j) => {
          const atsReady = ATS_HOST_RE.test((j.url || '').replace(/^https?:\/\//, ''))
          const scoreShown = typeof j._score === 'number'
          const saved = trackedUrls.includes(j.url)
          return (
            <div key={j.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 flex gap-3">
              <div className="w-12 h-12 shrink-0 rounded-lg flex items-center justify-center font-bold text-white text-sm"
                style={{ background: scoreShown ? fitColor(j._score) : 'var(--surface-2)' }}>
                {scoreShown ? j._score : '—'}
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-[15px] leading-snug">{j.title}</h3>
                <div className="text-[13px] text-[var(--muted)] mb-1.5">
                  {j.company || 'Company undisclosed'}{j.location ? ' · ' + j.location : ''}
                </div>
                <div className="flex gap-1.5 flex-wrap mb-1.5">
                  {(() => {
                    const sal = salaryInfo(j)
                    if (!sal) return null
                    return sal.listed
                      ? <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold text-white flex items-center gap-1" style={{ background: '#2e7d32' }} title="Listed in the job posting">💲 {sal.text} <span className="opacity-80 font-normal">listed</span></span>
                      : <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]" title="Estimated — not stated in the posting">{sal.text}</span>
                  })()}
                  {j.source && <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]">{j.source}</span>}
                  {j.contractTime && <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]">{String(j.contractTime).replace('_', '-')}</span>}
                  {atsReady && <span className="text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}><Zap size={11} /> auto-fill ready</span>}
                </div>
                {j._reason && <div className="text-xs italic text-[var(--muted)] mb-1">{j._reason}</div>}
                {j.description && <div className="text-[13px] text-[var(--muted)] line-clamp-2">{j.description.slice(0, 240)}…</div>}
                <div className="flex gap-2 mt-2">
                  <a href={j.url} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80">
                    <ExternalLink size={13} /> View posting
                  </a>
                  <button onClick={() => onSave(j)} disabled={saved}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80 disabled:opacity-50">
                    <Bookmark size={13} /> {saved ? 'Saved' : 'Save to tracker'}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────── Résumés ───────────────────────────
function ResumesView({ resumes, setResumes, onGoSearch }) {
  const [status, setStatus] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteName, setPasteName] = useState('')
  const [viewing, setViewing] = useState(null)
  const fileRef = useRef(null)

  const addResume = (name, text, file) => {
    setResumes((prev) => {
      const cleared = prev.map((r) => ({ ...r, isActive: false }))
      return [{ id: uid('r_'), name: name || 'Résumé', text, file: file || null, isActive: true, createdAt: Date.now() }, ...cleared]
    })
  }

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setStatus('Reading ' + file.name + '…')
    try {
      const text = await extractResumeText(file)
      if (!text || text.length < 40) { setStatus('Could not extract text from this file. Try a .docx, .pdf, or paste the text.'); return }
      const stored = await fileToStored(file).catch(() => null)
      addResume(file.name.replace(/\.(pdf|docx|txt)$/i, ''), text, stored)
      setStatus('Added ' + file.name + (stored ? '' : ' (text only — file too large to attach)') + '.')
    } catch (err) { setStatus(err.message || 'Could not read that file.') }
  }

  const savePaste = () => {
    const t = pasteText.trim()
    if (t.length < 40) { setStatus('Please paste at least a few lines of résumé text.'); return }
    addResume(pasteName.trim() || 'Pasted résumé', t, null)
    setPasteOpen(false); setPasteText(''); setPasteName(''); setStatus('Résumé saved.')
  }

  const setActive = (id) => setResumes((prev) => prev.map((r) => ({ ...r, isActive: r.id === id })))
  const del = (id) => setResumes((prev) => prev.filter((r) => r.id !== id))
  const rename = (id) => {
    const cur = resumes.find((r) => r.id === id)
    const name = window.prompt('Rename résumé', cur ? cur.name : '')
    if (name != null) setResumes((prev) => prev.map((r) => (r.id === id ? { ...r, name: name.trim() || r.name } : r)))
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => fileRef.current && fileRef.current.click()}
          className="flex items-center gap-1.5 bg-[var(--accent)] text-[var(--accent-text)] font-semibold px-3 py-2 rounded-lg text-sm hover:bg-[var(--accent-hover)]">
          <Upload size={15} /> Upload PDF / DOCX / TXT
        </button>
        <button onClick={() => setPasteOpen((o) => !o)}
          className="flex items-center gap-1.5 bg-[var(--surface-2)] text-[var(--text)] px-3 py-2 rounded-lg text-sm">
          <Plus size={15} /> Paste text
        </button>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" onChange={onFile} className="hidden" />
      </div>

      {pasteOpen && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2">
          <input className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" placeholder="Name (e.g. Base résumé)" value={pasteName} onChange={(e) => setPasteName(e.target.value)} />
          <textarea className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm h-40 font-mono" placeholder="Paste your résumé text here…" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          <div className="flex gap-2">
            <button onClick={savePaste} className="bg-[var(--accent)] text-[var(--accent-text)] px-3 py-1.5 rounded-lg text-sm font-semibold">Save</button>
            <button onClick={() => setPasteOpen(false)} className="bg-[var(--surface-2)] px-3 py-1.5 rounded-lg text-sm">Cancel</button>
          </div>
        </div>
      )}

      {status && <div className="text-sm text-[var(--muted)] px-1">{status}</div>}

      {resumes.length === 0 ? (
        <div className="text-center text-[var(--muted)] py-10 text-sm">
          No résumés yet. Upload or paste one — it powers the fit ranking in Search.
        </div>
      ) : (
        <div className="space-y-2">
          {resumes.map((r) => (
            <div key={r.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 flex items-center gap-3">
              <button onClick={() => setActive(r.id)} title={r.isActive ? 'Active résumé' : 'Set active'}>
                {r.isActive ? <Star size={18} className="text-[var(--accent)] fill-[var(--accent)]" /> : <StarOff size={18} className="text-[var(--muted)]" />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{r.name}{r.tailoredForJob ? ` — ${r.tailoredForJob.company || ''}` : ''}</div>
                <div className="text-xs text-[var(--muted)]">{r.file ? 'file + text' : 'text'} · {(r.text || '').length.toLocaleString()} chars{r.isActive ? ' · active' : ''}</div>
              </div>
              <button onClick={() => setViewing(r)} className="text-[var(--muted)] hover:text-[var(--text)]" title="View"><FileText size={16} /></button>
              <button onClick={() => rename(r.id)} className="text-[var(--muted)] hover:text-[var(--text)]" title="Rename"><Pencil size={16} /></button>
              <button onClick={() => del(r.id)} className="text-red-500 hover:opacity-80" title="Delete"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
              <div className="font-semibold text-sm truncate">{viewing.name}</div>
              <button onClick={() => setViewing(null)} className="text-[var(--muted)]"><X size={18} /></button>
            </div>
            <pre className="p-4 overflow-auto text-xs whitespace-pre-wrap font-mono text-[var(--text)]">{viewing.text}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── Tracker ───────────────────────────
const STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected']
function TrackerView({ tracked, setTracked }) {
  const setStatus = (id, status) => setTracked((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)))
  const setNotes = (id, notes) => setTracked((prev) => prev.map((t) => (t.id === id ? { ...t, notes } : t)))
  const del = (id) => setTracked((prev) => prev.filter((t) => t.id !== id))

  const counts = STATUSES.reduce((acc, s) => { acc[s] = tracked.filter((t) => t.status === s).length; return acc }, {})

  if (!tracked.length) {
    return <div className="text-center text-[var(--muted)] py-10 text-sm">No tracked applications yet. Save jobs from Search to track them here.</div>
  }
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap text-xs text-[var(--muted)]">
        {STATUSES.map((s) => <span key={s} className="px-2 py-1 rounded-lg bg-[var(--surface-2)]">{s}: {counts[s]}</span>)}
      </div>
      {tracked.map((t) => (
        <div key={t.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm">{t.title}</div>
              <div className="text-xs text-[var(--muted)]">{t.company}{t.location ? ' · ' + t.location : ''}</div>
            </div>
            <select value={t.status} onChange={(e) => setStatus(t.id, e.target.value)}
              className="bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-2 py-1 text-xs">
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-[var(--muted)] hover:text-[var(--text)] mt-1"><ExternalLink size={15} /></a>}
            <button onClick={() => del(t.id)} className="text-red-500 hover:opacity-80 mt-1"><Trash2 size={15} /></button>
          </div>
          <input className="mt-2 w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-2 py-1 text-xs"
            placeholder="Notes…" value={t.notes || ''} onChange={(e) => setNotes(t.id, e.target.value)} />
        </div>
      ))}
    </div>
  )
}
