# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What this is

**Wagner-GPT** — a 100% free AI assistant PWA (chat, document creation, image generation, a garden
farming game, and a multi-source job search "Jobs" tab). Mobile-first, serverless, zero monthly
cost. Live at **wagner-gpt.vercel.app**.

**⚠️ Push to `main` auto-deploys to production** (Vercel, GitHub-integration triggered). Never push
to `main` without stating intent and getting explicit confirmation first — this is a standing rule,
not per-request. Feature branches are safe to commit/push freely; only `main` triggers a deploy.

Sister repo: **Job-Assistant** (`C:\Users\Jordon\Job-Assistant`) is the "Alicia AI" Chrome extension
that does on-page autofill — something a web page fundamentally cannot do. The Jobs tab here
(`src/Jobs.jsx`) and that extension talk to each other via `src/lib/aliciaBridge.js`
(`window.postMessage`) — see "Extension handoff" below. That repo has its own CLAUDE.md/HANDOFF.md;
read those when a change touches the extension side of the handoff.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + Tailwind CSS |
| Backend | Vercel serverless functions (`api/*.js`) |
| Chat AI | Ollama Cloud (primary) + NVIDIA NIM (fallback) |
| Image gen | NVIDIA NIM FLUX.1-dev → HuggingFace FLUX.1-schnell → Pollinations.ai |
| Storage | Browser localStorage (fast) + Supabase Postgres (durable, cross-device sync) |
| Hosting | Vercel, auto-deploys on push to `main` |

No Docker, no database server to manage, no monthly bills — every service is on its free tier.

## Commands

- **Dev server:** `npm run dev` (Vite)
- **Build:** `npm run build`
- **Test:** `npm test` (plain `node --test tests/*.test.mjs` — no framework, no jsdom/vitest by
  convention; see "Testing philosophy" below)
- **Preview build:** `npm run preview`

## Architecture

### Directory map

| Path | Role |
|---|---|
| `src/App.jsx` | Chat UI — token streaming, model/provider badge, usage tracking |
| `src/Jobs.jsx` | Job search tab: multi-source search, Target Profile, résumé/tracker per-person, company-lookup UI, extension sync/apply handoff |
| `src/Garden.jsx` | Farming game (40 plant species, coins, harvestable plots) |
| `src/Code.jsx` | In-browser code runner (Pyodide) |
| `src/Attic.jsx` | Document/artifact history |
| `src/SharedChat.jsx` | Read-only shared conversation view |
| `src/lib/aliciaBridge.js` | `window.postMessage` bridge to the Alicia Chrome extension — `sendApply`, `sendSync`/`buildSyncPayload`, `onFillStatus` |
| `src/lib/jobsStore.js` | Per-person localStorage + Supabase sync for résumés/tracker/target profile (`jobs.<person>.*` keys) |
| `src/lib/ghostJob.js` | Advisory-only stale/generic-posting heuristics for job cards |
| `src/lib/supabase.js` | Supabase client + sync helpers shared across chat/garden/jobs |
| `api/jobs.js` | Multi-source job search aggregator: Adzuna, JSearch, bluedoor, Jooble/Careerjet/USAJobs, ATS_FETCHERS (Greenhouse/Lever/Workday/iCIMS/Taleo/etc.), custom-career-page scraping (`fetchCustomCareerPage` — structured data first, AI-extraction fallback, retried + cached) |
| `api/company-lookup.js` | "Look up one company" feature: seed → ATS registry → search → scrape resolution ladder |
| `api/jobs-crawl.js` / `api/jobs-import.js` | Scheduled crons (see `vercel.json`) that keep the ATS board registry fresh |
| `api/chat.js` | Chat completion routing (Ollama Cloud → NVIDIA NIM fallback), streaming, rate-limit/quota surfacing |
| `supabase-*.sql` | Schema files for each Supabase table this app uses — apply manually via the Supabase dashboard/MCP, no migration runner |

### Two-person Jobs data model

Jobs tab data (résumés, tracker, target profile) is scoped **per person** (`jobs.<person>.*` in
localStorage; a `job_data` Supabase table row per person) so two people sharing this app (e.g.
Jordon + his wife) don't clobber each other's job search. `activeResume(resumes)` returns the
active/most-recent résumé for whichever person is currently selected, or `null` if they have none.

### Extension handoff (`src/lib/aliciaBridge.js` ↔ Alicia extension's `bridge.js`)

- `sendApply(jobs)` — hands a batch (≤10) to the extension; **the extension opens each tab itself**
  (a real user gesture from its privileged background context, not popup-blocked) and binds the fill
  session to the tab it creates. This app must never `window.open()` those jobs itself when the
  extension is present — that would double-open tabs.
- `sendSync(buildSyncPayload(activeForSync, profile))` — pushes the active résumé + contact profile
  into the extension so autofill always uses what this app has (one source of truth). **Critical
  invariant:** this must fire on every person-switch, even when the newly-selected person has no
  active résumé — `buildSyncPayload` then sends cleared résumé fields but *always* the current
  person's `profile`. Regressing this to an early-return (skip pushing when there's no résumé) is a
  real wrong-person-autofill bug that shipped once and was fixed — see `tests/aliciaSyncPayload.test.mjs`
  and the git history around `buildSyncPayload`. Don't reintroduce that guard.
- `onFillStatus(cb)` — subscribes to live fill-status events the extension forwards back, for the
  tracker to reflect real state (not just "we sent the apply request").

### `fetchCustomCareerPage` reliability (api/jobs.js)

The scrape tier (schema.org structured data first, Groq-LLM extraction fallback) is wrapped in
`fetchWithRetry` (retries ONLY a thrown error or 429/5xx — never a genuine parsed-empty result) and
the existing `cached()` in-memory TTL cache (10min, cap 200, **never caches an empty/failed result**
— only real non-empty hits). Keyed on `url + name` because `name` changes
`finalizeCustomJobCandidates`'s filtering (targeted lookups pass `name: ''`; discovery passes the
real employer name to reject postings for OTHER companies at the same board).

## Testing philosophy

Plain `node --test`, zero test framework/dependencies — matches the rest of this project's
"no build step beyond Vite, no unnecessary tooling" ethos. When a bug is in React state/effects
(e.g. the Jobs.jsx sync effect), prefer extracting the actual logic into a pure, importable function
(see `buildSyncPayload` in `aliciaBridge.js`) and unit-testing *that*, rather than reaching for
jsdom/@testing-library for one test. Add those only if testing needs grow enough to justify it.

## Safety principles (worth restating, not just implied by the rule above)

- Never push to `main` without explicit confirmation — it's a live production deploy, not a
  reversible local action.
- Never hardcode or expose secrets/API keys (Supabase keys, Groq/NVIDIA/Ollama keys, RapidAPI keys)
  — all via `process.env`.
- The company-lookup/job-search scrape paths must never become an open SSRF surface — see the
  Adzuna redirect-resolution comments in `api/jobs.js` for the private-IP-rejection pattern already
  in place; follow it for any new URL-following logic.
