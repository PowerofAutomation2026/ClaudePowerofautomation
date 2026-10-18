import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui' }}>
        <h2>Something went wrong</h2>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.err.stack ?? this.state.err.message)}</pre>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}

createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>)
