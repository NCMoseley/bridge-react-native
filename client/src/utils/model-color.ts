import type { RangeSubcategory } from '../types'

// Model color: the subcategory's chosen color wins; otherwise a deterministic
// hash keeps a stable fallback so uncolored models still read distinctly.
const MODEL_BADGE_COLORS = [
  '#7a97fb', '#34d399', '#f87171', '#fbbf24', '#38bdf8',
  '#c084fc', '#fb923c', '#2dd4bf', '#f472b6', '#a3e635',
]

export function modelColor(name: string, subcategories: RangeSubcategory[]): string {
  const explicit = subcategories.find((s) => s.name === name)?.color
  if (explicit) return explicit
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return MODEL_BADGE_COLORS[h % MODEL_BADGE_COLORS.length]
}
