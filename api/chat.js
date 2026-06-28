export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { messages, newMessage, image, model } = req.body

  const OLLAMA_CLOUD_KEY = process.env.OLLAMA_CLOUD_KEY
  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY

  if (!OLLAMA_CLOUD_KEY || !NVIDIA_NIM_KEY) {
    return res.status(500).json({ error: 'API keys not configured' })
  }

  try {
    const formattedMessages = [
      ...messages.map(m => ({
        role: m.role,
        content: m.content
      })),
      {
        role: 'user',
        content: image 
          ? [
              { type: 'text', text: newMessage },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: image.data
                }
              }
            ]
          : newMessage
      }
    ]

    let response

    if (model === 'm3') {
      // Try Ollama Cloud M3 first
      try {
        response = await callOllamaCloud(formattedMessages, OLLAMA_CLOUD_KEY)
      } catch (err) {
        console.log('Ollama Cloud failed, falling back to NIM:', err.message)
        response = await callNimModel(formattedMessages, 'deepseek-ai/deepseek-r1', NVIDIA_NIM_KEY)
      }
    } else if (model === 'deepseek') {
      response = await callNimModel(formattedMessages, 'deepseek-ai/deepseek-r1', NVIDIA_NIM_KEY)
    } else if (model === 'qwen') {
      response = await callNimModel(formattedMessages, 'Qwen/QwQ-32B-Preview', NVIDIA_NIM_KEY)
    }

    return res.status(200).json({ response: response })
  } catch (error) {
    console.error('Chat error:', error)
    return res.status(500).json({ error: error.message || 'Failed to get response' })
  }
}

async function callOllamaCloud(messages, apiKey) {
  const response = await fetch('https://api.ollama.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'minimax-m3:cloud',
      messages: messages,
      temperature: 0.7,
      max_tokens: 2048
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Ollama Cloud error: ${err}`)
  }

  const data = await response.json()
  return data.choices[0].message.content
}

async function callNimModel(messages, model, apiKey) {
  // For NIM, strip out image data if present (these models don't support vision)
  const textMessages = messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string' 
      ? m.content 
      : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  }))

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: model,
      messages: textMessages,
      temperature: 0.7,
      max_tokens: 2048
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`NIM error: ${err}`)
  }

  const data = await response.json()
  return data.choices[0].message.content
}
