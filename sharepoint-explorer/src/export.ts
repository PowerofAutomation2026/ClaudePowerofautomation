/** CSV / JSON / PDF export. Big exports stream page by page straight to disk when the browser allows it. */
import type { Engine } from './engine'
import { BULK } from './engine'
import { emptyQuery } from './query'
import type { Row, SpField } from './types'
import { cellText, download, fmt, rawText, safeName, yieldToUi } from './util'
import type { Aggregator, Insight } from './aggregate'

export type ExportFormat = 'csv' | 'json' | 'pdf'
export type ExportScope = 'view' | 'selected' | 'all'
export const PDF_MAX_ROWS = 5000
export const EXPORT_MAX_ROWS = 5_000_000

export interface ExportJob {
  format: ExportFormat
  scope: ExportScope
  engine: Engine
  columns: SpField[]
  selected: Set<number>
  title: string
  filterText: string
  onProgress: (done: number) => void
  signal: AbortSignal
}

/** Guards against spreadsheet formula injection (=, +, -, @ at the start of a cell). */
const csvCell = (s: string) => {
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function* rowSource(job: ExportJob): AsyncGenerator<Row[]> {
  const { engine, scope } = job
  if (scope === 'selected') { yield engine.rows.filter((r) => job.selected.has(r.__id)); return }
  if (scope === 'view' || engine.mode === 'local') { for (let i = 0; i < engine.rows.length; i += BULK) yield engine.rows.slice(i, i + BULK); return }
  // whole filtered list from the server, in ID order (keyset paging: safe at any size)
  let cursor: string | undefined
  const q = { ...engine.q, sort: { ...emptyQuery().sort, dir: 'asc' as const } }
  for (;;) {
    const page = await engine.backend.query(engine.src, engine.fields, engine.select, q, BULK, cursor, job.signal)
    yield page.rows
    cursor = page.cursor
    if (!cursor) return
  }
}

async function openSink(name: string, mime: string, ext: string) {
  const w = window as any
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: `${name}.${ext}`, types: [{ description: ext.toUpperCase(), accept: { [mime]: [`.${ext}`] } }] })
      const ws = await h.createWritable()
      return { memory: false, write: (s: string) => ws.write(s), close: () => ws.close(), abort: () => ws.abort().catch(() => {}) }
    } catch (e) { if ((e as Error).name === 'AbortError') throw e /* user cancelled the dialog */ }
  }
  const parts: BlobPart[] = []
  let buf = ''
  return {
    memory: true,
    write: async (s: string) => { buf += s; if (buf.length > 1_000_000) { parts.push(new Blob([buf])); buf = '' } },
    close: async () => { parts.push(new Blob([buf])); download(new Blob(parts, { type: mime }), `${name}.${ext}`) },
    abort: async () => { parts.length = 0 },
  }
}

