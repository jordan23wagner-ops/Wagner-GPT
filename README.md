# Wagner-GPT — Free AI Chat PWA

A mobile-first Progressive Web App for free AI chat with **live token streaming**, **photo upload (vision)**, and **AI image generation**. Chat models are served by **Ollama Cloud** (primary, free) with **NVIDIA NIM** as an automatic fallback; image generation runs on NIM's **FLUX.1-dev**.

## Features

- 📱 **Mobile-first PWA** — Add to home screen, works like an app
- ⚡ **Streaming responses** — Tokens appear live as the model generates them (no waiting for the full reply)
- 🖼️ **Vision** — Upload a photo and ask about it; both models can analyze images
- 🎨 **Image generation** — Ask the model to "draw" or "create an image of" something; it calls a `generate_image` tool wired to NIM's FLUX.1-dev and returns the picture inline
- 🔄 **Model switching** — Toggle between two vision-capable models
- 🔁 **Provider fallback** — Ollama Cloud first; if it fails before streaming, falls back to NIM
- 📚 **Chat history** — Saved locally in the browser
- 🌙 **Dark mode** — Eye-friendly night theme
- 🆓 **Free tier** — Ollama Cloud, no per-token billing

> **Two kinds of images, don't confuse them:** the chat models are vision *input* models (photo → text) — they read images you upload. *Creating* an image from a prompt is handled separately: the chat model calls the `generate_image` tool, which runs the prompt through NIM's FLUX.1-dev and streams back a JPEG. Image generation requires a `NVIDIA_NIM_KEY` and uses NIM credits (chat stays on free Ollama).

## Models

The dropdown exposes two options. Each tries Ollama Cloud first, then NIM:

| Dropdown value | Ollama Cloud tag | NIM fallback ID          | Vision |
|----------------|------------------|--------------------------|:------:|
| `m3`           | `minimax-m3`     | `minimaxai/minimax-m3`        |   ✅   |
| `gemma`        | `gemma4:31b`     | `meta/llama-3.3-70b-instruct` |   ✅   |

> Ollama Cloud tags must match exactly what `GET https://ollama.com/api/tags` returns
> for the account (no `:cloud` suffix). NIM fallback IDs must be live in the catalog at
> `https://integrate.api.nvidia.com/v1/models` — retired models return `410 Gone`.

> Earlier builds listed DeepSeek V4 Flash/Pro. Those are heavy **reasoning** models that don't emit a first token within Vercel's function timeout, so requests timed out. They were replaced with fast, vision-capable models that stream quickly.

## Architecture

```
Browser (React)  ──POST /api/chat──►  Vercel serverless (api/chat.js)
       ▲                                      │
       │  NDJSON stream                       ├─1─►  Ollama Cloud  (primary, free)
       │  {"delta":"..."}                     │      https://ollama.com/api/chat
       │  {"done":true,"provider":"..."}      │      NDJSON stream: {message:{content}}
       └──────────────────────────────────────┘
                                              └─2─►  NVIDIA NIM    (fallback)
                                                     OpenAI-compatible SSE
                                                     data: {choices[0].delta.content}
```

**Streaming protocol (server → client), newline-delimited JSON:**

- `{"delta":"token text"}` — one or more, as tokens arrive
- `{"image":"<base64 jpeg>","mediaType":"image/jpeg","prompt":"..."}` — an AI-generated image (sent when the model calls `generate_image`)
- `{"done":true,"provider":"ollama"}` — terminal success
- `{"error":"message"}` — terminal failure (only sent if nothing streamed yet)

**Fallback rule:** the function can only switch providers *before* the first token is flushed (HTTP headers commit on first write). Once Ollama starts streaming, NIM is no longer an option for that request.

## Configuration

### Environment variables (Vercel → Settings → Environment Variables)

| Variable           | Required | Purpose                                  |
|--------------------|----------|------------------------------------------|
| `OLLAMA_CLOUD_KEY` | Yes      | Ollama Cloud auth (primary provider)     |
| `NVIDIA_NIM_KEY`   | Optional | NIM fallback; `nvapi-...` from build.nvidia.com |

If only one key is set, only that provider is used.

### `vercel.json`

The chat function needs a longer timeout than the Hobby default (10s) so the first
token has time to arrive:

```json
{
  "functions": {
    "api/chat.js": { "maxDuration": 60 }
  }
}
```

## Deploy to Vercel

1. Push to GitHub.
2. Import the repo at [vercel.com/new](https://vercel.com/new).
3. Add `OLLAMA_CLOUD_KEY` (and optionally `NVIDIA_NIM_KEY`) under Environment Variables.
4. Deploy. Live in ~2 minutes.

## Local Development

```bash
npm install
npm run dev
```

Visit `http://localhost:5173`.

## Verify streaming (curl)

PowerShell — put the body in a file to avoid quoting issues:

```powershell
'{"model":"m3","messages":[],"newMessage":"say hi"}' | Out-File -Encoding ascii body.json
curl.exe -i -N -X POST https://<your-app>.vercel.app/api/chat -H "Content-Type: application/json" -d "@body.json"
```

Expect `{"delta":...}` lines arriving incrementally, then `{"done":true,"provider":"ollama"}`.

## Troubleshooting

**Request hangs, then 504 `FUNCTION_INVOCATION_TIMEOUT`**
- The selected model isn't producing a first token within `maxDuration`. Heavy
  reasoning ("thinking") models do this. Use a fast model, or raise `maxDuration`
  (Hobby max 60s, Pro up to 300s).

**`Unknown model: <x>`**
- The dropdown value in `App.jsx` doesn't match a key in `MODEL_MAP` in `api/chat.js`.
  Keep the two in sync.

**`NIM: 404 page not found` in the error**
- Ollama failed and the NIM fallback ID is wrong/unavailable. Fix the `nim:` ID in
  `MODEL_MAP`, or rely on Ollama only.

**Empty response / nothing streams**
- Confirm the latest commit is the live Vercel production deploy.
- Hard-refresh the browser (`Ctrl+Shift+R`) to clear a cached build.

**Rate limit errors (429)**
- Built-in retry with exponential backoff handles transient 429/5xx. Persistent
  limits: wait ~60s.

## What's Included

```
wife-gpt/
├── src/
│   ├── App.jsx           (Chat UI + streaming reader)
│   ├── main.jsx          (React entry)
│   └── index.css         (Tailwind base)
├── api/
│   └── chat.js           (Serverless fn: streams Ollama/NIM as NDJSON)
├── public/
│   ├── sw.js             (Service worker for PWA)
│   └── manifest.json     (PWA metadata)
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── vercel.json           (maxDuration config)
└── package.json
```

## API Reference

**Ollama Cloud (primary):**
- Endpoint: `https://ollama.com/api/chat`
- Auth: `Authorization: Bearer $OLLAMA_CLOUD_KEY`
- Streaming: `stream: true` → NDJSON, `{message:{content}}` per line
- Vision: images sent as a separate `images: [base64]` array on the message

**NVIDIA NIM (fallback):**
- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions`
- Auth: `Authorization: Bearer $NVIDIA_NIM_KEY`
- OpenAI-compatible; `stream: true` → SSE, `data: {choices[0].delta.content}`
- Text only (images stripped before the request)

## License

MIT
