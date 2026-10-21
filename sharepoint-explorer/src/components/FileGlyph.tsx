import { useState } from 'react'

const KINDS: [RegExp, string, string][] = [
  [/^(docx?|dotx?|rtf|odt)$/, '#2B579A', 'W'], [/^(xlsx?|xlsm|csv|ods)$/, '#217346', 'X'], [/^(pptx?|ppsx?|odp)$/, '#C43E1C', 'P'],
  [/^pdf$/, '#D93025', 'PDF'], [/^(png|jpe?g|gif|bmp|svg|webp|heic|tiff?)$/, '#8E44AD', 'IMG'], [/^(mp4|mov|avi|mkv|wmv|webm)$/, '#E91E63', 'VID'],
  [/^(mp3|wav|m4a|flac)$/, '#009688', 'AUD'], [/^(zip|rar|7z|tar|gz)$/, '#6D4C41', 'ZIP'], [/^(txt|md|log)$/, '#546E7A', 'TXT'],
  [/^(one|onetoc2)$/, '#7719AA', 'N'], [/^(msg|eml)$/, '#0078D4', '@'], [/^(vsdx?)$/, '#3955A3', 'V'], [/^(js|ts|json|xml|html|css|py|cs|ps1|sql)$/, '#37474F', '</>'],
]
export const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')
export const isImage = (ext: string) => /^(png|jpe?g|gif|bmp|svg|webp)$/.test(ext)

export function FolderIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v1H2V6Z" fill="#E0A100" />
      <path d="M2 9h20v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9Z" fill="#FFC83D" />
    </svg>
  )
}

/** Colour-coded file-type badge (decorative: the file name is always next to it). */
export function FileGlyph({ name, folder, size = 24, thumb }: { name: string; folder?: boolean; size?: number; thumb?: string }) {
  const [bad, setBad] = useState(false)
  if (folder) return <FolderIcon size={size} />
  const ext = extOf(name)
  const [, color, label] = KINDS.find(([re]) => re.test(ext)) ?? [0, '#78909C', ext.slice(0, 3).toUpperCase() || '•']
  if (thumb && isImage(ext) && !bad) return <img src={thumb} alt="" width={size} height={size} loading="lazy" onError={() => setBad(true)} style={{ objectFit: 'cover', borderRadius: 4 }} />
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 2h9l5 5v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" fill={color} />
      <path d="M14 2l5 5h-4a1 1 0 0 1-1-1V2Z" fill="#fff" opacity=".45" />
      <text x="11" y="17" textAnchor="middle" fontFamily="Segoe UI, Arial" fontWeight="800" fontSize={label.length > 2 ? 5.6 : 8} fill="#fff">{label}</text>
    </svg>
  )
}
