import { getJson } from '../api/client'
import type {
  AlertFeedEntry,
  AlertFeedSummary,
} from '../types'

interface CachedAlerts {
  alerts: AlertFeedEntry[]
  totalCount: number
  rangeNames: string[]
  summary: AlertFeedSummary
}

const PRELOAD_QUERY = 'limit=100&offset=0'
const CACHE_KEY_PREFIX = 'bridge:alerts:'

let preloaded: CachedAlerts | undefined
let promise: Promise<void> | undefined

function cacheKey(query: string): string {
  return `${CACHE_KEY_PREFIX}${query}`
}

function readCached(query: string): CachedAlerts | undefined {
  try {
    const raw = window.localStorage.getItem(cacheKey(query))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedAlerts
    if (parsed.alerts && typeof parsed.totalCount === 'number') {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

function writeCached(query: string, data: CachedAlerts): void {
  try {
    window.localStorage.setItem(cacheKey(query), JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function preloadAlerts(): Promise<void> {
  if (preloaded) return Promise.resolve()
  if (promise) return promise
  promise = getJson<{
    alerts: AlertFeedEntry[]
    totalCount: number
    rangeNames: string[]
    summary: AlertFeedSummary
  }>('/api/alerts?limit=100&offset=0')
    .then((data) => {
      preloaded = {
        alerts: data.alerts,
        totalCount: data.totalCount,
        rangeNames: data.rangeNames,
        summary: data.summary,
      }
      writeCached(PRELOAD_QUERY, preloaded)
    })
    .catch((error) => {
      console.error('Failed to preload alerts:', error)
    })
  return promise
}

export function getPreloadedAlerts(): CachedAlerts | undefined {
  return preloaded ?? readCached(PRELOAD_QUERY)
}

export function getPreloadedPage(
  page: number,
  pageSize: number,
): CachedAlerts | undefined {
  const base = preloaded ?? readCached(PRELOAD_QUERY)
  if (!base) return undefined
  const start = (page - 1) * pageSize
  return {
    ...base,
    alerts: base.alerts.slice(start, start + pageSize),
  }
}

export function getCachedAlerts(query: string): CachedAlerts | undefined {
  return readCached(query)
}

export function setCachedAlerts(query: string, data: CachedAlerts): void {
  writeCached(query, data)
}

export function clearAlertsCache(): void {
  preloaded = undefined
  promise = undefined
  try {
    const keys: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(CACHE_KEY_PREFIX)) keys.push(key)
    }
    for (const key of keys) window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}
