/** Per-user inventory report: CSV (Excel-ready) and a hand-built PDF (no libraries, works inside Power Apps). */
import type { Asset, AssetKind, Person } from './types'

export interface ReportRow { Type: string; Name: string; Id: string; Created: string; Environment: string; EnvironmentId: string; Owner: string; State: string }

const LABEL: Record<AssetKind, string> = { app: 'App', flow: 'Cloud flow', agent: 'Agent' }
const fmt = (iso?: string) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '') : '')

export const reportRows = (assets: Asset[]): ReportRow[] =>
  [...assets].sort((a, b) => a.ownerEmail.localeCompare(b.ownerEmail) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).map((a) => ({
    Type: LABEL[a.kind], Name: a.name, Id: a.id, Created: fmt(a.createdTime), Environment: a.envName, EnvironmentId: a.envId, Owner: a.ownerEmail, State: a.state,
  }))

const q = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
export function reportCsv(assets: Asset[]): string {
  const rows = reportRows(assets)
  const cols: (keyof ReportRow)[] = ['Type', 'Name', 'Id', 'Created', 'Environment', 'EnvironmentId', 'Owner', 'State']
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n') + '\r\n'
}

type RGB = [number, number, number]
const KIND_RGB: Record<string, RGB> = { App: [0.224, 0.529, 0.898], 'Cloud flow': [0.851, 0.349, 0.149], Agent: [0.098, 0.620, 0.439] }
const INK: RGB = [0.11, 0.12, 0.2]
const MUTED: RGB = [0.45, 0.47, 0.56]

export interface ReportGroup { user: Person; assets: Asset[] }

export function reportPdf(user: Person, assets: Asset[], build: string): Uint8Array<ArrayBuffer> {
  return reportPdfMulti([{ user, assets }], build)
}

