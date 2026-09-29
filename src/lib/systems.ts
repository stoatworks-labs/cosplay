/**
 * Mechanical splay range per cabinet family, nominal degrees in 1° steps.
 *
 * From d&b's rigging manuals as best remembered AND cross-checked against the splays used in
 * ArrayCalc's own example projects (the observed range is noted where it is narrower). The UI
 * lets the user override every value, and ArrayCalc re-checks the rigging when the file is opened.
 */
export interface SplayRange {
  min: number
  max: number
  note?: string
}

const TABLE: [RegExp, SplayRange][] = [
  [/^V(8|12|7P|10P)?$|^V\d/, { min: 0, max: 14 }],
  [/^J(8|12)$/, { min: 0, max: 7 }],
  [/^Y(8|12)$/, { min: 0, max: 14 }],
  [/^KSL/, { min: 0, max: 10, note: 'compression rigging: ArrayCalc deflects each splay by up to ±0.3°' }],
  [/^GSL/, { min: 0, max: 7, note: 'compression rigging: ArrayCalc deflects each splay by up to ±0.3°' }],
  [/^XSL/, { min: 0, max: 14, note: 'compression rigging: ArrayCalc deflects each splay by up to ±0.3°' }],
  [/^CCL/, { min: 0, max: 14, note: 'compression rigging: ArrayCalc deflects each splay by up to ±0.1°' }],
  [/^Q\d/, { min: 0, max: 14 }],
  [/^T10/, { min: 0, max: 15 }],
  [/^(\d+AL|AL\d+)/, { min: 0, max: 14, note: 'range not confirmed for this family — check it' }],
]

export function splayRange(boxNames: string[]): SplayRange {
  let lo = -Infinity, hi = Infinity
  const notes = new Set<string>()
  let matched = false
  for (const name of new Set(boxNames)) {
    const hit = TABLE.find(([re]) => re.test(name))
    if (!hit) continue
    matched = true
    lo = Math.max(lo, hit[1].min)
    hi = Math.min(hi, hit[1].max)
    if (hit[1].note) notes.add(hit[1].note)
  }
  if (!matched) return { min: 0, max: 10, note: `no rigging data for ${[...new Set(boxNames)].join(', ')} — set the range by hand` }
  return { min: lo, max: hi, note: [...notes].join('; ') || undefined }
}
