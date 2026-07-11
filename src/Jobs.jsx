import React, { useState, useEffect, useRef } from 'react'
import {
  Search, Loader2, FileText, FileCheck, Trash2, Star, StarOff, Upload, ExternalLink,
  Plus, Pencil, X, Bookmark, Zap, Wand2, Sparkles, Brain, CheckCircle2, XCircle, Send,
  Folder, FolderOpen, ChevronRight, ChevronDown, Printer, Download, Target,
} from 'lucide-react'
import { fileToStored } from './lib/resumeParse'
import { parseDocument } from './lib/parseDocument'
import {
  loadResumes, saveResumes, loadTracked, saveTracked, loadMemory, saveMemory, loadProfile,
  loadTarget, saveTarget, activeResume, syncDown,
} from './lib/jobsStore'
import {
  aiRank, lexicalRank, quickTailor, matchScore,
  backendChat, stripThinking, deepSystemPrompt, deepIntro, extractConfirmedFacts,
} from './lib/jobsAI'
import { extensionPresent, extensionVersion, waitForExtension, sendApply, sendSync, onFillStatus } from './lib/aliciaBridge'
import { isFortune500, layoffFlag } from './lib/companyData'

// Industries mirror the backend's INDUSTRY_BOARDS keys (plus "Any"). `name` is sent to /api/jobs as
// `industry` so the backend can pick company ATS boards; `match` maps onto an Adzuna category label.
const INDUSTRIES = [
  { name: 'Any industry', match: null },
  { name: 'Software / IT', match: /it jobs/i },
  { name: 'Cybersecurity', match: /it jobs/i },
  { name: 'AI / Machine Learning', match: /it jobs/i },
  { name: 'Oil & Gas / Energy', match: /energy|oil/i },
  { name: 'Healthcare Tech', match: /healthcare|nursing/i },
  { name: 'Manufacturing', match: /manufacturing/i },
  { name: 'Engineering', match: /engineering/i },
  { name: 'Finance / Fintech', match: /accounting|finance/i },
  { name: 'Retail / Consumer', match: /retail/i },
  { name: 'Product Management', match: /it jobs/i },
  { name: 'Media / Gaming', match: /creative|design|media/i },
]
const COUNTRIES = [
  { v: 'us', label: 'United States' }, { v: 'gb', label: 'United Kingdom' },
  { v: 'ca', label: 'Canada' }, { v: 'au', label: 'Australia' },
]
const ATS_HOST_RE = /(^|\.)(myworkdayjobs|myworkdaysite|workday|greenhouse|lever|icims|ashbyhq|smartrecruiters|brassring|jobvite|taleo|workable|bamboohr|zohorecruit)\.(com|io|co|net)/i
const MAX_BATCH = 5          // apply 1–5 at a time (targeted, high-quality)
const APPLY_THRESHOLD = 50   // deep-rewrite auto-skip cutoff

const uid = (p) => p + Math.random().toString(36).slice(2, 9)

// Match a job to an already-saved tailored résumé (by posting URL, else company|title) so we don't
// create duplicates and can show a "résumé ready" badge + one-click apply.
function jobKey(company, title) { return ((company || '') + '|' + (title || '')).toLowerCase().replace(/\s+/g, ' ').trim() }
function findTailored(resumes, job) {
  if (!job) return null
  return resumes.find((r) => r.tailoredForJob && (
    (r.tailoredForJob.url && job.url && r.tailoredForJob.url === job.url) ||
    jobKey(r.tailoredForJob.company, r.tailoredForJob.title) === jobKey(job.company, job.title)
  )) || null
}

// ── salary: prefer the salary listed in the posting over Adzuna's estimate ──
function money(tok) {
  const k = /k$/i.test(tok.replace(/\s/g, ''))
  const n = parseFloat(tok.replace(/[\s,$]/g, '').replace(/k$/i, ''))
  return Number.isFinite(n) ? (k ? n * 1000 : n) : NaN
}
function parseListedSalary(text) {
  if (!text) return null
  const t = String(text).slice(0, 2000)
  const amt = '\\$\\s?\\d[\\d,]*(?:\\.\\d+)?\\s?[kK]?'
  let m = new RegExp(amt + '\\s*(?:-|–|—|to)\\s*' + amt + '\\s*(?:\\/|per\\s+|an?\\s+)?\\s*(?:hour|hr)\\b', 'i').exec(t)
    || new RegExp(amt + '\\s*(?:\\/|per\\s+|an?\\s+)\\s*(?:hour|hr)\\b', 'i').exec(t)
  if (m) {
    const nums = m[0].match(new RegExp(amt, 'g')).map(money).filter((n) => n >= 7 && n <= 500)
    if (nums.length) return { min: nums[0], max: nums[1] ?? null, period: 'hour' }
  }
  const rangeRe = new RegExp(amt + '\\s*(?:-|–|—|to)\\s*' + amt, 'g')
  let match
  while ((match = rangeRe.exec(t))) {
    const nums = match[0].match(new RegExp(amt, 'g')).map(money)
    if (nums.length >= 2 && nums.every((n) => n >= 20000 && n <= 1000000)) return { min: nums[0], max: nums[1], period: 'year' }
  }
  const single = new RegExp('(' + amt + ')\\s*(?:\\/|per\\s+|a\\s+)?\\s*(?:year|yr|annum|annually)', 'i').exec(t)
    || new RegExp('(?:salary|base|compensation|pay)[^.$]{0,40}?(' + amt + ')', 'i').exec(t)
  if (single) { const n = money(single[1]); if (n >= 20000 && n <= 1000000) return { min: n, max: null, period: 'year' } }
  return null
}
function fmtSalary(min, max, period) {
  const fmt = period === 'hour' ? (n) => '$' + (Math.round(n * 100) / 100) : (n) => '$' + Math.round(n / 1000) + 'k'
  const body = (min && max && min !== max) ? fmt(min) + '–' + fmt(max) : fmt(min || max)
  return body + (period === 'hour' ? '/hr' : '')
}
function salaryInfo(j) {
  const listed = parseListedSalary(j.description || '')
  if (listed) return { text: fmtSalary(listed.min, listed.max, listed.period), listed: true }
  if (j.salaryMin || j.salaryMax) return { text: fmtSalary(j.salaryMin, j.salaryMax, 'year') + (j.salaryPredicted ? ' est.' : ''), listed: false }
  return null
}
// Numeric annual salary for sorting (listed > Adzuna est.; hourly annualized). 0 when unknown.
function salaryNumber(j) {
  const listed = parseListedSalary(j.description || '')
  if (listed) { const v = listed.max || listed.min || 0; return listed.period === 'hour' ? v * 2080 : v }
  return j.salaryMax || j.salaryMin || 0
}
// Sort the already-fetched results by the chosen key (no re-fetch).
function sortResults(list, sortBy) {
  const arr = list.slice()
  if (sortBy === 'salary') arr.sort((a, b) => (b._sal || 0) - (a._sal || 0) || (b._score || 0) - (a._score || 0))
  else if (sortBy === 'match') arr.sort((a, b) => (b._score || 0) - (a._score || 0))
  else if (sortBy === 'date') arr.sort((a, b) => (b._ts || 0) - (a._ts || 0) || (b._score || 0) - (a._score || 0))
  else /* 'f500' */ arr.sort((a, b) => ((b._f500 ? 1 : 0) - (a._f500 ? 1 : 0)) || ((b._score || 0) - (a._score || 0)))
  return arr
}
function fitColor(score) {
  if (score >= 75) return '#2e7d32'
  if (score >= 50) return '#7a6a12'
  return '#7a3a3a'
}
// Relative posting age ("3d ago") + numeric timestamp for the date sort. Null when unknown.
function ageInfo(created) {
  const t = Date.parse(created || '')
  if (isNaN(t)) return null
  const days = Math.max(0, Math.floor((Date.now() - t) / 86400000))
  const text = days === 0 ? 'today' : days < 30 ? `${days}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`
  return { ts: t, text, stale: days > 30 }
}
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : '')

