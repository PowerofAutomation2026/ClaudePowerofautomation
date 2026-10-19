import { readFileSync, existsSync } from 'node:fs';
import { fileProvider } from './file.js';
import { sqlServerProvider, oracleProvider, assertReadOnly } from './sql.js';
import { flowProvider } from './flow.js';
import { planBinding, sampleQuery } from './sqlbuilder.js';

const pick = (row, key) => row[Object.keys(row).find((k) => k.toLowerCase() === key)];
const ORA_SYS = "'SYS','SYSTEM','XDB','MDSYS','CTXSYS','WMSYS','OUTLN','DBSNMP','APPQOSSYS','ORDSYS','ORDDATA','LBACSYS','DVSYS','GSMADMIN_INTERNAL','AUDSYS','OJVMSYS','DBSFWUSER'";
const CATALOG = {
  sqlserver: {
    tables: 'SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, TABLE_TYPE AS kind FROM INFORMATION_SCHEMA.TABLES',
    columns: 'SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @p1 AND TABLE_NAME = @p2 ORDER BY ORDINAL_POSITION',
  },
  oracle: {
    tables: `SELECT owner AS schema_name, table_name AS table_name, 'BASE TABLE' AS kind FROM all_tables WHERE owner NOT IN (${ORA_SYS}) UNION ALL SELECT owner, view_name, 'VIEW' FROM all_views WHERE owner NOT IN (${ORA_SYS})`,
    columns: 'SELECT column_name AS column_name, data_type AS data_type FROM all_tab_columns WHERE owner = :p1 AND table_name = :p2 ORDER BY column_id',
  },
};
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
    this.catalogCache = new Map();
    for (const [name, s] of Object.entries(this.sources)) {
      if (!TYPES.includes(s.type)) throw new Error(`data source "${name}": type must be one of ${TYPES.join(', ')}`);
      if (SQL_TYPES.includes(s.type) && !Object.keys(s.queries ?? {}).length && !s.discover?.include?.length) throw new Error(`data source "${name}" needs "queries" and/or "discover": {"include": [...]}`);
      if (SQL_TYPES.includes(s.type)) for (const [q, text] of Object.entries(s.queries ?? {})) {
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
      tableDiscovery: SQL_TYPES.includes(s.type) ? this.discoverable(name) : undefined,
      refreshSeconds: this.refreshSeconds(name),
    }));
  }

  // ---- dynamic discovery (SQL Server / Oracle) --------------------------------------------------------------
  discoverable(name) { const s = this.sources[name]; return !!s && SQL_TYPES.includes(s.type) && Array.isArray(s.discover?.include) && s.discover.include.length > 0; }

  async runRaw(name, sqlText, params) {
    const s = this.sources[name];
    const cfg = { ...resolveEnv({ ...s, queries: undefined }), __name: name };
    try { return await this.providers[s.type].fetch(cfg, sqlText, undefined, params); } catch (e) { throw new Error(`${name}: ${String(e.message).slice(0, 300)}`); }
  }

  allowed(name, schema, table) {
    const d = this.sources[name].discover;
    const glob = (g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
    const full = `${schema}.${table}`;
    return d.include.some((g) => glob(g).test(full)) && !(d.exclude ?? []).some((g) => glob(g).test(full));
  }

  async tables(name) {
    if (!this.discoverable(name)) throw new Error(`Table discovery is not enabled for "${name}". The admin must add "discover": {"include": ["dbo.*"]} to this source.`);
    const hit = this.catalogCache.get(name);
    if (hit && Date.now() - hit.at < 300_000) return hit.tables;
    const dialect = this.sources[name].type;
    const rows = await this.runRaw(name, CATALOG[dialect].tables);
    const tables = rows.map((r) => ({ schema: pick(r, 'schema_name'), name: pick(r, 'table_name'), kind: pick(r, 'kind') }))
      .filter((t) => this.allowed(name, t.schema, t.name)).sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
    this.catalogCache.set(name, { at: Date.now(), tables });
    return tables;
  }

  async tableInfo(name, ref) {
    const tables = await this.tables(name);
    const [a, b] = String(ref).split('.');
    const hits = tables.filter((t) => (b === undefined ? t.name.toLowerCase() === a.toLowerCase() : t.schema.toLowerCase() === a.toLowerCase() && t.name.toLowerCase() === b.toLowerCase()));
    if (!hits.length) throw new Error(`Table "${ref}" is not available. Call list_tables to see allowed tables.`);
    if (hits.length > 1) throw new Error(`"${ref}" is ambiguous; use schema.table (${hits.map((t) => `${t.schema}.${t.name}`).join(', ')})`);
    const t = hits[0];
    const key = `${name}:${t.schema}.${t.name}`;
    const cached = this.catalogCache.get(key);
    if (cached && Date.now() - cached.at < 300_000) return cached.info;
    const cols = await this.runRaw(name, CATALOG[this.sources[name].type].columns, { p1: t.schema, p2: t.name });
    const info = { ...t, columns: cols.map((c) => ({ name: pick(c, 'column_name'), type: String(pick(c, 'data_type')) })) };
    this.catalogCache.set(key, { at: Date.now(), info });
    return info;
  }

  async describeTable(name, ref) {
    const info = await this.tableInfo(name, ref);
    const q = sampleQuery(this.sources[name].type, info);
    return { table: `${info.schema}.${info.name}`, kind: info.kind, columns: info.columns, sample: await this.runRaw(name, q.sql, q.params) };
  }

  /** Run a structured (table-based) binding. Returns the rows plus how to read them. */
  async fetchPlanned(name, type, binding) {
    const info = await this.tableInfo(name, binding.table);
    const plan = planBinding(this.sources[name].type, type, binding, info);
    return { rows: await this.runRaw(name, plan.sql, plan.params), resultBinding: plan.resultBinding };
  }

  async fetchRows(name, queryName) {
    const s = this.sources[name];
    if (!s) throw new Error(`Unknown data source "${name}". Available: ${Object.keys(this.sources).join(', ') || 'none configured'}`);
    let queryText;
    if (SQL_TYPES.includes(s.type) || (s.type === 'powerautomate' && s.queries)) {
      const names = Object.keys(s.queries ?? {});
      queryName ??= names.length === 1 ? names[0] : undefined;
      if (!names.length && this.discoverable(name)) throw new Error(`"${name}" has no named queries. Use list_tables / describe_table, then bind_widget with "table".`);
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
