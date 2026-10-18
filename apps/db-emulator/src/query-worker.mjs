// Child process that runs read-only SQL. The server kills it (SIGKILL) when a query exceeds the timeout, which
// is the only reliable way to stop a long native SQLite call.
import { DatabaseSync } from 'node:sqlite'

const dbs = new Map()
const get = (file) => { let d = dbs.get(file); if (!d) { d = new DatabaseSync(file, { readOnly: true }); dbs.set(file, d) } return d }

process.on('message', ({ id, file, sql, params, cap }) => {
  try {
    const stmt = get(file).prepare(sql)
    const rows = []
    let truncated = false
    for (const row of stmt.iterate(...(params ?? []))) {
      if (rows.length >= cap) { truncated = true; break }
      rows.push({ ...row })
    }
    process.send({ id, rows, truncated })
  } catch (e) { process.send({ id, error: String(e.message ?? e) }) }
})
process.on('disconnect', () => process.exit(0))
