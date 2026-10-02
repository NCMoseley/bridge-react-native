import type {
  AccountAlertSummary,
  AccountJournal,
  TradersPostAccountDestination,
} from '../types'

interface CachedAccounts {
  accounts: AccountJournal[]
  alertSummaries: Record<string, AccountAlertSummary>
  destinations: Record<string, TradersPostAccountDestination | undefined>
  enabledRouteCounts?: Record<string, number>
}

const CACHE_KEY = 'bridge:accounts'

export function getCachedAccounts(): CachedAccounts | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as CachedAccounts
    if (Array.isArray(parsed.accounts)) {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

export function setCachedAccounts(data: CachedAccounts): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function clearAccountsCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}
