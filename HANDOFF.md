# Wagner-GPT — Engineering Handoff (2026-06-29)

A complete, current handoff for continuing development. Wagner-GPT is a **100% free,
serverless, $0/month** AI assistant PWA built for Alicia. Everything runs on free tiers;
the design rule is **never introduce a paid or persistent-server dependency**.

## Update 2026-07-08 (latest) — Adzuna follow-up: honest direct-by-host + never-empty list

Live test of the prior change showed "Direct apply only" (defaulted ON) hid ALL 55 results because the
Vercel-side resolver resolved 0 of 50 Adzuna rows (datacenter IP blocked, as predicted) and JSearch's 7
were flagged non-direct. Fixes:
- `api/jobs.js`: after the resolve pass, recompute `direct` for EVERY row by its final host
  (`isEmployerHost`) — honest regardless of a source's self-reported flag (a JSearch link to an ATS now
  counts as direct; resolved Adzuna rows do; links to adzuna/linkedin/indeed don't).
- `src/Jobs.jsx`: "Direct apply only" defaults OFF again (never a surprising empty list); when ON it
  filters to direct but FALLS BACK to showing all with an orange note if a search yields zero direct
  results. The residential-IP resolution now lives in the extension (v1.12.4) — Vercel can't do it.

## Update 2026-07-08 — Skip Adzuna's login wall: employer-URL resolution + direct-apply default

Adzuna's `redirect_url` now login-walls logged-out users (`adzuna.com/details/…?apply=1&after_login`
→ a Facebook/Google/email modal), so Apply never reached the employer. Fixed in `api/jobs.js` +
`src/Jobs.jsx`. Approach chosen after an ultracode workflow (understand → design → adversarial
stress-test); the adversary killed the first-pass plan's `/api/resolve` endpoint (SSRF/open-proxy)
and its client-synthesized `/land/ad` URLs (tokenless → 403 / infinite `/authenticate` loop). Shipped
the safe subset:

- **`api/jobs.js` — bounded, safe employer-URL resolution.** For the SHOWN Adzuna rows only (all-direct
  searches pay nothing), a capped worker pool (6) with a hard 7s deadline follows the redirect chain
  (Location headers only, no HTML scraping) via `resolveAdzunaUrl`; it accepts a target ONLY when it
  lands on a host that is neither Adzuna nor any other aggregator (expanded `AGGREGATOR_HOST_RE`), and
  rejects private-IP literals on every hop and Adzuna login/authenticate walls. A resolved row becomes
  a direct-apply row (`resolved:true`, `direct:true`), keeping its Adzuna link as `adzunaUrl` fallback.
  NOT a public endpoint — no `?url=` SSRF surface; only ever runs on redirect_urls from the Adzuna API.
  Verified by a mocked-fetch test (resolves adzuna→greenhouse, follows through jobgether→lever, returns
  null on login wall / private IP / terminal-on-adzuna).
- **`src/Jobs.jsx` — "Direct apply only" defaults ON.** Aggregator rows are hidden unless the user opts
  back in; the honest label is now "via Adzuna · may need login". Apply stays a SYNCHRONOUS
  `window.open(job.url)` (job.url is already the employer URL for resolved rows) — no async-at-click, so
  no pop-up-block or blank-tab-hang risk (both flagged by the adversary).
- **Extension v1.12.3:** `skipAggregatorInterstitial` bails on an Adzuna login wall instead of clicking
  into the modal.

Prior context: the abandoned commit 9eb1452 built a heavier resolver (redirect-follow + HTML scrape)
that was removed for "direct sources + demote Adzuna"; this reinstates only the safe, bounded core.

## Update 2026-07-08 — Deep-dive fixes: jobs pipeline, core chat perf/correctness, extension handoff v2

Full-codebase review (3 parallel reviewers) → fixes across the stack. Highlights:

