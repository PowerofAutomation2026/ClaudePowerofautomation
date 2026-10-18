/**
 * SQL dialect simulator: accepts common T-SQL (SQL Server), Oracle SQL and Teradata SQL SELECT statements and
 * translates them to SQLite. It is a SIMULATOR for testing dashboards, not the real engines: it covers the
 * constructs used by reporting queries (see README "SQL coverage") and reports everything else with the
 * engine's own style of error message. Read-only: only SELECT / WITH statements are accepted.
 */

export class SqlError extends Error {
  constructor(engine, code, message) { super(message); this.engine = engine; this.code = code }
}

/* ---------- 1. scan: mask string literals / quoted identifiers, drop comments ---------- */
const S = '\u0001S', I = '\u0001I', E = '\u0001'
const tokRe = /\u0001([SI])(\d+)\u0001/g

export function scan(sql, dialect) {
  const lits = []
  let out = ''
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1]
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; out += ' '; continue }
    if (c === '/' && n === '*') { const j = sql.indexOf('*/', i + 2); if (j < 0) throw new Error('unterminated comment'); i = j + 1; out += ' '; continue }
    if (c === "'") {
      let j = i + 1
      while (j < sql.length) { if (sql[j] === "'") { if (sql[j + 1] === "'") j += 2; else break } else j++ }
      if (j >= sql.length) throw new Error('unterminated string')
      lits.push(sql.slice(i, j + 1)); out += S + (lits.length - 1) + E; i = j; continue
    }
    if (c === '"' || (c === '[' && dialect === 'tsql') || c === '`') {
      const close = c === '[' ? ']' : c
      const j = sql.indexOf(close, i + 1)
      if (j < 0) throw new Error('unterminated identifier')
      lits.push(sql.slice(i + 1, j)); out += I + (lits.length - 1) + E; i = j; continue
    }
    out += c
  }
  return { sql: out, lits }
}
const litText = (tok, lits) => { const m = /^\u0001S(\d+)\u0001$/.exec(tok.trim()); return m ? lits[+m[1]].slice(1, -1).replace(/''/g, "'") : null }
const identText = (tok, lits) => { const m = /^\u0001I(\d+)\u0001$/.exec(tok); return m ? lits[+m[1]] : tok }
const restore = (sql, lits) => sql.replace(tokRe, (_, k, n) => (k === 'S' ? lits[+n] : '"' + lits[+n].replace(/"/g, '""') + '"'))

/* ---------- 2. function-call rewriter (balanced parentheses, nested) ---------- */
function splitArgs(s) {
  const out = []; let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim())
}

export function rewriteCalls(sql, handlers) {
  let out = ''
  for (let i = 0; i < sql.length;) {
    const ch = sql[i]
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[\w$#.\u0001]/.test(sql[i - 1]))) {
      let j = i; while (j < sql.length && /[\w$#]/.test(sql[j])) j++
      const name = sql.slice(i, j)
      let k = j; while (k < sql.length && /\s/.test(sql[k])) k++
      if (sql[k] === '(') {
        let depth = 0, e = k
        for (; e < sql.length; e++) { if (sql[e] === '(') depth++; else if (sql[e] === ')') { depth--; if (depth === 0) break } }
        if (depth !== 0) throw new Error('unbalanced parentheses')
        const inner = sql.slice(k + 1, e)
        const h = handlers[name.toLowerCase()]
        const args = splitArgs(inner).map((a) => rewriteCalls(a, handlers))
        out += h ? h(args, inner) : name + '(' + args.join(', ') + ')'
        i = e + 1; continue
      }
      out += name; i = j; continue
    }
    out += ch; i++
  }
  return out
}

/* ---------- 3. shared helpers for date handling ---------- */
const PART = { day: 'days', dd: 'days', d: 'days', month: 'months', mm: 'months', m: 'months', year: 'years', yy: 'years', yyyy: 'years', hour: 'hours', hh: 'hours', minute: 'minutes', mi: 'minutes', n: 'minutes', second: 'seconds', ss: 'seconds', s: 'seconds', week: 'weeks', wk: 'weeks', ww: 'weeks' }
const mod = (n, part) => (part === 'weeks' ? `printf('%+d days', (${n}) * 7)` : `printf('%+d ${part}', (${n}))`)
/** Date n months after x, clamped to the end of a shorter month (Jan 31 + 1 month = Feb 28), like the real engines. */
const addMonths = (x, n) => `DATE(DATE(${x}, 'start of month', printf('%+d months', (${n}))), printf('+%d days', MIN(CAST(strftime('%d', ${x}) AS INTEGER) - 1, CAST(strftime('%d', ${x}, 'start of month', printf('%+d months', (${n}) + 1), '-1 day') AS INTEGER) - 1)))`
const dateAdd = (x, n, part) => /^(month|mm|m|year|yy|yyyy)$/i.test(part)
  ? `DATETIME(${addMonths(x, /^(year|yy|yyyy)$/i.test(part) ? `(${n}) * 12` : n)} || ' ' || strftime('%H:%M:%S', ${x}))`
  : dateAddSimple(x, n, part)
const dateAddSimple = (x, n, part) => `DATETIME(${x}, ${mod(n, PART[part.toLowerCase()] ?? (() => { throw new Error('bad date part ' + part) })())})`
const strf = (f, x) => `CAST(strftime('${f}', ${x}) AS INTEGER)`
const sqlType = (t) => {
  const s = t.toLowerCase().replace(/\s+/g, '')
  if (/^(n?var)?char|^text|^clob|^varchar2/.test(s)) return 'TEXT'
  if (/^(big|small|tiny)?int/.test(s) || s === 'integer' || s === 'byteint') return 'INTEGER'
  if (/^(decimal|numeric|float|real|double|money|number)/.test(s)) return 'REAL'
  return null
}
const castTo = (x, t) => {
  const s = t.toLowerCase().replace(/\s+/g, '')
  const len = /^(?:n?var)?char\((\d+)\)$/.exec(s)
  if (len) return `SUBSTR(CAST(${x} AS TEXT), 1, ${len[1]})`
  if (s.startsWith('date') && !s.startsWith('datetime') && !s.startsWith('datetime2')) return `DATE(${x})`
  if (/^(datetime|timestamp|smalldatetime)/.test(s)) return `DATETIME(${x})`
  const ty = sqlType(t)
  return ty ? `CAST(${x} AS ${ty})` : `CAST(${x} AS ${t})`
}

const ORA_FMT = { YYYY: '%Y', YY: '%y', MM: '%m', DD: '%d', HH24: '%H', HH: '%H', MI: '%M', SS: '%S', MON: '%m', IW: '%W', DY: '%w', D: '%w' }
function oraFmt(fmt) {
  return fmt.replace(/YYYY|YY|MM|DD|HH24|HH|MI|SS|IW|DY|MON|D/gi, (m) => ORA_FMT[m.toUpperCase()] ?? m)
}

function commonHandlers(lits) {
  return {
    cast: (args, inner) => { const m = /^([\s\S]+?)\s+AS\s+([\s\S]+)$/i.exec(inner); if (!m) throw new Error('bad CAST'); return castTo(rewriteCalls(m[1], this?.h ?? {}), m[2].trim()) },
    extract: (_a, inner) => {
      const m = /^\s*(\w+)\s+FROM\s+([\s\S]+)$/i.exec(inner); if (!m) throw new Error('bad EXTRACT')
      const f = { year: '%Y', month: '%m', day: '%d', hour: '%H', minute: '%M', second: '%S' }[m[1].toLowerCase()]
      if (!f) throw new Error('unsupported EXTRACT part ' + m[1])
      return strf(f, m[2].trim())
    },
    substring: (a, inner) => { const m = /^([\s\S]+?)\s+FROM\s+([\s\S]+?)(?:\s+FOR\s+([\s\S]+))?$/i.exec(inner); return m ? `SUBSTR(${m[1]}, ${m[2]}${m[3] ? ', ' + m[3] : ''})` : `SUBSTR(${a.join(', ')})` },
    trim: (a, inner) => { const m = /\bFROM\b([\s\S]+)$/i.exec(inner); return m ? `TRIM(${m[1].trim()})` : `TRIM(${a.join(', ')})` },
    concat: (a) => '(' + a.map((x) => `IFNULL(${x}, '')`).join(' || ') + ')',
  }
}

/* ---------- 4. dialect rewrites ---------- */
function tsql(sql, lits) {
  let s = sql
  s = s.replace(/\bWITH\s*\(\s*(NOLOCK|READUNCOMMITTED|ROWLOCK|READPAST)\s*\)/gi, '')
  let limit = null
  s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?)TOP\s*\(?\s*(\d+)\s*\)?\s+/i, (_, a, n) => { limit = n; return a })
  s = s.replace(/\bOFFSET\s+(\d+)\s+ROWS?\s+FETCH\s+(?:NEXT|FIRST)\s+(\d+)\s+ROWS?\s+ONLY\b/i, (_, o, n) => { limit = `${n} OFFSET ${o}`; return '' })
  const h = {
    isnull: (a) => `IFNULL(${a[0]}, ${a[1]})`, len: (a) => `LENGTH(${a[0]})`, datalength: (a) => `LENGTH(${a[0]})`,
    getdate: () => `DATETIME('now')`, sysdatetime: () => `DATETIME('now')`, getutcdate: () => `DATETIME('now')`, sysutcdatetime: () => `DATETIME('now')`,
    dateadd: (a) => dateAdd(a[2], a[1], a[0]),
    datediff: (a) => {
      const p = a[0].toLowerCase(), x = a[1], y = a[2]
      if (/^(day|dd|d)$/.test(p)) return `CAST(julianday(DATE(${y})) - julianday(DATE(${x})) AS INTEGER)`
      if (/^(hour|hh)$/.test(p)) return `CAST((julianday(${y}) - julianday(${x})) * 24 AS INTEGER)`
      if (/^(minute|mi|n)$/.test(p)) return `CAST((julianday(${y}) - julianday(${x})) * 1440 AS INTEGER)`
      if (/^(second|ss|s)$/.test(p)) return `CAST((julianday(${y}) - julianday(${x})) * 86400 AS INTEGER)`
      if (/^(month|mm|m)$/.test(p)) return `((${strf('%Y', y)} - ${strf('%Y', x)}) * 12 + ${strf('%m', y)} - ${strf('%m', x)})`
      if (/^(year|yy|yyyy)$/.test(p)) return `(${strf('%Y', y)} - ${strf('%Y', x)})`
      throw new Error('unsupported DATEDIFF part ' + a[0])
    },
    year: (a) => strf('%Y', a[0]), month: (a) => strf('%m', a[0]), day: (a) => strf('%d', a[0]),
    datepart: (a) => { const f = { year: '%Y', yy: '%Y', yyyy: '%Y', month: '%m', mm: '%m', m: '%m', day: '%d', dd: '%d', d: '%d', hour: '%H', hh: '%H', minute: '%M', mi: '%M', n: '%M', weekday: '%w', dw: '%w', week: '%W', wk: '%W', dayofyear: '%j', dy: '%j' }[a[0].toLowerCase()]; if (!f) throw new Error('unsupported DATEPART ' + a[0]); return strf(f, a[1]) },
    charindex: (a) => `INSTR(${a[1]}, ${a[0]})`, count_big: (a) => `COUNT(${a[0]})`,
    convert: (a) => {
      const style = a[2] === undefined ? null : Number(a[2])
      const isChar = /^(n?var)?char/i.test(a[0])
      if (isChar && style !== null) {
        const f = { 23: `DATE(${a[1]})`, 101: `strftime('%m/%d/%Y', ${a[1]})`, 103: `strftime('%d/%m/%Y', ${a[1]})`, 104: `strftime('%d.%m.%Y', ${a[1]})`, 112: `strftime('%Y%m%d', ${a[1]})`, 120: `DATETIME(${a[1]})`, 121: `strftime('%Y-%m-%d %H:%M:%f', ${a[1]})`, 108: `strftime('%H:%M:%S', ${a[1]})` }[style]
        if (f) { const n = /\((\d+)\)/.exec(a[0]); return n ? `SUBSTR(${f}, 1, ${n[1]})` : f }
      }
      return castTo(a[1], a[0])
    },
    eomonth: (a) => `DATE(${a[0]}, 'start of month', '+1 month', '-1 day')`,
    str: (a) => `CAST(${a[0]} AS TEXT)`, newid: () => `lower(hex(randomblob(16)))`,
    ...commonHandlers(lits),
  }
  h.cast = (args, inner) => { const m = /^([\s\S]+?)\s+AS\s+([\s\S]+)$/i.exec(inner); if (!m) throw new Error('bad CAST'); return castTo(rewriteCalls(m[1], h), m[2].trim()) }
  s = rewriteCalls(s, h)
  return { sql: s, limit }
}

function oracle(sql, lits) {
  let s = sql
  let limit = null
  s = s.replace(/\bFROM\s+DUAL\s*,\s*/gi, 'FROM ').replace(/\bFROM\s+DUAL\b/gi, '')
  s = s.replace(/\bOFFSET\s+(\d+)\s+ROWS?\s+FETCH\s+(?:NEXT|FIRST)\s+(\d+)\s+ROWS?\s+(?:ONLY|WITH\s+TIES)\b/i, (_, o, n) => { limit = `${n} OFFSET ${o}`; return '' })
  s = s.replace(/\bFETCH\s+(?:FIRST|NEXT)\s+(\d+)\s+ROWS?\s+ONLY\b/i, (_, n) => { limit = n; return '' })
  s = s.replace(/\bOFFSET\s+(\d+)\s+ROWS?\b/i, (_, o) => { limit = `-1 OFFSET ${o}`; return '' })
  // ROWNUM <= n  (the classic top-N filter)
  s = s.replace(/\bWHERE\s+ROWNUM\s*(<=|<)\s*(\d+)\s*(?=(AND\b|ORDER\b|GROUP\b|$|\)))/i, (m, op, n, rest) => { limit = op === '<' ? String(+n - 1) : n; return /^AND\b/i.test(rest) ? 'WHERE ' : '' })
  s = s.replace(/\bAND\s+ROWNUM\s*(<=|<)\s*(\d+)/i, (_, op, n) => { limit = op === '<' ? String(+n - 1) : n; return '' })
  if (/\bROWNUM\b/i.test(s)) throw new Error('ROWNUM is only supported as "WHERE ROWNUM <= n"')
  s = s.replace(/\bMINUS\b/gi, 'EXCEPT')
  s = s.replace(/\bSYSTIMESTAMP\b|\bSYSDATE\b|\bCURRENT_TIMESTAMP\b|\bLOCALTIMESTAMP\b/gi, `DATETIME('now')`)
  s = s.replace(/\bCURRENT_DATE\b/gi, `DATE('now')`)
  s = s.replace(/DATETIME\('now'\)\s*([+-])\s*(\d+(?:\.\d+)?)(?!\s*\w)/g, (_, sg, n) => `DATETIME('now', '${sg}${n} days')`)
  s = s.replace(/\bWITHIN\s+GROUP\s*\(\s*ORDER\s+BY[^)]*\)/gi, '')
  const h = {
    nvl: (a) => `IFNULL(${a[0]}, ${a[1]})`, nvl2: (a) => `(CASE WHEN ${a[0]} IS NOT NULL THEN ${a[1]} ELSE ${a[2]} END)`,
    listagg: (a) => `GROUP_CONCAT(${a[0]}, ${a[1] ?? "','"})`,
    trunc: (a) => { if (a.length === 1) return `DATE(${a[0]})`; const f = litText(a[1], lits)?.toUpperCase(); if (f === 'MM' || f === 'MONTH') return `DATE(${a[0]}, 'start of month')`; if (f === 'YYYY' || f === 'YEAR') return `DATE(${a[0]}, 'start of year')`; if (f === 'DD' || f === 'DDD') return `DATE(${a[0]})`; throw new Error('unsupported TRUNC format') },
    to_char: (a) => { if (a.length === 1) return `CAST(${a[0]} AS TEXT)`; const f = litText(a[1], lits); if (f === null) throw new Error('TO_CHAR format must be a literal'); if (/^\s*[09.,FM]+\s*$/i.test(f)) return `CAST(${a[0]} AS TEXT)`; return `strftime('${oraFmt(f)}', ${a[0]})` },
    to_date: (a) => { const f = litText(a[1] ?? "''", lits) ?? ''; return /HH|MI|SS/i.test(f) ? `DATETIME(${a[0]})` : `DATE(${a[0]})` },
    to_timestamp: (a) => `DATETIME(${a[0]})`, to_number: (a) => `CAST(${a[0]} AS REAL)`,
    add_months: (a) => addMonths(a[0], a[1]),
    months_between: (a) => `((julianday(${a[0]}) - julianday(${a[1]})) / 30.4375)`,
    last_day: (a) => `DATE(${a[0]}, 'start of month', '+1 month', '-1 day')`,
    decode: (a) => { const [x, ...rest] = a; let o = `(CASE ${x}`; for (let i = 0; i + 1 < rest.length; i += 2) o += ` WHEN ${rest[i]} THEN ${rest[i + 1]}`; if (rest.length % 2) o += ` ELSE ${rest[rest.length - 1]}`; return o + ' END)' },
    ...commonHandlers(lits),
  }
  h.cast = (args, inner) => { const m = /^([\s\S]+?)\s+AS\s+([\s\S]+)$/i.exec(inner); if (!m) throw new Error('bad CAST'); return castTo(rewriteCalls(m[1], h), m[2].trim()) }
  s = rewriteCalls(s, h)
  return { sql: s, limit }
}

