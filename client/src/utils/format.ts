import type { BridgeAccount, JournalMetrics, TradeEvent } from '../types'

export function formatDollars(cents: number): string {
  const absolute = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}$${(absolute / 100).toFixed(2)}`
}

export function formatPnl(cents: number): string {
  return cents > 0 ? `+${formatDollars(cents)}` : formatDollars(cents)
}

export function classForCents(cents: number): string {
  if (cents > 0) return 'text-positive'
  if (cents < 0) return 'text-negative-400'
  return 'text-slate-200'
}

export function formatQuantity(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  // Pine sizing math can emit fractional contract counts (1.2000000000000002)
  // but the wire always sends whole contracts — display the integer.
  if (Math.abs(value) >= 0.5) return String(Math.round(value))
  return String(Number(value.toFixed(4)))
}

export function formatTicks(cents: number): string {
  const value = cents / 100
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
}

export function formatPercent(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function formatRatio(value: number | null): string {
  if (value == null) return '—'
  if (!Number.isFinite(value)) return '∞'
  return value.toFixed(2)
}

export function annualizedSharpe(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 2 || dailyReturns.some((value) => !Number.isFinite(value))) return null
  const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
  const variance = dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1)
  if (variance <= 0) return null
  return Math.sqrt(252) * mean / Math.sqrt(variance)
}

export function journalDateKey(value: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: JOURNAL_TIME_ZONE,
  }).formatToParts(new Date(value))
  const part = (type: 'year' | 'month' | 'day') => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function annualizedSharpeFromTrades(
  trades: Pick<TradeEvent, 'accountId' | 'occurredAt' | 'realizedDollarsCents' | 'excludedFromPerformance'>[],
  accounts: Pick<BridgeAccount, 'id' | 'startingBalanceCents'>[],
): number | null {
  const performanceTrades = trades.filter((trade) => !trade.excludedFromPerformance)
  const tradedAccountIds = new Set(performanceTrades.map((trade) => trade.accountId))
  const portfolioAccounts = accounts.filter((account) => tradedAccountIds.has(account.id))
  if (!portfolioAccounts.length || portfolioAccounts.length !== tradedAccountIds.size || portfolioAccounts.some((account) => account.startingBalanceCents <= 0)) return null

  const equityByAccount = new Map(portfolioAccounts.map((account) => [account.id, account.startingBalanceCents]))
  const pnlByDay = new Map<string, Map<string, number>>()
  for (const trade of performanceTrades) {
    const day = journalDateKey(trade.occurredAt)
    const accountsForDay = pnlByDay.get(day) ?? new Map<string, number>()
    accountsForDay.set(trade.accountId, (accountsForDay.get(trade.accountId) ?? 0) + (trade.realizedDollarsCents ?? 0))
    pnlByDay.set(day, accountsForDay)
  }

  const dailyReturns: number[] = []
  for (const day of [...pnlByDay.keys()].sort()) {
    const dayPnl = pnlByDay.get(day)!
    let openingEquity = 0
    let realizedPnl = 0
    for (const account of portfolioAccounts) {
      openingEquity += equityByAccount.get(account.id) ?? 0
      realizedPnl += dayPnl.get(account.id) ?? 0
    }
    if (openingEquity <= 0) return null
    dailyReturns.push(realizedPnl / openingEquity)
    for (const account of portfolioAccounts) {
      const id = account.id
      equityByAccount.set(id, (equityByAccount.get(id) ?? 0) + (dayPnl.get(id) ?? 0))
    }
  }
  return annualizedSharpe(dailyReturns)
}

export function profitFactor(metrics: JournalMetrics): number | null {
  const grossWins =
    metrics.averageWinDollarsCents == null
      ? 0
      : metrics.averageWinDollarsCents * metrics.wins
  const grossLoss =
    metrics.averageLossDollarsCents == null
      ? 0
      : Math.abs(metrics.averageLossDollarsCents) * metrics.losses
  if (grossWins === 0 && grossLoss === 0) return null
  if (grossLoss === 0) return grossWins > 0 ? Number.POSITIVE_INFINITY : null
  return grossWins / grossLoss
}

export const JOURNAL_TIME_ZONE = 'Etc/GMT+4'

export function formatJournalDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: JOURNAL_TIME_ZONE,
  }).format(new Date(value))
}

export function formatJournalDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-')
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 16)).toLocaleDateString(
    'en-US',
    { month: 'short', day: 'numeric', timeZone: JOURNAL_TIME_ZONE },
  )
}

export function calendarMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-')
  if (!year || !month) return '—'
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1, 16)).toLocaleDateString('en-US', {
    month: 'long',
    timeZone: JOURNAL_TIME_ZONE,
  })
}

export function journalActiveDays(calendar: {
  days: Array<{ closedCount: number }>
}): number {
  return calendar.days.filter((day) => day.closedCount > 0).length
}

export function grossPerformance(metrics: JournalMetrics): {
  grossWinsCents: number
  grossLossAbsCents: number
} {
  return {
    grossWinsCents:
      metrics.averageWinDollarsCents == null
        ? 0
        : metrics.averageWinDollarsCents * metrics.wins,
    grossLossAbsCents:
      metrics.averageLossDollarsCents == null
        ? 0
        : Math.abs(metrics.averageLossDollarsCents) * metrics.losses,
  }
}
