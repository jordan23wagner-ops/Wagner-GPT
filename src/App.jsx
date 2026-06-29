import React, { useState, useRef, useEffect } from 'react'
import {
  Send, Paperclip, Sun, Moon, Trash2, MessageSquare, Flower2,
  Menu, Plus, X, FileText, Printer,
} from 'lucide-react'
import Garden from './Garden'
import {
  loadConversations, saveConversations, loadActiveId, saveActiveId,
  newConversation, titleFromMessages,
} from './lib/conversations'
import { cacheKey, getCached, setCached, looksLikeImageRequest } from './lib/cache'
import { loadUsage, bumpUsage, IMAGE_DAILY_SOFT_LIMIT } from './lib/usage'
import { exportWord, exportPdf } from './lib/exportChat'

// Inset so the header/input clear the phone's status bar (time/battery) and home
// indicator. Harmless 0 on desktop; real values on notched phones (viewport-fit=cover).
const TOP_INSET = 'calc(env(safe-area-inset-top, 0px) + 0.75rem)'
const BOTTOM_INSET = 'calc(env(safe-area-inset-bottom, 0px) + 1rem)'

const MODEL_LABELS = { auto: 'Auto', m3: 'MiniMax M3', gemma: 'Gemma 4' }

export default function App() {
  // Load conversations once and derive the active id from the SAME instance — a fresh
  // load (or legacy migration) mints new ids, so calling the loader twice would leave
  // activeId pointing at a conversation that isn't in state.
  const initialConvs = useRef(null)
  if (!initialConvs.current) initialConvs.current = loadConversations()
  const [conversations, setConversations] = useState(initialConvs.current)
  const [activeId, setActiveId] = useState(() => loadActiveId(initialConvs.current))
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [model, setModel] = useState(() => localStorage.getItem('model') || 'auto')
  const [tab, setTab] = useState('chat')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [usage, setUsage] = useState(loadUsage)
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

  // Keep the active id reachable inside async stream closures without stale capture.
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const activeConv = conversations.find((c) => c.id === activeId) || conversations[0]
  const messages = activeConv ? activeConv.messages : []

  // setMessages shim: updates the active conversation's messages (and auto-titles it),
  // so the streaming code below stays unchanged from the single-history version.
  const setMessages = (updater) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeIdRef.current) return c
        const next = typeof updater === 'function' ? updater(c.messages) : updater
        const title = c.title === 'New chat' ? titleFromMessages(next) || c.title : c.title
        return { ...c, messages: next, title, updatedAt: Date.now() }
      })
    )
  }

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => { scrollToBottom() }, [messages])

  useEffect(() => {
    localStorage.setItem('darkMode', darkMode)
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  useEffect(() => { saveConversations(conversations) }, [conversations])
  useEffect(() => { saveActiveId(activeId) }, [activeId])
  useEffect(() => { localStorage.setItem('model', model) }, [model])

  const handleImageUpload = (e) => {
    const file = e.target.files[0]
    if (file) {
      const reader = new FileReader()
      reader.onload = (event) => {
        setImagePreview(event.target.result)
        setImage({
          data: event.target.result.split(',')[1],
          mediaType: file.type,
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
    let streamedText = ''       // text-only content (for caching)
    let producedImage = false   // did this turn generate an image?
    let routedModel = null      // which model the backend actually used
    let streamError = null      // terminal error reported by the backend

    const ensureAssistant = () => {
      if (appended) return
      appended = true
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: 'assistant', content: '' },
      ])
    }

    const appendDelta = (text) => {
      ensureAssistant()
      accumulated += text
      streamedText += text
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + text } : m
        )
      )
    }

    // AI-generated image: attach it to the assistant bubble as a data URL.
    const setAssistantImage = (b64, mediaType) => {
      ensureAssistant()
      accumulated += '[image]'
      producedImage = true
      const url = `data:${mediaType || 'image/jpeg'};base64,${b64}`
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? { ...m, image: url } : m))
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
          model: model,
        }),
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
      //   { image }  -> AI-generated image
      //   { done }   -> terminal success (carries routed provider/model)
      //   { error }  -> terminal failure
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const handleLine = (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let evt
        try { evt = JSON.parse(trimmed) } catch { return }
        if (evt.delta) appendDelta(evt.delta)
        else if (evt.image) setAssistantImage(evt.image, evt.mediaType)
        else if (evt.error) streamError = evt.error
        else if (evt.done) routedModel = evt.model || null
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
        // Tag the reply with the model that actually answered (useful in Auto mode).
        if (appended && routedModel) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, via: routedModel } : m))
          )
        }
        // Usage: one chat request, plus an image if one was generated.
        setUsage(bumpUsage({ chat: 1, image: producedImage ? 1 : 0 }))
        // Cache plain text answers so identical prompts return instantly next time.
        if (!producedImage && !payload.image && streamedText.trim()) {
          setCached(cacheKey(model, history, payload.text), streamedText)
        }
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
    if (loading) return // dedupe: never run two requests at once
    if (!input.trim() && !image) return

    const text = input
    const userMessage = {
      id: Date.now(),
      role: 'user',
      content: text,
      image: imagePreview,
    }

    // Snapshot the context (before adding this turn) and the new payload.
    const history = messages
    const payload = { text, image: image }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setImage(null)
    setImagePreview(null)

    // Cache hit: serve an identical text-only, non-image prompt instantly (no request).
    if (!image && !looksLikeImageRequest(text)) {
      const cached = getCached(cacheKey(model, history, text))
      if (cached) {
        setMessages((prev) => [
          ...prev,
          { id: Date.now() + 1, role: 'assistant', content: cached, cached: true },
        ])
        return
      }
    }

    await sendToModel(history, payload)
  }

  const handleRetry = () => {
    if (lastAttempt) sendToModel(lastAttempt.history, lastAttempt.payload)
  }

  const clearHistory = () => {
    if (window.confirm('Clear this conversation?')) setMessages([])
  }

  // ---- Conversation management ----
  const startNewChat = () => {
    const c = newConversation([])
    setConversations((prev) => [c, ...prev])
    setActiveId(c.id)
    setSidebarOpen(false)
    setError(null)
  }

  const selectChat = (id) => {
    setActiveId(id)
    setSidebarOpen(false)
    setError(null)
  }

  const deleteChat = (id) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id)
      if (next.length === 0) {
        const fresh = newConversation([])
        setActiveId(fresh.id)
        return [fresh]
      }
      if (id === activeIdRef.current) setActiveId(next[0].id)
      return next
    })
  }

  const imageLimitHit = usage.image >= IMAGE_DAILY_SOFT_LIMIT

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className={`flex flex-col h-[100dvh] overflow-x-hidden ${darkMode ? 'bg-gray-900' : 'bg-white'}`}>
        {/* Header */}
        <div
          className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'} border-b px-2 sm:px-4 pb-3 flex items-center justify-between gap-1`}
          style={{ paddingTop: TOP_INSET }}
        >
          <div className="flex items-center gap-1">
            {tab === 'chat' && (
              <button
                onClick={() => setSidebarOpen(true)}
                className={`p-1.5 sm:p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-gray-200' : 'bg-gray-200 text-gray-600'}`}
                aria-label="Chat history"
              >
                <Menu size={18} />
              </button>
            )}
            {[
              { id: 'chat', label: 'Chat', Icon: MessageSquare },
              { id: 'garden', label: 'Garden', Icon: Flower2 },
            ].map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium ${
                  tab === id
                    ? darkMode ? 'bg-gray-700 text-white' : 'bg-white text-gray-900 shadow-sm'
                    : darkMode ? 'text-gray-400' : 'text-gray-500'
                }`}
              >
                <Icon size={16} /> {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-1.5 sm:p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-200 text-gray-600'}`}
              aria-label="Toggle dark mode"
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {tab === 'chat' && (
              <button
                onClick={clearHistory}
                className={`p-1.5 sm:p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-red-400 hover:bg-gray-600' : 'bg-gray-200 text-red-600 hover:bg-gray-300'}`}
                aria-label="Clear chat"
              >
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </div>

        {tab === 'garden' && <Garden darkMode={darkMode} />}

        {tab === 'chat' && (
        <>
        {/* Model Selector + usage */}
        <div className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'} border-b px-4 py-2`}>
          <div className="flex items-center gap-2 flex-wrap">
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
              <option value="auto">Auto — smart routing</option>
              <option value="m3">MiniMax M3 — vision</option>
              <option value="gemma">Gemma 4 — vision + images</option>
            </select>
            <span
              className={`ml-auto text-xs ${imageLimitHit ? 'text-red-500 font-medium' : darkMode ? 'text-gray-500' : 'text-gray-400'}`}
              title={`Today's usage — resets daily. Image soft-limit ${IMAGE_DAILY_SOFT_LIMIT}/day to avoid throttling.`}
            >
              {usage.chat} chats · {usage.image} imgs{imageLimitHit ? ' ⚠' : ''}
            </span>
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
                    {msg.role === 'assistant' && (msg.via || msg.cached) && (
                      <p className={`text-[10px] mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        {msg.cached ? 'cached' : `via ${MODEL_LABELS[msg.via] || msg.via}`}
                      </p>
                    )}
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
        <div
          className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50 border-gray-200'} border-t px-4 pt-4`}
          style={{ paddingBottom: BOTTOM_INSET }}
        >
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
        </>
        )}

        {/* Chat history sidebar */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 flex">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setSidebarOpen(false)}
            />
            <div
              className={`relative w-72 max-w-[80%] h-full flex flex-col shadow-xl ${darkMode ? 'bg-gray-800' : 'bg-white'}`}
              style={{ paddingTop: TOP_INSET }}
            >
              <div className={`flex items-center justify-between px-4 pb-3 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <span className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Chats</span>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className={`p-1.5 rounded-lg ${darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="p-3 flex flex-col gap-2 border-b border-dashed border-gray-300/40">
                <button
                  onClick={startNewChat}
                  className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium ${darkMode ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-blue-500 text-white hover:bg-blue-600'}`}
                >
                  <Plus size={16} /> New chat
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => exportWord(activeConv?.title || 'chat', messages)}
                    disabled={messages.length === 0}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 ${darkMode ? 'bg-gray-700 text-gray-200 hover:bg-gray-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                  >
                    <FileText size={14} /> Word
                  </button>
                  <button
                    onClick={() => { if (!exportPdf(activeConv?.title || 'chat', messages)) alert('Allow pop-ups to export PDF.') }}
                    disabled={messages.length === 0}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40 ${darkMode ? 'bg-gray-700 text-gray-200 hover:bg-gray-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                  >
                    <Printer size={14} /> PDF
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-2">
                {conversations.map((c) => (
                  <div
                    key={c.id}
                    className={`group flex items-center gap-1 rounded-lg mb-1 ${
                      c.id === activeId
                        ? darkMode ? 'bg-gray-700' : 'bg-gray-100'
                        : ''
                    }`}
                  >
                    <button
                      onClick={() => selectChat(c.id)}
                      className={`flex-1 text-left px-3 py-2 text-sm truncate ${darkMode ? 'text-gray-200' : 'text-gray-800'}`}
                    >
                      {c.title || 'New chat'}
                    </button>
                    <button
                      onClick={() => deleteChat(c.id)}
                      className={`p-1.5 mr-1 rounded ${darkMode ? 'text-gray-500 hover:text-red-400' : 'text-gray-400 hover:text-red-500'}`}
                      aria-label="Delete chat"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
