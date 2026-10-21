/**
 * The data engine. One instance per connected list/library.
 *
 *  - small lists (<= LOCAL_MAX): everything is loaded once (streamed in pages) and search / filter / sort /
 *    group run in memory, so the UI reacts instantly.
 *  - big lists: nothing but the visible window is ever fetched. Search/filter/sort run on the server, rows are
 *    read page by page with keyset (ID) paging so SharePoint's 5,000-item list-view threshold is never hit,
 *    memory is capped, and every request is cancellable.
 */
import type { Backend, Query, Row, SourceConfig, SpField } from './types'
import { emptyQuery, isDefaultQuery, isFolderMode, matchRow, resetHaystack, searchTokens, sortFolderRows, sortRows } from './query'

export const LOCAL_MAX = 25_000
export const BULK = 5_000
export const PAGE = 250
export const MAX_ROWS = 150_000

export type EngineMode = 'local' | 'server'

export interface PulseEvent { at: number; kind: 'new' | 'changed'; id: number; title: string; by?: string }

export class Engine {
  mode: EngineMode
  total: number
  q: Query = emptyQuery()
  /** the rows the grid shows */
  rows: Row[] = []
  /** local mode: every row of the list */
  all: Row[] = []
  version = 0
  loading = false
  loadedAll = false
  hasMore = true
  capped = false
  error: string | null = null
  /** local mode: 0..1 while the first full load is running */
  progress = 0
  maxId = 0
  pendingNew = 0
  pulse: PulseEvent[] = []
  lastSync = new Date().toISOString()
  /** number of rows the server walked past without a match (shown as "scanned") */
  scanned = 0

  private cursor?: string
  private gen = 0
  private ctl?: AbortController
  private subs = new Set<() => void>()
  private titleField: string
  private pending = false
  private pageSize = PAGE
  private lastLoad = 0

