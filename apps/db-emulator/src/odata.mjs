/** OData $filter / $orderby / $select -> parameterized SQLite. Column names are checked against the table. */

export class ODataError extends Error {}

const tokenize = (s) => {
  const out = []
  const re = /\s*(?:('(?:[^']|'')*')|(\()|(\))|(,)|([A-Za-z_][\w./]*)|(\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[-+]\d{2}:\d{2})?)?)|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?))/y
  let pos = 0
  while (pos < s.length) {
    re.lastIndex = pos
    const m = re.exec(s)
    if (!m) { if (/^\s*$/.test(s.slice(pos))) break; throw new ODataError(`Syntax error in $filter near '${s.slice(pos, pos + 12)}'`) }
    pos = re.lastIndex
    if (m[1] !== undefined) out.push({ t: 'str', v: m[1].slice(1, -1).replace(/''/g, "'") })
    else if (m[2]) out.push({ t: '(' }); else if (m[3]) out.push({ t: ')' }); else if (m[4]) out.push({ t: ',' })
    else if (m[6] !== undefined) out.push({ t: 'str', v: m[6].replace('T', ' ').replace(/Z$/, '') })   // date literal without quotes
    else if (m[7] !== undefined) out.push({ t: 'num', v: Number(m[7]) })
    else out.push({ t: 'id', v: m[5] })
  }
  return out
}

/** columns: array of real column names. Returns { sql, params }. */
export function filterToSql(text, columns) {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]))
  const toks = tokenize(text)
  let i = 0
  const params = []
  const peek = () => toks[i]
  const take = () => toks[i++]
  const isId = (v) => peek()?.t === 'id' && peek().v.toLowerCase() === v
  const col = (name) => { const c = byLower.get(name.toLowerCase()); if (!c) throw new ODataError(`Could not find a property named '${name}'.`); return `"${c}"` }

  function primary() {
    const t = take()
    if (!t) throw new ODataError('Unexpected end of $filter')
    if (t.t === '(') { const e = or(); if (take()?.t !== ')') throw new ODataError('Missing )'); return e }
    if (t.t === 'id' && t.v.toLowerCase() === 'not') return `NOT (${primary()})`
    if (t.t === 'id' && peek()?.t === '(') {
      const fn = t.v.toLowerCase(); take()
      const args = []
      while (peek() && peek().t !== ')') { args.push(valueOrCol()); if (peek()?.t === ',') take() }
      if (take()?.t !== ')') throw new ODataError('Missing )')
      if (fn === 'contains') { params.push(`%${String(args[1].v)}%`); return `(${args[0].sql} LIKE ?)` }
      if (fn === 'startswith') { params.push(`${String(args[1].v)}%`); return `(${args[0].sql} LIKE ?)` }
      if (fn === 'endswith') { params.push(`%${String(args[1].v)}`); return `(${args[0].sql} LIKE ?)` }
      if (fn === 'tolower') return { sql: `LOWER(${args[0].sql})` , expr: true }.sql
      throw new ODataError(`Function '${fn}' is not supported`)
    }
    i--
    const left = valueOrCol()
    const op = take()
    if (!op || op.t !== 'id' || !['eq', 'ne', 'gt', 'ge', 'lt', 'le'].includes(op.v.toLowerCase())) throw new ODataError(`Expected a comparison operator after '${left.text ?? ''}'`)
    const right = valueOrCol()
    const o = op.v.toLowerCase()
    if (right.isNull) return o === 'eq' ? `${left.sql} IS NULL` : o === 'ne' ? `${left.sql} IS NOT NULL` : (() => { throw new ODataError('null can only be compared with eq / ne') })()
    if (left.isNull) throw new ODataError('null must be on the right side')
    if (!left.sql || !right.sql) throw new ODataError('Bad comparison')
    const sym = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' }[o]
    if (left.param !== undefined) params.push(left.param)
    if (right.param !== undefined) params.push(right.param)
    return `(${left.sql} ${sym} ${right.sql})`
  }
  function valueOrCol() {
    const t = take()
    if (!t) throw new ODataError('Unexpected end of $filter')
    if (t.t === 'str') return { sql: '?', param: t.v, v: t.v, text: t.v }
    if (t.t === 'num') return { sql: '?', param: t.v, v: t.v, text: String(t.v) }
    if (t.t === 'id') {
      const l = t.v.toLowerCase()
      if (l === 'null') return { isNull: true, sql: 'NULL' }
      if (l === 'true') return { sql: '?', param: 1, v: 1 }
      if (l === 'false') return { sql: '?', param: 0, v: 0 }
      if (peek()?.t === '(') { i--; const e = primary(); return { sql: e } }
      return { sql: col(t.v), text: t.v }
    }
    throw new ODataError('Syntax error in $filter')
  }
  function and() { let l = primary(); while (isId('and')) { take(); l = `(${l} AND ${primary()})` } return l }
  function or() { let l = and(); while (isId('or')) { take(); l = `(${l} OR ${and()})` } return l }
  // params are pushed while parsing in left-to-right order, which matches the placeholder order
  const sql = or()
  if (i < toks.length) throw new ODataError(`Syntax error in $filter near '${toks[i].v ?? toks[i].t}'`)
  return { sql, params }
}

export function orderToSql(text, columns) {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]))
  return text.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = /^([\w./]+)(?:\s+(asc|desc))?$/i.exec(p)
    if (!m) throw new ODataError(`Syntax error in $orderby near '${p}'`)
    const c = byLower.get(m[1].toLowerCase())
    if (!c) throw new ODataError(`Could not find a property named '${m[1]}'.`)
    return `"${c}" ${(m[2] ?? 'asc').toUpperCase()}`
  }).join(', ')
}

export function selectToSql(text, columns) {
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]))
  return text.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const c = byLower.get(p.toLowerCase())
    if (!c) throw new ODataError(`Could not find a property named '${p}'.`)
    return `"${c}"`
  }).join(', ')
}
