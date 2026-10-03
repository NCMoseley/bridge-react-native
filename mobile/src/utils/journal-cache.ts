import { storage } from './storage'
import type {
  TradeCalendarMonthView,
  TradeJournal,
  TradeJournalDay,
} from '../types'

interface CachedJournal {
  tradeJournal: TradeJournal
  calendar: TradeCalendarMonthView
  journalDays: Record<string, TradeJournalDay>
  fetchedAt: number
  month: string
  accountsKey: string
  userId: string
}

const CACHE_KEY = 'bridge:journal'
// Live updates already arrive over the SSE stream (journal:refresh) — a mount
// within this window can serve the cache without a redundant fetch.
export const JOURNAL_CACHE_TTL_MS = 30_000

// Mount-time optimistic read: renders the stored payload before auth resolves
// so a hard reload paints last-known data instead of zeros. Display-only — the
// stored userId is verified against the session before the cache serves as
// authoritative or is written again.
export function getCachedJournalOptimistic(): CachedJournal | undefined {
  try {
    const raw = storage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedJournal
    if (parsed.userId && parsed.tradeJournal && parsed.calendar && parsed.journalDays) {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

// User-scoped: a stored cache only serves the user it was written for —
// logout leaves the key behind, and a different login must never see it.
export function getCachedJournal(userId: string): CachedJournal | undefined {
  try {
    const raw = storage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedJournal
    if (parsed.userId !== userId) return undefined
    if (parsed.tradeJournal && parsed.calendar && parsed.journalDays) {
      const trades = parsed.tradeJournal.recentClosedTrades ?? []
      if (trades.length > 0 && trades.some((t) => typeof t.id !== 'string')) {
        clearJournalCache()
        return undefined
      }
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

export function isCachedJournalFresh(cached: CachedJournal, month: string, accountsKey: string, userId: string): boolean {
  return (
    cached.userId === userId &&
    cached.fetchedAt > 0 &&
    Date.now() - cached.fetchedAt < JOURNAL_CACHE_TTL_MS &&
    cached.month === month &&
    cached.accountsKey === accountsKey
  )
}

export function setCachedJournal(
  tradeJournal: TradeJournal,
  calendar: TradeCalendarMonthView,
  journalDays: Record<string, TradeJournalDay>,
  month: string,
  accountsKey: string,
  userId: string,
): void {
  try {
    storage.setItem(
      CACHE_KEY,
      JSON.stringify({ tradeJournal, calendar, journalDays, fetchedAt: Date.now(), month, accountsKey, userId }),
    )
  } catch {
    // ignore
  }
}

export function clearJournalCache(): void {
  try {
    storage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}