**Jobs backend (`api/jobs.js`):** `ATS_HOST_RE` was referenced but undefined (ReferenceError swallowed
by the catch → the whole JSearch direct-link source silently dead; regex now copied in). Cross-source
dedupe now also keys `company|title|city` (Greenhouse vs Adzuna URLs never matched, so "direct wins
over Adzuna" never actually happened). `salaryMin`/`fullTime` now filter the direct sources too (they
were Adzuna-only, so the top-ranked results ignored the salary floor). New 10-min warm-lambda TTL
cache for board/Himalayas/discovery fetches. Within-rank newest-first ordering; `page` passthrough
for Load more. Mocked-logic test: scratchpad `test-jobs-api.mjs` (run against a stubbed fetch).

**Jobs UI (`src/Jobs.jsx` + libs):** backendChat no longer swallows `{error}` NDJSON events (a failed
tailor could save an EMPTY résumé and hand it to the extension — also now guarded by a min-length
check). `jobsStore` only bumps `updatedAt` when data actually changed (page-load used to mark the
local snapshot newest and could clobber newer cloud data). quickTailor secondary material = base
résumés only, capped at 2 (the prompt previously grew with every tailored résumé ever saved).
lexicalRank scores job-vocabulary coverage (long résumés pinned everything at 95). 4 unreachable
industries added. Views stay mounted (tab-peek no longer discards results). UX: posting-age chip +
newest-first sort, Load more, "applied ✓" badge, tracker (date/résumé-used link/status filters/CSV),
print-to-PDF résumé export, full deep-rewrite Q&A transcript.

**Core app (`src/App.jsx` + libs/api):** streams are pinned to the conversation they started in
(switching chats mid-stream used to misdeliver the reply). Local persistence debounced 400ms +
flushed on hide (was a full JSON.stringify of ALL conversations per streamed token). renderMarkdown
memoized (settled messages no longer re-parse per token). suggest/memory-extract fire only on a
loading→done transition (sidebar navigation used to re-fire both AI calls). Lazy-loaded tabs
(~95 kB off the first chunk). Deep-research Stop works; smart auto-scroll (no hijack while reading);
composer stays typeable while streaming; ErrorBoundary with reset-local-data; `?tab=` deep link;
javascript: URLs stripped in markdown/export; cache TTL+LRU eviction; `gptoss:120b` typo (code-locate
silently fell back to NIM every call); github.js preserves real status (Code tab 409 handling works
now). NOT done (declined for now): shared-secret auth on github/code endpoints, CORS allowlist,
Supabase auth — flagged as a real exposure; revisit anytime.

**Extension handoff v2 (see Job-Assistant repo v1.12.0):** tailored résumé actually delivered to
autofill (was silently discarded), redirect-proof tab adoption, live fill-status forwarded back into
the Jobs tracker (`onFillStatus` → `t.fillStatus` chip), web→ext sync of the active résumé/profile
(`sendSync`, fires on résumé change when the extension is present).

## Update 2026-07-06 — `api/jobs.js`: Adzuna proxy for the Job-Assistant extension

`api/jobs.js` backs the **Job-Assistant** (Alicia AI) Chrome extension's Job Search feature — that
extension is the personal tool and uses THIS (wagner-gpt) backend for jobs, so keep this endpoint. It
proxies the **Adzuna** free jobs API (`POST {action:'search'|'categories', …}`) so no key ships in the
extension. **Requires env vars `ADZUNA_APP_ID` + `ADZUNA_APP_KEY`** (free from developer.adzuna.com —
already set on the Vercel project; verified working). Same reflect-origin CORS as `chat.js`; Vercel
auto-detects it. Returns a "not configured" 500 (presence-only diagnostic) if the vars go missing.

- **Repo:** https://github.com/jordan23wagner-ops/Wagner-GPT
- **Live:** https://wagner-gpt.vercel.app (auto-deploys on push to `main`)
- **Local:** `C:\Users\Jordon\Wagner-GPT\wife-gpt`
- **Vercel project:** `wagner-gpt` (a duplicate `wagner-gpt-9vwi` was deleted — there is now exactly ONE project; keep it that way)

---

## Stack

