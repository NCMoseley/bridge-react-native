import type { TradeCalendarMonthView } from '../types'

const CACHE_KEY_PREFIX = 'bridge:range-calendar:'

function cacheKey(rangeName: string, month: string): string {
  return `${CACHE_KEY_PREFIX}${encodeURIComponent(rangeName)}:${month}`
}

export function getCachedRangeCalendar(
  rangeName: string,
  month: string,
): TradeCalendarMonthView | undefined {
  try {
    const raw = window.localStorage.getItem(cacheKey(rangeName, month))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as TradeCalendarMonthView
    if (parsed.month && Array.isArray(parsed.days)) {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

export function setCachedRangeCalendar(
  rangeName: string,
  month: string,
  data: TradeCalendarMonthView,
): void {
  try {
    window.localStorage.setItem(cacheKey(rangeName, month), JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function clearRangeCalendarCache(): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(CACHE_KEY_PREFIX)) {
        window.localStorage.removeItem(key)
      }
    }
  } catch {
    // ignore
  }
}
