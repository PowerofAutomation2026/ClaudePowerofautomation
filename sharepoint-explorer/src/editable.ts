import type { SpField } from './types'

/** Only fields a person can sensibly type; users, lookups, files and multi-value columns stay read-only in the app. */
export const isEditable = (f: SpField) =>
  ['text', 'note', 'number', 'currency', 'boolean', 'date', 'choice'].includes(f.kind) && !f.system &&
  !/^(ID|Created|Modified|FileLeafRef2|File_x0020_Type|File_x0020_Size)$/.test(f.internal) && f.typeAsString !== 'Calculated' && f.typeAsString !== 'File'