function teradata(sql, lits) {
  let s = sql
  let limit = null
  s = s.replace(/^\s*SEL\b/i, 'SELECT')
  s = s.replace(/\bTD_SYSFNLIB\./gi, '')
  s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?)TOP\s+(\d+)\s+/i, (_, a, n) => { limit = n; return a })
  let sample = null
  s = s.replace(/\bSAMPLE\s+(\d+)\s*$/i, (_, n) => { sample = n; return '' })
  if (/\bSAMPLE\b/i.test(s)) throw new Error('SAMPLE with a fraction is not supported by the simulator (use SAMPLE n rows)')
  let qualify = null
  const qi = s.search(/\bQUALIFY\b/i)
  if (qi >= 0) {
    if (!/^\s*SELECT\s+\*\s+FROM\b/i.test(s)) throw new Error('QUALIFY is only supported with SELECT * in the simulator')
    let depth = 0, end = s.length
    const body = s.slice(qi + 7)
    for (let k = 0; k < body.length; k++) { const ch = body[k]; if (ch === '(') depth++; else if (ch === ')') depth--; else if (depth === 0 && /^ORDER\s+BY\b/i.test(body.slice(k)) && /\s/.test(body[k - 1] ?? ' ')) { end = qi + 7 + k; break } }
    qualify = s.slice(qi + 7, end).trim()
    const tail = s.slice(end)
    const head = s.slice(0, qi)
    const cond = /^([\s\S]*?)\s*(=|<=|>=|<|>)\s*(\d+)$/.exec(qualify)
    if (!cond || !/^(ROW_NUMBER|RANK|DENSE_RANK)\s*\(\s*\)\s*OVER\b/i.test(cond[1])) throw new Error('QUALIFY supports ROW_NUMBER() / RANK() / DENSE_RANK() OVER (...) compared with a number')
    s = `SELECT * FROM (${head.replace(/^\s*SELECT\s+\*/i, `SELECT *, ${cond[1]} AS "__q"`)}) WHERE "__q" ${cond[2]} ${cond[3]} ${tail}`
  }
  s = s.replace(/\bDATE\s+(\u0001S\d+\u0001)/gi, '$1').replace(/\bTIMESTAMP\s+(\u0001S\d+\u0001)/gi, '$1')
  s = s.replace(/\(\s*FORMAT\s+\u0001S\d+\u0001\s*\)/gi, '')
  s = s.replace(/CURRENT_DATE\s*([+-])\s*INTERVAL\s+(\u0001S\d+\u0001)\s*(DAY|MONTH|YEAR)S?/gi, (_, sg, lit, u) => `DATE('now', '${sg}${litText(lit, lits)} ${u.toLowerCase()}s')`)
  s = s.replace(/CURRENT_DATE\s*([+-])\s*(\d+)\b/gi, (_, sg, n) => `DATE('now', '${sg}${n} days')`)
  s = s.replace(/\bCURRENT_DATE\b|\bDATE\b(?=\s*(?:[,)]|$|\bAS\b))/gi, (m) => (/CURRENT_DATE/i.test(m) ? `DATE('now')` : m))
  s = s.replace(/\bCURRENT_TIMESTAMP(?:\(\d+\))?/gi, `DATETIME('now')`)
  s = s.replace(/(\w+(?:\([^()]*\))?)\s+MOD\s+(\w+)/gi, '($1 % $2)')
  const h = {
    zeroifnull: (a) => `IFNULL(${a[0]}, 0)`, nullifzero: (a) => `NULLIF(${a[0]}, 0)`,
    add_months: (a) => addMonths(a[0], a[1]),
    char_length: (a) => `LENGTH(${a[0]})`, characters: (a) => `LENGTH(${a[0]})`, character_length: (a) => `LENGTH(${a[0]})`,
    index: (a) => `INSTR(${a[0]}, ${a[1]})`, oreplace: (a) => `REPLACE(${a[0]}, ${a[1]}, ${a[2] ?? "''"})`,
    nvl: (a) => `IFNULL(${a[0]}, ${a[1]})`,
    to_char: (a) => { if (a.length === 1) return `CAST(${a[0]} AS TEXT)`; const f = litText(a[1], lits); return `strftime('${oraFmt(f ?? '%Y-%m-%d')}', ${a[0]})` },
    to_date: (a) => `DATE(${a[0]})`,
    ...commonHandlers(lits),
  }
  h.cast = (args, inner) => { const m = /^([\s\S]+?)\s+AS\s+([\s\S]+)$/i.exec(inner); if (!m) throw new Error('bad CAST'); return castTo(rewriteCalls(m[1], h), m[2].trim().replace(/\(\s*\d+\s*\)\s*$/, '')) }
  s = rewriteCalls(s, h)
  if (sample) { limit = sample; s += ' ORDER BY RANDOM()' }
  return { sql: s, limit }
}

