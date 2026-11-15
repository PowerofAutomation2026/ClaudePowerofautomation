// In-memory stand-in for the parts of the Dataverse Web API that provisioning uses.
// Used by (a) the unit tests, through a real local HTTP server, and (b) `owpp.mjs plan` (-DryRun), to show the
// exact request sequence without touching a tenant. It is a MODEL written from the public documentation,
// not Microsoft's implementation: passing against it proves the request sequence and payload shapes are
// self-consistent, not that a real environment accepts them.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const SYSTEM_SETS = { publishers: 'publisherid', solutions: 'solutionid', connectionreferences: 'connectionreferenceid', workflows: 'workflowid' }

export function createMockDataverse({ token = 'test-token', failActivation = null, autoRun = true, entitySetSuffix = 's' } = {}) {
  const db = { publishers: [], solutions: [], connectionreferences: [], workflows: [] }
  const entities = new Map()        // logical -> { MetadataId, LogicalName, EntitySetName, PrimaryId, attributes:Set, solution }
  const log = []                    // every request: { method, path, solution }
  const problems = []               // payload-shape violations the mock noticed
  const state = { failActivation, autoRun, transientAttrFails: 0, attrFailsAfterCreate: 0, attrAlwaysFails: false, staleSchemaReads: 0 }

  const reply = (status, json, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: json === undefined ? '' : JSON.stringify(json) })
  const err = (status, message, code = '0x0') => reply(status, { error: { code, message } })
  const setFor = (name) => (name in SYSTEM_SETS ? { rows: db[name], pk: SYSTEM_SETS[name] } : (() => { const e = [...entities.values()].find((x) => x.EntitySetName === name); return e ? { rows: (db[name] ??= []), pk: e.PrimaryId, entity: e } : null })())

  function lit(v) {
    if (/^'.*'$/s.test(v)) return v.slice(1, -1).replace(/''/g, "'")
    if (v === 'true') return true
    if (v === 'false') return false
    if (v === 'null') return null
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(v)) return Number(v)
    return v
  }
  function matches(row, filter) {
    if (!filter) return true
    return filter.split(/\s+and\s+/).every((cl) => {
      const m = /^(\S+)\s+(eq|ne|ge|gt|le|lt)\s+(.+)$/s.exec(cl.trim())
      if (!m) throw new Error('mock: unsupported $filter clause: ' + cl)
      const a = row[m[1]] ?? (m[1] === 'statecode' ? 0 : null); const b = lit(m[3].trim())
      switch (m[2]) { case 'eq': return a === b; case 'ne': return a !== b; case 'ge': return a >= b; case 'gt': return a > b; case 'le': return a <= b; default: return a < b }
    })
  }
  const check = (cond, what) => { if (!cond) problems.push(what) }

  function validateEntityCreate(b, solution) {
    for (const k of ['SchemaName', 'DisplayName', 'DisplayCollectionName', 'OwnershipType', 'Attributes']) check(b?.[k] !== undefined, `EntityDefinitions POST without ${k}`)
    check(b?.['@odata.type'] === 'Microsoft.Dynamics.CRM.EntityMetadata', 'EntityDefinitions POST without @odata.type EntityMetadata')
    const prim = (b?.Attributes ?? []).filter((a) => a.IsPrimaryName === true)
    check(prim.length === 1 && prim[0]['@odata.type'] === 'Microsoft.Dynamics.CRM.StringAttributeMetadata', 'table needs exactly one primary name String attribute')
    check(b?.DisplayName?.LocalizedLabels?.[0]?.LanguageCode === 1033, 'DisplayName label missing')
    checkPrefix(b?.SchemaName, solution)
  }
  function validateAttribute(a, solution) {
    check(/^Microsoft\.Dynamics\.CRM\.(String|Integer|Boolean|DateTime|Memo)AttributeMetadata$/.test(a?.['@odata.type'] ?? ''), 'attribute without a known @odata.type')
    for (const k of ['SchemaName', 'DisplayName', 'AttributeType', 'RequiredLevel']) check(a?.[k] !== undefined, `attribute ${a?.SchemaName} without ${k}`)
    if (a?.AttributeType === 'Boolean') check(a.OptionSet?.TrueOption?.Value === 1 && a.OptionSet?.FalseOption?.Value === 0 && a.OptionSet?.OptionSetType === 'Boolean', `boolean ${a.SchemaName} needs OptionSet True/False options`)
    if (a?.AttributeType === 'String') check(Number.isInteger(a.MaxLength) && a.MaxLength > 0 && a.MaxLength <= 4000, `string ${a.SchemaName} needs MaxLength`)
    if (a?.AttributeType === 'Integer') check(Number.isInteger(a.MinValue) && Number.isInteger(a.MaxValue) && a.MaxValue <= 2147483647, `integer ${a.SchemaName} needs MinValue/MaxValue`)
    checkPrefix(a?.SchemaName, solution)
  }
  function checkPrefix(schemaName, solution) {
    const sol = db.solutions.find((s) => s.uniquename === solution)
    check(!!sol, `metadata created without an existing solution in MSCRM.SolutionUniqueName (${solution})`)
    const pub = sol && db.publishers.find((p) => p.publisherid === sol._publisherid)
    if (pub) check(String(schemaName).startsWith(pub.customizationprefix + '_'), `${schemaName} does not use the publisher prefix ${pub.customizationprefix}_`)
  }
  function validateWorkflow(b) {
    for (const k of ['category', 'name', 'type', 'primaryentity', 'clientdata']) check(b?.[k] !== undefined, `workflows POST without ${k}`)
    check(b?.category === 5 && b?.type === 1 && b?.primaryentity === 'none', 'cloud flow needs category 5, type 1, primaryentity none')
    validateClientData(b?.clientdata)
  }
  function validateClientData(text) {
    check(typeof text === 'string', 'clientdata must be a JSON STRING')
    let cd; try { cd = JSON.parse(text) } catch { check(false, 'clientdata is not valid JSON'); return }
    check(cd?.schemaVersion === '1.0.0.0', 'clientdata.schemaVersion')
    const def = cd?.properties?.definition
    check(!!def?.$schema && !!def?.triggers && !!def?.actions, 'clientdata.properties.definition needs $schema, triggers, actions')
    check(def?.parameters?.$authentication?.type === 'SecureObject' && def?.parameters?.$connections?.type === 'Object', 'definition.parameters $connections/$authentication')
    for (const [k, r] of Object.entries(cd?.properties?.connectionReferences ?? {})) {
      check(r?.api?.name === k && r?.runtimeSource === 'embedded', `connectionReferences.${k} shape`)
      const ln = r?.connection?.connectionReferenceLogicalName
      check(db.connectionreferences.some((c) => c.connectionreferencelogicalname === ln), `flow uses connection reference ${ln} which does not exist yet`)
    }
    const names = new Set()
    const walk = (actions) => {
      for (const [n, a] of Object.entries(actions ?? {})) {
        check(!names.has(n), `duplicate action name ${n}`); names.add(n)
        check(typeof a.type === 'string', `action ${n} without type`)
        for (const dep of Object.keys(a.runAfter ?? {})) check(dep in actions, `action ${n} runs after unknown sibling ${dep}`)
        for (const st of Object.values(a.runAfter ?? {}).flat()) check(['Succeeded', 'Failed', 'Skipped', 'TimedOut'].includes(st), `action ${n}: bad runAfter status ${st}`)
        if (a.type === 'OpenApiConnection') {
          check(a.inputs?.host?.connectionName in (cd.properties.connectionReferences ?? {}), `action ${n} uses an undeclared connection`)
          const set = a.inputs?.parameters?.entityName
          check(!!setFor(set), `action ${n} targets unknown entity set ${set}`)
        }
        if (a.actions) walk(a.actions)
      }
    }
    walk(def?.actions)
  }

  function runFlowOnce(wf) {           // what the real flow would do on its first run: one raw row per enabled target
    const tset = [...entities.values()].find((e) => e.LogicalName === 'owatch_target')
    const rset = [...entities.values()].find((e) => e.LogicalName === 'owatch_result')
    if (!tset || !rset) return
    const at = new Date().toISOString()
    for (const t of db[tset.EntitySetName] ?? []) {
      if (t.owatch_enabled === false) continue
      ;(db[rset.EntitySetName] ??= []).push({ owatch_resultid: randomUUID(), owatch_name: t.owatch_name, owatch_httpstatus: 200, owatch_elapsedms: 120, owatch_errorkind: '', owatch_probedat: at, owatch_round: at, _flow: wf.workflowid })
    }
  }

  function handle(method, rawUrl, headers = {}, bodyText = '') {
    const u = new URL(rawUrl, 'http://mock')
    const auth = headers.authorization ?? headers.Authorization
    if (auth !== 'Bearer ' + token) return err(401, 'Unauthorized')
    if (!u.pathname.startsWith('/api/data/v9.2/')) return err(404, 'not found')
    const path = decodeURIComponent(u.pathname.slice('/api/data/v9.2/'.length))
    const solution = headers['mscrm.solutionuniquename'] ?? headers['MSCRM.SolutionUniqueName'] ?? null
    log.push({ method, path, query: decodeURIComponent(u.search), solution })
    let body = null
    if (bodyText) { try { body = JSON.parse(bodyText) } catch { return err(400, 'invalid JSON body') } }
    if (body && typeof body === 'object') for (const k of Object.keys(body)) if (body[k] === '') body[k] = null     // Dataverse stores an empty string as null
    const qp = (k) => u.searchParams.get(k)

    if (path === 'WhoAmI' && method === 'GET') return reply(200, { UserId: '11111111-1111-1111-1111-111111111111', BusinessUnitId: randomUUID(), OrganizationId: randomUUID() })
    if (path === 'PublishXml' && method === 'POST') { check(/<entity>/.test(body?.ParameterXml ?? ''), 'PublishXml without ParameterXml'); return reply(204) }

    let m = /^EntityDefinitions(?:\(LogicalName='([a-z0-9_]+)'\))?(?:\/Attributes(?:\(LogicalName='([a-z0-9_]+)'\))?)?$/.exec(path)
    if (m) {
      const [, logical, attr] = m
      const isAttrPath = /\/Attributes/.test(path)
      if (!logical) {
        if (method !== 'POST') return err(405, 'unsupported')
        validateEntityCreate(body, solution)
        const ln = String(body.SchemaName).toLowerCase()
        if (entities.has(ln)) return err(400, `An entity with name ${ln} already exists`)
        const prim = body.Attributes.find((a) => a.IsPrimaryName)
        const e = { MetadataId: randomUUID(), LogicalName: ln, EntitySetName: ln + entitySetSuffix, PrimaryId: ln + 'id', attributes: new Set([ln + 'id', String(prim?.SchemaName).toLowerCase()]), solution }
        entities.set(ln, e)
        return reply(204, undefined, { 'OData-EntityId': `http://mock/api/data/v9.2/EntityDefinitions(${e.MetadataId})` })
      }
      const e = entities.get(logical)
      if (!e) return err(404, `Could not find an entity with name ${logical}`)
      if (!isAttrPath) {
        if (method === 'GET') return reply(200, { MetadataId: e.MetadataId, LogicalName: e.LogicalName, EntitySetName: e.EntitySetName })
        if (method === 'DELETE') { entities.delete(logical); delete db[e.EntitySetName]; return reply(204) }
        return err(405, 'unsupported')
      }
      if (attr) return method === 'GET' ? (e.attributes.has(attr) ? reply(200, { LogicalName: attr }) : err(404, `Could not find an attribute with name ${attr}`)) : err(405, 'unsupported')
      if (method !== 'POST') return err(405, 'unsupported')
      if (state.attrAlwaysFails) return err(400, 'An unexpected error occurred.', '0x80040216')
      if (state.transientAttrFails > 0) { state.transientAttrFails--; return err(400, 'An unexpected error occurred.', '0x80040216') }
      validateAttribute(body, solution)
      const an = String(body.SchemaName).toLowerCase()
      if (e.attributes.has(an)) return err(400, `Attribute ${an} already exists`)
      e.attributes.add(an)
      if (state.attrFailsAfterCreate > 0) { state.attrFailsAfterCreate--; return err(400, 'An unexpected error occurred.', '0x80040216') }   // applied, but the reply was an error
      return reply(204, undefined, { 'OData-EntityId': `http://mock/api/data/v9.2/EntityDefinitions(${e.MetadataId})/Attributes(${randomUUID()})` })
    }

    m = /^([a-z0-9_]+)(?:\(([0-9a-f-]{36})\))?$/.exec(path)
    if (!m) return err(404, 'Resource not found for the segment ' + path)
    if (method === 'GET' && m[1] === 'owatch_settings' && state.staleSchemaReads > 0) {      // Web API schema cache not refreshed yet
      state.staleSchemaReads--
      return err(400, "Could not find a property named 'owatch_value' on type 'Microsoft.Dynamics.CRM.owatch_setting'.", '0x80060888')
    }
    const set = setFor(m[1])
    if (!set) return err(404, `Resource not found for the segment '${m[1]}'`)
    const id = m[2]
    if (!id) {
      if (method === 'GET') {
        let rows
        try { rows = set.rows.filter((r) => matches(r, qp('$filter'))) } catch (e) { return err(400, e.message) }
        const ob = qp('$orderby')
        if (ob) { const [f, dir] = ob.split(/\s+/); rows = [...rows].sort((a, b) => (a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : 0) * (dir === 'desc' ? -1 : 1)) }
        if (qp('$top')) rows = rows.slice(0, Number(qp('$top')))
        return reply(200, { value: rows.map(({ _publisherid, _flow, ...r }) => r) })
      }
      if (method === 'POST') {
        const row = { ...body, [set.pk]: randomUUID() }
        if (m[1] === 'publishers') { for (const k of ['uniquename', 'friendlyname', 'customizationprefix', 'customizationoptionvalueprefix']) check(body?.[k] !== undefined, `publisher without ${k}`); check(/^[a-z][a-z0-9]{1,7}$/.test(body?.customizationprefix ?? ''), 'publisher prefix must be 2-8 lowercase alphanumerics') ; check(body?.customizationoptionvalueprefix >= 10000 && body?.customizationoptionvalueprefix <= 99999, 'option value prefix must be 10000-99999') }
        if (m[1] === 'solutions') { const b = /^\/publishers\(([0-9a-f-]{36})\)$/.exec(body?.['publisherid@odata.bind'] ?? ''); check(!!b && db.publishers.some((p) => p.publisherid === b[1]), 'solution must bind an existing publisher'); check(!!body?.uniquename && !!body?.version, 'solution needs uniquename and version'); row._publisherid = b?.[1]; delete row['publisherid@odata.bind'] }
        if (m[1] === 'connectionreferences') { for (const k of ['connectionreferencelogicalname', 'connectorid']) check(!!body?.[k], `connection reference without ${k}`); check(solution !== null, 'connection reference created outside a solution') }
        if (m[1] === 'workflows') { validateWorkflow(body); check(solution !== null, 'flow created outside a solution'); row.statecode = 0 }
        if (set.entity) for (const k of Object.keys(body ?? {})) check(set.entity.attributes.has(k), `row for ${m[1]} uses unknown column ${k}`)
        set.rows.push(row)
        return reply(204, undefined, { 'OData-EntityId': `http://mock/api/data/v9.2/${m[1]}(${row[set.pk]})` })
      }
      return err(405, 'unsupported')
    }
    const row = set.rows.find((r) => r[set.pk] === id)
    if (!row) return err(404, `${m[1]} With Id = ${id} Does Not Exist`)
    if (method === 'GET') { const { _publisherid, _flow, ...pub } = row; return reply(200, pub) }
    if (method === 'DELETE') {
      if (m[1] === 'workflows') check(row.statecode !== 1, 'flow deleted while still ON')
      set.rows.splice(set.rows.indexOf(row), 1); return reply(204)
    }
    if (method === 'PATCH') {
      if (m[1] === 'workflows') {
        if (body.clientdata !== undefined) { check(row.statecode !== 1, 'flow definition patched while ON'); validateClientData(body.clientdata) }
        if (body.statecode === 1 && row.statecode !== 1) {
          if (state.failActivation) return err(400, state.failActivation, '0x80060467')
          const cd = JSON.parse(row.clientdata)
          for (const r of Object.values(cd.properties.connectionReferences)) {
            const cr = db.connectionreferences.find((c) => c.connectionreferencelogicalname === r.connection.connectionReferenceLogicalName)
            if (!cr?.connectionid) return err(400, 'Flow client error returned with status code "BadRequest": connection reference has no connection', 'ConnectionAuthorizationFailed')
          }
          Object.assign(row, body)
          if (state.autoRun) runFlowOnce(row)
          return reply(204)
        }
      }
      if (set.entity) for (const k of Object.keys(body ?? {})) check(set.entity.attributes.has(k), `row patch for ${m[1]} uses unknown column ${k}`)
      Object.assign(row, body)
      return reply(204)
    }
    return err(405, 'unsupported')
  }

  /** fetch()-compatible adapter (no sockets): used by `plan`. */
  async function mockFetch(url, init = {}) {
    const r = handle(init.method ?? 'GET', url, init.headers ?? {}, init.body ?? '')
    return new Response(r.body || null, { status: r.status, headers: r.headers })
  }

  /** Real HTTP server on 127.0.0.1 (used by the tests so the real fetch + header handling is exercised). */
  function listen() {
    const server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => { data += c })
      req.on('end', () => {
        const r = handle(req.method, req.url, req.headers, data)
        res.writeHead(r.status, r.headers); res.end(r.body)
      })
    })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })))
  }

  return { handle, mockFetch, listen, db, entities, log, problems, state, token }
}
