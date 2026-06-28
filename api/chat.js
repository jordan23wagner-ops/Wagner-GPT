export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { messages, newMessage, image, model } = req.body

  const NVIDIA_NIM_KEY = process.env.NVIDIA_NIM_KEY

  if (!NVIDIA_NIM_KEY) {
    return res.status(500).json({ error: 'API key not configured' })
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
      response = await callNimModel(formattedMessages, 'minimaxai/minimax-m3', NVIDIA_NIM_KEY)
    } else if (model === 'deepseek') {
      response = await callNimModel(formattedMessages, 'deepseek-ai/deepseek-v4-flash', NVIDIA_NIM_KEY)
    } else if (model === 'qwen') {
      response = await callNimModel(formattedMessages, 'deepseek-ai/deepseek-v4-pro', NVIDIA_NIM_KEY)
    } else {
      return res.status(400).json({ error: `Unknown model: ${model}` })
    }

    return res.status(200).json({ response: response })
  } catch (error) {
    console.error('Chat error:', error)
    return res.status(500).json({ error: error.message || 'Failed to get response' })
  }
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