const REF = String.raw`(?:\u0001I\d+\u0001|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:\u0001I\d+\u0001|[A-Za-z_][\w$#]*))*`
const CLAUSE_END = /^(WHERE|GROUP|ORDER|HAVING|UNION|INTERSECT|EXCEPT|LIMIT|OFFSET|FETCH|WINDOW|QUALIFY|FOR)\b/i

/** Resolve table names in every FROM clause (comma lists too) and after every JOIN. */
function resolveFrom(sql, lits, engine, unknown) {
  const one = (ref) => {
    const parts = ref.split('.').map((p) => identText(p.trim(), lits))
    const t = engine.resolveTable(parts)
    if (!t) { unknown.push(parts.join('.')); return null }
    return `"${t}"`
  }
  const joinRe = new RegExp(String.raw`\bJOIN\s+(${REF})(?=\s|$|\)|,)`, 'gi')
  const starts = [...sql.matchAll(/\bFROM\b/gi)].map((m) => m.index).reverse()
  for (const at of starts) {
    const from = at + 4
    let depth = 0, end = sql.length
    for (let k = from; k < sql.length; k++) {
      const ch = sql[k]
      if (ch === '(') depth++
      else if (ch === ')') { if (depth === 0) { end = k; break } depth-- }
      else if (depth === 0 && /\s/.test(sql[k - 1] ?? ' ') && CLAUSE_END.test(sql.slice(k))) { end = k; break }
    }
    const clause = sql.slice(from, end)
    const parts = []
    let d = 0, cur = ''
    for (const ch of clause) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur); cur = '' } else cur += ch }
    parts.push(cur)
    const fixed = parts.map((part) => {
      let out = part
      const m = new RegExp(String.raw`^(\s*)(${REF})(?=\s|$)`).exec(out)
      if (m && !/^\s*\(/.test(out)) { const r = one(m[2]); if (r) out = m[1] + r + out.slice(m[0].length) }
      return out.replace(joinRe, (all, ref) => { const r = one(ref); return r ? `JOIN ${r}` : all })
    })
    sql = sql.slice(0, from) + fixed.join(',') + sql.slice(end)
  }
  return sql
}

