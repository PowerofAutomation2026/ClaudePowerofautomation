import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'

export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
export class Rng {
  constructor(seed) { this.f = mulberry32(seed) }
  next() { return this.f() }
  int(a, b) { return a + Math.floor(this.f() * (b - a + 1)) }
  pick(arr) { return arr[Math.floor(this.f() * arr.length)] }
  zipf(n) { return Math.floor(n * this.f() ** 2) }                      // popular items first
  weighted(items, weights) { let t = 0; for (const w of weights) t += w; let r = this.f() * t; for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i] } return items[items.length - 1] }
  norm() { return Math.sqrt(-2 * Math.log(1 - this.f())) * Math.cos(2 * Math.PI * this.f()) }
  logn(mu, sigma) { return Math.exp(mu + sigma * this.norm()) }
}
export const ts = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
export const dt = (ms) => new Date(ms).toISOString().slice(0, 10)
export const DAY = 86400000
export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d

export const SIZES = { small: 0.02, standard: 1, big: 5 }

/** Create a table and register it in __tables. cols = [[name, type], ...]; types: INT, REAL, TEXT, BIT, DATE, TS */
export function defineTable(db, schema, name, cols, indexes = []) {
  db.exec('CREATE TABLE IF NOT EXISTS __tables (internal TEXT PRIMARY KEY, schema TEXT, name TEXT, cols TEXT)')
  const internal = `${schema}__${name}`
  const sqlt = (t) => ({ INT: 'INTEGER', REAL: 'REAL', TEXT: 'TEXT', BIT: 'INTEGER', DATE: 'TEXT', TS: 'TEXT' })[t]
  db.exec(`DROP TABLE IF EXISTS "${internal}"`)
  db.exec(`CREATE TABLE "${internal}" (${cols.map(([n, t]) => `"${n}" ${sqlt(t)}`).join(', ')})`)
  db.prepare('INSERT OR REPLACE INTO __tables VALUES (?,?,?,?)').run(internal, schema, name, JSON.stringify(cols))
  return { internal, cols, indexes }
}
export function addIndexes(db, t) {
  for (const col of t.indexes) db.exec(`CREATE INDEX IF NOT EXISTS "ix_${t.internal}_${col}" ON "${t.internal}"("${col}")`)
}
export function bulkInsert(db, t, count, gen, onProgress) {
  const cols = t.cols.map((c) => c[0])
  const stmt = db.prepare(`INSERT INTO "${t.internal}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
  const STEP = 50000
  for (let i = 0; i < count; i += STEP) {
    db.exec('BEGIN')
    for (let k = i; k < Math.min(count, i + STEP); k++) stmt.run(...gen(k))
    db.exec('COMMIT')
    onProgress?.(Math.min(count, i + STEP), count)
  }
}
export function openWritable(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA temp_store = MEMORY;')
  return db
}
export function freshDb(file) {
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true })
  return openWritable(file)
}
