// Shared helpers for turning provider output into plain, JSON-safe rows.
export const MAX_ROWS = Number(process.env.MAX_SOURCE_ROWS ?? 50_000);

export function cell(v) {
  if (v == null) return null;
  if (v instanceof Date) { const s = v.toISOString(); return s.endsWith('T00:00:00.000Z') ? s.slice(0, 10) : s; }
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'object') {
    if (Buffer.isBuffer(v)) return '[binary]';
    if ('result' in v) return cell(v.result);          // Excel formula cell
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);            // Excel hyperlink cell
    return JSON.stringify(v);
  }
  return v;
}

export const normalizeRows = (rows) => rows.slice(0, MAX_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)])));

/** "1,234.5", "$12", "45%" -> number; anything else -> NaN. */
export function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const s = v.replace(/[$€£,%\s]/g, '');
  return s === '' ? NaN : Number(s);
}

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((x) => x !== '')) out.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((x) => x !== '')) out.push(row);
  if (!out.length) return [];
  const seen = new Set();
  const head = out[0].map((h, i) => { let n = h.trim() || `col_${i + 1}`; while (seen.has(n)) n += '_'; seen.add(n); return n; });
  return out.slice(1, MAX_ROWS + 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] === undefined || r[i] === '' ? null : r[i]])));
}
