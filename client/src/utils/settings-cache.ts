import type { BridgeAccount, RangeRoute, RangeSubcategory, RangeSubcategoryAssignment } from '../types'

interface CachedSettings {
  accounts: BridgeAccount[]
  rangeRoutes: RangeRoute[]
  rangeNames: string[]
  rangeSubcategories: RangeSubcategory[]
  rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
  extensionToken: string
  extensionVersion?: string
}

const CACHE_KEY = 'bridge:settings'

export function getCachedSettings(): CachedSettings | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedSettings
    if (
      Array.isArray(parsed.accounts) &&
      Array.isArray(parsed.rangeRoutes) &&
      Array.isArray(parsed.rangeNames) &&
      Array.isArray(parsed.rangeSubcategories) &&
      Array.isArray(parsed.rangeSubcategoryAssignments)
    ) {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

export function setCachedSettings(data: CachedSettings): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function clearSettingsCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}
