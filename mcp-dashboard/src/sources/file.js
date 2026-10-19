import { readFile, stat } from 'node:fs/promises';
import { parseCsv, normalizeRows, MAX_ROWS } from './rows.js';

const MAX_BYTES = 50 * 1024 * 1024;

/** csv / excel from a local path or http(s) URL. Skips re-download/re-parse when the file is unchanged. */
export function fileProvider(kind) {
  const cache = new Map(); // location -> { stamp, rows }

  async function load(cfg) {
    const loc = cfg.location;
    if (!loc) throw new Error('"location" is required');
    let buf, stamp;
    if (/^https?:\/\//i.test(loc)) {
      const prev = cache.get(loc);
      const headers = { ...(cfg.headers ?? {}) };
      if (prev?.etag) headers['if-none-match'] = prev.etag; else if (prev?.lastModified) headers['if-modified-since'] = prev.lastModified;
      const res = await fetch(loc, { headers, signal: AbortSignal.timeout(30_000), redirect: 'follow' });
      if (res.status === 304 && prev) return prev.rows;
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('file is larger than 50 MB');
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error('file is larger than 50 MB');
      stamp = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    } else {
      const st = await stat(loc);
      if (st.size > MAX_BYTES) throw new Error('file is larger than 50 MB');
      const key = `${st.mtimeMs}:${st.size}`;
      const prev = cache.get(loc);
      if (prev?.key === key) return prev.rows;
      buf = await readFile(loc);
      stamp = { key };
    }
    const rows = kind === 'csv' ? parseCsv(buf.toString('utf8')) : await readExcel(buf, cfg.sheet);
    cache.set(loc, { ...stamp, rows });
    return rows;
  }
  return { fetch: async (cfg) => load(cfg) };
}

async function readExcel(buf, sheet) {
  let ExcelJS;
  try { ({ default: ExcelJS } = await import('exceljs')); } catch { throw new Error('Excel support needs the optional dependency: npm install exceljs'); }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = sheet ? wb.getWorksheet(sheet) : wb.worksheets[0];
  if (!ws) throw new Error(`sheet "${sheet}" not found (available: ${wb.worksheets.map((w) => w.name).join(', ')})`);
  const rows = [];
  let head;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = row.values.slice(1);
    if (!head) {
      const seen = new Set();
      head = vals.map((h, i) => { let n = String(h?.text ?? h?.result ?? h ?? '').trim() || `col_${i + 1}`; while (seen.has(n)) n += '_'; seen.add(n); return n; });
      return;
    }
    if (rows.length < MAX_ROWS) rows.push(Object.fromEntries(head.map((h, i) => [h, vals[i] ?? null])));
  });
  return normalizeRows(rows);
}
