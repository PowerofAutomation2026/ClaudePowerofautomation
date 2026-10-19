import { toNum } from './sources/rows.js';

export const AGGS = ['sum', 'avg', 'min', 'max', 'count', 'first', 'last'];
const round = (n) => Math.round(n * 100) / 100;

/** Case-insensitive column lookup with a helpful error. */
function col(rows, name) {
  if (name == null) return null;
  const cols = Object.keys(rows[0] ?? {});
  const hit = cols.find((c) => c === name) ?? cols.find((c) => c.toLowerCase() === String(name).toLowerCase());
  if (!hit && rows.length) throw new Error(`column "${name}" not found. Columns: ${cols.join(', ')}`);
  return hit ?? name;
}

function aggregate(rows, column, agg) {
  if (agg === 'count') return column ? rows.filter((r) => r[column] != null).length : rows.length;
  if (!rows.length) return null;
  if (agg === 'first') return rows[0][column];
  if (agg === 'last') return rows[rows.length - 1][column];
  const nums = rows.map((r) => toNum(r[column])).filter(Number.isFinite);
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return round(agg === 'sum' ? sum : agg === 'avg' ? sum / nums.length : agg === 'min' ? Math.min(...nums) : Math.max(...nums));
}

/**
 * Turn rows into the static widget fields the store understands.
 * binding: { type, column, agg, label, values[], group, sort, limit, columns[], order_by, desc }
 */
export function compute(type, b, rows) {
  if (type === 'kpi') {
    const agg = b.agg ?? (b.column ? 'sum' : 'count');
    const c = b.column ? col(rows, b.column) : null;
    const v = aggregate(rows, c, agg);
    return { value: v ?? '–' };
  }

  if (type === 'table') {
    const all = Object.keys(rows[0] ?? {});
    const cols = (b.columns?.length ? b.columns.map((c) => col(rows, c)) : all).slice(0, 12);
    let r = rows;
    if (b.order_by) {
      const oc = col(rows, b.order_by);
      r = [...rows].sort((x, y) => {
        const a = toNum(x[oc]), z = toNum(y[oc]);
        const d = Number.isFinite(a) && Number.isFinite(z) ? a - z : String(x[oc] ?? '').localeCompare(String(y[oc] ?? ''), undefined, { numeric: true });
        return b.desc ? -d : d;
      });
    }
    return { columns: cols, rows: r.slice(0, Math.min(b.limit ?? 50, 500)).map((x) => cols.map((c) => x[c] ?? '')) };
  }

  // line | bar | pie
  if (!b.label) throw new Error('"label" (the column for the x-axis / slice names) is required for charts');
  const lc = col(rows, b.label);
  const vcols = (b.values?.length ? b.values : b.column ? [b.column] : []).map((c) => col(rows, c));
  const agg = b.agg ?? (vcols.length ? 'sum' : 'count');
  const group = b.group !== false;
  let labels, series;
  if (group) {
    const groups = new Map();
    for (const r of rows) { const k = String(r[lc] ?? '(blank)'); (groups.get(k) ?? groups.set(k, []).get(k)).push(r); }
    labels = [...groups.keys()];
    series = (vcols.length ? vcols : [null]).map((c) => ({ name: c ?? 'Count', values: labels.map((k) => aggregate(groups.get(k), c, agg)) }));
  } else {
    labels = rows.map((r) => String(r[lc] ?? ''));
    series = (vcols.length ? vcols : []).map((c) => ({ name: c, values: rows.map((r) => { const n = toNum(r[c]); return Number.isFinite(n) ? n : null; }) }));
    if (!series.length) throw new Error('"values" columns are required when group is false');
  }

  const sort = b.sort ?? (type === 'line' ? 'label' : type === 'pie' ? 'value_desc' : 'none');
  let idx = labels.map((_, i) => i);
  if (sort === 'label') idx.sort((x, y) => labels[x].localeCompare(labels[y], undefined, { numeric: true }));
  else if (sort === 'value_desc') idx.sort((x, y) => (series[0].values[y] ?? -Infinity) - (series[0].values[x] ?? -Infinity));
  else if (sort === 'value_asc') idx.sort((x, y) => (series[0].values[x] ?? Infinity) - (series[0].values[y] ?? Infinity));
  idx = idx.slice(0, Math.min(b.limit ?? (type === 'pie' ? 8 : 30), 500));
  // keep time series chronological when a "limit" cuts the tail: take the newest points
  if (sort === 'label' && type === 'line' && (b.limit ?? 30) < labels.length) idx = [...labels.keys()].sort((x, y) => labels[x].localeCompare(labels[y], undefined, { numeric: true })).slice(-Math.min(b.limit ?? 30, 500));
  return { labels: idx.map((i) => labels[i]), series: series.map((s) => ({ name: s.name, values: idx.map((i) => s.values[i]) })) };
}
