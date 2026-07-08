import React from 'react'

// Last-resort crash screen. Without it, one render-time exception (e.g. a malformed persisted
// conversation) is a permanent white screen in a PWA — and nobody thinks to clear site data.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('App crashed:', error, info)
  }
  resetLocalData = () => {
    if (!window.confirm('Reset local data? This clears conversations and settings stored in this browser (anything synced to Supabase is safe and will re-download).')) return
    try { localStorage.clear() } catch { /* ignore */ }
    location.reload()
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#111', color: '#eee', fontFamily: 'system-ui, sans-serif', padding: 24 }}>
        <div style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something broke 😵</h1>
          <p style={{ fontSize: 14, opacity: 0.8, marginBottom: 6 }}>The app hit an error it couldn't recover from.</p>
          <pre style={{ fontSize: 11, textAlign: 'left', background: '#1d1d1d', padding: 10, borderRadius: 8, overflow: 'auto', maxHeight: 120, marginBottom: 16 }}>{String(this.state.error && (this.state.error.message || this.state.error))}</pre>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={() => location.reload()} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#3b82f6', color: '#fff', cursor: 'pointer' }}>Reload</button>
            <button onClick={this.resetLocalData} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #555', background: 'transparent', color: '#eee', cursor: 'pointer' }}>Reset local data</button>
          </div>
        </div>
      </div>
    )
  }
}
