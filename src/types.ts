export type DraftStatus = 'pending' | 'reviewed' | 'submitted' | 'rejected' | 'expired';
export type StrategyStopMode = 'close_confirmed' | 'intrabar';

export interface OrderDraft {
  id: string;
  userId: string;
  idempotencyKey: string;
  status: DraftStatus;
  ticker: string;
  action: 'buy' | 'sell' | 'cancel';
  sentiment?: 'long' | 'short' | 'flat';
  quantity: number;
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit' | 'cancel';
  signalPrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  takeProfit?: Record<string, number>;
  stopLoss?: Record<string, string | number>;
  strategyStopPrice?: number;
  strategyStopMode?: StrategyStopMode;
  bracketId?: string;
  bracketSide?: 'long' | 'short';
  rangeName?: string;
  orderLeg?: string;
  cancellationMessage?: string;
  // False when the subscription route had extension routing off — the draft
  // exists for web Order Review but is filtered out of the extension poll.
  extensionEligible?: boolean;
  accountId?: string;
  accountName?: string;
  receivedAt: string;
  reviewedAt?: string;
  submittedAt?: string;
}

export interface ExtensionSession {
  userId: string;
  email: string;
}

export interface BridgeAccount {
  id: string;
  userId: string;
  name: string;
  startingBalanceCents: number;
  externalBalanceCents?: number;
  externalBalanceAt?: string;
  deprecated: boolean;
  createdAt: string;
}

