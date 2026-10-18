import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Small pool of child processes. A query that runs too long is killed (SIGKILL) and the process is replaced. */
export class QueryPool {
  constructor(size = 2, timeoutMs = 20000) {
    this.size = size; this.timeoutMs = timeoutMs
    this.idle = []; this.queue = []; this.seq = 0; this.all = new Set(); this.closed = false
    this.file = fileURLToPath(new URL('./query-worker.mjs', import.meta.url))
    for (let i = 0; i < size; i++) this.idle.push(this.spawn())
  }
  spawn() {
    const c = fork(this.file, [], { execArgv: ['--no-warnings'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    c.unref(); c.channel?.unref?.()
    this.all.add(c)
    c.on('exit', () => this.all.delete(c))
    return c
  }
  run(file, sql, params, cap) {
    return new Promise((resolve, reject) => { this.queue.push({ file, sql, params, cap, resolve, reject }); this.pump() })
  }
  pump() {
    while (this.idle.length && this.queue.length && !this.closed) {
      const c = this.idle.pop(), job = this.queue.shift(), id = ++this.seq
      let done = false
      const finish = (fn, v, recycle) => {
        if (done) return; done = true; clearTimeout(timer); c.off('message', onMsg); c.off('exit', onExit)
        if (recycle) this.idle.push(c); else { try { c.kill('SIGKILL') } catch { /* already gone */ } if (!this.closed) this.idle.push(this.spawn()) }
        fn(v); this.pump()
      }
      const onMsg = (m) => { if (m.id !== id) return; m.error ? finish(job.reject, new Error(m.error), true) : finish(job.resolve, m, true) }
      const onExit = () => finish(job.reject, new Error('query process exited'), false)
      const timer = setTimeout(() => { const e = new Error('query timeout'); e.timeout = true; finish(job.reject, e, false) }, this.timeoutMs)
      c.on('message', onMsg); c.on('exit', onExit)
      c.send({ id, file: job.file, sql: job.sql, params: job.params, cap: job.cap })
    }
  }
  close() { this.closed = true; for (const c of this.all) { try { c.kill('SIGKILL') } catch { /* ignore */ } } }
}
