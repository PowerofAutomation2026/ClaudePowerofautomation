// A small interpreter for the subset of the Azure Logic Apps / Power Automate workflow definition language that
// the two generated flows use. TEST HELPER ONLY.
//
// Purpose: execute the GENERATED flow definitions (not a hand-written imitation) against the mock Dataverse, so
// that wrong column names, unbalanced logic, broken state handling and bad run-after wiring are caught here.
// Honest limit: this is this project's reading of the documented language semantics, not Microsoft's engine.
// Deliberately strict where the real engine is known or suspected to be strict:
//   * if() evaluates BOTH branches (so "guarded" int()/ticks() of bad input still fails, as it would for real);
//   * int() / ticks() of text that is not a number / date throws; property access on a string or number throws;
//   * a reference to an action that did not run yields null outputs.

class Skip extends Error {}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---------------- expression parser ----------------
function parse(src) {
  let i = 0
  const ws = () => { while (src[i] === ' ') i++ }
  const fail = (m) => { throw new Error(`expression syntax: ${m} at ${i} in ${src.slice(0, 200)}`) }
  function primary() {
    ws()
    const c = src[i]
    if (c === "'") {
      let s = ''; i++
      for (;;) { if (i >= src.length) fail('unterminated string'); if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue } i++; break } s += src[i++] }
      return { t: 'lit', v: s }
    }
    const num = /^-?[0-9]+(\.[0-9]+)?/.exec(src.slice(i))
    if (num) { i += num[0].length; return { t: 'lit', v: Number(num[0]) } }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (!id) fail('unexpected character ' + JSON.stringify(c))
    i += id[0].length
    ws()
    if (src[i] !== '(') {
      if (id[0] === 'true') return { t: 'lit', v: true }
      if (id[0] === 'false') return { t: 'lit', v: false }
      if (id[0] === 'null') return { t: 'lit', v: null }
      fail('bare identifier ' + id[0])
    }
    i++
    const args = []
    ws()
    if (src[i] === ')') { i++; return { t: 'call', f: id[0], args } }
    for (;;) { args.push(expr()); ws(); if (src[i] === ',') { i++; continue } if (src[i] === ')') { i++; break } fail('expected , or )') }
    return { t: 'call', f: id[0], args }
  }
  function expr() {
    let node = primary()
    for (;;) {
      let safe = false
      if (src[i] === '?' && src[i + 1] === '[') { safe = true; i++ }
      if (src[i] !== '[') break
      i++
      const key = expr(); ws()
      if (src[i] !== ']') fail('expected ]')
      i++
      node = { t: 'idx', o: node, k: key, safe }
    }
    return node
  }
  const n = expr(); ws()
  if (i !== src.length) fail('trailing text')
  return n
}
const cache = new Map()
const parsed = (s) => { let p = cache.get(s); if (!p) { p = parse(s); cache.set(s, p) } return p }

// ---------------- functions ----------------
const TICKS = (iso) => {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(iso) || !Number.isFinite(Date.parse(iso))) throw new Error(`ticks(): not a timestamp: ${JSON.stringify(iso)}`)
  return Date.parse(iso) * 10000
}
const fmtTime = (ms, f) => {
  const iso = new Date(ms).toISOString()
  if (f === undefined) return iso.replace('Z', '0000Z')
  if (f === 'yyyy-MM-ddTHH:mm:ssZ') return iso.replace(/\.\d+Z$/, 'Z')
  throw new Error('unsupported date format ' + f)
}
const str = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'number' ? String(v) : JSON.stringify(v))
const num = (v, f) => { if (typeof v !== 'number') throw new Error(`${f}(): not a number: ${JSON.stringify(v)}`); return v }
const cmpable = (a, b, f) => { if (typeof a !== typeof b || (typeof a !== 'number' && typeof a !== 'string')) throw new Error(`${f}(): cannot compare ${JSON.stringify(a)} with ${JSON.stringify(b)}`) }

