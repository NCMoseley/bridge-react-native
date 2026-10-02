export interface BridgeAccount {
  id: string
  userId: string
  name: string
  startingBalanceCents: number
  externalBalanceCents?: number
  externalBalanceAt?: string
  deprecated: boolean
  createdAt: string
}

export interface JournalMetrics {
  realizedDollarsCents: number
  netTicksCents: number
  closedCount: number
  wins: number
  losses: number
  breakevens: number
  winRate: number | null
  averageWinDollarsCents: number | null
  averageLossDollarsCents: number | null
  averageWinTicksCents: number | null
  averageLossTicksCents: number | null
  rEarned?: number | null
}

export interface TradeStats {
  profitFactor: number | null
  expectancyDollarsCents: number | null
  maxDrawdownDollarsCents: number
  largestWinDollarsCents: number | null
  largestLossDollarsCents: number | null
  longestWinStreak: number
  longestLossStreak: number
}

export interface AccountJournal {
  account: BridgeAccount
  allTime: JournalMetrics
  currentWeek: JournalMetrics
  currentDay: JournalMetrics
  internalBalanceCents: number
  stats?: TradeStats
}

export interface AccountAlertSummary {
  totalReceived: number
  processed: number
  extensionPending: number
  extensionReviewed: number
  extensionSubmitted: number
  extensionRejected: number
  traderspostDelivered: number
  traderspostPending: number
  traderspostFailed: number
  traderspostNotConfigured: number
  ignored: number
  noDestination: number
}

export interface TradersPostAccountDestination {
  accountId: string
  webhookUrl: string
  enabled: boolean
  crossTradeWebhookUrl?: string
  crossTradeAccountName?: string
  crossTradeEnabled?: boolean
  eodEnabled?: boolean
  eodExitTime?: string
  updatedAt: string
}

export type TradeOutcome = 'win' | 'loss' | 'breakeven'

export type TradeEventType =
  | 'entry_armed'
  | 'entry_filled'
  | 'entry_cancelled'
  | 'exit_filled'
  | 'trade_closed'

export interface TradeEvent {
  id: string
  userId: string
  accountId: string
  rangeName: string
  eventId: string
  tradeId: string
  bracketId?: string
  eventType: TradeEventType
  instrument: string
  side: 'long' | 'short'
  action?: 'buy' | 'sell' | 'cancel' | 'exit'
  quantity: number
  entryPrice?: number
  exitPrice?: number
  realizedTicksCents?: number
  realizedDollarsCents?: number
  outcome?: TradeOutcome
  occurredAt: string
  excludedFromPerformance: boolean
  exclusionReason?: 'test_data' | 'erroneous'
  adjustmentNote?: string
}

export interface CalendarDayRange {
  rangeName: string
  instrument: string
  realizedDollarsCents: number
  netTicksCents: number
  closedCount: number
  wins: number
  losses: number
  breakevens: number
}

export interface CalendarDay {
  date: string
  realizedDollarsCents: number
  netTicksCents: number
  closedCount: number
  wins: number
  losses: number
  breakevens: number
  winRate: number | null
  rEarned?: number | null
  hiddenFromPerformance?: boolean
  ranges: CalendarDayRange[]
}

export interface TradeCalendarMonthView {
  month: string
  days: CalendarDay[]
  summary: JournalMetrics
}

export interface TradeJournalDay {
  date: string
  trades: TradeEvent[]
  summary: JournalMetrics
  ranges: CalendarDayRange[]
}

export interface TradeJournal {
  allTime: JournalMetrics
  currentWeek: JournalMetrics
  currentDay: JournalMetrics
  accounts: AccountJournal[]
  openTrades: TradeEvent[]
  pairedClosedTrades: TradeEvent[]
  recentClosedTrades: TradeEvent[]
  rangeNames: string[]
  rangeEntries: Record<string, number>
  rangeRisk?: Record<string, number>
}