- **Frontend:** React 18 + Vite + Tailwind, installable PWA (service worker in `public/sw.js`)
- **Backend:** Vercel serverless functions only (`api/*.js`) — no server, no Docker, no container
- **Chat models (free):** Ollama Cloud primary, NVIDIA NIM fallback
- **Image gen:** NVIDIA NIM FLUX.1-dev → HuggingFace FLUX.1-schnell fallback
- **Web search:** Tavily (free 1000/mo)
- **Storage:** Browser `localStorage` (fast cache) + Supabase Postgres/pgvector (durable sync, memory, shares)
- **Embeddings:** `all-MiniLM-L6-v2` (384-dim) via **transformers.js in the browser** (no key, lazy-loaded)

## Environment variables (Vercel → `wagner-gpt` project → Production)

| Var | Purpose |
|---|---|
| `OLLAMA_CLOUD_KEY` | Primary chat |
| `NVIDIA_NIM_KEY` | Chat fallback + image generation |
| `HUGGINGFACE_KEY` | Image-gen fallback |
| `TAVILY_KEY` | Web search |

**GOTCHA — Supabase creds are HARDCODED, not env vars.** Vercel does **not** expose
`VITE_`-prefixed vars to the Vite build, so `src/lib/supabase.js` hardcodes the Supabase
URL + publishable anon key (this is safe — anon key is public by design; security is via
RLS). Do not try to move these to env vars.

## Supabase migrations (ALL RUN — schema files in repo root)

| File | Creates | Status |
|---|---|---|
| `supabase-schema.sql` | `conversations`, `garden_state` | ✅ run |
| `supabase-memory-schema.sql` | `memories` (+`match_memories` RPC), `user_settings` | ✅ run |
| `supabase-share-schema.sql` | `shared_chats` | ✅ run (Phase 7 table ready) |

All tables use permissive RLS (`allow_all_*`) — correct for a single-user app with a
public anon key. The `match_memories(query_embedding vector(384), match_count int)` RPC
returns nearest memories by cosine distance.

---

## Models & auto-routing (`api/chat.js`)

`MODEL_MAP` (Ollama tag → NIM fallback):
- `m3` → `minimax-m3` / `minimaxai/minimax-m3` (vision)
- `gemma` → `gemma4:31b` / `meta/llama-3.3-70b-instruct` (vision + drives image gen)
- `gptoss` → `gpt-oss:120b` / `meta/llama-3.3-70b-instruct` (smart generalist, ~2s)
- `qwen` → `qwen3-coder:480b` / `meta/llama-3.3-70b-instruct` (coding)

**Auto routing** (default): `classifyQuery()` → coding prompts to `qwen`, everything else
to `gptoss`; vision uploads or image-gen requests force `gemma`. `isImageRequest()` regex
detects "draw/paint/generate a picture" intent.