export async function runExport(job: ExportJob): Promise<{ rows: number; note?: string }> {
  const name = safeName(`${job.title}-${new Date().toISOString().slice(0, 10)}`)
  if (job.format === 'pdf') return exportPdf(job, name)
  const csv = job.format === 'csv'
  const sink = await openSink(name, csv ? 'text/csv' : 'application/json', job.format)
  let n = 0
  try {
    if (csv) await sink.write('﻿' + job.columns.map((c) => csvCell(c.title)).join(',') + '\r\n')
    else await sink.write('[\n')
    for await (const chunk of rowSource(job)) {
      let out = ''
      for (const r of chunk) {
        if (n >= (sink.memory ? 250_000 : EXPORT_MAX_ROWS)) break   // no disk streaming in this browser: everything is held in memory
        if (csv) out += job.columns.map((c) => csvCell(rawText(c, r))).join(',') + '\r\n'
        else {
          const o: Record<string, unknown> = { ID: r.__id }
          for (const c of job.columns) o[c.title] = r[c.internal] ?? null
          out += (n ? ',\n' : '') + JSON.stringify(o)
        }
        n++
      }
      await sink.write(out)
      job.onProgress(n)
      if (job.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await yieldToUi()
    }
    if (!csv) await sink.write('\n]\n')
    await sink.close()
    return { rows: n }
  } catch (e) { await sink.abort(); throw e }
}

/* ------------------------------------------------------------------ PDF */

async function exportPdf(job: ExportJob, name: string): Promise<{ rows: number; note?: string }> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 28
  const cols = job.columns.slice(0, 10)
  // column widths proportional to typical content length (sampled)
  const sample = job.engine.rows.slice(0, 200)
  const weight = cols.map((c) => Math.min(40, Math.max(6, c.title.length, ...sample.map((r) => cellText(c, r).length)) ** 0.85))
  const sum = weight.reduce((a, b) => a + b, 0)
  const widths = weight.map((w) => ((W - 2 * M) * w) / sum)
  const rowH = 17
  let y = 0, page = 0

  const header = () => {
    page++
    doc.setFillColor(15, 76, 129); doc.rect(0, 0, W, 44, 'F')
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(job.title, M, 28)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    doc.text(`Exported ${new Date().toLocaleString()}`, W - M, 28, { align: 'right' })
    doc.setTextColor(60)
    let x = M; y = 62
    if (job.filterText) { doc.text(`Filters: ${job.filterText}`.slice(0, 180), M, y); y += 14 }
    doc.setFillColor(232, 238, 246); doc.rect(M, y - 11, W - 2 * M, rowH, 'F')
    doc.setFont('helvetica', 'bold'); doc.setTextColor(20)
    cols.forEach((c, i) => { doc.text(fit(doc, c.title, widths[i] - 6), x + 3, y); x += widths[i] })
    doc.setFont('helvetica', 'normal'); y += rowH
  }
  const footer = () => { doc.setFontSize(8); doc.setTextColor(120); doc.text(`Page ${page}`, W - M, H - 14, { align: 'right' }) }

  header()
  doc.setFontSize(8)
  let n = 0, truncated = false
  outer: for await (const chunk of rowSource({ ...job, scope: job.scope === 'all' && job.engine.mode === 'server' ? 'view' : job.scope })) {
    for (const r of chunk) {
      if (n >= PDF_MAX_ROWS) { truncated = true; break outer }
      if (y > H - 30) { footer(); doc.addPage(); header(); doc.setFontSize(8) }
      if (n % 2) { doc.setFillColor(247, 249, 252); doc.rect(M, y - 11, W - 2 * M, rowH, 'F') }
      doc.setTextColor(30)
      let x = M
      cols.forEach((c, i) => { doc.text(fit(doc, cellText(c, r), widths[i] - 6), x + 3, y); x += widths[i] })
      y += rowH; n++
      if (n % 200 === 0) { job.onProgress(n); await yieldToUi(); if (job.signal.aborted) throw new DOMException('Aborted', 'AbortError') }
    }
  }
  footer()
  doc.save(`${name}.pdf`)
  return { rows: n, note: truncated || (job.scope === 'all' && job.engine.mode === 'server') ? `PDF is limited to ${fmt(PDF_MAX_ROWS)} rows - use CSV or JSON for the full data set.` : undefined }
}

function fit(doc: import('jspdf').jsPDF, s: string, w: number): string {
  s = s.replace(/[\r\n]+/g, ' ')
  if (doc.getTextWidth(s) <= w) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (doc.getTextWidth(s.slice(0, mid) + '…') <= w) lo = mid; else hi = mid - 1 }
  return s.slice(0, lo) + '…'
}

/** One-page dashboard report: KPIs, bars for the main categories, and the generated insights. */
export async function exportDashboardPdf(title: string, scope: string, kpis: { label: string; value: string }[], charts: { title: string; data: { label: string; value: number }[] }[], notes: Insight[]) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 36
  let y = 0
  const head = () => { doc.setFillColor(15, 76, 129); doc.rect(0, 0, W, 56, 'F'); doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text(title, M, 34); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(`Dashboard report · ${scope} · ${new Date().toLocaleString()}`, M, 48); y = 84 }
  head()
  const kw = (W - 2 * M) / Math.max(1, kpis.length)
  kpis.forEach((k, i) => { doc.setTextColor(15, 76, 129); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text(k.value, M + i * kw, y); doc.setTextColor(100); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text(k.label, M + i * kw, y + 12) })
  y += 40
  for (const c of charts) {
    const need = 24 + c.data.length * 16
    if (y + need > H - 40) { doc.addPage(); head() }
    doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(c.title, M, y); y += 14
    const max = Math.max(1, ...c.data.map((d) => d.value))
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    for (const d of c.data) {
      doc.setTextColor(50); doc.text(fit(doc, d.label, 110), M, y + 8)
      doc.setFillColor(15, 76, 129); doc.rect(M + 120, y, Math.max(1, (d.value / max) * (W - 2 * M - 200)), 10, 'F')
      doc.setTextColor(80); doc.text(fmt(d.value), M + 126 + (d.value / max) * (W - 2 * M - 200), y + 8)
      y += 16
    }
    y += 12
  }
  if (y + 30 > H - 40) { doc.addPage(); head() }
  doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('Insights', M, y); y += 14
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  for (const n of notes) {
    const lines = doc.splitTextToSize(`${n.level === 'warn' ? '! ' : '• '}${n.text}`, W - 2 * M) as string[]
    if (y + lines.length * 12 > H - 30) { doc.addPage(); head() }
    doc.setTextColor(n.level === 'warn' ? 160 : 50, n.level === 'warn' ? 60 : 50, n.level === 'warn' ? 0 : 50)
    doc.text(lines, M, y); y += lines.length * 12 + 4
  }
  doc.save(`${safeName(title)}-dashboard.pdf`)
}
export type { Aggregator }