// Hoisted so React doesn't see a brand-new component type (and remount all tab buttons) every render.
function TabBtn({ id, label, Icon, viewTab, setViewTab }) {
  return (
    <button onClick={() => setViewTab(id)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${
        viewTab === id ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'bg-[var(--surface-2)] text-[var(--muted)]'}`}>
      <Icon size={15} /> {label}
    </button>
  )
}

export default function Jobs() {
  const [viewTab, setViewTab] = useState('search') // search | resumes | tracker | memory
  const [resumes, setResumes] = useState(loadResumes)
  const [tracked, setTracked] = useState(loadTracked)
  const [memory, setMemory] = useState(loadMemory)
  const [hasExt, setHasExt] = useState(extensionPresent())
  const [extVer, setExtVer] = useState(extensionVersion())

  useEffect(() => {
    let alive = true
    // Prefill the search form from the saved Target Profile so the fields already show what you hunt
    // for. Runs immediately from localStorage, then again if syncDown pulls a newer cloud copy.
    prefillFromTarget(loadTarget())
    syncDown().then((d) => {
      if (!alive || !d) return
      if (Array.isArray(d.resumes)) setResumes(d.resumes)
      if (Array.isArray(d.tracked)) setTracked(d.tracked)
      if (Array.isArray(d.memory)) setMemory(d.memory)
      if (d.target && (d.target.titles || d.target.industry)) { setTargetState(d.target); prefillFromTarget(d.target) }
    })
    waitForExtension().then((p) => { if (alive) { setHasExt(p); setExtVer(extensionVersion()) } })
    // Live fill-status from the extension while it auto-fills application tabs → tracker rows.
    const off = onFillStatus((p) => {
      const keyOf = (u) => String(u || '').split('?')[0].replace(/\/+$/, '').toLowerCase()
      const keys = [keyOf(p.origUrl), keyOf(p.url)].filter(Boolean)
      if (!keys.length || !p.result) return
      setTracked((prev) => prev.map((t) => (t.url && keys.includes(keyOf(t.url))
        ? { ...t, fillStatus: p.result.status, fillAt: Date.now() } : t)))
    })
    return () => { alive = false; off() }
  }, [])

  // Push the active résumé (text + original file) and profile into the extension whenever they
  // change, so autofill always fills with what THIS app has — one source of truth.
  const activeForSync = activeResume(resumes)
  useEffect(() => {
    if (!hasExt || !activeForSync || !activeForSync.text) return
    const t = setTimeout(() => {
      sendSync({
        resumeText: activeForSync.text,
        resumeName: activeForSync.name,
        resumeFile: activeForSync.file || null,
        profile: loadProfile(),
      })
    }, 800)
    return () => clearTimeout(t)
  }, [hasExt, activeForSync && activeForSync.id, activeForSync && activeForSync.text]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { saveResumes(resumes) }, [resumes])
  useEffect(() => { saveTracked(tracked) }, [tracked])
  useEffect(() => { saveMemory(memory) }, [memory])

  const active = activeResume(resumes)

  const addSavedResume = (name, text, tailoredForJob) => {
    const id = uid('r_')
    setResumes((prev) => [{ id, name, text, file: null, isActive: false, createdAt: Date.now(), tailoredForJob: tailoredForJob || null }, ...prev])
    return id
  }
  const upsertTracked = (job, patch) => {
    setTracked((prev) => {
      const existing = job.url && prev.find((t) => t.url === job.url)
      if (existing) return prev.map((t) => (t.id === existing.id ? { ...t, ...patch } : t))
      return [{
        id: uid('tj_'), title: job.title || 'Untitled role', company: job.company || '', location: job.location || '',
        url: job.url || '', description: (job.description || '').slice(0, 2000), status: 'saved', notes: '', savedAt: Date.now(),
        ...patch,
      }, ...prev]
    })
  }

  const tb = { viewTab, setViewTab }
  // Views stay MOUNTED and toggle with `hidden` — unmounting SearchView used to throw away the
  // results/selection every time you peeked at the Tracker, forcing a full (quota-burning) re-search.
  return (
    <div className="flex-1 overflow-y-auto bg-[var(--bg)]">
      <div className="max-w-3xl mx-auto p-4 space-y-4 text-[var(--text)]">
        <div className="flex items-center gap-2 flex-wrap">
          <TabBtn id="search" label="Search" Icon={Search} {...tb} />
          <TabBtn id="resumes" label={`Résumés${resumes.length ? ` (${resumes.length})` : ''}`} Icon={FileText} {...tb} />
          <TabBtn id="tracker" label={`Tracker${tracked.length ? ` (${tracked.length})` : ''}`} Icon={Bookmark} {...tb} />
          <TabBtn id="memory" label={`Memory${memory.length ? ` (${memory.length})` : ''}`} Icon={Brain} {...tb} />
          <span className="ml-auto text-xs text-[var(--muted)] truncate max-w-[40%]">
            {active ? `Active résumé: ${active.name}` : 'No active résumé — add one for fit ranking'}
          </span>
        </div>

        <div className={viewTab === 'search' ? '' : 'hidden'}>
          <SearchView activeResume={active} resumes={resumes} memory={memory} setMemory={setMemory}
            hasExt={hasExt} extVer={extVer} addSavedResume={addSavedResume} upsertTracked={upsertTracked}
            tracked={tracked} />
        </div>
        <div className={viewTab === 'resumes' ? '' : 'hidden'}><ResumesView resumes={resumes} setResumes={setResumes} /></div>
        <div className={viewTab === 'tracker' ? '' : 'hidden'}><TrackerView tracked={tracked} setTracked={setTracked} resumes={resumes} /></div>
        <div className={viewTab === 'memory' ? '' : 'hidden'}><MemoryView memory={memory} setMemory={setMemory} /></div>
      </div>
    </div>
  )
}

// ─────────────────────────── Search ───────────────────────────
function SearchView({ activeResume, resumes, memory, setMemory, hasExt, extVer, addSavedResume, upsertTracked, tracked }) {
  const trackedByUrl = {}
  tracked.forEach((t) => { if (t.url) trackedByUrl[t.url] = t })
  const [titles, setTitles] = useState('')
  const [industry, setIndustry] = useState('AI / Machine Learning')
  const [location, setLocation] = useState('')
  const [salaryMin, setSalaryMin] = useState('')
  const [country, setCountry] = useState('us')
  const [remote, setRemote] = useState(false)
  const [fullTime, setFullTime] = useState(true)
  const [aiFit, setAiFit] = useState(true)
  // Default OFF so the list is never surprisingly empty. When ON it filters to employer/ATS-direct
  // jobs, but falls back to showing all (with a note) if a search has zero direct results.
  const [directOnly, setDirectOnly] = useState(false)
  const [categories, setCategories] = useState([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState([])
  const [sortBy, setSortBy] = useState('f500') // f500 | match | salary
  const [sources, setSources] = useState(null)
  const [selected, setSelected] = useState({}) // id -> true
  const [prep, setPrep] = useState(null)        // { mode, jobs } when the prep modal is open
  const [target, setTargetState] = useState(() => loadTarget()) // saved Target Profile
  const [targetMsg, setTargetMsg] = useState('')
  const hasTarget = !!(target && (target.titles || target.industry))

  useEffect(() => {
    fetch('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'categories', country }),
    }).then((r) => r.json()).then((d) => setCategories((d && d.categories) || [])).catch(() => setCategories([]))
  }, [country])

  const resolveCategory = (indName = industry) => {
    const ind = INDUSTRIES.find((i) => i.name === indName)
    if (!ind || !ind.match || !categories.length) return ''
    const hit = categories.find((c) => ind.match.test(c.label))
    return hit ? hit.tag : ''
  }

  // ── Target Profile: set your roles/industry/salary once, re-run in one click ──
  const prefillFromTarget = (t) => {
    if (!t || (!t.titles && !t.industry)) return
    if (t.titles != null) setTitles(String(t.titles))
    if (t.industry) setIndustry(t.industry)
    if (t.salaryMin != null) setSalaryMin(String(t.salaryMin))
    if (t.location != null) setLocation(String(t.location))
    setRemote(!!t.remote)
    setFullTime(t.fullTime !== false) // default full-time on for a saved target unless explicitly false
    if (t.country) setCountry(t.country)
  }
  const saveTargets = () => {
    const t = { titles: titles.trim(), industry, salaryMin: salaryMin.trim(), remote, fullTime, country, location: location.trim() }
    saveTarget(t); setTargetState(t)
    setTargetMsg('✓ Saved as your Target Profile'); setTimeout(() => setTargetMsg(''), 2500)
  }
  const runTargets = () => {
    const t = loadTarget()
    if (!t || (!t.titles && !t.industry)) return
    prefillFromTarget(t)
    doSearch({ params: {
      titles: String(t.titles || '').trim(), industry: t.industry || industry,
      where: String(t.location || '').trim(), salaryMin: String(t.salaryMin || '').trim(),
      remote: !!t.remote, fullTime: t.fullTime !== false, country: t.country || country,
    } })
  }

  const [page, setPage] = useState(1)
  const doSearch = async (opts = {}) => {
    if (busy) return // Enter key used to bypass the disabled button and race two searches
    const append = !!opts.append
    const pageN = append ? page + 1 : 1
    setBusy(true)
    if (!append) { setResults([]); setSources(null); setSelected({}) }
    setStatus(append ? 'Loading more…' : 'Searching company boards + aggregators…')
    // opts.params lets "Run my targets" search with the saved Target Profile values immediately,
    // without waiting for the setState calls that also mirror them into the form to flush.
    const P = opts.params || null
    const q = {
      titles: P ? P.titles : titles.trim(),
      industry: P ? P.industry : industry,
      where: P ? P.where : location.trim(),
      salaryMin: P ? P.salaryMin : salaryMin.trim(),
      remote: P ? !!P.remote : remote,
      fullTime: P ? !!P.fullTime : fullTime,
      country: P ? P.country : country,
    }
    try {
      const resp = await fetch('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'search', titles: q.titles, industry: q.industry, category: resolveCategory(q.industry),
          where: q.where, salaryMin: q.salaryMin, remote: q.remote, fullTime: q.fullTime, country: q.country,
          resultsPerPage: 60, page: pageN,
        }),
      })
      const d = await resp.json()
      if (d && d.error) { setStatus(d.error); return }
      let list = (d && d.results) || []
      if (!append) setSources(d && d.sources)
      if (append) {
        // Only sources that page (Adzuna) yield new jobs; drop everything already shown.
        const seen = new Set(results.map((j) => (j.url || j.id).toLowerCase()))
        list = list.filter((j) => !seen.has((j.url || j.id).toLowerCase()))
        if (!list.length) { setStatus('No more new jobs for this search.'); return }
      } else if (!list.length) { setStatus('No jobs found — try broader titles, fewer filters, or a different industry.'); return }
      const resume = (activeResume && activeResume.text) || ''
      setStatus(`Found ${list.length}${append ? ' more' : ''} — ranking by fit…`)
      let scores
      if (aiFit && resume) { try { scores = await aiRank(list, resume) } catch { scores = lexicalRank(list, resume) } }
      else scores = lexicalRank(list, resume)
      const byI = {}
      scores.forEach((s, idx) => { const k = (typeof s.i === 'number' && s.i >= 1) ? s.i - 1 : idx; byI[k] = s })
      list = list.map((j, idx) => {
        const s = byI[idx] || {}
        const age = ageInfo(j.created)
        return {
          ...j, _score: typeof s.score === 'number' ? s.score : 50, _reason: s.reason || '',
          _f500: isFortune500(j.company), _layoff: layoffFlag(j.company), _sal: salaryNumber(j),
          _salInfo: salaryInfo(j), _age: age, _ts: age ? age.ts : 0, // precomputed once — cards used to re-regex every render
        }
      })
      const merged = append ? [...results, ...list] : list
      setResults(merged)
      setPage(pageN)
      const f500n = merged.filter((j) => j._f500).length
      setStatus(`Showing ${merged.length} jobs — Fortune 500 first (${f500n}), then best fit${resume ? '' : ' (add a résumé for smarter ranking)'}.`)
    } catch (err) {
      setStatus('Search failed: ' + ((err && err.message) || 'unknown') + '.')
    } finally { setBusy(false) }
  }

  const [applyingId, setApplyingId] = useState(null)
  // Direct apply for one job (no tailoring): use its existing tailored résumé if present, else the
  // active résumé. IMPORTANT: this must run synchronously off the click — calling window.open after
  // an `await` loses the user gesture and the browser silently blocks the tab. So branch on the
  // (synchronous) hasExt state and never await before opening.
  const applyOne = (job) => {
    const tr = findTailored(resumes, job)
    const resumeText = (tr && tr.text) || (activeResume && activeResume.text) || ''
    // Open the tab from the web app (synchronous → not popup-blocked). No 'noopener' so window.open
    // returns a usable value — null means the browser blocked it (then we don't claim "applied").
    const win = job.url ? window.open(job.url, '_blank') : null
    if (!win) {
      setStatus(`Couldn’t open “${job.title}” — your browser blocked the pop-up. Use “View posting” to open it. (Not marked applied.)`)
      return
    }
    if (hasExt) {
      // Don't claim "applied" until we know Alicia actually got the request — sendApply's `ok` only
      // means the extension ACKed, but that's the earliest honest signal we have. Marking it
      // unconditionally here previously left false "✓ applied" rows (MEI, Anduril) when the
      // extension never even received the job.
      upsertTracked(job, { status: 'saved', resumeId: tr ? tr.id : undefined })
      setStatus(`Opened “${job.title}” — asking Alicia to auto-fill…`)
      sendApply([{ url: job.url, title: job.title, company: job.company, resumeText }], { resumeName: tr ? tr.name : (activeResume && activeResume.name) })
        .then((ok) => {
          if (ok) upsertTracked(job, { status: 'applied' })
          setStatus(ok
            ? `Alicia is auto-filling “${job.title}” — review and click Submit. (On a job description page, it fills once you reach the application form.)`
            : `Opened “${job.title}” but couldn’t reach the Alicia extension to auto-fill — check the extension version by the indicator above (needs v1.11.1+), reload it, or fill manually. Not marked applied yet — update its status once you have.`)
        })
    } else {
      upsertTracked(job, { status: 'applied', resumeId: tr ? tr.id : undefined })
      setStatus(`Opened “${job.title}” and marked it applied${tr ? ' (tailored résumé is in Résumés).' : '.'}`)
    }
    setApplyingId(job.id)
    setTimeout(() => setApplyingId((c) => (c === job.id ? null : c)), 1200)
  }

  const directList = results.filter((j) => j.direct !== false)
  const directFellBack = directOnly && results.length > 0 && directList.length === 0
  const shown = sortResults((directOnly && directList.length) ? directList : results, sortBy)
  const selectedJobs = shown.filter((j) => selected[j.id])
  const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }))
  const selectTop = (n) => { const s = {}; shown.slice(0, n).forEach((j) => { s[j.id] = true }); setSelected(s) }
  const clearSel = () => setSelected({})

  const startPrep = (mode) => {
    let jobs = selectedJobs
    if (!jobs.length) { setStatus('Select one or more jobs first (checkbox on each card).'); return }
    if (!resumes.length) { setStatus('Add a résumé first (Résumés tab) — tailoring an empty résumé produces nothing usable.'); return }
    if (jobs.length > MAX_BATCH) { jobs = jobs.slice(0, MAX_BATCH); setStatus(`Batch capped at ${MAX_BATCH} — prepping your top ${MAX_BATCH} by fit.`) }
    setPrep({ mode, jobs })
  }

  const field = 'w-full bg-[var(--input-bg)] text-[var(--text)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]'
  const lbl = 'block text-xs text-[var(--muted)] mb-1'

  return (
    <div className="space-y-4">
      {/* Target Profile: set your roles + industry + salary floor once, re-run in one click */}
      <div className="rounded-xl border border-[var(--accent)]/40 bg-[var(--surface)] p-3 flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold flex items-center gap-1.5"><Target size={15} className="text-[var(--accent)]" /> Target Profile</span>
        {hasTarget ? (
          <>
            <span className="text-xs text-[var(--muted)] truncate max-w-full sm:max-w-[46ch]">
              {[target.titles, target.industry, target.salaryMin ? `$${Number(target.salaryMin).toLocaleString()}+` : '', target.remote ? 'Remote' : ''].filter(Boolean).join('  ·  ')}
            </span>
            <button onClick={runTargets} disabled={busy}
              className="ml-auto flex items-center gap-1.5 bg-[var(--accent)] text-[var(--accent-text)] font-semibold px-3 py-1.5 rounded-lg text-sm disabled:opacity-50 hover:bg-[var(--accent-hover)]">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Run my targets
            </button>
            <button onClick={saveTargets} className="text-xs text-[var(--muted)] hover:text-[var(--text)] underline whitespace-nowrap">Update from fields</button>
          </>
        ) : (
          <>
            <span className="text-xs text-[var(--muted)]">Save your roles + industry + salary floor once, then re-run in one click.</span>
            <button onClick={saveTargets} className="ml-auto text-sm bg-[var(--accent)] text-[var(--accent-text)] font-semibold px-3 py-1.5 rounded-lg hover:bg-[var(--accent-hover)] whitespace-nowrap">Save current as my targets</button>
          </>
        )}
        {targetMsg && <span className="text-xs text-green-600 basis-full">{targetMsg}</span>}
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className={lbl}>Job titles (comma-separated)</label>
          <input className={field} value={titles} onChange={(e) => setTitles(e.target.value)}
            placeholder="Project Manager, Program Manager" onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
        </div>
        <div><label className={lbl}>Industry</label>
          <select className={field} value={industry} onChange={(e) => setIndustry(e.target.value)}>
            {INDUSTRIES.map((i) => <option key={i.name} value={i.name}>{i.name}</option>)}
          </select>
        </div>
        <div><label className={lbl}>Location</label>
          <input className={field} value={location} onChange={(e) => setLocation(e.target.value)}
            placeholder="City, state, or ZIP (blank = anywhere)" onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
        </div>
        <div><label className={lbl}>Minimum salary (USD/yr)</label>
          <input className={field} type="number" value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} placeholder="e.g. 90000" />
        </div>
        <div><label className={lbl}>Country</label>
          <select className={field} value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => <option key={c.v} value={c.v}>{c.label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2 flex items-center gap-4 flex-wrap">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={remote} onChange={(e) => setRemote(e.target.checked)} /> Remote only</label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={fullTime} onChange={(e) => setFullTime(e.target.checked)} /> Full-time</label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer"><input type="checkbox" checked={aiFit} onChange={(e) => setAiFit(e.target.checked)} /> Rank by résumé fit (AI)</label>
          <label className="flex items-center gap-1.5 text-sm cursor-pointer" title="Hide 'via Adzuna' jobs — show only jobs that open directly on the employer/ATS"><input type="checkbox" checked={directOnly} onChange={(e) => setDirectOnly(e.target.checked)} /> Direct apply only</label>
          <button onClick={doSearch} disabled={busy}
            className="ml-auto flex items-center gap-1.5 bg-[var(--accent)] text-[var(--accent-text)] font-semibold px-4 py-2 rounded-lg text-sm disabled:opacity-50 hover:bg-[var(--accent-hover)]">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Search jobs
          </button>
        </div>
      </div>

      <div className="text-xs px-1">
        {hasExt
          ? <span className="text-green-600">🔌 Alicia extension detected{extVer ? ` (v${extVer})` : ''} — needs v1.11.1+ for hands-off auto-fill.</span>
          : <span className="text-[var(--muted)]">🔌 Alicia extension not detected — Apply opens the posting in a new tab (install/enable it for hands-off auto-fill).</span>}
      </div>
      {status && <div className="text-sm text-[var(--muted)] px-1">{status}</div>}
      {directFellBack && (
        <div className="text-xs px-1 text-orange-500">
          No direct-apply jobs for this search — showing all {results.length}. The ones marked “via Adzuna” open on Adzuna (which may ask you to log in); the Alicia extension will try to skip straight to the employer when you Apply.
        </div>
      )}
      {sources && (
        <div className="text-xs text-[var(--muted)] px-1">
          Sources — <span className="text-green-600">direct apply: {sources.directCount ?? '—'}</span>
          {' '}· via Adzuna: {sources.adzuna || 0}
          {typeof sources.jsearch === 'number' && sources.jsearchConfigured ? ` · JSearch: ${sources.jsearch}` : ''}
          {sources.jsearchConfigured === false ? ' · (add JSEARCH_KEY for more direct links)' : ''}
          {sources.jsearchError ? <span className="text-orange-500"> · JSearch error: {String(sources.jsearchError).slice(0, 140)}</span> : ''}
          {sources.jsearchConfigured && !sources.jsearchError && sources.jsearchRaw > 0 && sources.jsearch === 0 ? <span className="text-[var(--muted)]"> · (JSearch returned {sources.jsearchRaw} but your filters excluded them — try unchecking Remote only)</span> : ''}
        </div>
      )}

      {/* Batch action bar */}
      {results.length > 0 && (
        <div className="sticky top-0 z-10 flex items-center gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <span className="text-sm font-medium">{selectedJobs.length} selected</span>
          <button onClick={() => selectTop(MAX_BATCH)} className="text-xs px-2 py-1 rounded-lg bg-[var(--surface-2)]">Select top {MAX_BATCH}</button>
          {selectedJobs.length > 0 && <button onClick={clearSel} className="text-xs px-2 py-1 rounded-lg bg-[var(--surface-2)]">Clear</button>}
          <div className="ml-auto flex gap-2">
            <button onClick={() => startPrep('quick')} disabled={!selectedJobs.length}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-[var(--surface-2)] text-[var(--text)] disabled:opacity-40" title="Tailor from your existing résumés, then apply">
              <Sparkles size={14} /> Quick tailor & apply
            </button>
            <button onClick={() => startPrep('deep')} disabled={!selectedJobs.length}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] disabled:opacity-40" title="AI interviews you to fill gaps, rewrites, rescores, drops weak fits">
              <Wand2 size={14} /> Deep rewrite & apply
            </button>
          </div>
        </div>
      )}

      {results.length > 0 && (
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs text-[var(--muted)]">Sort by</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
            className="bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-2 py-1 text-xs">
            <option value="f500">Fortune 500 first</option>
            <option value="match">Best match (fit)</option>
            <option value="salary">Salary (high → low)</option>
            <option value="date">Newest first</option>
          </select>
        </div>
      )}

      <div className="space-y-3">
        {shown.map((j) => {
          const atsReady = ATS_HOST_RE.test((j.url || '').replace(/^https?:\/\//, ''))
          const scoreShown = typeof j._score === 'number'
          const trackedRec = trackedByUrl[j.url]
          const saved = !!trackedRec
          const applied = trackedRec && trackedRec.status && trackedRec.status !== 'saved'
          const sal = j._salInfo
          const tailored = findTailored(resumes, j)
          return (
            <div key={j.id} className={`rounded-xl border bg-[var(--surface)] p-4 flex gap-3 ${selected[j.id] ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
              <input type="checkbox" checked={!!selected[j.id]} onChange={() => toggle(j.id)} className="mt-1.5 shrink-0" title="Select for tailor & apply" />
              <div className="w-11 h-11 shrink-0 rounded-lg flex items-center justify-center font-bold text-white text-sm"
                style={{ background: scoreShown ? fitColor(j._score) : 'var(--surface-2)' }}>{scoreShown ? j._score : '—'}</div>
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-[15px] leading-snug">{j.title}</h3>
                <div className="text-[13px] text-[var(--muted)] mb-1.5">{j.company || 'Company undisclosed'}{j.location ? ' · ' + j.location : ''}</div>
                <div className="flex gap-1.5 flex-wrap mb-1.5">
                  {sal && (sal.listed
                    ? <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold text-white flex items-center gap-1" style={{ background: '#2e7d32' }} title="Listed in the job posting">💲 {sal.text} <span className="opacity-80 font-normal">listed</span></span>
                    : <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]" title="Estimated — not stated in the posting">{sal.text}</span>)}
                  {j.direct === false
                    ? <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: '#7c2d12', color: '#fed7aa' }} title="Apply opens Adzuna, which now requires an Adzuna login before forwarding to the employer — enable 'Direct apply only' to hide these">via Adzuna · may need login</span>
                    : <span className="text-[11px] px-2 py-0.5 rounded-full font-medium text-green-700 border border-green-600" title={j.resolved ? "Resolved to the employer's own posting (skips Adzuna)" : "Apply opens the employer's own posting directly"}>✓ direct apply</span>}
                  {j._f500 && <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold text-white" style={{ background: '#1d4ed8' }} title="Fortune 500 company">★ Fortune 500</span>}
                  {j._layoff && <span className="text-[11px] px-2 py-0.5 rounded-full font-medium flex items-center gap-1" style={{ background: '#7c2d12', color: '#fed7aa' }} title={`Recent layoffs: ${j._layoff}`}>⚠ recent layoffs</span>}
                  {j._age && <span className={`text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)] ${j._age.stale ? 'text-orange-500' : 'text-[var(--muted)]'}`} title={`Posted ${j._age.text}${j._age.stale ? ' — may be stale' : ''}`}>🕒 {j._age.text}</span>}
                  {j.source && <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--muted)]">{j.source}</span>}
                  {atsReady && <span className="text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1" style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}><Zap size={11} /> auto-fill ready</span>}
                  {tailored && <span className="text-[11px] px-2 py-0.5 rounded-full border flex items-center gap-1 text-green-600 border-green-600" title={`Tailored résumé already saved: ${tailored.name}`}><FileCheck size={11} /> résumé ready</span>}
                  {applied && <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold text-white flex items-center gap-1" style={{ background: '#1565c0' }} title={`Already in your tracker: ${trackedRec.status}${trackedRec.savedAt ? ' · ' + fmtDate(trackedRec.savedAt) : ''}`}>✓ {trackedRec.status}</span>}
                </div>
                {j._layoff && <div className="text-[11px] text-orange-500 mb-1">⚠ {j.company} — recent layoffs: {j._layoff}</div>}
                {j._reason && <div className="text-xs italic text-[var(--muted)] mb-1">{j._reason}</div>}
                {j.description && <div className="text-[13px] text-[var(--muted)] line-clamp-2">{j.description.slice(0, 240)}…</div>}
                <div className="flex gap-2 mt-2 flex-wrap">
                  <button onClick={() => applyOne(j)} disabled={applyingId === j.id}
                    className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] font-semibold hover:bg-[var(--accent-hover)] disabled:opacity-50"
                    title={tailored ? 'Apply with the tailored résumé already saved for this job' : 'Apply with your active résumé (no edits)'}>
                    {applyingId === j.id ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />} Apply
                  </button>
                  <a href={j.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80"><ExternalLink size={13} /> View posting</a>
                  <button onClick={() => upsertTracked(j, {})} disabled={saved} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80 disabled:opacity-50"><Bookmark size={13} /> {saved ? 'Saved' : 'Save to tracker'}</button>
                </div>
              </div>
            </div>
          )
        })}
        {results.length > 0 && (
          <button onClick={() => doSearch({ append: true })} disabled={busy}
            className="w-full py-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] text-sm text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-50 flex items-center justify-center gap-1.5">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Load more
          </button>
        )}
      </div>

      {prep && (
        <PrepFlow mode={prep.mode} jobs={prep.jobs} resumes={resumes} activeResume={activeResume}
          memory={memory} setMemory={setMemory} hasExt={hasExt}
          addSavedResume={addSavedResume} upsertTracked={upsertTracked}
          onClose={() => setPrep(null)} />
      )}
    </div>
  )
}