/** One PDF, one section per user. */
export function reportPdfMulti(groups: ReportGroup[], build: string): Uint8Array<ArrayBuffer> {
  const W = 842, H = 595, M = 40
  const counts = { App: 0, 'Cloud flow': 0, Agent: 0 } as Record<string, number>
  const sections = groups.map((g) => ({ user: g.user, rows: reportRows(g.assets) }))
  sections.forEach((s) => s.rows.forEach((r) => { counts[r.Type] = (counts[r.Type] ?? 0) + 1 }))
  const esc = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1')
  const col = (c: RGB) => `${c[0]} ${c[1]} ${c[2]}`
  const rect = (x: number, y: number, w: number, h: number, c: RGB) => `${col(c)} rg ${x} ${y} ${w} ${h} re f\n`
  const text = (x: number, y: number, size: number, bold: boolean, s: string, c: RGB) => `BT /${bold ? 'F2' : 'F1'} ${size} Tf ${col(c)} rg ${x} ${y} Td (${esc(s)}) Tj ET\n`
  const fit = (s: string, width: number, size: number) => { const max = Math.max(1, Math.floor(width / (size * 0.52))); return s.length > max ? s.slice(0, max - 1) + '~' : s }

  const cols: { k: keyof ReportRow; label: string; w: number }[] = [
    { k: 'Type', label: 'TYPE', w: 56 }, { k: 'Name', label: 'NAME', w: 150 }, { k: 'Id', label: 'ID', w: 178 },
    { k: 'Created', label: 'CREATED', w: 84 }, { k: 'Environment', label: 'ENVIRONMENT', w: 96 }, { k: 'EnvironmentId', label: 'ENVIRONMENT ID', w: 178 },
  ]
  const ROW = 17
  const title = groups.length === 1 ? groups[0]!.user.name : `${groups.length} users`
  const sub = groups.length === 1 ? `${groups[0]!.user.name}  <${groups[0]!.user.email}>` : groups.map((g) => g.user.email).join(', ')
  const pages: string[] = []
  let cur = ''
  let y = 0
  const tableHead = () => {
    cur += rect(M - 6, y - 5, W - 2 * M + 12, ROW, [0.93, 0.93, 0.98])
    let x = M
    for (const c of cols) { cur += text(x, y, 7, true, c.label, INK); x += c.w }
    y -= ROW
  }
  const pageHeader = (first: boolean) => {
    const hh = first ? 92 : 40
    cur = rect(0, H - hh, W, hh, [0.17, 0.14, 0.45]) + rect(0, H - hh, 8, hh, [0.4, 0.35, 1])
    if (first) {
      cur += text(M, H - 38, 20, true, 'Ownership report', [1, 1, 1])
      cur += text(M, H - 58, 10, false, fit(sub, 470, 10), [0.85, 0.86, 1])
      cur += text(M, H - 76, 8, false, `Generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC  |  Ownership Command Center ${build}`, [0.7, 0.72, 0.95])
      let x = W - M - 3 * 110
      for (const k of ['App', 'Cloud flow', 'Agent']) {
        cur += rect(x, H - 80, 100, 54, KIND_RGB[k]!) + text(x + 10, H - 52, 20, true, String(counts[k] ?? 0), [1, 1, 1]) + text(x + 10, H - 70, 8, true, k.toUpperCase() + 'S', [1, 1, 1])
        x += 110
      }
      y = H - hh - 28
    } else {
      cur += text(M, H - 25, 11, true, `Ownership report - ${title}`, [1, 1, 1])
      y = H - hh - 28
    }
  }
  pageHeader(true)
  sections.forEach((s, si) => {
    if (groups.length > 1) {
      if (y < 110) { pages.push(cur); pageHeader(false) }
      cur += rect(M - 6, y - 8, W - 2 * M + 12, 24, [0.88, 0.86, 1]) + rect(M - 6, y - 8, 4, 24, [0.4, 0.35, 1])
      const n = (k: string) => s.rows.filter((r) => r.Type === k).length
      cur += text(M + 4, y + 2, 10, true, `${s.user.name}  <${s.user.email}>`, INK) + text(W - M - 230, y + 2, 8, true, `${n('App')} apps  |  ${n('Cloud flow')} flows  |  ${n('Agent')} agents`, MUTED)
      y -= 30
    }
    tableHead()
    s.rows.forEach((r, i) => {
      if (y < 46) { pages.push(cur); pageHeader(false); tableHead() }
      if (i % 2 === 1) cur += rect(M - 6, y - 5, W - 2 * M + 12, ROW, [0.975, 0.975, 0.99])
      let x = M
      for (const c of cols) {
        const v = r[c.k]
        const small = c.k === 'Id' || c.k === 'EnvironmentId'
        if (c.k === 'Type') cur += rect(x, y - 3.5, 48, 11.5, KIND_RGB[r.Type] ?? INK) + text(x + 4, y, 6.5, true, r.Type === 'Cloud flow' ? 'FLOW' : r.Type.toUpperCase(), [1, 1, 1])
        else cur += text(x, y, small ? 6.5 : 7.5, c.k === 'Name', fit(v, c.w - 6, small ? 6.5 : 7.5), c.k === 'Name' ? INK : MUTED)
        x += c.w
      }
      y -= ROW
    })
    if (!s.rows.length) { cur += text(M, y, 9, false, 'No items match for this user.', MUTED); y -= ROW }
    if (si < sections.length - 1) y -= 14
  })
  pages.push(cur)
  const total = pages.length
  const streams = pages.map((p, i) => p + text(W - M - 70, 22, 7, false, `Page ${i + 1} of ${total}`, MUTED) + text(M, 22, 7, false, 'Environment IDs are the Power Platform environment GUIDs. Created = creation time reported by the service.', MUTED))

  const objs: string[] = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${streams.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${total} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  streams.forEach((s, i) => {
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
    objs[6 + i * 2] = `<< /Length ${s.length} >>\nstream\n${s}endstream`
  })
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let n = 1; n < objs.length; n++) { offsets[n] = pdf.length; pdf += `${n} 0 obj\n${objs[n]}\nendobj\n` }
  const xref = pdf.length
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const out = new Uint8Array(new ArrayBuffer(pdf.length))
  for (let i = 0; i < pdf.length; i++) out[i] = pdf.charCodeAt(i) & 0xff
  return out
}

export function saveBlob(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
