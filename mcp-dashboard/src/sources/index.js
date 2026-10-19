import { readFileSync, existsSync } from 'node:fs';
import { fileProvider } from './file.js';
import { sqlServerProvider, oracleProvider, assertReadOnly } from './sql.js';
import { flowProvider } from './flow.js';

const TYPES = ['csv', 'excel', 'sqlserver', 'oracle', 'powerautomate'];
const SQL_TYPES = ['sqlserver', 'oracle'];

/** Replace "env:NAME" strings with process.env.NAME so secrets stay out of the config file. */
function resolveEnv(v) {
  if (typeof v === 'string' && v.startsWith('env:')) {
    const val = process.env[v.slice(4)];
    if (val === undefined) throw new Error(`environment variable ${v.slice(4)} is not set`);
    return val;
  }
  if (Array.isArray(v)) return v.map(resolveEnv);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveEnv(x)]));
  return v;
}

export class Registry {
  /** @param config {sources:{[name]:{type,...}}, pollWithoutViewers?:boolean} */
  constructor(config = {}, providers = {}) {
    this.config = config;
    this.pollWithoutViewers = !!config.pollWithoutViewers;
    this.sources = config.sources ?? {};
    for (const [name, s] of Object.entries(this.sources)) {
      if (!TYPES.includes(s.type)) throw new Error(`data source "${name}": type must be one of ${TYPES.join(', ')}`);
      if (SQL_TYPES.includes(s.type) && !Object.keys(s.queries ?? {}).length) throw new Error(`data source "${name}" needs at least one entry in "queries"`);
      if (SQL_TYPES.includes(s.type)) for (const [q, text] of Object.entries(s.queries)) {
        try { assertReadOnly(text); } catch (e) { throw new Error(`data source "${name}", query "${q}": ${e.message}`); }
      }
    }
    this.providers = {
      csv: fileProvider('csv'), excel: fileProvider('excel'),
      sqlserver: sqlServerProvider(), oracle: oracleProvider(), powerautomate: flowProvider(),
      ...providers,
    };
  }

  static fromFile(file) {
    if (!file || !existsSync(file)) return new Registry({});
    return new Registry(JSON.parse(readFileSync(file, 'utf8')));
  }

  has(name) { return name in this.sources; }

  refreshSeconds(name) { return Math.max(5, Number(this.sources[name]?.refreshSeconds ?? 60)); }

  /** What an agent may see: names, types and query names. Never connection details. */
  list() {
    return Object.entries(this.sources).map(([name, s]) => ({
      name, type: s.type, description: s.description ?? '',
      queries: SQL_TYPES.includes(s.type) || s.type === 'powerautomate' ? Object.keys(s.queries ?? {}) : undefined,
      refreshSeconds: this.refreshSeconds(name),
    }));
  }

  async fetchRows(name, queryName) {
    const s = this.sources[name];
    if (!s) throw new Error(`Unknown data source "${name}". Available: ${Object.keys(this.sources).join(', ') || 'none configured'}`);
    let queryText;
    if (SQL_TYPES.includes(s.type) || (s.type === 'powerautomate' && s.queries)) {
      const names = Object.keys(s.queries ?? {});
      queryName ??= names.length === 1 ? names[0] : undefined;
      if (!queryName || !(queryName in (s.queries ?? {}))) throw new Error(`"query" must be one of: ${names.join(', ')}`);
      queryText = s.queries[queryName];
    }
    const cfg = { ...resolveEnv({ ...s, queries: undefined }), __name: name };
    try {
      return await this.providers[s.type].fetch(cfg, queryText, queryName);
    } catch (e) {
      throw new Error(`${name}: ${String(e.message).slice(0, 300)}`);
    }
  }
}
