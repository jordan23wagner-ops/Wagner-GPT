import React, { useState, useEffect, useRef } from 'react'
import {
  Loader2, Wand2, GitCommit, X, FolderGit2, FileCode, ArrowLeft, Paperclip,
} from 'lucide-react'
import {
  listRepos, getTree, getFile, locateFile, editFile, commitFile,
} from './lib/coder'
import { diffLines, diffStats } from './lib/linediff'

const ACCOUNTS = [
  { id: 'jordon', label: 'Jordon' },
  { id: 'alicia', label: 'Alicia' },
]

// Step labels shown in the spinner while generating
const STEP_LABELS = {
  locating: 'Finding the right file…',
  reading:  'Reading the file…',
  editing:  'Writing the change…',
}

export default function Code() {
  const [account, setAccount] = useState('jordon')
  const [repos, setRepos] = useState([])
  const [repo, setRepo] = useState(null)
  const [tree, setTree] = useState(null)
  const [projectContext, setProjectContext] = useState(null)

  const [instruction, setInstruction] = useState('')
  const [screenshot, setScreenshot] = useState(null)    // { data, mimeType, preview }
  const [locatedPath, setLocatedPath] = useState(null)  // path the model picked
  const [file, setFile] = useState(null)                // { path, content, sha, branch }
  const [proposal, setProposal] = useState(null)
  const [commitMsg, setCommitMsg] = useState('')

  const [step, setStep] = useState(null)   // null | 'locating' | 'reading' | 'editing'
  const [status, setStatus] = useState(null)
  const screenshotInputRef = useRef(null)

  const acct = account === 'jordon' ? undefined : account

  useEffect(() => {
    setRepo(null); setTree(null); setProjectContext(null); resetEdit()
    listRepos(acct)
      .then(setRepos)
      .catch((err) => setStatus({ type: 'error', text: err.message }))
  }, [account])

  function resetEdit() {
    setLocatedPath(null); setFile(null); setProposal(null)
    setInstruction(''); setScreenshot(null); setStatus(null); setStep(null)
  }

  const openRepo = async (fullName) => {
    const r = repos.find((x) => x.full_name === fullName)
    if (!r) return
    setRepo(r); resetEdit(); setProjectContext(null); setStep('reading')
    try {
      const t = await getTree(r.owner, r.repo, r.default_branch, acct)
      setTree(t)
      // Best-effort: grab package.json + README to give the model project context.
      fetchProjectContext(r, t.branch, acct).then(setProjectContext)
    } catch (err) {
      setStatus({ type: 'error', text: err.message })
    } finally {
      setStep(null)
    }
  }

  const generate = async () => {
    if (!tree || !instruction.trim() || step) return
    setStatus(null); setProposal(null); setLocatedPath(null); setFile(null)

    try {
      // 1. Ask the model which file to edit
      setStep('locating')
      const path = await locateFile(tree.files, instruction.trim(), projectContext, screenshot)
      setLocatedPath(path)

      // 2. Fetch that file from GitHub
      setStep('reading')
      const f = await getFile(repo.owner, repo.repo, path, tree.branch, acct)
      setFile(f)

      // 3. Ask the model to rewrite it
      setStep('editing')
      const updated = await editFile({ path: f.path, content: f.content, instruction: instruction.trim(), image: screenshot })

      if (updated === f.content) {
        setStatus({ type: 'error', text: 'The model returned no changes. Try rephrasing.' })
      } else {
        setProposal(updated)
        setCommitMsg(instruction.trim().slice(0, 72))
      }
    } catch (err) {
      setStatus({ type: 'error', text: err.message })
    } finally {
      setStep(null)
    }
  }

  const confirmCommit = async () => {
    if (proposal == null || !commitMsg.trim() || step) return
    setStep('editing'); setStatus(null)
    try {
      const result = await commitFile({
        owner: repo.owner, repo: repo.repo, path: file.path,
        content: proposal, message: commitMsg.trim(), sha: file.sha, branch: file.branch,
        account: acct,
      })
      setFile({ ...file, content: proposal, sha: result.sha || file.sha })
      setProposal(null); setInstruction(''); setLocatedPath(null)
      setStatus({ type: 'ok', text: 'Committed — Vercel will redeploy in ~1 minute.', url: result.commitUrl })
    } catch (err) {
      if (err.status === 409) {
        setStatus({ type: 'error', text: 'File changed on GitHub while you were editing. Please try again.' })
        resetEdit()
      } else {
        setStatus({ type: 'error', text: err.message })
      }
    } finally {
      setStep(null)
    }
  }

  const busy = !!step

  return (
    <div className="flex-1 overflow-y-auto bg-[var(--bg)]">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 bg-[var(--surface)] border-b border-[var(--border)] px-4 py-2 flex items-center gap-2 flex-wrap">
        <FolderGit2 size={16} className="text-[var(--accent)]" />
        <div className="flex rounded-lg overflow-hidden border border-[var(--border)] text-xs shrink-0">
          {ACCOUNTS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setAccount(id)}
              className={`px-3 py-1 font-medium transition-colors ${
                account === id
                  ? 'bg-[var(--accent)] text-[var(--accent-text)]'
                  : 'bg-[var(--input-bg)] text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <select
          value={repo?.full_name || ''}
          onChange={(e) => openRepo(e.target.value)}
          disabled={busy}
          className="px-3 py-1 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] max-w-[50%] disabled:opacity-50"
        >
          <option value="" disabled>Choose a repo…</option>
          {repos.map((r) => (
            <option key={r.full_name} value={r.full_name}>
              {r.full_name}{r.private ? ' 🔒' : ''}
            </option>
          ))}
        </select>
      </div>

      {status && (
        <div
          className={`mx-4 mt-3 px-3 py-2 rounded-lg text-sm border ${
            status.type === 'error'
              ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-950/40 dark:border-red-800 dark:text-red-200'
              : 'bg-green-50 border-green-200 text-green-700 dark:bg-green-950/40 dark:border-green-800 dark:text-green-200'
          }`}
        >
          {status.text}
          {status.url && (
            <> <a href={status.url} target="_blank" rel="noreferrer" className="underline font-medium">View commit</a></>
          )}
        </div>
      )}

      <div className="p-4">
        {!repo && (
          <p className="text-sm text-[var(--muted)] text-center py-10">
            Pick a repository above to get started.
          </p>
        )}

        {repo && !proposal && (
          <>
            {/* Loading repo tree */}
            {step === 'reading' && !tree && (
              <p className="flex items-center justify-center gap-2 text-sm text-[var(--muted)] py-10">
                <Loader2 size={16} className="animate-spin" /> Loading repo…
              </p>
            )}

            {tree && (
              <>
                <label className="block text-xs font-semibold text-[var(--muted)] mb-1">
                  What do you want to change?
                </label>
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  rows={4}
                  disabled={busy}
                  placeholder={`e.g. "Change the dashboard title to 'My Finances'"\ne.g. "Add a dark mode toggle to the navbar"\ne.g. "Fix the button on the login page so it says 'Sign In'"`}
                  className="w-full px-3 py-2 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)] resize-none disabled:opacity-50"
                />

                {/* Screenshot attachment */}
                <input
                  type="file"
                  accept="image/*"
                  ref={screenshotInputRef}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    const reader = new FileReader()
                    reader.onload = (ev) => {
                      const dataUrl = ev.target.result
                      setScreenshot({
                        data: dataUrl.split(',')[1],
                        mimeType: file.type || 'image/jpeg',
                        preview: dataUrl,
                      })
                    }
                    reader.readAsDataURL(file)
                  }}
                />
                {screenshot ? (
                  <div className="mt-2 flex items-center gap-2">
                    <img src={screenshot.preview} alt="screenshot" className="h-12 w-20 object-cover rounded border border-[var(--border)]" />
                    <span className="text-xs text-[var(--muted)]">Screenshot attached</span>
                    <button
                      type="button"
                      onClick={() => setScreenshot(null)}
                      className="ml-auto text-xs text-red-500 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => screenshotInputRef.current?.click()}
                    disabled={busy}
                    className="mt-2 flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-50"
                  >
                    <Paperclip size={13} /> Attach screenshot for context
                  </button>
                )}

                {/* Progress indicator */}
                {busy && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-[var(--muted)]">
                    <Loader2 size={15} className="animate-spin shrink-0" />
                    <span>{STEP_LABELS[step]}</span>
                    {locatedPath && (
                      <span className="flex items-center gap-1 ml-1 text-xs font-mono text-[var(--text)] bg-[var(--surface-2)] px-2 py-0.5 rounded">
                        <FileCode size={11} /> {locatedPath}
                      </span>
                    )}
                  </div>
                )}

                {!busy && locatedPath && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-[var(--muted)]">
                    <FileCode size={12} />
                    <span>Last edited: <span className="font-mono text-[var(--text)]">{locatedPath}</span></span>
                    <button onClick={resetEdit} className="ml-auto text-xs text-[var(--accent)] hover:underline">Reset</button>
                  </div>
                )}

                <button
                  onClick={generate}
                  disabled={busy || !instruction.trim()}
                  className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                  {busy ? STEP_LABELS[step] : 'Generate change'}
                </button>
              </>
            )}
          </>
        )}

        {/* Diff review */}
        {repo && proposal && file && (
          <>
            <button
              onClick={() => { setProposal(null) }}
              className="flex items-center gap-1 text-sm text-[var(--accent)] mb-3"
            >
              <ArrowLeft size={15} /> Back
            </button>
            <div className="flex items-center gap-2 mb-3">
              <FileCode size={15} className="text-[var(--accent)]" />
              <span className="text-sm font-medium text-[var(--text)] truncate font-mono">{file.path}</span>
              <span className="text-xs text-[var(--muted)]">· {file.branch}</span>
            </div>
            <DiffView
              oldText={file.content}
              newText={proposal}
              commitMsg={commitMsg}
              setCommitMsg={setCommitMsg}
              onCancel={() => setProposal(null)}
              onConfirm={confirmCommit}
              busy={busy}
            />
          </>
        )}
      </div>
    </div>
  )
}

// Fetch package.json and/or README to give the model project context.
// Silently ignores missing files — not every repo has both.
async function fetchProjectContext(repo, branch, acct) {
  const candidates = ['package.json', 'README.md', 'README.rst', 'requirements.txt', 'Cargo.toml']
  const parts = []
  for (const path of candidates) {
    try {
      const f = await getFile(repo.owner, repo.repo, path, branch, acct)
      const text = path === 'README.md' || path === 'README.rst'
        ? f.content.slice(0, 600)   // READMEs can be huge — just the top
        : f.content.slice(0, 2000)
      parts.push(`--- ${path} ---\n${text}`)
      if (parts.length >= 2) break  // two files is enough context
    } catch { /* file doesn't exist, skip */ }
  }
  return parts.length ? parts.join('\n\n') : null
}

function DiffView({ oldText, newText, commitMsg, setCommitMsg, onCancel, onConfirm, busy }) {
  const rows = diffLines(oldText, newText)
  const { add, del } = diffStats(rows)
  return (
    <div>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-green-600 dark:text-green-400 font-medium">+{add}</span>
        <span className="text-red-600 dark:text-red-400 font-medium">−{del}</span>
        <span className="text-[var(--muted)]">lines changed — review before committing</span>
      </div>
      <div className="max-h-72 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] text-xs font-mono leading-relaxed">
        {rows.map((r, i) => (
          <div
            key={i}
            className={
              r.type === 'add'
                ? 'px-2 whitespace-pre-wrap break-all bg-green-500/10 text-green-700 dark:text-green-300'
                : r.type === 'del'
                ? 'px-2 whitespace-pre-wrap break-all bg-red-500/10 text-red-700 dark:text-red-300'
                : 'px-2 whitespace-pre-wrap break-all text-[var(--muted)]'
            }
          >
            <span className="select-none opacity-60">{r.type === 'add' ? '+ ' : r.type === 'del' ? '- ' : '  '}</span>
            {r.text || ' '}
          </div>
        ))}
      </div>
      <label className="block text-xs font-semibold text-[var(--muted)] mt-4 mb-1">Commit message</label>
      <input
        type="text"
        value={commitMsg}
        onChange={(e) => setCommitMsg(e.target.value)}
        className="w-full px-3 py-2 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)]"
      />
      <div className="flex gap-2 mt-3">
        <button
          onClick={onConfirm}
          disabled={busy || !commitMsg.trim()}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <GitCommit size={16} />}
          Commit to GitHub
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex items-center justify-center gap-1 px-4 py-2 rounded-lg font-medium bg-[var(--surface-2)] text-[var(--text)] hover:opacity-80 disabled:opacity-50"
        >
          <X size={16} /> Cancel
        </button>
      </div>
    </div>
  )
}
