import type { Access, AppConfig, Role, ViewDef } from './types'
import { sameUser } from './util'

/** SharePoint base-permission bits (low word). */
export const PERM = { View: 0x1, Add: 0x2, Edit: 0x4, Delete: 0x8, ManageLists: 0x800, ManagePermissions: 0x2000000 }

export function accessFrom(low: number, groups: string[], isSiteAdmin: boolean, cfg: AppConfig, upn: string): Access {
  const has = (b: number) => (low & b) === b
  const owner = cfg.owners.some((o) => sameUser(o, upn))
  const inAny = (names?: string[]) => !!names?.length && names.some((n) => groups.some((g) => g.toLowerCase() === n.toLowerCase()))
  let canAdd = has(PERM.Add), canEdit = has(PERM.Edit), canDelete = has(PERM.Delete)
  const spAdmin = has(PERM.ManageLists) || has(PERM.ManagePermissions) || isSiteAdmin
  let reason = ''
  // optional app-level restriction: if writer groups are named, only those groups (or admins) may write
  const writerOk = !cfg.writerGroups?.length || inAny(cfg.writerGroups) || inAny(cfg.adminGroups) || spAdmin || owner
  if (!writerOk) { canAdd = canEdit = canDelete = false; reason = `Write access is limited to: ${cfg.writerGroups!.join(', ')}.` }
  const adminOk = cfg.adminGroups?.length ? inAny(cfg.adminGroups) || owner : spAdmin || owner
  if (!(adminOk && canDelete)) canDelete = canDelete && adminOk
  let role: Role = 'reader'
  if (canDelete && adminOk) role = 'admin'
  else if (canAdd || canEdit) role = 'writer'
  if (!reason) reason = role === 'admin' ? 'Full control of the data (add, edit, delete).' : role === 'writer' ? 'You can add and edit items (SharePoint group with Contribute/Edit).' : has(PERM.View) ? 'Read-only: you can view and export data.' : 'You have no SharePoint permission on this list.'
  const canManage = has(PERM.ManagePermissions) && (!cfg.adminGroups?.length || adminOk)
  return { role, canAdd, canEdit, canDelete: role === 'admin' && canDelete, canManage, groups, isSiteAdmin, reason }
}

export const roleLabel = (r: Role) => (r === 'admin' ? 'Data admin' : r === 'writer' ? 'Contributor' : 'Read-only')

export function viewVisible(v: ViewDef, a: Access, cfg: AppConfig, upn: string): boolean {
  const owner = cfg.owners.some((o) => sameUser(o, upn))
  if (v.audience === 'me') return sameUser(v.owner, upn)
  if (v.audience === 'everyone') return true
  if (v.audience === 'admins') return a.role === 'admin' || owner
  return owner || a.role === 'admin' || !!v.groups?.some((g) => a.groups.some((x) => x.toLowerCase() === g.toLowerCase()))
}
