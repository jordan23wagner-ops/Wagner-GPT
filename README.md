# Wagner-GPT

A **100% free** AI assistant PWA with chat, document creation, image generation, and a garden farming game. Mobile-first, serverless, zero monthly cost.

**Live:** https://wagner-gpt.vercel.app

## What It Does

- **AI Chat** with live token streaming — responses appear word-by-word as they generate
- **Document creation** — ask the AI to write a resume, to-do list, letter, or any document, then tap **Word** or **PDF** to download it with proper formatting
- **Image generation** — ask "draw a sunset" or "create a picture of a garden" and get a 1024x1024 image inline in chat
- **Photo analysis (vision)** — upload a photo and ask "what's in this?" — the AI describes what it sees
- **Garden game** — a farming economy with 40 real plant species, coins, harvestable plots, and decorations
- **Cloud sync** — chat history and garden state persist across devices via Supabase
- **Works offline** — installable PWA with service worker

## Stack

| Layer | Technology | Cost |
|---|---|---|
| Frontend | React 18 + Vite + Tailwind CSS | Free |
| Backend | Vercel serverless functions | Free (Hobby) |
| Chat AI | Ollama Cloud (primary) + NVIDIA NIM (fallback) | Free tier |
| Image gen | NVIDIA NIM FLUX.1-dev → HuggingFace FLUX.1-schnell → Pollinations.ai (fallbacks) | Free tier / free forever |
| Storage | Browser localStorage (fast) + Supabase Postgres (durable) | Free tier |
| Hosting | Vercel, auto-deploys on push to `main` | Free (Hobby) |

No Docker. No database server. No monthly bills.

## Chat

- **Auto routing** (default) — classifies each prompt: MiniMax M3 for reasoning/coding/math, Gemma 4 for creative/casual/vision. Manual model override available.
- **Image requests always work** — even if MiniMax M3 is manually selected, image prompts auto-route to Gemma 4, the model that reliably calls the image generation tool.
- **Streaming** — NDJSON protocol delivers tokens incrementally.
- **Provider fallback** — Ollama Cloud primary, NVIDIA NIM fallback (per-model, before first token).
- **Multiple conversations** — slide-in sidebar to create, switch, and delete chats.
- **Response cache** — identical text prompts return instantly without an API call.
- **Request deduplication** — prevents double-sends while in-flight.
- **Usage monitor** — daily chat/image counts with early warning before soft-limits.
- **Markdown rendering** — replies display formatted headings, bold, italic, lists, **tables**, scrollable **code blocks** with **syntax highlighting**, and **math** (KaTeX). All lazy-loaded.
- **Message controls** — stop generation mid-stream, copy any reply, regenerate the last answer, and edit & resend your own messages.
- **Follow-up suggestions** — tappable suggested next questions after each reply.
- **Conversation search** — filter the chat sidebar by title or message content.
- **Memory** — remembers durable facts about you across chats (semantic, via in-browser `all-MiniLM-L6-v2` embeddings + Supabase pgvector). Auto-captures facts, supports "remember that…", and an editable memory list in Settings. Faithful port of the `mcp-memory-server` design (dedup at 0.05 cosine, recency-reranked retrieval).
- **Custom instructions** — set "About you" and "How should I respond" in Settings; injected into every chat.
- **Response style** — a selector (Balanced / Quick answer / Info only / Code) injects a system prompt so replies match your preference — no unwanted code or long-winded walls of text.
- **Themes** — 5 themes via the palette button: Light, Dark, Matte Yellow, Ocean, Rose. Text contrast is tuned per theme. Persisted.

- **Web search** — toggle the globe in the input bar; current results (via Tavily) are injected into the answer with clickable source citations.
- **Voice input** — tap the mic to dictate (Web Speech API; Chrome/Edge/Safari incl. iOS).
- **Voice output (TTS)** — a "Listen" button on each reply reads it aloud via the browser's built-in SpeechSynthesis (free, no key).
- **Document input** — upload a PDF, Word (.docx), CSV, or text file; it's parsed in the browser and the model can summarize, answer about, or rewrite it. Pairs with Word/PDF export for a full "upload résumé → improve it → download" loop. Parsers (pdf.js, mammoth, papaparse) are lazy-loaded so they don't affect startup.

