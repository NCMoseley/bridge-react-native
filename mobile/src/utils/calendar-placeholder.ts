import type { JournalMetrics, TradeCalendarMonthView } from '../types'

export const EMPTY_METRICS: JournalMetrics = {
  realizedDollarsCents: 0,
  netTicksCents: 0,
  closedCount: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  winRate: null,
  averageWinDollarsCents: null,
  averageLossDollarsCents: null,
  averageWinTicksCents: null,
  averageLossTicksCents: null,
  rEarned: null,
}

// Rendered before the server payload lands so calendar pages paint their card
// skeleton (metrics + month grid) instead of an empty screen.
export function placeholderMonthView(month: string): TradeCalendarMonthView {
  return { month, days: [], summary: EMPTY_METRICS }
}
