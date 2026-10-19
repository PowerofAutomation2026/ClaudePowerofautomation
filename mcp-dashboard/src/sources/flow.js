import { normalizeRows } from './rows.js';

/**
 * Power Platform route: an HTTP-triggered Power Automate flow runs the SQL Server / Oracle / Excel Online / SharePoint
 * connector (through the on-premises data gateway if needed) and returns the rows as JSON in a Response action.
 * We POST {"query": "<name>"} so one flow can serve several datasets.
 */
export function flowProvider() {
  return {
    async fetch(cfg, _text, queryName) {
      if (!cfg.url) throw new Error('"url" is required');
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body: JSON.stringify({ query: queryName ?? null }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`flow returned HTTP ${res.status}`);
      const json = await res.json();
      const rows = Array.isArray(json) ? json : json?.value ?? json?.rows ?? json?.data;
      if (!Array.isArray(rows)) throw new Error('flow must return a JSON array of objects (or {"value":[...]})');
      return normalizeRows(rows.filter((r) => r && typeof r === 'object'));
    },
  };
}
