# Wagner-GPT — Engineering Handoff (2026-06-29)

A complete, current handoff for continuing development. Wagner-GPT is a **100% free,
serverless, $0/month** AI assistant PWA built for Alicia. Everything runs on free tiers;
the design rule is **never introduce a paid or persistent-server dependency**.

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