const REWRITERS = { tsql, oracle, teradata }
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|MERGE|CALL|VACUUM|REINDEX|SAVEPOINT|BEGIN|COMMIT|ROLLBACK|INTO)\b|REPLACE\s+INTO|load_extension|sqlite_/i

/**
 * @param engine  { id, dialect, resolveTable(parts[]) -> internalName | null }
 * @returns { sql, cap } SQLite statement text (identifiers restored)
 */
export function translate(sqlText, engine) {
  const dialect = engine.dialect
  const fail = (code, msg) => { throw new SqlError(engine.id, code, msg) }
  let scanned
  try { scanned = scan(String(sqlText ?? ''), dialect) } catch (e) { return fail('syntax', e.message) }
  let { sql, lits } = scanned
  sql = sql.trim().replace(/;+\s*$/, '')
  if (!sql) fail('syntax', 'empty statement')
  if (sql.includes(';')) fail('syntax', 'only one statement is allowed')
  if (!/^(SELECT|SEL|WITH)\b/i.test(sql)) fail('readonly', 'only SELECT statements are allowed (this is a read-only reporting server)')
  const bad = FORBIDDEN.exec(sql)
  if (bad) fail('readonly', `statement not allowed: ${bad[0].trim().toUpperCase()}`)
  let rewritten
  try { rewritten = REWRITERS[dialect](sql, lits) } catch (e) { return fail('syntax', e.message) }
  sql = rewritten.sql
  const unknown = []
  sql = resolveFrom(sql, lits, engine, unknown)
  if (unknown.length) fail('no-table', unknown[0])
  sql = restore(sql, lits)
  if (rewritten.limit !== null) {
    if (/\bLIMIT\b/i.test(sql)) fail('syntax', 'row limit given twice')
    sql += ` LIMIT ${rewritten.limit}`
  }
  return sql
}

