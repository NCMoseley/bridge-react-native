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

export type AlertActivityFilter =
  | 'all'
  | 'routed'
  | 'unrouted'
  | 'lifecycle'
  | 'traderspost_delivered'
  | 'traderspost_failed'

export type AlertTimeFilter =
  | 'all'
  | '15m'
  | '30m'
  | 'hour'
  | '2h'
  | '4h'
  | '12h'
  | 'day'
  | '3d'
  | 'week'

export interface AlertFeedSummary {
  totalAlerts: number
  routedAlerts: number
  unroutedAlerts: number
  traderspostDeliveredCount: number
  traderspostPendingCount: number
  traderspostFailedCount: number
  latestReceivedAt?: string
}

export interface AlertFeedEntry {
  alertId: string
  receivedAt: string
  rangeName?: string
  action: 'buy' | 'sell' | 'cancel' | 'exit'
  ticker: string
  payloadJson: string
  sourceReference?: string
  deliveryCount: number
  tradeEventCount: number
  matchedUserCount: number
  matchedAccountCount: number
  matchedAccountNames: string[]
  traderspostDeliveredCount: number
  traderspostFailedCount: number
  traderspostPendingCount: number
  traderspostNotConfiguredCount: number
  currentUserLinked: boolean
}

export type BrokerOrderAction = 'buy' | 'sell' | 'cancel' | 'exit'

export type BrokerOrderState =
  | 'pending'
  | 'acknowledged'
  | 'rejected'
  | 'uncertain'
  | 'filled'
  | 'closed'
  | 'cancelled'

export interface BrokerOrder {
  id: string
  accountId: string
  accountName?: string
  rangeName: string
  bracketId?: string
  orderId: string
  action: BrokerOrderAction
  status: BrokerOrderState
  dispatchStatus?: BrokerOrderState
  statusSource?: string
  destination?: 'traderspost' | 'crosstrade'
  instrument: string
  side?: 'long' | 'short'
  quantity?: number
  price?: number
  errorText?: string
  occurredAt: string
}

export type BracketMonitorState = 'armed' | 'filled' | 'closed' | 'cancelled'

export interface OpenTradeSanity {
  accountId: string
  accountName: string
  rangeName: string
  instrument: string
  side: 'long' | 'short'
  bracketId: string
  state: BracketMonitorState
  quantity: number
  entryPrice?: number
  lastOccurredAt: string
  hasTradeEvent: boolean
  hasLifecycleAlert: boolean
  hasDispatchAlert: boolean
  deliveryStatus?: string
  brokerOrderStatus?: BrokerOrderState
  brokerOrderErrorText?: string
  routeTraderspostEnabled: boolean
  oppositeSideExists: boolean
}

export interface MonitoringData {
  openTradeSanity: OpenTradeSanity[]
  brokerOrders: BrokerOrder[]
}

export interface RangeRoute {
  id: string
  rangeName: string
  userId: string
  accountId: string
  extensionEnabled: boolean
  traderspostEnabled: boolean
  runScheduled: boolean
  createdAt: string
  updatedAt: string
}

export interface RangeConfiguration {
  rangeName: string
  instrument: string
  description: string
  riskDollarsCents: number
  rangeWindow: string
  tradingSession: string
  takeProfitStyle: string
  takeProfitTicksCents: number
  stopLossStyle: string
  stopLossTicksCents: number
  breakEvenEnabled: boolean
  breakEvenTriggerTicksCents: number
  breakEvenOffsetTicksCents: number
  ocoMode: 'oco' | 'both'
  stopOnlyEntries: boolean
  runMonday: boolean
  runTuesday: boolean
  runWednesday: boolean
  runThursday: boolean
  runFriday: boolean
  runSaturday: boolean
  runSunday: boolean
  entriesPerRange: number
  createdAt: string
  updatedAt: string
}

export interface RangeSubcategory {
  name: string
  createdByUserId: string
  createdByEmail: string
  createdAt: string
  color?: string | null
}

export interface RangeSubcategoryAssignment {
  rangeName: string
  subcategoryName: string
  assignedByUserId: string
  updatedAt: string
}

export interface SharedRangeSubscription {
  user: { id: string; email: string }
  account: { id: string; name: string }
  modelName?: string
  modelNames?: string[]
  extensionEnabled: boolean
  traderspostEnabled: boolean
  createdAt: string
  updatedAt: string
}

export interface RangeReviewFlag {
  rangeName: string
  flaggedByUserId?: string
  reason?: string
  updatedAt?: string
}

export interface SharedRangeDetail {
  rangeName: string
  createdBy?: { id: string; email: string }
  createdAt: string
  allTime: JournalMetrics
  currentMonth: JournalMetrics
  currentWeek: JournalMetrics
  currentDay: JournalMetrics
  subscriptions: SharedRangeSubscription[]
  reviewFlag?: RangeReviewFlag
}

export interface RangesData {
  sharedRangeDetails: SharedRangeDetail[]
  rangeSubcategories: RangeSubcategory[]
  rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
  rangeConfigurations: RangeConfiguration[]
}

export type DraftStatus =
  | 'pending'
  | 'reviewed'
  | 'submitted'
  | 'rejected'
  | 'expired'

export interface OrderDraft {
  id: string
  userId: string
  idempotencyKey: string
  status: DraftStatus
  ticker: string
  action: 'buy' | 'sell' | 'cancel'
  sentiment?: 'long' | 'short' | 'flat'
  quantity: number
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit' | 'cancel'
  signalPrice?: number
  limitPrice?: number
  stopPrice?: number
  strategyStopPrice?: number
  strategyStopMode?: 'close_confirmed' | 'intrabar'
  bracketId?: string
  bracketSide?: 'long' | 'short'
  rangeName?: string
  orderLeg?: string
  cancellationMessage?: string
  extensionEligible?: boolean
  accountId?: string
  accountName?: string
  receivedAt: string
  reviewedAt?: string
  submittedAt?: string
}

export interface AccountPnlReview {
  account: BridgeAccount
  since: string
  until: string
  summary: JournalMetrics
  ranges: CalendarDayRange[]
  trades: TradeEvent[]
}

export interface RangeTradeEvent {
  id: string
  rangeName: string
  eventId: string
  tradeId: string
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
  adjustmentNote?: string
}

export interface UntrackedRange {
  rangeName: string
  accountNames?: string[]
  lastSeenAt?: string
}

export interface ReapplyOperationSummary {
  id: string
  eventId: string
  rangeName?: string
  status?: string
  createdAt?: string
  updatedAt?: string
}

export interface ProcessRun {
  id: string
  pid?: number
  startedAt: string
  endedAt?: string
  lastHeartbeatAt?: string
  cleanExit?: boolean
  rssBytes?: number
  heapUsedBytes?: number
}

export interface DebuggingData {
  accounts: BridgeAccount[]
  traderspostDestinations: TradersPostAccountDestination[]
  rangeConfigurations: RangeConfiguration[]
  flaggedRanges: RangeReviewFlag[]
  excludedTrades: TradeEvent[]
  untrackedRangeNames: UntrackedRange[]
  reapplyOperations: ReapplyOperationSummary[]
  openTradeSanity: OpenTradeSanity[]
  brokerOrders: BrokerOrder[]
  processRuns?: ProcessRun[]
}

export interface SettingsData {
  accounts: BridgeAccount[]
  rangeRoutes: RangeRoute[]
  rangeNames: string[]
  rangeSubcategories: RangeSubcategory[]
  rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
  extensionToken: string
  extensionVersion: string
}
