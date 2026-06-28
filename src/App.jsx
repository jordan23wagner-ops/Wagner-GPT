import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown, Send, Paperclip, MoreVertical, Sun, Moon, Trash2 } from 'lucide-react'

export default function App() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState('m3')
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('darkMode') === 'true' || window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return false
  })
  const [image, setImage] = useState(null)
  const [imagePreview, setImagePreview] = useState(null)
  const [error, setError] = useState(null)
  const [lastAttempt, setLastAttempt] = useState(null)
  const messagesEndRef = useRef(null)
  const fileInputRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    localStorage.setItem('darkMode', darkMode)
    if (darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [darkMode])

  useEffect(() => {
    const saved = localStorage.getItem('chatHistory')
    if (saved) {
      setMessages(JSON.parse(saved))
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('chatHistory', JSON.stringify(messages))
  }, [messages])

  const handleImageUpload = (e) => {
    const file = e.target.files[0]
    if (file) {
      const reader = new FileReader()
      reader.onload = (event) => {
        setImagePreview(event.target.result)
        setImage({
          data: event.target.result.split(',')[1],
          mediaType: file.type
        })
      }
      reader.readAsDataURL(file)
    }
  }

  // Core send routine. `history` is the message list to send as context,
  // `payload` is the new turn (text + optional image). Reused by submit and retry.
  const sendToModel = async (history, payload) => {
    setError(null)
    setLoading(true)

    // Create a placeholder assistant message we'll fill in as tokens stream in.
    const assistantId = Date.now() + 1
    let appended = false        // have we added the placeholder to the list yet?
    let accumulated = ''        // full text so far (for error-rollback decisions)
    let streamError = null      // terminal error reported by the backend

    const ensureAssistant = () => {
      if (appended) return
      appended = true
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '' }
      ])
    }

    const appendDelta = (text) => {
      ensureAssistant()
      accumulated += text
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + text } : m
        )
      )
    }

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          newMessage: payload.text,
          image: payload.image,
          model: model
        })
      })

      // Non-OK before streaming started (e.g. 400/500) — body may be JSON or NDJSON.
      if (!response.ok || !response.body) {
        let errMsg = 'Failed to get a response.'
        try {
          const data = await response.json()
          errMsg = data.error || errMsg
        } catch (_) { /* ignore parse failures */ }
        setError(errMsg)
        setLastAttempt({ history, payload })
        return
      }

      // Read the NDJSON stream: one JSON object per line.
      //   { delta }  -> append token
      //   { error }  -> terminal failure
      //   { done }   -> terminal success
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const handleLine = (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let evt
        try { evt = JSON.parse(trimmed) } catch { return }
        if (evt.delta) appendDelta(evt.delta)
        else if (evt.error) streamError = evt.error
        // evt.done -> nothing to do; loop ends when reader closes
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, idx))
          buffer = buffer.slice(idx + 1)
        }
      }
      if (buffer.length) handleLine(buffer)

      if (streamError) {
        // If nothing streamed, surface the error banner + retry. If we already
        // streamed partial content, keep what we got and append a note inline.
        if (accumulated) {
          appendDelta(`\n\n⚠️ ${streamError}`)
          setLastAttempt(null)
        } else {
          setError(streamError)
          setLastAttempt({ history, payload })
        }
      } else {
        setLastAttempt(null)
      }
    } catch (err) {
      // Network drop mid-stream: keep any partial content, but offer retry only
      // if we never received anything.
      if (accumulated) {
        appendDelta('\n\n⚠️ Connection interrupted.')
      } else {
        setError('Network error — check your connection and try again.')
        setLastAttempt({ history, payload })
      }
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!input.trim() && !image) return

    const userMessage = {
      id: Date.now(),
      role: 'user',
      content: input,
      image: imagePreview
    }

    // Snapshot the context (before adding this turn) and the new payload.
    const history = messages
    const payload = { text: input, image: image }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setImage(null)
    setImagePreview(null)

    await sendToModel(history, payload)
  }

  const handleRetry = () => {
    if (lastAttempt) {
      sendToModel(lastAttempt.history, lastAttempt.payload)
    }
  }

  const clearHistory = () => {
    if (window.confirm('Clear all chat history?')) {
      setMessages([])
    }
  }

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className={`flex flex-col h-screen ${darkMode ? 'bg-gray-900' : 'bg-white'}`}>
        {/* Header */}
        <div className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'} border-b px-4 py-3 flex items-center justify-between`}>
          <h1 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Chat
          </h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-200 text-gray-600'}`}
              aria-label="Toggle dark mode"
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              onClick={clearHistory}
              className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-red-400 hover:bg-gray-600' : 'bg-gray-200 text-red-600 hover:bg-gray-300'}`}
              aria-label="Clear chat"
            >
              <Trash2 size={18} />
            </button>
          </div>
        </div>

        {/* Model Selector */}
        <div className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'} border-b px-4 py-2`}>
          <div className="flex items-center gap-2">
            <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Model:</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={`px-3 py-1 rounded-lg text-sm border ${
                darkMode
                  ? 'bg-gray-700 border-gray-600 text-white'
                  : 'bg-white border-gray-300 text-gray-900'
              }`}
            >
              <option value="m3">MiniMax M3 (Ollama → NIM)</option>
              <option value="deepseek">DeepSeek V4 Flash (Ollama → NIM)</option>
              <option value="qwen">DeepSeek V4 Pro (Ollama → NIM)</option>
            </select>
          </div>
        </div>

        {/* Messages */}
        <div className={`flex-1 overflow-y-auto p-4 space-y-4 ${darkMode ? 'bg-gray-900' : 'bg-white'}`}>
          {messages.length === 0 ? (
            <div className={`flex items-center justify-center h-full text-center ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              <div>
                <p className="text-lg mb-2">No messages yet</p>
                <p className="text-sm">Start typing to begin a conversation</p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-xs px-4 py-2 rounded-lg ${
                      msg.role === 'user'
                        ? `${darkMode ? 'bg-blue-600' : 'bg-blue-500'} text-white`
                        : `${darkMode ? 'bg-gray-800' : 'bg-gray-100'} ${darkMode ? 'text-gray-100' : 'text-gray-900'}`
                    }`}
                  >
                    {msg.image && (
                      <img src={msg.image} alt="uploaded" className="max-w-xs rounded mb-2" />
                    )}
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  </div>
                </div>
              ))}
              {loading && messages[messages.length - 1]?.role !== 'assistant' && (
                <div className="flex justify-start">
                  <div className={`${darkMode ? 'bg-gray-800' : 'bg-gray-100'} px-4 py-2 rounded-lg`}>
                    <div className="flex gap-1">
                      <div className={`w-2 h-2 rounded-full ${darkMode ? 'bg-gray-400' : 'bg-gray-600'} animate-bounce`}></div>
                      <div className={`w-2 h-2 rounded-full ${darkMode ? 'bg-gray-400' : 'bg-gray-600'} animate-bounce`} style={{ animationDelay: '0.1s' }}></div>
                      <div className={`w-2 h-2 rounded-full ${darkMode ? 'bg-gray-400' : 'bg-gray-600'} animate-bounce`} style={{ animationDelay: '0.2s' }}></div>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}

          {error && (
            <div className="flex justify-start">
              <div
                role="alert"
                className={`max-w-xs px-4 py-3 rounded-lg border ${
                  darkMode
                    ? 'bg-red-950/40 border-red-800 text-red-200'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}
              >
                <p className="text-sm mb-2">{error}</p>
                <div className="flex gap-2">
                  {lastAttempt && (
                    <button
                      onClick={handleRetry}
                      disabled={loading}
                      className={`text-xs font-medium px-3 py-1 rounded ${
                        darkMode
                          ? 'bg-red-800 text-red-100 hover:bg-red-700 disabled:opacity-50'
                          : 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
                      }`}
                    >
                      Retry
                    </button>
                  )}
                  <button
                    onClick={() => setError(null)}
                    className={`text-xs font-medium px-3 py-1 rounded ${
                      darkMode
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                    }`}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'} border-t p-4`}>
          {imagePreview && (
            <div className="mb-3 flex items-center justify-between">
              <img src={imagePreview} alt="preview" className="h-16 rounded-lg" />
              <button
                onClick={() => {
                  setImage(null)
                  setImagePreview(null)
                }}
                className={`text-sm px-2 py-1 rounded ${darkMode ? 'bg-gray-700 text-red-400' : 'bg-gray-200 text-red-600'}`}
              >
                Remove
              </button>
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleImageUpload}
              accept="image/*"
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}
              aria-label="Upload image"
            >
              <Paperclip size={20} />
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              className={`flex-1 px-4 py-2 rounded-lg border ${
                darkMode
                  ? 'bg-gray-700 border-gray-600 text-white placeholder-gray-400'
                  : 'bg-white border-gray-300 text-gray-900'
              }`}
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || (!input.trim() && !image)}
              className={`p-2 rounded-lg ${
                loading || (!input.trim() && !image)
                  ? darkMode
                    ? 'bg-gray-700 text-gray-500'
                    : 'bg-gray-200 text-gray-400'
                  : darkMode
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
              aria-label="Send message"
            >
              <Send size={20} />
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
