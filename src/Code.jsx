import React, { useState, useEffect, useRef } from 'react'
import {
  Lock, Loader2, Search, FileCode, ArrowLeft, Wand2, GitCommit, X, FolderGit2,
} from 'lucide-react'
import {
  hasPassword, clearPassword, unlock, getTree, getFile, editFile, commitFile,
} from './lib/coder'
import { diffLines, diffStats } from './lib/linediff'

// Phase 8 — Coding Mode. A free, browser-based fallback coding assistant that edits the
// user's GitHub repos directly (no local PC, no Claude). Single-file edits: pick a repo,
// open a file, describe a change, review the diff, commit. All writes are password-gated
// server-side; we only ever hold the password in sessionStorage.
export default function Code() {
  // Auth
  const [pw, setPw] = useState('')
  const [unlocked, setUnlocked] = useState(false)
  const [unlocking, setUnlocking] = useState(false)

  // Repo / file navigation
  const [repos, setRepos] = useState([])
  const [repo, setRepo] = useState(null)          // { owner, repo, default_branch, ... }
  const [tree, setTree] = useState(null)          // { branch, truncated, files }
  const [fileFilter, setFileFilter] = useState('')
  const [file, setFile] = useState(null)          // { path, content, sha, branch }

  // Editing
  const [instruction, setInstruction] = useState('')
  const [proposal, setProposal] = useState(null)  // new file text awaiting confirmation
  const [commitMsg, setCommitMsg] = useState('')

  const [busy, setBusy] = useState(false)         // generic in-flight (load/generate/commit)
  const [status, setStatus] = useState(null)      // { type: 'error' | 'ok', text }
  const fileScrollRef = useRef(null)

  // Auto-unlock if a password is already cached for this tab session.
  useEffect(() => {
    if (!hasPassword()) return
    setUnlocking(true)
    unlock('')
      .then((r) => { setRepos(r); setUnlocked(true) })
      .catch(() => clearPassword())
      .finally(() => setUnlocking(false))
  }, [])

  const handleUnlock = async () => {
    if (!pw.trim() || unlocking) return
    setUnlocking(true)
    setStatus(null)
    try {
      const r = await unlock(pw.trim())
      setRepos(r)
      setUnlocked(true)
      setPw('')
    } catch (err) {
      setStatus({ type: 'error', text: err.message })
    } finally {
      setUnlocking(false)
    }
  }

  const handleLock = () => {
    clearPassword()
    setUnlocked(false)
    setRepos([]); setRepo(null); setTree(null); setFile(null); setProposal(null)
  }

  const openRepo = async (fullName) => {
    const r = repos.find((x) => x.full_name === fullName)
    if (!r) return
    setRepo(r); setTree(null); setFile(null); setProposal(null); setFileFilter('')
    setStatus(null); setBusy(true)
    try {
      setTree(await getTree(r.owner, r.repo, r.default_branch))
    } catch (err) {
      setStatus({ type: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  const openFile = async (path) => {
    if (!repo) return
    setBusy(true); setStatus(null); setProposal(null); setInstruction('')
    try {
      const f = await getFile(repo.owner, repo.repo, path, tree.branch)
      setFile(f)
    } catch (err) {
      setStatus({ type: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  const generate = async () => {
    if (!file || !instruction.trim() || busy) return
    setBusy(true); setStatus(null); setProposal(null)
    try {
      const updated = await editFile({ path: file.path, content: file.content, instruction: instruction.trim() })
      if (updated === file.content) {
        setStatus({ type: 'error', text: 'The model returned no changes. Try rephrasing the instruction.' })
      } else {
        setProposal(updated)
        setCommitMsg(instruction.trim().slice(0, 72))
      }
    } catch (err) {
      setStatus({ type: 'error', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  const confirmCommit = async () => {
    if (proposal == null || !commitMsg.trim() || busy) return
    setBusy(true); setStatus(null)
    try {
      const result = await commitFile({
        owner: repo.owner, repo: repo.repo, path: file.path,
        content: proposal, message: commitMsg.trim(), sha: file.sha, branch: file.branch,
      })
      // Roll the editor forward to the committed version.
      setFile({ ...file, content: proposal, sha: result.sha || file.sha })
      setProposal(null); setInstruction('')
      setStatus({ type: 'ok', text: 'Committed — Vercel will redeploy in about a minute.', url: result.commitUrl })
    } catch (err) {
      // 409 = the file changed under us (stale sha). Refetch so the user can retry.
      if (err.status === 409) {
        setStatus({ type: 'error', text: 'This file changed on GitHub. Reloading the latest version — please redo the change.' })
        openFile(file.path)
      } else {
        setStatus({ type: 'error', text: err.message })
      }
    } finally {
      setBusy(false)
    }
  }

  // ---- Render ----

  if (!unlocked) {
    return (
      <div className="flex-1 overflow-y-auto p-6 flex items-center justify-center bg-[var(--bg)]">
        <div className="w-full max-w-sm text-center">
          <Lock size={32} className="mx-auto mb-3 text-[var(--accent)]" />
          <h2 className="text-lg font-semibold text-[var(--text)]">Coding Mode</h2>
          <p className="text-sm text-[var(--muted)] mt-1 mb-4">
            Edit your GitHub repos right here. Enter the Coding Mode password to unlock.
          </p>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleUnlock() }}
            placeholder="Password"
            className="w-full px-4 py-2 rounded-lg border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)]"
            autoFocus
          />
          <button
            onClick={handleUnlock}
            disabled={unlocking || !pw.trim()}
            className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
          >
            {unlocking ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />}
            Unlock
          </button>
          {status?.type === 'error' && (
            <p className="text-sm text-red-500 mt-3">{status.text}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[var(--bg)]">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 bg-[var(--surface)] border-b border-[var(--border)] px-4 py-2 flex items-center gap-2 flex-wrap">
        <FolderGit2 size={16} className="text-[var(--accent)]" />
        <select
          value={repo?.full_name || ''}
          onChange={(e) => openRepo(e.target.value)}
          className="px-3 py-1 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] max-w-[60%]"
        >
          <option value="" disabled>Choose a repo…</option>
          {repos.map((r) => (
            <option key={r.full_name} value={r.full_name}>
              {r.full_name}{r.private ? ' 🔒' : ''}
            </option>
          ))}
        </select>
        <button
          onClick={handleLock}
          className="ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-[var(--surface-2)] text-[var(--muted)] hover:opacity-80"
          title="Lock Coding Mode"
        >
          <Lock size={13} /> Lock
        </button>
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
        {/* No repo chosen yet */}
        {!repo && (
          <p className="text-sm text-[var(--muted)] text-center py-10">
            Pick a repository above to browse its files.
          </p>
        )}

        {/* Repo chosen, no file open: file browser */}
        {repo && !file && (
          <>
            {busy && !tree && (
              <p className="flex items-center justify-center gap-2 text-sm text-[var(--muted)] py-10">
                <Loader2 size={16} className="animate-spin" /> Loading files…
              </p>
            )}
            {tree && (
              <>
                <div className="relative mb-3">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
                  <input
                    type="text"
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder="Filter files…"
                    className="w-full pl-8 pr-2 py-1.5 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)]"
                  />
                </div>
                {tree.truncated && (
                  <p className="text-xs text-[var(--muted)] mb-2">⚠️ This repo is large; the file list is partial.</p>
                )}
                <div className="space-y-0.5">
                  {tree.files
                    .filter((f) => f.path.toLowerCase().includes(fileFilter.trim().toLowerCase()))
                    .slice(0, 400)
                    .map((f) => (
                      <button
                        key={f.path}
                        onClick={() => openFile(f.path)}
                        className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-lg text-sm text-[var(--text)] hover:bg-[var(--surface-2)]"
                      >
                        <FileCode size={14} className="shrink-0 text-[var(--muted)]" />
                        <span className="truncate">{f.path}</span>
                      </button>
                    ))}
                </div>
              </>
            )}
          </>
        )}

        {/* File open: editor + instruction (or diff confirm) */}
        {repo && file && (
          <>
            <button
              onClick={() => { setFile(null); setProposal(null) }}
              className="flex items-center gap-1 text-sm text-[var(--accent)] mb-3"
            >
              <ArrowLeft size={15} /> Back to files
            </button>
            <div className="flex items-center gap-2 mb-2">
              <FileCode size={15} className="text-[var(--accent)]" />
              <span className="text-sm font-medium text-[var(--text)] truncate">{file.path}</span>
              <span className="text-xs text-[var(--muted)]">· {file.branch}</span>
            </div>

            {/* Confirm view: show the diff */}
            {proposal != null ? (
              <DiffView
                oldText={file.content}
                newText={proposal}
                commitMsg={commitMsg}
                setCommitMsg={setCommitMsg}
                onCancel={() => setProposal(null)}
                onConfirm={confirmCommit}
                busy={busy}
              />
            ) : (
              <>
                <pre
                  ref={fileScrollRef}
                  className="max-h-64 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-[var(--text)] whitespace-pre"
                >
                  {file.content}
                </pre>
                <label className="block text-xs font-semibold text-[var(--muted)] mt-4 mb-1">
                  Describe the change
                </label>
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  rows={3}
                  placeholder="e.g. Change the header text to 'Welcome back', and make the button blue."
                  className="w-full px-3 py-2 rounded-lg text-sm border bg-[var(--input-bg)] border-[var(--border)] text-[var(--text)] placeholder:text-[var(--muted)] resize-none"
                />
                <button
                  onClick={generate}
                  disabled={busy || !instruction.trim()}
                  className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-2 rounded-lg font-medium bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)] disabled:opacity-50"
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                  {busy ? 'Writing the change…' : 'Generate change'}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Before/after diff with a commit message box and confirm/cancel.
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