function functions(env, scope) {
  return {
    concat: (...a) => a.map(str).join(''),
    string: (v) => str(v),
    int: (v) => { if (typeof v === 'number') return Math.trunc(v); if (typeof v !== 'string' || !/^[+-]?[0-9]+$/.test(v)) throw new Error(`int(): not an integer: ${JSON.stringify(v)}`); return parseInt(v, 10) },
    isInt: (v) => typeof v === 'string' && /^[+-]?[0-9]+$/.test(v),
    toLower: (v) => str(v).toLowerCase(),
    take: (v, n) => { if (typeof v !== 'string' && !Array.isArray(v)) throw new Error('take(): needs text or an array'); return v.slice(0, n) },
    replace: (s, a, b) => { if (typeof s !== 'string') throw new Error('replace(): needs text'); return s.split(a).join(b) },
    join: (a, sep) => { if (!Array.isArray(a)) throw new Error('join(): needs an array'); return a.map(str).join(sep) },
    startsWith: (s, p) => { if (typeof s !== 'string') throw new Error('startsWith(): needs text'); return s.startsWith(p) },
    length: (v) => { if (typeof v !== 'string' && !Array.isArray(v)) throw new Error(`length(): needs text or an array, got ${JSON.stringify(v)}`); return v.length },
    empty: (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0),
    contains: (c, v) => { if (typeof c === 'string') return c.includes(str(v)); if (Array.isArray(c)) return c.includes(v); if (isObj(c)) return Object.prototype.hasOwnProperty.call(c, v); throw new Error(`contains(): needs text, an array or an object, got ${JSON.stringify(c)}`) },
    first: (v) => { if (typeof v === 'string') return v[0] ?? ''; if (Array.isArray(v)) return v.length ? v[0] : null; throw new Error(`first(): needs text or an array, got ${JSON.stringify(v)}`) },
    coalesce: (...a) => { for (const x of a) if (x !== null && x !== undefined) return x; return null },
    equals: (a, b) => (a ?? null) === (b ?? null),
    not: (a) => { if (typeof a !== 'boolean') throw new Error('not(): needs a boolean'); return !a },
    and: (...a) => a.every((x) => { if (typeof x !== 'boolean') throw new Error('and(): needs booleans'); return x }),
    or: (...a) => a.some((x) => { if (typeof x !== 'boolean') throw new Error('or(): needs booleans'); return x }),
    if: (c, a, b) => { if (typeof c !== 'boolean') throw new Error('if(): condition is not a boolean'); return c ? a : b },   // NOTE: a and b are both already evaluated
    greater: (a, b) => { cmpable(a, b, 'greater'); return a > b },
    greaterOrEquals: (a, b) => { cmpable(a, b, 'greaterOrEquals'); return a >= b },
    less: (a, b) => { cmpable(a, b, 'less'); return a < b },
    add: (a, b) => num(a, 'add') + num(b, 'add'), sub: (a, b) => num(a, 'sub') - num(b, 'sub'),
    div: (a, b) => { if (num(b, 'div') === 0) throw new Error('div(): division by zero'); return Math.trunc(num(a, 'div') / b) },
    min: (...a) => Math.min(...a.map((x) => num(x, 'min'))), max: (...a) => Math.max(...a.map((x) => num(x, 'max'))),
    ticks: TICKS,
    utcNow: (f) => fmtTime(env.now(), f),
    addMinutes: (t, n, f) => fmtTime(TICKS(t) / 10000 + n * 60000, f),
    addDays: (t, n, f) => fmtTime(TICKS(t) / 10000 + n * 86400000, f),
    json: (s) => JSON.parse(s),
    union: (a, b) => { if (!Array.isArray(a) || !Array.isArray(b)) throw new Error('union(): needs arrays'); return [...new Set([...a, ...b])] },
    addSeconds: (t, n, f) => fmtTime(TICKS(t) / 10000 + n * 1000, f),
    triggerBody: () => env.trigger?.body ?? null,
    triggerOutputs: () => (env.trigger ? { ...Object.fromEntries(Object.entries(env.trigger.body ?? {}).map(([k, v]) => ['body/' + k, v])), body: env.trigger.body } : null),      // the designer's 'body/<column>' form
    decodeUriComponent: (s) => decodeURIComponent(s),
    split: (s, d) => { if (typeof s !== 'string') throw new Error('split(): needs text'); return s.split(d) },
    last: (v) => { if (typeof v === 'string') return v.slice(-1); if (Array.isArray(v)) return v.length ? v[v.length - 1] : null; throw new Error('last(): needs text or an array') },
    createArray: (...a) => a,
    parameters: (n) => (n === '$authentication' ? { type: 'test' } : {}),
    variables: (n) => { if (!env.vars.has(n)) throw new Error(`variables('${n}'): not initialized`); return env.vars.get(n) },
    items: (n) => { const s = find(scope, (x) => x.loops?.has(n)); if (!s) throw new Error(`items('${n}'): not inside that loop`); return s.loops.get(n) },
    item: () => { const s = find(scope, (x) => 'item' in x); if (!s) throw new Error('item(): no current item'); return s.item },
    actions: (n) => lookup(scope, n),
    outputs: (n) => lookup(scope, n)?.outputs ?? null,
    body: (n) => { const o = lookup(scope, n)?.outputs; return o === undefined || o === null ? null : (isObj(o) && 'body' in o ? o.body : o) },
  }
}
const find = (scope, pred) => { for (let s = scope; s; s = s.parent) if (pred(s)) return s; return null }
// An action is visible to everything that runs after it in the same run (the engine keeps results per run, not per
// branch). Inside a loop the current iteration's result is found first through the scope chain.
let GLOBAL = new Map()
function lookup(scope, name) { for (let s = scope; s; s = s.parent) if (s.results?.has(name)) return s.results.get(name); return GLOBAL.get(name) ?? null }

