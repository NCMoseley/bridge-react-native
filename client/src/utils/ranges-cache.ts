import type {
  RangeConfiguration,
  RangeSubcategory,
  RangeSubcategoryAssignment,
  SharedRangeDetail,
} from '../types'

interface CachedRanges {
  sharedRangeDetails: SharedRangeDetail[]
  rangeSubcategories: RangeSubcategory[]
  rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
  rangeConfigurations: RangeConfiguration[]
  fetchedAt: number
  userId: string
}

const CACHE_KEY = 'bridge:ranges'

// User-scoped: a stored cache only serves the user it was written for —
// logout leaves the key behind, and a different login must never see it.
// Mount-time optimistic read (display-only): paints last-known data before the
// session resolves. The stored userId is still verified before the cache serves
// authoritatively or is rewritten.
export function getCachedRangesOptimistic(): CachedRanges | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedRanges
    if (parsed.userId && Array.isArray(parsed.sharedRangeDetails)) {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

export function getCachedRanges(userId: string): CachedRanges | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedRanges
    if (parsed.userId !== userId) return undefined
    if (Array.isArray(parsed.sharedRangeDetails)) {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

export function setCachedRanges(
  data: Omit<CachedRanges, 'fetchedAt' | 'userId'>,
  userId: string,
): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ...data, fetchedAt: Date.now(), userId }))
  } catch {
    // ignore
  }
}

export function clearRangesCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}

export const RANGES_CACHE_TTL_MS = 30_000
