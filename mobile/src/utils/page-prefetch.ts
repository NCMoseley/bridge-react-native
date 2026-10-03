import { getJson } from '../api/client'
import { setCachedAccounts } from './accounts-cache'
import { setCachedDebugging } from './debugging-cache'
import { setCachedJournal } from './journal-cache'
import { setCachedRanges } from './ranges-cache'
import { setCachedSettings } from './settings-cache'
import { preloadAlerts } from './alerts-cache'
import type {
  TradeCalendarMonthView,
  TradeJournal,
  TradeJournalDay,
} from '../types'

export async function prefetchPageData(): Promise<void> {
  try {
    // Cached payloads are keyed by the authenticated user — the prefetch must
    // stamp the same identity or the caches it fills will never serve.
    const session = await getJson<{ userId: string }>('/api/session').catch(() => undefined)
    const userId = session?.userId ?? ''
    // Never stamp '' — caches written under an empty id would be readable by
    // any other user's unauthenticated early render.
    const scoped = <T>(fn: (data: T, userId: string) => void, data: T) => { if (userId) fn(data, userId) }
    const journal = await getJson<{
      tradeJournal: TradeJournal
      calendar: TradeCalendarMonthView
      journalDays: Record<string, TradeJournalDay>
    }>('/api/journal')
    if (userId) setCachedJournal(journal.tradeJournal, journal.calendar, journal.journalDays, journal.calendar.month, '', userId)

    await Promise.all([
      getJson('/api/accounts')
        .then((data) => {
          setCachedAccounts(data as Parameters<typeof setCachedAccounts>[0])
        })
        .catch((err) => {
          console.error('[prefetch] accounts failed:', err)
        }),

      getJson('/api/ranges')
        .then((data) => {
          scoped(setCachedRanges, data as Parameters<typeof setCachedRanges>[0])
        })
        .catch((err) => {
          console.error('[prefetch] ranges failed:', err)
        }),

      getJson('/api/settings')
        .then((data) => {
          setCachedSettings(data as Parameters<typeof setCachedSettings>[0])
        })
        .catch((err) => {
          console.error('[prefetch] settings failed:', err)
        }),

      getJson('/api/debugging')
        .then((data) => {
          setCachedDebugging(data as Parameters<typeof setCachedDebugging>[0])
        })
        .catch((err) => {
          console.error('[prefetch] debugging failed:', err)
        }),

      preloadAlerts()
        .catch((err) => {
          console.error('[prefetch] alerts failed:', err)
        }),
    ])

    console.info('[prefetch] all page data cached after journal')
  } catch (err) {
    console.error('[prefetch] journal failed; aborting remaining prefetch:', err)
  }
}