### Models

| Dropdown | Ollama Cloud | NIM Fallback | Vision |
|---|---|---|:---:|
| Auto (default) | code → Qwen3-Coder, general → GPT-OSS, vision/image → Gemma | per-model | Yes |
| MiniMax M3 | `minimax-m3` | `minimaxai/minimax-m3` | Yes |
| Gemma 4 | `gemma4:31b` | `meta/llama-3.3-70b-instruct` | Yes |
| GPT-OSS 120B | `gpt-oss:120b` | `meta/llama-3.3-70b-instruct` | No |
| Qwen3 Coder | `qwen3-coder:480b` | `meta/llama-3.3-70b-instruct` | No |

## Document Export

Every assistant reply has **Word** and **PDF** buttons underneath:

- **Word** — downloads a `.doc` file. On mobile, opens in Word / Google Docs / Pages or saves to Files.
- **PDF** — opens a styled page and auto-triggers the print/save-as-PDF dialog.
- **Whole-chat export** — Word/PDF of the full conversation from the history sidebar.
- Markdown (headings, bold, italic, lists) is converted to proper HTML formatting in both the chat display and exports.

## Image Generation

- **Tool-calling** — the chat model decides when to generate an image by calling a `generate_image` tool. No brittle keyword matching.
- **Three providers, automatic fallback** — NVIDIA NIM FLUX.1-dev (highest quality) → HuggingFace FLUX.1-schnell → **Pollinations.ai** (free, no API key, not behind an aggressive content filter). The last resort means generation keeps working even when NIM filters a benign prompt or runs out of credits. Each provider call is hard-timed-out so a slow one fails over fast instead of stalling.
- **Inline** — generated images appear directly in the chat bubble.
- **Photo-informed generation ("re-imagine my photo")** — attach a photo (or several) and ask to change it ("show this garden in full summer bloom"). The vision model studies the photo(s) and writes a prompt, then a fresh image of that requested future state is generated. This is an *AI re-imagining based on the photo, not a pixel-edit of the original* (labelled as such in the reply) — true pixel-level editing isn't available on a free hosted tier (NVIDIA's hosted FLUX.1 Kontext only accepts its own demo images, not user photos). Triggered automatically when an image is attached and the message reads like an edit; plain questions about a photo stay vision Q&A.
- **Multiple images** — attach up to 4 photos per message (paperclip → multi-select, each removable before sending). Uploads are downscaled in the browser so they stay fast.
- **Robustness** — empty/black-image guards, and NVIDIA's `CONTENT_FILTERED` safety-filter responses are detected and routed to a fallback rather than shown as a black square.

## Coding Mode (Phase 8)

A free, browser-based fallback coding assistant — edit your GitHub repos straight from the app, no local machine and no Claude required. Built for "I ran out of Claude usage, keep going."

- **Password-gated** — the site is public, so Coding Mode is locked behind `CODING_MODE_PASSWORD`. The GitHub token never reaches the browser; it lives only in `GITHUB_TOKEN` and is used server-side by `api/github.js`. The password is held only in `sessionStorage` and checked in constant time.
- **Flow** — unlock → pick any of your repos → browse/open a file → describe the change in plain English → the AI (`qwen3-coder`, NIM `llama-3.3` fallback) rewrites the whole file → **review a before/after diff** → confirm → it commits to the default branch → Vercel redeploys.
- **Safe by default** — nothing is committed until you approve the diff. Stale-write (409) conflicts auto-reload the latest file. Every commit is a normal, revertible git commit.
- **Scope v1** — single-file edits. Multi-file/agentic editing can come later.

Requires two extra Vercel env vars (see the table below): `GITHUB_TOKEN` and `CODING_MODE_PASSWORD`. Until both are set, Coding Mode reports "not configured" and does nothing.

## Garden Game

A farming economy where you grow plants, harvest them for coins, and expand your garden:

