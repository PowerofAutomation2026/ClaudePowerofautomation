import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { startGuard } from './guard'
import './styles.css'

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <main style={{ padding: 24 }} role="alert">
        <div className="card">
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.err.stack ?? this.state.err.message)}</pre>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    )
  }
}

startGuard()
createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>)