**Verified-bad tags (don't re-add):** `glm-5`, `deepseek-v3.1:671b` don't resolve on the
free tier (fall back to NIM, slow). `gpt-oss:120b` is the smart pick.

**Streaming protocol** (NDJSON, server→client): `{"delta":"…"}`, `{"image":"<b64>",…}`,
`{"done":true,"provider":"…","model":"…"}`, `{"error":"…"}`. Provider fallback only works
*before* the first token is flushed.

---

## Features shipped (all live & verified)

### Chat
- Streaming, auto-routing, Ollama→NIM fallback, retry-on-error
- 5 models (Auto default), **response-style** selector (Balanced / Quick / Info-only / Code → system prompt in `STYLE_PROMPTS`)
- Multi-conversation history sidebar, **conversation search**, response cache, in-flight dedupe, daily usage monitor
- Vision (photo upload), AI image gen via `generate_image` tool

### Memory + personalization (Phase 2 — your `mcp-memory-server` design)
- **Semantic memory:** transformers.js embeds (`all-MiniLM-L6-v2`), Supabase pgvector stores. Faithful port of `store.py`: dedup at cosine distance ≤ `0.05` (update in place), retrieval reranks fetched `top_k*3` candidates by `(1 - distance) - 0.01 * age_days`. See `src/lib/memory.js`, `src/lib/embed.js`.
- **Auto-capture:** `api/memory-extract.js` pulls durable user facts after each reply.
- **Manual:** "remember that …" stores explicitly; Settings panel adds/lists/deletes.
- **Custom instructions + About you:** injected as system messages every turn (works without memory migration). Settings ⚙️ button in header.
- Retrieval is time-boxed to 2.5s so the first message stays snappy while the model downloads (~25MB, cached after).

### Rendering & UX pack (Phase 1)
- Markdown: headings, bold/italic, lists, links, **tables**, fenced **code blocks**
- **Syntax highlighting** (highlight.js, dark theme) + **math** (KaTeX) — both lazy-loaded, applied post-stream in `src/lib/enhanceMessages.js`
- **Stop generation** (AbortController), **copy**, **regenerate**, **edit & resend**
- **Follow-up suggestions** (`api/suggest.js`) — tappable chips
- **5 themes** via CSS variables (Light, Dark, Matte Yellow, Ocean, Rose) — `src/lib/themes.js` + `:root[data-theme]` in `index.css`. Palette button in header.

### Documents
- **Input:** upload PDF / Word(.docx) / CSV / text — parsed in-browser (lazy `pdfjs-dist`, `mammoth`, `papaparse` in `src/lib/parseDocument.js`), capped 15k chars, injected as system context. Persists across follow-ups.
- **Export:** per-reply + whole-chat to **Word** (.doc blob) and **PDF** (print window) — `src/lib/exportChat.js`, markdown→HTML incl. tables/code.

### Web search & voice
- **Web search:** Tavily toggle; results injected + clickable **Sources** appended. `runWebSearch`/`buildSearchSystem`/`sourcesMarkdown` in `api/chat.js`. Never cached.
- **Voice input:** Web Speech API mic. **Voice output:** "Listen" button (SpeechSynthesis, markdown stripped).

### Garden game (economy)
- Coins, 40 real species (Flowers/Plants consumed, Bushes/Trees perennial), 4×4 stacked plots (buy up to 9), harvest. All data tables in `src/gardenReducer.js`. State `version: 2`; legacy resets. No fail states.

### Sync
- `src/lib/sync.js`: local-first — localStorage is the fast cache, Supabase syncs conversations + garden in the background (last-write-wins). Works fully offline.

---

## File map

```
api/
  chat.js            # main chat: routing, streaming, tools (image), web search,
                     #   persona+memory+style injection, document injection
  suggest.js         # follow-up question suggestions (non-streaming)
  memory-extract.js  # auto-memory fact extraction (non-streaming)
src/
  App.jsx            # everything UI (large — most features live here)
  Garden.jsx, gardenReducer.js
  lib/
    conversations.js # multi-conversation history + localStorage + migration
    cache.js         # response cache + image-intent check
    usage.js         # daily usage counters
    exportChat.js    # Word/PDF export + markdown→HTML (tables/code)
    renderMarkdown.js# markdown→HTML for chat bubbles (tables, code, links)
    enhanceMessages.js# lazy highlight.js + KaTeX, applied post-stream
    themes.js        # 5 theme registry
    parseDocument.js # lazy PDF/docx/csv/text extraction
    supabase.js      # hardcoded client
    sync.js          # local-first conversation/garden sync
    embed.js         # transformers.js all-MiniLM-L6-v2 (384-dim) in-browser
    memory.js        # pgvector memory store/retrieve/dedup/rerank + settings
index.css            # Tailwind + theme CSS variables
public/sw.js         # network-first pages, cache-first assets
supabase-schema.sql, supabase-memory-schema.sql, supabase-share-schema.sql
```

---

## How to develop / verify (IMPORTANT for continuity)

1. **Build:** `npm run build` (from `C:\Users\Jordon\Wagner-GPT\wife-gpt`). Always build before deploying.
2. **Browser verify:** use the `Claude_Preview` MCP. Config lives at
   `C:\Users\Jordon\.claude\.claude\launch.json` with a `wagner-gpt-prod` entry running
   `npm --prefix C:/Users/Jordon/Wagner-GPT/wife-gpt run preview -- --port 4188 --strictPort`.
   Start it, then drive with `preview_eval` (DOM checks) — `preview_screenshot` sometimes
   times out in headless (not a bug; fall back to eval).
3. **GOTCHA — stale node servers:** old `npm run dev`/`preview` processes from prior
   sessions poison the headless browser (duplicate React → "Invalid hook call", or serving
   old code). If verification shows stale/blank output, `Get-Process node | Stop-Process
   -Force` and restart on a clean strict port. Always verify against `vite preview` (the
   built `dist`), not a stray dev server.
4. **`vite preview` does NOT serve `/api/*`** (those are Vercel functions). This is the key
   verification gap: any change touching `/api/chat`, `/api/suggest`, etc. can't be exercised
   end-to-end in local preview. Two ways to close it — use one before shipping backend work:
   - **Vercel preview deployments (preferred, zero production risk):** push the feature branch
     (`git push origin feat-…`) → Vercel auto-builds a throwaway preview URL with the real
     `/api` functions running. Verify the full stack there, THEN fast-forward `main`. This is
     how backend phases (5 Deep Research, 6 Voice loop) should be verified — never ship `/api`
     changes to production unverified just because local preview can't reach them.
   - **`vercel dev` locally:** runs the `api/*.js` functions on localhost so the browser-eval
     loop works full-stack. Needs keys locally: `vercel link` once, then `vercel env pull`.
   - For frontend-only work that happens to call `/api`, you can also stub the fetch with
     canned NDJSON to verify the UI/state machine in plain `vite preview`, then confirm the
     real call on a preview deploy.
5. **Deploy:** commit + `git push origin main` → Vercel auto-deploys (~90s). Poll the live
   bundle hash (`curl -s https://wagner-gpt.vercel.app/ | grep index-…js`) and compare to the
   entry hash in your local `dist/index.html` to confirm. For backend-only changes the bundle
   hash doesn't change — poll the endpoint behavior instead.
6. LF→CRLF git warnings are harmless. End commit messages with the Claude co-author line.

---

## Roadmap — REMAINING work

> **STATUS (2026-06-30):** This roadmap section below is STALE — it predates several shipped
> phases. Source of truth for what's done: git log. As of now, **done & verified & live**:
> Phase 1 (UX), 2 (Memory), **2b (Document RAG)**, **3 (Pyodide code interpreter)**,
> **4 (Artifacts/Canvas — sandboxed iframe)**, 7 (Shareable links) **incl. manage/revoke**.
> **Remaining: Phase 5 (Deep Research), 6 (Voice loop), 8 (Career mode / flagcheck).** All
> three are `/api`-dependent (5, 6) or need the `flagcheck` repo (8), so verify them via a
> **Vercel preview deployment** (see "How to develop / verify" step 4) before merging to main.
> The per-phase notes below are kept for reference but several describe already-shipped work.

Phases 1 (UX pack) and 2 (Memory + Custom Instructions) are **done & verified**. Remaining:

### Phase 2b — Document RAG (no setup) — RECOMMENDED NEXT
Large docs are currently truncated at 15k chars. Upgrade: chunk + embed + retrieve only
relevant chunks. **Use the user's `rag-post-processor` chunker, ported exactly:**
- `chunk_size=1000`, `overlap=100`; if `len(text) <= chunk_size` return `[text]`; else slide
  window, and when not at end find the last `". "` after `0.6*chunk_size` and break there
  (sentence-aware); advance `start = end - overlap`.
- `clean_text`: strip `<[^>]+>`, `&[a-zA-Z]+;`, `https?://\S+`, collapse `\s+`.
- Source: `mcp-memory-server`/`rag-post-processor` repos (clone to inspect `my_actor/src/main.py`).
- Plan: in `parseDocument.js` (or a new `chunk.js`), when a doc exceeds ~6k chars, chunk +
  embed each chunk (reuse `embed.js`), keep chunks in memory keyed to the conversation; on
  each turn embed the query, retrieve top ~4 chunks, inject those instead of full text.
  Small docs keep current behavior.

### Phase 3 — Code Interpreter (Pyodide) (no setup)
Run Python in-browser via **Pyodide** (WASM, free, serverless). Lazy-load from CDN
(`pyodide` npm or `cdn.jsdelivr.net/pyodide`). Flow: model writes Python in a ```python
block → show a "Run" button → execute in Pyodide → display stdout + matplotlib charts
(Pyodide has numpy/pandas/matplotlib). Pairs with CSV upload (already built). Big chunk —
lazy-load only on first run. Capture stdout, render figures as images.

### Phase 4 — Artifacts / Canvas (no setup)
Detect when a reply contains a self-contained HTML doc or a runnable artifact → render it
in a **sandboxed `<iframe sandbox>`** side panel with a code/preview toggle. Good for
calculators, landing pages, charts, interactive widgets.

### Phase 5 — Deep Research (no setup; uses Tavily quota)
A "Deep Research" toggle/mode that runs **multiple** Tavily searches (decompose the
question → 3-5 sub-queries), cleans + chunks results (reuse the Phase 2b chunker), and has
the model synthesize a structured cited report. Mind the 1000/mo Tavily quota.

### Phase 6 — Voice conversation mode (no setup)
Chain the existing STT (Web Speech) → `/api/chat` → TTS (SpeechSynthesis) into a hands-free
loop: listen → send → speak the reply → auto-listen again. A "conversation mode" toggle.

### Phase 7 — Shareable links (TABLE READY — just build)
`shared_chats` table exists. Build: a **Share** button on a conversation → write a snapshot
`{id, title, messages, created_at}` to `shared_chats` with a long random id → copy a link
`wagner-gpt.vercel.app/?s=<id>` to clipboard. On load, if `?s=<id>` present, fetch that row
and render a **read-only** view (no composer, no keys). Snapshot (frozen), not live.
NOTE: strip large base64 images from snapshots if size is a concern.

### Phase 8 — Career mode (flagcheck) (no setup; review repo)
The user's `flagcheck` repo (Chrome extension: analyzes job postings for red flags, ATS
score, salary estimate, résumé match — "Powered by Claude AI"). Port its prompts/logic into
a "Career mode": paste a job posting (+ optionally a résumé via the existing doc upload) →
structured output (red flags, ATS score, match, tailored advice). Clone `flagcheck` to read
its analysis prompts. Runs on our free Ollama models instead of Claude.

---

## The user's GitHub tools (already integrated / to integrate)

- **`mcp-memory-server`** → Phase 2 memory (DONE). Constants ported: `RECENCY_DECAY_WEIGHT=0.01`, `DUPLICATE_DISTANCE_THRESHOLD=0.05`, model `all-MiniLM-L6-v2`, rerank `(1-distance) - 0.01*age_days`, fetch `top_k*3`. Summaries were Groq-based there; we skip per-fact summaries (facts are already short) — the `summary` column exists for future use.
- **`rag-post-processor`** → Phase 2b chunker (params above).
- **`flagcheck`** → Phase 8 career mode.

---

## Design rules (do not violate)
- 100% free, serverless, $0/month. No paid APIs, no persistent server, no Docker, no DB beyond Supabase free tier.
- No new keys/services unless a free option is genuinely insufficient (confirm with the user).
- Mobile-first; verify safe-area insets and narrow widths.
- Verify every change in a browser (Phase 1/2 method above) and confirm live before calling done.
- Keep it to ONE Vercel project and ONE Supabase project.

## Most recent commits (newest first)
- docs: memory + custom instructions in README
- feat: Phase 2 — semantic memory + custom instructions
- feat: UX pack pt.3 — follow-up suggestions
- feat: UX pack pt.2 — code syntax highlighting + math
- feat: UX pack pt.1 — stop, copy, regenerate, edit, search
- feat: themes, markdown tables/code, response-style preference