- **40 real species** across 4 categories, each a dropdown of 10 tiers (free starter to expensive):
  - **Flowers** (consumed on harvest): Daisy, Marigold, Tulip, Lavender, Sunflower, Hibiscus, Cherry Blossom, Rose, Lotus, Dahlia
  - **Plants** (consumed on harvest): Lettuce, Carrot, Onion, Garlic, Potato, Tomato, Pepper, Corn, Eggplant, Pumpkin
  - **Bushes** (perennial — regrow after harvest): Boxwood, Holly, Blueberry, Raspberry, Currant, Gooseberry, Hydrangea, Azalea, Rosemary, Blackberry
  - **Trees** (perennial — regrow after harvest): Maple, Almond, Olive, Fig, Pear, Apple, Peach, Cherry, Orange, Lemon
- **Stacked 4x4 plots** — start with one, buy up to 9 more for rising prices (150 to 16,000 coins).
- **No fail states** — plants never wither. Growth is timestamp-based and advances while the app is closed.
- **6 free decorations** — Fence, Bench, Fountain, Lantern, Pot, Stepping Stone.

## Jobs

A job-search + application workspace, ported from the *Alicia AI* Chrome extension so it can be
managed here in one web app (the extension stays only for on-page application autofill, which needs
browser-extension powers a web page can't have). Three sub-tabs:

- **Search** — pulls jobs from sources that give a **direct employer/ATS apply link** wherever
  possible (so Apply opens the real posting, not an aggregator page). The `/api/jobs` function fans
  out to, in preference order:
  - Company **ATS boards** (Greenhouse / Lever / Ashby / Workable public JSON) from the
    `INDUSTRY_BOARDS` map — the companies' own career pages (direct).
  - **JSearch** (Google-for-Jobs, `JSEARCH_KEY`) — breadth with direct links, picking the
    `apply_options` entry where `is_direct` is true (direct).
  - **Himalayas** (no key) — remote roles with a direct `applicationLink` (direct).
  - **Adzuna** (`ADZUNA_APP_ID/KEY`) — broad listings, but its links open Adzuna's own landing page,
    so it's ranked **last** and labeled **"via Adzuna"** in the UI. (Adzuna does not expose the
    employer URL — confirmed — so it can't be de-aggregated server-side.)
  - Optional **discovery** via Brave/Tavily to find more ATS boards for the query, plus genuinely
    custom company career pages (no known ATS) parsed via schema.org/JobPosting structured data first,
    Jina+Groq AI extraction as a fallback.
  - **USAJobs** (`USAJOBS_API_KEY` + `USAJOBS_EMAIL`, US federal jobs, direct — only called for
    `country: 'us'`) plus three more aggregators (ranked with Adzuna, not as direct-apply): **The Muse**
    (no key), **Jooble** (`JOOBLE_KEY`), **Careerjet** (`CAREERJET_AFFID`). **Reed** (`REED_API_KEY`,
    UK jobs, only called for `country: 'gb'`) is also available. All four are free to sign up for and
    silently no-op if their env var isn't set — none are required for the rest of the Jobs tab to work.
  - **Crawl cache** (optional): searches read pre-crawled ATS-board results from a Supabase table
    (`job_crawl_cache`) instead of live-fetching every company's board on every request, when that
    table has data for the requested industry. `api/jobs-crawl.js`, triggered by Vercel Cron (see
    `vercel.json`), re-crawls every `INDUSTRY_BOARDS` industry once a day and upserts the results.
    Run `supabase-job-crawl-schema.sql` to enable it — without it, the Jobs tab works exactly as
    before (falls back to live-fetching), just without the speed-up. See the env var table below.
  Results are merged, deduped (direct link wins over the same job's Adzuna link), filtered by
  title/location/remote, and **ranked by résumé fit** with **Fortune 500 first** and **direct-apply
  before via-Adzuna**. Cards show **✓ direct apply** / **via Adzuna**, **★ Fortune 500**, and
  **⚠ recent layoffs** badges.
  - **Extend coverage** by adding `{ ats, slug, name }` rows to `INDUSTRY_BOARDS` — no other change.
- **Résumés** — upload PDF/DOCX/TXT (parsed locally by `src/lib/resumeParse.js`, zero deps) or paste
  text; keep a bank of résumés and mark one **active** (that's what fit-ranking uses).
- **Tracker** — save jobs from Search and track status (saved → applied → interview → offer/rejected)
  with notes.
- **Memory** — skills/facts Alicia has learned about you. Used when tailoring; she never claims
  anything that isn't here or in your résumé.

**Prep & Apply (targeted, 1–5 at a time).** Check the jobs you want on the results, then:
- **Quick tailor & apply** — tailors a résumé to each job from your existing résumés + memory (no
  invention), scores the fit, and saves each tailored résumé to the bank.
- **Deep rewrite & apply** — Alicia interviews you once to fill gaps across the batch, asks you to
  **confirm any new skills into Memory**, rewrites per job, **re-scores, and auto-skips weak fits**
  (below 50) so effort goes to strong matches.
- **Apply** hands the batch to the Alicia browser extension (detected via `src/lib/aliciaBridge.js`),
  which opens each posting and auto-fills — stopping before the final Submit (a human always submits).
  Without the extension it falls back to opening the postings and marking them "applied" in the Tracker.

Storage is local-first (`src/lib/jobsStore.js`); optional cloud sync activates once you run
`supabase-jobs-schema.sql`. No new npm dependencies or API keys were added — every provider key is one
the backend already uses. AI helpers live in `src/lib/jobsAI.js`.

## Persistence

- **localStorage** — fast local cache for everything (chat, garden, settings, jobs).
- **Supabase cloud sync** — conversations and garden state sync to Postgres in the background. Open the app on a new device or browser and everything loads from the cloud.
- **Local-first** — works fully offline; Supabase syncs when available.

## Architecture

```
Browser (React PWA)
  |
  |-- Chat --POST /api/chat--> Vercel serverless (api/chat.js)
  |   ^                            |
  |   | NDJSON stream              |--1--> Ollama Cloud (free, primary)
  |   | {"delta":"..."}            |--2--> NVIDIA NIM   (fallback)
  |   | {"image":"<b64>"}          |
  |   | {"done":true}              '-- Image generation:
  |   '----------------------------     |--1--> NIM FLUX.1-dev
  |                                     |--2--> HuggingFace FLUX.1-schnell
  |                                     '--3--> Pollinations.ai (no key)
  |-- localStorage (fast cache)
  |
  '-- Supabase Postgres (cloud sync)
```

**Streaming protocol (NDJSON, server to client):**

| Event | Meaning |
|---|---|
| `{"delta":"text"}` | Token chunk (zero or more) |
| `{"image":"<base64>","mediaType":"image/jpeg","prompt":"..."}` | AI-generated image |
| `{"done":true,"provider":"ollama","model":"gemma"}` | Terminal success |
| `{"error":"message"}` | Terminal failure (only if nothing streamed yet) |

## File Structure

```
wife-gpt/
├── src/
│   ├── App.jsx                 # Chat UI, tabs, sidebar, model selector, usage
│   ├── Garden.jsx              # Garden tab: plots, seed shop, harvesting
│   ├── gardenReducer.js        # Species catalog, prices, growth, reducer
│   ├── lib/
│   │   ├── conversations.js    # Multi-conversation history + localStorage
│   │   ├── cache.js            # Response cache + image-intent detection
│   │   ├── usage.js            # Daily usage counters + soft limits
│   │   ├── exportChat.js       # Document export: per-reply + whole-chat
│   │   ├── renderMarkdown.js   # Markdown to HTML for chat bubbles
│   │   ├── parseDocument.js    # Client-side PDF/Word/CSV/text extraction (lazy-loaded)
│   │   ├── supabase.js         # Supabase client
│   │   └── sync.js             # Local-first sync (localStorage + Supabase)
│   ├── main.jsx
│   └── index.css
├── api/
│   └── chat.js                 # Serverless: routing, streaming, tool-calling, image gen
├── public/
│   ├── sw.js                   # Service worker (network-first pages, cache-first assets)
│   └── manifest.json
├── supabase-schema.sql         # Database schema (run in Supabase SQL Editor)
├── index.html
├── vite.config.js
├── tailwind.config.js
├── vercel.json                 # maxDuration 60s for chat function
└── package.json
```

## Environment Variables (Vercel)

| Variable | Required | Purpose |
|---|---|---|
| `OLLAMA_CLOUD_KEY` | Yes | Ollama Cloud chat (primary) |
| `NVIDIA_NIM_KEY` | Yes | NIM chat fallback + image generation (FLUX.1-dev) |
| `HUGGINGFACE_KEY` | Recommended | HuggingFace image fallback (free forever, fires when NIM 403s) |
| `TAVILY_KEY` | Optional | Web search (free 1000/mo at tavily.com) + Jobs board discovery. Without it, those features gracefully no-op. |
| `BRAVE_KEY` | Optional | Deep research + Jobs board discovery search. |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | Optional | Jobs tab: Adzuna listings (free tier at developer.adzuna.com). Note: Adzuna links open Adzuna's landing page, not the employer — treated as a fallback source. |
| `JSEARCH_KEY` (or `RAPIDAPI_KEY`) | Optional | Jobs tab: JSearch (Google-for-Jobs, RapidAPI) — the breadth source for **direct** employer/ATS apply links (`apply_options` filtered to `is_direct`). Free tier ~200 req/mo. |
| `GROQ_KEY` | Optional | Jobs tab: AI extraction fallback for custom (non-ATS) company career pages found via discovery. Free tier at console.groq.com. |
| `JOOBLE_KEY` | Optional | Jobs tab: Jooble aggregator. Free, sign up at jooble.org/api/about. |
| `CAREERJET_AFFID` | Optional | Jobs tab: Careerjet aggregator. Free affiliate id at careerjet.com/partners. |
| `REED_API_KEY` | Optional | Jobs tab: Reed aggregator — **UK jobs only**, only called when the Jobs tab's country is set to United Kingdom. Free at reed.co.uk/developers. |
| `USAJOBS_API_KEY` + `USAJOBS_EMAIL` | Optional | Jobs tab: USAJobs (US federal jobs, direct source) — **US jobs only**, only called when country is United States. Both must be set (USAJobs requires the exact registered email as the request's User-Agent). Free at developer.usajobs.gov. |
| `CRON_SECRET` | Recommended | Protects `api/jobs-crawl.js` (the Jobs tab's scheduled ATS-board crawl). Vercel sends this automatically as a bearer token when set. Without it, the crawl endpoint is triggerable by anyone who finds the URL — low-cost abuse (it can't leak data or spend paid-API budget), but still worth setting to any random string. |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Optional | Overrides the Jobs tab crawl cache's Supabase project/key. Defaults to the same project already used by `src/lib/supabase.js` — only set these if you want the crawl cache on a different project. |
| `GITHUB_TOKEN` | Coding Mode | Fine-grained PAT with Contents: read/write. Lets Coding Mode read and commit to your repos. Server-side only. |
| `CODING_MODE_PASSWORD` | Coding Mode | A secret you choose to unlock Coding Mode. Without it (or `GITHUB_TOKEN`), Coding Mode is disabled. |

Supabase credentials are embedded in the frontend bundle (publishable anon key — this is standard Supabase practice, same as Stripe's publishable key).

## Deploy

1. Push to GitHub: `git push origin main`
2. Import at [vercel.com/new](https://vercel.com/new)
3. Add environment variables (see table above)
4. Run `supabase-schema.sql` (chat/garden sync) and `supabase-memory-schema.sql` (memory + settings) in the Supabase SQL Editor
5. Live in ~2 minutes. Auto-deploys on every push to `main`.

## Local Development

```bash
npm install
npm run dev
```

Visit `http://localhost:5173`.

## Troubleshooting

**Blank page after deploy:** Service worker cached an old build. Clear site data in browser settings, or close and reopen the tab 2-3 times (the network-first SW self-heals).

**"All available models failed":** API keys expired or revoked. Regenerate at [ollama.com/settings/keys](https://ollama.com/settings/keys) or [build.nvidia.com](https://build.nvidia.com) and update in Vercel. A redeploy is required after changing env vars.

**Image generation fails / comes back black:** NVIDIA's FLUX safety filter sometimes false-flags benign prompts and returns a `CONTENT_FILTERED` (black) image; NIM credits can also deplete. Both are handled automatically — generation falls back to HuggingFace and then to Pollinations.ai (free, no key), so it should still succeed. If every provider is listed as failed in the error, they're all temporarily down; retry shortly. NIM credits (free) can be topped up at the [NVIDIA developer forum](https://forums.developer.nvidia.com).

**Garden plants not growing:** Close and reopen the tab. Growth is timestamp-based and catches up on reload.

**Chat history lost after clearing browser data:** With Supabase configured, reopen the app and conversations reload from the cloud automatically.

## License

MIT
