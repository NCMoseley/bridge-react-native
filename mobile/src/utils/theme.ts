// Theme system — ports the web client's 10 themes onto the mobile palette.
// `colors` in ui.tsx is a mutable export; applyTheme rewrites its properties
// in place and re-runs every registered style builder so both StyleSheet
// constants and inline `colors.*` reads pick up the new palette on remount.
import { postForm } from '../api/client'
import { emitEvent } from './events'
import { storage } from './storage'

export type ThemeName =
  | 'dark'
  | 'light'
  | 'ultra'
  | 'neonsign'
  | 'barbie'
  | 'irish'
  | 'medieval'
  | 'optimist'
  | 'cush'
  | 'castrol'

export const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'castrol', label: 'Castrol' },
  { value: 'ultra', label: 'Ultra' },
  { value: 'neonsign', label: 'Neon' },
  { value: 'barbie', label: 'Barbie House' },
  { value: 'irish', label: 'Eire' },
  { value: 'medieval', label: 'Medieval' },
  { value: 'optimist', label: 'The Optimist' },
  { value: 'cush', label: 'Cush' },
]

export interface Palette {
  bg: string
  card: string
  cardAlt: string
  border: string
  borderLight: string
  text: string
  muted: string
  faint: string
  positive: string
  negative: string
  accent: string
  amber: string
}

const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    bg: '#020617', card: '#0f172a', cardAlt: '#111c34',
    border: '#1e293b', borderLight: '#334155',
    text: '#e2e8f0', muted: '#94a3b8', faint: '#64748b',
    positive: '#4ade80', negative: '#f87171', accent: '#38bdf8', amber: '#fbbf24',
  },
  light: {
    bg: '#ffffff', card: '#f8fafc', cardAlt: '#f1f5f9',
    border: '#e2e8f0', borderLight: '#cbd5e1',
    text: '#0f172a', muted: '#475569', faint: '#64748b',
    positive: '#047857', negative: '#b91c1c', accent: '#2563eb', amber: '#b45309',
  },
  ultra: {
    bg: '#150630', card: '#20094a', cardAlt: '#2e0f63',
    border: '#2e0f63', borderLight: '#4a1d8f',
    text: '#ffffff', muted: '#b98ef5', faint: '#9d5ce8',
    positive: '#ffd23f', negative: '#ff4d8a', accent: '#ff6ec7', amber: '#ffa53d',
  },
  neonsign: {
    bg: '#0e0620', card: '#180c33', cardAlt: '#241349',
    border: '#241349', borderLight: '#322060',
    text: '#ffffff', muted: '#8f74d6', faint: '#6348b0',
    positive: '#00e5ff', negative: '#ff5fd0', accent: '#7fa0ff', amber: '#ff8ad4',
  },
  barbie: {
    bg: '#12021f', card: '#1e0538', cardAlt: '#3b0764',
    border: '#3b0764', borderLight: '#5b21b6',
    text: '#ffffff', muted: '#c084fc', faint: '#a855f7',
    positive: '#39ff14', negative: '#ff2e88', accent: '#e879f9', amber: '#ffe600',
  },
  irish: {
    bg: '#ffffff', card: '#f4f8f5', cardAlt: '#e6ede9',
    border: '#e6ede9', borderLight: '#d3ded6',
    text: '#1c2b23', muted: '#4a7059', faint: '#6b8f79',
    positive: '#047857', negative: '#c2410c', accent: '#15803d', amber: '#c2410c',
  },
  medieval: {
    bg: '#101216', card: '#16181d', cardAlt: '#1f232a',
    border: '#1f232a', borderLight: '#2c313a',
    text: '#e6e9ee', muted: '#8a91a0', faint: '#5c6572',
    positive: '#57c98f', negative: '#e05563', accent: '#7fb2f8', amber: '#e8a33d',
  },
  optimist: {
    bg: '#0a1019', card: '#121924', cardAlt: '#1a2332',
    border: '#232c3d', borderLight: '#2f3a4e',
    text: '#e8eaed', muted: '#9aa3b0', faint: '#6b7280',
    positive: '#4ade80', negative: '#9aa3b0', accent: '#7fb2f8', amber: '#fbbf24',
  },
  cush: {
    bg: '#fdf6e3', card: '#eee8d5', cardAlt: '#e3dabd',
    border: '#e3dabd', borderLight: '#d3c9a8',
    text: '#073642', muted: '#586e75', faint: '#657b83',
    positive: '#6b7f00', negative: '#b91c1c', accent: '#2563eb', amber: '#926d00',
  },
  castrol: {
    bg: '#ffffff', card: '#f8fafc', cardAlt: '#e2e8f0',
    border: '#e2e8f0', borderLight: '#cbd5e1',
    text: '#0f172a', muted: '#475569', faint: '#64748b',
    positive: '#047857', negative: '#b91c1c', accent: '#2563eb', amber: '#b45309',
  },
}

const THEME_KEY = 'bridge:theme'

export function currentTheme(): ThemeName {
  const saved = storage.getItem(THEME_KEY)
  if (saved === 'glass') return 'light'
  if (saved === 'glassdark' || saved === 'neon') return 'dark'
  return PALETTES[saved as ThemeName] ? (saved as ThemeName) : 'dark'
}

export function paletteFor(name: ThemeName): Palette {
  return PALETTES[name] ?? PALETTES.dark
}

// Style builders register here so applyTheme can rewrite every exported
// `styles` object in place — mounted components keep working object refs.
const builders: Array<{ live: Record<string, unknown>; build: (p: Palette) => Record<string, unknown> }> = []

export function registerThemedStyles<T extends Record<string, unknown>>(
  live: T,
  build: (p: Palette) => T,
): T {
  builders.push({ live: live as Record<string, unknown>, build: build as (p: Palette) => Record<string, unknown> })
  return live
}

let appliedTheme: ThemeName | null = null
let appliedIsLight = false

export function isLightTheme(): boolean {
  return appliedIsLight
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

export function applyTheme(
  name: ThemeName,
  mutateColors: (p: Palette) => void,
): void {
  const unchanged = appliedTheme === name
  appliedTheme = name
  const palette = paletteFor(name)
  appliedIsLight = luminance(palette.bg) > 0.5
  mutateColors(palette)
  for (const entry of builders) {
    const fresh = entry.build(palette)
    for (const k of Object.keys(fresh)) {
      entry.live[k] = fresh[k]
    }
  }
  storage.setItem(THEME_KEY, name)
  if (!unchanged) {
    postForm('/theme', { theme: name }).catch(() => {})
    emitEvent('theme:changed')
  }
}
