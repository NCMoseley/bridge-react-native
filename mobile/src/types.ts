export type DraftStatus = 'pending' | 'reviewed' | 'submitted' | 'rejected' | 'expired'

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
  takeProfit?: Record<string, number>
  stopLoss?: Record<string, string | number>
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
  // Σ(realized ÷ range risk) over trades whose range declares risk; null when
  // no covered trades — only populated on journal-summary paths.
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
  outboundTicker?: string
  outboundTickerMode?: 'none' | 'exact' | 'micros_only'
  useLimitPriceTP?: boolean
  useAlertTP?: boolean
  reapplyOnTradeCloseEnabled?: boolean
  eodCancelTime?: string
  eodExitTime?: string
  eodEnabled?: boolean
  newsFlattenEnabled?: boolean
  newsFlattenMinutes?: number
  crossTradeWebhookUrl?: string
  // Write-only outbound field — the API never returns the stored key, it only
  // reports whether one is saved (crossTradeSecretKeySet).
  crossTradeSecretKey?: string
  crossTradeSecretKeySet?: boolean
  crossTradeAccountName?: string
  // false = CT config parked (preserved, but dispatches go via TradersPost)
  crossTradeEnabled?: boolean
  quantityOverrideMode?: 'percent' | 'fixed' | 'risk'
  quantityOverrideValue?: number
  updatedAt: string
}

export interface RangeReviewFlag {
  rangeName: string
  reason: 'test_data' | 'erroneous'
  flaggedByUserId: string
  flaggedByEmail: string
  createdAt: string
  updatedAt: string
}

export interface UntrackedRange {
  name: string
  alertCount: number
  latestInstrument: string
  latestReceivedAt: string
}

export interface ReapplyOperationSummary {
  id: string
  accountId: string
  instrument: string
  closingRangeName: string
  createdAt: string
  completed: boolean
  reason?: string
  rearmedRangeNames: string[]
}

export interface ProcessRun {
  id: string
  startedAt: string
  endedAt?: string
  cleanExit: boolean
  exitCode?: number
  fatal?: { event: string; name?: string; message?: string; stack?: string }
  lastHeartbeatAt?: string
  rssBytes?: number
  heapUsedBytes?: number
  eventLoopLagMs?: number
  nodeVersion: string
  pid: number
}

export type BrokerOrderAction = 'buy' | 'sell' | 'cancel' | 'exit'

export type BrokerOrderState = 'pending' | 'acknowledged' | 'rejected' | 'uncertain' | 'filled' | 'closed' | 'cancelled'

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
  statusSource?: 'dispatch' | 'lifecycle' | 'bridge' | 'operator' | 'email' | 'ct-verified' | 'legacy'
  destination?: 'traderspost' | 'crosstrade'
  instrument: string
  side?: 'long' | 'short'
  quantity?: number
  price?: number
  stopPrice?: number
  limitPrice?: number
  proxyAlertId?: string
  proxyDeliveryId?: string
  errorText?: string
  occurredAt: string
  createdAt: string
  updatedAt: string
  // Server-enriched: this terminal entry order still covers an armed
  // bracket_monitor row — the only case where "retire arm" does anything.
  uncoveredArm?: boolean
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
  proxyAlertId?: string
  entryArmedDeliveryStatus?: 'delivered' | 'failed' | 'extension' | 'blocked' | 'unknown'
  entryArmedDeliveryDetail?: string
  entryArmedDeliveryId?: string
  excludedFromPerformance: boolean
  exclusionReason?: 'test_data' | 'erroneous'
  excludedByUserId?: string
  exclusionUpdatedAt?: string
  adjustmentNote?: string
  adjustedAt?: string
  adjustedByUserId?: string
  adjustedByEmail?: string
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
  trades?: RangeTradeEvent[]
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
  proxyAlertId?: string
  adjustmentNote?: string
}

export interface TradeCalendarMonthView {
  month: string
  days: CalendarDay[]
  /** Prior-month days that fill the grid's leading cells — display only,
      never counted in `summary`. */
  trailingDays?: Array<
    Pick<
      CalendarDay,
      | 'date'
      | 'realizedDollarsCents'
      | 'netTicksCents'
      | 'closedCount'
      | 'wins'
      | 'losses'
      | 'breakevens'
      | 'winRate'
    >
  >
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

export interface AccountPnlReview {
  account: BridgeAccount
  since: string
  until: string
  summary: JournalMetrics
  ranges: CalendarDayRange[]
  trades: TradeEvent[]
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
  matchedUserEmails: string[]
  matchedAccountCount: number
  matchedAccountNames: string[]
  traderspostDeliveredCount: number
  traderspostFailedCount: number
  traderspostPendingCount: number
  traderspostNotConfiguredCount: number
  currentUserLinked: boolean
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
  // Per-model run-day overrides for this range; null = inherit the range's
  // own run day for accounts routed through this model.
  runMonday?: boolean | null
  runTuesday?: boolean | null
  runWednesday?: boolean | null
  runThursday?: boolean | null
  runFriday?: boolean | null
  runSaturday?: boolean | null
  runSunday?: boolean | null
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

export interface SharedRangeDetail {
  rangeName: string
  createdBy?: { id: string; email: string }
  createdAt: string
  allTime: JournalMetrics
  currentMonth: JournalMetrics
  currentWeek: JournalMetrics
  currentDay: JournalMetrics
  performanceAllTime: JournalMetrics
  performanceCurrentMonth: JournalMetrics
  performanceCurrentWeek: JournalMetrics
  performanceCurrentDay: JournalMetrics
  subscriptions: SharedRangeSubscription[]
  reviewFlag?: RangeReviewFlag
}

export type BracketMonitorState = 'armed' | 'filled' | 'closed' | 'cancelled'

export interface OpenTradeSanity {
  accountId: string
  accountName: string
  rangeName: string
  instrument: string
  side: 'long' | 'short'
  bracketId: string
  tradeId: string
  state: BracketMonitorState
  quantity: number
  entryPrice?: number
  lastOccurredAt: string
  hasTradeEvent: boolean
  tradeEventType?: TradeEventType
  tradeEventOccurredAt?: string
  hasLifecycleAlert: boolean
  hasDispatchAlert: boolean
  dispatchAlertReceivedAt?: string
  dispatchAlertAction?: 'buy' | 'sell'
  deliveryStatus?: string
  deliveryCreatedAt?: string
  brokerOrderStatus?: BrokerOrderState
  brokerOrderErrorText?: string
  brokerOrderOccurredAt?: string
  routeTraderspostEnabled: boolean
  routeExtensionEnabled: boolean
  routeRunScheduled: boolean
  isScheduledDay?: boolean
  oppositeSideExists: boolean
  oppositeSideState?: BracketMonitorState
}

export interface MonitoringData {
  openTradeSanity: OpenTradeSanity[]
  brokerOrders: BrokerOrder[]
}

export interface RangesData {
  sharedRangeDetails: SharedRangeDetail[]
  rangeSubcategories: RangeSubcategory[]
  rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
  rangeConfigurations: RangeConfiguration[]
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
