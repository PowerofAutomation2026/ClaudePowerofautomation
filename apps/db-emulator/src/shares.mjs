/**
 * Shared-dashboard store simulator. Models "publish a dashboard so other people can open it":
 * owner, per-person permission (view / edit), "everyone", optimistic versioning and an optional data snapshot.
 * Identity comes from the x-user header (the emulator trusts it: test tool only).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PERMS = new Set(['view', 'edit'])
const MAX_DEF = 2 * 1024 * 1024, MAX_SNAP = 12 * 1024 * 1024

export class ShareStore {
  constructor(file) {
    this.file = file
    this.items = new Map()
    try { for (const x of JSON.parse(fs.readFileSync(file, 'utf8'))) this.items.set(x.id, x) } catch { /* new store */ }
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify([...this.items.values()])) }
  static user(req) { const u = String(req.headers['x-user'] ?? '').trim().toLowerCase(); return EMAIL.test(u) ? u : null }
  permission(item, user) {
    if (item.owner === user) return 'owner'
    const p = item.sharedWith.find((s) => s.user === user)?.permission
    if (p) return p
    if (item.everyone === 'view' || item.everyone === 'edit') return item.everyone
    return null
  }
  summary(item, user) {
    const perm = this.permission(item, user)
    return { id: item.id, name: item.name, owner: item.owner, permission: perm, updated: item.updated, updatedBy: item.updatedBy, version: item.version, everyone: item.everyone, hasSnapshot: !!item.snapshot, sourceKind: item.definition?.source?.kind ?? null, sharedWith: perm === 'owner' ? item.sharedWith : undefined }
  }
  list(user) { return [...this.items.values()].filter((x) => this.permission(x, user)).sort((a, b) => b.updated.localeCompare(a.updated)).map((x) => this.summary(x, user)) }
  get(id, user) { const x = this.items.get(id); if (!x || !this.permission(x, user)) return null; return { ...this.summary(x, user), definition: x.definition, snapshot: x.snapshot ?? null } }
  parseShare(body, strict) {
    const everyone = body.everyone ?? (strict ? 'none' : undefined)
    if (everyone !== undefined && !['none', 'view', 'edit'].includes(everyone)) throw err(400, 'everyone must be none, view or edit')
    let sharedWith
    if (body.sharedWith !== undefined) {
      if (!Array.isArray(body.sharedWith) || body.sharedWith.length > 500) throw err(400, 'sharedWith must be a list of up to 500 people')
      sharedWith = body.sharedWith.map((s) => ({ user: String(s.user ?? '').trim().toLowerCase(), permission: s.permission }))
      for (const s of sharedWith) { if (!EMAIL.test(s.user)) throw err(400, `Not an email address: ${s.user}`); if (!PERMS.has(s.permission)) throw err(400, `Permission for ${s.user} must be view or edit`) }
      sharedWith = [...new Map(sharedWith.map((s) => [s.user, s])).values()]
    }
    return { everyone, sharedWith }
  }
  checkSize(body) {
    if (body.definition !== undefined && (typeof body.definition !== 'object' || body.definition === null || JSON.stringify(body.definition).length > MAX_DEF)) throw err(400, 'definition must be an object under 2 MB')
    if (body.snapshot != null && JSON.stringify(body.snapshot).length > MAX_SNAP) throw err(413, 'The data snapshot is larger than 12 MB')
  }
  create(user, body) {
    if (!body.name || String(body.name).length > 120) throw err(400, 'name is required (max 120 characters)')
    if (!body.definition) throw err(400, 'definition is required')
    this.checkSize(body)
    const { everyone, sharedWith } = this.parseShare(body, true)
    const now = new Date().toISOString()
    const item = { id: crypto.randomBytes(8).toString('hex'), name: String(body.name), owner: user, definition: body.definition, snapshot: body.snapshot ?? null, sharedWith: (sharedWith ?? []).filter((s) => s.user !== user), everyone, version: 1, created: now, updated: now, updatedBy: user }
    this.items.set(item.id, item); this.save()
    return this.get(item.id, user)
  }
  update(user, id, body) {
    const item = this.items.get(id)
    const perm = item ? this.permission(item, user) : null
    if (!item || !perm) throw err(404, 'Dashboard not found')
    if (perm === 'view') throw err(403, 'You can view this dashboard but not change it')
    const changesSharing = body.sharedWith !== undefined || body.everyone !== undefined
    if (changesSharing && perm !== 'owner') throw err(403, 'Only the owner can change who it is shared with')
    this.checkSize(body)
    const contentChange = body.definition !== undefined || body.snapshot !== undefined || body.name !== undefined
    if (contentChange && body.baseVersion !== item.version) { const e = err(409, `Version conflict: someone else saved version ${item.version} first. Reload and try again.`); e.currentVersion = item.version; throw e }
    const { everyone, sharedWith } = this.parseShare(body, false)
    if (body.name !== undefined) { if (!body.name || String(body.name).length > 120) throw err(400, 'name is required (max 120 characters)'); item.name = String(body.name) }
    if (body.definition !== undefined) item.definition = body.definition
    if (body.snapshot !== undefined) item.snapshot = body.snapshot
    if (everyone !== undefined) item.everyone = everyone
    if (sharedWith !== undefined) item.sharedWith = sharedWith.filter((s) => s.user !== item.owner)
    item.version += 1; item.updated = new Date().toISOString(); item.updatedBy = user
    this.save()
    return this.get(id, user)
  }
  remove(user, id) {
    const item = this.items.get(id)
    if (!item || !this.permission(item, user)) throw err(404, 'Dashboard not found')
    if (item.owner !== user) throw err(403, 'Only the owner can stop sharing and delete it')
    this.items.delete(id); this.save()
  }

  async handle(req, res, url, helpers) {
    const { send, fail, readBody } = helpers
    const p = url.pathname.replace(/\/+$/, '')
    const m = /^\/shares(?:\/([0-9a-f]{16}))?$/.exec(p)
    if (!m) return false
    try {
      const user = ShareStore.user(req)
      if (!user) { fail(res, null, 401, 0, 'Send the signed-in user as an x-user header (an email address).'); return true }
      const id = m[1]
      if (!id && req.method === 'GET') return send(res, 200, { user, value: this.list(user) }), true
      if (!id && req.method === 'POST') return send(res, 201, this.create(user, JSON.parse(await readBody(req, MAX_SNAP + MAX_DEF)))), true
      if (id && req.method === 'GET') { const g = this.get(id, user); if (!g) throw err(404, 'Dashboard not found'); return send(res, 200, g), true }
      if (id && req.method === 'PUT') return send(res, 200, this.update(user, id, JSON.parse(await readBody(req, MAX_SNAP + MAX_DEF)))), true
      if (id && req.method === 'DELETE') { this.remove(user, id); return send(res, 200, { deleted: true }), true }
      fail(res, null, 405, 0, 'Method not allowed'); return true
    } catch (e) {
      if (e instanceof SyntaxError) { fail(res, null, 400, 0, 'Invalid JSON body'); return true }
      fail(res, null, e.status ?? 500, 0, e.message); return true
    }
  }
}
function err(status, message) { const e = new Error(message); e.status = status; return e }