function evalNode(n, env, scope) {
  if (n.t === 'lit') return n.v
  if (n.t === 'idx') {
    const o = evalNode(n.o, env, scope); const k = evalNode(n.k, env, scope)
    if (o === null || o === undefined) { if (n.safe) return null; throw new Error(`cannot read [${JSON.stringify(k)}] of null`) }
    if (Array.isArray(o)) { if (typeof k !== 'number') throw new Error('array index must be a number'); return o[k] ?? null }
    if (!isObj(o)) throw new Error(`cannot select property ${JSON.stringify(k)} of a ${typeof o} value`)       // strict on purpose
    if (typeof k === 'string' && k.includes('/') && !(k in o)) {       // Power Automate path shorthand: outputs('X')?['body/value']
      let cur = o
      for (const part of k.split('/')) { if (cur === null || cur === undefined) return null; if (!isObj(cur)) throw new Error(`cannot select ${JSON.stringify(part)} of a ${typeof cur} value`); cur = cur[part] ?? null }
      return cur
    }
    return o[k] ?? null
  }
  const f = functions(env, scope)[n.f]
  if (!f) throw new Error(`unsupported function ${n.f}() - add it to tests/helpers/wdl.mjs only if the flows really need it`)
  return f(...n.args.map((a) => evalNode(a, env, scope)))
}

/** Evaluate any JSON value from a definition: "@expr", "text @{expr} text", or nested objects / arrays. */
export function evaluate(v, env, scope) {
  if (typeof v === 'string') {
    if (v.startsWith('@@')) return v.slice(1)
    if (v.startsWith('@') && !v.startsWith('@{')) return evalNode(parsed(v.slice(1)), env, scope)
    if (!v.includes('@{')) return v
    let out = ''; let i = 0
    while (i < v.length) {
      const at = v.indexOf('@{', i)
      if (at < 0) { out += v.slice(i); break }
      out += v.slice(i, at)
      let depth = 0; let j = at + 2; let inStr = false
      for (; j < v.length; j++) { const c = v[j]; if (c === "'") inStr = !inStr; else if (!inStr && c === '{') depth++; else if (!inStr && c === '}') { if (depth === 0) break; depth-- } }
      out += str(evalNode(parsed(v.slice(at + 2, j)), env, scope)); i = j + 1
    }
    return out
  }
  if (Array.isArray(v)) return v.map((x) => evaluate(x, env, scope))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, evaluate(x, env, scope)]))
  return v
}

function condition(c, env, scope) {
  if (typeof c === 'string') return evaluate(c, env, scope) === true
  const [op, arg] = Object.entries(c)[0]
  if (op === 'and') return arg.every((x) => condition(x, env, scope))
  if (op === 'or') return arg.some((x) => condition(x, env, scope))
  if (op === 'not') return !condition(arg, env, scope)
  const [a, b] = arg.map((x) => evaluate(x, env, scope))
  const f = functions(env, scope)[op]
  if (!f) throw new Error('unsupported condition operator ' + op)
  return f(a, b)
}

