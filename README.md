# Wagner-GPT — Free AI Chat PWA

A mobile-first Progressive Web App for free AI chat. All models route through the **NVIDIA NIM** API.

## Features

- 📱 **Mobile-first PWA** — Add to home screen, works like an app
- 🔄 **Model switching** — Toggle between three NIM-hosted models
- 📚 **Chat history** — Saved locally in browser
- 🌙 **Dark mode** — Eye-friendly night theme
- ⚡ **Free tier** — NVIDIA NIM, no paid API

> **Note on images:** the upload UI is present but the NIM models used here are text-only. Image data is silently stripped server-side before the request. Vision is not currently supported.

## Models

The dropdown exposes three options, all served by NVIDIA NIM:

| Dropdown value | NIM model ID                      |
|----------------|-----------------------------------|
| `m3`           | `minimaxai/minimax-m3`            |
| `deepseek`     | `deepseek-ai/deepseek-v4-flash`  |
| `qwen`         | `deepseek-ai/deepseek-v4-pro`    |

> The `qwen` label is historical — it currently maps to DeepSeek v4 Pro, not a Qwen model.

## Deploy to Vercel (5 minutes)

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-github-url>
git push -u origin main
```

### 2. Import the repo on Vercel

- Visit [vercel.com/new](https://vercel.com/new)
- Select "Import Git Repository"
- Choose your repo and click "Import"

### 3. Add environment variable

- **NVIDIA_NIM_KEY**: Your NVIDIA NIM API key from [build.nvidia.com](https://build.nvidia.com)
  - Format: `nvapi-...` (starts with `nvapi-`)

This is the only env var the app reads.

### 4. Deploy

Click "Deploy" — Vercel builds and deploys automatically. Live in ~2 minutes.

## Local Development

```bash
npm install
npm run dev
```

Visit `http://localhost:5173`

## How It Works

1. **Frontend** (React + Vite + Tailwind)
   - Chat UI with model selector
   - Dark mode + local chat history

2. **Backend** (Vercel serverless function at `/api/chat.js`)
   - Receives messages + selected model
   - Routes the request to the matching NIM model
   - Returns the response to the frontend

3. **Free tier limits**
   - NVIDIA NIM: ~40 requests/minute on the free tier
   - Free tier is for prototyping; production would need a paid tier or self-hosted inference

## Troubleshooting

**"API key not configured"**
- Go to Vercel dashboard → Settings → Environment Variables
- Confirm `NVIDIA_NIM_KEY` is set to a real `nvapi-` key (not a placeholder)
- Redeploy (or wait for auto-redeploy after the env change)

**Rate limit errors (429)**
- You've hit the NIM RPM limit
- Wait ~60 seconds and retry
- Load is shared across all users of the deployment

**PWA doesn't install**
- On iOS: Safari → Share → Add to Home Screen
- On Android: Chrome menu → Install app
- Must be served over HTTPS (Vercel does this automatically)

## What's Included

```
wife-gpt/
├── src/
│   ├── App.jsx           (Chat UI component)
│   ├── main.jsx          (React entry)
│   └── index.css         (Tailwind base)
├── api/
│   └── chat.js           (Vercel serverless function)
├── public/
│   ├── sw.js             (Service worker for PWA)
│   └── manifest.json     (PWA metadata)
├── index.html            (HTML shell)
├── vite.config.js        (Vite config)
├── tailwind.config.js    (Tailwind config)
├── postcss.config.js     (PostCSS config)
├── vercel.json           (Vercel config)
└── package.json          (Dependencies)
```

## API Docs

**NVIDIA NIM:**
- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions`
- Models: `minimaxai/minimax-m3`, `deepseek-ai/deepseek-v4-flash`, `deepseek-ai/deepseek-v4-pro`
- Supports: text only
- Rate limit: ~40 req/min (free tier)
- Cost: Free tier (no per-token billing)

## License

MIT