/* ---------- 5. engine-style error messages ---------- */
export function engineError(engine, err) {
  const msg = String(err?.message ?? err)
  const e = engine.id
  const tbl = (n) => n.replace(/^"|"$/g, '')
  if (err instanceof SqlError) {
    if (err.code === 'no-table') {
      if (e === 'sql') return { status: 400, number: 208, message: `Invalid object name '${err.message}'.` }
      if (e === 'oracle') return { status: 400, number: 942, message: `ORA-00942: table or view does not exist` }
      return { status: 400, number: 3807, message: `[Teradata Database] [3807] Object '${err.message}' does not exist.` }
    }
    if (err.code === 'readonly') return { status: 403, number: 229, message: e === 'sql' ? `The SELECT permission was denied: ${err.message}` : e === 'oracle' ? `ORA-01031: insufficient privileges (${err.message})` : `[Teradata Database] [3523] The user does not have the right to do this: ${err.message}` }
    if (e === 'sql') return { status: 400, number: 102, message: `Msg 102, Level 15, State 1, Line 1\nIncorrect syntax: ${err.message}` }
    if (e === 'oracle') return { status: 400, number: 933, message: `ORA-00933: SQL command not properly ended (${err.message})` }
    return { status: 400, number: 3706, message: `[Teradata Database] [3706] Syntax error: ${err.message}` }
  }
  let m
  if ((m = /no such column: ([\w."]+)/i.exec(msg))) {
    const c = tbl(m[1].split('.').pop())
    if (e === 'sql') return { status: 400, number: 207, message: `Msg 207, Level 16, State 1, Line 1\nInvalid column name '${c}'.` }
    if (e === 'oracle') return { status: 400, number: 904, message: `ORA-00904: "${c.toUpperCase()}": invalid identifier` }
    return { status: 400, number: 5628, message: `[Teradata Database] [5628] Column '${c}' not found.` }
  }
  if ((m = /no such function: (\w+)/i.exec(msg))) {
    const f = m[1]
    if (e === 'sql') return { status: 400, number: 195, message: `Msg 195, Level 15, State 10, Line 1\n'${f}' is not a recognized built-in function name.` }
    if (e === 'oracle') return { status: 400, number: 904, message: `ORA-00904: "${f.toUpperCase()}": invalid identifier (function is not supported by the simulator)` }
    return { status: 400, number: 3706, message: `[Teradata Database] [3706] Syntax error: unknown function ${f} (not supported by the simulator)` }
  }
  if (/syntax error|incomplete input|near "/i.test(msg)) {
    const near = /near "([^"]*)"/.exec(msg)?.[1]
    if (e === 'sql') return { status: 400, number: 102, message: `Msg 102, Level 15, State 1, Line 1\nIncorrect syntax near '${near ?? ''}'.` }
    if (e === 'oracle') return { status: 400, number: 933, message: `ORA-00933: SQL command not properly ended` }
    return { status: 400, number: 3706, message: `[Teradata Database] [3706] Syntax error: expected something between the beginning of the request and '${near ?? ''}'.` }
  }
  if (/ambiguous column/i.test(msg)) {
    if (e === 'sql') return { status: 400, number: 209, message: `Msg 209, Level 16, State 1, Line 1\nAmbiguous column name.` }
    if (e === 'oracle') return { status: 400, number: 918, message: `ORA-00918: column ambiguously defined` }
    return { status: 400, number: 3809, message: `[Teradata Database] [3809] Column is ambiguous.` }
  }
  if (/GROUP BY|aggregate/i.test(msg)) {
    if (e === 'sql') return { status: 400, number: 8120, message: `Msg 8120, Level 16, State 1, Line 1\nColumn is invalid in the select list because it is not contained in either an aggregate function or the GROUP BY clause.` }
    if (e === 'oracle') return { status: 400, number: 979, message: `ORA-00979: not a GROUP BY expression` }
    return { status: 400, number: 3504, message: `[Teradata Database] [3504] Selected non-aggregate values must be part of the associated group.` }
  }
  return { status: 400, number: 0, message: msg }
}
