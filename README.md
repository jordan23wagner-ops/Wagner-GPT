# Wife GPT — Free AI Chat PWA

A mobile-first Progressive Web App for free AI chat using Ollama Cloud (MiniMax M3) and NVIDIA NIM with automatic fallback.

## Features

- 📱 **Mobile-first PWA** — Add to home screen, works like an app
- 🖼️ **Image upload** — Send pictures to M3 (multimodal support)
- 🔄 **Model switching** — Toggle between M3, DeepSeek, Qwen
- 📚 **Chat history** — Saved locally in browser
- 🌙 **Dark mode** — Eye-friendly night theme
- ⚡ **Free tier** — Ollama Cloud + NVIDIA NIM, no paid API

## Deploy to Vercel (5 minutes)

### 1. Clone/fork this repo or push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin <your-github-url>
git push -u origin main
```

### 2. Go to vercel.com and import the GitHub repo

- Visit [vercel.com/new](https://vercel.com/new)
- Select "Import Git Repository"
- Choose your repo
- Click "Import"

### 3. Add environment variables

Vercel will prompt you for env vars. Enter:

- **OLLAMA_CLOUD_KEY**: Your Ollama Cloud API key from [ollama.com](https://ollama.com)
  - Format: `adb948dd...` (alphanumeric string)
- **NVIDIA_NIM_KEY**: Your NVIDIA NIM API key from [build.nvidia.com](https://build.nvidia.com)
  - Format: `nvapi-...` (starts with nvapi-)

### 4. Deploy

Click "Deploy" — Vercel builds and deploys automatically.

**Your app is live in ~2 minutes.** Share the URL with your wife.

## Local Development

```bash
npm install
npm run dev
```

Visit `http://localhost:5173`

## How It Works

1. **Frontend** (React + Vite + Tailwind)
   - Chat UI with image upload
   - Model selector (M3, DeepSeek, Qwen)
   - Dark mode + local chat history

2. **Backend** (Vercel serverless function at `/api/chat.js`)
   - Receives message + image
   - Tries Ollama Cloud M3 first
   - Falls back to NVIDIA NIM if M3 fails or rate-limits
   - Returns response to frontend

3. **Free tier limits**
   - Ollama Cloud: 40 requests/minute, 1 concurrent model
   - NVIDIA NIM: 40 requests/minute, unlimited tokens per request
   - Both free tier APIs are for prototyping; production would need paid tier or self-hosted

## Troubleshooting

**"API keys not configured"**
- Go to Vercel dashboard → Settings → Environment Variables
- Paste your actual keys (not redacted versions)
- Redeploy the project (or wait for auto-redeployment after env change)

**Rate limit errors (429)**
- You've hit 40 RPM on Ollama Cloud or NIM
- Wait ~60 seconds and retry
- Load is shared across all users; if wife and you both chat simultaneously, you'll hit it faster

**Image upload doesn't work**
- Only Ollama Cloud M3 supports images; NIM models do not
- If M3 is down, image upload will fail gracefully
- Text-only fallback to DeepSeek/Qwen works fine

**PWA doesn't install**
- On iOS: Safari → Share → Add to Home Screen
- On Android: Chrome menu → Install app (or Add to home screen)
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

## Next Steps

- **Share URL** with wife → she adds to home screen
- **Test on her phone** with both models (M3 for images, DeepSeek for text)
- **Compare to Claude Pro** — see where free tier falls short
- **Iterate** on UI based on her feedback
- **Consider extension** later if you want browser sidebar access

## API Docs

**Ollama Cloud M3:**
- Endpoint: `api.ollama.ai/v1/chat/completions`
- Model: `minimax-m3:cloud`
- Supports: text + images (base64)
- Rate limit: 40 req/min
- Cost: Free tier (credits consumed per request)

**NVIDIA NIM:**
- Endpoint: `integrate.api.nvidia.com/v1/chat/completions`
- Models: `deepseek-ai/deepseek-r1`, `Qwen/QwQ-32B-Preview`
- Supports: text only
- Rate limit: 40 req/min
- Cost: Free tier (no per-token billing, just RPM limit)

## License

MIT
