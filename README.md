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
| Image gen | NVIDIA NIM FLUX.1-dev + HuggingFace FLUX.1-schnell (fallback) | Free tier / free forever |
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
- **Markdown rendering** — AI replies display with formatted headings, bold, italic, lists, and code.
- **Dark mode** — global toggle, persisted.

- **Web search** — toggle the globe in the input bar; current results (via Tavily) are injected into the answer with clickable source citations.
- **Voice input** — tap the mic to dictate (Web Speech API; Chrome/Edge/Safari incl. iOS).

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
- **Two providers** — NVIDIA NIM FLUX.1-dev (faster, higher quality) with HuggingFace FLUX.1-schnell as automatic fallback when NIM credits run out.
- **Inline** — generated images appear directly in the chat bubble.

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

## Persistence

- **localStorage** — fast local cache for everything (chat, garden, settings).
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
  |   | {"done":true}              '-- Image tool call:
  |   '----------------------------     |--1--> NIM FLUX.1-dev
  |                                     '--2--> HuggingFace FLUX.1-schnell
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
| `TAVILY_KEY` | Optional | Web search (free 1000/mo at tavily.com). Without it, the web-search toggle gracefully no-ops. |

Supabase credentials are embedded in the frontend bundle (publishable anon key — this is standard Supabase practice, same as Stripe's publishable key).

## Deploy

1. Push to GitHub: `git push origin main`
2. Import at [vercel.com/new](https://vercel.com/new)
3. Add environment variables (see table above)
4. Run `supabase-schema.sql` in the Supabase SQL Editor to create tables
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

**Image generation fails:** NIM credits depleted. The HuggingFace fallback should catch this automatically. If both fail, request more NIM credits (free) at the [NVIDIA developer forum](https://forums.developer.nvidia.com).

**Garden plants not growing:** Close and reopen the tab. Growth is timestamp-based and catches up on reload.

**Chat history lost after clearing browser data:** With Supabase configured, reopen the app and conversations reload from the cloud automatically.

## License

MIT
