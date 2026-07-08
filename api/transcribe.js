// Groq Whisper transcription endpoint.
// Accepts POST { audio: base64string, mimeType: string } → { text: string }
// Groq Whisper large-v3-turbo is free, very fast, and far more accurate than
// the browser Web Speech API (especially for accents and background noise).

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const GROQ_KEY = process.env.GROQ_KEY
  if (!GROQ_KEY) {
    return res.status(503).json({ error: 'Voice transcription not configured — GROQ_KEY missing.' })
  }

  const { audio, mimeType } = req.body || {}
  if (!audio) return res.status(400).json({ error: 'Missing audio data.' })

  const audioBuffer = Buffer.from(audio, 'base64')
  const ext = String(mimeType || '').includes('mp4') ? 'mp4' : 'webm'

  const formData = new FormData()
  formData.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/webm' }), `rec.${ext}`)
  formData.append('model', 'whisper-large-v3-turbo')
  formData.append('response_format', 'json')
  formData.append('language', 'en')

  let response
  try {
    response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}` },
      body: formData,
    })
  } catch (err) {
    return res.status(502).json({ error: 'Whisper unreachable: ' + ((err && err.message) || 'network error') })
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return res.status(502).json({ error: `Whisper ${response.status}: ${body.slice(0, 200)}` })
  }

  const data = await response.json()
  return res.status(200).json({ text: data.text || '' })
}