// ---------------- actions ----------------
async function runAction(name, a, env, scope) {
  env.count++
  env.trace.push(name)
  const start = env.now()
  const rec = { status: 'Succeeded', code: 'OK', outputs: null, startTime: new Date(start).toISOString(), endTime: null, error: undefined }
  try {
    switch (a.type) {
      case 'Compose': rec.outputs = evaluate(a.inputs, env, scope); break
      case 'InitializeVariable': for (const v of a.inputs.variables) { if (scope.parent) throw new Error('variables can only be initialized at the top level'); env.vars.set(v.name, evaluate(v.value, env, scope)) } break
      case 'SetVariable': if (!env.vars.has(a.inputs.name)) throw new Error('unknown variable ' + a.inputs.name); env.vars.set(a.inputs.name, evaluate(a.inputs.value, env, scope)); break
      case 'AppendToArrayVariable': { const arr = env.vars.get(a.inputs.name); if (!Array.isArray(arr)) throw new Error(a.inputs.name + ' is not an array variable'); arr.push(evaluate(a.inputs.value, env, scope)); break }
      case 'Query': { const from = evaluate(a.inputs.from, env, scope); if (!Array.isArray(from)) throw new Error(`Query ${name}: "from" is not an array`); rec.outputs = { body: from.filter((item) => { const r = evaluate(a.inputs.where, env, { parent: scope, item }); if (typeof r !== 'boolean') throw new Error(`Query ${name}: "where" is not a boolean`); return r }) }; break }
      case 'Select': { const from = evaluate(a.inputs.from, env, scope); if (!Array.isArray(from)) throw new Error(`Select ${name}: "from" is not an array`); rec.outputs = { body: from.map((item) => evaluate(a.inputs.select, env, { parent: scope, item })) }; break }
      case 'If': { const branch = condition(a.expression, env, scope) ? a.actions : (a.else?.actions ?? {}); const st = await runActions(branch, env, { parent: scope, results: new Map() }, name); if (st !== 'Succeeded') { rec.status = 'Failed'; rec.code = 'ActionFailed' } break }
      case 'Foreach': {
        const list = evaluate(a.foreach, env, scope)
        if (!Array.isArray(list)) throw new Error(`Foreach ${name}: not an array`)
        let failed = false
        for (const it of list) { const st = await runActions(a.actions, env, { parent: scope, results: new Map(), loops: new Map([[name, it]]) }, name); if (st !== 'Succeeded') failed = true }
        if (failed) { rec.status = 'Failed'; rec.code = 'ActionFailed' }
        break
      }
      case 'Http': {
        const inputs = evaluate(a.inputs, env, scope)
        if (a.runtimeConfiguration?.secureData) env.secured.push(name)
        const r = await env.http(inputs, a)
        env.advance(r.elapsedMs ?? 100)
        if (r.timedOut) { rec.status = 'TimedOut'; rec.code = 'ActionTimedOut'; rec.error = { code: 'ActionTimedOut', message: r.message ?? 'The execution of template action timed out.' } }
        else if (r.statusCode === undefined || r.statusCode === null) { rec.status = 'Failed'; rec.code = r.code ?? 'BadGateway'; rec.error = { code: rec.code, message: r.message ?? 'Http request failed.' } }
        else { rec.outputs = { statusCode: r.statusCode, headers: {}, body: r.body ?? '' }; if (r.statusCode >= 300) { rec.status = 'Failed'; rec.code = r.code ?? 'HttpError'; if (r.message) rec.error = { code: rec.code, message: r.message } } }
        break
      }
      case 'OpenApiConnection': {
        const inputs = evaluate(a.inputs, env, scope)
        const r = await env.connector(inputs.host.connectionName, inputs.host.operationId, inputs.parameters, name)
        if (r.error) { rec.status = 'Failed'; rec.code = r.code ?? 'BadRequest'; rec.error = { code: rec.code, message: r.error }; rec.outputs = { statusCode: r.statusCode ?? 400, body: { error: { message: r.error } } } }
        else rec.outputs = { statusCode: r.statusCode ?? 200, body: r.body ?? null }
        break
      }
      default: throw new Error('unsupported action type ' + a.type)
    }
  } catch (e) {
    if (e instanceof Skip) throw e
    rec.status = 'Failed'; rec.code = 'InvalidTemplate'; rec.error = { code: 'InvalidTemplate', message: String(e.message) }
    env.expressionErrors.push(`${name}: ${e.message}`)
  }
  rec.endTime = new Date(env.now()).toISOString()
  return rec
}

/** Runs a set of sibling actions honouring runAfter. Returns the status of the container. */
async function runActions(actions, env, scope, container = '(root)') {
  const names = Object.keys(actions ?? {})
  const done = new Map()
  const pending = new Set(names)
  while (pending.size) {
    let progressed = false
    for (const n of [...pending]) {
      const deps = Object.entries(actions[n].runAfter ?? {})
      for (const [d] of deps) if (!(d in actions)) throw new Error(`${container}/${n}: runAfter names unknown sibling ${d}`)
      if (deps.some(([d]) => !done.has(d))) continue
      pending.delete(n); progressed = true
      const allowed = deps.every(([d, sts]) => sts.includes(done.get(d).status))
      const rec = allowed ? await runAction(n, actions[n], env, scope) : { status: 'Skipped', code: 'ActionSkipped', outputs: null }
      done.set(n, rec); scope.results.set(n, rec); GLOBAL.set(n, rec)
      env.statuses.set(n, rec.status)
    }
    if (!progressed) throw new Error(`${container}: runAfter cycle among ${[...pending].join(', ')}`)
  }
  // a failure is "handled" when a later sibling was configured to run after that outcome (and did run)
  for (const n of names) {
    const st = done.get(n).status
    if (st !== 'Failed' && st !== 'TimedOut') continue
    const handled = names.some((m) => (actions[m].runAfter?.[n] ?? []).includes(st) && done.get(m).status !== 'Skipped')
    if (!handled) return 'Failed'
  }
  return 'Succeeded'
}