export interface RangeRoute {
  id: string;
  rangeName: string;
  userId: string;
  accountId: string;
  extensionEnabled: boolean;
  traderspostEnabled: boolean;
  runScheduled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RangeConfiguration {
  rangeName: string;
  instrument: string;
  description: string;
  riskDollarsCents: number;
  rangeWindow: string;
  tradingSession: string;
  takeProfitStyle: string;
  takeProfitTicksCents: number;
  stopLossStyle: string;
  stopLossTicksCents: number;
  breakEvenEnabled: boolean;
  breakEvenTriggerTicksCents: number;
  breakEvenOffsetTicksCents: number;
  ocoMode: 'oco' | 'both';
  /** Stop-only mode: entries dispatched as limit/market are refused — the
   *  bracket never reaches the broker once its level is crossed. */
  stopOnlyEntries: boolean;
  runMonday: boolean;
  runTuesday: boolean;
  runWednesday: boolean;
  runThursday: boolean;
  runFriday: boolean;
  runSaturday: boolean;
  runSunday: boolean;
  entriesPerRange: number;
  createdAt: string;
  updatedAt: string;
}

export type PerformanceExclusionReason = 'test_data' | 'erroneous';

export interface ProxyAlert {
  id: string;
  receivedAt: string;
  rangeName?: string;
  action: 'buy' | 'sell' | 'cancel' | 'exit';
  ticker: string;
  payloadJson: string;
  sourceReference?: string;
}

export interface AlertFeedEntry {
  alertId: string;
  receivedAt: string;
  rangeName?: string;
  action: 'buy' | 'sell' | 'cancel' | 'exit';
  ticker: string;
  payloadJson: string;
  sourceReference?: string;
  deliveryCount: number;
  tradeEventCount: number;
  matchedUserCount: number;
  matchedUserEmails: string[];
  matchedAccountCount: number;
  matchedAccountNames: string[];
  traderspostDeliveredCount: number;
  traderspostFailedCount: number;
  traderspostPendingCount: number;
  traderspostNotConfiguredCount: number;
  currentUserLinked: boolean;
}

export interface AlertFeedSummary {
  totalAlerts: number;
  routedAlerts: number;
  unroutedAlerts: number;
  traderspostDeliveredCount: number;
  traderspostFailedCount: number;
  traderspostPendingCount: number;
  latestReceivedAt?: string;
}

export type ProxyDeliveryStatus =
  | 'extension_draft_created'
  | 'extension_draft_created_and_pending_traderspost'
  | 'extension_draft_created_and_traderspost_delivered'
  | 'extension_draft_created_and_traderspost_failed'
  | 'pending_traderspost'
  | 'traderspost_delivered'
  | 'traderspost_failed'
  | 'traderspost_not_configured'
  | 'exit_recorded'
  | 'routing_disabled'
  | 'suppressed_duplicate'
  | 'suppressed_reapply'
  | 'suppressed_guard'
  | 'suppressed_safeguard';

export interface ProxyDelivery {
  id: string;
  proxyAlertId: string;
  rangeRouteId: string;
  userId: string;
  accountId: string;
  extensionEnabled: boolean;
  traderspostEnabled: boolean;
  draftId?: string;
  qualifiedTradeId?: string;
  status: ProxyDeliveryStatus;
  createdAt: string;
}

export interface AccountAlert {
  deliveryId: string;
  accountId: string;
  accountName: string;
  userId: string;
  receivedAt: string;
  rangeName?: string;
  action: 'buy' | 'sell' | 'cancel' | 'exit';
  ticker: string;
  sourceReference?: string;
  extensionEnabled: boolean;
  traderspostEnabled: boolean;
  deliveryStatus: ProxyDeliveryStatus;
  draftId?: string;
  draftStatus?: DraftStatus;
  reviewedAt?: string;
  submittedAt?: string;
}

export interface AccountAlertSummary {
  totalReceived: number;
  processed: number;
  extensionPending: number;
  extensionReviewed: number;
  extensionSubmitted: number;
  extensionRejected: number;
  traderspostDelivered: number;
  traderspostPending: number;
  traderspostFailed: number;
  traderspostNotConfigured: number;
  ignored: number;
  noDestination: number;
}

export interface TradersPostAccountDestination {
  accountId: string;
  webhookUrl: string;
  enabled: boolean;
  outboundTicker?: string;
  outboundTickerMode?: 'micros_only';
  useLimitPriceTP?: boolean;
  useAlertTP?: boolean;
  reapplyOnTradeCloseEnabled?: boolean;
  eodCancelTime?: string;
  eodExitTime?: string;
  eodEnabled?: boolean;
  newsFlattenEnabled?: boolean;
  newsFlattenMinutes?: number;
  // CrossTrade webhook destination — when crossTradeWebhookUrl is set, outbound
  // dispatches go to CrossTrade instead of the TradersPost webhookUrl.
  crossTradeWebhookUrl?: string;
  crossTradeSecretKey?: string;
  crossTradeAccountName?: string;
  // undefined = legacy rows treat configured CT as active; explicit false parks
  // a saved CT config so the account dispatches via TradersPost again.
  crossTradeEnabled?: boolean;
  quantityOverrideMode?: 'percent' | 'fixed' | 'risk';
  quantityOverrideValue?: number;
  updatedAt: string;
}

export interface ProxyDeliveryAttempt {
  id: string;
  proxyDeliveryId: string;
  attemptNumber: number;
  attemptedAt: string;
  statusCode?: number;
  success: boolean;
  errorText?: string;
}

export interface BridgeLog {
  id: string;
  userId: string;
  category: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface ProcessRun {
  id: string;
  startedAt: string;
  endedAt?: string;
  cleanExit: boolean;
  exitCode?: number;
  fatal?: { event: string; name?: string; message?: string; stack?: string };
  warnings?: Array<{ at?: string; name?: string; message?: string; stack?: string }>;
  lastActivity?: unknown;
  context?: unknown;
  lastHeartbeatAt?: string;
  rssBytes?: number;
  heapUsedBytes?: number;
  eventLoopLagMs?: number;
  nodeVersion: string;
  pid: number;
}

export type TradeEventType =
  | 'entry_armed'
  | 'entry_filled'
  | 'entry_cancelled'
  | 'exit_filled'
  | 'trade_closed';

export type TradeOutcome = 'win' | 'loss' | 'breakeven';

export interface TradeEvent {
  id: string;
  userId: string;
  accountId: string;
  rangeName: string;
  eventId: string;
  tradeId: string;
  bracketId?: string;
  eventType: TradeEventType;
  instrument: string;
  side: 'long' | 'short';
  action?: 'buy' | 'sell' | 'cancel' | 'exit';
  quantity: number;
  entryPrice?: number;
  exitPrice?: number;
  realizedTicksCents?: number;
  realizedDollarsCents?: number;
  outcome?: TradeOutcome;
  occurredAt: string;
  proxyAlertId?: string;
  entryArmedDeliveryStatus?: 'delivered' | 'failed' | 'extension' | 'blocked' | 'unknown';
  entryArmedDeliveryDetail?: string;
  entryArmedDeliveryId?: string;
  excludedFromPerformance: boolean;
  exclusionReason?: PerformanceExclusionReason;
  excludedByUserId?: string;
  exclusionUpdatedAt?: string;
  /** Machine provenance for automated exclusions (e.g. 'ct-phantom-close'). */
  exclusionMarker?: string;
  adjustmentNote?: string;
  adjustedAt?: string;
  adjustedByUserId?: string;
  adjustedByEmail?: string;
}

export interface RangeTradeEvent {
  id: string;
  rangeName: string;
  eventId: string;
  tradeId: string;
  eventType: TradeEventType;
  instrument: string;
  side: 'long' | 'short';
  action?: 'buy' | 'sell' | 'cancel' | 'exit';
  quantity: number;
  entryPrice?: number;
  exitPrice?: number;
  realizedTicksCents?: number;
  realizedDollarsCents?: number;
  outcome?: TradeOutcome;
  occurredAt: string;
  proxyAlertId?: string;
  adjustmentNote?: string;
}

export type BrokerOrderAction = 'buy' | 'sell' | 'cancel' | 'exit';

export type BrokerOrderState = 'pending' | 'acknowledged' | 'rejected' | 'uncertain' | 'filled' | 'closed' | 'cancelled';

export interface BrokerOrder {
  id: string;
  accountId: string;
  accountName?: string;
  rangeName: string;
  bracketId?: string;
  orderId: string;
  action: BrokerOrderAction;
  status: BrokerOrderState;
  dispatchStatus?: BrokerOrderState;
  statusSource?: 'dispatch' | 'lifecycle' | 'bridge' | 'operator' | 'email' | 'ct-verified' | 'legacy';
  // Which endpoint received the dispatch — legacy rows predate the marker and
  // surface as 'traderspost' via the mapper default.
  destination?: 'traderspost' | 'crosstrade';
  instrument: string;
  side?: 'long' | 'short';
  quantity?: number;
  price?: number;
  stopPrice?: number;
  limitPrice?: number;
  proxyAlertId?: string;
  proxyDeliveryId?: string;
  errorText?: string;
  /** The prepared outbound payload (post destination-transforms) as sent —
   *  the immutable dispatch snapshot retries rebuild from. */
  payloadJson?: string;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenTradeSanity {
  accountId: string;
  accountName: string;
  rangeName: string;
  instrument: string;
  side: 'long' | 'short';
  bracketId: string;
  tradeId: string;
  state: BracketMonitorState;
  quantity: number;
  entryPrice?: number;
  lastOccurredAt: string;
  hasTradeEvent: boolean;
  tradeEventType?: TradeEventType;
  tradeEventOccurredAt?: string;
  hasLifecycleAlert: boolean;
  hasDispatchAlert: boolean;
  dispatchAlertReceivedAt?: string;
  dispatchAlertAction?: 'buy' | 'sell';
  deliveryStatus?: string;
  deliveryCreatedAt?: string;
  brokerOrderStatus?: BrokerOrderState;
  brokerOrderErrorText?: string;
  brokerOrderOccurredAt?: string;
  routeTraderspostEnabled: boolean;
  routeExtensionEnabled: boolean;
  routeRunScheduled: boolean;
  isScheduledDay?: boolean;
  oppositeSideExists: boolean;
  oppositeSideState?: BracketMonitorState;
}

export type BracketMonitorState = 'armed' | 'filled' | 'closed' | 'cancelled';

export interface BracketMonitorEntry {
  accountId: string;
  rangeName: string;
  bracketId: string;
  side: 'long' | 'short';
  instrument: string;
  state: BracketMonitorState;
  quantity: number;
  tradeId: string;
  entryPrice?: number;
  deliverySuppressed?: boolean;
  lastEventId: string;
  lastEventType: TradeEventType;
  lastOccurredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RangeSubcategory {
  name: string;
  createdByUserId: string;
  createdByEmail: string;
  createdAt: string;
  color?: string | null;
}

export interface RangeSubcategoryAssignment {
  rangeName: string;
  subcategoryName: string;
  assignedByUserId: string;
  updatedAt: string;
  // Per-model run-day overrides for this range. null/undefined = inherit the
  // range's own run_* flag; a set flag governs routing for accounts subscribed
  // through this model — separate from the range's own schedule.
  runMonday?: boolean | null;
  runTuesday?: boolean | null;
  runWednesday?: boolean | null;
  runThursday?: boolean | null;
  runFriday?: boolean | null;
  runSaturday?: boolean | null;
  runSunday?: boolean | null;
}

export interface JournalMetrics {
  realizedDollarsCents: number;
  netTicksCents: number;
  closedCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  averageWinDollarsCents: number | null;
  averageLossDollarsCents: number | null;
  averageWinTicksCents: number | null;
  averageLossTicksCents: number | null;
  // Σ(realized ÷ range risk) over trades whose range declares risk; null when
  // no covered trades — only populated on journal-summary paths.
  rEarned?: number | null;
}

export interface TradeStats {
  profitFactor: number | null;
  expectancyDollarsCents: number | null;
  maxDrawdownDollarsCents: number;
  largestWinDollarsCents: number | null;
  largestLossDollarsCents: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface AccountJournal {
  account: BridgeAccount;
  allTime: JournalMetrics;
  currentWeek: JournalMetrics;
  currentDay: JournalMetrics;
  internalBalanceCents: number;
  stats: TradeStats;
}

export interface TradeJournal {
  allTime: JournalMetrics;
  currentWeek: JournalMetrics;
  currentDay: JournalMetrics;
  accounts: AccountJournal[];
  openTrades: TradeEvent[];
  pairedClosedTrades: TradeEvent[];
  recentClosedTrades: TradeEvent[];
  rangeNames: string[];
  rangeEntries: Record<string, number>;
  rangeRisk?: Record<string, number>;
}
