import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import DatabaseLib from 'better-sqlite3';
import { databasePath } from './config.js';
import { parseScopeBounds, type ForexFactoryDayResult, type ForexFactoryRangeResult } from './forex-factory.js';
import type {
  AlertFeedEntry,
  AlertFeedSummary,
  AccountAlert,
  AccountAlertSummary,
  BracketMonitorEntry,
  BracketMonitorState,
  BrokerOrder,
  BrokerOrderAction,
  BrokerOrderState,
  BridgeAccount,
  BridgeLog,
  DraftStatus,
  OrderDraft,
  OpenTradeSanity,
  PerformanceExclusionReason,
  ProxyAlert,
  ProxyDelivery,
  ProxyDeliveryAttempt,
  ProxyDeliveryStatus,
  ProcessRun,
  RangeConfiguration,
  RangeRoute,
  RangeSubcategory,
  RangeSubcategoryAssignment,
  RangeTradeEvent,
  AccountJournal,
  JournalMetrics,
  TradeEvent,
  TradeEventType,
  TradeJournal,
  TradeOutcome,
  TradersPostAccountDestination,
} from './types.js';
import { isLifecyclePayload, proxyPayloadSchema, rangeSlugForLookup, unscopeIdForRange as unscopeBracketId } from './webhook.js';
import type { ReapplyOperation, ReapplyStep } from './reapply.js';

type AlertFeedActivityFilter =
  | 'all'
  | 'routed'
  | 'unrouted'
  | 'lifecycle'
  | 'traderspost_delivered'
  | 'traderspost_failed';

export interface UserCredentials {
  id: string;
  email: string;
  webhookSecret: string;
  extensionToken: string;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  passwordSalt: string | null;
  passwordHash: string | null;
}

export interface UserSession {
  user: Pick<UserCredentials, 'id' | 'email'>;
  csrfToken: string;
}

const JOURNAL_TIME_OFFSET_MINUTES = -4 * 60;

interface DraftRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  status: DraftStatus;
  payload_json: string;
  received_at: string;
  reviewed_at: string | null;
  submitted_at: string | null;
  extension_eligible: number;
}

interface TradovateConnectionRow {
  environment: 'demo';
  encrypted_credentials: string;
  account_id: number | null;
  account_spec: string | null;
}

interface AccountRow {
  id: string;
  user_id: string;
  name: string;
  starting_balance_cents: number;
  external_balance_cents: number | null;
  deprecated: number;
  external_balance_at: string | null;
  created_at: string;
}

interface RangeRouteRow {
  id: string;
  range_name: string;
  user_id: string;
  account_id: string;
  extension_enabled: number;
  traderspost_enabled: number;
  run_scheduled: number;
  created_at: string;
  updated_at: string;
}

interface RangeConfigurationRow {
  range_name: string;
  instrument: string;
  description: string;
  risk_dollars_cents: number;
  range_window: string;
  trading_session: string;
  take_profit_style: string;
  take_profit_ticks_cents: number;
  stop_loss_style: string;
  stop_loss_ticks_cents: number;
  break_even_enabled: number;
  break_even_trigger_ticks_cents: number;
  break_even_offset_ticks_cents: number;
  oco_mode: string;
  stop_only_entries: number;
  run_monday: number;
  run_tuesday: number;
  run_wednesday: number;
  run_thursday: number;
  run_friday: number;
  run_saturday: number;
  run_sunday: number;
  entries_per_range: number;
  created_at: string;
  updated_at: string;
}

interface RangeTradeEventRow {
  id: string;
  range_name: string;
  event_id: string;
  trade_id: string;
  event_type: TradeEventType;
  instrument: string;
  side: 'long' | 'short';
  action: 'buy' | 'sell' | 'cancel' | 'exit' | null;
  quantity: number;
  entry_price: number | null;
  exit_price: number | null;
  realized_ticks_cents: number | null;
  realized_dollars_cents: number | null;
  outcome: TradeOutcome | null;
  occurred_at: string;
  proxy_alert_id: string | null;
  adjustment_note: string | null;
}

interface RangeCalendarVisibilityRow {
  range_name: string;
  date_key: string;
  hidden_by_user_id: string;
  updated_at: string;
}

interface RangeSubcategoryRow {
  name: string;
  created_by_user_id: string;
  created_by_email: string;
  created_at: string;
  color: string | null;
}

interface RangeSubcategoryAssignmentRow {
  range_name: string;
  subcategory_name: string;
  assigned_by_user_id: string;
  updated_at: string;
  run_monday: number | null;
  run_tuesday: number | null;
  run_wednesday: number | null;
  run_thursday: number | null;
  run_friday: number | null;
  run_saturday: number | null;
  run_sunday: number | null;
}

interface ProxyDeliveryRow {
  id: string;
  proxy_alert_id: string;
  range_route_id: string;
  user_id: string;
  account_id: string;
  extension_enabled: number;
  traderspost_enabled: number;
  draft_id: string | null;
  qualified_trade_id: string | null;
  status: ProxyDeliveryStatus;
  created_at: string;
}

export interface PreciseTakeProfitIntent {
  accountId: string;
  rangeName: string;
  bracketId: string;
  instrument: string;
  side: 'long' | 'short';
  action: 'buy' | 'sell';
  payloadJson: string;
  createdAt: string;
  updatedAt: string;
}

interface PreciseTakeProfitIntentRow {
  account_id: string;
  range_name: string;
  bracket_id: string;
  instrument: string;
  side: 'long' | 'short';
  action: 'buy' | 'sell';
  payload_json: string;
  created_at: string;
  updated_at: string;
}

interface BridgeLogRow {
  id: string;
  user_id: string;
  category: string;
  timestamp: string;
  data_json: string;
}

interface ProcessRunRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  clean_exit: number;
  exit_code: number | null;
  fatal_json: string | null;
  last_heartbeat_at: string | null;
  rss_bytes: number | null;
  heap_used_bytes: number | null;
  event_loop_lag_ms: number | null;
  warnings_json: string | null;
  last_activity_json: string | null;
  context_json: string | null;
  node_version: string;
  pid: number;
}

interface AccountAlertRow {
  delivery_id: string;
  account_id: string;
  account_name: string;
  user_id: string;
  received_at: string;
  range_name: string | null;
  action: 'buy' | 'sell' | 'cancel' | 'exit';
  ticker: string;
  source_reference: string | null;
  extension_enabled: number;
  traderspost_enabled: number;
  delivery_status: ProxyDeliveryStatus;
  draft_id: string | null;
  draft_status: DraftStatus | null;
  reviewed_at: string | null;
  submitted_at: string | null;
}

interface AccountAlertSummaryRow {
  total_received: number;
  processed: number;
  extension_pending: number;
  extension_reviewed: number;
  extension_submitted: number;
  extension_rejected: number;
  traderspost_delivered: number;
  traderspost_pending: number;
  traderspost_failed: number;
  traderspost_not_configured: number;
  ignored: number;
  no_destination: number;
}

interface AlertFeedRow {
  id: string;
  received_at: string;
  range_name: string | null;
  action: 'buy' | 'sell' | 'cancel' | 'exit';
  ticker: string;
  payload_json: string;
  source_reference: string | null;
  delivery_count: number;
  trade_event_count: number;
  matched_user_count: number;
  matched_user_emails: string | null;
  matched_account_count: number;
  matched_account_names: string | null;
  traderspost_delivered_count: number;
  traderspost_failed_count: number;
  traderspost_pending_count: number;
  traderspost_not_configured_count: number;
  current_user_linked: number;
}

interface ProxyDeliveryAttemptRow {
  id: string;
  proxy_delivery_id: string;
  attempt_number: number;
  attempted_at: string;
  status_code: number | null;
  success: number;
  error_text: string | null;
}

interface TradersPostAccountDestinationRow {
  account_id: string;
  webhook_url: string;
  enabled: number;
  outbound_ticker: string | null;
  outbound_ticker_mode: 'micros_only' | null;
  use_limit_price_tp: number;
  use_alert_tp: number;
  reapply_on_trade_close_enabled: number;
  eod_cancel_time: string;
  eod_exit_time: string;
  eod_enabled: number;
  news_flatten_enabled: number;
  news_flatten_minutes: number;
  cross_trade_webhook_url: string | null;
  cross_trade_secret_key: string | null;
  cross_trade_account_name: string | null;
  cross_trade_enabled: number | null;
  quantity_override_mode: 'percent' | 'fixed' | 'risk' | null;
  quantity_override_value: number | null;
  updated_at: string;
}

function mapTradersPostDestinationRow(row: TradersPostAccountDestinationRow): TradersPostAccountDestination {
  // CT-only accounts store the CrossTrade URL in webhook_url (column is NOT
  // NULL). While CT is parked that URL is NOT a valid TradersPost target —
  // presenting it would post TP payloads at the CT endpoint. Blank it so the
  // account reads as unconfigured until a distinct TP webhook is supplied.
  const parkedCtAlias = row.cross_trade_enabled === 0
    && row.cross_trade_webhook_url
    && row.webhook_url === row.cross_trade_webhook_url;
  return {
    accountId: row.account_id,
    webhookUrl: parkedCtAlias ? '' : row.webhook_url,
    enabled: row.enabled !== 0,
    ...(row.outbound_ticker ? { outboundTicker: row.outbound_ticker } : {}),
    ...(row.outbound_ticker_mode ? { outboundTickerMode: row.outbound_ticker_mode } : {}),
    useLimitPriceTP: row.use_limit_price_tp !== 0,
    useAlertTP: row.use_alert_tp !== 0,
    reapplyOnTradeCloseEnabled: row.reapply_on_trade_close_enabled !== 0,
    eodCancelTime: row.eod_cancel_time,
    eodExitTime: row.eod_exit_time,
    eodEnabled: row.eod_enabled !== 0,
    newsFlattenEnabled: row.news_flatten_enabled !== 0,
    newsFlattenMinutes: row.news_flatten_minutes,
    ...(row.cross_trade_webhook_url ? { crossTradeWebhookUrl: row.cross_trade_webhook_url } : {}),
    ...(row.cross_trade_secret_key ? { crossTradeSecretKey: row.cross_trade_secret_key } : {}),
    ...(row.cross_trade_account_name ? { crossTradeAccountName: row.cross_trade_account_name } : {}),
    ...(row.cross_trade_enabled != null ? { crossTradeEnabled: row.cross_trade_enabled !== 0 } : {}),
    ...(row.quantity_override_mode && row.quantity_override_value != null && row.quantity_override_value > 0
      ? { quantityOverrideMode: row.quantity_override_mode, quantityOverrideValue: row.quantity_override_value }
      : {}),
    updatedAt: row.updated_at,
  };
}

interface TradeEventRow {
  id: string;
  user_id: string;
  account_id: string;
  range_name: string;
  event_id: string;
  trade_id: string;
  bracket_id?: string | null;
  event_type: TradeEventType;
  instrument: string;
  side: 'long' | 'short';
  action: 'buy' | 'sell' | 'cancel' | 'exit' | null;
  quantity: number;
  entry_price: number | null;
  exit_price: number | null;
  realized_ticks_cents: number | null;
  realized_dollars_cents: number | null;
  outcome: TradeOutcome | null;
  occurred_at: string;
  proxy_alert_id: string | null;
  excluded_from_performance: number;
  exclusion_reason: PerformanceExclusionReason | null;
  excluded_by_user_id: string | null;
  exclusion_updated_at: string | null;
  exclusion_marker: string | null;
  adjustment_note: string | null;
  adjusted_at: string | null;
  adjusted_by_user_id: string | null;
  adjusted_by_email: string | null;
}

interface BracketMonitorRow {
  account_id: string;
  range_name: string;
  bracket_id: string;
  side: string;
  instrument: string;
  state: string;
  quantity: number;
  trade_id: string;
  entry_price: number | null;
  delivery_suppressed?: number;
  last_event_id: string;
  last_event_type: string;
  last_occurred_at: string;
  created_at: string;
  updated_at: string;
}

interface ForexFactorySnapshotRow {
  scope_kind: 'day' | 'range';
  scope_key: string;
  timezone: string;
  fetched_at: string;
  payload_json: string;
}

const CACHE_TTL_MS = 60_000;

export class Database {
  private readonly db: DatabaseLib.Database;
  private readonly cache: Map<string, { value: unknown; cachedAt: number; expiresAt: number }> = new Map();
  private readonly userCacheInvalidatedAt: Map<string, number> = new Map();

  constructor(filename = databasePath) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseLib(filename);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        webhook_secret TEXT NOT NULL UNIQUE,
        extension_token TEXT NOT NULL UNIQUE,
        password_salt TEXT,
        password_hash TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS order_drafts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'reviewed', 'submitted', 'rejected', 'expired')),
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        reviewed_at TEXT,
        submitted_at TEXT,
        UNIQUE(user_id, idempotency_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tradovate_connections (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        environment TEXT NOT NULL CHECK (environment IN ('demo')),
        encrypted_credentials TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        starting_balance_cents INTEGER NOT NULL,
        external_balance_cents INTEGER,
        external_balance_at TEXT,
        deprecated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS range_routes (
        id TEXT PRIMARY KEY,
        range_name TEXT NOT NULL COLLATE BINARY,
        user_id TEXT NOT NULL REFERENCES users(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        extension_enabled INTEGER NOT NULL CHECK (extension_enabled IN (0, 1)),
        traderspost_enabled INTEGER NOT NULL CHECK (traderspost_enabled IN (0, 1)),
        run_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (run_scheduled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(range_name, user_id, account_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS range_configurations (
        range_name TEXT PRIMARY KEY COLLATE BINARY,
        instrument TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        risk_dollars_cents INTEGER NOT NULL CHECK (risk_dollars_cents >= 0),
        range_window TEXT NOT NULL,
        trading_session TEXT NOT NULL DEFAULT '',
        take_profit_style TEXT NOT NULL,
        take_profit_ticks_cents INTEGER NOT NULL CHECK (take_profit_ticks_cents >= 0),
        stop_loss_style TEXT NOT NULL,
        stop_loss_ticks_cents INTEGER NOT NULL CHECK (stop_loss_ticks_cents >= 0),
        break_even_enabled INTEGER NOT NULL DEFAULT 0 CHECK (break_even_enabled IN (0, 1)),
        break_even_trigger_ticks_cents INTEGER NOT NULL DEFAULT 0 CHECK (break_even_trigger_ticks_cents >= 0),
        break_even_offset_ticks_cents INTEGER NOT NULL DEFAULT 0 CHECK (break_even_offset_ticks_cents >= 0),
        oco_mode TEXT NOT NULL DEFAULT 'oco' CHECK (oco_mode IN ('oco', 'both')),
        stop_only_entries INTEGER NOT NULL DEFAULT 1 CHECK (stop_only_entries IN (0, 1)),
        run_monday INTEGER NOT NULL CHECK (run_monday IN (0, 1)),
        run_tuesday INTEGER NOT NULL CHECK (run_tuesday IN (0, 1)),
        run_wednesday INTEGER NOT NULL CHECK (run_wednesday IN (0, 1)),
        run_thursday INTEGER NOT NULL CHECK (run_thursday IN (0, 1)),
        run_friday INTEGER NOT NULL CHECK (run_friday IN (0, 1)),
        run_saturday INTEGER NOT NULL CHECK (run_saturday IN (0, 1)),
        run_sunday INTEGER NOT NULL CHECK (run_sunday IN (0, 1)),
        entries_per_range INTEGER NOT NULL CHECK (entries_per_range > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS range_review_flags (
        range_name TEXT PRIMARY KEY COLLATE BINARY,
        reason TEXT NOT NULL,
        flagged_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS tracked_ranges (
        range_name TEXT PRIMARY KEY COLLATE BINARY,
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS range_subcategories (
        name TEXT PRIMARY KEY COLLATE BINARY,
        created_by_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        color TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS range_subcategory_assignments (
        range_name TEXT NOT NULL COLLATE BINARY,
        subcategory_name TEXT NOT NULL COLLATE BINARY REFERENCES range_subcategories(name) ON DELETE CASCADE,
        assigned_by_user_id TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL,
        run_monday INTEGER CHECK (run_monday IN (0, 1)),
        run_tuesday INTEGER CHECK (run_tuesday IN (0, 1)),
        run_wednesday INTEGER CHECK (run_wednesday IN (0, 1)),
        run_thursday INTEGER CHECK (run_thursday IN (0, 1)),
        run_friday INTEGER CHECK (run_friday IN (0, 1)),
        run_saturday INTEGER CHECK (run_saturday IN (0, 1)),
        run_sunday INTEGER CHECK (run_sunday IN (0, 1)),
        PRIMARY KEY (range_name, subcategory_name)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS proxy_alerts (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        range_name TEXT COLLATE BINARY,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'cancel', 'exit')),
        ticker TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        source_reference TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS proxy_deliveries (
        id TEXT PRIMARY KEY,
        proxy_alert_id TEXT NOT NULL REFERENCES proxy_alerts(id),
        range_route_id TEXT NOT NULL REFERENCES range_routes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        extension_enabled INTEGER NOT NULL CHECK (extension_enabled IN (0, 1)),
        traderspost_enabled INTEGER NOT NULL CHECK (traderspost_enabled IN (0, 1)),
        draft_id TEXT REFERENCES order_drafts(id) ON DELETE SET NULL,
        qualified_trade_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS traderspost_account_destinations (
         account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
         webhook_url TEXT NOT NULL,
         enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
         outbound_ticker TEXT,
         outbound_ticker_mode TEXT CHECK (outbound_ticker_mode IN ('micros_only')),
         use_limit_price_tp INTEGER NOT NULL DEFAULT 0 CHECK (use_limit_price_tp IN (0, 1)),
         use_alert_tp INTEGER NOT NULL DEFAULT 0 CHECK (use_alert_tp IN (0, 1)),
         reapply_on_trade_close_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reapply_on_trade_close_enabled IN (0, 1)),
         cancel_opposite_on_entry_fill INTEGER NOT NULL DEFAULT 0 CHECK (cancel_opposite_on_entry_fill IN (0, 1)),
         eod_cancel_time TEXT NOT NULL DEFAULT '16:30',
         eod_exit_time TEXT NOT NULL DEFAULT '16:45',
         eod_enabled INTEGER NOT NULL DEFAULT 1 CHECK (eod_enabled IN (0, 1)),
         news_flatten_enabled INTEGER NOT NULL DEFAULT 0 CHECK (news_flatten_enabled IN (0, 1)),
         news_flatten_minutes INTEGER NOT NULL DEFAULT 5 CHECK (news_flatten_minutes > 0),
         cross_trade_webhook_url TEXT,
         cross_trade_secret_key TEXT,
         cross_trade_account_name TEXT,
         updated_at TEXT NOT NULL
       ) STRICT;

      CREATE TABLE IF NOT EXISTS proxy_delivery_attempts (
        id TEXT PRIMARY KEY,
        proxy_delivery_id TEXT NOT NULL REFERENCES proxy_deliveries(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        attempted_at TEXT NOT NULL,
        status_code INTEGER,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        error_text TEXT,
        UNIQUE(proxy_delivery_id, attempt_number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS precise_take_profit_intents (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        range_name TEXT NOT NULL COLLATE BINARY,
        bracket_id TEXT NOT NULL,
        instrument TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, range_name, bracket_id, side)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS trade_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        range_name TEXT NOT NULL COLLATE BINARY,
        event_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('entry_armed', 'entry_filled', 'entry_cancelled', 'exit_filled', 'trade_closed')),
        instrument TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        action TEXT CHECK (action IS NULL OR action IN ('buy', 'sell', 'cancel', 'exit')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        entry_price REAL,
        exit_price REAL,
        realized_ticks_cents INTEGER,
        realized_dollars_cents INTEGER,
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'breakeven')),
        occurred_at TEXT NOT NULL,
        proxy_alert_id TEXT REFERENCES proxy_alerts(id),
        excluded_from_performance INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_performance IN (0, 1)),
        exclusion_reason TEXT,
        excluded_by_user_id TEXT REFERENCES users(id),
        exclusion_updated_at TEXT,
        exclusion_marker TEXT,
        CHECK (
          (event_type = 'trade_closed'
            AND realized_ticks_cents IS NOT NULL
            AND realized_dollars_cents IS NOT NULL
            AND outcome IS NOT NULL)
          OR event_type <> 'trade_closed'
        ),
        UNIQUE(event_id, account_id, range_name)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS range_trade_events (
        id TEXT PRIMARY KEY,
        range_name TEXT NOT NULL COLLATE BINARY,
        event_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('entry_armed', 'entry_filled', 'entry_cancelled', 'exit_filled', 'trade_closed')),
        instrument TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        action TEXT CHECK (action IS NULL OR action IN ('buy', 'sell', 'cancel', 'exit')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        entry_price REAL,
        exit_price REAL,
        realized_ticks_cents INTEGER,
        realized_dollars_cents INTEGER,
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'breakeven')),
        occurred_at TEXT NOT NULL,
        proxy_alert_id TEXT REFERENCES proxy_alerts(id),
        adjustment_note TEXT,
        CHECK (
          (event_type = 'trade_closed'
            AND realized_ticks_cents IS NOT NULL
            AND realized_dollars_cents IS NOT NULL
            AND outcome IS NOT NULL)
          OR event_type <> 'trade_closed'
        ),
        UNIQUE(event_id, range_name)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS range_calendar_visibility (
        range_name TEXT NOT NULL COLLATE BINARY,
        date_key TEXT NOT NULL,
        hidden_by_user_id TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (range_name, date_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS forex_factory_snapshots (
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('day', 'range')),
        scope_key TEXT NOT NULL,
        timezone TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (scope_kind, scope_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS bracket_monitor (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        range_name TEXT NOT NULL COLLATE BINARY,
        bracket_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        instrument TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('armed', 'filled', 'closed', 'cancelled')),
        quantity REAL NOT NULL,
        trade_id TEXT NOT NULL,
        entry_price REAL,
        delivery_suppressed INTEGER NOT NULL DEFAULT 0,
        last_event_id TEXT NOT NULL,
        last_event_type TEXT NOT NULL CHECK (last_event_type IN ('entry_armed', 'entry_filled', 'entry_cancelled', 'exit_filled', 'trade_closed')),
        last_occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, range_name, bracket_id, side)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS bracket_monitor_by_account_range
        ON bracket_monitor (account_id, range_name, state);

      CREATE TABLE IF NOT EXISTS bracket_reapply_aliases (
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        range_name TEXT NOT NULL COLLATE BINARY,
        original_bracket_id TEXT NOT NULL,
        current_bracket_id TEXT NOT NULL,
        logical_trade_id TEXT NOT NULL,
        PRIMARY KEY (account_id, range_name, original_bracket_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS broker_orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        range_name TEXT NOT NULL COLLATE BINARY,
        bracket_id TEXT,
        order_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'cancel', 'exit')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'rejected', 'uncertain', 'filled', 'closed', 'cancelled')),
        instrument TEXT NOT NULL,
        side TEXT CHECK (side IN ('long', 'short')),
        quantity REAL CHECK (quantity > 0),
        price REAL,
        stop_price REAL,
        limit_price REAL,
        proxy_alert_id TEXT REFERENCES proxy_alerts(id),
        proxy_delivery_id TEXT REFERENCES proxy_deliveries(id),
        error_text TEXT,
        destination TEXT CHECK (destination IN ('traderspost', 'crosstrade')),
        payload_json TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, order_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS broker_orders_by_account_bracket
        ON broker_orders (account_id, bracket_id, side);
      CREATE INDEX IF NOT EXISTS broker_orders_by_account_order
        ON broker_orders (account_id, order_id);

      CREATE TABLE IF NOT EXISTS reapply_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        data_json TEXT NOT NULL,
        UNIQUE (account_id, event_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS bridge_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        category TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        data_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS process_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        clean_exit INTEGER NOT NULL DEFAULT 0 CHECK (clean_exit IN (0, 1)),
        exit_code INTEGER,
        fatal_json TEXT,
        last_heartbeat_at TEXT,
        rss_bytes INTEGER,
        heap_used_bytes INTEGER,
        event_loop_lag_ms INTEGER,
        node_version TEXT NOT NULL,
        pid INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS process_runs_by_started_at
        ON process_runs (started_at DESC);

      CREATE INDEX IF NOT EXISTS bridge_logs_by_user_timestamp
        ON bridge_logs (user_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS bridge_logs_by_user_category_timestamp
        ON bridge_logs (user_id, category, timestamp DESC);

      CREATE INDEX IF NOT EXISTS trade_events_by_user_closed_at
        ON trade_events (user_id, event_type, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS trade_events_by_user_excluded_closed_at
        ON trade_events (user_id, event_type, excluded_from_performance, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS trade_events_by_account_closed_at
        ON trade_events (account_id, event_type, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS trade_events_by_proxy_alert
        ON trade_events (proxy_alert_id);
      CREATE INDEX IF NOT EXISTS range_trade_events_by_range_closed_at
        ON range_trade_events (range_name, event_type, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS range_calendar_visibility_by_range
        ON range_calendar_visibility (range_name, date_key);
      CREATE INDEX IF NOT EXISTS range_subcategory_assignments_by_subcategory
        ON range_subcategory_assignments (subcategory_name, range_name COLLATE BINARY);
      CREATE INDEX IF NOT EXISTS proxy_deliveries_by_proxy_alert
        ON proxy_deliveries (proxy_alert_id);
      CREATE INDEX IF NOT EXISTS proxy_alerts_received_at
        ON proxy_alerts (received_at DESC);
    `);
    this.ensureUserColumns();
    this.ensureAccountColumns();
    this.ensureProcessRunColumns();
    this.ensureOrderDraftColumns();
    this.ensureProxyDeliveryColumns();
    this.ensureBracketMonitorColumns();
    this.ensureBrokerOrdersSchema();
    const brokerColumns = this.db.prepare('PRAGMA table_info(broker_orders)').all() as Array<{ name: string }>;
    if (!brokerColumns.some(c => c.name === 'dispatch_status')) this.db.exec('ALTER TABLE broker_orders ADD COLUMN dispatch_status TEXT');
    if (!brokerColumns.some(c => c.name === 'status_source')) this.db.exec("ALTER TABLE broker_orders ADD COLUMN status_source TEXT NOT NULL DEFAULT 'legacy'");
    if (!brokerColumns.some(c => c.name === 'destination')) this.db.exec("ALTER TABLE broker_orders ADD COLUMN destination TEXT CHECK (destination IN ('traderspost', 'crosstrade'))");
    if (!brokerColumns.some(c => c.name === 'payload_json')) this.db.exec('ALTER TABLE broker_orders ADD COLUMN payload_json TEXT');
    this.ensureTradovateConnectionColumns();
    this.ensureRangeConfigurationColumns();
    this.ensureTradeEventColumns();
    this.ensureTradeEventsUniqueKey();
    this.ensureRangeTradeEventColumns();
    this.ensureTradersPostDestinationColumns();
    this.migrateTradersPostDestinations();
    this.migrateRangeRoutesMultiplicity();
    this.migrateRangeSubcategoryAssignments();
    this.ensureRangeRouteColumns();
    this.ensureRangeSubcategoryColumns();
    this.ensureProxyDeliveryRangeRouteReference();
    this.ensureProxyDeliveriesNoUniqueConstraint();
    this.normalizeStoredRangeNames();
    this.syncExclusionFromRangeReviewFlags();
    this.syncRangeCalendarVisibilityWithSchedules();
  }

  private cacheKey(userId: string, namespace: string, parts: (string | undefined)[]): string {
    return `${namespace}:${userId}:${parts.map((part) => part ?? 'all').join(':')}`;
  }

  private getCache<T>(userId: string, namespace: string, parts: (string | undefined)[]): T | undefined {
    if (process.env.NODE_ENV === 'test') return undefined;
    const key = this.cacheKey(userId, namespace, parts);
    const entry = this.cache.get(key);
    const invalidatedAt = this.userCacheInvalidatedAt.get(userId) ?? 0;
    const now = Date.now();
    if (!entry) return undefined;
    if (entry.expiresAt <= now || entry.cachedAt <= invalidatedAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private setCache<T>(userId: string, namespace: string, parts: (string | undefined)[], value: T): void {
    if (process.env.NODE_ENV === 'test') return;
    const key = this.cacheKey(userId, namespace, parts);
    this.cache.set(key, { value, cachedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS });
  }

  onUserCacheInvalidated?: (userId: string) => void;

  private userInvalidateLastEmit = new Map<string, number>();
  private userInvalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();

  invalidateUserCache(userId: string): void {
    // Always stamp — reads depend on this being fresh even when the SSE emit
    // is debounced (a sweep burst can write dozens of rows per tick).
    this.userCacheInvalidatedAt.set(userId, Date.now());
    const emit = () => {
      this.userInvalidateLastEmit.set(userId, Date.now());
      try {
        this.onUserCacheInvalidated?.(userId);
      } catch {
        // never let a listener break the write path
      }
    };
    const last = this.userInvalidateLastEmit.get(userId) ?? 0;
    const remaining = 400 - (Date.now() - last);
    if (remaining <= 0) {
      const pending = this.userInvalidateTimers.get(userId);
      if (pending) clearTimeout(pending);
      this.userInvalidateTimers.delete(userId);
      emit();
      return;
    }
    if (!this.userInvalidateTimers.has(userId)) {
      const t = setTimeout(() => {
        this.userInvalidateTimers.delete(userId);
        emit();
      }, remaining);
      t.unref?.();
      this.userInvalidateTimers.set(userId, t);
    }
  }

  getForexFactorySnapshot(scopeKind: 'day' | 'range', scopeKey: string): ForexFactoryDayResult | ForexFactoryRangeResult | undefined {
    const row = this.db.prepare(`
      SELECT scope_kind, scope_key, timezone, fetched_at, payload_json
      FROM forex_factory_snapshots
      WHERE scope_kind = ? AND scope_key = ?
    `).get(scopeKind, scopeKey) as ForexFactorySnapshotRow | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload_json) as { events: unknown[] };
    if (row.scope_kind === 'day') {
      return {
        source: 'ForexFactory',
        day: row.scope_key,
        timezone: row.timezone,
        fetchedAt: row.fetched_at,
        events: Array.isArray(payload.events) ? payload.events as ForexFactoryDayResult['events'] : [],
      };
    }
    return {
      source: 'ForexFactory',
      range: row.scope_key,
      timezone: row.timezone,
      fetchedAt: row.fetched_at,
      events: Array.isArray(payload.events) ? payload.events as ForexFactoryRangeResult['events'] : [],
    };
  }

  findForexFactoryRangeSnapshotCovering(date: Date): ForexFactoryRangeResult | undefined {
    const time = date.getTime();
    const rows = this.db.prepare(`
      SELECT scope_key, timezone, fetched_at, payload_json
      FROM forex_factory_snapshots
      WHERE scope_kind = 'range'
    `).all() as Array<{ scope_key: string; timezone: string; fetched_at: string; payload_json: string }>;
    for (const row of rows) {
      const bounds = parseScopeBounds(row.scope_key);
      if (!bounds) continue;
      if (time < bounds.start || time > bounds.end) continue;
      const payload = JSON.parse(row.payload_json) as { events: unknown[] };
      return {
        source: 'ForexFactory',
        range: row.scope_key,
        timezone: row.timezone,
        fetchedAt: row.fetched_at,
        events: Array.isArray(payload.events) ? payload.events as ForexFactoryRangeResult['events'] : [],
      };
    }
    return undefined;
  }

  findForexFactoryRangeSnapshotsOverlapping(range: string): ForexFactoryRangeResult[] {
    const bounds = parseScopeBounds(range);
    if (!bounds) return [];
    const rows = this.db.prepare(`
      SELECT scope_key, timezone, fetched_at, payload_json
      FROM forex_factory_snapshots
      WHERE scope_kind = 'range'
    `).all() as Array<{ scope_key: string; timezone: string; fetched_at: string; payload_json: string }>;
    const results: ForexFactoryRangeResult[] = [];
    for (const row of rows) {
      const rowBounds = parseScopeBounds(row.scope_key);
      if (!rowBounds) continue;
      if (rowBounds.end < bounds.start || rowBounds.start > bounds.end) continue;
      const payload = JSON.parse(row.payload_json) as { events: unknown[] };
      results.push({
        source: 'ForexFactory',
        range: row.scope_key,
        timezone: row.timezone,
        fetchedAt: row.fetched_at,
        events: Array.isArray(payload.events) ? payload.events as ForexFactoryRangeResult['events'] : [],
      });
    }
    return results;
  }

  upsertForexFactorySnapshot(snapshot: ForexFactoryDayResult | ForexFactoryRangeResult): void {
    const scopeKind = 'day' in snapshot ? 'day' : 'range';
    const scopeKey = 'day' in snapshot ? snapshot.day : snapshot.range;
    this.db.prepare(`
      INSERT INTO forex_factory_snapshots (scope_kind, scope_key, timezone, fetched_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_kind, scope_key) DO UPDATE SET
        timezone = excluded.timezone,
        fetched_at = excluded.fetched_at,
        payload_json = excluded.payload_json
    `).run(
      scopeKind,
      scopeKey,
      snapshot.timezone,
      snapshot.fetchedAt,
      JSON.stringify({ events: snapshot.events }),
    );
  }

  private ensureUserColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(users)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'password_salt')) {
      this.db.exec('ALTER TABLE users ADD COLUMN password_salt TEXT');
    }
    if (!columns.some((column) => column.name === 'password_hash')) {
      this.db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
    }
  }

  // Crash-forensics columns: warnings accumulate process.on('warning')
  // events, last_activity_json carries the most recent work snapshot (written
  // each heartbeat), context_json is written on managed fatal exits with the
  // request ring buffer — for hard kills (SIGKILL/host) the heartbeat snapshot
  // is all the evidence that survives.
  private ensureProcessRunColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(process_runs)').all() as unknown as Array<{ name: string }>;
    for (const name of ['warnings_json', 'last_activity_json', 'context_json']) {
      if (!columns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE process_runs ADD COLUMN ${name} TEXT`);
      }
    }
  }

  private ensureAccountColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(accounts)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'deprecated')) {
      this.db.exec('ALTER TABLE accounts ADD COLUMN deprecated INTEGER NOT NULL DEFAULT 0');
    }
  }

  private ensureRangeSubcategoryColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(range_subcategories)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'color')) {
      this.db.exec('ALTER TABLE range_subcategories ADD COLUMN color TEXT');
    }
  }

  private ensureRangeRouteColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(range_routes)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'run_scheduled')) {
      this.db.exec('ALTER TABLE range_routes ADD COLUMN run_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (run_scheduled IN (0, 1))');
    }
  }

  private ensureTradovateConnectionColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(tradovate_connections)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'account_id')) {
      this.db.exec('ALTER TABLE tradovate_connections ADD COLUMN account_id INTEGER');
    }
    if (!columns.some((column) => column.name === 'account_spec')) {
      this.db.exec('ALTER TABLE tradovate_connections ADD COLUMN account_spec TEXT');
    }
  }

  private ensureRangeConfigurationColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(range_configurations)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'description')) {
      this.db.exec("ALTER TABLE range_configurations ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === 'trading_session')) {
      this.db.exec("ALTER TABLE range_configurations ADD COLUMN trading_session TEXT NOT NULL DEFAULT ''");
    }
    // Breakeven model upgrade: the old break_even_stop_ticks_cents held what
    // was really the BE trigger distance (values match ULTRA's trigger presets),
    // so rename it to break_even_trigger_ticks_cents — preserving the data under
    // its correct meaning. The enabled flag defaults to 0 for everyone:
    // nonzero triggers can't be trusted as an enable signal (e.g. 46 CODE had
    // a stored trigger but ULTRA flags BE off), and a wrongly-enabled range
    // fails closed under the CT ATM policy. scripts/prepopulate-ultra-configs.ts
    // applies the authoritative ULTRA preset values.
    const hasOldBeStop = columns.some((column) => column.name === 'break_even_stop_ticks_cents');
    const hasTrigger = columns.some((column) => column.name === 'break_even_trigger_ticks_cents');
    if (hasOldBeStop && !hasTrigger) {
      this.db.exec('ALTER TABLE range_configurations RENAME COLUMN break_even_stop_ticks_cents TO break_even_trigger_ticks_cents');
    } else if (hasOldBeStop) {
      this.db.exec('ALTER TABLE range_configurations DROP COLUMN break_even_stop_ticks_cents');
    }
    if (!columns.some((column) => column.name === 'break_even_enabled')) {
      this.db.exec('ALTER TABLE range_configurations ADD COLUMN break_even_enabled INTEGER NOT NULL DEFAULT 0 CHECK (break_even_enabled IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'break_even_offset_ticks_cents')) {
      this.db.exec('ALTER TABLE range_configurations ADD COLUMN break_even_offset_ticks_cents INTEGER NOT NULL DEFAULT 0 CHECK (break_even_offset_ticks_cents >= 0)');
    }
    if (!hasTrigger && !hasOldBeStop) {
      this.db.exec('ALTER TABLE range_configurations ADD COLUMN break_even_trigger_ticks_cents INTEGER NOT NULL DEFAULT 0 CHECK (break_even_trigger_ticks_cents >= 0)');
    }
    if (!columns.some((column) => column.name === 'oco_mode')) {
      this.db.exec("ALTER TABLE range_configurations ADD COLUMN oco_mode TEXT NOT NULL DEFAULT 'oco' CHECK (oco_mode IN ('oco', 'both'))");
    }
    if (!columns.some((column) => column.name === 'stop_only_entries')) {
      this.db.exec('ALTER TABLE range_configurations ADD COLUMN stop_only_entries INTEGER NOT NULL DEFAULT 1 CHECK (stop_only_entries IN (0, 1))');
      // Stop-only is the default posture — enable on every pre-existing range
      // too. Runs only on column creation so later opt-outs stick.
      this.db.exec('UPDATE range_configurations SET stop_only_entries = 1');
    }
    // EOD flatten moved to the account destination — the per-range time is dead config.
    if (columns.some((column) => column.name === 'eod_flatten_time')) {
      this.db.exec('ALTER TABLE range_configurations DROP COLUMN eod_flatten_time');
    }
  }

  private ensureTradeEventColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(trade_events)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'excluded_from_performance')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN excluded_from_performance INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'exclusion_reason')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN exclusion_reason TEXT');
    }
    if (!columns.some((column) => column.name === 'excluded_by_user_id')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN excluded_by_user_id TEXT');
    }
    if (!columns.some((column) => column.name === 'exclusion_updated_at')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN exclusion_updated_at TEXT');
    }
    if (!columns.some((column) => column.name === 'adjustment_note')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN adjustment_note TEXT');
    }
    if (!columns.some((column) => column.name === 'exclusion_marker')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN exclusion_marker TEXT');
    }
    if (!columns.some((column) => column.name === 'adjusted_at')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN adjusted_at TEXT');
    }
    if (!columns.some((column) => column.name === 'adjusted_by_user_id')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN adjusted_by_user_id TEXT');
    }
    if (!columns.some((column) => column.name === 'adjusted_by_email')) {
      this.db.exec('ALTER TABLE trade_events ADD COLUMN adjusted_by_email TEXT');
    }
  }

  // Ultra/Pine mints lifecycle ids as `ultra-<ver>-<ticker>-<epoch>-<seq>-<side>-arm-<seq>`
  // with no range component, so two ranges sharing an instrument and anchor epoch emit
  // identical event_ids. The legacy UNIQUE(event_id, account_id) silently dropped the
  // second range's journal rows on a shared account — no monitor write, no close
  // dispatch, and the surviving range's lifecycle resolved the other range's ledger
  // rows. Rebuild with the range-scoped key so colliding ids stay distinct events.
  private ensureTradeEventsUniqueKey(): void {
    const sql = (this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trade_events'`,
    ).get() as { sql: string } | undefined)?.sql ?? '';
    if (!sql || sql.includes('UNIQUE(event_id, account_id, range_name)')) return;

    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE trade_events_repaired (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          account_id TEXT NOT NULL REFERENCES accounts(id),
          range_name TEXT NOT NULL COLLATE BINARY,
          event_id TEXT NOT NULL,
          trade_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN ('entry_armed', 'entry_filled', 'entry_cancelled', 'exit_filled', 'trade_closed')),
          instrument TEXT NOT NULL,
          side TEXT NOT NULL CHECK (side IN ('long', 'short')),
          action TEXT CHECK (action IS NULL OR action IN ('buy', 'sell', 'cancel', 'exit')),
          quantity REAL NOT NULL CHECK (quantity > 0),
          entry_price REAL,
          exit_price REAL,
          realized_ticks_cents INTEGER,
          realized_dollars_cents INTEGER,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'breakeven')),
          occurred_at TEXT NOT NULL,
          proxy_alert_id TEXT REFERENCES proxy_alerts(id),
          excluded_from_performance INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_performance IN (0, 1)),
          exclusion_reason TEXT,
          excluded_by_user_id TEXT REFERENCES users(id),
          exclusion_updated_at TEXT,
          exclusion_marker TEXT,
          adjustment_note TEXT,
          adjusted_at TEXT,
          adjusted_by_user_id TEXT,
          adjusted_by_email TEXT,
          CHECK (
            (event_type = 'trade_closed'
              AND realized_ticks_cents IS NOT NULL
              AND realized_dollars_cents IS NOT NULL
              AND outcome IS NOT NULL)
            OR event_type <> 'trade_closed'
          ),
          UNIQUE(event_id, account_id, range_name)
        ) STRICT;
      `);
      this.db.exec(`
        INSERT INTO trade_events_repaired (
          id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
          quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
          occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id,
          exclusion_updated_at, exclusion_marker, adjustment_note, adjusted_at, adjusted_by_user_id, adjusted_by_email
        )
        SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
          quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
          occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id,
          exclusion_updated_at, exclusion_marker, adjustment_note, adjusted_at, adjusted_by_user_id, adjusted_by_email
        FROM trade_events`,
      );
      this.db.exec('DROP TABLE trade_events');
      this.db.exec('ALTER TABLE trade_events_repaired RENAME TO trade_events');
      this.db.exec(`
        CREATE INDEX trade_events_by_user_closed_at
          ON trade_events (user_id, event_type, occurred_at DESC);
        CREATE INDEX trade_events_by_account_closed_at
          ON trade_events (account_id, event_type, occurred_at DESC);
        CREATE INDEX trade_events_by_user_excluded_closed_at
          ON trade_events (user_id, event_type, excluded_from_performance, occurred_at DESC);
        CREATE INDEX trade_events_by_proxy_alert
          ON trade_events (proxy_alert_id);
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private ensureRangeTradeEventColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(range_trade_events)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'adjustment_note')) {
      this.db.exec('ALTER TABLE range_trade_events ADD COLUMN adjustment_note TEXT');
    }
  }

  private ensureOrderDraftColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(order_drafts)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'submitted_at')) {
      this.db.exec('ALTER TABLE order_drafts ADD COLUMN submitted_at TEXT');
    }
    // 1 = default so every pre-migration draft stays visible to the extension.
    if (!columns.some((column) => column.name === 'extension_eligible')) {
      this.db.exec('ALTER TABLE order_drafts ADD COLUMN extension_eligible INTEGER NOT NULL DEFAULT 1');
    }
  }

  private ensureProxyDeliveryColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(proxy_deliveries)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'qualified_trade_id')) {
      this.db.prepare('ALTER TABLE proxy_deliveries ADD COLUMN qualified_trade_id TEXT').run();
    }
  }

  private ensureBracketMonitorColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(bracket_monitor)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'delivery_suppressed')) {
      this.db.prepare('ALTER TABLE bracket_monitor ADD COLUMN delivery_suppressed INTEGER NOT NULL DEFAULT 0').run();
    }
  }

  // Older databases created broker_orders with NOT NULL bracket_id/side/quantity and a
  // UNIQUE(account_id, bracket_id, side, action) constraint, or with a status CHECK that
  // predates the 'uncertain' state. Rebuild the table with the current DDL when either
  // legacy shape is detected.
  private ensureBrokerOrdersSchema(): void {
    const columns = this.db.prepare('PRAGMA table_info(broker_orders)').all() as unknown as Array<{ name: string; notnull: number }>;
    const bracketIdColumn = columns.find((column) => column.name === 'bracket_id');
    const tableSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'broker_orders'").get() as { sql: string } | undefined)?.sql ?? '';
    const needsRebuild = Boolean(bracketIdColumn && bracketIdColumn.notnull !== 0) || !tableSql.includes("'uncertain'");
    if (!needsRebuild) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE broker_orders_repaired (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          range_name TEXT NOT NULL COLLATE BINARY,
          bracket_id TEXT,
          order_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'cancel', 'exit')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'rejected', 'uncertain', 'filled', 'closed', 'cancelled')),
          instrument TEXT NOT NULL,
          side TEXT CHECK (side IN ('long', 'short')),
          quantity REAL CHECK (quantity > 0),
          price REAL,
          stop_price REAL,
          limit_price REAL,
          proxy_alert_id TEXT REFERENCES proxy_alerts(id),
          proxy_delivery_id TEXT REFERENCES proxy_deliveries(id),
          error_text TEXT,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (account_id, order_id)
        ) STRICT;
      `);
      this.db.prepare(
        `INSERT INTO broker_orders_repaired (
          id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
          price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, occurred_at, created_at, updated_at
        )
        SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
          price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, occurred_at, created_at, updated_at
        FROM broker_orders`,
      ).run();
      this.db.exec('DROP TABLE broker_orders');
      this.db.exec('ALTER TABLE broker_orders_repaired RENAME TO broker_orders');
      this.db.exec(`
        CREATE INDEX broker_orders_by_account_bracket ON broker_orders (account_id, bracket_id, side);
        CREATE INDEX broker_orders_by_account_order ON broker_orders (account_id, order_id);
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private ensureTradersPostDestinationColumns(): void {
    const columns = this.db.prepare('PRAGMA table_info(traderspost_account_destinations)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'enabled')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'outbound_ticker')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN outbound_ticker TEXT');
    }
    if (!columns.some((column) => column.name === 'outbound_ticker_mode')) {
      this.db.exec("ALTER TABLE traderspost_account_destinations ADD COLUMN outbound_ticker_mode TEXT CHECK (outbound_ticker_mode IN ('micros_only'))");
    }
    if (!columns.some((column) => column.name === 'use_limit_price_tp')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN use_limit_price_tp INTEGER NOT NULL DEFAULT 0 CHECK (use_limit_price_tp IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'use_alert_tp')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN use_alert_tp INTEGER NOT NULL DEFAULT 0 CHECK (use_alert_tp IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'reapply_on_trade_close_enabled')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN reapply_on_trade_close_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reapply_on_trade_close_enabled IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'cancel_opposite_on_entry_fill')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN cancel_opposite_on_entry_fill INTEGER NOT NULL DEFAULT 0 CHECK (cancel_opposite_on_entry_fill IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'eod_cancel_time')) {
      this.db.exec("ALTER TABLE traderspost_account_destinations ADD COLUMN eod_cancel_time TEXT NOT NULL DEFAULT '16:30'");
    }
    if (!columns.some((column) => column.name === 'eod_exit_time')) {
      this.db.exec("ALTER TABLE traderspost_account_destinations ADD COLUMN eod_exit_time TEXT NOT NULL DEFAULT '16:45'");
    }
    if (!columns.some((column) => column.name === 'eod_enabled')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN eod_enabled INTEGER NOT NULL DEFAULT 1 CHECK (eod_enabled IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'news_flatten_enabled')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN news_flatten_enabled INTEGER NOT NULL DEFAULT 0 CHECK (news_flatten_enabled IN (0, 1))');
    }
    if (!columns.some((column) => column.name === 'news_flatten_minutes')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN news_flatten_minutes INTEGER NOT NULL DEFAULT 5 CHECK (news_flatten_minutes > 0)');
    }
    if (!columns.some((column) => column.name === 'cross_trade_webhook_url')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN cross_trade_webhook_url TEXT');
    }
    if (!columns.some((column) => column.name === 'cross_trade_secret_key')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN cross_trade_secret_key TEXT');
    }
    if (!columns.some((column) => column.name === 'cross_trade_account_name')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN cross_trade_account_name TEXT');
    }
    if (!columns.some((column) => column.name === 'quantity_override_mode')) {
      this.db.exec("ALTER TABLE traderspost_account_destinations ADD COLUMN quantity_override_mode TEXT CHECK (quantity_override_mode IN ('percent', 'fixed'))");
    }
    if (!columns.some((column) => column.name === 'quantity_override_value')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN quantity_override_value REAL');
    }
    // NULL/1 = CrossTrade routes dispatches when url+key are configured;
    // 0 = parked — stored config preserved but TradersPost dispatches again.
    if (!columns.some((column) => column.name === 'cross_trade_enabled')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations ADD COLUMN cross_trade_enabled INTEGER CHECK (cross_trade_enabled IN (0, 1))');
    }
    // cross_trade_destination existed briefly; the integration is NT8-only, so
    // the column is dropped again on databases that already received it.
    if (columns.some((column) => column.name === 'cross_trade_destination')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations DROP COLUMN cross_trade_destination');
    }
    // cross_trade_api_token existed briefly; the single secret key doubles as
    // the REST Bearer token, so the column is dropped where it exists.
    if (columns.some((column) => column.name === 'cross_trade_api_token')) {
      this.db.exec('ALTER TABLE traderspost_account_destinations DROP COLUMN cross_trade_api_token');
    }
    // 'risk' sizing mode: SQLite cannot ALTER a CHECK, so the STRICT table is
    // rebuilt once when its CHECK still lacks the 'risk' member. The rebuild
    // reuses the table's own CREATE SQL so vintages with legacy columns
    // (ultra_exit_order_enabled, lifecycle_exit_order_enabled,
    // close_range_on_take_profit) keep them.
    const destSql = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'traderspost_account_destinations'`,
    ).get() as { sql: string } | undefined;
    if (destSql && destSql.sql.includes("IN ('percent', 'fixed')") && !destSql.sql.includes("'risk'")) {
      const createSql = destSql.sql
        .replace(/^CREATE TABLE traderspost_account_destinations/i, 'CREATE TABLE traderspost_account_destinations_new')
        .replace(/IN \('percent', 'fixed'\)/, "IN ('percent', 'fixed', 'risk')");
      this.db.exec(`
        ${createSql};
        INSERT INTO traderspost_account_destinations_new SELECT * FROM traderspost_account_destinations;
        DROP TABLE traderspost_account_destinations;
        ALTER TABLE traderspost_account_destinations_new RENAME TO traderspost_account_destinations;
      `);
    }
  }

  private recreateProxyDeliveriesTable(): void {
    this.db.exec(`
      CREATE TABLE proxy_deliveries_repaired (
        id TEXT PRIMARY KEY,
        proxy_alert_id TEXT NOT NULL REFERENCES proxy_alerts(id),
        range_route_id TEXT NOT NULL REFERENCES range_routes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        extension_enabled INTEGER NOT NULL CHECK (extension_enabled IN (0, 1)),
        traderspost_enabled INTEGER NOT NULL CHECK (traderspost_enabled IN (0, 1)),
        draft_id TEXT REFERENCES order_drafts(id) ON DELETE SET NULL,
        qualified_trade_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    this.db.prepare(
      `INSERT INTO proxy_deliveries_repaired (
        id, proxy_alert_id, range_route_id, user_id, account_id, extension_enabled, traderspost_enabled,
        draft_id, qualified_trade_id, status, created_at
      )
      SELECT id, proxy_alert_id, range_route_id, user_id, account_id, extension_enabled, traderspost_enabled,
        draft_id, qualified_trade_id, status, created_at
      FROM proxy_deliveries`,
    ).run();
    this.db.exec('DROP TABLE proxy_deliveries');
    this.db.exec('ALTER TABLE proxy_deliveries_repaired RENAME TO proxy_deliveries');
  }

  private ensureProxyDeliveryRangeRouteReference(): void {
    const foreignKeys = this.db.prepare('PRAGMA foreign_key_list(proxy_deliveries)').all() as unknown as Array<{
      from: string;
      table: string;
    }>;
    const brokenRangeRouteReference = foreignKeys.some((foreignKey) => (
      foreignKey.from === 'range_route_id' && foreignKey.table !== 'range_routes'
    ));
    if (!brokenRangeRouteReference) return;

    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.recreateProxyDeliveriesTable();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private ensureProxyDeliveriesNoUniqueConstraint(): void {
    const indexes = this.db.prepare('PRAGMA index_list(proxy_deliveries)').all() as unknown as Array<{
      name: string;
      unique: number;
      origin: string;
    }>;
    const uniqueConstraintIndex = indexes.find((index) => index.unique === 1 && index.origin === 'u');
    if (!uniqueConstraintIndex) return;
    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.recreateProxyDeliveriesTable();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private migrateTradersPostDestinations(): void {
    const legacyTable = this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'traderspost_destinations'`,
    ).get();
    if (!legacyTable) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        `INSERT INTO traderspost_account_destinations (account_id, webhook_url, updated_at)
         SELECT accounts.id, legacy.webhook_url, legacy.updated_at
         FROM accounts
         JOIN traderspost_destinations AS legacy ON legacy.user_id = accounts.user_id
         WHERE NOT EXISTS (
           SELECT 1
           FROM traderspost_account_destinations AS destination
           WHERE destination.account_id = accounts.id
         )`,
      ).run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private migrateRangeRoutesMultiplicity(): void {
    const table = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'range_routes'`,
    ).get() as { sql: string } | undefined;
    if (!table?.sql || table.sql.includes('UNIQUE(range_name, user_id, account_id)')) return;

    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE range_routes_repaired (
          id TEXT PRIMARY KEY,
          range_name TEXT NOT NULL COLLATE BINARY,
          user_id TEXT NOT NULL REFERENCES users(id),
          account_id TEXT NOT NULL REFERENCES accounts(id),
          extension_enabled INTEGER NOT NULL CHECK (extension_enabled IN (0, 1)),
          traderspost_enabled INTEGER NOT NULL CHECK (traderspost_enabled IN (0, 1)),
          run_scheduled INTEGER NOT NULL DEFAULT 0 CHECK (run_scheduled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(range_name, user_id, account_id)
        ) STRICT;
      `);
      this.db.prepare(
        `INSERT INTO range_routes_repaired (
          id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
         )
         SELECT id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, 0, created_at, updated_at
         FROM range_routes`,
      ).run();
      this.db.exec('DROP TABLE range_routes');
      this.db.exec('ALTER TABLE range_routes_repaired RENAME TO range_routes');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // Pre-shared-model schema had `range_name TEXT PRIMARY KEY` — one model per
  // range. The current table is keyed (range_name, subcategory_name) and
  // carries nullable per-model run-day overrides. Rebuild preserving rows;
  // day columns start NULL meaning "inherit the range's own schedule".
  private migrateRangeSubcategoryAssignments(): void {
    const table = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'range_subcategory_assignments'`,
    ).get() as { sql: string } | undefined;
    if (!table?.sql || table.sql.includes('PRIMARY KEY (range_name, subcategory_name)')) return;

    this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(`
        CREATE TABLE range_subcategory_assignments_repaired (
          range_name TEXT NOT NULL COLLATE BINARY,
          subcategory_name TEXT NOT NULL COLLATE BINARY REFERENCES range_subcategories(name) ON DELETE CASCADE,
          assigned_by_user_id TEXT NOT NULL REFERENCES users(id),
          updated_at TEXT NOT NULL,
          run_monday INTEGER CHECK (run_monday IN (0, 1)),
          run_tuesday INTEGER CHECK (run_tuesday IN (0, 1)),
          run_wednesday INTEGER CHECK (run_wednesday IN (0, 1)),
          run_thursday INTEGER CHECK (run_thursday IN (0, 1)),
          run_friday INTEGER CHECK (run_friday IN (0, 1)),
          run_saturday INTEGER CHECK (run_saturday IN (0, 1)),
          run_sunday INTEGER CHECK (run_sunday IN (0, 1)),
          PRIMARY KEY (range_name, subcategory_name)
        ) STRICT;
      `);
      this.db.prepare(
        `INSERT INTO range_subcategory_assignments_repaired (
          range_name, subcategory_name, assigned_by_user_id, updated_at
         )
         SELECT range_name, subcategory_name, assigned_by_user_id, updated_at
         FROM range_subcategory_assignments`,
      ).run();
      this.db.exec('DROP TABLE range_subcategory_assignments');
      this.db.exec('ALTER TABLE range_subcategory_assignments_repaired RENAME TO range_subcategory_assignments');
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS range_subcategory_assignments_by_subcategory
        ON range_subcategory_assignments (subcategory_name, range_name COLLATE BINARY);
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  private normalizeStoredRangeNames(): void {
    const storedRangeNames = this.listStoredRangeNames();
    const aliases = storedRangeNames
      .map((storedRangeName) => ({
        storedRangeName,
        targetRangeName: this.resolveCanonicalRangeAliasTarget(storedRangeName),
      }))
      .filter((alias): alias is { storedRangeName: string; targetRangeName: string } => (
        Boolean(alias.targetRangeName) && alias.targetRangeName !== alias.storedRangeName
      ));
    const payloadIds = this.listProxyAlertIdsWithUnnormalizedPayloadRangeNames();
    if (aliases.length === 0 && payloadIds.length === 0) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { storedRangeName, targetRangeName } of aliases) {
        this.mergeStoredRangeAlias(storedRangeName, targetRangeName);
      }
      this.normalizeProxyAlertPayloadRangeNames(payloadIds);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private syncExclusionFromRangeReviewFlags(): void {
    const now = new Date().toISOString();
    const flags = this.db.prepare(
      'SELECT range_name, reason, flagged_by_user_id FROM range_review_flags',
    ).all() as unknown as Array<{
      range_name: string
      reason: 'test_data' | 'erroneous'
      flagged_by_user_id: string
    }>;
    for (const { range_name, reason, flagged_by_user_id } of flags) {
      this.db.prepare(
        `UPDATE trade_events
         SET excluded_from_performance = 1,
             exclusion_reason = ?,
             excluded_by_user_id = ?,
             exclusion_updated_at = ?
         WHERE user_id = ?
           AND range_name = ? COLLATE BINARY
           AND (excluded_from_performance = 0 OR exclusion_reason IN ('test_data', 'erroneous'))`,
      ).run(reason, flagged_by_user_id, now, flagged_by_user_id, range_name);
    }
  }

  private mergeStoredRangeAlias(sourceRangeName: string, targetRangeName: string): void {
    if (!sourceRangeName || !targetRangeName || sourceRangeName === targetRangeName) return;

    const now = new Date().toISOString();
    const sourceTradeEvents = this.db.prepare(
      `SELECT id, event_id, account_id, proxy_alert_id, excluded_from_performance, exclusion_reason,
        excluded_by_user_id, exclusion_updated_at
       FROM trade_events
       WHERE range_name = ? COLLATE BINARY
       ORDER BY occurred_at ASC, id ASC`,
    ).all(sourceRangeName) as Array<{
      id: string;
      event_id: string;
      account_id: string;
      proxy_alert_id: string | null;
      excluded_from_performance: number;
      exclusion_reason: string | null;
      excluded_by_user_id: string | null;
      exclusion_updated_at: string | null;
    }>;
    for (const sourceEvent of sourceTradeEvents) {
      const targetEvent = this.db.prepare(
        `SELECT id
         FROM trade_events
         WHERE event_id = ? AND account_id = ? AND range_name = ? COLLATE BINARY
         LIMIT 1`,
      ).get(sourceEvent.event_id, sourceEvent.account_id, targetRangeName) as { id: string } | undefined;
      if (targetEvent && targetEvent.id !== sourceEvent.id) {
        this.db.prepare(
          `UPDATE trade_events
           SET proxy_alert_id = COALESCE(proxy_alert_id, ?),
             excluded_from_performance = CASE WHEN excluded_from_performance = 1 OR ? = 1 THEN 1 ELSE 0 END,
             exclusion_reason = COALESCE(exclusion_reason, ?),
             excluded_by_user_id = COALESCE(excluded_by_user_id, ?),
             exclusion_updated_at = COALESCE(exclusion_updated_at, ?)
           WHERE id = ?`,
        ).run(
          sourceEvent.proxy_alert_id,
          sourceEvent.excluded_from_performance,
          sourceEvent.exclusion_reason,
          sourceEvent.excluded_by_user_id,
          sourceEvent.exclusion_updated_at,
          targetEvent.id,
        );
        this.db.prepare('DELETE FROM trade_events WHERE id = ?').run(sourceEvent.id);
        continue;
      }
      this.db.prepare(
        'UPDATE trade_events SET range_name = ? WHERE id = ?',
      ).run(targetRangeName, sourceEvent.id);
    }

    const sourceRangeTradeEvents = this.db.prepare(
      `SELECT id, event_id, proxy_alert_id
       FROM range_trade_events
       WHERE range_name = ? COLLATE BINARY
       ORDER BY occurred_at ASC, id ASC`,
    ).all(sourceRangeName) as Array<{
      id: string;
      event_id: string;
      proxy_alert_id: string | null;
    }>;
    for (const sourceEvent of sourceRangeTradeEvents) {
      const targetEvent = this.db.prepare(
        `SELECT id
         FROM range_trade_events
         WHERE event_id = ? AND range_name = ? COLLATE BINARY
         LIMIT 1`,
      ).get(sourceEvent.event_id, targetRangeName) as { id: string } | undefined;
      if (targetEvent && targetEvent.id !== sourceEvent.id) {
        this.db.prepare(
          `UPDATE range_trade_events
           SET proxy_alert_id = COALESCE(proxy_alert_id, ?)
           WHERE id = ?`,
        ).run(sourceEvent.proxy_alert_id, targetEvent.id);
        this.db.prepare('DELETE FROM range_trade_events WHERE id = ?').run(sourceEvent.id);
        continue;
      }
      this.db.prepare(
        'UPDATE range_trade_events SET range_name = ? WHERE id = ?',
      ).run(targetRangeName, sourceEvent.id);
    }

    this.db.prepare(
      'UPDATE proxy_alerts SET range_name = ? WHERE range_name = ? COLLATE BINARY',
    ).run(targetRangeName, sourceRangeName);
    this.db.prepare(
      `INSERT INTO range_calendar_visibility (range_name, date_key, hidden_by_user_id, updated_at)
       SELECT ?, date_key, hidden_by_user_id, updated_at
       FROM range_calendar_visibility
       WHERE range_name = ? COLLATE BINARY
       ON CONFLICT(range_name, date_key) DO UPDATE SET
         hidden_by_user_id = excluded.hidden_by_user_id,
         updated_at = excluded.updated_at`,
    ).run(targetRangeName, sourceRangeName);
    this.db.prepare(
      'DELETE FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY',
    ).run(sourceRangeName);

    const sourceRoutes = this.db.prepare(
      `SELECT id, user_id, account_id
       FROM range_routes
       WHERE range_name = ? COLLATE BINARY`,
    ).all(sourceRangeName) as Array<{ id: string; user_id: string; account_id: string }>;
    for (const route of sourceRoutes) {
      const targetRoute = this.db.prepare(
        `SELECT id
         FROM range_routes
         WHERE range_name = ? COLLATE BINARY AND user_id = ? AND account_id = ?`,
      ).get(targetRangeName, route.user_id, route.account_id) as { id: string } | undefined;
      if (targetRoute) {
        this.db.prepare(
          `DELETE FROM proxy_deliveries
           WHERE range_route_id = ?
             AND proxy_alert_id IN (
               SELECT proxy_alert_id
               FROM proxy_deliveries
               WHERE range_route_id = ?
             )`,
        ).run(route.id, targetRoute.id);
        this.db.prepare(
          `UPDATE proxy_deliveries
           SET range_route_id = ?
           WHERE range_route_id = ?`,
        ).run(targetRoute.id, route.id);
        this.db.prepare('DELETE FROM range_routes WHERE id = ?').run(route.id);
        continue;
      }
      this.db.prepare(
        'UPDATE range_routes SET range_name = ?, updated_at = ? WHERE id = ?',
      ).run(targetRangeName, now, route.id);
    }

    const mergeUniqueRangeRecord = (table: 'tracked_ranges' | 'range_configurations' | 'range_review_flags') => {
      const sourceExists = Boolean(this.db.prepare(
        `SELECT 1 FROM ${table} WHERE range_name = ? COLLATE BINARY`,
      ).get(sourceRangeName));
      if (!sourceExists) return;
      const targetExists = Boolean(this.db.prepare(
        `SELECT 1 FROM ${table} WHERE range_name = ? COLLATE BINARY`,
      ).get(targetRangeName));
      if (targetExists) {
        this.db.prepare(`DELETE FROM ${table} WHERE range_name = ? COLLATE BINARY`).run(sourceRangeName);
        return;
      }
      this.db.prepare(
        `UPDATE ${table} SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
      ).run(targetRangeName, sourceRangeName);
    };

    mergeUniqueRangeRecord('tracked_ranges');
    mergeUniqueRangeRecord('range_configurations');
    mergeUniqueRangeRecord('range_review_flags');
    // Assignments are keyed (range_name, subcategory_name) — a source range
    // can hold memberships the target lacks, so merge is a union, not a
    // whole-row move. UPDATE OR IGNORE re-points non-conflicting rows;
    // duplicates (both ranges already in the same model) get deleted.
    this.db.prepare(
      `UPDATE OR IGNORE range_subcategory_assignments SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
    ).run(targetRangeName, sourceRangeName);
    this.db.prepare(
      `DELETE FROM range_subcategory_assignments WHERE range_name = ? COLLATE BINARY`,
    ).run(sourceRangeName);
  }

  private resolveCanonicalRangeAliasTarget(rangeName: string): string | undefined {
    const normalizedRangeName = normalizeRangeName(rangeName);
    if (normalizedRangeName && normalizedRangeName !== rangeName) return normalizedRangeName;
    return this.resolveSingleRStoredRangeAlias(normalizedRangeName);
  }

  private resolveSingleRStoredRangeAlias(rangeName: string): string | undefined {
    const normalizedRangeName = normalizeRangeName(rangeName);
    if (!normalizedRangeName) return undefined;
    const candidates = [...new Set(this.listSelectableRangeNames().map((candidate) => this.resolveRangeName(candidate)))]
      .filter((candidate) => candidate !== normalizedRangeName && isSingleRMissingVariant(normalizedRangeName, candidate));
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private listProxyAlertIdsWithUnnormalizedPayloadRangeNames(): string[] {
    const rows = this.db.prepare(
      `SELECT id, payload_json
       FROM proxy_alerts`,
    ).all() as Array<{ id: string; payload_json: string }>;
    return rows.flatMap((row) => {
      const payload = JSON.parse(row.payload_json) as { extras?: { rangeName?: unknown } };
      const rangeName = typeof payload.extras?.rangeName === 'string' ? payload.extras.rangeName : undefined;
      return rangeName && normalizeRangeName(rangeName) !== rangeName ? [row.id] : [];
    });
  }

  private normalizeProxyAlertPayloadRangeNames(alertIds: string[]): void {
    if (alertIds.length === 0) return;
    const selectAlert = this.db.prepare(
      `SELECT payload_json
       FROM proxy_alerts
       WHERE id = ?`,
    );
    const updateAlert = this.db.prepare(
      `UPDATE proxy_alerts
       SET payload_json = ?
       WHERE id = ?`,
    );
    for (const alertId of alertIds) {
      const row = selectAlert.get(alertId) as { payload_json: string } | undefined;
      if (!row) continue;
      const payload = JSON.parse(row.payload_json) as { extras?: { rangeName?: unknown } };
      if (typeof payload.extras?.rangeName !== 'string') continue;
      const normalizedRangeName = normalizeRangeName(payload.extras.rangeName);
      if (!normalizedRangeName || normalizedRangeName === payload.extras.rangeName) continue;
      updateAlert.run(JSON.stringify({
        ...payload,
        extras: {
          ...payload.extras,
          rangeName: normalizedRangeName,
        },
      }), alertId);
    }
  }

  createUser(email: string): UserCredentials {
    const user: UserCredentials = {
      id: randomUUID(),
      email: email.trim().toLowerCase(),
      webhookSecret: randomBytes(32).toString('base64url'),
      extensionToken: randomBytes(32).toString('base64url'),
    };
    this.db.prepare(
      `INSERT INTO users (id, email, webhook_secret, extension_token, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(user.id, user.email, user.webhookSecret, user.extensionToken, new Date().toISOString());
    return user;
  }

  rotateUserCredentials(id: string): UserCredentials | undefined {
    const credentials = {
      webhookSecret: randomBytes(32).toString('base64url'),
      extensionToken: randomBytes(32).toString('base64url'),
    };
    const result = this.db.prepare(
      `UPDATE users SET webhook_secret = ?, extension_token = ? WHERE id = ?`,
    ).run(credentials.webhookSecret, credentials.extensionToken, id);
    if (result.changes !== 1) return undefined;

    const user = this.db.prepare('SELECT id, email FROM users WHERE id = ?').get(id) as unknown as Pick<UserCredentials, 'id' | 'email'>;
    return { ...user, ...credentials };
  }

  findUserByWebhook(id: string, secret: string): Pick<UserCredentials, 'id' | 'email'> | undefined {
    return this.db.prepare(
      'SELECT id, email FROM users WHERE id = ? AND webhook_secret = ?',
    ).get(id, secret) as Pick<UserCredentials, 'id' | 'email'> | undefined;
  }

  findUserByExtensionToken(token: string): Pick<UserCredentials, 'id' | 'email'> | undefined {
    return this.db.prepare(
      'SELECT id, email FROM users WHERE extension_token = ?',
    ).get(token) as Pick<UserCredentials, 'id' | 'email'> | undefined;
  }

  findOnlyUser(): Pick<UserCredentials, 'id' | 'email'> | undefined {
    const users = this.db.prepare('SELECT id, email FROM users LIMIT 2').all() as unknown as Array<Pick<UserCredentials, 'id' | 'email'>>;
    return users.length === 1 ? users[0] : undefined;
  }

  findUserByEmail(email: string): Pick<UserCredentials, 'id' | 'email'> | undefined {
    return this.db.prepare('SELECT id, email FROM users WHERE email = ?')
      .get(email.trim().toLowerCase()) as Pick<UserCredentials, 'id' | 'email'> | undefined;
  }

  findUserForLogin(email: string): AuthenticatedUser | undefined {
    const row = this.db.prepare(
      `SELECT id, email, password_salt, password_hash
       FROM users WHERE email = ?`,
    ).get(email.trim().toLowerCase()) as
      | { id: string; email: string; password_salt: string | null; password_hash: string | null }
      | undefined;
    return row && {
      id: row.id,
      email: row.email,
      passwordSalt: row.password_salt,
      passwordHash: row.password_hash,
    };
  }

  setUserPassword(id: string, salt: string, hash: string): void {
    this.db.prepare(
      'UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?',
    ).run(salt, hash, id);
  }

  createSession(tokenHash: string, userId: string, csrfToken: string, expiresAt: string): void {
    this.db.prepare(
      `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(tokenHash, userId, csrfToken, expiresAt, new Date().toISOString());
  }

  findSession(tokenHash: string): UserSession | undefined {
    const row = this.db.prepare(
      `SELECT users.id, users.email, sessions.csrf_token
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
    ).get(tokenHash, new Date().toISOString()) as
      | { id: string; email: string; csrf_token: string }
      | undefined;
    return row && { user: { id: row.id, email: row.email }, csrfToken: row.csrf_token };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  findUserById(id: string): Pick<UserCredentials, 'id' | 'email'> | undefined {
    return this.db.prepare('SELECT id, email FROM users WHERE id = ?').get(id) as Pick<UserCredentials, 'id' | 'email'> | undefined;
  }

  getUserExtensionToken(id: string): string | undefined {
    return this.db.prepare('SELECT extension_token FROM users WHERE id = ?').pluck().get(id) as string | undefined;
  }

  listUsers(): Array<Pick<UserCredentials, 'id' | 'email'>> {
    return this.db.prepare('SELECT id, email FROM users ORDER BY created_at ASC').all() as Array<Pick<UserCredentials, 'id' | 'email'>>;
  }

  cloneAccount(userId: string, accountId: string, name: string): BridgeAccount | undefined {
    const source = this.db.prepare(
      'SELECT user_id, name, starting_balance_cents, external_balance_cents, external_balance_at FROM accounts WHERE id = ? AND user_id = ?',
    ).get(accountId, userId) as unknown as { user_id: string; name: string; starting_balance_cents: number; external_balance_cents: number | null; external_balance_at: string | null } | undefined;
    if (!source) return undefined;
    const account: BridgeAccount = {
      id: randomUUID(),
      userId,
      name,
      startingBalanceCents: source.starting_balance_cents,
      externalBalanceCents: source.external_balance_cents ?? undefined,
      externalBalanceAt: source.external_balance_at ?? undefined,
      deprecated: false,
      createdAt: new Date().toISOString(),
    };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        `INSERT INTO accounts (id, user_id, name, starting_balance_cents, external_balance_cents, external_balance_at, deprecated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(account.id, userId, name, account.startingBalanceCents, account.externalBalanceCents ?? null, account.externalBalanceAt ?? null, account.createdAt);
      // Copy the destination via the normal upsert — webhook URL, CT secret,
      // EOD windows, quantity override, every flag the current schema knows.
      // Secrets stay server-side; they never round-trip through the client.
      const sourceDestination = this.getTradersPostAccountDestination(accountId);
      if (sourceDestination) {
        this.upsertTradersPostAccountDestination(
          userId,
          account.id,
          sourceDestination.webhookUrl,
          sourceDestination.outboundTicker,
          sourceDestination.outboundTickerMode,
          sourceDestination.enabled,
          sourceDestination.useLimitPriceTP,
          sourceDestination.useAlertTP,
          sourceDestination.eodCancelTime,
          sourceDestination.eodExitTime,
          sourceDestination.eodEnabled,
          sourceDestination.newsFlattenEnabled,
          sourceDestination.newsFlattenMinutes,
          sourceDestination.reapplyOnTradeCloseEnabled,
          sourceDestination.crossTradeWebhookUrl
            ? {
                webhookUrl: sourceDestination.crossTradeWebhookUrl,
                secretKey: sourceDestination.crossTradeSecretKey,
                accountName: sourceDestination.crossTradeAccountName,
                enabled: sourceDestination.crossTradeEnabled,
              }
            : undefined,
          sourceDestination.quantityOverrideMode && sourceDestination.quantityOverrideValue != null
            ? { mode: sourceDestination.quantityOverrideMode, value: sourceDestination.quantityOverrideValue }
            : undefined,
        );
      }
      // Same route subscriptions — the clone starts wired like the source.
      this.db.prepare(
        `INSERT INTO range_routes (id, user_id, account_id, range_name, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at)
         SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))), user_id, ?, range_name, extension_enabled, traderspost_enabled, run_scheduled, ?, ?
         FROM range_routes WHERE account_id = ?`,
      ).run(account.id, account.createdAt, account.createdAt, accountId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.invalidateUserCache(userId);
    return account;
  }

  createAccount(input: Omit<BridgeAccount, 'id' | 'createdAt' | 'deprecated'> & { deprecated?: boolean }): BridgeAccount {
    const account: BridgeAccount = {
      ...input,
      deprecated: input.deprecated ?? false,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO accounts (
        id, user_id, name, starting_balance_cents, external_balance_cents, external_balance_at, deprecated, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      account.id,
      account.userId,
      account.name,
      account.startingBalanceCents,
      account.externalBalanceCents ?? null,
      account.externalBalanceAt ?? null,
      Number(account.deprecated),
      account.createdAt,
    );
    this.invalidateUserCache(input.userId);
    return account;
  }

  hasAccountName(userId: string, name: string, excludeAccountId?: string): boolean {
    const row = this.db.prepare(
      `SELECT 1
       FROM accounts
       WHERE user_id = ?
         AND lower(name) = lower(?)
         AND (? IS NULL OR id != ?)
       LIMIT 1`,
    ).get(userId, name, excludeAccountId ?? null, excludeAccountId ?? null) as { 1: number } | undefined;
    return Boolean(row);
  }

  updateAccountStartingBalance(userId: string, accountId: string, startingBalanceCents: number): BridgeAccount | undefined {
    const result = this.db.prepare(
      `UPDATE accounts
       SET starting_balance_cents = ?
       WHERE id = ? AND user_id = ?`,
    ).run(startingBalanceCents, accountId, userId);
    if (result.changes) this.invalidateUserCache(userId);
    return result.changes ? this.findAccountById(accountId) : undefined;
  }

  deleteAccount(userId: string, accountId: string): {
    deletedAccountId: string;
    deletedAccountName: string;
    deletedRoutes: number;
    deletedDeliveries: number;
    deletedTradeEvents: number;
    deletedDrafts: number;
  } | undefined {
    const account = this.db.prepare(
      `SELECT id, user_id, name, starting_balance_cents, external_balance_cents, external_balance_at, created_at
       FROM accounts
       WHERE id = ? AND user_id = ?`,
    ).get(accountId, userId) as unknown as AccountRow | undefined;
    if (!account) return undefined;

    const draftIds = this.db.prepare(
      `SELECT DISTINCT draft_id
       FROM proxy_deliveries
       WHERE account_id = ? AND user_id = ? AND draft_id IS NOT NULL`,
    ).all(accountId, userId) as Array<{ draft_id: string }>;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const deletedDeliveries = Number(this.db.prepare(
        'DELETE FROM proxy_deliveries WHERE account_id = ? AND user_id = ?',
      ).run(accountId, userId).changes);
      const deletedRoutes = Number(this.db.prepare(
        'DELETE FROM range_routes WHERE account_id = ? AND user_id = ?',
      ).run(accountId, userId).changes);
      const deletedTradeEvents = Number(this.db.prepare(
        'DELETE FROM trade_events WHERE account_id = ? AND user_id = ?',
      ).run(accountId, userId).changes);
      this.db.prepare('DELETE FROM traderspost_account_destinations WHERE account_id = ?').run(accountId);
      const deletedAccount = this.db.prepare(
        'DELETE FROM accounts WHERE id = ? AND user_id = ?',
      ).run(accountId, userId);
      if (deletedAccount.changes !== 1) {
        this.db.exec('ROLLBACK');
        return undefined;
      }

      let deletedDrafts = 0;
      for (const draft of draftIds) {
        const stillReferenced = Boolean(this.db.prepare(
          'SELECT 1 FROM proxy_deliveries WHERE draft_id = ? LIMIT 1',
        ).get(draft.draft_id));
        if (stillReferenced) continue;
        deletedDrafts += Number(this.db.prepare(
          'DELETE FROM order_drafts WHERE id = ? AND user_id = ?',
        ).run(draft.draft_id, userId).changes);
      }

      this.db.exec('COMMIT');
      this.invalidateUserCache(userId);
      return {
        deletedAccountId: account.id,
        deletedAccountName: account.name,
        deletedRoutes,
        deletedDeliveries,
        deletedTradeEvents,
        deletedDrafts,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listAccounts(userId: string): BridgeAccount[] {
    const rows = this.db.prepare(
      `SELECT id, user_id, name, starting_balance_cents, external_balance_cents, external_balance_at, deprecated, created_at
       FROM accounts WHERE user_id = ? ORDER BY created_at ASC`,
    ).all(userId) as unknown as AccountRow[];
    return rows.map((row) => this.toAccount(row));
  }

  findAccountById(id: string): BridgeAccount | undefined {
    const row = this.db.prepare(
      `SELECT id, user_id, name, starting_balance_cents, external_balance_cents, external_balance_at, deprecated, created_at
       FROM accounts WHERE id = ?`,
    ).get(id) as unknown as AccountRow | undefined;
    return row && this.toAccount(row);
  }

  setAccountDeprecated(userId: string, accountId: string, deprecated: boolean): BridgeAccount | undefined {
    if (!deprecated) {
      const result = this.db.prepare(
        `UPDATE accounts
         SET deprecated = 0
         WHERE id = ? AND user_id = ?`,
      ).run(accountId, userId);
      if (result.changes === 0) return undefined;
      this.invalidateUserCache(userId);
      return this.findAccountById(accountId);
    }
    const account = this.db.prepare(
      'SELECT id FROM accounts WHERE id = ? AND user_id = ?',
    ).get(accountId, userId) as { id: string } | undefined;
    if (!account) return undefined;
    // Deprecation disables rather than deletes: proxy_deliveries are the audit trail
    // and are referenced by broker_orders, and routes/destination are referenced by
    // deliveries — deleting them violates FK constraints and loses the configuration
    // needed to reactivate the account later.
    const transaction = this.db.transaction((id: string, uid: string) => {
      this.db.prepare(
        'UPDATE range_routes SET traderspost_enabled = 0, extension_enabled = 0, run_scheduled = 0 WHERE account_id = ? AND user_id = ?',
      ).run(id, uid);
      this.db.prepare(
        'UPDATE traderspost_account_destinations SET enabled = 0 WHERE account_id = ?',
      ).run(id);
      const result = this.db.prepare(
        `UPDATE accounts
         SET deprecated = 1
         WHERE id = ? AND user_id = ?`,
      ).run(id, uid);
      return result.changes === 1;
    });
    const ok = transaction(accountId, userId);
    if (!ok) return undefined;
    this.invalidateUserCache(userId);
    return this.findAccountById(accountId);
  }

  upsertRangeRoute(input: Omit<RangeRoute, 'id' | 'createdAt' | 'updatedAt'>): RangeRoute | undefined {
    const account = this.db.prepare(
      'SELECT id, deprecated FROM accounts WHERE id = ? AND user_id = ?',
    ).get(input.accountId, input.userId) as { id: string; deprecated: number } | undefined;
    if (!account || account.deprecated) return undefined;

    const resolvedRangeName = this.resolveRangeName(input.rangeName);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO range_routes (
        id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(range_name, user_id, account_id) DO UPDATE SET
         extension_enabled = excluded.extension_enabled,
         traderspost_enabled = excluded.traderspost_enabled,
         run_scheduled = excluded.run_scheduled,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      resolvedRangeName,
      input.userId,
      input.accountId,
      Number(input.extensionEnabled),
      Number(input.traderspostEnabled),
      Number(input.runScheduled ?? false),
      now,
      now,
    );
    const row = this.db.prepare(
      `SELECT id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
       FROM range_routes WHERE range_name = ? COLLATE BINARY AND user_id = ? AND account_id = ?`,
    ).get(resolvedRangeName, input.userId, input.accountId) as unknown as RangeRouteRow;
    return this.toRangeRoute(row);
  }

  listRangeRoutes(userId: string): RangeRoute[] {
    const rows = this.db.prepare(
      `SELECT id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
       FROM range_routes WHERE user_id = ? ORDER BY range_name COLLATE BINARY ASC, created_at ASC, account_id ASC`,
    ).all(userId) as unknown as RangeRouteRow[];
    return rows.map((row) => this.toRangeRoute(row));
  }

  listRangeRoutesForUserRange(userId: string, rangeName: string): RangeRoute[] {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
       FROM range_routes
       WHERE user_id = ? AND range_name = ? COLLATE BINARY
       ORDER BY created_at ASC, account_id ASC`,
    ).all(userId, resolvedRangeName) as unknown as RangeRouteRow[];
    return rows.map((row) => this.toRangeRoute(row));
  }

  syncRangeRoutes(
    userId: string,
    rangeName: string,
    routes: Array<Pick<RangeRoute, 'accountId' | 'extensionEnabled' | 'traderspostEnabled' | 'runScheduled'>>,
  ): RangeRoute[] | undefined {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    const dedupedRoutes = [...new Map(routes.map((route) => [route.accountId, route])).values()];
    for (const route of dedupedRoutes) {
      const account = this.findAccountById(route.accountId);
      if (!account || account.userId !== userId) return undefined;
    }
    // Deprecated accounts' routes are inert — deprecation zeroes their flags
    // but keeps the rows (deliveries FK-reference them). A stale submission
    // carrying one must not fail the whole save.
    const activeRoutes = dedupedRoutes.filter(
      (route) => !this.findAccountById(route.accountId)?.deprecated,
    );

    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existingRoutes = this.listRangeRoutesForUserRange(userId, resolvedRangeName);
      const existingByAccountId = new Map(existingRoutes.map((route) => [route.accountId, route]));
      const nextAccountIds = new Set(activeRoutes.map((route) => route.accountId));
      const removedRouteDraftIds = new Set<string>();

      for (const route of activeRoutes) {
        const existing = existingByAccountId.get(route.accountId);
        if (existing) {
          this.db.prepare(
            `UPDATE range_routes
             SET extension_enabled = ?, traderspost_enabled = ?, run_scheduled = ?, updated_at = ?
             WHERE id = ?`,
          ).run(Number(route.extensionEnabled), Number(route.traderspostEnabled), Number(route.runScheduled), now, existing.id);
          continue;
        }
        this.db.prepare(
          `INSERT INTO range_routes (
            id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          resolvedRangeName,
          userId,
          route.accountId,
          Number(route.extensionEnabled),
          Number(route.traderspostEnabled),
          Number(route.runScheduled),
          now,
          now,
        );
      }

      for (const existing of existingRoutes) {
        if (nextAccountIds.has(existing.accountId)) continue;
        const account = this.findAccountById(existing.accountId);
        if (account?.deprecated) continue;
        const draftIds = this.db.prepare(
          `SELECT DISTINCT draft_id
           FROM proxy_deliveries
           WHERE range_route_id = ? AND draft_id IS NOT NULL`,
        ).all(existing.id) as Array<{ draft_id: string }>;
        for (const draft of draftIds) removedRouteDraftIds.add(draft.draft_id);
        // broker_orders.proxy_delivery_id has no ON DELETE action — detach
        // the ledger rows before removing the deliveries (same as
        // deleteRangeRoutesForAccountTx).
        this.db.prepare(
          'UPDATE broker_orders SET proxy_delivery_id = NULL WHERE proxy_delivery_id IN (SELECT id FROM proxy_deliveries WHERE range_route_id = ?)',
        ).run(existing.id);
        this.db.prepare('DELETE FROM proxy_deliveries WHERE range_route_id = ?').run(existing.id);
        this.db.prepare('DELETE FROM range_routes WHERE id = ?').run(existing.id);
      }

      for (const draftId of removedRouteDraftIds) {
        const stillReferenced = Boolean(this.db.prepare(
          'SELECT 1 FROM proxy_deliveries WHERE draft_id = ? LIMIT 1',
        ).get(draftId));
        if (stillReferenced) continue;
        this.db.prepare(
          'DELETE FROM order_drafts WHERE id = ? AND user_id = ?',
        ).run(draftId, userId);
      }

      this.db.exec('COMMIT');
      return this.listRangeRoutesForUserRange(userId, resolvedRangeName);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private deleteRangeRoutesForAccountTx(userId: string, accountId: string): number {
    const routeRows = this.db.prepare(
      'SELECT id FROM range_routes WHERE user_id = ? AND account_id = ?',
    ).all(userId, accountId) as Array<{ id: string }>;
    if (routeRows.length === 0) return 0;

    const routeIds = routeRows.map((row) => row.id);
    const placeholders = routeIds.map(() => '?').join(',');

    const draftRows = this.db.prepare(
      `SELECT DISTINCT draft_id FROM proxy_deliveries WHERE range_route_id IN (${placeholders}) AND draft_id IS NOT NULL`,
    ).all(...routeIds) as Array<{ draft_id: string }>;
    const removedDraftIds = new Set(draftRows.map((row) => row.draft_id));

    // broker_orders.proxy_delivery_id has no ON DELETE action — detach the
    // ledger rows before removing the deliveries so the dispatch audit survives.
    this.db.prepare(
      `UPDATE broker_orders SET proxy_delivery_id = NULL
       WHERE proxy_delivery_id IN (SELECT id FROM proxy_deliveries WHERE range_route_id IN (${placeholders}))`,
    ).run(...routeIds);
    this.db.prepare(
      `DELETE FROM proxy_deliveries WHERE range_route_id IN (${placeholders})`,
    ).run(...routeIds);
    this.db.prepare(
      `DELETE FROM range_routes WHERE id IN (${placeholders})`,
    ).run(...routeIds);

    for (const draftId of removedDraftIds) {
      const stillReferenced = Boolean(this.db.prepare(
        'SELECT 1 FROM proxy_deliveries WHERE draft_id = ? LIMIT 1',
      ).get(draftId));
      if (stillReferenced) continue;
      this.db.prepare('DELETE FROM order_drafts WHERE id = ? AND user_id = ?').run(draftId, userId);
    }
    return routeIds.length;
  }

  removeAllRangeRoutesForAccount(userId: string, accountId: string): number {
    const account = this.findAccountById(accountId);
    if (!account || account.userId !== userId || account.deprecated) return 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.deleteRangeRoutesForAccountTx(userId, accountId);
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Replace the target account's subscriptions with a copy of the source's —
  // target routes are cleared (with their pending deliveries) before the copy.
  copyRangeRoutes(userId: string, fromAccountId: string, toAccountId: string): { copied: number; removed: number } | undefined {
    if (fromAccountId === toAccountId) return undefined;
    const from = this.findAccountById(fromAccountId);
    const to = this.findAccountById(toAccountId);
    if (!from || from.userId !== userId || from.deprecated) return undefined;
    if (!to || to.userId !== userId || to.deprecated) return undefined;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = this.deleteRangeRoutesForAccountTx(userId, toAccountId);
      const sourceRows = this.db.prepare(
        `SELECT range_name, extension_enabled, traderspost_enabled, run_scheduled
         FROM range_routes WHERE user_id = ? AND account_id = ?`,
      ).all(userId, fromAccountId) as Array<{
        range_name: string;
        extension_enabled: number;
        traderspost_enabled: number;
        run_scheduled: number;
      }>;
      const now = new Date().toISOString();
      const insert = this.db.prepare(
        `INSERT INTO range_routes (
          id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of sourceRows) {
        insert.run(
          randomUUID(), row.range_name, userId, toAccountId,
          row.extension_enabled, row.traderspost_enabled, row.run_scheduled, now, now,
        );
      }
      this.db.exec('COMMIT');
      return { copied: sourceRows.length, removed };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  userHasRangeRoute(userId: string, rangeName: string): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    return Boolean(this.db.prepare(
      'SELECT 1 FROM range_routes WHERE user_id = ? AND range_name = ? COLLATE BINARY',
    ).get(userId, resolvedRangeName));
  }

  listTrackedRangeNames(): string[] {
    const rows = this.db.prepare(
      `SELECT range_name FROM range_routes
       UNION
       SELECT range_name FROM tracked_ranges
       UNION
       SELECT range_name FROM range_configurations
       UNION
       SELECT range_name FROM range_review_flags
       UNION
        SELECT range_name FROM range_trade_events
        ORDER BY range_name COLLATE BINARY ASC`,
    ).all() as Array<{ range_name: string }>;
    return rows.map((row) => row.range_name);
  }

  listSelectableRangeNames(): string[] {
    const rows = this.db.prepare(
      `SELECT range_name FROM range_routes
       UNION
       SELECT range_name FROM tracked_ranges
       UNION
       SELECT range_name FROM range_configurations
       UNION
       SELECT range_name FROM range_review_flags
       UNION
       SELECT range_name FROM range_subcategory_assignments
       ORDER BY range_name COLLATE BINARY ASC`,
    ).all() as Array<{ range_name: string }>;
    return rows.map((row) => row.range_name);
  }

  listRangeConfigurations(): RangeConfiguration[] {
    const rows = this.db.prepare(
      `SELECT range_name, instrument, description, risk_dollars_cents, range_window, trading_session, take_profit_style, take_profit_ticks_cents,
        stop_loss_style, stop_loss_ticks_cents, break_even_enabled, break_even_trigger_ticks_cents,
         break_even_offset_ticks_cents, oco_mode, stop_only_entries, run_monday, run_tuesday, run_wednesday,
        run_thursday, run_friday, run_saturday, run_sunday, entries_per_range, created_at, updated_at
        FROM range_configurations
       ORDER BY range_name COLLATE BINARY ASC`,
    ).all() as unknown as RangeConfigurationRow[];
    return rows.map((row) => this.toRangeConfiguration(row));
  }

  getRangeConfiguration(rangeName: string): RangeConfiguration | undefined {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const row = this.db.prepare(
      `SELECT range_name, instrument, description, risk_dollars_cents, range_window, trading_session, take_profit_style, take_profit_ticks_cents,
         stop_loss_style, stop_loss_ticks_cents, break_even_enabled, break_even_trigger_ticks_cents,
         break_even_offset_ticks_cents, oco_mode, stop_only_entries, run_monday, run_tuesday, run_wednesday,
         run_thursday, run_friday, run_saturday, run_sunday, entries_per_range, created_at, updated_at
         FROM range_configurations
        WHERE range_name = ? COLLATE BINARY`,
    ).get(resolvedRangeName) as unknown as RangeConfigurationRow | undefined;
    return row && this.toRangeConfiguration(row);
  }

  upsertRangeConfiguration(input: Omit<RangeConfiguration, 'createdAt' | 'updatedAt'>): RangeConfiguration | undefined {
    const resolvedRangeName = this.resolveStoredRangeName(input.rangeName) ?? this.resolveRangeName(input.rangeName);
    if (!this.rangeExists(resolvedRangeName)) return undefined;
    const existing = this.getRangeConfiguration(resolvedRangeName);
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO range_configurations (
        range_name, instrument, description, risk_dollars_cents, range_window, trading_session, take_profit_style, take_profit_ticks_cents,
        stop_loss_style, stop_loss_ticks_cents, break_even_enabled, break_even_trigger_ticks_cents, break_even_offset_ticks_cents, oco_mode, stop_only_entries,
        run_monday, run_tuesday, run_wednesday,
        run_thursday, run_friday, run_saturday, run_sunday, entries_per_range, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(range_name) DO UPDATE SET
        instrument = excluded.instrument,
        description = excluded.description,
        risk_dollars_cents = excluded.risk_dollars_cents,
        range_window = excluded.range_window,
        trading_session = excluded.trading_session,
        take_profit_style = excluded.take_profit_style,
        take_profit_ticks_cents = excluded.take_profit_ticks_cents,
        stop_loss_style = excluded.stop_loss_style,
        stop_loss_ticks_cents = excluded.stop_loss_ticks_cents,
        break_even_enabled = excluded.break_even_enabled,
        break_even_trigger_ticks_cents = excluded.break_even_trigger_ticks_cents,
        break_even_offset_ticks_cents = excluded.break_even_offset_ticks_cents,
        oco_mode = excluded.oco_mode,
        stop_only_entries = excluded.stop_only_entries,
        run_monday = excluded.run_monday,
        run_tuesday = excluded.run_tuesday,
        run_wednesday = excluded.run_wednesday,
        run_thursday = excluded.run_thursday,
        run_friday = excluded.run_friday,
        run_saturday = excluded.run_saturday,
        run_sunday = excluded.run_sunday,
        entries_per_range = excluded.entries_per_range,
        updated_at = excluded.updated_at`,
    ).run(
      resolvedRangeName,
      input.instrument,
      input.description,
      input.riskDollarsCents,
      input.rangeWindow,
      input.tradingSession,
      input.takeProfitStyle,
      input.takeProfitTicksCents,
      input.stopLossStyle,
      input.stopLossTicksCents,
      Number(input.breakEvenEnabled),
      input.breakEvenTriggerTicksCents,
      input.breakEvenOffsetTicksCents,
      input.ocoMode,
      input.stopOnlyEntries ? 1 : 0,
      Number(input.runMonday),
      Number(input.runTuesday),
      Number(input.runWednesday),
      Number(input.runThursday),
      Number(input.runFriday),
      Number(input.runSaturday),
      Number(input.runSunday),
      input.entriesPerRange,
      existing?.createdAt ?? now,
      now,
    );
    this.syncRangeCalendarVisibilityWithSchedules([resolvedRangeName]);
    return this.getRangeConfiguration(resolvedRangeName);
  }

  createTrackedRange(rangeName: string, createdByUserId: string): string | undefined {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    if (!resolvedRangeName) return undefined;
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR IGNORE INTO tracked_ranges (range_name, created_by_user_id, created_at)
       VALUES (?, ?, ?)`,
    ).run(resolvedRangeName, createdByUserId, now);
    return this.resolveStoredRangeName(resolvedRangeName) ?? resolvedRangeName;
  }

  upsertRangeReviewFlag(rangeName: string, flaggedByUserId: string, reason: 'test_data' | 'erroneous' = 'erroneous'): boolean {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    if (!this.rangeExists(resolvedRangeName)) return false;
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      'SELECT created_at FROM range_review_flags WHERE range_name = ? COLLATE BINARY',
    ).get(resolvedRangeName) as { created_at: string } | undefined;
    this.db.prepare(
      `INSERT INTO range_review_flags (range_name, reason, flagged_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(range_name) DO UPDATE SET
         reason = excluded.reason,
         flagged_by_user_id = excluded.flagged_by_user_id,
         updated_at = excluded.updated_at`,
    ).run(resolvedRangeName, reason, flaggedByUserId, existing?.created_at ?? now, now);
    this.db.prepare(
      `UPDATE trade_events
       SET excluded_from_performance = 1,
           exclusion_reason = ?,
           excluded_by_user_id = ?,
           exclusion_updated_at = ?
       WHERE user_id = ?
         AND range_name = ? COLLATE BINARY
         AND (excluded_from_performance = 0 OR exclusion_reason IN ('test_data', 'erroneous'))`,
    ).run(reason, flaggedByUserId, now, flaggedByUserId, resolvedRangeName);
    this.invalidateUserCache(flaggedByUserId);
    return true;
  }

  clearRangeReviewFlag(rangeName: string, userId: string): void {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE trade_events
       SET excluded_from_performance = 0,
           exclusion_reason = NULL,
           excluded_by_user_id = NULL,
           exclusion_updated_at = ?
       WHERE user_id = ?
         AND range_name = ? COLLATE BINARY
         AND excluded_from_performance = 1
         AND exclusion_reason IN ('test_data', 'erroneous')`,
    ).run(now, userId, resolvedRangeName);
    this.db.prepare('DELETE FROM range_review_flags WHERE range_name = ? COLLATE BINARY').run(resolvedRangeName);
    this.invalidateUserCache(userId);
  }

  isRangeReviewFlagged(rangeName: string): boolean {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    return Boolean(this.db.prepare(
      'SELECT 1 FROM range_review_flags WHERE range_name = ? COLLATE BINARY',
    ).get(resolvedRangeName));
  }

  getRangeReviewFlag(rangeName: string): {
    rangeName: string;
    reason: string;
    flaggedByUserId: string;
    flaggedByEmail: string;
    createdAt: string;
    updatedAt: string;
  } | undefined {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const row = this.db.prepare(
      `SELECT range_review_flags.range_name, range_review_flags.reason, range_review_flags.flagged_by_user_id,
       users.email AS flagged_by_email, range_review_flags.created_at, range_review_flags.updated_at
       FROM range_review_flags
       JOIN users ON users.id = range_review_flags.flagged_by_user_id
       WHERE range_review_flags.range_name = ? COLLATE BINARY`,
    ).get(resolvedRangeName) as {
      range_name: string;
      reason: string;
      flagged_by_user_id: string;
      flagged_by_email: string;
      created_at: string;
      updated_at: string;
    } | undefined;
    return row
      ? {
          rangeName: row.range_name,
          reason: row.reason,
          flaggedByUserId: row.flagged_by_user_id,
          flaggedByEmail: row.flagged_by_email,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  listRangeReviewFlags(): Array<{
    rangeName: string;
    reason: string;
    flaggedByUserId: string;
    flaggedByEmail: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.db.prepare(
      `SELECT range_review_flags.range_name, range_review_flags.reason, range_review_flags.flagged_by_user_id,
       users.email AS flagged_by_email, range_review_flags.created_at, range_review_flags.updated_at
       FROM range_review_flags
       JOIN users ON users.id = range_review_flags.flagged_by_user_id
       ORDER BY range_review_flags.updated_at DESC, range_review_flags.range_name COLLATE BINARY ASC`,
    ).all() as Array<{
      range_name: string;
      reason: string;
      flagged_by_user_id: string;
      flagged_by_email: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      rangeName: row.range_name,
      reason: row.reason,
      flaggedByUserId: row.flagged_by_user_id,
      flaggedByEmail: row.flagged_by_email,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  listRangeSubcategories(): RangeSubcategory[] {
    const rows = this.db.prepare(
      `SELECT range_subcategories.name, range_subcategories.created_by_user_id, users.email AS created_by_email,
        range_subcategories.created_at, range_subcategories.color
       FROM range_subcategories
       JOIN users ON users.id = range_subcategories.created_by_user_id
       ORDER BY range_subcategories.name COLLATE BINARY ASC`,
    ).all() as unknown as RangeSubcategoryRow[];
    return rows.map((row) => ({
      name: row.name,
      createdByUserId: row.created_by_user_id,
      createdByEmail: row.created_by_email,
      createdAt: row.created_at,
      color: row.color,
    }));
  }

  updateRangeSubcategoryColor(name: string, color: string | null): boolean {
    const normalized = normalizeSubcategoryName(name);
    if (!normalized) return false;
    const result = this.db.prepare(
      'UPDATE range_subcategories SET color = ? WHERE name = ? COLLATE BINARY',
    ).run(color, normalized);
    return result.changes > 0;
  }

  createRangeSubcategory(name: string, createdByUserId: string): RangeSubcategory | undefined {
    const normalizedName = normalizeSubcategoryName(name);
    if (!normalizedName) return undefined;
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO range_subcategories (name, created_by_user_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
    ).run(normalizedName, createdByUserId, now);
    return this.listRangeSubcategories().find((subcategory) => subcategory.name === normalizedName);
  }

  renameRangeSubcategory(currentName: string, nextName: string): boolean {
    const normalizedCurrentName = normalizeSubcategoryName(currentName);
    const normalizedNextName = normalizeSubcategoryName(nextName);
    if (!normalizedCurrentName || !normalizedNextName || normalizedCurrentName === normalizedNextName) return false;
    const currentExists = Boolean(this.db.prepare(
      'SELECT 1 FROM range_subcategories WHERE name = ? COLLATE BINARY',
    ).get(normalizedCurrentName));
    if (!currentExists) return false;
    const nextExists = Boolean(this.db.prepare(
      'SELECT 1 FROM range_subcategories WHERE name = ? COLLATE BINARY',
    ).get(normalizedNextName));
    if (nextExists) return false;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentRow = this.db.prepare(
        `SELECT created_by_user_id, created_at, color
         FROM range_subcategories
         WHERE name = ? COLLATE BINARY`,
      ).get(normalizedCurrentName) as { created_by_user_id: string; created_at: string; color: string | null } | undefined;
      if (!currentRow) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare(
        `INSERT INTO range_subcategories (name, created_by_user_id, created_at, color)
         VALUES (?, ?, ?, ?)`,
      ).run(normalizedNextName, currentRow.created_by_user_id, currentRow.created_at, currentRow.color);
      this.db.prepare(
        `UPDATE range_subcategory_assignments
         SET subcategory_name = ?
         WHERE subcategory_name = ? COLLATE BINARY`,
      ).run(normalizedNextName, normalizedCurrentName);
      this.db.prepare(
        `DELETE FROM range_subcategories
         WHERE name = ? COLLATE BINARY`,
      ).run(normalizedCurrentName);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteRangeSubcategory(name: string): { deletedSubcategoryName: string; unassignedRangeCount: number } | undefined {
    const normalizedName = normalizeSubcategoryName(name);
    if (!normalizedName) return undefined;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS assignment_count
       FROM range_subcategory_assignments
       WHERE subcategory_name = ? COLLATE BINARY`,
    ).get(normalizedName) as { assignment_count: number };
    const result = this.db.prepare(
      'DELETE FROM range_subcategories WHERE name = ? COLLATE BINARY',
    ).run(normalizedName);
    if (result.changes !== 1) return undefined;
    return {
      deletedSubcategoryName: normalizedName,
      unassignedRangeCount: row.assignment_count,
    };
  }

  listRangeSubcategoryAssignments(): RangeSubcategoryAssignment[] {
    const rows = this.db.prepare(
      `SELECT range_name, subcategory_name, assigned_by_user_id, updated_at,
              run_monday, run_tuesday, run_wednesday, run_thursday, run_friday, run_saturday, run_sunday
       FROM range_subcategory_assignments
       ORDER BY range_name COLLATE BINARY ASC`,
    ).all() as unknown as RangeSubcategoryAssignmentRow[];
    return rows.map((row) => this.toRangeSubcategoryAssignment(row));
  }

  private toRangeSubcategoryAssignment(row: RangeSubcategoryAssignmentRow): RangeSubcategoryAssignment {
    return {
      rangeName: row.range_name,
      subcategoryName: row.subcategory_name,
      assignedByUserId: row.assigned_by_user_id,
      updatedAt: row.updated_at,
      runMonday: row.run_monday == null ? null : Boolean(row.run_monday),
      runTuesday: row.run_tuesday == null ? null : Boolean(row.run_tuesday),
      runWednesday: row.run_wednesday == null ? null : Boolean(row.run_wednesday),
      runThursday: row.run_thursday == null ? null : Boolean(row.run_thursday),
      runFriday: row.run_friday == null ? null : Boolean(row.run_friday),
      runSaturday: row.run_saturday == null ? null : Boolean(row.run_saturday),
      runSunday: row.run_sunday == null ? null : Boolean(row.run_sunday),
    };
  }

  setSubcategoryRunDays(subcategoryName: string, enabled: boolean, userId: string): { updated: number; rangeNames: string[] } {
    const isUncategorized = !subcategoryName || subcategoryName === 'Uncategorized';
    const normalized = isUncategorized ? null : normalizeSubcategoryName(subcategoryName);
    if (!isUncategorized && !normalized) return { updated: 0, rangeNames: [] };

    let rangeNames: string[];
    if (normalized) {
      const rows = this.db.prepare(
        'SELECT range_name FROM range_subcategory_assignments WHERE subcategory_name = ? COLLATE BINARY',
      ).all(normalized) as Array<{ range_name: string }>;
      rangeNames = rows.map((row) => row.range_name);
    } else {
      const all = this.listTrackedRangeNames();
      const assigned = this.db
        .prepare('SELECT range_name FROM range_subcategory_assignments')
        .all() as Array<{ range_name: string }>;
      const assignedSet = new Set(assigned.map((row) => row.range_name));
      rangeNames = all.filter((name) => !assignedSet.has(name));
    }

    if (rangeNames.length === 0) return { updated: 0, rangeNames: [] };
    const placeholders = rangeNames.map(() => '?').join(',');
    const run = enabled ? 1 : 0;
    const now = new Date().toISOString();
    // Enabling maps to the futures week (Sun 18:00 ET → Fri ~17:00): Saturday
    // stays off except for crypto futures, which trade through the weekend.
    const result = this.db.prepare(
      `UPDATE range_configurations
       SET run_monday = ?, run_tuesday = ?, run_wednesday = ?, run_thursday = ?, run_friday = ?,
           run_saturday = CASE WHEN ? = 0 THEN 0
             WHEN substr(UPPER(COALESCE(instrument, '')), 1, 3) IN ('BTC', 'MBT', 'ETH', 'MET', 'SOL', 'XRP') THEN 1
             ELSE 0 END,
           run_sunday = ?, updated_at = ?
       WHERE range_name IN (${placeholders})`,
    ).run(run, run, run, run, run, run, run, now, ...rangeNames);
    this.syncRangeCalendarVisibilityWithSchedules(rangeNames, userId);
    return { updated: result.changes, rangeNames };
  }

  // Model-level bulk day control: sets every member range's per-model run-day
  // flags to `enabled` (overrides — no inherit). Per-account routing through
  // the model then follows these flags, leaving each range's own schedule
  // untouched.
  setSubcategoryMemberRunDays(subcategoryName: string, enabled: boolean): { updated: number; rangeNames: string[] } {
    const normalized = normalizeSubcategoryName(subcategoryName);
    if (!normalized || !this.subcategoryExists(normalized)) return { updated: 0, rangeNames: [] };
    const run = enabled ? 1 : 0;
    // Enabling maps to the futures week (Sun 18:00 ET → Fri ~17:00): Saturday
    // stays off except for crypto futures, which trade through the weekend.
    const result = this.db.prepare(
      `UPDATE range_subcategory_assignments
       SET run_monday = ?, run_tuesday = ?, run_wednesday = ?, run_thursday = ?,
           run_friday = ?,
           run_saturday = CASE WHEN ? = 0 THEN 0
             WHEN EXISTS (
               SELECT 1 FROM range_configurations cfg
               WHERE cfg.range_name = range_subcategory_assignments.range_name COLLATE BINARY
                 AND substr(UPPER(COALESCE(cfg.instrument, '')), 1, 3) IN ('BTC', 'MBT', 'ETH', 'MET', 'SOL', 'XRP')
             ) THEN 1
             ELSE 0 END,
           run_sunday = ?, updated_at = ?
       WHERE subcategory_name = ? COLLATE BINARY`,
    ).run(run, run, run, run, run, run, run, new Date().toISOString(), normalized);
    const rangeNames = this.listSubcategoryRangeNames(normalized);
    return { updated: result.changes, rangeNames };
  }

  private subcategoryExists(normalizedSubcategoryName: string): boolean {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM range_subcategories WHERE name = ? COLLATE BINARY',
    ).get(normalizedSubcategoryName));
  }

  private insertRangeSubcategoryAssignment(resolvedRangeName: string, normalizedSubcategoryName: string, assignedByUserId: string): void {
    this.db.prepare(
      `INSERT INTO range_subcategory_assignments (range_name, subcategory_name, assigned_by_user_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(range_name, subcategory_name) DO UPDATE SET
         assigned_by_user_id = excluded.assigned_by_user_id`,
    ).run(resolvedRangeName, normalizedSubcategoryName, assignedByUserId, new Date().toISOString());
  }

  // Replaces the range's whole model membership with a single model (or none).
  // The legacy form endpoint's semantics — a range lived in exactly one model.
  assignRangeSubcategory(rangeName: string, subcategoryName: string | undefined, assignedByUserId: string): boolean {
    return this.setRangeSubcategoryAssignments(rangeName, subcategoryName ? [subcategoryName] : [], assignedByUserId);
  }

  // Syncs the range's model membership to exactly `subcategoryNames`. Rows for
  // memberships being kept are left untouched — their per-model run-day
  // schedules survive. Returns false if the range or any model is missing.
  setRangeSubcategoryAssignments(rangeName: string, subcategoryNames: string[], assignedByUserId: string): boolean {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    if (!this.rangeExists(resolvedRangeName)) return false;
    const normalized = [...new Set(
      subcategoryNames.map((name) => normalizeSubcategoryName(name)).filter((name): name is string => Boolean(name)),
    )];
    if (normalized.some((name) => !this.subcategoryExists(name))) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (normalized.length === 0) {
        this.db.prepare('DELETE FROM range_subcategory_assignments WHERE range_name = ? COLLATE BINARY').run(resolvedRangeName);
      } else {
        const placeholders = normalized.map(() => '?').join(',');
        this.db.prepare(
          `DELETE FROM range_subcategory_assignments
           WHERE range_name = ? COLLATE BINARY AND subcategory_name NOT IN (${placeholders})`,
        ).run(resolvedRangeName, ...normalized);
        for (const name of normalized) {
          // Propagate routes to the model's existing subscribers when this is
          // a NEW membership (the row did not survive the sync above).
          const alreadyMember = Boolean(this.db.prepare(
            'SELECT 1 FROM range_subcategory_assignments WHERE range_name = ? COLLATE BINARY AND subcategory_name = ? COLLATE BINARY',
          ).get(resolvedRangeName, name));
          const membersBefore = alreadyMember
            ? null
            : this.listSubcategoryRangeNames(name).filter((member) => member !== resolvedRangeName);
          this.insertRangeSubcategoryAssignment(resolvedRangeName, name, assignedByUserId);
          if (membersBefore) {
            this.propagateRangeRouteToModelSubscribers(resolvedRangeName, membersBefore);
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return true;
  }

  // Adds (or keeps) a single model membership — the multi-model variant of
  // assignRangeSubcategory; existing memberships and their day schedules are
  // preserved. Accounts already subscribed to the model (routed to every
  // pre-existing member) get a route to the new member too, copying their
  // route flags from a sibling membership — otherwise adding a range to a
  // model would silently drop those accounts out of "subscribed".
  addRangeSubcategoryAssignment(rangeName: string, subcategoryName: string, assignedByUserId: string): boolean {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    if (!this.rangeExists(resolvedRangeName)) return false;
    const normalized = normalizeSubcategoryName(subcategoryName);
    if (!normalized || !this.subcategoryExists(normalized)) return false;
    // Already a member: nothing to insert or propagate — re-running it would
    // re-upsert routes and clobber customized flags.
    const alreadyMember = Boolean(this.db.prepare(
      'SELECT 1 FROM range_subcategory_assignments WHERE range_name = ? COLLATE BINARY AND subcategory_name = ? COLLATE BINARY',
    ).get(resolvedRangeName, normalized));
    if (alreadyMember) return true;
    const membersBefore = this.listSubcategoryRangeNames(normalized)
      .filter((name) => name !== resolvedRangeName);
    this.insertRangeSubcategoryAssignment(resolvedRangeName, normalized, assignedByUserId);
    this.propagateRangeRouteToModelSubscribers(resolvedRangeName, membersBefore);
    return true;
  }

  // Gives every account routed to ALL of `otherMembers` a route to
  // `rangeName`, cloning its flags from one of its sibling routes. No-op when
  // the model had no prior members (nothing to subscribe through).
  private propagateRangeRouteToModelSubscribers(rangeName: string, otherMembers: string[]): void {
    if (otherMembers.length === 0) return;
    const placeholders = otherMembers.map(() => '?').join(',');
    // Flags aggregate conservatively: a delivery channel propagates only when
    // it was enabled on EVERY sibling route. run_scheduled has inverted
    // safety semantics — false bypasses the weekday gate — so it takes MAX:
    // if any sibling is schedule-gated, the propagated route stays gated.
    const rows = this.db.prepare(
      `SELECT user_id, account_id,
              MIN(extension_enabled) AS extension_enabled,
              MIN(traderspost_enabled) AS traderspost_enabled,
              MAX(run_scheduled) AS run_scheduled
       FROM range_routes
       WHERE range_name IN (${placeholders})
       GROUP BY user_id, account_id
       HAVING COUNT(DISTINCT range_name) = ?`,
    ).all(...otherMembers, otherMembers.length) as Array<{
      user_id: string;
      account_id: string;
      extension_enabled: number;
      traderspost_enabled: number;
      run_scheduled: number;
    }>;
    // Only create MISSING routes. An existing direct route to the new member
    // keeps its own flags — upserting sibling-derived values onto it could
    // silently enable a delivery channel the operator had turned off.
    const hasRoute = this.db.prepare(
      'SELECT 1 FROM range_routes WHERE user_id = ? AND account_id = ? AND range_name = ? COLLATE BINARY',
    );
    for (const row of rows) {
      if (hasRoute.get(row.user_id, row.account_id, rangeName)) continue;
      this.upsertRangeRoute({
        userId: row.user_id,
        accountId: row.account_id,
        rangeName,
        extensionEnabled: Boolean(row.extension_enabled),
        traderspostEnabled: Boolean(row.traderspost_enabled),
        runScheduled: Boolean(row.run_scheduled),
      });
    }
  }

  removeRangeSubcategoryAssignment(rangeName: string, subcategoryName: string): boolean {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const normalized = normalizeSubcategoryName(subcategoryName);
    if (!normalized) return false;
    this.db.prepare(
      'DELETE FROM range_subcategory_assignments WHERE range_name = ? COLLATE BINARY AND subcategory_name = ? COLLATE BINARY',
    ).run(resolvedRangeName, normalized);
    return true;
  }

  // Per-model run-day schedule for one range: each flag is true/false to
  // override the range's own run day for that model, or null to inherit.
  // Only provided keys are updated.
  setRangeSubcategorySchedule(
    rangeName: string,
    subcategoryName: string,
    days: Partial<Record<'runMonday' | 'runTuesday' | 'runWednesday' | 'runThursday' | 'runFriday' | 'runSaturday' | 'runSunday', boolean | null>>,
  ): RangeSubcategoryAssignment | undefined {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const normalized = normalizeSubcategoryName(subcategoryName);
    if (!normalized) return undefined;
    const columnFor: Record<string, string> = {
      runMonday: 'run_monday', runTuesday: 'run_tuesday', runWednesday: 'run_wednesday',
      runThursday: 'run_thursday', runFriday: 'run_friday', runSaturday: 'run_saturday', runSunday: 'run_sunday',
    };
    const sets: string[] = [];
    const params: Array<number | null> = [];
    for (const [key, column] of Object.entries(columnFor)) {
      if (!(key in days)) continue;
      sets.push(`${column} = ?`);
      const value = days[key as keyof typeof days];
      params.push(value == null ? null : value ? 1 : 0);
    }
    if (sets.length === 0) {
      const existing = this.db.prepare(
        `SELECT range_name, subcategory_name, assigned_by_user_id, updated_at,
                run_monday, run_tuesday, run_wednesday, run_thursday, run_friday, run_saturday, run_sunday
         FROM range_subcategory_assignments
         WHERE range_name = ? COLLATE BINARY AND subcategory_name = ? COLLATE BINARY`,
      ).get(resolvedRangeName, normalized) as RangeSubcategoryAssignmentRow | undefined;
      return existing ? this.toRangeSubcategoryAssignment(existing) : undefined;
    }
    const result = this.db.prepare(
      `UPDATE range_subcategory_assignments SET ${sets.join(', ')}, updated_at = ?
       WHERE range_name = ? COLLATE BINARY AND subcategory_name = ? COLLATE BINARY`,
    ).run(...params, new Date().toISOString(), resolvedRangeName, normalized);
    if (result.changes === 0) return undefined;
    const row = this.db.prepare(
      `SELECT range_name, subcategory_name, assigned_by_user_id, updated_at,
              run_monday, run_tuesday, run_wednesday, run_thursday, run_friday, run_saturday, run_sunday
       FROM range_subcategory_assignments
       WHERE range_name = ? COLLATE BINARY AND subcategory_name = ? COLLATE BINARY`,
    ).get(resolvedRangeName, normalized) as RangeSubcategoryAssignmentRow;
    return this.toRangeSubcategoryAssignment(row);
  }

  // The ranges that make up a model — the membership test for "is this
  // account subscribed to the model" is having a route to every one of these.
  listSubcategoryRangeNames(subcategoryName: string): string[] {
    const rows = this.db.prepare(
      `SELECT range_name FROM range_subcategory_assignments
       WHERE subcategory_name = ? COLLATE BINARY ORDER BY range_name COLLATE BINARY`,
    ).all(subcategoryName) as Array<{ range_name: string }>;
    return rows.map((row) => row.range_name);
  }

  // Same feed for a single range — summed across every account's closed events.
  listRangeDailyPnl(rangeName: string, sinceIso: string, untilIso: string): Array<{ occurredAt: string; realizedDollarsCents: number }> {
    const resolved = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    if (!resolved) return [];
    const rows = this.db.prepare(
      `SELECT occurred_at, realized_dollars_cents
       FROM trade_events
       WHERE event_type = 'trade_closed'
         AND excluded_from_performance = 0
         AND realized_dollars_cents IS NOT NULL
         AND occurred_at >= ?
         AND occurred_at <= ?
         AND range_name = ? COLLATE BINARY
       ORDER BY occurred_at ASC`,
    ).all(sinceIso, untilIso, resolved) as Array<{ occurred_at: string; realized_dollars_cents: number }>;
    return rows.map((row) => ({ occurredAt: row.occurred_at, realizedDollarsCents: row.realized_dollars_cents }));
  }

  // Daily realized dollars for every range in a model, summed across all
  // account-level trade events — the model's equity feed for charting.
  // Caller buckets occurredAt into journal days.
  listSubcategoryDailyPnl(subcategoryName: string, sinceIso: string, untilIso: string): Array<{ occurredAt: string; realizedDollarsCents: number }> {
    const rows = this.db.prepare(
      `SELECT te.occurred_at, te.realized_dollars_cents
       FROM trade_events te
       WHERE te.event_type = 'trade_closed'
         AND te.excluded_from_performance = 0
         AND te.realized_dollars_cents IS NOT NULL
         AND te.occurred_at >= ?
         AND te.occurred_at <= ?
         AND te.range_name IN (
           SELECT range_name FROM range_subcategory_assignments
           WHERE subcategory_name = ? COLLATE BINARY
         )
       ORDER BY te.occurred_at ASC`,
    ).all(sinceIso, untilIso, normalizeSubcategoryName(subcategoryName)) as Array<{ occurred_at: string; realized_dollars_cents: number }>;
    return rows.map((row) => ({ occurredAt: row.occurred_at, realizedDollarsCents: row.realized_dollars_cents }));
  }

  private rangeDayFlag(
    flags: { runMonday?: boolean | null; runTuesday?: boolean | null; runWednesday?: boolean | null; runThursday?: boolean | null; runFriday?: boolean | null; runSaturday?: boolean | null; runSunday?: boolean | null },
    weekday: number,
  ): boolean | null {
    switch (weekday) {
      case 0: return flags.runSunday ?? null;
      case 1: return flags.runMonday ?? null;
      case 2: return flags.runTuesday ?? null;
      case 3: return flags.runWednesday ?? null;
      case 4: return flags.runThursday ?? null;
      case 5: return flags.runFriday ?? null;
      case 6: return flags.runSaturday ?? null;
      default: return null;
    }
  }

  // Model-aware run-day gate for one account's route to a range.
  //
  // "Subscribed to a model" means the account has routes to EVERY range in the
  // model (the same inference the modelName subscription display uses). When
  // the account is subscribed through ≥1 model containing this range, the
  // effective day check is the union of those models' per-range schedules —
  // each NULL flag inherits the range's own run_* day. Accounts only reaching
  // the range directly keep the range's own schedule.
  routeRunsOnWeekday(
    route: { userId: string; accountId: string; rangeName: string },
    configuration: Pick<RangeConfiguration, 'runMonday' | 'runTuesday' | 'runWednesday' | 'runThursday' | 'runFriday' | 'runSaturday' | 'runSunday'> | undefined,
    weekday: number,
  ): boolean {
    const rangeFlag = configuration ? Boolean(this.rangeDayFlag(configuration, weekday)) : false;
    const rangeAssignments = this.listRangeSubcategoryAssignments()
      .filter((a) => a.rangeName === route.rangeName);
    if (rangeAssignments.length === 0) return rangeFlag;
    const routedRanges = new Set(
      (this.db.prepare(
        'SELECT range_name FROM range_routes WHERE user_id = ? AND account_id = ?',
      ).all(route.userId, route.accountId) as Array<{ range_name: string }>)
        .map((row) => row.range_name),
    );
    const modelsAllowed: boolean[] = [];
    for (const assignment of rangeAssignments) {
      const memberRanges = this.listSubcategoryRangeNames(assignment.subcategoryName);
      if (memberRanges.length === 0 || !memberRanges.every((name) => routedRanges.has(name))) continue;
      const modelFlag = this.rangeDayFlag(assignment, weekday);
      modelsAllowed.push(modelFlag === null ? rangeFlag : modelFlag);
    }
    if (modelsAllowed.length === 0) return rangeFlag;
    return modelsAllowed.some(Boolean);
  }

  listUntrackedAlertRanges(): Array<{
    rangeName: string;
    totalAlerts: number;
    lifecycleAlerts: number;
    latestReceivedAt: string;
    latestTicker: string;
  }> {
    const rows = this.db.prepare(
      `SELECT range_name, received_at, ticker, payload_json
       FROM proxy_alerts
       WHERE range_name IS NOT NULL
       ORDER BY received_at DESC, id DESC`,
    ).all() as Array<{
      range_name: string;
      received_at: string;
      ticker: string;
      payload_json: string;
    }>;
    const grouped = new Map<string, {
      rangeName: string;
      totalAlerts: number;
      lifecycleAlerts: number;
      latestReceivedAt: string;
      latestTicker: string;
    }>();
    for (const row of rows) {
      if (this.isRangeExplicitlyTracked(row.range_name)) continue;
      const existing = grouped.get(row.range_name);
      const payload = safeParseProxyAlertPayload(row.payload_json);
      if (existing) {
        existing.totalAlerts += 1;
        if (payload && isLifecyclePayload(payload)) existing.lifecycleAlerts += 1;
        continue;
      }
      grouped.set(row.range_name, {
        rangeName: row.range_name,
        totalAlerts: 1,
        lifecycleAlerts: payload && isLifecyclePayload(payload) ? 1 : 0,
        latestReceivedAt: row.received_at,
        latestTicker: row.ticker,
      });
    }
    return [...grouped.values()];
  }

  moveRangeHistory(sourceRangeName: string, targetRangeName: string): {
    sourceRangeName: string;
    targetRangeName: string;
    movedTradeEvents: number;
    movedRangeTradeEvents: number;
    movedAlerts: number;
    movedRoutes: number;
  } | undefined {
    const resolvedTargetRangeName = this.resolveStoredRangeName(targetRangeName) ?? this.resolveRangeName(targetRangeName);
    if (normalizeRangeDisplayName(sourceRangeName) === normalizeRangeDisplayName(targetRangeName)) return undefined;
    const resolvedSourceRangeNames = this.resolveStoredRangeAliases(sourceRangeName)
      .filter((name) => name !== resolvedTargetRangeName);
    if (resolvedSourceRangeNames.length === 0) return undefined;

    const affectedUserIds = new Set<string>();
    for (const resolvedSourceRangeName of resolvedSourceRangeNames) {
      const rows = this.db.prepare(
        'SELECT DISTINCT user_id FROM trade_events WHERE range_name = ? COLLATE BINARY',
      ).all(resolvedSourceRangeName) as Array<{ user_id: string }>;
      for (const { user_id } of rows) affectedUserIds.add(user_id);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      let movedTradeEvents = 0;
      let movedRangeTradeEvents = 0;
      let movedAlerts = 0;
      let movedRoutes = 0;

      for (const resolvedSourceRangeName of resolvedSourceRangeNames) {
        movedTradeEvents += Number(this.db.prepare(
          'UPDATE trade_events SET range_name = ? WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedTargetRangeName, resolvedSourceRangeName).changes);
        movedRangeTradeEvents += Number(this.db.prepare(
          'UPDATE range_trade_events SET range_name = ? WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedTargetRangeName, resolvedSourceRangeName).changes);
        const sourceAlerts = this.db.prepare(
          `SELECT id, payload_json
           FROM proxy_alerts
           WHERE range_name = ? COLLATE BINARY`,
        ).all(resolvedSourceRangeName) as Array<{ id: string; payload_json: string }>;
        for (const alert of sourceAlerts) {
          movedAlerts += Number(this.db.prepare(
            `UPDATE proxy_alerts
             SET range_name = ?, payload_json = ?
             WHERE id = ?`,
          ).run(
            resolvedTargetRangeName,
            rewriteProxyAlertPayloadRangeName(alert.payload_json, resolvedTargetRangeName),
            alert.id,
          ).changes);
        }
        const sourcePreciseTakeProfitIntents = this.db.prepare(
          `SELECT account_id, bracket_id, instrument, side, action, payload_json, created_at, updated_at
           FROM precise_take_profit_intents
           WHERE range_name = ? COLLATE BINARY
           ORDER BY created_at, account_id, bracket_id`,
        ).all(resolvedSourceRangeName) as Array<Omit<PreciseTakeProfitIntentRow, 'range_name'>>;
        for (const intent of sourcePreciseTakeProfitIntents) {
          this.db.prepare(
            `INSERT INTO precise_take_profit_intents (
               account_id, range_name, bracket_id, instrument, side, action, payload_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, range_name, bracket_id, side) DO NOTHING`,
          ).run(
            intent.account_id,
            resolvedTargetRangeName,
            intent.bracket_id,
            intent.instrument,
            intent.side,
            intent.action,
            rewriteProxyAlertPayloadRangeName(intent.payload_json, resolvedTargetRangeName),
            intent.created_at,
            intent.updated_at,
          );
        }
        this.db.prepare(
          'DELETE FROM precise_take_profit_intents WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedSourceRangeName);

        const sourceRoutes = this.db.prepare(
          `SELECT id, user_id, account_id
           FROM range_routes
           WHERE range_name = ? COLLATE BINARY`,
        ).all(resolvedSourceRangeName) as Array<{ id: string; user_id: string; account_id: string }>;
        for (const route of sourceRoutes) {
          const targetRoute = this.db.prepare(
            `SELECT id
             FROM range_routes
             WHERE range_name = ? COLLATE BINARY AND user_id = ? AND account_id = ?`,
          ).get(resolvedTargetRangeName, route.user_id, route.account_id) as { id: string } | undefined;
          if (targetRoute) {
            this.db.prepare(
              `DELETE FROM proxy_deliveries
               WHERE range_route_id = ?
                 AND proxy_alert_id IN (
                   SELECT proxy_alert_id
                   FROM proxy_deliveries
                   WHERE range_route_id = ?
                 )`,
            ).run(route.id, targetRoute.id);
            this.db.prepare(
              `UPDATE proxy_deliveries
               SET range_route_id = ?
               WHERE range_route_id = ?`,
            ).run(targetRoute.id, route.id);
            this.db.prepare('DELETE FROM range_routes WHERE id = ?').run(route.id);
            continue;
          }
          movedRoutes += Number(this.db.prepare(
            'UPDATE range_routes SET range_name = ?, updated_at = ? WHERE id = ?',
          ).run(resolvedTargetRangeName, new Date().toISOString(), route.id).changes);
        }
        this.db.prepare(
          `INSERT INTO range_calendar_visibility (range_name, date_key, hidden_by_user_id, updated_at)
           SELECT ?, date_key, hidden_by_user_id, updated_at
           FROM range_calendar_visibility
           WHERE range_name = ? COLLATE BINARY
           ON CONFLICT(range_name, date_key) DO UPDATE SET
             hidden_by_user_id = excluded.hidden_by_user_id,
             updated_at = excluded.updated_at`,
        ).run(resolvedTargetRangeName, resolvedSourceRangeName);
        this.db.prepare(
          'DELETE FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedSourceRangeName);

        const moveUniqueRangeRecord = (table: 'tracked_ranges' | 'range_configurations' | 'range_review_flags' | 'range_subcategory_assignments') => {
          const sourceExists = Boolean(this.db.prepare(
            `SELECT 1 FROM ${table} WHERE range_name = ? COLLATE BINARY`,
          ).get(resolvedSourceRangeName));
          if (!sourceExists) return;
          const targetExists = Boolean(this.db.prepare(
            `SELECT 1 FROM ${table} WHERE range_name = ? COLLATE BINARY`,
          ).get(resolvedTargetRangeName));
          if (targetExists) {
            this.db.prepare(`DELETE FROM ${table} WHERE range_name = ? COLLATE BINARY`).run(resolvedSourceRangeName);
            return;
          }
          this.db.prepare(
            `UPDATE ${table} SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
          ).run(resolvedTargetRangeName, resolvedSourceRangeName);
        };

        moveUniqueRangeRecord('tracked_ranges');
        moveUniqueRangeRecord('range_configurations');
        moveUniqueRangeRecord('range_review_flags');
        moveUniqueRangeRecord('range_subcategory_assignments');
      }

      this.db.exec('COMMIT');
      for (const userId of affectedUserIds) this.invalidateUserCache(userId);
      return {
        sourceRangeName: sourceRangeName.trim(),
        targetRangeName: resolvedTargetRangeName,
        movedTradeEvents,
        movedRangeTradeEvents,
        movedAlerts,
        movedRoutes,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listProxyAlertsForReprocess(rangeName?: string, limit = 10000, trackedOnly = false): Array<{
    alertId: string;
    receivedAt: string;
    rangeName?: string;
    action: 'buy' | 'sell' | 'cancel' | 'exit';
    ticker: string;
    payloadJson: string;
    sourceReference?: string;
  }> {
    if (rangeName) {
      const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
      const rows = this.db.prepare(
        `SELECT id, received_at, range_name, action, ticker, payload_json, source_reference
         FROM proxy_alerts
         WHERE range_name = ? COLLATE BINARY
         ORDER BY received_at ASC, id ASC
         LIMIT ?`,
      ).all(resolvedRangeName, limit) as Array<{
        id: string;
        received_at: string;
        range_name: string | null;
        action: 'buy' | 'sell' | 'cancel' | 'exit';
        ticker: string;
        payload_json: string;
        source_reference: string | null;
      }>;
      return rows.map((row) => ({
        alertId: row.id,
        receivedAt: row.received_at,
        ...(row.range_name ? { rangeName: row.range_name } : {}),
        action: row.action,
        ticker: row.ticker,
        payloadJson: row.payload_json,
        ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
      }));
    }
    const whereClause = trackedOnly
      ? `range_name IN (SELECT range_name FROM tracked_ranges)`
      : `range_name IS NOT NULL`;
    const rows = this.db.prepare(
      `SELECT id, received_at, range_name, action, ticker, payload_json, source_reference
       FROM proxy_alerts
       WHERE ${whereClause}
       ORDER BY received_at ASC, id ASC
       LIMIT ?`,
    ).all(limit) as Array<{
      id: string;
      received_at: string;
      range_name: string | null;
      action: 'buy' | 'sell' | 'cancel' | 'exit';
      ticker: string;
      payload_json: string;
      source_reference: string | null;
    }>;
    return rows.map((row) => ({
      alertId: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      action: row.action,
      ticker: row.ticker,
      payloadJson: row.payload_json,
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
    }));
  }

  listProxyAlertsByRange(rangeName: string): Array<{
    alertId: string;
    receivedAt: string;
    rangeName?: string;
    action: 'buy' | 'sell' | 'cancel' | 'exit';
    ticker: string;
    payloadJson: string;
    sourceReference?: string;
  }> {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT id, received_at, range_name, action, ticker, payload_json, source_reference
       FROM proxy_alerts
       WHERE range_name = ? COLLATE BINARY
       ORDER BY received_at ASC, id ASC`,
    ).all(resolvedRangeName) as Array<{
      id: string;
      received_at: string;
      range_name: string | null;
      action: 'buy' | 'sell' | 'cancel' | 'exit';
      ticker: string;
      payload_json: string;
      source_reference: string | null;
    }>;
    return rows.map((row) => ({
      alertId: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      action: row.action,
      ticker: row.ticker,
      payloadJson: row.payload_json,
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
    }));
  }

  setRangeCalendarDayHidden(rangeName: string, dateKey: string, hidden: boolean, userId: string): boolean {
    const resolvedRangeName = this.resolveTrackedRangeName(rangeName);
    if (!resolvedRangeName || !isDateKey(dateKey)) return false;
    if (hidden) {
      const result = this.db.prepare(
        `INSERT INTO range_calendar_visibility (range_name, date_key, hidden_by_user_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(range_name, date_key) DO UPDATE SET
           hidden_by_user_id = excluded.hidden_by_user_id,
           updated_at = excluded.updated_at`,
      ).run(resolvedRangeName, dateKey, userId, new Date().toISOString());
      return result.changes > 0;
    }
    const result = this.db.prepare(
      'DELETE FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY AND date_key = ?',
    ).run(resolvedRangeName, dateKey);
    return result.changes > 0;
  }

  reconcileRangeCalendarVisibility(
    rangeName: string,
    userId: string,
    configuration: RangeConfiguration,
  ): void {
    const resolvedRangeName =
      this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    if (!resolvedRangeName) return;

    const runConfig = {
      run_monday: configuration.runMonday ? 1 : 0,
      run_tuesday: configuration.runTuesday ? 1 : 0,
      run_wednesday: configuration.runWednesday ? 1 : 0,
      run_thursday: configuration.runThursday ? 1 : 0,
      run_friday: configuration.runFriday ? 1 : 0,
      run_saturday: configuration.runSaturday ? 1 : 0,
      run_sunday: configuration.runSunday ? 1 : 0,
    };

    const now = new Date().toISOString();
    const base = new Date();
    const insertHidden = this.db.prepare(
      `INSERT INTO range_calendar_visibility (range_name, date_key, hidden_by_user_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(range_name, date_key) DO UPDATE SET
         hidden_by_user_id = excluded.hidden_by_user_id,
         updated_at = excluded.updated_at`,
    );
    const deleteHidden = this.db.prepare(
      'DELETE FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY AND date_key = ?',
    );

    for (let offset = 0; offset < 62; offset++) {
      const date = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
      const dateKey = fixedOffsetDateKey(date, JOURNAL_TIME_OFFSET_MINUTES);
      if (!isDateKey(dateKey)) continue;
      const runs = rangeRunsOnDate(runConfig, dateKey);
      if (runs) {
        deleteHidden.run(resolvedRangeName, dateKey);
      } else {
        insertHidden.run(resolvedRangeName, dateKey, userId, now);
      }
    }
    this.invalidateUserCache(userId);
  }

  deleteRange(rangeName: string): { deletedRangeName: string; deletedDrafts: number; deletedAlerts: number; deletedDeliveries: number; deletedRoutes: number; deletedTradeEvents: number; deletedRangeTradeEvents: number } | undefined {
    const resolvedRangeNames = this.resolveStoredRangeAliases(rangeName);
    if (resolvedRangeNames.length === 0) return undefined;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const draftIds = new Set<string>();
      let deletedAlerts = 0;
      let deletedDeliveries = 0;
      let deletedRoutes = 0;
      let deletedRangeTradeEvents = 0;

      for (const resolvedRangeName of resolvedRangeNames) {
        // Collect drafts from the same set of deliveries we're about to
        // delete — alert-keyed OR route-keyed — so no draft is orphaned by
        // deliveries whose alert carries a different/NULL range_name.
        const currentDraftIds = this.db.prepare(
          `SELECT DISTINCT proxy_deliveries.draft_id
           FROM proxy_deliveries
           WHERE proxy_deliveries.draft_id IS NOT NULL
             AND (
               proxy_deliveries.proxy_alert_id IN (
                 SELECT id FROM proxy_alerts WHERE range_name = ? COLLATE BINARY
               )
               OR proxy_deliveries.range_route_id IN (
                 SELECT id FROM range_routes WHERE range_name = ? COLLATE BINARY
               )
             )`,
        ).all(resolvedRangeName, resolvedRangeName) as Array<{ draft_id: string }>;
        currentDraftIds.forEach((draft) => draftIds.add(draft.draft_id));
      }

      for (const resolvedRangeName of resolvedRangeNames) {
        this.db.prepare(
          'UPDATE trade_events SET proxy_alert_id = NULL WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedRangeName);
      }

      for (const resolvedRangeName of resolvedRangeNames) {
        deletedRangeTradeEvents += Number(this.db.prepare(
          'DELETE FROM range_trade_events WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedRangeName).changes);
        this.db.prepare(
          'DELETE FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedRangeName);
      }

      // broker_orders reference proxy_deliveries/proxy_alerts with NO ACTION
      // FKs. Rows OWNED by this range are deleted outright; rows belonging to
      // other ranges keep their audit record — just null the now-dangling
      // delivery/alert links before those records are removed.
      for (const resolvedRangeName of resolvedRangeNames) {
        this.db.prepare(
          'DELETE FROM broker_orders WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedRangeName);
        this.db.prepare(
          `UPDATE broker_orders SET proxy_delivery_id = NULL
           WHERE proxy_delivery_id IN (
             SELECT id FROM proxy_deliveries
             WHERE proxy_alert_id IN (
               SELECT id FROM proxy_alerts WHERE range_name = ? COLLATE BINARY
             )
             OR range_route_id IN (
               SELECT id FROM range_routes WHERE range_name = ? COLLATE BINARY
             )
           )`,
        ).run(resolvedRangeName, resolvedRangeName);
        this.db.prepare(
          `UPDATE broker_orders SET proxy_alert_id = NULL
           WHERE proxy_alert_id IN (
             SELECT id FROM proxy_alerts WHERE range_name = ? COLLATE BINARY
           )`,
        ).run(resolvedRangeName);
      }

      // Deliveries keyed to this range's routes as well as its alerts —
      // an alert row can carry a NULL/stale range_name while its deliveries
      // still hang off the range's route rows.
      for (const resolvedRangeName of resolvedRangeNames) {
        deletedDeliveries += Number(this.db.prepare(
          `DELETE FROM proxy_deliveries
           WHERE proxy_alert_id IN (
             SELECT id FROM proxy_alerts WHERE range_name = ? COLLATE BINARY
           )
           OR range_route_id IN (
             SELECT id FROM range_routes WHERE range_name = ? COLLATE BINARY
           )`,
        ).run(resolvedRangeName, resolvedRangeName).changes);
      }

      // Other ranges' journal rows may reference this range's alerts — null
      // the link rather than delete their history.
      for (const resolvedRangeName of resolvedRangeNames) {
        this.db.prepare(
          `UPDATE trade_events SET proxy_alert_id = NULL
           WHERE proxy_alert_id IN (
             SELECT id FROM proxy_alerts WHERE range_name = ? COLLATE BINARY
           )`,
        ).run(resolvedRangeName);
        this.db.prepare(
          `UPDATE range_trade_events SET proxy_alert_id = NULL
           WHERE proxy_alert_id IN (
             SELECT id FROM proxy_alerts WHERE range_name = ? COLLATE BINARY
           )`,
        ).run(resolvedRangeName);
      }

      for (const resolvedRangeName of resolvedRangeNames) {
        deletedAlerts += Number(this.db.prepare(
          'DELETE FROM proxy_alerts WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedRangeName).changes);
      }

      for (const resolvedRangeName of resolvedRangeNames) {
        this.db.prepare('DELETE FROM range_subcategory_assignments WHERE range_name = ? COLLATE BINARY').run(resolvedRangeName);
        this.db.prepare('DELETE FROM range_review_flags WHERE range_name = ? COLLATE BINARY').run(resolvedRangeName);
        this.db.prepare('DELETE FROM range_configurations WHERE range_name = ? COLLATE BINARY').run(resolvedRangeName);
        this.db.prepare('DELETE FROM tracked_ranges WHERE range_name = ? COLLATE BINARY').run(resolvedRangeName);
        deletedRoutes += Number(this.db.prepare(
          'DELETE FROM range_routes WHERE range_name = ? COLLATE BINARY',
        ).run(resolvedRangeName).changes);
      }

      let deletedDrafts = 0;
      for (const draftId of draftIds) {
        deletedDrafts += Number(this.db.prepare('DELETE FROM order_drafts WHERE id = ?').run(draftId).changes);
      }

      this.db.exec('COMMIT');
      return {
        deletedRangeName: rangeName.trim(),
        deletedDrafts,
        deletedAlerts,
        deletedDeliveries,
        deletedRoutes,
        deletedTradeEvents: 0,
        deletedRangeTradeEvents,
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listSharedRangeEnrollments(): Array<{ rangeName: string; users: Array<Pick<UserCredentials, 'id' | 'email'>> }> {
    const rows = this.db.prepare(
      `SELECT range_routes.range_name, users.id AS user_id, users.email
       FROM range_routes
       JOIN users ON users.id = range_routes.user_id
       ORDER BY range_routes.range_name COLLATE BINARY ASC, users.email COLLATE NOCASE ASC`,
    ).all() as Array<{ range_name: string; user_id: string; email: string }>;
    const enrollments = new Map<string, Array<Pick<UserCredentials, 'id' | 'email'>>>();
    for (const row of rows) {
      const users = enrollments.get(row.range_name) ?? [];
      if (users.some((user) => user.id === row.user_id)) continue;
      users.push({ id: row.user_id, email: row.email });
      enrollments.set(row.range_name, users);
    }
    return [...enrollments.entries()].map(([rangeName, users]) => ({ rangeName, users }));
  }

  listSharedRangeDetails(now = new Date()): Array<{
    rangeName: string;
    createdBy?: Pick<UserCredentials, 'id' | 'email'>;
    createdAt: string;
    allTime: JournalMetrics;
    currentMonth: JournalMetrics;
    currentWeek: JournalMetrics;
    currentDay: JournalMetrics;
    performanceAllTime: JournalMetrics;
    performanceCurrentMonth: JournalMetrics;
    performanceCurrentWeek: JournalMetrics;
    performanceCurrentDay: JournalMetrics;
    subscriptions: Array<{
      user: Pick<UserCredentials, 'id' | 'email'>;
      account: { id: string; name: string };
      modelName?: string;
      modelNames?: string[];
      extensionEnabled: boolean;
      traderspostEnabled: boolean;
      crossTradeEnabled: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
  }> {
    const currentMonthStart = fixedOffsetMonthStart(now, JOURNAL_TIME_OFFSET_MINUTES);
    const currentWeekStart = fixedOffsetWeekStart(now, JOURNAL_TIME_OFFSET_MINUTES);
    const currentDayStart = fixedOffsetDayStart(now, JOURNAL_TIME_OFFSET_MINUTES);
    const trackedRangeNames = this.listTrackedRangeNames();
    // Batch-friendly name resolution: one stored-name scan + one flag scan
    // serve the whole loop — per-range resolvers each cost several UNION
    // queries, which serializes this endpoint badly on slow disks.
    const storedNamesForResolution = this.listStoredRangeNames();
    const resolveFlagRangeName = (name: string) =>
      this.resolveStoredRangeAliasesFromList(storedNamesForResolution, name)[0] ?? normalizeRangeName(name);
    const flagsByRange = new Map(
      this.listRangeReviewFlags().map((flag) => [flag.rangeName, flag]),
    );
    const trackedRangeRows = this.db.prepare(
      `SELECT tracked_ranges.range_name, tracked_ranges.created_by_user_id, users.email AS created_by_email, tracked_ranges.created_at
       FROM tracked_ranges
       JOIN users ON users.id = tracked_ranges.created_by_user_id
       ORDER BY tracked_ranges.created_at ASC, tracked_ranges.range_name COLLATE BINARY ASC`,
    ).all() as Array<{
      range_name: string;
      created_by_user_id: string;
      created_by_email: string;
      created_at: string;
    }>;
    const routeRows = this.db.prepare(
      `SELECT range_routes.range_name, range_routes.user_id, users.email, range_routes.account_id, accounts.name AS account_name,
       range_routes.extension_enabled, range_routes.traderspost_enabled, range_routes.created_at, range_routes.updated_at
       FROM range_routes
       JOIN users ON users.id = range_routes.user_id
       JOIN accounts ON accounts.id = range_routes.account_id
       WHERE accounts.deprecated = 0
       ORDER BY range_routes.range_name COLLATE BINARY ASC, range_routes.created_at ASC, users.email COLLATE NOCASE ASC`,
    ).all() as Array<{
      range_name: string;
      user_id: string;
      email: string;
      account_id: string;
      account_name: string;
      extension_enabled: number;
      traderspost_enabled: number;
        created_at: string;
        updated_at: string;
      }>;
    const ctConfiguredByAccount = new Map<string, boolean>();
    for (const row of this.db.prepare(
      'SELECT account_id, cross_trade_webhook_url, cross_trade_secret_key, cross_trade_enabled FROM traderspost_account_destinations',
    ).all() as Array<{
      account_id: string;
      cross_trade_webhook_url: string | null;
      cross_trade_secret_key: string | null;
      cross_trade_enabled: number | null;
    }>) {
      ctConfiguredByAccount.set(
        row.account_id,
        Boolean(row.cross_trade_webhook_url && row.cross_trade_secret_key && row.cross_trade_enabled !== 0),
      );
    }
    const subcategoryAssignments = this.listRangeSubcategoryAssignments();
    // A range can live in several models — map to a set, not a single name.
    const rangeToSubcategories = new Map<string, Set<string>>();
    const subcategoryRanges = new Map<string, Set<string>>();
    for (const assignment of subcategoryAssignments) {
      const rangeSet = rangeToSubcategories.get(assignment.rangeName) ?? new Set<string>();
      rangeSet.add(assignment.subcategoryName);
      rangeToSubcategories.set(assignment.rangeName, rangeSet);
      const set = subcategoryRanges.get(assignment.subcategoryName) ?? new Set<string>();
      set.add(assignment.rangeName);
      subcategoryRanges.set(assignment.subcategoryName, set);
    }
    const accountSubcategoryRoutes = new Map<string, Set<string>>();
    for (const row of routeRows) {
      for (const subcategory of rangeToSubcategories.get(row.range_name) ?? []) {
        const key = `${subcategory}:${row.user_id}:${row.account_id}`;
        const set = accountSubcategoryRoutes.get(key) ?? new Set<string>();
        set.add(row.range_name);
        accountSubcategoryRoutes.set(key, set);
      }
    }

    const tradeRows = this.db.prepare(
      `SELECT id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id
       FROM range_trade_events
       WHERE event_type = 'trade_closed'
       ORDER BY occurred_at DESC, id DESC`,
    ).all() as unknown as RangeTradeEventRow[];
    const allTradesByRange = new Map<string, RangeTradeEvent[]>();
    const performanceTradesByRange = new Map<string, RangeTradeEvent[]>();
    for (const row of tradeRows) {
      const event = this.toRangeTradeEvent(row);
      const allTrades = allTradesByRange.get(event.rangeName) ?? [];
      allTrades.push(event);
      allTradesByRange.set(event.rangeName, allTrades);
      // Hidden calendar days are display-only (schedule sync hides off-days);
      // they must not remove real trades from performance stats.
      const performanceTrades = performanceTradesByRange.get(event.rangeName) ?? [];
      performanceTrades.push(event);
      performanceTradesByRange.set(event.rangeName, performanceTrades);
    }
    const subscriptionsByRange = new Map<string, Array<{
      user: Pick<UserCredentials, 'id' | 'email'>;
      account: { id: string; name: string };
      modelName?: string;
      modelNames?: string[];
      extensionEnabled: boolean;
      traderspostEnabled: boolean;
      crossTradeEnabled: boolean;
      createdAt: string;
      updatedAt: string;
    }>>();
    const creatorsByRange = new Map<string, Pick<UserCredentials, 'id' | 'email'>>();
    const createdAtByRange = new Map<string, string>();
    for (const row of trackedRangeRows) {
      if (!creatorsByRange.has(row.range_name)) {
        creatorsByRange.set(row.range_name, { id: row.created_by_user_id, email: row.created_by_email });
      }
      if (!createdAtByRange.has(row.range_name)) createdAtByRange.set(row.range_name, row.created_at);
    }
    for (const row of routeRows) {
      const subscriptions = subscriptionsByRange.get(row.range_name) ?? [];
      // Full-model subscriptions: every model whose entire range set is routed
      // on this account counts. modelNames carries them all; modelName stays
      // the first (sorted) for consumers expecting a singular value.
      const modelNames = [...(rangeToSubcategories.get(row.range_name) ?? [])]
        .sort()
        .filter((subcategory) =>
          (accountSubcategoryRoutes.get(`${subcategory}:${row.user_id}:${row.account_id}`)?.size ?? 0)
            === (subcategoryRanges.get(subcategory)?.size ?? 0));
      subscriptions.push({
        user: { id: row.user_id, email: row.email },
        account: { id: row.account_id, name: row.account_name },
        modelName: modelNames[0],
        modelNames,
        extensionEnabled: Boolean(row.extension_enabled),
        traderspostEnabled: Boolean(row.traderspost_enabled),
        crossTradeEnabled: ctConfiguredByAccount.get(row.account_id) ?? false,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      subscriptionsByRange.set(row.range_name, subscriptions);
      if (!creatorsByRange.has(row.range_name)) creatorsByRange.set(row.range_name, { id: row.user_id, email: row.email });
      if (!createdAtByRange.has(row.range_name)) createdAtByRange.set(row.range_name, row.created_at);
    }

    const details = new Map<string, {
      rangeName: string;
      createdBy?: Pick<UserCredentials, 'id' | 'email'>;
      createdAt: string;
      allTime: JournalMetrics;
      currentMonth: JournalMetrics;
      currentWeek: JournalMetrics;
      currentDay: JournalMetrics;
      performanceAllTime: JournalMetrics;
      performanceCurrentMonth: JournalMetrics;
      performanceCurrentWeek: JournalMetrics;
      performanceCurrentDay: JournalMetrics;
      reviewFlag: ReturnType<Database['getRangeReviewFlag']>;
      subscriptions: Array<{
        user: Pick<UserCredentials, 'id' | 'email'>;
        account: { id: string; name: string };
        modelName?: string;
        extensionEnabled: boolean;
        traderspostEnabled: boolean;
        crossTradeEnabled: boolean;
        createdAt: string;
        updatedAt: string;
      }>;
    }>();

    for (const rangeName of trackedRangeNames) {
      const trades = allTradesByRange.get(rangeName) ?? [];
      const performanceTrades = performanceTradesByRange.get(rangeName) ?? [];
      details.set(rangeName, {
        rangeName,
        ...(creatorsByRange.has(rangeName) ? { createdBy: creatorsByRange.get(rangeName)! } : {}),
        createdAt: createdAtByRange.get(rangeName) ?? trades.at(-1)?.occurredAt ?? performanceTrades.at(-1)?.occurredAt ?? now.toISOString(),
        allTime: summarizeTrades(trades),
        currentMonth: summarizeTrades(trades.filter((event) => event.occurredAt >= currentMonthStart)),
        currentWeek: summarizeTrades(trades.filter((event) => event.occurredAt >= currentWeekStart)),
        currentDay: summarizeTrades(trades.filter((event) => event.occurredAt >= currentDayStart)),
        performanceAllTime: summarizeTrades(performanceTrades),
        performanceCurrentMonth: summarizeTrades(performanceTrades.filter((event) => event.occurredAt >= currentMonthStart)),
        performanceCurrentWeek: summarizeTrades(performanceTrades.filter((event) => event.occurredAt >= currentWeekStart)),
        performanceCurrentDay: summarizeTrades(performanceTrades.filter((event) => event.occurredAt >= currentDayStart)),
        reviewFlag: flagsByRange.get(rangeName) ?? flagsByRange.get(resolveFlagRangeName(rangeName)),
        subscriptions: subscriptionsByRange.get(rangeName) ?? [],
      });
    }

    return [...details.values()];
  }

  listRangeAlertPayloads(userId?: string): Array<{
    id: string;
    receivedAt: string;
    rangeName: string;
    action: 'buy' | 'sell' | 'cancel' | 'exit';
    ticker: string;
    payloadJson: string;
    sourceReference?: string;
  }> {
    const filters = ['range_name IS NOT NULL'];
    const params: (string | number)[] = [];
    if (userId) {
      filters.push('EXISTS (SELECT 1 FROM proxy_deliveries WHERE proxy_deliveries.proxy_alert_id = proxy_alerts.id AND proxy_deliveries.user_id = ?)');
      params.push(userId);
    }
    const rows = this.db.prepare(
      `SELECT id, received_at, range_name, action, ticker, payload_json, source_reference
       FROM proxy_alerts
       WHERE ${filters.join(' AND ')}
       ORDER BY received_at DESC, id DESC`,
    ).all(...params) as Array<{
      id: string;
      received_at: string;
      range_name: string;
      action: 'buy' | 'sell' | 'cancel' | 'exit';
      ticker: string;
      payload_json: string;
      source_reference: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      receivedAt: row.received_at,
      rangeName: row.range_name,
      action: row.action,
      ticker: row.ticker,
      payloadJson: row.payload_json,
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
    }));
  }

  findAccountAlertPayload(deliveryId: string): {
    deliveryId: string;
    userId: string;
    accountName: string;
    receivedAt: string;
    rangeName?: string;
    sourceReference?: string;
    payloadJson: string;
  } | undefined {
    const row = this.db.prepare(
      `SELECT proxy_deliveries.id AS delivery_id, proxy_deliveries.user_id, accounts.name AS account_name,
       proxy_alerts.received_at, proxy_alerts.range_name, proxy_alerts.payload_json, proxy_alerts.source_reference
       FROM proxy_deliveries
       JOIN proxy_alerts ON proxy_alerts.id = proxy_deliveries.proxy_alert_id
       JOIN accounts ON accounts.id = proxy_deliveries.account_id
       WHERE proxy_deliveries.id = ?`,
    ).get(deliveryId) as {
      delivery_id: string;
      user_id: string;
      account_name: string;
      received_at: string;
      range_name: string | null;
      payload_json: string;
      source_reference: string | null;
    } | undefined;
    return row && {
      deliveryId: row.delivery_id,
      userId: row.user_id,
      accountName: row.account_name,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
      payloadJson: row.payload_json,
    };
  }

  private alertFeedBaseQuery(): string {
    return `
      WITH scoped_deliveries AS (
        SELECT proxy_alert_id, user_id, account_id, status
        FROM proxy_deliveries
        WHERE (? IS NULL OR user_id = ?)
      ),
      scoped_trade_events AS (
        SELECT proxy_alert_id, user_id, account_id
        FROM trade_events
        WHERE (? IS NULL OR user_id = ?)
      ),
      alert_feed AS (
        SELECT proxy_alerts.id, proxy_alerts.received_at, proxy_alerts.range_name, proxy_alerts.action,
          proxy_alerts.ticker, proxy_alerts.payload_json, proxy_alerts.source_reference,
          (SELECT COUNT(*) FROM scoped_deliveries WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id) AS delivery_count,
          (SELECT COUNT(*) FROM scoped_trade_events WHERE scoped_trade_events.proxy_alert_id = proxy_alerts.id) AS trade_event_count,
          (SELECT COUNT(*) FROM (
            SELECT scoped_deliveries.user_id AS value
            FROM scoped_deliveries
            WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id
            UNION
            SELECT scoped_trade_events.user_id AS value
            FROM scoped_trade_events
            WHERE scoped_trade_events.proxy_alert_id = proxy_alerts.id
          )) AS matched_user_count,
          (SELECT GROUP_CONCAT(value, char(31)) FROM (
            SELECT users.email AS value
            FROM scoped_deliveries
            JOIN users ON users.id = scoped_deliveries.user_id
            WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id
            UNION
            SELECT users.email AS value
            FROM scoped_trade_events
            JOIN users ON users.id = scoped_trade_events.user_id
            WHERE scoped_trade_events.proxy_alert_id = proxy_alerts.id
          )) AS matched_user_emails,
          (SELECT COUNT(*) FROM (
            SELECT scoped_deliveries.account_id AS value
            FROM scoped_deliveries
            WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id
            UNION
            SELECT scoped_trade_events.account_id AS value
            FROM scoped_trade_events
            WHERE scoped_trade_events.proxy_alert_id = proxy_alerts.id
          )) AS matched_account_count,
          (SELECT GROUP_CONCAT(value, char(31)) FROM (
            SELECT accounts.name AS value
            FROM scoped_deliveries
            JOIN accounts ON accounts.id = scoped_deliveries.account_id
            WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id
            UNION
            SELECT accounts.name AS value
            FROM scoped_trade_events
            JOIN accounts ON accounts.id = scoped_trade_events.account_id
            WHERE scoped_trade_events.proxy_alert_id = proxy_alerts.id
          )) AS matched_account_names,
          (SELECT COALESCE(SUM(CASE WHEN status IN (
            'traderspost_delivered',
            'extension_draft_created_and_traderspost_delivered'
          ) THEN 1 ELSE 0 END), 0)
            FROM scoped_deliveries WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id) AS traderspost_delivered_count,
          (SELECT COALESCE(SUM(CASE WHEN status IN (
            'traderspost_failed',
            'extension_draft_created_and_traderspost_failed'
          ) THEN 1 ELSE 0 END), 0)
            FROM scoped_deliveries WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id) AS traderspost_failed_count,
          (SELECT COALESCE(SUM(CASE WHEN status IN (
            'pending_traderspost',
            'extension_draft_created_and_pending_traderspost'
          ) THEN 1 ELSE 0 END), 0)
            FROM scoped_deliveries WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id) AS traderspost_pending_count,
          (SELECT COALESCE(SUM(CASE WHEN status = 'traderspost_not_configured' THEN 1 ELSE 0 END), 0)
            FROM scoped_deliveries WHERE scoped_deliveries.proxy_alert_id = proxy_alerts.id) AS traderspost_not_configured_count,
          CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (
            SELECT 1
            FROM range_routes
            WHERE range_routes.user_id = ? AND range_routes.range_name = proxy_alerts.range_name
          ) END AS current_user_linked
        FROM proxy_alerts
      )`;
  }

  private alertFeedFilterClause(): string {
    return `CASE ?
      WHEN 'routed' THEN CASE WHEN (delivery_count > 0 OR trade_event_count > 0) THEN 1 ELSE 0 END
      WHEN 'unrouted' THEN CASE WHEN delivery_count = 0 AND trade_event_count = 0 THEN 1 ELSE 0 END
      WHEN 'lifecycle' THEN CASE WHEN trade_event_count > 0 THEN 1 ELSE 0 END
      WHEN 'traderspost_delivered' THEN CASE WHEN traderspost_delivered_count > 0 THEN 1 ELSE 0 END
      WHEN 'traderspost_failed' THEN CASE WHEN traderspost_failed_count > 0 THEN 1 ELSE 0 END
      ELSE 1
    END = 1`;
  }

  private alertFeedScopeBindings(
    selectedUserId?: string,
  ): [string | null, string | null, string | null, string | null, string | null, string | null] {
    return [
      selectedUserId ?? null,
      selectedUserId ?? null,
      selectedUserId ?? null,
      selectedUserId ?? null,
      selectedUserId ?? null,
      selectedUserId ?? null,
    ];
  }

  private alertFeedSearchBindings(
    nameQuery?: string,
    receivedAfter?: string,
  ): [string | null, string | null, string | null, string | null] {
    const namePattern = nameQuery ? `%${escapeSqlLikePattern(nameQuery.toLowerCase())}%` : null;
    return [
      namePattern,
      namePattern,
      receivedAfter ?? null,
      receivedAfter ?? null,
    ];
  }

  private splitFeedValues(value: string | null): string[] {
    return value ? value.split('\u001f').filter((entry) => entry.length > 0) : [];
  }

  listAlertFeedRangeNames(selectedUserId?: string): string[] {
    const scopeBindings = this.alertFeedScopeBindings(selectedUserId);
    const scopedVisibilityClause = selectedUserId ? 'AND (matched_user_count > 0 OR current_user_linked = 1)' : '';
    const rows = this.db.prepare(
      `${this.alertFeedBaseQuery()}
       SELECT DISTINCT range_name
       FROM alert_feed
       WHERE range_name IS NOT NULL
       ${scopedVisibilityClause}
       ORDER BY range_name COLLATE BINARY ASC`,
    ).all(...scopeBindings) as Array<{ range_name: string }>;
    return rows.map((row) => row.range_name);
  }

  listAlertFeed(
    selectedUserId?: string,
    activity: AlertFeedActivityFilter = 'all',
    nameQuery?: string,
    receivedAfter?: string,
    limit = 25,
    offset = 0,
  ): { alerts: AlertFeedEntry[]; totalCount: number } {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const safeOffset = Math.max(Math.trunc(offset), 0);
    const scopeBindings = this.alertFeedScopeBindings(selectedUserId);
    const searchBindings = this.alertFeedSearchBindings(nameQuery, receivedAfter);
    const scopedVisibilityClause = selectedUserId ? 'AND (delivery_count > 0 OR trade_event_count > 0 OR current_user_linked = 1)' : '';
    const feedSearchClause = `AND (? IS NULL OR lower(replace(replace(COALESCE(range_name, ''), char(13), ''), char(10), '')) LIKE ? ESCAPE '\\')
       AND (? IS NULL OR received_at >= ?)`;
    const total = this.db.prepare(
      `${this.alertFeedBaseQuery()}
       SELECT COUNT(*) AS count
       FROM alert_feed
       WHERE ${this.alertFeedFilterClause()}
       ${feedSearchClause}
       ${scopedVisibilityClause}`,
    ).get(...scopeBindings, activity, ...searchBindings) as { count: number };
    const rows = this.db.prepare(
      `${this.alertFeedBaseQuery()}
       SELECT *
       FROM alert_feed
       WHERE ${this.alertFeedFilterClause()}
       ${feedSearchClause}
       ${scopedVisibilityClause}
       ORDER BY received_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    ).all(...scopeBindings, activity, ...searchBindings, safeLimit, safeOffset) as unknown as AlertFeedRow[];
    return {
      alerts: rows.map((row) => this.toAlertFeedEntry(row)),
      totalCount: total.count,
    };
  }

  getAlertFeedSummary(
    selectedUserId?: string,
    activity: AlertFeedActivityFilter = 'all',
    nameQuery?: string,
    receivedAfter?: string,
  ): AlertFeedSummary {
    const scopeBindings = this.alertFeedScopeBindings(selectedUserId);
    const searchBindings = this.alertFeedSearchBindings(nameQuery, receivedAfter);
    const scopedVisibilityClause = selectedUserId ? 'AND (delivery_count > 0 OR trade_event_count > 0 OR current_user_linked = 1)' : '';
    const feedSearchClause = `AND (? IS NULL OR lower(replace(replace(COALESCE(range_name, ''), char(13), ''), char(10), '')) LIKE ? ESCAPE '\\')
       AND (? IS NULL OR received_at >= ?)`;
    const row = this.db.prepare(
      `${this.alertFeedBaseQuery()}
       SELECT COUNT(*) AS total_alerts,
         COALESCE(SUM(CASE WHEN delivery_count > 0 OR trade_event_count > 0 THEN 1 ELSE 0 END), 0) AS routed_alerts,
         COALESCE(SUM(CASE WHEN delivery_count = 0 AND trade_event_count = 0 THEN 1 ELSE 0 END), 0) AS unrouted_alerts,
         COALESCE(SUM(traderspost_delivered_count), 0) AS traderspost_delivered_count,
         COALESCE(SUM(traderspost_failed_count), 0) AS traderspost_failed_count,
         COALESCE(SUM(traderspost_pending_count), 0) AS traderspost_pending_count,
         MAX(received_at) AS latest_received_at
       FROM alert_feed
       WHERE ${this.alertFeedFilterClause()}
       ${feedSearchClause}
       ${scopedVisibilityClause}`,
    ).get(...scopeBindings, activity, ...searchBindings) as {
      total_alerts: number;
      routed_alerts: number;
      unrouted_alerts: number;
      traderspost_delivered_count: number;
      traderspost_failed_count: number;
      traderspost_pending_count: number;
      latest_received_at: string | null;
    };
    return {
      totalAlerts: row.total_alerts,
      routedAlerts: row.routed_alerts,
      unroutedAlerts: row.unrouted_alerts,
      traderspostDeliveredCount: row.traderspost_delivered_count,
      traderspostFailedCount: row.traderspost_failed_count,
      traderspostPendingCount: row.traderspost_pending_count,
      ...(row.latest_received_at ? { latestReceivedAt: row.latest_received_at } : {}),
    };
  }

  findProxyAlertPayload(alertId: string): {
    alertId: string;
    receivedAt: string;
    rangeName?: string;
    sourceReference?: string;
    payloadJson: string;
  } | undefined {
    const row = this.db.prepare(
      `SELECT id, received_at, range_name, payload_json, source_reference
       FROM proxy_alerts
       WHERE id = ?`,
    ).get(alertId) as {
      id: string;
      received_at: string;
      range_name: string | null;
      payload_json: string;
      source_reference: string | null;
    } | undefined;
    return row && {
      alertId: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
      payloadJson: row.payload_json,
    };
  }

  listRelevantProxyAlerts(userId: string, accountId?: string, limit = 50): Array<{
    id: string;
    receivedAt: string;
    rangeName?: string;
    action: 'buy' | 'sell' | 'cancel' | 'exit';
    ticker: string;
    payloadJson: string;
    sourceReference?: string;
    deliveryCount: number;
    tradeEventCount: number;
  }> {
    if (accountId && !this.accountBelongsToUser(accountId, userId)) return [];
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
    const rows = this.db.prepare(
      `SELECT proxy_alerts.id, proxy_alerts.received_at, proxy_alerts.range_name, proxy_alerts.action,
       proxy_alerts.ticker, proxy_alerts.payload_json, proxy_alerts.source_reference,
       COUNT(DISTINCT proxy_deliveries.id) AS delivery_count,
       COUNT(DISTINCT trade_events.id) AS trade_event_count
       FROM proxy_alerts
       LEFT JOIN proxy_deliveries
         ON proxy_deliveries.proxy_alert_id = proxy_alerts.id
         AND proxy_deliveries.user_id = ?
         AND (? IS NULL OR proxy_deliveries.account_id = ?)
       LEFT JOIN trade_events
         ON trade_events.proxy_alert_id = proxy_alerts.id
         AND trade_events.user_id = ?
         AND (? IS NULL OR trade_events.account_id = ?)
       WHERE EXISTS (
         SELECT 1 FROM proxy_deliveries AS relevant_deliveries
         WHERE relevant_deliveries.proxy_alert_id = proxy_alerts.id
           AND relevant_deliveries.user_id = ?
           AND (? IS NULL OR relevant_deliveries.account_id = ?)
       ) OR EXISTS (
         SELECT 1 FROM trade_events AS relevant_trade_events
         WHERE relevant_trade_events.proxy_alert_id = proxy_alerts.id
           AND relevant_trade_events.user_id = ?
           AND (? IS NULL OR relevant_trade_events.account_id = ?)
       )
       GROUP BY proxy_alerts.id, proxy_alerts.received_at, proxy_alerts.range_name, proxy_alerts.action,
         proxy_alerts.ticker, proxy_alerts.payload_json, proxy_alerts.source_reference
       ORDER BY proxy_alerts.received_at DESC, proxy_alerts.id DESC
       LIMIT ?`,
    ).all(
      userId, accountId ?? null, accountId ?? null,
      userId, accountId ?? null, accountId ?? null,
      userId, accountId ?? null, accountId ?? null,
      userId, accountId ?? null, accountId ?? null,
      safeLimit,
    ) as Array<{
      id: string;
      received_at: string;
      range_name: string | null;
      action: 'buy' | 'sell' | 'cancel' | 'exit';
      ticker: string;
      payload_json: string;
      source_reference: string | null;
      delivery_count: number;
      trade_event_count: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      action: row.action,
      ticker: row.ticker,
      payloadJson: row.payload_json,
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
      deliveryCount: row.delivery_count,
      tradeEventCount: row.trade_event_count,
    }));
  }

  findUserProxyAlertPayload(userId: string, alertId: string, accountId?: string): {
    alertId: string;
    receivedAt: string;
    rangeName?: string;
    sourceReference?: string;
    payloadJson: string;
  } | undefined {
    if (accountId && !this.accountBelongsToUser(accountId, userId)) return undefined;
    const row = this.db.prepare(
      `SELECT proxy_alerts.id, proxy_alerts.received_at, proxy_alerts.range_name, proxy_alerts.payload_json,
       proxy_alerts.source_reference
       FROM proxy_alerts
       WHERE proxy_alerts.id = ?
         AND (
           EXISTS (
             SELECT 1 FROM proxy_deliveries
             WHERE proxy_deliveries.proxy_alert_id = proxy_alerts.id
               AND proxy_deliveries.user_id = ?
               AND (? IS NULL OR proxy_deliveries.account_id = ?)
           ) OR EXISTS (
             SELECT 1 FROM trade_events
             WHERE trade_events.proxy_alert_id = proxy_alerts.id
               AND trade_events.user_id = ?
               AND (? IS NULL OR trade_events.account_id = ?)
           )
         )`,
    ).get(
      alertId,
      userId, accountId ?? null, accountId ?? null,
      userId, accountId ?? null, accountId ?? null,
    ) as {
      id: string;
      received_at: string;
      range_name: string | null;
      payload_json: string;
      source_reference: string | null;
    } | undefined;
    return row && {
      alertId: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
      payloadJson: row.payload_json,
    };
  }

  findRangeRoutes(rangeName: string): RangeRoute[] {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT id, range_name, user_id, account_id, extension_enabled, traderspost_enabled, run_scheduled, created_at, updated_at
       FROM range_routes WHERE range_name = ? COLLATE BINARY ORDER BY created_at ASC`,
    ).all(resolvedRangeName) as unknown as RangeRouteRow[];
    return rows.map((row) => this.toRangeRoute(row));
  }

  findCurrentRangeRoute(
    rangeRouteId: string,
    accountId: string,
    rangeName: string,
  ): RangeRoute | undefined {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT id, range_name, user_id, account_id, extension_enabled, traderspost_enabled,
         run_scheduled, created_at, updated_at
       FROM range_routes
       WHERE id = ? AND account_id = ? AND range_name = ? COLLATE BINARY`,
    ).get(rangeRouteId, accountId, resolvedRangeName) as unknown as RangeRouteRow | undefined;
    return row && this.toRangeRoute(row);
  }

  createProxyAlert(input: Omit<ProxyAlert, 'id' | 'receivedAt'>): ProxyAlert {
    let payloadJson = input.payloadJson;
    try {
      const payload = JSON.parse(input.payloadJson);
      if (payload && typeof payload === 'object') {
        for (const key of ['bracketId', 'tradeId', 'eventId'] as const) {
          const value = payload[key];
          if (typeof value === 'string') {
            payload[key] = value.replace(/[\r\n]/g, '').replace(/'/g, 'r');
          }
        }
        payloadJson = JSON.stringify(payload);
      }
    } catch {
      payloadJson = input.payloadJson.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    }
    const sourceReference = input.sourceReference != null ? input.sourceReference.replace(/[\r\n]/g, '').replace(/'/g, 'r') : input.sourceReference;
    const alert: ProxyAlert = {
      ...input,
      payloadJson,
      sourceReference,
      ...(input.rangeName ? { rangeName: this.resolveRangeName(input.rangeName) } : {}),
      id: randomUUID(),
      receivedAt: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO proxy_alerts (
        id, received_at, range_name, action, ticker, payload_json, source_reference
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      alert.id,
      alert.receivedAt,
      alert.rangeName ?? null,
      alert.action,
      alert.ticker,
      alert.payloadJson,
      alert.sourceReference ?? null,
    );
    return alert;
  }

  deleteProxyAlert(alertId: string): boolean {
    const unlinkTradeEvents = this.db.prepare(
      'UPDATE trade_events SET proxy_alert_id = NULL WHERE proxy_alert_id = ?',
    );
    const unlinkRangeTradeEvents = this.db.prepare(
      'UPDATE range_trade_events SET proxy_alert_id = NULL WHERE proxy_alert_id = ?',
    );
    const deleteDeliveries = this.db.prepare(
      'DELETE FROM proxy_deliveries WHERE proxy_alert_id = ?',
    );
    const deleteAlert = this.db.prepare(
      'DELETE FROM proxy_alerts WHERE id = ?',
    );
    const deleteAlertTransaction = this.db.transaction((id: string) => {
      unlinkTradeEvents.run(id);
      unlinkRangeTradeEvents.run(id);
      deleteDeliveries.run(id);
      const result = deleteAlert.run(id);
      return result.changes === 1;
    });
    return deleteAlertTransaction(alertId);
  }

  createProxyDelivery(input: Omit<ProxyDelivery, 'id' | 'createdAt'>): ProxyDelivery {
    const delivery: ProxyDelivery = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO proxy_deliveries (
        id, proxy_alert_id, range_route_id, user_id, account_id, extension_enabled, traderspost_enabled,
        draft_id, qualified_trade_id, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      delivery.id,
      delivery.proxyAlertId,
      delivery.rangeRouteId,
      delivery.userId,
      delivery.accountId,
      Number(delivery.extensionEnabled),
      Number(delivery.traderspostEnabled),
      delivery.draftId ?? null,
      delivery.qualifiedTradeId ?? null,
      delivery.status,
      delivery.createdAt,
    );
    return delivery;
  }

  updateProxyDeliveryStatus(id: string, status: ProxyDeliveryStatus): ProxyDelivery | undefined {
    const result = this.db.prepare('UPDATE proxy_deliveries SET status = ? WHERE id = ?').run(status, id);
    if (result.changes !== 1) return undefined;
    const delivery = this.findProxyDelivery(id);
    // The journal renders delivery status (delivered/failed/blocked) — without this,
    // a resend or async completion would keep showing the stale cached status.
    if (delivery) this.invalidateUserCache(delivery.userId);
    return delivery;
  }

  findProxyDelivery(id: string): ProxyDelivery | undefined {
    const row = this.db.prepare(
      `SELECT id, proxy_alert_id, range_route_id, user_id, account_id, extension_enabled, traderspost_enabled,
       draft_id, qualified_trade_id, status, created_at FROM proxy_deliveries WHERE id = ?`,
    ).get(id) as unknown as ProxyDeliveryRow | undefined;
    return row && this.toProxyDelivery(row);
  }

  // On startup no dispatch can still be in flight — anything left pending was
  // interrupted and its outcome is unknowable. Resolve it honestly so the
  // journal doesn't show a permanently pending send.
  sweepInterruptedTradersPostDispatches(): { deliveries: number; orders: number } {
    const interrupted = this.db.prepare(
      `SELECT id, user_id FROM proxy_deliveries
       WHERE status IN ('pending_traderspost', 'extension_draft_created_and_pending_traderspost')`,
    ).all() as Array<{ id: string; user_id: string }>;
    // Ledger each interrupted send as an attempt so an operator resend allocates
    // the -r<n> order id instead of upserting over the row this attempt created.
    for (const { id } of interrupted) {
      this.createProxyDeliveryAttempt({
        proxyDeliveryId: id,
        success: false,
        errorText: 'Dispatch interrupted by process restart',
      });
    }
    const deliveries = this.db.prepare(
      `UPDATE proxy_deliveries SET status = CASE
         WHEN extension_enabled = 1 AND draft_id IS NOT NULL THEN 'extension_draft_created_and_traderspost_failed'
         ELSE 'traderspost_failed' END
       WHERE status IN ('pending_traderspost', 'extension_draft_created_and_pending_traderspost')`,
    ).run().changes;
    const orders = this.db.prepare(
      `UPDATE broker_orders SET status = 'uncertain', dispatch_status = 'uncertain', status_source = 'dispatch',
         error_text = COALESCE(error_text, 'Dispatch interrupted by process restart')
       WHERE status = 'pending'`,
    ).run().changes;
    for (const { user_id } of interrupted) this.invalidateUserCache(user_id);
    return { deliveries, orders };
  }

  listPendingTradersPostDeliveries(accountId: string): Array<{ id: string; ticker: string }> {
    const rows = this.db.prepare(
      `SELECT pd.id, pa.ticker
       FROM proxy_deliveries pd
       JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
       WHERE pd.account_id = ? AND pd.status IN ('pending_traderspost', 'extension_draft_created_and_pending_traderspost')`,
    ).all(accountId) as unknown as Array<{ id: string; ticker: string | null }>;
    return rows.map((row) => ({ id: row.id, ticker: row.ticker ?? '' }));
  }

  latestEntryDeliveryStatusForBracket(
    accountId: string,
    rangeName: string,
    bracketId: string,
    action: 'buy' | 'sell',
    bracketSide: 'long' | 'short',
  ): ProxyDeliveryStatus | undefined {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT pd.status
       FROM proxy_alerts pa
       JOIN proxy_deliveries pd ON pd.proxy_alert_id = pa.id
       WHERE pd.account_id = ?
         AND pa.range_name = ? COLLATE BINARY
         AND pa.source_reference IN (?, ?)
         AND pa.action = ?
         AND json_extract(pa.payload_json, '$.bracketSide') = ?
       ORDER BY pd.created_at DESC, pd.rowid DESC
       LIMIT 1`,
    ).get(accountId, resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, bracketId), action, bracketSide) as { status: ProxyDeliveryStatus } | undefined;
    return row?.status;
  }

  // How many times this arm's entry may have reached the wire — NT8 burns
  // oco_id/order_id permanently, so a re-armed bracket resend must go out under
  // a fresh wire id. Counts every delivery that could have landed (delivered,
  // pending, uncertain — never suppressed/failed); a redundant suffix is
  // harmless, a reused id is not.
  countDeliveredBracketEntryDispatches(
    accountId: string,
    rangeName: string,
    bracketId: string,
    action: 'buy' | 'sell',
    bracketSide: 'long' | 'short',
    excludeDeliveryId?: string,
  ): number {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c
       FROM proxy_alerts pa
       JOIN proxy_deliveries pd ON pd.proxy_alert_id = pa.id
       WHERE pd.account_id = ?
         AND pa.range_name = ? COLLATE BINARY
         AND pa.source_reference IN (?, ?)
         AND pa.action = ?
         AND json_extract(pa.payload_json, '$.bracketSide') = ?
         AND pd.status NOT IN (
           'suppressed_duplicate', 'suppressed_guard', 'suppressed_safeguard',
           'suppressed_reapply', 'routing_disabled', 'failed'
         )
         AND (? IS NULL OR pd.id != ?)`,
    ).get(accountId, resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, bracketId), action, bracketSide, excludeDeliveryId ?? null, excludeDeliveryId ?? null) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  hasDeliveredEntryForBracket(
    accountId: string,
    rangeName: string,
    bracketId: string,
    action: 'buy' | 'sell',
    bracketSide: 'long' | 'short',
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM proxy_alerts pa
       JOIN proxy_deliveries pd ON pd.proxy_alert_id = pa.id
       WHERE pd.account_id = ?
         AND pa.range_name = ? COLLATE BINARY
         AND pa.source_reference IN (?, ?)
         AND pa.action = ?
         AND json_extract(pa.payload_json, '$.bracketSide') = ?
         AND pd.status IN (
           'traderspost_delivered',
           'extension_draft_created_and_traderspost_delivered'
         )
       LIMIT 1`,
    ).get(accountId, resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, bracketId), action, bracketSide) as { 1: number } | undefined;
    return Boolean(row);
  }

  hasPreciseTakeProfitDelivery(
    accountId: string,
    rangeName: string,
    bracketId: string,
    side: 'long' | 'short',
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM proxy_alerts pa
       JOIN proxy_deliveries pd ON pd.proxy_alert_id = pa.id
       WHERE pd.account_id = ?
         AND pa.range_name = ? COLLATE BINARY
         AND pa.source_reference IN (?, ?)
         AND json_extract(pa.payload_json, '$.bracketSide') = ?
         AND json_extract(pa.payload_json, '$.extras.preciseTakeProfitAfterFill') = 1
       LIMIT 1`,
    ).get(accountId, resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, bracketId), side) as { 1: number } | undefined;
    return Boolean(row);
  }

  upsertPreciseTakeProfitIntent(input: {
    accountId: string;
    rangeName: string;
    bracketId: string;
    instrument: string;
    side: 'long' | 'short';
    action: 'buy' | 'sell';
    payloadJson: string;
  }): PreciseTakeProfitIntent {
    const rangeName = this.resolveRangeName(input.rangeName) ?? input.rangeName;
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO precise_take_profit_intents (
         account_id, range_name, bracket_id, instrument, side, action, payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, range_name, bracket_id, side) DO NOTHING`,
    ).run(input.accountId, rangeName, input.bracketId, input.instrument, input.side, input.action, input.payloadJson, now, now);
    const row = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, instrument, side, action, payload_json, created_at, updated_at
       FROM precise_take_profit_intents
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?`,
    ).get(input.accountId, rangeName, input.bracketId, input.side) as PreciseTakeProfitIntentRow | undefined;
    const intent = row && this.toPreciseTakeProfitIntent(row);
    if (!intent) throw new Error('Failed to persist precise take profit intent');
    return intent;
  }

  hasSuccessfulPreciseTakeProfitDelivery(
    accountId: string,
    rangeName: string,
    bracketId: string,
    side: 'long' | 'short',
    excludeDeliveryId?: string,
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM proxy_deliveries pd
       JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
       WHERE pd.account_id = ?
         AND pa.range_name = ? COLLATE BINARY
         AND pa.source_reference IN (?, ?)
         AND json_extract(pa.payload_json, '$.bracketSide') = ?
         AND json_extract(pa.payload_json, '$.extras.preciseTakeProfitAfterFill') = 1
         AND pd.status IN (
           'traderspost_delivered',
           'extension_draft_created_and_traderspost_delivered'
         )
         AND (? IS NULL OR pd.id <> ?)
       LIMIT 1`,
    ).get(
      accountId,
      resolvedRangeName,
      ...this.idFormsForLookup(resolvedRangeName, bracketId),
      side,
      excludeDeliveryId ?? null,
      excludeDeliveryId ?? null,
    ) as { 1: number } | undefined;
    return Boolean(row);
  }

  hasPreciseTakeProfitCleanupDelivery(
    accountId: string,
    rangeName: string,
    bracketId: string,
    side: 'long' | 'short',
    lifecycleEventId?: string,
    excludeDeliveryId?: string,
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM proxy_deliveries pd
       JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
       WHERE pd.account_id = ?
         AND pa.range_name = ? COLLATE BINARY
         AND pa.source_reference IN (?, ?)
         AND json_extract(pa.payload_json, '$.bracketSide') = ?
         AND json_extract(pa.payload_json, '$.extras.preciseTakeProfitStopoutCleanup') = 1
         AND (? IS NULL OR json_extract(pa.payload_json, '$.extras.lifecycleEventId') = ?)
         AND (? IS NULL OR pd.id <> ?)
       LIMIT 1`,
    ).get(
      accountId,
      resolvedRangeName,
      ...this.idFormsForLookup(resolvedRangeName, bracketId),
      side,
      lifecycleEventId ?? null,
      lifecycleEventId ?? null,
      excludeDeliveryId ?? null,
      excludeDeliveryId ?? null,
    ) as { 1: number } | undefined;
    return Boolean(row);
  }

  hasSuccessfulPreciseTakeProfitCleanupDelivery(
    accountId: string,
    rangeName: string,
    bracketId: string,
    side: 'long' | 'short',
    excludeDeliveryId?: string,
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM proxy_deliveries pd
       JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
       WHERE pd.account_id = ?
         AND pa.range_name = ? COLLATE BINARY
         AND pa.source_reference IN (?, ?)
         AND json_extract(pa.payload_json, '$.bracketSide') = ?
         AND json_extract(pa.payload_json, '$.extras.preciseTakeProfitStopoutCleanup') = 1
         AND pd.status IN (
           'traderspost_delivered',
           'extension_draft_created_and_traderspost_delivered'
         )
         AND (? IS NULL OR pd.id <> ?)
       LIMIT 1`,
    ).get(
      accountId,
      resolvedRangeName,
      ...this.idFormsForLookup(resolvedRangeName, bracketId),
      side,
      excludeDeliveryId ?? null,
      excludeDeliveryId ?? null,
    ) as { 1: number } | undefined;
    return Boolean(row);
  }

  findPreciseTakeProfitIntent(
    accountId: string,
    rangeName: string,
    bracketId: string,
    side: 'long' | 'short',
  ): PreciseTakeProfitIntent | undefined {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, instrument, side, action, payload_json, created_at, updated_at
       FROM precise_take_profit_intents
       WHERE account_id = ?
         AND range_name = ? COLLATE BINARY
         AND bracket_id IN (?, ?)
         AND side = ?
       ORDER BY (bracket_id = ?) DESC`,
    ).get(accountId, resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, bracketId), side, bracketId) as PreciseTakeProfitIntentRow | undefined;
    return row && this.toPreciseTakeProfitIntent(row);
  }

  hasOpenLifecycleQuantityForBracket(
    accountId: string,
    rangeName: string,
    instrument: string,
    side: 'long' | 'short',
    bracketId: string,
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(
         CASE WHEN event_type = 'entry_filled' THEN quantity ELSE -quantity END
       ), 0) AS open_quantity
       FROM trade_events
       WHERE account_id = ?
         AND range_name = ? COLLATE BINARY
         AND instrument = ?
         AND side = ?
         AND event_type IN ('entry_filled', 'exit_filled', 'trade_closed')
         AND CASE
           WHEN instr(replace(replace(trade_id, char(13), ''), char(10), ''), '-lifecycle-') > 0
           THEN substr(
             replace(replace(trade_id, char(13), ''), char(10), ''),
             1,
             instr(replace(replace(trade_id, char(13), ''), char(10), ''), '-lifecycle-') - 1
           )
           ELSE replace(replace(trade_id, char(13), ''), char(10), '')
         END IN (?, ?)`,
    ).get(accountId, resolvedRangeName, instrument, side, ...this.idFormsForLookup(resolvedRangeName, bracketId)) as { open_quantity: number } | undefined;
    return (row?.open_quantity ?? 0) > 0;
  }

  hasClosedOrCancelledLifecycleForBracket(
    accountId: string,
    rangeName: string,
    instrument: string,
    side: 'long' | 'short',
    bracketId: string,
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM trade_events
       WHERE account_id = ?
         AND range_name = ? COLLATE BINARY
         AND instrument = ?
         AND side = ?
         AND event_type IN ('entry_cancelled', 'trade_closed')
         AND CASE
           WHEN instr(replace(replace(trade_id, char(13), ''), char(10), ''), '-lifecycle-') > 0
           THEN substr(
             replace(replace(trade_id, char(13), ''), char(10), ''),
             1,
             instr(replace(replace(trade_id, char(13), ''), char(10), ''), '-lifecycle-') - 1
           )
           ELSE replace(replace(trade_id, char(13), ''), char(10), '')
         END IN (?, ?)
       LIMIT 1`,
    ).get(accountId, resolvedRangeName, instrument, side, ...this.idFormsForLookup(resolvedRangeName, bracketId)) as { 1: number } | undefined;
    return Boolean(row);
  }

  findProxyDeliveryForRetry(id: string): { delivery: ProxyDelivery; payloadJson: string; rangeName?: string } | undefined {
    const row = this.db.prepare(
      `SELECT proxy_deliveries.id, proxy_deliveries.proxy_alert_id, proxy_deliveries.range_route_id,
       proxy_deliveries.user_id, proxy_deliveries.account_id, proxy_deliveries.extension_enabled,
       proxy_deliveries.traderspost_enabled, proxy_deliveries.draft_id, proxy_deliveries.qualified_trade_id, proxy_deliveries.status,
       proxy_deliveries.created_at, proxy_alerts.payload_json, proxy_alerts.range_name
       FROM proxy_deliveries JOIN proxy_alerts ON proxy_alerts.id = proxy_deliveries.proxy_alert_id
       WHERE proxy_deliveries.id = ?`,
    ).get(id) as unknown as (ProxyDeliveryRow & { payload_json: string; range_name: string | null }) | undefined;
    return row && {
      delivery: this.toProxyDelivery(row),
      payloadJson: row.payload_json,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
    };
  }

  findProxyDeliveryByDraftId(userId: string, draftId: string): ProxyDelivery | undefined {
    const row = this.db.prepare(
      `SELECT id, proxy_alert_id, range_route_id, user_id, account_id, extension_enabled, traderspost_enabled,
       draft_id, qualified_trade_id, status, created_at
       FROM proxy_deliveries
       WHERE user_id = ? AND draft_id = ?`,
    ).get(userId, draftId) as unknown as ProxyDeliveryRow | undefined;
    return row && this.toProxyDelivery(row);
  }

  listSubmittedRouteDeliveries(rangeRouteId: string): Array<{ delivery: ProxyDelivery; draft: OrderDraft }> {
    const rows = this.db.prepare(
      `SELECT proxy_deliveries.id, proxy_deliveries.proxy_alert_id, proxy_deliveries.range_route_id,
       proxy_deliveries.user_id, proxy_deliveries.account_id, proxy_deliveries.extension_enabled,
       proxy_deliveries.traderspost_enabled, proxy_deliveries.draft_id, proxy_deliveries.qualified_trade_id,
       proxy_deliveries.status, proxy_deliveries.created_at,
       order_drafts.id AS order_draft_id, order_drafts.user_id AS order_draft_user_id, order_drafts.idempotency_key,
       order_drafts.status AS order_draft_status, order_drafts.payload_json AS order_draft_payload_json,
       order_drafts.received_at AS order_draft_received_at, order_drafts.reviewed_at AS order_draft_reviewed_at,
       order_drafts.submitted_at AS order_draft_submitted_at, order_drafts.extension_eligible AS order_draft_extension_eligible
       FROM proxy_deliveries
       JOIN order_drafts ON order_drafts.id = proxy_deliveries.draft_id
       WHERE proxy_deliveries.range_route_id = ? AND order_drafts.status = 'submitted'
       ORDER BY order_drafts.submitted_at DESC, order_drafts.received_at DESC`,
    ).all(rangeRouteId) as unknown as Array<ProxyDeliveryRow & {
      order_draft_id: string;
      order_draft_user_id: string;
      idempotency_key: string;
      order_draft_status: DraftStatus;
      order_draft_payload_json: string;
      order_draft_received_at: string;
      order_draft_reviewed_at: string | null;
      order_draft_submitted_at: string | null;
      order_draft_extension_eligible: number;
    }>;
    return rows.map((row) => ({
      delivery: this.toProxyDelivery(row),
      draft: this.toDraft({
        id: row.order_draft_id,
        user_id: row.order_draft_user_id,
        idempotency_key: row.idempotency_key,
        status: row.order_draft_status,
        payload_json: row.order_draft_payload_json,
        received_at: row.order_draft_received_at,
        reviewed_at: row.order_draft_reviewed_at,
        submitted_at: row.order_draft_submitted_at,
        extension_eligible: row.order_draft_extension_eligible,
      }),
    }));
  }

  listSubmittedRouteDrafts(rangeRouteId: string): OrderDraft[] {
    return this.listSubmittedRouteDeliveries(rangeRouteId).map((row) => row.draft);
  }

  qualifyProxyDeliveryTrade(id: string, tradeId: string): ProxyDelivery | undefined {
    const result = this.db.prepare(
      'UPDATE proxy_deliveries SET qualified_trade_id = ? WHERE id = ?',
    ).run(tradeId, id);
    if (result.changes !== 1) return undefined;
    return this.findProxyDelivery(id);
  }

  listAccountAlerts(userId: string, accountId?: string, limit = 50): AccountAlert[] {
    if (accountId && !this.accountBelongsToUser(accountId, userId)) return [];
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
    const rows = this.db.prepare(
      `SELECT proxy_deliveries.id AS delivery_id, proxy_deliveries.account_id, accounts.name AS account_name,
       proxy_deliveries.user_id, proxy_alerts.received_at, proxy_alerts.range_name, proxy_alerts.action,
       proxy_alerts.ticker, proxy_alerts.source_reference, proxy_deliveries.extension_enabled,
       proxy_deliveries.traderspost_enabled, proxy_deliveries.status AS delivery_status,
       proxy_deliveries.draft_id, order_drafts.status AS draft_status, order_drafts.reviewed_at,
       order_drafts.submitted_at
       FROM proxy_deliveries
       JOIN proxy_alerts ON proxy_alerts.id = proxy_deliveries.proxy_alert_id
       JOIN accounts ON accounts.id = proxy_deliveries.account_id
       LEFT JOIN order_drafts ON order_drafts.id = proxy_deliveries.draft_id
         AND order_drafts.user_id = proxy_deliveries.user_id
       WHERE proxy_deliveries.user_id = ? AND accounts.user_id = ?
         AND (? IS NULL OR proxy_deliveries.account_id = ?)
       ORDER BY proxy_alerts.received_at DESC, proxy_alerts.id DESC, proxy_deliveries.id DESC
       LIMIT ?`,
    ).all(userId, userId, accountId ?? null, accountId ?? null, safeLimit) as unknown as AccountAlertRow[];
    return rows.map((row) => this.toAccountAlert(row));
  }

  // Tickers whose buy/sell alerts actually reached (or may have reached) TradersPost.
  // Suppressed, unrouted, and unconfigured deliveries never produced broker traffic, so
  // they must not count as submitted state for flatten/reconcile tooling. A failed
  // delivery whose ledger rows are all definite rejections likewise produced no broker
  // state; an uncertain failure or missing ledger row still counts (conservative).
  listAccountRecentTradersPostTickers(accountId: string, hours: number): string[] {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(
      `SELECT DISTINCT pa.ticker
       FROM proxy_deliveries pd
       JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
       WHERE pd.account_id = ?
         AND pa.action IN ('buy', 'sell')
         AND pd.status IN ('pending_traderspost', 'extension_draft_created_and_pending_traderspost', 'traderspost_delivered', 'extension_draft_created_and_traderspost_delivered', 'traderspost_failed', 'extension_draft_created_and_traderspost_failed')
         AND NOT (
           pd.status IN ('traderspost_failed', 'extension_draft_created_and_traderspost_failed')
           AND EXISTS (SELECT 1 FROM broker_orders bo WHERE bo.proxy_delivery_id = pd.id)
           AND NOT EXISTS (SELECT 1 FROM broker_orders bo WHERE bo.proxy_delivery_id = pd.id AND COALESCE(bo.dispatch_status, bo.status) != 'rejected')
         )
         AND pd.created_at >= ?`,
    ).all(accountId, since) as unknown as Array<{ ticker: string }>;
    return rows.map((row) => row.ticker);
  }

  getAccountAlertPulse(userId: string, accountId?: string): { totalReceived: number; pendingCount: number; latestReceivedAt?: string } {
    if (accountId && !this.accountBelongsToUser(accountId, userId)) return { totalReceived: 0, pendingCount: 0 };
    const summary = this.getAccountAlertSummary(userId, accountId);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total_received,
       MAX(proxy_alerts.received_at) AS latest_received_at
        FROM proxy_alerts
        WHERE EXISTS (
          SELECT 1 FROM proxy_deliveries
          WHERE proxy_deliveries.proxy_alert_id = proxy_alerts.id
            AND proxy_deliveries.user_id = ?
            AND (? IS NULL OR proxy_deliveries.account_id = ?)
        ) OR EXISTS (
          SELECT 1 FROM trade_events
          WHERE trade_events.proxy_alert_id = proxy_alerts.id
            AND trade_events.user_id = ?
            AND (? IS NULL OR trade_events.account_id = ?)
        )`,
    ).get(
      userId, accountId ?? null, accountId ?? null,
      userId, accountId ?? null, accountId ?? null,
    ) as {
      total_received: number;
      latest_received_at: string | null;
    };
    return {
      totalReceived: row.total_received,
      pendingCount: summary.extensionPending + summary.traderspostPending,
      ...(row.latest_received_at ? { latestReceivedAt: row.latest_received_at } : {}),
    };
  }

  getAccountAlertSummary(userId: string, accountId?: string): AccountAlertSummary {
    if (accountId && !this.accountBelongsToUser(accountId, userId)) return emptyAccountAlertSummary();
    const row = this.db.prepare(
      `SELECT
       COUNT(proxy_deliveries.id) AS total_received,
       COALESCE(SUM(CASE WHEN order_drafts.status IN ('reviewed', 'submitted', 'rejected', 'expired')
         OR (order_drafts.id IS NULL AND proxy_deliveries.status IN (
           'traderspost_delivered', 'traderspost_failed', 'traderspost_not_configured', 'exit_recorded', 'routing_disabled'
         ) OR (order_drafts.id IS NULL AND proxy_deliveries.status LIKE 'suppressed_%')) THEN 1 ELSE 0 END), 0) AS processed,
       COALESCE(SUM(CASE WHEN order_drafts.status = 'pending' THEN 1 ELSE 0 END), 0) AS extension_pending,
       COALESCE(SUM(CASE WHEN order_drafts.status = 'reviewed' THEN 1 ELSE 0 END), 0) AS extension_reviewed,
       COALESCE(SUM(CASE WHEN order_drafts.status = 'submitted' THEN 1 ELSE 0 END), 0) AS extension_submitted,
       COALESCE(SUM(CASE WHEN order_drafts.status = 'rejected' THEN 1 ELSE 0 END), 0) AS extension_rejected,
       COALESCE(SUM(CASE WHEN proxy_deliveries.status IN (
         'traderspost_delivered', 'extension_draft_created_and_traderspost_delivered'
       ) THEN 1 ELSE 0 END), 0) AS traderspost_delivered,
       COALESCE(SUM(CASE WHEN proxy_deliveries.status IN (
         'pending_traderspost', 'extension_draft_created_and_pending_traderspost'
       ) THEN 1 ELSE 0 END), 0) AS traderspost_pending,
       COALESCE(SUM(CASE WHEN proxy_deliveries.status IN (
         'traderspost_failed', 'extension_draft_created_and_traderspost_failed'
       ) THEN 1 ELSE 0 END), 0) AS traderspost_failed,
       COALESCE(SUM(CASE WHEN proxy_deliveries.status = 'traderspost_not_configured' THEN 1 ELSE 0 END), 0)
         AS traderspost_not_configured,
       COALESCE(SUM(CASE WHEN proxy_deliveries.status = 'exit_recorded' THEN 1 ELSE 0 END), 0) AS ignored,
       COALESCE(SUM(CASE WHEN proxy_deliveries.status = 'routing_disabled' THEN 1 ELSE 0 END), 0)
         AS no_destination
       FROM proxy_deliveries
       JOIN accounts ON accounts.id = proxy_deliveries.account_id
       LEFT JOIN order_drafts ON order_drafts.id = proxy_deliveries.draft_id
         AND order_drafts.user_id = proxy_deliveries.user_id
       WHERE proxy_deliveries.user_id = ? AND accounts.user_id = ?
         AND (? IS NULL OR proxy_deliveries.account_id = ?)`,
    ).get(userId, userId, accountId ?? null, accountId ?? null) as unknown as AccountAlertSummaryRow;
    return {
      totalReceived: row.total_received,
      processed: row.processed,
      extensionPending: row.extension_pending,
      extensionReviewed: row.extension_reviewed,
      extensionSubmitted: row.extension_submitted,
      extensionRejected: row.extension_rejected,
      traderspostDelivered: row.traderspost_delivered,
      traderspostPending: row.traderspost_pending,
      traderspostFailed: row.traderspost_failed,
      traderspostNotConfigured: row.traderspost_not_configured,
      ignored: row.ignored,
      noDestination: row.no_destination,
    };
  }

  upsertTradersPostAccountDestination(
    userId: string,
    accountId: string,
    webhookUrl: string,
    outboundTicker?: string,
    outboundTickerMode?: 'micros_only',
    enabled = true,
    useLimitPriceTP = false,
    useAlertTP = false,
    eodCancelTime = '16:30',
    eodExitTime = '16:45',
    eodEnabled = true,
    newsFlattenEnabled = false,
    newsFlattenMinutes = 5,
    reapplyOnTradeCloseEnabled = false,
    crossTrade?: { webhookUrl?: string; secretKey?: string; accountName?: string; enabled?: boolean },
    quantityOverride?: { mode: 'percent' | 'fixed' | 'risk'; value: number },
  ): TradersPostAccountDestination | undefined {
    const account = this.db.prepare(
      'SELECT 1 FROM accounts WHERE id = ? AND user_id = ?',
    ).get(accountId, userId);
    if (!account) return undefined;

    const normalizedOutboundTicker = normalizeOutboundTicker(outboundTicker);
    const normalizedOutboundTickerMode = normalizeOutboundTickerMode(outboundTickerMode);
    const updatedAt = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO traderspost_account_destinations (account_id, webhook_url, enabled, outbound_ticker, outbound_ticker_mode, use_limit_price_tp, use_alert_tp, reapply_on_trade_close_enabled, eod_cancel_time, eod_exit_time, eod_enabled, news_flatten_enabled, news_flatten_minutes, cross_trade_webhook_url, cross_trade_secret_key, cross_trade_account_name, cross_trade_enabled, quantity_override_mode, quantity_override_value, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
          webhook_url = excluded.webhook_url,
          enabled = excluded.enabled,
          outbound_ticker = excluded.outbound_ticker,
          outbound_ticker_mode = excluded.outbound_ticker_mode,
          use_limit_price_tp = excluded.use_limit_price_tp,
          use_alert_tp = excluded.use_alert_tp,
          reapply_on_trade_close_enabled = excluded.reapply_on_trade_close_enabled,
          eod_cancel_time = excluded.eod_cancel_time,
          eod_exit_time = excluded.eod_exit_time,
          eod_enabled = excluded.eod_enabled,
          news_flatten_enabled = excluded.news_flatten_enabled,
          news_flatten_minutes = excluded.news_flatten_minutes,
          cross_trade_webhook_url = excluded.cross_trade_webhook_url,
          cross_trade_secret_key = excluded.cross_trade_secret_key,
          cross_trade_account_name = excluded.cross_trade_account_name,
          cross_trade_enabled = excluded.cross_trade_enabled,
          quantity_override_mode = excluded.quantity_override_mode,
          quantity_override_value = excluded.quantity_override_value,
          updated_at = excluded.updated_at`,
    ).run(
      accountId,
      webhookUrl,
      enabled ? 1 : 0,
      normalizedOutboundTicker ?? null,
      normalizedOutboundTickerMode ?? null,
      useLimitPriceTP ? 1 : 0,
      useAlertTP ? 1 : 0,
      reapplyOnTradeCloseEnabled ? 1 : 0,
      eodCancelTime,
      eodExitTime,
      eodEnabled ? 1 : 0,
      newsFlattenEnabled ? 1 : 0,
      newsFlattenMinutes,
      crossTrade?.webhookUrl || null,
      crossTrade?.secretKey || null,
      crossTrade?.accountName || null,
      crossTrade?.enabled == null ? null : crossTrade.enabled ? 1 : 0,
      quantityOverride && quantityOverride.value > 0 ? quantityOverride.mode : null,
      quantityOverride && quantityOverride.value > 0 ? quantityOverride.value : null,
      updatedAt,
    );
    return {
      accountId,
      webhookUrl,
      enabled,
      ...(normalizedOutboundTicker ? { outboundTicker: normalizedOutboundTicker } : {}),
      ...(normalizedOutboundTickerMode ? { outboundTickerMode: normalizedOutboundTickerMode } : {}),
      useLimitPriceTP,
      useAlertTP,
      reapplyOnTradeCloseEnabled,
      eodCancelTime,
      eodExitTime,
      eodEnabled,
      newsFlattenEnabled,
      newsFlattenMinutes,
      ...(crossTrade?.webhookUrl ? { crossTradeWebhookUrl: crossTrade.webhookUrl } : {}),
      ...(crossTrade?.secretKey ? { crossTradeSecretKey: crossTrade.secretKey } : {}),
      ...(crossTrade?.accountName ? { crossTradeAccountName: crossTrade.accountName } : {}),
      ...(crossTrade?.enabled != null ? { crossTradeEnabled: crossTrade.enabled } : {}),
      ...(quantityOverride && quantityOverride.value > 0
        ? { quantityOverrideMode: quantityOverride.mode, quantityOverrideValue: quantityOverride.value }
        : {}),
      updatedAt,
    };
  }

  getTradersPostAccountDestination(accountId: string): TradersPostAccountDestination | undefined {
    const row = this.db.prepare(
      'SELECT account_id, webhook_url, enabled, outbound_ticker, outbound_ticker_mode, use_limit_price_tp, use_alert_tp, reapply_on_trade_close_enabled, eod_cancel_time, eod_exit_time, eod_enabled, news_flatten_enabled, news_flatten_minutes, cross_trade_webhook_url, cross_trade_secret_key, cross_trade_account_name, cross_trade_enabled, quantity_override_mode, quantity_override_value, updated_at FROM traderspost_account_destinations WHERE account_id = ?',
    ).get(accountId) as unknown as TradersPostAccountDestinationRow | undefined;
    return row && mapTradersPostDestinationRow(row);
  }

  listEnabledBrokerRouteCounts(userId: string): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT account_id, COUNT(*) AS cnt
       FROM range_routes
       WHERE user_id = ? AND traderspost_enabled = 1
       GROUP BY account_id`,
    ).all(userId) as unknown as Array<{ account_id: string; cnt: number }>;
    return Object.fromEntries(rows.map((row) => [row.account_id, row.cnt]));
  }

  listTradersPostAccountDestinations(userId: string): TradersPostAccountDestination[] {
    const rows = this.db.prepare(
      `SELECT destination.account_id, destination.webhook_url, destination.enabled, destination.outbound_ticker, destination.outbound_ticker_mode, destination.use_limit_price_tp, destination.use_alert_tp, destination.reapply_on_trade_close_enabled, destination.eod_cancel_time, destination.eod_exit_time, destination.eod_enabled, destination.news_flatten_enabled, destination.news_flatten_minutes, destination.cross_trade_webhook_url, destination.cross_trade_secret_key, destination.cross_trade_account_name, destination.cross_trade_enabled, destination.quantity_override_mode, destination.quantity_override_value, destination.updated_at
       FROM traderspost_account_destinations AS destination
       JOIN accounts ON accounts.id = destination.account_id
       WHERE accounts.user_id = ?`,
    ).all(userId) as unknown as TradersPostAccountDestinationRow[];
    return rows.map(mapTradersPostDestinationRow);
  }

  getArmedBracketsForReapply(
    accountId: string,
    instrument: string,
    excludeRangeName?: string,
  ): Array<{ rangeName: string; bracketId: string; tradeId: string; side: 'long' | 'short'; quantity: number; entryPrice: number | null }> {
    const resolvedExclude = excludeRangeName == null ? undefined : this.resolveRangeName(excludeRangeName) ?? excludeRangeName;
    const sql = resolvedExclude == null
      ? `SELECT range_name, bracket_id, trade_id, side, quantity, entry_price
         FROM bracket_monitor
         WHERE account_id = ? AND instrument = ? AND state = 'armed'`
      : `SELECT range_name, bracket_id, trade_id, side, quantity, entry_price
         FROM bracket_monitor
         WHERE account_id = ? AND instrument = ? AND state = 'armed' AND range_name != ? COLLATE BINARY`;
    const params = resolvedExclude == null ? [accountId, instrument] : [accountId, instrument, resolvedExclude];
    const rows = this.db.prepare(sql).all(...params) as unknown as Array<{
      range_name: string;
      bracket_id: string;
      trade_id: string;
      side: string;
      quantity: number;
      entry_price: number | null;
    }>;
    return rows.map((row) => ({
      rangeName: row.range_name,
      bracketId: row.bracket_id,
      tradeId: row.trade_id,
      side: row.side as 'long' | 'short',
      quantity: row.quantity,
      entryPrice: row.entry_price,
    }));
  }

  listBracketIdsForBase(
    accountId: string,
    base: string,
    side: 'long' | 'short',
  ): string[] {
    const rows = this.db.prepare(
      `SELECT bracket_id FROM bracket_monitor
       WHERE account_id = ? AND bracket_id GLOB ?`,
    ).all(accountId, `${base}-${side}-arm-*`) as unknown as Array<{ bracket_id: string }>;
    return rows.map((row) => row.bracket_id);
  }

  getOriginalBracketPayload(bracketId: string, accountId?: string, side?: 'long' | 'short'): string | undefined {
    const normalized = bracketId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    const row = this.db.prepare(
      `SELECT pa.payload_json FROM proxy_alerts pa
       WHERE pa.action IN ('buy', 'sell')
         AND json_extract(pa.payload_json, '$.eventType') IS NULL
         AND COALESCE(json_extract(pa.payload_json, '$.extras.preciseTakeProfitAfterFill'), 0) != 1
         AND (? IS NULL OR pa.action = ?)
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM proxy_deliveries pd WHERE pd.proxy_alert_id = pa.id AND pd.account_id = ?
             AND pd.status IN ('traderspost_delivered', 'extension_draft_created_and_traderspost_delivered')
         ))
         AND (json_extract(pa.payload_json, '$.bracketId') = ? OR json_extract(pa.payload_json, '$.tradeId') = ?)
       ORDER BY pa.received_at DESC, pa.rowid DESC LIMIT 1`,
    ).get(side ?? null, side === 'long' ? 'buy' : 'sell', accountId ?? null, accountId ?? null, normalized, normalized) as { payload_json: string } | undefined;
    return row?.payload_json;
  }

  listActiveBracketMonitorEntries(accountId: string): BracketMonitorEntry[] {
    const rows = this.db.prepare("SELECT * FROM bracket_monitor WHERE account_id = ? AND state IN ('armed', 'filled')").all(accountId) as BracketMonitorRow[];
    return rows.map(row => this.toBracketMonitorEntry(row));
  }

  // Cancelled arms too — the sweep's adoption lookup needs the cancelled
  // identities as well, since a locally-retired arm can still have a live leg
  // at the broker. Armed/filled already carry open ledger coverage; cancelled
  // is the state adoption actually revives.
  listBracketMonitorEntriesForAdoption(accountId: string): BracketMonitorEntry[] {
    const rows = this.db.prepare("SELECT * FROM bracket_monitor WHERE account_id = ? AND state IN ('armed', 'filled', 'cancelled')").all(accountId) as BracketMonitorRow[];
    return rows.map(row => this.toBracketMonitorEntry(row));
  }

  getJournalDayStartISO(now: Date = new Date()): string {
    return fixedOffsetDayStart(now, JOURNAL_TIME_OFFSET_MINUTES);
  }

  listStaleBracketMonitorEntries(before: string): BracketMonitorEntry[] {
    const rows = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
       entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
       FROM bracket_monitor
       WHERE state IN ('armed', 'filled')
         AND last_occurred_at < ?`,
    ).all(before) as unknown as BracketMonitorRow[];
    return rows.map((row) => this.toBracketMonitorEntry(row));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    for (const timer of this.userInvalidateTimers.values()) clearTimeout(timer);
    this.userInvalidateTimers.clear();
    this.userInvalidateLastEmit.clear();
    if (this.db.open) this.db.close();
  }

  findReapplyOperation(accountId: string, eventId: string): ReapplyOperation | undefined {
    const row = this.db.prepare('SELECT data_json FROM reapply_operations WHERE account_id = ? AND event_id = ?').get(accountId, eventId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as ReapplyOperation : undefined;
  }

  findReapplyOperationById(id: string): ReapplyOperation | undefined {
    const row = this.db.prepare('SELECT data_json FROM reapply_operations WHERE id = ?').get(id) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as ReapplyOperation : undefined;
  }

  findReapplyOperationForDelivery(deliveryId: string): ReapplyOperation | undefined {
    const row = this.db.prepare(`SELECT op.data_json FROM reapply_operations op, json_each(op.data_json, '$.steps') step
      WHERE json_extract(step.value, '$.deliveryId') = ? LIMIT 1`).get(deliveryId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as ReapplyOperation : undefined;
  }

  dismissCompletedReapplyOperations(): number {
    const rows = this.db.prepare(
      `SELECT id, data_json FROM reapply_operations
       WHERE completed = 1
         AND COALESCE(json_extract(data_json, '$.dismissed'), 0) = 0`,
    ).all() as Array<{ id: string; data_json: string }>;
    const update = this.db.prepare(
      `UPDATE reapply_operations SET data_json = json_set(data_json, '$.dismissed', 1) WHERE id = ?`,
    );
    for (const row of rows) {
      update.run(row.id);
    }
    return rows.length;
  }

  listIncompleteReapplyOperations(): ReapplyOperation[] {
    const rows = this.db.prepare('SELECT data_json FROM reapply_operations WHERE completed = 0 ORDER BY rowid').all() as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as ReapplyOperation);
  }

  listReapplyOperationsForUser(userId: string, limit = 50, includeDismissed = true): ReapplyOperation[] {
    const rows = this.db.prepare(
      `SELECT data_json FROM reapply_operations
       WHERE json_extract(data_json, '$.route.userId') = ?
         AND (? OR COALESCE(json_extract(data_json, '$.dismissed'), 0) = 0)
       ORDER BY json_extract(data_json, '$.createdAt') DESC
       LIMIT ?`,
    ).all(userId, includeDismissed ? 1 : 0, limit) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as ReapplyOperation);
  }

  saveReapplyOperation(operation: ReapplyOperation): void {
    const stored = this.findReapplyOperation(operation.accountId, operation.eventId);
    // Terminal state is terminal: a stale in-flight save must not reopen an operation
    // that was completed/dismissed externally (e.g. the debugging clear endpoint).
    if (stored?.completed && !operation.completed) {
      operation.completed = true;
      operation.reason = stored.reason ?? operation.reason;
    }
    operation.invalidated ??= stored?.invalidated;
    operation.dismissed ||= stored?.dismissed;
    this.db.prepare(`INSERT INTO reapply_operations (id, account_id, event_id, completed, data_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, event_id) DO UPDATE SET completed = excluded.completed, data_json = excluded.data_json`).run(operation.id, operation.accountId, operation.eventId, Number(operation.completed), JSON.stringify(operation));
  }

  createReapplyDelivery(operation: ReapplyOperation, step: ReapplyStep): ProxyDelivery {
    return this.db.transaction(() => {
      const alert = this.createProxyAlert({ rangeName: step.route.rangeName, action: step.payload.action, ticker: step.payload.ticker, payloadJson: JSON.stringify(step.payload), sourceReference: typeof step.payload.bracketId === 'string' ? step.payload.bracketId : operation.payload.tradeId });
      const delivery = this.createProxyDelivery({ proxyAlertId: alert.id, rangeRouteId: step.route.id, userId: step.route.userId, accountId: step.route.accountId, extensionEnabled: false, traderspostEnabled: true, status: 'pending_traderspost' });
      step.deliveryId = delivery.id;
      this.saveReapplyOperation(operation);
      return delivery;
    })();
  }

  logicalReapplyTradeId(arm: Pick<BracketMonitorEntry, 'accountId' | 'rangeName' | 'bracketId' | 'tradeId'>): string {
    const row = this.db.prepare('SELECT logical_trade_id FROM bracket_reapply_aliases WHERE account_id = ? AND range_name = ? AND current_bracket_id = ? LIMIT 1').get(arm.accountId, arm.rangeName, arm.bracketId) as { logical_trade_id: string } | undefined;
    return row?.logical_trade_id ?? arm.tradeId;
  }

  retireReapplyArm(arm: BracketMonitorEntry, occurredAt: string): void {
    this.db.prepare(`UPDATE bracket_monitor SET state = 'cancelled', last_event_type = 'entry_cancelled', last_event_id = ?, last_occurred_at = ?, updated_at = ?
      WHERE account_id = ? AND range_name = ? AND bracket_id = ? AND side = ? AND state = 'armed'`).run(`${arm.tradeId}-reapply-cancel`, occurredAt, new Date().toISOString(), arm.accountId, arm.rangeName, arm.bracketId, arm.side);
    // The instrument-wide cancel removes this arm's working entry at the broker; keep the
    // dispatch ledger in step so retired arms don't linger as acknowledged orders.
    this.updateOpenEntryBrokerOrderStatus(arm.accountId, arm.rangeName, arm.bracketId, arm.side, 'cancelled', 'bridge');
  }

  // Returns why the replacement monitor row was or wasn't written: 'resolved' means
  // the logical trade already closed/cancelled — if the re-arm request was accepted
  // at the broker, its order may be live with nothing tracking it.
  bindReappliedArm(arm: BracketMonitorEntry, newBracketId: string, occurredAt: string, recordArmed: boolean = false): 'armed' | 'resolved' | 'existing' {
    let outcome: 'armed' | 'resolved' | 'existing' = 'armed';
    this.db.transaction(() => {
      const logicalTradeId = this.logicalReapplyTradeId(arm);
      this.db.prepare('UPDATE bracket_reapply_aliases SET current_bracket_id = ? WHERE account_id = ? AND range_name = ? AND current_bracket_id = ?').run(newBracketId, arm.accountId, arm.rangeName, arm.bracketId);
      this.db.prepare(`INSERT INTO bracket_reapply_aliases (account_id, range_name, original_bracket_id, current_bracket_id, logical_trade_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, range_name, original_bracket_id) DO UPDATE SET current_bracket_id = excluded.current_bracket_id`).run(arm.accountId, arm.rangeName, arm.bracketId, newBracketId, logicalTradeId);
      if (recordArmed) {
        const original = this.db.prepare(
          'SELECT state FROM bracket_monitor WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?',
        ).get(arm.accountId, arm.rangeName, arm.bracketId, arm.side) as { state: string } | undefined;
        // A Pine fill/close that arrived while the re-arm request was in flight already
        // resolved the logical trade on the original row; do not add a second active row.
        // A Pine entry_cancelled or trade_closed does the same: the monitor row may already
        // carry our own reapply retire marker, so the journal (which reapply never writes to)
        // decides.
        const externallyResolved = this.hasEntryCancellationEvent(arm.accountId, arm.rangeName, logicalTradeId)
          || this.hasTradeClosedEvent(arm.accountId, arm.rangeName, logicalTradeId);
        if (original?.state === 'filled' || original?.state === 'closed' || externallyResolved) {
          outcome = 'resolved';
          return;
        }
        const replacement = this.db.prepare(
          'SELECT state FROM bracket_monitor WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?',
        ).get(arm.accountId, arm.rangeName, newBracketId, arm.side) as { state: string } | undefined;
        // Retry passes re-bind delivered steps; never overwrite a replacement row that has
        // already moved past armed (Pine fill/close via alias) or been deliberately cancelled.
        if (replacement && replacement.state !== 'armed') {
          outcome = 'existing';
          return;
        }
        const now = new Date().toISOString();
        // Monitor-only armed row for the replacement bracket; no journal event is written.
        this.db.prepare(
          `INSERT INTO bracket_monitor (
            account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
            entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'armed', ?, ?, ?, 0, ?, 'entry_armed', ?, ?, ?)
          ON CONFLICT(account_id, range_name, bracket_id, side) DO UPDATE SET
            instrument = excluded.instrument,
            state = 'armed',
            quantity = excluded.quantity,
            trade_id = excluded.trade_id,
            entry_price = excluded.entry_price,
            last_event_id = excluded.last_event_id,
            last_event_type = excluded.last_event_type,
            last_occurred_at = excluded.last_occurred_at,
            updated_at = excluded.updated_at`,
        ).run(
          arm.accountId,
          arm.rangeName,
          newBracketId,
          arm.side,
          arm.instrument,
          arm.quantity,
          newBracketId,
          arm.entryPrice ?? null,
          `${newBracketId}-reapply-armed`,
          occurredAt,
          now,
          now,
        );
      }
    })();
    return outcome;
  }

  // True when a Pine (or synthetic cleanup) entry_cancelled exists in the journal for the
  // logical trade. Reapply's own retireReapplyArm writes no trade_events, so this
  // distinguishes an external cancellation from our own bookkeeping cancel.
  hasEntryCancellationEvent(accountId: string, rangeName: string, logicalTradeId: string): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    return Boolean(this.db.prepare(
      `SELECT 1 FROM trade_events
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND event_type = 'entry_cancelled' AND trade_id IN (?, ?)
       LIMIT 1`,
    ).get(accountId, resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, logicalTradeId)));
  }

  // The journal records trade_closed even when the monitor row already carries our
  // own reapply retire marker, so a close can be present only in trade_events.
  hasTradeClosedEvent(accountId: string, rangeName: string, logicalTradeId: string): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    return Boolean(this.db.prepare(
      `SELECT 1 FROM trade_events
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND event_type = 'trade_closed' AND trade_id IN (?, ?)
       LIMIT 1`,
    ).get(accountId, resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, logicalTradeId)));
  }

  createBrokerOrder(input: Omit<BrokerOrder, 'id' | 'createdAt' | 'updatedAt'>): BrokerOrder {
    const id = randomUUID();
    const now = new Date().toISOString();
    const resolvedRangeName = this.resolveStoredRangeName(input.rangeName) ?? this.resolveRangeName(input.rangeName) ?? input.rangeName;
    this.db.prepare(
      `INSERT INTO broker_orders (
        id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
        price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, destination, payload_json, occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.accountId,
      resolvedRangeName,
      input.bracketId ?? null,
      input.orderId,
      input.action,
      input.status,
      input.instrument,
      input.side ?? null,
      input.quantity ?? null,
      input.price ?? null,
      input.stopPrice ?? null,
      input.limitPrice ?? null,
      input.proxyAlertId ?? null,
      input.proxyDeliveryId ?? null,
      input.errorText ?? null,
      input.destination ?? null,
      input.payloadJson ?? null,
      input.occurredAt,
      now,
      now,
    );
    const dispatchStatus = input.dispatchStatus ?? (['pending', 'acknowledged', 'rejected', 'uncertain'].includes(input.status) ? input.status : undefined);
    const statusSource = input.statusSource ?? (dispatchStatus ? 'dispatch' : 'legacy');
    this.db.prepare('UPDATE broker_orders SET dispatch_status = ?, status_source = ? WHERE id = ?').run(dispatchStatus ?? null, statusSource, id);
    return { ...input, dispatchStatus, statusSource, rangeName: resolvedRangeName, id, createdAt: now, updatedAt: now };
  }

  // Records a dispatch attempt; a retry for the same order id resets the row to pending
  // so the ledger reflects the latest attempt rather than multiplying rows.
  upsertBrokerOrder(input: Omit<BrokerOrder, 'id' | 'createdAt' | 'updatedAt'>): BrokerOrder {
    const existing = this.findBrokerOrder(input.accountId, input.orderId);
    if (!existing) return this.createBrokerOrder(input);
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE broker_orders SET status = 'pending', dispatch_status = 'pending', status_source = 'dispatch', error_text = NULL, instrument = ?, side = ?, quantity = ?,
       price = ?, stop_price = ?, limit_price = ?, proxy_alert_id = ?, proxy_delivery_id = ?, destination = COALESCE(?, destination),
       payload_json = COALESCE(?, payload_json), occurred_at = ?, updated_at = ?
       WHERE account_id = ? AND order_id = ?`,
    ).run(
      input.instrument,
      input.side ?? null,
      input.quantity ?? null,
      input.price ?? null,
      input.stopPrice ?? null,
      input.limitPrice ?? null,
      input.proxyAlertId ?? null,
      input.proxyDeliveryId ?? null,
      input.destination ?? null,
      input.payloadJson ?? null,
      input.occurredAt,
      now,
      input.accountId,
      input.orderId,
    );
    return { ...existing, ...input, updatedAt: now };
  }

  findBrokerOrder(accountId: string, orderId: string): BrokerOrder | undefined {
    const row = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE account_id = ? AND order_id = ?`,
    ).get(accountId, orderId);
    return row ? this.toBrokerOrder(row) : undefined;
  }

  // Order ids are globally unique (bridge-<uuid>), so operator reconciliation
  // can find a row without knowing its account.
  findBrokerOrderByOrderId(orderId: string): BrokerOrder | undefined {
    const row = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE order_id = ?`,
    ).get(orderId);
    return row ? this.toBrokerOrder(row) : undefined;
  }

  // Inbound failure-email attribution: a bracket id echoes back in the TradersPost
  // payload, so any ledger row with it (any status) identifies the owning account
  // even when the matching order was already resolved.
  findBrokerOrdersByBracketId(bracketId: string): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE bracket_id = ? ORDER BY created_at DESC`,
    ).all(bracketId) as unknown[];
    return rows.map(r => this.toBrokerOrder(r));
  }

  // True when an entry order was actually dispatched for this bracket — i.e. a
  // broker_orders row exists in any non-rejected state. Rejected rows prove the
  // order never existed at the broker. No row at all means the send never ran
  // (wedged queue, suppressed preflight, disabled route), so a Pine `filled`
  // monitor for it is simulated state, not broker evidence.
  // The check reads dispatch_status first: a lifecycle or operator write can
  // later overwrite status (e.g. a Pine fill marking a rejected send `filled`),
  // but dispatch_status still records that the send itself was rejected. Rows
  // with no dispatch_status fall back to the effective status.
  // The action encodes the side (long→buy, short→sell); `side IS NULL` covers
  // entry payloads without bracketSide and legacy rows that never stored one.
  // Positive broker confirmation: NT8's book once answered about THIS attempt —
  // a probe/verify resolution (error_text 'NT8 order state: …') or a verified
  // terminal/filled state. A bare webhook 200 is only CrossTrade ACKing the
  // send — it is not evidence NT8 accepted the order. Scoped to the LATEST
  // attempt so a reused bracketId can't inherit an old cycle's confirmation.
  hasBrokerConfirmedEntryOrder(accountId: string, rangeName: string, bracketId: string, side: 'long' | 'short'): boolean {
    const row = this.db.prepare(
      `SELECT status, status_source, error_text FROM broker_orders
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id IN (?, ?) AND (side = ? OR side IS NULL)
         AND action = ? AND destination = 'crosstrade'
       ORDER BY occurred_at DESC
       LIMIT 1`,
    ).get(accountId, rangeName, ...this.idFormsForLookup(rangeName, bracketId), side, side === 'long' ? 'buy' : 'sell') as
      | { status: string; status_source: string | null; error_text: string | null } | undefined;
    if (!row) return false;
    // 'NT8 order state: X' is the probe's recorded answer — only live/working
    // or filled states count as entry-fill evidence; cancelled/rejected are
    // proof the position never opened.
    const nt8State = /NT8 order state:\s*(\w+)/.exec(row.error_text ?? '')?.[1];
    if (nt8State) return /working|accepted|filled|submitted|pending|initialized|triggerpending|changepending|suspended/i.test(nt8State);
    if (row.status_source === 'ct-verified' || row.status_source === 'operator') {
      return !['cancelled', 'rejected'].includes(row.status);
    }
    // 'filled' ledger rows count only when a broker path wrote them — a
    // lifecycle-sourced fill is just Pine's report, not broker evidence.
    return row.status === 'filled' && row.status_source !== 'lifecycle';
  }

  hasAttemptedEntryOrder(accountId: string, rangeName: string, bracketId: string, side: 'long' | 'short'): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM broker_orders
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id IN (?, ?) AND (side = ? OR side IS NULL)
         AND action = ? AND COALESCE(dispatch_status, status) != 'rejected'
       LIMIT 1`,
    ).get(accountId, rangeName, ...this.idFormsForLookup(rangeName, bracketId), side, side === 'long' ? 'buy' : 'sell') as { 1: number } | undefined;
    return Boolean(row);
  }

  // Global account-name lookup for failure-email attribution fallback ("from
  // your strategy Nate"). Case-insensitive; may span multiple users' accounts.
  findAccountsByName(name: string): BridgeAccount[] {
    const rows = this.db.prepare(
      `SELECT id, user_id, name, starting_balance_cents, external_balance_cents, external_balance_at, deprecated, created_at
       FROM accounts WHERE lower(name) = lower(?)`,
    ).all(name) as unknown as AccountRow[];
    return rows.map((row) => this.toAccount(row));
  }

  updateBrokerOrderStatus(accountId: string, orderId: string, status: BrokerOrderState, errorText?: string, proxyDeliveryId?: string, source: BrokerOrder['statusSource'] = 'dispatch'): void {
    const now = new Date().toISOString();
    // A dispatch response must not regress a row a non-dispatch writer already
    // resolved: a Pine `entry_filled` that landed while the request was in
    // flight must not be overwritten back to `acknowledged` when the late HTTP
    // success arrives. The dispatch outcome is still recorded in
    // dispatch_status; only status/status_source are preserved.
    this.db.prepare(
      `UPDATE broker_orders SET
       status = CASE WHEN ? = 'dispatch' AND status_source IN ('lifecycle','bridge','operator','email','ct-verified')
                     AND status IN ('filled','closed','cancelled','rejected') THEN status ELSE ? END,
       status_source = CASE WHEN ? = 'dispatch' AND status_source IN ('lifecycle','bridge','operator','email','ct-verified')
                            AND status IN ('filled','closed','cancelled','rejected') THEN status_source ELSE ? END,
       dispatch_status = CASE WHEN ? = 'dispatch' THEN ? ELSE dispatch_status END,
       error_text = COALESCE(?, error_text), proxy_delivery_id = COALESCE(?, proxy_delivery_id), updated_at = ?
       WHERE account_id = ? AND order_id = ?`,
    ).run(source, status, source, source, source, status, errorText ?? null, proxyDeliveryId ?? null, now, accountId, orderId);
    const account = this.findAccountById(accountId);
    if (account) this.invalidateUserCache(account.userId);
  }

  // Transitions open entry dispatches (buy for long, sell for short) for a bracket, so a
  // Pine lifecycle event resolves the ordinary entry row as well as reapply-bound rows.
  // Mirrors the monitor model: a filled order can close but cannot be cancelled, and a
  // cancelled row may still be filled when Pine reports events out of order.
  // range_name scopes the lookup because Ultra bracket_ids are not range-unique: two
  // ranges sharing an instrument and anchor epoch mint identical bracket_ids, and an
  // unscoped match would resolve the other range's ledger rows.
  private updateOpenEntryBrokerOrderStatus(accountId: string, rangeName: string, bracketId: string, side: string, status: BrokerOrderState, source: BrokerOrder['statusSource'] = 'lifecycle'): void {
    const action = side === 'long' ? 'buy' : 'sell';
    const sources = status === 'closed'
      ? "('pending', 'acknowledged', 'uncertain', 'filled')"
      : status === 'filled'
        ? "('pending', 'acknowledged', 'uncertain', 'cancelled')"
        : "('pending', 'acknowledged', 'uncertain')";
    // A lifecycle event resolves only the current logical attempt: resent orders
    // share the bracket_id, so transitioning every open row would silently mark a
    // still-uncertain earlier request as resolved and lose the per-attempt
    // uncertainty this ledger preserves.
    this.db.prepare(
      `UPDATE broker_orders SET status = ?, status_source = ?, updated_at = ?
       WHERE rowid = (
         SELECT MAX(rowid) FROM broker_orders
         WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id IN (?, ?) AND (side = ? OR side IS NULL) AND action = ?
       ) AND status IN ${sources}`,
    ).run(status, source, new Date().toISOString(), accountId, rangeName, ...this.idFormsForLookup(this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName) ?? rangeName, bracketId), side, action);
  }

  listBrokerOrdersByAccount(accountId: string, limit = 100): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(accountId, limit) as unknown[];
    return rows.map(r => this.toBrokerOrder(r));
  }

  // The admin debugging ledger spans every user's accounts — the clear/flatten
  // controls operate cross-user, so the displayed ledger must too. Rows carry the
  // joined account name since the admin's own account list can't supply it.
  listAllBrokerOrders(limit = 200): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT bo.id, bo.account_id, bo.range_name, bo.bracket_id, bo.order_id, bo.action, bo.status, bo.instrument, bo.side, bo.quantity,
       bo.price, bo.stop_price, bo.limit_price, bo.proxy_alert_id, bo.proxy_delivery_id, bo.error_text, bo.occurred_at, bo.created_at, bo.updated_at,
       a.name AS account_name, bo.dispatch_status, bo.status_source, bo.destination
       FROM broker_orders bo JOIN accounts a ON a.id = bo.account_id
       ORDER BY bo.created_at DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({ ...this.toBrokerOrder(r), accountName: r.account_name as string }));
  }

  // User-scoped variant of listAllBrokerOrders for the Monitoring page, which is
  // available to every signed-in user rather than only the admin.
  listBrokerOrdersForUser(userId: string, limit = 200): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT bo.id, bo.account_id, bo.range_name, bo.bracket_id, bo.order_id, bo.action, bo.status, bo.instrument, bo.side, bo.quantity,
       bo.price, bo.stop_price, bo.limit_price, bo.proxy_alert_id, bo.proxy_delivery_id, bo.error_text, bo.occurred_at, bo.created_at, bo.updated_at,
       a.name AS account_name, bo.dispatch_status, bo.status_source, bo.destination
       FROM broker_orders bo JOIN accounts a ON a.id = bo.account_id
       WHERE a.user_id = ?
       ORDER BY bo.created_at DESC LIMIT ?`,
    ).all(userId, limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({ ...this.toBrokerOrder(r), accountName: r.account_name as string }));
  }

  // Range-scoped variant for the per-range detail page. userId scopes the
  // listing to that user's accounts; undefined returns all accounts (admin).
  listBrokerOrdersByRange(rangeName: string, userId: string | undefined, limit = 60): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT bo.id, bo.account_id, bo.range_name, bo.bracket_id, bo.order_id, bo.action, bo.status, bo.instrument, bo.side, bo.quantity,
       bo.price, bo.stop_price, bo.limit_price, bo.proxy_alert_id, bo.proxy_delivery_id, bo.error_text, bo.occurred_at, bo.created_at, bo.updated_at,
       a.name AS account_name, bo.dispatch_status, bo.status_source, bo.destination
       FROM broker_orders bo JOIN accounts a ON a.id = bo.account_id
       WHERE bo.range_name = ? COLLATE BINARY ${userId ? 'AND a.user_id = ?' : ''}
       ORDER BY bo.created_at DESC LIMIT ?`,
    ).all(...(userId ? [rangeName, userId, limit] : [rangeName, limit])) as Array<Record<string, unknown>>;
    return rows.map(r => ({ ...this.toBrokerOrder(r), accountName: r.account_name as string }));
  }

  findProxyAlert(id: string): { alertId: string; receivedAt: string; rangeName?: string; action: 'buy' | 'sell' | 'cancel' | 'exit'; ticker: string; payloadJson: string } | undefined {
    const row = this.db.prepare(
      `SELECT id, received_at, range_name, action, ticker, payload_json
       FROM proxy_alerts WHERE id = ?`,
    ).get(id) as { id: string; received_at: string; range_name: string | null; action: 'buy' | 'sell' | 'cancel' | 'exit'; ticker: string; payload_json: string } | undefined;
    return row && {
      alertId: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      action: row.action,
      ticker: row.ticker,
      payloadJson: row.payload_json,
    };
  }

  listRecentProxyAlertsByRange(rangeName: string, limit = 25): Array<{
    alertId: string;
    receivedAt: string;
    rangeName?: string;
    action: 'buy' | 'sell' | 'cancel' | 'exit';
    ticker: string;
    payloadJson: string;
  }> {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT id, received_at, range_name, action, ticker, payload_json
       FROM proxy_alerts
       WHERE range_name = ? COLLATE BINARY
       ORDER BY received_at DESC, id DESC LIMIT ?`,
    ).all(resolvedRangeName, limit) as Array<{
      id: string;
      received_at: string;
      range_name: string | null;
      action: 'buy' | 'sell' | 'cancel' | 'exit';
      ticker: string;
      payload_json: string;
    }>;
    return rows.map((row) => ({
      alertId: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      action: row.action,
      ticker: row.ticker,
      payloadJson: row.payload_json,
    }));
  }

  // All routes for a range across users, joined to account name and destination
  // state — the resend card on the range detail page picks targets from this.
  listRangeRoutesByRangeName(rangeName: string): Array<RangeRoute & { accountName: string; accountUserId: string; destinationEnabled: boolean }> {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT rr.id, rr.range_name, rr.user_id, rr.account_id, rr.extension_enabled, rr.traderspost_enabled, rr.run_scheduled,
              rr.created_at, rr.updated_at, a.name AS account_name, a.user_id AS account_user_id,
              COALESCE(d.enabled, 0) AS destination_enabled
       FROM range_routes rr
       JOIN accounts a ON a.id = rr.account_id
       LEFT JOIN traderspost_account_destinations d ON d.account_id = rr.account_id
       WHERE rr.range_name = ? COLLATE BINARY
       ORDER BY a.name ASC`,
    ).all(resolvedRangeName) as Array<RangeRouteRow & { account_name: string; account_user_id: string; destination_enabled: number }>;
    return rows.map((row) => ({
      ...this.toRangeRoute(row),
      accountName: row.account_name,
      accountUserId: row.account_user_id,
      destinationEnabled: row.destination_enabled === 1,
    }));
  }

  // Unbounded, status-filtered listing for flatten decisions — the display-capped
  // listBrokerOrdersByAccount can hide older submitted-state rows once an account
  // has more rows than the cap.
  listOpenBrokerOrdersByAccount(accountId: string): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE account_id = ? AND status IN ('pending', 'acknowledged', 'uncertain')
       ORDER BY created_at DESC`,
    ).all(accountId) as unknown[];
    return rows.map(r => this.toBrokerOrder(r));
  }

  // Unresolved CrossTrade dispatches across all accounts, older than the grace
  // cutoff — the reconciliation sweep's work list. Entry actions only: cancel
  // and exit are commands, not orders, so there is nothing at NT8 to look up.
  // pending/uncertain rows past the grace window are probed every sweep.
  // acknowledged rows are probed too — a webhook ACK only means CrossTrade
  // received the command; NT8 can still reject the order asynchronously —
  // but only within ackHorizonIso and only until confirmed once ('ct-verified'),
  // so a healthy order is not re-probed every minute forever.
  listUnresolvedCrossTradeOrdersBefore(cutoffIso: string, ackHorizonIso?: string): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders
       WHERE destination = 'crosstrade'
         AND action IN ('buy', 'sell') AND occurred_at < ?
         AND bracket_id IS NOT NULL
         AND (status IN ('pending', 'uncertain')
              OR (status = 'acknowledged'
                  AND (status_source IS NULL OR status_source <> 'ct-verified')
                  AND (? IS NULL OR occurred_at >= ?)))
       ORDER BY occurred_at`,
    ).all(cutoffIso, ackHorizonIso ?? null, ackHorizonIso ?? null) as unknown[];
    return rows.map(r => this.toBrokerOrder(r));
  }

  // Every account that ever dispatched to CT or holds bracket state — the
  // sweep's adoption universe. A live NT8 leg whose local bookkeeping is gone
  // (monitor cancelled, ledger resolved) appears in no activity-scoped list,
  // so the sweep needs this full set to recognize orphaned wire ids.
  listAccountsWithCrossTradeOrders(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT account_id FROM broker_orders WHERE destination = 'crosstrade'
       UNION SELECT DISTINCT account_id FROM bracket_monitor`,
    ).all() as { account_id: string }[];
    return rows.map((r) => r.account_id);
  }

  // Entry (buy/sell) rows in every status, unbounded — the debugging "Clear"
  // cleanup runs its monitor-retirement pass over these because a terminal
  // ledger row can still cover an armed monitor row (e.g. a broker rejection
  // that landed before Pine's entry_armed bookkeeping).
  listEntryBrokerOrdersByAccount(accountId: string): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE account_id = ? AND action IN ('buy', 'sell')
       ORDER BY created_at DESC`,
    ).all(accountId) as unknown[];
    return rows.map(r => this.toBrokerOrder(r));
  }

  // Broker ledger rows created for one proxy delivery (all attempts). Used by the
  // resend path to refuse dispatching another order while a prior attempt's
  // outcome is still unresolved or already acknowledged at the broker.
  listBrokerOrdersForDelivery(proxyDeliveryId: string): BrokerOrder[] {
    const rows = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE proxy_delivery_id = ? ORDER BY created_at DESC`,
    ).all(proxyDeliveryId) as unknown[];
    return rows.map(r => this.toBrokerOrder(r));
  }

  // Resends of a logical order append -r<n> attempt rows; the newest attempt owns
  // the live status so lifecycle updates must not touch an earlier attempt's row.
  latestBrokerOrderAttempt(accountId: string, baseOrderId: string): BrokerOrder | undefined {
    const row = this.db.prepare(
      `SELECT id, account_id, range_name, bracket_id, order_id, action, status, instrument, side, quantity,
       price, stop_price, limit_price, proxy_alert_id, proxy_delivery_id, error_text, payload_json, occurred_at, created_at, updated_at
       , dispatch_status, status_source, destination, payload_json FROM broker_orders WHERE account_id = ? AND (order_id = ? OR order_id GLOB ?)
       ORDER BY rowid DESC LIMIT 1`,
    ).get(accountId, baseOrderId, `${baseOrderId}-r*`);
    return row ? this.toBrokerOrder(row) : undefined;
  }

  private toBrokerOrder(row: unknown): BrokerOrder {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      accountId: String(r.account_id),
      rangeName: String(r.range_name),
      ...(r.bracket_id != null ? { bracketId: String(r.bracket_id) } : {}),
      orderId: String(r.order_id),
      action: String(r.action) as BrokerOrderAction,
      status: String(r.status) as BrokerOrderState,
      dispatchStatus: r.dispatch_status == null ? undefined : String(r.dispatch_status) as BrokerOrderState,
      statusSource: (r.status_source ?? 'legacy') as BrokerOrder['statusSource'],
      destination: (r.destination ?? 'traderspost') as BrokerOrder['destination'],
      instrument: String(r.instrument),
      ...(r.side != null ? { side: String(r.side) as 'long' | 'short' } : {}),
      ...(r.quantity != null ? { quantity: Number(r.quantity) } : {}),
      ...(r.price != null ? { price: Number(r.price) } : {}),
      ...(r.stop_price != null ? { stopPrice: Number(r.stop_price) } : {}),
      ...(r.limit_price != null ? { limitPrice: Number(r.limit_price) } : {}),
      ...(r.proxy_alert_id ? { proxyAlertId: String(r.proxy_alert_id) } : {}),
      ...(r.proxy_delivery_id ? { proxyDeliveryId: String(r.proxy_delivery_id) } : {}),
      ...(r.error_text ? { errorText: String(r.error_text) } : {}),
      ...(r.payload_json ? { payloadJson: String(r.payload_json) } : {}),
      occurredAt: String(r.occurred_at),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  findExistingBracketForRangeSide(
    accountId: string,
    rangeName: string,
    side: 'long' | 'short',
    since: string,
  ): { bracketId: string; tradeId: string } | undefined {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT bracket_id, trade_id
       FROM bracket_monitor
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND side = ? AND state != 'cancelled' AND last_occurred_at >= ?
       LIMIT 1`,
    ).get(accountId, resolvedRangeName, side, since) as { bracket_id: string; trade_id: string } | undefined;
    return row ? { bracketId: row.bracket_id, tradeId: row.trade_id } : undefined;
  }

  // Bookkeeping-only close for the debugging "Clear" control: open rows move to a
  // terminal state before deleteResolvedBrokerOrdersForAccount purges them.
  closeOpenBrokerOrdersForAccount(accountId: string, note: string): number {
    return this.db.prepare(
      `UPDATE broker_orders
       SET status = CASE WHEN action IN ('buy', 'sell') THEN 'cancelled' ELSE 'closed' END,
           status_source = 'operator', error_text = ?, updated_at = ?
       WHERE account_id = ? AND status IN ('pending', 'acknowledged', 'uncertain')`,
    ).run(note, new Date().toISOString(), accountId).changes;
  }

  // Hard-delete resolved ledger rows for the debugging "Clear" cleanup. 'filled'
  // rows are kept: a filled entry order is the dispatch evidence for a live open
  // position and only becomes 'closed' when the trade closes.
  deleteResolvedBrokerOrdersForAccount(accountId: string): number {
    return this.db.prepare(
      `DELETE FROM broker_orders WHERE account_id = ? AND status IN ('cancelled', 'closed', 'rejected')`,
    ).run(accountId).changes;
  }

  deleteBrokerOrder(accountId: string, orderId: string): boolean {
    return this.db.prepare(
      `DELETE FROM broker_orders WHERE account_id = ? AND order_id = ?`,
    ).run(accountId, orderId).changes > 0;
  }

  listArmedInstrumentsForAccount(accountId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT instrument
         FROM bracket_monitor
         WHERE account_id = ? AND state = 'armed'
         ORDER BY instrument COLLATE NOCASE`,
      )
      .all(accountId) as unknown as Array<{ instrument: string }>;
    return rows.map((row) => row.instrument);
  }

  hasFilledBracketsOnAccountInstrument(
    accountId: string,
    instrument: string,
    excludeRangeName: string,
  ): boolean {
    const resolvedExclude = this.resolveRangeName(excludeRangeName) ?? excludeRangeName;
    const row = this.db.prepare(
      `SELECT 1 FROM bracket_monitor
       WHERE account_id = ? AND instrument = ? AND state = 'filled' AND range_name != ? COLLATE BINARY
       LIMIT 1`,
    ).get(accountId, instrument, resolvedExclude) as { 1: number } | undefined;
    return row != null;
  }

  getOpenBracketOrdersForAccount(
    accountId: string,
  ): Array<{ bracketId: string; ticker: string; tradeId: string; quantity: number; side: 'long' | 'short'; rangeName?: string }> {
    const rows = this.db.prepare(
      `SELECT
         bracket_id,
         instrument AS ticker,
         trade_id,
         quantity,
         side,
         range_name
       FROM bracket_monitor
       WHERE account_id = ?
         AND state = 'armed'`,
    ).all(accountId) as unknown as Array<{ bracket_id: string; ticker: string; trade_id: string; quantity: number; side: 'long' | 'short'; range_name: string }>;
    return rows.map((row) => ({ bracketId: row.bracket_id, ticker: row.ticker, tradeId: row.trade_id, quantity: row.quantity, side: row.side, rangeName: row.range_name }));
  }

  findTradeEventById(userId: string, id: string): TradeEvent | undefined {
    const row = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at,
       adjustment_note, adjusted_at, adjusted_by_user_id, adjusted_by_email
       FROM trade_events
       WHERE id = ? AND user_id = ?`,
    ).get(id, userId) as unknown as TradeEventRow | undefined;
    return row ? this.toTradeEvent(row) : undefined;
  }

  getOpenPositionsForAccount(
    accountId: string,
    instrument: string,
  ): Array<{ rangeName: string; tradeId: string; bracketId: string | null; side: 'long' | 'short'; openQuantity: number; entryPrice?: number }> {
    const eventRows = this.db.prepare(
      `SELECT range_name, trade_id, side,
              SUM(CASE WHEN event_type = 'entry_filled' THEN quantity ELSE -quantity END) AS open_qty,
              MAX(CASE WHEN event_type = 'entry_filled' THEN entry_price END) AS entry_price
       FROM trade_events
       WHERE account_id = ?
         AND instrument = ?
         AND event_type IN ('entry_filled', 'exit_filled', 'trade_closed')
       GROUP BY range_name, trade_id, side
       HAVING open_qty > 0`,
    ).all(accountId, instrument) as unknown as Array<{ range_name: string; trade_id: string; side: 'long' | 'short'; open_qty: number; entry_price: number | null }>;
    const monitorRows = this.db.prepare(
      `SELECT range_name, bracket_id, trade_id, side, quantity AS open_qty, entry_price
       FROM bracket_monitor
       WHERE account_id = ?
         AND instrument = ?
         AND state = 'filled'`,
    ).all(accountId, instrument) as unknown as Array<{ range_name: string; bracket_id: string; trade_id: string; side: 'long' | 'short'; open_qty: number; entry_price: number | null }>;
    const eventTradeIds = new Set(eventRows.map((row) => row.trade_id));
    const rows = [...eventRows.map((row) => ({ ...row, bracket_id: null as string | null })), ...monitorRows.filter((row) => !eventTradeIds.has(row.trade_id))];
    return rows.map((row) => ({
      rangeName: row.range_name,
      tradeId: row.trade_id,
      bracketId: row.bracket_id,
      side: row.side,
      openQuantity: row.open_qty,
      ...(row.entry_price != null ? { entryPrice: row.entry_price } : {}),
    }));
  }

  getEntryOrderTypeForBracket(
    accountId: string,
    bracketId: string,
  ): 'market' | 'limit' | 'stop' | undefined {
    const row = this.db.prepare(
      `SELECT pa.payload_json
       FROM proxy_alerts pa
       JOIN proxy_deliveries pd ON pd.proxy_alert_id = pa.id
       WHERE pd.account_id = ?
         AND pa.source_reference = ?
         AND pa.action IN ('buy', 'sell')
       ORDER BY pa.received_at DESC
       LIMIT 1`,
    ).get(accountId, bracketId) as unknown as { payload_json: string } | undefined;
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.payload_json);
      const orderType = parsed?.orderType;
      if (orderType === 'market' || orderType === 'limit' || orderType === 'stop') return orderType;
    } catch {
      // ignore parse errors
    }
    return undefined;
  }

  createProxyDeliveryAttempt(
    input: Omit<ProxyDeliveryAttempt, 'id' | 'attemptNumber' | 'attemptedAt'>,
  ): ProxyDeliveryAttempt {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number FROM proxy_delivery_attempts WHERE proxy_delivery_id = ?',
    ).get(input.proxyDeliveryId) as { attempt_number: number };
    const attemptNumber = row.attempt_number;
    const attempt: ProxyDeliveryAttempt = {
      ...input,
      id: randomUUID(),
      attemptNumber,
      attemptedAt: new Date().toISOString(),
    };
    const result = this.db.prepare(
      `INSERT INTO proxy_delivery_attempts (
        id, proxy_delivery_id, attempt_number, attempted_at, status_code, success, error_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(proxy_delivery_id, attempt_number) DO NOTHING`,
    ).run(
      attempt.id,
      attempt.proxyDeliveryId,
      attempt.attemptNumber,
      attempt.attemptedAt,
      attempt.statusCode ?? null,
      Number(attempt.success),
      attempt.errorText ?? null,
    );
    if (result.changes === 1) {
      return attempt;
    }
    const existing = this.db.prepare(
      `SELECT id, proxy_delivery_id, attempt_number, attempted_at, status_code, success, error_text
       FROM proxy_delivery_attempts WHERE proxy_delivery_id = ? AND attempt_number = ?`,
    ).get(attempt.proxyDeliveryId, attempt.attemptNumber) as unknown as ProxyDeliveryAttemptRow | undefined;
    if (!existing) return attempt;
    return {
      id: existing.id,
      proxyDeliveryId: existing.proxy_delivery_id,
      attemptNumber: existing.attempt_number,
      attemptedAt: existing.attempted_at,
      ...(existing.status_code != null ? { statusCode: existing.status_code } : {}),
      success: Boolean(existing.success),
      ...(existing.error_text ? { errorText: existing.error_text } : {}),
    };
  }

  listProxyDeliveryAttempts(proxyDeliveryId: string): ProxyDeliveryAttempt[] {
    const rows = this.db.prepare(
      `SELECT id, proxy_delivery_id, attempt_number, attempted_at, status_code, success, error_text
       FROM proxy_delivery_attempts WHERE proxy_delivery_id = ? ORDER BY attempt_number ASC`,
    ).all(proxyDeliveryId) as unknown as ProxyDeliveryAttemptRow[];
    return rows.map((row) => ({
      id: row.id,
      proxyDeliveryId: row.proxy_delivery_id,
      attemptNumber: row.attempt_number,
      attemptedAt: row.attempted_at,
      ...(row.status_code != null ? { statusCode: row.status_code } : {}),
      success: Boolean(row.success),
      ...(row.error_text != null ? { errorText: row.error_text } : {}),
    }));
  }

  createBridgeLog(userId: string, category: string, data: Record<string, unknown>): BridgeLog {
    const log: BridgeLog = {
      id: randomUUID(),
      userId,
      category,
      timestamp: new Date().toISOString(),
      data,
    };
    this.db.prepare(
      `INSERT INTO bridge_logs (id, user_id, category, timestamp, data_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(log.id, log.userId, log.category, log.timestamp, JSON.stringify(log.data));
    this.db.prepare(
      'DELETE FROM bridge_logs WHERE timestamp < ?',
    ).run(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());
    return log;
  }

  // Existence check over the JSON payload — used to dedup warn-once events
  // across restarts (in-memory sets reset on boot; the log row persists).
  hasBridgeLogEntry(input: {
    userId: string;
    category: string;
    event?: string;
    bracketId?: string;
    since: string;
  }): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM bridge_logs
       WHERE user_id = ? AND category = ? AND timestamp >= ?
         AND (? IS NULL OR json_extract(data_json, '$.event') = ?)
         AND (? IS NULL OR json_extract(data_json, '$.bracketId') = ?)
       LIMIT 1`,
    ).get(
      input.userId, input.category, input.since,
      input.event ?? null, input.event ?? null,
      input.bracketId ?? null, input.bracketId ?? null,
    ));
  }

  listBridgeLogs(input: { userId: string; since: string; category?: string; limit?: number }): BridgeLog[] {
    const limit = input.limit ?? 1000;
    if (input.category) {
      const rows = this.db.prepare(
        `SELECT id, user_id, category, timestamp, data_json
         FROM bridge_logs
         WHERE user_id = ? AND category = ? AND timestamp >= ?
         ORDER BY timestamp DESC
         LIMIT ?`,
      ).all(input.userId, input.category, input.since, limit) as unknown as BridgeLogRow[];
      return rows.map((row) => this.toBridgeLog(row));
    }
    const rows = this.db.prepare(
      `SELECT id, user_id, category, timestamp, data_json
       FROM bridge_logs
       WHERE user_id = ? AND timestamp >= ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    ).all(input.userId, input.since, limit) as unknown as BridgeLogRow[];
    return rows.map((row) => this.toBridgeLog(row));
  }

  private toBridgeLog(row: BridgeLogRow): BridgeLog {
    return {
      id: row.id,
      userId: row.user_id,
      category: row.category,
      timestamp: row.timestamp,
      data: (() => {
        try {
          return JSON.parse(row.data_json) as Record<string, unknown>;
        } catch {
          return { raw: row.data_json };
        }
      })(),
    };
  }

  // Process-run forensics: one row per server process lifetime. A row left
  // without clean_exit means the process died without running its exit
  // handlers (SIGKILL/OOM/host kill) — fatal_json captures crash evidence when
  // a handler did run.
  createProcessRun(): string {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO process_runs (id, started_at, node_version, pid)
       VALUES (?, ?, ?, ?)`,
    ).run(id, new Date().toISOString(), process.version, process.pid);
    return id;
  }

  heartbeatProcessRun(id: string, stats: { rssBytes: number; heapUsedBytes: number; eventLoopLagMs: number }): void {
    this.db.prepare(
      `UPDATE process_runs
       SET last_heartbeat_at = ?, rss_bytes = ?, heap_used_bytes = ?, event_loop_lag_ms = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), stats.rssBytes, stats.heapUsedBytes, stats.eventLoopLagMs, id);
  }

  endProcessRun(id: string, input: { exitCode?: number; clean: boolean; fatal?: ProcessRun['fatal']; context?: unknown }): void {
    this.db.prepare(
      `UPDATE process_runs
       SET ended_at = ?, clean_exit = ?, exit_code = ?, fatal_json = COALESCE(?, fatal_json),
           context_json = COALESCE(?, context_json)
       WHERE id = ?`,
    ).run(
      new Date().toISOString(),
      input.clean ? 1 : 0,
      input.exitCode ?? null,
      input.fatal ? JSON.stringify(input.fatal) : null,
      input.context !== undefined ? JSON.stringify(input.context) : null,
      id,
    );
  }

  recordProcessWarning(id: string, warning: { name: string; message: string; stack?: string }): void {
    const existing = (this.db.prepare('SELECT warnings_json FROM process_runs WHERE id = ?').get(id) as { warnings_json: string | null } | undefined)?.warnings_json;
    let warnings: unknown[] = [];
    if (existing) {
      try { warnings = JSON.parse(existing) as unknown[]; } catch { warnings = [{ event: 'unparseable', raw: existing }]; }
    }
    warnings.push({ at: new Date().toISOString(), name: warning.name, message: warning.message, stack: warning.stack });
    if (warnings.length > 25) warnings = warnings.slice(warnings.length - 25);
    this.db.prepare('UPDATE process_runs SET warnings_json = ? WHERE id = ?').run(JSON.stringify(warnings), id);
  }

  updateProcessRunActivity(id: string, activity: unknown): void {
    this.db.prepare('UPDATE process_runs SET last_activity_json = ? WHERE id = ?').run(JSON.stringify(activity), id);
  }

  listProcessRuns(limit = 20): ProcessRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM process_runs ORDER BY started_at DESC LIMIT ?`,
    ).all(limit) as unknown as ProcessRunRow[];
    return rows.map((row) => this.toProcessRun(row));
  }

  listAbnormalProcessRuns(excludeId?: string): ProcessRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM process_runs WHERE clean_exit = 0 AND id != COALESCE(?, '')
       ORDER BY started_at DESC LIMIT 20`,
    ).all(excludeId ?? null) as unknown as ProcessRunRow[];
    return rows.map((row) => this.toProcessRun(row));
  }

  private toProcessRun(row: ProcessRunRow): ProcessRun {
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      cleanExit: row.clean_exit === 1,
      exitCode: row.exit_code ?? undefined,
      fatal: (() => {
        if (!row.fatal_json) return undefined;
        try {
          return JSON.parse(row.fatal_json) as ProcessRun['fatal'];
        } catch {
          return { event: 'unknown', message: row.fatal_json };
        }
      })(),
      lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
      rssBytes: row.rss_bytes ?? undefined,
      heapUsedBytes: row.heap_used_bytes ?? undefined,
      eventLoopLagMs: row.event_loop_lag_ms ?? undefined,
      warnings: (() => {
        if (!row.warnings_json) return undefined;
        try { return JSON.parse(row.warnings_json) as ProcessRun['warnings']; } catch { return [{ message: row.warnings_json }]; }
      })(),
      lastActivity: (() => {
        if (!row.last_activity_json) return undefined;
        try { return JSON.parse(row.last_activity_json) as unknown; } catch { return { unparseable: row.last_activity_json }; }
      })(),
      context: (() => {
        if (!row.context_json) return undefined;
        try { return JSON.parse(row.context_json) as unknown; } catch { return { unparseable: row.context_json }; }
      })(),
      nodeVersion: row.node_version,
      pid: row.pid,
    };
  }

  createTradeEvent(
    input: Omit<TradeEvent, 'id' | 'excludedFromPerformance' | 'exclusionReason' | 'excludedByUserId' | 'exclusionUpdatedAt'>,
  ): { event: TradeEvent; created: boolean } {
    const resolvedRangeName = this.resolveStoredRangeName(input.rangeName) ?? this.resolveRangeName(input.rangeName);
    const event: TradeEvent = {
      ...input,
      rangeName: resolvedRangeName,
      id: randomUUID(),
      excludedFromPerformance: false,
    };
    event.tradeId = event.tradeId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    event.eventId = event.eventId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    const scopedIds = this.unscopeEventIdsForLegacyBracket(event.rangeName, event.side, event.tradeId, event.eventId, event.accountId);
    event.tradeId = scopedIds.tradeId;
    event.eventId = scopedIds.eventId;
    const result = this.db.prepare(
      `INSERT INTO trade_events (
        id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
        quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
        occurred_at, proxy_alert_id, adjustment_note
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, account_id, range_name) DO NOTHING`,
    ).run(
      event.id,
      event.userId,
      event.accountId,
      event.rangeName,
      event.eventId,
      event.tradeId,
      event.eventType,
      event.instrument,
      event.side,
      event.action ?? null,
      event.quantity,
      event.entryPrice ?? null,
      event.exitPrice ?? null,
      event.realizedTicksCents ?? null,
      event.realizedDollarsCents ?? null,
      event.outcome ?? null,
      event.occurredAt,
      event.proxyAlertId ?? null,
      input.adjustmentNote ?? null,
    );
    if (result.changes === 1) {
      this.recordBracketMonitorEvent(event);
      this.invalidateUserCache(input.userId);
      return { event, created: true };
    }

    const existing = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at
       FROM trade_events WHERE event_id = ? AND account_id = ? AND range_name = ? COLLATE BINARY`,
    ).get(event.eventId, event.accountId, event.rangeName) as unknown as TradeEventRow;
    const existingEvent = this.toTradeEvent(existing);
    this.recordBracketMonitorEvent(existingEvent);
    return { event: existingEvent, created: false };
  }

  findTradeClosedForTrade(accountId: string, rangeName: string, tradeId: string): TradeEvent | undefined {
    tradeId = tradeId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    const row = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at,
       adjustment_note, exclusion_marker
       FROM trade_events
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND trade_id IN (?, ?) AND event_type = 'trade_closed'
       ORDER BY (trade_id = ?) DESC
       LIMIT 1`,
    ).get(accountId, ...((rn: string) => [rn, ...this.idFormsForLookup(rn, tradeId), tradeId])(this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName) ?? rangeName)) as TradeEventRow | undefined;
    return row ? this.toTradeEvent(row) : undefined;
  }

  // Pine's real trade_closed can arrive after a synthesized ct-flat close —
  // upgrade the row in place (same event row, real numbers) instead of
  // double-journaling.
  updateTradeEventRealization(
    id: string,
    values: { exitPrice?: number; realizedTicksCents?: number; realizedDollarsCents?: number; outcome?: string; occurredAt?: string },
  ): void {
    const userId = (this.db.prepare(`SELECT user_id FROM trade_events WHERE id = ?`).get(id) as { user_id: string } | undefined)?.user_id;
    if (userId) this.invalidateUserCache(userId);
    this.db.prepare(
      `UPDATE trade_events SET
         exit_price = COALESCE(?, exit_price),
         realized_ticks_cents = COALESCE(?, realized_ticks_cents),
         realized_dollars_cents = COALESCE(?, realized_dollars_cents),
         outcome = COALESCE(?, outcome),
         occurred_at = COALESCE(?, occurred_at)
       WHERE id = ?`,
    ).run(
      values.exitPrice ?? null, values.realizedTicksCents ?? null,
      values.realizedDollarsCents ?? null, values.outcome ?? null,
      values.occurredAt ?? null, id,
    );
  }

  findRangeTradeClosedForTrade(rangeName: string, tradeId: string): RangeTradeEvent | undefined {
    tradeId = tradeId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    const row = this.db.prepare(
      `SELECT * FROM range_trade_events
       WHERE range_name = ? COLLATE BINARY AND trade_id IN (?, ?) AND event_type = 'trade_closed'
       ORDER BY (trade_id = ?) DESC
       LIMIT 1`,
    ).get(...((rn: string) => [rn, ...this.idFormsForLookup(rn, tradeId), tradeId])(this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName) ?? rangeName)) as RangeTradeEventRow | undefined;
    return row ? this.toRangeTradeEvent(row) : undefined;
  }

  updateRangeTradeEventRealization(
    id: string,
    values: { exitPrice?: number; realizedTicksCents?: number; realizedDollarsCents?: number; outcome?: string; occurredAt?: string },
  ): void {
    const rangeName = (this.db.prepare(`SELECT range_name FROM range_trade_events WHERE id = ?`).get(id) as { range_name: string } | undefined)?.range_name;
    if (rangeName) {
      for (const u of this.db.prepare(
        `SELECT DISTINCT a.user_id FROM range_routes r JOIN accounts a ON a.id = r.account_id WHERE r.range_name = ? COLLATE BINARY`,
      ).all(rangeName) as Array<{ user_id: string }>) {
        this.invalidateUserCache(u.user_id);
      }
    }
    this.db.prepare(
      `UPDATE range_trade_events SET
         exit_price = COALESCE(?, exit_price),
         realized_ticks_cents = COALESCE(?, realized_ticks_cents),
         realized_dollars_cents = COALESCE(?, realized_dollars_cents),
         outcome = COALESCE(?, outcome),
         occurred_at = COALESCE(?, occurred_at)
       WHERE id = ?`,
    ).run(
      values.exitPrice ?? null, values.realizedTicksCents ?? null,
      values.realizedDollarsCents ?? null, values.outcome ?? null,
      values.occurredAt ?? null, id,
    );
  }

  createRangeTradeEvent(
    input: Omit<RangeTradeEvent, 'id'>,
  ): { event: RangeTradeEvent; created: boolean } {
    const resolvedRangeName = this.resolveStoredRangeName(input.rangeName) ?? this.resolveRangeName(input.rangeName);
    const event: RangeTradeEvent = {
      ...input,
      rangeName: resolvedRangeName,
      id: randomUUID(),
    };
    event.tradeId = event.tradeId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    event.eventId = event.eventId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    const scopedIds = this.unscopeEventIdsForLegacyBracket(event.rangeName, event.side, event.tradeId, event.eventId);
    event.tradeId = scopedIds.tradeId;
    event.eventId = scopedIds.eventId;
    const result = this.db.prepare(
      `INSERT INTO range_trade_events (
        id, range_name, event_id, trade_id, event_type, instrument, side, action,
        quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
        occurred_at, proxy_alert_id, adjustment_note
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, range_name) DO NOTHING`,
    ).run(
      event.id,
      event.rangeName,
      event.eventId,
      event.tradeId,
      event.eventType,
      event.instrument,
      event.side,
      event.action ?? null,
      event.quantity,
      event.entryPrice ?? null,
      event.exitPrice ?? null,
      event.realizedTicksCents ?? null,
      event.realizedDollarsCents ?? null,
      event.outcome ?? null,
      event.occurredAt,
      event.proxyAlertId ?? null,
      input.adjustmentNote ?? null,
    );
    if (result.changes === 1) {
      if (event.eventType === 'trade_closed') {
        this.syncRangeCalendarVisibilityWithSchedules([event.rangeName]);
      }
      return { event, created: true };
    }

    const existing = this.db.prepare(
      `SELECT id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id
       FROM range_trade_events WHERE event_id = ? AND range_name = ? COLLATE BINARY`,
    ).get(event.eventId, event.rangeName) as unknown as RangeTradeEventRow;
    return { event: this.toRangeTradeEvent(existing), created: false };
  }

  listLifecycleBracketAccounts(rangeName: string, tradeId: string, side: string): Array<{ accountId: string; userId: string }> {
    const bracketId = baseBracketIdFromLifecycleTradeId(tradeId);
    return this.db.prepare(`SELECT DISTINCT b.account_id AS accountId, a.user_id AS userId
      FROM bracket_monitor b JOIN accounts a ON a.id = b.account_id
      WHERE b.range_name = ? AND b.side = ? AND (b.bracket_id IN (?, ?) OR EXISTS (
        SELECT 1 FROM bracket_reapply_aliases r WHERE r.account_id = b.account_id
        AND r.range_name = b.range_name AND r.original_bracket_id IN (?, ?) AND r.current_bracket_id = b.bracket_id
      ))`).all(rangeName, side, ...this.idFormsForLookup(rangeName, bracketId), ...this.idFormsForLookup(rangeName, bracketId)) as Array<{ accountId: string; userId: string }>;
  }

  recordBracketMonitorEvent(
    event: Pick<TradeEvent, 'accountId' | 'rangeName' | 'tradeId' | 'eventType' | 'instrument' | 'side' | 'quantity' | 'entryPrice' | 'occurredAt' | 'eventId'>,
  ): BracketMonitorEntry {
    const sourceBracketId = baseBracketIdFromLifecycleTradeId(event.tradeId);
    const alias = event.eventType === 'entry_armed' ? undefined : this.db.prepare(
      'SELECT current_bracket_id FROM bracket_reapply_aliases WHERE account_id = ? AND range_name = ? AND original_bracket_id IN (?, ?) ORDER BY (original_bracket_id = ?) DESC',
    ).get(event.accountId, event.rangeName, ...this.idFormsForLookup(this.resolveRangeName(event.rangeName) ?? event.rangeName, sourceBracketId), sourceBracketId) as { current_bracket_id: string } | undefined;
    let bracketId = sourceBracketId;
    if (alias) {
      const replacement = this.db.prepare(
        'SELECT 1 FROM bracket_monitor WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?',
      ).get(event.accountId, event.rangeName, alias.current_bracket_id, event.side);
      if (replacement) bracketId = alias.current_bracket_id;
    }
    bracketId = this.resolveBracketMonitorId(event.accountId, event.rangeName, bracketId, event.side);
    const now = new Date().toISOString();
    const state = bracketMonitorStateFromEventType(event.eventType);
    const existing = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
       entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
       FROM bracket_monitor
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?`,
    ).get(event.accountId, event.rangeName, bracketId, event.side) as BracketMonitorRow | undefined;
    const isFreshRearm = event.eventType === 'entry_armed'
      && (existing?.state === 'closed' || existing?.state === 'cancelled')
      && new Date(event.occurredAt).getTime() > new Date(existing!.last_occurred_at).getTime();
    if (existing && !isFreshRearm && (existing.state === 'closed' || (existing.state === 'cancelled' && event.eventType !== 'entry_filled') || (existing.state === 'filled' && (event.eventType === 'entry_armed' || event.eventType === 'entry_cancelled')))) {
      return {
        accountId: existing.account_id,
        rangeName: existing.range_name,
        bracketId: existing.bracket_id,
        side: existing.side,
        instrument: existing.instrument,
        state: existing.state,
        quantity: existing.quantity,
        tradeId: existing.trade_id,
        entryPrice: existing.entry_price ?? undefined,
        deliverySuppressed: existing.delivery_suppressed === 1,
        lastEventId: existing.last_event_id,
        lastEventType: existing.last_event_type,
        lastOccurredAt: existing.last_occurred_at,
        createdAt: existing.created_at,
        updatedAt: existing.updated_at,
      } as BracketMonitorEntry;
    }
    const createdAt = existing?.created_at ?? now;
    const deliverySuppressed = event.eventType === 'entry_armed' || event.eventType === 'entry_filled'
      ? this.latestEntryDeliveryStatusForBracket(
          event.accountId,
          event.rangeName,
          bracketId,
          event.side === 'long' ? 'buy' : 'sell',
          event.side,
        )?.startsWith('suppressed_') === true
      : (existing?.delivery_suppressed ?? 0) === 1;
    this.db.prepare(
      `INSERT INTO bracket_monitor (
        account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
        entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, range_name, bracket_id, side) DO UPDATE SET
        instrument = excluded.instrument,
        state = excluded.state,
        quantity = excluded.quantity,
        trade_id = excluded.trade_id,
        entry_price = excluded.entry_price,
        delivery_suppressed = MAX(bracket_monitor.delivery_suppressed, excluded.delivery_suppressed),
        last_event_id = excluded.last_event_id,
        last_event_type = excluded.last_event_type,
        last_occurred_at = excluded.last_occurred_at,
        updated_at = excluded.updated_at`,
    ).run(
      event.accountId,
      event.rangeName,
      bracketId,
      event.side,
      event.instrument,
      state,
      event.quantity,
      event.tradeId,
      event.entryPrice ?? null,
      deliverySuppressed ? 1 : 0,
      event.eventId,
      event.eventType,
      event.occurredAt,
      createdAt,
      now,
    );
    let brokerStatus: BrokerOrderState | undefined;
    if (event.eventType === 'entry_filled') brokerStatus = 'filled';
    else if (event.eventType === 'trade_closed' || event.eventType === 'exit_filled') brokerStatus = 'closed';
    else if (event.eventType === 'entry_cancelled') brokerStatus = 'cancelled';
    if (brokerStatus) {
      if (alias) {
        // Bracket-scoped so every resend attempt row (order_id suffixed -r<n>)
        // transitions; the rejected/uncertain history of earlier attempts is
        // preserved since only still-open statuses match. bracketId is the
        // replacement when its monitor exists, else the original — the ledger
        // update must land on the same row the monitor write just touched.
        this.updateOpenEntryBrokerOrderStatus(event.accountId, event.rangeName, bracketId, event.side, brokerStatus);
      } else {
        // Ordinary entries are ledgered as bridge-<delivery> with no alias; transition the
        // matching open entry row so the ledger tracks the lifecycle. The side-derived
        // action match excludes precise-TP and cleanup dispatches for the same bracket.
        this.updateOpenEntryBrokerOrderStatus(event.accountId, event.rangeName, bracketId, event.side, brokerStatus);
      }
    }
    return {
      accountId: event.accountId,
      rangeName: event.rangeName,
      bracketId,
      side: event.side,
      instrument: event.instrument,
      state,
      quantity: event.quantity,
      tradeId: event.tradeId,
      entryPrice: event.entryPrice,
      deliverySuppressed,
      lastEventId: event.eventId,
      lastEventType: event.eventType,
      lastOccurredAt: event.occurredAt,
      createdAt,
      updatedAt: now,
    };
  }

  retireBracketMonitorEntry(
    userId: string,
    row: BracketMonitorEntry,
    eventType: TradeEventType,
    eventId: string,
    occurredAt: string,
  ): void {
    const now = new Date().toISOString();
    const state = bracketMonitorStateFromEventType(eventType);
    this.db.prepare(
      `UPDATE bracket_monitor
       SET state = ?, last_event_type = ?, last_event_id = ?, last_occurred_at = ?, updated_at = ?
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?`,
    ).run(
      state,
      eventType,
      eventId,
      occurredAt,
      now,
      row.accountId,
      row.rangeName,
      row.bracketId,
      row.side,
    );
    // Force-retire paths (EOD, reconcile, safeguard bookkeeping) don't flow through
    // recordBracketMonitorEvent, so transition the entry dispatch row here as well —
    // the bracket's working/filled order is resolved by the same cleanup.
    if (state === 'cancelled' || state === 'closed') {
      this.updateOpenEntryBrokerOrderStatus(row.accountId, row.rangeName, row.bracketId, row.side, state, 'bridge');
    }
    this.invalidateUserCache(userId);
  }

  // The reverse of a force-retire: the CT sweep proved the bracket's entry
  // order is still Working at the broker after local bookkeeping cancelled
  // the arm (e.g. a reconcile raced a slow book). Re-arm the row so Open
  // Orders tracks the live order again. Guarded to 'cancelled' rows — a
  // 'closed' trade stays closed; an orphan leg is not the trade reopening.
  reactivateBracketMonitorArm(userId: string, row: BracketMonitorEntry): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE bracket_monitor SET state = 'armed', last_event_type = 'entry_armed',
         last_event_id = ?, last_occurred_at = ?, updated_at = ?
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ? AND state = 'cancelled'`,
    ).run(`ct-adopted-${row.bracketId}-entry_armed`, now, now, row.accountId, row.rangeName, row.bracketId, row.side);
    this.invalidateUserCache(userId);
  }

  // Armed monitor rows keyed by bracket_id alone — for reapply replacements the
  // monitor key is the broker order's order_id, so lookups that only know the
  // order identity (e.g. a broker failure email) cannot go through
  // findBracketMonitorEntry, which requires range_name and side.
  // Monitor rows that closed recently via a non-synthesized close — the
  // Pine-first upgrade path re-examines them so broker fill data can replace
  // Pine's reported realization when the book shows attributable fills.
  listRecentlyClosedMonitorEntriesByAccount(accountId: string, cutoffIso: string): BracketMonitorEntry[] {
    const rows = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
       entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
       FROM bracket_monitor
       WHERE account_id = ? AND state = 'closed' AND last_event_type = 'trade_closed'
         AND last_event_id NOT LIKE 'ct-flat-%'
         AND updated_at > ?`,
    ).all(accountId, cutoffIso) as BracketMonitorRow[];
    return rows.map((row) => this.toBracketMonitorEntry(row));
  }

  listAccountsWithRecentlyClosedMonitorRows(cutoffIso: string): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT account_id FROM bracket_monitor
       WHERE state = 'closed' AND last_event_type = 'trade_closed'
         AND last_event_id NOT LIKE 'ct-flat-%' AND updated_at > ?`,
    ).all(cutoffIso) as Array<{ account_id: string }>;
    return rows.map((row) => row.account_id);
  }

  listAccountsWithFilledMonitorRows(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT account_id FROM bracket_monitor WHERE state = 'filled'`,
    ).all() as Array<{ account_id: string }>;
    return rows.map((row) => row.account_id);
  }

  listFilledBracketMonitorEntriesByAccount(accountId: string): BracketMonitorEntry[] {
    const rows = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
       entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
       FROM bracket_monitor
       WHERE account_id = ? AND state = 'filled'`,
    ).all(accountId) as BracketMonitorRow[];
    return rows.map((row) => this.toBracketMonitorEntry(row));
  }

  listArmedBracketMonitorRows(accountId: string, bracketId: string): BracketMonitorEntry[] {
    const rows = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
       entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
       FROM bracket_monitor
       WHERE account_id = ? AND bracket_id = ? AND state = 'armed'`,
    ).all(accountId, bracketId) as BracketMonitorRow[];
    return rows.map((row) => this.toBracketMonitorEntry(row));
  }

  // Every stored form a lookup id could take during the prefix transition:
  // as-given, unscoped (slug prefix stripped), or explicitly scoped. Queries
  // use IN (?, ?) so a caller holding either generation finds the stored row.
  private idFormsForLookup(resolvedRangeName: string, id: string): [string, string] {
    const unscoped = unscopeBracketId(id, resolvedRangeName);
    if (unscoped !== id) return [id, unscoped];
    const slug = rangeSlugForLookup(resolvedRangeName);
    return [id, slug ? `${slug}-${id}` : id];
  }

  // A normalized incoming event that maps onto an OPEN legacy (unprefixed)
  // monitor row keeps that row's journal identity: strip the slug off
  // tradeId/eventId so the whole bracket lifecycle shares one identity.
  private unscopeEventIdsForLegacyBracket(
    rangeName: string,
    side: 'long' | 'short',
    tradeId: string,
    eventId: string,
    accountId?: string,
  ): { tradeId: string; eventId: string } {
    const scope = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName) ?? rangeName;
    const base = baseBracketIdFromLifecycleTradeId(tradeId);
    const legacyBase = unscopeBracketId(base, scope);
    if (legacyBase === base) return { tradeId, eventId };
    // The scoped form already owns this bracket's identity — an exact row
    // (any state) wins over the legacy fallback, so an established scoped
    // bracket is never folded into a lingering unprefixed row sharing the base.
    const exact = this.db.prepare(
      `SELECT 1 FROM bracket_monitor
       WHERE range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?
         ${accountId ? 'AND account_id = ?' : ''}
       LIMIT 1`,
    ).get(...(accountId ? [scope, base, side, accountId] : [scope, base, side]));
    if (exact) return { tradeId, eventId };
    const open = this.db.prepare(
      `SELECT 1 FROM bracket_monitor
       WHERE range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?
         AND state IN ('armed', 'filled')
         ${accountId ? 'AND account_id = ?' : ''}
       LIMIT 1`,
    ).get(...(accountId ? [scope, legacyBase, side, accountId] : [scope, legacyBase, side]));
    if (!open) return { tradeId, eventId };
    return { tradeId: unscopeBracketId(tradeId, scope), eventId: unscopeBracketId(eventId, scope) };
  }

  // Pre-deploy rows may carry unprefixed ids while incoming lifecycle events
  // now arrive range-prefixed. resolveBracketMonitorId maps the normalized id
  // back onto the legacy row ONLY when the normalized key doesn't already
  // exist and a matching unprefixed row is still open — closed/cancelled
  // legacy rows keep their own identity so a post-deploy re-arm can't alias
  // into a dead bracket. The fallback is scoped to (account, range, side).
  private resolveBracketMonitorId(
    accountId: string,
    rangeName: string,
    bracketId: string,
    side: 'long' | 'short',
    resolvedRangeName?: string,
  ): string {
    const scope = resolvedRangeName ?? this.resolveRangeName(rangeName) ?? rangeName;
    const find = (id: string, openOnly: boolean) => this.db.prepare(
      `SELECT 1 FROM bracket_monitor
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?
         ${openOnly ? `AND state IN ('armed', 'filled')` : ''}`,
    ).get(accountId, scope, id, side);
    if (find(bracketId, false)) return bracketId;
    const legacy = unscopeBracketId(bracketId, scope);
    if (legacy !== bracketId) {
      // Incoming normalized id, existing pre-deploy row: only capture an OPEN
      // legacy row — a closed/cancelled one must not alias a post-deploy re-arm.
      if (find(legacy, true)) return legacy;
      return bracketId;
    }
    // Caller supplied a raw id while the stored row is normalized (test/helpers,
    // reconcile/email paths that never went through ingest). The normalized row
    // is the true row at any state.
    const scoped = `${rangeSlugForLookup(scope)}-${bracketId}`;
    return find(scoped, false) ? scoped : bracketId;
  }

  findBracketMonitorEntry(
    accountId: string,
    rangeName: string,
    bracketId: string,
    side: 'long' | 'short',
  ): BracketMonitorEntry | undefined {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const resolvedId = this.resolveBracketMonitorId(accountId, rangeName, bracketId, side, resolvedRangeName);
    const row = this.db.prepare(
      `SELECT account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id,
       entry_price, delivery_suppressed, last_event_id, last_event_type, last_occurred_at, created_at, updated_at
       FROM bracket_monitor
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?`,
    ).get(accountId, resolvedRangeName, resolvedId, side) as BracketMonitorRow | undefined;
    return row ? this.toBracketMonitorEntry(row) : undefined;
  }

  private toBracketMonitorEntry(row: BracketMonitorRow): BracketMonitorEntry {
    return {
      accountId: row.account_id,
      rangeName: row.range_name,
      bracketId: row.bracket_id,
      side: row.side as 'long' | 'short',
      instrument: row.instrument,
      state: row.state as BracketMonitorState,
      quantity: row.quantity,
      tradeId: row.trade_id,
      entryPrice: row.entry_price ?? undefined,
      deliverySuppressed: row.delivery_suppressed === 1,
      lastEventId: row.last_event_id,
      lastEventType: row.last_event_type as TradeEventType,
      lastOccurredAt: row.last_occurred_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  hasTradeEventForAccountTrade(accountId: string, tradeId: string): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1
       FROM trade_events
       WHERE account_id = ? AND trade_id IN (?, ?)
       LIMIT 1`,
    ).get(accountId, ...this.idFormsForLookup('', tradeId)));
  }

  listRangeTradeEventsByTrade(rangeName: string, tradeId: string): RangeTradeEvent[] {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id, adjustment_note
       FROM range_trade_events
       WHERE range_name = ? COLLATE BINARY AND trade_id IN (?, ?)
       ORDER BY occurred_at ASC, id ASC`,
    ).all(resolvedRangeName, ...this.idFormsForLookup(resolvedRangeName, tradeId)) as unknown as RangeTradeEventRow[];
    return rows.map((row) => this.toRangeTradeEvent(row));
  }

  adjustRangeTradeEvent(
    rangeTradeEventId: string,
    userId: string,
    changes: Partial<Omit<RangeTradeEvent, 'id' | 'rangeName' | 'eventId' | 'tradeId'>>,
    note: string,
    adjuster: { id: string; email: string },
  ): RangeTradeEvent | undefined {
    const allowed = new Set([
      'eventType', 'instrument', 'side', 'action', 'quantity',
      'entryPrice', 'exitPrice', 'realizedTicksCents', 'realizedDollarsCents',
      'outcome', 'occurredAt', 'proxyAlertId',
    ]);
    const fieldMap: Record<string, string> = {
      eventType: 'event_type',
      instrument: 'instrument',
      side: 'side',
      action: 'action',
      quantity: 'quantity',
      entryPrice: 'entry_price',
      exitPrice: 'exit_price',
      realizedTicksCents: 'realized_ticks_cents',
      realizedDollarsCents: 'realized_dollars_cents',
      outcome: 'outcome',
      occurredAt: 'occurred_at',
      proxyAlertId: 'proxy_alert_id',
    };
    const valueSet: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.has(key)) continue;
      if (value === undefined) continue;
      valueSet.push(`${fieldMap[key]} = ?`);
      values.push(value as string | number | null);
    }
    if (valueSet.length === 0 && !note.trim()) return undefined;

    const now = new Date().toISOString();
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const rangeEvent = this.db.prepare(
        'SELECT id, range_name, event_id, trade_id, event_type, occurred_at FROM range_trade_events WHERE id = ?',
      ).get(rangeTradeEventId) as { id: string; range_name: string; event_id: string; trade_id: string; event_type: string; occurred_at: string } | undefined;
      if (!rangeEvent) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const tradeEvents = this.db.prepare(
        `SELECT id, user_id FROM trade_events WHERE user_id = ? AND event_id = ? AND range_name = ? COLLATE BINARY`,
      ).all(userId, rangeEvent.event_id, rangeEvent.range_name) as Array<{ id: string; user_id: string }>;
      if (tradeEvents.length === 0) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const tradeUpdate = this.db.prepare(
        `UPDATE trade_events
         SET ${valueSet.length > 0 ? `${valueSet.join(', ')}, ` : ''}adjustment_note = ?, adjusted_at = ?, adjusted_by_user_id = ?, adjusted_by_email = ?
         WHERE id = ? AND user_id = ?`,
      );
      for (const { id, user_id: tradeUserId } of tradeEvents) {
        tradeUpdate.run(...values, note, now, adjuster.id, adjuster.email, id, tradeUserId);
      }
      if (valueSet.length > 0) {
        this.db.prepare(
          `UPDATE range_trade_events SET ${valueSet.join(', ')} WHERE id = ?`,
        ).run(...values, rangeTradeEventId);
      }
      this.db.prepare(
        'UPDATE range_trade_events SET adjustment_note = ? WHERE id = ?',
      ).run(note, rangeTradeEventId);
      const updated = this.db.prepare(
        `SELECT id, range_name, event_id, trade_id, event_type, instrument, side, action,
         quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
         occurred_at, proxy_alert_id, adjustment_note
         FROM range_trade_events WHERE id = ?`,
      ).get(rangeTradeEventId) as unknown as RangeTradeEventRow;
      this.db.exec('COMMIT');
      this.invalidateUserCache(userId);
      return this.toRangeTradeEvent(updated);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  applyAllMatchingTradeEvents(
    rangeTradeEventId: string,
    userId: string,
    changes: Partial<Omit<RangeTradeEvent, 'id' | 'rangeName' | 'eventId' | 'tradeId'>>,
    note: string,
    adjuster: { id: string; email: string },
  ): RangeTradeEvent | undefined {
    const allowed = new Set([
      'eventType', 'instrument', 'side', 'action', 'quantity',
      'entryPrice', 'exitPrice', 'realizedTicksCents', 'realizedDollarsCents',
      'outcome', 'occurredAt', 'proxyAlertId',
    ]);
    const fieldMap: Record<string, string> = {
      eventType: 'event_type',
      instrument: 'instrument',
      side: 'side',
      action: 'action',
      quantity: 'quantity',
      entryPrice: 'entry_price',
      exitPrice: 'exit_price',
      realizedTicksCents: 'realized_ticks_cents',
      realizedDollarsCents: 'realized_dollars_cents',
      outcome: 'outcome',
      occurredAt: 'occurred_at',
      proxyAlertId: 'proxy_alert_id',
    };
    const valueSet: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.has(key)) continue;
      const column = fieldMap[key];
      if (column === undefined) continue;
      valueSet.push(`${column} = ?`);
      values.push(value ?? null);
    }
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const rangeEvent = this.db.prepare(
        'SELECT range_name, event_id, trade_id, event_type, occurred_at FROM range_trade_events WHERE id = ?',
      ).get(rangeTradeEventId) as { range_name: string; event_id: string; trade_id: string; event_type: string; occurred_at: string } | undefined;
      if (!rangeEvent) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const tradeEvents = this.db.prepare(
        `SELECT id, user_id FROM trade_events
         WHERE range_name = ? COLLATE NOCASE AND event_type = ?
           AND abs(strftime('%s', occurred_at) - strftime('%s', ?)) <= 300`,
      ).all(rangeEvent.range_name, rangeEvent.event_type, rangeEvent.occurred_at) as Array<{ id: string; user_id: string }>;
      if (tradeEvents.length === 0) {
        this.db.exec('ROLLBACK');
        return undefined;
      }
      const now = new Date().toISOString();
      const tradeUpdate = this.db.prepare(
        `UPDATE trade_events
         SET ${valueSet.length > 0 ? `${valueSet.join(', ')}, ` : ''}adjustment_note = ?, adjusted_at = ?, adjusted_by_user_id = ?, adjusted_by_email = ?
         WHERE id = ? AND user_id = ?`,
      );
      for (const { id, user_id: tradeUserId } of tradeEvents) {
        tradeUpdate.run(...values, note, now, adjuster.id, adjuster.email, id, tradeUserId);
        this.invalidateUserCache(tradeUserId);
      }
      if (valueSet.length > 0) {
        this.db.prepare(
          `UPDATE range_trade_events SET ${valueSet.join(', ')} WHERE id = ?`,
        ).run(...values, rangeTradeEventId);
      }
      this.db.prepare(
        'UPDATE range_trade_events SET adjustment_note = ? WHERE id = ?',
      ).run(note, rangeTradeEventId);
      const updated = this.db.prepare(
        `SELECT id, range_name, event_id, trade_id, event_type, instrument, side, action,
         quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
         occurred_at, proxy_alert_id, adjustment_note
         FROM range_trade_events WHERE id = ?`,
      ).get(rangeTradeEventId) as unknown as RangeTradeEventRow;
      this.db.exec('COMMIT');
      this.invalidateUserCache(userId);
      return this.toRangeTradeEvent(updated);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  deleteRangeTradeEvent(rangeTradeEventId: string, userId: string): boolean {
    this.db.prepare('BEGIN IMMEDIATE').run();
    try {
      const rangeEvent = this.db.prepare(
        'SELECT range_name, event_id, trade_id, event_type, occurred_at FROM range_trade_events WHERE id = ?',
      ).get(rangeTradeEventId) as { range_name: string; event_id: string; trade_id: string; event_type: string; occurred_at: string } | undefined;
      if (!rangeEvent) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db.prepare('DELETE FROM range_trade_events WHERE id = ?').run(rangeTradeEventId);
      this.db.prepare(
        `DELETE FROM trade_events WHERE user_id = ? AND event_id = ? AND range_name = ? COLLATE BINARY`,
      ).run(userId, rangeEvent.event_id, rangeEvent.range_name);
      this.db.exec('COMMIT');
      this.invalidateUserCache(userId);
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  findCandidateRangeTradeIds(
    rangeName: string,
    side: 'long' | 'short',
    quantity: number,
    entryPrice: number,
    receivedAt: string,
  ): string[] {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT DISTINCT trade_id
       FROM range_trade_events
       WHERE range_name = ? COLLATE BINARY
         AND side = ?
         AND quantity = ?
         AND entry_price = ?
         AND occurred_at >= ?
       ORDER BY occurred_at ASC, trade_id ASC`,
    ).all(resolvedRangeName, side, quantity, entryPrice, receivedAt) as Array<{ trade_id: string }>;
    return rows.map((row) => row.trade_id);
  }

  listRecentClosedTrades(
    userId: string,
    limit = 50,
    options: { accountId?: string; includeExcluded?: boolean; rangeName?: string; outcome?: TradeOutcome; occurredAfter?: string } = {},
  ): TradeEvent[] {
    return this.listRecentClosedTradesPage(userId, limit, 0, options);
  }

  countRecentClosedTrades(
    userId: string,
    options: { accountId?: string; includeExcluded?: boolean; rangeName?: string; outcome?: TradeOutcome; occurredAfter?: string } = {},
  ): number {
    const { accountId, includeExcluded = true, rangeName, outcome, occurredAfter } = options;
    if (accountId && !this.accountBelongsToUser(accountId, userId)) return 0;
    const filters = ['user_id = ?', "event_type = 'trade_closed'"];
    const params: Array<string | number> = [userId];
    if (accountId) {
      filters.push('account_id = ?');
      params.push(accountId);
    }
    if (!includeExcluded) filters.push('excluded_from_performance = 0');
    if (rangeName) {
      filters.push('range_name = ? COLLATE BINARY');
      params.push(this.resolveRangeName(rangeName));
    }
    if (outcome) {
      filters.push('outcome = ?');
      params.push(outcome);
    }
    if (occurredAfter) {
      filters.push('occurred_at >= ?');
      params.push(occurredAfter);
    }
    const row = this.db.prepare(
      `SELECT COUNT(*) AS total_count
       FROM trade_events
       WHERE ${filters.join(' AND ')}`,
    ).get(...params) as { total_count: number };
    return row.total_count;
  }

  listRecentClosedTradesPage(
    userId: string,
    limit = 50,
    offset = 0,
    options: { accountId?: string; includeExcluded?: boolean; rangeName?: string; outcome?: TradeOutcome; occurredAfter?: string } = {},
  ): TradeEvent[] {
    const { accountId, includeExcluded = true, rangeName, outcome, occurredAfter } = options;
    if (accountId && !this.accountBelongsToUser(accountId, userId)) return [];
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const safeOffset = Math.max(Math.trunc(offset), 0);
    const filters = ['user_id = ?', "event_type = 'trade_closed'"];
    const params: Array<string | number> = [userId];
    if (accountId) {
      filters.push('account_id = ?');
      params.push(accountId);
    }
    if (!includeExcluded) filters.push('excluded_from_performance = 0');
    if (rangeName) {
      filters.push('range_name = ? COLLATE BINARY');
      params.push(this.resolveRangeName(rangeName));
    }
    if (outcome) {
      filters.push('outcome = ?');
      params.push(outcome);
    }
    if (occurredAfter) {
      filters.push('occurred_at >= ?');
      params.push(occurredAfter);
    }
    const rows = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
        quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
        occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at
         FROM trade_events
         WHERE ${filters.join(' AND ')}
         ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, safeLimit, safeOffset) as unknown as TradeEventRow[];
    return rows.map((row) => this.toTradeEvent(row));
  }

  listAccountClosedTradesSince(userId: string, accountId: string, occurredAfter: string, occurredBefore?: string): TradeEvent[] {
    if (!this.accountBelongsToUser(accountId, userId)) return [];
    const rows = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
        quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
        occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at
         FROM trade_events
         WHERE user_id = ? AND account_id = ? AND event_type = 'trade_closed' AND occurred_at >= ?
           AND (? IS NULL OR occurred_at <= ?)
         ORDER BY occurred_at DESC, id DESC`,
    ).all(userId, accountId, occurredAfter, occurredBefore ?? null, occurredBefore ?? null) as unknown as TradeEventRow[];
    return rows.map((row) => this.toTradeEvent(row));
  }

  getAccountPnlReview(
    accountId: string,
    since: string,
    until?: string,
  ): {
    trades: TradeEvent[];
    summary: JournalMetrics;
    ranges: Array<{
      rangeName: string;
      instrument: string;
      realizedDollarsCents: number;
      netTicksCents: number;
      closedCount: number;
      wins: number;
      losses: number;
      breakevens: number;
    }>;
  } | undefined {
    const account = this.findAccountById(accountId);
    if (!account) return undefined;
    // Trades, summary, and ranges all cover the complete window — the equity curve and
    // best/worst cards derive from this list, so a display cap would skew the visuals.
    const trades = this.listAccountClosedTradesSince(account.userId, accountId, since, until);
    const performance = trades.filter((trade) => !trade.excludedFromPerformance);
    const byRange = new Map<string, TradeEvent[]>();
    for (const trade of performance) {
      const key = `${trade.rangeName}\u0000${trade.instrument}`;
      const list = byRange.get(key);
      if (list) list.push(trade);
      else byRange.set(key, [trade]);
    }
    const ranges = [...byRange.values()]
      .map((events) => {
        const metrics = summarizeTrades(events);
        return {
          rangeName: events[0]?.rangeName ?? '',
          instrument: events[0]?.instrument ?? '',
          realizedDollarsCents: metrics.realizedDollarsCents,
          netTicksCents: metrics.netTicksCents,
          closedCount: metrics.closedCount,
          wins: metrics.wins,
          losses: metrics.losses,
          breakevens: metrics.breakevens,
        };
      })
      .sort((a, b) => b.realizedDollarsCents - a.realizedDollarsCents || a.rangeName.localeCompare(b.rangeName) || a.instrument.localeCompare(b.instrument));
    return { trades, summary: summarizeTrades(performance), ranges };
  }

  setTradeEventPerformanceExclusion(
    userId: string,
    eventId: string,
    reason: PerformanceExclusionReason | undefined,
    excludedByUserId = userId,
    // marker rides exclusion_marker (not the operator-facing
    // adjustment_note): set on flag so automated exclusions are
    // distinguishable from operator exclusions, cleared on un-flag.
    marker?: string,
  ): TradeEvent | undefined {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE trade_events
       SET excluded_from_performance = ?,
           exclusion_reason = ?,
           excluded_by_user_id = ?,
           exclusion_updated_at = ?,
           exclusion_marker = ?
       WHERE id = ? AND user_id = ?`,
    ).run(
      Number(Boolean(reason)),
      reason ?? null,
      reason ? excludedByUserId : null,
      reason ? now : null,
      reason ? (marker ?? null) : null,
      eventId,
      userId,
    );
    if (result.changes !== 1) return undefined;
    this.invalidateUserCache(userId);
    const row = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at
       FROM trade_events WHERE id = ? AND user_id = ?`,
    ).get(eventId, userId) as unknown as TradeEventRow | undefined;
    return row && this.toTradeEvent(row);
  }

  setTradeEventPerformanceExclusionForDayRangeAccount(
    userId: string,
    dateKey: string,
    accountId: string,
    rangeName: string,
    reason: PerformanceExclusionReason,
    excludedByUserId = userId,
  ): number {
    const now = new Date().toISOString();
    const { start, end } = dayRange(dateKey, JOURNAL_TIME_OFFSET_MINUTES);
    const result = this.db.prepare(
      `UPDATE trade_events
       SET excluded_from_performance = 1,
           exclusion_reason = ?,
           excluded_by_user_id = ?,
           exclusion_updated_at = ?
       WHERE user_id = ? AND account_id = ? AND range_name = ? AND event_type = 'trade_closed'
         AND occurred_at >= ? AND occurred_at < ? AND excluded_from_performance = 0`,
    ).run(
      reason,
      excludedByUserId,
      now,
      userId,
      accountId,
      rangeName,
      start,
      end,
    );
    if (result.changes > 0) {
      this.invalidateUserCache(userId);
    }
    return result.changes;
  }

  deleteTradeEvent(userId: string, eventId: string): boolean {
    const result = this.db.prepare(
      'DELETE FROM trade_events WHERE id = ? AND user_id = ?',
    ).run(eventId, userId);
    if (result.changes === 1) {
      this.invalidateUserCache(userId);
      return true;
    }
    return false;
  }

  listExcludedTradeEvents(reason?: PerformanceExclusionReason): Array<TradeEvent & {
    userEmail: string;
    accountName: string;
    excludedByEmail?: string;
  }> {
    const rows = this.db.prepare(
      `SELECT trade_events.id, trade_events.user_id, trade_events.account_id, trade_events.range_name, trade_events.event_id,
       trade_events.trade_id, trade_events.event_type, trade_events.instrument, trade_events.side, trade_events.action,
       trade_events.quantity, trade_events.entry_price, trade_events.exit_price, trade_events.realized_ticks_cents,
       trade_events.realized_dollars_cents, trade_events.outcome, trade_events.occurred_at, trade_events.proxy_alert_id,
       trade_events.excluded_from_performance, trade_events.exclusion_reason, trade_events.excluded_by_user_id,
       trade_events.exclusion_updated_at, users.email AS user_email, accounts.name AS account_name,
       excluded_by.email AS excluded_by_email
       FROM trade_events
       JOIN users ON users.id = trade_events.user_id
       JOIN accounts ON accounts.id = trade_events.account_id
       LEFT JOIN users AS excluded_by ON excluded_by.id = trade_events.excluded_by_user_id
       WHERE trade_events.event_type = 'trade_closed' AND trade_events.excluded_from_performance = 1
       ${reason ? 'AND trade_events.exclusion_reason = ?' : ''}
       ORDER BY trade_events.exclusion_updated_at DESC, trade_events.occurred_at DESC`,
    ).all(...(reason ? [reason] : [])) as unknown as Array<TradeEventRow & {
      user_email: string;
      account_name: string;
      excluded_by_email: string | null;
    }>;
    return rows.map((row) => ({
      ...this.toTradeEvent(row),
      userEmail: row.user_email,
      accountName: row.account_name,
      ...(row.excluded_by_email ? { excludedByEmail: row.excluded_by_email } : {}),
    }));
  }

  getTradeCalendarMonth(
    userId: string,
    now = new Date(),
    options: { accountId?: string | string[]; month?: string } = {},
  ): ReturnType<typeof buildTradeCalendarMonth> {
    const { accountId, month } = options;
    const monthKey = normalizeMonthKey(month, now, JOURNAL_TIME_OFFSET_MINUTES);
    const accountIds = Array.isArray(accountId) ? (accountId.length > 0 ? accountId : undefined) : (accountId ? [accountId] : undefined);
    const accountKey = accountIds ? [...accountIds].sort().join(',') : '';
    const cacheKey = this.cacheKey(userId, 'calendar', [monthKey, accountKey]);
    const cached = this.getCache<ReturnType<Database['getTradeCalendarMonth']>>(userId, 'calendar', [monthKey, accountKey]);
    if (cached) {
      console.info('[db] getTradeCalendarMonth cache hit', { month: monthKey, hasAccountId: Boolean(accountIds) });
      return cached;
    }
    if (accountIds && !accountIds.every((id) => this.accountBelongsToUser(id, userId))) {
      return { month: monthKey, days: [], trailingDays: [], summary: summarizeTrades([]) };
    }
    const start = Date.now();
    const { start: rangeStart, end: rangeEnd } = monthRange(monthKey, JOURNAL_TIME_OFFSET_MINUTES);
    // Extend the fetch window back over the leading pad cells so trailing
    // prior-month days carry real results into the calendar view.
    const leadingPadDays = new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1)).getUTCDay();
    const padStart = new Date(new Date(rangeStart).getTime() - leadingPadDays * 86_400_000).toISOString();
    const closedTrades = this.listClosedTrades(userId, {
      startAt: padStart,
      endAt: rangeEnd,
      ...(accountIds ? { accountIds } : {}),
      limit: 10000,
    });
    const result = buildTradeCalendarMonth(closedTrades, now, monthKey, { riskByRangeName: this.rangeRiskMap() });
    this.setCache(userId, 'calendar', [monthKey, accountKey], result);
    console.info('[db] getTradeCalendarMonth', {
      duration: Date.now() - start,
      month: monthKey,
      hasAccountId: Boolean(accountIds),
      tradeCount: closedTrades.length,
      cacheKey,
    });
    return result;
  }

  getTradeJournalDay(
    userId: string,
    dateKey: string,
    options: { accountId?: string | string[] } = {},
  ): {
    date: string;
    trades: TradeEvent[];
    summary: JournalMetrics;
    ranges: Array<{
      rangeName: string;
      instrument: string;
      realizedDollarsCents: number;
      netTicksCents: number;
      closedCount: number;
      wins: number;
      losses: number;
      breakevens: number;
    }>;
  } {
    const { accountId } = options;
    const accountIds = Array.isArray(accountId) ? (accountId.length > 0 ? accountId : undefined) : (accountId ? [accountId] : undefined);
    if (accountIds && !accountIds.every((id) => this.accountBelongsToUser(id, userId))) {
      return { date: dateKey, trades: [], summary: summarizeTrades([]), ranges: [] };
    }
    const start = Date.now();
    const { start: rangeStart, end: rangeEnd } = dayRange(dateKey, JOURNAL_TIME_OFFSET_MINUTES);
    const trades = this.listClosedTrades(userId, {
      startAt: rangeStart,
      endAt: rangeEnd,
      ...(accountIds ? { accountIds } : {}),
    });
    const ranges = this.summarizeJournalDayRanges(trades);
    const result = {
      date: dateKey,
      trades,
      summary: summarizeTrades(trades),
      ranges,
    };
    console.info('[db] getTradeJournalDay', {
      duration: Date.now() - start,
      date: dateKey,
      hasAccountId: Boolean(accountId),
      tradeCount: trades.length,
    });
    return result;
  }

  // Batched form of getTradeJournalDay for multi-day payloads (the /api/journal
  // response): one listClosedTrades over the union of requested days, grouped
  // in JS. Per-day queries serialized badly on slow disks (~25 sequential
  // reads ~= multi-second responses).
  getTradeJournalDays(
    userId: string,
    dateKeys: string[],
    options: { accountId?: string | string[] } = {},
  ): Record<string, ReturnType<Database['getTradeJournalDay']>> {
    const { accountId } = options;
    const accountIds = Array.isArray(accountId) ? (accountId.length > 0 ? accountId : undefined) : (accountId ? [accountId] : undefined);
    const accountBlocked = Boolean(accountIds && !accountIds.every((id) => this.accountBelongsToUser(id, userId)));
    const empty = (date: string): ReturnType<Database['getTradeJournalDay']> =>
      ({ date, trades: [], summary: summarizeTrades([]), ranges: [] });
    if (accountBlocked || dateKeys.length === 0) {
      return Object.fromEntries(dateKeys.map((key) => [key, empty(key)]));
    }
    const start2 = Date.now();
    const bounds = dateKeys.map((key) => dayRange(key, JOURNAL_TIME_OFFSET_MINUTES));
    const startAt = bounds.reduce((min, b) => (b.start < min ? b.start : min), bounds[0].start);
    const endAt = bounds.reduce((max, b) => (b.end > max ? b.end : max), bounds[0].end);
    const allTrades = this.listClosedTrades(userId, {
      startAt,
      endAt,
      ...(accountIds ? { accountIds } : {}),
    });
    const tradesByDate = new Map<string, TradeEvent[]>();
    for (const trade of allTrades) {
      const key = fixedOffsetDateKey(trade.occurredAt, JOURNAL_TIME_OFFSET_MINUTES);
      const bucket = tradesByDate.get(key) ?? [];
      bucket.push(trade);
      tradesByDate.set(key, bucket);
    }
    const result: Record<string, ReturnType<Database['getTradeJournalDay']>> = {};
    for (const key of dateKeys) {
      const trades = tradesByDate.get(key) ?? [];
      result[key] = {
        date: key,
        trades,
        summary: summarizeTrades(trades),
        ranges: this.summarizeJournalDayRanges(trades),
      };
    }
    console.info('[db] getTradeJournalDays', {
      duration: Date.now() - start2,
      dayCount: dateKeys.length,
      tradeCount: allTrades.length,
    });
    return result;
  }

  private summarizeJournalDayRanges(trades: TradeEvent[]): Array<{
    rangeName: string;
    instrument: string;
    realizedDollarsCents: number;
    netTicksCents: number;
    closedCount: number;
    wins: number;
    losses: number;
    breakevens: number;
  }> {
    return [...trades.reduce((entries, event) => {
      const key = `${event.rangeName}\u0000${event.instrument}`;
      const existing = entries.get(key) ?? {
        rangeName: event.rangeName,
        instrument: event.instrument,
        realizedDollarsCents: 0,
        netTicksCents: 0,
        closedCount: 0,
        wins: 0,
        losses: 0,
        breakevens: 0,
      };
      existing.realizedDollarsCents = safeCentsSum(existing.realizedDollarsCents, event.realizedDollarsCents ?? 0);
      existing.netTicksCents = safeCentsSum(existing.netTicksCents, event.realizedTicksCents ?? 0);
      existing.closedCount += 1;
      if (event.outcome === 'win') existing.wins += 1;
      else if (event.outcome === 'loss') existing.losses += 1;
      else if (event.outcome === 'breakeven') existing.breakevens += 1;
      entries.set(key, existing);
      return entries;
    }, new Map<string, {
      rangeName: string;
      instrument: string;
      realizedDollarsCents: number;
      netTicksCents: number;
      closedCount: number;
      wins: number;
      losses: number;
      breakevens: number;
    }>()).values()]
      .sort((left, right) => left.rangeName.localeCompare(right.rangeName) || left.instrument.localeCompare(right.instrument));
  }

  getRangeTradeCalendarMonth(
    rangeName: string,
    now = new Date(),
    month?: string,
  ): {
    month: string;
    days: Array<{
      date: string;
      realizedDollarsCents: number;
      netTicksCents: number;
      closedCount: number;
      wins: number;
      losses: number;
      breakevens: number;
      winRate: number | null;
      hiddenFromPerformance?: boolean;
      ranges: Array<{
        rangeName: string;
        instrument: string;
        realizedDollarsCents: number;
        netTicksCents: number;
        closedCount: number;
        wins: number;
        losses: number;
        breakevens: number;
      }>;
      trades: RangeTradeEvent[];
    }>;
    summary: JournalMetrics;
  } {
    const resolvedRangeName = this.resolveTrackedRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    const trades = this.listClosedRangeTradesByRange(resolvedRangeName);
    return buildTradeCalendarMonth(trades, now, month, {
      hiddenDateKeys: this.listRangeHiddenCalendarDateKeys(resolvedRangeName),
      riskByRangeName: this.rangeRiskMap(),
    });
  }

  getSubcategoryTradeCalendarMonth(
    subcategoryName: string,
    now = new Date(),
    month?: string,
    includedRangeNames?: string[],
    week?: number,
  ): {
    month: string;
    days: Array<{
      date: string;
      realizedDollarsCents: number;
      netTicksCents: number;
      closedCount: number;
      wins: number;
      losses: number;
      breakevens: number;
      winRate: number | null;
      hiddenFromPerformance?: boolean;
      ranges: Array<{
        rangeName: string;
        instrument: string;
        realizedDollarsCents: number;
        netTicksCents: number;
        closedCount: number;
        wins: number;
        losses: number;
        breakevens: number;
      }>;
      trades: RangeTradeEvent[];
    }>;
    summary: JournalMetrics;
  } {
    const resolvedSubcategoryName = normalizeSubcategoryName(subcategoryName);
    if (!resolvedSubcategoryName) {
      return buildTradeCalendarMonth([], now, month, { hiddenDateKeys: new Set() });
    }
    const rows = this.db.prepare(
      `SELECT range_name
       FROM range_subcategory_assignments
       WHERE subcategory_name = ? COLLATE BINARY
       ORDER BY range_name COLLATE NOCASE ASC`,
    ).all(resolvedSubcategoryName) as unknown as Array<{ range_name: string }>;
    let rangeNames = rows.map((row) => row.range_name);
    if (includedRangeNames && includedRangeNames.length > 0) {
      const normalized = new Set(includedRangeNames.map((name) => this.resolveRangeName(name)));
      rangeNames = rangeNames.filter((name) => normalized.has(name));
    }
    if (rangeNames.length === 0) {
      return buildTradeCalendarMonth([], now, month, { hiddenDateKeys: new Set() });
    }
    const placeholders = rangeNames.map(() => '?').join(',');
    const eventRows = this.db.prepare(
      `SELECT id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id, adjustment_note
       FROM range_trade_events
       WHERE range_name IN (${placeholders}) AND event_type = 'trade_closed'
       ORDER BY occurred_at DESC, id DESC`,
    ).all(...rangeNames) as unknown as RangeTradeEventRow[];
    const trades = eventRows.map((row) => this.toRangeTradeEvent(row));
    const hiddenByEventRange = new Map<string, Set<string>>();
    for (const rangeName of rangeNames) {
      const resolvedRangeName =
        this.resolveTrackedRangeName(rangeName) ?? this.resolveRangeName(rangeName);
      hiddenByEventRange.set(rangeName, this.listRangeHiddenCalendarDateKeys(resolvedRangeName));
    }
    const visibleTrades = trades.filter((trade) => {
      const dateKey = fixedOffsetDateKey(trade.occurredAt, JOURNAL_TIME_OFFSET_MINUTES);
      const hidden = hiddenByEventRange.get(trade.rangeName);
      return !hidden?.has(dateKey);
    });
    const calendarOptions: { hiddenDateKeys: Set<string>; startAt?: string; endAt?: string; riskByRangeName?: ReadonlyMap<string, number> } = { hiddenDateKeys: new Set(), riskByRangeName: this.rangeRiskMap() };
    if (week != null && month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      const [year, monthPart] = month.split('-').map(Number);
      const monthIndex = monthPart - 1;
      const startDay = (week - 1) * 7 + 1;
      const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
      const endDay = Math.min(startDay + 6, daysInMonth);
      const offsetMilliseconds = JOURNAL_TIME_OFFSET_MINUTES * 60_000;
      calendarOptions.startAt = new Date(Date.UTC(year, monthIndex, startDay) - offsetMilliseconds).toISOString();
      calendarOptions.endAt = new Date(Date.UTC(year, monthIndex, endDay + 1) - offsetMilliseconds).toISOString();
    }
    return buildTradeCalendarMonth(visibleTrades, now, month, calendarOptions);
  }

  rangeRiskMap(): ReadonlyMap<string, number> {
    const rows = this.db.prepare(
      'SELECT range_name, risk_dollars_cents FROM range_configurations',
    ).all() as unknown as Array<{ range_name: string; risk_dollars_cents: number }>;
    return new Map(rows.map((row) => [row.range_name, row.risk_dollars_cents]));
  }

  listUserRangeNames(userId: string): string[] {
    const rows = this.db.prepare(
      `SELECT range_name FROM tracked_ranges WHERE created_by_user_id = ?
       UNION
       SELECT range_name FROM range_routes WHERE user_id = ?
       ORDER BY range_name COLLATE NOCASE ASC`,
    ).all(userId, userId) as unknown as Array<{ range_name: string }>;
    return [...new Set(rows.map((row) => row.range_name))];
  }

  getTradeJournal(userId: string, now = new Date(), accountId?: string | string[]): TradeJournal {
    const accountIds = Array.isArray(accountId) ? (accountId.length > 0 ? accountId : undefined) : (accountId ? [accountId] : undefined);
    const accountKey = accountIds ? [...accountIds].sort().join(',') : '';
    const cached = this.getCache<TradeJournal>(userId, 'journal', [accountKey]);
    if (cached) {
      console.info('[db] getTradeJournal cache hit', { hasAccountId: Boolean(accountIds) });
      return cached;
    }
    const start = Date.now();
    const closedTrades = this.listClosedTrades(userId, {
      includeExcluded: true,
      ...(accountIds ? { accountIds } : {}),
    });
    const openTrades = this.listOpenTrades(userId, {
      ...(accountIds ? { accountIds } : {}),
    });
    const cancelledOpenOrders = this.listCancelledOpenOrders(userId, {
      ...(accountIds ? { accountIds } : {}),
    });
    const bracketBase = (bracketId?: string) => (bracketId ? bracketId.replace(/-(long|short)(?=-arm-)/g, '') : '');
    const openBaseSideSet = new Set(openTrades.map((t) => `${t.accountId}:${bracketBase(t.bracketId)}:${t.side}`));
    const pairedClosedTrades = [...closedTrades, ...cancelledOpenOrders].filter((t) => {
      const oppositeSide = t.side === 'long' ? 'short' : 'long';
      return openBaseSideSet.has(`${t.accountId}:${bracketBase(t.bracketId)}:${oppositeSide}`);
    });
    const nonExcludedTrades = closedTrades.filter((event) => !event.excludedFromPerformance);
    const currentWeekStart = fixedOffsetWeekStart(now, JOURNAL_TIME_OFFSET_MINUTES);
    const currentDayStart = fixedOffsetDayStart(now, JOURNAL_TIME_OFFSET_MINUTES);
    const accounts = this.listAccounts(userId);
    const riskByRangeName = this.rangeRiskMap();
    const allTime = summarizeTrades(nonExcludedTrades, riskByRangeName);
    const currentWeek = summarizeTrades(nonExcludedTrades.filter((event) => event.occurredAt >= currentWeekStart), riskByRangeName);
    const currentDay = summarizeTrades(nonExcludedTrades.filter((event) => event.occurredAt >= currentDayStart), riskByRangeName);
    const accountJournals: AccountJournal[] = accounts.map((account) => {
      const accountTrades = nonExcludedTrades.filter((event) => event.accountId === account.id);
      const accountAllTime = summarizeTrades(accountTrades, riskByRangeName);
      const internalBalanceCents = safeCentsSum(account.startingBalanceCents, accountAllTime.realizedDollarsCents);
      return {
        account,
        allTime: accountAllTime,
        currentWeek: summarizeTrades(accountTrades.filter((event) => event.occurredAt >= currentWeekStart), riskByRangeName),
        currentDay: summarizeTrades(accountTrades.filter((event) => event.occurredAt >= currentDayStart), riskByRangeName),
        internalBalanceCents,
        stats: extendedTradeStats(accountTrades),
      };
    });
    const rangeNames = this.listUserRangeNames(userId);
    const rangeEntries = Object.fromEntries(
      (this.db.prepare('SELECT range_name, entries_per_range FROM range_configurations').all() as unknown as Array<{ range_name: string; entries_per_range: number }>)
        .map((row) => [row.range_name, row.entries_per_range]),
    );
    const rangeRisk = Object.fromEntries(riskByRangeName);
    const result = {
      allTime,
      currentWeek,
      currentDay,
      accounts: accountJournals,
      openTrades,
      pairedClosedTrades,
      recentClosedTrades: closedTrades,
      rangeNames,
      rangeEntries,
      rangeRisk,
    };
    this.setCache(userId, 'journal', [accountKey], result);
    console.info('[db] getTradeJournal', {
      duration: Date.now() - start,
      hasAccountId: Boolean(accountIds),
      openTradeCount: openTrades.length,
      tradeCount: closedTrades.length,
      accountCount: accounts.length,
    });
    return result;
  }

  saveTradovateConnection(userId: string, environment: 'demo', encryptedCredentials: string): void {
    this.db.prepare(
      `INSERT INTO tradovate_connections (user_id, environment, encrypted_credentials, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         environment = excluded.environment,
         encrypted_credentials = excluded.encrypted_credentials,
         updated_at = excluded.updated_at`,
    ).run(userId, environment, encryptedCredentials, new Date().toISOString());
  }

  getTradovateConnection(userId: string): {
    environment: 'demo';
    encryptedCredentials: string;
    accountId?: number;
    accountSpec?: string;
  } | undefined {
    const row = this.db.prepare(
      `SELECT environment, encrypted_credentials, account_id, account_spec
       FROM tradovate_connections WHERE user_id = ?`,
    ).get(userId) as unknown as TradovateConnectionRow | undefined;
    return row && {
      environment: row.environment,
      encryptedCredentials: row.encrypted_credentials,
      ...(row.account_id != null && row.account_spec ? { accountId: row.account_id, accountSpec: row.account_spec } : {}),
    };
  }

  setTradovateAccount(userId: string, accountId: number, accountSpec: string): void {
    this.db.prepare(
      `UPDATE tradovate_connections SET account_id = ?, account_spec = ?, updated_at = ?
       WHERE user_id = ?`,
    ).run(accountId, accountSpec, new Date().toISOString(), userId);
  }

  createDraft(draft: Omit<OrderDraft, 'id' | 'status' | 'receivedAt'>): { draft: OrderDraft; created: boolean } {
    const id = randomUUID();
    const created: OrderDraft = {
      ...draft,
      id,
      idempotencyKey: draft.idempotencyKey,
      status: 'pending',
      receivedAt: new Date().toISOString(),
    };
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO order_drafts (id, user_id, idempotency_key, status, payload_json, received_at, extension_eligible)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      created.id,
      created.userId,
      created.idempotencyKey,
      created.status,
      JSON.stringify(created),
      created.receivedAt,
      created.extensionEligible === false ? 0 : 1,
    );
    if (result.changes === 1) return { draft: created, created: true };
    const existingRow = this.db.prepare(
      `SELECT id, user_id, idempotency_key, status, payload_json, received_at, reviewed_at, submitted_at, extension_eligible
       FROM order_drafts WHERE user_id = ? AND idempotency_key = ?`,
    ).get(created.userId, created.idempotencyKey) as DraftRow | undefined;
    if (!existingRow) {
      throw new Error('failed to load existing order draft after idempotency conflict');
    }
    return { draft: this.toDraft(existingRow), created: false };
  }

  // extensionOnly filters to drafts whose subscription had the extension flag
  // on — the extension poll uses it so ext-off trades never badge or notify a
  // running extension, while the web Order Review keeps seeing everything.
  listDrafts(userId: string, status: DraftStatus = 'pending', options?: { extensionOnly?: boolean }): OrderDraft[] {
    const rows = this.db.prepare(
      `SELECT id, user_id, idempotency_key, status, payload_json, received_at, reviewed_at, submitted_at, extension_eligible
       FROM order_drafts WHERE user_id = ? AND status = ?
       AND (? = 0 OR extension_eligible = 1) ORDER BY received_at ASC`,
    ).all(userId, status, options?.extensionOnly ? 1 : 0) as unknown as DraftRow[];
    return rows.map((row) => this.toDraft(row));
  }

  countDrafts(status: DraftStatus = 'pending', userId?: string): number {
    const row = userId
      ? this.db.prepare(
        `SELECT COUNT(*) AS count
         FROM order_drafts
         WHERE status = ? AND user_id = ?`,
      ).get(status, userId) as { count: number }
      : this.db.prepare(
        `SELECT COUNT(*) AS count
         FROM order_drafts
         WHERE status = ?`,
      ).get(status) as { count: number };
    return row.count;
  }

  listRecentDrafts(
    userId: string,
    options: {
      limit: number;
      sinceHours?: number;
      status?: Exclude<DraftStatus, 'pending'> | 'all';
      query?: string;
      accountId?: string;
    },
  ): OrderDraft[] {
    const safeLimit = Math.min(Math.max(Math.trunc(options.limit), 1), 200);
    const safeSinceHours = options.sinceHours == null
      ? undefined
      : Math.min(Math.max(Math.trunc(options.sinceHours), 1), 168);
    const receivedAfter = safeSinceHours == null
      ? null
      : new Date(Date.now() - (safeSinceHours * 60 * 60 * 1000)).toISOString();
    const status = options.status ?? 'all';
    const rows = this.db.prepare(
      `SELECT id, user_id, idempotency_key, status, payload_json, received_at, reviewed_at, submitted_at, extension_eligible
       FROM order_drafts
       WHERE user_id = ? AND status <> 'pending'
         AND (? IS NULL OR received_at >= ?)
         AND (? = 'all' OR status = ?)
       ORDER BY received_at DESC
       LIMIT ?`,
    ).all(userId, receivedAfter, receivedAfter, status, status, safeLimit) as unknown as DraftRow[];
    let drafts = rows.map((row) => this.toDraft(row));
    if (options.accountId && options.accountId !== 'all') {
      drafts = drafts.filter((draft) => draft.accountId === options.accountId);
    }
    const normalizedQuery = options.query?.trim().toLowerCase();
    if (!normalizedQuery) return drafts;
    return drafts.filter((draft) => [
      draft.status,
      draft.action,
      draft.ticker,
      draft.orderType,
      draft.rangeName ?? '',
      draft.orderLeg ?? '',
      draft.cancellationMessage ?? '',
      draft.accountName ?? '',
      draft.accountId ?? '',
      String(draft.quantity),
    ].some((value) => value.toLowerCase().includes(normalizedQuery)));
  }

  clearDrafts(userId: string): number {
    return Number(this.db.prepare('DELETE FROM order_drafts WHERE user_id = ?').run(userId).changes);
  }

  markReviewed(userId: string, draftId: string): OrderDraft | undefined {
    const reviewedAt = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE order_drafts SET status = 'reviewed', reviewed_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
    ).run(reviewedAt, draftId, userId);
    if (result.changes !== 1) return undefined;
    const row = this.db.prepare(
      `SELECT id, user_id, idempotency_key, status, payload_json, received_at, reviewed_at, submitted_at, extension_eligible
       FROM order_drafts WHERE id = ?`,
    ).get(draftId) as unknown as DraftRow;
    return this.toDraft(row);
  }

  applyBrokerFillPriceToEntry(
    userId: string,
    accountId: string,
    rangeName: string,
    bracketId: string,
    tradeId: string | null | undefined,
    side: string,
    fillPrice: number,
    fillQty?: number,
  ): void {
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return;
    const hasQty = typeof fillQty === 'number' && Number.isFinite(fillQty) && fillQty > 0;
    // Broker averageFillPrice is authoritative — it supersedes Pine's computed
    // entry price (which can be fractional/off-tick) on the monitor row and the
    // journal entry_filled event. 'closed' rows upgrade too: the CT upgrade
    // path runs after trade_closed retired the monitor, and the realization it
    // writes alongside is computed from this same broker fill.
    const monitor = this.db.prepare(
      `UPDATE bracket_monitor SET entry_price = ?, updated_at = ?
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id IN (?, ?) AND side = ?
         AND state IN ('filled', 'closed') AND (entry_price IS NULL OR ABS(entry_price - ?) > 0.0001)`,
    ).run(fillPrice, new Date().toISOString(), accountId, rangeName, ...this.idFormsForLookup(rangeName, bracketId), side, fillPrice);
    // Broker fill qty is likewise authoritative — Pine can declare fractional
    // contract counts the wire had to round. Updated independently of price so
    // a matching price doesn't skip a qty correction.
    let monitorQty = { changes: 0 };
    if (hasQty) {
      monitorQty = this.db.prepare(
        `UPDATE bracket_monitor SET quantity = ?, updated_at = ?
         WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id IN (?, ?) AND side = ?
           AND state IN ('filled', 'closed') AND (quantity IS NULL OR ABS(quantity - ?) > 0.0001)`,
      ).run(fillQty, new Date().toISOString(), accountId, rangeName, ...this.idFormsForLookup(rangeName, bracketId), side, fillQty);
    }
    // trade_events has no bracket_id column — the entry_filled row keys on
    // trade_id, which is the monitor's tradeId for this bracket.
    if (tradeId) {
      const ev = this.db.prepare(
        `UPDATE trade_events SET entry_price = ?
         WHERE account_id = ? AND range_name = ? COLLATE BINARY AND trade_id IN (?, ?) AND side = ?
           AND event_type = 'entry_filled' AND (entry_price IS NULL OR ABS(entry_price - ?) > 0.0001)`,
      ).run(fillPrice, accountId, rangeName, ...this.idFormsForLookup(rangeName, tradeId), side, fillPrice);
      let evQty = { changes: 0 };
      let evCloseQty = { changes: 0 };
      if (hasQty) {
        evQty = this.db.prepare(
          `UPDATE trade_events SET quantity = ?
           WHERE account_id = ? AND range_name = ? COLLATE BINARY AND trade_id IN (?, ?) AND side = ?
             AND event_type = 'entry_filled' AND (quantity IS NULL OR ABS(quantity - ?) > 0.0001)`,
        ).run(fillQty, accountId, rangeName, ...this.idFormsForLookup(rangeName, tradeId), side, fillQty);
        // The closed-trade row carries its own quantity (drives the Closed
        // Trades table). Correct it with the entry, and rescale the realized
        // dollars — they are qty-proportional — when a prior quantity exists.
        // Realized ticks are per-contract price distance, not qty-scaled.
        evCloseQty = this.db.prepare(
          `UPDATE trade_events SET
             quantity = ?,
             realized_dollars_cents = CASE
               WHEN quantity IS NOT NULL AND quantity > 0 AND realized_dollars_cents IS NOT NULL
                 THEN CAST(ROUND(realized_dollars_cents * ? / quantity) AS INTEGER)
               ELSE realized_dollars_cents END
           WHERE account_id = ? AND range_name = ? COLLATE BINARY AND trade_id IN (?, ?) AND side = ?
             AND event_type = 'trade_closed' AND (quantity IS NULL OR ABS(quantity - ?) > 0.0001)`,
        ).run(fillQty, fillQty, accountId, rangeName, ...this.idFormsForLookup(rangeName, tradeId), side, fillQty);
      }
      // The range-scoped journal holds its own entry_filled row — keep it on
      // the same broker price so range/calendar consumers agree with the
      // account journal and the CT close calculation.
      const rangeEv = this.db.prepare(
        `UPDATE range_trade_events SET entry_price = ?
         WHERE range_name = ? COLLATE BINARY AND trade_id IN (?, ?) AND side = ?
           AND event_type = 'entry_filled' AND (entry_price IS NULL OR ABS(entry_price - ?) > 0.0001)`,
      ).run(fillPrice, rangeName, ...this.idFormsForLookup(rangeName, tradeId), side, fillPrice);
      // range_trade_events is shared across every account on the range —
      // fillQty is per-account (micros scaling, overrides), so writing it
      // here would corrupt other accounts' view. Price stays shared
      // (market-determined); quantity correction is account-scoped only.
      if (ev.changes > 0 || evQty.changes > 0 || evCloseQty.changes > 0) this.invalidateUserCache(userId);
      if (rangeEv.changes > 0) {
        for (const u of this.db.prepare(
          `SELECT DISTINCT a.user_id FROM range_routes r JOIN accounts a ON a.id = r.account_id WHERE r.range_name = ? COLLATE BINARY`,
        ).all(rangeName) as Array<{ user_id: string }>) {
          this.invalidateUserCache(u.user_id);
        }
      }
    }
    if (monitor.changes > 0 || monitorQty.changes > 0) this.invalidateUserCache(userId);
  }

  markAllPendingDraftsSubmitted(userId: string): number {
    const result = this.db.prepare(
      `UPDATE order_drafts SET status = 'submitted', submitted_at = ?
       WHERE user_id = ? AND status = 'pending'`,
    ).run(new Date().toISOString(), userId);
    return result.changes;
  }

  markSubmitted(userId: string, draftId: string): OrderDraft | undefined {
    const submittedAt = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE order_drafts SET status = 'submitted', submitted_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
    ).run(submittedAt, draftId, userId);
    if (result.changes !== 1) return undefined;
    const row = this.db.prepare(
      `SELECT id, user_id, idempotency_key, status, payload_json, received_at, reviewed_at, submitted_at, extension_eligible
       FROM order_drafts WHERE id = ?`,
    ).get(draftId) as unknown as DraftRow;
    return this.toDraft(row);
  }

  rejectDraft(userId: string, draftId: string): boolean {
    const result = this.db.prepare(
      `UPDATE order_drafts SET status = 'rejected'
       WHERE id = ? AND user_id = ? AND status = 'pending'`,
    ).run(draftId, userId);
    return result.changes === 1;
  }

  // Operator resend: a completed draft goes back to 'pending' so the extension
  // picks it up on its next poll — e.g. a draft that was submitted/rejected by
  // mistake or an order that needs to be filled again in Tradovate.
  resendDraft(userId: string, draftId: string): boolean {
    const result = this.db.prepare(
      `UPDATE order_drafts SET status = 'pending'
       WHERE id = ? AND user_id = ? AND status IN ('submitted', 'rejected', 'reviewed', 'expired')`,
    ).run(draftId, userId);
    return result.changes === 1;
  }

  private toDraft(row: DraftRow): OrderDraft {
    return {
      ...JSON.parse(row.payload_json) as OrderDraft,
      status: row.status,
      receivedAt: row.received_at,
      extensionEligible: row.extension_eligible !== 0,
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
      ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    };
  }

  private toAccount(row: AccountRow): BridgeAccount {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      startingBalanceCents: row.starting_balance_cents,
      ...(row.external_balance_cents != null ? { externalBalanceCents: row.external_balance_cents } : {}),
      ...(row.external_balance_at != null ? { externalBalanceAt: row.external_balance_at } : {}),
      deprecated: Boolean(row.deprecated),
      createdAt: row.created_at,
    };
  }

  private toRangeRoute(row: RangeRouteRow): RangeRoute {
    return {
      id: row.id,
      rangeName: row.range_name,
      userId: row.user_id,
      accountId: row.account_id,
      extensionEnabled: Boolean(row.extension_enabled),
      traderspostEnabled: Boolean(row.traderspost_enabled),
      runScheduled: Boolean(row.run_scheduled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toRangeConfiguration(row: RangeConfigurationRow): RangeConfiguration {
    return {
      rangeName: row.range_name,
      instrument: row.instrument,
      description: row.description,
      riskDollarsCents: row.risk_dollars_cents,
      rangeWindow: row.range_window,
      tradingSession: row.trading_session,
      takeProfitStyle: (row.take_profit_style ?? '').toLowerCase(),
      takeProfitTicksCents: row.take_profit_ticks_cents,
      stopLossStyle: (row.stop_loss_style ?? '').toLowerCase(),
      stopLossTicksCents: row.stop_loss_ticks_cents,
      breakEvenEnabled: Boolean(row.break_even_enabled),
      breakEvenTriggerTicksCents: row.break_even_trigger_ticks_cents,
      breakEvenOffsetTicksCents: row.break_even_offset_ticks_cents,
      ocoMode: row.oco_mode === 'both' ? 'both' : 'oco',
      stopOnlyEntries: Boolean(row.stop_only_entries),
      runMonday: Boolean(row.run_monday),
      runTuesday: Boolean(row.run_tuesday),
      runWednesday: Boolean(row.run_wednesday),
      runThursday: Boolean(row.run_thursday),
      runFriday: Boolean(row.run_friday),
      runSaturday: Boolean(row.run_saturday),
      runSunday: Boolean(row.run_sunday),
      entriesPerRange: row.entries_per_range,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private accountBelongsToUser(accountId: string, userId: string): boolean {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM accounts WHERE id = ? AND user_id = ?',
    ).get(accountId, userId));
  }

  private toAccountAlert(row: AccountAlertRow): AccountAlert {
    return {
      deliveryId: row.delivery_id,
      accountId: row.account_id,
      accountName: row.account_name,
      userId: row.user_id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      action: row.action,
      ticker: row.ticker,
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
      extensionEnabled: Boolean(row.extension_enabled),
      traderspostEnabled: Boolean(row.traderspost_enabled),
      deliveryStatus: row.delivery_status,
      ...(row.draft_id ? { draftId: row.draft_id } : {}),
      ...(row.draft_status ? { draftStatus: row.draft_status } : {}),
      ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
      ...(row.submitted_at ? { submittedAt: row.submitted_at } : {}),
    };
  }

  private toAlertFeedEntry(row: AlertFeedRow): AlertFeedEntry {
    return {
      alertId: row.id,
      receivedAt: row.received_at,
      ...(row.range_name ? { rangeName: row.range_name } : {}),
      action: row.action,
      ticker: row.ticker,
      payloadJson: row.payload_json,
      ...(row.source_reference ? { sourceReference: row.source_reference } : {}),
      deliveryCount: row.delivery_count,
      tradeEventCount: row.trade_event_count,
      matchedUserCount: row.matched_user_count,
      matchedUserEmails: this.splitFeedValues(row.matched_user_emails),
      matchedAccountCount: row.matched_account_count,
      matchedAccountNames: this.splitFeedValues(row.matched_account_names),
      traderspostDeliveredCount: row.traderspost_delivered_count,
      traderspostFailedCount: row.traderspost_failed_count,
      traderspostPendingCount: row.traderspost_pending_count,
      traderspostNotConfiguredCount: row.traderspost_not_configured_count,
      currentUserLinked: Boolean(row.current_user_linked),
    };
  }

  private toProxyDelivery(row: ProxyDeliveryRow): ProxyDelivery {
    return {
      id: row.id,
      proxyAlertId: row.proxy_alert_id,
      rangeRouteId: row.range_route_id,
      userId: row.user_id,
      accountId: row.account_id,
      extensionEnabled: Boolean(row.extension_enabled),
      traderspostEnabled: Boolean(row.traderspost_enabled),
      ...(row.draft_id ? { draftId: row.draft_id } : {}),
      ...(row.qualified_trade_id ? { qualifiedTradeId: row.qualified_trade_id } : {}),
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private toPreciseTakeProfitIntent(row: PreciseTakeProfitIntentRow): PreciseTakeProfitIntent {
    return {
      accountId: row.account_id,
      rangeName: row.range_name,
      bracketId: row.bracket_id,
      instrument: row.instrument,
      side: row.side,
      action: row.action,
      payloadJson: row.payload_json,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private listClosedTrades(
    userId: string,
    options: { limit?: number; startAt?: string; endAt?: string; accountId?: string; accountIds?: string[]; includeExcluded?: boolean } = {},
  ): TradeEvent[] {
    const { limit, startAt, endAt, accountId, includeExcluded } = options;
    const accountIds = options.accountIds ?? (accountId ? [accountId] : undefined);
    const start = Date.now();
    const conditions = [
      'user_id = ?',
      "event_type = 'trade_closed'",
    ];
    if (!includeExcluded) {
      conditions.push('excluded_from_performance = 0');
    }
    const params: (string | number)[] = [userId];
    if (accountIds && accountIds.length > 0) {
      if (accountIds.length === 1) {
        conditions.push('account_id = ?');
        params.push(accountIds[0]);
      } else {
        conditions.push(`account_id IN (${accountIds.map(() => '?').join(',')})`);
        params.push(...accountIds);
      }
    }
    if (startAt) {
      conditions.push('occurred_at >= ?');
      params.push(startAt);
    }
    if (endAt) {
      conditions.push('occurred_at < ?');
      params.push(endAt);
    }
    const suffix = [
      'ORDER BY occurred_at DESC, id DESC',
      ...(typeof limit === 'number' ? ['LIMIT ?'] : []),
    ];
    const allParams = [...params, ...(typeof limit === 'number' ? [limit] : [])];
    const rows = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id,
       (SELECT bracket_id FROM bracket_monitor AS bm
        WHERE bm.account_id = trade_events.account_id
          AND bm.range_name = trade_events.range_name
          AND bm.side = trade_events.side
          AND bm.trade_id = trade_events.trade_id
        LIMIT 1) AS bracket_id,
       event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
        occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at,
        adjustment_note, adjusted_at, adjusted_by_user_id, adjusted_by_email
        FROM trade_events
        WHERE ${conditions.join(' AND ')}
        ${suffix.join(' ')}`,
    ).all(...allParams) as unknown as TradeEventRow[];
    const events = rows.map((row) => this.toTradeEvent(row));
    console.info('[db] listClosedTrades', {
      duration: Date.now() - start,
      rowCount: events.length,
      hasAccountId: Boolean(accountIds && accountIds.length > 0),
      hasStartAt: Boolean(startAt),
      hasEndAt: Boolean(endAt),
      hasLimit: typeof limit === 'number',
    });
    return events;
  }

  private listCancelledOpenOrders(
    userId: string,
    options: { accountId?: string; accountIds?: string[]; limit?: number } = {},
  ): TradeEvent[] {
    const { limit } = options;
    const accountIds = options.accountIds ?? (options.accountId ? [options.accountId] : undefined);
    const start = Date.now();
    const conditions = ['user_id = ?', "event_type = 'entry_cancelled'"];
    const params: (string | number)[] = [userId];
    if (accountIds && accountIds.length > 0) {
      if (accountIds.length === 1) {
        conditions.push('account_id = ?');
        params.push(accountIds[0]);
      } else {
        conditions.push(`account_id IN (${accountIds.map(() => '?').join(',')})`);
        params.push(...accountIds);
      }
    }
    const suffix = [
      'ORDER BY occurred_at DESC, id DESC',
      ...(typeof limit === 'number' ? ['LIMIT ?'] : []),
    ];
    const allParams = [...params, ...(typeof limit === 'number' ? [limit] : [])];
    const rows = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id,
       (SELECT bracket_id FROM bracket_monitor AS bm
        WHERE bm.account_id = trade_events.account_id
          AND bm.range_name = trade_events.range_name
          AND bm.side = trade_events.side
          AND bm.trade_id = trade_events.trade_id
        LIMIT 1) AS bracket_id,
       event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
        occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at,
        adjustment_note, adjusted_at, adjusted_by_user_id, adjusted_by_email
        FROM trade_events
        WHERE ${conditions.join(' AND ')}
        ${suffix.join(' ')}`,
    ).all(...allParams) as unknown as TradeEventRow[];
    const events = rows.map((row) => this.toTradeEvent(row));
    console.info('[db] listCancelledOpenOrders', {
      duration: Date.now() - start,
      rowCount: events.length,
      hasAccountId: Boolean(accountIds && accountIds.length > 0),
      hasLimit: typeof limit === 'number',
    });
    return events;
  }

  private listOpenTrades(
    userId: string,
    options: { accountId?: string; accountIds?: string[]; limit?: number } = {},
  ): TradeEvent[] {
    const { limit } = options;
    const accountIds = options.accountIds ?? (options.accountId ? [options.accountId] : undefined);
    const start = Date.now();
    const now = new Date();
    const sessionStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22));
    if (now < sessionStart) {
      sessionStart.setUTCDate(sessionStart.getUTCDate() - 1);
    }
    const conditions = [
      'user_id = ?',
      "event_type IN ('entry_filled', 'entry_armed')",
    ];
    const params: (string | number)[] = [userId];
    if (accountIds && accountIds.length > 0) {
      if (accountIds.length === 1) {
        conditions.push('account_id = ?');
        params.push(accountIds[0]);
      } else {
        conditions.push(`account_id IN (${accountIds.map(() => '?').join(',')})`);
        params.push(...accountIds);
      }
    }
    const suffix = [
      "AND NOT EXISTS (SELECT 1 FROM trade_events c WHERE c.account_id = trade_events.account_id AND c.trade_id = trade_events.trade_id AND c.event_type = 'trade_closed')",
      "AND (trade_events.event_type = 'entry_filled' OR NOT EXISTS (SELECT 1 FROM trade_events c WHERE c.account_id = trade_events.account_id AND c.trade_id = trade_events.trade_id AND c.id != trade_events.id AND c.event_type IN ('entry_filled', 'entry_cancelled')))",
      'ORDER BY occurred_at DESC, id DESC',
    ];
    const allParams = [...params];
    const rows = this.db.prepare(
      `SELECT id, user_id, account_id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
        occurred_at, proxy_alert_id, excluded_from_performance, exclusion_reason, excluded_by_user_id, exclusion_updated_at,
        adjustment_note, adjusted_at, adjusted_by_user_id, adjusted_by_email
        FROM trade_events
        WHERE ${conditions.join(' AND ')}
        ${suffix.join(' ')}`,
    ).all(...allParams) as unknown as TradeEventRow[];
    let events = rows.map((row) => this.toTradeEvent(row));

    const monitorConditions = ['accounts.user_id = ?', "bracket_monitor.state IN ('armed', 'filled')", 'bracket_monitor.last_occurred_at >= ?'];
    const monitorParams: (string | number)[] = [userId, sessionStart.toISOString()];
    if (accountIds && accountIds.length > 0) {
      monitorConditions.push(`bracket_monitor.account_id IN (${accountIds.map(() => '?').join(',')})`);
      monitorParams.push(...accountIds);
    }
    const monitorRows = this.db.prepare(
      `SELECT bracket_monitor.account_id, bracket_monitor.range_name, bracket_monitor.bracket_id, bracket_monitor.side,
              bracket_monitor.instrument, bracket_monitor.state, bracket_monitor.quantity, bracket_monitor.trade_id,
              bracket_monitor.entry_price, bracket_monitor.last_event_id, bracket_monitor.last_occurred_at
       FROM bracket_monitor
       JOIN accounts ON bracket_monitor.account_id = accounts.id
       WHERE ${monitorConditions.join(' AND ')}`,
    ).all(...monitorParams) as unknown as BracketMonitorRow[];
    const monitorKey = (accountId: string, tradeId: string) => `${accountId}:${tradeId}`;
    const bracketIdByTradeId = new Map<string, string>();
    for (const row of monitorRows) {
      bracketIdByTradeId.set(monitorKey(row.account_id, row.trade_id), row.bracket_id);
    }
    const monitorTradeIds = new Set(monitorRows.map((row) => monitorKey(row.account_id, row.trade_id)));
    events = events.filter((e) => monitorTradeIds.has(monitorKey(e.accountId, e.tradeId)));
    for (const event of events) {
      event.bracketId = bracketIdByTradeId.get(monitorKey(event.accountId, event.tradeId)) ?? event.bracketId;
    }
    const openTradeIds = new Set(events.map((e) => monitorKey(e.accountId, e.tradeId)));
    for (const row of monitorRows) {
      if (openTradeIds.has(monitorKey(row.account_id, row.trade_id))) continue;
      const action = row.side === 'long' ? 'buy' : 'sell';
      const eventType: TradeEventType = row.state === 'filled' ? 'entry_filled' : 'entry_armed';
      const monitorEvent: TradeEvent = {
        id: `monitor:${row.account_id}:${row.range_name}:${row.bracket_id}:${row.side}`,
        userId,
        accountId: row.account_id,
        rangeName: row.range_name,
        eventId: row.last_event_id,
        tradeId: row.trade_id,
        bracketId: row.bracket_id,
        eventType,
        instrument: row.instrument,
        side: row.side as 'long' | 'short',
        action,
        quantity: row.quantity,
        ...(row.entry_price != null ? { entryPrice: row.entry_price } : {}),
        occurredAt: row.last_occurred_at,
        excludedFromPerformance: false,
      };
      events.push(monitorEvent);
    }
    events.sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
    if (typeof limit === 'number') {
      events = events.slice(0, limit);
    }

    const armedDeliveryStmt = this.db.prepare(
      `SELECT pd.id, pd.status
       FROM proxy_alerts pa
       LEFT JOIN proxy_deliveries pd ON pd.proxy_alert_id = pa.id AND pd.account_id = ?
       WHERE pa.action = ?
         AND pa.source_reference NOT LIKE '%-lifecycle-%'
         AND ? LIKE pa.source_reference || '%'
       ORDER BY
         CASE
           WHEN pd.status IN ('traderspost_delivered', 'extension_draft_created_and_traderspost_delivered') THEN 0
           WHEN pd.status IN ('traderspost_failed', 'extension_draft_created_and_traderspost_failed') THEN 1
           WHEN pd.status = 'extension_draft_created' THEN 2
           WHEN pd.id IS NOT NULL THEN 3
           ELSE 4
         END,
         pa.received_at DESC
       LIMIT 1`,
    );
    for (const event of events) {
      const row = armedDeliveryStmt.get(
        event.accountId,
        event.side === 'long' ? 'buy' : 'sell',
        event.tradeId,
      ) as { id: string | null; status: string | null } | undefined;
      if (row?.id) event.entryArmedDeliveryId = row.id;
      if (!row) {
        event.entryArmedDeliveryStatus = 'unknown';
      } else if (row.status == null) {
        event.entryArmedDeliveryStatus = 'unknown';
      } else if (
        row.status === 'traderspost_delivered' ||
        row.status === 'extension_draft_created_and_traderspost_delivered'
      ) {
        event.entryArmedDeliveryStatus = 'delivered';
      } else if (
        row.status === 'traderspost_failed' ||
        row.status === 'extension_draft_created_and_traderspost_failed'
      ) {
        event.entryArmedDeliveryStatus = 'failed';
      } else if (row.status === 'extension_draft_created') {
        event.entryArmedDeliveryStatus = 'extension';
      } else if (row.status.startsWith('suppressed_')) {
        event.entryArmedDeliveryStatus = 'blocked';
        event.entryArmedDeliveryDetail = row.status;
      } else {
        event.entryArmedDeliveryStatus = 'unknown';
      }
    }

    const routeTPEnabledStmt = this.db.prepare(
      'SELECT traderspost_enabled FROM range_routes WHERE account_id = ? AND range_name = ? COLLATE BINARY',
    );
    for (const event of events) {
      if (event.entryArmedDeliveryStatus !== 'unknown') continue;
      const routeRow = routeTPEnabledStmt.get(event.accountId, event.rangeName) as { traderspost_enabled: number } | undefined;
      if (routeRow && routeRow.traderspost_enabled === 0) {
        event.entryArmedDeliveryStatus = 'extension';
      }
    }

    const routeRunScheduledStmt = this.db.prepare(
      'SELECT run_scheduled FROM range_routes WHERE account_id = ? AND range_name = ? COLLATE BINARY',
    );
    const rangeConfigCache = new Map<string, RangeConfiguration | undefined>();
    for (const event of events) {
      if (event.entryArmedDeliveryStatus !== 'unknown') continue;
      const routeRow = routeRunScheduledStmt.get(event.accountId, event.rangeName) as { run_scheduled: number } | undefined;
      if (!routeRow || !routeRow.run_scheduled) continue;
      let config = rangeConfigCache.get(event.rangeName);
      if (config === undefined && !rangeConfigCache.has(event.rangeName)) {
        config = this.getRangeConfiguration(event.rangeName);
        rangeConfigCache.set(event.rangeName, config);
      }
      if (!config) continue;
      const dateKey = fixedOffsetDateKey(event.occurredAt, JOURNAL_TIME_OFFSET_MINUTES);
      const runConfig = {
        run_monday: Number(config.runMonday),
        run_tuesday: Number(config.runTuesday),
        run_wednesday: Number(config.runWednesday),
        run_thursday: Number(config.runThursday),
        run_friday: Number(config.runFriday),
        run_saturday: Number(config.runSaturday),
        run_sunday: Number(config.runSunday),
      };
      if (!rangeRunsOnDate(runConfig, dateKey)) {
        event.entryArmedDeliveryStatus = 'extension';
      }
    }

    console.info('[db] listOpenTrades', {
      duration: Date.now() - start,
      rowCount: events.length,
      hasAccountId: Boolean(accountIds && accountIds.length > 0),
      hasLimit: typeof limit === 'number',
    });
    return events;
  }

  listOpenTradeSanity(userId: string): OpenTradeSanity[] {
    const start = Date.now();
    const now = new Date();
    const sessionStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22));
    if (now < sessionStart) {
      sessionStart.setUTCDate(sessionStart.getUTCDate() - 1);
    }
    const monitorRows = this.db.prepare(
      `SELECT bracket_monitor.account_id, bracket_monitor.range_name, bracket_monitor.bracket_id, bracket_monitor.side,
              bracket_monitor.instrument, bracket_monitor.state, bracket_monitor.quantity, bracket_monitor.trade_id,
              bracket_monitor.entry_price, bracket_monitor.last_event_id, bracket_monitor.last_event_type, bracket_monitor.last_occurred_at,
              accounts.name AS account_name
       FROM bracket_monitor
       JOIN accounts ON bracket_monitor.account_id = accounts.id
       WHERE accounts.user_id = ?
         AND bracket_monitor.state IN ('armed', 'filled')
         AND bracket_monitor.last_occurred_at >= ?
       ORDER BY bracket_monitor.last_occurred_at DESC`,
    ).all(userId, sessionStart.toISOString()) as unknown as Array<BracketMonitorRow & { account_name: string }>;

    const latestEventStmt = this.db.prepare(
      `SELECT event_type, occurred_at FROM trade_events
       WHERE account_id = ? AND trade_id = ? AND side = ?
       ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    const dispatchAlertStmt = this.db.prepare(
      `SELECT pa.id, pa.received_at, pa.action FROM proxy_alerts pa
       WHERE pa.action IN ('buy', 'sell')
         AND pa.source_reference NOT LIKE '%-lifecycle-%'
         AND ? LIKE pa.source_reference || '%'
       ORDER BY pa.received_at DESC, pa.id DESC LIMIT 1`,
    );
    const lifecycleAlertStmt = this.db.prepare(
      `SELECT 1 FROM proxy_alerts WHERE source_reference = ? LIMIT 1`,
    );
    const deliveryStmt = this.db.prepare(
      `SELECT status, created_at FROM proxy_deliveries
       WHERE proxy_alert_id = ? AND account_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    );
    const routeStmt = this.db.prepare(
      `SELECT traderspost_enabled, extension_enabled, run_scheduled
       FROM range_routes
       WHERE account_id = ? AND range_name = ? COLLATE BINARY`,
    );
    const oppositeStmt = this.db.prepare(
      `SELECT state FROM bracket_monitor
       WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side != ?
       LIMIT 1`,
    );
    // The monitor row says Pine considers the bracket armed/filled; the broker
    // ledger says what happened to the actual dispatch. Reapply replacements key
    // broker_orders.order_id to the monitor bracket_id; ordinary entries key
    // bracket_id — both are checked so a webhook-accepted-but-broker-rejected
    // order (resolved later, e.g. via the failure-email ingest) still surfaces.
    const brokerOrderStmt = this.db.prepare(
      `SELECT status, error_text, created_at FROM broker_orders
       WHERE account_id = ? AND (order_id = ? OR (bracket_id = ? AND range_name = ? COLLATE BINARY)) AND action = ?
       ORDER BY created_at DESC LIMIT 1`,
    );

    const results: OpenTradeSanity[] = monitorRows.map((row) => {
      const eventRow = latestEventStmt.get(row.account_id, row.trade_id, row.side) as
        | { event_type: string; occurred_at: string }
        | undefined;
      const dispatchAlert = dispatchAlertStmt.get(row.trade_id) as
        | { id: string; received_at: string; action: string }
        | undefined;
      const lifecycleAlert = row.last_event_id
        ? (lifecycleAlertStmt.get(row.last_event_id) as { 1: number } | undefined)
        : undefined;
      const delivery = dispatchAlert
        ? (deliveryStmt.get(dispatchAlert.id, row.account_id) as { status: string; created_at: string } | undefined)
        : undefined;
      const routeRow = routeStmt.get(row.account_id, row.range_name) as
        | { traderspost_enabled: number; extension_enabled: number; run_scheduled: number }
        | undefined;
      const opposite = oppositeStmt.get(row.account_id, row.range_name, row.bracket_id, row.side) as
        | { state: string }
        | undefined;
      const entryAction = row.side === 'long' ? 'buy' : 'sell';
      const brokerOrder = brokerOrderStmt.get(row.account_id, row.bracket_id, row.bracket_id, row.range_name, entryAction) as
        | { status: string; error_text: string | null; created_at: string }
        | undefined;

      const rangeConfiguration = routeRow?.run_scheduled ? this.getRangeConfiguration(row.range_name) : undefined;
      const dateKey = fixedOffsetDateKey(row.last_occurred_at, JOURNAL_TIME_OFFSET_MINUTES);
      const isScheduledDay = rangeConfiguration
        ? rangeRunsOnDate({
            run_monday: Number(rangeConfiguration.runMonday),
            run_tuesday: Number(rangeConfiguration.runTuesday),
            run_wednesday: Number(rangeConfiguration.runWednesday),
            run_thursday: Number(rangeConfiguration.runThursday),
            run_friday: Number(rangeConfiguration.runFriday),
            run_saturday: Number(rangeConfiguration.runSaturday),
            run_sunday: Number(rangeConfiguration.runSunday),
          }, dateKey)
        : undefined;

      return {
        accountId: row.account_id,
        accountName: row.account_name,
        rangeName: row.range_name,
        instrument: row.instrument,
        side: row.side as 'long' | 'short',
        bracketId: row.bracket_id,
        tradeId: row.trade_id,
        state: row.state as BracketMonitorState,
        quantity: row.quantity,
        entryPrice: row.entry_price ?? undefined,
        lastOccurredAt: row.last_occurred_at,
        hasTradeEvent: eventRow !== undefined,
        tradeEventType: eventRow?.event_type as TradeEventType | undefined,
        tradeEventOccurredAt: eventRow?.occurred_at,
        hasLifecycleAlert: lifecycleAlert !== undefined,
        hasDispatchAlert: dispatchAlert !== undefined,
        dispatchAlertReceivedAt: dispatchAlert?.received_at,
        dispatchAlertAction: dispatchAlert?.action as 'buy' | 'sell' | undefined,
        deliveryStatus: delivery?.status,
        deliveryCreatedAt: delivery?.created_at,
        brokerOrderStatus: brokerOrder?.status as BrokerOrderState | undefined,
        brokerOrderErrorText: brokerOrder?.error_text ?? undefined,
        brokerOrderOccurredAt: brokerOrder?.created_at,
        routeTraderspostEnabled: Boolean(routeRow?.traderspost_enabled),
        routeExtensionEnabled: Boolean(routeRow?.extension_enabled),
        routeRunScheduled: Boolean(routeRow?.run_scheduled),
        isScheduledDay,
        oppositeSideExists: opposite !== undefined,
        oppositeSideState: opposite?.state as BracketMonitorState | undefined,
      };
    });
    console.info('[db] listOpenTradeSanity', { duration: Date.now() - start, rowCount: results.length });
    return results;
  }

  getOpenTradeQuantity(
    accountId: string,
    rangeName: string,
    instrument: string,
    side: 'long' | 'short',
    excludeEventId: string,
  ): number {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN event_type = 'entry_filled' THEN quantity ELSE -quantity END), 0) AS open_quantity
       FROM trade_events
       WHERE account_id = ?
         AND range_name = ? COLLATE BINARY
         AND instrument = ?
         AND side = ?
         AND event_type IN ('entry_filled', 'exit_filled', 'trade_closed')
         AND event_id != ?`,
    ).get(accountId, resolvedRangeName, instrument, side, excludeEventId) as { open_quantity: number } | undefined;
    return Math.max(0, row?.open_quantity ?? 0);
  }

  getAccountOpenInstruments(accountId: string): string[] {
    const rows = this.db.prepare(
      `SELECT instrument
       FROM (
         SELECT instrument
         FROM trade_events
         WHERE account_id = ?
           AND event_type IN ('entry_filled', 'exit_filled', 'trade_closed')
         GROUP BY instrument
         HAVING SUM(CASE WHEN event_type = 'entry_filled' THEN quantity ELSE -quantity END) > 0
         UNION
         SELECT DISTINCT instrument
         FROM bracket_monitor
         WHERE account_id = ? AND state = 'filled'
       )
       ORDER BY instrument COLLATE NOCASE`,
    ).all(accountId, accountId) as { instrument: string }[];
    return rows.map((row) => row.instrument);
  }

  hasUnrelatedOpenPosition(
    accountId: string,
    instrument: string,
    rangeName: string,
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM (
         SELECT range_name
         FROM trade_events
         WHERE account_id = ?
           AND instrument = ?
           AND event_type IN ('entry_filled', 'exit_filled', 'trade_closed')
         GROUP BY range_name
         HAVING SUM(CASE WHEN event_type = 'entry_filled' THEN quantity ELSE -quantity END) > 0
         UNION
         SELECT range_name
         FROM bracket_monitor
         WHERE account_id = ?
           AND instrument = ?
           AND state = 'filled'
       )
       WHERE range_name <> ? COLLATE BINARY`,
    ).get(accountId, instrument, accountId, instrument, resolvedRangeName) as { 1: number } | undefined;
    return !!row;
  }

  hasUnrelatedOpenOrder(
    accountId: string,
    instrument: string,
    rangeName: string,
  ): boolean {
    const resolvedRangeName = this.resolveRangeName(rangeName) ?? rangeName;
    const row = this.db.prepare(
      `SELECT 1
       FROM proxy_deliveries pd
       JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
       WHERE pd.account_id = ?
         AND pa.ticker = ?
         AND pa.range_name <> ? COLLATE BINARY
         AND pa.action IN ('buy', 'sell')
         AND (pd.status LIKE '%pending%' OR pd.status LIKE '%delivered%' OR pd.status = 'extension_draft_created')
         AND NOT EXISTS (
           SELECT 1
           FROM range_trade_events rte
           WHERE (rte.trade_id = pa.source_reference OR rte.trade_id LIKE (pa.source_reference || '-lifecycle-%'))
             AND rte.event_type IN ('entry_filled', 'entry_cancelled')
         )`,
    ).get(accountId, instrument, resolvedRangeName) as { 1: number } | undefined;
    return !!row;
  }

  private listClosedRangeTradesByRange(rangeName: string): RangeTradeEvent[] {
    const resolvedRangeName = this.resolveRangeName(rangeName);
    const rows = this.db.prepare(
      `SELECT id, range_name, event_id, trade_id, event_type, instrument, side, action,
       quantity, entry_price, exit_price, realized_ticks_cents, realized_dollars_cents, outcome,
       occurred_at, proxy_alert_id, adjustment_note
       FROM range_trade_events
       WHERE range_name = ? COLLATE BINARY AND event_type = 'trade_closed'
       ORDER BY occurred_at DESC, id DESC`,
    ).all(resolvedRangeName) as unknown as RangeTradeEventRow[];
    return rows.map((row) => this.toRangeTradeEvent(row));
  }

  private listRangeHiddenCalendarDateKeys(rangeName: string): Set<string> {
    const rows = this.db.prepare(
      `SELECT date_key
       FROM range_calendar_visibility
       WHERE range_name = ? COLLATE BINARY`,
    ).all(rangeName) as Array<{ date_key: string }>;
    return new Set(rows.map((row) => row.date_key));
  }

  private listRangeHiddenCalendarDateKeysByRange(): Map<string, Set<string>> {
    const rows = this.db.prepare(
      `SELECT range_name, date_key, hidden_by_user_id, updated_at
       FROM range_calendar_visibility`,
    ).all() as unknown as RangeCalendarVisibilityRow[];
    const hiddenDateKeysByRange = new Map<string, Set<string>>();
    for (const row of rows) {
      const dateKeys = hiddenDateKeysByRange.get(row.range_name) ?? new Set<string>();
      dateKeys.add(row.date_key);
      hiddenDateKeysByRange.set(row.range_name, dateKeys);
    }
    return hiddenDateKeysByRange;
  }

  syncRangeCalendarVisibilityWithSchedules(rangeNames?: string[], fallbackUserId?: string): void {
    const targetRangeNames = (rangeNames ?? this.listTrackedRangeNames())
      .map((rangeName) => this.resolveTrackedRangeName(rangeName) ?? this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName))
      .filter((rangeName): rangeName is string => Boolean(rangeName));
    if (!targetRangeNames.length) return;
    const uniqueRangeNames = [...new Set(targetRangeNames)];
    const placeholders = uniqueRangeNames.map(() => '?').join(',');
    const configurationRows = this.db.prepare(
      `SELECT range_configurations.range_name,
        COALESCE(
          (
            SELECT tracked_ranges.created_by_user_id
            FROM tracked_ranges
            WHERE tracked_ranges.range_name = range_configurations.range_name COLLATE BINARY
            LIMIT 1
          ),
          (
            SELECT range_routes.user_id
            FROM range_routes
            WHERE range_routes.range_name = range_configurations.range_name COLLATE BINARY
            ORDER BY range_routes.created_at ASC
            LIMIT 1
          )
        ) AS owner_user_id,
        range_configurations.run_monday, range_configurations.run_tuesday,
        range_configurations.run_wednesday, range_configurations.run_thursday, range_configurations.run_friday,
        range_configurations.run_saturday, range_configurations.run_sunday
       FROM range_configurations
       WHERE range_configurations.range_name IN (${placeholders})`,
    ).all(...uniqueRangeNames) as Array<{
      range_name: string;
      owner_user_id: string | null;
      run_monday: number;
      run_tuesday: number;
      run_wednesday: number;
      run_thursday: number;
      run_friday: number;
      run_saturday: number;
      run_sunday: number;
    }>;
    if (!configurationRows.length) return;
    const configurationByRange = new Map(configurationRows.map((row) => [row.range_name, row] as const));
    const tradeRows = this.db.prepare(
      `SELECT range_name, occurred_at
       FROM range_trade_events
       WHERE event_type = 'trade_closed'
         AND range_name IN (${placeholders})
       ORDER BY occurred_at ASC`,
    ).all(...uniqueRangeNames) as Array<{ range_name: string; occurred_at: string }>;
    const existingHiddenDateKeysByRange = this.listRangeHiddenCalendarDateKeysByRange();
    const deleteHiddenDate = this.db.prepare(
      'DELETE FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY AND date_key = ?',
    );
    const insertHiddenDate = this.db.prepare(
      `INSERT INTO range_calendar_visibility (range_name, date_key, hidden_by_user_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(range_name, date_key) DO NOTHING`,
    );
    const now = new Date().toISOString();
    const cutoff = fixedOffsetDateKey(now, JOURNAL_TIME_OFFSET_MINUTES);
    for (const [rangeName, hiddenDateKeys] of existingHiddenDateKeysByRange.entries()) {
      const configuration = configurationByRange.get(rangeName);
      if (!configuration) continue;
      for (const dateKey of hiddenDateKeys) {
        if (dateKey < cutoff) continue;
        if (rangeRunsOnDate(configuration, dateKey)) {
          deleteHiddenDate.run(rangeName, dateKey);
        }
      }
    }
    for (const row of tradeRows) {
      const configuration = configurationByRange.get(row.range_name);
      if (!configuration) continue;
      const ownerUserId = configuration.owner_user_id ?? fallbackUserId;
      if (!ownerUserId) continue;
      const dateKey = fixedOffsetDateKey(row.occurred_at, JOURNAL_TIME_OFFSET_MINUTES);
      if (dateKey < cutoff) continue;
      const hiddenDateKeys = existingHiddenDateKeysByRange.get(row.range_name) ?? new Set<string>();
      if (hiddenDateKeys.has(dateKey)) continue;
      if (rangeRunsOnDate(configuration, dateKey)) continue;
      insertHiddenDate.run(row.range_name, dateKey, ownerUserId, now);
      hiddenDateKeys.add(dateKey);
      existingHiddenDateKeysByRange.set(row.range_name, hiddenDateKeys);
    }
    const ownerUserIds = new Set<string>();
    if (fallbackUserId) ownerUserIds.add(fallbackUserId);
    for (const row of configurationRows) {
      if (row.owner_user_id) ownerUserIds.add(row.owner_user_id);
    }
    for (const userId of ownerUserIds) {
      this.invalidateUserCache(userId);
    }
  }

  private toTradeEvent(row: TradeEventRow): TradeEvent {
    return {
      id: row.id,
      userId: row.user_id,
      accountId: row.account_id,
      rangeName: row.range_name,
      eventId: row.event_id,
      tradeId: row.trade_id,
      bracketId: row.bracket_id ?? undefined,
      eventType: row.event_type,
      instrument: row.instrument,
      side: row.side,
      ...(row.action ? { action: row.action } : {}),
      quantity: row.quantity,
      ...(row.entry_price != null ? { entryPrice: row.entry_price } : {}),
      ...(row.exit_price != null ? { exitPrice: row.exit_price } : {}),
      ...(row.realized_ticks_cents != null ? { realizedTicksCents: row.realized_ticks_cents } : {}),
      ...(row.realized_dollars_cents != null ? { realizedDollarsCents: row.realized_dollars_cents } : {}),
      ...(row.outcome ? { outcome: row.outcome } : {}),
      occurredAt: row.occurred_at,
      ...(row.proxy_alert_id ? { proxyAlertId: row.proxy_alert_id } : {}),
      excludedFromPerformance: Boolean(row.excluded_from_performance),
      ...(row.exclusion_reason ? { exclusionReason: row.exclusion_reason } : {}),
      ...(row.excluded_by_user_id ? { excludedByUserId: row.excluded_by_user_id } : {}),
      ...(row.exclusion_updated_at ? { exclusionUpdatedAt: row.exclusion_updated_at } : {}),
      ...(row.adjustment_note ? { adjustmentNote: row.adjustment_note } : {}),
      ...(row.exclusion_marker ? { exclusionMarker: row.exclusion_marker } : {}),
      ...(row.adjusted_at ? { adjustedAt: row.adjusted_at } : {}),
      ...(row.adjusted_by_user_id ? { adjustedByUserId: row.adjusted_by_user_id } : {}),
      ...(row.adjusted_by_email ? { adjustedByEmail: row.adjusted_by_email } : {}),
    };
  }

  private toRangeTradeEvent(row: RangeTradeEventRow): RangeTradeEvent {
    return {
      id: row.id,
      rangeName: row.range_name,
      eventId: row.event_id,
      tradeId: row.trade_id,
      eventType: row.event_type,
      instrument: row.instrument,
      side: row.side,
      ...(row.action ? { action: row.action } : {}),
      quantity: row.quantity,
      ...(row.entry_price != null ? { entryPrice: row.entry_price } : {}),
      ...(row.exit_price != null ? { exitPrice: row.exit_price } : {}),
      ...(row.realized_ticks_cents != null ? { realizedTicksCents: row.realized_ticks_cents } : {}),
      ...(row.realized_dollars_cents != null ? { realizedDollarsCents: row.realized_dollars_cents } : {}),
      ...(row.outcome ? { outcome: row.outcome } : {}),
      occurredAt: row.occurred_at,
      ...(row.proxy_alert_id ? { proxyAlertId: row.proxy_alert_id } : {}),
      ...(row.adjustment_note ? { adjustmentNote: row.adjustment_note } : {}),
    };
  }

  resolveRangeName(rangeName: string): string {
    return normalizeRangeName(rangeName);
  }

  resolveTrackedRangeName(rangeName: string): string | undefined {
    const resolvedRangeName = this.resolveStoredRangeName(rangeName) ?? this.resolveRangeName(rangeName);
    if (!resolvedRangeName) return undefined;
    if (this.isRangeExplicitlyTracked(resolvedRangeName)) return resolvedRangeName;
    return this.resolveSingleRStoredRangeAlias(resolvedRangeName);
  }

  isRangeExplicitlyTracked(rangeName: string): boolean {
    const resolvedRangeName = normalizeRangeName(rangeName);
    return Boolean(this.db.prepare(
      `SELECT 1 FROM range_routes WHERE range_name = ? COLLATE BINARY
       UNION
       SELECT 1 FROM tracked_ranges WHERE range_name = ? COLLATE BINARY
       UNION
       SELECT 1 FROM range_configurations WHERE range_name = ? COLLATE BINARY
       UNION
       SELECT 1 FROM range_review_flags WHERE range_name = ? COLLATE BINARY
       UNION
       SELECT 1 FROM range_subcategory_assignments WHERE range_name = ? COLLATE BINARY
       LIMIT 1`,
    ).get(resolvedRangeName, resolvedRangeName, resolvedRangeName, resolvedRangeName, resolvedRangeName));
  }

  private listExplicitlyTrackedRangeNames(): string[] {
    const rows = this.db.prepare(
      `SELECT range_name FROM range_routes
       UNION
       SELECT range_name FROM tracked_ranges
       UNION
       SELECT range_name FROM range_configurations
       UNION
       SELECT range_name FROM range_review_flags
       UNION
       SELECT range_name FROM range_subcategory_assignments`,
    ).all() as Array<{ range_name: string }>;
    return rows.map((row) => row.range_name);
  }

  // One-shot name resolver for batch endpoints (e.g. /api/ranges): prefetch the
  // three name sets once, then resolve each range in pure JS. The per-name path
  // (resolveTrackedRangeName/resolveRangeName) issues several multi-table UNION
  // queries per call — fine singly, ruinous × hundreds of names on slow disk.
  // Replicates `resolveTrackedRangeName(name) ?? resolveRangeName(name)` —
  // falls back to the input when neither resolves.
  createRangeNameResolver(): (rangeName: string) => string {
    const storedNames = this.listStoredRangeNames();
    const trackedNames = new Set(this.listExplicitlyTrackedRangeNames());
    const selectableNormalized = new Set(
      this.listSelectableRangeNames().map((name) => normalizeRangeName(name)),
    );
    const cache = new Map<string, string>();
    return (rangeName) => {
      const cached = cache.get(rangeName);
      if (cached !== undefined) return cached;
      const resolved = this.resolveStoredRangeAliasesFromList(storedNames, rangeName)[0]
        ?? this.resolveRangeName(rangeName);
      let value: string;
      if (!resolved) {
        value = rangeName;
      } else if (trackedNames.has(resolved)) {
        value = resolved;
      } else {
        const normalizedRangeName = normalizeRangeName(rangeName);
        const candidates = [...selectableNormalized]
          .filter((candidate) => candidate !== normalizedRangeName && isSingleRMissingVariant(normalizedRangeName, candidate));
        // Matches the caller's `?? resolveRangeName(name)` fallback exactly.
        value = candidates.length === 1 ? candidates[0] : this.resolveRangeName(rangeName);
      }
      cache.set(rangeName, value);
      return value;
    };
  }

  private listStoredRangeNames(): string[] {
    const rows = this.db.prepare(
      `SELECT DISTINCT range_name
       FROM (
         SELECT range_name FROM range_routes
         UNION ALL
         SELECT range_name FROM tracked_ranges
         UNION ALL
         SELECT range_name FROM range_configurations
         UNION ALL
         SELECT range_name FROM range_review_flags
         UNION ALL
         SELECT range_name FROM range_trade_events
         UNION ALL
         SELECT range_name FROM range_subcategory_assignments
         UNION ALL
          SELECT range_name FROM proxy_alerts
          UNION ALL
          SELECT range_name FROM trade_events
          UNION ALL
          SELECT range_name FROM range_calendar_visibility
        )
        WHERE range_name IS NOT NULL`,
    ).all() as Array<{ range_name: string }>;
    return rows.map((row) => row.range_name);
  }

  private resolveStoredRangeAliases(rangeName: string): string[] {
    return this.resolveStoredRangeAliasesFromList(this.listStoredRangeNames(), rangeName);
  }

  private resolveStoredRangeAliasesFromList(storedNames: string[], rangeName: string): string[] {
    const resolvedRangeName = normalizeRangeName(rangeName);
    const normalizedDisplayRangeName = normalizeRangeDisplayName(rangeName);
    if (!resolvedRangeName || !normalizedDisplayRangeName) return [];
    return storedNames
      .filter((storedRangeName) => {
        if (normalizeRangeName(storedRangeName) === resolvedRangeName) return true;
        return normalizeRangeDisplayName(storedRangeName) === normalizedDisplayRangeName;
      })
      .sort((left, right) => {
        const leftPriority = normalizeRangeName(left) === resolvedRangeName ? 0 : 1;
        const rightPriority = normalizeRangeName(right) === resolvedRangeName ? 0 : 1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        if (left.length !== right.length) return left.length - right.length;
        return left.localeCompare(right);
      });
  }

  private resolveStoredRangeName(rangeName: string): string | undefined {
    return this.resolveStoredRangeAliases(rangeName)[0];
  }

  // Stored spelling of an existing range matching the input, or undefined.
  // Case-insensitive so a differently-cased duplicate is reported rather than
  // inserted as a second range (tracked_ranges uses COLLATE BINARY).
  findStoredRangeName(rangeName: string): string | undefined {
    const resolvedRangeName = normalizeRangeName(rangeName);
    if (!resolvedRangeName) return undefined;
    const exact = this.resolveStoredRangeName(resolvedRangeName);
    if (exact) return exact;
    const lowered = resolvedRangeName.toLowerCase();
    return this.listStoredRangeNames().find((stored) => stored.toLowerCase() === lowered);
  }

  private rangeExists(rangeName: string): boolean {
    return Boolean(this.resolveStoredRangeName(rangeName) || this.isRangeExplicitlyTracked(rangeName));
  }
}

function emptyAccountAlertSummary(): AccountAlertSummary {
  return {
    totalReceived: 0,
    processed: 0,
    extensionPending: 0,
    extensionReviewed: 0,
    extensionSubmitted: 0,
    extensionRejected: 0,
    traderspostDelivered: 0,
    traderspostPending: 0,
    traderspostFailed: 0,
    traderspostNotConfigured: 0,
    ignored: 0,
    noDestination: 0,
  };
}

function fixedOffsetDayStart(now: Date, offsetMinutes: number): string {
  const offsetMilliseconds = offsetMinutes * 60_000;
  const shifted = new Date(now.getTime() + offsetMilliseconds);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMilliseconds,
  ).toISOString();
}

function fixedOffsetWeekStart(now: Date, offsetMinutes: number): string {
  const offsetMilliseconds = offsetMinutes * 60_000;
  const shifted = new Date(now.getTime() + offsetMilliseconds);
  const day = shifted.getUTCDay();
  const daysSinceSunday = day;
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysSinceSunday)
      - offsetMilliseconds,
  ).toISOString();
}

function fixedOffsetMonthStart(now: Date, offsetMinutes: number): string {
  const offsetMilliseconds = offsetMinutes * 60_000;
  const shifted = new Date(now.getTime() + offsetMilliseconds);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - offsetMilliseconds,
  ).toISOString();
}

function fixedOffsetDateParts(value: string | Date, offsetMinutes: number): { year: number; month: number; day: number } {
  const date = typeof value === 'string' ? new Date(value) : value;
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function padCalendarNumber(value: number): string {
  return value.toString().padStart(2, '0');
}

function fixedOffsetDateKey(value: string | Date, offsetMinutes: number): string {
  const parts = fixedOffsetDateParts(value, offsetMinutes);
  return `${parts.year}-${padCalendarNumber(parts.month)}-${padCalendarNumber(parts.day)}`;
}

function rangeRunsOnDate(
  configuration: {
    run_monday: number;
    run_tuesday: number;
    run_wednesday: number;
    run_thursday: number;
    run_friday: number;
    run_saturday: number;
    run_sunday: number;
  },
  dateKey: string,
): boolean {
  const weekday = new Date(`${dateKey}T04:00:00.000Z`).getUTCDay();
  switch (weekday) {
    case 0:
      return Boolean(configuration.run_sunday);
    case 1:
      return Boolean(configuration.run_monday);
    case 2:
      return Boolean(configuration.run_tuesday);
    case 3:
      return Boolean(configuration.run_wednesday);
    case 4:
      return Boolean(configuration.run_thursday);
    case 5:
      return Boolean(configuration.run_friday);
    case 6:
      return Boolean(configuration.run_saturday);
    default:
      return true;
  }
}

function normalizeMonthKey(month: string | undefined, fallback: Date, offsetMinutes: number): string {
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month;
  const parts = fixedOffsetDateParts(fallback, offsetMinutes);
  return `${parts.year}-${padCalendarNumber(parts.month)}`;
}

function monthRange(month: string, offsetMinutes: number): { start: string; end: string } {
  const [yearPart, monthPart] = month.split('-');
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  const offsetMilliseconds = offsetMinutes * 60_000;
  return {
    start: new Date(Date.UTC(year, monthIndex, 1) - offsetMilliseconds).toISOString(),
    end: new Date(Date.UTC(year, monthIndex + 1, 1) - offsetMilliseconds).toISOString(),
  };
}

function dayRange(dateKey: string, offsetMinutes: number): { start: string; end: string } {
  const [yearPart, monthPart, dayPart] = dateKey.split('-');
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  const day = Number(dayPart);
  const offsetMilliseconds = offsetMinutes * 60_000;
  return {
    start: new Date(Date.UTC(year, monthIndex, day) - offsetMilliseconds).toISOString(),
    end: new Date(Date.UTC(year, monthIndex, day + 1) - offsetMilliseconds).toISOString(),
  };
}

function safeCentsSum(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError('journal aggregate exceeds safe integer precision');
  return total;
}

function normalizeRangeName(value: string): string {
  return stripControlCharacters(value).trim().replace(/\s+/g, ' ');
}

function normalizeRangeDisplayName(value: string): string {
  return normalizeRangeName(value);
}

function safeParseProxyAlertPayload(payloadJson: string) {
  try {
    const parsed = JSON.parse(payloadJson);
    const result = proxyPayloadSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function rewriteProxyAlertPayloadRangeName(payloadJson: string, rangeName: string): string {
  const payload = safeParseProxyAlertPayload(payloadJson);
  if (!payload || typeof payload.extras?.rangeName !== 'string') return payloadJson;
  if (payload.extras.rangeName === rangeName) return payloadJson;
  return JSON.stringify({
    ...payload,
    extras: {
      ...payload.extras,
      rangeName,
    },
  });
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, '');
}

function isSingleRMissingVariant(source: string, candidate: string): boolean {
  if (candidate.length !== source.length + 1) return false;
  let sourceIndex = 0;
  let candidateIndex = 0;
  let insertedR = false;
  while (sourceIndex < source.length && candidateIndex < candidate.length) {
    if (source[sourceIndex].toLowerCase() === candidate[candidateIndex].toLowerCase()) {
      sourceIndex += 1;
      candidateIndex += 1;
      continue;
    }
    if (insertedR || candidate[candidateIndex].toLowerCase() !== 'r') return false;
    insertedR = true;
    candidateIndex += 1;
  }
  if (candidateIndex < candidate.length) {
    if (insertedR || candidate[candidateIndex].toLowerCase() !== 'r') return false;
    insertedR = true;
    candidateIndex += 1;
  }
  return insertedR && sourceIndex === source.length && candidateIndex === candidate.length;
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function normalizeSubcategoryName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isDateKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeOutboundTicker(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : undefined;
}

function normalizeOutboundTickerMode(value: 'micros_only' | undefined): 'micros_only' | undefined {
  return value === 'micros_only' ? value : undefined;
}
type PerformanceEvent = Pick<TradeEvent, 'occurredAt' | 'realizedDollarsCents' | 'realizedTicksCents' | 'outcome' | 'rangeName' | 'instrument'>
  | Pick<RangeTradeEvent, 'occurredAt' | 'realizedDollarsCents' | 'realizedTicksCents' | 'outcome' | 'rangeName' | 'instrument'>;

function summarizeTrades<T extends PerformanceEvent>(
  events: T[],
  riskByRangeName?: ReadonlyMap<string, number>,
): JournalMetrics {
  const wins = events.filter((event) => event.outcome === 'win');
  const losses = events.filter((event) => event.outcome === 'loss');
  const breakevens = events.filter((event) => event.outcome === 'breakeven');
  const realizedDollarsCents = safeCentsSum(...events.map((event) => event.realizedDollarsCents ?? 0));
  const netTicksCents = safeCentsSum(...events.map((event) => event.realizedTicksCents ?? 0));
  const closedCount = events.length;
  const decisiveTrades = wins.length + losses.length;
  // R earned = Σ(realized ÷ range risk) over trades whose range declares a
  // risk figure. Ranges without one contribute nothing to the multiple.
  let rEarned: number | null = null;
  if (riskByRangeName) {
    let sum = 0;
    let covered = 0;
    for (const event of events) {
      const risk = event.rangeName ? riskByRangeName.get(event.rangeName) : undefined;
      if (!risk || risk <= 0) continue;
      sum += (event.realizedDollarsCents ?? 0) / risk;
      covered++;
    }
    rEarned = covered ? sum : null;
  }
  return {
    realizedDollarsCents,
    netTicksCents,
    closedCount,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRate: decisiveTrades ? wins.length / decisiveTrades : null,
    averageWinDollarsCents: wins.length
      ? Math.round(safeCentsSum(...wins.map((event) => event.realizedDollarsCents ?? 0)) / wins.length)
      : null,
    averageLossDollarsCents: losses.length
      ? Math.round(safeCentsSum(...losses.map((event) => event.realizedDollarsCents ?? 0)) / losses.length)
      : null,
    averageWinTicksCents: wins.length
      ? Math.round(safeCentsSum(...wins.map((event) => event.realizedTicksCents ?? 0)) / wins.length)
      : null,
    averageLossTicksCents: losses.length
      ? Math.round(safeCentsSum(...losses.map((event) => event.realizedTicksCents ?? 0)) / losses.length)
      : null,
    rEarned,
  };
}

// Extended per-account stats — drawdown and streaks need chronological order,
// so the input is sorted by occurredAt ascending before walking the curve.
function extendedTradeStats<T extends PerformanceEvent>(events: T[]): {
  profitFactor: number | null;
  expectancyDollarsCents: number | null;
  maxDrawdownDollarsCents: number;
  largestWinDollarsCents: number | null;
  largestLossDollarsCents: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
} {
  const sorted = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let largestWin: number | null = null;
  let largestLoss: number | null = null;
  let winRun = 0;
  let lossRun = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  for (const event of sorted) {
    const pnl = event.realizedDollarsCents ?? 0;
    equity += pnl;
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (event.outcome === 'win') {
      grossWin += pnl;
      largestWin = Math.max(largestWin ?? 0, pnl);
      winRun++;
      lossRun = 0;
      longestWinStreak = Math.max(longestWinStreak, winRun);
    } else if (event.outcome === 'loss') {
      grossLoss += Math.abs(pnl);
      largestLoss = Math.min(largestLoss ?? 0, pnl);
      lossRun++;
      winRun = 0;
      longestLossStreak = Math.max(longestLossStreak, lossRun);
    } else {
      winRun = 0;
      lossRun = 0;
    }
  }
  const closedCount = sorted.length;
  return {
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : null,
    expectancyDollarsCents: closedCount
      ? Math.round(safeCentsSum(...sorted.map((event) => event.realizedDollarsCents ?? 0)) / closedCount)
      : null,
    maxDrawdownDollarsCents: maxDrawdown,
    largestWinDollarsCents: largestWin,
    largestLossDollarsCents: largestLoss,
    longestWinStreak,
    longestLossStreak,
  };
}

function buildTradeCalendarMonth<T extends PerformanceEvent>(
  events: T[],
  now: Date,
  month: string | undefined,
  options: { hiddenDateKeys?: ReadonlySet<string>; startAt?: string; endAt?: string; riskByRangeName?: ReadonlyMap<string, number> } = {},
): {
  month: string;
  days: Array<{
    date: string;
    realizedDollarsCents: number;
    netTicksCents: number;
    closedCount: number;
    wins: number;
    losses: number;
    breakevens: number;
    winRate: number | null;
    hiddenFromPerformance?: boolean;
    ranges: Array<{
      rangeName: string;
      instrument: string;
      realizedDollarsCents: number;
      netTicksCents: number;
      closedCount: number;
      wins: number;
      losses: number;
      breakevens: number;
    }>;
    trades: T[];
  }>;
  /** Prior-month days that pad the leading grid cells — display context only,
      never counted in `summary`. */
  trailingDays: Array<{
    date: string;
    realizedDollarsCents: number;
    netTicksCents: number;
    closedCount: number;
    wins: number;
    losses: number;
    breakevens: number;
    winRate: number | null;
  }>;
  summary: JournalMetrics;
} {
  const monthKey = normalizeMonthKey(month, now, JOURNAL_TIME_OFFSET_MINUTES);
  const monthWindow = monthRange(monthKey, JOURNAL_TIME_OFFSET_MINUTES);
  const start = options.startAt ?? monthWindow.start;
  const end = options.endAt ?? monthWindow.end;
  const hiddenDateKeys = options.hiddenDateKeys ?? new Set<string>();
  const monthlyEvents = events.filter((event) => event.occurredAt >= start && event.occurredAt < end);
  // The month's leading pad cells show the previous month's trailing days —
  // pull those events into the date map so callers can render real results.
  // Skipped when a custom window (week view) is in play.
  const leadingPadDays = options.startAt
    ? 0
    : new Date(Date.UTC(Number(monthKey.slice(0, 4)), Number(monthKey.slice(5, 7)) - 1, 1)).getUTCDay();
  const padStartMs = new Date(start).getTime() - leadingPadDays * 86_400_000;
  const visibleMonthlyEvents = monthlyEvents.filter((event) => !hiddenDateKeys.has(
    fixedOffsetDateKey(event.occurredAt, JOURNAL_TIME_OFFSET_MINUTES),
  ));
  const eventsByDate = new Map<string, T[]>();
  for (const event of events) {
    if (event.occurredAt < new Date(padStartMs).toISOString() || event.occurredAt >= end) continue;
    const date = fixedOffsetDateKey(event.occurredAt, JOURNAL_TIME_OFFSET_MINUTES);
    const dayEvents = eventsByDate.get(date) ?? [];
    dayEvents.push(event);
    eventsByDate.set(date, dayEvents);
  }
  const monthPrefix = `${monthKey}-`;
  const allDays = [...eventsByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, dayEvents]) => {
      const hiddenFromPerformance = hiddenDateKeys.has(date);
      const summary = summarizeTrades(dayEvents, options.riskByRangeName);
      const ranges = [...dayEvents.reduce((entries, event) => {
        const key = `${event.rangeName}\u0000${event.instrument}`;
        const existing = entries.get(key) ?? {
          rangeName: event.rangeName,
          instrument: event.instrument,
          realizedDollarsCents: 0,
          netTicksCents: 0,
          closedCount: 0,
          wins: 0,
          losses: 0,
          breakevens: 0,
        };
        existing.realizedDollarsCents = safeCentsSum(existing.realizedDollarsCents, event.realizedDollarsCents ?? 0);
        existing.netTicksCents = safeCentsSum(existing.netTicksCents, event.realizedTicksCents ?? 0);
        existing.closedCount += 1;
        if (event.outcome === 'win') existing.wins += 1;
        else if (event.outcome === 'loss') existing.losses += 1;
        else if (event.outcome === 'breakeven') existing.breakevens += 1;
        entries.set(key, existing);
        return entries;
      }, new Map<string, {
        rangeName: string;
        instrument: string;
        realizedDollarsCents: number;
        netTicksCents: number;
        closedCount: number;
        wins: number;
        losses: number;
        breakevens: number;
      }>()).values()]
        .sort((left, right) => left.rangeName.localeCompare(right.rangeName) || left.instrument.localeCompare(right.instrument));
      return {
        date,
        realizedDollarsCents: summary.realizedDollarsCents,
        netTicksCents: summary.netTicksCents,
        closedCount: summary.closedCount,
        wins: summary.wins,
        losses: summary.losses,
        breakevens: summary.breakevens,
        winRate: summary.winRate,
        rEarned: summary.rEarned,
        ...(hiddenFromPerformance ? { hiddenFromPerformance: true } : {}),
        ranges,
        trades: dayEvents,
      };
    });
  const days = allDays.filter((day) => day.date.startsWith(monthPrefix));
  const trailingDays = allDays
    .filter((day) => !day.date.startsWith(monthPrefix))
    .map(({ date, realizedDollarsCents, netTicksCents, closedCount, wins, losses, breakevens, winRate }) => ({
      date, realizedDollarsCents, netTicksCents, closedCount, wins, losses, breakevens, winRate,
    }));
  return {
    month: monthKey,
    days,
    trailingDays,
    summary: summarizeTrades(visibleMonthlyEvents, options.riskByRangeName),
  };
}

function baseBracketIdFromLifecycleTradeId(tradeId: string): string {
  const normalized = tradeId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
  const lifecycleMatch = normalized.match(/-lifecycle-(long|short)(?:-[^-]+)?(?:$|-)/);
  if (!lifecycleMatch) {
    // No lifecycle suffix; treat the whole normalized id as the bracket base.
    return normalized;
  }

  const side = lifecycleMatch[1];
  const lifecycleIndex = lifecycleMatch.index ?? normalized.length;
  const before = normalized.slice(0, lifecycleIndex);

  // If the bracket id already carries the side (e.g. "...-long-arm-18"), keep it.
  const sideArmMatch = before.match(/-(long|short)-arm-(\d+)$/);
  if (sideArmMatch) {
    return before;
  }

  // Legacy no-side v5.0 id: "...-arm-N" => "...-<side>-arm-N".
  const armMatch = before.match(/-arm-(\d+)$/);
  if (armMatch) {
    const prefix = before.slice(0, armMatch.index);
    return `${prefix}-${side}-arm-${armMatch[1]}`;
  }

  // Fallback to the text before the lifecycle suffix (v4.x style).
  return before;
}

function bracketMonitorStateFromEventType(eventType: TradeEventType): BracketMonitorState {
  switch (eventType) {
    case 'entry_armed':
      return 'armed';
    case 'entry_filled':
      return 'filled';
    case 'entry_cancelled':
      return 'cancelled';
    case 'exit_filled':
    case 'trade_closed':
      return 'closed';
    default:
      return 'armed';
  }
}
