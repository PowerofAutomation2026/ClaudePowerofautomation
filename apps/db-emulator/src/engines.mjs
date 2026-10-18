import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export const ENGINE_DEFS = {
  sql: { id: 'sql', label: 'SQL Server', dialect: 'tsql', dataset: 'emulator,SalesDW', file: 'sqlserver.db', defaultSchema: 'dbo', connector: 'shared_sql', display: (s, n) => `[${s}].[${n}]`, dateT: true },
  oracle: { id: 'oracle', label: 'Oracle Database', dialect: 'oracle', dataset: 'EMULATOR/ERPPROD', file: 'oracle.db', defaultSchema: null, connector: 'shared_oracle', display: (s, n) => `${s}.${n}`, dateT: true, oracleDates: true },
  teradata: { id: 'teradata', label: 'Teradata', dialect: 'teradata', dataset: 'emulator/EDW_PROD', file: 'teradata.db', defaultSchema: 'EDW_PROD', connector: 'shared_teradata', display: (s, n) => `${s}.${n}`, dateT: false },
}

export class Engine {
  constructor(def, dataDir) {
    Object.assign(this, def)
    this.path = path.join(dataDir, def.file)
    this.tables = new Map()      // internal -> { internal, schema, name, cols: [[name,type]] }
    this.ro = null
  }
  exists() { return fs.existsSync(this.path) }
  open() {
    this.ro = new DatabaseSync(this.path, { readOnly: true })
    this.loadRegistry()
    return this
  }
  loadRegistry() {
    this.tables.clear()
    for (const r of this.ro.prepare('SELECT internal, schema, name, cols FROM __tables ORDER BY schema, name').all()) {
      this.tables.set(r.internal, { internal: r.internal, schema: r.schema, name: r.name, cols: JSON.parse(r.cols) })
    }
  }
  /** parts like ['dbo','FactSales'] or ['FactSales'] -> table object or null (case-insensitive) */
  findTable(parts) {
    const name = String(parts[parts.length - 1] ?? '').toLowerCase()
    const schema = parts.length > 1 ? String(parts[parts.length - 2]).toLowerCase() : null
    const hits = [...this.tables.values()].filter((t) => t.name.toLowerCase() === name && (schema === null || t.schema.toLowerCase() === schema))
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return hits.find((t) => t.schema === this.defaultSchema) ?? null
    return null
  }
  resolveTable(parts) { return this.findTable(parts)?.internal ?? null }
  /** table by connector path segment: '[dbo].[FactSales]' | 'dbo.FactSales' | 'FactSales' */
  tableFromPath(seg) {
    const parts = decodeURIComponent(seg).split('.').map((p) => p.replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''))
    return this.findTable(parts)
  }
  listTables() {
    return [...this.tables.values()].map((t) => ({ Name: this.display(t.schema, t.name), DisplayName: this.display(t.schema, t.name) }))
  }
  count(t) { return this.ro.prepare(`SELECT COUNT(*) c FROM "${t.internal}"`).get().c }
}
