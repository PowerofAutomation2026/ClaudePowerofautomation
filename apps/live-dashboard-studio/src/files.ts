/**
 * Files that live somewhere other than this computer, and how to notice when they change:
 *   web link   any https address (CSV / TSV / JSON / XLSX) that allows cross-origin reads; checked with ETag / Last-Modified
 *   sharepoint a file in a SharePoint library through the SharePoint connection of this app (Power Apps only)
 *   onedrive   a file in OneDrive for Business through its connection (Power Apps only)
 *   emulator   the test file share in apps/db-emulator (shaped like the connector file operations)
 * The dashboard asks for a cheap "signature" every few seconds and downloads the file only when it changed.
 */
import { emuBase, emuCall, emuHeaders } from './emulator'
import { normOp, readFile, sdkExecute, sdkOps } from './sources'
import type { FileRead } from './sources'
import type { Progress } from './engine'

export type FileLoc =
  | { via: 'url'; url: string }
  | { via: 'emulator'; url: string; path: string }
  | { via: 'sharepoint'; site: string; path: string }
  | { via: 'onedrive'; path: string }

export interface FileStat { name: string; signature: string; modified?: string; size?: number }

export const WATCH_CHOICES = [{ v: 2, t: 'Every 2 s' }, { v: 5, t: 'Every 5 s' }, { v: 10, t: 'Every 10 s' }, { v: 30, t: 'Every 30 s' }, { v: 60, t: 'Every minute' }, { v: 300, t: 'Every 5 min' }]

export const locLabel = (l: FileLoc): string =>
  l.via === 'url' ? l.url : l.via === 'emulator' ? `emulator files: ${l.path}` : l.via === 'sharepoint' ? `SharePoint: ${l.path}` : `OneDrive: ${l.path}`
const baseName = (p: string) => decodeURIComponent(p.split('?')[0].split('/').filter(Boolean).pop() ?? 'file')

/* ------------------------------------------------------------ connector files */
const FILE_DS: Record<'sharepoint' | 'onedrive', RegExp> = { sharepoint: /sharepoint/i, onedrive: /onedrive/i }
function fileOps(via: 'sharepoint' | 'onedrive') {
  const ops = sdkOps().filter((o) => FILE_DS[via].test(o.ds))
  const find = (...names: string[]) => ops.find((o) => names.includes(normOp(o.op)))
  const meta = find('getfilemetadatabypath', 'getfilemetadata', 'getfilemetadatav2')
  const content = find('getfilecontentbypath', 'getfilecontent', 'getfilecontentv2')
  if (!meta || !content) throw new Error(`This app has no ${via === 'sharepoint' ? 'SharePoint' : 'OneDrive for Business'} connection with the file operations "Get file metadata using path" and "Get file content using path". Re-run the deploy script with -${via === 'sharepoint' ? 'SharePoint' : 'OneDrive'} (see README), or use a web link.`)
  return { meta, content }
}
function toBytes(data: any): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const b64 = typeof data === 'string' ? data : data?.$content ?? data?.content ?? null
  if (typeof b64 === 'string') {
    try { const bin = atob(b64.replace(/^data:[^,]*,/, '')); return Uint8Array.from(bin, (c) => c.charCodeAt(0)) } catch { return new TextEncoder().encode(b64) }   // plain text content
  }
  throw new Error('The connector returned file content in a format this app does not understand.')
}
const metaStat = (m: any, name: string): FileStat => {
  const modified = m?.LastModified ?? m?.Modified ?? m?.TimeLastModified ?? m?.lastModifiedDateTime ?? m?.['{ModifiedDate}'] ?? ''
  const etag = m?.ETag ?? m?.eTag ?? m?.['{VersionNumber}'] ?? ''
  const size = m?.Size ?? m?.size
  return { name: m?.Name ?? m?.name ?? name, signature: `${etag}|${modified}|${size ?? ''}`, modified: String(modified), size: typeof size === 'number' ? size : undefined }
}

/* -------------------------------------------------------------------- stat */
export async function statFile(loc: FileLoc): Promise<FileStat> {
  if (loc.via === 'emulator') {
    const m = await emuCall(loc.url, `/files/metadata?path=${encodeURIComponent(loc.path)}`)
    return { name: m.Name, signature: `${m.ETag}`, modified: m.LastModified, size: m.Size }
  }
  if (loc.via === 'url') {
    const name = baseName(loc.url)
    try {
      const r = await fetch(loc.url, { method: 'HEAD', cache: 'no-store' })
      if (r.ok) {
        const sig = [r.headers.get('etag'), r.headers.get('last-modified'), r.headers.get('content-length')].filter(Boolean).join('|')
        if (sig) return { name, signature: sig, modified: r.headers.get('last-modified') ?? undefined, size: Number(r.headers.get('content-length')) || undefined }
      }
    } catch { /* HEAD blocked: fall back to a full read */ }
    const r = await fetch(loc.url, { cache: 'no-store' })
    if (!r.ok) throw new Error(`Cannot read ${loc.url} (HTTP ${r.status}). The address must allow cross-origin reads (CORS).`)
    const buf = new Uint8Array(await r.arrayBuffer())
    let h = 2166136261
    for (let i = 0; i < buf.length; i += Math.max(1, buf.length >> 14)) h = Math.imul(h ^ buf[i], 16777619)
    return { name, signature: `${buf.length}:${(h >>> 0).toString(16)}`, size: buf.length }
  }
  const { meta } = fileOps(loc.via)
  const m = await sdkExecute(meta, loc.via === 'sharepoint' ? { dataset: loc.site, path: loc.path } : { path: loc.path })
  return metaStat(m, baseName(loc.path))
}

/* -------------------------------------------------------------------- read */
export async function fetchFileAt(loc: FileLoc, sheet?: string, onProgress?: Progress): Promise<{ read: FileRead; stat: FileStat }> {
  onProgress?.(0.02, `Downloading ${locLabel(loc)}…`)
  let bytes: Uint8Array, stat: FileStat
  if (loc.via === 'emulator') {
    stat = await statFile(loc)
    const r = await fetch(`${emuBase(loc.url)}/files/content?path=${encodeURIComponent(loc.path)}`, { cache: 'no-store', headers: emuHeaders(loc.url) })
    if (!r.ok) throw new Error(`Cannot read ${loc.path} (HTTP ${r.status}).`)
    bytes = new Uint8Array(await r.arrayBuffer())
  } else if (loc.via === 'url') {
    const r = await fetch(loc.url, { cache: 'no-store' }).catch(() => { throw new Error(`Cannot reach ${loc.url}. The address must be reachable from this browser and allow cross-origin reads (CORS).`) })
    if (!r.ok) throw new Error(`Cannot read ${loc.url} (HTTP ${r.status}).`)
    bytes = new Uint8Array(await r.arrayBuffer())
    stat = { name: baseName(loc.url), signature: [r.headers.get('etag'), r.headers.get('last-modified'), r.headers.get('content-length')].filter(Boolean).join('|') || `${bytes.length}`, modified: r.headers.get('last-modified') ?? undefined, size: bytes.length }
  } else {
    const { content } = fileOps(loc.via)
    stat = await statFile(loc)
    bytes = toBytes(await sdkExecute(content, loc.via === 'sharepoint' ? { dataset: loc.site, path: loc.path, inferContentType: true } : { path: loc.path }))
  }
  const file = new File([bytes as BlobPart], stat.name || baseName(loc.via === 'url' ? loc.url : loc.path))
  return { read: await readFile(file, sheet, onProgress), stat }
}
