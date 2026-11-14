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
      <div className="wrap"><section className="panel">
        <h2>Something went wrong</h2>
        <p className="mono">{String(this.state.err.message)}</p>
        <button type="button" onClick={() => location.reload()}>Reload</button>
      </section></div>
    )
  }
}

createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>)