// ─────────────────────────── Prep & Apply flow ───────────────────────────
function PrepFlow({ mode, jobs, resumes, activeResume, memory, setMemory, hasExt, addSavedResume, upsertTracked, onClose }) {
  // phases: deep → 'qa' → 'confirm' → 'process' → 'review'; quick → 'process' → 'review'
  const [phase, setPhase] = useState(mode === 'deep' ? 'qa' : 'process')
  const [history, setHistory] = useState([])   // deep Q&A transcript
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [facts, setFacts] = useState([])       // extracted candidate facts (deep)
  const [factSel, setFactSel] = useState({})
  const [progress, setProgress] = useState([]) // per-job: { job, state, score, tailoredText, resumeId, decision }
  const [applyMsg, setApplyMsg] = useState('')
  const started = useRef(false)
  const base = (activeResume && activeResume.text) || (resumes[0] && resumes[0].text) || ''
  // Secondary material = BASE résumés only. Including tailored ones fed every previous AI output
  // back into every new tailor call — an unboundedly growing prompt of near-duplicates.
  const others = resumes.filter((r) => !r.tailoredForJob && (!activeResume || r.id !== activeResume.id)).map((r) => r.text)

  // Kick off deep Q&A.
  useEffect(() => {
    if (mode !== 'deep' || started.current) return
    started.current = true
    const h = [{ role: 'system', content: deepSystemPrompt() }, { role: 'user', content: deepIntro(base, jobs) }]
    setThinking(true)
    backendChat(h).then((raw) => {
      const t = stripThinking(raw)
      setHistory([...h, { role: 'assistant', content: t }])
    }).catch(() => setHistory([...h, { role: 'assistant', content: 'Let\'s start — what tools or skills have you used that the target roles ask for but your résumé doesn\'t clearly show?' }]))
      .finally(() => setThinking(false))
  }, []) // eslint-disable-line

  const sendAnswer = async () => {
    const text = input.trim()
    if (!text || thinking) return
    const h = [...history, { role: 'user', content: text }]
    setHistory(h); setInput(''); setThinking(true)
    try {
      const raw = await backendChat(h)
      const t = stripThinking(raw)
      if (/\[\[DONE\]\]/.test(t)) { await finishQA(h) }
      else setHistory([...h, { role: 'assistant', content: t }])
    } catch { setHistory([...h, { role: 'assistant', content: '(hmm, connection hiccup — say "done" to continue)' }]) }
    finally { setThinking(false) }
  }

  const finishQA = async (h) => {
    setThinking(true)
    try {
      const extracted = await extractConfirmedFacts(h)
      const fresh = extracted.filter((f) => !memory.some((m) => m.text.toLowerCase() === f.toLowerCase()))
      if (fresh.length) {
        setFacts(fresh); setFactSel(Object.fromEntries(fresh.map((f) => [f, true]))); setPhase('confirm')
      } else { setPhase('process') }
    } catch { setPhase('process') } finally { setThinking(false) }
  }

  const confirmFacts = () => {
    const chosen = facts.filter((f) => factSel[f]).map((f) => ({ id: uid('m_'), text: f, kind: 'skill', confirmedAt: Date.now() }))
    if (chosen.length) setMemory((prev) => [...chosen, ...prev])
    setPhase('process')
  }

  // Run tailor + rescore per job once we hit 'process'.
  useEffect(() => {
    if (phase !== 'process') return
    let cancelled = false
    ;(async () => {
      const mem = mode === 'deep'
        ? [...facts.filter((f) => factSel[f]).map((f) => ({ text: f })), ...memory]
        : memory
      const rows = jobs.map((j) => ({ job: j, state: 'pending', score: null, tailoredText: '', resumeId: null, decision: null }))
      setProgress(rows.map((r) => ({ ...r })))
      // Process the batch in parallel — 5 jobs tailor + score at once, not one-by-one.
      await Promise.all(jobs.map(async (job, i) => {
        if (cancelled) return
        const set = (patch) => setProgress((p) => p.map((r, k) => (k === i ? { ...r, ...patch } : r)))
        // Reuse an existing tailored résumé for this job (quick mode) instead of doubling up —
        // and reuse its saved score too, instead of a fresh AI call for a number we already computed.
        const existing = mode === 'quick' ? findTailored(resumes, job) : null
        if (existing) {
          let score = (existing.tailoredForJob && existing.tailoredForJob.score) || job._score || 70
          if (!(existing.tailoredForJob && existing.tailoredForJob.score)) { try { score = (await matchScore(existing.text, job)).score } catch { /* */ } }
          set({ state: 'done', score, tailoredText: existing.text, resumeId: existing.id, decision: 'ready', reused: true })
          return
        }
        set({ state: 'tailoring' })
        let tailoredText = ''
        try { tailoredText = await quickTailor(job, { activeText: base, otherTexts: others, memory: mem }) }
        catch { set({ state: 'error', decision: 'skipped' }); return }
        if (!tailoredText || tailoredText.trim().length < 200) { set({ state: 'error', decision: 'skipped' }); return } // backend hiccup — never save/apply an empty résumé
        if (cancelled) return
        set({ state: 'scoring', tailoredText })
        let score = 60
        try { score = (await matchScore(tailoredText, job)).score } catch { /* keep default */ }
        const name = `Tailored — ${job.company || 'Company'} · ${job.title || 'Role'}`.slice(0, 80)
        const resumeId = addSavedResume(name, tailoredText, { title: job.title, company: job.company, url: job.url, score })
        // Auto-skip weak fits only for deep rewrite (per the chosen behavior).
        const decision = (mode === 'deep' && score < APPLY_THRESHOLD) ? 'skipped' : 'ready'
        set({ state: 'done', score, resumeId, decision })
      }))
      if (!cancelled) setPhase('review')
    })()
    return () => { cancelled = true }
  }, [phase]) // eslint-disable-line

  // Review-phase local selection (which ready jobs to actually apply to).
  const [applySel, setApplySel] = useState({})
  useEffect(() => {
    if (phase !== 'review') return
    setApplySel(Object.fromEntries(progress.filter((r) => r.decision === 'ready').map((r) => [r.job.id, true])))
  }, [phase]) // eslint-disable-line

  // Synchronous off the click — open tabs from the web app (no 'noopener', so we can tell which
  // actually opened), track only those, then let the extension auto-fill the ones it recognizes.
  // Note: browsers typically allow only the first window.open per click, so batches often open 1 tab
  // and block the rest — we report that honestly and leave the blocked ones for "View posting".
  const doApply = () => {
    const chosen = progress.filter((r) => applySel[r.job.id] && r.state === 'done' && r.tailoredText)
    if (!chosen.length) { setApplyMsg('Nothing selected to apply to.'); return }
    const openedRows = []
    chosen.forEach((r) => { const w = r.job.url ? window.open(r.job.url, '_blank') : null; if (w) openedRows.push(r) })
    const opened = openedRows.length
    const blocked = chosen.length - opened
    const blockedNote = blocked ? ` ${blocked} pop-up(s) were blocked — open those from the Tracker or each card’s “View posting”.` : ''
    if (!opened) { setApplyMsg(`All ${chosen.length} pop-ups were blocked — nothing marked applied. Open them from “View posting”, or apply one at a time.`); return }
    const payloadJobs = openedRows.map((r) => ({ url: r.job.url, title: r.job.title, company: r.job.company, resumeText: r.tailoredText }))
    if (hasExt) {
      // See applyOne's comment: don't mark "applied" until sendApply confirms Alicia got the request.
      openedRows.forEach((r) => upsertTracked(r.job, { status: 'saved', resumeId: r.resumeId }))
      setApplyMsg(`Opened ${opened} tab(s) — asking Alicia to auto-fill…`)
      sendApply(payloadJobs, { resumeName: (activeResume && activeResume.name) || 'Tailored résumé' })
        .then((ok) => {
          if (ok) openedRows.forEach((r) => upsertTracked(r.job, { status: 'applied' }))
          setApplyMsg(ok
            ? `Alicia is auto-filling ${opened} tab(s) — review and click Submit on each.${blockedNote}`
            : `Opened ${opened} tab(s) but couldn’t reach the Alicia extension — check its version by the indicator (needs v1.11.1+), reload it, or fill manually. Not marked applied yet — update status once you have.${blockedNote}`)
        })
    } else {
      openedRows.forEach((r) => upsertTracked(r.job, { status: 'applied', resumeId: r.resumeId }))
      setApplyMsg(`Opened ${opened} posting(s) and marked applied. Install/enable the Alicia extension (v1.11.1+) for hands-off auto-fill.${blockedNote}`)
    }
  }

  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant')

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-3 border-b border-[var(--border)]">
          <div className="font-semibold text-sm flex items-center gap-2">
            {mode === 'deep' ? <Wand2 size={16} /> : <Sparkles size={16} />}
            {mode === 'deep' ? 'Deep rewrite & apply' : 'Quick tailor & apply'} · {jobs.length} job{jobs.length > 1 ? 's' : ''}
          </div>
          <button onClick={onClose} className="text-[var(--muted)]"><X size={18} /></button>
        </div>

        <div className="p-4 overflow-auto flex-1 space-y-3">
          {/* DEEP: Q&A */}
          {phase === 'qa' && (
            <>
              <p className="text-xs text-[var(--muted)]">Alicia is finding gaps across your {jobs.length} selected jobs. Answer honestly — it only adds what you confirm.</p>
              <div className="rounded-lg bg-[var(--surface-2)] p-3 text-sm space-y-2 min-h-[60px] max-h-72 overflow-y-auto">
                {history.filter((m, i) => m.role !== 'system' && i !== 1).map((m, i) => (
                  <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
                    <span className={`inline-block whitespace-pre-wrap rounded-lg px-2.5 py-1.5 max-w-[90%] text-left ${m.role === 'user' ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'bg-[var(--surface)]'}`}>{m.content}</span>
                  </div>
                ))}
                {thinking && <div className="text-[var(--muted)]">Thinking…</div>}
                {!thinking && !lastAssistant && <div className="text-[var(--muted)]">Starting…</div>}
              </div>
              <div className="flex gap-2">
                <input className="flex-1 bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
                  placeholder='Your answer… (or type "done")' value={input} disabled={thinking}
                  onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendAnswer()} />
                <button onClick={sendAnswer} disabled={thinking} className="px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] text-sm disabled:opacity-50">
                  {thinking ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                </button>
              </div>
              <button onClick={() => finishQA(history)} disabled={thinking} className="text-xs text-[var(--muted)] underline">Skip questions & generate now</button>
            </>
          )}

          {/* DEEP: confirm learned skills into memory */}
          {phase === 'confirm' && (
            <>
              <p className="text-sm font-medium">Add these to your memory?</p>
              <p className="text-xs text-[var(--muted)]">You mentioned things not clearly on your résumé. Confirm the true ones — Alicia will use them when tailoring now and in the future, and never invent beyond them.</p>
              <div className="space-y-1.5">
                {facts.map((f) => (
                  <label key={f} className="flex items-center gap-2 text-sm rounded-lg bg-[var(--surface-2)] px-3 py-2 cursor-pointer">
                    <input type="checkbox" checked={!!factSel[f]} onChange={() => setFactSel((s) => ({ ...s, [f]: !s[f] }))} /> {f}
                  </label>
                ))}
              </div>
              <button onClick={confirmFacts} className="mt-1 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] text-sm font-semibold">Confirm & continue</button>
            </>
          )}

          {/* Processing + review share the per-job list */}
          {(phase === 'process' || phase === 'review') && (
            <div className="space-y-2">
              {progress.map((r) => (
                <div key={r.job.id} className="rounded-lg border border-[var(--border)] p-3">
                  <div className="flex items-center gap-2">
                    {phase === 'review' && r.state === 'done' && (
                      <input type="checkbox" checked={!!applySel[r.job.id]} onChange={() => setApplySel((s) => ({ ...s, [r.job.id]: !s[r.job.id] }))} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{r.job.title} <span className="text-[var(--muted)] font-normal">· {r.job.company}</span></div>
                      <div className="text-xs text-[var(--muted)]">
                        {r.state === 'tailoring' && '✍️ tailoring résumé…'}
                        {r.state === 'scoring' && '📊 scoring fit…'}
                        {r.state === 'error' && '⚠️ tailoring failed — skipped'}
                        {r.state === 'done' && (
                          <>Fit {r.score} · {r.decision === 'skipped'
                            ? <span className="text-red-500">below {APPLY_THRESHOLD} — auto-skipped</span>
                            : <span className="text-green-600">ready</span>} · {r.reused ? 'reused saved résumé' : 'tailored résumé saved'}</>
                        )}
                      </div>
                    </div>
                    {(r.state === 'tailoring' || r.state === 'scoring') && <Loader2 size={15} className="animate-spin text-[var(--muted)]" />}
                    {r.state === 'done' && (r.decision === 'ready' ? <CheckCircle2 size={16} className="text-green-600" /> : <XCircle size={16} className="text-red-500" />)}
                  </div>
                </div>
              ))}
              {phase === 'process' && <p className="text-xs text-[var(--muted)]">Tailoring and scoring your batch…</p>}
            </div>
          )}
        </div>

        {phase === 'review' && (
          <div className="p-3 border-t border-[var(--border)] space-y-2">
            {!hasExt && <div className="text-xs text-[var(--muted)]">Alicia extension not detected — Apply will open the postings in new tabs for manual filling. Install/enable it for hands-off auto-fill.</div>}
            {applyMsg && <div className="text-xs text-[var(--text)]">{applyMsg}</div>}
            <div className="flex gap-2">
              <button onClick={doApply} className="flex-1 px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] text-sm font-semibold flex items-center justify-center gap-1.5">
                <Zap size={15} /> Apply to {progress.filter((r) => applySel[r.job.id]).length} {hasExt ? 'via extension' : '(open tabs)'}
              </button>
              <button onClick={onClose} className="px-3 py-2 rounded-lg bg-[var(--surface-2)] text-sm">Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────── Résumés ───────────────────────────
function ResumesView({ resumes, setResumes }) {
  const [status, setStatus] = useState('')
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteName, setPasteName] = useState('')
  const [viewing, setViewing] = useState(null)
  const [folderOpen, setFolderOpen] = useState(false)
  const fileRef = useRef(null)

  const addResume = (name, text, file) => {
    setResumes((prev) => {
      const cleared = prev.map((r) => ({ ...r, isActive: false }))
      return [{ id: uid('r_'), name: name || 'Résumé', text, file: file || null, isActive: true, createdAt: Date.now() }, ...cleared]
    })
  }
  const noTextTip = 'This file has no selectable text — likely an outlined, scanned, or “Print to PDF” / design-tool (Canva) export, where letters are saved as images/shapes. Upload the original .docx, or use “Paste text”. (Tip: if you can’t highlight text in the PDF, it has no text layer.)'
  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setStatus('Reading ' + file.name + '…')
    try {
      // Use the app's pdf.js/mammoth parser (robust) — handles most real text PDFs and .docx.
      const parsed = await parseDocument(file)
      const text = (parsed && parsed.text) || ''
      if (text.length < 40) { setStatus(noTextTip); return }
      const stored = await fileToStored(file).catch(() => null)
      addResume(file.name.replace(/\.(pdf|docx|txt)$/i, ''), text, stored)
      setStatus('Added ' + file.name + (stored ? '' : ' (text only — file too large to attach)') + '.')
    } catch (err) {
      const m = (err && err.message) || ''
      setStatus(/no readable text/i.test(m) ? noTextTip : (m || 'Could not read that file. Try a .docx, a text PDF, or “Paste text”.'))
    }
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
  const download = (r) => {
    const blob = new Blob([r.text || ''], { type: 'text/plain' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = (r.name || 'resume').replace(/[^\w.-]+/g, '_') + '.txt'; a.click(); URL.revokeObjectURL(a.href)
  }
  // Print-ready view → the browser's print dialog saves a clean PDF (ATS portals want PDF, not .txt).
  const printResume = (r) => {
    const w = window.open('', '_blank')
    if (!w) { setStatus('Pop-up blocked — allow pop-ups to print/PDF a résumé.'); return }
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    w.document.write(`<!doctype html><html><head><title>${esc(r.name)}</title><style>
      body{font:11pt/1.5 Georgia,'Times New Roman',serif;color:#111;background:#fff;max-width:7.5in;margin:0.6in auto;white-space:pre-wrap;word-wrap:break-word}
      @media print{body{margin:0}}
    </style></head><body>${esc(r.text)}</body></html>`)
    w.document.close(); w.focus()
    setTimeout(() => { try { w.print() } catch { /* user can Ctrl+P */ } }, 300)
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => fileRef.current && fileRef.current.click()} className="flex items-center gap-1.5 bg-[var(--accent)] text-[var(--accent-text)] font-semibold px-3 py-2 rounded-lg text-sm hover:bg-[var(--accent-hover)]"><Upload size={15} /> Upload PDF / DOCX / TXT</button>
        <button onClick={() => setPasteOpen((o) => !o)} className="flex items-center gap-1.5 bg-[var(--surface-2)] text-[var(--text)] px-3 py-2 rounded-lg text-sm"><Plus size={15} /> Paste text</button>
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" onChange={onFile} className="hidden" />
      </div>
      {pasteOpen && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2">
          <input className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" placeholder="Name (e.g. Base résumé)" value={pasteName} onChange={(e) => setPasteName(e.target.value)} />
          <textarea className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm h-40 font-mono" placeholder="Paste your résumé text here…" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          <div className="flex gap-2"><button onClick={savePaste} className="bg-[var(--accent)] text-[var(--accent-text)] px-3 py-1.5 rounded-lg text-sm font-semibold">Save</button><button onClick={() => setPasteOpen(false)} className="bg-[var(--surface-2)] px-3 py-1.5 rounded-lg text-sm">Cancel</button></div>
        </div>
      )}
      {status && <div className="text-sm text-[var(--muted)] px-1">{status}</div>}
      {(() => {
        const base = resumes.filter((r) => !r.tailoredForJob)
        const tailored = resumes.filter((r) => r.tailoredForJob)
        if (!resumes.length) {
          return <div className="text-center text-[var(--muted)] py-10 text-sm">No résumés yet. Upload or paste one — it powers the fit ranking and tailoring.</div>
        }
        const row = (r, compact) => (
          <div key={r.id} className={`rounded-xl border bg-[var(--surface)] p-3 flex items-center gap-3 ${r.isActive ? 'border-[var(--accent)]' : 'border-[var(--border)]'}`}>
            <button onClick={() => setActive(r.id)} title={r.isActive ? 'Active résumé' : 'Set active'}>
              {r.isActive ? <Star size={18} className="text-[var(--accent)] fill-[var(--accent)]" /> : <StarOff size={18} className="text-[var(--muted)]" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm truncate">{r.name}</div>
              <div className="text-xs text-[var(--muted)]">
                {compact && r.tailoredForJob
                  ? `${r.tailoredForJob.title || 'role'}${r.tailoredForJob.company ? ' · ' + r.tailoredForJob.company : ''}`
                  : (r.file ? 'file + text' : 'text')} · {(r.text || '').length.toLocaleString()} chars{r.isActive ? ' · active' : ''}
              </div>
            </div>
            <button onClick={() => setViewing(r)} className="text-[var(--muted)] hover:text-[var(--text)]" title="View"><FileText size={16} /></button>
            <button onClick={() => printResume(r)} className="text-[var(--muted)] hover:text-[var(--text)]" title="Print / save as PDF"><Printer size={16} /></button>
            <button onClick={() => download(r)} className="text-[var(--muted)] hover:text-[var(--text)]" title="Download .txt"><Upload size={16} className="rotate-180" /></button>
            <button onClick={() => rename(r.id)} className="text-[var(--muted)] hover:text-[var(--text)]" title="Rename"><Pencil size={16} /></button>
            <button onClick={() => del(r.id)} className="text-red-500 hover:opacity-80" title="Delete"><Trash2 size={16} /></button>
          </div>
        )
        return (
          <div className="space-y-2">
            {base.length === 0 && <div className="text-xs text-[var(--muted)] px-1">No base résumés — upload or paste one above.</div>}
            {base.map((r) => row(r, false))}

            {tailored.length > 0 && (
              <div className="rounded-xl border border-[var(--border)] overflow-hidden">
                <button onClick={() => setFolderOpen((o) => !o)}
                  className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--surface-2)] text-sm font-medium">
                  {folderOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  {folderOpen ? <FolderOpen size={15} className="text-[var(--accent)]" /> : <Folder size={15} className="text-[var(--accent)]" />}
                  Tailored résumés
                  <span className="text-[var(--muted)] font-normal">({tailored.length})</span>
                  {tailored.some((r) => r.isActive) && <span className="ml-auto text-[11px] text-[var(--accent)]">★ active inside</span>}
                </button>
                {folderOpen && (
                  <div className="p-2 space-y-2 bg-[var(--bg)]">
                    {tailored.map((r) => row(r, true))}
                    <button onClick={() => { if (window.confirm(`Delete all ${tailored.length} tailored résumés? (Base résumés are kept.)`)) setResumes((prev) => prev.filter((r) => !r.tailoredForJob)) }}
                      className="text-xs text-red-500 hover:opacity-80 px-1 pt-1">Clear all tailored</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })()}
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--border)]"><div className="font-semibold text-sm truncate">{viewing.name}</div><button onClick={() => setViewing(null)} className="text-[var(--muted)]"><X size={18} /></button></div>
            <pre className="p-4 overflow-auto text-xs whitespace-pre-wrap font-mono text-[var(--text)]">{viewing.text}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── Memory ───────────────────────────
function MemoryView({ memory, setMemory }) {
  const [text, setText] = useState('')
  const add = () => { const t = text.trim(); if (!t) return; setMemory((p) => [{ id: uid('m_'), text: t, kind: 'skill', confirmedAt: Date.now() }, ...p]); setText('') }
  const del = (id) => setMemory((p) => p.filter((m) => m.id !== id))
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--muted)]">Skills and facts Alicia has learned about you. These are used when tailoring — she'll never claim anything that isn't here or in your résumé. Add your own, or confirm them during a Deep rewrite.</p>
      <div className="flex gap-2">
        <input className="flex-1 bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm" placeholder="e.g. Led a 5-person team; AWS certified" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button onClick={add} className="px-3 py-2 rounded-lg bg-[var(--accent)] text-[var(--accent-text)] text-sm font-semibold">Add</button>
      </div>
      {memory.length === 0 ? (
        <div className="text-center text-[var(--muted)] py-10 text-sm">Nothing learned yet. Do a Deep rewrite and confirm the skills you mention, or add them here.</div>
      ) : (
        <div className="space-y-1.5">
          {memory.map((m) => (
            <div key={m.id} className="flex items-center gap-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] px-3 py-2 text-sm">
              <Brain size={14} className="text-[var(--muted)] shrink-0" />
              <span className="flex-1">{m.text}</span>
              <button onClick={() => del(m.id)} className="text-red-500 hover:opacity-80"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── Tracker ───────────────────────────
const STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected']
// Live autofill states forwarded by the extension while it fills an application tab.
const FILL_STATUS_LABELS = {
  advancing: { text: 'opening the application…', color: '#1565c0' },
  ready_to_submit: { text: '✓ filled — click Submit in the tab', color: '#2e7d32' },
  answered_review: { text: 'AI answered — review in the tab', color: '#7a6a12' },
  stopped_needs_input: { text: 'needs your input in the tab', color: '#7a6a12' },
  done_no_more_fields: { text: 'filled', color: '#2e7d32' },
  no_fields_found: { text: 'no form found — apply manually', color: '#7a3a3a' },
  stopped_step_cap: { text: 'stopped (too many steps)', color: '#7a3a3a' },
  no_profile: { text: 'set up the extension profile first', color: '#7a3a3a' },
  error: { text: 'autofill error', color: '#7a3a3a' },
}
function TrackerView({ tracked, setTracked, resumes }) {
  const [filter, setFilter] = useState('') // '' = all; else one of STATUSES
  const [viewing, setViewing] = useState(null) // résumé being viewed
  const setStatus = (id, status) => setTracked((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)))
  const setNotes = (id, notes) => setTracked((prev) => prev.map((t) => (t.id === id ? { ...t, notes } : t)))
  const del = (id) => setTracked((prev) => prev.filter((t) => t.id !== id))
  const counts = STATUSES.reduce((acc, s) => { acc[s] = tracked.filter((t) => t.status === s).length; return acc }, {})
  const exportCsv = () => {
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
    const rows = [['Title', 'Company', 'Location', 'Status', 'Saved', 'Résumé used', 'URL', 'Notes'],
      ...tracked.map((t) => {
        const r = t.resumeId && resumes.find((x) => x.id === t.resumeId)
        return [t.title, t.company, t.location, t.status, t.savedAt ? new Date(t.savedAt).toISOString().slice(0, 10) : '', r ? r.name : '', t.url, t.notes || '']
      })]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' }))
    a.download = 'applications.csv'; a.click(); URL.revokeObjectURL(a.href)
  }
  if (!tracked.length) return <div className="text-center text-[var(--muted)] py-10 text-sm">No tracked applications yet. Save jobs from Search to track them here.</div>
  const shown = filter ? tracked.filter((t) => t.status === filter) : tracked
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center text-xs">
        <button onClick={() => setFilter('')} className={`px-2 py-1 rounded-lg ${!filter ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'bg-[var(--surface-2)] text-[var(--muted)]'}`}>all: {tracked.length}</button>
        {STATUSES.map((s) => (
          <button key={s} onClick={() => setFilter(filter === s ? '' : s)}
            className={`px-2 py-1 rounded-lg ${filter === s ? 'bg-[var(--accent)] text-[var(--accent-text)]' : 'bg-[var(--surface-2)] text-[var(--muted)]'}`}>{s}: {counts[s]}</button>
        ))}
        <button onClick={exportCsv} className="ml-auto flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--text)]" title="Export all to CSV"><Download size={12} /> CSV</button>
      </div>
      {shown.map((t) => {
        const usedResume = t.resumeId && resumes.find((r) => r.id === t.resumeId)
        return (
          <div key={t.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm">{t.title}</div>
                <div className="text-xs text-[var(--muted)]">
                  {t.company}{t.location ? ' · ' + t.location : ''}
                  {t.savedAt ? <span title="Saved to tracker"> · {fmtDate(t.savedAt)}</span> : ''}
                </div>
                {t.fillStatus && FILL_STATUS_LABELS[t.fillStatus] && (
                  <div className="text-[11px] mt-0.5 font-medium" style={{ color: FILL_STATUS_LABELS[t.fillStatus].color }}
                    title={t.fillAt ? 'Last autofill update: ' + new Date(t.fillAt).toLocaleString() : ''}>
                    ⚡ {FILL_STATUS_LABELS[t.fillStatus].text}
                  </div>
                )}
                {usedResume && (
                  <button onClick={() => setViewing(usedResume)} className="mt-0.5 text-[11px] text-[var(--accent)] underline flex items-center gap-1" title="The exact résumé you applied with — review it before an interview">
                    <FileCheck size={11} /> {usedResume.name}
                  </button>
                )}
              </div>
              <select value={t.status} onChange={(e) => setStatus(t.id, e.target.value)} className="bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-2 py-1 text-xs">{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
              {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-[var(--muted)] hover:text-[var(--text)] mt-1"><ExternalLink size={15} /></a>}
              <button onClick={() => del(t.id)} className="text-red-500 hover:opacity-80 mt-1"><Trash2 size={15} /></button>
            </div>
            {/* Commit notes on blur — per-keystroke commits re-serialized the whole tracker + scheduled a cloud push each key. */}
            <input className="mt-2 w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-2 py-1 text-xs" placeholder="Notes…"
              defaultValue={t.notes || ''} onBlur={(e) => { if (e.target.value !== (t.notes || '')) setNotes(t.id, e.target.value) }} />
          </div>
        )
      })}
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={() => setViewing(null)}>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-[var(--border)]"><div className="font-semibold text-sm truncate">{viewing.name}</div><button onClick={() => setViewing(null)} className="text-[var(--muted)]"><X size={18} /></button></div>
            <pre className="p-4 overflow-auto text-xs whitespace-pre-wrap font-mono text-[var(--text)]">{viewing.text}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