/**
 * Runs one flow definition once.
 * env: { now(): ms, advance(ms), http(inputs) -> {statusCode, body, elapsedMs} | {code, message} | {timedOut}, connector(api, operationId, parameters) -> {body} | {error, code} }
 * Returns { status, statuses (per action name, last value), count (actions executed), expressionErrors, trace }.
 */
export async function runFlow(clientdata, env) {
  GLOBAL = new Map()
  const e = { ...env, vars: new Map(), statuses: new Map(), count: 1, trace: [], expressionErrors: [], secured: [] }    // count starts at 1: the trigger
  const status = await runActions(clientdata.properties.definition.actions, e, { parent: null, results: new Map() })
  return { status, statuses: e.statuses, count: e.count, expressionErrors: e.expressionErrors, trace: e.trace, vars: e.vars, secured: e.secured }
}

/** Connector that maps the Dataverse operations of the flows onto the mock Dataverse, and captures Teams posts. */
export function mockConnector(mock, { teams = [], teamsFails = null } = {}) {
  const call = (method, path, body) => { const r = mock.handle(method, 'http://mock/api/data/v9.2/' + path, { authorization: 'Bearer ' + mock.token }, body === undefined ? '' : JSON.stringify(body)); return { status: r.status, json: r.body ? JSON.parse(r.body) : null, headers: r.headers } }
  const fail = (r) => ({ error: r.json?.error?.message ?? 'request failed', code: 'BadRequest', statusCode: r.status })
  const items = (p) => Object.fromEntries(Object.entries(p).filter(([k, v]) => k.startsWith('item/') && v !== null && v !== undefined).map(([k, v]) => [k.slice(5), v]))   // null parameters are not sent
  return async (api, op, p) => {
    if (api === 'shared_teams') {
      if (op !== 'PostMessageToConversation') return { error: 'unknown Teams operation ' + op }
      if (typeof teamsFails === 'function' ? teamsFails() : teamsFails) return { error: typeof teamsFails === 'function' ? teamsFails() : teamsFails, code: 'Forbidden', statusCode: 403 }
      for (const k of ['poster', 'location', 'body/recipient/groupId', 'body/recipient/channelId', 'body/messageBody']) if (typeof p[k] !== 'string' || !p[k]) return { error: `Teams post without ${k}` }
      if (p['body/messageBody'].length > 28000) return { error: 'message too large', code: 'RequestEntityTooLarge', statusCode: 413 }
      teams.push({ groupId: p['body/recipient/groupId'], channelId: p['body/recipient/channelId'], poster: p.poster, location: p.location, html: p['body/messageBody'] })
      return { body: { id: String(teams.length) }, statusCode: 201 }
    }
    if (api !== 'shared_commondataserviceforapps') return { error: 'unknown connector ' + api }
    if (op === 'ListRecords') {
      const qs = ['$select', '$filter', '$orderby', '$top'].filter((k) => p[k] !== undefined && p[k] !== null).map((k) => `${k}=${encodeURIComponent(p[k])}`).join('&')
      const r = call('GET', `${p.entityName}?${qs}`)
      return r.status === 200 ? { body: r.json } : fail(r)
    }
    if (op === 'CreateRecord') { const r = call('POST', p.entityName, items(p)); return r.status === 204 ? { body: {} } : fail(r) }
    if (op === 'UpdateRecord') {
      if (typeof p.recordId !== 'string' || !/^[0-9a-f-]{36}$/.test(p.recordId)) return { error: `UpdateRecord: recordId is not a row id (${JSON.stringify(p.recordId)})`, statusCode: 404, code: 'NotFound' }
      const r = call('PATCH', `${p.entityName}(${p.recordId})`, items(p)); return r.status === 204 ? { body: {} } : fail(r)
    }
    if (op === 'DeleteRecord') { const r = call('DELETE', `${p.entityName}(${p.recordId})`); return r.status === 204 ? { body: {} } : fail(r) }
    return { error: 'unknown Dataverse operation ' + op }
  }
}