  constructor(
    readonly backend: Backend,
    readonly src: SourceConfig,
    readonly fields: SpField[],
    readonly select: string[],
  ) {
    this.total = src.itemCount
    this.mode = src.itemCount <= LOCAL_MAX && !src.isLibrary ? 'local' : 'server'
    this.titleField = src.isLibrary ? 'FileLeafRef' : 'Title'
    this.q = src.isLibrary && src.url ? { ...emptyQuery(), folder: src.url, sort: { field: 'FileLeafRef', dir: 'asc' } } : { ...emptyQuery(), sort: { field: 'ID', dir: 'desc' } }
  }

  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn) } }
  getVersion = () => this.version
  private emit() { this.version++; this.subs.forEach((f) => f()) }

  dispose() { this.gen++; this.ctl?.abort(); this.subs.clear() }

  /* ---------------------------------------------------------------- loading */

  async start() { await this.reset() }

  private async reset() {
    const gen = ++this.gen
    this.ctl?.abort()
    this.ctl = new AbortController()
    this.error = null
    this.cursor = undefined
    this.capped = false
    this.scanned = 0
    this.pendingNew = 0
    this.pageSize = PAGE
    if (this.mode === 'local') {
      if (this.loadedAll) { this.recompute(); return }
      this.all = []; this.rows = []; this.hasMore = true; this.loading = true; this.progress = 0
      this.emit()
      await this.loadEverything(gen)
    } else {
      this.rows = []; this.hasMore = true; this.loading = true
      this.emit()
      await this.fill(gen, PAGE)
    }
  }

  private async loadEverything(gen: number) {
    try {
      let cursor: string | undefined
      const base: Query = { ...emptyQuery(), sort: { field: 'ID', dir: 'asc' }, folders: this.q.folders }
      for (;;) {
        const page = await this.backend.query(this.src, this.fields, this.select, base, BULK, cursor, this.ctl!.signal)
        if (gen !== this.gen) return
        this.all.push(...page.rows)
        for (const r of page.rows) if (r.__id > this.maxId) this.maxId = r.__id
        cursor = page.cursor
        this.progress = Math.min(1, this.all.length / Math.max(1, this.total))
        this.recompute(false)
        if (!cursor) break
      }
      this.loadedAll = true; this.hasMore = false; this.progress = 1
      this.total = Math.max(this.total, this.all.length)
    } catch (e) {
      if (gen === this.gen && !isAbort(e)) this.error = msg(e)
    } finally {
      if (gen === this.gen) { this.loading = false; this.recompute() }
    }
  }

  private recompute(emit = true) {
    const tokens = searchTokens(this.q.search)
    const filtered = isDefaultQuery(this.q) ? this.all : this.all.filter((r) => matchRow(r, this.q, this.fields, tokens))
    this.rows = sortRows(filtered, this.q, this.fields, this.src.isLibrary)
    if (emit) this.emit()
  }

  /** Server mode: read until `want` more rows are in, or the list is exhausted. Slow filters can need several round trips. */
  private async fill(gen: number, want: number) {
    this.loading = true
    try {
      let got = 0, calls = 0
      while (got < want && this.hasMore && calls < 8) {
        calls++
        const page = await this.backend.query(this.src, this.fields, this.select, this.q, this.pageSize, this.cursor, this.ctl!.signal)
        if (gen !== this.gen) return
        this.rows = this.rows.concat(page.rows)
        if (isFolderMode(this.q)) this.rows = sortFolderRows(this.rows, this.q, this.fields)
        got += page.rows.length
        this.scanned += page.scanned ?? page.rows.length
        for (const r of page.rows) if (r.__id > this.maxId) this.maxId = r.__id
        this.cursor = page.cursor
        this.hasMore = !!page.cursor
        if (this.rows.length >= MAX_ROWS) { this.capped = true; this.hasMore = false }
        this.emit()
      }
    } catch (e) {
      if (gen === this.gen && !isAbort(e)) { this.error = msg(e); this.hasMore = false }
    } finally {
      if (gen === this.gen) { this.loading = false; this.emit() }
    }
  }

  loadMore() {
    if (this.mode !== 'server' || this.loading || !this.hasMore || this.pending) return
    // someone is scrolling fast: grow the page (up to 1,000 rows per request) so loading keeps up; slow down again when idle
    const now = Date.now()
    this.pageSize = now - this.lastLoad < 1500 ? Math.min(1000, this.pageSize * 2) : PAGE
    this.lastLoad = now
    void this.fill(this.gen, this.pageSize)
  }

  /* ---------------------------------------------------------------- query changes */

  setQuery(patch: Partial<Query>) {
    const next = { ...this.q, ...patch }
    const foldersChanged = next.folders !== this.q.folders
    // folder view: re-sorting needs no round trip, the whole folder is already here
    if (this.mode === 'server' && isFolderMode(this.q) && isFolderMode(next) && next.folder === this.q.folder && !this.hasMore) { this.q = next; this.rows = sortFolderRows(this.rows, next, this.fields); this.emit(); return }
    this.q = next
    if (this.mode === 'local') {
      if (foldersChanged) { this.loadedAll = false; this.all = []; void this.reset(); return }
      this.recompute()
    } else void this.reset()
  }

  /** Library: switch between SharePoint-style folder browsing and one flat list of every file. */
  setBrowse(on: boolean) {
    this.setQuery(on && this.src.url ? { folder: this.src.url, sort: { field: 'FileLeafRef', dir: 'asc' }, folders: false } : { folder: undefined, sort: { field: 'ID', dir: 'desc' }, folders: false })
  }
  openFolder(path: string) { this.setQuery({ folder: path, search: '', clauses: [], sort: { field: 'FileLeafRef', dir: 'asc' } }) }

  /** Server mode only: restart the view where `fraction` (0..1) of the way through the ID range (fast "seek"). */
  seek(fraction: number) {
    if (this.mode !== 'server') return
    const f = Math.min(0.999, Math.max(0, fraction))
    const asc = this.q.sort.dir === 'asc'
    const ref = Math.round((asc ? f : 1 - f) * Math.max(1, this.maxIdKnown()))
    this.gen++; this.ctl?.abort(); this.ctl = new AbortController()
    this.rows = []; this.hasMore = true; this.cursor = `id:${asc ? ref : ref + 1}`
    this.emit()
    void this.fill(this.gen, PAGE)
  }
  private maxIdKnown() { return Math.max(this.maxId, this.total) }

  refresh() { this.loadedAll = false; this.all = []; return this.reset() }

  /* ---------------------------------------------------------------- live pulse */

  async poll(): Promise<number> {
    if (this.loading) return 0
    try {
      const r = await this.backend.changes(this.src, this.fields, this.select, this.maxId, this.lastSync)
      const now = new Date().toISOString()
      this.lastSync = now
      this.total = r.itemCount || this.total
      const ts = Date.now()
      const ev = (row: Row, kind: PulseEvent['kind']): PulseEvent => ({ at: ts, kind, id: row.__id, title: String(row[this.titleField] ?? row.Title ?? `#${row.__id}`), by: String(row.Editor ?? row.Author ?? '') || undefined })
      const fresh = r.added.filter((x) => !this.hasId(x.__id))
      for (const x of fresh) { x.__new = true; if (x.__id > this.maxId) this.maxId = x.__id }
      const changed = r.changed.filter((x) => !fresh.some((n) => n.__id === x.__id))
      this.pulse = [...fresh.map((x) => ev(x, 'new')), ...changed.map((x) => ev(x, 'changed')), ...this.pulse].slice(0, 60)
      if (this.mode === 'local') {
        this.all.push(...fresh)
        const idx = new Map(this.all.map((x, i) => [x.__id, i]))
        for (const c of changed) { const i = idx.get(c.__id); if (i != null) this.all[i] = c }
        resetHaystack(this.all)
        this.recompute()
      } else {
        this.pendingNew += fresh.length
        const idx = new Map(this.rows.map((x, i) => [x.__id, i]))
        let touched = false
        for (const c of changed) { const i = idx.get(c.__id); if (i != null) { this.rows[i] = c; touched = true } }
        if (touched || fresh.length) this.emit()
      }
      this.emit()
      return fresh.length + changed.length
    } catch { return 0 }
  }
  private hasId(id: number) { return (this.mode === 'local' ? this.all : this.rows).some((r) => r.__id === id) }

  /* ---------------------------------------------------------------- local edits (after the user saves / deletes) */
  patchRow(r: Row) {
    const swap = (list: Row[]) => { const i = list.findIndex((x) => x.__id === r.__id); if (i >= 0) list[i] = r }
    swap(this.all); swap(this.rows)
    if (this.mode === 'local') { resetHaystack([r]); this.recompute() } else this.emit()
  }
  removeRow(id: number) {
    this.all = this.all.filter((x) => x.__id !== id); this.rows = this.rows.filter((x) => x.__id !== id); this.total = Math.max(0, this.total - 1)
    if (this.mode === 'local') this.recompute(); else this.emit()
  }

  /** Show newly arrived rows in the server-mode grid. */
  absorbNew() { this.pendingNew = 0; void this.reset() }
}

export const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError'
export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
