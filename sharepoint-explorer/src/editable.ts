import type { SpField } from './types'

/** Columns the app can write. Lookups, calculated, managed-metadata and system columns stay read-only. */
export const isEditable = (f: SpField) =>
  !f.readOnly && ['text', 'note', 'number', 'currency', 'boolean', 'date', 'choice', 'multichoice', 'user', 'url'].includes(f.kind) && !f.system &&
  !/^(ID|Created|Modified|Author|Editor|FileLeafRef2|File_x0020_Type|File_x0020_Size)$/.test(f.internal) && f.typeAsString !== 'Calculated' && f.typeAsString !== 'File' && !/Taxonomy/.test(f.typeAsString)
