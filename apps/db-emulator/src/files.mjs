/**
 * File share simulator, modeled on the SharePoint / OneDrive connector file operations
 * (List folder, Get file metadata, Get file content). Lets you test "dashboard refreshes when the file changes":
 * drop or edit a CSV / Excel file in data/files and the app notices the new modified time / ETag.
 *
 *   GET    /files/folder?path=            { value: [{ Name, Path, Size, LastModified, ETag, IsFolder }] }
 *   GET    /files/metadata?path=x.csv     { Name, Path, Size, LastModified, ETag }
 *   GET    /files/content?path=x.csv      file bytes (ETag, Last-Modified; 304 for If-None-Match)
 *   PUT    /files/content?path=x.csv      write (test tooling)
 *   DELETE /files/content?path=x.csv
 */
import fs from 'node:fs'
import path from 'node:path'
import { Rng, ts, dt } from '../seed/common.mjs'

const OK_EXT = new Set(['.csv', '.tsv', '.txt', '.json', '.xlsx'])
const MIME = { '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.txt': 'text/plain', '.json': 'application/json', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
const MAX_UPLOAD = 25 * 1024 * 1024

export class FileShare {
  constructor(root, seedDir) {
    this.root = path.resolve(root)
    fs.mkdirSync(this.root, { recursive: true })
    if (seedDir && fs.existsSync(seedDir)) for (const f of fs.readdirSync(seedDir)) { const to = path.join(this.root, f); if (!fs.existsSync(to)) fs.copyFileSync(path.join(seedDir, f), to) }
    this.feedTimer = null
    this.feedStats = { running: false, appended: 0, last: null }
  }
  /** Resolve a request path inside the root; throws on traversal. */
  resolve(p, { mustExist = true } = {}) {
    const clean = String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (clean.split('/').includes('..') || clean.includes('\0')) throw httpError(400, 'Invalid path')
    const full = path.resolve(this.root, clean)
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw httpError(400, 'Invalid path')
    if (mustExist && !fs.existsSync(full)) throw httpError(404, `File not found: ${clean || '/'}`)
    return full
  }
  meta(full) {
    const st = fs.statSync(full)
    const rel = path.relative(this.root, full).split(path.sep).join('/')
    return { Name: path.basename(full) || '/', Path: '/' + rel, Size: st.size, LastModified: new Date(st.mtimeMs).toISOString(), ETag: `"${Math.round(st.mtimeMs)}-${st.size}"`, IsFolder: st.isDirectory() }
  }
  list(p) {
    const dir = this.resolve(p)
    if (!fs.statSync(dir).isDirectory()) throw httpError(400, 'Not a folder')
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).map((n) => this.meta(path.join(dir, n))).filter((m) => m.IsFolder || OK_EXT.has(path.extname(m.Name).toLowerCase()))
  }

  /** Simulates an upstream system that re-exports sales-feed.csv every few seconds (appends new rows). */
  startFeed(everySec = 3, rowsPerTick = 5, seed = 5) {
    const file = path.join(this.root, 'sales-feed.csv')
    const r = new Rng(seed)
    const REG = ['North', 'South', 'East', 'West', 'Central'], PRO = ['Widget', 'Gadget', 'Gizmo', 'Doohickey']
    const row = () => { const u = r.int(1, 12), pr = r.pick([20, 35, 50, 80]); return [dt(Date.now()), r.pick(REG), r.pick(PRO), u, u * pr].join(',') }
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'Date,Region,Product,Units,Revenue\n' + Array.from({ length: 500 }, row).join('\n') + '\n')
    this.feedStats.running = true
    this.feedTimer = setInterval(() => {
      try { fs.appendFileSync(file, Array.from({ length: rowsPerTick }, row).join('\n') + '\n'); this.feedStats.appended += rowsPerTick; this.feedStats.last = new Date().toISOString() } catch (e) { this.feedStats.error = String(e.message) }
    }, everySec * 1000)
    this.feedTimer.unref?.()
  }
  stopFeed() { clearInterval(this.feedTimer); this.feedStats.running = false }

  /** @returns true when the request was handled */
  async handle(req, res, url, helpers) {
    const { send, fail, CORS, readBodyBuffer } = helpers
    const p = url.pathname.replace(/\/+$/, '')
    try {
      if (p === '/files/folder' && req.method === 'GET') return send(res, 200, { value: this.list(url.searchParams.get('path') ?? '/') }), true
      if (p === '/files/metadata' && req.method === 'GET') return send(res, 200, this.meta(this.resolve(url.searchParams.get('path')))), true
      if (p === '/files/content') {
        const rel = url.searchParams.get('path')
        if (req.method === 'GET') {
          const full = this.resolve(rel)
          if (fs.statSync(full).isDirectory()) throw httpError(400, 'Not a file')
          const m = this.meta(full)
          const headers = { ...CORS, etag: m.ETag, 'last-modified': new Date(m.LastModified).toUTCString(), 'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' }
          if (req.headers['if-none-match'] === m.ETag) { res.writeHead(304, headers); return res.end(), true }
          res.writeHead(200, { ...headers, 'content-length': m.Size }); res.end(fs.readFileSync(full)); return true
        }
        if (req.method === 'PUT') {
          const full = this.resolve(rel, { mustExist: false })
          if (!OK_EXT.has(path.extname(full).toLowerCase())) throw httpError(400, 'Only .csv .tsv .txt .json .xlsx files')
          const buf = await readBodyBuffer(req, MAX_UPLOAD)
          fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, buf)
          return send(res, 200, this.meta(full)), true
        }
        if (req.method === 'DELETE') { fs.rmSync(this.resolve(rel)); return send(res, 200, { deleted: true }), true }
      }
    } catch (e) { fail(res, null, e.status ?? 500, 0, e.message); return true }
    return false
  }
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e }
