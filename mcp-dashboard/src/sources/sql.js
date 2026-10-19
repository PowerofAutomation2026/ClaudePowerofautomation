import { normalizeRows, MAX_ROWS } from './rows.js';

// Queries come only from the admin's config file, never from the agent. These checks catch config mistakes;
// the real protection is giving the connection a read-only database account.
export function assertReadOnly(sqlText) {
  const t = sqlText.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(t)) throw new Error('only SELECT / WITH queries are allowed');
  if (t.includes(';')) throw new Error('multiple statements are not allowed');
  return t;
}

const missing = (pkg) => new Error(`This data source needs the optional dependency: npm install ${pkg}`);

export function sqlServerProvider() {
  const pools = new Map();
  return {
    async fetch(cfg, queryText, _name, params) {
      let sql;
      try { ({ default: sql } = await import('mssql')); } catch { throw missing('mssql'); }
      const key = cfg.__name;
      let pool = pools.get(key);
      if (!pool) {
        const c = typeof cfg.connection === 'string' ? cfg.connection : { requestTimeout: 30_000, ...cfg.connection };
        pool = new sql.ConnectionPool(c);
        pool.on('error', () => pools.delete(key));
        await pool.connect();
        pools.set(key, pool);
      }
      try {
        const req = pool.request();
        for (const [k, v] of Object.entries(params ?? {})) req.input(k, v);
        const res = await req.query(assertReadOnly(queryText));
        return normalizeRows(res.recordset ?? []);
      } catch (e) {
        if (e.code === 'ESOCKET' || e.code === 'ECONNCLOSED') { pools.delete(key); pool.close().catch(() => {}); }
        throw e;
      }
    },
  };
}

export function oracleProvider() {
  const pools = new Map();
  return {
    async fetch(cfg, queryText, _name, params) {
      let oracledb;
      try { ({ default: oracledb } = await import('oracledb')); } catch { throw missing('oracledb'); }
      const key = cfg.__name;
      let pool = pools.get(key);
      if (!pool) {
        const { user, password, connectString } = cfg.connection ?? {};
        pool = await oracledb.createPool({ user, password, connectString, poolMin: 0, poolMax: 2 }); // thin mode: no Oracle client needed
        pools.set(key, pool);
      }
      const conn = await pool.getConnection();
      try {
        conn.callTimeout = 30_000;
        const res = await conn.execute(assertReadOnly(queryText), params ?? {}, { maxRows: MAX_ROWS, outFormat: oracledb.OUT_FORMAT_OBJECT });
        return normalizeRows(res.rows ?? []);
      } finally { await conn.close().catch(() => {}); }
    },
  };
}
