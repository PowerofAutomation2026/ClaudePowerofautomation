import { Component, Fragment, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installErrorHandlers, logError } from './errorlog'
import { startGuard } from './guard'
import { embedded, setSoftReset } from './reset'
import './styles.css'

class Boundary extends Component<{ children: ReactNode }, { err: Error | null; k: number }> {
  state = { err: null as Error | null, k: 0 }
  private lastAuto = 0
  static getDerivedStateFromError(err: unknown) { return { err: err instanceof Error ? err : new Error(String(err ?? 'Unknown error')) } }   // a thrown non-Error would otherwise render nothing at all
  componentDidCatch(err: Error) {
    logError('render', err)
    if (Date.now() - this.lastAuto > 120_000) { this.lastAuto = Date.now(); setTimeout(() => this.setState((s) => ({ err: null, k: s.k + 1 })), 800) }   // first failure: quietly start the app again
  }
  render() {
    if (!this.state.err) return <Fragment key={this.state.k}>{this.props.children}</Fragment>
    return (
      <main style={{ padding: 24 }} role="alert">
        <div className="card">
          <h2>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{String(this.state.err.stack ?? this.state.err.message)}</pre>
          <button className="btn" onClick={() => this.setState((s) => ({ err: null, k: s.k + 1 }))}>Try again</button> {!embedded() && <button className="btn primary" onClick={() => location.reload()}>Reload</button>}
        </div>
      </main>
    )
  }
}

startGuard(); installErrorHandlers()
const root = createRoot(document.getElementById('root')!, { onUncaughtError: (e) => logError('uncaught', e), onCaughtError: (e) => logError('caught', e), onRecoverableError: (e) => logError('recoverable', e) })
let mountKey = 0
const mount = () => root.render(<Boundary key={mountKey}><App /></Boundary>)
setSoftReset(() => { mountKey++; mount() })
mount()
