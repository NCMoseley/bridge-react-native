import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createPasswordHash, createSessionToken, hashSessionToken, verifyPassword } from './auth.js';
import { config } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import { Database } from './database.js';
import { TradersPostRateLimiter } from './traderspost-rate-limiter.js';
import { filterForexFactoryEvents, forexFactoryWeekRangeForDate, ForexFactoryError, normalizeForexFactoryDay, normalizeForexFactoryRange, normalizeForexFactorySnapshotTimezone, parseForexFactoryRangeHtml, parseScopeBounds, type ForexFactoryRangeResult } from './forex-factory.js';
import { TradovateClient, type TradovateCredentials } from './tradovate.js';
import type {
  AccountJournal,
  AccountAlert,
  AccountAlertSummary,
  BracketMonitorEntry,
  BridgeAccount,
  BrokerOrder,
  BrokerOrderAction,
  ExtensionSession,
  JournalMetrics,
  PerformanceExclusionReason,
  ProxyAlert,
  ProxyDelivery,
  ProxyDeliveryStatus,
  RangeConfiguration,
  RangeRoute,
  RangeTradeEvent,
  TradeEvent,
  TradeEventType,
  TradersPostAccountDestination,
} from './types.js';
import {
  decimalToIntegerCents,
  type EntryPayload,
  type ExitPayload,
  isDraftEligiblePayload,
  isLifecyclePayload,
  scopePayloadIdsToRange,
  type LifecyclePayload,
  lifecycleSide,
  proxyPayloadSchema,
  type TradersPostPayload,
  toCancellationReminderDraft,
  toDraft,
  tradersPostPayloadSchema,
} from './webhook.js';
import { parseBracketArmId } from './bracket-manager.js';
import { ReapplyCoordinator } from './reapply.js';
import { crossTradeExitPricesFromTicks, ctUserDataOrderId, ctWireOrderId, fetchCrossTradeAtmTemplates, fetchCrossTradeOrder, fetchCrossTradeOrders, fetchCrossTradePositions, interpretCrossTradeResponse, isCrossTradeConfigured, mapNt8OrderState, matchesCtOrderId, redactCrossTradeMessage, toCrossTradeMessage, type CrossTradeApiResult, type CrossTradeDestination, type CrossTradeMessage, type CrossTradeOrderRow, type CrossTradePositionRow, inferredTickSize, roundToTick } from './crosstrade.js';
import { atmTemplateFileName, renderNt8AtmTemplateXml } from './atm-template.js';
import {
  isTradersPostSender,
  normalizeInboundEmail,
  parseTradersPostEmail,
  type InboundEmail,
  type ParsedTradersPostEmail,
} from './email-ingest.js';

type RequestWithRawBody = Request & { rawBody?: string };
type AppView = 'journal' | 'accounts' | 'alerts' | 'ranges' | 'settings' | 'debugging';
type AppTheme = 'dark' | 'light';
type RangeComparisonTimeframe = 'all' | 'day' | 'week' | 'month';
type DebuggingFilter = 'all' | PerformanceExclusionReason;
type AlertActivityFilter = 'all' | 'routed' | 'unrouted' | 'lifecycle' | 'traderspost_delivered' | 'traderspost_failed';
type AlertTimeFilter = 'all' | '15m' | '30m' | 'hour' | '2h' | '4h' | '12h' | 'day' | '3d' | 'week';
type JournalTradeOutcomeFilter = 'all' | 'win' | 'loss' | 'breakeven';
type JournalTradeTimeFilter = 'all' | 'day' | 'week' | 'month';

const JOURNAL_TIME_ZONE = 'Etc/GMT+4';
const JOURNAL_TIME_ZONE_LABEL = 'UTC-4';
const JOURNAL_TIME_OFFSET_MINUTES = -4 * 60;
const REQUEST_BODY_LIMIT = '512kb';
const packageMetadata = z.object({ version: z.string().trim().min(1) }).parse(
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')),
);
// The extension is versioned by its own manifest (what Chrome reports), not the
// app package version — the build stamps a copy into dist/extension.
const extensionVersion = (() => {
  const manifestVersion = z.object({ version: z.string().trim().min(1) });
  for (const candidate of ['extension/manifest.json', 'dist/extension/manifest.json']) {
    try {
      const parsed = manifestVersion.safeParse(JSON.parse(readFileSync(join(process.cwd(), candidate), 'utf8')));
      if (parsed.success) return parsed.data.version;
    } catch { /* try the next candidate */ }
  }
  return packageMetadata.version;
})();
const EXTENSION_ZIP_FILE_NAME = `tradovate-browser-bridge-extension-${extensionVersion}.zip`;
const EXTENSION_ZIP_PATH = join(process.cwd(), 'dist', EXTENSION_ZIP_FILE_NAME);
const themeCookieName = 'bridge_theme';
const themeCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
const alertSoundCookieName = 'bridge_alert_sound';
const alertSoundCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
const isProduction = process.env.NODE_ENV === 'production';

function firstStringValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.find((entry): entry is string => typeof entry === 'string');
  return value;
}

function lastStringValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const entry = value[index];
      if (typeof entry === 'string') return entry;
    }
    return undefined;
  }
  return value;
}

const createUserSchema = z.object({
  email: z.email(),
});

const userIdSchema = z.string().uuid();

const createAccountSchema = z.object({
  userId: userIdSchema,
  name: z.string().trim().min(1).max(128),
  startingBalanceCents: z.number().int().min(0),
  externalBalanceCents: z.number().int().nullable().optional(),
  externalBalanceAt: z.string().datetime().nullable().optional(),
});

const upsertRangeRouteSchema = z.object({
  userId: userIdSchema,
  rangeName: z.string().min(1).max(256),
  accountId: z.string().uuid(),
  extensionEnabled: z.boolean().default(false),
  traderspostEnabled: z.boolean().default(false),
  runScheduled: z.boolean().default(false),
});

const webAccountSchema = z.object({
  name: z.string().trim().min(1).max(128),
  startingBalance: z.string(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webAccountStartingBalanceSchema = z.object({
  accountId: z.string().uuid(),
  startingBalance: z.string(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webAccountDeleteSchema = z.object({
  accountId: z.string().uuid(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webAccountDeprecateSchema = z.object({
  accountId: z.string().uuid(),
  deprecated: z.enum(['true', 'false']),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webForexFactoryImportSchema = z.object({
  range: z.preprocess(firstStringValue, z.string().trim().min(1)),
  html: z.preprocess(firstStringValue, z.string().trim().min(1)),
  csrfToken: z.preprocess(firstStringValue, z.string().min(1)),
});

const webRangeRouteSchema = z.object({
  rangeName: z.preprocess(firstStringValue, z.string().trim().min(1).max(256)),
  targetUserId: z.preprocess(firstStringValue, z.string().uuid().optional()),
  csrfToken: z.preprocess(firstStringValue, z.string().min(1)),
});

const webRemoveAccountSubscriptionsSchema = z.object({
  accountId: z.preprocess(firstStringValue, z.string().trim().uuid()),
  targetUserId: z.preprocess(firstStringValue, z.string().uuid().optional()),
  csrfToken: z.preprocess(firstStringValue, z.string().min(1)),
});

const webCopyAccountSubscriptionsSchema = z.object({
  fromAccountId: z.preprocess(firstStringValue, z.string().trim().uuid()),
  toAccountId: z.preprocess(firstStringValue, z.string().trim().uuid()),
  targetUserId: z.preprocess(firstStringValue, z.string().uuid().optional()),
  csrfToken: z.preprocess(firstStringValue, z.string().min(1)),
});

const webRangeRoutesBatchSchema = z.object({
  targetUserId: z.preprocess(firstStringValue, z.string().uuid().optional()),
  csrfToken: z.preprocess(firstStringValue, z.string().min(1)),
  rangeRoutesJson: z.preprocess(firstStringValue, z.string().min(1)),
});

const webModelSubscriptionSchema = z.object({
  subcategoryName: z.string().trim().min(1).max(256),
  accountId: z.string().uuid(),
  extensionEnabled: z.coerce.boolean().default(true),
  traderspostEnabled: z.coerce.boolean().default(true),
  runScheduled: z.coerce.boolean().default(true),
  csrfToken: z.string().min(1),
});

const extensionForexFactoryImportSchema = z.object({
  range: z.string().trim().min(1),
  html: z.string().trim().min(1),
});

const webRangeEnrollSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  accountId: z.string().uuid(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const dayFlagSchema = z.preprocess(
  (val) => {
    if (val === undefined || val === null) return undefined;
    if (val === 'true' || val === true) return true;
    if (val === 'false' || val === false) return false;
    return val;
  },
  z.boolean().optional(),
);
const decimalFieldSchema = z.union([z.string(), z.number()]);

const webRangeConfigurationSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  instrument: z.string().trim().min(1).max(64),
  description: z.string().trim().max(4_000),
  riskDollars: decimalFieldSchema,
  rangeWindow: z.string().trim().regex(/^\d{4}-\d{4}$/),
  tradingSession: z.string().trim().regex(/^$|^\d{4}-\d{4}$/),
  takeProfitStyle: z.string().trim().min(1).max(64),
  takeProfitTicks: decimalFieldSchema,
  stopLossStyle: z.string().trim().min(1).max(64),
  stopLossTicks: decimalFieldSchema,
  breakEvenEnabled: dayFlagSchema,
  breakEvenTriggerTicks: decimalFieldSchema,
  breakEvenOffsetTicks: decimalFieldSchema,
  ocoMode: z.enum(['oco', 'both']),
  stopOnlyEntries: dayFlagSchema,
  runMonday: dayFlagSchema,
  runTuesday: dayFlagSchema,
  runWednesday: dayFlagSchema,
  runThursday: dayFlagSchema,
  runFriday: dayFlagSchema,
  runSaturday: dayFlagSchema,
  runSunday: dayFlagSchema,
  entriesPerRange: z.coerce.number().int().positive(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const rangeConfigurationPatchJsonSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
  instrument: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(4_000).optional(),
  riskDollarsCents: z.coerce.number().int().min(0).optional(),
  rangeWindow: z.string().trim().regex(/^\d{4}-\d{4}$/).optional(),
  tradingSession: z.string().trim().regex(/^$|^\d{4}-\d{4}$/).optional(),
  takeProfitStyle: z.string().trim().min(1).max(64).optional(),
  takeProfitTicksCents: z.coerce.number().int().min(0).optional(),
  stopLossStyle: z.string().trim().min(1).max(64).optional(),
  stopLossTicksCents: z.coerce.number().int().min(0).optional(),
  breakEvenEnabled: z.boolean().optional(),
  breakEvenTriggerTicksCents: z.coerce.number().int().min(0).optional(),
  breakEvenOffsetTicksCents: z.coerce.number().int().min(0).optional(),
  ocoMode: z.enum(['oco', 'both']).optional(),
  stopOnlyEntries: z.boolean().optional(),
  runMonday: z.boolean().optional(),
  runTuesday: z.boolean().optional(),
  runWednesday: z.boolean().optional(),
  runThursday: z.boolean().optional(),
  runFriday: z.boolean().optional(),
  runSaturday: z.boolean().optional(),
  runSunday: z.boolean().optional(),
  entriesPerRange: z.coerce.number().int().positive().optional(),
});

const rangeConfigurationBulkDaysSchema = z.object({
  subcategoryName: z.string().max(256),
  enabled: z.coerce.boolean(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webTradeExclusionSchema = z.object({
  eventId: z.string().uuid(),
  testData: z.enum(['true']).optional(),
  erroneous: z.enum(['true']).optional(),
  targetUserId: z.string().uuid().optional(),
  returnAccountId: z.string().uuid().optional(),
  returnMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  csrfToken: z.string().min(1),
});

const journalDayRangeAccountExclusionSchema = z.object({
  date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/),
  accountId: z.string().uuid(),
  rangeName: z.string().min(1),
  reason: z.enum(['test_data', 'erroneous']).optional(),
  csrfToken: z.string().min(1),
});

const webTradeEventDeleteSchema = z.object({
  eventId: z.string().uuid(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const tradeAdjustmentSchema = z.object({
  changes: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  note: z.string().max(2000),
  csrfToken: z.string().min(1),
});

const manualTradeSchema = z.object({
  accountId: z.string().uuid(),
  instrument: z.string().trim().min(1).max(64).toUpperCase(),
  side: z.enum(['long', 'short']),
  quantity: z.coerce.number().positive(),
  entryPrice: z.coerce.number().nonnegative().optional(),
  exitPrice: z.coerce.number().nonnegative().optional(),
  realizedDollars: z.coerce.number(),
  realizedTicks: z.coerce.number(),
  outcome: z.enum(['win', 'loss', 'breakeven']),
  occurredAt: z.string().refine((v) => !Number.isNaN(new Date(v).getTime()), { message: 'invalid datetime' }),
  note: z.string().max(1000).optional(),
  csrfToken: z.string().min(1),
});

const webAlertDeleteSchema = z.object({
  alertId: z.string().uuid(),
  csrfToken: z.string().min(1),
});

const webRangeReviewFlagSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  testData: z.enum(['true']).optional(),
  erroneous: z.enum(['true']).optional(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webThemeSchema = z.object({
  theme: z.enum(['dark', 'light', 'ultra', 'barbie', 'neonsign', 'irish', 'medieval', 'optimist', 'cush', 'castrol']),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webAlertSoundSchema = z.object({
  enabled: z.enum(['true']).optional(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webDebugTradersPostTestSchema = z.object({
  accountId: z.string().uuid(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webDebugRangeSimulationSchema = z.object({
  accountId: z.string().uuid(),
  rangeName: z.string().trim().min(1).max(256),
  action: z.enum(['buy', 'sell']),
  top: z.coerce.number().positive(),
  bottom: z.coerce.number().positive(),
  quantity: z.coerce.number().int().positive(),
  orderType: z.enum(['market', 'limit', 'stop', 'stop_limit']).default('stop'),
  takeProfitTicksCents: z.coerce.number().int().min(0).optional(),
  stopLossTicksCents: z.coerce.number().int().min(0).optional(),
  takeProfitStyle: z.string().optional(),
  stopLossStyle: z.string().optional(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webTrackedRangeSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webRangeSubcategorySchema = z.object({
  name: z.string().trim().min(1).max(128),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webRangeSubcategoryColorSchema = z.object({
  name: z.string().trim().min(1).max(128),
  color: z.union([z.literal(''), z.string().trim().regex(/^#[0-9a-fA-F]{6}$/)]).nullable().optional(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webRangeSubcategoryRenameSchema = z.object({
  currentName: z.string().trim().min(1).max(128),
  newName: z.string().trim().min(1).max(128),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webRangeSubcategoryDeleteSchema = z.object({
  name: z.string().trim().min(1).max(128),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webRangeSubcategoryAssignmentSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  subcategoryName: z.string().trim().max(128).optional(),
  mode: z.enum(['replace', 'add', 'remove']).default('replace'),
  timeframe: z.enum(['all', 'day', 'week', 'month']).optional(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const subcategoryDayFlagsSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  subcategoryName: z.string().trim().min(1).max(128),
  runMonday: z.boolean().nullable().optional(),
  runTuesday: z.boolean().nullable().optional(),
  runWednesday: z.boolean().nullable().optional(),
  runThursday: z.boolean().nullable().optional(),
  runFriday: z.boolean().nullable().optional(),
  runSaturday: z.boolean().nullable().optional(),
  runSunday: z.boolean().nullable().optional(),
  csrfToken: z.string().min(1),
});

// undici wraps transport failures (socket closed, refused, DNS, TLS) in a
// TypeError carrying the real reason on .cause — 'fetch failed' alone is not
// diagnostic. AbortError is a DOMException, so the TypeError+cause check also
// excludes our own aborts and URL-parse errors (which carry no cause).
const describeErrorCause = (error: unknown): string | undefined => {
  if (!(error instanceof Error) || error.cause === undefined) return undefined;
  const cause = error.cause;
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
};

const isTransportFetchError = (error: unknown): boolean =>
  error instanceof TypeError && error.cause !== undefined;

// AbortError covers our 10s send timeout and the never-settled hard cap — the
// request may already be in flight, so it is only retried for idempotent
// flatten legs (cancel/exit): a duplicate cancel or exit is a no-op at the
// broker, while a duplicate entry could double a position.
const isAbortFetchError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const isFlattenAction = (action: unknown): boolean =>
  action === 'cancel' || action === 'exit';

const TRADERSPOST_TRANSPORT_RETRIES = 1;
const TRADERSPOST_TRANSPORT_RETRY_DELAY_MS = 750;
// Deferred retries re-enqueue the whole delivery at the BACK of the account
// lane (setTimeout → fresh queue task). Same retryable set as the inline
// retry — transport errors only, plus timeouts on flatten/cancel actions
// which are safe to duplicate. Entry timeouts stay single-shot: an
// acknowledged-but-uncertain entry must never risk a broker duplicate.
// Attempt count is ledger-derived so the cap survives a task-chain retry.
const TRADERSPOST_DEFERRED_RETRIES = 2;
const TRADERSPOST_DEFERRED_RETRY_BASE_MS = 5_000;

// The retry sleep must observe the same abort signals as the send — otherwise a
// watchdog release during the delay still lets the retry fire while the account
// queue has already moved on to the next task.
const abortableDelay = (ms: number, signals: AbortSignal[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      for (const s of signals) s.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      const aborted = signals.find((s) => s.aborted);
      reject(aborted?.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    if (signals.some((s) => s.aborted)) { onAbort(); return; }
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  });

const webRangeDeleteSchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webRangeMoveSchema = z.object({
  sourceRangeName: z.string().trim().min(1).max(256),
  targetRangeName: z.string().trim().min(1).max(256),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webRangeRenameSchema = z.object({
  currentRangeName: z.string().trim().min(1).max(256),
  newRangeName: z.string().trim().min(1).max(256),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webUntrackedRangeReassignmentSchema = z.object({
  sourceRangeName: z.string().trim().min(1).max(256),
  targetRangeName: z.string().trim().min(1).max(256),
  returnView: z.enum(['alerts', 'debugging']).optional(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const webReprocessLifecycleSchema = z.object({
  rangeName: z.string().trim().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(10000).default(1000).optional(),
  runScheduledOnly: z.coerce.boolean().default(false),
  csrfToken: z.string().min(1),
});

const webReconcileBookkeepingSchema = z.object({
  accountId: z.union([z.literal('*'), z.string().uuid()]),
  mode: z.enum(['orders', 'positions', 'both']).default('both'),
  includeCrypto: z.coerce.boolean().default(false),
  csrfToken: z.string().min(1),
});

const webReconcileYesterdaySchema = z.object({
  csrfToken: z.string().min(1),
});

const webReconcileBeSchema = z.object({
  eventId: z.string().min(1),
  csrfToken: z.string().min(1),
});

const webRangeCalendarDayVisibilitySchema = z.object({
  rangeName: z.string().trim().min(1).max(256),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hidden: z.enum(['true', 'false']),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const tradersPostWebhookUrlSchema = z.url().superRefine((value, ctx) => {
  // zod still evaluates refinements when the URL check already failed (e.g.
  // crossTradeWebhookUrl '' clearing) — an unparseable value must bail out
  // here rather than let new URL throw through the whole parse.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  let baseUrl: URL | undefined;
  try {
    baseUrl = new URL(config.PUBLIC_BASE_URL);
  } catch {
    baseUrl = undefined;
  }
  const localDevelopmentUrl = url.protocol === 'http:'
    && url.hostname === 'localhost'
    && !!baseUrl
    && ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname);
  if (url.protocol !== 'https:' && !localDevelopmentUrl) {
    ctx.addIssue({
      code: 'custom',
      message: 'TradersPost webhook URL must use HTTPS',
    });
  }
});

const upsertTradersPostAccountDestinationSchema = z.object({
  accountId: z.string().uuid(),
  webhookUrl: tradersPostWebhookUrlSchema,
  outboundTicker: z.string().trim().max(64).optional(),
  outboundTickerMode: z.enum(['none', 'exact', 'micros_only']).optional(),
  useLimitPriceTP: z.boolean().optional(),
  useAlertTP: z.boolean().optional(),
  reapplyOnTradeCloseEnabled: z.boolean().optional(),
  eodCancelTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  eodExitTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  eodEnabled: z.boolean().optional(),
  newsFlattenEnabled: z.boolean().optional(),
  newsFlattenMinutes: z.coerce.number().int().min(1).max(120).default(5),
  crossTradeWebhookUrl: tradersPostWebhookUrlSchema.optional().or(z.literal('')),
  crossTradeSecretKey: z.string().trim().max(256).optional(),
  crossTradeAccountName: z.string().trim().max(128).optional(),
  crossTradeEnabled: z.boolean().optional(),
  quantityOverrideMode: z.enum(['off', 'percent', 'fixed', 'risk']).optional(),
  quantityOverrideValue: z.coerce.number().positive().max(100000).optional(),
});

const webTradersPostAccountDestinationSchema = z.object({
  accountId: z.string().uuid(),
  webhookUrl: tradersPostWebhookUrlSchema,
  enabled: z.preprocess(lastStringValue, z.enum(['true', 'false']).default('true')),
  outboundTicker: z.string().trim().max(64).optional(),
  outboundTickerMode: z.enum(['none', 'exact', 'micros_only']).optional(),
  useLimitPriceTP: z.enum(['true']).optional(),
  useAlertTP: z.enum(['true']).optional(),
  reapplyOnTradeCloseEnabled: z.enum(['true']).optional(),
  eodCancelTime: z.string().optional(),
  eodExitTime: z.string().optional(),
  eodEnabled: z.enum(['true']).optional(),
  newsFlattenEnabled: z.enum(['true']).optional(),
  newsFlattenMinutes: z.coerce.number().int().min(1).max(120).default(5),
  crossTradeWebhookUrl: tradersPostWebhookUrlSchema.optional().or(z.literal('')),
  crossTradeSecretKey: z.string().trim().max(256).optional(),
  crossTradeAccountName: z.string().trim().max(128).optional(),
  crossTradeEnabled: z.enum(['true', 'false']).optional(),
  quantityOverrideMode: z.enum(['off', 'percent', 'fixed', 'risk']).optional(),
  quantityOverrideValue: z.coerce.number().positive().max(100000).optional(),
  targetUserId: z.string().uuid().optional(),
  csrfToken: z.string().min(1),
});

const tradovateConnectionSchema = z.object({
  environment: z.literal('demo'),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(512),
  cid: z.string().min(1).max(256),
  sec: z.string().min(1).max(512),
});

const tradovateAccountSchema = z.object({
  accountId: z.number().int().positive(),
});

// CrossTrade's secret key is write-only: API responses carry a boolean marker
// instead of the credential, so it can never reach the browser or the
// localStorage account cache. The stored value is preserved server-side when
// a save omits the field.
type PublicTradersPostAccountDestination = Omit<TradersPostAccountDestination, 'crossTradeSecretKey'> & {
  crossTradeSecretKey?: undefined;
  crossTradeSecretKeySet: boolean;
};
const publicTradersPostDestination = (destination: TradersPostAccountDestination): PublicTradersPostAccountDestination => ({
  ...destination,
  crossTradeSecretKey: undefined,
  crossTradeSecretKeySet: Boolean(destination.crossTradeSecretKey),
});

// CrossTrade credentials resolve as a pair: a webhook URL enables the CT path
// only alongside a secret key — supplied in this request or preserved from
// the stored row. URL absent → all CT fields clear (unless an explicit
// disabled flag parks them); URL present without any usable key → rejected
// rather than persisted as a partial configuration.
const resolveCrossTradeFields = (
  input: { crossTradeWebhookUrl?: string; crossTradeSecretKey?: string; crossTradeAccountName?: string; crossTradeEnabled?: boolean | 'true' | 'false' },
  existing?: TradersPostAccountDestination,
): { webhookUrl?: string; secretKey?: string; accountName?: string; enabled?: boolean } | 'missing-key' => {
  const webhookUrl = input.crossTradeWebhookUrl?.trim() || undefined;
  // Explicitly parked: keep the stored URL/key/name so switching back is a
  // toggle, not a re-entry. Dispatch ignores CT while enabled=0.
  if (input.crossTradeEnabled === false || input.crossTradeEnabled === 'false') {
    return {
      webhookUrl: input.crossTradeWebhookUrl?.trim() || existing?.crossTradeWebhookUrl,
      secretKey: input.crossTradeSecretKey?.trim() || existing?.crossTradeSecretKey,
      accountName: input.crossTradeAccountName?.trim() || existing?.crossTradeAccountName,
      enabled: false,
    };
  }
  if (!webhookUrl) return {};
  const secretKey = input.crossTradeSecretKey?.trim() || existing?.crossTradeSecretKey || undefined;
  if (!secretKey) return 'missing-key';
  return { webhookUrl, secretKey, accountName: input.crossTradeAccountName?.trim() || undefined, enabled: true };
};

function credentialResponse(user: import('./database.js').UserCredentials) {
  return {
    id: user.id,
    email: user.email,
    webhookUrl: `${config.PUBLIC_BASE_URL}/webhooks/${user.id}/${user.webhookSecret}`,
    extensionToken: user.extensionToken,
  };
}

function matchesSecret(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

const sessionCookieName = 'bridge_session';
const sessionDurationSeconds = 7 * 24 * 60 * 60;

interface WebSession {
  userId: string;
  email: string;
  csrfToken: string;
  tokenHash: string;
}

interface AppOptions {
  proxyWebhookSecret?: string;
  emailIngestSecret?: string;
  initialUserPassword?: string;
  sessionSecret?: string;
  adminUserEmail?: string;
  fetch?: typeof globalThis.fetch;
  traderspostHardTimeoutMs?: number;
  // Base delay for deferred back-of-lane retries (defaults to
  // TRADERSPOST_DEFERRED_RETRY_BASE_MS); tests shrink it.
  traderspostDeferredRetryBaseMs?: number;
  traderspostQueueTaskTimeoutMs?: number;
  // Watchdog bound for each send slot on the per-account TradersPost rate
  // limiter (the inner queue inside forwardToTradersPost / flatten sends).
  traderspostRateLimitTaskTimeoutMs?: number;
  // Watchdog bound for a whole cancel/exit-all-safeguard flatten task on the
  // per-account reapply queue. Defaults to ten minutes — injectable for tests.
  traderspostSafeguardTaskTimeoutMs?: number;
  // Reapply flatten-leg retry policy: how many send passes a cancel/exit step
  // gets per execute() run, and the pause between passes. Injectable for tests.
  reapplyFlattenMaxSends?: number;
  reapplyFlattenRetryDelayMs?: number;
}

interface TradersPostForwardContext {
  source?: string;
  userId?: string;
  rangeName?: string;
  openInstrumentSet?: Set<string>;
  preflight?: () => { allowed: true } | { allowed: false; reason: string; status?: ProxyDeliveryStatus };
  queueNext?: boolean;
  brokerOrderId?: string;
  occurredAt?: string;
  // Explicit operator resend of a plain entry: allowed to dispatch again even
  // though the delivery already succeeded (bypasses sendable-status and
  // prior-success dedup — still recorded as another attempt).
  allowResend?: boolean;
  // Set when this forward runs inside a queue task — if the task watchdog
  // releases the account, the aborted signal must stop this work from sending
  // or mutating the delivery alongside the next queued dispatch.
  taskSignal?: AbortSignal;
}

function readCookie(request: Request, name: string): string | undefined {
  return request.header('cookie')
    ?.split(';')
    .map((part) => part.trim().split('=', 2))
    .find(([key]) => key === name)?.[1];
}

function sessionCookie(token: string, secure: boolean): string {
  return `${sessionCookieName}=${token}; Max-Age=${sessionDurationSeconds}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

function expiredSessionCookie(secure: boolean): string {
  return `${sessionCookieName}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

function themeCookie(theme: AppTheme | 'ultra' | 'barbie' | 'neonsign' | 'irish' | 'medieval' | 'optimist' | 'cush' | 'castrol', secure: boolean): string {
  return `${themeCookieName}=${theme}; Max-Age=${themeCookieMaxAgeSeconds}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

function alertSoundCookie(enabled: boolean, secure: boolean): string {
  return `${alertSoundCookieName}=${enabled ? 'on' : 'off'}; Max-Age=${alertSoundCookieMaxAgeSeconds}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

function readTheme(request: Request): AppTheme {
  const t = readCookie(request, themeCookieName);
  return t === 'light' || t === 'castrol' || t === 'glass' ? 'light' : 'dark';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return typeof value === 'string' && value.trim().length > 0 ? [value] : [];
}

function formatDollars(cents: number): string {
  const absolute = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${(absolute / 100).toFixed(2)}`;
}

function formatPnl(cents: number): string {
  return cents > 0 ? `+${formatDollars(cents)}` : formatDollars(cents);
}

function formatTicks(cents: number): string {
  const value = cents / 100;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formatPercent(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function toneClassForValue(value: number): string {
  return value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral';
}

function formatRatio(value: number | null): string {
  if (value == null) return '—';
  if (!Number.isFinite(value)) return '∞';
  return value.toFixed(2);
}

function renderWinLossValue(wins: number, losses: number): string {
  return `<span class="positive">${wins}</span>/<span class="negative">${losses}</span>`;
}

function renderWinLossBreakevenValue(wins: number, losses: number, breakevens: number): string {
  return `${renderWinLossValue(wins, losses)}/<span>${breakevens}</span>`;
}

function grossPerformance(metrics: JournalMetrics): { grossWinsCents: number; grossLossAbsCents: number } {
  return {
    grossWinsCents: metrics.averageWinDollarsCents == null ? 0 : metrics.averageWinDollarsCents * metrics.wins,
    grossLossAbsCents: metrics.averageLossDollarsCents == null ? 0 : Math.abs(metrics.averageLossDollarsCents) * metrics.losses,
  };
}

function profitFactor(metrics: JournalMetrics): number | null {
  const { grossWinsCents, grossLossAbsCents } = grossPerformance(metrics);
  if (grossWinsCents === 0 && grossLossAbsCents === 0) return null;
  if (grossLossAbsCents === 0) return grossWinsCents > 0 ? Number.POSITIVE_INFINITY : null;
  return grossWinsCents / grossLossAbsCents;
}

function journalActiveDays(calendar: CalendarMonthView): number {
  return calendar.days.filter((day) => day.closedCount > 0).length;
}

function formatJournalDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: JOURNAL_TIME_ZONE,
  }).format(new Date(value));
}

function formatJournalTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: JOURNAL_TIME_ZONE,
  }).format(new Date(value));
}

const FOREX_FACTORY_MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const FOREX_FACTORY_MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const FOREX_FACTORY_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
function parseForexFactoryRangeBoundary(value: string): Date | undefined {
  const match = value.trim().toLowerCase().match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})\.(\d{4})$/);
  if (!match) return undefined;
  const monthIndex = FOREX_FACTORY_MONTH_INDEX[match[1]];
  const day = Number(match[2]);
  const year = Number(match[3]);
  return new Date(Date.UTC(year, monthIndex, day));
}

function parseForexFactoryRangeBounds(range: string): { start: number; end: number; years: number[] } | undefined {
  const [startText, endText] = range.split('-');
  const start = startText ? parseForexFactoryRangeBoundary(startText) : undefined;
  const end = endText ? parseForexFactoryRangeBoundary(endText) : undefined;
  if (!start || !end) return undefined;
  const years: number[] = [];
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += 1) years.push(year);
  return {
    start: start.getTime(),
    // Day-inclusive end — matches parseScopeBounds so the last calendar day of
    // a snapshot range stays covered instead of expiring at midnight UTC.
    end: end.getTime() + 24 * 60 * 60 * 1_000 - 1,
    years,
  };
}

function parseForexFactoryDayIdentifier(day: string, now = new Date()): Date | undefined {
  if (day === 'today') {
    const shifted = new Date(now.getTime() + JOURNAL_TIME_OFFSET_MINUTES * 60 * 1_000);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  }
  const match = day.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(\d{1,2})\.(\d{4})$/i);
  if (!match) return undefined;
  const monthIndex = FOREX_FACTORY_MONTH_INDEX[match[1].toLowerCase()];
  return new Date(Date.UTC(Number(match[3]), monthIndex, Number(match[2])));
}

function formatForexFactoryEventDateLabel(date: Date): string {
  return `${FOREX_FACTORY_WEEKDAY_LABELS[date.getUTCDay()]} ${FOREX_FACTORY_MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
function parseForexFactoryEventAt(eventDate: string, eventTime: string, range: string): number | undefined {
  const dateMatch = eventDate.trim().match(/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Za-z]{3})\s+(\d{1,2})$/);
  const timeMatch = eventTime.trim().match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!dateMatch || !timeMatch) return undefined;
  const bounds = parseForexFactoryRangeBounds(range);
  if (!bounds) return undefined;
  const monthIndex = FOREX_FACTORY_MONTH_INDEX[dateMatch[1].toLowerCase()];
  const day = Number(dateMatch[2]);
  const hour12 = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const period = timeMatch[3].toLowerCase();
  const hour24 = period === 'pm'
    ? (hour12 === 12 ? 12 : hour12 + 12)
    : (hour12 === 12 ? 0 : hour12);
  for (const year of bounds.years) {
    const eventDay = Date.UTC(year, monthIndex, day);
    if (eventDay < bounds.start || eventDay > bounds.end) continue;
    return Date.UTC(year, monthIndex, day, hour24, minute) - JOURNAL_TIME_OFFSET_MINUTES * 60 * 1_000;
  }
  return undefined;
}

function nextForexFactoryEvent(
  snapshot: ForexFactoryRangeResult | undefined,
  now = new Date(),
): (ForexFactoryRangeResult['events'][number] & { eventAt: number }) | undefined {
  if (!snapshot) return undefined;
  return filterForexFactoryEvents(snapshot.events, 'high')
    .map((event) => ({
      ...event,
      eventAt: parseForexFactoryEventAt(event.date, event.time, snapshot.range),
    }))
    .filter((event): event is typeof event & { eventAt: number } => typeof event.eventAt === 'number' && event.eventAt >= now.getTime())
    .sort((left, right) => left.eventAt - right.eventAt)[0];
}

const NEWS_REAPPLY_COOLDOWN_MS = 2 * 60 * 60 * 1_000;

function isAccountInNewsWindow(db: Database, accountId: string, now = new Date()): boolean {
  const destination = db.getTradersPostAccountDestination(accountId);
  if (!destination?.newsFlattenEnabled || !destination.newsFlattenMinutes) return false;
  const snapshot = db.findForexFactoryRangeSnapshotCovering(now);
  if (!snapshot) return false;
  const events = filterForexFactoryEvents(snapshot.events, 'high')
    .map((event) => ({
      ...event,
      eventAt: parseForexFactoryEventAt(event.date, event.time, snapshot.range),
    }))
    .filter((event): event is typeof event & { eventAt: number } => typeof event.eventAt === 'number');
  const preMs = destination.newsFlattenMinutes * 60 * 1_000;
  const nowMs = now.getTime();
  for (const event of events) {
    if (nowMs >= event.eventAt - preMs && nowMs <= event.eventAt + NEWS_REAPPLY_COOLDOWN_MS) {
      return true;
    }
  }
  return false;
}

function formatForexFactoryCountdown(millisecondsUntil: number): string {
  const totalMinutes = Math.max(0, Math.floor(millisecondsUntil / (60 * 1_000)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function formatForexFactoryLeadTime(eventAt: number, now: Date): string {
  const shiftToJournalDay = (value: number): number => {
    const shifted = new Date(value + JOURNAL_TIME_OFFSET_MINUTES * 60 * 1_000);
    return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  };
  const dayDifference = Math.round((shiftToJournalDay(eventAt) - shiftToJournalDay(now.getTime())) / (24 * 60 * 60 * 1_000));
  if (dayDifference === 1) return 'Tomorrow';
  return formatForexFactoryCountdown(eventAt - now.getTime());
}
function importForexFactorySnapshot(
  database: Database,
  caches: {
    forexFactoryCache: Map<string, { expiresAt: number; payload: { source: 'ForexFactory'; day: string; timezone: string; fetchedAt: string; events: ForexFactoryRangeResult['events'] } }>;
    forexFactoryRangeCache: Map<string, { expiresAt: number; payload: ForexFactoryRangeResult }>;
  },
  range: string,
  html: string,
): ForexFactoryRangeResult {
  const normalizedRange = normalizeForexFactoryRange(range);
  const snapshot = normalizeForexFactorySnapshotTimezone(
    parseForexFactoryRangeHtml(html, normalizedRange),
    JOURNAL_TIME_ZONE,
  );
  database.upsertForexFactorySnapshot(snapshot);
  caches.forexFactoryCache.clear();
  caches.forexFactoryRangeCache.clear();
  return snapshot;
}
function formatDashboardDateTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: JOURNAL_TIME_ZONE,
  }).format(new Date(value));
}

function getDeepLifePath(customDate: string) {
  const [yearStr, monthStr, dayStr] = customDate.split('-');
  const yearNum = Number(yearStr);
  const monthNum = Number(monthStr);
  const dayNum = Number(dayStr);
  const sumDigits = (value: string | number) => value.toString().split('').reduce((sum, digit) => sum + Number.parseInt(digit, 10), 0);
  const targets = [11, 22, 33, 28];
  const hiddenFound = new Set<number>();
  const checkTarget = (value: number) => {
    if (targets.includes(value)) hiddenFound.add(value);
  };

  checkTarget(monthNum);
  checkTarget(dayNum);
  checkTarget(yearNum);
  checkTarget(monthNum + dayNum);
  checkTarget(monthNum + yearNum);
  checkTarget(dayNum + yearNum);
  checkTarget(monthNum + dayNum + yearNum);
  checkTarget(sumDigits(`${yearStr}${monthStr}${dayStr}`));

  const reduceComponent = (value: string) => {
    let sum = sumDigits(value);
    while (sum > 9 && sum !== 11 && sum !== 22 && sum !== 33) {
      sum = sumDigits(sum);
    }
    return sum;
  };

  const reducedMonth = reduceComponent(monthStr);
  const reducedDay = reduceComponent(dayStr);
  const reducedYear = reduceComponent(yearStr);
  checkTarget(reducedMonth);
  checkTarget(reducedDay);
  checkTarget(reducedYear);

  let finalLifePath = reducedMonth + reducedDay + reducedYear;
  checkTarget(finalLifePath);
  while (finalLifePath > 9 && finalLifePath !== 11 && finalLifePath !== 22 && finalLifePath !== 33) {
    finalLifePath = sumDigits(finalLifePath);
  }
  checkTarget(finalLifePath);

  return {
    lifePathNumber: finalLifePath,
    hiddenNumbersFound: [...hiddenFound].sort((left, right) => left - right),
  };
}

function parseAlertActivityFilter(value: unknown): AlertActivityFilter {
  return value === 'routed'
    || value === 'unrouted'
    || value === 'lifecycle'
    || value === 'traderspost_delivered'
    || value === 'traderspost_failed'
    ? value
    : 'all';
}

function parseAlertTimeFilter(value: unknown): AlertTimeFilter {
  return value === '15m'
    || value === '30m'
    || value === 'hour'
    || value === '2h'
    || value === '4h'
    || value === '12h'
    || value === 'day'
    || value === '3d'
    || value === 'week'
    ? value
    : 'all';
}

function parsePageParam(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 1;
  return Math.max(1, Number.parseInt(value, 10));
}

function normalizeAlertNameFilter(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length ? normalized.slice(0, 256) : undefined;
}

function alertTimeFilterStart(now: Date, filter: AlertTimeFilter): string | undefined {
  const start = new Date(now);
  switch (filter) {
    case '15m':
      start.setMinutes(start.getMinutes() - 15);
      return start.toISOString();
    case '30m':
      start.setMinutes(start.getMinutes() - 30);
      return start.toISOString();
    case 'hour':
      start.setHours(start.getHours() - 1);
      return start.toISOString();
    case '2h':
      start.setHours(start.getHours() - 2);
      return start.toISOString();
    case '4h':
      start.setHours(start.getHours() - 4);
      return start.toISOString();
    case '12h':
      start.setHours(start.getHours() - 12);
      return start.toISOString();
    case 'day':
      start.setHours(start.getHours() - 24);
      return start.toISOString();
    case '3d':
      start.setDate(start.getDate() - 3);
      return start.toISOString();
    case 'week':
      start.setDate(start.getDate() - 7);
      return start.toISOString();
    case 'all':
      return undefined;
  }
}

function rangeComparisonLabel(timeframe: RangeComparisonTimeframe): string {
  switch (timeframe) {
    case 'day':
      return 'Today';
    case 'week':
      return 'This week';
    case 'month':
      return 'This month';
    case 'all':
      return 'All time';
  }
}

function exclusionReasonLabel(reason: PerformanceExclusionReason | undefined): string {
  if (reason === 'test_data') return 'Test data';
  if (reason === 'erroneous') return 'Erroneous';
  return 'Excluded';
}

function humanizeEnum(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatAlertConfigNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toString();
}

// Ultra v5.0 sends percent as a decimal fraction (e.g. 0.003373 = 0.337%).
// Older Ultra versions send percent as a percent value (e.g. 0.02 = 0.02%).
// Treat values below 0.01 as decimal fractions and larger values as percent numbers.
const PERCENT_FRACTION_THRESHOLD = 0.01;

// Block bracket protection that is larger than a 5% stop/take profit to guard against
// mis-scaled Pine percent values (e.g. 33.73 sent instead of 0.337).
const MAX_PROTECTION_PERCENT = 0.05;

function percentAsDecimal(percent: number): number {
  return percent < PERCENT_FRACTION_THRESHOLD ? percent : percent / 100;
}

function displayPercent(percent: number): number {
  return percent < PERCENT_FRACTION_THRESHOLD ? percent * 100 : percent;
}

function parseStoredProxyPayload(payloadJson: string) {
  try {
    const parsed = JSON.parse(payloadJson);
    const result = proxyPayloadSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStoredPayloadJson(
  rawBody: string,
  payload: z.infer<typeof proxyPayloadSchema>,
  normalizedRangeName: string | undefined,
): string {
  const rawRangeName = typeof payload.extras?.rangeName === 'string' ? payload.extras.rangeName : undefined;
  if (!rawRangeName || !normalizedRangeName || rawRangeName === normalizedRangeName) return rawBody;
  return JSON.stringify({
    ...payload,
    extras: {
      ...payload.extras,
      rangeName: normalizedRangeName,
    },
  });
}

function inferredTickDollars(ticker: string): number {
  if (/^MNQ/i.test(ticker)) return 0.5;
  if (/^NQ/i.test(ticker)) return 5;
  if (/^MES/i.test(ticker)) return 1.25;
  if (/^ES/i.test(ticker)) return 12.5;
  if (/^M2K/i.test(ticker)) return 0.5;
  if (/^RTY/i.test(ticker)) return 5;
  if (/^MYM/i.test(ticker)) return 0.5;
  if (/^YM/i.test(ticker)) return 5;
  if (/^MGC/i.test(ticker)) return 1;
  if (/^GC/i.test(ticker)) return 10;
  if (/^SIL/i.test(ticker)) return 5;   // micro silver, 0.005 tick
  if (/^SI/i.test(ticker)) return 25;   // 5000 oz, 0.005 tick
  if (/^MCL/i.test(ticker)) return 1;
  if (/^CL/i.test(ticker)) return 10;
  if (/^NG/i.test(ticker)) return 10;   // 0.001 tick
  if (/^MNG/i.test(ticker)) return 2.5; // 2500 MMBtu * 0.001
  if (/^MBT/i.test(ticker)) return 0.5; // micro bitcoin, 5-pt tick
  if (/^BT/i.test(ticker)) return 25;   // full-size BTC futures are BT-rooted (BT1!/BTN6)
  if (/^ZL/i.test(ticker)) return 6;
  return 1;
}

function referenceAlertPrice(payload: TradersPostPayload): number | undefined {
  const signalPrice = 'signalPrice' in payload && typeof payload.signalPrice === 'number' ? payload.signalPrice : undefined;
  const price = 'price' in payload && typeof payload.price === 'number' ? payload.price : undefined;
  const limitPrice = 'limitPrice' in payload && typeof payload.limitPrice === 'number' ? payload.limitPrice : undefined;
  const stopPrice = 'stopPrice' in payload && typeof payload.stopPrice === 'number' ? payload.stopPrice : undefined;
  return signalPrice ?? price ?? limitPrice ?? stopPrice;
}

function exactProtectionPrices(
  entry: EntryPayload,
  destination: { useAlertTP?: boolean },
  rangeConfiguration?: RangeConfiguration,
): { takeProfitLimit?: number; stopLossPrice?: number } {
  const entryPrice = referenceAlertPrice(entry);
  if (entryPrice == null) return {};
  const tickSize = inferredTickSize(rangeConfiguration?.instrument ?? entry.ticker);
  const direction = entry.action === 'buy' ? 1 : -1;
  const stopLossFromConfig =
    rangeConfiguration && rangeConfiguration.stopLossTicksCents > 0
      ? Number((rangeConfiguration.stopLossTicksCents / 100 * tickSize).toFixed(4))
      : undefined;
  // Ultra emits absolute SL/TP prices (v5.4+); percent alerts remain as the
  // fallback for pre-deploy payloads still arriving with percent-only exits.
  const stopLossFromAlert =
    typeof entry.stopLoss?.stopPrice === 'number'
      ? Number(Math.abs(entry.stopLoss.stopPrice - entryPrice).toFixed(4))
      : typeof entry.stopLoss?.percent === 'number'
        ? Number((entryPrice * percentAsDecimal(entry.stopLoss.percent)).toFixed(4))
        : undefined;
  const stopLossDistance = destination.useAlertTP
    ? (stopLossFromAlert ?? stopLossFromConfig)
    : (stopLossFromConfig ?? stopLossFromAlert);

  let takeProfitFromConfig: number | undefined;
  if (rangeConfiguration && rangeConfiguration.takeProfitStyle === 'multiplier' && stopLossDistance != null) {
    takeProfitFromConfig = Number(((rangeConfiguration.takeProfitTicksCents / 100) * stopLossDistance).toFixed(4));
  } else if (rangeConfiguration && rangeConfiguration.takeProfitTicksCents > 0) {
    takeProfitFromConfig = Number((rangeConfiguration.takeProfitTicksCents / 100 * tickSize).toFixed(4));
  }
  const takeProfitFromAlert =
    typeof entry.takeProfit?.limitPrice === 'number'
      ? Number(Math.abs(entry.takeProfit.limitPrice - entryPrice).toFixed(4))
      : typeof entry.takeProfit?.percent === 'number'
        ? Number((entryPrice * percentAsDecimal(entry.takeProfit.percent)).toFixed(4))
        : undefined;
  const takeProfitDistance = destination.useAlertTP
    ? (takeProfitFromAlert ?? takeProfitFromConfig)
    : (takeProfitFromConfig ?? takeProfitFromAlert);

  return {
    ...(takeProfitDistance != null
      ? { takeProfitLimit: roundToTick(entryPrice + direction * takeProfitDistance, tickSize) }
      : {}),
    ...(stopLossDistance != null
      ? { stopLossPrice: roundToTick(entryPrice - direction * stopLossDistance, tickSize) }
      : {}),
  };
}

function baseBracketIdFromLifecycleTradeId(tradeId: string): string {
  const normalized = tradeId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
  const lifecycleIndex = normalized.indexOf('-lifecycle-');
  return lifecycleIndex === -1 ? normalized : normalized.slice(0, lifecycleIndex);
}

function buildRangeSimulationAlerts(database: Database): TradersPostPayload[] {
  const rangeConfig = database.getRangeConfiguration('R5 MWF');
  const referenceAlerts = database.listRangeAlertPayloads()
    .filter((alert) => alert.rangeName === 'Test range')
    .map((alert) => parseStoredProxyPayload(alert.payloadJson))
    .filter((payload): payload is EntryPayload => Boolean(payload && !isLifecyclePayload(payload) && (payload.action === 'buy' || payload.action === 'sell')));
  const latestLong = referenceAlerts.find((payload) => payload.action === 'buy');
  const latestShort = referenceAlerts.find((payload) => payload.action === 'sell');
  const fallbackLongPrice = referenceAlertPrice(latestLong ?? notificationTestDraft('test-user'));
  const fallbackShortPrice = referenceAlertPrice(latestShort ?? {
    ...notificationTestDraft('test-user'),
    action: 'sell' as const,
    bracketSide: 'short' as const,
    stopPrice: 29089.5,
    signalPrice: 29089.5,
  });
  const longTicker = latestLong?.ticker ?? latestShort?.ticker ?? rangeConfig?.instrument ?? 'MNQU6';
  const shortTicker = latestShort?.ticker ?? latestLong?.ticker ?? rangeConfig?.instrument ?? 'MNQU6';
  const longTickSize = inferredTickSize(longTicker);
  const shortTickSize = inferredTickSize(shortTicker);
  const longTpTicks = (rangeConfig?.takeProfitTicksCents ?? 75) / 100;
  const longSlTicks = (rangeConfig?.stopLossTicksCents ?? 40) / 100;
  const shortTpTicks = longTpTicks;
  const shortSlTicks = longSlTicks;
  const longEntry = fallbackLongPrice ?? 29110.5;
  const shortEntry = fallbackShortPrice ?? 29089.5;
  return [
    {
      ticker: longTicker,
      action: 'buy',
      quantity: latestLong?.quantity ?? 2,
      orderType: latestLong?.orderType ?? 'stop',
      signalPrice: latestLong?.signalPrice ?? longEntry,
      ...(latestLong?.limitPrice != null ? { limitPrice: latestLong.limitPrice } : {}),
      stopPrice: latestLong?.stopPrice ?? longEntry,
      takeProfit: { limitPrice: Number((longEntry + longTpTicks * longTickSize).toFixed(2)) },
      stopLoss: { type: 'stop' as const, stopPrice: Number((longEntry - longSlTicks * longTickSize).toFixed(2)) },
      bracketId: `test-r5-mwf-long-${randomUUID()}`,
      bracketSide: 'long',
      extras: { rangeName: 'R5 MWF' },
    },
    {
      ticker: shortTicker,
      action: 'sell',
      quantity: latestShort?.quantity ?? 2,
      orderType: latestShort?.orderType ?? 'stop',
      signalPrice: latestShort?.signalPrice ?? shortEntry,
      ...(latestShort?.limitPrice != null ? { limitPrice: latestShort.limitPrice } : {}),
      stopPrice: latestShort?.stopPrice ?? shortEntry,
      takeProfit: { limitPrice: Number((shortEntry - shortTpTicks * shortTickSize).toFixed(2)) },
      stopLoss: { type: 'stop' as const, stopPrice: Number((shortEntry + shortSlTicks * shortTickSize).toFixed(2)) },
      bracketId: `test-r5-mwf-short-${randomUUID()}`,
      bracketSide: 'short',
      extras: { rangeName: 'R5 MWF' },
    },
  ];
}

function buildRangeLifecycleSimulation(options: {
  firstOutcome: 'win' | 'loss';
  secondOutcome: 'win' | 'loss';
  quantity: number;
  realizedDollarsPerTrade: number;
}): Array<TradersPostPayload | LifecyclePayload> {
  const startedAt = Date.now();
  const ticker = 'MNQ1!';
  const rangeName = 'Test Range';
  const firstTradeId = `server-v5.0-${randomUUID()}-first`;
  const secondTradeId = `server-v5.0-${randomUUID()}-second`;
  const longBracketId = `${firstTradeId}-bracket`;
  const shortBracketId = `${secondTradeId}-bracket`;
  const longEntry = 28637.75;
  const longTakeProfit = 28647.75;
  const longStopLoss = 28627.75;
  const shortEntry = 28627.75;
  const shortTakeProfit = 28617.75;
  const shortStopLoss = 28637.75;
  const at = (offsetSeconds: number) => new Date(startedAt + offsetSeconds * 1_000).toISOString();
  const firstExit = options.firstOutcome === 'win' ? longTakeProfit : longStopLoss;
  const secondExit = options.secondOutcome === 'win' ? shortTakeProfit : shortStopLoss;
  const firstExitReason = options.firstOutcome === 'win' ? 'take_profit' : 'stop_loss';
  const secondExitReason = options.secondOutcome === 'win' ? 'take_profit' : 'stop_loss';
  const firstTicks = options.firstOutcome === 'win' ? 40 : -40;
  const secondTicks = options.secondOutcome === 'win' ? 40 : -40;
  const firstDollars = options.firstOutcome === 'win' ? options.realizedDollarsPerTrade : -options.realizedDollarsPerTrade;
  const secondDollars = options.secondOutcome === 'win' ? options.realizedDollarsPerTrade : -options.realizedDollarsPerTrade;

  return [
    {
      ticker,
      action: 'buy',
      sentiment: 'long',
      quantity: options.quantity,
      quantityType: 'fixed_quantity',
      price: longEntry,
      signalPrice: longEntry,
      orderType: 'stop',
      stopPrice: longEntry,
      bracketId: longBracketId,
      bracketSide: 'long',
      time: String(startedAt),
      interval: '15S',
      takeProfit: { limitPrice: longTakeProfit },
      stopLoss: { type: 'stop', stopPrice: longStopLoss },
      extras: {
        source: 'server-v5.0',
        strategyStopPrice: longStopLoss,
        strategyStopMode: 'intrabar',
        orderRole: 'range_bracket',
        orderLeg: 'single',
        rangeName,
      },
    },
    {
      eventType: 'entry_armed',
      eventId: `${firstTradeId}-entry_armed-leg-0`,
      tradeId: firstTradeId,
      ticker,
      side: 'long',
      action: 'buy',
      quantity: options.quantity,
      occurredAt: at(5),
      extras: { source: 'server-v5.0', rangeName },
    },
    {
      eventType: 'entry_filled',
      eventId: `${firstTradeId}-entry_filled-leg-0`,
      tradeId: firstTradeId,
      ticker,
      side: 'long',
      action: 'buy',
      quantity: options.quantity,
      entryPrice: longEntry,
      occurredAt: at(8),
      extras: { source: 'server-v5.0', rangeName },
    },
    {
      eventType: 'exit_filled',
      eventId: `${firstTradeId}-exit_filled-leg-1`,
      tradeId: firstTradeId,
      ticker,
      side: 'long',
      action: 'exit',
      quantity: options.quantity,
      exitPrice: firstExit,
      occurredAt: at(18),
      extras: { source: 'server-v5.0', rangeName, exitReason: firstExitReason },
    },
    {
      eventType: 'trade_closed',
      eventId: `${firstTradeId}-trade_closed-leg-1`,
      tradeId: firstTradeId,
      ticker,
      side: 'long',
      action: 'exit',
      quantity: options.quantity,
      entryPrice: longEntry,
      exitPrice: firstExit,
      closedAt: at(19),
      realizedTicks: firstTicks,
      realizedDollars: firstDollars,
      outcome: options.firstOutcome,
      extras: { source: 'server-v5.0', rangeName, exitReason: firstExitReason },
    },
    {
      ticker,
      action: 'sell',
      sentiment: 'short',
      quantity: options.quantity,
      quantityType: 'fixed_quantity',
      price: shortEntry,
      signalPrice: shortEntry,
      orderType: 'stop',
      stopPrice: shortEntry,
      bracketId: shortBracketId,
      bracketSide: 'short',
      time: String(startedAt + 20_000),
      interval: '15S',
      takeProfit: { limitPrice: shortTakeProfit },
      stopLoss: { type: 'stop', stopPrice: shortStopLoss },
      extras: {
        source: 'server-v5.0',
        strategyStopPrice: shortStopLoss,
        strategyStopMode: 'intrabar',
        orderRole: 'range_bracket',
        orderLeg: 'single',
        rangeName,
      },
    },
    {
      eventType: 'entry_armed',
      eventId: `${secondTradeId}-entry_armed-leg-0`,
      tradeId: secondTradeId,
      ticker,
      side: 'short',
      action: 'sell',
      quantity: options.quantity,
      occurredAt: at(24),
      extras: { source: 'server-v5.0', rangeName },
    },
    {
      eventType: 'entry_filled',
      eventId: `${secondTradeId}-entry_filled-leg-0`,
      tradeId: secondTradeId,
      ticker,
      side: 'short',
      action: 'sell',
      quantity: options.quantity,
      entryPrice: shortEntry,
      occurredAt: at(27),
      extras: { source: 'server-v5.0', rangeName },
    },
    {
      eventType: 'exit_filled',
      eventId: `${secondTradeId}-exit_filled-leg-1`,
      tradeId: secondTradeId,
      ticker,
      side: 'short',
      action: 'exit',
      quantity: options.quantity,
      exitPrice: secondExit,
      occurredAt: at(36),
      extras: { source: 'server-v5.0', rangeName, exitReason: secondExitReason },
    },
    {
      eventType: 'trade_closed',
      eventId: `${secondTradeId}-trade_closed-leg-1`,
      tradeId: secondTradeId,
      ticker,
      side: 'short',
      action: 'exit',
      quantity: options.quantity,
      entryPrice: shortEntry,
      exitPrice: secondExit,
      closedAt: at(37),
      realizedTicks: secondTicks,
      realizedDollars: secondDollars,
      outcome: options.secondOutcome,
      extras: { source: 'server-v5.0', rangeName, exitReason: secondExitReason },
    },
  ];
}

function buildCompleteRangeLifecycleSimulation(): Array<TradersPostPayload | LifecyclePayload> {
  return buildRangeLifecycleSimulation({
    firstOutcome: 'loss',
    secondOutcome: 'win',
    quantity: 1,
    realizedDollarsPerTrade: 20,
  });
}

function buildWinningRangeLifecycleSimulation(): Array<TradersPostPayload | LifecyclePayload> {
  return buildRangeLifecycleSimulation({
    firstOutcome: 'win',
    secondOutcome: 'win',
    quantity: 25,
    realizedDollarsPerTrade: 500,
  });
}

function buildLosingRangeLifecycleSimulation(): Array<TradersPostPayload | LifecyclePayload> {
  return buildRangeLifecycleSimulation({
    firstOutcome: 'loss',
    secondOutcome: 'loss',
    quantity: 25,
    realizedDollarsPerTrade: 500,
  });
}

function lifecycleTestRoutes(database: Database, userId: string): RangeRoute[] {
  const preferredRouteByAccountId = new Map<string, RangeRoute>();
  for (const route of database.listRangeRoutes(userId)) {
    if (!route.extensionEnabled && !route.traderspostEnabled) continue;
    const existing = preferredRouteByAccountId.get(route.accountId);
    if (!existing
      || (route.traderspostEnabled && !existing.traderspostEnabled)
      || (route.extensionEnabled && !existing.extensionEnabled && route.traderspostEnabled === existing.traderspostEnabled)) {
      preferredRouteByAccountId.set(route.accountId, route);
    }
  }
  return [...preferredRouteByAccountId.values()];
}

function ensureLifecycleTestRangeState(database: Database, userId: string): void {
  database.createTrackedRange('Test Range', userId);
  database.upsertRangeReviewFlag('Test Range', userId, 'test_data');
}

const COMPLETE_TEST_SPACING_MS = 3_000;
const MICRO_CONTINUOUS_ROOTS: Record<string, string> = {
  MNQ: 'MNQ',
  NQ: 'MNQ',
  MES: 'MES',
  ES: 'MES',
  MYM: 'MYM',
  YM: 'MYM',
  MGC: 'MGC',
  GC: 'MGC',
  MCL: 'MCL',
  CL: 'MCL',
  MBT: 'MBT',
  BT: 'MBT',
};
const MICRO_CONTINUOUS_QUANTITY_FACTORS: Record<string, number> = {
  MNQ: 1,
  NQ: 10,
  MES: 1,
  ES: 10,
  MYM: 1,
  YM: 10,
  MGC: 1,
  GC: 10,
  MCL: 1,
  CL: 10,
  MBT: 1,
  BT: 10,
};

function summarizeTakeProfit(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const takeProfit = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof takeProfit.percent === 'number') parts.push(`${formatAlertConfigNumber(displayPercent(takeProfit.percent))}%`);
  if (typeof takeProfit.amount === 'number') parts.push(`$${formatAlertConfigNumber(takeProfit.amount)}`);
  if (typeof takeProfit.limitPrice === 'number') parts.push('price target');
  return parts.length ? parts.join(' · ') : 'Configured';
}

function summarizeStopLoss(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const stopLoss = value as Record<string, unknown>;
  const type = typeof stopLoss.type === 'string' ? humanizeEnum(stopLoss.type) : 'Stop';
  if (typeof stopLoss.percent === 'number') return `${type} · ${formatAlertConfigNumber(displayPercent(stopLoss.percent))}%`;
  if (typeof stopLoss.amount === 'number') return `${type} · $${formatAlertConfigNumber(stopLoss.amount)}`;
  if (typeof stopLoss.stopPrice === 'number' || typeof stopLoss.limitPrice === 'number') return `${type} · price based`;
  return type;
}

function summarizeStrategyStop(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const extras = value as Record<string, unknown>;
  const mode = typeof extras.strategyStopMode === 'string' ? humanizeEnum(extras.strategyStopMode) : undefined;
  const hasPrice = typeof extras.strategyStopPrice === 'number' && Number.isFinite(extras.strategyStopPrice);
  if (mode && hasPrice) return `${mode} · price armed`;
  if (mode) return mode;
  if (hasPrice) return 'Configured';
  return undefined;
}

function normalizeOutboundTicker(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized ? normalized : undefined;
}

function normalizeOutboundTickerMode(value: string | undefined): 'micros_only' | undefined {
  return value === 'micros_only' ? value : undefined;
}

const FUTURES_MONTH_LETTERS = 'FGHJKMNQUVXZ';
const FUTURES_MONTH_CONTRACT_RE = new RegExp(`^([A-Z0-9]{1,6})([${FUTURES_MONTH_LETTERS}])(\\d{1,2}|\\d{4})$`);

function normalizeTradersPostTicker(ticker: string): string | undefined {
  if (typeof ticker !== 'string' || ticker.length === 0) return undefined;
  // Continuous contract already valid in TradersPost (e.g. MNQ1!, MGC1!).
  if (ticker.endsWith('1!')) return ticker;
  // Convert a specific-month contract like MNQN26 or MGCU26 to its continuous equivalent.
  const monthMatch = ticker.match(FUTURES_MONTH_CONTRACT_RE);
  if (monthMatch) return `${monthMatch[1]}1!`;
  return undefined;
}

// Contract-aware root extraction: MNQU6 -> MNQ via the futures month parser, not MNQU.
function continuousTickerRoot(ticker: string | null | undefined): string | undefined {
  if (!ticker) return undefined;
  const continuous = normalizeTradersPostTicker(ticker);
  if (continuous) return continuous.slice(0, -2);
  return ticker.match(/^([A-Z]+)/)?.[1];
}

// Root of the ticker TradersPost would actually receive for this stored ticker, so
// local bookkeeping compares in the same space as outbound dispatches.
function destinationTickerRoot(
  ticker: string | null | undefined,
  destination: { outboundTicker?: string; outboundTickerMode?: 'micros_only' },
): string | undefined {
  if (!ticker) return undefined;
  const normalized = normalizeTradersPostTicker(ticker) ?? ticker;
  return continuousTickerRoot(resolvedTradersPostTicker(normalized, destination));
}

function resolvedTradersPostTicker(
  ticker: string,
  destination: { outboundTicker?: string; outboundTickerMode?: 'micros_only' },
): string {
  const normalizedOutboundTicker = normalizeOutboundTicker(destination.outboundTicker);
  if (normalizedOutboundTicker) return normalizedOutboundTicker;
  if (destination.outboundTickerMode === 'micros_only') return defaultMicroContinuousTicker(ticker);
  return ticker;
}

function defaultMicroContinuousTicker(ticker: string): string {
  const root = matchedMicroContinuousRoot(ticker);
  return root ? `${MICRO_CONTINUOUS_ROOTS[root]}${ticker.slice(root.length)}` : ticker;
}

function matchedMicroContinuousRoot(ticker: string): string | undefined {
  if (!ticker.endsWith('1!')) return undefined;
  return Object.keys(MICRO_CONTINUOUS_ROOTS)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => ticker.startsWith(candidate));
}

function microContinuousQuantityFactor(ticker: string): number {
  const root = matchedMicroContinuousRoot(ticker);
  return root ? MICRO_CONTINUOUS_QUANTITY_FACTORS[root] : 1;
}

function applyTradersPostTickerOverride<T extends { ticker: string }>(
  payload: T,
  destination: { outboundTicker?: string; outboundTickerMode?: 'micros_only' },
): T {
  const outboundTicker = resolvedTradersPostTicker(payload.ticker, destination);
  if (payload.ticker === outboundTicker) return payload;
  return {
    ...payload,
    ticker: outboundTicker,
  };
}

function normalizedFixedQuantity(
  ticker: string,
  quantity: number,
  destination: { outboundTickerMode?: 'micros_only' } | undefined,
): number | undefined {
  if (!Number.isFinite(quantity) || quantity <= 0) return undefined;
  const quantityFactor = microContinuousQuantityFactor(ticker);
  const adjustedQuantity = quantityFactor > 1 && destination?.outboundTickerMode === 'micros_only'
    ? quantity * quantityFactor
    : quantity;
  return Math.max(1, Math.round(adjustedQuantity));
}

// Per-contract dollar value of one tick, keyed by contract root. Risk-based
// sizing divides the configured dollar risk by (stopDistanceTicks × value).
// Values are the exchange-defined tick values for each contract — the OUTBOUND
// ticker's root is used, so an NQ alert routed to MNQ micros prices risk at
// $0.50/tick, not $5.
const TICK_VALUE_PER_CONTRACT: Record<string, number> = {
  MNQ: 0.5, NQ: 5,
  MES: 1.25, ES: 12.5,
  MYM: 0.5, YM: 5,
  M2K: 0.5, RTY: 5,
  MGC: 1, GC: 10,
  SIL: 5, SI: 25,
  MCL: 1, CL: 10,
  MNG: 1, NG: 10,
  ZL: 6,
  MBT: 0.5, BT: 25,
};

function contractTickValue(ticker: string): number | undefined {
  const root = /^([A-Za-z]+)/.exec(ticker)?.[1]?.toUpperCase();
  return root ? TICK_VALUE_PER_CONTRACT[root] : undefined;
}

// 'risk' mode: size the entry so a full stop-out loses ~= quantityOverrideValue
// dollars. Stop distance comes from the payload — the strategy stop price
// (extras.strategyStopPrice or an absolute stopLoss.stopPrice) vs the entry
// price; a percent stopLoss resolves to distance the same way the config does.
// Returns undefined when the payload can't prove a stop distance — the alert
// quantity then sails through untouched rather than guessing a size.
function riskSizedQuantity(
  payload: {
    ticker: string;
    stopPrice?: number;
    limitPrice?: number;
    price?: number;
    signalPrice?: number;
    stopLoss?: { stopPrice?: number; price?: number; percent?: number };
    extras?: { strategyStopPrice?: number } | Record<string, unknown> | undefined;
  },
  destination: { outboundTicker?: string; outboundTickerMode?: 'micros_only'; quantityOverrideValue?: number },
): number | undefined {
  const risk = destination.quantityOverrideValue;
  if (risk == null || risk <= 0) return undefined;
  const entryPx = [payload.stopPrice, payload.limitPrice, payload.price, payload.signalPrice]
    .find((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (entryPx == null) return undefined;
  const extrasStop = payload.extras && typeof payload.extras === 'object'
    ? (payload.extras as Record<string, unknown>).strategyStopPrice
    : undefined;
  const stopPx = [payload.stopLoss?.stopPrice, payload.stopLoss?.price, extrasStop]
    .find((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const slDistance = stopPx != null
    ? Math.abs(entryPx - stopPx)
    : payload.stopLoss?.percent != null && payload.stopLoss.percent > 0
      ? entryPx * (payload.stopLoss.percent / 100)
      : undefined;
  if (slDistance == null || slDistance <= 0) return undefined;
  const outboundTicker = resolvedTradersPostTicker(payload.ticker, destination);
  const tickSize = inferredTickSize(outboundTicker);
  const tickValue = contractTickValue(outboundTicker);
  if (tickValue == null) return undefined;
  const ticks = slDistance / tickSize;
  return Math.max(1, Math.floor(risk / (ticks * tickValue)));
}

export function applyAccountFixedQuantityOverride<
  T extends {
    ticker: string;
    quantity?: number;
    quantityType?: string;
    stopPrice?: number;
    limitPrice?: number;
    price?: number;
    signalPrice?: number;
    stopLoss?: { stopPrice?: number; price?: number; percent?: number };
    extras?: Record<string, unknown>;
  },
>(
  payload: T,
  destination: {
    outboundTicker?: string;
    outboundTickerMode?: 'micros_only';
    quantityOverrideMode?: 'percent' | 'fixed' | 'risk';
    quantityOverrideValue?: number;
  } | undefined,
): T {
  if (typeof payload.quantity !== 'number') return payload;
  if (payload.quantityType && payload.quantityType !== 'fixed_quantity') return payload;
  let adjustedQuantity = normalizedFixedQuantity(payload.ticker, payload.quantity, destination);
  // Per-account order sizing — off by default; 'percent' multiplies the alert
  // quantity (any positive value: 15 halves nothing but 15% → alert×0.15),
  // 'fixed' replaces it outright, 'risk' sizes from $ risk ÷ stop distance.
  // Applied after micro scaling so fixed/risk values mean literal outbound
  // contracts.
  if (adjustedQuantity != null && destination?.quantityOverrideValue != null && destination.quantityOverrideValue > 0) {
    if (destination.quantityOverrideMode === 'risk') {
      adjustedQuantity = riskSizedQuantity(payload, destination) ?? adjustedQuantity;
    } else {
      adjustedQuantity = destination.quantityOverrideMode === 'percent'
        ? Math.max(1, Math.round(adjustedQuantity * (destination.quantityOverrideValue / 100)))
        : Math.max(1, Math.round(destination.quantityOverrideValue));
    }
  }
  if (adjustedQuantity == null || adjustedQuantity === payload.quantity) return payload;
  return {
    ...payload,
    quantity: adjustedQuantity,
  };
}

function applyAccountDestinationToPayload<
  T extends { ticker: string; quantity?: number; quantityType?: string },
>(
  payload: T,
  destination: { outboundTicker?: string; outboundTickerMode?: 'micros_only' } | undefined,
): T {
  const quantityAdjusted = applyAccountFixedQuantityOverride(payload, destination);
  return destination ? applyTradersPostTickerOverride(quantityAdjusted, destination) : quantityAdjusted;
}

function buildExplicitMarketExitPayload(
  payload: ExitPayload,
  destination?: { outboundTicker?: string; outboundTickerMode?: 'micros_only' },
): ExitPayload {
  return applyAccountDestinationToPayload({
    ticker: payload.ticker,
    action: 'exit',
    orderType: 'market',
    cancel: true,
    ...(payload.time ? { time: payload.time } : {}),
    ...(payload.interval ? { interval: payload.interval } : {}),
    ...(payload.extras ? { extras: payload.extras } : {}),
  }, destination);
}

function parseMultiplierStyle(style: string): number | undefined {
  const match = style.match(/^([0-9]+(?:\.[0-9]+)?(?:\/[0-9]+(?:\.[0-9]+)?)?)x$/i);
  if (!match) return undefined;
  const value = match[1];
  if (value.includes('/')) {
    const [num, den] = value.split('/');
    const numerator = Number(num);
    const denominator = Number(den);
    if (denominator === 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) return undefined;
    return Number((numerator / denominator).toFixed(6));
  }
  return Number(value);
}

const CRYPTO_FUTURE_ROOTS = new Set(['BTC', 'MBT', 'ETH', 'MET', 'SOL', 'XRP']);
const isCryptoFutureTicker = (ticker: string): boolean => {
  for (const root of CRYPTO_FUTURE_ROOTS) {
    if (ticker.startsWith(root)) return true;
  }
  return false;
};

function getMonthNeighbors(ticker: string): string[] {
  const match = ticker.match(/^([A-Z]+)([FGHJKMNQUVXZ])(\d{1,2}|\d{4})$/);
  if (!match) return [];
  const [, root, monthCode, yearPart] = match;
  const monthIndex = FUTURES_MONTH_LETTERS.indexOf(monthCode);
  if (monthIndex === -1) return [];
  let fullYear = parseInt(yearPart, 10);
  if (yearPart.length <= 2) fullYear += fullYear < 50 ? 2000 : 1900;
  const neighbors: string[] = [];
  for (const offset of [-1, 1]) {
    const nextIndex = (monthIndex + offset + FUTURES_MONTH_LETTERS.length) % FUTURES_MONTH_LETTERS.length;
    let nextYear = fullYear;
    if (offset === -1 && nextIndex > monthIndex) nextYear -= 1;
    if (offset === 1 && nextIndex < monthIndex) nextYear += 1;
    const nextYearPart = yearPart.length <= 2
      ? String(nextYear % 100).padStart(2, '0')
      : String(nextYear);
    neighbors.push(`${root}${FUTURES_MONTH_LETTERS[nextIndex]}${nextYearPart}`);
  }
  return neighbors;
}

interface PreparedTradersPostPayloads {
  payloadJsons: string[];
  protectionError?: string;
  preciseTakeProfitIntent?: {
    bracketId: string;
    instrument: string;
    side: 'long' | 'short';
    action: 'buy' | 'sell';
    payloadJson: string;
  };
}

function prepareTradersPostDestinationPayloads(
  payloadJson: string,
  destination: { accountId: string; outboundTicker?: string; outboundTickerMode?: 'micros_only'; useLimitPriceTP?: boolean; useAlertTP?: boolean },
  rangeConfiguration?: RangeConfiguration,
  openInstrumentSet?: Set<string>,
): PreparedTradersPostPayloads {
  const parsed = parseStoredProxyPayload(payloadJson);
  if (!parsed || isLifecyclePayload(parsed)) return { payloadJsons: [payloadJson] };
  if (parsed.extras?.preciseTakeProfitAfterFill === true) {
    if (parsed.sentiment == null) return { payloadJsons: [payloadJson] };
    const precisePayload = { ...parsed };
    delete precisePayload.sentiment;
    return { payloadJsons: [JSON.stringify(precisePayload)] };
  }
  if (parsed.sentiment != null && parsed.action !== 'buy' && parsed.action !== 'sell') {
    delete parsed.sentiment;
  }
  if (parsed.action === 'cancel') {
    delete parsed.bracketId;
    delete parsed.bracketSide;
    delete parsed.tradeId;
  }
  const normalizedTicker = normalizeTradersPostTicker(parsed.ticker);
  if (!normalizedTicker) {
    return {
      payloadJsons: [],
      protectionError: `Blocked unsupported or unrecognized ticker: ${parsed.ticker}`,
    };
  }
  parsed.ticker = normalizedTicker;
  let outboundPayload = applyAccountDestinationToPayload(parsed, destination);
  const normalizedOutboundTicker = normalizeTradersPostTicker(outboundPayload.ticker);
  if (!normalizedOutboundTicker) {
    return {
      payloadJsons: [],
      protectionError: `Blocked unsupported or unrecognized outbound ticker: ${outboundPayload.ticker}`,
    };
  }
  outboundPayload = { ...outboundPayload, ticker: normalizedOutboundTicker };
  if (outboundPayload.action === 'buy' || outboundPayload.action === 'sell') {
    if (typeof outboundPayload.takeProfit?.percent === 'number' && percentAsDecimal(outboundPayload.takeProfit.percent) > MAX_PROTECTION_PERCENT) {
      return {
        payloadJsons: [],
        protectionError: `Blocked out-of-size take profit: ${outboundPayload.takeProfit.percent} is more than 5%`,
      };
    }
    if (typeof outboundPayload.stopLoss?.percent === 'number' && percentAsDecimal(outboundPayload.stopLoss.percent) > MAX_PROTECTION_PERCENT) {
      return {
        payloadJsons: [],
        protectionError: `Blocked out-of-size stop loss: ${outboundPayload.stopLoss.percent} is more than 5%`,
      };
    }
  }
  let preciseTakeProfitIntent: PreparedTradersPostPayloads['preciseTakeProfitIntent'];
  if (destination.useLimitPriceTP && (outboundPayload.action === 'buy' || outboundPayload.action === 'sell')) {
    const entry = outboundPayload;
    const { takeProfitLimit, stopLossPrice } = exactProtectionPrices(entry, destination, rangeConfiguration);
    const expectedBracketSide = entry.action === 'buy' ? 'long' : 'short';
    const bracketId = typeof entry.bracketId === 'string' && entry.bracketId.trim().length > 0
      ? entry.bracketId
      : undefined;
    const canSendSeparateTakeProfit =
      takeProfitLimit != null
      && stopLossPrice != null
      && bracketId != null
      && entry.bracketSide === expectedBracketSide;
    if (canSendSeparateTakeProfit && bracketId) {
      const action = entry.action === 'buy' ? 'sell' : 'buy';
      const precisePayload: TradersPostPayload = {
        ticker: entry.ticker,
        action,
        quantity: entry.quantity,
        quantityType: entry.quantityType,
        orderType: 'limit',
        limitPrice: takeProfitLimit,
        bracketId,
        bracketSide: expectedBracketSide,
        ...(entry.time ? { time: entry.time } : {}),
        extras: {
          ...(typeof entry.extras === 'object' && entry.extras ? entry.extras : {}),
          preciseTakeProfitAfterFill: true,
        },
      };
      preciseTakeProfitIntent = {
        bracketId,
        instrument: parsed.ticker,
        side: expectedBracketSide,
        action,
        payloadJson: JSON.stringify(precisePayload),
      };
    }
    outboundPayload = {
      ...outboundPayload,
      ...(canSendSeparateTakeProfit ? { takeProfit: undefined } : {}),
      ...(stopLossPrice != null ? { stopLoss: { type: 'stop' as const, stopPrice: stopLossPrice } } : {}),
    };
    if (!canSendSeparateTakeProfit) {
      console.warn('[traderspost] Separate exact take profit unavailable; preserving attached alert protection', {
        accountId: destination.accountId,
        ticker: entry.ticker,
        hasReferencePrice: referenceAlertPrice(entry) != null,
        hasOriginalTakeProfit: entry.takeProfit != null,
        hasRangeConfiguration: rangeConfiguration != null,
        hasExactStopLoss: stopLossPrice != null,
        hasBracketId: bracketId != null,
        bracketSide: entry.bracketSide ?? null,
        expectedBracketSide,
      });
    }
    if (!canSendSeparateTakeProfit && outboundPayload.takeProfit == null) {
      return {
        payloadJsons: [],
        protectionError: 'Blocked entry because no exact or attached take profit protection is available',
      };
    }
  }
  if (outboundPayload.action === 'exit' && openInstrumentSet) {
    const normalizedOpenInstrumentSet = new Set(
      Array.from(openInstrumentSet).map((t) => normalizeTradersPostTicker(t) ?? t).filter(Boolean),
    );
    if (!normalizedOpenInstrumentSet.has(parsed.ticker) && !normalizedOpenInstrumentSet.has(outboundPayload.ticker)) {
      const exitAndCancel = { ...outboundPayload, cancel: true };
      if (JSON.stringify(exitAndCancel) === JSON.stringify(parsed)) return { payloadJsons: [payloadJson] };
      return { payloadJsons: [JSON.stringify(exitAndCancel)] };
    }
  }
  const outboundPayloadJson = JSON.stringify(outboundPayload);
  return {
    payloadJsons: [outboundPayloadJson],
    ...(preciseTakeProfitIntent ? { preciseTakeProfitIntent } : {}),
  };
}

interface RangeAlertSnapshot {
  updatedAt: string;
  ticker: string;
  lastAction: string;
  sourceReference?: string;
  orderType?: string;
  quantityType?: string;
  bracketSide?: string;
  takeProfit?: string;
  stopLoss?: string;
  strategyStop?: string;
}

function prettyPrintJson(payloadJson: string): string {
  try {
    return JSON.stringify(JSON.parse(payloadJson), null, 2);
  } catch {
    return payloadJson;
  }
}

type TradeCalendarMonth = ReturnType<Database['getTradeCalendarMonth']>;
type RangeTradeCalendarMonth = ReturnType<Database['getRangeTradeCalendarMonth']>;
type CalendarMonthView = {
  month: string;
  days: RangeTradeCalendarMonth['days'];
  summary: TradeCalendarMonth['summary'];
};
type CalendarDay = CalendarMonthView['days'][number];
type SharedRangeDetail = ReturnType<Database['listSharedRangeDetails']>[number];
type RangeDaySchedule = {
  rangeName: string;
  instrument: string;
  rangeWindow: string;
  tradingSession: string;
  entriesPerRange: number;
  description: string;
  startAt: number;
  endAt: number;
};

function calendarMonthLabel(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: JOURNAL_TIME_ZONE,
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1, 4)));
}

function journalShiftedDate(now = new Date()): Date {
  return new Date(now.getTime() + JOURNAL_TIME_OFFSET_MINUTES * 60 * 1_000);
}

function shiftMonth(month: string, delta: number): string {
  const [yearPart, monthPart] = month.split('-');
  const shifted = new Date(Date.UTC(Number(yearPart), Number(monthPart) - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function currentJournalMonth(now = new Date()): string {
  const shifted = journalShiftedDate(now);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function slugifyAnchorValue(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'item';
}

function currentJournalWeekday(now = new Date()): number {
  return journalShiftedDate(now).getUTCDay();
}

function journalDateAtTime(dateKey: string, hour: number, minute: number): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - JOURNAL_TIME_OFFSET_MINUTES * 60 * 1_000;
}

function journalDateFromKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - JOURNAL_TIME_OFFSET_MINUTES * 60 * 1_000);
}

function formatJournalDateKey(dateKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: JOURNAL_TIME_ZONE,
  }).format(journalDateFromKey(dateKey));
}

function parseRangeClockSegment(value: string): { hour: number; minute: number } | undefined {
  if (!/^\d{4}$/.test(value)) return undefined;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(2, 4));
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

function formatRelativeMinutes(milliseconds: number): string {
  const absoluteMinutes = Math.max(0, Math.round(Math.abs(milliseconds) / 60_000));
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function rangeScheduleHighlightIntensity(remainingMs: number): number {
  const highlightWindowMs = 60 * 60_000;
  if (remainingMs > highlightWindowMs) return 0;
  return Math.max(0.12, Math.min(1, 1 - (remainingMs / highlightWindowMs)));
}

function calendarMonthCellOffset(month: string): number {
  const [yearPart, monthPart] = month.split('-');
  const firstDay = new Date(Date.UTC(Number(yearPart), Number(monthPart) - 1, 1, 4)).getUTCDay();
  return firstDay;
}

function daysInCalendarMonth(month: string): number {
  const [yearPart, monthPart] = month.split('-');
  return new Date(Date.UTC(Number(yearPart), Number(monthPart), 0)).getUTCDate();
}

function buildPath(basePath: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const serialized = query.toString();
  return serialized ? `${basePath}?${serialized}` : basePath;
}

function summaryDayMetricValue(
  day: CalendarDay,
  metricMode: 'dollars' | 'ticks',
): number {
  return metricMode === 'ticks' ? day.netTicksCents : day.realizedDollarsCents;
}

function renderCalendarDayHovercard(day: CalendarDay, enhanced = false): string {
  const rangeRows = day.ranges.map((range) => `<li><strong>${escapeHtml(range.rangeName)}</strong><span>${escapeHtml(range.instrument)} · ${formatPnl(range.realizedDollarsCents)} · ${formatTicks(range.netTicksCents)} ticks · ${range.closedCount} trade${range.closedCount === 1 ? '' : 's'} · W/L/BE ${renderWinLossBreakevenValue(range.wins, range.losses, range.breakevens)}</span></li>`).join('');
  return `<div class="calendar-day-hovercard${enhanced ? ' calendar-day-hovercard-enhanced' : ''}" role="tooltip"><div class="calendar-day-hovercard-title">Ranges taken · ${day.ranges.length}</div><ul class="calendar-day-hovercard-list">${rangeRows}</ul></div>`;
}

function rangeMetricsForTimeframe(detail: SharedRangeDetail, timeframe: RangeComparisonTimeframe) {
  switch (timeframe) {
    case 'day':
      return detail.performanceCurrentDay;
    case 'week':
      return detail.performanceCurrentWeek;
    case 'month':
      return detail.performanceCurrentMonth;
    case 'all':
      return detail.performanceAllTime;
  }
}

function renderMetricComparisonChart(
  title: string,
  description: string,
  ariaLabel: string,
  labelHeading: string,
  valueHeading: string,
  rows: Array<{
    label: string;
    descriptor: string;
    value: number;
    wins: number;
    losses: number;
    breakevens: number;
    closedCount: number;
  }>,
): string {
  if (!rows.length) {
    return '<div class="empty-state"><strong>No performance to chart yet.</strong>Once lifecycle results arrive, comparison data will appear here.</div>';
  }
  const maxWins = Math.max(1, ...rows.map((row) => row.wins));
  const maxLosses = Math.max(1, ...rows.map((row) => row.losses));
  const rowMarkup = rows.map((row) => {
    const lossWidth = row.losses === 0 ? 0 : Math.max(6, Math.round((row.losses / maxLosses) * 100));
    const winWidth = row.wins === 0 ? 0 : Math.max(6, Math.round((row.wins / maxWins) * 100));
    const netClass = row.value > 0 ? 'range-net-positive' : row.value < 0 ? 'range-net-negative' : 'range-net-neutral';
    const netValueClass = row.value > 0 ? 'positive' : row.value < 0 ? 'negative' : 'neutral';
    return `<div class="range-comparison-grid range-comparison-row">
      <div class="range-comparison-label">
        <strong>${escapeHtml(row.label)}</strong>
        <span>${escapeHtml(row.descriptor)}</span>
      </div>
      <div class="trade-mix trade-mix-loss">
        <span class="trade-mix-count">${row.losses}</span>
        <div class="trade-mix-track">
          <div class="trade-mix-fill" style="width:${lossWidth}%;"></div>
        </div>
      </div>
      <div class="range-net-card ${netClass}">
        <span class="range-net-caption">${escapeHtml(valueHeading)}</span>
        <strong class="${netValueClass}">${escapeHtml(formatTicks(row.value))}</strong>
        <small>${row.closedCount} trigger${row.closedCount === 1 ? '' : 's'} · BE ${row.breakevens}</small>
      </div>
      <div class="trade-mix trade-mix-win">
        <div class="trade-mix-track">
          <div class="trade-mix-fill" style="width:${winWidth}%;"></div>
        </div>
        <span class="trade-mix-count">${row.wins}</span>
      </div>
    </div>`;
  }).join('');
  return `
    <article class="panel range-comparison-panel">
      <div class="range-comparison-header">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(description)}</p>
        </div>
        <div class="range-comparison-legend">
          <span><span class="range-comparison-dot range-comparison-dot-loss"></span>Losing trades</span>
          <span><span class="range-comparison-dot range-comparison-dot-net"></span>Net ticks</span>
          <span><span class="range-comparison-dot range-comparison-dot-win"></span>Winning trades</span>
        </div>
      </div>
      <div class="range-comparison-chart" role="img" aria-label="${escapeHtml(ariaLabel)}">
        <div class="range-comparison-grid range-comparison-head">
          <span>${escapeHtml(labelHeading)}</span>
          <span>Losses</span>
          <span>${escapeHtml(valueHeading)}</span>
          <span>Wins</span>
        </div>
        <div class="range-comparison-rows">
          ${rowMarkup}
        </div>
      </div>
    </article>`;
}

function parseDecimalInput(value: string | number): number | undefined {
  const normalized = typeof value === 'number'
    ? (Number.isFinite(value) ? String(value) : undefined)
    : value.trim();
  if (!normalized) return undefined;
  if (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(normalized)) return undefined;
  const [wholePart, fractionPart = ''] = normalized.split('.');
  const scaled = Number(wholePart || '0') * 100 + Number(fractionPart.padEnd(2, '0') || '0');
  return Number.isSafeInteger(scaled) ? scaled : undefined;
}

function parseDollars(value: string | number): number | undefined {
  return parseDecimalInput(value);
}

function parseDecimalWithCents(value: string | number): number | undefined {
  return parseDecimalInput(value);
}

function page(title: string, content: string, bodyClass = '', theme: AppTheme = 'dark'): string {
  const css = `
 *{box-sizing:border-box}body{margin:0;background:#0a1019;color:#e8edf6;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body:not(.journal-page):not(.login-page){max-width:1000px;margin:2rem auto;padding:0 1rem}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #263346}section{margin:2rem 0;padding:1rem;border:1px solid #263346;border-radius:.7rem;background:#101926}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.65rem;border-bottom:1px solid #263346}th{color:#8fa1b8;font-size:.75rem;letter-spacing:.08em;text-transform:uppercase}label{display:block;margin:.65rem 0;color:#b7c3d4;font-size:.9rem}input,select,textarea,button{padding:.6rem .7rem;border-radius:.45rem;border:1px solid #34445b;background:#111c2b;color:inherit;font:inherit}input::placeholder,textarea::placeholder{color:#7f91aa}input:focus,select:focus,textarea:focus{outline:none;border-color:#4a8dff;box-shadow:0 0 0 2px rgba(74,141,255,.16)}button{cursor:pointer;background:#38d39f;color:#062217;border:0;font-weight:700}a{color:#9bc5ff}.error{color:#ff8993}.muted{color:#8fa1b8}
 .app-shell{min-height:100vh;display:grid;grid-template-columns:248px minmax(0,1fr)}.sidebar{padding:28px 20px;border-right:1px solid #1d2a3b;background:linear-gradient(180deg,#0d1624,#080d15);display:flex;flex-direction:column;gap:30px}.brand{display:flex;gap:11px;align-items:center;font-weight:800;letter-spacing:.02em}.brand-mark{width:31px;height:31px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(135deg,#51e2b0,#4a8dff);color:#07111d}.brand small{display:block;color:#7f91aa;font-size:.68rem;font-weight:600;letter-spacing:.12em;text-transform:uppercase}.sidebar nav{display:grid;gap:6px}.sidebar a{color:#aab7c9;text-decoration:none;padding:10px 12px;border-radius:8px;font-weight:650;transition:background-color .16s ease,color .16s ease,box-shadow .16s ease}.sidebar a:hover,.sidebar a:focus,.sidebar a.active{color:#f1f6fb;background:#162338;outline:none;box-shadow:inset 0 0 0 1px #2a4262}.sidebar-note{margin-top:auto;border:1px solid #26364a;border-radius:10px;padding:12px;color:#8fa1b8;font-size:.78rem;line-height:1.5}.dashboard-main{min-width:0;padding:28px clamp(18px,4vw,56px) 54px}.journal-top{border:0;padding:0 0 24px;margin:0 0 22px;gap:20px}.eyebrow{margin:0 0 5px;color:#4ee0ad;text-transform:uppercase;letter-spacing:.13em;font-size:.72rem;font-weight:800}.journal-top h1{font-size:clamp(1.65rem,3vw,2.45rem);margin:0;letter-spacing:-.04em}.subtle{color:#91a1b7;margin:.4rem 0 0}.top-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap}.outline-button{display:inline-flex;align-items:center;justify-content:center;background:#142238;color:#dbe9f7;border:1px solid #31445f;padding:.45rem .65rem;border-radius:8px;text-decoration:none;font-size:.78rem;font-weight:700;white-space:nowrap;transition:background-color .16s ease,border-color .16s ease,transform .16s ease,box-shadow .16s ease}.outline-button:hover,.outline-button:focus-visible{background:#1a2b43;border-color:#466286;box-shadow:0 0 0 2px rgba(74,141,255,.18);outline:none}.outline-button:active{transform:translateY(1px)}button{transition:background-color .16s ease,transform .16s ease,box-shadow .16s ease}button:hover,button:focus-visible{box-shadow:0 0 0 2px rgba(81,226,176,.16);outline:none}button:active{transform:translateY(1px)}.period-chip{display:inline-flex;gap:7px;align-items:center;background:#101d2d;border:1px solid #2b405a;color:#c6d5e6;padding:9px 11px;border-radius:8px;font-size:.8rem;font-weight:700}.period-chip-forex{flex:1 1 320px;min-width:min(100%,280px);white-space:normal;line-height:1.4}.period-dot{width:7px;height:7px;border-radius:50%;background:#4ee0ad;box-shadow:0 0 12px #4ee0ad}.dashboard-footer-actions{display:flex;justify-content:flex-end;margin-top:8px}.selector-form{margin:0 0 20px;padding:11px 13px;border:1px solid #2d4360;border-radius:10px;background:#101b2a;display:flex;align-items:end;gap:10px}.selector-form label{margin:0;flex:1}.selector-form select{width:100%;margin-top:5px}.selector-form-compact{margin:0 0 0 auto;padding:0;border:0;background:transparent;align-items:center;gap:8px}.selector-form-compact label{flex:0 0 auto;display:flex;align-items:center;gap:8px;font-size:.8rem;font-weight:700;color:#91a3ba;text-transform:uppercase;letter-spacing:.08em}.selector-form-compact select{width:auto;min-width:180px;max-width:240px;margin-top:0}.selector-form-compact button{padding:.58rem .8rem;white-space:nowrap}.journal-section{border:0;background:transparent;padding:0;margin:0 0 28px}.section-heading{display:flex;justify-content:space-between;align-items:end;gap:14px;margin-bottom:13px}.section-heading h2{font-size:1.05rem;margin:0;letter-spacing:-.02em}.section-heading p{margin:0;color:#8394aa;font-size:.83rem}.summary-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.range-detail-grid{display:grid;gap:16px}.range-day-spotlight{padding:0;background:linear-gradient(145deg,rgba(20,31,48,.98),rgba(12,19,31,.98));display:block}.range-day-spotlight>summary{list-style:none;cursor:pointer;padding:22px;transition:background-color .16s ease,box-shadow .16s ease}.range-day-spotlight>summary::-webkit-details-marker{display:none}.range-day-spotlight>summary:hover,.range-day-spotlight>summary:focus-visible{background:rgba(255,255,255,.02);box-shadow:inset 0 0 0 1px #31445f;outline:none}.range-day-spotlight-body{padding:0 22px 22px;display:grid;gap:12px}.range-day-spotlight-header{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;flex-wrap:wrap}.range-day-spotlight-title{display:grid;gap:10px}.range-day-spotlight-title h2{margin:0;font-size:1.18rem;letter-spacing:-.03em}.range-day-spotlight-title p{margin:0;color:#95a7bd;font-size:.9rem;max-width:760px;line-height:1.5}.range-day-life-path{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap}.range-day-life-path .calendar-day-number{padding:9px 12px;border:1px solid rgba(113,89,204,.26);border-radius:12px;background:rgba(28,22,54,.42)}.range-day-life-path-copy{color:#b6c4d7;font-size:.82rem;line-height:1.45}.range-day-summary-pill{display:inline-flex;align-items:center;gap:7px;padding:8px 11px;border-radius:999px;background:rgba(16,27,42,.9);border:1px solid rgba(56,79,110,.72);color:#d8e6f5;font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-day-summary-pill strong{font-size:.95rem;letter-spacing:-.02em;color:#fff}.range-day-spotlight-toggle{display:inline-flex;align-items:center;gap:8px;color:#dce8f6;font-size:.78rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-day-spotlight-toggle-icon{display:inline-block;width:9px;height:9px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-1px);transform-origin:center;transition:transform .16s ease}.range-day-spotlight[open] .range-day-spotlight-toggle-icon{transform:rotate(225deg) translateY(-1px)}.range-day-schedule-grid{display:grid;grid-template-columns:1fr;gap:10px}.range-day-schedule-card{--range-day-intensity:.08;display:grid;grid-template-columns:minmax(0,1.45fr) auto auto;align-items:center;gap:14px;padding:12px 14px;border:1px solid rgba(74,104,141,.34);border-left-width:4px;border-radius:12px;background:rgba(14,23,36,.82);box-shadow:none;transition:border-color .25s ease,background .25s ease}.range-day-schedule-card[data-range-state="upcoming"]{border-color:rgba(255,120,138,calc(.18 + var(--range-day-intensity) * .52));background:linear-gradient(90deg,rgba(255,120,138,calc(.05 + var(--range-day-intensity) * .14)),rgba(14,23,36,.92) 18%,rgba(14,23,36,.92))}.range-day-schedule-card[data-range-state="active"]{border-color:rgba(255,120,138,.78);background:linear-gradient(90deg,rgba(255,120,138,.22),rgba(22,20,33,.96) 16%,rgba(14,23,36,.96))}.range-day-schedule-header{display:flex;justify-content:space-between;align-items:center;gap:12px}.range-day-schedule-header p{margin:.3rem 0 0;color:#8fa1b8;font-size:.81rem;line-height:1.45}.range-day-schedule-meta{display:flex;align-items:center;gap:12px;justify-content:flex-end}.range-day-schedule-meta span{color:#8fa1b8;font-size:.8rem;white-space:nowrap}.range-day-schedule-countdown{font-size:1rem;font-weight:800;letter-spacing:-.02em;color:#f6fbff;white-space:nowrap}.range-day-schedule-countdown[data-range-imminent="true"]{font-weight:900;color:#ffd7dd}.range-day-schedule-description{margin:0;color:#b7c6d7;font-size:.82rem;line-height:1.45}.range-day-empty-note{padding:18px;border:1px dashed #33455e;border-radius:14px;background:rgba(13,23,36,.86);color:#91a3ba}.range-panel{padding:0;border-color:#1d2940;background:#0d1724}.range-panel summary{list-style:none;cursor:pointer;padding:17px;transition:background-color .16s ease,box-shadow .16s ease}.range-panel summary:hover,.range-panel summary:focus-visible{background:#111d2c;box-shadow:inset 0 0 0 1px #31445f}.range-panel summary::-webkit-details-marker{display:none}.range-panel summary:focus-visible{outline:2px solid #4a8dff;outline-offset:-2px}.range-category-panel{padding:0;border-color:#26374f;background:linear-gradient(180deg,rgba(18,28,43,.98),rgba(13,20,31,.98));box-shadow:0 14px 32px rgba(0,0,0,.18)}.range-category-summary{list-style:none;cursor:pointer;padding:18px 20px;position:relative;background:linear-gradient(135deg,rgba(20,31,48,.96),rgba(15,24,37,.96));transition:background-color .16s ease,box-shadow .16s ease,border-color .16s ease}.range-category-summary::-webkit-details-marker{display:none}.range-category-summary:hover,.range-category-summary:focus-visible{background:linear-gradient(135deg,rgba(24,37,57,.98),rgba(17,27,42,.98));box-shadow:inset 0 0 0 1px #395172}.range-category-summary:focus-visible{outline:2px solid #4a8dff;outline-offset:-2px}.range-category-panel[open] .range-category-summary{border-bottom:1px solid #24354d}.range-category-heading{display:grid;gap:8px;min-width:0}.range-category-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.range-category-title-row h2{margin:0;font-size:1.15rem;letter-spacing:-.03em}.range-category-count{display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;background:rgba(78,224,173,.12);border:1px solid rgba(78,224,173,.28);color:#8ff0c9;font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-category-summary p{max-width:560px}.range-category-summary .range-summary-row{align-items:center}.range-category-summary .range-summary-metrics{justify-content:flex-end;align-items:center;gap:10px}.range-category-summary .range-summary-metrics>span{display:inline-flex;align-items:center;gap:6px;padding:8px 10px;border-radius:999px;background:rgba(16,27,42,.9);border:1px solid rgba(56,79,110,.72);color:#b7c7da;font-size:.78rem;font-weight:700}.range-category-toggle{color:#dce8f6}.range-category-toggle-icon{display:inline-block;width:9px;height:9px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-1px);transform-origin:center;transition:transform .16s ease}.range-category-panel[open] .range-category-toggle-icon{transform:rotate(225deg) translateY(-1px)}.range-category-body{padding-top:18px}.range-summary-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}.range-summary-row h2{margin:0;font-size:1.05rem}.range-summary-row p{margin:.35rem 0 0;color:#8394aa;font-size:.83rem}.range-summary-metrics{display:flex;gap:12px;flex-wrap:wrap;color:#8fa1b8;font-size:.82rem}.range-panel-body{padding:0 17px 17px;border-top:1px solid #24354d}.range-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.range-icon{width:20px;height:20px;border-radius:999px;border:1px solid #31445f;background:#101b2a;flex:0 0 auto}.range-instrument-label{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;background:#101b2a;border:1px solid #24354d;color:#b8c8db;font-size:.76rem;font-weight:700}.range-current-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-top:16px}.range-current-card{padding:14px;border:1px solid #24354d;border-radius:12px;background:#101b2a}.range-current-card-wide{grid-column:span 2}.range-current-card span{display:block;color:#91a3ba;font-size:.75rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.range-current-card strong{display:block;margin-top:8px;font-size:.94rem;line-height:1.45}.range-comparison-panel{padding:16px;background:linear-gradient(180deg,rgba(17,29,46,.96),rgba(12,20,33,.96));border-color:transparent;box-shadow:none}.range-leaders-panel{padding:18px;background:linear-gradient(160deg,rgba(16,28,43,.98),rgba(11,18,29,.98));display:grid;gap:16px}.range-comparison-header,.range-leaders-header{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}.range-comparison-header{margin-bottom:12px}.range-comparison-header h3,.range-leaders-header h3{margin:0;font-size:1rem;letter-spacing:-.02em}.range-comparison-header p,.range-leaders-header p{margin:6px 0 0;color:#8fa1b8;font-size:.83rem;max-width:760px}.range-comparison-legend{display:flex;gap:14px;flex-wrap:wrap;color:#c4d2e4;font-size:.78rem;font-weight:700}.range-comparison-legend span{display:inline-flex;align-items:center;gap:7px}.range-comparison-dot{width:10px;height:10px;border-radius:999px;display:inline-block}.range-comparison-dot-loss{background:#ff8c98}.range-comparison-dot-net{background:#7da2ff}.range-comparison-dot-win{background:#76e0b3}.range-leaders-pill-row{display:flex;gap:8px;flex-wrap:wrap}.range-leaders-pill{display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;border:1px solid rgba(49,68,95,.72);background:rgba(16,27,42,.92);font-size:.74rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-leaders-pill-positive{color:#8ff0c9;border-color:rgba(81,226,176,.28);background:rgba(81,226,176,.1)}.range-leaders-pill-negative{color:#ffb0ba;border-color:rgba(255,130,144,.28);background:rgba(255,130,144,.1)}.range-leaders-chart-wrap{width:100%}.range-leaders-chart{display:block;width:100%;height:328px;color:#8fa1b8}.range-leaders-axis{stroke-width:1}.range-leaders-axis-top,.range-leaders-axis-bottom{stroke:rgba(143,161,184,.16)}.range-leaders-axis-mid{stroke:rgba(143,161,184,.26)}.range-leaders-axis-label{fill:currentColor;font-size:11px;font-weight:700}.range-leader-bar{stroke-width:1}.range-leader-bar-positive{fill:url(#range-leader-positive-fill);stroke:rgba(81,226,176,.42);color:#76e0b3}.range-leader-bar-negative{fill:url(#range-leader-negative-fill);stroke:rgba(255,130,144,.42);color:#ff8c98}.range-leader-bar-neutral{fill:url(#range-leader-neutral-fill);stroke:rgba(125,162,255,.36);color:#b8c8db}.range-leader-value{fill:currentColor;font-size:12px;font-weight:800}.range-leader-label{fill:#eef5ff;font-size:12px;font-weight:800}.range-leader-meta{fill:#8fa1b8;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.range-comparison-chart{display:grid;gap:8px}.range-comparison-grid{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(120px,1fr) minmax(150px,.95fr) minmax(120px,1fr);gap:12px;align-items:center}.range-comparison-head{padding:0 2px 6px;color:#91a3ba;font-size:.75rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;border-bottom:0}.range-comparison-head span:nth-child(2){text-align:right}.range-comparison-head span:nth-child(3){text-align:center}.range-comparison-head span:nth-child(4){text-align:left}.range-comparison-rows{display:grid;gap:8px}.range-comparison-row{padding:12px 14px;border:0;border-radius:14px;background:rgba(14,23,36,.72);box-shadow:none}.range-comparison-label strong{display:block;font-size:1rem;line-height:1.25;color:#eef5ff}.range-comparison-label span{display:block;margin-top:4px;color:#8fa1b8;font-size:.83rem;line-height:1.4}.trade-mix{display:flex;align-items:center;gap:8px}.trade-mix-loss{justify-content:flex-end}.trade-mix-win{justify-content:flex-start}.trade-mix-track{position:relative;flex:1;height:8px;border-radius:999px;background:#142131;overflow:hidden;box-shadow:none}.trade-mix-fill{position:absolute;top:0;bottom:0;border-radius:999px}.trade-mix-loss .trade-mix-fill{right:0;background:linear-gradient(90deg,rgba(255,140,152,.25),#ff8c98)}.trade-mix-win .trade-mix-fill{left:0;background:linear-gradient(90deg,#76e0b3,rgba(118,224,179,.3))}.trade-mix-count{flex:0 0 auto;min-width:30px;padding:3px 0;border-radius:999px;background:transparent;border:0;color:#dce8f6;font-size:.78rem;font-weight:800;text-align:center}.range-net-card{display:grid;justify-items:center;gap:2px;padding:10px 12px;border-radius:14px;border:0;background:rgba(18,30,46,.72);text-align:center}.range-net-caption{color:#8fa1b8;font-size:.7rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-net-card strong{font-size:1.08rem;letter-spacing:-.03em;color:#eef5ff}.range-net-card small{color:#8fa1b8;font-size:.74rem}.range-net-positive{box-shadow:none}.range-net-negative{box-shadow:none}.range-net-neutral{box-shadow:none}.dirty-submit-hidden{display:none!important}.range-config-form,.range-enroll-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:14px}.range-config-form .field-span-2,.range-enroll-form .field-span-2{grid-column:1 / -1}.range-config-form label,.range-enroll-form label,.settings-panel label{display:grid;gap:6px}.range-config-form textarea,.settings-panel textarea{width:100%;margin-top:0;resize:vertical;min-height:120px;line-height:1.5}.range-enroll-form .check-label,.range-config-form .check-label,.settings-panel .check-label{display:flex;gap:8px;align-items:center}.range-enroll-form .check-label input,.range-config-form .check-label input,.settings-panel .check-label input{width:auto;margin:0}.day-checkbox-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 12px}.day-checkbox-grid label,.settings-panel .day-checkbox-grid label{display:flex;gap:8px;align-items:center;margin:0;font-size:.84rem}.day-checkbox-grid input{width:auto;margin:0}.table-date{display:inline-block;white-space:nowrap}.range-meta{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#8fa1b8;font-size:.82rem}.range-metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:14px 0}.alert-summary{margin-bottom:12px}.calendar-nav{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.calendar-panel{padding:17px}.calendar-month-heading{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}.calendar-month-heading h3{margin:0;font-size:1rem}.calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:10px}.calendar-weekdays{margin-bottom:10px}.calendar-weekdays span{color:#8fa1b8;font-size:.75rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase;padding:0 2px}.calendar-day{min-height:132px;padding:12px;border:1px solid #24354d;border-radius:12px;background:#101b2a;display:flex;flex-direction:column;gap:7px}.calendar-day-win{background:rgba(81,226,176,.08);border-color:rgba(81,226,176,.28)}.calendar-day-loss{background:rgba(255,130,144,.08);border-color:rgba(255,130,144,.28)}.calendar-day-flat{background:#101b2a}.calendar-day-empty{background:transparent;border-style:dashed;min-height:132px}.calendar-day-number{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}.calendar-day-date{font-size:.84rem;font-weight:800;color:#b8c7d9}.calendar-day-life-path{font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#b184ff}.calendar-day-hidden{font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7f91aa}.calendar-day-pnl{font-size:1rem;font-weight:800;letter-spacing:-.02em}.calendar-day-meta{color:#90a2b9;font-size:.79rem;line-height:1.35}.calendar-day-empty-copy{margin-top:auto;color:#71849d;font-size:.78rem}.metric-card{min-height:137px;padding:15px;border:1px solid #24354d;border-radius:12px;background:linear-gradient(145deg,#111e30,#0d1725);box-shadow:0 12px 28px rgba(0,0,0,.14);transition:border-color .16s ease,transform .16s ease}.metric-card:hover{border-color:#2e4360;transform:translateY(-1px)}.metric-label{display:block;color:#91a3ba;font-size:.76rem;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.metric-values{display:grid;gap:7px;margin-top:13px}.metric-line{display:flex;justify-content:space-between;gap:10px;font-size:.85rem;color:#91a3ba}.metric-line strong{font-size:.95rem;color:#e8edf6}.positive{color:#50dbaa!important}.negative{color:#ff8290!important}.neutral{color:#e8edf6!important}.panel{border:1px solid #24354d;border-radius:12px;background:#0f1927;overflow:hidden}.table-wrap{overflow-x:auto}.journal-table{min-width:720px}.journal-table tbody tr:last-child td{border-bottom:0}.journal-table .row-muted td{opacity:.72}.alert-table{min-width:980px}.state-chip{display:inline-flex;padding:4px 8px;border-radius:999px;background:#16263b;color:#d5e4f5;font-size:.74rem;font-weight:750;white-space:nowrap}.outcome{display:inline-flex;align-items:center;padding:4px 8px;border-radius:999px;font-size:.73rem;font-weight:800;text-transform:capitalize}.outcome.win{background:rgba(59,211,157,.13);color:#54e2af}.outcome.loss{background:rgba(255,112,129,.12);color:#ff9aa5}.outcome.breakeven{background:rgba(145,164,186,.12);color:#c1cede}.empty-state{padding:34px 24px;text-align:center;color:#91a3ba;border:1px dashed #33455e;border-radius:12px;background:#0d1724}.empty-state strong{display:block;color:#e5edf7;margin-bottom:6px}.account-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:12px}.account-card{padding:16px;border:1px solid #24354d;border-radius:12px;background:#101b2a}.account-card h3{margin:0 0 14px;font-size:1rem}.account-data{display:grid;grid-template-columns:1fr auto;gap:9px;font-size:.86rem}.account-data span{color:#91a3ba}.account-data strong{text-align:right}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}.settings-column{display:grid;gap:16px;align-content:start;min-width:0}.settings-panel{padding:17px}.settings-panel--full-width{grid-column:1 / -1}.settings-panel h3{margin:0 0 5px}.settings-panel p{color:#91a3ba;font-size:.84rem}.settings-panel form{display:grid;gap:5px}.settings-panel input,.settings-panel select{width:100%;margin-top:0}.settings-panel table{font-size:.85rem}.settings-panel th,.settings-panel td{padding:.5rem .2rem}.sign-out{margin:0}.sign-out button{background:#17263a;color:#dce9f5;border:1px solid #334962}.json-page{max-width:1200px}.json-frame{padding:18px;border:1px solid #24354d;border-radius:12px;background:#0f1927;overflow:auto}.json-frame pre{margin:0;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,"Liberation Mono","Courier New",monospace;white-space:pre-wrap;word-break:break-word}(max-width:960px){.app-shell{grid-template-columns:1fr}.sidebar{padding:18px 20px;display:flex;flex-direction:column;align-items:stretch;gap:16px;border-right:0;border-bottom:1px solid #1d2a3b}.sidebar nav{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));margin-left:0;width:100%}.sidebar a{text-align:center}.sidebar-note{display:block;margin-top:0}.dashboard-main{padding:24px 20px 42px}.journal-top,.section-heading{align-items:flex-start;flex-direction:column}.top-actions{width:100%;justify-content:flex-start}.summary-grid,.range-metric-grid,.range-config-form,.range-enroll-form{grid-template-columns:repeat(2,minmax(0,1fr))}.calendar-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.range-summary-metrics{width:100%}.range-category-summary .range-summary-metrics{justify-content:flex-start}.range-comparison-grid{grid-template-columns:minmax(220px,1.35fr) minmax(110px,1fr) minmax(140px,.95fr) minmax(110px,1fr)}}(max-width:620px){.sidebar{padding:16px}.sidebar nav{grid-template-columns:repeat(2,minmax(0,1fr))}.top-actions{width:100%;justify-content:flex-start}.period-chip-forex{flex-basis:100%}.dashboard-footer-actions{justify-content:stretch}.dashboard-footer-actions .sign-out{width:100%}.dashboard-footer-actions .sign-out button{width:100%}.summary-grid,.range-metric-grid,.range-current-grid,.range-config-form,.range-enroll-form,.calendar-grid,.day-checkbox-grid,.range-comparison-grid,.range-day-schedule-grid{grid-template-columns:1fr}.range-current-card-wide{grid-column:auto}.settings-grid{grid-template-columns:1fr}.selector-form{display:block}.selector-form button,.range-config-form button,.range-enroll-form button,.settings-panel button,.calendar-nav .outline-button{width:100%;justify-content:center}.selector-form button{margin-top:8px}.selector-form-compact{display:block;width:100%}.selector-form-compact label{display:block}.selector-form-compact select{width:100%;max-width:none;margin-top:5px}.account-grid{grid-template-columns:1fr}.calendar-weekdays{display:none}.calendar-nav{width:100%;display:grid;grid-template-columns:1fr}.calendar-month-heading,.range-summary-row,.range-day-spotlight-header,.range-day-schedule-header,.range-day-schedule-meta{align-items:flex-start}.range-category-summary{padding:16px}.range-category-summary .range-summary-metrics>span{width:100%;justify-content:space-between}.calendar-day,.calendar-day-empty{min-height:0}.settings-column-route{order:1}.settings-column-actions{order:2}.range-leaders-panel{padding:16px}.range-leaders-chart{height:292px}.range-leader-label{font-size:11px}.range-leader-meta{font-size:9px}}
  `;
  const enhancementsCss = `
body.theme-dark{color-scheme:dark}body.theme-light{color-scheme:light}
.metric-card-alert .metric-detail{display:grid;gap:4px}.metric-card-alert .metric-detail-label{font-size:.85rem;color:#91a3ba}.metric-card-alert .metric-detail strong{font-size:1rem;color:#e8edf6;line-height:1.3;white-space:normal;overflow-wrap:anywhere;text-align:left}
.journal-dashboard-section{display:grid;gap:18px}.journal-kpi-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.journal-kpi-card{padding:16px;background:linear-gradient(145deg,#111c2c,#0d1724);display:grid;gap:14px;min-height:176px}.journal-kpi-card-primary{background:linear-gradient(145deg,rgba(81,226,176,.12),rgba(16,28,43,.96))}.journal-kpi-label-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.journal-kpi-pill,.journal-mix-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid #31445f;background:rgba(17,29,46,.82);color:#bfd0e4;font-size:.72rem;font-weight:800;letter-spacing:.03em}.journal-kpi-value{font-size:2.05rem;line-height:1;letter-spacing:-.05em;color:#eef5ff}.journal-kpi-subgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.journal-kpi-subgrid span,.journal-kpi-chart-stats span{display:grid;gap:4px;color:#8fa1b8;font-size:.78rem}.journal-kpi-subgrid strong,.journal-kpi-chart-stats strong{font-size:1rem;color:#eef5ff}.journal-kpi-chart-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px;align-items:center}.journal-ring-chart{--journal-ring-positive:50%;--journal-ring-secondary:50%;--journal-ring-tertiary:0%;width:102px;height:102px;border-radius:50%;position:relative;display:grid;place-items:center;background:conic-gradient(#51e2b0 0 var(--journal-ring-positive),#ff8290 var(--journal-ring-positive) calc(var(--journal-ring-positive) + var(--journal-ring-secondary)),rgba(148,163,184,.4) calc(var(--journal-ring-positive) + var(--journal-ring-secondary)) 100%)}.journal-ring-chart::before{content:"";position:absolute;inset:10px;border-radius:50%;background:#0f1927;border:1px solid rgba(49,68,95,.7)}.journal-ring-chart span{position:relative;z-index:1;font-size:1.1rem;font-weight:800;color:#eef5ff;letter-spacing:-.03em}.journal-ring-chart-profit{background:conic-gradient(#51e2b0 0 var(--journal-ring-positive),#ff8290 var(--journal-ring-positive) 100%)}.journal-ring-chart-triple{background:conic-gradient(#51e2b0 0 var(--journal-ring-positive),#ff8290 var(--journal-ring-positive) calc(var(--journal-ring-positive) + var(--journal-ring-secondary)),#7da2ff calc(var(--journal-ring-positive) + var(--journal-ring-secondary)) 100%)}.journal-balance-bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:#142131}.journal-balance-bar-positive{background:linear-gradient(90deg,#51e2b0,#86efc4)}.journal-balance-bar-negative{background:linear-gradient(90deg,#ff9aa5,#ff6b79)}.journal-spotlight-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(320px,.95fr);gap:14px}.journal-spotlight-card{padding:18px;display:grid;gap:16px;background:linear-gradient(145deg,#101a29,#0d1622)}.journal-spotlight-card-compact{align-content:start}.journal-spotlight-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}.journal-spotlight-header h3{margin:0;font-size:1.02rem;letter-spacing:-.02em}.journal-spotlight-header p{margin:6px 0 0;color:#8fa1b8;font-size:.83rem}.journal-spotlight-stat{display:grid;gap:4px;text-align:right}.journal-spotlight-stat strong{font-size:1.1rem;color:#eef5ff}.journal-cumulative-chart{width:100%;height:auto;display:block;color:#8fa1b8}.journal-axis-label{fill:currentColor;font-size:11px}.journal-cumulative-area{fill:url(#journal-cumulative-fill)}.journal-cumulative-line{fill:none;stroke:#7da2ff;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}.journal-cumulative-point{fill:#51e2b0;stroke:#0f1927;stroke-width:2}.journal-mix-layout{display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px;align-items:center}.journal-mix-stats{grid-template-columns:repeat(2,minmax(0,1fr));display:grid;gap:10px 14px}.journal-mix-footer{display:flex;gap:10px;flex-wrap:wrap}.journal-dashboard-wide{display:grid}.journal-dashboard-wide .panel{height:100%}.journal-performance-summary{padding:18px 18px 14px}
.calendar-day-has-details{position:relative;cursor:default}.calendar-day-clickable{cursor:pointer}.calendar-day-summary{margin-top:auto;display:grid;gap:4px}.calendar-day-open-hint{font-size:.75rem;font-weight:800;letter-spacing:.04em;color:#9bc5ff}.calendar-day-has-details:focus-visible{outline:2px solid #4a8dff;outline-offset:2px}.calendar-day-hovercard{display:none;position:absolute;left:12px;right:12px;bottom:calc(100% + 10px);z-index:3;padding:12px;border:1px solid #2f4665;border-radius:12px;background:#0b1420;box-shadow:0 16px 36px rgba(0,0,0,.34);opacity:0;pointer-events:none;transform:translateY(6px);transition:opacity .16s ease,transform .16s ease}.calendar-day-has-details:not([data-hovercard-delay]):hover .calendar-day-hovercard{display:block;opacity:1;transform:translateY(0)}.calendar-panel-hovercards-enhanced{overflow:visible}.calendar-panel-hovercards-enhanced .calendar-grid{position:relative;isolation:isolate}.calendar-panel-hovercards-enhanced .calendar-day-has-details[data-hovercard-active="true"]{z-index:6}.calendar-panel-hovercards-enhanced .calendar-day-hovercard{left:50%;right:auto;bottom:calc(100% + 12px);z-index:7;width:min(560px,calc(100vw - 48px));max-height:min(72vh,680px);overflow:auto;padding:18px 20px;border-radius:16px;box-shadow:0 22px 48px rgba(0,0,0,.4);transform:translate(-50%,6px);transition:opacity .18s ease,transform .18s ease}.calendar-panel-hovercards-enhanced .calendar-day-has-details[data-hovercard-active="true"] .calendar-day-hovercard{display:block;opacity:1;transform:translate(-50%,0)}.calendar-day-hovercard-title{font-size:.72rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#8fb2dc}.calendar-day-hovercard-list{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:8px}.calendar-day-hovercard-list li{display:grid;gap:2px}.calendar-day-hovercard-list strong{font-size:.83rem;color:#eef5fd}.calendar-day-hovercard-list span{font-size:.76rem;line-height:1.45;color:#a8b8cc}.calendar-panel-hovercards-enhanced .calendar-day-hovercard-title{font-size:.78rem}.calendar-panel-hovercards-enhanced .calendar-day-hovercard-list{margin:12px 0 0;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px;align-items:start}.calendar-panel-hovercards-enhanced .calendar-day-hovercard-list li{gap:5px;padding:10px 0;border-bottom:1px solid rgba(143,178,220,.16)}.calendar-panel-hovercards-enhanced .calendar-day-hovercard-list li:last-child{padding-bottom:0}.calendar-panel-hovercards-enhanced .calendar-day-hovercard-list strong{font-size:.95rem}.calendar-panel-hovercards-enhanced .calendar-day-hovercard-list span{font-size:.85rem;line-height:1.55}.journal-day-page-layout{max-width:1180px;margin:0 auto;padding:28px 16px 48px;display:grid;gap:20px}.journal-day-page-header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}.journal-day-page-header h1{margin:4px 0 0;font-size:2rem}.journal-day-page-kicker{margin:0;color:#8fb2dc;font-size:.8rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.journal-day-range-list,.journal-day-trade-grid{display:grid;gap:14px}.journal-day-range-card{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:14px 16px;border:1px solid #263346;border-radius:14px;background:rgba(14,23,36,.72)}.journal-day-range-card div{display:grid;gap:4px}.journal-day-range-card strong{font-size:1rem;color:#eef5ff}.journal-day-range-card span{color:#9db0c7;font-size:.84rem}.journal-day-trade-card{gap:16px;padding:16px 18px;border-radius:16px;background:linear-gradient(145deg,rgba(17,28,43,.96),rgba(12,21,33,.94));box-shadow:0 10px 24px rgba(0,0,0,.14)}.journal-day-trade-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap}.journal-day-trade-header h3{margin:0 0 6px;font-size:1.08rem;letter-spacing:-.02em}.journal-day-trade-header p{margin:0;color:#9db0c7;font-size:.92rem}.journal-day-pill-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}.journal-day-trade-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px 18px}.journal-day-trade-stats span{display:grid;gap:4px;color:#8fa1b8;font-size:.76rem;text-transform:uppercase;letter-spacing:.08em}.journal-day-trade-stats strong{color:#eef5ff;font-size:1.02rem;letter-spacing:-.01em;text-transform:none}
.range-leaders-panel{padding:0!important;border:0!important;box-shadow:none!important}.range-leaders-summary{list-style:none;cursor:pointer;padding:18px 18px 10px}.range-leaders-summary::-webkit-details-marker{display:none}.range-leaders-summary:focus-visible{outline:2px solid #4a8dff;outline-offset:-2px}.range-leaders-body{padding:0 18px 18px;display:grid;gap:16px}.range-leaders-header-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.range-leaders-toggle{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:999px;border:1px solid rgba(49,68,95,.72);background:rgba(16,27,42,.86);color:#c6d5e6;font-size:.74rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-leaders-toggle-icon{display:inline-block;width:9px;height:9px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(225deg) translateY(-1px);transform-origin:center;transition:transform .16s ease}.range-leaders-panel:not([open]) .range-leaders-toggle-icon{transform:rotate(45deg) translateY(-1px)}.range-leaders-axis-row{display:grid;grid-template-columns:minmax(190px,1.3fr) minmax(280px,2.2fr) minmax(92px,.7fr);align-items:center;gap:14px;color:#8fa1b8;font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-leaders-axis-row span:nth-child(1){text-align:left}.range-leaders-axis-row span:nth-child(2){text-align:center}.range-leaders-axis-row span:nth-child(3){text-align:right}.range-leaders-chart{display:grid;gap:12px}.range-leader-row{display:grid;grid-template-columns:minmax(190px,1.3fr) minmax(280px,2.2fr) minmax(92px,.7fr);align-items:center;gap:14px}.range-leader-copy strong{display:block;font-size:.95rem;color:#eef5ff;line-height:1.25}.range-leader-copy span{display:block;margin-top:4px;color:#8fa1b8;font-size:.8rem;line-height:1.45}.range-leader-track{position:relative;height:42px;border-radius:14px;background:rgba(16,27,42,.64);overflow:hidden}.range-leader-track-axis{position:absolute;top:7px;bottom:7px;left:50%;width:1px;transform:translateX(-50%);background:rgba(143,161,184,.28)}.range-leader-fill{position:absolute;top:8px;bottom:8px;border-radius:8px}.range-leader-fill.range-leader-bar-positive{background:linear-gradient(90deg,#5ddca9,#8cebc7)}.range-leader-fill.range-leader-bar-negative{background:linear-gradient(90deg,#ffb2bc,#f26a7b)}.range-leader-fill.range-leader-bar-neutral{background:linear-gradient(90deg,#cbd8ea,#98a9bf)}.range-leader-values{text-align:right}.range-leader-values strong{display:block;font-size:1rem}.range-leader-values span{display:block;margin-top:4px;color:#8fa1b8;font-size:.76rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
.range-reassign-form{display:grid;gap:8px;min-width:220px}.range-reassign-form label{margin:0;display:grid;gap:6px;font-size:.76rem;font-weight:700;color:#91a3ba;text-transform:uppercase;letter-spacing:.08em}.range-reassign-form button{width:100%}.range-reassign-dialog{width:min(100%,440px);border:1px solid #2d4360;border-radius:18px;padding:0;background:#0f1927;color:#e8edf6;box-shadow:0 24px 64px rgba(0,0,0,.38)}.range-reassign-dialog::backdrop{background:rgba(4,10,18,.72)}.range-reassign-dialog-body{padding:22px 22px 18px;display:grid;gap:14px}.range-reassign-dialog h3{margin:0;font-size:1.05rem}.range-reassign-dialog p{margin:0;color:#91a3ba;line-height:1.55}.range-reassign-dialog dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:8px 12px}.range-reassign-dialog dt{color:#91a3ba;font-size:.76rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-reassign-dialog dd{margin:0;font-weight:700;overflow-wrap:anywhere}.range-reassign-dialog-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
.range-day-spotlight-actions{display:flex;justify-content:flex-end}.range-day-spotlight-toggle{display:inline-flex;align-items:center;gap:12px;padding:10px 16px;border-radius:999px;border:1px solid rgba(49,68,95,.72);background:rgba(16,27,42,.86);color:#c6d5e6;font-size:.74rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.range-day-spotlight-toggle-icon{display:inline-block;width:11px;height:11px;border-right:3px solid currentColor;border-bottom:3px solid currentColor;transform:rotate(225deg) translateY(1px);transform-origin:center;transition:transform .16s ease}.range-day-spotlight:not([open]) .range-day-spotlight-toggle-icon{transform:rotate(45deg) translateY(-1px)}.range-day-category-form{display:grid;gap:12px;padding:14px 16px;border:1px solid rgba(49,68,95,.6);border-radius:16px;background:rgba(11,18,29,.64)}.range-day-category-form-header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.range-day-category-form-header strong{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#c7d5e6}.range-day-category-actions,.range-day-category-submit{display:flex;gap:8px;flex-wrap:wrap}.range-day-category-options{display:flex;gap:8px;flex-wrap:wrap}.range-day-category-option{display:inline-flex;align-items:center;gap:8px;padding:7px 11px;border-radius:999px;border:1px solid rgba(49,68,95,.62);background:rgba(16,27,42,.82);color:#c7d5e6;font-size:.82rem;margin:0}.range-day-category-option input{margin:0}.range-day-schedule-card[data-range-state="upcoming"],.range-day-schedule-card[data-range-state="active"]{box-shadow:inset 0 0 0 1px rgba(255,120,138,calc(var(--range-day-intensity) * .55))}.range-day-schedule-card[data-range-state="upcoming"]{background:linear-gradient(90deg,rgba(255,120,138,calc(var(--range-day-intensity) * .18)),rgba(14,23,36,.92) 18%,rgba(14,23,36,.92))}.range-day-schedule-card[data-range-state="active"]{background:linear-gradient(90deg,rgba(255,120,138,calc(var(--range-day-intensity) * .24)),rgba(22,20,33,.96) 16%,rgba(14,23,36,.96))}.range-day-schedule-countdown{display:flex;align-items:baseline;gap:6px;justify-self:end;font-size:1rem;font-weight:500;letter-spacing:-.02em;color:#aebed0;white-space:nowrap}.range-day-schedule-countdown-value{font-weight:800;color:#f6fbff}.range-day-schedule-countdown[data-range-imminent="true"] .range-day-schedule-countdown-value{font-weight:900;color:#ffd7dd}.range-day-completed-section{display:grid;gap:8px;padding-top:4px}.range-day-completed-section h3{margin:0;color:#7f91a7;font-size:.74rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase}.range-day-completed-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}.range-day-completed-item{display:flex;justify-content:space-between;gap:10px;color:#8fa1b8;font-size:.8rem;line-height:1.35}.range-day-completed-name{font-weight:500;color:#9eb0c5}.range-day-completed-time{font-size:.76rem;color:#70839a;white-space:nowrap}
body.theme-light{background:#eef3f9;color:#142132}body.theme-light header{border-bottom-color:#d4deea}body.theme-light section{border-color:#d4deea;background:#fff}body.theme-light input,body.theme-light select,body.theme-light textarea{background:#fff;border-color:#c7d5e6;color:#142132}body.theme-light input::placeholder,body.theme-light textarea::placeholder{color:#7b8da3}body.theme-light a{color:#2459c6}body.theme-light .muted,body.theme-light .subtle{color:#5f7288}body.theme-light .sidebar{border-right-color:#d4deea;background:linear-gradient(180deg,#fbfdff,#edf3fb)}body.theme-light .sidebar a{color:#4c627a}body.theme-light .sidebar a:hover,body.theme-light .sidebar a:focus,body.theme-light .sidebar a.active{color:#10263f;background:#e4edf8;box-shadow:inset 0 0 0 1px #c2d4ea}body.theme-light .sidebar-note,body.theme-light .period-chip,body.theme-light .selector-form,body.theme-light .range-current-card,body.theme-light .account-card,body.theme-light .metric-card,body.theme-light .panel,body.theme-light .calendar-day,body.theme-light .range-icon,body.theme-light .range-instrument-label,body.theme-light .empty-state,body.theme-light .json-frame,body.theme-light .state-chip{background:#fff;color:#142132;border-color:#d4deea}body.theme-light .metric-card{background:linear-gradient(145deg,#ffffff,#f2f6fb);box-shadow:0 10px 26px rgba(55,78,107,.08)}body.theme-light .metric-card:hover{border-color:#9fb7d5}body.theme-light .metric-card-alert .metric-detail-label{color:#5f7288}body.theme-light .metric-card-alert .metric-detail strong{color:#142132}body.theme-light .journal-dashboard-section{gap:22px;padding:8px 6px 14px}body.theme-light .journal-dashboard-section .section-heading{margin-bottom:2px;padding:0 2px}body.theme-light .journal-dashboard-section .selector-form-compact{padding-top:2px}body.theme-light .journal-kpi-card,body.theme-light .journal-spotlight-card{background:linear-gradient(145deg,#ffffff,#f4f7fb)}body.theme-light .journal-kpi-card-primary{background:linear-gradient(145deg,rgba(23,132,99,.08),#ffffff)}body.theme-light .journal-kpi-value,body.theme-light .journal-ring-chart span,body.theme-light .journal-spotlight-header h3,body.theme-light .journal-spotlight-stat strong,body.theme-light .journal-kpi-subgrid strong,body.theme-light .journal-kpi-chart-stats strong{color:#142132}body.theme-light .journal-kpi-pill,body.theme-light .journal-mix-pill{background:#edf3fb;border-color:#d4deea;color:#466078}body.theme-light .journal-ring-chart::before{background:#fff;border-color:#d4deea}body.theme-light .journal-balance-bar{background:#edf3fb}body.theme-light .journal-cumulative-chart{color:#6b7f95}body.theme-light .journal-cumulative-line{stroke:#5d79ff}body.theme-light .journal-cumulative-point{stroke:#fff}body.theme-light .journal-performance-summary{padding:22px 24px 18px}body.theme-light .range-panel summary:hover,body.theme-light .range-panel summary:focus-visible{background:#eef4fb;box-shadow:inset 0 0 0 1px #c7d5e6}body.theme-light .range-category-panel{background:linear-gradient(180deg,#ffffff,#f5f8fc);border-color:#d4deea;box-shadow:0 14px 28px rgba(65,88,116,.09)}body.theme-light .range-category-summary{background:linear-gradient(135deg,#ffffff,#f6f9fd)}body.theme-light .range-category-summary:hover,body.theme-light .range-category-summary:focus-visible{background:linear-gradient(135deg,#f7faff,#edf4fb);box-shadow:inset 0 0 0 1px #c7d5e6}body.theme-light .range-category-panel[open] .range-category-summary{border-bottom-color:#d4deea}body.theme-light .range-category-count{background:rgba(23,132,99,.08);border-color:rgba(23,132,99,.18);color:#178463}body.theme-light .range-category-summary .range-summary-metrics>span{background:rgba(237,243,251,.94);border-color:#d4deea;color:#466078}body.theme-light .range-category-toggle{color:#17314f}body.theme-light .calendar-day-empty{background:transparent;border-color:#cfd8e4}body.theme-light .calendar-day-win{background:rgba(81,226,176,.12);border-color:rgba(81,226,176,.4)}body.theme-light .calendar-day-loss{background:rgba(255,130,144,.12);border-color:rgba(255,130,144,.38)}body.theme-light .calendar-day-has-details:hover,body.theme-light .calendar-day-has-details:focus-visible{background:#f6f9fd;border-color:#adc1d7}body.theme-light .calendar-day-win.calendar-day-has-details:hover,body.theme-light .calendar-day-win.calendar-day-has-details:focus-visible{background:rgba(81,226,176,.18);border-color:rgba(81,226,176,.52)}body.theme-light .calendar-day-loss.calendar-day-has-details:hover,body.theme-light .calendar-day-loss.calendar-day-has-details:focus-visible{background:rgba(255,130,144,.18);border-color:rgba(255,130,144,.5)}body.theme-light .calendar-day-date,body.theme-light .metric-line strong,body.theme-light .empty-state strong,body.theme-light .account-card h3,body.theme-light .login-brand-copy strong,body.theme-light .login-card h2,body.theme-light .range-category-title-row h2{color:#142132}body.theme-light .calendar-day-meta,body.theme-light .metric-line,body.theme-light .account-data span,body.theme-light .settings-panel p,body.theme-light .range-summary-row p,body.theme-light .range-summary-metrics,body.theme-light .range-current-card span,body.theme-light .calendar-weekdays span,body.theme-light .section-heading p,body.theme-light .journal-spotlight-header p,body.theme-light .journal-kpi-subgrid span,body.theme-light .journal-kpi-chart-stats span{color:#5f7288}body.theme-light .outline-button,body.theme-light .sign-out button{background:#edf3fb;color:#17314f;border-color:#c7d5e6}body.theme-light .outline-button:hover,body.theme-light .outline-button:focus-visible{background:#e4edf8;border-color:#9fb7d5}body.theme-light .calendar-day-hovercard{background:#fff;border-color:#c7d5e6;box-shadow:0 16px 36px rgba(55,78,107,.18)}body.theme-light .calendar-day-hovercard-title{color:#315f93}body.theme-light .calendar-day-hovercard-list strong{color:#142132}body.theme-light .calendar-day-hovercard-list span{color:#4f647d}body.theme-light .range-comparison-panel{background:linear-gradient(180deg,#ffffff,#f4f7fb);border-color:transparent;box-shadow:none}body.theme-light .range-leaders-panel{background:linear-gradient(160deg,#ffffff,#f3f7fc);border-color:#d4deea;box-shadow:0 14px 30px rgba(65,88,116,.1)}body.theme-light .range-leaders-pill{background:#edf3fb;border-color:#d4deea;color:#466078}body.theme-light .range-leaders-pill-positive{background:rgba(23,132,99,.08);border-color:rgba(23,132,99,.18);color:#178463}body.theme-light .range-leaders-pill-negative{background:rgba(217,71,91,.08);border-color:rgba(217,71,91,.18);color:#c04859}body.theme-light .range-leaders-chart{color:#6b7f95}body.theme-light .range-leaders-axis-top,body.theme-light .range-leaders-axis-bottom{stroke:rgba(123,141,163,.18)}body.theme-light .range-leaders-axis-mid{stroke:rgba(123,141,163,.28)}body.theme-light .range-leader-label{fill:#142132}body.theme-light .range-leader-meta,body.theme-light .range-comparison-header p,body.theme-light .range-comparison-legend,body.theme-light .range-comparison-head,body.theme-light .range-comparison-label span,body.theme-light .range-net-caption,body.theme-light .range-net-card small{color:#61758d;fill:#61758d}body.theme-light .range-comparison-label strong,body.theme-light .range-net-card strong{color:#142132}body.theme-light .range-comparison-row{background:rgba(240,245,251,.92);border-color:transparent;box-shadow:none}body.theme-light .trade-mix-track{background:#edf3fb;box-shadow:none}body.theme-light .trade-mix-count{background:transparent;border-color:transparent;color:#17314f}body.theme-light .range-net-card{background:rgba(255,255,255,.92);border-color:transparent}body.theme-light.login-page{background:linear-gradient(135deg,#f6f9fd 0%,#eef4fb 54%,#f9fbfe 100%)}body.theme-light .login-points li,body.theme-light .login-card{background:rgba(255,255,255,.92);border-color:#d6e0eb;box-shadow:0 24px 64px rgba(65,88,116,.12)}body.theme-light .login-form input{background:#fff;border-color:#c7d5e6;color:#142132}body.theme-light .login-copy,body.theme-light .login-brand-copy span,body.theme-light .login-card p,body.theme-light .login-footnote,body.theme-light .login-points span{color:#607286}body.theme-light .login-kicker{color:#178463}
body.theme-light .range-reassign-form label,body.theme-light .range-reassign-dialog p,body.theme-light .range-reassign-dialog dt{color:#5f7288}body.theme-light .range-reassign-dialog{background:#fff;color:#142132;border-color:#d4deea;box-shadow:0 24px 64px rgba(65,88,116,.18)}
body.theme-light .range-leaders-panel{background:linear-gradient(160deg,#ffffff,#f3f7fc)!important;border:0!important;box-shadow:none!important}body.theme-light .range-leaders-toggle,body.theme-light .range-day-spotlight-toggle,body.theme-light .range-day-category-option{background:#edf3fb;border-color:#d4deea;color:#466078}body.theme-light .range-day-category-form{background:#f7faff;border-color:#d4deea}body.theme-light .range-day-category-form-header strong{color:#466078}body.theme-light .range-day-schedule-countdown{color:#61758d}body.theme-light .range-day-schedule-countdown-value{color:#142132}body.theme-light .range-day-completed-section h3,body.theme-light .range-day-completed-item,body.theme-light .range-day-completed-name,body.theme-light .range-day-completed-time,body.theme-light .range-leaders-axis-row,body.theme-light .range-leader-copy span,body.theme-light .range-leader-values span{color:#61758d}body.theme-light .range-leader-copy strong{color:#142132}body.theme-light .range-leader-track{background:#edf3fb}body.theme-light .range-leader-track-axis{background:rgba(123,141,163,.3)}
    .range-day-schedule-card{border-color:rgba(96,122,154,.48)}.range-day-schedule-meta span{color:#c6d2df;font-weight:600}.range-day-schedule-description{color:#d3deea}.range-day-schedule-countdown[data-range-imminent="true"] .range-day-schedule-countdown-value{color:#ffe3e8}.calendar-day-summary{display:grid;gap:6px}.calendar-day-detail-stack{display:grid;gap:3px}.calendar-day-meta{line-height:1.25}.calendar-day-open-hint{margin-top:2px;color:#bdd9ff;font-weight:700}.calendar-day-clickable:focus-visible,.calendar-day-clickable:hover{box-shadow:inset 0 0 0 1px rgba(90,150,255,.34)}body.theme-light .range-day-schedule-card{border-color:#b8c9dd}body.theme-light .range-day-schedule-meta span{color:#466078}body.theme-light .range-day-schedule-description{color:#40566f}body.theme-light .calendar-day-open-hint{color:#2459c6}@media(max-width:900px){.settings-grid{grid-template-columns:1fr}}
@media(max-width:1180px){.journal-kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.journal-spotlight-grid{grid-template-columns:1fr}}@media(max-width:1150px){.journal-top{display:grid;gap:14px}.top-actions{width:100%;justify-content:flex-start!important;flex-wrap:wrap!important}.top-actions .period-chip{flex:0 1 auto!important}.top-actions .period-chip-forex{flex:1 1 320px!important;min-width:min(100%,260px)}.calendar-grid.calendar-weekdays{display:none}.calendar-panel>.calendar-grid:not(.calendar-weekdays){grid-template-columns:1fr}.calendar-day-empty{display:none}}@media(max-width:800px){.journal-kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.journal-kpi-chart-row,.journal-mix-layout{grid-template-columns:1fr}.journal-ring-chart{margin:0 auto}.journal-spotlight-stat{text-align:left}.calendar-panel-hovercards-enhanced .calendar-day-hovercard{width:min(420px,calc(100vw - 32px))}.calendar-panel-hovercards-enhanced .calendar-day-hovercard-list{grid-template-columns:1fr}}@media(max-width:620px){.calendar-day-hovercard{position:static;opacity:1;pointer-events:auto;transform:none;margin-top:8px}.journal-kpi-grid,.journal-kpi-subgrid,.journal-mix-stats{grid-template-columns:1fr}.journal-kpi-card,.journal-spotlight-card{padding:16px}}
@media(max-width:620px){.range-leaders-summary{padding:16px 16px 10px}.range-leaders-body{padding:0 16px 16px}.range-leaders-header-actions{width:100%;justify-content:flex-start}.range-leaders-toggle{width:100%;justify-content:center}.range-leaders-axis-row,.range-leader-row{grid-template-columns:1fr}.range-leaders-axis-row span:nth-child(1),.range-leaders-axis-row span:nth-child(2),.range-leaders-axis-row span:nth-child(3),.range-leader-values{text-align:left}}
@media(max-width:900px){.journal-day-page-header{align-items:stretch}.journal-day-range-card{display:grid}.journal-day-trade-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.range-day-schedule-card{grid-template-columns:1fr}.range-day-schedule-meta,.range-day-schedule-countdown{justify-self:start}}
@media(max-width:620px){.calendar-day-hovercard,.calendar-panel-hovercards-enhanced .calendar-day-hovercard{display:none!important}.calendar-day-open-hint{margin-top:2px}.journal-day-trade-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.range-day-schedule-meta{flex-wrap:wrap}.range-day-schedule-countdown{white-space:normal}.range-day-schedule-card{gap:10px}}
.range-config-form,.range-enroll-form{gap:10px 12px!important;margin-top:8px!important}.section-heading{margin-bottom:10px!important}.range-run-days-editor{gap:8px!important}
.range-panel summary,.range-category-summary{transition:background-color .16s ease,box-shadow .16s ease,border-color .16s ease,opacity .16s ease!important}.range-panel:not([open]) summary,.range-category-panel:not([open]) .range-category-summary{opacity:.64}.range-panel:not([open]) summary:hover,.range-panel:not([open]) summary:focus-visible,.range-category-panel:not([open]) .range-category-summary:hover,.range-category-panel:not([open]) .range-category-summary:focus-visible{opacity:.82}
`;
  const script = `
const updateDirtyForms = () => {
  for (const form of document.querySelectorAll('form[data-dirty-form="true"]')) {
    if (!(form instanceof HTMLFormElement)) continue;
    const linkedControls = form.id
      ? Array.from(document.querySelectorAll('[form]'))
        .filter((control) => control instanceof HTMLElement && control.getAttribute('form') === form.id)
      : [];
    const submits = [
      ...Array.from(form.querySelectorAll('[data-dirty-submit]')),
      ...linkedControls.filter((control) => control instanceof HTMLElement && control.hasAttribute('data-dirty-submit')),
    ].filter((control) => control instanceof HTMLElement);
    if (!submits.length) continue;
    const snapshot = () => Array.from(new FormData(form).entries())
      .filter(([key]) => key !== 'csrfToken')
      .map(([key, value]) => key + ':' + (typeof value === 'string' ? value : '[file]'))
      .join('\\u001f');
    const initial = snapshot();
    const sync = () => {
      const isDirty = snapshot() !== initial;
      for (const submit of submits) {
        submit.classList.toggle('dirty-submit-hidden', !isDirty);
      }
    };
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    for (const control of linkedControls) {
      control.addEventListener('input', sync);
      control.addEventListener('change', sync);
    }
    sync();
  }
};

const initializePersistedRangeDetails = () => {
  const detailsList = Array.from(document.querySelectorAll('details[data-range-persist-key]'))
    .filter((detail) => detail instanceof HTMLDetailsElement);
  if (!detailsList.length) return;
  const storageKey = 'bridge-ledger:ranges:details';
  const accordionStorageKey = 'bridge-ledger:ranges:accordions';
  const readObject = (key) => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  const writeObject = (key, state) => {
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {}
  };
  const state = readObject(storageKey);
  const accordionState = readObject(accordionStorageKey);
  const accordionGroups = new Map();
  for (const detail of detailsList) {
    const accordionGroup = detail.dataset.rangeAccordionGroup;
    if (!accordionGroup) continue;
    const group = accordionGroups.get(accordionGroup) ?? [];
    group.push(detail);
    accordionGroups.set(accordionGroup, group);
  }
  for (const detail of detailsList) {
    if (detail.dataset.rangeAccordionGroup) continue;
    const key = detail.dataset.rangePersistKey;
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(state, key)) detail.open = Boolean(state[key]);
    detail.addEventListener('toggle', () => {
      state[key] = detail.open;
      writeObject(storageKey, state);
    });
  }
  for (const [groupName, groupDetails] of accordionGroups) {
    let syncing = false;
    const detailsByKey = new Map(groupDetails.map((detail) => [detail.dataset.rangePersistKey, detail]));
    const writeAccordionState = (activeKey) => {
      accordionState[groupName] = activeKey ?? '';
      writeObject(accordionStorageKey, accordionState);
    };
    const clearActive = () => {
      syncing = true;
      for (const detail of groupDetails) {
        detail.open = false;
      }
      syncing = false;
      writeAccordionState(null);
    };
    const setActive = (activeKey) => {
      syncing = true;
      for (const detail of groupDetails) {
        detail.open = detail.dataset.rangePersistKey === activeKey;
      }
      syncing = false;
      writeAccordionState(activeKey);
    };
    const storedKey = typeof accordionState[groupName] === 'string' ? accordionState[groupName] : '';
    const migratedKey = groupDetails.find((detail) => {
      const key = detail.dataset.rangePersistKey;
      return key && Boolean(state[key]);
    })?.dataset.rangePersistKey;
    const initialKey = (storedKey && detailsByKey.has(storedKey))
      ? storedKey
      : migratedKey
        ? migratedKey
        : groupDetails.find((detail) => detail.open)?.dataset.rangePersistKey;
    if (initialKey) setActive(initialKey);
    else writeAccordionState(null);
    for (const detail of groupDetails) {
      const key = detail.dataset.rangePersistKey;
      if (!key) continue;
      const summary = detail.querySelector('summary');
      if (summary instanceof HTMLElement) {
        summary.addEventListener('click', (event) => {
          if (
            event.target instanceof Element
            && event.target.closest('a,button,input,select,textarea,label,form')
          ) return;
          event.preventDefault();
          if (detail.open) {
            clearActive();
            return;
          }
          setActive(key);
        });
      }
      detail.addEventListener('toggle', () => {
        if (syncing) return;
        if (detail.open) {
          setActive(key);
          return;
        }
        window.requestAnimationFrame(() => {
          if (syncing) return;
          if (groupDetails.some((entry) => entry.open)) return;
          writeAccordionState(null);
        });
      });
    }
  }
};

const initializePersistedFilterForms = () => {
  const forms = Array.from(document.querySelectorAll('form[data-filter-persist-key]'))
    .filter((form) => form instanceof HTMLFormElement);
  for (const form of forms) {
    const persistKey = form.dataset.filterPersistKey;
    const trackedNames = (form.dataset.filterPersistNames ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (!persistKey || !trackedNames.length) continue;
    const storageKey = 'bridge-ledger:filters:' + persistKey;
    const controls = trackedNames.flatMap((name) => (
      Array.from(form.elements).filter((element) => (
        (element instanceof HTMLInputElement
          || element instanceof HTMLSelectElement
          || element instanceof HTMLTextAreaElement)
        && element.name === name
        && element.type !== 'hidden'
      ))
    ));
    if (!controls.length) continue;
    const groups = trackedNames.map((name) => [name, controls.filter((control) => control.name === name)]).filter(([, group]) => group.length > 0);
    const snapshot = () => Object.fromEntries(groups.map(([name, group]) => {
      const checkboxGroup = group.every((control) => control instanceof HTMLInputElement && control.type === 'checkbox');
      if (checkboxGroup) {
        return [name, group
          .filter((control) => control instanceof HTMLInputElement && control.checked)
          .map((control) => control.value)];
      }
      return [name, group[0]?.value ?? ''];
    }));
    const writeState = () => {
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(snapshot()));
      } catch {}
    };
    const currentParams = new URLSearchParams(window.location.search);
    if (!trackedNames.some((name) => currentParams.has(name))) {
      try {
        const raw = window.localStorage.getItem(storageKey);
        const storedState = raw ? JSON.parse(raw) : null;
        if (storedState && typeof storedState === 'object') {
          let changed = false;
          for (const [name, group] of groups) {
            const storedValue = storedState[name];
            const checkboxGroup = group.every((control) => control instanceof HTMLInputElement && control.type === 'checkbox');
            if (checkboxGroup) {
              const selectedValues = Array.isArray(storedValue)
                ? storedValue.filter((entry) => typeof entry === 'string')
                : typeof storedValue === 'string' && storedValue.length > 0
                  ? [storedValue]
                  : [];
              for (const control of group) {
                if (!(control instanceof HTMLInputElement)) continue;
                const shouldCheck = selectedValues.includes(control.value);
                if (control.checked === shouldCheck) continue;
                control.checked = shouldCheck;
                changed = true;
              }
              continue;
            }
            if (typeof storedValue !== 'string') continue;
            const control = group[0];
            if (!control || control.value === storedValue) continue;
            control.value = storedValue;
            changed = true;
          }
          if (changed) {
            const actionUrl = new URL(form.action || window.location.pathname, window.location.origin);
            const params = new URLSearchParams();
            for (const [key, value] of new FormData(form).entries()) {
              if (typeof value === 'string' && value.length > 0) params.append(key, value);
            }
            actionUrl.search = params.toString();
            const nextLocation = actionUrl.pathname + actionUrl.search;
            const currentLocation = window.location.pathname + window.location.search;
            if (nextLocation !== currentLocation) {
              window.location.replace(nextLocation);
              return;
            }
          }
        }
      } catch {}
    }
    form.addEventListener('change', writeState);
    form.addEventListener('input', writeState);
    form.addEventListener('submit', writeState);
  }
};

const initializeRangeReassignDialog = () => {
  const dialog = document.getElementById('range-reassign-dialog');
  if (!(dialog instanceof HTMLDialogElement)) return;
  const sourceValue = dialog.querySelector('[data-range-reassign-source]');
  const targetValue = dialog.querySelector('[data-range-reassign-target]');
  const confirmButton = dialog.querySelector('[data-range-reassign-confirm]');
  const cancelButton = dialog.querySelector('[data-range-reassign-cancel]');
  let pendingForm;
  const closeDialog = () => {
    pendingForm = undefined;
    dialog.close();
  };
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const trigger = target.closest('[data-range-reassign-trigger]');
    if (!(trigger instanceof HTMLButtonElement)) return;
    const form = trigger.closest('form');
    if (!(form instanceof HTMLFormElement)) return;
    const select = form.querySelector('select[name="targetRangeName"]');
    const source = form.querySelector('input[name="sourceRangeName"]');
    if (!(select instanceof HTMLSelectElement) || !(source instanceof HTMLInputElement) || !select.value) return;
    pendingForm = form;
    if (sourceValue) sourceValue.textContent = source.value;
    if (targetValue) targetValue.textContent = select.value;
    dialog.showModal();
  });
  if (confirmButton instanceof HTMLButtonElement) {
    confirmButton.addEventListener('click', () => {
      if (!pendingForm) return;
      const form = pendingForm;
      pendingForm = undefined;
      dialog.close();
      form.requestSubmit();
    });
  }
  if (cancelButton instanceof HTMLButtonElement) {
    cancelButton.addEventListener('click', closeDialog);
  }
  dialog.addEventListener('cancel', () => {
    pendingForm = undefined;
  });
};

const initializeTradersPostDestinationForm = () => {
  const form = document.querySelector('form[data-traderspost-destination-form="true"]');
  if (!(form instanceof HTMLFormElement)) return;
  const accountSelect = form.querySelector('select[name="accountId"]');
  const webhookInput = form.querySelector('input[name="webhookUrl"]');
  const overrideModeSelect = form.querySelector('select[name="outboundTickerMode"]');
  const outboundTickerInput = form.querySelector('input[name="outboundTicker"]');
  if (
    !(accountSelect instanceof HTMLSelectElement)
    || !(webhookInput instanceof HTMLInputElement)
    || !(overrideModeSelect instanceof HTMLSelectElement)
    || !(outboundTickerInput instanceof HTMLInputElement)
  ) return;
  let configByAccount = {};
  try {
    const raw = form.dataset.traderspostDestinationConfig;
    const parsed = raw ? JSON.parse(raw) : {};
    configByAccount = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    configByAccount = {};
  }
  const sync = () => {
    const config = configByAccount[accountSelect.value];
    if (!config || typeof config !== 'object') {
      webhookInput.value = '';
      overrideModeSelect.value = 'none';
      outboundTickerInput.value = '';
      return;
    }
    webhookInput.value = typeof config.webhookUrl === 'string' ? config.webhookUrl : '';
    overrideModeSelect.value = config.outboundTickerMode === 'micros_only' || config.outboundTickerMode === 'exact'
      ? config.outboundTickerMode
      : 'none';
    outboundTickerInput.value = typeof config.outboundTicker === 'string' ? config.outboundTicker : '';
  };
  accountSelect.addEventListener('change', sync);
  sync();
};

const initializeCalendarDayHovercards = () => {
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  const hovercardDays = Array.from(document.querySelectorAll('.calendar-day-has-details'))
    .filter((day) => day instanceof HTMLElement);
  for (const day of hovercardDays) {
    let activateTimeout;
    const activate = () => {
      day.dataset.hovercardActive = 'true';
    };
    const clearActivation = () => {
      if (activateTimeout != null) {
        window.clearTimeout(activateTimeout);
        activateTimeout = undefined;
      }
    };
    const deactivate = () => {
      clearActivation();
      delete day.dataset.hovercardActive;
    };
    day.addEventListener('mouseenter', () => {
      clearActivation();
      activateTimeout = window.setTimeout(activate, 500);
    });
    day.addEventListener('mouseleave', deactivate);
  }
};

const initializeCalendarDayLinks = () => {
  const clickableDays = Array.from(document.querySelectorAll('.calendar-day-has-details[data-day-url]'))
    .filter((day) => day instanceof HTMLElement);
  for (const day of clickableDays) {
    const openDay = () => {
      const url = day.dataset.dayUrl;
      if (!url) return;
      window.open(url, day.dataset.dayTarget || '_self', 'noopener');
    };
    day.addEventListener('click', (event) => {
      if (
        event.target instanceof Element
        && event.target.closest('a,button,input,select,textarea,summary,form,label')
      ) return;
      openDay();
    });
    day.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openDay();
    });
  }
};

const initializeRangeDayScheduleCards = () => {
  const spotlight = document.querySelector('.range-day-spotlight');
  const cards = Array.from(document.querySelectorAll('[data-range-day-entry="true"]'))
    .filter((card) => card instanceof HTMLElement);
  if (!(spotlight instanceof HTMLElement)) return;
  const openRangeTarget = (card) => {
    const categoryId = card.dataset.rangeCategoryId;
    const panelId = card.dataset.rangePanelId;
    const category = categoryId ? document.getElementById(categoryId) : null;
    const panel = panelId ? document.getElementById(panelId) : null;
    if (category instanceof HTMLDetailsElement) {
      const categories = Array.from(document.querySelectorAll('details[data-range-accordion-group="category"]'))
        .filter((detail) => detail instanceof HTMLDetailsElement);
      for (const entry of categories) {
        entry.open = entry === category;
      }
    }
    if (panel instanceof HTMLDetailsElement) {
      const accordionGroup = panel.dataset.rangeAccordionGroup;
      if (accordionGroup) {
        const siblings = Array.from(document.querySelectorAll('details[data-range-accordion-group]'))
          .filter((detail) => (
            detail instanceof HTMLDetailsElement
            && detail.dataset.rangeAccordionGroup === accordionGroup
          ));
        for (const entry of siblings) {
          entry.open = entry === panel;
        }
      } else {
        panel.open = true;
      }
    }
    const target = panel instanceof HTMLElement ? panel : category instanceof HTMLElement ? category : null;
    if (!target) return;
    if (target.id) history.replaceState(null, '', '#' + target.id);
    window.requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  for (const card of cards) {
    if (card.dataset.rangeJumpBound === 'true') continue;
    card.dataset.rangeJumpBound = 'true';
    card.addEventListener('click', (event) => {
      event.preventDefault();
      openRangeTarget(card);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openRangeTarget(card);
    });
  }
  const nextLabel = spotlight.querySelector('[data-range-day-next]');
  const completedSection = spotlight.querySelector('[data-range-completed-section]');
  const completedList = spotlight.querySelector('[data-range-completed-list]');
  const formatDuration = (milliseconds) => {
    const totalMinutes = Math.max(0, Math.round(Math.abs(milliseconds) / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? String(hours) + 'h ' + String(minutes) + 'm' : String(minutes) + 'm';
  };
  const highlightIntensity = (remainingMs) => {
    const highlightWindowMs = 60 * 60000;
    if (remainingMs > highlightWindowMs) return 0;
    return Math.max(0.12, Math.min(1, 1 - (remainingMs / highlightWindowMs)));
  };
  const describeState = (startAt, endAt) => {
    const now = Date.now();
    const remainingMs = endAt - now;
    if (now < startAt) {
      const countdownValue = formatDuration(remainingMs);
      return {
        countdown: 'Range will be active in ' + countdownValue,
        countdownLabel: 'Range will be active in',
        countdownValue,
        status: 'Scheduled',
        intensity: highlightIntensity(remainingMs),
        state: 'upcoming',
        imminent: remainingMs <= 15 * 60000,
      };
    }
    if (now <= endAt) {
      const countdownValue = formatDuration(remainingMs);
      return {
        countdown: 'Range will be active in ' + countdownValue,
        countdownLabel: 'Range will be active in',
        countdownValue,
        status: 'Live now',
        intensity: highlightIntensity(remainingMs),
        state: 'active',
        imminent: remainingMs <= 15 * 60000,
      };
    }
    const countdownValue = formatDuration(now - endAt) + ' ago';
    return {
      countdown: countdownValue,
      countdownLabel: '',
      countdownValue,
      status: 'Completed',
      intensity: 0.18,
      state: 'complete',
      imminent: false,
    };
  };
  const appendCompletedItem = (rangeName, startLabel) => {
    if (!(completedList instanceof HTMLElement) || !rangeName || !startLabel) return;
    const key = rangeName + '|' + startLabel;
    const existing = Array.from(completedList.querySelectorAll('[data-range-completed-key]'))
      .find((item) => item instanceof HTMLElement && item.dataset.rangeCompletedKey === key);
    if (existing) return;
    const item = document.createElement('li');
    item.className = 'range-day-completed-item';
    item.dataset.rangeCompletedKey = key;
    const name = document.createElement('span');
    name.className = 'range-day-completed-name';
    name.textContent = rangeName;
    const meta = document.createElement('span');
    meta.className = 'range-day-completed-time';
    meta.textContent = 'Fired ' + startLabel;
    item.append(name, meta);
    completedList.append(item);
  };
  const update = () => {
    for (const card of cards) {
      const startAt = Number(card.dataset.startAt);
      const endAt = Number(card.dataset.endAt);
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) continue;
      const countdown = card.querySelector('[data-range-countdown]');
      const countdownLabel = card.querySelector('[data-range-countdown-label]');
      const countdownValue = card.querySelector('[data-range-countdown-value]');
      const status = card.querySelector('[data-range-status]');
      const nextState = describeState(startAt, endAt);
      card.dataset.rangeState = nextState.state;
      card.hidden = nextState.state === 'complete';
      if (nextState.state === 'complete') appendCompletedItem(card.dataset.rangeName ?? '', card.dataset.rangeStartLabel ?? '');
      card.style.setProperty('--range-day-intensity', nextState.intensity.toFixed(2));
      if (countdown instanceof HTMLElement) {
        countdown.dataset.rangeImminent = nextState.imminent ? 'true' : 'false';
      }
      if (countdownLabel instanceof HTMLElement) countdownLabel.textContent = nextState.countdownLabel;
      if (countdownValue instanceof HTMLElement) countdownValue.textContent = nextState.countdownValue;
      if (status instanceof HTMLElement) status.textContent = nextState.status;
    }
    const visibleCards = cards.filter((card) => !card.hidden);
    if (completedSection instanceof HTMLElement && completedList instanceof HTMLElement) {
      completedSection.hidden = completedList.children.length === 0;
    }
    if (nextLabel instanceof HTMLElement) {
      const leadCard = visibleCards[0];
      if (!leadCard) {
        nextLabel.textContent = 'All configured ranges for today have already fired.';
      } else {
        const leadStartAt = Number(leadCard.dataset.startAt);
        const leadEndAt = Number(leadCard.dataset.endAt);
        const leadState = Number.isFinite(leadStartAt) && Number.isFinite(leadEndAt)
          ? describeState(leadStartAt, leadEndAt)
          : null;
        const leadName = leadCard.dataset.rangeName;
        nextLabel.textContent = leadName && leadState
          ? 'Next Range: ' + leadName + ' in ' + leadState.countdownValue
          : leadState
            ? 'Next Range in ' + leadState.countdownValue
            : '';
      }
    }
  };
  update();
  window.setInterval(update, 30000);
};

const initializeRangeDayCategoryFilter = () => {
  const forms = Array.from(document.querySelectorAll('[data-range-day-category-filter="true"]'))
    .filter((form) => form instanceof HTMLFormElement);
  for (const form of forms) {
    const checkboxes = Array.from(form.querySelectorAll('input[name="scheduleCategory"]'))
      .filter((input) => input instanceof HTMLInputElement && input.type === 'checkbox');
    const selectAll = form.querySelector('[data-range-schedule-select-all]');
    const selectNone = form.querySelector('[data-range-schedule-select-none]');
    if (selectAll instanceof HTMLButtonElement) {
      selectAll.addEventListener('click', () => {
        for (const checkbox of checkboxes) checkbox.checked = true;
      });
    }
    if (selectNone instanceof HTMLButtonElement) {
      selectNone.addEventListener('click', () => {
        for (const checkbox of checkboxes) checkbox.checked = false;
      });
    }
  }
};

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.dataset.asyncSubmit !== 'true') return;
  event.preventDefault();
  if (form.dataset.submitting === 'true') return;
  form.dataset.submitting = 'true';
  form.setAttribute('aria-busy', 'true');
  const payload = new URLSearchParams();
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === 'string') payload.append(key, value);
  }
  fetch(form.action, {
    method: (form.method || 'post').toUpperCase(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-requested-with': 'fetch',
    },
    body: payload.toString(),
  })
    .then((response) => {
      if (!response.ok) throw new Error('Request failed');
    })
    .catch(() => {
      window.location.assign(window.location.href);
    })
    .finally(() => {
      delete form.dataset.submitting;
      form.removeAttribute('aria-busy');
    });
});

const escapeHtmlClient = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const updatePendingRangeRoutes = (form) => {
  const container = form.querySelector('.pending-range-routes');
  const submit = form.querySelector('button[type="submit"]');
  if (!container) return;
  const checkboxes = Array.from(form.querySelectorAll('input[type="checkbox"]'));
  const pending = [];
  for (const checkbox of checkboxes) {
    if (checkbox.checked === checkbox.defaultChecked) continue;
    const row = checkbox.closest('tr');
    const accountName = row?.querySelector('td')?.textContent?.trim() ?? 'Unknown';
    const service = checkbox.name === 'extensionAccountIds' ? 'Extension' : 'TradersPost';
    const action = checkbox.checked ? 'Enable' : 'Disable';
    pending.push({ checkbox, accountName, service, action });
  }
  if (pending.length === 0) {
    container.innerHTML = '';
    if (submit) submit.hidden = true;
    return;
  }
  const listItems = pending.map((p) => {
    const label = p.action + ' ' + p.service + ' for ' + p.accountName;
    return '<li style="margin:.25rem 0;">' + escapeHtmlClient(label) + ' <button type="button" class="outline-button" style="margin-left:.5rem;" onclick="undoPendingRangeRoute(this)" data-undo-name="' + escapeHtmlClient(p.checkbox.name) + '" data-undo-value="' + escapeHtmlClient(p.checkbox.value) + '">Undo</button></li>';
  }).join('');
  container.innerHTML = '<p class="muted">Pending changes</p><ul style="margin:0;padding-left:1.2rem;">' + listItems + '</ul>';
  if (submit) submit.hidden = false;
};

const undoPendingRangeRoute = (button) => {
  const form = button.form;
  if (!form) return;
  const name = button.dataset.undoName;
  const value = button.dataset.undoValue;
  if (!name || !value) return;
  const checkbox = form.querySelector('input[type="checkbox"][name="' + name + '"][value="' + value + '"]');
  if (checkbox) {
    checkbox.checked = checkbox.defaultChecked;
    updatePendingRangeRoutes(form);
  }
};

window.undoPendingRangeRoute = undoPendingRangeRoute;

window.updatePendingRangeRoute = (checkbox) => {
  const form = checkbox.form;
  if (form) updatePendingRangeRoutes(form);
};

for (const form of document.querySelectorAll('form[data-batch-range-routes]')) {
  updatePendingRangeRoutes(form);
}

const parseRangeRouteQueue = (form) => {
  const input = form.querySelector('input[name="rangeRoutesJson"]');
  if (!input) return [];
  try {
    return JSON.parse(input.value || '[]');
  } catch {
    return [];
  }
};

const updateRangeRouteQueue = (form, queue) => {
  const input = form.querySelector('input[name="rangeRoutesJson"]');
  const container = form.querySelector('.range-route-queue');
  const submit = form.querySelector('button[type="submit"]');
  if (input) input.value = JSON.stringify(queue);
  if (!container) return;
  if (queue.length === 0) {
    container.innerHTML = '';
    if (submit) submit.disabled = true;
    return;
  }
  const list = queue.map((entry, index) => {
    const routeSummary = entry.routes.map((r) => escapeHtmlClient(r.accountName || 'Unknown') + ' (' + (r.extensionEnabled ? 'Ext' : '') + (r.extensionEnabled && r.traderspostEnabled ? '+' : '') + (r.traderspostEnabled ? 'TP' : '') + ')').join(', ');
    return '<li style="margin:.25rem 0;"><strong>' + escapeHtmlClient(entry.rangeName) + '</strong>: ' + routeSummary + ' <button type="button" class="outline-button" style="margin-left:.5rem;" onclick="removeRangeRouteFromQueue(this)" data-index="' + index + '">Remove</button></li>';
  }).join('');
  container.innerHTML = '<p class="muted">Queued subscriptions</p><ul style="margin:0;padding-left:1.2rem;">' + list + '</ul>';
  if (submit) submit.disabled = false;
};

const addRangeRouteToQueue = (button) => {
  const form = button.form;
  if (!form) return;
  const rangeNameInput = form.querySelector('input[name="rangeName"]');
  const rangeName = rangeNameInput ? String(rangeNameInput.value).trim() : '';
  if (!rangeName) {
    window.alert('Please enter a range name.');
    return;
  }
  const getAccounts = (name) => Array.from(form.querySelectorAll('input[type="checkbox"][name="' + name + '"]:checked')).map((cb) => ({
    accountId: cb.value,
    accountName: (cb.closest('tr')?.querySelector('td')?.textContent?.trim() || 'Unknown'),
  }));
  const ext = getAccounts('extensionAccountIds');
  const tp = getAccounts('traderspostAccountIds');
  const routeMap = new Map();
  for (const a of ext) {
    routeMap.set(a.accountId, { accountId: a.accountId, accountName: a.accountName, extensionEnabled: true, traderspostEnabled: false });
  }
  for (const a of tp) {
    const existing = routeMap.get(a.accountId);
    if (existing) {
      existing.traderspostEnabled = true;
    } else {
      routeMap.set(a.accountId, { accountId: a.accountId, accountName: a.accountName, extensionEnabled: false, traderspostEnabled: true });
    }
  }
  if (routeMap.size === 0) {
    window.alert('Please select at least one account.');
    return;
  }
  const queue = parseRangeRouteQueue(form);
  queue.push({ rangeName, routes: Array.from(routeMap.values()) });
  updateRangeRouteQueue(form, queue);
  if (rangeNameInput) rangeNameInput.value = '';
  for (const cb of form.querySelectorAll('input[type="checkbox"]')) {
    cb.checked = cb.defaultChecked;
  }
};

const removeRangeRouteFromQueue = (button) => {
  const form = button.form;
  if (!form) return;
  const index = Number(button.dataset.index);
  const queue = parseRangeRouteQueue(form);
  queue.splice(index, 1);
  updateRangeRouteQueue(form, queue);
};

window.addRangeRouteToQueue = addRangeRouteToQueue;
window.removeRangeRouteFromQueue = removeRangeRouteFromQueue;

updateDirtyForms();
initializePersistedRangeDetails();
initializePersistedFilterForms();
initializeRangeReassignDialog();
initializeTradersPostDestinationForm();
initializeCalendarDayLinks();
initializeCalendarDayHovercards();
initializeRangeDayScheduleCards();
initializeRangeDayCategoryFilter();
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>${css}${enhancementsCss}</style></head><body class="${escapeHtml(`${bodyClass} theme-${theme}`.trim())}">${content}<script>${script}</script></body></html>`;
}

function proxyDeliveryResponse(delivery: {
  id: string;
  rangeRouteId: string;
  status: ProxyDeliveryStatus;
  draftId?: string;
}) {
  return {
    deliveryId: delivery.id,
    routeId: delivery.rangeRouteId,
    status: delivery.status,
    ...(delivery.draftId ? { draftId: delivery.draftId } : {}),
  };
}

function notificationTestDraft(userId: string) {
  return {
    userId,
    idempotencyKey: `notification-test-${randomUUID()}`,
    ticker: 'MNQU6',
    action: 'buy' as const,
    quantity: 2,
    orderType: 'stop' as const,
    signalPrice: 29110.5,
    stopPrice: 29110.5,
    takeProfit: { limitPrice: 29300.25 },
    stopLoss: { type: 'stop' as const, stopPrice: 28920 },
    bracketId: `test-${randomUUID()}`,
    rangeName: 'Test range',
  };
}

function debuggingTradersPostTestBuy(rangeName = 'Test Range'): EntryPayload {
  const entryPrice = 28637.75;
  return {
    ticker: 'MNQ1!',
    action: 'buy',
    quantity: 1,
    quantityType: 'fixed_quantity',
    price: entryPrice,
    signalPrice: entryPrice,
    orderType: 'stop',
    stopPrice: entryPrice,
    bracketId: `debug-traderspost-${randomUUID()}`,
    bracketSide: 'long',
    time: new Date().toISOString(),
    interval: 'debug',
    takeProfit: { limitPrice: 28647.75 },
    stopLoss: { type: 'stop', stopPrice: 28627.75 },
    extras: {
      source: 'debugging_traderspost_test',
      rangeName,
    },
  };
}

function debuggingRangeSimulationPayload(input: {
  rangeName: string;
  instrument: string;
  action: 'buy' | 'sell';
  top: number;
  bottom: number;
  quantity: number;
  orderType: string;
  takeProfitDistance?: number;
  stopLossDistance?: number;
}): EntryPayload {
  const isLong = input.action === 'buy';
  const direction = isLong ? 1 : -1;
  const entryPrice = Number((isLong ? input.top : input.bottom).toFixed(2));
  const slBasePrice = input.stopLossDistance != null
    ? Number((entryPrice - direction * input.stopLossDistance).toFixed(2))
    : Number((isLong ? input.bottom : input.top).toFixed(2));
  const tpBasePrice = input.takeProfitDistance != null
    ? Number((entryPrice + direction * input.takeProfitDistance).toFixed(2))
    : Number((isLong ? input.top : input.bottom).toFixed(2));
  const timeMs = Date.now();
  const now = new Date(timeMs);
  const bracketId = `server-v5-${input.instrument}-${timeMs}-${20}`;
  return {
    ticker: input.instrument,
    action: input.action,
    quantity: input.quantity,
    quantityType: 'fixed_quantity',
    price: entryPrice,
    signalPrice: entryPrice,
    orderType: input.orderType as EntryPayload['orderType'],
    ...(input.orderType === 'stop'
      ? { stopPrice: entryPrice }
      : input.orderType === 'limit'
        ? { limitPrice: entryPrice }
        : input.orderType === 'stop_limit'
          ? { stopPrice: entryPrice, limitPrice: entryPrice }
          : {}),
    bracketId,
    bracketSide: isLong ? 'long' : 'short',
    time: now.toISOString(),
    interval: '1',
    takeProfit: { limitPrice: tpBasePrice },
    stopLoss: { type: 'stop', stopPrice: slBasePrice },
    extras: {
      source: 'debugging',
      rangeName: input.rangeName,
      strategyStopPrice: slBasePrice,
      strategyStopMode: 'intrabar',
      orderRole: 'range_bracket',
      orderLeg: 'single',
    },
  };
}

// Exit distances derived from a stored range configuration: tick counts, or
// multiplier styles measured against the range's top-bottom distance.
function rangeExitDistances(
  rangeConfiguration: RangeConfiguration | undefined,
  top: number,
  bottom: number,
  tickSize: number,
): { slDistance: number; tpDistance: number } {
  const rangeDistance = Number(Math.abs(top - bottom).toFixed(4));
  let slDistance = 0;
  let tpDistance = 0;
  if (rangeConfiguration) {
    if (rangeConfiguration.stopLossTicksCents > 0) {
      slDistance = Number((rangeConfiguration.stopLossTicksCents / 100 * tickSize).toFixed(4));
    } else if (rangeDistance > 0) {
      const slMultiplier = parseMultiplierStyle(rangeConfiguration.stopLossStyle);
      if (slMultiplier != null) {
        slDistance = Number((slMultiplier * rangeDistance).toFixed(4));
      }
    }
    if (rangeConfiguration.takeProfitStyle === 'multiplier' && slDistance > 0) {
      tpDistance = Number(((rangeConfiguration.takeProfitTicksCents / 100) * slDistance).toFixed(4));
    } else if (rangeConfiguration.takeProfitTicksCents > 0) {
      tpDistance = Number((rangeConfiguration.takeProfitTicksCents / 100 * tickSize).toFixed(4));
    } else if (rangeDistance > 0) {
      const tpMultiplier = parseMultiplierStyle(rangeConfiguration.takeProfitStyle);
      if (tpMultiplier != null) {
        tpDistance = Number((tpMultiplier * rangeDistance).toFixed(4));
      }
    }
  }
  return { slDistance, tpDistance };
}

// The real ULTRA arming sequence for a range: per side, an entry order alert
// (buy stop at the top / sell stop at the bottom) followed by its entry_armed
// lifecycle event. Fed through processProxyPayload so bookkeeping, routes, and
// dispatch all behave exactly as if Pine sent them.
function buildRangeArmAlerts(options: {
  rangeName: string;
  instrument: string;
  top: number;
  bottom: number;
  quantity: number;
  tickSize: number;
  tpDistance: number;
  slDistance: number;
  breakEvenEnabled?: boolean;
  breakEvenOffsetTicksCents?: number;
}): Array<EntryPayload | LifecyclePayload> {
  const runId = randomUUID().slice(0, 8);
  const slug = options.rangeName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const now = new Date();
  const alerts: Array<EntryPayload | LifecyclePayload> = [];
  for (const arm of [
    { side: 'long', action: 'buy', entry: options.top },
    { side: 'short', action: 'sell', entry: options.bottom },
  ] as const) {
    const direction = arm.side === 'long' ? 1 : -1;
    const tradeId = `sim-${slug}-${arm.side}-${runId}`;
    const entryPrice = Number(arm.entry.toFixed(2));
    const tpPrice = options.tpDistance > 0
      ? Number((entryPrice + direction * options.tpDistance).toFixed(2))
      : Number((arm.side === 'long' ? options.bottom : options.top).toFixed(2));
    const slPrice = options.slDistance > 0
      ? Number((entryPrice - direction * options.slDistance).toFixed(2))
      : Number((arm.side === 'long' ? options.bottom : options.top).toFixed(2));
    // The strategy's protective stop — breakeven+offset when the range config
    // defines one, otherwise the plain stop-loss level.
    const beDistance = options.breakEvenEnabled && options.breakEvenOffsetTicksCents
      ? Number((options.breakEvenOffsetTicksCents / 100 * options.tickSize).toFixed(4))
      : 0;
    const strategyStopPrice = beDistance > 0
      ? Number((entryPrice + direction * beDistance).toFixed(2))
      : slPrice;
    alerts.push({
      ticker: options.instrument,
      action: arm.action,
      quantity: options.quantity,
      quantityType: 'fixed_quantity',
      price: entryPrice,
      signalPrice: entryPrice,
      orderType: 'stop',
      stopPrice: entryPrice,
      bracketId: `${tradeId}-bracket`,
      bracketSide: arm.side,
      tradeId,
      time: now.toISOString(),
      interval: '15S',
      takeProfit: { limitPrice: tpPrice },
      stopLoss: { type: 'stop', stopPrice: slPrice },
      extras: {
        source: 'debug-simulation',
        rangeName: options.rangeName,
        strategyStopPrice,
        strategyStopMode: 'intrabar',
        orderRole: 'range_bracket',
        orderLeg: 'single',
      },
    });
    alerts.push({
      eventType: 'entry_armed',
      eventId: `${tradeId}-entry_armed-leg-0`,
      tradeId,
      ticker: options.instrument,
      side: arm.side,
      action: arm.action,
      quantity: options.quantity,
      entryPrice,
      occurredAt: now.toISOString(),
      extras: { source: 'debug-simulation', rangeName: options.rangeName },
    });
  }
  return alerts;
}

function summarizeRoutesForLog(routes: RangeRoute[]): Array<{
  routeId: string;
  accountId: string;
  userId: string;
  rangeName: string;
  extensionEnabled: boolean;
  traderspostEnabled: boolean;
}> {
  return routes.map((route) => ({
    routeId: route.id,
    accountId: route.accountId,
    userId: route.userId,
    rangeName: route.rangeName,
    extensionEnabled: route.extensionEnabled,
    traderspostEnabled: route.traderspostEnabled,
  }));
}



/* The newest NT8 book row matching a logical bracket — re-armed resends land
   as '<bracket>-a<n>' rows alongside the original filled entry, so a find()
   can return the prior cycle's order. The current arm cycle's entry is the
   most recent match; rows without a parseable time sort oldest. */
function findCtEntryRow(orders: CrossTradeOrderRow[], bracketId: string, action: string): CrossTradeOrderRow | undefined {
  return orders
    .filter((o) => matchesCtOrderId(o, bracketId, action))
    .sort((a, b) => (Date.parse(String(b.time ?? '')) || 0) - (Date.parse(String(a.time ?? '')) || 0))[0];
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Remote-push fallback for toast events when the user has no live SSE stream
// (mobile app closed). Fire-and-forget; dead tokens are pruned on
// DeviceNotRegistered receipts.
async function sendExpoPush(
  database: Database,
  userId: string,
  event: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const body = typeof data?.message === 'string' ? data.message : undefined;
  if (!body) return;
  const tokens = database.listPushTokens(userId);
  if (tokens.length === 0) return;
  const title =
    event === 'toast:error'
      ? 'Bridge error'
      : event === 'toast:warning'
        ? 'Bridge warning'
        : 'Bridge';
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          title,
          body,
          sound: 'default',
          channelId: 'bridge-alerts',
          data: { type: event === 'toast:error' ? 'error' : event === 'toast:warning' ? 'warning' : 'success' },
        })),
      ),
    });
    const receipts = (await res.json().catch(() => undefined)) as
      | { data?: Array<{ status?: string; details?: { error?: string } }> }
      | undefined;
    receipts?.data?.forEach((receipt, i) => {
      if (receipt?.details?.error === 'DeviceNotRegistered' && tokens[i]) {
        database.deletePushToken(userId, tokens[i]);
      }
    });
  } catch {}
}

export function createApp(
  database = new Database(),
  options: AppOptions = {},
) {
  const app = express();
  const userEventStreams = new Map<string, Set<Response>>();
  const emitToUser = (
    userId: string,
    event: string,
    data?: Record<string, unknown>,
  ) => {
    const streams = userEventStreams.get(userId);
    if (event.startsWith('log:') && data) {
      database.createBridgeLog(userId, String(data.category ?? 'unknown'), data);
    }
    if (!streams || streams.size === 0) {
      // No connected clients — the mobile app is closed, so fall back to
      // remote push for user-facing toast events.
      if (event.startsWith('toast:')) void sendExpoPush(database, userId, event, data);
      return;
    }
    const message = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const res of [...streams]) {
      try {
        if (!res.writableEnded) res.write(message);
      } catch {
        streams.delete(res);
      }
    }
  };
  // Every mutation path funnels through invalidateUserCache — one hook keeps
  // connected clients' journal/open-trade views in sync without polling.
  database.onUserCacheInvalidated = (userId) => emitToUser(userId, 'journal:refresh', {});
  const proxyWebhookSecret = options.proxyWebhookSecret ?? config.PROXY_WEBHOOK_SECRET;
  // Dedicated secret on purpose: the proxy secret is embedded in every
  // TradingView webhook URL, so it must not also authorize a mutation path.
  const emailIngestSecret = options.emailIngestSecret ?? config.EMAIL_INGEST_SECRET;
  const initialUserPassword = options.initialUserPassword ?? config.INITIAL_USER_PASSWORD;
  const sessionSecret = options.sessionSecret ?? config.SESSION_SECRET;
  const configuredAdminEmail = (options.adminUserEmail ?? config.ADMIN_USER_EMAIL)?.toLowerCase();
  const adminUserEmail = configuredAdminEmail ?? database.listUsers()[0]?.email;
  const authConfigured = Boolean(initialUserPassword && sessionSecret);
  const secureCookies = new URL(config.PUBLIC_BASE_URL).protocol === 'https:';
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const traderspostRateLimiter = new TradersPostRateLimiter(
    250,
    options.traderspostRateLimitTaskTimeoutMs ?? 60_000,
    Number(process.env.TP_BREAKER_THRESHOLD) || 3,
    Number(process.env.TP_BREAKER_BASE_MS) || 2_000,
    Number(process.env.TP_BREAKER_MAX_MS) || 25_000,
  );
  const forexFactoryCache = new Map<string, {
    expiresAt: number;
    payload: {
      source: 'ForexFactory';
      day: string;
      timezone: string;
      fetchedAt: string;
      events: ForexFactoryRangeResult['events'];
    };
  }>();
  const forexFactoryRangeCache = new Map<string, { expiresAt: number; payload: ForexFactoryRangeResult }>();
  let lastPublicTestAt = 0;
  let completeTestRunEndsAt = 0;
  const testUser = () => config.TEST_USER_EMAIL
    ? database.findUserByEmail(config.TEST_USER_EMAIL)
    : database.findOnlyUser();
  const resolveTestUserWithLog = (label: 'test' | 'test-complete' | 'test-win' | 'test-lose') => {
    const user = testUser();
    console.info(`[${label}] Resolved public test user`, {
      configuredTestUserEmail: config.TEST_USER_EMAIL ?? null,
      resolvedUserId: user?.id ?? null,
      resolvedUserEmail: user?.email ?? null,
    });
    return user;
  };
  app.disable('x-powered-by');
  app.use(express.json({
    limit: REQUEST_BODY_LIMIT,
    verify: (request, _response, buffer) => {
      (request as RequestWithRawBody).rawBody = buffer.toString('utf8');
    },
  }));
  app.use(express.urlencoded({ extended: false, limit: REQUEST_BODY_LIMIT }));

  // Ring of recent requests — crash forensics. Entries are pushed at request
  // START and stamped done on finish, so a request that wedges/kills the
  // process still appears (with no finishedAt). index.ts dumps this ring into
  // process_runs.context_json on managed fatal exits and snapshots it into
  // last_activity_json each heartbeat — the heartbeat snapshot is all that
  // survives a hard kill.
  const recentRequests: Array<Record<string, unknown>> = [];
  app.locals.recentRequests = recentRequests;
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    const startMemory = process.memoryUsage();
    const entry = { method: req.method, path: req.path, at: new Date().toISOString(), statusCode: undefined as number | undefined, durationMs: undefined as number | undefined };
    recentRequests.push(entry);
    if (recentRequests.length > 200) recentRequests.splice(0, recentRequests.length - 200);
    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const durationMs = Number(end - start) / 1_000_000;
      entry.statusCode = res.statusCode;
      entry.durationMs = Math.round(durationMs * 100) / 100;
      const endMemory = process.memoryUsage();
      const message = `[request] ${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(2)}ms`;
      const meta = {
        heapDelta: endMemory.heapUsed - startMemory.heapUsed,
        startHeap: startMemory.heapUsed,
        endHeap: endMemory.heapUsed,
      };
      if (res.statusCode >= 400) {
        console.error(`[request error] ${message}`, meta);
      } else {
        console.info(message, meta);
      }
    });
    next();
  });

  const getWebSession = (req: Request): WebSession | undefined => {
    if (!sessionSecret) return undefined;
    const token = readCookie(req, sessionCookieName);
    if (!token) return undefined;
    const session = database.findSession(hashSessionToken(token, sessionSecret));
    return session && {
      userId: session.user.id,
      email: session.user.email,
      csrfToken: session.csrfToken,
      tokenHash: hashSessionToken(token, sessionSecret),
    };
  };

  app.get('/app/api/session', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({
      csrfToken: session.csrfToken,
      userId: session.userId,
      email: session.email,
      isAdmin: session.email === adminUserEmail,
      devMode: process.env.NODE_ENV !== 'production',
    });
  });

  app.get('/app/api/ranges', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const now = new Date();
    const sharedRangeDetails = database.listSharedRangeDetails(now);
    // Prefetched resolver — per-name resolution fans out into several
    // multi-table UNION queries each, which made this endpoint take seconds.
    const resolveRange = database.createRangeNameResolver();
    const storedToDisplay = new Map<string, string>();
    const dedupedSharedRangeDetails = [];
    for (const range of sharedRangeDetails) {
      const stored = resolveRange(range.rangeName);
      if (!storedToDisplay.has(stored)) {
        storedToDisplay.set(stored, range.rangeName);
        dedupedSharedRangeDetails.push(range);
      }
    }
    const rangeSubcategories = database.listRangeSubcategories();
    const rawAssignments = database.listRangeSubcategoryAssignments();
    const rangeSubcategoryAssignments = rawAssignments.map((assignment) => ({
      ...assignment,
      rangeName: storedToDisplay.get(assignment.rangeName) ?? assignment.rangeName,
    }));
    const allConfigurations = new Map<string, RangeConfiguration>(
      database.listRangeConfigurations().map((configuration) => [configuration.rangeName, configuration]),
    );
    const rangeConfigurations: RangeConfiguration[] = [];
    for (const range of dedupedSharedRangeDetails) {
      const stored = resolveRange(range.rangeName);
      const configuration = allConfigurations.get(stored);
      if (configuration) {
        rangeConfigurations.push({ ...configuration, rangeName: range.rangeName });
      }
    }
    res.json({
      sharedRangeDetails: dedupedSharedRangeDetails,
      rangeSubcategories,
      rangeSubcategoryAssignments,
      rangeConfigurations,
    });
  });

  app.post('/app/api/model-subscribe', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webModelSubscriptionSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const account = database.findAccountById(input.accountId);
      if (!account || account.userId !== session.userId || account.deprecated) {
        res.status(400).json({ error: 'Invalid account.' });
        return;
      }
      const assignments = database.listRangeSubcategoryAssignments().filter((a) => a.subcategoryName === input.subcategoryName);
      if (assignments.length === 0) {
        res.status(404).json({ error: 'Model not found or has no ranges.' });
        return;
      }
      let count = 0;
      for (const assignment of assignments) {
        const route = database.upsertRangeRoute({
          userId: session.userId,
          rangeName: assignment.rangeName,
          accountId: input.accountId,
          extensionEnabled: input.extensionEnabled,
          traderspostEnabled: input.traderspostEnabled,
          runScheduled: input.runScheduled,
        });
        if (route) count += 1;
      }
      database.invalidateUserCache(session.userId);
      res.json({ success: true, count });
    } catch {
      res.status(400).json({ error: 'Invalid model subscription request.' });
    }
  });

  app.post('/app/api/push-token', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    const { csrfToken, token } = req.body ?? {};
    if (typeof csrfToken !== 'string' || !validateCsrf(session, csrfToken)) {
      res.status(403).json({ error: 'Invalid form token.' });
      return;
    }
    if (typeof token !== 'string' || token.length < 10 || token.length > 200) {
      res.status(400).json({ error: 'Invalid push token.' });
      return;
    }
    database.upsertPushToken(session.userId, token);
    res.json({ success: true });
  });

  app.post('/app/api/push-token/delete', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    const { csrfToken, token } = req.body ?? {};
    if (typeof csrfToken !== 'string' || !validateCsrf(session, csrfToken)) {
      res.status(403).json({ error: 'Invalid form token.' });
      return;
    }
    if (typeof token !== 'string' || token.length < 10 || token.length > 200) {
      res.status(400).json({ error: 'Invalid push token.' });
      return;
    }
    database.deletePushToken(session.userId, token);
    res.json({ success: true });
  });

  app.get('/app/api/range/calendar', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const rangeName = typeof req.query.range === 'string' && req.query.range ? req.query.range : '';
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : undefined;
    if (!rangeName) {
      res.status(400).json({ error: 'Missing range' });
      return;
    }
    if (!database.resolveTrackedRangeName(rangeName)) {
      res.status(404).json({ error: 'Range not found' });
      return;
    }
    const calendar = database.getRangeTradeCalendarMonth(rangeName, new Date(), month);
    res.json(calendar);
  });

  app.get('/app/api/category/calendar', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const subcategoryName = typeof req.query.subcategory === 'string' && req.query.subcategory ? req.query.subcategory : '';
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : undefined;
    const weekParam = typeof req.query.week === 'string' ? Number(req.query.week) : undefined;
    const week = weekParam && Number.isInteger(weekParam) && weekParam >= 1 && weekParam <= 5 ? weekParam : undefined;
    if (!subcategoryName) {
      res.status(400).json({ error: 'Missing model' });
      return;
    }
    const includedRanges = typeof req.query.ranges === 'string' && req.query.ranges
      ? req.query.ranges.split(',').filter(Boolean)
      : undefined;
    const calendar = database.getSubcategoryTradeCalendarMonth(subcategoryName, new Date(), month, includedRanges, week);
    res.json(calendar);
  });

  app.get('/app/api/events/stream', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const streams = userEventStreams.get(session.userId) ?? new Set<Response>();
    userEventStreams.set(session.userId, streams);
    streams.add(res);
    res.on('close', () => streams.delete(res));
    req.on('close', () => streams.delete(res));
  });

  app.get('/app/api/journal', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const rawAccount = req.query.account;
    const accountId =
      typeof rawAccount === 'string' && rawAccount
        ? rawAccount.split(',').filter(Boolean)
        : Array.isArray(rawAccount)
          ? rawAccount.filter((v): v is string => typeof v === 'string').filter(Boolean)
          : undefined;
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : undefined;
    const now = new Date();
    const tradeJournal = database.getTradeJournal(session.userId, now, accountId);
    const calendar = database.getTradeCalendarMonth(session.userId, now, { accountId, month });
    const journalDays = database.getTradeJournalDays(
      session.userId,
      calendar.days.filter((day) => day.closedCount > 0).map((day) => day.date),
      { accountId },
    );
    res.json({ tradeJournal, calendar, journalDays });
  });

  app.get('/app/api/drafts', (req, res, next) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const status = z.enum(['pending', 'reviewed']).default('pending').parse(req.query.status);
      res.status(200).json({ drafts: database.listDrafts(session.userId, status) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/app/api/drafts/history', (req, res, next) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const limit = z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit);
      const sinceHours = z.coerce.number().int().min(1).max(168).default(12).parse(req.query.sinceHours);
      const status = z.enum(['all', 'reviewed', 'submitted', 'rejected', 'expired']).default('all').parse(req.query.status);
      const query = z.string().trim().max(256).optional().parse(req.query.query) || undefined;
      const accountId = z.string().trim().max(64).default('all').parse(req.query.accountId);
      res.status(200).json({
        drafts: database.listRecentDrafts(session.userId, { limit, sinceHours, status, query, accountId }),
      });
    } catch (error) {
      next(error);
    }
  });

  const draftAction = (
    req: Request,
    res: Response,
    act: (userId: string, draftId: string) => boolean,
  ): void => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const draftId = z.string().uuid().parse(req.params.id);
      const input = z.object({ csrfToken: z.string().min(1) }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (!act(session.userId, draftId)) {
        res.status(409).json({ error: 'draft is not pending or does not exist' });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(400).json({ error: 'Invalid request.' });
    }
  };

  app.post('/app/api/drafts/:id/reviewed', (req, res) => {
    draftAction(req, res, (userId, draftId) => Boolean(database.markReviewed(userId, draftId)));
  });
  app.post('/app/api/drafts/:id/rejected', (req, res) => {
    draftAction(req, res, (userId, draftId) => database.rejectDraft(userId, draftId));
  });
  app.post('/app/api/drafts/:id/submitted', (req, res) => {
    draftAction(req, res, (userId, draftId) => Boolean(database.markSubmitted(userId, draftId)));
  });
  app.post('/app/api/drafts/submit-all', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = z.object({ csrfToken: z.string().min(1) }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const count = database.markAllPendingDraftsSubmitted(session.userId);
      emitToUser(session.userId, 'drafts:refresh', {});
      res.json({ submitted: count });
    } catch {
      res.status(400).json({ error: 'Invalid request.' });
    }
  });
  app.post('/app/api/drafts/:id/resend', (req, res) => {
    draftAction(req, res, (userId, draftId) => database.resendDraft(userId, draftId));
  });

  app.post('/app/api/journal/manual-trade', (req, res, next) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = manualTradeSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const account = database.findAccountById(input.accountId);
      if (!account || (account.userId !== session.userId && session.email !== adminUserEmail)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const occurredAt = new Date(input.occurredAt).toISOString();
      const tradeId = `manual-${randomUUID()}`;
      const rangeName = '__manual';
      const action = input.side === 'long' ? 'buy' : 'sell';
      const realizedDollarsCents = Math.round(input.realizedDollars * 100);
      const realizedTicksCents = Math.round(input.realizedTicks * 100);
      const shared = {
        userId: session.userId,
        accountId: input.accountId,
        rangeName,
        tradeId,
        instrument: input.instrument,
        side: input.side,
        quantity: input.quantity,
        occurredAt,
      };
      database.createTradeEvent({
        ...shared,
        eventId: `${tradeId}-entry_filled`,
        eventType: 'entry_filled' as const,
        action,
        entryPrice: input.entryPrice,
      });
      database.createTradeEvent({
        ...shared,
        eventId: `${tradeId}-exit_filled`,
        eventType: 'exit_filled' as const,
        action: 'exit' as const,
        entryPrice: input.entryPrice,
        exitPrice: input.exitPrice,
      });
      database.createTradeEvent({
        ...shared,
        eventId: `${tradeId}-trade_closed`,
        eventType: 'trade_closed' as const,
        action: 'exit' as const,
        entryPrice: input.entryPrice,
        exitPrice: input.exitPrice,
        realizedTicksCents,
        realizedDollarsCents,
        outcome: input.outcome,
      });
      console.info('[manual-trade] Recorded manual trade', {
        accountId: input.accountId,
        tradeId,
        instrument: input.instrument,
        occurredAt,
        outcome: input.outcome,
      });
      res.json({ tradeId, rangeName, occurredAt });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'invalid request', details: error.issues });
        return;
      }
      next(error);
    }
  });

  app.post('/app/api/journal/exclude-day-range-account', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = journalDayRangeAccountExclusionSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const count = database.setTradeEventPerformanceExclusionForDayRangeAccount(
        session.userId,
        input.date,
        input.accountId,
        input.rangeName,
        input.reason ?? 'erroneous',
      );
      res.json({ success: true, count });
    } catch {
      res.status(400).json({ error: 'Invalid exclusion request.' });
    }
  });

  app.post('/app/api/journal/reconcile-be', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = webReconcileBeSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      let event: TradeEvent | undefined;
      let bracket: BracketMonitorEntry | undefined;
      if (input.eventId.startsWith('monitor:')) {
        const parts = input.eventId.split(':');
        if (parts.length === 5) {
          const [, accountId, rangeName, bracketId, side] = parts;
          bracket = database.findBracketMonitorEntry(
            accountId,
            rangeName,
            bracketId,
            side as 'long' | 'short',
          );
          if (bracket) {
            event = {
              id: input.eventId,
              userId: session.userId,
              accountId: bracket.accountId,
              rangeName: bracket.rangeName,
              eventId: bracket.lastEventId ?? input.eventId,
              tradeId: bracket.tradeId,
              eventType: bracket.state === 'filled' ? 'entry_filled' : 'entry_armed',
              instrument: bracket.instrument,
              side: bracket.side,
              action: bracket.side === 'long' ? 'buy' : 'sell',
              quantity: bracket.quantity,
              ...(bracket.entryPrice != null ? { entryPrice: bracket.entryPrice } : {}),
              occurredAt: bracket.lastOccurredAt,
              excludedFromPerformance: false,
            };
          }
        }
      } else {
        event = database.findTradeEventById(session.userId, input.eventId);
      }
      if (!event || (event.eventType !== 'entry_filled' && event.eventType !== 'entry_armed')) {
        res.status(404).json({ error: 'Open trade not found.' });
        return;
      }
      const account = database.findAccountById(event.accountId);
      if (!account || (account.userId !== session.userId && session.email !== adminUserEmail)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const now = new Date().toISOString();
      if (event.eventType === 'entry_filled') {
        const positions = database.getOpenPositionsForAccount(event.accountId, event.instrument);
        const pos = positions.find(
          (p) => p.tradeId === event.tradeId && p.side === event.side && p.rangeName === event.rangeName,
        );
        if (pos) {
          recordBreakevenCloseForTrade(account.userId, account.id, event.instrument, pos, now);
        } else {
          recordBreakevenTradeClosed(account.userId, account.id, event, now);
        }
      } else {
        recordReconcileArmCancelled(account.userId, account.id, event, now);
      }
      if (bracket) {
        database.retireBracketMonitorEntry(
          account.userId,
          bracket,
          event.eventType === 'entry_filled' ? 'trade_closed' : 'entry_cancelled',
          input.eventId,
          now,
        );
      }
      database.setTradeEventPerformanceExclusion(session.userId, event.id, 'erroneous', session.userId);
      res.json({ success: true, closed: 1, tradeId: event.tradeId });
    } catch {
      res.status(400).json({ error: 'Invalid reconcile request.' });
    }
  });

  app.post('/app/api/trade-events/:id/delete', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const csrfToken = typeof req.body?.csrfToken === 'string' ? req.body.csrfToken : '';
      if (!validateCsrf(session, csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const deleted = database.deleteRangeTradeEvent(req.params.id, session.userId);
      if (!deleted) {
        res.status(404).json({ error: 'Trade not found.' });
        return;
      }
      res.json({ success: true });
    } catch {
      res.status(400).json({ error: 'Invalid delete request.' });
    }
  });

  app.post('/app/api/trade-events/:id/adjust', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = tradeAdjustmentSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const updated = database.adjustRangeTradeEvent(
        req.params.id,
        session.userId,
        input.changes as Record<string, string | number | null>,
        input.note,
        { id: session.userId, email: session.email },
      );
      if (!updated) {
        res.status(404).json({ error: 'Trade not found.' });
        return;
      }
      res.json({ success: true, trade: updated });
    } catch {
      res.status(400).json({ error: 'Invalid adjustment request.' });
    }
  });

  app.post('/app/api/trade-events/:id/apply-all', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = tradeAdjustmentSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const updated = database.applyAllMatchingTradeEvents(
        req.params.id,
        session.userId,
        input.changes as Record<string, string | number | null>,
        input.note,
        { id: session.userId, email: session.email },
      );
      if (!updated) {
        res.status(404).json({ error: 'Trade not found.' });
        return;
      }
      res.json({ success: true, trade: updated });
    } catch {
      res.status(400).json({ error: 'Invalid apply-all request.' });
    }
  });

  app.get('/app/api/accounts', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const now = new Date();
    const journal = database.getTradeJournal(session.userId, now);
    const alertSummaries: Record<string, AccountAlertSummary> = {};
    for (const { account } of journal.accounts) {
      alertSummaries[account.id] = database.getAccountAlertSummary(session.userId, account.id);
    }
    const destinationList = database.listTradersPostAccountDestinations(session.userId);
    const destinations: Record<string, PublicTradersPostAccountDestination | undefined> = {};
    for (const dest of destinationList) {
      destinations[dest.accountId] = publicTradersPostDestination(dest);
    }
    const enabledRouteCounts = database.listEnabledBrokerRouteCounts(session.userId);
    res.json({
      accounts: journal.accounts,
      alertSummaries,
      destinations,
      enabledRouteCounts,
    });
  });

  app.get('/app/api/accounts/:accountId/pnl-review', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const parsedAccountId = z.string().uuid().safeParse(req.params.accountId);
    if (!parsedAccountId.success) {
      res.status(400).json({ error: 'Invalid account id' });
      return;
    }
    const account = database.findAccountById(parsedAccountId.data);
    if (!account || (account.userId !== session.userId && session.email !== adminUserEmail)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const until = new Date();
    const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
    const review = database.getAccountPnlReview(account.id, since.toISOString(), until.toISOString());
    res.json({
      account,
      since: since.toISOString(),
      until: until.toISOString(),
      summary: review?.summary,
      ranges: review?.ranges ?? [],
      trades: review?.trades ?? [],
    });
  });

  app.get('/app/api/alerts', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const activity = parseAlertActivityFilter(req.query.activity);
    const nameQuery = typeof req.query.name === 'string' ? req.query.name : undefined;
    const receivedAfter = typeof req.query.receivedAfter === 'string' ? req.query.receivedAfter : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const offset = typeof req.query.offset === 'string' ? Number(req.query.offset) : 0;
    const selectedUserId = session.email === adminUserEmail && req.query.user !== 'me' ? undefined : session.userId;
    const { alerts, totalCount } = database.listAlertFeed(
      selectedUserId,
      activity,
      nameQuery,
      receivedAfter,
      limit,
      offset,
    );
    const rangeNames = database.listAlertFeedRangeNames(selectedUserId);
    const summary = database.getAlertFeedSummary(
      selectedUserId,
      activity,
      nameQuery,
      receivedAfter,
    );
    res.json({ alerts, totalCount, rangeNames, summary });
  });

  app.get('/app/api/bridge-logs', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const hours = Math.min(Math.max(Number(req.query.hours ?? 4), 1), 48);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const category = typeof req.query.category === 'string' && req.query.category !== 'all'
      ? req.query.category
      : undefined;
    const logs = database.listBridgeLogs({ userId: session.userId, since, category, limit: 1000 });
    res.json({ logs, hours, category });
  });

  const reapplyOperationSummaries = (userId: string) =>
    database.listReapplyOperationsForUser(userId, 50, false).map((op) => {
      const rearmedRangeNames = Array.from(new Set(
        op.steps
          .filter((s) => s.kind === 'entry')
          .map((s) => s.arm?.rangeName ?? (s.payload.extras?.rangeName as string | undefined))
          .filter((name): name is string => Boolean(name)),
      ));
      return {
        id: op.id,
        accountId: op.accountId,
        instrument: op.instrument,
        closingRangeName: op.route.rangeName,
        createdAt: op.createdAt,
        completed: op.completed,
        reason: op.reason,
        rearmedRangeNames,
      };
    });

  // Read-only payload for the Monitoring page, which every signed-in user can
  // open. Everything is scoped to the session user except the broker-order
  // ledger for the admin, which mirrors the cross-user debugging view.
  app.get('/app/api/monitoring', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const userId = session.userId;
    const brokerOrders = session.email === adminUserEmail
      ? database.listAllBrokerOrders(200)
      : database.listBrokerOrdersForUser(userId, 200);
    const enrichedBrokerOrders = withUncoveredArmFlag(brokerOrders);
    res.json({
      accounts: database.listAccounts(userId),
      traderspostDestinations: [],
      rangeConfigurations: [],
      flaggedRanges: [],
      excludedTrades: [],
      untrackedRangeNames: [],
      reapplyOperations: reapplyOperationSummaries(userId),
      openTradeSanity: database.listOpenTradeSanity(userId),
      brokerOrders: enrichedBrokerOrders,
      processRuns: session.email === adminUserEmail ? database.listProcessRuns(20) : [],
      // Dispatch lane telemetry — ops data, admin-scoped like processRuns.
      dispatchQueues: session.email === adminUserEmail ? (app.locals.dispatchQueueStats?.() ?? []) : [],
    });
  });

  app.get('/app/api/debugging', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (session.email !== adminUserEmail) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const userId = session.userId;
    const accounts = database.listAccounts(userId);
    const traderspostDestinations = database.listTradersPostAccountDestinations(userId);
    const rangeConfigurations = database.listRangeConfigurations();
    const flaggedRanges = database.listRangeReviewFlags();
    const closedTrades = database.listRecentClosedTrades(userId, 200, { includeExcluded: true });
    const excludedTrades = closedTrades.filter((trade) => trade.excludedFromPerformance);
    const trackedNames = new Set(database.listTrackedRangeNames());
    const alertPayloads = database.listRangeAlertPayloads(
      session.email === adminUserEmail ? undefined : userId,
    );
    const untrackedMap = new Map<string, {
      name: string;
      alertCount: number;
      latestInstrument: string;
      latestReceivedAt: string;
    }>();
    for (const alert of alertPayloads) {
      if (!alert.rangeName || trackedNames.has(alert.rangeName)) continue;
      const existing = untrackedMap.get(alert.rangeName);
      if (!existing || alert.receivedAt > existing.latestReceivedAt) {
        untrackedMap.set(alert.rangeName, {
          name: alert.rangeName,
          alertCount: (existing?.alertCount ?? 0) + 1,
          latestInstrument: alert.ticker,
          latestReceivedAt: alert.receivedAt,
        });
      } else {
        existing.alertCount += 1;
      }
    }
    const untrackedRangeNames = [...untrackedMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    const reapplyOperations = reapplyOperationSummaries(userId);
    const openTradeSanity = database.listOpenTradeSanity(userId);
    // The clear/flatten controls operate across every user's accounts, so the
    // ledger must show the same scope — not only the admin's own accounts.
    const brokerOrders = withUncoveredArmFlag(database.listAllBrokerOrders(200));
    res.json({
      accounts,
      traderspostDestinations: traderspostDestinations.map(publicTradersPostDestination),
      rangeConfigurations,
      flaggedRanges,
      excludedTrades,
      untrackedRangeNames,
      reapplyOperations,
      openTradeSanity,
      brokerOrders,
      processRuns: database.listProcessRuns(20),
    });
  });

  app.get('/app/api/settings', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const now = new Date();
    const userId = session.userId;
    const accounts = database.listAccounts(userId);
    const deprecatedIds = new Set(accounts.filter((a) => a.deprecated).map((a) => a.id));
    const rangeRoutes = database.listRangeRoutes(userId)
      .filter((route) => !deprecatedIds.has(route.accountId));
    const sharedRangeDetails = database.listSharedRangeDetails(now);
    const rangeNames = [
      ...new Set([
        ...sharedRangeDetails.map((detail) => detail.rangeName),
        ...rangeRoutes.map((route) => route.rangeName),
      ]),
    ].sort((a, b) => a.localeCompare(b));
    const rangeSubcategories = database.listRangeSubcategories();
    const rangeSubcategoryAssignments = database.listRangeSubcategoryAssignments();
    const extensionToken = database.getUserExtensionToken(userId);
    res.json({
      accounts,
      rangeRoutes,
      rangeNames,
      rangeSubcategories,
      rangeSubcategoryAssignments,
      extensionToken,
      extensionVersion,
    });
  });

  const requireWebSession = (req: Request, res: Response): WebSession | undefined => {
    const session = getWebSession(req);
    if (!session) {
      res.redirect(303, '/login');
      return undefined;
    }
    return session;
  };

  const validateCsrf = (session: WebSession, token: string): boolean => matchesSecret(session.csrfToken, token);

  const targetUser = (
    session: WebSession,
    requestedUserId: string | undefined,
    res: Response,
  ): Pick<import('./database.js').UserCredentials, 'id' | 'email'> | undefined => {
    if (requestedUserId && requestedUserId !== session.userId && session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Not authorized to manage this user.</p>'));
      return undefined;
    }
    const id = requestedUserId && session.email === adminUserEmail ? requestedUserId : session.userId;
    const user = database.findUserById(id);
    if (!user) {
      res.status(404).send(page('Not found', '<p>User not found.</p>'));
      return undefined;
    }
    return user;
  };

  app.get('/', (_req, res) => {
    res.redirect(303, '/app');
  });

  app.get('/login', (_req, res) => {
    if (!isProduction) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
    res.sendFile(join(process.cwd(), 'client/dist/index.html'));
  });

  app.post('/login', (req, res) => {
    if (!authConfigured || !initialUserPassword || !sessionSecret) {
      res.status(503).json({ error: 'Login unavailable: INITIAL_USER_PASSWORD and SESSION_SECRET must be configured.' });
      return;
    }
    const email = typeof req.body.email === 'string' ? req.body.email : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = database.findUserForLogin(email);
    const valid = user && (
      user.passwordSalt && user.passwordHash
        ? verifyPassword(password, user.passwordSalt, user.passwordHash)
        : matchesSecret(initialUserPassword, password)
    );
    if (!valid || !user) {
      res.status(401).json({ error: 'Invalid email or password.' });
      return;
    }
    if (!user.passwordSalt || !user.passwordHash) {
      const passwordHash = createPasswordHash(password);
      database.setUserPassword(user.id, passwordHash.salt, passwordHash.hash);
    }
    const token = createSessionToken();
    database.createSession(
      hashSessionToken(token, sessionSecret),
      user.id,
      createSessionToken(),
      new Date(Date.now() + sessionDurationSeconds * 1000).toISOString(),
    );
    res.setHeader('Set-Cookie', sessionCookie(token, secureCookies));
    res.status(200).json({ redirect: '/app' });
  });

  app.post('/logout', (req, res) => {
    const session = getWebSession(req);
    if (!session || typeof req.body.csrfToken !== 'string' || !validateCsrf(session, req.body.csrfToken)) {
      res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
      return;
    }
    database.deleteSession(session.tokenHash);
    res.setHeader('Set-Cookie', expiredSessionCookie(secureCookies));
    res.redirect(303, '/login');
  });

  const renderAppView = (view: AppView) => (req: Request, res: Response) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(join(process.cwd(), 'client/dist/index.html'));
  };

  const renderAdminAppView = (view: AppView) => (req: Request, res: Response) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Only the administrator can view this page.</p>', '', readTheme(req)));
      return;
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(join(process.cwd(), 'client/dist/index.html'));
  };

  app.get('/app', renderAppView('journal'));
  app.get('/app/journal/day', renderAppView('journal'))
  app.get('/app/accounts', renderAppView('accounts'));
  app.get('/app/alerts', renderAppView('alerts'));
  app.get('/api/alerts/pulse', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    const requestedUserId = typeof req.query.user === 'string' ? req.query.user : undefined;
    const user = targetUser(session, requestedUserId, res);
    if (!user) return;
    const requestedAccountId = typeof req.query.account === 'string' && req.query.account
      ? userIdSchema.parse(req.query.account)
      : undefined;
    if (requestedAccountId) {
      const account = database.findAccountById(requestedAccountId);
      if (!account || account.userId !== user.id) {
        res.status(404).send(page('Not found', '<p>Account not found.</p>'));
        return;
      }
      const pulse = database.getAccountAlertPulse(user.id, requestedAccountId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(pulse);
      return;
    }
    const selectedAlertsUserId = session.email === adminUserEmail
      ? requestedUserId ?? undefined
      : session.userId;
    const selectedAlertsName = normalizeAlertNameFilter(req.query.name);
    const selectedAlertsTime = parseAlertTimeFilter(req.query.time);
    const selectedAlertsActivity = parseAlertActivityFilter(req.query.activity);
    const summary = database.getAlertFeedSummary(
      selectedAlertsUserId,
      selectedAlertsActivity,
      selectedAlertsName,
      alertTimeFilterStart(new Date(), selectedAlertsTime),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      totalReceived: summary.totalAlerts,
      pendingCount: database.countDrafts('pending', selectedAlertsUserId) + summary.traderspostPendingCount,
      ...(summary.latestReceivedAt ? { latestReceivedAt: summary.latestReceivedAt } : {}),
    });
  });
  app.get('/app/ranges/calendar', renderAppView('ranges'))
  app.post('/app/ranges/calendar/day-visibility', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeCalendarDayVisibilitySchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      if (input.dateKey) {
        const updated = database.setRangeCalendarDayHidden(
          input.rangeName,
          input.dateKey,
          input.hidden === 'true',
          session.userId,
        );
        if (!updated) {
          res.status(404).send(page('Not found', '<p>Range day not found.</p>'));
          return;
        }
      } else {
        const rangeCalendar = database.getRangeTradeCalendarMonth(
          input.rangeName,
          new Date(`${input.month}-15T12:00:00.000Z`),
          input.month,
        );
        for (const day of rangeCalendar.days) {
          database.setRangeCalendarDayHidden(
            input.rangeName,
            day.date,
            input.hidden === 'true',
            session.userId,
          );
        }
      }
      res.redirect(303, buildPath('/app/ranges/calendar', {
        ...(user.id === session.userId ? {} : { user: user.id }),
        range: input.rangeName,
        ...(input.month ? { month: input.month } : {}),
      }));
    } catch {
      res.status(400).send(page('Invalid calendar update', '<p>Review the range day request and try again.</p>'));
    }
  });
  app.get('/app/alerts/:deliveryId/raw', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    const alertId = z.string().uuid().safeParse(req.params.deliveryId);
    if (!alertId.success) {
      res.status(404).send(page('Not found', '<p>Alert payload not found.</p>'));
      return;
    }
    const user = targetUser(session, undefined, res);
    if (!user) return;
    const selectedAlertsUserId = session.email === adminUserEmail ? undefined : session.userId;
    const alert = selectedAlertsUserId
      ? database.findUserProxyAlertPayload(selectedAlertsUserId, alertId.data)
      : session.email === adminUserEmail
        ? database.findProxyAlertPayload(alertId.data)
        : database.findUserProxyAlertPayload(user.id, alertId.data);
    const legacyAlert = !alert ? database.findAccountAlertPayload(alertId.data) : undefined;
    if (!alert && !legacyAlert) {
      res.status(404).send(page('Not found', '<p>Alert payload not found.</p>'));
      return;
    }
    if (legacyAlert && legacyAlert.userId !== session.userId && session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Not authorized to view this alert payload.</p>'));
      return;
    }
    const selectedAlertsName = normalizeAlertNameFilter(req.query.name);
    const selectedAlertsTime = parseAlertTimeFilter(req.query.time);
    const selectedAlertsActivity = parseAlertActivityFilter(req.query.activity);
    const selectedAlertsPage = parsePageParam(req.query.page);
    const backPath = buildPath('/app/alerts', {
      ...(selectedAlertsName ? { name: selectedAlertsName } : {}),
      ...(selectedAlertsTime !== 'all' ? { time: selectedAlertsTime } : {}),
      ...(selectedAlertsActivity !== 'all' ? { activity: selectedAlertsActivity } : {}),
      ...(selectedAlertsPage > 1 ? { page: String(selectedAlertsPage) } : {}),
    });
    const alertTitle = alert?.rangeName ?? legacyAlert?.accountName ?? 'Alert payload';
    const alertDate = alert?.receivedAt ?? legacyAlert!.receivedAt;
    const alertReference = alert?.sourceReference ?? legacyAlert?.sourceReference;
    const payloadJson = alert?.payloadJson ?? legacyAlert!.payloadJson;
    res.status(200).send(page(
      'Raw alert JSON',
      `<main class="json-page"><header><div><h1>Raw alert JSON</h1><p class="muted">${escapeHtml(alertTitle)} · ${escapeHtml(formatDashboardDateTime(alertDate))}</p>${alertReference ? `<p class="muted">Reference · ${escapeHtml(alertReference)}</p>` : ''}</div><a href="${escapeHtml(backPath)}" class="outline-button">Back to alerts</a></header><section class="json-frame"><pre>${escapeHtml(prettyPrintJson(payloadJson))}</pre></section></main>`,
    ));
  });
  app.post('/app/alerts/delete', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Only the administrator can delete alerts.</p>'));
      return;
    }
    try {
      const input = webAlertDeleteSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const deleted = database.deleteProxyAlert(input.alertId);
      if (!deleted) {
        res.status(404).json({ error: 'alert not found' });
        return;
      }
      res.status(200).json({ deleted: true });
    } catch {
      res.status(400).json({ error: 'invalid alert delete request' });
    }
  });
  app.get('/app/ranges', renderAppView('ranges'));
  app.get('/app/settings', renderAppView('settings'));
  app.post('/app/theme', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webThemeSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      res.setHeader('Set-Cookie', themeCookie(input.theme, secureCookies));
      res.redirect(303, buildPath('/app/settings', user.id === session.userId ? {} : { user: user.id }));
    } catch {
      res.status(400).send(page('Invalid theme', '<p>Review the theme selection and try again.</p>'));
    }
  });
  app.post('/app/alert-sound', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webAlertSoundSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      res.setHeader('Set-Cookie', alertSoundCookie(Boolean(input.enabled), secureCookies));
      res.redirect(303, buildPath('/app/settings', user.id === session.userId ? {} : { user: user.id }));
    } catch {
      res.status(400).send(page('Invalid alert settings', '<p>Review the alert sound setting and try again.</p>'));
    }
  });
  app.post('/app/forex-factory/import', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Only the administrator can import shared Forex Factory snapshots.</p>', '', readTheme(req)));
      return;
    }
    try {
      const input = webForexFactoryImportSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>', '', readTheme(req)));
        return;
      }
      importForexFactorySnapshot(database, { forexFactoryCache, forexFactoryRangeCache }, input.range, input.html);
      res.redirect(303, buildPath('/app/settings', {}));
    } catch (error) {
      if (error instanceof ForexFactoryError) {
        res.status(error.status).send(page('Forex Factory import failed', `<p>${escapeHtml(error.message)}</p>`, '', readTheme(req)));
        return;
      }
      res.status(400).send(page('Invalid Forex Factory import', '<p>Paste the full weekly page source and try again.</p>', '', readTheme(req)));
    }
  });
  app.post('/app/debugging/traderspost-direct-test', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Not authorized to run debugging TradersPost tests.</p>', '', readTheme(req)));
      return;
    }
    try {
      const input = webDebugTradersPostTestSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>', '', readTheme(req)));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const account = database.findAccountById(input.accountId);
      if (!account || account.userId !== user.id) {
        res.status(404).send(page('Not found', '<p>Account not found.</p>', '', readTheme(req)));
        return;
      }
      const destination = database.getTradersPostAccountDestination(account.id);
      if (!destination) {
        res.status(409).send(page('No TradersPost destination', '<p>This account does not have a TradersPost destination configured.</p>', '', readTheme(req)));
        return;
      }
      const sampleRoute = database.listRangeRoutes(user.id).find((route) => route.accountId === account.id && route.traderspostEnabled);
      const payload = applyAccountDestinationToPayload(
        debuggingTradersPostTestBuy(sampleRoute?.rangeName ?? 'Test Range'),
        destination,
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      let statusCode: number | undefined;
      let responseBody = '';
      let errorText: string | undefined;
      try {
        const response = await fetchImplementation(destination.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        statusCode = response.status;
        responseBody = await response.text();
      } catch (error) {
        errorText = error instanceof Error && error.name === 'AbortError'
          ? 'TradersPost request timed out'
          : error instanceof Error
            ? `${error.message}${describeErrorCause(error) ? ` — ${describeErrorCause(error)}` : ''}`
            : 'TradersPost request failed';
      } finally {
        clearTimeout(timeout);
      }
      const backPath = buildPath('/app/debugging', user.id === session.userId ? {} : { user: user.id });
      const resultSummary = errorText
        ? `<p class="error">Request failed · ${escapeHtml(errorText)}</p>`
        : `<p class="${statusCode != null && statusCode >= 200 && statusCode < 300 ? 'positive' : 'negative'}">HTTP ${statusCode ?? 'Unknown'} returned from TradersPost.</p>`;
      res.status(errorText ? 502 : 200).send(page(
        'TradersPost direct test result',
        `<main class="json-page"><header><div><h1>TradersPost direct test result</h1><p class="muted">${escapeHtml(account.name)} · sample range ${escapeHtml(sampleRoute?.rangeName ?? 'Test Range')}</p>${resultSummary}</div><a href="${escapeHtml(backPath)}" class="outline-button">Back to debugging</a></header><section class="json-frame"><h2>Sent payload</h2><pre>${escapeHtml(prettyPrintJson(JSON.stringify(payload)))}</pre></section><section class="json-frame"><h2>Response body</h2><pre>${escapeHtml(responseBody ? prettyPrintJson(responseBody) : errorText ?? 'No response body returned.')}</pre></section></main>`,
        'json-page',
        readTheme(req),
      ));
    } catch (error) {
      next(error);
    }
  });
  // A destination can send when it is enabled and has a reachable webhook —
  // either the TradersPost URL or a complete CrossTrade pair (CT sends go
  // through the shared dispatch path's CT conversion, or direct CT posts in
  // the safeguard/sim paths).
  const destinationCanSend = (destination: TradersPostAccountDestination | null | undefined): destination is TradersPostAccountDestination =>
    Boolean(destination?.enabled && (destination.webhookUrl || isCrossTradeConfigured(destination)));

  // Range-configured dispatch policy for CT (see toCrossTradeMessage):
  //  - breakEvenEnabled ranges attach atm_strategy named after the range; a
  //    missing NT8 template rejects the entry — intentional, an unprotected
  //    BE range must not run.
  //  - ocoMode 'both' drops the native OCO pairing so both arms can be live.
  const crossTradeRangePolicy = (payload: TradersPostPayload, contextRangeName?: string): TradersPostPayload => {
    const action = typeof payload.action === 'string' ? payload.action.toLowerCase() : '';
    if (action !== 'buy' && action !== 'sell') return payload;
    const extras = (payload.extras ?? {}) as Record<string, unknown>;
    const rangeName = contextRangeName
      ?? (typeof extras.rangeName === 'string' ? extras.rangeName : undefined);
    const config = rangeName ? database.getRangeConfiguration(rangeName) : undefined;
    if (!config) return payload;
    const nextExtras = { ...extras };
    if (config.breakEvenEnabled && nextExtras.appendAtm === undefined
      && !(typeof nextExtras.atmStrategy === 'string' && nextExtras.atmStrategy.trim())) {
      nextExtras.appendAtm = true;
    }
    if (config.ocoMode === 'both' && nextExtras.oco === undefined && nextExtras.ocoId === undefined) {
      nextExtras.oco = false;
    }
    return { ...payload, extras: nextExtras };
  };

  // Shared core for the debugging Range simulation card and the per-range
  // detail page: builds the bracket payload from top/bottom, applies account
  // destination transforms, and POSTs each prepared payload to the webhook —
  // CrossTrade-converted when the destination is CT-configured.
  const runRangeSimulation = async (
    account: BridgeAccount,
    input: {
      rangeName: string;
      action: 'buy' | 'sell';
      top: number;
      bottom: number;
      quantity: number;
      orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
      takeProfitTicksCents?: number;
      stopLossTicksCents?: number;
      takeProfitStyle?: string;
      stopLossStyle?: string;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const destination = database.getTradersPostAccountDestination(account.id);
    const crossTrade: CrossTradeDestination | undefined = isCrossTradeConfigured(destination)
      ? {
          webhookUrl: destination!.crossTradeWebhookUrl!,
          secretKey: destination!.crossTradeSecretKey!,
          accountName: destination!.crossTradeAccountName || account.name,
        }
      : undefined;
    if (!destination || (!destination.webhookUrl && !crossTrade)) {
      return { status: 409, body: { error: 'No broker destination configured' } };
    }
    const storedRangeConfiguration = database.getRangeConfiguration(input.rangeName);
    const rangeConfiguration: RangeConfiguration | undefined = storedRangeConfiguration
      ? {
          ...storedRangeConfiguration,
          takeProfitTicksCents: input.takeProfitTicksCents ?? storedRangeConfiguration.takeProfitTicksCents,
          stopLossTicksCents: input.stopLossTicksCents ?? storedRangeConfiguration.stopLossTicksCents,
          takeProfitStyle: input.takeProfitStyle ? input.takeProfitStyle.toLowerCase() : storedRangeConfiguration.takeProfitStyle,
          stopLossStyle: input.stopLossStyle ? input.stopLossStyle.toLowerCase() : storedRangeConfiguration.stopLossStyle,
        }
      : undefined;
    const alertTicker = resolvedTradersPostTicker(rangeConfiguration?.instrument ?? 'MNQ1!', destination);
    const tickSize = inferredTickSize(rangeConfiguration?.instrument ?? alertTicker);
    const { slDistance, tpDistance } = rangeExitDistances(rangeConfiguration, input.top, input.bottom, tickSize);
    const basePayload = debuggingRangeSimulationPayload({
      rangeName: input.rangeName,
      instrument: alertTicker,
      action: input.action,
      top: input.top,
      bottom: input.bottom,
      quantity: input.quantity,
      orderType: input.orderType,
      ...(tpDistance > 0 ? { takeProfitDistance: tpDistance } : {}),
      ...(slDistance > 0 ? { stopLossDistance: slDistance } : {}),
    });
    const entryPrice = basePayload.price as number;
    const computed: { entryPrice: number; tickSize: number; tpDistance?: number; slDistance?: number; tpPercent?: number; slPercent?: number } = {
      entryPrice,
      tickSize,
    };
    if (rangeConfiguration && entryPrice > 0) {
      const tpPercent = tpDistance > 0 ? Number(((tpDistance / entryPrice) * 100).toFixed(6)) : 0;
      const slPercent = slDistance > 0 ? Number(((slDistance / entryPrice) * 100).toFixed(6)) : 0;
      if (destination.useLimitPriceTP) {
        if (tpPercent > 0) {
          basePayload.takeProfit = { ...basePayload.takeProfit, percent: tpPercent };
        }
        if (slPercent > 0) {
          basePayload.stopLoss = { ...basePayload.stopLoss, percent: slPercent };
        }
      }
      computed.tpDistance = tpDistance;
      computed.slDistance = slDistance;
      computed.tpPercent = tpPercent;
      computed.slPercent = slPercent;
    }
    const payloadJson = JSON.stringify(basePayload);
    const openInstrumentSet = new Set(database.getAccountOpenInstruments(account.id));
    const preparedPayloads = prepareTradersPostDestinationPayloads(
      payloadJson,
      { ...destination, accountId: account.id },
      rangeConfiguration,
      openInstrumentSet,
    );
    if (preparedPayloads.protectionError) {
      emitToUser(account.userId, 'toast:error', { message: preparedPayloads.protectionError, persistent: true });
      return { status: 400, body: { error: preparedPayloads.protectionError } };
    }
    const outboundPayloadJsons = preparedPayloads.payloadJsons;
    const results: Array<{ status?: number; body: string; error?: string }> = [];
    const sentPayloads: string[] = [];
    for (const outboundPayloadJson of outboundPayloadJsons) {
      // CT destinations get the CrossTrade command shape (with the range's
      // ATM/OCO policy applied); TradersPost gets the prepared JSON as-is.
      const outboundBody = crossTrade
        ? JSON.stringify(toCrossTradeMessage(
            crossTradeRangePolicy(JSON.parse(outboundPayloadJson) as TradersPostPayload, input.rangeName),
            crossTrade,
            'debugging',
          ))
        : outboundPayloadJson;
      sentPayloads.push(outboundBody);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchImplementation(crossTrade ? crossTrade.webhookUrl : destination.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: outboundBody,
          signal: controller.signal,
        });
        const body = await response.text();
        results.push({ status: response.status, body });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ body: '', error });
      } finally {
        clearTimeout(timeout);
      }
    }
    return {
      status: 200,
      body: {
        rangeName: input.rangeName,
        accountName: account.name,
        destination: crossTrade ? 'crosstrade' : 'traderspost',
        outboundPayloads: sentPayloads,
        results,
        computed,
      },
    };
  };

  app.post('/app/debugging/range-simulation', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
    try {
      const input = webDebugRangeSimulationSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token' });
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const account = database.findAccountById(input.accountId);
      if (!account || account.userId !== user.id) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }
      const result = await runRangeSimulation(account, input);
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });
  // Simulate the real ULTRA arming sequence for a stored range: per side, an
  // entry order alert then its entry_armed lifecycle event, fed through the
  // shared proxy pipeline. Routes, bookkeeping, and broker dispatch (TradersPost
  // or CrossTrade) all behave exactly as if Pine sent them — including fan-out
  // to every account with an enabled route for the range.
  app.post('/app/debugging/alert-simulation', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
    try {
      const input = z.object({
        rangeName: z.string().trim().min(1).max(256),
        top: z.coerce.number().positive(),
        bottom: z.coerce.number().positive(),
        quantity: z.coerce.number().positive().default(1),
        csrfToken: z.string().min(1),
      }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token' });
        return;
      }
      const rangeName = database.resolveTrackedRangeName(input.rangeName) ?? database.resolveRangeName(input.rangeName);
      const rangeConfiguration = database.getRangeConfiguration(rangeName);
      if (!rangeConfiguration) {
        res.status(404).json({ error: `No stored range configuration for '${input.rangeName}'.` });
        return;
      }
      const tickSize = inferredTickSize(rangeConfiguration.instrument);
      const { slDistance, tpDistance } = rangeExitDistances(rangeConfiguration, input.top, input.bottom, tickSize);
      const alerts = buildRangeArmAlerts({
        rangeName,
        instrument: rangeConfiguration.instrument,
        top: input.top,
        bottom: input.bottom,
        quantity: input.quantity,
        tickSize,
        tpDistance,
        slDistance,
        breakEvenEnabled: rangeConfiguration.breakEvenEnabled,
        breakEvenOffsetTicksCents: rangeConfiguration.breakEvenOffsetTicksCents,
      });
      const results: Array<{ kind: string; side: string; result: Record<string, unknown> }> = [];
      for (const alert of alerts) {
        const isLifecycle = isLifecyclePayload(alert);
        const result = await processProxyPayload(alert, JSON.stringify(alert));
        results.push({
          kind: isLifecycle ? String((alert as LifecyclePayload).eventType) : 'order',
          side: String(isLifecycle ? (alert as LifecyclePayload).side : (alert as EntryPayload).bracketSide ?? ''),
          result,
        });
      }
      res.status(200).json({ rangeName, instrument: rangeConfiguration.instrument, results });
    } catch (error) {
      next(error);
    }
  });
  // Manual CrossTrade webhook test — builds the internal TradersPost-shaped
  // payload, runs it through toCrossTradeMessage, and posts it to the account's
  // configured CrossTrade endpoint. Response includes the exact sent message.
  app.post('/app/debugging/crosstrade-test', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }
    try {
      const input = z.object({
        accountId: z.string().uuid(),
        action: z.enum(['buy', 'sell', 'cancel', 'exit', 'both']),
        instrument: z.string().trim().min(1).max(64),
        quantity: z.coerce.number().positive().default(1),
        orderType: z.enum(['market', 'limit', 'stop', 'stop_limit']).optional(),
        limitPrice: z.coerce.number().positive().optional(),
        stopPrice: z.coerce.number().positive().optional(),
        bottomPrice: z.coerce.number().positive().optional(),
        takeProfit: z.coerce.number().positive().optional(),
        stopLoss: z.coerce.number().positive().optional(),
        takeProfitTicks: z.coerce.number().positive().optional(),
        stopLossTicks: z.coerce.number().positive().optional(),
        convertTicksToPrices: z.boolean().optional(),
        referencePrice: z.coerce.number().positive().optional(),
        tif: z.enum(['day', 'gtc', 'ioc', 'fok']).optional(),
        notes: z.string().trim().max(400).optional(),
        atmStrategy: z.string().trim().max(128).optional(),
        appendAtm: z.boolean().optional(),
        ocoId: z.string().trim().max(128).optional(),
        targetUserId: z.string().uuid().optional(),
        csrfToken: z.string().min(1),
      }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token' });
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      if (input.action === 'both' && (input.stopPrice == null || input.bottomPrice == null)) {
        res.status(400).json({ error: 'OCO pair requires a stop price (range top) and a bottom price (range bottom)' });
        return;
      }
      const hasTickExits = input.takeProfitTicks != null || input.stopLossTicks != null;
      const singleEntryReference = input.orderType === 'market'
        ? input.referencePrice
        : input.orderType === 'limit'
          ? input.limitPrice ?? input.referencePrice
          : input.stopPrice ?? input.referencePrice;
      if (input.convertTicksToPrices && hasTickExits
        && input.action !== 'both' && input.action !== 'buy' && input.action !== 'sell') {
        res.status(400).json({ error: 'Tick-to-price conversion is only supported for entry orders' });
        return;
      }
      if (input.convertTicksToPrices && hasTickExits
        && (input.action === 'buy' || input.action === 'sell') && singleEntryReference == null) {
        res.status(400).json({ error: 'A reference entry price is required to convert TP/SL ticks to absolute prices' });
        return;
      }
      const account = database.findAccountById(input.accountId);
      if (!account || account.userId !== user.id) {
        res.status(404).json({ error: 'Account not found' });
        return;
      }
      const destination = database.getTradersPostAccountDestination(account.id);
      if (!isCrossTradeConfigured(destination)) {
        res.status(409).json({ error: 'This account has no CrossTrade endpoint configured — set the webhook URL and secret key on the Accounts page.' });
        return;
      }
      const ctDestination: CrossTradeDestination = {
        webhookUrl: destination!.crossTradeWebhookUrl!,
        secretKey: destination!.crossTradeSecretKey!,
        accountName: destination!.crossTradeAccountName || account.name,
      };
      const sharedExtras = {
        rangeName: 'DEBUG-TEST',
        source: 'debugging',
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.atmStrategy ? { atmStrategy: input.atmStrategy } : {}),
        ...(input.appendAtm ? { appendAtm: true } : {}),
        ...(input.ocoId ? { ocoId: input.ocoId } : {}),
      };
      const tickExitFields = (action: 'buy' | 'sell', entryPrice: number) => {
        if (input.convertTicksToPrices) {
          const prices = crossTradeExitPricesFromTicks({
            action,
            ticker: input.instrument,
            entryPrice,
            takeProfitTicks: input.takeProfitTicks,
            stopLossTicks: input.stopLossTicks,
          });
          return {
            ...(prices.takeProfitPrice != null ? { takeProfit: { limitPrice: prices.takeProfitPrice } } : {}),
            ...(prices.stopLossPrice != null ? { stopLoss: { stopPrice: prices.stopLossPrice } } : {}),
          };
        }
        return {
          ...(input.takeProfitTicks != null ? { takeProfit: { amount: input.takeProfitTicks } } : {}),
          ...(input.stopLossTicks != null ? { stopLoss: { amount: input.stopLossTicks } } : {}),
        };
      };
      // CrossTrade's webhook ACK means the command was received — NT8 can still
      // reject the order asynchronously. For test sends we can close that gap:
      // probe the REST read for the order_id we just placed and report the NT8
      // state next to the dispatch result.
      const probeNt8Order = async (orderId: string): Promise<{ state: string; raw?: string; error?: string }> => {
        for (const delay of [0, 1200]) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          const probe = await fetchCrossTradeOrder(ctDestination, orderId);
          if (probe.ok) {
            const row = (probe.data?.order ?? probe.data) as { orderState?: string } | undefined;
            return { state: mapNt8OrderState(row?.orderState), raw: row?.orderState };
          }
          const notFound = probe.statusCode === 404 || /not found/i.test(probe.error ?? '');
          if (!notFound) return { state: 'unknown', error: probe.error };
        }
        return { state: 'not_found' };
      };
      const sendMessage = async (message: CrossTradeMessage, options?: { probe?: boolean }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        let statusCode: number | undefined;
        let responseBody = '';
        let errorText: string | undefined;
        try {
          const response = await fetchImplementation(ctDestination.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message),
            signal: controller.signal,
          });
          statusCode = response.status;
          responseBody = await response.text();
        } catch (error) {
          errorText = error instanceof Error && error.name === 'AbortError'
            ? 'CrossTrade request timed out'
            : error instanceof Error
              ? `${error.message}${describeErrorCause(error) ? ` — ${describeErrorCause(error)}` : ''}`
              : 'CrossTrade request failed';
        } finally {
          clearTimeout(timeout);
        }
        const interpreted = errorText ? undefined : interpretCrossTradeResponse(statusCode ?? 0, responseBody);
        return {
          // The sent message is echoed for operator confirmation, but `key`
          // is a credential — it must never be serialized back to the browser.
          sent: redactCrossTradeMessage(message),
          statusCode,
          responseBody,
          ...(interpreted ? { success: interpreted.success, failureMessage: interpreted.failureMessage } : {}),
          ...(errorText ? { error: errorText } : {}),
          ...(options?.probe !== false && interpreted?.success && message.command === 'place' && message.order_id
            ? { nt8: await probeNt8Order(String(message.order_id)) }
            : {}),
        };
      };

      // 'both' sends the two-sided arm test: a buy stop at the range top and a
      // sell stop at the bottom, sharing one oco_id and ATM strategy group.
      if (input.action === 'both') {
        const runId = randomUUID().slice(0, 8);
        const legs = [
          { side: 'long' as const, action: 'buy' as const, stopPrice: input.stopPrice! },
          { side: 'short' as const, action: 'sell' as const, stopPrice: input.bottomPrice! },
        ];
        const messages = legs.map((leg) => {
          const internalPayload = {
            ticker: input.instrument,
            action: leg.action,
            quantity: input.quantity,
            orderType: 'stop',
            stopPrice: leg.stopPrice,
            bracketId: `debug-${runId}-${leg.side}`,
            bracketSide: leg.side,
            ...tickExitFields(leg.action, leg.stopPrice),
            extras: sharedExtras,
          } as TradersPostPayload;
          const message = toCrossTradeMessage(internalPayload, ctDestination, 'debugging');
          if (input.tif) message.tif = input.tif;
          return message;
        });
        // OCO integrity: both legs go on the wire concurrently, then both are
        // probed — awaiting anything between the sends (a slow ACK, a probe)
        // leaves a gap where one stop can fill with its sibling unsubmitted.
        const results = await Promise.all(messages.map(async (message, i) => ({
          side: legs[i].side,
          ...(await sendMessage(message, { probe: false })),
        })));
        await Promise.all(results.map(async (leg, i) => {
          const orderId = messages[i].order_id;
          if (leg.success === true && typeof orderId === 'string') {
            Object.assign(leg, { nt8: await probeNt8Order(orderId) });
          }
        }));
        res.status(200).json({ legs: results });
        return;
      }

      const singleExitFields = input.convertTicksToPrices
        ? (input.action === 'buy' || input.action === 'sell') && hasTickExits
          ? tickExitFields(input.action, singleEntryReference!)
          : {}
        : {
            ...(input.takeProfit != null ? { takeProfit: { limitPrice: input.takeProfit } } : {}),
            ...(input.stopLoss != null ? { stopLoss: { stopPrice: input.stopLoss } } : {}),
          };
      const internalPayload = {
        ticker: input.instrument,
        action: input.action,
        quantity: input.quantity,
        orderType: input.orderType,
        limitPrice: input.limitPrice,
        stopPrice: input.stopPrice,
        // An order_id makes the test leg traceable — and lets the NT8 probe
        // confirm the order actually landed after the webhook ACK.
        bracketId: `debug-${randomUUID().slice(0, 8)}-${input.action}`,
        ...singleExitFields,
        extras: sharedExtras,
      } as TradersPostPayload;
      const message = toCrossTradeMessage(internalPayload, ctDestination, 'debugging');
      if (input.tif) message.tif = input.tif;
      const leg = await sendMessage(message);
      res.status(leg.error ? 502 : 200).json(leg);
    } catch (error) {
      next(error);
    }
  });

  // Shared resolver for the CrossTrade REST read endpoints — returns the
  // destination or writes the error response and returns undefined.
  const crossTradeReadDestination = (
    accountIdRaw: unknown,
    res: { status: (code: number) => { json: (body: unknown) => void } },
    session: { userId: string; email: string },
  ): { account: BridgeAccount; destination: CrossTradeDestination } | undefined => {
    const accountId = z.string().uuid().parse(accountIdRaw);
    const account = database.findAccountById(accountId);
    if (!account || (session.userId !== account.userId && session.email !== adminUserEmail)) {
      res.status(404).json({ error: 'account not found' });
      return undefined;
    }
    const destination = database.getTradersPostAccountDestination(account.id);
    if (!isCrossTradeConfigured(destination)) {
      res.status(409).json({ error: 'account is not CrossTrade-configured' });
      return undefined;
    }
    return {
      account,
      destination: {
        webhookUrl: destination!.crossTradeWebhookUrl!,
        secretKey: destination!.crossTradeSecretKey!,
        accountName: destination!.crossTradeAccountName || account.name,
      },
    };
  };

  // Live broker state from the CrossTrade REST API, paired with our local
  // bookkeeping so drift is visible: orders/positions as NT8 reports them next
  // to the ledger rows and armed/filled brackets we think are live.
  app.get('/app/debugging/crosstrade-state', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const resolved = crossTradeReadDestination(req.query.accountId, res, session);
      if (!resolved) return;
      const [orders, positions, atmTemplates] = await Promise.all([
        fetchCrossTradeOrders(resolved.destination, false),
        fetchCrossTradePositions(resolved.destination),
        fetchCrossTradeAtmTemplates(resolved.destination),
      ]);
      const ordersList = ((orders.data?.orders ?? []) as CrossTradeOrderRow[]);
      const positionsList = ((positions.data?.positions ?? positions.data?.data ?? []) as CrossTradePositionRow[]);
      const templatesList = ((atmTemplates.data?.templates ?? []) as string[]);
      // ATM preflight: every break-even range routed to this account needs an
      // NT8 template named exactly after it — a missing one means its entries
      // reject at dispatch time. Templates are NT8-install-wide, not per-account.
      const routedRangeNames = new Set(
        database.listRangeRoutes(resolved.account.userId)
          .filter((route) => route.accountId === resolved.account.id && route.traderspostEnabled)
          .map((route) => route.rangeName),
      );
      const requiredTemplates = database.listRangeConfigurations()
        .filter((config) => config.breakEvenEnabled && routedRangeNames.has(config.rangeName))
        .map((config) => config.rangeName);
      const missingTemplates = atmTemplates.ok
        ? requiredTemplates.filter((name) => !templatesList.includes(name))
        : [];
      // Local side: unresolved CT dispatches plus active monitor rows, so the
      // operator can eyeball whether NT8 agrees with our bookkeeping.
      const localOrders = database.listOpenBrokerOrdersByAccount(resolved.account.id)
        .filter((o) => o.destination === 'crosstrade');
      const monitorRows = database.listActiveBracketMonitorEntries(resolved.account.id);
      res.json({
        account: { id: resolved.account.id, name: resolved.account.name },
        nt8Account: resolved.destination.accountName,
        orders: { ok: orders.ok, statusCode: orders.statusCode, error: orders.error, orders: ordersList },
        positions: { ok: positions.ok, statusCode: positions.statusCode, error: positions.error, positions: positionsList },
        atmTemplates: { ok: atmTemplates.ok, statusCode: atmTemplates.statusCode, error: atmTemplates.error, templates: templatesList },
        atmPreflight: { required: requiredTemplates, missing: missingTemplates },
        local: { openOrders: localOrders, monitorRows },
      });
    } catch (error) {
      next(error);
    }
  });

  // Single-order lookup by our caller-supplied order_id (bracket id) —
  // CrossTrade resolves it from the order's UserData, so uncertain dispatches
  // can be verified against real NT8 state.
  app.get('/app/debugging/crosstrade-order', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const resolved = crossTradeReadDestination(req.query.accountId, res, session);
      if (!resolved) return;
      const orderId = z.string().trim().min(1).max(256).parse(req.query.orderId);
      // The ledger id (bridge-*) is not the wire id — CT sends bracketId as
      // order_id. Resolve the row so the probe queries what NT8 actually saw.
      const ledgerRow = database.findBrokerOrderByOrderId(orderId);
      const wireId = ledgerRow?.orderId ? ctWireOrderId(ledgerRow.orderId) : orderId;
      const result = await fetchCrossTradeOrder(resolved.destination, wireId);
      if (!result.ok) {
        // Plain (non-ATM) orders don't echo our order_id at NT8 — fall back to
        // the book read + oco_id/action match, same as the verifier sweep.
        const book = await fetchCrossTradeOrders(resolved.destination);
        const row = book.ok
          ? ((book.data?.orders ?? []) as CrossTradeOrderRow[])
              .find((r) => matchesCtOrderId(r, wireId, ledgerRow?.action))
          : undefined;
        if (row) {
          res.json({ orderId, wireId, ok: true, order: row, status: row.state ?? row.status ?? null, note: 'matched via ocoId + action (order id not echoed)' });
          return;
        }
      }
      // Always 200 — this is a probe; a failed lookup is the answer, not an
      // error. ok/error/statusCode carry the outcome for the UI.
      res.json({ orderId, wireId, ...result });
    } catch (error) {
      next(error);
    }
  });

  // Operator-confirmed "reconcile from broker": probes NT8 for every unresolved
  // CT ledger row on the account and applies definite broker evidence
  // (Working → acknowledged, Filled → filled, Cancelled/Rejected/not-found →
  // terminal + arm retirement). Unknown reads leave rows untouched — nothing
  // is inferred from an unavailable API. Pine lifecycle stays authoritative;
  // this only resolves broker-dispatch evidence.
  app.post('/app/debugging/reconcile-crosstrade', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({
        accountId: z.string().uuid(),
        csrfToken: z.string().min(1),
      }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      const resolved = crossTradeReadDestination(input.accountId, res, session);
      if (!resolved) return;
      const open = database.listOpenBrokerOrdersByAccount(resolved.account.id)
        .filter((o) => o.destination === 'crosstrade' && (o.action === 'buy' || o.action === 'sell'));
      // One book read resolves most rows — only ids missing from it pay for a
      // direct probe. A failed book read falls back to per-order probing.
      const book = await fetchCrossTradeOrders(resolved.destination);
      const bookRows = book.ok ? ((book.data?.orders ?? []) as CrossTradeOrderRow[]) : undefined;
      const outcomes: CtResolveOutcome[] = [];
      for (const order of open) {
        outcomes.push(await resolveCrossTradeBrokerOrder(resolved.account, resolved.destination, order, bookRows));
      }
      res.json({ success: true, accountId: resolved.account.id, probed: outcomes.length, outcomes });
    } catch (error) {
      next(error);
    }
  });

  // Dev/test lever: run the 60s CT sweep on demand (order probes + flat-close
  // sync). Admin-only; production cadence is the interval, this just lets an
  // operator or e2e force a pass instead of waiting a tick.
  app.post('/app/debugging/ct-sweep-now', async (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    const input = z.object({ csrfToken: z.string().min(1) }).parse(req.body ?? {});
    if (!validateCsrf(session, input.csrfToken)) {
      res.status(403).json({ error: 'Invalid form token.' });
      return;
    }
    if (session.email !== adminUserEmail) {
      res.status(403).json({ error: 'admin only' });
      return;
    }
    try {
      await sweepUncertainCrossTradeOrders(true);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/app/extension-download', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const requestedUserId = z.string().uuid().optional().parse(req.query.user);
      const user = targetUser(session, requestedUserId, res);
      if (!user) return;
      if (!existsSync(EXTENSION_ZIP_PATH)) {
        res.status(503).send(page('Extension unavailable', '<p>The latest extension zip is not available on this server yet.</p>'));
        return;
      }
      res.setHeader('Content-Disposition', `attachment; filename="${EXTENSION_ZIP_FILE_NAME}"`);
      res.type('application/zip');
      res.status(200).end(readFileSync(EXTENSION_ZIP_PATH));
    } catch {
      res.status(400).send(page('Invalid request', '<p>Review the extension download request and try again.</p>'));
    }
  });
  app.get('/app/debugging', renderAdminAppView('debugging'));

  app.post('/app/accounts', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webAccountSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const startingBalanceCents = parseDollars(input.startingBalance);
      if (startingBalanceCents == null) {
        res.status(400).send(page('Invalid account', '<p>Balances must be non-negative dollar amounts with up to two decimal places.</p>'));
        return;
      }
      if (database.hasAccountName(user.id, input.name)) {
        res.status(400).send(page('Duplicate account name', '<p>Choose a unique account name.</p>'));
        return;
      }
      database.createAccount({
        userId: user.id,
        name: input.name,
        startingBalanceCents,
      });
      res.redirect(303, `/app/accounts${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid account', '<p>Invalid account details.</p>'));
    }
  });

  app.post('/app/accounts/starting-balance', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webAccountStartingBalanceSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const startingBalanceCents = parseDollars(input.startingBalance);
      if (startingBalanceCents == null) {
        res.status(400).send(page('Invalid account', '<p>Balances must be non-negative dollar amounts with up to two decimal places.</p>'));
        return;
      }
      const updated = database.updateAccountStartingBalance(user.id, input.accountId, startingBalanceCents);
      if (!updated) {
        res.status(404).send(page('Not found', '<p>Account not found.</p>'));
        return;
      }
      res.redirect(303, `/app/accounts${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid account', '<p>Invalid account details.</p>'));
    }
  });

  app.post('/app/accounts/clone', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({
        accountId: z.string().uuid(),
        name: z.string().trim().min(1).max(128),
        csrfToken: z.string().min(1),
      }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, (req.body as Record<string, unknown>).targetUserId as string | undefined, res);
      if (!user) return;
      const account = database.cloneAccount(user.id, input.accountId, input.name);
      if (!account) {
        res.status(403).send(page('Forbidden', '<p>The selected account does not belong to this user.</p>'));
        return;
      }
      res.redirect(303, `/app/accounts${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid request', '<p>Account name is required.</p>'));
    }
  });

  app.post('/app/accounts/delete', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webAccountDeleteSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const deleted = database.deleteAccount(user.id, input.accountId);
      if (!deleted) {
        res.status(404).send(page('Not found', '<p>Account not found.</p>'));
        return;
      }
      res.redirect(303, `/app/accounts${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid account', '<p>Invalid account details.</p>'));
    }
  });

  app.post('/app/accounts/deprecate', async (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webAccountDeprecateSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      if (input.deprecated === 'true') {
        // Close out everything before marking deprecated — a live destination gets
        // the same instrument-scoped cancel/exit flatten as the safeguard button
        // (which also reconciles broker orders, reapply ops, and pending deliveries);
        // anything still open afterwards is closed locally so the journal is flat.
        const account = database.findAccountById(input.accountId);
        if (account) {
          const destination = database.getTradersPostAccountDestination(account.id);
          if (destinationCanSend(destination)) {
            const roots = new Set<string>();
            const addRoot = (ticker: string | null | undefined) => {
              const root = continuousTickerRoot(ticker);
              if (root) roots.add(root);
            };
            for (const ticker of database.listAccountRecentTradersPostTickers(account.id, 24)) addRoot(ticker);
            for (const instrument of database.getAccountOpenInstruments(account.id)) addRoot(instrument);
            for (const op of database.listIncompleteReapplyOperations()) {
              if (op.accountId === account.id) addRoot(op.instrument);
            }
            for (const order of database.listOpenBrokerOrdersByAccount(account.id)) addRoot(order.instrument);
            for (const delivery of database.listPendingTradersPostDeliveries(account.id)) addRoot(delivery.ticker);
            if (roots.size > 0) {
              const outcome = await runCancelAllSafeguard(account, destination, roots);
              emitToUser(account.userId, outcome.sent > 0 ? 'toast:success' : 'toast:error', {
                message: outcome.sent > 0
                  ? `Deprecated ${account.name}: flatten sent for ${outcome.sent} instrument(s)`
                  : `Deprecated ${account.name}: flatten failed for ${outcome.errors} instrument(s)`,
              });
            }
          }
          const occurredAt = new Date().toISOString();
          for (const order of database.getOpenBracketOrdersForAccount(account.id)) {
            recordBridgeGeneratedEntryCancelled({ userId: account.userId, accountId: account.id }, {
              ticker: order.ticker,
              action: 'cancel',
              tradeId: order.tradeId,
              quantity: order.quantity,
              bracketSide: order.side,
              extras: { rangeName: order.rangeName ?? '', reason: 'deprecated_close' },
            }, occurredAt);
          }
          for (const instrument of database.getAccountOpenInstruments(account.id)) {
            recordFlattenedPositions(account.userId, account.id, instrument, occurredAt, undefined, 'deprecated');
          }
        }
      }
      const updated = database.setAccountDeprecated(
        user.id,
        input.accountId,
        input.deprecated === 'true',
      );
      if (!updated) {
        res.status(404).send(page('Not found', '<p>Account not found.</p>'));
        return;
      }
      res.sendStatus(204);
    } catch (error) {
      console.error('[deprecate] failed', { error: error instanceof Error ? error.message : String(error) });
      res.status(400).send(page('Invalid request', '<p>Invalid account details.</p>'));
    }
  });

  app.post('/app/range-routes', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeRouteSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const extensionAccountIds = new Set(asStringArray(req.body.extensionAccountIds));
      const traderspostAccountIds = new Set(asStringArray(req.body.traderspostAccountIds));
      const runScheduledAccountIds = new Set(asStringArray(req.body.runScheduledAccountIds));
      const selectedAccountIds = new Set([
        ...extensionAccountIds,
        ...traderspostAccountIds,
        ...runScheduledAccountIds,
      ]);
      const routes = database.syncRangeRoutes(
        user.id,
        input.rangeName,
        [...selectedAccountIds].map((accountId) => ({
          accountId,
          extensionEnabled: extensionAccountIds.has(accountId),
          traderspostEnabled: traderspostAccountIds.has(accountId),
          runScheduled: runScheduledAccountIds.has(accountId),
        })),
      );
      if (!routes) {
        res.status(403).send(page('Forbidden', '<p>The selected account does not belong to this user.</p>'));
        return;
      }
      res.redirect(303, `/app/settings${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid route', '<p>Invalid route details.</p>'));
    }
  });

  app.post('/app/account/subscriptions/remove', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRemoveAccountSubscriptionsSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const removed = database.removeAllRangeRoutesForAccount(user.id, input.accountId);
      res.json({ removed });
    } catch {
      res.status(400).send(page('Invalid request', '<p>Invalid account details.</p>'));
    }
  });

  app.post('/app/account/subscriptions/copy', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webCopyAccountSubscriptionsSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const result = database.copyRangeRoutes(user.id, input.fromAccountId, input.toAccountId);
      if (!result) {
        res.status(403).send(page('Forbidden', '<p>Source and target must be two different active accounts belonging to this user.</p>'));
        return;
      }
      res.json(result);
    } catch {
      res.status(400).send(page('Invalid request', '<p>Invalid account details.</p>'));
    }
  });

  app.post('/app/range-routes/batch', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeRoutesBatchSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const raw = JSON.parse(input.rangeRoutesJson);
      if (!Array.isArray(raw)) {
        res.status(400).send(page('Invalid routes', '<p>Invalid batch route data.</p>'));
        return;
      }
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) {
          res.status(400).send(page('Invalid routes', '<p>Invalid batch route entry.</p>'));
          return;
        }
        if (typeof entry.rangeName !== 'string' || !entry.rangeName.trim() || entry.rangeName.length > 256) {
          res.status(400).send(page('Invalid routes', '<p>Invalid range name in batch.</p>'));
          return;
        }
        if (!Array.isArray(entry.routes)) {
          res.status(400).send(page('Invalid routes', '<p>Invalid routes list in batch.</p>'));
          return;
        }
      }
      for (const entry of raw) {
        const routes = (entry.routes as Array<{ accountId?: unknown; extensionEnabled?: unknown; traderspostEnabled?: unknown; runScheduled?: unknown }>)
          .filter((route) => typeof route.accountId === 'string' && (typeof route.extensionEnabled === 'boolean' || typeof route.extensionEnabled === 'number') && (typeof route.traderspostEnabled === 'boolean' || typeof route.traderspostEnabled === 'number'))
          .map((route) => ({
            accountId: String(route.accountId),
            extensionEnabled: Boolean(route.extensionEnabled),
            traderspostEnabled: Boolean(route.traderspostEnabled),
            runScheduled: Boolean(route.runScheduled),
          }));
        const saved = database.syncRangeRoutes(user.id, entry.rangeName as string, routes);
        if (!saved) {
          res.status(403).send(page('Forbidden', '<p>The selected account does not belong to this user.</p>'));
          return;
        }
      }
      res.redirect(303, `/app/settings${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid routes', '<p>Invalid batch route details.</p>'));
    }
  });

  app.post('/app/ranges/enroll', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeEnrollSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const sharedRangeExists = database.listTrackedRangeNames().includes(input.rangeName);
      if (!sharedRangeExists) {
        res.status(404).send(page('Not found', '<p>Range not found.</p>'));
        return;
      }
      const existingRoute = database.listRangeRoutes(user.id).find((route) => route.rangeName === input.rangeName);
      const route = database.upsertRangeRoute({
        userId: user.id,
        rangeName: input.rangeName,
        accountId: input.accountId,
        extensionEnabled: existingRoute?.extensionEnabled ?? false,
        traderspostEnabled: existingRoute?.traderspostEnabled ?? false,
        runScheduled: existingRoute?.runScheduled ?? false,
      });
      if (!route) {
        res.status(403).send(page('Forbidden', '<p>The selected account does not belong to this user.</p>'));
        return;
      }
      res.redirect(303, buildPath('/app/ranges', {
        ...(user.id === session.userId ? {} : { user: user.id }),
      }));
    } catch {
      res.status(400).send(page('Invalid enrollment', '<p>Invalid enrollment details.</p>'));
    }
  });

  app.post('/app/range-configurations', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeConfigurationSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const viewingUser = targetUser(session, input.targetUserId, res);
      if (!viewingUser) return;
      const sharedRangeExists = database.listTrackedRangeNames().includes(input.rangeName);
      if (!sharedRangeExists) {
        res.status(404).send(page('Not found', '<p>Range not found.</p>'));
        return;
      }
      const riskDollarsCents = parseDollars(input.riskDollars);
      const takeProfitTicksCents = parseDecimalWithCents(input.takeProfitTicks);
      const stopLossTicksCents = parseDecimalWithCents(input.stopLossTicks);
      const breakEvenTriggerTicksCents = parseDecimalWithCents(input.breakEvenTriggerTicks);
      const breakEvenOffsetTicksCents = parseDecimalWithCents(input.breakEvenOffsetTicks);
      if (
        riskDollarsCents == null
        || takeProfitTicksCents == null
        || stopLossTicksCents == null
        || breakEvenTriggerTicksCents == null
        || breakEvenOffsetTicksCents == null
      ) {
        res.status(400).send(page('Invalid range settings', '<p>Risk and tick values must be non-negative numbers or numeric strings with up to two decimal places.</p>'));
        return;
      }
      const saved = database.upsertRangeConfiguration({
        rangeName: input.rangeName,
        instrument: input.instrument,
        description: input.description,
        riskDollarsCents,
        rangeWindow: input.rangeWindow,
        tradingSession: input.tradingSession,
        takeProfitStyle: input.takeProfitStyle,
        takeProfitTicksCents,
        stopLossStyle: input.stopLossStyle,
        stopLossTicksCents,
        breakEvenEnabled: input.breakEvenEnabled === true,
        breakEvenTriggerTicksCents,
        breakEvenOffsetTicksCents,
        ocoMode: input.ocoMode,
        stopOnlyEntries: input.stopOnlyEntries !== false,
        runMonday: input.runMonday === true,
        runTuesday: input.runTuesday === true,
        runWednesday: input.runWednesday === true,
        runThursday: input.runThursday === true,
        runFriday: input.runFriday === true,
        runSaturday: input.runSaturday === true,
        runSunday: input.runSunday === true,
        entriesPerRange: input.entriesPerRange,
      });
      if (!saved) {
        res.status(404).send(page('Not found', '<p>Range not found.</p>'));
        return;
      }
      database.reconcileRangeCalendarVisibility(input.rangeName, session.userId, saved);
      res.redirect(303, `/app/ranges${viewingUser.id === session.userId ? '' : `?user=${encodeURIComponent(viewingUser.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid range settings', '<p>Review the range settings and try again.</p>'));
    }
  });

  app.post('/app/api/range-configurations/patch', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = rangeConfigurationPatchJsonSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token' });
        return;
      }
      const viewingUser = targetUser(session, input.targetUserId, res);
      if (!viewingUser) return;
      const existing = database.getRangeConfiguration(input.rangeName);
      const fallback = {
        rangeName: input.rangeName,
        instrument: '',
        description: '',
        riskDollarsCents: 0,
        rangeWindow: '0000-0000',
        tradingSession: '',
        takeProfitStyle: '',
        takeProfitTicksCents: 0,
        stopLossStyle: '',
        stopLossTicksCents: 0,
        breakEvenEnabled: false,
        breakEvenTriggerTicksCents: 0,
        breakEvenOffsetTicksCents: 0,
        ocoMode: 'oco' as const,
        stopOnlyEntries: true,
        runMonday: false,
        runTuesday: false,
        runWednesday: false,
        runThursday: false,
        runFriday: false,
        runSaturday: false,
        runSunday: false,
        entriesPerRange: 1,
      };
      const base = existing ?? fallback;
      const next = {
        rangeName: input.rangeName,
        instrument: input.instrument ?? base.instrument,
        description: input.description ?? base.description,
        riskDollarsCents: input.riskDollarsCents ?? base.riskDollarsCents,
        rangeWindow: input.rangeWindow ?? base.rangeWindow,
        tradingSession: input.tradingSession ?? base.tradingSession,
        takeProfitStyle: input.takeProfitStyle ?? base.takeProfitStyle,
        takeProfitTicksCents: input.takeProfitTicksCents ?? base.takeProfitTicksCents,
        stopLossStyle: input.stopLossStyle ?? base.stopLossStyle,
        stopLossTicksCents: input.stopLossTicksCents ?? base.stopLossTicksCents,
        breakEvenEnabled: input.breakEvenEnabled ?? base.breakEvenEnabled,
        breakEvenTriggerTicksCents: input.breakEvenTriggerTicksCents ?? base.breakEvenTriggerTicksCents,
        breakEvenOffsetTicksCents: input.breakEvenOffsetTicksCents ?? base.breakEvenOffsetTicksCents,
        ocoMode: input.ocoMode ?? base.ocoMode,
        stopOnlyEntries: input.stopOnlyEntries ?? base.stopOnlyEntries,
        runMonday: input.runMonday ?? base.runMonday,
        runTuesday: input.runTuesday ?? base.runTuesday,
        runWednesday: input.runWednesday ?? base.runWednesday,
        runThursday: input.runThursday ?? base.runThursday,
        runFriday: input.runFriday ?? base.runFriday,
        runSaturday: input.runSaturday ?? base.runSaturday,
        runSunday: input.runSunday ?? base.runSunday,
        entriesPerRange: input.entriesPerRange ?? base.entriesPerRange,
      };
      const saved = database.upsertRangeConfiguration(next as Omit<RangeConfiguration, 'createdAt' | 'updatedAt'>);
      if (!saved) {
        res.status(404).json({ error: 'Range not found' });
        return;
      }
      database.reconcileRangeCalendarVisibility(input.rangeName, session.userId, saved);
      res.json(saved);
    } catch {
      res.status(400).json({ error: 'Invalid range settings' });
    }
  });

  app.post('/app/api/range-configurations/bulk-days', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = rangeConfigurationBulkDaysSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token' });
        return;
      }
      const viewingUser = targetUser(session, input.targetUserId, res);
      if (!viewingUser) return;
      // A named model updates its members' per-range assignment days (the
      // schedule governing accounts routed through the model) — the ranges'
      // own run days stay untouched. 'Uncategorized'/empty keeps the legacy
      // behavior of writing each range's own run_* flags.
      const result = input.subcategoryName.trim()
        ? database.setSubcategoryMemberRunDays(input.subcategoryName, input.enabled)
        : database.setSubcategoryRunDays(input.subcategoryName, input.enabled, session.userId);
      res.json(result);
    } catch {
      res.status(400).json({ error: 'Invalid bulk run-day request' });
    }
  });

  app.post('/app/tracked-ranges', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webTrackedRangeSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const existing = database.findStoredRangeName(input.rangeName);
      if (existing) {
        res.status(409).json({ error: `Range "${existing}" already exists` });
        return;
      }
      const created = database.createTrackedRange(input.rangeName, session.userId);
      if (!created) {
        res.status(400).json({ error: 'Enter a valid range name' });
        return;
      }
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).json({ error: 'Invalid range name' });
    }
  });

  app.post('/app/range-subcategories', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeSubcategorySchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const created = database.createRangeSubcategory(input.name, session.userId);
      if (!created) {
        res.status(400).send(page('Invalid model', '<p>Review the model name and try again.</p>'));
        return;
      }
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid model', '<p>Review the model name and try again.</p>'));
    }
  });

  app.post('/app/range-subcategories/rename', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeSubcategoryRenameSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const renamed = database.renameRangeSubcategory(input.currentName, input.newName);
      if (!renamed) {
        res.status(400).send(page('Invalid model rename', '<p>Review the current and new model names and try again.</p>'));
        return;
      }
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid model rename', '<p>Review the current and new model names and try again.</p>'));
    }
  });

  app.post('/app/range-subcategories/color', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeSubcategoryColorSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      database.updateRangeSubcategoryColor(input.name, input.color || null);
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid model color', '<p>Review the model and color value and try again.</p>'));
    }
  });

  app.post('/app/range-subcategories/delete', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeSubcategoryDeleteSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const deleted = database.deleteRangeSubcategory(input.name);
      if (!deleted) {
        res.status(404).send(page('Not found', '<p>Model not found.</p>'));
        return;
      }
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid model delete', '<p>Review the model delete request and try again.</p>'));
    }
  });

  app.post('/app/range-subcategory-assignments', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeSubcategoryAssignmentSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const subcategoryName = input.subcategoryName?.trim() || undefined;
      // 'replace' keeps the legacy semantics — the range's membership becomes
      // exactly this model (or none). 'add'/'remove' toggle a single
      // membership and preserve the rest, for shared ranges.
      const assigned = input.mode === 'add'
        ? (subcategoryName ? database.addRangeSubcategoryAssignment(input.rangeName, subcategoryName, session.userId) : false)
        : input.mode === 'remove'
          ? (subcategoryName ? database.removeRangeSubcategoryAssignment(input.rangeName, subcategoryName) : false)
          : database.assignRangeSubcategory(input.rangeName, subcategoryName, session.userId);
      if (!assigned) {
        res.status(404).send(page('Not found', '<p>Range or model not found.</p>'));
        return;
      }
      res.redirect(303, buildPath('/app/ranges', {
        ...(user.id === session.userId ? {} : { user: user.id }),
        ...(input.timeframe && input.timeframe !== 'all' ? { timeframe: input.timeframe } : {}),
      }));
    } catch {
      res.status(400).send(page('Invalid model assignment', '<p>Review the model selection and try again.</p>'));
    }
  });

  // Per-model run-day schedule for one range: each day flag is true/false to
  // govern accounts routed through this model, or null to inherit the range's
  // own run day. Returns the updated assignment row.
  app.post('/app/api/range-subcategory-schedule', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = subcategoryDayFlagsSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token' });
        return;
      }
      const saved = database.setRangeSubcategorySchedule(input.rangeName, input.subcategoryName, {
        ...(input.runMonday !== undefined ? { runMonday: input.runMonday } : {}),
        ...(input.runTuesday !== undefined ? { runTuesday: input.runTuesday } : {}),
        ...(input.runWednesday !== undefined ? { runWednesday: input.runWednesday } : {}),
        ...(input.runThursday !== undefined ? { runThursday: input.runThursday } : {}),
        ...(input.runFriday !== undefined ? { runFriday: input.runFriday } : {}),
        ...(input.runSaturday !== undefined ? { runSaturday: input.runSaturday } : {}),
        ...(input.runSunday !== undefined ? { runSunday: input.runSunday } : {}),
      });
      if (!saved) {
        res.status(404).json({ error: 'Range or model membership not found' });
        return;
      }
      res.json(saved);
    } catch {
      res.status(400).json({ error: 'Invalid model day schedule' });
    }
  });

  app.post('/app/ranges/move', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Only the admin can move range history.</p>'));
      return;
    }
    try {
      const input = webRangeMoveSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const result = database.moveRangeHistory(input.sourceRangeName, input.targetRangeName);
      if (!result) {
        res.status(404).send(page('Not found', '<p>The source range must already exist, and the source and target names must be different.</p>'));
        return;
      }
      replayTrackedRangeLifecycleHistory(result.targetRangeName);
      res.redirect(303, buildPath('/app/ranges', {
        ...(input.targetUserId && input.targetUserId !== session.userId ? { user: input.targetUserId } : {}),
      }));
    } catch {
      res.status(400).send(page('Invalid range move', '<p>Review the source and target range names and try again.</p>'));
    }
  });

  app.post('/app/ranges/rename', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeRenameSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const result = database.moveRangeHistory(input.currentRangeName, input.newRangeName);
      if (!result) {
        res.status(404).send(page('Not found', '<p>The current range must already exist, and the new name must be different.</p>'));
        return;
      }
      replayTrackedRangeLifecycleHistory(result.targetRangeName);
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid range rename', '<p>Review the exact range name and try again.</p>'));
    }
  });

  app.post('/app/debugging/untracked-ranges/reassign', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    if (session.email !== adminUserEmail) {
      res.status(403).send(page('Forbidden', '<p>Only the admin can reassign untracked range history.</p>'));
      return;
    }
    try {
      const input = webUntrackedRangeReassignmentSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      if (database.isRangeExplicitlyTracked(input.sourceRangeName)) {
        res.status(400).send(page('Invalid reassignment', '<p>The incoming range name is already tracked.</p>'));
        return;
      }
      if (!database.isRangeExplicitlyTracked(input.targetRangeName)) {
        res.status(404).send(page('Not found', '<p>The target range must already be tracked.</p>'));
        return;
      }
      const result = database.moveRangeHistory(input.sourceRangeName, input.targetRangeName);
      if (!result) {
        res.status(404).send(page('Not found', '<p>The source range must already exist, and the source and target names must be different.</p>'));
        return;
      }
      replayTrackedRangeLifecycleHistory(result.targetRangeName);
      const redirectPath = input.returnView === 'alerts' ? '/app/alerts' : '/app/debugging';
      res.redirect(303, buildPath(redirectPath, {
        ...(input.targetUserId && input.targetUserId !== session.userId && redirectPath !== '/app/alerts' ? { user: input.targetUserId } : {}),
      }));
    } catch {
      res.status(400).send(page('Invalid reassignment', '<p>Review the source and target range names and try again.</p>'));
    }
  });

  app.post('/app/debugging/reprocess-lifecycle', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webReprocessLifecycleSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const allTracked = input.rangeName === '*';
      const rangeName = allTracked ? undefined : input.rangeName;
      const alerts = database.listProxyAlertsForReprocess(rangeName, input.limit, allTracked);
      const result = await reprocessLifecycleAlerts(alerts, input.runScheduledOnly, session.userId);
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.get('/app/api/debugging/armed-instruments', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const accountId = req.query.accountId;
      if (!accountId || typeof accountId !== 'string') {
        res.status(400).json({ error: 'accountId query parameter is required' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      const account = database.findAccountById(accountId);
      if (!account) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      const instruments = database.listArmedInstrumentsForAccount(account.id);
      res.json({ instruments });
    } catch (error) {
      next(error);
    }
  });

  app.post('/app/api/debugging/send-test-exit', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({
        accountId: z.string().uuid(),
        instrument: z.string().min(1),
        exitType: z.enum(['reapply', 'lifecycle', 'exit-all']),
      }).parse(req.body);
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      const account = database.findAccountById(input.accountId);
      if (!account || account.userId !== session.userId) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      const destinations = database.listTradersPostAccountDestinations(session.userId);
      const destination = destinations.find((d) => d.accountId === input.accountId);
      if (!destinationCanSend(destination)) {
        res.status(400).json({ error: 'Broker destination not configured or disabled' });
        return;
      }
      const time = new Date().toISOString();
      let baseExtras: Record<string, unknown> = {
        source: 'server-v5.0',
        rangeName: 'DEBUG-TEST',
      };
      if (input.exitType === 'reapply' || input.exitType === 'lifecycle') {
        baseExtras = {
          ...baseExtras,
          lifecycleExit: 'trade_closed',
          exitReason: 'stop_loss',
        };
        if (input.exitType === 'reapply') {
          baseExtras.reapplyOnTradeClose = true;
        }
      } else {
        baseExtras = {
          source: 'bridge-eod-scheduler',
          reason: 'eod_exit',
          rangeName: 'DEBUG-TEST',
        };
      }
      const basePayload: TradersPostPayload = {
        ticker: input.instrument,
        action: 'exit',
        quantity: 100,
        quantityType: 'percent_of_position',
        orderType: 'market',
        cancel: true,
        time,
        extras: baseExtras,
      };
      const payloadJson = JSON.stringify(basePayload);
      const rangeConfiguration = database.getRangeConfiguration('DEBUG-TEST') ?? undefined;
      const openInstrumentSet = new Set<string>();
      openInstrumentSet.add(input.instrument);
      const prepared = prepareTradersPostDestinationPayloads(
        payloadJson,
        { ...destination, accountId: account.id },
        rangeConfiguration,
        openInstrumentSet,
      );
      if (prepared.protectionError) {
        res.status(400).json({ error: prepared.protectionError });
        return;
      }
      if (prepared.payloadJsons.length === 0) {
        res.status(400).json({ error: 'No payload to send' });
        return;
      }
      const outboundPayloadJson = prepared.payloadJsons[0];
      const crossTrade: CrossTradeDestination | undefined = isCrossTradeConfigured(destination)
        ? {
            webhookUrl: destination.crossTradeWebhookUrl!,
            secretKey: destination.crossTradeSecretKey!,
            accountName: destination.crossTradeAccountName || account.name,
          }
        : undefined;
      const outboundBody = crossTrade
        ? JSON.stringify(toCrossTradeMessage(
            JSON.parse(outboundPayloadJson) as TradersPostPayload,
            crossTrade,
            `debug_test_${input.exitType}`,
          ))
        : outboundPayloadJson;
      const requestPayload = JSON.parse(outboundBody) as Record<string, unknown>;
      if (crossTrade && 'key' in requestPayload) requestPayload.key = '[redacted]';
      const sentAt = new Date().toISOString();
      database.createBridgeLog(session.userId, 'traderspost', {
        category: 'traderspost',
        phase: 'request',
        timestamp: sentAt,
        accountId: account.id,
        accountName: account.name,
        source: `debug_test_${input.exitType}`,
        rangeName: 'DEBUG-TEST',
        payload: requestPayload,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchImplementation(crossTrade?.webhookUrl ?? destination.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: outboundBody,
          signal: controller.signal,
        });
        const responseBody = await response.text();
        let tradersPostBody: { success?: boolean } | undefined;
        try {
          tradersPostBody = JSON.parse(responseBody) as { success?: boolean };
        } catch {
          tradersPostBody = undefined;
        }
        const success = response.ok && tradersPostBody?.success !== false;
        database.createBridgeLog(session.userId, 'traderspost', {
          category: 'traderspost',
          phase: 'response',
          timestamp: new Date().toISOString(),
          accountId: account.id,
          accountName: account.name,
          source: `debug_test_${input.exitType}`,
          rangeName: 'DEBUG-TEST',
          statusCode: response.status,
          httpSuccess: response.ok,
          tradersPostSuccess: tradersPostBody?.success,
          success,
          responseBody,
          payload: requestPayload,
        });
        res.json({
          statusCode: response.status,
          success,
          responseBody,
          payloadSent: requestPayload,
        });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      next(error);
    }
  });

  app.post('/app/debugging/reconcile-bookkeeping', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webReconcileBookkeepingSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      const accounts = input.accountId === '*'
        ? database.listUsers().flatMap((u) => database.listAccounts(u.id)).filter((a) => !a.deprecated)
        : [database.findAccountById(input.accountId)].filter((a): a is NonNullable<typeof a> => a != null);
      if (accounts.length === 0) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      const occurredAt = new Date().toISOString();
      let ordersCancelled = 0;
      let positionsClosed = 0;
      let skippedCrypto = 0;
      const details: string[] = [];
      for (const account of accounts) {
        if (input.mode !== 'positions') {
          for (const order of database.getOpenBracketOrdersForAccount(account.id)) {
            if (!input.includeCrypto && isCryptoFutureTicker(order.ticker)) {
              skippedCrypto += 1;
              continue;
            }
            if (!order.rangeName) continue;
            recordBridgeGeneratedEntryCancelled(
              { userId: account.userId, accountId: account.id },
              {
                ticker: order.ticker,
                action: 'cancel',
                tradeId: order.tradeId,
                quantity: order.quantity,
                bracketSide: order.side,
                extras: { rangeName: order.rangeName, reason: 'reconcile_open_orders' },
              },
              occurredAt,
            );
            ordersCancelled += 1;
            details.push(`[${account.name}] order ${order.tradeId} (${order.ticker} ${order.side} x${order.quantity} @ ${order.rangeName})`);
          }
        }
        if (input.mode !== 'orders') {
          for (const instrument of database.getAccountOpenInstruments(account.id)) {
            if (!input.includeCrypto && isCryptoFutureTicker(instrument)) {
              skippedCrypto += 1;
              continue;
            }
            const closed = recordFlattenedPositions(account.userId, account.id, instrument, occurredAt, undefined, 'eod');
            positionsClosed += closed;
            if (closed > 0) details.push(`[${account.name}] flattened ${closed} ${instrument} position(s) as breakeven`);
          }
        }
      }
      res.json({ success: true, ordersCancelled, positionsClosed, skippedCrypto, details });
    } catch (error) {
      next(error);
    }
  });

  app.post('/app/debugging/reconcile-previous-days', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webReconcileYesterdaySchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      const cutoff = database.getJournalDayStartISO();
      const rows = database.listStaleBracketMonitorEntries(cutoff);
      let filledClosed = 0;
      let armedCancelled = 0;
      let skipped = 0;
      const now = new Date().toISOString();
      for (const row of rows) {
        const account = database.findAccountById(row.accountId);
        if (!account) {
          skipped += 1;
          continue;
        }
        if (row.state === 'filled') {
          try {
            database.createTradeEvent({
              userId: account.userId,
              accountId: row.accountId,
              rangeName: row.rangeName,
              eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-exit_filled`,
              tradeId: row.tradeId,
              eventType: 'exit_filled',
              instrument: row.instrument,
              side: row.side,
              action: 'exit',
              quantity: row.quantity,
              occurredAt: now,
              ...(row.entryPrice != null ? { entryPrice: row.entryPrice } : {}),
            });
          } catch (error) {
            console.warn('[reconcile-yesterday] Failed to record exit_filled', {
              tradeId: row.tradeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          try {
            const { event: closedEvent } = database.createTradeEvent({
              userId: account.userId,
              accountId: row.accountId,
              rangeName: row.rangeName,
              eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-trade_closed`,
              tradeId: row.tradeId,
              eventType: 'trade_closed',
              instrument: row.instrument,
              side: row.side,
              action: 'exit',
              quantity: row.quantity,
              occurredAt: now,
              realizedTicksCents: 0,
              realizedDollarsCents: 0,
              outcome: 'breakeven',
              ...(row.entryPrice != null ? { entryPrice: row.entryPrice, exitPrice: row.entryPrice } : {}),
            });
            database.retireBracketMonitorEntry(account.userId, row, 'trade_closed', closedEvent.eventId, now);
            filledClosed += 1;
          } catch (error) {
            console.warn('[reconcile-yesterday] Failed to record breakeven trade_closed', {
              tradeId: row.tradeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (row.state === 'armed') {
          try {
            database.createTradeEvent({
              userId: account.userId,
              accountId: row.accountId,
              rangeName: row.rangeName,
              eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-entry_cancelled`,
              tradeId: row.tradeId,
              eventType: 'entry_cancelled',
              instrument: row.instrument,
              side: row.side,
              action: 'cancel',
              quantity: row.quantity,
              occurredAt: now,
            });
          } catch (error) {
            console.warn('[reconcile-yesterday] Failed to record entry_cancelled', {
              tradeId: row.tradeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          try {
            const { event: closedEvent } = database.createTradeEvent({
              userId: account.userId,
              accountId: row.accountId,
              rangeName: row.rangeName,
              eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-trade_closed`,
              tradeId: row.tradeId,
              eventType: 'trade_closed',
              instrument: row.instrument,
              side: row.side,
              action: 'exit',
              quantity: row.quantity,
              occurredAt: now,
              realizedTicksCents: 0,
              realizedDollarsCents: 0,
              outcome: 'breakeven',
            });
            database.setTradeEventPerformanceExclusion(account.userId, closedEvent.id, 'erroneous', account.userId);
            database.retireBracketMonitorEntry(account.userId, row, 'trade_closed', closedEvent.eventId, now);
            armedCancelled += 1;
          } catch (error) {
            console.warn('[reconcile-yesterday] Failed to record erroneous trade_closed', {
              tradeId: row.tradeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      res.json({ success: true, filledClosed, armedCancelled, skipped, total: rows.length });
    } catch (error) {
      next(error);
    }
  });

  app.post('/app/trade-exclusions', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webTradeExclusionSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const reasons = [
        input.testData === 'true' ? 'test_data' : undefined,
        input.erroneous === 'true' ? 'erroneous' : undefined,
      ].filter((value): value is PerformanceExclusionReason => value != null);
      if (reasons.length > 1) {
        res.status(400).send(page('Invalid flags', '<p>Select only one exclusion reason for each trade.</p>'));
        return;
      }
      const updated = database.setTradeEventPerformanceExclusion(
        user.id,
        input.eventId,
        reasons[0],
        session.userId,
      );
      if (!updated) {
        res.status(404).send(page('Not found', '<p>Trade record not found.</p>'));
        return;
      }
      res.redirect(303, buildPath('/app', {
        ...(user.id === session.userId ? {} : { user: user.id }),
        ...(input.returnAccountId ? { account: input.returnAccountId } : {}),
        ...(input.returnMonth ? { month: input.returnMonth } : {}),
      }));
    } catch {
      res.status(400).send(page('Invalid exclusion', '<p>Review the exclusion settings and try again.</p>'));
    }
  });

  app.post('/app/trade-events/delete', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webTradeEventDeleteSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const deleted = database.deleteTradeEvent(user.id, input.eventId);
      if (!deleted) {
        res.status(404).send(page('Not found', '<p>Trade record not found.</p>'));
        return;
      }
      res.sendStatus(204);
    } catch {
      res.status(400).send(page('Invalid trade delete', '<p>Review the trade delete request and try again.</p>'));
    }
  });

  app.post('/app/ranges/delete', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeDeleteSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const deleted = database.deleteRange(input.rangeName);
      if (!deleted) {
        res.status(404).send(page('Not found', '<p>Range not found.</p>'));
        return;
      }
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid range delete', '<p>Review the range delete request and try again.</p>'));
    }
  });

  app.post('/app/range-review-flags', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webRangeReviewFlagSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const exists = database.listTrackedRangeNames().includes(input.rangeName);
      if (!exists) {
        res.status(404).send(page('Not found', '<p>Range not found.</p>'));
        return;
      }
      const selectedReasons = [
        input.testData === 'true' ? 'test_data' : undefined,
        input.erroneous === 'true' ? 'erroneous' : undefined,
      ].filter((reason): reason is 'test_data' | 'erroneous' => Boolean(reason));
      if (selectedReasons.length > 1) {
        res.status(400).send(page('Invalid range flag', '<p>Select either Test data or Erroneous, not both.</p>'));
        return;
      }
      if (selectedReasons[0]) {
        database.upsertRangeReviewFlag(input.rangeName, session.userId, selectedReasons[0]);
      } else {
        database.clearRangeReviewFlag(input.rangeName, session.userId);
      }
      res.redirect(303, `/app/ranges${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid range flag', '<p>Review the range flag and try again.</p>'));
    }
  });

  app.post('/app/traderspost-destination', (req, res) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = webTradersPostAccountDestinationSchema.parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).send(page('Forbidden', '<p>Invalid form token.</p>'));
        return;
      }
      const user = targetUser(session, input.targetUserId, res);
      if (!user) return;
      const outboundTickerMode = normalizeOutboundTickerMode(input.outboundTickerMode);
      const outboundTicker = input.outboundTickerMode === 'exact' ? normalizeOutboundTicker(input.outboundTicker) : undefined;
      const useLimitPriceTP = input.useLimitPriceTP === 'true';
      const useAlertTP = input.useAlertTP === 'true';
      const reapplyOnTradeCloseEnabled = input.reapplyOnTradeCloseEnabled === 'true';
      const enabled = input.enabled === 'true';
      const eodTimeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
      const eodCancelTime = input.eodCancelTime && eodTimeRegex.test(input.eodCancelTime) ? input.eodCancelTime : '16:30';
      const eodExitTime = input.eodExitTime && eodTimeRegex.test(input.eodExitTime) ? input.eodExitTime : '16:45';
      const eodEnabled = input.eodEnabled === 'true';
      const newsFlattenEnabled = input.newsFlattenEnabled === 'true';
      const newsFlattenMinutes = input.newsFlattenMinutes ?? 5;
      if (input.outboundTickerMode === 'exact' && !outboundTicker) {
        res.status(400).send(page('Invalid destination', '<p>Enter an exact outbound ticker when Exact ticker is selected.</p>'));
        return;
      }
      const crossTrade = resolveCrossTradeFields(input, database.getTradersPostAccountDestination(input.accountId));
      if (crossTrade === 'missing-key') {
        res.status(400).send(page('Invalid destination', '<p>CrossTrade requires its secret key alongside the webhook URL.</p>'));
        return;
      }
      if (input.crossTradeEnabled === 'false'
          && crossTrade.webhookUrl
          && input.webhookUrl === crossTrade.webhookUrl) {
        res.status(400).send(page('Invalid destination', '<p>Parking CrossTrade requires a distinct TradersPost webhook — the primary URL still points at the CrossTrade endpoint, which would receive TradersPost payloads.</p>'));
        return;
      }
      const destination = database.upsertTradersPostAccountDestination(
        user.id,
        input.accountId,
        input.webhookUrl,
        outboundTicker,
        outboundTickerMode,
        enabled,
        useLimitPriceTP,
        useAlertTP,
        eodCancelTime,
        eodExitTime,
        eodEnabled,
        newsFlattenEnabled,
        newsFlattenMinutes,
        reapplyOnTradeCloseEnabled,
        crossTrade,
        input.quantityOverrideMode && input.quantityOverrideMode !== 'off' && input.quantityOverrideValue != null
          ? { mode: input.quantityOverrideMode, value: input.quantityOverrideValue }
          : undefined,
      );
      if (!destination) {
        res.status(403).send(page('Forbidden', '<p>The selected account does not belong to this user.</p>'));
        return;
      }
      res.redirect(303, `/app/accounts${user.id === session.userId ? '' : `?user=${encodeURIComponent(user.id)}`}`);
    } catch {
      res.status(400).send(page('Invalid destination', '<p>Enter a valid HTTPS TradersPost webhook URL.</p>'));
    }
  });

  // Sends instrument-scoped cancel/exit to TradersPost for each root, then reconciles
  // Bridge bookkeeping only for roots whose flatten was accepted. Shared by the
  // account-level safeguard button and the debugging flatten endpoint.
  const runCancelAllSafeguard = async (
    account: BridgeAccount,
    destination: TradersPostAccountDestination,
    roots: Set<string>,
  ): Promise<{
    instruments: string[];
    sent: number;
    errors: number;
    results: Array<{ instrument: string; ok: boolean; status?: number; error?: string }>;
    reconciled: {
      flattenedPositions: number;
      resolvedReapplyOps: number;
      closedBrokerOrders: number;
      retiredDeliveries: number;
    };
  }> => {
    // Serialize with the reapply coordinator's queue so an in-flight reapply cannot
    // interleave with the flatten or recreate broker state after it is resolved here.
    // A flatten runs many sequentially-capped sends, so it needs a batch-sized
    // watchdog bound — the task signal stops the loop promptly if it ever fires.
    return reapply.queue.run(account.id, async (taskSignal) => {
    const instruments = new Set<string>();
    const now = new Date();
    const monthCode = FUTURES_MONTH_LETTERS[now.getMonth()];
    const yearPart = String(now.getFullYear() % 100).padStart(2, '0');
    for (const root of roots) {
      instruments.add(`${root}1!`);
      instruments.add(`${root}${monthCode}${yearPart}`);
    }
    if (instruments.size === 0) {
      return { instruments: [], sent: 0, errors: 0, results: [], reconciled: { flattenedPositions: 0, resolvedReapplyOps: 0, closedBrokerOrders: 0, retiredDeliveries: 0 } };
    }
    const crossTrade: CrossTradeDestination | undefined = isCrossTradeConfigured(destination)
      ? {
          webhookUrl: destination.crossTradeWebhookUrl!,
          secretKey: destination.crossTradeSecretKey!,
          accountName: destination.crossTradeAccountName || account.name,
        }
      : undefined;
    const results: Array<{ instrument: string; ok: boolean; status?: number; error?: string }> = [];
    let sent = 0;
    let errors = 0;
    const sentTickers = new Set<string>();
    const safeguardOccurredAt = new Date().toISOString();
    const sendOne = async (ticker: string, basePayload: TradersPostPayload, taskSignal: AbortSignal) => {
      if (sentTickers.has(ticker)) return;
      sentTickers.add(ticker);
      const cancelPayload = { ...basePayload, ticker };
      const cancelPayloadJson = JSON.stringify(cancelPayload);
      // CT destinations get the command shape (cancelorders/flatten); TP gets
      // the raw cancel/exit payload. Same ledger bookkeeping either way.
      const outboundBody = crossTrade
        ? JSON.stringify(toCrossTradeMessage(cancelPayload, crossTrade, 'safeguard'))
        : cancelPayloadJson;
      const orderId = `bridge-safeguard-${randomUUID()}`;
      // The transport retry gets its own broker_orders row (-r<n> suffix like the
      // dispatch path) so the failed send's evidence is not overwritten.
      let activeOrderId = orderId;
      database.createBrokerOrder({
        accountId: account.id,
        rangeName: '(safeguard)',
        orderId,
        action: 'exit',
        status: 'pending',
        instrument: ticker,
        occurredAt: safeguardOccurredAt,
      });
      try {
      await traderspostRateLimiter.run(account.id, async (limiterSignal) => {
      // Either watchdog releasing means this is post-release work: the queue
      // moved on, so do not fetch or mutate the safeguard ledger — except that
      // an outer-task abort resolves run() normally (only the inner limiter's
      // own watchdog rejects it), so that release must record the send
      // uncertain here or the pending broker order is orphaned.
      const recordReleasedSend = () => {
        if (limiterSignal.aborted) return true;
        if (!taskSignal.aborted) return false;
        const error = 'Flatten released by the account queue watchdog before the send settled';
        errors += 1;
        results.push({ instrument: ticker, ok: false, error });
        database.updateBrokerOrderStatus(account.id, activeOrderId, 'uncertain', error);
        return true;
      };
      if (recordReleasedSend()) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      // Same hard cap as the dispatch path — a stuck fetch must settle into an
      // uncertain order so the flatten can continue with the next instrument.
      let hardTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const hardTimeout = new Promise<never>((_, reject) => {
        hardTimeoutHandle = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error('request never settled'), { name: 'AbortError' }));
        }, options.traderspostHardTimeoutMs ?? 20_000);
      });
      try {
        const { response, responseBody } = await (async () => {
          for (let sendAttempt = 0; ; sendAttempt++) {
            let res: Awaited<ReturnType<typeof fetchImplementation>>;
            try {
              if (sendAttempt > 0) {
                await abortableDelay(TRADERSPOST_TRANSPORT_RETRY_DELAY_MS, [controller.signal, taskSignal, limiterSignal]);
                if (limiterSignal.aborted || taskSignal.aborted) {
                  throw limiterSignal.reason ?? taskSignal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
                }
                activeOrderId = `${orderId}-r${sendAttempt}`;
                database.createBrokerOrder({
                  accountId: account.id,
                  rangeName: '(safeguard)',
                  orderId: activeOrderId,
                  action: 'exit',
                  status: 'pending',
                  instrument: ticker,
                  occurredAt: safeguardOccurredAt,
                });
              }
              res = await Promise.race([
                fetchImplementation(crossTrade?.webhookUrl ?? destination.webhookUrl, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: outboundBody,
                  signal: AbortSignal.any([controller.signal, taskSignal, limiterSignal]),
                }),
                hardTimeout,
              ]);
            } catch (sendError) {
              // Safeguard sends are cancel/exit flatten legs — idempotent at the
              // broker — so timeouts retry as well as transport failures.
              if (limiterSignal.aborted || taskSignal.aborted || sendAttempt >= TRADERSPOST_TRANSPORT_RETRIES || !(isTransportFetchError(sendError) || isAbortFetchError(sendError))) {
                throw sendError;
              }
              const retryReason = `${sendError instanceof Error ? sendError.message : String(sendError)}${describeErrorCause(sendError) ? ` — ${describeErrorCause(sendError)}` : ''}`;
              // The failed send may still have reached TradersPost — keep its
              // ledger row uncertain rather than overwriting it with the retry.
              database.updateBrokerOrderStatus(account.id, activeOrderId, 'uncertain', `Transport attempt failed (retrying once): ${retryReason}`);
              console.warn('[cancel-all-safeguard] TradersPost transport retry', {
                accountId: account.id,
                instrument: ticker,
                error: sendError instanceof Error ? sendError.message : String(sendError),
                cause: describeErrorCause(sendError),
              });
              continue;
            }
            // Body-read failures happen after the POST was accepted — retrying
            // them could duplicate the flatten send, so they stay single-shot.
            const body = await Promise.race([res.text().catch(() => ''), hardTimeout]);
            return { response: res, responseBody: body };
          }
        })();
        if (recordReleasedSend()) return;
        let bodySuccess: boolean | undefined;
        let failureMessage: string | undefined;
        try {
          const parsedBody = JSON.parse(responseBody) as { success?: boolean; failureMessage?: string };
          bodySuccess = parsedBody?.success;
          failureMessage = parsedBody?.failureMessage;
        } catch {}
        // The safeguard reconciles local state only on an explicit body-level ack — a
        // bare 2xx without success:true stays uncertain so a malformed response cannot
        // make the bridge appear flat when TradersPost did not confirm the flatten.
        if (response.ok && bodySuccess === true) {
          sent += 1;
          results.push({ instrument: ticker, ok: true, status: response.status });
          database.updateBrokerOrderStatus(account.id, activeOrderId, 'acknowledged');
        } else {
          errors += 1;
          const error = `${response.status} ${response.statusText} ${(failureMessage ?? responseBody).slice(0, 200)}`.trim();
          results.push({ instrument: ticker, ok: false, status: response.status, error });
          // A body-level or 4xx rejection is definite; a 5xx/timeout may still have
          // reached the broker, so keep the ledger row uncertain for reconciliation.
          const definiteReject = response.status < 500 && response.status !== 408 && (bodySuccess === false || response.status >= 400);
          database.updateBrokerOrderStatus(account.id, activeOrderId, definiteReject ? 'rejected' : 'uncertain', error);
          console.warn('[cancel-all-safeguard] TradersPost error', {
            accountId: account.id,
            instrument: ticker,
            status: response.status,
            response: error.slice(0, 500),
          });
        }
      } catch (err) {
        // Post-release: the outer catch already recorded this instrument's
        // failure — a zombie callback must not re-mutate the ledger.
        if (recordReleasedSend()) return;
        errors += 1;
        const rawError = err instanceof Error ? err.message : String(err);
        const error = describeErrorCause(err) ? `${rawError} — ${describeErrorCause(err)}` : rawError;
        results.push({ instrument: ticker, ok: false, error });
        database.updateBrokerOrderStatus(account.id, activeOrderId, 'uncertain', error);
        console.warn('[cancel-all-safeguard] TradersPost request failed', {
          accountId: account.id,
          instrument: ticker,
          error,
        });
      } finally {
        clearTimeout(timeout);
        clearTimeout(hardTimeoutHandle);
      }
    });
      } catch (err) {
        // Queue-level failure (e.g. the watchdog released a never-settling task):
        // record it and continue — one instrument must not abort the flatten.
        errors += 1;
        const error = err instanceof Error ? err.message : String(err);
        results.push({ instrument: ticker, ok: false, error });
        database.updateBrokerOrderStatus(account.id, activeOrderId, 'uncertain', error);
      }
    };
    const openBrackets = database.getOpenBracketOrdersForAccount(account.id);
    for (const instrument of instruments) {
      // Month-coded tickers (NQU26) normalize to continuous before destination mapping —
      // micros_only only rewrites continuous tickers, so an unmapped month contract would
      // both send the wrong instrument and fail the root comparison during reconcile.
      const basePayload = buildExplicitMarketExitPayload({
        ticker: normalizeTradersPostTicker(instrument) ?? instrument,
        time: new Date().toISOString(),
        extras: { cancelAll: true },
      } as unknown as ExitPayload, {
        outboundTicker: destination.outboundTicker,
        outboundTickerMode: destination.outboundTickerMode,
      });
      // Ordinary entries re-normalize the resolved outbound ticker to continuous —
      // apply the same rule so an exact month-coded destination (MNQU26) flattens the
      // same instrument the entries actually went out on (MNQ1!).
      const actualTicker = normalizeTradersPostTicker(basePayload.ticker) ?? basePayload.ticker;
      basePayload.ticker = actualTicker;
      for (const cancelTicker of [actualTicker, ...getMonthNeighbors(actualTicker)]) {
        if (taskSignal.aborted) {
          results.push({ instrument: cancelTicker, ok: false, error: 'Flatten aborted: task watchdog released the account queue' });
          break;
        }
        await sendOne(cancelTicker, basePayload, taskSignal);
      }
      if (taskSignal.aborted) break;
    }
    if (taskSignal.aborted) {
      // The queue already released this account — a subsequent dispatch may be
      // live now, so reconciliation must not run and close its fresh rows.
      return {
        instruments: [...instruments],
        sent,
        errors,
        results,
        reconciled: { flattenedPositions: 0, resolvedReapplyOps: 0, closedBrokerOrders: 0, retiredDeliveries: 0 },
      };
    }
    // Sent tickers are already outbound-mapped; compare local bookkeeping through the
    // same destination mapping so overrides and micros_only reconcile correctly.
    const okRoots = new Set(
      results
        .filter((r) => r.ok)
        .map((r) => continuousTickerRoot(r.instrument))
        .filter((root): root is string => Boolean(root)),
    );
    for (const bracket of openBrackets) {
      const bracketRoot = destinationTickerRoot(bracket.ticker, destination);
      if (!bracket.rangeName || !bracketRoot || !okRoots.has(bracketRoot)) continue;
      recordBridgeGeneratedEntryCancelled(
        { userId: account.userId, accountId: account.id },
        {
          ticker: bracket.ticker,
          action: 'cancel',
          tradeId: bracket.tradeId,
          quantity: bracket.quantity,
          bracketSide: bracket.side,
          extras: { rangeName: bracket.rangeName, reason: 'cancel_all_safeguard' },
        },
        safeguardOccurredAt,
      );
    }
    // Bookkeeping reconcile for instruments where TradersPost accepted the flatten.
    // Iterate the account's actual stored open instruments — the generated
    // continuous/current-month tickers only decide whether the outbound flatten
    // was accepted; a position recorded under another contract (a neighbor month
    // or a differently rooted ticker for the same destination root) must still
    // reconcile, or the safeguard can appear flat while the journal stays open.
    let flattenedPositions = 0;
    for (const instrument of database.getAccountOpenInstruments(account.id)) {
      const instrumentRoot = destinationTickerRoot(instrument, destination);
      if (!instrumentRoot || !okRoots.has(instrumentRoot)) continue;
      flattenedPositions += recordFlattenedPositions(
        account.userId,
        account.id,
        instrument,
        safeguardOccurredAt,
        undefined,
        'cancel_all_safeguard',
      );
    }
    let resolvedReapplyOps = 0;
    for (const op of database.listIncompleteReapplyOperations()) {
      if (op.accountId !== account.id) continue;
      const opRoot = destinationTickerRoot(op.instrument, destination);
      if (!opRoot || !okRoots.has(opRoot)) continue;
      op.completed = true;
      op.reason = 'Superseded by cancel-all safeguard';
      database.saveReapplyOperation(op);
      resolvedReapplyOps += 1;
    }
    let closedBrokerOrders = 0;
    for (const order of database.listOpenBrokerOrdersByAccount(account.id)) {
      const orderRoot = destinationTickerRoot(order.instrument, destination);
      if (!orderRoot || !okRoots.has(orderRoot)) continue;
      database.updateBrokerOrderStatus(
        account.id,
        order.orderId,
        order.action === 'buy' || order.action === 'sell' ? 'cancelled' : 'closed',
        'cancel_all_safeguard', undefined, 'bridge',
      );
      closedBrokerOrders += 1;
    }
    let retiredDeliveries = 0;
    for (const pending of database.listPendingTradersPostDeliveries(account.id)) {
      const deliveryRoot = destinationTickerRoot(pending.ticker, destination);
      if (!deliveryRoot || !okRoots.has(deliveryRoot)) continue;
      database.createProxyDeliveryAttempt({
        proxyDeliveryId: pending.id,
        success: false,
        errorText: 'Superseded by cancel-all safeguard',
      });
      database.updateProxyDeliveryStatus(pending.id, 'suppressed_safeguard');
      retiredDeliveries += 1;
    }
    return {
      instruments: [...instruments],
      sent,
      errors,
      results,
      reconciled: {
        flattenedPositions,
        resolvedReapplyOps,
        closedBrokerOrders,
        retiredDeliveries,
      },
    };
    // Every send inside is hard-capped at traderspostHardTimeoutMs, so ten minutes
    // bounds any realistic flatten while still releasing a truly stuck task.
    }, options.traderspostSafeguardTaskTimeoutMs ?? 10 * 60_000);
  };

  app.post('/app/exit-all-safeguard', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({ accountId: z.string().uuid(), csrfToken: z.string().min(1) }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'invalid csrf token' });
        return;
      }
      const account = database.findAccountById(input.accountId);
      if (!account || account.userId !== session.userId) {
        res.status(403).json({ error: 'account does not belong to user' });
        return;
      }
      const destination = database.getTradersPostAccountDestination(account.id);
      if (!destinationCanSend(destination)) {
        res.status(400).json({ error: 'Broker destination not configured or disabled' });
        return;
      }
      const roots = new Set<string>();
      for (const recentTicker of database.listAccountRecentTradersPostTickers(account.id, 24)) {
        const root = continuousTickerRoot(recentTicker);
        if (root) roots.add(root);
      }
      for (const openInstrument of database.getAccountOpenInstruments(account.id)) {
        const root = continuousTickerRoot(openInstrument);
        if (root) roots.add(root);
      }
      roots.add('MNQ');
      roots.add('MGC');
      const outcome = await runCancelAllSafeguard(account, destination, roots);
      emitToUser(session.userId, outcome.sent > 0 ? 'toast:success' : 'toast:error', {
        message: outcome.sent > 0 ? `Cancel all sent for ${outcome.sent} instrument(s)` : `Cancel all failed for ${outcome.errors} instrument(s)`,
      });
      res.status(200).json(outcome);
    } catch (error) {
      next(error);
    }
  });

  // Admin flatten: cancel/exit every account only on instruments that already have
  // submitted state (open brackets, recent deliveries, reapply ops, broker orders).
  app.post('/app/debugging/flatten-submitted-instruments', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({ csrfToken: z.string().min(1) }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      const accounts = database.listUsers()
        .flatMap((u) => database.listAccounts(u.id))
        .filter((a) => !a.deprecated);
      const addTickerRoot = (roots: Set<string>, ticker: string | null | undefined) => {
        const root = continuousTickerRoot(ticker);
        if (root) roots.add(root);
      };
      const perAccount: Array<Record<string, unknown>> = [];
      const skipped: string[] = [];
      for (const account of accounts) {
        const destination = database.getTradersPostAccountDestination(account.id);
        const roots = new Set<string>();
        for (const ticker of database.listAccountRecentTradersPostTickers(account.id, 24)) {
          addTickerRoot(roots, ticker);
        }
        for (const instrument of database.getAccountOpenInstruments(account.id)) {
          addTickerRoot(roots, instrument);
        }
        for (const op of database.listIncompleteReapplyOperations()) {
          if (op.accountId === account.id) addTickerRoot(roots, op.instrument);
        }
        for (const order of database.listOpenBrokerOrdersByAccount(account.id)) {
          addTickerRoot(roots, order.instrument);
        }
        for (const delivery of database.listPendingTradersPostDeliveries(account.id)) {
          addTickerRoot(roots, delivery.ticker);
        }
        if (!destinationCanSend(destination)) {
          // Report every disabled destination, not only ones with submitted state —
          // the endpoint contract is that all disabled accounts surface as skipped.
          skipped.push(`${account.name} (destination disabled)`);
          continue;
        }
        if (roots.size === 0) continue;
        const outcome = await runCancelAllSafeguard(account, destination, roots);
        perAccount.push({ accountId: account.id, accountName: account.name, ...outcome });
        emitToUser(account.userId, outcome.sent > 0 ? 'toast:success' : 'toast:error', {
          message: outcome.sent > 0
            ? `[debugging] Flattened ${outcome.sent} submitted instrument(s) for ${account.name}`
            : `[debugging] Flatten failed for ${account.name} (${outcome.errors} instrument(s))`,
        });
      }
      res.json({ success: true, accounts: perAccount, skipped });
    } catch (error) {
      next(error);
    }
  });

  // Bookkeeping-only clears for debugging: mark incomplete reapply ops resolved and
  // retire open broker order rows without sending any TradersPost traffic.
  app.post('/app/debugging/clear-reapply-operations', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({ csrfToken: z.string().min(1), brokerReconciled: z.literal(true) }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      // Only incomplete operations are cleared — completed history stays visible. The
      // brokerReconciled confirmation is required because clearing an unfinished op lifts
      // the entry block while its cancel/exit/re-arm work may still be live at the broker.
      // This is an admin-wide control like the flatten endpoint, so it covers every
      // user's incomplete operations rather than only the session user's.
      const ops = database.listIncompleteReapplyOperations().filter((op) => !op.dismissed);
      let cleared = 0;
      for (const op of ops) {
        // Serialize with the account's reapply queue: an op mid-execution could
        // otherwise keep sending after being marked completed here, or overwrite
        // the dismissed state. Re-read inside — the op may have finished already.
        cleared += await reapply.queue.run(op.accountId, async () => {
          const current = database.findReapplyOperation(op.accountId, op.eventId);
          if (!current || current.completed || current.dismissed) return 0;
          current.dismissed = true;
          current.completed = true;
          current.reason = 'Cleared via debugging (bookkeeping only; broker reconciled manually)';
          database.createBridgeLog(current.route.userId, 'reapply', { operationId: current.id, message: current.reason });
          database.saveReapplyOperation(current);
          return 1;
        });
      }
      // Completed history is audit-only — dismiss it so the card actually empties
      // instead of reporting 0 cleared while rows stay visible.
      cleared += database.dismissCompletedReapplyOperations();
      res.json({ success: true, cleared });
    } catch (error) {
      next(error);
    }
  });

  app.post('/app/debugging/clear-broker-orders', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({ csrfToken: z.string().min(1) }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      // Admin-wide like the flatten endpoint: close open rows on every user's account,
      // not just the session user's. Serialized per account so an in-flight dispatch
      // cannot land an acknowledged update (or a new row) after the rows are closed.
      // This is ledger bookkeeping only — no broker traffic — so it must NOT retire
      // armed monitor rows: clearing our dispatch record does not prove the order is
      // dead at the broker, and a healthy working order would lose its Open Orders
      // row. Arms still retire via Pine lifecycle, EOD, reconcile, or the per-row
      // reconcile endpoint where an operator asserts real broker state.
      const accounts = database.listUsers()
        .flatMap((u) => database.listAccounts(u.id))
        .filter((a) => !a.deprecated);
      let cleared = 0;
      let purged = 0;
      for (const account of accounts) {
        const result = await reapply.queue.run(account.id, async () => {
          const n = database.closeOpenBrokerOrdersForAccount(account.id, 'Cleared via debugging (bookkeeping only; no broker traffic sent)');
          const deleted = database.deleteResolvedBrokerOrdersForAccount(account.id);
          return { n, deleted };
        });
        cleared += result.n;
        purged += result.deleted;
      }
      res.json({ success: true, cleared, purged });
    } catch (error) {
      next(error);
    }
  });

  // Operator reconciliation for broker_orders rows whose broker-side outcome we
  // cannot learn automatically (uncertain fetch failures, stale acknowledged
  // rows contradicted by an operator-verified broker state). After checking
  // TradersPost/Tradovate, an admin marks the row resolved; rejecting or
  // cancelling an entry order also retires its armed monitor row when no other
  // open dispatch covers the arm — the same rule as the failure-email path.
  app.post('/app/debugging/reconcile-broker-order', async (req, res, next) => {
    const session = requireWebSession(req, res);
    if (!session) return;
    try {
      const input = z.object({
        orderId: z.string().min(1),
        status: z.enum(['acknowledged', 'filled', 'closed', 'rejected', 'cancelled']).optional(),
        retireArm: z.boolean().optional(),
        dismiss: z.boolean().optional(),
        note: z.string().max(500).optional(),
        csrfToken: z.string().min(1),
      }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      if (session.email !== adminUserEmail) {
        res.status(403).json({ error: 'admin only' });
        return;
      }
      const order = database.findBrokerOrderByOrderId(input.orderId);
      if (!order) {
        res.status(404).json({ error: 'broker order not found' });
        return;
      }
      const unresolved = order.status === 'pending' || order.status === 'uncertain' || order.status === 'acknowledged';
      // Dismissing deletes the ledger row outright — only safe once the dispatch
      // is resolved and no longer evidence for a live position.
      if (input.dismiss && (unresolved || order.status === 'filled')) {
        res.status(409).json({
          error: unresolved
            ? 'resolve the dispatch before dismissing its ledger row'
            : 'filled rows are dispatch evidence for a live position',
        });
        return;
      }
      if (unresolved && !input.status) {
        res.status(400).json({ error: 'status is required for unresolved broker orders' });
        return;
      }
      // Terminal history stands — a rejected/cancelled dispatch cannot be
      // re-marked, but the operator can still retire the armed arm it covers
      // (dispatch-time rejections never reach the monitor row, and the email
      // path skips rows that are no longer open), or dismiss the row entirely.
      if (!unresolved && !input.retireArm && !input.dismiss) {
        res.status(409).json({ error: `broker order is already ${order.status}` });
        return;
      }
      const retiredBrackets = await reapply.queue.run(order.accountId, async () => {
        if (unresolved && input.status) {
          database.updateBrokerOrderStatus(order.accountId, order.orderId, input.status, input.note, undefined, 'operator');
        }
        let retired: string[] = [];
        if (input.retireArm || input.status === 'rejected' || input.status === 'cancelled') {
          const openOrders = database
            .listOpenBrokerOrdersByAccount(order.accountId)
            .filter((open) => open.orderId !== order.orderId);
          // The order may belong to another user — invalidate the owner's cache,
          // not the admin session's.
          const ownerId = database.findAccountById(order.accountId)?.userId ?? session.userId;
          retired = retireUncoveredArmedMonitorRows(ownerId, order, openOrders, `reconcile-${order.orderId}`);
        }
        if (input.dismiss) database.deleteBrokerOrder(order.accountId, order.orderId);
        return retired;
      });
      res.json({ success: true, orderId: order.orderId, status: input.status ?? order.status, dismissed: input.dismiss === true, retiredBrackets });
    } catch (error) {
      next(error);
    }
  });

  // Mock TradersPost receiver for local e2e testing. Point an account destination's
  // webhook URL at http://localhost:3000/mock/traderspost to capture outbound
  // dispatches without a real TradersPost account. Inspect what was sent via
  // GET /mock/traderspost/calls or the derived broker state at
  // GET /mock/traderspost/state. Failure injection via query params on the webhook
  // URL: ?mode=reject (HTTP 200 with success:false), ?mode=error&status=503,
  // ?mode=timeout (never responds; exercises the caller's timeout), ?delay=ms.
  const mockTradersPostCalls: Array<{
    receivedAt: string;
    url: string;
    payload: unknown;
    responseStatus: number | null;
    responseBody: unknown;
  }> = [];

  // Mock routes exist only outside production — on a deployed instance an
  // unauthenticated caller could otherwise read captured order payloads, inject
  // fake broker calls, or erase the capture.
  if (!isProduction) {
  app.post('/mock/traderspost', (req, res) => {
    const mode = String(req.query.mode ?? 'success');
    const delayMs = Math.min(Math.max(Number(req.query.delay) || 0, 0), 60_000);
    const record = (responseStatus: number | null, responseBody: unknown) => {
      mockTradersPostCalls.push({
        receivedAt: new Date().toISOString(),
        url: req.originalUrl,
        payload: req.body,
        responseStatus,
        responseBody,
      });
      if (mockTradersPostCalls.length > 1000) mockTradersPostCalls.splice(0, mockTradersPostCalls.length - 1000);
    };
    if (mode === 'timeout' || mode === 'hang') {
      // Record the receipt but never respond — the caller's own timeout decides.
      record(null, '(mock: no response — timeout)');
      return;
    }
    const respond = () => {
      let status = 200;
      let body: unknown = { success: true, message: 'mock: accepted' };
      if (mode === 'reject') {
        body = { success: false, failureMessage: 'mock: rejected by request' };
      } else if (mode === 'error') {
        status = Math.min(Math.max(Number(req.query.status) || 500, 100), 599);
        body = `mock: HTTP ${status} error`;
      }
      record(status, body);
      if (typeof body === 'string') res.status(status).type('text').send(body);
      else res.status(status).json(body);
    };
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
  });

  app.get('/mock/traderspost/calls', (_req, res) => {
    res.json({ calls: mockTradersPostCalls });
  });

  // Derived broker view: working orders, open positions, and cancels/exits per ticker.
  // Stop/limit entries count as working orders; market entries open a position;
  // cancel clears working orders; exit flattens everything for that ticker.
  app.get('/mock/traderspost/state', (_req, res) => {
    const tickers = new Map<string, {
      position: { side: 'long' | 'short'; quantity: number } | null;
      workingOrders: unknown[];
      lastAction: string | undefined;
      lastActionAt: string | undefined;
    }>();
    for (const call of mockTradersPostCalls) {
      // Only calls the mock actually accepted may move derived broker state — a
      // rejected/error/timeout receipt must not appear as a working order or
      // clear a simulated position.
      const accepted = call.responseStatus != null && call.responseStatus >= 200 && call.responseStatus < 300
        && !(call.responseBody != null && typeof call.responseBody === 'object' && (call.responseBody as { success?: unknown }).success === false);
      if (!accepted) continue;
      const payload = call.payload as Record<string, unknown> | undefined;
      const ticker = typeof payload?.ticker === 'string' ? payload.ticker : undefined;
      if (!ticker || typeof payload?.action !== 'string') continue;
      const state = tickers.get(ticker) ?? { position: null, workingOrders: [], lastAction: undefined, lastActionAt: undefined };
      if (payload.action === 'cancel') {
        state.workingOrders = [];
      } else if (payload.action === 'exit') {
        state.workingOrders = [];
        state.position = null;
      } else if (payload.action === 'buy' || payload.action === 'sell') {
        const quantity = typeof payload.quantity === 'number' ? payload.quantity : 1;
        const side = payload.bracketSide === 'short' || payload.action === 'sell' ? 'short' : 'long';
        if (payload.orderType === 'market') {
          // Signed netting: buys add and sells reduce so an opposite market order
          // shrinks or flips the position instead of inflating it.
          const signed = payload.action === 'buy' ? quantity : -quantity;
          const net = (state.position ? (state.position.side === 'long' ? state.position.quantity : -state.position.quantity) : 0) + signed;
          state.position = net === 0 ? null : { side: net > 0 ? 'long' : 'short', quantity: Math.abs(net) };
        } else {
          state.workingOrders.push(payload);
        }
      }
      state.lastAction = payload.action;
      state.lastActionAt = call.receivedAt;
      tickers.set(ticker, state);
    }
    res.json({
      tickers: [...tickers.entries()].map(([ticker, state]) => ({ ticker, ...state })),
      callCount: mockTradersPostCalls.length,
    });
  });

  app.post('/mock/traderspost/clear', (_req, res) => {
    const cleared = mockTradersPostCalls.length;
    mockTradersPostCalls.length = 0;
    res.json({ cleared });
  });

  // Mock CrossTrade receiver — same capture/inspect shape as /mock/traderspost
  // but for the flat CrossTrade message format. Point an account destination's
  // crossTradeWebhookUrl at http://localhost:3000/mock/crosstrade to exercise the
  // NT8 dispatch path without a running CrossTrade add-on. State derives per
  // account:instrument from command semantics: 'place' adds a working order (or
  // a position for market orders), 'cancelorders' sweeps working orders,
  // 'flatten' clears orders and position. Same failure-injection query params.
  const mockCrossTradeCalls: typeof mockTradersPostCalls = [];

  // Structured per-account:instrument books so the mock behaves like NT8, not
  // just a call log: orders carry state, a fill nets a position, and filling
  // one leg of an OCO pair cancels the sibling natively.
  type CtMockOrder = {
    orderId: string;
    account: string;
    instrument: string;
    action: 'buy' | 'sell';
    orderType: string;
    qty: number;
    limitPrice?: number;
    stopPrice?: number;
    ocoId?: string;
    atmStrategy?: string;
    name?: string;
    state: 'Working' | 'PartFilled' | 'Filled' | 'Cancelled';
    placedAt: string;
    fillPrice?: number;
    filledQty?: number;
  };
  type CtMockBook = {
    orders: Map<string, CtMockOrder>;
    position: { side: 'long' | 'short'; quantity: number; averagePrice?: number } | null;
    lastAction?: string;
    lastActionAt?: string;
  };
  const ctMockBooks = new Map<string, CtMockBook>();
  // Simulated NT8 ATM template directory — seeded with the BE-enabled e2e
  // fixture range names; POST /mock/crosstrade/templates replaces the set.
  const ctMockAtmTemplates = new Set<string>(['SIM-CT-MNQ', 'SIM-ALL-MNQ', 'SIM-ALL-MGC']);
  const ctBook = (account: string, instrument: string): CtMockBook => {
    const key = `${account}:${instrument}`;
    let book = ctMockBooks.get(key);
    if (!book) {
      book = { orders: new Map(), position: null };
      ctMockBooks.set(key, book);
    }
    return book;
  };
  const netCtPosition = (book: CtMockBook, side: 'buy' | 'sell', qty: number, price?: number) => {
    const signed = side === 'buy' ? qty : -qty;
    const cur = book.position ? (book.position.side === 'long' ? book.position.quantity : -book.position.quantity) : 0;
    const net = cur + signed;
    book.position = net === 0 ? null : { side: net > 0 ? 'long' : 'short', quantity: Math.abs(net), averagePrice: price };
  };
  const applyCtCommand = (payload: Record<string, unknown>): string | undefined => {
    const account = typeof payload.account === 'string' ? payload.account : 'unknown';
    const instrument = typeof payload.instrument === 'string' ? payload.instrument : undefined;
    if (!instrument || typeof payload.command !== 'string') return;
    const book = ctBook(account, instrument);
    if (payload.command === 'cancelorders') {
      for (const order of book.orders.values()) if (order.state === 'Working') order.state = 'Cancelled';
    } else if (payload.command === 'flatten') {
      // A position closing leaves the strategy's exit leg as a Filled row in
      // the book — the source of realized-PnL attribution for readers.
      const exiting = book.position;
      const legs = [...book.orders.values()].filter((o) => o.state === 'Working' && o.atmStrategy);
      for (const order of book.orders.values()) {
        if (order.state === 'Working') order.state = 'Cancelled';
      }
      if (exiting) {
        const leg = legs.find((o) => o.name === 'Stop1') ?? legs[0];
        const exitAction = exiting.side === 'long' ? 'sell' as const : 'buy' as const;
        const exitPx = typeof payload.exit_price === 'number' ? payload.exit_price
          : leg?.stopPrice ?? leg?.limitPrice ?? exiting.averagePrice;
        if (leg) {
          leg.state = 'Filled';
          leg.fillPrice = exitPx;
        }
      }
      book.position = null;
    } else if (payload.command === 'place' && (payload.action === 'buy' || payload.action === 'sell')) {
      // NT8 burns an oco_id once its group RESOLVES (every member terminal);
      // a resend under a burned id is refused outright, while a still-working
      // group's other arm may legitimately share the id.
      const ocoIn = typeof payload.oco_id === 'string' && payload.oco_id ? payload.oco_id : undefined;
      if (ocoIn) {
        const priorGroup = [...ctMockBooks.values()]
          .flatMap((b) => [...b.orders.values()])
          .filter((o) => o.account === account && o.ocoId === ocoIn);
        const groupResolved = priorGroup.length > 0 && priorGroup.every((o) => o.state === 'Cancelled' || o.state === 'Filled');
        if (groupResolved) {
          return `Order cannot be submitted: The OCO ID '${ocoIn}' cannot be reused. Please use a new OCO ID.`;
        }
      }
      const qty = typeof payload.qty === 'number' ? payload.qty : 1;
      if (payload.order_type === 'market') {
        netCtPosition(book, payload.action, qty);
      } else {
        const orderId = typeof payload.order_id === 'string' && payload.order_id ? payload.order_id : `mock-${randomUUID()}`;
        book.orders.set(orderId, {
          orderId, account, instrument,
          action: payload.action, orderType: String(payload.order_type ?? 'market'), qty,
          limitPrice: typeof payload.limit_price === 'number' ? payload.limit_price : undefined,
          stopPrice: typeof payload.stop_price === 'number' ? payload.stop_price : undefined,
          ocoId: typeof payload.oco_id === 'string' && payload.oco_id ? payload.oco_id : undefined,
          atmStrategy: typeof payload.atm_strategy === 'string' ? payload.atm_strategy : undefined,
          state: 'Working', placedAt: new Date().toISOString(),
        });
      }
    }
    book.lastAction = payload.command;
    book.lastActionAt = new Date().toISOString();
  };
  // NT8-shape row — mirrors what the real REST API returns.
  const toNt8OrderRow = (order: CtMockOrder) => ({
    id: order.orderId,
    account: order.account,
    instrument: order.instrument,
    orderAction: order.action === 'buy' ? 'Buy' : 'Sell',
    orderType: order.orderType,
    orderState: order.state,
    quantity: order.qty,
    filledQuantity: order.filledQty ?? (order.state === 'Filled' ? order.qty : 0),
    filled: order.filledQty ?? (order.state === 'Filled' ? order.qty : 0),
    averageFillPrice: order.fillPrice,
    // NT8 wraps the echoed order_id in a userData XML blob — emit the same
    // shape so matchers exercise the extraction path, not raw equality.
    ...(order.name === undefined
      ? { userData: `<NinjaTrader><AutomatedTradingOrderId>${order.orderId}</AutomatedTradingOrderId></NinjaTrader>` }
      : {}),
    name: order.name,
    stopPrice: order.stopPrice,
    limitPrice: order.limitPrice,
    ocoId: order.ocoId,
    ownerStrategy: order.atmStrategy ? { name: order.atmStrategy, displayName: order.atmStrategy } : undefined,
    time: order.placedAt,
  });

  app.post('/mock/crosstrade', (req, res) => {
    const mode = String(req.query.mode ?? 'success');
    const delayMs = Math.min(Math.max(Number(req.query.delay) || 0, 0), 60_000);
    const record = (responseStatus: number | null, responseBody: unknown) => {
      mockCrossTradeCalls.push({
        receivedAt: new Date().toISOString(),
        url: req.originalUrl,
        payload: req.body,
        responseStatus,
        responseBody,
      });
      if (mockCrossTradeCalls.length > 1000) mockCrossTradeCalls.splice(0, mockCrossTradeCalls.length - 1000);
    };
    if (mode === 'timeout' || mode === 'hang') {
      record(null, '(mock: no response — timeout)');
      return;
    }
    const respond = () => {
      let status = 200;
      let body: unknown = { success: true, message: 'mock-crosstrade: accepted' };
      if (mode === 'reject') {
        body = { success: false, failureMessage: 'mock-crosstrade: rejected by request' };
      } else if (mode === 'error') {
        status = Math.min(Math.max(Number(req.query.status) || 500, 100), 599);
        body = `mock-crosstrade: HTTP ${status} error`;
      }
      if (status >= 200 && status < 300 && typeof req.body === 'object' && req.body) {
        const commandError = applyCtCommand(req.body as Record<string, unknown>);
        if (commandError) body = { success: false, failureMessage: commandError };
      }
      record(status, body);
      if (typeof body === 'string') res.status(status).type('text').send(body);
      else res.status(status).json(body);
    };
    if (delayMs > 0) setTimeout(respond, delayMs);
    else respond();
  });

  // Fill a working order: nets the position and — like real NT8 — cancels the
  // OCO siblings so the losing arm disappears without a cancelorders dispatch.
  app.post('/mock/crosstrade/fill', (req, res) => {
    const account = String(req.body?.account ?? '');
    const orderId = String(req.body?.orderId ?? '');
    const book = [...ctMockBooks.values()].find((b) => b.orders.get(orderId)?.account === account);
    const order = book?.orders.get(orderId);
    if (!book || !order || (order.state !== 'Working' && order.state !== 'PartFilled')) {
      res.status(404).json({ success: false, error: `no working order ${orderId} for ${account}` });
      return;
    }
    // Optional partial fill: req.body.qty < order.qty leaves a PartFilled row —
    // the remaining quantity is still working, like NT8's real behavior.
    // Default fills the REMAINING quantity, not the original order size.
    const alreadyFilled = order.filledQty ?? 0;
    const remaining = order.qty - alreadyFilled;
    const fillQty = req.body?.qty != null
      ? Math.max(1, Math.min(Number(req.body.qty) || remaining, remaining))
      : remaining;
    const totalFilled = alreadyFilled + fillQty;
    order.filledQty = totalFilled;
    order.state = totalFilled >= order.qty ? 'Filled' : 'PartFilled';
    order.fillPrice = order.stopPrice ?? order.limitPrice;
    netCtPosition(book, order.action, fillQty, order.fillPrice);
    // NT8 attaches the ATM strategy's protection legs on fill — spawn Working
    // Stop1/Target1 rows (ownerStrategy set) like the real book exposes.
    if (order.atmStrategy && order.fillPrice != null) {
      const tick = inferredTickSize(order.instrument);
      const exitAction = order.action === 'buy' ? 'sell' as const : 'buy' as const;
      const dir = order.action === 'buy' ? 1 : -1;
      const leg = (name: string, orderType: 'stopmarket' | 'limit', price: number) => {
        const legId = `${order.orderId}-${name.toLowerCase()}`;
        book.orders.set(legId, {
          orderId: legId, account: order.account, instrument: order.instrument,
          action: exitAction, orderType, qty: fillQty, name,
          ...(orderType === 'stopmarket' ? { stopPrice: price } : { limitPrice: price }),
          atmStrategy: order.atmStrategy, state: 'Working', placedAt: new Date().toISOString(),
        });
      };
      leg('Stop1', 'stopmarket', order.fillPrice - dir * 20 * tick);
      leg('Target1', 'limit', order.fillPrice + dir * 40 * tick);
    }
    const cancelledOco: string[] = [];
    if (order.ocoId) {
      for (const sibling of book.orders.values()) {
        if (sibling.ocoId === order.ocoId && sibling.orderId !== order.orderId && sibling.state === 'Working') {
          sibling.state = 'Cancelled';
          cancelledOco.push(sibling.orderId);
        }
      }
    }
    res.json({ success: true, filled: orderId, cancelledOco, position: book.position });
  });

  app.get('/mock/crosstrade/calls', (_req, res) => {
    res.json({ calls: mockCrossTradeCalls });
  });

  app.get('/mock/crosstrade/state', (_req, res) => {
    res.json({
      books: [...ctMockBooks.entries()].map(([key, book]) => ({
        book: key,
        position: book.position,
        workingOrders: [...book.orders.values()].filter((o) => o.state === 'Working'),
        orders: [...book.orders.values()],
        lastAction: book.lastAction,
        lastActionAt: book.lastActionAt,
      })),
      callCount: mockCrossTradeCalls.length,
    });
  });

  app.post('/mock/crosstrade/clear', (_req, res) => {
    const cleared = mockCrossTradeCalls.length;
    mockCrossTradeCalls.length = 0;
    ctMockBooks.clear();
    res.json({ cleared });
  });

  // CrossTrade REST API twin — the real API lives at {origin}/v1/api behind a
  // Bearer token, so the Debugging broker-state card works end-to-end when a
  // fixture destination's webhook points at the mock.
  const requireMockBearer = (req: Request, res: Response): boolean => {
    if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Invalid bearer token' });
      return false;
    }
    return true;
  };
  const ctAccountBooks = (account: string) =>
    [...ctMockBooks.entries()]
      .filter(([key]) => key.startsWith(`${account}:`))
      .map(([key, book]) => ({ instrument: key.slice(account.length + 1), book }));
  app.get('/v1/api/accounts/:account/orders', (req, res) => {
    if (!requireMockBearer(req, res)) return;
    const activeOnly = req.query.activeOnly === 'true';
    const orders = ctAccountBooks(req.params.account)
      .flatMap(({ book }) => [...book.orders.values()])
      .filter((o) => !activeOnly || o.state === 'Working')
      .map(toNt8OrderRow);
    res.json({ success: true, orders });
  });
  app.get('/v1/api/accounts/:account/positions', (req, res) => {
    if (!requireMockBearer(req, res)) return;
    const positions = ctAccountBooks(req.params.account)
      .filter(({ book }) => book.position)
      .map(({ instrument, book }) => ({
        account: req.params.account,
        instrument,
        marketPosition: book.position!.side === 'long' ? 'Long' : 'Short',
        quantity: book.position!.quantity,
        averagePrice: book.position!.averagePrice,
      }));
    res.json({ success: true, positions });
  });
  app.get('/v1/api/accounts/:account/orders/:orderId', (req, res) => {
    if (!requireMockBearer(req, res)) return;
    const order = ctAccountBooks(req.params.account)
      .flatMap(({ book }) => [...book.orders.values()])
      .find((o) => o.orderId === req.params.orderId);
    if (!order) {
      res.status(404).json({ success: false, error: `order ${req.params.orderId} not found` });
      return;
    }
    res.json({ success: true, order: toNt8OrderRow(order) });
  });
  // GET /v1/api/atm-templates twin. The set is mutable via the mock control
  // endpoint so e2e/dev can exercise the missing-template preflight path.
  app.get('/v1/api/atm-templates', (req, res) => {
    if (!requireMockBearer(req, res)) return;
    res.json({ success: true, templates: [...ctMockAtmTemplates], count: ctMockAtmTemplates.size });
  });
  app.post('/mock/crosstrade/templates', (req, res) => {
    const templates = z.array(z.string().min(1).max(128)).max(500).parse(req.body?.templates ?? []);
    ctMockAtmTemplates.clear();
    for (const name of templates) ctMockAtmTemplates.add(name);
    res.json({ success: true, templates: [...ctMockAtmTemplates] });
  });
  }

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  async function handleForexFactoryEvents(req: Request, res: Response) {
    try {
      const day = typeof req.query.day === 'string' ? req.query.day : undefined;
      const range = typeof req.query.range === 'string' ? req.query.range : undefined;
      const impact = z.enum(['all', 'high']).default('high').parse(req.query.impact);
      if (day && range) {
        res.status(400).json({ error: 'Use either day or range, not both.' });
        return;
      }
      if (range) {
        const normalizedRange = normalizeForexFactoryRange(range);
        const cachedRange = forexFactoryRangeCache.get(`${normalizedRange}:${impact}`);
        if (cachedRange && cachedRange.expiresAt > Date.now()) {
          const events = filterForexFactoryEvents(cachedRange.payload.events, impact);
          res.status(200).json({
            ...cachedRange.payload,
            events,
            count: events.length,
            cached: true,
          });
          return;
        }
        const bounds = parseScopeBounds(normalizedRange);
        const overlapping = bounds ? database.findForexFactoryRangeSnapshotsOverlapping(normalizedRange) : [];
        const normalizedSources = overlapping
          .map((snapshot) => normalizeForexFactorySnapshotTimezone(snapshot, JOURNAL_TIME_ZONE))
          .filter((snapshot) => {
            const sourceBounds = parseScopeBounds(snapshot.range);
            if (!sourceBounds || !bounds) return false;
            return sourceBounds.end >= bounds.start && sourceBounds.start <= bounds.end;
          })
          .sort((left, right) => left.fetchedAt.localeCompare(right.fetchedAt));
        if (normalizedSources.length === 0) {
          res.status(404).json({ error: 'No imported Forex Factory snapshot is stored for that range yet.' });
          return;
        }
        const eventsById = new Map<string, ForexFactoryRangeResult['events'][number]>();
        let latestFetchedAt = '';
        for (const snapshot of normalizedSources) {
          if (snapshot.fetchedAt > latestFetchedAt) latestFetchedAt = snapshot.fetchedAt;
          for (const event of snapshot.events) {
            eventsById.set(event.eventId, event);
          }
        }
        const merged: ForexFactoryRangeResult = {
          source: 'ForexFactory',
          range: normalizedRange,
          timezone: JOURNAL_TIME_ZONE,
          fetchedAt: latestFetchedAt || new Date().toISOString(),
          events: [...eventsById.values()],
        };
        forexFactoryRangeCache.set(`${merged.range}:${impact}`, {
          expiresAt: Date.now() + (5 * 60 * 1000),
          payload: merged,
        });
        const events = filterForexFactoryEvents(merged.events, impact);
        res.status(200).json({
          ...merged,
          events,
          count: events.length,
          cached: false,
        });
        return;
      }
      const normalizedDay = normalizeForexFactoryDay(day);
      const cacheKey = `${normalizedDay}:${impact}`;
      const cached = forexFactoryCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const events = filterForexFactoryEvents(cached.payload.events, impact);
        res.status(200).json({
          ...cached.payload,
          events,
          count: events.length,
          cached: true,
        });
        return;
      }
      const requestedDate = parseForexFactoryDayIdentifier(normalizedDay, new Date());
      if (!requestedDate) {
        res.status(400).json({ error: 'Invalid day.' });
        return;
      }
      const storedRange = database.findForexFactoryRangeSnapshotCovering(requestedDate);
      if (!storedRange) {
        res.status(404).json({ error: 'No imported Forex Factory snapshot is stored that contains this day yet.' });
        return;
      }
      const normalizedStoredRange = normalizeForexFactorySnapshotTimezone(storedRange, JOURNAL_TIME_ZONE);
      if (normalizedStoredRange.timezone !== storedRange.timezone) database.upsertForexFactorySnapshot(normalizedStoredRange);
      const payload = {
        source: 'ForexFactory' as const,
        day: normalizedDay,
        timezone: normalizedStoredRange.timezone,
        fetchedAt: normalizedStoredRange.fetchedAt,
        events: normalizedStoredRange.events.filter((event) => event.date === formatForexFactoryEventDateLabel(requestedDate)),
      };
      forexFactoryCache.set(cacheKey, {
        expiresAt: Date.now() + (5 * 60 * 1000),
        payload,
      });
      const events = filterForexFactoryEvents(payload.events, impact);
      res.status(200).json({
        ...payload,
        events,
        count: events.length,
        cached: false,
      });
    } catch (error) {
      if (error instanceof ForexFactoryError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  }

  app.get('/api/forex-factory/events', handleForexFactoryEvents);
  app.get('/app/api/forex-factory/events', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    handleForexFactoryEvents(req, res);
  });

  app.get('/favicon.svg', (_req, res) => {
    res.type('image/svg+xml').send(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#51e2b0"/><stop offset="1" stop-color="#4a8dff"/></linearGradient></defs><rect width="64" height="64" rx="18" fill="#0d1624"/><path d="M17 42 29 30l8 8 12-16" fill="none" stroke="url(#g)" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"/><path d="M40 22h9v9" fill="none" stroke="#4a8dff" stroke-linecap="round" stroke-linejoin="round" stroke-width="7"/></svg>',
    );
  });

  const requireAdmin = (req: Request, res: Response): boolean => {
    if (matchesSecret(config.ADMIN_API_KEY, req.header('x-admin-key'))) return true;
    res.status(401).json({ error: 'unauthorized' });
    return false;
  };

  app.get('/api/journal', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const userId = userIdSchema.parse(req.query.userId);
      if (!database.findUserById(userId)) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      res.status(200).json(database.getTradeJournal(userId));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/accounts/:accountId/alerts', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const accountId = z.string().uuid().parse(req.params.accountId);
      const account = database.findAccountById(accountId);
      if (!account) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      res.status(200).json({
        account: { id: account.id, name: account.name },
        alerts: database.listAccountAlerts(account.userId, account.id),
        summary: database.getAccountAlertSummary(account.userId, account.id),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/users', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const { email } = createUserSchema.parse(req.body);
      const user = database.createUser(email);
      res.status(201).json(credentialResponse(user));
    } catch (error) {
      next(error);
    }
  });

  app.post('/admin/users/:id/credentials', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const user = database.rotateUserCredentials(z.string().uuid().parse(req.params.id));
      if (!user) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      res.status(200).json(credentialResponse(user));
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/users', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.status(200).json({ users: database.listUsers() });
  });

  app.post('/admin/accounts', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const input = createAccountSchema.parse(req.body);
      if (!database.findUserById(input.userId)) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      if (database.hasAccountName(input.userId, input.name)) {
        res.status(409).json({ error: 'account name already exists' });
        return;
      }
      const { externalBalanceAt, externalBalanceCents, ...accountInput } = input;
      const account = database.createAccount({
        ...accountInput,
        ...(externalBalanceCents != null ? { externalBalanceCents } : {}),
        ...(externalBalanceAt != null ? { externalBalanceAt } : {}),
      });
      res.status(201).json({ account });
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/accounts', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const userId = userIdSchema.parse(req.query.userId);
      if (!database.findUserById(userId)) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      res.status(200).json({ accounts: database.listAccounts(userId) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/admin/range-routes', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const input = upsertRangeRouteSchema.parse(req.body);
      if (!database.findUserById(input.userId)) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      const route = database.upsertRangeRoute(input);
      if (!route) {
        res.status(400).json({ error: 'account does not belong to user' });
        return;
      }
      res.status(200).json({ route });
    } catch (error) {
      next(error);
    }
  });

  app.get('/admin/range-routes', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const userId = userIdSchema.parse(req.query.userId);
      if (!database.findUserById(userId)) {
        res.status(404).json({ error: 'user not found' });
        return;
      }
      res.status(200).json({ routes: database.listRangeRoutes(userId) });
    } catch (error) {
      next(error);
    }
  });

  app.put('/admin/traderspost-destination', (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const input = upsertTradersPostAccountDestinationSchema.parse(req.body);
      const account = database.findAccountById(input.accountId);
      if (!account) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      const outboundTickerMode = normalizeOutboundTickerMode(input.outboundTickerMode);
      const outboundTicker = input.outboundTickerMode === 'exact' ? normalizeOutboundTicker(input.outboundTicker) : undefined;
      const useLimitPriceTP = input.useLimitPriceTP === true;
      const useAlertTP = input.useAlertTP === true;
      const reapplyOnTradeCloseEnabled = input.reapplyOnTradeCloseEnabled === true;
      const eodCancelTime = input.eodCancelTime ?? '16:30';
      const eodExitTime = input.eodExitTime ?? '16:45';
      const eodEnabled = input.eodEnabled !== false;
      const newsFlattenEnabled = input.newsFlattenEnabled === true;
      const newsFlattenMinutes = input.newsFlattenMinutes ?? 5;
      if (input.outboundTickerMode === 'exact' && !outboundTicker) {
        res.status(400).json({ error: 'exact outbound ticker is required when exact mode is selected' });
        return;
      }
      const crossTrade = resolveCrossTradeFields(input, database.getTradersPostAccountDestination(account.id));
      if (crossTrade === 'missing-key') {
        res.status(400).json({ error: 'crossTradeSecretKey is required when crossTradeWebhookUrl is set' });
        return;
      }
      if (input.crossTradeEnabled === false
          && crossTrade.webhookUrl
          && input.webhookUrl === crossTrade.webhookUrl) {
        res.status(400).json({ error: 'parking CrossTrade requires a distinct TradersPost webhook — the primary URL still points at the CrossTrade endpoint' });
        return;
      }
      const destination = database.upsertTradersPostAccountDestination(
        account.userId,
        account.id,
        input.webhookUrl,
        outboundTicker,
        outboundTickerMode,
        true,
        useLimitPriceTP,
        useAlertTP,
        eodCancelTime,
        eodExitTime,
        eodEnabled,
        newsFlattenEnabled,
        newsFlattenMinutes,
        reapplyOnTradeCloseEnabled,
        crossTrade,
        input.quantityOverrideMode && input.quantityOverrideMode !== 'off' && input.quantityOverrideValue != null
          ? { mode: input.quantityOverrideMode, value: input.quantityOverrideValue }
          : undefined,
      )!;
      res.status(200).json({
        accountId: destination.accountId,
        configured: true,
        crossTradeConfigured: isCrossTradeConfigured(destination),
        ...(destination.outboundTicker ? { outboundTicker: destination.outboundTicker } : {}),
        ...(destination.outboundTickerMode ? { outboundTickerMode: destination.outboundTickerMode } : {}),
        useLimitPriceTP: destination.useLimitPriceTP === true,
        useAlertTP: destination.useAlertTP === true,
        reapplyOnTradeCloseEnabled: destination.reapplyOnTradeCloseEnabled === true,
        eodCancelTime: destination.eodCancelTime,
        eodExitTime: destination.eodExitTime,
        eodEnabled: destination.eodEnabled !== false,
        newsFlattenEnabled: destination.newsFlattenEnabled === true,
        newsFlattenMinutes: destination.newsFlattenMinutes,
        updatedAt: destination.updatedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  const tradersPostStatus = (delivery: ProxyDelivery, success: boolean): ProxyDeliveryStatus => {
    if (success) {
      return delivery.extensionEnabled && delivery.draftId
        ? 'extension_draft_created_and_traderspost_delivered'
        : 'traderspost_delivered';
    }
    return delivery.extensionEnabled && delivery.draftId
      ? 'extension_draft_created_and_traderspost_failed'
      : 'traderspost_failed';
  };

  const createAccountTradeEventFromRange = (route: Pick<RangeRoute, 'accountId' | 'userId'>, event: RangeTradeEvent) => {
    if (event.eventType === 'trade_closed') {
      // The bracket-close key is the trade, not the event id — a synthesized
      // ct-flat close and Pine's real trade_closed share the tradeId. Pine's
      // numbers upgrade a synthesized row in place; a real row wins outright.
      const prior = database.findTradeClosedForTrade(route.accountId, event.rangeName, event.tradeId);
      if (prior) {
        // CT-matched closes carry real broker fill prices — authoritative,
        // Pine's report is skipped. An unmatched synth (exitPrice null) keeps
        // zeros, so Pine's real numbers still upgrade it.
        if (prior.eventId.startsWith('ct-flat-') && prior.exitPrice == null
            && !event.eventId.startsWith('ct-flat-')) {
          database.updateTradeEventRealization(prior.id, {
            exitPrice: event.exitPrice,
            realizedTicksCents: event.realizedTicksCents,
            realizedDollarsCents: event.realizedDollarsCents,
            outcome: event.outcome,
            occurredAt: event.occurredAt,
          });
        }
        return { event: prior, created: false };
      }
    }
    return database.createTradeEvent({
      userId: route.userId,
      accountId: route.accountId,
      rangeName: event.rangeName,
      eventId: event.eventId,
      tradeId: event.tradeId,
      eventType: event.eventType,
      instrument: event.instrument,
      side: event.side,
      ...(event.action ? { action: event.action } : {}),
      quantity: event.quantity,
      ...(event.entryPrice != null ? { entryPrice: event.entryPrice } : {}),
      ...(event.exitPrice != null ? { exitPrice: event.exitPrice } : {}),
      ...(event.realizedTicksCents != null ? { realizedTicksCents: event.realizedTicksCents } : {}),
      ...(event.realizedDollarsCents != null ? { realizedDollarsCents: event.realizedDollarsCents } : {}),
      ...(event.outcome ? { outcome: event.outcome } : {}),
      occurredAt: event.occurredAt,
      ...(event.proxyAlertId ? { proxyAlertId: event.proxyAlertId } : {}),
    });
  };

  const recordLifecycleAlertHistory = (
    payload: LifecyclePayload,
    alert: { id: string; receivedAt: string },
    rangeName: string | undefined,
    respectRunScheduled = false,
  ) => {
    const realizedTicksCents = payload.realizedTicks == null
      ? undefined
      : decimalToIntegerCents(payload.realizedTicks);
    const realizedDollarsCents = payload.realizedDollars == null
      ? undefined
      : decimalToIntegerCents(payload.realizedDollars);
    if (payload.eventType === 'trade_closed'
      && (realizedTicksCents == null || realizedDollarsCents == null || !payload.closedAt || !payload.outcome)) {
      throw new Error('invalid lifecycle payload');
    }
    const occurredAt = new Date(payload.eventType === 'trade_closed'
      ? payload.closedAt!
      : payload.occurredAt ?? alert.receivedAt).toISOString();
    if (!rangeName) {
      return { occurredAt, routes: [] as Array<{
        routeId: string;
        tradeEventId: string;
        eventId: string;
        eventType: TradeEventType;
        status: 'trade_event_recorded';
        duplicate: boolean;
      }> };
    }
    const rangeConfiguration = respectRunScheduled ? database.getRangeConfiguration(rangeName) : undefined;
    const eventWeekday = respectRunScheduled ? currentJournalWeekday(new Date(occurredAt)) : undefined;
    const existing = payload.eventType === 'entry_armed' ? []
      : database.listLifecycleBracketAccounts(rangeName, payload.tradeId, lifecycleSide(payload));
    const existingIds = new Set(existing.map(account => account.accountId));
    const activeRoutes = database.findRangeRoutes(rangeName).filter((route) =>
      existingIds.has(route.accountId) || !respectRunScheduled || !route.runScheduled
      || (eventWeekday !== undefined && database.routeRunsOnWeekday(route, rangeConfiguration, eventWeekday)),
    );
    const eligibleRoutes = activeRoutes.filter((route) => {
      if (existingIds.has(route.accountId)) return true;
      const account = database.findAccountById(route.accountId);
      if (!account || account.deprecated) return false;
      return (
        new Date(route.createdAt) <= new Date(occurredAt) &&
        new Date(account.createdAt) <= new Date(occurredAt)
      );
    });
    const recipients = [...new Map([...existing, ...eligibleRoutes].map(r => [r.accountId, r])).values()];
    // Same trade-level dedupe at the range table — a prior ct-flat or real
    // trade_closed for this tradeId means the close is already journaled.
    const priorRangeClose = payload.eventType === 'trade_closed'
      ? database.findRangeTradeClosedForTrade(rangeName, payload.tradeId)
      : undefined;
    if (priorRangeClose && priorRangeClose.eventId.startsWith('ct-flat-')
        && priorRangeClose.exitPrice == null && !payload.eventId.startsWith('ct-flat-')) {
      database.updateRangeTradeEventRealization(priorRangeClose.id, {
        exitPrice: payload.exitPrice,
        realizedTicksCents,
        realizedDollarsCents,
        outcome: payload.outcome,
        occurredAt,
      });
    }
    const rangeResult = priorRangeClose
      ? { event: priorRangeClose, created: false }
      : recipients.length > 0
      ? database.createRangeTradeEvent({
          rangeName,
          eventId: payload.eventId,
          tradeId: payload.tradeId,
          eventType: payload.eventType,
          instrument: payload.ticker,
          side: lifecycleSide(payload),
          ...(payload.action ? { action: payload.action } : {}),
          quantity: payload.quantity,
          ...(payload.entryPrice != null ? { entryPrice: payload.entryPrice } : {}),
          ...(payload.exitPrice != null ? { exitPrice: payload.exitPrice } : {}),
          ...(realizedTicksCents != null ? { realizedTicksCents } : {}),
          ...(realizedDollarsCents != null ? { realizedDollarsCents } : {}),
          ...(payload.outcome ? { outcome: payload.outcome } : {}),
          occurredAt,
          proxyAlertId: alert.id,
        })
      : undefined;
    // When Pine's close upgraded an existing ct-flat range row, the stored
    // event object still carries the old ct-flat eventId + null realization —
    // the account fan-out must see the INCOMING Pine event so a prior ct-flat
    // account row upgrades in place and fresh accounts get Pine's real data.
    const fanOutEvent = priorRangeClose
      ? {
          ...priorRangeClose,
          eventId: payload.eventId,
          tradeId: payload.tradeId,
          eventType: payload.eventType,
          instrument: payload.ticker,
          side: lifecycleSide(payload),
          ...(payload.action ? { action: payload.action } : {}),
          quantity: payload.quantity ?? priorRangeClose.quantity,
          ...(payload.entryPrice != null ? { entryPrice: payload.entryPrice } : {}),
          ...(payload.exitPrice != null ? { exitPrice: payload.exitPrice } : {}),
          ...(realizedTicksCents != null ? { realizedTicksCents } : {}),
          ...(realizedDollarsCents != null ? { realizedDollarsCents } : {}),
          ...(payload.outcome ? { outcome: payload.outcome } : {}),
          occurredAt,
          proxyAlertId: alert.id,
        }
      : rangeResult!.event;
    const routes = recipients.map((route) => {
      const result = createAccountTradeEventFromRange(route, {
        ...fanOutEvent,
        occurredAt,
        ...(fanOutEvent.proxyAlertId ? { proxyAlertId: fanOutEvent.proxyAlertId } : {}),
      });
      emitToUser(route.userId, 'journal:refresh', {});
      return {
        routeId: eligibleRoutes.find(r => r.accountId === route.accountId)?.id,
        tradeEventId: result.event.id,
        eventId: result.event.eventId,
        eventType: result.event.eventType,
        status: 'trade_event_recorded' as const,
        duplicate: !result.created,
      };
    });
    return { occurredAt, rangeResult, routes, eligibleRoutes };
  };

  const reprocessLifecycleAlerts = async (
    alerts: Array<{
      alertId: string;
      receivedAt: string;
      rangeName?: string;
      payloadJson: string;
    }>,
    respectRunScheduled = false,
    fallbackUserId?: string,
  ) => {
    let processed = 0;
    let created = 0;
    let tradeEvents = 0;
    let errors = 0;
    const syncRangeNames = new Set<string>();
    for (let i = 0; i < alerts.length; i++) {
      const alert = alerts[i];
      const payload = parseStoredProxyPayload(alert.payloadJson);
      if (!payload || !isLifecyclePayload(payload)) continue;
      if (alert.rangeName) syncRangeNames.add(alert.rangeName);
      try {
        const history = recordLifecycleAlertHistory(
          payload,
          { id: alert.alertId, receivedAt: alert.receivedAt },
          alert.rangeName,
          respectRunScheduled,
        );
        processed += 1;
        if (history.rangeResult?.created) created += 1;
        tradeEvents += history.routes.length;
      } catch {
        errors += 1;
      }
      if ((i + 1) % 100 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    if (syncRangeNames.size > 0) {
      database.syncRangeCalendarVisibilityWithSchedules([...syncRangeNames], fallbackUserId);
    }
    return { processed, created, tradeEvents, errors };
  };

  const replayTrackedRangeLifecycleHistory = (
    rangeName: string,
    respectRunScheduled = false,
  ): void => {
    for (const alert of database.listProxyAlertsByRange(rangeName)) {
      const payload = parseStoredProxyPayload(alert.payloadJson);
      if (!payload || !isLifecyclePayload(payload)) continue;
      recordLifecycleAlertHistory(
        payload,
        { id: alert.alertId, receivedAt: alert.receivedAt },
        rangeName,
        respectRunScheduled,
      );
    }
  };

  const forwardToTradersPost = async (
    delivery: ProxyDelivery,
    payloadJson: string,
    context?: TradersPostForwardContext,
  ): Promise<ProxyDelivery> => {
    let immediatePreciseTakeProfitPromise: Promise<ProxyDelivery> | undefined;
    const runInAccountQueue = context?.queueNext
      ? traderspostRateLimiter.runNext.bind(traderspostRateLimiter)
      : traderspostRateLimiter.run.bind(traderspostRateLimiter);
    // The send path swallows broker failures into the returned delivery —
    // report the real outcome so the lane circuit breaker sees broker
    // unavailability, not just thrown errors (watchdog releases).
    const deliveryOutcome = (result: ProxyDelivery): 'success' | 'failure' | 'neutral' =>
      result.status === 'traderspost_delivered' || result.status === 'extension_draft_created_and_traderspost_delivered'
        ? 'success'
        : result.status === 'traderspost_failed' || result.status === 'extension_draft_created_and_traderspost_failed'
          ? 'failure'
          : 'neutral';
    // Lane key = the destination endpoint, not the account: ~20 accounts share
    // one VPS/CT plugin, which serializes anyway — endpoint lanes give the
    // pacing AND the circuit breaker the granularity that matches reality,
    // while the outer account queue keeps per-account operation ordering.
    const laneDestination = database.getTradersPostAccountDestination(delivery.accountId);
    const dispatchLaneKey = laneDestination && isCrossTradeConfigured(laneDestination)
      ? laneDestination.crossTradeWebhookUrl!
      : (laneDestination?.webhookUrl ?? delivery.accountId);
    const updatedDelivery = await runInAccountQueue(dispatchLaneKey, async (limiterSignal) => {
    // The outer queue task may have been watchdog-released while this send waited
    // on the per-account interval — the caller already recorded the failure, so
    // this queued work must bail instead of sending alongside the next task.
    // The limiter's own watchdog releases this slot the same way, so either
    // abort means "post-release": no fetches and no ledger mutations.
    const released = () => limiterSignal.aborted || context?.taskSignal?.aborted === true;
    if (released()) {
      return database.findProxyDelivery(delivery.id) ?? delivery;
    }
    // A delivery can be superseded between creation and send time — the cancel-all
    // safeguard marks still-pending deliveries suppressed_safeguard inside this same
    // account queue. Re-read the row: a delivery whose status no longer expects a
    // send must never dispatch, or its queued task would place an order on an
    // instrument that was just flattened.
    const current = database.findProxyDelivery(delivery.id);
    const sendable = current && (
      current.status === 'pending_traderspost'
      || current.status === 'extension_draft_created_and_pending_traderspost'
      || current.status === 'traderspost_failed'
      || current.status === 'extension_draft_created_and_traderspost_failed'
      || (context?.allowResend === true && (
        current.status === 'traderspost_delivered'
        || current.status === 'extension_draft_created_and_traderspost_delivered'
        || current.status.startsWith('suppressed_')
      ))
    );
    if (!sendable) {
      console.warn('[traderspost] Skipping delivery whose status no longer expects a send', {
        deliveryId: delivery.id,
        accountId: delivery.accountId,
        source: context?.source ?? 'proxy',
        rangeName: context?.rangeName ?? null,
        status: current?.status ?? 'missing',
      });
      return current ?? delivery;
    }
    const preflight = context?.preflight?.();
    if (preflight && !preflight.allowed) {
      console.warn('[traderspost] Delivery blocked by queued preflight', {
        deliveryId: delivery.id,
        accountId: delivery.accountId,
        source: context?.source ?? 'proxy',
        rangeName: context?.rangeName ?? null,
        reason: preflight.reason,
      });
      database.createProxyDeliveryAttempt({
        proxyDeliveryId: delivery.id,
        success: false,
        errorText: preflight.reason,
      });
      return database.updateProxyDeliveryStatus(delivery.id, preflight.status ?? 'suppressed_guard')!;
    }
    const previousAttempts = database.listProxyDeliveryAttempts(delivery.id);
    if (context?.allowResend !== true && previousAttempts.some((attempt) => attempt.success)) {
      console.info('[traderspost] Skipping duplicate delivery for already-succeeded proxy delivery', {
        deliveryId: delivery.id,
        accountId: delivery.accountId,
        source: context?.source ?? 'proxy',
        rangeName: context?.rangeName ?? null,
      });
      return database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, true))!;
    }
    const destination = database.getTradersPostAccountDestination(delivery.accountId);
    const accountName = database.findAccountById(delivery.accountId)?.name ?? 'Unknown account';
    if (!destination) {
      console.warn('[traderspost] Skipping delivery without destination', {
        deliveryId: delivery.id,
        accountId: delivery.accountId,
        userId: delivery.userId,
        source: context?.source ?? 'proxy',
        rangeName: context?.rangeName ?? null,
      });
      database.createProxyDeliveryAttempt({
        proxyDeliveryId: delivery.id,
        success: false,
        errorText: 'TradersPost destination is not configured',
      });
      return database.updateProxyDeliveryStatus(delivery.id, 'traderspost_not_configured')!;
    }

      const openInstrumentSet = context?.openInstrumentSet ?? new Set(database.getAccountOpenInstruments(destination.accountId));
      const parsed = parseStoredProxyPayload(payloadJson);
      const isReapply = context?.source?.startsWith('reapply_') === true;
      if (parsed && !isReapply && (parsed.action === 'cancel' || parsed.action === 'exit')) reapply.invalidate(delivery.accountId, parsed.ticker);
      const isNewsFlatten = typeof parsed?.extras?.reason === 'string' && parsed.extras.reason.startsWith('news_flatten_');
      const isSafeguardBypass = isReapply || isNewsFlatten;
      if (parsed != null && parsed.action === 'exit') {
        const guardRangeName = context?.rangeName
          ?? (typeof parsed.extras?.rangeName === 'string' ? parsed.extras.rangeName : undefined);
        const isEod = typeof parsed.extras?.reason === 'string' && parsed.extras.reason.startsWith('eod_');
        if (guardRangeName != null && !isEod && !isSafeguardBypass
          && database.hasUnrelatedOpenPosition(delivery.accountId, parsed.ticker, guardRangeName)) {
          const guardReason = `Blocked exit: account has unrelated open position for ${parsed.ticker} outside range ${guardRangeName}`;
          console.warn('[traderspost] ' + guardReason, {
            deliveryId: delivery.id,
            accountId: delivery.accountId,
            userId: delivery.userId,
            source: context?.source ?? 'proxy',
            rangeName: guardRangeName,
            ticker: parsed.ticker,
          });
          database.createProxyDeliveryAttempt({
            proxyDeliveryId: delivery.id,
            success: false,
            errorText: guardReason,
          });
          return database.updateProxyDeliveryStatus(delivery.id, 'suppressed_guard')!;
        }
      }
      if (parsed != null && parsed.action === 'cancel') {
        const guardRangeName = context?.rangeName
          ?? (typeof parsed.extras?.rangeName === 'string' ? parsed.extras.rangeName : undefined);
        const isEod = typeof parsed.extras?.reason === 'string' && parsed.extras.reason.startsWith('eod_');
        if (guardRangeName != null && !isEod && !isSafeguardBypass && !destination.useLimitPriceTP
          && database.hasUnrelatedOpenOrder(delivery.accountId, parsed.ticker, guardRangeName)) {
          const guardReason = `Blocked cancel: account has unrelated open order for ${parsed.ticker} outside range ${guardRangeName} and useLimitPriceTP is not enabled`;
          console.warn('[traderspost] ' + guardReason, {
            deliveryId: delivery.id,
            accountId: delivery.accountId,
            userId: delivery.userId,
            source: context?.source ?? 'proxy',
            rangeName: guardRangeName,
            ticker: parsed.ticker,
          });
          database.createProxyDeliveryAttempt({
            proxyDeliveryId: delivery.id,
            success: false,
            errorText: guardReason,
          });
          return database.updateProxyDeliveryStatus(delivery.id, 'suppressed_guard')!;
        }
      }
      const rangeConfiguration = context?.rangeName ? database.getRangeConfiguration(context.rangeName) : undefined;
      const preparedPayloads = prepareTradersPostDestinationPayloads(
        payloadJson,
        destination,
        rangeConfiguration,
        openInstrumentSet,
      );
      if (preparedPayloads.protectionError) {
        console.error('[traderspost] Delivery blocked by take profit safety invariant', {
          deliveryId: delivery.id,
          accountId: delivery.accountId,
          source: context?.source ?? 'proxy',
          rangeName: context?.rangeName ?? null,
          reason: preparedPayloads.protectionError,
        });
        database.createProxyDeliveryAttempt({
          proxyDeliveryId: delivery.id,
          success: false,
          errorText: preparedPayloads.protectionError,
        });
        if (!isCrossTradeConfigured(destination)) {
          emitToUser(delivery.userId, 'toast:error', { message: preparedPayloads.protectionError, persistent: true, ...(context?.rangeName ? { rangeName: context.rangeName } : {}) });
        }
        return database.updateProxyDeliveryStatus(delivery.id, 'suppressed_guard')!;
      }
      const outboundPayloadJsons = preparedPayloads.payloadJsons;
      // CrossTrade destination: when configured, dispatches are converted to
      // CrossTrade's flat command JSON and posted to its webhook URL instead of
      // the TradersPost endpoint. The broker_orders ledger still records the
      // internal TradersPost-shaped payload fields (ticker/action/qty/prices).
      const crossTrade: CrossTradeDestination | undefined =
        isCrossTradeConfigured(destination)
          ? {
              webhookUrl: destination.crossTradeWebhookUrl!,
              secretKey: destination.crossTradeSecretKey!,
              accountName: destination.crossTradeAccountName || accountName,
            }
          : undefined;
      // User-facing strings must name the actual destination — CT failures
      // labelled "TradersPost" send operators looking at the wrong broker.
      const destinationLabel = crossTrade ? 'CrossTrade' : 'TradersPost';
      // Range-configured dispatch policy for CT (see toCrossTradeMessage):
      //  - breakEvenEnabled ranges attach atm_strategy named after the range; a
      //    missing NT8 template rejects the entry — intentional, an unprotected
      //    BE range must not run.
      //  - ocoMode 'both' drops the native OCO pairing so both arms can be live.
      const applyCrossTradeRangePolicy = (payload: TradersPostPayload): TradersPostPayload =>
        crossTradeRangePolicy(payload, context?.rangeName);
      // Mandatory protection bookkeeping. When the entry reached — or may have
      // reached — TradersPost (acknowledged, uncertain, or released mid-flight),
      // the obligation must exist so protectionReady pauses re-arms until the
      // take profit is actually delivered. Creating these rows is additive
      // bookkeeping: it never conflicts with the queue-failure path, which owns
      // the in-flight delivery's status. Only a definite rejection proves no
      // entry exists and excuses the obligation.
      const ensurePreciseTakeProfitObligation = () => {
        if (!preparedPayloads.preciseTakeProfitIntent || !context?.rangeName) return undefined;
        const preciseIntent = database.upsertPreciseTakeProfitIntent({
          accountId: delivery.accountId,
          rangeName: context.rangeName,
          ...preparedPayloads.preciseTakeProfitIntent,
        });
        if (database.hasPreciseTakeProfitDelivery(
          delivery.accountId,
          context.rangeName,
          preciseIntent.bracketId,
          preciseIntent.side,
        )) return undefined;
        const preciseAlert = database.createProxyAlert({
          rangeName: context.rangeName,
          action: preciseIntent.action,
          ticker: preciseIntent.instrument,
          payloadJson: preciseIntent.payloadJson,
          sourceReference: preciseIntent.bracketId,
        });
        const preciseDelivery = database.createProxyDelivery({
          proxyAlertId: preciseAlert.id,
          rangeRouteId: delivery.rangeRouteId,
          userId: delivery.userId,
          accountId: delivery.accountId,
          extensionEnabled: false,
          traderspostEnabled: true,
          status: 'pending_traderspost',
        });
        return { preciseIntent, preciseAlert, preciseDelivery, rangeName: context.rangeName };
      };
      console.info('[traderspost] Sending delivery', {
        deliveryId: delivery.id,
        accountId: delivery.accountId,
        userId: delivery.userId,
        source: context?.source ?? 'proxy',
        rangeName: context?.rangeName ?? null,
        outboundTicker: destination.outboundTicker ?? null,
        outboundTickerMode: destination.outboundTickerMode ?? null,
        payloadCount: outboundPayloadJsons.length,
      });

      const successfulResponses: Array<{ statusCode: number }> = [];
      // Each actual outbound request gets its own ledger row: a retry of the same
      // delivery suffixes the order id so the prior attempt's status/error is retained.
      const priorAttempts = database.listProxyDeliveryAttempts(delivery.id).length;
      for (let i = 0; i < outboundPayloadJsons.length; i += 1) {
        if (released()) {
          if (successfulResponses.length > 0) ensurePreciseTakeProfitObligation();
          return database.findProxyDelivery(delivery.id) ?? delivery;
        }
        const requestPayload = (() => {
          try {
            return JSON.parse(outboundPayloadJsons[i]) as Record<string, unknown>;
          } catch {
            return { raw: outboundPayloadJsons[i] };
          }
        })();
        // Ledger the prepared outbound request (post destination transforms) so the row
        // reflects what TradersPost actually receives — mapped ticker and micro quantity.
        // context.brokerOrderId is the logical identity (alias/monitor linkage); each
        // resend still gets its own attempt row so a prior rejection is not overwritten.
        // NT8 permanently burns oco_id/order_id once used — a re-armed bracket
        // resend (Ultra reuses the id after a terminal close) must leave under a
        // fresh wire id or NT8 rejects the order outright. Attempt sequence =
        // count of prior delivered entry dispatches for this arm, so both arms
        // of a re-armed pair suffix identically and OCO pairing survives.
        let ctPayload = requestPayload;
        if (crossTrade && typeof requestPayload.bracketId === 'string'
            && (requestPayload.action === 'buy' || requestPayload.action === 'sell')) {
          const priorCt = database.countDeliveredBracketEntryDispatches(
            delivery.accountId,
            context?.rangeName ?? (typeof parsed?.extras?.rangeName === 'string' ? parsed.extras.rangeName : 'untracked'),
            requestPayload.bracketId,
            requestPayload.action,
            requestPayload.bracketSide === 'short' ? 'short' : 'long',
            delivery.id,
          );
          if (priorCt > 0) {
            ctPayload = { ...requestPayload, bracketId: `${requestPayload.bracketId}-a${priorCt}` };
          }
        }
        // Ledger order_id carries the wire id (suffixed on resends) so NT8
        // probes and book verifies look up what the broker actually saw;
        // bracket_id keeps the logical Ultra id for monitor/journal joins.
        const logicalOrderId = crossTrade && typeof ctPayload.bracketId === 'string'
          ? ctPayload.bracketId
          : context?.brokerOrderId;
        const brokerOrderId = logicalOrderId
          ? `${logicalOrderId}${priorAttempts > 0 ? `-r${priorAttempts}` : ''}${i === 0 ? '' : `-${i}`}`
          : `bridge-${delivery.id}${priorAttempts > 0 ? `-r${priorAttempts}` : ''}${i === 0 ? '' : `-${i}`}`;
        const outboundBody = crossTrade
          ? JSON.stringify(toCrossTradeMessage(
              applyCrossTradeRangePolicy(ctPayload as TradersPostPayload),
              crossTrade,
              context?.source,
            ))
          : outboundPayloadJsons[i];
        const requestRangeName = context?.rangeName
          ?? (typeof parsed?.extras?.rangeName === 'string' ? parsed.extras.rangeName : undefined)
          ?? 'untracked';
        database.upsertBrokerOrder({
          accountId: delivery.accountId,
          rangeName: requestRangeName,
          bracketId: typeof requestPayload.bracketId === 'string' ? requestPayload.bracketId : undefined,
          orderId: brokerOrderId,
          action: (requestPayload.action ?? parsed?.action ?? 'buy') as BrokerOrderAction,
          status: 'pending',
          instrument: typeof requestPayload.ticker === 'string' ? requestPayload.ticker : parsed?.ticker ?? 'unknown',
          side: requestPayload.bracketSide === 'long' || requestPayload.bracketSide === 'short' ? requestPayload.bracketSide : undefined,
          quantity: typeof requestPayload.quantity === 'number' ? requestPayload.quantity : undefined,
          price: typeof requestPayload.price === 'number' ? requestPayload.price : undefined,
          stopPrice: typeof requestPayload.stopPrice === 'number' ? requestPayload.stopPrice : undefined,
          limitPrice: typeof requestPayload.limitPrice === 'number' ? requestPayload.limitPrice : undefined,
          proxyAlertId: delivery.proxyAlertId,
          proxyDeliveryId: delivery.id,
          destination: crossTrade ? 'crosstrade' : 'traderspost',
          // Snapshot the policy-applied payload (BE/OCO/current range config)
          // — retries replay THIS, immune to later config changes.
          payloadJson: crossTrade
            ? JSON.stringify(applyCrossTradeRangePolicy(ctPayload as TradersPostPayload))
            : outboundPayloadJsons[i],
          occurredAt: context?.occurredAt ?? delivery.createdAt,
        });
        // Stop-only ranges refuse non-stop entries at the wire: a limit/market
        // entry means the level was already crossed (Ultra picks 'limit' when
        // the edge is inside the current price), so the arm stays locally
        // armed while nothing reaches the broker — no late fill on reversal.
        const stopOnlyBlocked = Boolean(crossTrade
          && (requestPayload.action === 'buy' || requestPayload.action === 'sell')
          && !['stop', 'stop_limit', 'trailing_stop'].includes(String(requestPayload.orderType))
          && database.getRangeConfiguration(requestRangeName)?.stopOnlyEntries);
        if (stopOnlyBlocked) {
          const blockReason = `stop-only range — ${String(requestPayload.orderType ?? 'market')} entry not dispatched (level already crossed)`;
          database.updateBrokerOrderStatus(delivery.accountId, brokerOrderId, 'rejected', blockReason, delivery.id, 'bridge');
          database.createProxyDeliveryAttempt({ proxyDeliveryId: delivery.id, success: false, errorText: blockReason });
          database.createBridgeLog(delivery.userId, 'crosstrade', {
            event: 'crossTradeStopOnlyBlocked', accountId: delivery.accountId, accountName,
            rangeName: requestRangeName, bracketId: requestPayload.bracketId, orderType: requestPayload.orderType, reason: blockReason,
          });
          emitToUser(delivery.userId, 'toast:warning', {
            persistent: true,
            rangeName: requestRangeName,
            message: `${requestRangeName}: ${String(requestPayload.orderType ?? 'market')} entry blocked — stop-only mode, level already crossed`,
          });
          return database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, false))!;
        }
        emitToUser(delivery.userId, 'log:bridge', {
          category: 'traderspost',
          phase: 'request',
          timestamp: new Date().toISOString(),
          accountId: delivery.accountId,
          accountName,
          source: context?.source ?? 'proxy',
          rangeName: context?.rangeName ?? null,
          payload: crossTrade ? redactCrossTradeMessage(JSON.parse(outboundBody) as CrossTradeMessage) : requestPayload,
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        // Hard cap: abort() does not always settle a stuck undici fetch, so race
        // the request (and the body read) against a ceiling that always resolves.
        let hardTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const hardTimeout = new Promise<never>((_, reject) => {
          hardTimeoutHandle = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error('request never settled'), { name: 'AbortError' }));
          }, options.traderspostHardTimeoutMs ?? 20_000);
        });
        // The transport retry is a second outbound POST, so it gets its own
        // broker_orders row (-r<n> suffix like operator resends) — one row per
        // dispatch keeps the failed attempt's evidence instead of overwriting it.
        let activeBrokerOrderId = brokerOrderId;
        try {
          const { response, responseBody } = await (async () => {
            for (let sendAttempt = 0; ; sendAttempt++) {
              const sendSignals = context?.taskSignal
                ? [controller.signal, limiterSignal, context.taskSignal]
                : [controller.signal, limiterSignal];
              let res: Awaited<ReturnType<typeof fetchImplementation>>;
              try {
                if (sendAttempt > 0) {
                  await abortableDelay(TRADERSPOST_TRANSPORT_RETRY_DELAY_MS, sendSignals);
                  if (released()) throw limiterSignal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
                  activeBrokerOrderId = `${brokerOrderId}-r${sendAttempt}`;
                  database.upsertBrokerOrder({
                    accountId: delivery.accountId,
                    rangeName: requestRangeName,
                    bracketId: typeof requestPayload.bracketId === 'string' ? requestPayload.bracketId : undefined,
                    orderId: activeBrokerOrderId,
                    action: (requestPayload.action ?? parsed?.action ?? 'buy') as BrokerOrderAction,
                    status: 'pending',
                    instrument: typeof requestPayload.ticker === 'string' ? requestPayload.ticker : parsed?.ticker ?? 'unknown',
                    side: requestPayload.bracketSide === 'long' || requestPayload.bracketSide === 'short' ? requestPayload.bracketSide : undefined,
                    quantity: typeof requestPayload.quantity === 'number' ? requestPayload.quantity : undefined,
                    price: typeof requestPayload.price === 'number' ? requestPayload.price : undefined,
                    stopPrice: typeof requestPayload.stopPrice === 'number' ? requestPayload.stopPrice : undefined,
                    limitPrice: typeof requestPayload.limitPrice === 'number' ? requestPayload.limitPrice : undefined,
                    proxyAlertId: delivery.proxyAlertId,
                    proxyDeliveryId: delivery.id,
                    destination: crossTrade ? 'crosstrade' : 'traderspost',
                    payloadJson: outboundPayloadJsons[i],
                    occurredAt: context?.occurredAt ?? delivery.createdAt,
                  });
                }
                res = await Promise.race([
                  fetchImplementation(crossTrade?.webhookUrl ?? destination.webhookUrl, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: outboundBody,
                    signal: AbortSignal.any(sendSignals),
                  }),
                  hardTimeout,
                ]);
              } catch (sendError) {
                // One automatic retry for transport failures — plus timeouts for
                // cancel/exit, which are safe to duplicate at the broker. Entry
                // timeouts stay single-shot because the order may already be
                // live.
                const retryable = isTransportFetchError(sendError)
                  || (isFlattenAction(requestPayload.action ?? parsed?.action) && isAbortFetchError(sendError));
                if (released() || sendAttempt >= TRADERSPOST_TRANSPORT_RETRIES || !retryable) {
                  throw sendError;
                }
                const retryReason = `${sendError instanceof Error ? sendError.message : String(sendError)}${describeErrorCause(sendError) ? ` — ${describeErrorCause(sendError)}` : ''}`;
                // The failed send may still have reached TradersPost — its ledger
                // row stays uncertain rather than being overwritten by the retry.
                database.updateBrokerOrderStatus(delivery.accountId, activeBrokerOrderId, 'uncertain', `Transport attempt failed (retrying once): ${retryReason}`, delivery.id);
                database.createProxyDeliveryAttempt({
                  proxyDeliveryId: delivery.id,
                  success: false,
                  errorText: `Transport attempt failed (retrying once): ${retryReason}`,
                });
                emitToUser(delivery.userId, 'log:bridge', {
                  category: 'traderspost',
                  phase: 'error',
                  timestamp: new Date().toISOString(),
                  deliveryId: delivery.id,
                  accountId: delivery.accountId,
                  accountName,
                  source: context?.source ?? 'proxy',
                  rangeName: context?.rangeName ?? null,
                  errorText: `Transport attempt failed, retrying once: ${retryReason}`,
                  rawMessage: sendError instanceof Error ? sendError.message : String(sendError),
                  errorCause: describeErrorCause(sendError),
                  willRetry: true,
                  payload: requestPayload,
                });
                continue;
              }
              // Body-read failures happen after the POST was accepted — retrying
              // them could duplicate the order, so they stay single-shot.
              const body = await Promise.race([res.text(), hardTimeout]);
              return { response: res, responseBody: body };
            }
          })();
          if (released()) {
            // The account queue was released while the request was in flight.
            // The queue-level failure path owns the ledger — mutating here
            // would race the next account task. The obligation rows are
            // additive bookkeeping, so they are still persisted: the entry may
            // already be live at the broker without recorded protection.
            ensurePreciseTakeProfitObligation();
            return database.findProxyDelivery(delivery.id) ?? delivery;
          }
          let tradersPostBodySuccess: boolean | undefined;
          let tradersPostFailureMessage: string | undefined;
          try {
            const parsed = JSON.parse(responseBody) as { success?: boolean; failureMessage?: string; error?: string; message?: string } | undefined;
            tradersPostBodySuccess = parsed?.success;
            tradersPostFailureMessage = parsed?.failureMessage ?? parsed?.error;
          } catch {
            tradersPostBodySuccess = undefined;
          }
          const success = response.ok && tradersPostBodySuccess === true;
          emitToUser(delivery.userId, 'log:bridge', {
            category: 'traderspost',
            phase: 'response',
            timestamp: new Date().toISOString(),
            accountId: delivery.accountId,
            accountName,
            source: context?.source ?? 'proxy',
            rangeName: context?.rangeName ?? null,
            statusCode: response.status,
            httpSuccess: response.ok,
            tradersPostSuccess: tradersPostBodySuccess,
            success,
            responseBody,
            payload: requestPayload,
          });
          console.info('[traderspost] Delivery completed', {
            deliveryId: delivery.id,
            accountId: delivery.accountId,
            userId: delivery.userId,
            source: context?.source ?? 'proxy',
            rangeName: context?.rangeName ?? null,
            index: i,
            statusCode: response.status,
            httpSuccess: response.ok,
            tradersPostSuccess: tradersPostBodySuccess,
            success,
            responseBody,
          });
          if (!success) {
            const errorText = tradersPostFailureMessage
              ?? (tradersPostBodySuccess === false
                ? (responseBody || `${destinationLabel} trade plan failed`)
                : (responseBody || `${destinationLabel} responded with HTTP ${response.status}`));
            database.createProxyDeliveryAttempt({
              proxyDeliveryId: delivery.id,
              statusCode: response.status,
              success: false,
              errorText,
            });
            const signal = [
              requestPayload.ticker,
              requestPayload.action,
              requestPayload.quantity != null ? `×${requestPayload.quantity}` : '',
            ]
              .filter(Boolean)
              .join(' ');
            const reasonText = tradersPostFailureMessage
              ? `${destinationLabel} rejected the order: ${tradersPostFailureMessage}`
              : tradersPostBodySuccess === false
                ? `${destinationLabel} rejected the order: ${errorText}`
                : `HTTP ${response.status}`;
            if (!crossTrade) {
              emitToUser(delivery.userId, 'toast:error', {
                message: `${destinationLabel} failed for ${accountName}${context?.rangeName ? ` · ${context.rangeName}` : ''}${signal ? ` · ${signal}` : ''}: ${reasonText}`,
                persistent: true,
                ...(context?.rangeName ? { rangeName: context.rangeName } : {}),
              });
            }
            // A sub-500 response carrying an explicit refusal message
            // (CrossTrade's {error} envelope — e.g. a missing ATM template) is a
            // definite rejection: the command was received and refused, so it
            // is not ambiguous in the way a bare 2xx-without-success is.
            const definiteReject = response.status < 500 && response.status !== 408
              && (tradersPostBodySuccess === false || response.status >= 400 || tradersPostFailureMessage != null);
            if (!definiteReject) ensurePreciseTakeProfitObligation();
            database.updateBrokerOrderStatus(delivery.accountId, activeBrokerOrderId, definiteReject ? 'rejected' : 'uncertain', errorText, delivery.id);
            return database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, false))!;
          }
          database.updateBrokerOrderStatus(delivery.accountId, activeBrokerOrderId, 'acknowledged', undefined, delivery.id);
          successfulResponses.push({ statusCode: response.status });
        } catch (error) {
          if (released()) {
            // Watchdog abort — the queue-level failure path owns the ledger.
            ensurePreciseTakeProfitObligation();
            return database.findProxyDelivery(delivery.id) ?? delivery;
          }
          const isTimeout = error instanceof Error && error.name === 'AbortError';
          const rawMessage = error instanceof Error && error.message ? error.message : String(error);
          const errorCause = describeErrorCause(error);
          const errorText = isTimeout
            ? `${destinationLabel} request timed out: ${rawMessage}`
            : `${destinationLabel} request failed: ${rawMessage}${errorCause ? ` — ${errorCause}` : ''}`;
          console.warn('[traderspost] Delivery failed', {
            deliveryId: delivery.id,
            accountId: delivery.accountId,
            userId: delivery.userId,
            source: context?.source ?? 'proxy',
            rangeName: context?.rangeName ?? null,
            errorText,
            rawMessage,
            errorCause,
          });
          database.createProxyDeliveryAttempt({
            proxyDeliveryId: delivery.id,
            success: false,
            errorText,
          });
          const signal = [
            requestPayload.ticker,
            requestPayload.action,
            requestPayload.quantity != null ? `×${requestPayload.quantity}` : '',
          ]
            .filter(Boolean)
            .join(' ');
          emitToUser(delivery.userId, 'log:bridge', {
            category: 'traderspost',
            phase: 'error',
            timestamp: new Date().toISOString(),
            deliveryId: delivery.id,
            accountId: delivery.accountId,
            accountName,
            source: context?.source ?? 'proxy',
            rangeName: context?.rangeName ?? null,
            errorText,
            rawMessage,
            errorCause,
            payload: requestPayload,
          });
          if (!crossTrade) {
            emitToUser(delivery.userId, 'toast:error', {
              message: `${destinationLabel} failed for ${accountName}${context?.rangeName ? ` · ${context.rangeName}` : ''}${signal ? ` · ${signal}` : ''}: ${errorText}`,
              persistent: true,
              ...(context?.rangeName ? { rangeName: context.rangeName } : {}),
            });
          }
          database.updateBrokerOrderStatus(delivery.accountId, activeBrokerOrderId, 'uncertain', errorText, delivery.id);
          // A failed/uncertain CT send still merits a book check — the order
          // may have reached NT8 despite the transport error.
          if (crossTrade) scheduleCtBookVerify(delivery.accountId);
          const finalDelivery = database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, false))!;
          // Back-of-queue retry: re-enqueue this delivery after a delay for
          // the same failure class the inline retry accepts. The status just
          // written (…_failed) is in the sendable set, so the re-enqueued
          // task passes the guard — and still re-reads it at send time, so a
          // suppression landing during the delay kills the retry too.
          // Deferred retries are flatten/cancel-only: an entry transport
          // failure is already 'uncertain' (either POST may have reached the
          // broker) and a further automatic resend risks duplicate exposure —
          // ambiguous entries need reconciliation or explicit operator resend.
          const deferredRetryable = isFlattenAction(requestPayload.action ?? parsed?.action)
            && (isTransportFetchError(error) || isAbortFetchError(error));
          const deferredAttemptCount = database.listProxyDeliveryAttempts(delivery.id).length;
          // A lane in breaker cooldown already means the destination is down —
          // piling deferred sends on top just deepens the backlog it must
          // chew through when it recovers.
          const laneCoolingDown = (traderspostRateLimiter.breakerState(crossTrade?.webhookUrl ?? destination.webhookUrl).cooldownUntilMs ?? 0) > Date.now();
          if (deferredRetryable && !laneCoolingDown && deferredAttemptCount <= TRADERSPOST_DEFERRED_RETRIES + 1) {
            const delayMs = (options.traderspostDeferredRetryBaseMs ?? TRADERSPOST_DEFERRED_RETRY_BASE_MS) * Math.max(1, deferredAttemptCount - 1);
            console.info('[traderspost] Scheduling deferred retry', {
              deliveryId: delivery.id,
              accountId: delivery.accountId,
              source: context?.source ?? 'proxy',
              rangeName: context?.rangeName ?? null,
              attempt: deferredAttemptCount,
              delayMs,
            });
            emitToUser(delivery.userId, 'log:bridge', {
              category: 'traderspost',
              phase: 'error',
              timestamp: new Date().toISOString(),
              deliveryId: delivery.id,
              accountId: delivery.accountId,
              accountName,
              source: context?.source ?? 'proxy',
              rangeName: context?.rangeName ?? null,
              errorText: `Deferred retry queued in ${Math.round(delayMs / 1000)}s (attempt ${deferredAttemptCount})`,
              willRetry: true,
              payload: requestPayload,
            });
            setTimeout(() => {
              // Fresh task on the OUTER account queue — entering the inner
              // limiter directly would let this retry slip between a running
              // reapply/safeguard operation's cancel/exit/rearm steps. The
              // fresh taskSignal keeps the watchdog semantics intact.
              void reapply.queue.run(delivery.accountId, (taskSignal) =>
                forwardToTradersPost(finalDelivery, payloadJson, { ...(context ?? {}), taskSignal, queueNext: false }),
              ).catch((retryErr) => {
                  console.warn('[traderspost] Deferred retry task failed', {
                    deliveryId: delivery.id,
                    error: retryErr instanceof Error ? retryErr.message : String(retryErr),
                  });
                });
            }, delayMs).unref();
          }
          return finalDelivery;
        } finally {
          clearTimeout(timeout);
          clearTimeout(hardTimeoutHandle);
        }
      }
      if (!crossTrade) {
        emitToUser(delivery.userId, 'toast:success', {
          message: `${destinationLabel} sent to ${accountName}${context?.rangeName ? ` for ${context.rangeName}` : ''}`,
          ...(context?.rangeName ? { rangeName: context.rangeName } : {}),
        });
      }
      // The ACK only means CrossTrade received it — NT8 can still reject the
      // order asynchronously. Schedule one debounced book read for the account
      // so a burst of sends reconciles against NT8's real order list once.
      if (crossTrade) scheduleCtBookVerify(delivery.accountId);
      const preciseObligation = ensurePreciseTakeProfitObligation();
      if (preciseObligation) {
        const { preciseIntent, preciseAlert, preciseDelivery, rangeName } = preciseObligation;
        const entryAction = preciseIntent.side === 'long' ? 'buy' : 'sell';
          if (released()) {
            // The queue already released this account — dispatching now could
            // interleave with the next task's orders. Leave the delivery pending
            // (resendable) and flag it: protectionReady pauses re-arms until the
            // take profit is actually delivered.
            console.warn('[traderspost] Precise take profit left pending after watchdog release', {
              deliveryId: delivery.id,
              preciseDeliveryId: preciseDelivery.id,
              accountId: delivery.accountId,
              rangeName,
              bracketId: preciseIntent.bracketId,
            });
            if (!crossTrade) {
              emitToUser(delivery.userId, 'toast:error', {
                message: `Entry sent to ${accountName} for ${rangeName} but its take profit was not dispatched — reconcile and resend the pending delivery`,
                persistent: true,
                rangeName,
              });
            }
          } else {
          immediatePreciseTakeProfitPromise = forwardToTradersPost(
            preciseDelivery,
            preciseAlert.payloadJson,
            {
              source: 'entry_precise_take_profit',
              userId: delivery.userId,
              rangeName,
              queueNext: true,
              ...(context?.taskSignal ? { taskSignal: context.taskSignal } : {}),
              preflight: () => {
                const queuedRoute = database.findCurrentRangeRoute(
                  delivery.rangeRouteId,
                  delivery.accountId,
                  rangeName,
                );
                if (!queuedRoute?.traderspostEnabled) {
                  return { allowed: false, reason: 'Matching TradersPost range route is missing or disabled', status: 'routing_disabled' };
                }
                if (!database.getTradersPostAccountDestination(delivery.accountId)?.enabled) {
                  return { allowed: false, reason: 'TradersPost destination is missing or disabled', status: 'routing_disabled' };
                }
                if (!database.hasDeliveredEntryForBracket(
                  delivery.accountId,
                  rangeName,
                  preciseIntent.bracketId,
                  entryAction,
                  preciseIntent.side,
                )) {
                  return { allowed: false, reason: 'Initial entry was not delivered', status: 'suppressed_guard' };
                }
                if (database.hasClosedOrCancelledLifecycleForBracket(
                  delivery.accountId,
                  rangeName,
                  preciseIntent.instrument,
                  preciseIntent.side,
                  preciseIntent.bracketId,
                )) {
                  return { allowed: false, reason: 'Entry bracket was already closed or cancelled', status: 'suppressed_guard' };
                }
                if (database.hasSuccessfulPreciseTakeProfitDelivery(
                  delivery.accountId,
                  rangeName,
                  preciseIntent.bracketId,
                  preciseIntent.side,
                  preciseDelivery.id,
                )) {
                  return { allowed: false, reason: 'Precise take profit was already delivered for this bracket side', status: 'suppressed_duplicate' };
                }
                return { allowed: true };
              },
            },
          );
          }
      }
      for (const response of successfulResponses) {
        database.createProxyDeliveryAttempt({
          proxyDeliveryId: delivery.id,
          statusCode: response.statusCode,
          success: true,
        });
      }
      return database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, true))!;
    }, undefined, deliveryOutcome);
    await immediatePreciseTakeProfitPromise;
    return updatedDelivery;
  };

  const sendPreciseTakeProfitCleanup = async (input: {
    route: RangeRoute;
    bracketId: string;
    side: 'long' | 'short';
    instrument: string;
    occurredAt: string;
    cleanupEventId: string;
    reason: 'precise_tp_entry_cancel_cleanup' | 'precise_tp_stopout_cleanup' | 'precise_tp_opposite_entry_cleanup';
    requireClosedLifecycle: boolean;
  }): Promise<void> => {
    const { route, bracketId, side, instrument, occurredAt, cleanupEventId, reason, requireClosedLifecycle } = input;
    const destination = database.getTradersPostAccountDestination(route.accountId);
    if (!destination) return;
    const intent = database.findPreciseTakeProfitIntent(
      route.accountId,
      route.rangeName,
      bracketId,
      side,
    );
    const intentPayload = intent ? parseStoredProxyPayload(intent.payloadJson) : undefined;
    if (!intent || !intentPayload || isLifecyclePayload(intentPayload)) return;
    if (requireClosedLifecycle && database.hasOpenLifecycleQuantityForBracket(
      route.accountId,
      route.rangeName,
      instrument,
      side,
      bracketId,
    )) return;
    if (database.hasPreciseTakeProfitCleanupDelivery(
      route.accountId,
      route.rangeName,
      bracketId,
      side,
    )) return;

    const cleanupPayload: TradersPostPayload = {
      ticker: intentPayload.ticker,
      action: 'cancel',
      cancelOrderType: 'limit',
      bracketId,
      bracketSide: side,
      time: occurredAt,
      extras: {
        rangeName: route.rangeName,
        reason,
        preciseTakeProfitStopoutCleanup: true,
        lifecycleEventId: cleanupEventId,
      },
    };
    const cleanupAlert = database.createProxyAlert({
      rangeName: route.rangeName,
      action: 'cancel',
      ticker: intentPayload.ticker,
      payloadJson: JSON.stringify(cleanupPayload),
      sourceReference: bracketId,
    });
    const cleanupDelivery = database.createProxyDelivery({
      proxyAlertId: cleanupAlert.id,
      rangeRouteId: route.id,
      userId: route.userId,
      accountId: route.accountId,
      extensionEnabled: false,
      traderspostEnabled: true,
      status: 'pending_traderspost',
    });
    await forwardToTradersPost(cleanupDelivery, cleanupAlert.payloadJson, {
      source: 'precise_take_profit_cleanup',
      userId: route.userId,
      rangeName: route.rangeName,
      preflight: () => {
        if (!database.hasSuccessfulPreciseTakeProfitDelivery(
          route.accountId,
          route.rangeName,
          bracketId,
          side,
        )) {
          return { allowed: false, reason: 'No successful precise take profit requires cleanup', status: 'suppressed_guard' };
        }
        if (database.hasSuccessfulPreciseTakeProfitCleanupDelivery(
          route.accountId,
          route.rangeName,
          bracketId,
          side,
          cleanupDelivery.id,
        )) {
          return { allowed: false, reason: 'Precise take profit cleanup already succeeded for this bracket side', status: 'suppressed_duplicate' };
        }
        if (requireClosedLifecycle && database.hasOpenLifecycleQuantityForBracket(
          route.accountId,
          route.rangeName,
          instrument,
          side,
          bracketId,
        )) {
          return { allowed: false, reason: 'Precise take profit bracket is open again', status: 'suppressed_guard' };
        }
        return { allowed: true };
      },
    });
  };

  const recordBridgeGeneratedEntryCancelled = (
    delivery: { userId: string; accountId: string; proxyAlertId?: string },
    payload: {
      ticker: string;
      action?: unknown;
      tradeId?: unknown;
      quantity?: unknown;
      bracketSide?: unknown;
      extras?: Record<string, unknown>;
    },
    occurredAt: string,
  ): void => {
    const extras = typeof payload.extras === 'object' && payload.extras ? payload.extras : {};
    const reason = typeof extras.reason === 'string' ? extras.reason : '';
    const isAutomatedCancellation = reason.startsWith('eod_') || reason.startsWith('reconcile_') || reason.startsWith('reapply_') || reason.startsWith('news_flatten_') || reason.startsWith('deprecated_') || reason === 'cancel_all_safeguard';
    if (
      !isAutomatedCancellation
      || payload.action !== 'cancel'
      || typeof payload.tradeId !== 'string'
      || typeof payload.quantity !== 'number'
      || typeof extras.rangeName !== 'string'
      || (payload.bracketSide !== 'long' && payload.bracketSide !== 'short')
    ) return;

    const bracketId = payload.tradeId.includes('-lifecycle-')
      ? payload.tradeId.split('-lifecycle-')[0]
      : payload.tradeId;
    if (database.hasClosedOrCancelledLifecycleForBracket(delivery.accountId, extras.rangeName, payload.ticker, payload.bracketSide, bracketId)) {
      const monitor = database.findBracketMonitorEntry(delivery.accountId, extras.rangeName, bracketId, payload.bracketSide);
      if (monitor) {
        // The caller's armed snapshot predates its awaited broker requests; Pine may
        // have filled and closed while the request was in flight. A filled monitor
        // is a closed position, not an unfilled cancellation — retire it as a
        // trade_closed like recordFlattenedPositions does, and never regress an
        // already-resolved row.
        if (monitor.state === 'filled') {
          database.retireBracketMonitorEntry(delivery.userId, monitor, 'trade_closed', `${payload.tradeId}-${reason}_reconcile_trade_closed`, occurredAt);
        } else if (monitor.state === 'armed') {
          database.retireBracketMonitorEntry(delivery.userId, monitor, 'entry_cancelled', `${payload.tradeId}-${reason}_reconcile_entry_cancelled`, occurredAt);
        }
      }
      return;
    }

    // The caller's armed snapshot predates its awaited broker requests; a Pine fill
    // or close can land in between (monitor writes do not wait on the account queue).
    // Never synthesize cancel/close history for a live or resolved position.
    const currentMonitor = database.findBracketMonitorEntry(delivery.accountId, extras.rangeName, bracketId, payload.bracketSide);
    if (currentMonitor?.state === 'filled' || currentMonitor?.state === 'closed') return;

    const eventId = `${payload.tradeId}-entry_cancelled-leg-0`;
    try {
      database.createRangeTradeEvent({
        rangeName: extras.rangeName,
        eventId,
        tradeId: payload.tradeId,
        eventType: 'entry_cancelled',
        instrument: payload.ticker,
        side: payload.bracketSide,
        action: 'cancel',
        quantity: payload.quantity,
        occurredAt,
        ...(delivery.proxyAlertId ? { proxyAlertId: delivery.proxyAlertId } : {}),
      });
    } catch (error) {
      console.warn('[lifecycle] Failed to record range entry_cancelled for automated cancel', {
        tradeId: payload.tradeId,
        rangeName: extras.rangeName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const { event: cancelledEvent } = database.createTradeEvent({
      userId: delivery.userId,
      accountId: delivery.accountId,
      rangeName: extras.rangeName,
      eventId,
      tradeId: payload.tradeId,
      eventType: 'entry_cancelled',
      instrument: payload.ticker,
      side: payload.bracketSide,
      action: 'cancel',
      quantity: payload.quantity,
      occurredAt,
      ...(delivery.proxyAlertId ? { proxyAlertId: delivery.proxyAlertId } : {}),
    });

    if (reason.startsWith('eod_') || reason.startsWith('reconcile_') || reason === 'cancel_all_safeguard') {
      try {
        const { event: closedEvent } = database.createTradeEvent({
          userId: delivery.userId,
          accountId: delivery.accountId,
          rangeName: extras.rangeName,
          eventId: `${payload.tradeId}-${reason}_trade_closed`,
          tradeId: payload.tradeId,
          eventType: 'trade_closed',
          instrument: payload.ticker,
          side: payload.bracketSide,
          action: 'exit',
          quantity: payload.quantity,
          occurredAt,
          realizedTicksCents: 0,
          realizedDollarsCents: 0,
          outcome: 'breakeven',
          ...(delivery.proxyAlertId ? { proxyAlertId: delivery.proxyAlertId } : {}),
        });
        database.setTradeEventPerformanceExclusion(delivery.userId, closedEvent.id, 'erroneous', delivery.userId);
      } catch (error) {
        console.warn('[lifecycle] Failed to record erroneous trade_closed for automated cancel', {
          tradeId: payload.tradeId,
          rangeName: extras.rangeName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const recordBreakevenTradeClosed = (
    userId: string,
    accountId: string,
    event: TradeEvent,
    occurredAt: string,
  ): boolean => {
    const source = 'reconcile';
    const shared = {
      tradeId: event.tradeId,
      instrument: event.instrument,
      side: event.side,
      quantity: event.quantity,
      occurredAt,
    };
    try {
      database.createRangeTradeEvent({
        rangeName: event.rangeName,
        ...shared,
        eventId: `${event.tradeId}-${source}-trade_closed`,
        eventType: 'trade_closed',
        action: 'exit',
        entryPrice: event.entryPrice,
        exitPrice: event.entryPrice,
        realizedTicksCents: 0,
        realizedDollarsCents: 0,
        outcome: 'breakeven',
      });
    } catch (error) {
      console.warn('[reconcile] Failed to record range trade_closed for reconciled trade', {
        tradeId: event.tradeId,
        rangeName: event.rangeName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let closedTrade: TradeEvent | undefined;
    try {
      const result = database.createTradeEvent({
        userId,
        accountId,
        rangeName: event.rangeName,
        ...shared,
        eventId: `${event.tradeId}-${source}-trade_closed`,
        eventType: 'trade_closed',
        action: 'exit',
        entryPrice: event.entryPrice,
        exitPrice: event.entryPrice,
        realizedTicksCents: 0,
        realizedDollarsCents: 0,
        outcome: 'breakeven',
      });
      closedTrade = result.event;
    } catch (error) {
      console.warn('[reconcile] Failed to record account trade_closed for reconciled trade', {
        accountId,
        tradeId: event.tradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      database.setTradeEventPerformanceExclusion(userId, event.id, 'erroneous', userId);
      if (closedTrade) database.setTradeEventPerformanceExclusion(userId, closedTrade.id, 'erroneous', userId);
    } catch (error) {
      console.warn('[reconcile] Failed to mark reconciled trade as erroneous', {
        accountId,
        tradeId: event.tradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  };

  const recordBreakevenCloseForTrade = (
    userId: string,
    accountId: string,
    instrument: string,
    pos: ReturnType<Database['getOpenPositionsForAccount']>[number],
    occurredAt: string,
  ): boolean => {
    const source = 'reconcile';
    const shared = {
      tradeId: pos.tradeId,
      instrument,
      side: pos.side,
      quantity: pos.openQuantity,
      occurredAt,
    };
    const events = [
      {
        eventId: `${pos.tradeId}-${source}-exit_filled`,
        eventType: 'exit_filled' as const,
        action: 'exit' as const,
      },
      {
        eventId: `${pos.tradeId}-${source}-trade_closed`,
        eventType: 'trade_closed' as const,
        action: 'exit' as const,
        entryPrice: pos.entryPrice,
        exitPrice: pos.entryPrice,
        realizedTicksCents: 0,
        realizedDollarsCents: 0,
        outcome: 'breakeven' as const,
      },
    ];
    const createdAccountEvents: TradeEvent[] = [];
    for (const evt of events) {
      try {
        database.createRangeTradeEvent({ rangeName: pos.rangeName, ...shared, ...evt });
      } catch (error) {
        console.warn('[reconcile] Failed to record range event for reconciled trade', {
          tradeId: pos.tradeId,
          rangeName: pos.rangeName,
          eventId: evt.eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        const result = database.createTradeEvent({ userId, accountId, rangeName: pos.rangeName, ...shared, ...evt });
        createdAccountEvents.push(result.event);
      } catch (error) {
        console.warn('[reconcile] Failed to record account event for reconciled trade', {
          accountId,
          tradeId: pos.tradeId,
          eventId: evt.eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      for (const created of createdAccountEvents) {
        database.setTradeEventPerformanceExclusion(userId, created.id, 'erroneous', userId);
      }
    } catch (error) {
      console.warn('[reconcile] Failed to mark reconciled close events as erroneous', {
        accountId,
        tradeId: pos.tradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  };

  const recordReconcileArmCancelled = (
    userId: string,
    accountId: string,
    event: TradeEvent,
    occurredAt: string,
  ): boolean => {
    const source = 'reconcile';
    const shared = {
      tradeId: event.tradeId,
      instrument: event.instrument,
      side: event.side,
      quantity: event.quantity,
      occurredAt,
    };
    let cancelledEvent: TradeEvent | undefined;
    try {
      database.createRangeTradeEvent({
        rangeName: event.rangeName,
        ...shared,
        eventId: `${event.tradeId}-${source}-entry_cancelled`,
        eventType: 'entry_cancelled',
        action: 'cancel',
      });
    } catch (error) {
      console.warn('[reconcile] Failed to record range entry_cancelled for reconciled armed trade', {
        tradeId: event.tradeId,
        rangeName: event.rangeName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const result = database.createTradeEvent({
        userId,
        accountId,
        rangeName: event.rangeName,
        ...shared,
        eventId: `${event.tradeId}-${source}-entry_cancelled`,
        eventType: 'entry_cancelled',
        action: 'cancel',
      });
      cancelledEvent = result.event;
    } catch (error) {
      console.warn('[reconcile] Failed to record account entry_cancelled for reconciled armed trade', {
        accountId,
        tradeId: event.tradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      database.setTradeEventPerformanceExclusion(userId, event.id, 'erroneous', userId);
      if (cancelledEvent) database.setTradeEventPerformanceExclusion(userId, cancelledEvent.id, 'erroneous', userId);
    } catch (error) {
      console.warn('[reconcile] Failed to mark reconciled armed trade as erroneous', {
        accountId,
        tradeId: event.tradeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  };

  const recordFlattenedPositions = (
    userId: string,
    accountId: string,
    instrument: string,
    occurredAt: string,
    proxyAlertId: string | undefined,
    reason = 'eod',
  ): number => {
    let closed = 0;
    for (const pos of database.getOpenPositionsForAccount(accountId, instrument)) {
      if (database.hasClosedOrCancelledLifecycleForBracket(accountId, pos.rangeName, instrument, pos.side, pos.tradeId)) {
        if (pos.bracketId) {
          const monitor = database.findBracketMonitorEntry(accountId, pos.rangeName, pos.bracketId, pos.side);
          if (monitor) {
            database.retireBracketMonitorEntry(userId, monitor, 'trade_closed', `${pos.tradeId}-eod_reconcile_trade_closed`, occurredAt);
          }
        }
        continue;
      }
      const shared = {
        tradeId: pos.tradeId,
        instrument,
        side: pos.side,
        quantity: pos.openQuantity,
        occurredAt,
        ...(proxyAlertId ? { proxyAlertId } : {}),
      };
      const events = [
        {
          eventId: `${pos.tradeId}-${reason}_exit_filled`,
          eventType: 'exit_filled' as const,
          action: 'exit' as const,
        },
        {
          eventId: `${pos.tradeId}-${reason}_trade_closed`,
          eventType: 'trade_closed' as const,
          action: 'exit' as const,
          entryPrice: pos.entryPrice,
          exitPrice: pos.entryPrice,
          realizedTicksCents: 0,
          realizedDollarsCents: 0,
          outcome: 'breakeven' as const,
        },
      ];
      for (const evt of events) {
        try {
          database.createRangeTradeEvent({ rangeName: pos.rangeName, ...shared, ...evt });
        } catch (error) {
          console.warn(`[${reason}] Failed to record range event for flattened position`, {
            tradeId: pos.tradeId,
            rangeName: pos.rangeName,
            eventId: evt.eventId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          database.createTradeEvent({ userId, accountId, rangeName: pos.rangeName, ...shared, ...evt });
          if (evt.eventType === 'trade_closed') closed += 1;
        } catch (error) {
          console.warn(`[${reason}] Failed to record account event for flattened position`, {
            accountId,
            tradeId: pos.tradeId,
            eventId: evt.eventId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return closed;
  };



  const reapply = new ReapplyCoordinator(database, {
    instrument: (accountId, ticker) => {
      const destination = database.getTradersPostAccountDestination(accountId);
      const normalized = normalizeTradersPostTicker(ticker) ?? ticker;
      const outbound = resolvedTradersPostTicker(normalized, destination ?? {});
      return normalizeTradersPostTicker(outbound) ?? outbound;
    },
    routeEnabled: (route, cleanup = false) => {
      const current = database.findCurrentRangeRoute(route.id, route.accountId, route.rangeName);
      if (!current?.traderspostEnabled || !database.getTradersPostAccountDestination(route.accountId)?.enabled) return false;
      if (database.findAccountById(route.accountId)?.deprecated || database.getRangeReviewFlag(route.rangeName)?.reason === 'erroneous') return false;
      const configuration = database.getRangeConfiguration(route.rangeName);
      return cleanup || !current.runScheduled || database.routeRunsOnWeekday(current, configuration, currentJournalWeekday(new Date()));
    },
    forward: (delivery, payload, route, preflight, brokerOrder, taskSignal) => forwardToTradersPost(delivery, JSON.stringify(payload), {
      source: `reapply_${payload.action === 'buy' || payload.action === 'sell' ? 'entry' : payload.action}`,
      userId: route.userId,
      rangeName: route.rangeName,
      openInstrumentSet: new Set([payload.ticker]),
      preflight,
      ...(brokerOrder ? { brokerOrderId: brokerOrder.orderId, occurredAt: brokerOrder.occurredAt } : {}),
      ...(taskSignal ? { taskSignal } : {}),
    }),
    protectionReady: (step) => {
      if (step.kind !== 'entry' || !step.arm) return true;
      const id = String(step.payload.bracketId);
      const intent = database.findPreciseTakeProfitIntent(step.route.accountId, step.route.rangeName, id, step.arm.side);
      return !intent || database.hasSuccessfulPreciseTakeProfitDelivery(step.route.accountId, step.route.rangeName, id, step.arm.side);
    },
    notify: (userId, message, level = 'error') => {
      database.createBridgeLog(userId, 'reapply', { message });
      emitToUser(userId, level === 'warning' ? 'toast:warning' : 'toast:error', { message, persistent: true });
    },
    queueTaskTimeoutMs: options.traderspostQueueTaskTimeoutMs,
    flattenMaxSends: options.reapplyFlattenMaxSends,
    flattenRetryDelayMs: options.reapplyFlattenRetryDelayMs,
  });
  // Restart recovery: pending deliveries with zero attempts lost only their
  // in-memory queue slot — no send ever reached the wire — so re-enqueue them
  // through the normal queue path BEFORE the interrupted-dispatch sweep fails
  // anything. Rows that did attempt keep the conservative outcome (failed /
  // uncertain + operator reconcile), since a blind resend could double-order.
  const resumePendingDispatches = async (): Promise<void> => {
    const pending = database.listUnattemptedPendingDeliveries();
    if (pending.length === 0) return;
    console.info(JSON.stringify({ level: 'info', event: 'dispatchResume', resuming: pending.length }));
    await Promise.all(pending.map(async (delivery) => {
      const alert = database.findProxyAlert(delivery.proxyAlertId);
      if (!alert) return;
      await reapply.queue.run(delivery.accountId, (taskSignal) =>
        forwardToTradersPost(delivery, alert.payloadJson, {
          source: 'proxy',
          userId: delivery.userId,
          rangeName: alert.rangeName,
          taskSignal,
          // Same enablement re-check queued dispatches get: a destination or
          // route disabled while the process was down must not send on resume.
          preflight: () => {
            if (!database.getTradersPostAccountDestination(delivery.accountId)?.enabled) {
              return { allowed: false, reason: 'Destination was disabled while the process was down', status: 'routing_disabled' };
            }
            if (alert.rangeName && !database.findCurrentRangeRoute(delivery.rangeRouteId, delivery.accountId, alert.rangeName)?.traderspostEnabled) {
              return { allowed: false, reason: 'Route was disabled while the process was down', status: 'routing_disabled' };
            }
            // Same duplicate-entry guard queued dispatches carry: two
            // unattempted same-bracket entries must not both replay.
            const recovered = (() => {
              try {
                return JSON.parse(alert.payloadJson) as { action?: string; bracketId?: string; bracketSide?: string };
              } catch {
                return undefined;
              }
            })();
            if (alert.rangeName && (recovered?.action === 'buy' || recovered?.action === 'sell') && typeof recovered.bracketId === 'string') {
              const side = recovered.bracketSide === 'short' ? 'short' as const : 'long' as const;
              if (database.hasDeliveredEntryForBracket(delivery.accountId, alert.rangeName, recovered.bracketId, recovered.action, side)) {
                const mon = database.findBracketMonitorEntry(delivery.accountId, alert.rangeName, recovered.bracketId, side);
                if (!(mon && (mon.state === 'closed' || mon.state === 'cancelled'))) {
                  return { allowed: false, reason: 'Entry for this bracket was already delivered', status: 'suppressed_duplicate' };
                }
              }
            }
            return { allowed: true };
          },
        }),
      ).catch((err) => {
        const errorText = err instanceof Error ? err.message : String(err);
        database.createProxyDeliveryAttempt({
          proxyDeliveryId: delivery.id,
          success: false,
          errorText,
        });
        for (const order of database.listBrokerOrdersForDelivery(delivery.id)) {
          if (order.status === 'pending') {
            database.updateBrokerOrderStatus(delivery.accountId, order.orderId, 'uncertain', errorText, delivery.id);
          }
        }
        database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, false));
      });
    }));
  };
  app.locals.recoverReapplyOperations = async () => {
    await resumePendingDispatches();
    return reapply.recover();
  };
  // Lane telemetry shared by the monitoring payload and the heartbeat's
  // crash forensics — queue depth is the first place dispatch trouble shows.
  app.locals.dispatchQueueStats = () => [
    ...traderspostRateLimiter.snapshot(),
    ...reapply.queue.snapshot(),
  ];

  const processProxyPayload = async (
    payload: z.infer<typeof proxyPayloadSchema>,
    rawBody: string,
    options?: { lifecycleTestUserId?: string },
  ): Promise<Record<string, unknown>> => {
    let alert: ProxyAlert | undefined;
    try {
      // Normalize bracket/trade ids to carry the range name — Ultra ids are
      // ticker+epoch scoped, so ranges sharing a price box collide without
      // it. Single scope point covering every caller (/proxy, lifecycle test
      // sends, simulators), keyed on the stored range spelling so the slug
      // lands on the stored identity — scoping the same payload under two
      // different resolutions would double-prefix.
      const rawRangeName = typeof payload.extras?.rangeName === 'string' ? payload.extras.rangeName : undefined;
      if (rawRangeName) {
        const scopeRangeName = database.resolveTrackedRangeName(database.resolveRangeName(rawRangeName))
          ?? database.resolveRangeName(rawRangeName);
        scopePayloadIdsToRange(payload, scopeRangeName);
      }
      rawBody = JSON.stringify(payload);
    if (isLifecyclePayload(payload)) {
      const incomingRangeName = database.resolveRangeName(payload.extras.rangeName as string);
      const trackedRangeName = database.resolveTrackedRangeName(incomingRangeName);
      const storedRangeName = trackedRangeName ?? incomingRangeName;
      const storedPayloadJson = normalizeStoredPayloadJson(rawBody, payload, storedRangeName);
      const rangeName = storedRangeName;
      const auditAction = payload.action ?? (payload.side === 'long' ? 'buy' : 'sell');
      alert = database.createProxyAlert({
        rangeName: storedRangeName,
        action: auditAction,
        ticker: payload.ticker,
        payloadJson: storedPayloadJson,
        sourceReference: payload.tradeId,
      });
      const history = database.transaction(() => {
        const recorded = recordLifecycleAlertHistory(
          payload,
          alert!,
          rangeName,
          payload.eventType === 'entry_armed' || payload.eventType === 'entry_filled' || payload.eventType === 'trade_closed' || payload.eventType === 'entry_cancelled',
        );
        if (payload.eventType === 'trade_closed' && recorded.rangeResult?.created) {
          for (const route of recorded.eligibleRoutes ?? []) reapply.enqueueClose(payload, route, recorded.occurredAt);
        }
        return recorded;
      });
      const lifecycleUserIds = new Set(history.eligibleRoutes?.map((route) => route.userId) ?? []);
      for (const userId of lifecycleUserIds) {
        emitToUser(userId, 'log:bridge', {
          category: 'lifecycle',
          timestamp: new Date().toISOString(),
          eventType: payload.eventType,
          ticker: payload.ticker,
          rangeName,
          side: payload.side,
          action: auditAction,
          quantity: payload.quantity,
          outcome: payload.outcome,
          occurredAt: history.occurredAt,
          routes: history.routes.length,
          recorded: Boolean(history.rangeResult),
          tradeEventId: history.rangeResult?.event?.id,
        });
      }
      if (payload.eventType === 'trade_closed' && history.rangeResult && history.eligibleRoutes?.length) {
        for (const route of history.eligibleRoutes) {
          await reapply.onClose(payload, route);
        }
      }
      if (!rangeName || !history.rangeResult) {
        return {
          alertId: alert.id,
          lifecycle: true,
          eventType: payload.eventType,
          eventId: payload.eventId,
          routes: [],
        };
      }
      return {
        alertId: alert.id,
        lifecycle: true,
        eventType: payload.eventType,
        eventId: payload.eventId,
        rangeTradeEventId: history.rangeResult.event.id,
        duplicateRangeTradeEvent: !history.rangeResult.created,
        routes: history.routes,
      };
    }

    const incomingRangeName = typeof payload.extras?.rangeName === 'string'
      ? database.resolveRangeName(payload.extras.rangeName)
      : undefined;
    const trackedRangeName = incomingRangeName ? database.resolveTrackedRangeName(incomingRangeName) : undefined;
    const storedRangeName = trackedRangeName ?? incomingRangeName;
    const storedPayloadJson = normalizeStoredPayloadJson(rawBody, payload, storedRangeName);
    const rangeName = storedRangeName && (trackedRangeName
      || (options?.lifecycleTestUserId && incomingRangeName === 'Test Range'))
      ? storedRangeName
      : undefined;
    const sourceReference = 'bracketId' in payload ? payload.bracketId : undefined;
    alert = database.createProxyAlert({
      rangeName: storedRangeName,
      action: payload.action,
      ticker: payload.ticker,
      payloadJson: storedPayloadJson,
      ...(sourceReference ? { sourceReference } : {}),
    });
    // Fan-out runs per-account-serial but cross-account-parallel: each route's
    // dispatch + post-send bookkeeping is one task; the per-account queue
    // preserves ordering while Promise.all collapses fan-out latency to the
    // slowest lane instead of the sum of all lanes.
    const deliveryTasks: Array<Promise<ProxyDelivery>> = [];
    const deliveries: ProxyDelivery[] = [];
    // Kill switch: SERIAL_FANOUT=1 reverts to the pre-parallelism behavior
    // (each route's dispatch awaited before the next is enqueued) without a
    // redeploy — for bisecting if prod behavior surprises.
    const serialFanout = process.env.SERIAL_FANOUT === '1';
    const extensionDraftIdsByPayloadKey = new Map<string, string>();
    const rangeReviewFlag = rangeName ? database.getRangeReviewFlag(rangeName) : undefined;
    const rangeRoutingDisabled = rangeReviewFlag?.reason === 'erroneous';
    if (rangeName) {
      const matchedRoutes = database.findRangeRoutes(rangeName);
      const usedLifecycleFallback = !matchedRoutes.length && Boolean(options?.lifecycleTestUserId) && rangeName === 'Test Range';
      const routes = matchedRoutes.length || !options?.lifecycleTestUserId || rangeName !== 'Test Range'
        ? matchedRoutes
        : lifecycleTestRoutes(database, options.lifecycleTestUserId);
      if (options?.lifecycleTestUserId && rangeName === 'Test Range') {
        console.info('[test lifecycle] Evaluated routing for Test Range payload', {
          lifecycleTestUserId: options.lifecycleTestUserId,
          reviewFlagReason: rangeReviewFlag?.reason ?? null,
          rangeRoutingDisabled,
          usedLifecycleFallback,
          matchedRoutes: summarizeRoutesForLog(matchedRoutes),
          selectedRoutes: summarizeRoutesForLog(routes),
        });
      }
      const notifiedUserIds = new Set(routes.map((route) => route.userId));
      for (const userId of notifiedUserIds) {
        emitToUser(userId, 'toast:success', {
          message: `Alert received: ${payload.ticker} · ${payload.action} for ${rangeName}`,
          rangeName,
        });
      }
      const rangeConfiguration = database.getRangeConfiguration(rangeName);
      const alertWeekday = currentJournalWeekday(new Date(alert.receivedAt));
      for (const route of routes) {
        if (
          route.runScheduled &&
          !database.routeRunsOnWeekday(route, rangeConfiguration, alertWeekday)
        ) {
          continue;
        }
        let draftId: string | undefined;
        const routingSuppressed = rangeRoutingDisabled;
        const routeDestination = database.getTradersPostAccountDestination(route.accountId);
        const traderspostAccountEnabled = routeDestination?.enabled !== false;
        const exactEntryReusePreflight: TradersPostForwardContext['preflight'] = (() => {
          if (
            !routeDestination?.useLimitPriceTP
            || (payload.action !== 'buy' && payload.action !== 'sell')
            || payload.extras?.preciseTakeProfitAfterFill === true
            || typeof payload.bracketId !== 'string'
            || payload.bracketId.trim().length === 0
          ) return undefined;
          const bracketId = payload.bracketId;
          const side = payload.action === 'buy' ? 'long' : 'short';
          if (payload.bracketSide !== side) return undefined;
          return () => {
            const hasPriorEntry = database.hasDeliveredEntryForBracket(
              route.accountId,
              rangeName,
              bracketId,
              payload.action,
              side,
            );
            const hasPriorPreciseTakeProfit = database.hasPreciseTakeProfitDelivery(
              route.accountId,
              rangeName,
              bracketId,
              side,
            );
            const hasPriorCloseOrCancel = database.hasClosedOrCancelledLifecycleForBracket(
              route.accountId,
              rangeName,
              payload.ticker,
              side,
              bracketId,
            );
            const hasPriorCleanup = database.hasPreciseTakeProfitCleanupDelivery(
              route.accountId,
              rangeName,
              bracketId,
              side,
            );
            if (hasPriorEntry || hasPriorPreciseTakeProfit || hasPriorCloseOrCancel || hasPriorCleanup) {
              return {
                allowed: false,
                reason: `Blocked exact entry because bracket ${bracketId} ${side} has prior delivery or lifecycle evidence; use a new bracket ID`,
                status: 'suppressed_duplicate',
              };
            }
            return { allowed: true };
          };
        })();
        const oppositeEntryCancelPreflight: TradersPostForwardContext['preflight'] = (() => {
          if (
            payload.action !== 'cancel'
            || payload.extras?.reason !== 'opposite_entry_filled'
            || typeof payload.bracketId !== 'string'
            || payload.bracketId.trim().length === 0
            || !rangeName
          ) return undefined;
          const bracketId = payload.bracketId.trim();
          const parsed = parseBracketArmId(bracketId);
          const sides: Array<'long' | 'short'> = payload.bracketSide
            ? [payload.bracketSide]
            : parsed?.side
              ? [parsed.side]
              : ['long', 'short'];
          return () => {
            for (const side of sides) {
              if (
                database.hasOpenLifecycleQuantityForBracket(
                  route.accountId,
                  rangeName,
                  payload.ticker,
                  side,
                  bracketId,
                )
              ) {
                return {
                  allowed: false,
                  reason: `Blocked opposite-entry cancel: target bracket ${bracketId} already has an open ${side} lifecycle position`,
                  status: 'suppressed_guard',
                };
              }
            }
            return { allowed: true };
          };
        })();
        const forwardPreflight: TradersPostForwardContext['preflight'] = (() => {
          const preflights: NonNullable<TradersPostForwardContext['preflight']>[] = [];
          if (payload.action === 'buy' || payload.action === 'sell') {
            preflights.push(() => {
              if (!database.getTradersPostAccountDestination(route.accountId)?.enabled || !database.findCurrentRangeRoute(route.id, route.accountId, rangeName)?.traderspostEnabled) {
                return { allowed: false, reason: 'Destination or route was disabled while the entry was queued', status: 'routing_disabled' };
              }
              const id = typeof payload.bracketId === 'string' ? payload.bracketId.replace(/[\r\n]/g, '').replace(/'/g, 'r') : undefined;
              if (id && payload.extras?.preciseTakeProfitAfterFill !== true && database.hasDeliveredEntryForBracket(route.accountId, rangeName, id, payload.action, payload.action === 'buy' ? 'long' : 'short')) {
                // Ultra bracket ids are range-epoch+seq, not attempt-unique —
                // the same arm re-fires the same id after a close. Only treat
                // the resend as a duplicate while the bracket is still live;
                // a terminal monitor row means the prior attempt resolved and
                // this is a fresh entry.
                const side = payload.action === 'buy' ? 'long' as const : 'short' as const;
                const mon = database.findBracketMonitorEntry(route.accountId, rangeName, id, side);
                const resolved = mon && (mon.state === 'closed' || mon.state === 'cancelled');
                if (!resolved) {
                  return { allowed: false, reason: 'Entry for this bracket was already delivered', status: 'suppressed_duplicate' };
                }
              }
              return { allowed: true };
            });
          }
          if (exactEntryReusePreflight) preflights.push(exactEntryReusePreflight);
          if (oppositeEntryCancelPreflight) preflights.push(oppositeEntryCancelPreflight);
          if (preflights.length === 0) return undefined;
          return () => {
            for (const p of preflights) {
              const result = p();
              if (!result.allowed) return result;
            }
            return { allowed: true };
          };
        })();
        // Drafts are created for every subscribed route so a trade lands in
        // Order Review even when the extension flag is off. The extension
        // polls the same pending list, so a running extension will surface
        // these too — drafts are manual-review only, so that is extra
        // visibility, not execution.
        const account = database.findAccountById(route.accountId);
        const shouldCreateExtensionDraft = !routingSuppressed
          && !account?.deprecated
          && (payload.action === 'cancel' || isDraftEligiblePayload(payload));
        const accountMeta = account ? { id: account.id, name: account.name } : undefined;
        if (shouldCreateExtensionDraft) {
          if (payload.action === 'cancel') {
            const draft = database.createDraft({ ...toCancellationReminderDraft(route.userId, payload, accountMeta), extensionEligible: route.extensionEnabled });
            draftId = draft.draft.id;
          } else {
            const extensionPayload = applyAccountDestinationToPayload(payload, routeDestination);
            const draftCacheKey = `${route.userId}:${accountMeta?.id ?? 'none'}:${JSON.stringify(extensionPayload)}`;
            draftId = extensionDraftIdsByPayloadKey.get(draftCacheKey);
            if (!draftId) {
              const draft = database.createDraft({ ...toDraft(route.userId, extensionPayload, accountMeta), extensionEligible: route.extensionEnabled });
              draftId = draft.draft.id;
              extensionDraftIdsByPayloadKey.set(draftCacheKey, draftId);
            }
          }
        }
        const status: ProxyDeliveryStatus = routingSuppressed
          ? 'routing_disabled'
          : route.traderspostEnabled && !traderspostAccountEnabled
            ? draftId
              ? 'extension_draft_created'
              : 'routing_disabled'
          : route.traderspostEnabled && draftId
            ? 'extension_draft_created_and_pending_traderspost'
          : route.traderspostEnabled && payload.action !== 'exit'
              ? 'pending_traderspost'
            : payload.action === 'exit'
              ? 'exit_recorded'
              : draftId
                ? 'extension_draft_created'
                : 'routing_disabled';
        const delivery = database.createProxyDelivery({
          proxyAlertId: alert.id,
          rangeRouteId: route.id,
          userId: route.userId,
          accountId: route.accountId,
          extensionEnabled: route.extensionEnabled,
          traderspostEnabled: route.traderspostEnabled,
          ...(draftId ? { draftId } : {}),
          // Plain fan-out sends are safe to resume after a restart — they carry
          // no operation-level guards. Specialized sends (reapply steps,
          // precise-TP, EOD/news, safeguard) stay unmarked so recovery never
          // replays them without their original preflights.
          resumable: true,
          status,
        });
        // A wedged dispatch must not abort the fan-out — the remaining
        // accounts still need their delivery rows and queued sends.
        const task = (async () => {
          const queueRun = payload.action === 'cancel'
            ? reapply.queue.runNext.bind(reapply.queue)
            : reapply.queue.run.bind(reapply.queue);
          const updatedDelivery = !routingSuppressed && route.traderspostEnabled && traderspostAccountEnabled && payload.action !== 'exit'
            ? await queueRun(route.accountId, (taskSignal) => forwardToTradersPost(delivery, alert!.payloadJson, {
              source: options?.lifecycleTestUserId && rangeName === 'Test Range' ? 'lifecycle_test' : 'proxy',
              userId: route.userId,
              rangeName,
              taskSignal,
              ...(forwardPreflight ? { preflight: forwardPreflight } : {}),
            })).catch((err) => {
              const errorText = err instanceof Error ? err.message : String(err);
              console.warn('[traderspost] Queued dispatch failed', {
                deliveryId: delivery.id,
                accountId: route.accountId,
                rangeName,
                error: errorText,
              });
              // Ledger the interrupted attempt so a resend allocates the -r<n> order
              // id instead of upserting over the uncertain row this attempt created.
              database.createProxyDeliveryAttempt({
                proxyDeliveryId: delivery.id,
                success: false,
                errorText,
              });
              for (const order of database.listBrokerOrdersForDelivery(delivery.id)) {
                if (order.status === 'pending') {
                  database.updateBrokerOrderStatus(delivery.accountId, order.orderId, 'uncertain', errorText, delivery.id);
                }
              }
              return database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, false))!;
            })
            : delivery;
          emitToUser(route.userId, 'log:bridge', {
            category: 'routing',
            timestamp: new Date().toISOString(),
            action: payload.action,
            ticker: payload.ticker,
            rangeName,
            accountName: accountMeta?.name ?? 'Unknown',
            accountId: route.accountId,
            status: updatedDelivery.status,
            suppressed: routingSuppressed || updatedDelivery.status.startsWith('suppressed_'),
            traderspostEnabled: route.traderspostEnabled,
            extensionEnabled: route.extensionEnabled,
            deliveryId: delivery.id,
          });
          if (payload.action === 'cancel'
            && (updatedDelivery.status === 'traderspost_delivered' || updatedDelivery.status === 'extension_draft_created_and_traderspost_delivered')
          ) {
            const cancelPayload = payload as { tradeId?: string; quantity?: number; bracketSide?: 'long' | 'short' };
            if (
              payload.cancelOrderType === 'stop'
              && payload.extras?.reason === 'opposite_entry_filled'
              && payload.bracketId
              && cancelPayload.bracketSide
            ) {
              await sendPreciseTakeProfitCleanup({
                route,
                bracketId: payload.bracketId,
                side: cancelPayload.bracketSide,
                instrument: payload.ticker,
                occurredAt: alert.receivedAt,
                cleanupEventId: `proxy-cancel-${alert.id}`,
                reason: 'precise_tp_opposite_entry_cleanup',
                requireClosedLifecycle: true,
              });
            }
            if (cancelPayload.tradeId && cancelPayload.quantity != null && cancelPayload.bracketSide) {
              database.createTradeEvent({
                userId: route.userId,
                accountId: route.accountId,
                rangeName,
                eventId: `proxy-cancel-${alert.id}-${randomUUID()}`,
                tradeId: cancelPayload.tradeId,
                eventType: 'entry_cancelled',
                instrument: payload.ticker,
                side: cancelPayload.bracketSide,
                action: 'cancel',
                quantity: cancelPayload.quantity,
                occurredAt: new Date().toISOString(),
                proxyAlertId: alert.id,
              });
            }
          }
          return updatedDelivery;
        })();
        if (serialFanout) deliveries.push(await task);
        else deliveryTasks.push(task);
      }
    }
    deliveries.push(...await Promise.all(deliveryTasks));
    return {
      alertId: alert.id,
      routes: deliveries.map(proxyDeliveryResponse),
    };
    } catch (error) {
      const errorText = error instanceof Error ? error.message : 'Unknown error';
      console.warn('[proxy] Error processing payload', {
        errorText,
        action: payload.action,
        ticker: payload.ticker,
        eventType: isLifecyclePayload(payload) ? payload.eventType : undefined,
        rangeName: payload.extras?.rangeName,
      });
      return {
        alertId: alert?.id,
        accepted: true,
        warning: `Alert accepted but processing encountered an error: ${errorText}`,
        routes: [],
      };
    }
  };

  const scheduleLifecycleTest = (
    userId: string,
    label: 'test-complete' | 'test-win' | 'test-lose',
    payloads: Array<TradersPostPayload | LifecyclePayload>,
  ) => {
    ensureLifecycleTestRangeState(database, userId);
    const directRoutes = database.findRangeRoutes('Test Range');
    const fallbackRoutes = lifecycleTestRoutes(database, userId);
    const scheduledAt = Date.now();
    completeTestRunEndsAt = scheduledAt + payloads.length * COMPLETE_TEST_SPACING_MS;
    console.info(`[${label}] Scheduling lifecycle test`, {
      userId,
      payloadCount: payloads.length,
      directTestRangeRoutes: summarizeRoutesForLog(directRoutes),
      fallbackLifecycleRoutes: summarizeRoutesForLog(fallbackRoutes),
      completeTestRunEndsAt,
    });
    payloads.forEach((payload, index) => {
      const delayMs = COMPLETE_TEST_SPACING_MS * index;
      setTimeout(() => {
        void processProxyPayload(payload, JSON.stringify(payload), { lifecycleTestUserId: userId })
          .then((result) => {
            console.info(`[${label}] Scheduled payload routed`, {
              userId,
              index: index + 1,
              count: payloads.length,
              delayMs,
              alertId: result.alertId,
            });
          })
          .catch((error) => {
            console.error(`[${label}] Scheduled payload failed`, {
              userId,
              index: index + 1,
              count: payloads.length,
              delayMs,
              error,
            });
          });
      }, delayMs);
    });
    const completesAt = new Date(completeTestRunEndsAt).toISOString();
    console.info(`[${label}] Lifecycle scheduled`, {
      userId,
      count: payloads.length,
      spacingMs: COMPLETE_TEST_SPACING_MS,
      completesAt,
    });
    return {
      count: payloads.length,
      spacingMs: COMPLETE_TEST_SPACING_MS,
      completesAt,
    };
  };

  app.get('/admin/reapply-operations', (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.json({ operations: database.listIncompleteReapplyOperations().map(op => ({
      id: op.id, accountId: op.accountId, instrument: op.instrument, rangeName: op.route.rangeName, createdAt: op.createdAt, reason: op.reason,
      steps: op.steps.map(step => ({ kind: step.kind, state: step.state, deliveryId: step.deliveryId })),
    })) });
  });

  app.post('/admin/reapply-operations/:id/:action', async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const id = z.string().uuid().parse(req.params.id);
      const action = z.enum(['retry', 'abandon']).parse(req.params.action);
      if (action === 'abandon') z.object({ brokerReconciled: z.literal(true) }).parse(req.body);
      const operation = database.findReapplyOperationById(id);
      if (!operation) { res.status(404).json({ error: 'Reapply operation not found' }); return; }
      if (action === 'abandon') await reapply.abandon(operation);
      else await reapply.onClose(operation.payload, operation.route);
      const current = database.findReapplyOperationById(id)!;
      res.status(current.completed ? 200 : 409).json({ id, completed: current.completed, reason: current.reason });
    } catch (error) { next(error); }
  });

  const resendProxyDelivery = async (
    deliveryId: string,
    options: { allowSuccessfulResend?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> => {
      const initialRetry = database.findProxyDeliveryForRetry(deliveryId);
      if (!initialRetry) {
        return { status: 404, body: { error: 'proxy delivery not found' } };
      }
      // Serialize with the account's reapply/dispatch queue so a manual resend
      // cannot interleave with an in-flight reapply or flatten on this account.
      // The queued pass re-reads the delivery — its state may change while queued.
      return reapply.queue.run(initialRetry.delivery.accountId, (taskSignal) => resendProxyDeliveryQueued(deliveryId, { ...options, taskSignal }));
  };

  const resendProxyDeliveryQueued = async (
    deliveryId: string,
    options: { allowSuccessfulResend?: boolean; taskSignal?: AbortSignal } = {},
  ): Promise<{ status: number; body: unknown }> => {
      const retry = database.findProxyDeliveryForRetry(deliveryId);
      if (!retry) {
        return { status: 404, body: { error: 'proxy delivery not found' } };
      }
      if (retry.delivery.status === 'traderspost_not_configured') {
        return { status: 409, body: { error: 'TradersPost destination must be configured before retrying' } };
      }
      const operation = database.findReapplyOperationForDelivery(retry.delivery.id);
      if (operation) {
        return { status: 409, body: { error: 'Retry the reapply operation, not an individual delivery', operationId: operation.id } };
      }
      const retryPayload = parseStoredProxyPayload(retry.payloadJson);
      if (retryPayload?.extras?.reapplyOnTradeClose === true) {
        return { status: 409, body: { error: 'Reapply-related protection requires operation-level reconciliation' } };
      }
      const preciseTakeProfitRetry = retryPayload?.extras?.preciseTakeProfitAfterFill === true;
      const preciseTakeProfitCleanupRetry = retryPayload?.extras?.preciseTakeProfitStopoutCleanup === true;
      const pendingPreciseTakeProfit =
        preciseTakeProfitRetry && retry.delivery.status === 'pending_traderspost';
      // Session/UI resend may deliberately dispatch a plain entry again even after
      // success; every other delivery kind keeps the failed-only rule.
      const plainEntryRedispatch = Boolean(
        options.allowSuccessfulResend
        && retryPayload
        && !isLifecyclePayload(retryPayload)
        && (retryPayload.action === 'buy' || retryPayload.action === 'sell')
        && !preciseTakeProfitRetry
        && !preciseTakeProfitCleanupRetry
        && (retry.delivery.status === 'traderspost_delivered'
          || retry.delivery.status === 'extension_draft_created_and_traderspost_delivered'),
      );
      // A suppressed entry was never sent; Pine may still hold the bracket live
      // (armed or even filled). Allow an explicit resend while the bracket is
      // unresolved — suppressed_duplicate means a sibling delivery already
      // succeeded, so resending it would double the order.
      const suppressedEntryResend = Boolean(
        options.allowSuccessfulResend
        && retryPayload
        && !isLifecyclePayload(retryPayload)
        && (retryPayload.action === 'buy' || retryPayload.action === 'sell')
        && !preciseTakeProfitRetry
        && !preciseTakeProfitCleanupRetry
        && retry.delivery.status.startsWith('suppressed_')
        && retry.delivery.status !== 'suppressed_duplicate',
      );
      if (suppressedEntryResend && retryPayload && !isLifecyclePayload(retryPayload)) {
        const bracketId = typeof retryPayload.bracketId === 'string' ? retryPayload.bracketId : String(retryPayload.tradeId ?? '');
        const side = retryPayload.bracketSide === 'short' ? 'short' : 'long';
        const live = database.listActiveBracketMonitorEntries(retry.delivery.accountId)
          .some((e) => e.bracketId === bracketId && e.side === side);
        if (!live) {
          return { status: 409, body: { error: 'suppressed entry belongs to a resolved bracket; nothing to resend' } };
        }
      }
      if (!pendingPreciseTakeProfit
        && !plainEntryRedispatch
        && !suppressedEntryResend
        && retry.delivery.status !== 'traderspost_failed'
        && retry.delivery.status !== 'extension_draft_created_and_traderspost_failed') {
        return { status: 409, body: { error: 'proxy delivery is not failed or recoverable' } };
      }
      let retryPreflight: TradersPostForwardContext['preflight'];
      if (preciseTakeProfitRetry) {
        if (
          !retry.rangeName
          || !retryPayload
          || isLifecyclePayload(retryPayload)
          || typeof retryPayload.bracketId !== 'string'
          || !retryPayload.bracketSide
        ) {
          return { status: 409, body: { error: 'precise take profit is missing retry identity' } };
        }
        const retryRangeName = retry.rangeName;
        const currentRoute = database.findCurrentRangeRoute(
          retry.delivery.rangeRouteId,
          retry.delivery.accountId,
          retryRangeName,
        );
        if (!currentRoute?.traderspostEnabled) {
          return { status: 409, body: { error: 'matching TradersPost range route is missing or disabled' } };
        }
        const preciseIntent = database.findPreciseTakeProfitIntent(
          retry.delivery.accountId,
          retryRangeName,
          retryPayload.bracketId,
          retryPayload.bracketSide,
        );
        const entryAction = retryPayload.bracketSide === 'long' ? 'buy' : 'sell';
        if (!preciseIntent || !database.hasDeliveredEntryForBracket(
          retry.delivery.accountId,
          retryRangeName,
          retryPayload.bracketId,
          entryAction,
          retryPayload.bracketSide,
        )) {
          return { status: 409, body: { error: 'matching delivered entry or precise take profit intent is missing' } };
        }
        if (database.hasClosedOrCancelledLifecycleForBracket(
          retry.delivery.accountId,
          retryRangeName,
          preciseIntent.instrument,
          preciseIntent.side,
          preciseIntent.bracketId,
        )) {
          return { status: 409, body: { error: 'precise take profit entry was already closed or cancelled' } };
        }
        if (database.hasSuccessfulPreciseTakeProfitDelivery(
          retry.delivery.accountId,
          retryRangeName,
          preciseIntent.bracketId,
          preciseIntent.side,
          retry.delivery.id,
        )) {
          return { status: 409, body: { error: 'precise take profit was already delivered for this bracket side' } };
        }
        retryPreflight = () => {
          const queuedRoute = database.findCurrentRangeRoute(
            retry.delivery.rangeRouteId,
            retry.delivery.accountId,
            retryRangeName,
          );
          if (!queuedRoute?.traderspostEnabled) {
            return { allowed: false, reason: 'Matching TradersPost range route is missing or disabled', status: 'routing_disabled' };
          }
          if (!database.getTradersPostAccountDestination(retry.delivery.accountId)?.enabled) {
            return { allowed: false, reason: 'TradersPost destination is missing or disabled', status: 'routing_disabled' };
          }
          if (!database.hasDeliveredEntryForBracket(
            retry.delivery.accountId,
            retryRangeName,
            preciseIntent.bracketId,
            entryAction,
            preciseIntent.side,
          )) {
            return { allowed: false, reason: 'Initial entry was not delivered', status: 'suppressed_guard' };
          }
          if (database.hasClosedOrCancelledLifecycleForBracket(
            retry.delivery.accountId,
            retryRangeName,
            preciseIntent.instrument,
            preciseIntent.side,
            preciseIntent.bracketId,
          )) {
            return { allowed: false, reason: 'Entry bracket was already closed or cancelled', status: 'suppressed_guard' };
          }
          if (database.hasSuccessfulPreciseTakeProfitDelivery(
            retry.delivery.accountId,
            retryRangeName,
            preciseIntent.bracketId,
            preciseIntent.side,
            retry.delivery.id,
          )) {
            return { allowed: false, reason: 'Precise take profit was already delivered for this bracket side', status: 'suppressed_duplicate' };
          }
          return { allowed: true };
        };
      } else if (preciseTakeProfitCleanupRetry) {
        if (
          !retry.rangeName
          || !retryPayload
          || isLifecyclePayload(retryPayload)
          || typeof retryPayload.bracketId !== 'string'
          || !retryPayload.bracketSide
        ) {
          return { status: 409, body: { error: 'precise take profit cleanup is missing retry identity' } };
        }
        const retryRangeName = retry.rangeName;
        const cleanupIntent = database.findPreciseTakeProfitIntent(
          retry.delivery.accountId,
          retryRangeName,
          retryPayload.bracketId,
          retryPayload.bracketSide,
        );
        if (!cleanupIntent) {
          return { status: 409, body: { error: 'precise take profit cleanup intent is missing' } };
        }
        const requireClosedLifecycle =
          retryPayload.extras?.reason !== 'precise_tp_opposite_entry_cleanup';
        retryPreflight = () => {
          if (!database.hasSuccessfulPreciseTakeProfitDelivery(
            retry.delivery.accountId,
            retryRangeName,
            cleanupIntent.bracketId,
            cleanupIntent.side,
          )) {
            return { allowed: false, reason: 'No successful precise take profit requires cleanup', status: 'suppressed_guard' };
          }
          if (database.hasSuccessfulPreciseTakeProfitCleanupDelivery(
            retry.delivery.accountId,
            retryRangeName,
            cleanupIntent.bracketId,
            cleanupIntent.side,
            retry.delivery.id,
          )) {
            return { allowed: false, reason: 'Precise take profit cleanup already succeeded for this bracket side', status: 'suppressed_duplicate' };
          }
          if (requireClosedLifecycle && database.hasOpenLifecycleQuantityForBracket(
            retry.delivery.accountId,
            retryRangeName,
            cleanupIntent.instrument,
            cleanupIntent.side,
            cleanupIntent.bracketId,
          )) {
            return { allowed: false, reason: 'Precise take profit bracket is open again', status: 'suppressed_guard' };
          }
          return { allowed: true };
        };
      } else {
        // Plain deliveries previously had no send-time guard: re-check route and
        // destination enablement inside the account queue (either can be disabled
        // while the resend waits). A prior attempt may still be unresolved at the
        // broker (uncertain fetch failure, timeout, 5xx) — the resend proceeds
        // anyway: resend is operator-initiated and the dialog warns that a
        // request that secretly reached TradersPost would duplicate the order.
        const retryRangeName = retry.rangeName;
        retryPreflight = () => {
          if (retryRangeName) {
            const queuedRoute = database.findCurrentRangeRoute(
              retry.delivery.rangeRouteId,
              retry.delivery.accountId,
              retryRangeName,
            );
            if (!queuedRoute?.traderspostEnabled) {
              return { allowed: false, reason: 'Matching TradersPost range route is missing or disabled', status: 'routing_disabled' };
            }
          }
          if (!database.getTradersPostAccountDestination(retry.delivery.accountId)?.enabled) {
            return { allowed: false, reason: 'TradersPost destination is missing or disabled', status: 'routing_disabled' };
          }
          return { allowed: true };
        };
      }
      const retryDestination = database.getTradersPostAccountDestination(retry.delivery.accountId);
      if (!retryDestination) {
        return { status: 409, body: { error: 'TradersPost destination must be configured before retrying' } };
      }
      if (preciseTakeProfitRetry && !retryDestination.enabled) {
        return { status: 409, body: { error: 'TradersPost destination must be enabled before retrying a precise take profit' } };
      }
      const delivery = await forwardToTradersPost(retry.delivery, retry.payloadJson, {
        source: 'retry',
        rangeName: retry.rangeName,
        preflight: retryPreflight,
        allowResend: plainEntryRedispatch || suppressedEntryResend,
        ...(options.taskSignal ? { taskSignal: options.taskSignal } : {}),
      });
      if (
        retryPayload
        && (delivery.status === 'traderspost_delivered' || delivery.status === 'extension_draft_created_and_traderspost_delivered')
      ) {
        recordBridgeGeneratedEntryCancelled(delivery, retryPayload, new Date().toISOString());
      }
      return { status: 200, body: { delivery: proxyDeliveryResponse(delivery) } };
  };

  app.post('/admin/proxy-deliveries/:id/retry', async (req, res, next) => {
    try {
      if (!requireAdmin(req, res)) return;
      const result = await resendProxyDelivery(userIdSchema.parse(req.params.id));
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  app.post('/app/api/journal/resend-delivery', async (req, res, next) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = z.object({ deliveryId: userIdSchema, csrfToken: z.string().min(1) }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const target = database.findProxyDeliveryForRetry(input.deliveryId);
      if (!target || (target.delivery.userId !== session.userId && session.email !== adminUserEmail)) {
        res.status(404).json({ error: 'proxy delivery not found' });
        return;
      }
      const result = await resendProxyDelivery(input.deliveryId, { allowSuccessfulResend: true });
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });

  // Daily realized P&L for a model over a trailing window — trade_closed
  // events bucketed into journal days (UTC-4) across every member range.
  // Shared-range data, so any signed-in user may read it, same as /app/api/ranges.
  app.get('/app/api/model-equity', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const subcategory = String(req.query.subcategory ?? '').trim();
    const range = String(req.query.range ?? '').trim();
    if (!subcategory && !range) {
      res.status(400).json({ error: 'Missing subcategory or range' });
      return;
    }
    const windowDays = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const now = new Date();
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const until = now.toISOString();
    const byDay = new Map<string, number>();
    const feed = range
      ? database.listRangeDailyPnl(range, since, until)
      : database.listSubcategoryDailyPnl(subcategory, since, until);
    for (const row of feed) {
      const shifted = new Date(new Date(row.occurredAt).getTime() + JOURNAL_TIME_OFFSET_MINUTES * 60 * 1_000);
      const key = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
      byDay.set(key, (byDay.get(key) ?? 0) + row.realizedDollarsCents);
    }
    const days = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, realizedDollarsCents]) => ({ date, realizedDollarsCents }));
    res.json({ subcategory: subcategory || undefined, range: range || undefined, days });
  });

  // Per-range detail view: recent inbound alerts, the TradersPost dispatch ledger,
  // and the account routes eligible for a manual resend. Deliveries/orders are
  // scoped to the session user's accounts unless the session is admin.
  app.get('/app/api/ranges/:rangeName/detail', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const rangeName = req.params.rangeName;
    const resolvedRangeName = database.resolveTrackedRangeName(rangeName) ?? database.resolveRangeName(rangeName);
    const configuration = database.getRangeConfiguration(resolvedRangeName);
    const alertRows = database.listRecentProxyAlertsByRange(rangeName, 100);
    // Latest range bounds from the newest entry alerts: a buy alert's entry
    // level is the range top, a sell alert's is the range bottom.
    let latestTop: number | undefined;
    let latestTopAt: string | undefined;
    let latestBottom: number | undefined;
    let latestBottomAt: string | undefined;
    let latestQuantity: number | undefined;
    for (const a of alertRows) {
      if (latestTop != null && latestBottom != null && latestQuantity != null) break;
      if (a.action !== 'buy' && a.action !== 'sell') continue;
      try {
        const payload = JSON.parse(a.payloadJson) as { signalPrice?: number; price?: number; quantity?: number };
        const level = payload.signalPrice ?? payload.price;
        if (latestQuantity == null && typeof payload.quantity === 'number' && payload.quantity > 0) {
          latestQuantity = payload.quantity;
        }
        if (typeof level !== 'number') continue;
        if (a.action === 'buy' && latestTop == null) { latestTop = level; latestTopAt = a.receivedAt; }
        if (a.action === 'sell' && latestBottom == null) { latestBottom = level; latestBottomAt = a.receivedAt; }
      } catch {}
    }
    const alerts = alertRows.map((a) => ({
      alertId: a.alertId,
      receivedAt: a.receivedAt,
      action: a.action,
      ticker: a.ticker,
      payloadJson: a.payloadJson,
    }));
    const dispatches = database.listBrokerOrdersByRange(resolvedRangeName, session.userId, 200);
    const allAccounts = database.listAccounts(session.userId);
    const deprecatedAccountIds = new Set(
      allAccounts.filter((account) => account.deprecated).map((account) => account.id),
    );
    const accounts = allAccounts
      .filter((account) => !account.deprecated)
      .map((account) => {
        const destination = database.getTradersPostAccountDestination(account.id);
        return {
          accountId: account.id,
          accountName: account.name,
          destinationEnabled: destination?.enabled === true,
          crossTrade: isCrossTradeConfigured(destination),
        };
      });
    const subscriptions = database.listRangeRoutesByRangeName(rangeName)
      // Deprecation disables the route (both flags off) rather than deleting it —
      // deliveries FK-reference route rows — so a deprecated account must not
      // present as "subscribed" here.
      .filter((route) => route.accountUserId === session.userId && !deprecatedAccountIds.has(route.accountId))
      .map((route) => ({
        accountId: route.accountId,
        accountName: route.accountName,
        traderspostEnabled: route.traderspostEnabled,
        extensionEnabled: route.extensionEnabled,
        runScheduled: route.runScheduled,
        crossTrade: isCrossTradeConfigured(database.getTradersPostAccountDestination(route.accountId)),
      }));
    // The same shared-range detail the Ranges page renders (performance,
    // subscriptions, review flag), matched on the stored range name.
    const resolveDetailRange = database.createRangeNameResolver();
    let rangeDetail: SharedRangeDetail | null = null;
    for (const range of database.listSharedRangeDetails(new Date())) {
      if (resolveDetailRange(range.rangeName) === resolvedRangeName) {
        rangeDetail = range;
        break;
      }
    }
    const subcategories = database.listRangeSubcategories();
    const modelNames: string[] = [];
    for (const assignment of database.listRangeSubcategoryAssignments()) {
      const stored = resolveDetailRange(assignment.rangeName);
      if (stored === resolvedRangeName && assignment.subcategoryName) {
        modelNames.push(assignment.subcategoryName);
      }
    }
    modelNames.sort();
    res.json({
      rangeName: resolvedRangeName,
      rangeDetail,
      subcategories,
      modelNames,
      // Back-compat: first model, for consumers expecting a singular value.
      modelName: modelNames[0] ?? null,
      instrument: configuration?.instrument ?? null,
      configuration: configuration ?? null,
      latestTop: latestTop ?? null,
      latestTopAt: latestTopAt ?? null,
      latestBottom: latestBottom ?? null,
      latestBottomAt: latestBottomAt ?? null,
      latestQuantity: latestQuantity ?? null,
      alerts,
      dispatches,
      accounts,
      subscriptions,
    });
  });

  // Downloads the NT8 ATM strategy template XML for a break-even-enabled
  // range — the file lands in Documents\NinjaTrader 8\templates\AtmStrategy\.
  // The wire's atm_strategy equals the range name, so the embedded <Template>
  // name must too; only the filename is sanitized for the filesystem.
  app.get('/app/api/ranges/:rangeName/atm-template', (req, res) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const resolvedRangeName = database.resolveTrackedRangeName(req.params.rangeName)
      ?? database.resolveRangeName(req.params.rangeName);
    const configuration = database.getRangeConfiguration(resolvedRangeName);
    if (!configuration) {
      res.status(404).json({ error: 'range configuration not found' });
      return;
    }
    if (!configuration.breakEvenEnabled) {
      res.status(409).json({ error: 'range does not have break-even enabled — no ATM template needed' });
      return;
    }
    res.setHeader('content-type', 'application/xml; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${atmTemplateFileName(configuration.rangeName)}"`);
    res.send(renderNt8AtmTemplateXml(configuration));
  });

  // Range simulation for the detail page: same logic as the debugging Range
  // simulation card, scoped to the path's range and to accounts the session may
  // use (all routed accounts for admin, own accounts otherwise).
  app.post('/app/api/ranges/:rangeName/simulate', async (req, res, next) => {
    const session = getWebSession(req);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const input = z.object({
        accountId: z.string().min(1),
        action: z.enum(['buy', 'sell', 'both']),
        top: z.coerce.number().positive(),
        bottom: z.coerce.number().positive(),
        quantity: z.coerce.number().int().positive(),
        orderType: z.enum(['market', 'limit', 'stop', 'stop_limit']).default('stop'),
        takeProfitTicksCents: z.coerce.number().int().min(0).optional(),
        stopLossTicksCents: z.coerce.number().int().min(0).optional(),
        takeProfitStyle: z.string().optional(),
        stopLossStyle: z.string().optional(),
        csrfToken: z.string().min(1),
      }).parse(req.body);
      if (!validateCsrf(session, input.csrfToken)) {
        res.status(403).json({ error: 'Invalid form token.' });
        return;
      }
      const rangeName = database.resolveTrackedRangeName(req.params.rangeName) ?? database.resolveRangeName(req.params.rangeName);
      const eligible = database.listAccounts(session.userId)
        .filter((account) => !account.deprecated);
      const targets = input.accountId === 'all'
        ? eligible
        : eligible.filter((account) => account.id === input.accountId);
      if (targets.length === 0) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      const simBase = {
        rangeName,
        top: input.top,
        bottom: input.bottom,
        quantity: input.quantity,
        orderType: input.orderType,
        takeProfitTicksCents: input.takeProfitTicksCents,
        stopLossTicksCents: input.stopLossTicksCents,
        takeProfitStyle: input.takeProfitStyle,
        stopLossStyle: input.stopLossStyle,
      };
      const actions: Array<'buy' | 'sell'> = input.action === 'both' ? ['buy', 'sell'] : [input.action];
      const results = [] as Array<Record<string, unknown>>;
      for (const account of targets) {
        for (const action of actions) {
          const result = await runRangeSimulation(account, { ...simBase, action });
          results.push({ accountId: account.id, action, status: result.status, ...result.body });
        }
      }
      res.json({ results });
    } catch (error) {
      next(error);
    }
  });

  app.post('/proxy/:secret', async (req, res, next) => {
    try {
      if (!proxyWebhookSecret) {
        res.status(503).json({ error: 'proxy webhook is not configured' });
        return;
      }
      if (!matchesSecret(proxyWebhookSecret, req.params.secret)) {
        res.status(401).json({ error: 'invalid proxy credentials' });
        return;
      }
      console.info('[proxy] Incoming webhook received', {
        contentType: req.header('content-type'),
        body: req.body,
      });
      const parsed = proxyPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid request', details: parsed.error.issues });
        return;
      }
      if (process.env.PROXY_ASYNC === '1') {
        // Acknowledge the webhook immediately; TradersPost forwarding runs in the background.
        res.status(202).json({ accepted: true });
        void processProxyPayload(
          parsed.data,
          JSON.stringify(parsed.data),
        ).catch((error) => {
          const errorText = error instanceof Error ? error.message : 'Unknown error';
          console.error('[proxy] Async payload processing error', {
            errorText,
            action: parsed.data.action,
            ticker: parsed.data.ticker,
            eventType: isLifecyclePayload(parsed.data) ? parsed.data.eventType : undefined,
          });
        });
      } else {
        const response = await processProxyPayload(
          parsed.data,
          JSON.stringify(parsed.data),
        );
        res.status(202).json(response);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid lifecycle payload') {
        res.status(400).json({ error: 'invalid request' });
        return;
      }
      next(error);
    }
  });

  app.post('/webhooks/:userId/:secret', (req, res, next) => {
    try {
      console.info('[webhook] Request received', {
        userId: req.params.userId,
        contentType: req.header('content-type'),
      });
      const user = database.findUserByWebhook(req.params.userId, req.params.secret);
      if (!user) {
        console.warn('[webhook] Request rejected: invalid credentials', { userId: req.params.userId });
        res.status(401).json({ error: 'invalid webhook credentials' });
        return;
      }
      const parsed = tradersPostPayloadSchema.safeParse(req.body);
      if (!parsed.success) {
        console.warn('[webhook] Request rejected: invalid payload', {
          userId: user.id,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
        res.status(400).json({ error: 'invalid request', details: parsed.error.issues });
        return;
      }
      const payload = parsed.data;
      if (payload.action === 'cancel') {
        const result = database.createDraft(toCancellationReminderDraft(user.id, payload));
        console.info('[webhook] Cancellation reminder received', {
          userId: user.id,
          draftId: result.draft.id,
          duplicate: !result.created,
          bracketId: payload.bracketId || undefined,
          rangeName: result.draft.rangeName,
        });
        res.status(result.created ? 202 : 200).json({
          id: result.draft.id,
          status: 'cancellation reminder created',
          duplicate: !result.created,
        });
        return;
      }
      if (payload.action === 'exit') {
        console.info('[webhook] Exit signal recorded without broker action', {
          userId: user.id,
          ticker: payload.ticker,
          reason: payload.extras?.reason,
        });
        res.status(202).json({ status: 'ignored', reason: 'exit automation is not enabled' });
        return;
      }
      if (!isDraftEligiblePayload(payload)) {
        console.warn('[webhook] Request rejected: unsupported extension payload', {
          userId: user.id,
          action: payload.action,
          quantity: payload.quantity,
          orderType: payload.orderType,
        });
        res.status(400).json({ error: 'invalid request', details: [{ path: ['action'], message: 'payload is not supported for extension drafts' }] });
        return;
      }
      const normalizedPayload = applyAccountDestinationToPayload(payload, undefined);
      const result = database.createDraft(toDraft(user.id, normalizedPayload));
      console.info('[webhook] Order draft received', {
        userId: user.id,
        draftId: result.draft.id,
        duplicate: !result.created,
        ticker: result.draft.ticker,
        action: result.draft.action,
        quantity: result.draft.quantity,
        orderType: result.draft.orderType,
        signalPrice: result.draft.signalPrice,
        limitPrice: result.draft.limitPrice,
        stopPrice: result.draft.stopPrice,
        takeProfit: result.draft.takeProfit,
        stopLoss: result.draft.stopLoss,
        bracketId: result.draft.bracketId,
      });
      res.status(result.created ? 202 : 200).json({
        id: result.draft.id,
        status: result.draft.status,
        duplicate: !result.created,
      });
    } catch (error) {
      next(error);
    }
  });

  // TradersPost reports broker-side delivery failures (webhook accepted, then
  // the order fails at Tradovate) only by email. An inbound-mail relay POSTs the
  // message to /email/:secret (shared ingest secret) or the scoped
  // /email/:userId/:accountId/:secret variant. Unresolved broker_orders rows
  // matching the parsed bracketId or instrument are marked rejected.
  // Every inbound email that normalizes is stored for review — the endpoint
  // secret is the gate, so sender/content checks only annotate the log rather
  // than reject. This keeps forwarded or oddly-shaped mail visible for parser
  // iteration instead of dropping it.
  const readInboundEmail = (body: unknown):
    | { inbound: InboundEmail; parsed: ParsedTradersPostEmail }
    | { status: number; error: string } => {
    const inbound = normalizeInboundEmail(body);
    if (!inbound) return { status: 400, error: 'invalid email payload' };
    return { inbound, parsed: parseTradersPostEmail(inbound) };
  };

  const emitEmailLog = (
    userId: string,
    inbound: InboundEmail,
    parsed: ParsedTradersPostEmail,
    extras: Record<string, unknown>,
  ) => {
    emitToUser(userId, 'log:bridge', {
      category: 'email',
      timestamp: new Date().toISOString(),
      subject: inbound.subject,
      from: inbound.from,
      to: inbound.to ?? null,
      body: inbound.text.slice(0, 20000),
      errorText: parsed.errorText,
      ticker: parsed.ticker ?? null,
      bracketId: parsed.bracketId ?? null,
      strategy: parsed.strategy ?? null,
      tpAccount: parsed.tpAccount ?? null,
      senderTrusted: isTradersPostSender(inbound.from),
      ...extras,
    });
  };

  // Retires armed monitor rows whose covering entry dispatch just resolved dead
  // (rejected/cancelled). otherOpenOrders is the remaining open ledger for the
  // account — a sibling open dispatch on the same arm keeps the row armed, so a
  // rejected attempt with a live resend leaves the monitor untouched. Only a
  // dead entry order voids the arm; a dead TP/exit leg leaves the working entry
  // alone.
  // Armed bracket_monitor rows whose only covering entry order is `order` —
  // i.e. phantom open-trade rows that can never fill because no other live
  // dispatch still covers them. Pure read; callers decide what to do with them.
  const uncoveredArmedMonitorRows = (
    order: BrokerOrder,
    otherOpenOrders: BrokerOrder[],
  ) => {
    const rows: ReturnType<typeof database.listArmedBracketMonitorRows> = [];
    for (const key of [order.orderId, order.bracketId].filter((k): k is string => Boolean(k))) {
      for (const row of database.listArmedBracketMonitorRows(order.accountId, key)) {
        const entryAction = row.side === 'long' ? 'buy' : 'sell';
        if (order.action !== entryAction) continue;
        const stillWorking = otherOpenOrders.some(
          (open) => (open.orderId === key || open.bracketId === key) && open.action === entryAction,
        );
        if (stillWorking) continue;
        rows.push(row);
      }
    }
    return rows;
  };

  const retireUncoveredArmedMonitorRows = (
    userId: string,
    order: BrokerOrder,
    otherOpenOrders: BrokerOrder[],
    evidence: string,
  ): string[] => {
    const retired: string[] = [];
    for (const row of uncoveredArmedMonitorRows(order, otherOpenOrders)) {
      database.retireBracketMonitorEntry(
        userId,
        row,
        'entry_cancelled',
        evidence,
        new Date().toISOString(),
      );
      retired.push(row.bracketId);
    }
    return retired;
  };

  // Enrich ledger rows for the UI: flag terminal entry orders whose arm is
  // still armed — the only case where the "retire arm" action does anything.
  // Open-order coverage is derived from the same ledger page for consistency.
  const withUncoveredArmFlag = (orders: BrokerOrder[]) => {
    const openByAccount = new Map<string, BrokerOrder[]>();
    for (const order of orders) {
      if (order.status === 'pending' || order.status === 'acknowledged' || order.status === 'uncertain') {
        const list = openByAccount.get(order.accountId) ?? [];
        list.push(order);
        openByAccount.set(order.accountId, list);
      }
    }
    return orders.map((order) => {
      const terminalEntry =
        (order.status === 'rejected' || order.status === 'cancelled') &&
        (order.action === 'buy' || order.action === 'sell');
      if (!terminalEntry) return { ...order, uncoveredArm: false };
      const others = (openByAccount.get(order.accountId) ?? []).filter((o) => o.orderId !== order.orderId);
      return { ...order, uncoveredArm: uncoveredArmedMonitorRows(order, others).length > 0 };
    });
  };

  // CrossTrade broker-evidence resolution. A failed read is *unknown*, never
  // evidence of absence — only definite NT8 answers mutate the ledger. A
  // not-found answer is meaningful only once the dispatch has had time to
  // land, so the grace window gates it.
  // Env-overridable for e2e — prod defaults unchanged.
  const CT_PROBE_GRACE_MS = Math.max(1_000, Number(process.env.CT_PROBE_GRACE_MS) || 2 * 60_000);
  // Absence removal window: NT8 retains live and terminal orders in the book,
  // so an order still missing past this window is gone — remove the leg from
  // tracking (rejected) even when it had acknowledged. In-flight rows younger
  // than this keep the grace-gated probe path.
  const CT_ABSENT_REMOVE_MS = Math.max(CT_PROBE_GRACE_MS, Number(process.env.CT_ABSENT_REMOVE_MS) || 5 * 60_000);
  type CtResolveOutcome = {
    orderId: string;
    outcome: 'acknowledged' | 'filled' | 'cancelled' | 'rejected' | 'in_flight' | 'unknown';
    nt8State?: string;
    error?: string;
    retiredBrackets?: string[];
  };
  // CT-verified journal sync: when the NT8 book proves an entry filled but Pine
  // never emitted lifecycle for this bracket copy (resent orders, bridge-minted
  // reapply arms), the journal would otherwise miss the trade entirely. A real
  // broker fill is evidence enough to journal entry_filled once — the monitor
  // check skips brackets Pine already covered, and createTradeEvent's unique
  // (event_id, account, range) key makes repeat verify ticks no-ops.
  const syncCtFillToJournal = (
    account: BridgeAccount,
    order: BrokerOrder,
    nt8Row?: CrossTradeOrderRow,
  ): void => {
    if (!order.bracketId || (order.action !== 'buy' && order.action !== 'sell')) return;
    const side = order.side ?? (order.action === 'sell' ? 'short' : 'long');
    const monitor = database.findBracketMonitorEntry(account.id, order.rangeName, order.bracketId, side);
    if (monitor && (monitor.state === 'filled' || monitor.state === 'closed')) {
      // Pine already journaled the fill — upgrade its computed entry price to
      // the broker's actual averageFillPrice when they differ.
      if (typeof nt8Row?.averageFillPrice === 'number') {
        database.applyBrokerFillPriceToEntry(account.userId, account.id, order.rangeName, order.bracketId, monitor.tradeId, side, nt8Row.averageFillPrice, nt8Row.filled ?? nt8Row.quantity);
      }
      return;
    }
    const quantity = nt8Row?.filled || nt8Row?.quantity || order.quantity || monitor?.quantity || 1;
    const { created } = database.createTradeEvent({
      userId: account.userId,
      accountId: account.id,
      rangeName: monitor?.rangeName ?? order.rangeName,
      eventId: `ct-verified-${order.bracketId}-entry_filled`,
      tradeId: monitor?.tradeId ?? `${order.bracketId}-lifecycle-${side}-0`,
      eventType: 'entry_filled',
      instrument: nt8Row?.instrument ?? order.instrument,
      side,
      action: order.action === 'sell' ? 'sell' : 'buy',
      quantity: quantity > 0 ? quantity : 1,
      entryPrice: nt8Row?.averageFillPrice ?? order.stopPrice ?? order.price,
      occurredAt: new Date().toISOString(),
      ...(order.proxyAlertId ? { proxyAlertId: order.proxyAlertId } : {}),
    });
    if (!created) return;
    emitToUser(account.userId, 'log:bridge', {
      category: 'crosstrade',
      message: `NT8 fill journaled for ${order.bracketId} — entry_filled synthesized from broker state (no Pine lifecycle event)`,
      orderId: order.orderId,
      bracketId: order.bracketId,
    });
  };

  // Applies a definite NT8 answer to one ledger row — shared by the per-order
  // probe (sweep/reconcile) and the post-burst whole-book verify. Must run
  // inside the account's serialized queue section; `current` is the row
  // re-read inside that section.
  const applyCtProbeOutcome = (
    account: BridgeAccount,
    order: BrokerOrder,
    current: BrokerOrder,
    status: 'acknowledged' | 'filled' | 'cancelled' | 'rejected',
    note: string,
    nt8State?: string,
    nt8Row?: CrossTradeOrderRow,
  ): CtResolveOutcome => {
    if (status === 'filled') syncCtFillToJournal(account, order, nt8Row);
    // Rows that were already 'acknowledged' get the 'ct-verified' source so
    // the sweep stops re-probing them — verified once, then left alone.
    database.updateBrokerOrderStatus(account.id, order.orderId, status, note, undefined, current.status === 'acknowledged' ? 'ct-verified' : 'bridge');
    let retiredBrackets: string[] | undefined;
    if (status === 'rejected' || status === 'cancelled') {
      const openOrders = database
        .listOpenBrokerOrdersByAccount(account.id)
        .filter((open) => open.orderId !== order.orderId);
      retiredBrackets = retireUncoveredArmedMonitorRows(account.userId, current, openOrders, `ct-probe-${order.orderId}`);
    }
    // A confirmed Working leg on an already-open row should also heal a
    // cancelled arm — adoption only reaches uncovered brackets, so without
    // this a covered ledger + cancelled monitor diverges from Open Orders.
    let armRevived = false;
    if (status === 'acknowledged' && nt8State && mapNt8OrderState(nt8State) === 'working'
        && current.bracketId && (current.action === 'buy' || current.action === 'sell')) {
      const side = current.side ?? (current.action === 'sell' ? 'short' : 'long');
      const monitor = database.findBracketMonitorEntry(account.id, current.rangeName, current.bracketId, side);
      if (monitor?.state === 'cancelled') {
        database.reactivateBracketMonitorArm(account.userId, monitor);
        armRevived = true;
      }
    }
    emitToUser(account.userId, 'log:bridge', {
      category: 'crosstrade',
      message: `CT dispatch ${order.orderId} resolved ${status}${nt8State ? ` (NT8: ${nt8State})` : ''} — ${note}`,
      orderId: order.orderId, bracketId: order.bracketId, outcome: status, nt8State,
      retiredBrackets,
      ...(armRevived ? { armRevived: true } : {}),
    });
    return { orderId: order.orderId, outcome: status, nt8State, retiredBrackets };
  };

  const emitCtResolutionToast = (account: BridgeAccount, order: BrokerOrder, result: CtResolveOutcome): void => {
    if (result.outcome === 'rejected') {
      emitToUser(account.userId, 'toast:warning', {
        persistent: true,
        message: `CrossTrade dispatch ${order.orderId} resolved rejected at NT8${result.retiredBrackets?.length ? ` — retired armed bracket ${result.retiredBrackets.join(', ')}` : ''}.`,
      });
    } else if (result.outcome === 'unknown' && result.error && !/already resolved|superseded by a newer attempt/i.test(result.error)) {
      emitToUser(account.userId, 'toast:warning', {
        message: `CrossTrade sweep could not verify ${order.orderId}: ${result.error}`,
      });
    }
  };

  const resolveCrossTradeBrokerOrder = async (
    account: BridgeAccount,
    destination: CrossTradeDestination,
    order: BrokerOrder,
    // A caller that already fetched the account's orders list passes the rows
    // here — one book read then resolves many orders. Only ids missing from
    // the snapshot pay for a direct probe (deep history beyond the list).
    sharedBookRows?: CrossTradeOrderRow[],
  ): Promise<CtResolveOutcome> => {
    const graceExpired = Date.now() - Date.parse(order.occurredAt) >= CT_PROBE_GRACE_MS;
    // The ledger's order_id is the dispatch row id (bridge-<delivery>) — the
    // wire order_id CrossTrade/NT8 tracks is the bracket id only. A
    // bracket-less dispatch sends no order_id, so the broker can never echo
    // the ledger id back: probing those rows can only produce false
    // "not found" rejections.
    const wireOrderId = order.orderId ? ctWireOrderId(order.orderId) : undefined;
    if (!wireOrderId) {
      return { orderId: order.orderId, outcome: 'unknown' as const, error: 'no wire order_id (payload had no bracketId) — untraceable' };
    }
    let bookRow: CrossTradeOrderRow | undefined = sharedBookRows
      ?.find((r) => matchesCtOrderId(r, wireOrderId, order.action));
    const probe = bookRow ? undefined : await fetchCrossTradeOrder(destination, wireOrderId);
    const notFound = bookRow ? false
      : (!probe!.ok && (probe!.statusCode === 404 || /not found/i.test(probe!.error ?? '')));
    // The direct id lookup misses plain entries — NT8 regenerates the
    // AutomatedTradingOrderId, so /orders/:id 404s even when the order is
    // working. On a miss, read the book and retry via the oco_id+action
    // fallback before treating absence as evidence.
    if (notFound && !sharedBookRows) {
      const book = await fetchCrossTradeOrders(destination);
      if (book.ok) {
        bookRow = ((book.data?.orders ?? []) as CrossTradeOrderRow[])
          .find((r) => matchesCtOrderId(r, wireOrderId, order.action));
      }
    }
    return reapply.queue.run(account.id, async () => {
      // Re-read inside the serialized section: a lifecycle event or a dispatch
      // response that landed while the probe was in flight wins.
      // Account-scoped re-read — the same wire order_id fans out to every
      // routed account, so an unscoped lookup can return another account's
      // row (e.g. a cancelled sibling) and early-out this account forever.
      const current = database.findBrokerOrder(account.id, order.orderId);
      if (!current || !(current.status === 'pending' || current.status === 'uncertain' || current.status === 'acknowledged')) {
        return { orderId: order.orderId, outcome: 'unknown' as const, error: `already resolved (${current?.status ?? 'gone'})` };
      }
      // The wire id is the bracket id — resend attempts share it, so NT8's
      // answer identifies the logical order, not each attempt. Only the
      // newest open attempt may be resolved by it; an older attempt stays
      // unresolved until its own row is the latest.
      const logicalId = order.bracketId ?? wireOrderId;
      const newerSibling = database.listOpenBrokerOrdersByAccount(account.id).some(
        (open) => open.orderId !== order.orderId
          && (open.bracketId ?? (open.orderId ? ctWireOrderId(open.orderId) : undefined)) === logicalId
          && open.occurredAt > order.occurredAt,
      );
      if (newerSibling) {
        return { orderId: order.orderId, outcome: 'unknown' as const, error: 'superseded by a newer attempt for this bracket' };
      }
      const row = ((probe?.data?.order ?? probe?.data) as CrossTradeOrderRow | undefined) ?? bookRow;
      const apply = (status: 'acknowledged' | 'filled' | 'cancelled' | 'rejected', note: string, nt8State?: string): CtResolveOutcome =>
        applyCtProbeOutcome(account, order, current, status, note, nt8State, row);
      if (bookRow) {
        // Found via the oco_id+action fallback — resolve from the book row's
        // real state rather than the direct lookup's 404.
        const nt8State = typeof bookRow.orderState === 'string' ? bookRow.orderState : '';
        switch (mapNt8OrderState(nt8State)) {
          case 'working': return apply('acknowledged', `NT8 order state: ${nt8State} (book fallback)`, nt8State);
          case 'filled': return apply('filled', `NT8 order state: ${nt8State} (book fallback)`, nt8State);
          case 'cancelled': return apply('cancelled', `NT8 order state: ${nt8State} (book fallback)`, nt8State);
          case 'rejected': return apply('rejected', `NT8 order state: ${nt8State} (book fallback)`, nt8State);
          default: return { orderId: order.orderId, outcome: 'unknown', nt8State, error: 'unrecognized NT8 order state (book fallback)' };
        }
      }
      if (!probe || !probe.ok) {
        // Same rule as the book verify: absence is weak evidence while young —
        // an acknowledged row keeps its status until the removal window, since
        // NT8 retains terminal orders and a real cancel/fill is found
        // positively, not inferred.
        if (notFound && graceExpired && current.status !== 'acknowledged') return apply('rejected', 'order not found at NT8 after dispatch grace window');
        // Acknowledged but absent: the ACK only proved CrossTrade took the
        // call. NT8 retains live/terminal orders, so a row still missing past
        // the removal window is dead — remove the leg from tracking and let
        // the uncovered-arm pass retire anything it was covering.
        const absentRemoveExpired = notFound
          && Date.now() - Date.parse(current.occurredAt || current.createdAt) > CT_ABSENT_REMOVE_MS;
        if (absentRemoveExpired) return apply('rejected', 'acknowledged order absent from NT8 book past removal window');
        if (notFound) return { orderId: order.orderId, outcome: 'in_flight', error: probe?.error };
        if (!probe) return { orderId: order.orderId, outcome: 'unknown', error: 'no NT8 evidence (book snapshot + probe unavailable)' };
        return { orderId: order.orderId, outcome: 'unknown', error: probe.error ?? `probe failed (${probe.statusCode ?? 'no response'})` };
      }
      const nt8State = typeof row?.orderState === 'string' ? row.orderState : '';
      switch (mapNt8OrderState(nt8State)) {
        case 'working': return apply('acknowledged', `NT8 order state: ${nt8State}`, nt8State);
        case 'filled': return apply('filled', `NT8 order state: ${nt8State}`, nt8State);
        case 'cancelled': return apply('cancelled', `NT8 order state: ${nt8State}`, nt8State);
        case 'rejected': return apply('rejected', `NT8 order state: ${nt8State}`, nt8State);
        default: return { orderId: order.orderId, outcome: 'unknown', nt8State, error: 'unrecognized NT8 order state' };
      }

    });
  };

  // Post-burst whole-book verify: one orders-list read covers every open CT
  // entry at once — cheaper than per-order probes and it also catches rows
  // that ACKed success:true but were rejected asynchronously at NT8 (the
  // webhook response can never show those). Absence means "rejected" only
  // inside the verify window — older rows keep the per-order sweep probe,
  // which resolves by UserData and has deeper history than the list may.
  const verifyCrossTradeAccountBook = async (accountId: string): Promise<void> => {
    const account = database.findAccountById(accountId);
    const destination = account ? database.getTradersPostAccountDestination(account.id) : undefined;
    if (!account || !isCrossTradeConfigured(destination)) return;
    const ctDestination: CrossTradeDestination = {
      webhookUrl: destination!.crossTradeWebhookUrl!,
      secretKey: destination!.crossTradeSecretKey!,
      accountName: destination!.crossTradeAccountName || account.name,
    };
    // Snapshot time is captured before the fetch so a dispatch that completes
    // while the GET is in flight cannot be false-rejected as absent — absence
    // is only evidence for orders that existed when the snapshot was taken.
    const snapshotTakenAt = Date.now();
    const read = await fetchCrossTradeOrders(ctDestination);
    if (!read.ok) {
      // A failed read is unknown, never evidence of absence.
      console.info(JSON.stringify({ level: 'info', event: 'crossTradeVerifyReadFailed', accountId, statusCode: read.statusCode, error: read.error }));
      emitToUser(account.userId, 'toast:warning', { message: `CrossTrade sweep could not read the NT8 order book for ${account.name}: ${read.error ?? read.statusCode ?? 'unknown error'}` });
      return;
    }
    const nt8Rows = (read.data?.orders ?? []) as CrossTradeOrderRow[];
    const nowMs = Date.now();
    const openWireIds = new Set<string>();
    await reapply.queue.run(account.id, async (signal) => {
      // Only bracket-bearing rows are wire-traceable — a bracket-less dispatch
      // sends no order_id, so absence from the book is not evidence.
      const open = database.listOpenBrokerOrdersByAccount(account.id)
        .filter((o) => o.destination === 'crosstrade' && (o.action === 'buy' || o.action === 'sell') && o.bracketId);
      for (const o of open) {
        openWireIds.add(o.bracketId!);
        if (o.orderId) openWireIds.add(ctWireOrderId(o.orderId));
      }
      // Multiple open rows can share a wire id across resend attempts — the
      // NT8 row identifies the logical order, not each dispatch attempt, so
      // only the newest open attempt per bracket gets resolved; earlier
      // attempts stay as unresolved evidence.
      const newestByWire = new Map<string, BrokerOrder>();
      for (const order of open) {
        const wireId = order.bracketId ?? (order.orderId ? ctWireOrderId(order.orderId) : undefined);
        if (!wireId) continue;
        const prev = newestByWire.get(wireId);
        if (!prev || order.occurredAt > prev.occurredAt) newestByWire.set(wireId, order);
      }
      for (const order of newestByWire.values()) {
        if (signal.aborted) return;
        const current = database.findBrokerOrder(account.id, order.orderId);
        if (!current || !(current.status === 'pending' || current.status === 'uncertain' || current.status === 'acknowledged')) continue;
        const wireId = order.orderId ?? order.bracketId;
        if (!wireId) continue;
        const nt8Row = nt8Rows.find((row) => matchesCtOrderId(row, wireId, order.action));
        const note = 'post-burst book verify';
        let result: CtResolveOutcome | undefined;
        if (nt8Row) {
          const nt8State = typeof nt8Row.orderState === 'string' ? nt8Row.orderState : '';
          switch (mapNt8OrderState(nt8State)) {
            case 'working': result = applyCtProbeOutcome(account, order, current, 'acknowledged', `NT8 order state: ${nt8State} (${note})`, nt8State, nt8Row); break;
            case 'filled': result = applyCtProbeOutcome(account, order, current, 'filled', `NT8 order state: ${nt8State} (${note})`, nt8State, nt8Row); break;
            case 'cancelled': result = applyCtProbeOutcome(account, order, current, 'cancelled', `NT8 order state: ${nt8State} (${note})`, nt8State, nt8Row); break;
            case 'rejected': result = applyCtProbeOutcome(account, order, current, 'rejected', `NT8 order state: ${nt8State} (${note})`, nt8State, nt8Row); break;
            default: break;
          }
        } else if (Date.parse(order.occurredAt) < snapshotTakenAt
                   && nowMs - Date.parse(order.occurredAt) >= CT_PROBE_GRACE_MS
                   && nowMs - Date.parse(order.occurredAt) < CT_VERIFY_WINDOW_MS
                   // Absence is weak evidence — the orders list can skip or
                   // briefly drop rows (instrument-scoped/partial snapshots).
                   // An order NT8 already confirmed (acknowledged) stays
                   // acknowledged; the per-order sweep probe owns its terminal
                   // resolution with deeper history. Absence only rejects an
                   // order that was never confirmed at the broker.
                   && current.status !== 'acknowledged') {
          result = applyCtProbeOutcome(account, order, current, 'rejected', `order absent from NT8 order list (${note})`);
        }
        if (result && !signal.aborted) {
          console.info(JSON.stringify({ level: 'info', event: 'crossTradeVerifyResolve', accountId: account.id, orderId: order.orderId, outcome: result.outcome, nt8State: result.nt8State }));
          emitCtResolutionToast(account, order, result);
        }

      }
      for (const order of newestByWire.values()) {
        const wireId = order.orderId ?? order.bracketId;
        if (!wireId) continue;
        const nt8Row = nt8Rows.find((row) => matchesCtOrderId(row, wireId, order.action));
        if (nt8Row) checkAtmTemplateDivergence(account, order, nt8Row, nt8Rows);
      }
      // Filled entries drop out of the open set above — the common fill path
      // (Pine entry_filled) transitions the ledger to 'filled' — so check
      // recent fills too or a stale template goes undetected forever.
      const openWireSet = new Set(newestByWire.keys());
      for (const filledOrder of database.listEntryBrokerOrdersByAccount(account.id)) {
        if (filledOrder.status !== 'filled' || filledOrder.destination !== 'crosstrade') continue;
        if (nowMs - Date.parse(filledOrder.occurredAt) >= CT_VERIFY_WINDOW_MS) continue;
        const wireId = filledOrder.bracketId ?? (filledOrder.orderId ? ctWireOrderId(filledOrder.orderId) : undefined);
        if (!wireId || openWireSet.has(wireId)) continue;
        const nt8Row = nt8Rows.find((row) => matchesCtOrderId(row, wireId, filledOrder.action));
        if (nt8Row) checkAtmTemplateDivergence(account, filledOrder, nt8Row, nt8Rows);
      }
    });

  };

  // Debounced per account: a burst of sends collapses to a single book read.
  // ATM template divergence check — for ATM-managed entries (BE-enabled
  // ranges), the strategy's live legs reveal the template's actual SL/TP;
  // divergence from the range config means the template on NT8 is stale.
  // Warn once per account+range+bracket.
  const checkAtmTemplateDivergence = (
    account: BridgeAccount,
    order: Pick<BrokerOrder, 'rangeName' | 'action' | 'instrument' | 'bracketId'>,
    nt8Row: CrossTradeOrderRow,
    nt8Rows: CrossTradeOrderRow[],
  ): void => {
    const warnKey = `${account.id}|${order.rangeName}|${order.bracketId}`;
    const config = database.getRangeConfiguration(order.rangeName);
    const entryPx = typeof nt8Row.averageFillPrice === 'number' ? nt8Row.averageFillPrice : undefined;
    if (atmMismatchWarned.has(warnKey)) return;
    // Missing-protection detection applies to every filled entry, BE-enabled or
    // not — the legs are what make exits attributable either way. The config
    // compare below only has reference values when breakEvenEnabled is on.
    if (entryPx == null) return;
    const tickSize = inferredTickSize(order.instrument ?? '');
    const exitAction = order.action === 'buy' ? 'sell' : 'buy';
    // Scope legs to the strategy that owns THIS entry — the wire sends
    // atm_strategy = range name, and NT8 echoes it as ownerStrategy. Legs from
    // another BE range on the same instrument would produce a false compare.
    // Strategies without an ATM template get legs with no ownerStrategy at
    // all — falling back to unattributed legs keeps missing-protection and
    // divergence detection working for them too.
    const strategyName = order.rangeName;
    const exitStates = (r: CrossTradeOrderRow) =>
      mapNt8OrderState(String(r.orderState ?? '')) === 'working' || mapNt8OrderState(String(r.orderState ?? '')) === 'filled';
    const baseLegs = nt8Rows.filter((r) =>
      String(r.orderAction ?? '').toLowerCase() === exitAction
      && r.id !== nt8Row.id
      && String(r.instrument ?? '') === String(nt8Row.instrument ?? '')
      && exitStates(r),
    );
    // Fill-time leg signature diagnostics: dump the entry's sibling rows so
    // we can see exactly how NT8 attributes protection legs (ocoId group vs
    // ownerStrategy vs bare row). Once per entry per 46h — deduped across
    // sweeps and restarts like the other sweep warnings.
    const legSigKey = `legsig:${order.bracketId ?? nt8Row.id}`;
    if (!database.hasBridgeLogEntry({
      userId: account.userId, category: 'crosstrade', event: 'crossTradeLegSignature',
      dedupKey: legSigKey, since: new Date(Date.now() - 46 * 3600_000).toISOString(),
    })) {
      const rowSig = (r: CrossTradeOrderRow) => ({
        id: r.id, action: r.orderAction, type: r.orderType, state: r.orderState,
        qty: r.quantity, filled: r.filled, stop: r.stopPrice, limit: r.limitPrice,
        avg: r.averageFillPrice, ocoId: r.ocoId, name: r.name,
        owner: r.ownerStrategy ? { id: r.ownerStrategy.id, name: r.ownerStrategy.name, displayName: r.ownerStrategy.displayName } : null,
      });
      database.createBridgeLog(account.userId, 'crosstrade', {
        event: 'crossTradeLegSignature', dedupKey: legSigKey,
        accountId: account.id, accountName: account.name,
        rangeName: order.rangeName, bracketId: order.bracketId,
        instrument: nt8Row.instrument,
        entry: rowSig(nt8Row),
        siblings: baseLegs.map(rowSig),
      });
    }
    // Attribution keys off the ENTRY's owner, not the range name: NT8 marks
    // every strategy-spawned leg with its strategy instance ('THE MAX WIN - 1'),
    // and a strategy-owned filled entry carries that same owner. Legs sharing
    // the entry's ownerStrategy are its protection — for BE ranges the owner
    // IS the range name (atm_strategy), so the old behavior folds in. A
    // bare webhook entry (owner null) has no strategy to match → price
    // fallback below, which is also how an opposite-side ENTRY arm (same
    // action as an exit leg) is kept out of the count.
    const entryOwnerName = nt8Row.ownerStrategy?.name ?? nt8Row.ownerStrategy?.displayName;
    const ownedLegs = baseLegs.filter((r) =>
      entryOwnerName
        ? r.ownerStrategy?.name === entryOwnerName || r.ownerStrategy?.displayName === entryOwnerName
        : r.ownerStrategy?.name === strategyName || r.ownerStrategy?.displayName === strategyName);
    // For non-ATM entries a leg is attributable only when it's unattributed to
    // another strategy — a leg owned by a different range's ATM on the same
    // instrument must not count as this bracket's protection.
    const otherRangeStrategies = new Set(
      database.listRangeConfigurations().map((c) => c.rangeName).filter((n) => n !== strategyName),
    );
    const legs = ownedLegs.length > 0
      ? ownedLegs
      : entryOwnerName
        ? baseLegs.filter((r) => {
            // Strategy-owned entry, ownerless leg: plausible only by qty +
            // submission time — price can't be checked without the strategy's
            // internal SL/TP, which the bridge never sees. Rows owned by THIS
            // strategy are already in ownedLegs — a same-owner row reaching
            // here is the opposite-side arm, not protection.
            const owner = r.ownerStrategy?.name ?? r.ownerStrategy?.displayName;
            if (owner === entryOwnerName) return false;
            if (owner && otherRangeStrategies.has(owner)) return false;
            const legQty = typeof r.quantity === 'number' ? r.quantity : undefined;
            const entryQty = typeof nt8Row.filled === 'number' && nt8Row.filled > 0 ? nt8Row.filled : nt8Row.quantity;
            if (legQty != null && typeof entryQty === 'number' && legQty > entryQty) return false;
            const entryTime = Date.parse(String(nt8Row.time ?? ''));
            const legTime = Date.parse(String(r.time ?? ''));
            if (Number.isFinite(entryTime) && Number.isFinite(legTime) && legTime < entryTime) return false;
            return true;
          })
        : baseLegs.filter((r) => {
            const owner = r.ownerStrategy?.name ?? r.ownerStrategy?.displayName;
            if (owner && otherRangeStrategies.has(owner)) return false;
            // Ownerless entry → ownerless leg: the only discriminator vs an
            // opposite-side arm or a manual order is price, so validate the
            // leg against this range's configured SL/TP — an unrelated
            // wrong-price leg must not suppress the warning.
            const legQty = typeof r.quantity === 'number' ? r.quantity : undefined;
            const entryQty = typeof nt8Row.filled === 'number' && nt8Row.filled > 0 ? nt8Row.filled : nt8Row.quantity;
            if (legQty != null && typeof entryQty === 'number' && legQty > entryQty) return false;
            const entryTime = Date.parse(String(nt8Row.time ?? ''));
            const legTime = Date.parse(String(r.time ?? ''));
            if (Number.isFinite(entryTime) && Number.isFinite(legTime) && legTime < entryTime) return false;
            const entryPx = typeof nt8Row.averageFillPrice === 'number' ? nt8Row.averageFillPrice : undefined;
            const tick = inferredTickSize(String(nt8Row.instrument ?? ''));
            if (entryPx == null || !(tick > 0)) return false;
            const dir = String(nt8Row.orderAction ?? '').toLowerCase() === 'buy' ? 1 : -1;
            const slTicks = (config?.stopLossTicksCents ?? 0) / 100;
            const tpTicks = (config?.takeProfitTicksCents ?? 0) / 100;
            if (!(slTicks > 0) && !(tpTicks > 0)) return false; // nothing configured → nothing to validate against
            const tol = tick * 2;
            if (slTicks > 0 && typeof r.stopPrice === 'number' && r.stopPrice !== 0
                && Math.abs(r.stopPrice - (entryPx - dir * slTicks * tick)) <= tol) return true;
            if (tpTicks > 0 && typeof r.limitPrice === 'number' && r.limitPrice !== 0
                && Math.abs(r.limitPrice - (entryPx + dir * tpTicks * tick)) <= tol) return true;
            return false;
          });
    const stopLeg = legs.find((r) => typeof r.stopPrice === 'number' && r.stopPrice !== 0);
    const targetLeg = legs.find((r) => typeof r.limitPrice === 'number' && r.limitPrice !== 0);
    // Entry filled but no protection legs anywhere in the book — the ATM
    // strategy never spawned (or spawned detached), or the OCO legs died
    // with the send. An unprotected position can't produce an attributable
    // exit fill, so this warns for every filled entry regardless of mode.
    if (!stopLeg && !targetLeg) {
      if (atmMismatchWarned.has(warnKey)) return;
      // Persisted dedup — a restart re-checks every open bracket, so gate on
      // the log row instead of memory alone (warn once per bracket per 24h).
      if (database.hasBridgeLogEntry({
        userId: account.userId, category: 'crosstrade', event: 'crossTradeAtmMissing',
        bracketId: order.bracketId ?? '', since: new Date(Date.now() - 24 * 3600_000).toISOString(),
      })) { atmMismatchWarned.add(warnKey); return; }
      atmMismatchWarned.add(warnKey);
      emitToUser(account.userId, 'toast:warning', {
        persistent: true,
        message: `${order.rangeName} has a filled ${order.instrument} position with no ATM protection legs at NT8 — the position is unprotected. Check the strategy's ATM template assignment.`,
      });
      console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeAtmMissing', accountId: account.id, bracketId: order.bracketId }));
      database.createBridgeLog(account.userId, 'crosstrade', {
        event: 'crossTradeAtmMissing', accountId: account.id, accountName: account.name,
        rangeName: order.rangeName, bracketId: order.bracketId,
      });
      return;
    }
    if (!config?.breakEvenEnabled) return;
    // Divergence compares config against legs the strategy actually owns — a
    // plausibility-matched ownerless leg isn't the template's leg, and
    // comparing it produces nonsense diffs (a same-instrument arm reads as
    // tens of thousands of ticks off). No owner legs → nothing to compare.
    const ownedStop = ownedLegs.find((r) => typeof r.stopPrice === 'number' && r.stopPrice !== 0);
    const ownedTarget = ownedLegs.find((r) => typeof r.limitPrice === 'number' && r.limitPrice !== 0);
    if (!ownedStop && !ownedTarget) return;
    const expectedSl = config.stopLossStyle === 'ticks' ? Math.round(config.stopLossTicksCents / 100) : undefined;
    const expectedTp = config.takeProfitStyle === 'ticks' ? Math.round(config.takeProfitTicksCents / 100) : undefined;
    const mismatches: string[] = [];
    if (ownedStop && expectedSl != null) {
      const implied = Math.round(Math.abs(entryPx - ownedStop.stopPrice!) / tickSize);
      if (Math.abs(implied - expectedSl) > 1) mismatches.push(`SL ${implied}t vs config ${expectedSl}t`);
    }
    if (ownedTarget && expectedTp != null) {
      const implied = Math.round(Math.abs(ownedTarget.limitPrice! - entryPx) / tickSize);
      if (Math.abs(implied - expectedTp) > 1) mismatches.push(`TP ${implied}t vs config ${expectedTp}t`);
    }
    if (mismatches.length === 0) return;
    if (database.hasBridgeLogEntry({
      userId: account.userId, category: 'crosstrade', event: 'crossTradeAtmMismatch',
      bracketId: order.bracketId ?? '', since: new Date(Date.now() - 24 * 3600_000).toISOString(),
    })) { atmMismatchWarned.add(warnKey); return; }
    atmMismatchWarned.add(warnKey);
    emitToUser(account.userId, 'toast:warning', {
      persistent: true,
      message: `${order.rangeName} ATM template mismatch — NT8 legs show ${mismatches.join(', ')}. Download the regenerated template and re-import it into NT8.`,
    });
    console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeAtmMismatch', accountId: account.id, bracketId: order.bracketId, mismatches }));
    database.createBridgeLog(account.userId, 'crosstrade', {
      event: 'crossTradeAtmMismatch', accountId: account.id, accountName: account.name,
      rangeName: order.rangeName, bracketId: order.bracketId, mismatches,
    });
  };

  const CT_VERIFY_DELAY_MS = Math.max(500, Number(process.env.CT_VERIFY_DELAY_MS) || 12_000);
  const ctVerifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Brackets already warned about a template/config divergence — warn once.
  const atmMismatchWarned = new Set<string>();
  const ctDeferredWarned = new Set<string>();
  // accountId:root pairs already warned about an orphan broker position;
  // cleared when an open monitor row reappears on that root so the next
  // orphan re-warns.
  const ctOrphanWarned = new Set<string>();

  const scheduleCtBookVerify = (accountId: string): void => {
    const existing = ctVerifyTimers.get(accountId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      ctVerifyTimers.delete(accountId);
      void verifyCrossTradeAccountBook(accountId).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeVerifyError', accountId, error: message }));
        const account = database.findAccountById(accountId);
        if (account) emitToUser(account.userId, 'toast:warning', { message: `CrossTrade sweep verification failed for ${account.name}: ${message}` });
      });
    }, CT_VERIFY_DELAY_MS);
    timer.unref();
    ctVerifyTimers.set(accountId, timer);
  };

  // Background sweep: every CT dispatch stuck pending/uncertain past the grace
  // window gets probed against NT8 — plus acknowledged entries inside the
  // verify window, since a webhook ACK doesn't prove NT8 accepted the order
  // (asynchronous rejects show up only in the REST read). Safe on failure —
  // unknown stays unresolved.
  const CT_VERIFY_WINDOW_MS = 30 * 60_000;
  // Flat-position reconciliation: a 'filled' monitor row means the broker
  // opened a position — when the NT8 book goes flat on that instrument and no
  // working orders remain for it, the position is gone (ATM exit, OCO, manual
  // flatten). Synthesize the close so Open Orders and both journals stop
  // carrying a phantom position — realized PnL comes from the NT8 exit fill
  // rows when we can attribute them (ownerStrategy set = ATM-owned leg, which
  // also excludes the user's manual orders on the same instrument).
  // Phantom-close exclusions carry this marker in adjustment_note so the
  // broker-realization upgrade can tell them apart from operator exclusions.
  const CT_PHANTOM_EXCLUSION_MARKER = 'ct-phantom-close';
  const syncFilledBracketClosures = async (
    account: BridgeAccount,
    destination: CrossTradeDestination,
    // A sweep that already read the account's orders list passes it here so the
    // pass costs one book read, not two. The snapshot can be slightly stale by
    // queue depth — acceptable: every consumer below defers on missing
    // evidence rather than acting on absence.
    sharedOrdersRead?: CrossTradeApiResult,
  ): Promise<void> => {
    const now = new Date().toISOString();
    await reapply.queue.run(account.id, async (signal) => {
      // Snapshot inside the serialized task — a monitor row can flip filled
      // while a lifecycle event was queued behind this sweep.
      const filled = database.listFilledBracketMonitorEntriesByAccount(account.id)
        // Only reconcile rows backed by a real CT dispatch — a Pine-only 'filled'
        // (suppressed send, extension-only route) is simulated state, not a
        // broker position, so the flat book must not close it.
        .filter((row) => database.hasAttemptedEntryOrder(row.accountId, row.rangeName, row.bracketId, row.side));
      // Pine-first closes retire the monitor before the flat check runs —
      // closed rows get a second look so broker fill data can replace Pine's
      // reported realization. Cover the whole journal day (UTC-4), not just
      // the 30-min verify window: an EOD-breakeven close can be upgraded to
      // the real exit hours later, including by a manual dev sweep.
      const shiftedDay = new Date(Date.now() + JOURNAL_TIME_OFFSET_MINUTES * 60_000);
      const closedCutoff = new Date(
        Date.UTC(shiftedDay.getUTCFullYear(), shiftedDay.getUTCMonth(), shiftedDay.getUTCDate())
        - JOURNAL_TIME_OFFSET_MINUTES * 60_000,
      ).toISOString();
      const recentlyClosed = database.listRecentlyClosedMonitorEntriesByAccount(account.id, closedCutoff);
      // No early return on empty candidates — orphan-position detection below
      // must run even when the account has no local filled/closed rows, or a
      // broker-only position would never be surfaced.
      // Read the book inside the serialized task — a snapshot taken before
      // queueing can go stale if a new entry dispatched/filled meanwhile.
      // A read that throws or fails is unknown — never evidence. Failed
      // reads must not imply flat, rejection, or closure.
      let ordersRead: CrossTradeApiResult, posRead: CrossTradeApiResult;
      try {
        [ordersRead, posRead] = sharedOrdersRead
          ? [sharedOrdersRead, await fetchCrossTradePositions(destination)]
          : await Promise.all([
              fetchCrossTradeOrders(destination),
              fetchCrossTradePositions(destination),
            ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitToUser(account.userId, 'toast:warning', { message: `CrossTrade position sweep failed for ${account.name}: ${message}` });
        return;
      }
      if (signal.aborted) return;
      if (!ordersRead.ok || !posRead.ok) {
        const failed = !ordersRead.ok ? ordersRead : posRead;
        const message = ordersRead.error ?? posRead.error ?? `orders HTTP ${ordersRead.statusCode ?? 'unknown'}, positions HTTP ${posRead.statusCode ?? 'unknown'}`;
        noteCtSweepReadFailure(account, failed);
        emitToUser(account.userId, 'toast:warning', { message: `CrossTrade position sweep could not read the NT8 book for ${account.name}: ${message}` });
        return; // failed read = unknown, never evidence
      }
      const orders = (ordersRead.data?.orders ?? []) as CrossTradeOrderRow[];
      // Net position direction per instrument root. An opposite-side position
      // is proof the bracket's exposure is gone — a reversal fill doubles as
      // the original arm's exit — so only a SAME-side position means "open".
      const positionDirByRoot = new Map<string, string>();
      for (const p of (posRead.data?.positions ?? []) as CrossTradePositionRow[]) {
        if (String(p.marketPosition ?? '').toLowerCase() === 'flat' || (p.quantity ?? 0) === 0) continue;
        const root = continuousTickerRoot(String(p.instrument ?? ''));
        if (root) positionDirByRoot.set(root, String(p.marketPosition ?? '').toLowerCase());
      }
      // Orphan bracket legs: a strategy-owned Working order on an instrument
      // with no open position is a leg left behind (e.g., a TP that outlived
      // a breakeven stop-out). Orders we dispatched are excluded via wire-id
      // match; ownerless rows are skipped — they may be manual orders.
      // Read-only: warn, never cancel. Runs in the sweep (not the post-send
      // verify) so armed but quiet accounts stay watched.
      {
        const openWireIds = new Set<string>();
        for (const o of database.listOpenBrokerOrdersByAccount(account.id)) {
          if (o.destination !== 'crosstrade' || (o.action !== 'buy' && o.action !== 'sell')) continue;
          if (o.bracketId) openWireIds.add(o.bracketId);
          if (o.orderId) openWireIds.add(ctWireOrderId(o.orderId));
        }
        const orphans = orders.filter((row) => {
          if (String(row.orderState ?? '').toLowerCase() !== 'working') return false;
          if (!row.ownerStrategy?.name && !row.ownerStrategy?.displayName) return false;
          if ([row.id, row.orderId, row.userData, row.automatedTradingOrderId, row.name]
            .some((v) => typeof v === 'string' && openWireIds.has(v))) return false;
          // Armed arm pairs aren't orphans: a strategy-owned ENTRY leg in an
          // opposite-action Working OCO pair is an armed range, not a bracket
          // leg left behind. A real orphan's partner is Filled/Cancelled (or
          // never existed), so it can't satisfy this pairing.
          if (row.ocoId && orders.some((other) => other !== row
            && other.ocoId === row.ocoId
            && String(other.orderState ?? '').toLowerCase() === 'working'
            && String(other.instrument ?? '') === String(row.instrument ?? '')
            && String(other.orderAction ?? '').toLowerCase() !== String(row.orderAction ?? '').toLowerCase())) return false;
          const inst = String(row.instrument ?? '');
          const root = continuousTickerRoot(inst);
          return inst === '' || !root || !positionDirByRoot.has(root);
        });
        if (orphans.length) {
          const label = orphans.map((o) => String(o.name ?? o.orderId ?? o.id)).slice(0, 4).join(', ');
          const message = `NT8 book shows ${orphans.length} working order(s) with no open position — possible orphaned bracket leg(s): ${label}${orphans.length > 4 ? '…' : ''}`;
          // Dedup on the orphan id set — a stalled leg would otherwise warn
          // once per sweep tick.
          const orphanKey = `orphans:${orphans.map((o) => o.id).sort().join(',')}`;
          if (!database.hasBridgeLogEntry({
            userId: account.userId, category: 'crosstrade', event: 'crossTradeOrphanOrders',
            dedupKey: orphanKey, since: new Date(Date.now() - 24 * 3600_000).toISOString(),
          })) {
            console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeOrphanOrders', accountId: account.id, count: orphans.length, orders: orphans.map((o) => o.id) }));
            database.createBridgeLog(account.userId, 'crosstrade', {
              event: 'crossTradeOrphanOrders', dedupKey: orphanKey,
              accountId: account.id, accountName: account.name, message,
            });
            emitToUser(account.userId, 'toast:warning', { persistent: true, message: `${account.name}: ${message}` });
          }
        }
      }
      // Book instrument per row — destinations transform tickers
      // (micros_only: NQ→MNQ); the alert ticker is not what NT8 holds.
      const bookInstrumentFor = (row: { bracketId?: string; instrument: string }): string => {
        const ledgerEntry = database.listEntryBrokerOrdersByAccount(account.id)
          .filter((o) => o.bracketId === row.bracketId && o.destination === 'crosstrade')
          .at(-1);
        return ledgerEntry?.instrument ?? row.instrument;
      };
      // Orphan broker positions: a live NT8 position on a root with no open
      // monitor row is broker activity the bridge never saw — manual order,
      // rearmed NT8 strategy, or a missed alert. Flag it for review; the
      // journal can't carry P&L for it without attributable legs. Monitor rows
      // resolve through their CT ledger instrument so a micros-mapped position
      // isn't orphaned by its own bracket.
      const openMonitorRoots = new Set(
        database.listBracketMonitorEntriesForAdoption(account.id)
          .filter((m) => m.state === 'armed' || m.state === 'filled')
          .map((m) => continuousTickerRoot(bookInstrumentFor(m)))
          .filter((r): r is string => r != null),
      );
      for (const [root, dir] of positionDirByRoot) {
        const orphanKey = `${account.id}:${root}`;
        if (openMonitorRoots.has(root)) { ctOrphanWarned.delete(orphanKey); continue; }
        if (ctOrphanWarned.has(orphanKey)) continue;
        ctOrphanWarned.add(orphanKey);
        // Persisted dedup — restarts re-warn every still-open position since
        // the in-memory set resets. Gate on the log row (46h, under the 48h
        // bridge_logs retention) so only genuinely new orphans notify.
        if (database.hasBridgeLogEntry({
          userId: account.userId, category: 'crosstrade', event: 'crossTradeOrphanPosition',
          dedupKey: `orphanpos:${root}`, since: new Date(Date.now() - 46 * 3600_000).toISOString(),
        })) continue;
        const reason = `live ${dir} ${root} position has no open bracket — manual or broker-side order the bridge never saw`;
        database.createBridgeLog(account.userId, 'crosstrade', {
          event: 'crossTradeOrphanPosition', accountId: account.id, reason, dedupKey: `orphanpos:${root}`,
        });
        emitToUser(account.userId, 'toast:warning', { persistent: true, message: `CrossTrade sweep: ${reason}` });
      }
      // Orphan FILLED orders: a broker-only fill (often already flat — the
      // round trip happened entirely inside NT8) matches no local ledger row
      // and no open monitor. Without this, manual/missed-alert P&L stays
      // invisible. Surface once per order id; never journal a row.
      const knownRangeNames = new Set(database.listRangeConfigurations().map((c) => c.rangeName));
      const ledgerEntries = database.listEntryBrokerOrdersByAccount(account.id)
        .filter((o) => o.destination === 'crosstrade');
      for (const o of orders) {
        if (mapNt8OrderState(String(o.orderState ?? '')) !== 'filled') continue;
        // NT8 can echo the wire id in id/orderId/userData/automatedTradingOrderId
        // /name — or only via oco_id for plain non-ATM entries — so a bare id
        // set misses real matches. matchesCtOrderId covers all the forms.
        if (ledgerEntries.some((e) => matchesCtOrderId(o, e.orderId, e.action))) continue;
        const owner = o.ownerStrategy?.name ?? o.ownerStrategy?.displayName;
        if (owner && knownRangeNames.has(owner)) continue; // range-owned legs attribute elsewhere
        const fillKey = `orphanfill:${account.id}:${String(o.id)}`;
        if (ctOrphanWarned.has(fillKey)) continue;
        ctOrphanWarned.add(fillKey);
        // Same persisted dedup — a process restart re-reports every historic
        // fill in the NT8 book otherwise (bridge_logs retention is 48h).
        if (database.hasBridgeLogEntry({
          userId: account.userId, category: 'crosstrade', event: 'crossTradeOrphanFill',
          dedupKey: fillKey, since: new Date(Date.now() - 46 * 3600_000).toISOString(),
        })) continue;
        const reason = `NT8 fill ${String(o.id)} ${String(o.orderAction)} ${o.quantity ?? '?'} ${String(o.instrument)} has no bridge bookkeeping — broker-side trade with no attributable bracket`;
        database.createBridgeLog(account.userId, 'crosstrade', {
          event: 'crossTradeOrphanFill', accountId: account.id, reason, dedupKey: fillKey,
        });
        emitToUser(account.userId, 'toast:warning', { persistent: true, message: `CrossTrade sweep: ${reason}` });
      }
      // Per-instrument ambiguity: two filled brackets on one instrument share
      // exit legs — count by the DESTINATION root or transformed tickers
      // falsely look distinct and each row would attribute the same exit fill.
      const filledCountByRoot = new Map<string, number>();
      const filledQtyByRoot = new Map<string, number>();
      for (const r of filled) {
        const r2 = continuousTickerRoot(bookInstrumentFor(r));
        if (r2) {
          filledCountByRoot.set(r2, (filledCountByRoot.get(r2) ?? 0) + 1);
          filledQtyByRoot.set(r2, (filledQtyByRoot.get(r2) ?? 0) + (r.quantity ?? 1));
        }
      }
      // Broker-dispatched entry quantity per bracket (newest attempt first) —
      // the leg-close proof must compare exit legs against what NT8 actually
      // received, not Pine's pre-routing monitor quantity (micros/overrides
      // rescale the wire qty).
      const entryQtyByBracket = new Map<string, number>();
      for (const o of database.listEntryBrokerOrdersByAccount(account.id)) {
        if (o.bracketId && o.action && !entryQtyByBracket.has(o.bracketId)) {
          entryQtyByBracket.set(o.bracketId, o.quantity ?? 0);
        }
      }
      for (const row of filled) {
        if (signal.aborted) return;
        const bookInstrument = bookInstrumentFor(row);
        const root = continuousTickerRoot(bookInstrument);
        if (!root) continue;
        const instrumentOrders = orders.filter(
          (o) => continuousTickerRoot(String(o.instrument ?? '')) === root,
        );
        // Template check runs while the position is live — the legs are
        // Working then, which is when the template's SL/TP are observable.
        const entryAction0 = row.side === 'long' ? 'buy' : 'sell';
        const entryRow0 = findCtEntryRow(instrumentOrders, row.bracketId, entryAction0);
        if (entryRow0) {
          checkAtmTemplateDivergence(account, { rangeName: row.rangeName, action: entryAction0, instrument: row.instrument, bracketId: row.bracketId }, entryRow0, orders);
        }
        const bookPositionDir = positionDirByRoot.get(root);
        // Multiple filled brackets share the instrument — we can still close
        // (the book is provably flat), but exit-fill attribution is ambiguous:
        // record the close as unmatched breakeven rather than guess, and let a
        // later Pine close upgrade the realization (ct-flat rows stay
        // upgradeable). Log once per bracket so the ambiguity is visible.
        const attributionAmbiguous = (filledCountByRoot.get(root) ?? 0) > 1;
        if (attributionAmbiguous && !ctDeferredWarned.has(row.bracketId)) {
          ctDeferredWarned.add(row.bracketId);
          const reason = `${filledCountByRoot.get(root)} filled brackets share ${root} — closing without exit attribution`;
          database.createBridgeLog(account.userId, 'crosstrade', {
            event: 'crossTradeAttributionAmbiguous', accountId: account.id, bracketId: row.bracketId, reason,
          });
          emitToUser(account.userId, 'toast:warning', { persistent: true, message: `CrossTrade sweep warning for ${row.bracketId}: ${reason}` });
        }
        // CT orders are individually identified (order_id/oco_id echo on our
        // legs, ownerStrategy on ATM exits) — unlike TradersPost, where cancel
        // is instrument-scoped and any live order could be ours. Defer only
        // while a leg provably bound to this bracket is still live: an OCO
        // sibling that hasn't died yet, a partially-filled entry remainder, or
        // a resend leg that could reopen exposure. The user's unrelated
        // working orders on the same instrument don't block the close.
        const exitAction0 = row.side === 'long' ? 'sell' : 'buy';
        const stillWorking = instrumentOrders.some((o) => {
          const raw = String(o.orderState ?? '');
          const live = mapNt8OrderState(raw) === 'working' || /part/i.test(raw);
          if (!live) return false;
          return matchesCtOrderId(o, row.bracketId, entryAction0)
            || matchesCtOrderId(o, row.bracketId, exitAction0)
            || o.ownerStrategy?.name === row.rangeName
            || o.ownerStrategy?.displayName === row.rangeName;
        });
        if (stillWorking) continue;
        // Leg-first close proof: a strategy-owned exit leg Filled for the
        // bracket's full qty IS the close — decided on the individual leg,
        // not the netted position. Fires even while the book reads same-side
        // (a manual or other-strategy position on the root can hide the
        // flat forever). Ambiguous roots can't map shared ATM legs to a
        // bracket, so they keep the flat-book requirement below.
        const entryTsPre = Date.parse(String(entryRow0?.time ?? row.lastOccurredAt));
        const brokerEntryQty = entryRow0?.quantity ?? entryQtyByBracket.get(row.bracketId) ?? row.quantity ?? 1;
        const legProvenClose = !attributionAmbiguous && instrumentOrders.some((o) =>
          mapNt8OrderState(String(o.orderState ?? '')) === 'filled'
          && String(o.orderAction ?? '').toLowerCase() === exitAction0
          && !matchesCtOrderId(o, row.bracketId, exitAction0)
          && (o.ownerStrategy?.name === row.rangeName || o.ownerStrategy?.displayName === row.rangeName)
          && (o.filled ?? o.quantity ?? 0) >= brokerEntryQty
          && Date.parse(String(o.time ?? '')) > entryTsPre,
        );
        if (bookPositionDir === row.side && !legProvenClose) continue; // same-side position still open at NT8
        // The close must be backed by broker-confirmed entry evidence — a
        // Pine-side 'filled' monitor + a dispatch NT8 never confirmed must not
        // synthesize a position close. Positive evidence is either the live
        // book's Filled row or a prior confirmed ledger state (NT8 prunes
        // order history — the book can forget what it once confirmed).
        const entryConfirm = findCtEntryRow(instrumentOrders, row.bracketId, row.side === 'long' ? 'buy' : 'sell');
        // An entry row NT8 still lists but never marked Filled contradicts the
        // Pine fill — defer. Absence is weaker (NT8 prunes history), so a
        // broker-confirmed ledger row is enough when the book has forgotten.
        if (entryConfirm && mapNt8OrderState(String(entryConfirm.orderState ?? '')) !== 'filled') {
          if (!ctDeferredWarned.has(row.bracketId)) {
            ctDeferredWarned.add(row.bracketId);
            const reason = `entry order state: ${entryConfirm.orderState}`;
            database.createBridgeLog(account.userId, 'crosstrade', {
              event: 'crossTradeCloseDeferred', accountId: account.id, bracketId: row.bracketId, reason,
            });
            emitToUser(account.userId, 'toast:warning', { persistent: true, message: `CrossTrade sweep deferred close for ${row.bracketId}: ${reason}` });
          }
          continue;
        }
        const ledgerConfirmed = database.hasBrokerConfirmedEntryOrder(row.accountId, row.rangeName, row.bracketId, row.side);
        if (!entryConfirm && !ledgerConfirmed) {
          if (!ctDeferredWarned.has(row.bracketId)) {
            ctDeferredWarned.add(row.bracketId);
            const reason = 'no broker-confirmed entry fill (book + ledger silent)';
            database.createBridgeLog(account.userId, 'crosstrade', {
              event: 'crossTradeCloseDeferred', accountId: account.id, bracketId: row.bracketId, reason,
            });
            emitToUser(account.userId, 'toast:warning', { persistent: true, message: `CrossTrade sweep deferred close for ${row.bracketId}: ${reason}` });
          }
          continue;
        }

        const entryAction = row.side === 'long' ? 'buy' : 'sell';
        const exitAction = row.side === 'long' ? 'sell' : 'buy';
        const entryRow = findCtEntryRow(instrumentOrders, row.bracketId, entryAction);
        const entryPx = typeof entryRow?.averageFillPrice === 'number' ? entryRow.averageFillPrice : row.entryPrice ?? undefined;
        if (typeof entryRow?.averageFillPrice === 'number') {
          database.applyBrokerFillPriceToEntry(account.userId, row.accountId, row.rangeName, row.bracketId, row.tradeId, row.side, entryRow.averageFillPrice, entryRow.filled ?? entryRow.quantity);
        }
        const brokerQty = typeof entryRow?.quantity === 'number' && entryRow.quantity > 0 ? entryRow.quantity : (row.quantity ?? 1);
        // Exit legs: opposite-action fills on the instrument owned by an ATM
        // strategy, after the fill event — excludes our own entry + manual orders.
        // When the entry row was pruned from the book, compare against the
        // monitor's fill timestamp instead — NaN would reject every leg.
        const entryTs = Date.parse(String(entryRow?.time ?? row.lastOccurredAt));
        let exitFills = attributionAmbiguous ? [] : instrumentOrders.filter((o) =>
          mapNt8OrderState(String(o.orderState ?? '')) === 'filled'
          && String(o.orderAction ?? '').toLowerCase() === exitAction
          && !matchesCtOrderId(o, row.bracketId, exitAction)
          && (o.ownerStrategy?.name === row.rangeName || o.ownerStrategy?.displayName === row.rangeName)
          && Date.parse(String(o.time ?? '')) > entryTs,
        );
        let consensusMatch = false;
        if (attributionAmbiguous) {
          // Sibling brackets share the instrument — no single leg is provably
          // ours, but when every opposite-action fill agrees on one price the
          // exit value is identical either way. Use Pine's entry + that price.
          const consensus = instrumentOrders.filter((o) =>
            mapNt8OrderState(String(o.orderState ?? '')) === 'filled'
            && String(o.orderAction ?? '').toLowerCase() === exitAction
            && !matchesCtOrderId(o, row.bracketId, exitAction)
            && (o.ownerStrategy?.name === row.rangeName || o.ownerStrategy?.displayName === row.rangeName)
            && typeof o.averageFillPrice === 'number'
            && Date.parse(String(o.time ?? '')) > entryTs,
          );
          const distinctPx = new Set(consensus.map((o) => o.averageFillPrice));
          // Agreement is only meaningful when there is an owned leg for every
          // ambiguous bracket — a single fill at one price satisfies
          // distinctPx==1 but belongs to just one of them, so applying it to
          // all rows would double-count realized P&L (e.g. the other position
          // flattened manually). Insufficient coverage keeps the existing
          // unmatched-breakeven path.
          const exitQty = consensus.reduce((q, o) => q + (o.filled ?? o.quantity ?? 1), 0);
          const neededQty = filledQtyByRoot.get(root) ?? 0;
          if (distinctPx.size === 1 && consensus.length >= (filledCountByRoot.get(root) ?? 0) && exitQty >= neededQty) {
            consensusMatch = true;
            exitFills = [consensus[0]!];
          }
        }
        const tickSize = inferredTickSize(bookInstrument);
        const qty = brokerQty;
        let ticks = 0;
        let dollars = 0;
        let outcome: 'win' | 'loss' | 'breakeven' = 'breakeven';
        const reversed = bookPositionDir != null && bookPositionDir !== row.side;
        const legProven = bookPositionDir === row.side; // reached only via legProvenClose — book still reads open
        let note = reversed
          ? 'NT8 position reversed — exit fill not matched; PnL recorded as 0'
          : 'NT8 flat — exit fill not matched; PnL recorded as 0';
        const exitPx = exitFills[0]?.averageFillPrice;
        if (entryPx != null && typeof exitPx === 'number') {
          const dir = row.side === 'long' ? 1 : -1;
          ticks = Math.round(((exitPx - entryPx) * dir) / tickSize);
          dollars = ticks * inferredTickDollars(row.instrument) * qty;
          outcome = ticks > 0 ? 'win' : ticks < 0 ? 'loss' : 'breakeven';
          note = legProven
            ? `synthesized from NT8 exit leg — book still shows ${bookPositionDir} position; exit ${exitAction} @ ${exitPx}`
            : reversed
              ? `synthesized from NT8 book — position reversed to ${bookPositionDir}; exit ${exitAction} @ ${exitPx}`
              : consensusMatch
                ? `synthesized from NT8 book — ambiguous brackets, exit legs agree @ ${exitPx} (consensus)`
                : `synthesized from NT8 book — position flat; exit ${exitAction} @ ${exitPx}`;
        }
        // Broker data is authoritative in both directions: a real Pine close
        // already journaled gets its realization REPLACED by the matched CT
        // numbers (fill prices include spread/slippage; Pine reports are
        // strategy-side estimates). Unmatched synths never overwrite.
        const priorRangeClose = database.findRangeTradeClosedForTrade(row.rangeName, row.tradeId);
        const rangeAlreadyClosed = priorRangeClose && !priorRangeClose.eventId.startsWith('ct-flat-');
        const matched = entryPx != null && typeof exitPx === 'number';
        if (rangeAlreadyClosed && matched) {
          database.updateRangeTradeEventRealization(priorRangeClose.id, {
            exitPrice: exitPx,
            realizedTicksCents: Math.round(ticks * 100),
            realizedDollarsCents: Math.round(dollars * 100),
            outcome,
            occurredAt: now,
          });
        }
        try {
          if (!rangeAlreadyClosed) database.createRangeTradeEvent({
            rangeName: row.rangeName,
            eventId: `ct-flat-${row.tradeId || row.bracketId}-${row.side}-trade_closed`,
            tradeId: row.tradeId,
            eventType: 'trade_closed',
            instrument: row.instrument,
            side: row.side,
            action: 'exit',
            quantity: qty,
            occurredAt: now,
            realizedTicksCents: Math.round(ticks * 100),
            realizedDollarsCents: Math.round(dollars * 100),
            outcome,
            ...(entryPx != null && exitPx != null ? { entryPrice: entryPx, exitPrice: exitPx } : {}),
            adjustmentNote: note,
          });
        } catch (error) {
          console.warn('[ct-flat-sync] Failed to record range trade_closed', { bracketId: row.bracketId, error: error instanceof Error ? error.message : String(error) });
        }
        const priorAccountClose = database.findTradeClosedForTrade(row.accountId, row.rangeName, row.tradeId);
        if (priorAccountClose && !priorAccountClose.eventId.startsWith('ct-flat-') && matched) {
          database.updateTradeEventRealization(priorAccountClose.id, {
            exitPrice: exitPx,
            realizedTicksCents: Math.round(ticks * 100),
            realizedDollarsCents: Math.round(dollars * 100),
            outcome,
            occurredAt: now,
          });
          // Broker-derived realization — sync the entry_filled row to the same
          // broker fill price so the event set stays internally consistent.
          if (typeof entryRow?.averageFillPrice === 'number') {
            database.applyBrokerFillPriceToEntry(account.userId, row.accountId, row.rangeName, row.bracketId, row.tradeId, row.side, entryRow.averageFillPrice, entryRow.filled ?? entryRow.quantity);
          }
        }
        try {
          const { event } = priorAccountClose
            ? { event: priorAccountClose }
            : database.createTradeEvent({
            userId: account.userId,
            accountId: row.accountId,
            rangeName: row.rangeName,
            eventId: `ct-flat-${row.tradeId || row.bracketId}-${row.side}-trade_closed`,
            tradeId: row.tradeId,
            eventType: 'trade_closed',
            instrument: row.instrument,
            side: row.side,
            action: 'exit',
            quantity: qty,
            occurredAt: now,
            realizedTicksCents: Math.round(ticks * 100),
            realizedDollarsCents: Math.round(dollars * 100),
            outcome,
            ...(entryPx != null && exitPx != null ? { entryPrice: entryPx, exitPrice: exitPx } : {}),
          });
          // An unmatched synth close fabricates $0/breakeven P&L — exclude it
          // from performance so it doesn't count as a real breakeven trade.
          // Matched exits carry real broker numbers and stay counted.
          if (!matched && event.eventId.startsWith('ct-flat-')) {
            database.setTradeEventPerformanceExclusion(account.userId, event.id, 'erroneous', account.userId);
          }
          database.retireBracketMonitorEntry(account.userId, row, 'trade_closed', event.eventId, now);
          database.createBridgeLog(account.userId, 'crosstrade', {
            event: 'crossTradeFlatClose', accountId: account.id, accountName: account.name,
            bracketId: row.bracketId, side: row.side, quantity: qty, ticks, dollars, note,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn('[ct-flat-sync] Failed to close filled bracket', { bracketId: row.bracketId, error: message });
          emitToUser(account.userId, 'toast:warning', { message: `CrossTrade sweep could not journal close for ${row.bracketId}: ${message}` });
        }
      }

      // Pine-first closes: the monitor already retired, so the flat check
      // above never sees them. If the book attributes the bracket's entry
      // fill + a strategy-owned exit fill, the broker numbers REPLACE the
      // journaled realization — matched CT data is authoritative over Pine's
      // report regardless of arrival order.
      // Roots still claimed by an open filled bracket — a same-side position
      // there belongs to the live bracket, not proof a closed row is phantom.
      const openFilledRoots = new Set(
        filled.map((r) => continuousTickerRoot(bookInstrumentFor(r))).filter((r): r is string => r != null),
      );
      // Multiple same-side closes sharing a root can each contradict the same
      // book position — flag only when the phantom candidate is uniquely
      // attributable, consistent with the multi-bracket deferral below.
      // Count by the DESTINATION-normalized root (same ledger lookup as the
      // phantom check below) — transformed tickers must collapse together.
      const closedCountByRootSide = new Map<string, number>();
      for (const r of recentlyClosed) {
        const ledgerEntry = database.listEntryBrokerOrdersByAccount(account.id)
          .filter((o) => o.bracketId === r.bracketId && o.destination === 'crosstrade')
          .at(-1);
        const rr = continuousTickerRoot(ledgerEntry?.instrument ?? r.instrument ?? '');
        if (rr) closedCountByRootSide.set(`${rr}|${r.side}`, (closedCountByRootSide.get(`${rr}|${r.side}`) ?? 0) + 1);
      }
      for (const row of recentlyClosed) {
        if (signal.aborted) return;
        const closedLedgerEntry = database.listEntryBrokerOrdersByAccount(account.id)
          .filter((o) => o.bracketId === row.bracketId && o.destination === 'crosstrade')
          .at(-1);
        const closedBookInstrument = closedLedgerEntry?.instrument ?? row.instrument;
        const root = continuousTickerRoot(closedBookInstrument);
        if (!root) continue;
        // Phantom close: the journal says closed but NT8 still holds a
        // same-side position on the root with no other open bracket to claim
        // it — Pine's reported exit never reached the broker. Flag the
        // journaled close erroneous so strategy-side estimates stop feeding
        // performance, and surface it once.
        if (positionDirByRoot.get(root) === row.side && !openFilledRoots.has(root)
            && (closedCountByRootSide.get(`${root}|${row.side}`) ?? 0) === 1) {
          // Dedupe per account + arm cycle — the same bracket fans out to
          // multiple accounts and Ultra reuses bracket ids across re-arms;
          // a new arm must be able to phantom-flag again.
          const phantomKey = `phantom:${account.id}:${row.bracketId}:${row.lastEventId}`;
          const phantomClose = database.findTradeClosedForTrade(row.accountId, row.rangeName, row.tradeId);
          if (phantomClose && !phantomClose.eventId.startsWith('ct-flat-') && !phantomClose.excludedFromPerformance) {
            database.setTradeEventPerformanceExclusion(account.userId, phantomClose.id, 'erroneous', account.userId, CT_PHANTOM_EXCLUSION_MARKER);
          }
          if (!ctOrphanWarned.has(phantomKey)) {
            ctOrphanWarned.add(phantomKey);
            const reason = `journaled close on ${row.bracketId} (${row.side} ${row.instrument}) but NT8 still holds a ${row.side} position — Pine's exit prices were not a real fill`;
            database.createBridgeLog(account.userId, 'crosstrade', {
              event: 'crossTradePhantomClose', accountId: account.id, bracketId: row.bracketId, reason,
            });
            emitToUser(account.userId, 'toast:warning', { persistent: true, message: `CrossTrade sweep: ${reason}` });
          }
          continue;
        }
        const instrumentOrders = orders.filter(
          (o) => continuousTickerRoot(String(o.instrument ?? '')) === root,
        );
        const entryAction = row.side === 'long' ? 'buy' : 'sell';
        const exitAction = row.side === 'long' ? 'sell' : 'buy';
        const entryRow = findCtEntryRow(instrumentOrders, row.bracketId, entryAction);
        const entryPx = typeof entryRow?.averageFillPrice === 'number' ? entryRow.averageFillPrice : undefined;
        if (entryPx == null) continue;
        // ownerStrategy scopes to the RANGE, not the bracket — two entries on
        // the same range+instrument share it. Attribution is only ambiguous
        // when a second same-strategy entry filled BEFORE the exit we're
        // attributing; an entry that came later (e.g. a reversal after our
        // close) doesn't muddy this trade's exit.
        const sameStrategyEntries = instrumentOrders.filter((o) =>
          mapNt8OrderState(String(o.orderState ?? '')) === 'filled'
          && String(o.orderAction ?? '').toLowerCase() === entryAction
          && !matchesCtOrderId(o, row.bracketId, entryAction)
          && (o.ownerStrategy?.name === row.rangeName || o.ownerStrategy?.displayName === row.rangeName),
        );
        // The leg must postdate the ENTRY fill — not the monitor's last
        // event (on a closed row that's the close itself, always later).
        const exitFill = instrumentOrders.find((o) =>
          mapNt8OrderState(String(o.orderState ?? '')) === 'filled'
          && String(o.orderAction ?? '').toLowerCase() === exitAction
          && !matchesCtOrderId(o, row.bracketId, exitAction)
          && (o.ownerStrategy?.name === row.rangeName || o.ownerStrategy?.displayName === row.rangeName)
          && typeof o.averageFillPrice === 'number'
          && Date.parse(String(o.time ?? '')) > Date.parse(String(entryRow?.time ?? '')),
        );
        if (!exitFill) continue;
        if (sameStrategyEntries.some((o) =>
          Date.parse(String(o.time ?? '')) < Date.parse(String(exitFill.time ?? '')),
        )) continue;
        const dir = row.side === 'long' ? 1 : -1;
        const ticks = Math.round(((exitFill.averageFillPrice! - entryPx) * dir) / inferredTickSize(closedBookInstrument));
        const dollars = ticks * inferredTickDollars(closedBookInstrument) * (typeof entryRow?.quantity === 'number' && entryRow.quantity > 0 ? entryRow.quantity : (row.quantity ?? 1));
        const outcome = ticks > 0 ? 'win' : ticks < 0 ? 'loss' : 'breakeven';
        const accountClose = database.findTradeClosedForTrade(row.accountId, row.rangeName, row.tradeId);
        const rangeClose = database.findRangeTradeClosedForTrade(row.rangeName, row.tradeId);
        if (accountClose && !accountClose.eventId.startsWith('ct-flat-')) {
          database.updateTradeEventRealization(accountClose.id, {
            exitPrice: exitFill.averageFillPrice!,
            realizedTicksCents: Math.round(ticks * 100),
            realizedDollarsCents: Math.round(dollars * 100),
            outcome,
          });
          // A real exit leg landed for a close previously flagged phantom —
          // broker numbers now back the row, so the exclusion comes off.
          // Provenance is required: only exclusions this pass flagged carry the
          // marker — an operator/cleanup 'erroneous' exclusion stays put.
          if (accountClose.exclusionReason === 'erroneous'
              && accountClose.exclusionMarker === CT_PHANTOM_EXCLUSION_MARKER) {
            database.setTradeEventPerformanceExclusion(account.userId, accountClose.id, undefined, account.userId, CT_PHANTOM_EXCLUSION_MARKER);
          }
        }
        if (rangeClose && !rangeClose.eventId.startsWith('ct-flat-')) {
          database.updateRangeTradeEventRealization(rangeClose.id, {
            exitPrice: exitFill.averageFillPrice!,
            realizedTicksCents: Math.round(ticks * 100),
            realizedDollarsCents: Math.round(dollars * 100),
            outcome,
          });
        }
        if ((accountClose && !accountClose.eventId.startsWith('ct-flat-')) || (rangeClose && !rangeClose.eventId.startsWith('ct-flat-'))) {
          // The realization was just rewritten from broker values — bring the
          // entry_filled row's price to the same broker fill so the event set
          // stays internally consistent.
          database.applyBrokerFillPriceToEntry(account.userId, row.accountId, row.rangeName, row.bracketId, row.tradeId, row.side, entryPx, entryRow?.filled ?? entryRow?.quantity);
          console.info(JSON.stringify({ level: 'info', event: 'crossTradeBrokerRealizationUpgrade', accountId: account.id, bracketId: row.bracketId, ticks, dollars }));
          database.createBridgeLog(account.userId, 'crosstrade', {
            event: 'crossTradeBrokerRealizationUpgrade', accountId: account.id, accountName: account.name,
            bracketId: row.bracketId, ticks, dollars, exitPrice: exitFill.averageFillPrice,
          });
        }
      }

    });
  };

  // Per-account read-failure backoff. A failed book read keeps every order on
  // the account unresolved (unknown, never evidence) — and a flailing NT8 or
  // rate-limited key shouldn't be hammered every tick, so failures back off
  // exponentially up to 5 minutes. Manual sweeps force past the cooldown.
  const ctSweepAccountFailures = new Map<string, number>();
  const ctSweepAccountCooldown = new Map<string, number>();
  const noteCtSweepReadFailure = (account: BridgeAccount, read: CrossTradeApiResult): void => {
    const failures = (ctSweepAccountFailures.get(account.id) ?? 0) + 1;
    ctSweepAccountFailures.set(account.id, failures);
    const backoffMs = Math.min(CT_SWEEP_INTERVAL_MS * 2 ** (failures - 1), 5 * 60_000);
    ctSweepAccountCooldown.set(account.id, Date.now() + backoffMs);
    console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeSweepReadFailed', accountId: account.id, statusCode: read.statusCode, error: read.error, failures, retryInMs: backoffMs }));
    // Toast on the first failure only — repeated failures while backed off
    // stay in the log so the warnings don't pile up.
    if (failures === 1) {
      emitToUser(account.userId, 'toast:warning', {
        message: `CrossTrade sweep could not read the NT8 order book for ${account.name}: ${read.error ?? read.statusCode ?? 'unknown error'} — backing off ${Math.round(backoffMs / 1000)}s`,
      });
    }
  };
  const clearCtSweepReadFailure = (accountId: string): void => {
    ctSweepAccountFailures.delete(accountId);
    ctSweepAccountCooldown.delete(accountId);
  };

  // Per-account leg reconciliation against one orders-book read. Two duties:
  // (1) every open CT entry row mirrors its NT8 leg — at any age, and (2)
  // live NT8 legs carrying a wire id we minted get their tracking restored.
  // `alreadyResolved` skips rows the probe pass just handled.
  const syncCtAccountLegs = async (
    account: BridgeAccount,
    ctDestination: CrossTradeDestination,
    nt8Rows: CrossTradeOrderRow[],
    alreadyResolved: Set<string>,
  ): Promise<void> => {
    // Whole-book leg sync: while we hold the account's orders read, every
    // open CT entry row mirrors its NT8 leg — at any age. An 'acknowledged'
    // order asynchronously rejected past the verify window, or a 'pending'
    // row that already landed, converges here instead of waiting for probe
    // eligibility. Rows absent from the book are skipped while young (the
    // grace-gated probe owns not-found semantics); past the removal window
    // they take the full resolver — the single-order lookup confirms the
    // absence once before the row is removed as dead.
    for (const open of database.listOpenBrokerOrdersByAccount(account.id)) {
      if (alreadyResolved.has(open.id) || open.destination !== 'crosstrade'
          || (open.action !== 'buy' && open.action !== 'sell')
          || !open.bracketId || !open.orderId) continue;
      const absentRemoveExpired = Date.now() - Date.parse(open.occurredAt || open.createdAt) > CT_ABSENT_REMOVE_MS;
      const matched = nt8Rows.find((r) => matchesCtOrderId(r, ctWireOrderId(open.orderId!), open.action));
      if (!absentRemoveExpired && !matched) continue;
      // Steady state: a Working NT8 leg under an already ct-verified
      // acknowledged row is a no-op — resolving it would rewrite the same
      // status and emit another log/SSE refresh every sweep. The arm heal
      // still runs cheaply: a cancelled monitor under a covered live order
      // diverges Open Orders otherwise.
      if (open.status === 'acknowledged' && open.statusSource === 'ct-verified'
          && matched && mapNt8OrderState(String(matched.orderState ?? '')) === 'working') {
        const side = open.side ?? (open.action === 'sell' ? 'short' : 'long');
        const monitor = database.findBracketMonitorEntry(account.id, open.rangeName, open.bracketId, side);
        if (monitor?.state === 'cancelled') {
          await reapply.queue.run(account.id, async () => {
            const fresh = database.findBracketMonitorEntry(account.id, open.rangeName, open.bracketId!, side);
            if (fresh?.state !== 'cancelled') return;
            const covered = database.listOpenBrokerOrdersByAccount(account.id)
              .some((o) => o.bracketId === open.bracketId && o.action === open.action);
            if (!covered) return;
            database.reactivateBracketMonitorArm(account.userId, fresh);
            console.info(JSON.stringify({ level: 'info', event: 'crossTradeArmRevived', accountId: account.id, bracketId: open.bracketId }));
          });
        }
        continue;
      }
      try {
        const result = await resolveCrossTradeBrokerOrder(account, ctDestination, open, nt8Rows);
        console.info(JSON.stringify({ level: 'info', event: 'crossTradeSweepLegSync', accountId: account.id, orderId: open.orderId, outcome: result.outcome, nt8State: result.nt8State, error: result.error }));
        emitCtResolutionToast(account, open, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeSweepError', accountId: account.id, orderId: open.orderId, error: message }));
      }
    }

    // Adoption: a live NT8 leg whose wire id matches a bracket the monitor
    // or ledger knows was sent by us — bookkeeping was lost (ledger cleared,
    // DB restored, resend leg outliving coverage) while the order still
    // works at the broker. Recreate the ledger row AND revive a cancelled
    // monitor arm so Open Orders reflects the live order; untagged/manual
    // rows carry no recognizable id and are ignored.
    const knownBrackets = new Map<string, { rangeName: string; side: string }>();
    for (const m of database.listBracketMonitorEntriesForAdoption(account.id)) knownBrackets.set(m.bracketId, { rangeName: m.rangeName, side: m.side });
    for (const o of database.listEntryBrokerOrdersByAccount(account.id)) {
      if (o.bracketId && !knownBrackets.has(o.bracketId)) knownBrackets.set(o.bracketId, { rangeName: o.rangeName, side: o.side ?? (o.action === 'sell' ? 'short' : 'long') });
    }
    const openLedger = database.listOpenBrokerOrdersByAccount(account.id);
    for (const nt8 of nt8Rows) {
      const raw = String(nt8.orderState ?? '');
      if (mapNt8OrderState(raw) !== 'working' && !/part/i.test(raw)) continue;
      const action = String(nt8.orderAction ?? '').toLowerCase();
      if (action !== 'buy' && action !== 'sell') continue;
      const match = [...knownBrackets].find(([bracketId, k]) =>
        action === (k.side === 'long' ? 'buy' : 'sell')
        && matchesCtOrderId(nt8, ctWireOrderId(bracketId), action));
      if (!match) continue;
      const [bracketId, known] = match;
      const rangeName = known.rangeName;
      if (openLedger.some((o) => o.bracketId === bracketId && o.action === action)) continue;
      await reapply.queue.run(account.id, async () => {
        // Re-check inside the serialized section — a dispatch or probe
        // resolution queued behind this pass may have covered the leg.
        const covered = database.listOpenBrokerOrdersByAccount(account.id)
          .some((o) => o.bracketId === bracketId && o.action === action);
        if (covered) return;
        // The wire id NT8 echoes is the exact attempt — re-armed resends go
        // out as '<bracket>-a<n>' and ledger retries add '-r<n>'. Revive THAT
        // row, not the base bracketId row; only mint a new row when no
        // attempt history exists at all.
        const echoedId = ctUserDataOrderId(nt8.userData)
          ?? (typeof nt8.orderId === 'string' ? nt8.orderId : undefined)
          ?? (typeof nt8.name === 'string' ? nt8.name : undefined)
          ?? bracketId;
        // A PartFilled leg is a position, not a working order — adopt through
        // the fill path (filled ledger row + synthesized entry_filled) so
        // Open Orders shows the partial exposure instead of a phantom arm.
        const partFilled = /part/i.test(raw) && (nt8.filled ?? 0) > 0;
        const targetStatus = partFilled ? 'filled' as const : 'acknowledged' as const;
        const adoptNote = partFilled ? 're-adopted: NT8 leg partially filled' : 're-adopted: NT8 leg live in book';
        const existing = database.listEntryBrokerOrdersByAccount(account.id)
          .filter((o) => o.orderId && ctWireOrderId(o.orderId) === echoedId)
          .at(0);
        if (existing) {
          database.updateBrokerOrderStatus(account.id, existing.orderId!, targetStatus, adoptNote, undefined, 'bridge');
        }
        const adopted = existing ? undefined : database.createBrokerOrder({
          accountId: account.id,
          rangeName,
          bracketId,
          orderId: echoedId,
          action,
          status: targetStatus,
          instrument: String(nt8.instrument ?? ''),
          side: action === 'buy' ? 'long' : 'short',
          quantity: typeof nt8.quantity === 'number' ? nt8.quantity : undefined,
          price: typeof nt8.limitPrice === 'number' ? nt8.limitPrice : undefined,
          stopPrice: typeof nt8.stopPrice === 'number' ? nt8.stopPrice : undefined,
          destination: 'crosstrade',
          occurredAt: new Date().toISOString(),
        });
        const adoptedRow = existing
          ? database.findBrokerOrder(account.id, existing.orderId!)
          : adopted;
        if (partFilled && adoptedRow) {
          // Journal the broker-observed partial fill; the monitor's
          // cancelled→entry_filled transition is the sanctioned path, so a
          // cancelled arm lands 'filled' rather than a wrong 'armed'.
          syncCtFillToJournal(account, adoptedRow, nt8);
        } else {
          // The broker order is provably Working — a locally 'cancelled' arm
          // was bookkeeping, not reality. Re-arm the monitor so Open Orders
          // shows the live order again. 'closed' monitors are left alone: a
          // working entry leg after a completed trade is an orphan, not the
          // trade reopening.
          const monitor = database.findBracketMonitorEntry(account.id, rangeName, bracketId, known.side as 'long' | 'short');
          if (monitor && monitor.state === 'cancelled') {
            database.reactivateBracketMonitorArm(account.userId, monitor);
          }
        }
        const monitor = database.findBracketMonitorEntry(account.id, rangeName, bracketId, known.side as 'long' | 'short');
        console.info(JSON.stringify({ level: 'info', event: 'crossTradeAdoptedOrder', accountId: account.id, orderId: bracketId, bracketId, action, nt8State: raw, revived: Boolean(existing) }));
        // One audit record: log:bridge events are persisted by emitToUser —
        // a separate createBridgeLog would double-write the same adoption.
        emitToUser(account.userId, 'log:bridge', {
          category: 'crosstrade',
          event: 'crossTradeAdoptedOrder',
          accountId: account.id, accountName: account.name,
          bracketId, action, nt8State: raw, nt8OrderId: nt8.orderId ?? nt8.id,
          monitorRevived: monitor ? monitor.state !== 'cancelled' : false,
          message: `NT8 leg ${nt8.orderId ?? nt8.id} (${action} ${nt8.instrument}) matched bracket ${bracketId} but had no open tracking — adopted as ${targetStatus}`,
          orderId: bracketId,
        });
      });
    }

    // Reverse direction — an 'armed' monitor whose entry legs are ALL
    // terminal in the ledger is a dead arm left behind (e.g. a cancel
    // resolution that raced the retire path, or a leg pruned before the
    // retire ran). Live NT8 legs are handled by adoption above, so by the
    // time this runs coverage is current. Skip brackets that never
    // dispatched (no ledger rows at all — Pine-armed intent, not sweep
    // evidence) and brackets with any still-open attempt.
    for (const m of database.listActiveBracketMonitorEntries(account.id)) {
      if (m.state !== 'armed') continue;
      const entryAction = m.side === 'long' ? 'buy' : 'sell';
      const entryRows = database.listEntryBrokerOrdersByAccount(account.id)
        .filter((o) => o.bracketId === m.bracketId && o.action === entryAction);
      if (entryRows.length === 0) continue;
      // A live NT8 leg for this arm (even one adoption failed to correlate
      // to a ledger row) means the order is alive — never retire on that.
      const liveLeg = nt8Rows.some((r) => {
        const raw = String(r.orderState ?? '');
        return (mapNt8OrderState(raw) === 'working' || /part/i.test(raw))
          && matchesCtOrderId(r, ctWireOrderId(m.bracketId), entryAction);
      });
      if (liveLeg) continue;
      if (entryRows.some((o) => o.status === 'pending' || o.status === 'acknowledged' || o.status === 'uncertain')) continue;
      if (!entryRows.some((o) => o.status === 'cancelled' || o.status === 'rejected')) continue;
      await reapply.queue.run(account.id, async () => {
        // Re-check inside the serialized section — a probe resolution or
        // dispatch queued behind this pass may have covered the arm.
        const fresh = database.findBracketMonitorEntry(account.id, m.rangeName, m.bracketId, m.side);
        if (!fresh || fresh.state !== 'armed') return;
        const covered = database.listOpenBrokerOrdersByAccount(account.id)
          .some((o) => o.bracketId === m.bracketId && o.action === entryAction);
        if (covered) return;
        database.retireBracketMonitorEntry(account.userId, fresh, 'entry_cancelled', `ct-sweep-orphan-${m.bracketId}`, new Date().toISOString());
        emitToUser(account.userId, 'log:bridge', {
          category: 'crosstrade',
          event: 'crossTradeOrphanedArmRetired',
          accountId: account.id, accountName: account.name,
          bracketId: m.bracketId, side: m.side,
          message: `armed monitor ${m.bracketId} had only terminal ledger rows and no live NT8 leg — retired`,
        });
        console.info(JSON.stringify({ level: 'info', event: 'crossTradeOrphanedArmRetired', accountId: account.id, bracketId: m.bracketId }));
      });
    }
  };

  // Auto-retry for hard-rejected entry dispatches while the arm is still live.
  // The sweep re-sends the ORIGINAL payload (same stop level — the whole point
  // of stop-only mode is never chasing a crossed level) on a fresh wire id
  // (<bracket>-a<n>, the same resend convention NT8 expects for burned order
  // ids). Bounded: a hard failure older than the window, or max attempts hit,
  // aborts the arm (entry_cancelled) instead of re-sending forever.
  const CT_ENTRY_RETRY_WINDOW_MS = 10 * 60_000;
  const CT_ENTRY_RETRY_MAX_ATTEMPTS = 3;
  const ctRetryHandled = new Set<string>();
  const retryRejectedCtEntries = async (account: BridgeAccount, ctDestination: CrossTradeDestination, destination: TradersPostAccountDestination): Promise<void> => {
    const armed = database.listBracketMonitorEntriesForAdoption(account.id)
      .filter((m) => m.state === 'armed');
    for (const row of armed) {
      // Bracket ids are reused across re-arm cycles and fan out to every CT
      // account — key handled state on the arm's current-cycle attempt, not
      // the bracket alone, or one account's outcome would suppress the rest.
      const allAttempts = database.listEntryBrokerOrdersByAccount(account.id)
        .filter((o) => o.destination === 'crosstrade' && o.bracketId === row.bracketId
          && (o.action === 'buy' || o.action === 'sell'));
      // Current cycle = attempts dispatched after this arm's event timestamp.
      // Lifetime history only mints unique wire ids; bounds/status use the
      // cycle, so a fresh arm isn't instantly aborted by a stale rejection.
      // 60s tolerance: the entry dispatch can ledger an occurred_at a beat
      // before the arm event timestamps the monitor row — same cycle either
      // way, while a re-arm is minutes apart.
      const cycleStartMs = Date.parse(row.lastOccurredAt) - 60_000;
      const cycleAttempts = allAttempts
        .filter((o) => Date.parse(String(o.occurredAt ?? o.createdAt)) >= cycleStartMs);
      const latest = cycleAttempts[0];
      const handledKey = `${account.id}|${row.bracketId}|${latest?.id ?? row.lastEventId}`;
      if (ctRetryHandled.has(handledKey)) continue;
      if (!latest || latest.status !== 'rejected') continue;
      // Deterministic bridge-side blocks (stop-only) are policy, not failure —
      // they never retry; the level is crossed by definition.
      if (String(latest.errorText ?? '').startsWith('stop-only range')) {
        ctRetryHandled.add(handledKey);
        continue;
      }
      const first = cycleAttempts.at(-1)!;
      const ageMs = Date.now() - Date.parse(String(first.occurredAt ?? first.createdAt));
      if (ageMs > CT_ENTRY_RETRY_WINDOW_MS || cycleAttempts.length >= CT_ENTRY_RETRY_MAX_ATTEMPTS) {
        ctRetryHandled.add(handledKey);
        const reason = ageMs > CT_ENTRY_RETRY_WINDOW_MS
          ? `entry dispatch rejected and ${Math.round(ageMs / 60000)}min elapsed — retry window (10min) expired`
          : `entry dispatch rejected ${cycleAttempts.length}x — max retries reached`;
        database.retireBracketMonitorEntry(account.userId, row, 'entry_cancelled', `ct-retry-abort-${row.bracketId}-${latest.id}`, new Date().toISOString());
        database.createBridgeLog(account.userId, 'crosstrade', {
          event: 'crossTradeRetryAborted', accountId: account.id, bracketId: row.bracketId, reason,
        });
        emitToUser(account.userId, 'toast:warning', {
          persistent: true,
          message: `CrossTrade entry ${row.bracketId} aborted — ${reason}`,
        });
        continue;
      }
      const delivery = latest.proxyDeliveryId ? database.findProxyDelivery(latest.proxyDeliveryId) : undefined;
      // Rebuild from the IMMUTABLE dispatch snapshot: the prepared outbound
      // payload ledgered on the original send (post destination-transforms).
      // Re-preparing from the alert would drift if ticker/quantity/protection
      // config changed since the rejection.
      const parsedPayload = latest.payloadJson ? parseStoredProxyPayload(latest.payloadJson) : undefined;
      const parsed = parsedPayload && !isLifecyclePayload(parsedPayload) ? parsedPayload : undefined;
      if (!delivery || !parsed || typeof parsed.bracketId !== 'string' || typeof parsed.ticker !== 'string') {
        ctRetryHandled.add(handledKey);
        database.createBridgeLog(account.userId, 'crosstrade', {
          event: 'crossTradeRetrySkipped', accountId: account.id, bracketId: row.bracketId,
          reason: 'entry rejected but no stored dispatch payload to resend',
        });
        continue;
      }
      // Original price stays on the wire — retries never re-read the level.
      const wireId = `${row.bracketId}-a${allAttempts.length}`;
      const retryPayload = { ...parsed, bracketId: wireId } as TradersPostPayload;
      // Snapshot is already policy-applied — send it as stored, no re-derive.
      const message = toCrossTradeMessage(retryPayload, ctDestination, 'sweep-retry');
      const orderId = `${wireId}-r${allAttempts.length}`;
      const sentAt = new Date().toISOString();
      database.upsertBrokerOrder({
        accountId: account.id,
        rangeName: row.rangeName,
        bracketId: row.bracketId,
        orderId,
        action: parsed.action === 'sell' ? 'sell' : 'buy',
        status: 'pending',
        instrument: String(parsed.ticker),
        side: row.side,
        quantity: typeof parsed.quantity === 'number' ? parsed.quantity : undefined,
        price: typeof parsed.price === 'number' ? parsed.price : undefined,
        stopPrice: typeof parsed.stopPrice === 'number' ? parsed.stopPrice : undefined,
        limitPrice: typeof parsed.limitPrice === 'number' ? parsed.limitPrice : undefined,
        proxyAlertId: delivery.proxyAlertId,
        proxyDeliveryId: delivery.id,
        destination: 'crosstrade',
        payloadJson: latest.payloadJson,
        occurredAt: sentAt,
      });
      // Serialize with the account's dispatch queue + send interval — the same
      // composition the normal path uses — so a sweep retry can't interleave
      // with an in-flight cancel/flatten/entry on the same account.
      await reapply.queue.run(account.id, (taskSignal) => traderspostRateLimiter.run(account.id, async (limiterSignal) => {
        const released = () => limiterSignal.aborted || taskSignal.aborted;
        try {
          if (released()) {
            database.updateBrokerOrderStatus(account.id, orderId, 'uncertain', 'account queue released before retry send', delivery.id);
            return;
          }
          // Queued preflight: the route or destination may have been disabled
          // while this task waited — re-check before touching the wire.
          const route = database.findCurrentRangeRoute(delivery.rangeRouteId, account.id, row.rangeName);
          const liveDest = database.getTradersPostAccountDestination(account.id);
          if (!route?.traderspostEnabled || !isCrossTradeConfigured(liveDest)) {
            ctRetryHandled.add(handledKey);
            const reason = 'range route or CrossTrade destination disabled during retry wait';
            database.updateBrokerOrderStatus(account.id, orderId, 'rejected', reason, delivery.id, 'bridge');
            database.retireBracketMonitorEntry(account.userId, row, 'entry_cancelled', `ct-retry-disabled-${row.bracketId}-${latest.id}`, new Date().toISOString());
            database.createBridgeLog(account.userId, 'crosstrade', {
              event: 'crossTradeRetryAborted', accountId: account.id, bracketId: row.bracketId, reason,
            });
            return;
          }
          // OCO re-pair: this retry mints a fresh oco group (…-aN) while the
          // still-working sibling arm sits in the original group — a lone
          // retry would fill without cancelling the other side. Cancel the
          // instrument's working legs first (the only wire primitive), then
          // resend the sibling under the SAME -aN group after this arm lands.
          // Skipped when another bracket shares the instrument — an
          // instrument-wide cancel would kill unrelated legs; then we warn.
          const siblingBracketId = row.bracketId?.replace(/-(long|short)(?=-|$)(?![\s\S]*-(?:long|short)(?=-|$))/, (_, s) => `-${s === 'long' ? 'short' : 'long'}`);
          let siblingToRePair: { orderId: string; payloadJson: string; proxyDeliveryId?: string; proxyAlertId?: string } | undefined;
          let ocoUnpairedWarn = false;
          if (siblingBracketId && siblingBracketId !== row.bracketId) {
            const sibling = database.listBracketMonitorEntriesForAdoption(account.id)
              .find((m) => m.bracketId === siblingBracketId && m.state === 'armed');
            const siblingEntry = sibling
              ? database.listEntryBrokerOrdersByAccount(account.id)
                .filter((o) => o.destination === 'crosstrade' && o.bracketId === siblingBracketId
                  && (o.action === 'buy' || o.action === 'sell'))
                .find((o) => o.status === 'acknowledged' || o.status === 'pending' || o.status === 'uncertain')
              : undefined;
            if (sibling && siblingEntry?.payloadJson) {
              const bookRoot = continuousTickerRoot(latest.instrument ?? String(parsed.ticker));
              const monitorBookInstrument = (m: { bracketId?: string; instrument: string }): string =>
                database.listEntryBrokerOrdersByAccount(account.id)
                  .filter((o) => o.bracketId === m.bracketId && o.destination === 'crosstrade')
                  .at(-1)?.instrument ?? m.instrument;
              const sharers = database.listBracketMonitorEntriesForAdoption(account.id)
                .filter((m) => (m.state === 'armed' || m.state === 'filled')
                  && m.bracketId !== row.bracketId && m.bracketId !== siblingBracketId
                  && continuousTickerRoot(monitorBookInstrument(m) ?? '') === bookRoot);
              if (sharers.length > 0) {
                ocoUnpairedWarn = true;
              } else {
                // Instrument-scoped cancel is safe: only the sibling's working
                // leg on this instrument is ours.
                const cancelMsg = toCrossTradeMessage(
                  { ...parsed, action: 'cancel', bracketId: siblingBracketId } as TradersPostPayload,
                  ctDestination, 'sweep-repair');
                try {
                  const cancelRes = await fetchImplementation(ctDestination.webhookUrl, {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(cancelMsg),
                    signal: AbortSignal.any([limiterSignal, taskSignal]),
                  });
                  const cancelBody = await cancelRes.text();
                  const cancelOk = cancelRes.ok && interpretCrossTradeResponse(cancelRes.status, cancelBody)?.success === true;
                  if (cancelOk) {
                    // Cancel belongs to the SIBLING's delivery — the failed
                    // arm's delivery id here would corrupt audit linkage.
                    database.updateBrokerOrderStatus(account.id, siblingEntry.orderId, 'cancelled', 'OCO re-pair: resending under fresh group', siblingEntry.proxyDeliveryId, 'bridge');
                    siblingToRePair = {
                      orderId: siblingEntry.orderId, payloadJson: siblingEntry.payloadJson,
                      proxyDeliveryId: siblingEntry.proxyDeliveryId, proxyAlertId: siblingEntry.proxyAlertId,
                    };
                  } else {
                    ocoUnpairedWarn = true;
                  }
                } catch {
                  ocoUnpairedWarn = true;
                }
              }
            }
          }
          if (ocoUnpairedWarn) {
            database.createBridgeLog(account.userId, 'crosstrade', {
              event: 'crossTradeOcoUnpaired', accountId: account.id, bracketId: row.bracketId,
              reason: 'retry re-sends this arm under a fresh OCO group; the sibling arm could not be re-paired safely',
            });
            emitToUser(account.userId, 'toast:warning', {
              persistent: true,
              message: `CrossTrade retry for ${row.bracketId} will not be OCO-paired with its sibling — check the other arm manually`,
            });
          }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15_000);
          // Mirror the dispatch path's hard ceiling: abort() doesn't always
          // settle a stuck undici fetch, and a watchdog-released task must not
          // write the ledger after the queue moved on.
          let hardTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const hardTimeout = new Promise<never>((_, reject) => {
            hardTimeoutHandle = setTimeout(() => {
              controller.abort();
              reject(Object.assign(new Error('request never settled'), { name: 'AbortError' }));
            }, 20_000);
          });
          let response: Awaited<ReturnType<typeof fetchImplementation>> | undefined;
          let body = '';
          let fetchError: unknown;
          try {
            const raced = await Promise.race([
              (async () => {
                const res = await fetchImplementation(ctDestination.webhookUrl, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(message),
                  signal: AbortSignal.any([controller.signal, limiterSignal, taskSignal]),
                });
                return { res, body: await res.text() };
              })(),
              hardTimeout,
            ]);
            response = raced.res;
            body = raced.body;
          } catch (error) {
            fetchError = error;
          } finally {
            clearTimeout(timeout);
            if (hardTimeoutHandle) clearTimeout(hardTimeoutHandle);
          }
          if (released()) {
            // The watchdog released while in flight — no outer owner resolves
            // this row, and the send may have reached the broker: uncertain.
            database.updateBrokerOrderStatus(account.id, orderId, 'uncertain', 'queue released while send in flight', delivery.id);
            return;
          }
          if (fetchError || !response) {
            const errText = fetchError instanceof Error && fetchError.name === 'AbortError'
              ? 'CrossTrade request timed out'
              : fetchError instanceof Error ? fetchError.message : String(fetchError ?? 'request failed');
            database.updateBrokerOrderStatus(account.id, orderId, 'uncertain', errText, delivery.id);
            database.createProxyDeliveryAttempt({ proxyDeliveryId: delivery.id, success: false, errorText: errText });
            database.createBridgeLog(account.userId, 'crosstrade', {
              event: 'crossTradeEntryAutoRetry', accountId: account.id, bracketId: row.bracketId,
              orderId, wireId, success: false, failureMessage: errText,
            });
            return;
          }
          const interpreted = interpretCrossTradeResponse(response.status, body);
          const ok = response.ok && interpreted?.success === true;
          // Same definite-rejection rule as the normal dispatch path: only an
          // explicit refusal (<500, not 408, success:false/4xx/message) proves
          // the order never landed — anything else stays uncertain so the
          // sweep can't double-send a live order.
          const definiteReject = !ok && response.status < 500 && response.status !== 408
            && (interpreted?.success === false || response.status >= 400 || interpreted?.failureMessage != null);
          const status = ok ? 'acknowledged' : definiteReject ? 'rejected' : 'uncertain';
          const errorText = ok ? undefined : (interpreted?.failureMessage ?? (body.slice(0, 500) || `HTTP ${response.status}`));
          database.updateBrokerOrderStatus(account.id, orderId, status, errorText, delivery.id);
          // The delivery's audit trail must see the retry too — otherwise Open
          // Orders still shows it failed and an operator resend can duplicate
          // the now-working order.
          database.createProxyDeliveryAttempt({
            proxyDeliveryId: delivery.id, statusCode: response.status, success: ok,
            ...(errorText ? { errorText } : {}),
          });
          database.updateProxyDeliveryStatus(delivery.id, tradersPostStatus(delivery, ok));
          database.createBridgeLog(account.userId, 'crosstrade', {
            event: 'crossTradeEntryAutoRetry', accountId: account.id, bracketId: row.bracketId,
            orderId, wireId, success: ok, uncertain: !ok && !definiteReject, failureMessage: interpreted?.failureMessage,
          });
          emitToUser(account.userId, ok ? 'toast:info' : 'toast:warning', {
            persistent: !ok,
            message: ok
              ? `CrossTrade retry landed for ${row.bracketId} (attempt ${cycleAttempts.length + 1})`
              : definiteReject
                ? `CrossTrade retry failed for ${row.bracketId}: ${interpreted?.failureMessage ?? `HTTP ${response.status}`}`
                : `CrossTrade retry outcome unknown for ${row.bracketId} — may have reached the broker`,
          });
          // Re-pair: the sibling leg was cancelled above — resend it under the
          // same -aN suffix so both arms share the fresh OCO group again.
          if (ok && siblingToRePair && siblingBracketId) {
            const sibParsed = (() => { const p = parseStoredProxyPayload(siblingToRePair!.payloadJson); return p && !isLifecyclePayload(p) ? p : undefined; })();
            if (sibParsed && typeof sibParsed.bracketId === 'string') {
              const sibWireId = `${siblingBracketId}-a${allAttempts.length}`;
              const sibPayload = { ...sibParsed, bracketId: sibWireId } as TradersPostPayload;
              const sibMsg = toCrossTradeMessage(sibPayload, ctDestination, 'sweep-repair');
              const sibOrderId = `${sibWireId}-r${allAttempts.length}`;
              database.upsertBrokerOrder({
                accountId: account.id,
                rangeName: row.rangeName,
                bracketId: siblingBracketId,
                orderId: sibOrderId,
                action: sibParsed.action === 'sell' ? 'sell' : 'buy',
                status: 'pending',
                instrument: String(sibParsed.ticker),
                side: siblingBracketId.includes('-short') ? 'short' : 'long',
                quantity: typeof sibParsed.quantity === 'number' ? sibParsed.quantity : undefined,
                price: typeof sibParsed.price === 'number' ? sibParsed.price : undefined,
                stopPrice: typeof sibParsed.stopPrice === 'number' ? sibParsed.stopPrice : undefined,
                limitPrice: typeof sibParsed.limitPrice === 'number' ? sibParsed.limitPrice : undefined,
                proxyAlertId: siblingToRePair.proxyAlertId,
                proxyDeliveryId: siblingToRePair.proxyDeliveryId,
                destination: 'crosstrade',
                payloadJson: siblingToRePair.payloadJson,
                occurredAt: new Date().toISOString(),
              });
              try {
                const sibRes = await fetchImplementation(ctDestination.webhookUrl, {
                  method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(sibMsg),
                  signal: AbortSignal.any([limiterSignal, taskSignal]),
                });
                const sibBody = await sibRes.text();
                if (released()) {
                  // Released mid-POST — the send may have landed; the row we
                  // created can't stay pending forever.
                  database.updateBrokerOrderStatus(account.id, sibOrderId, 'uncertain', 'queue released while send in flight', siblingToRePair.proxyDeliveryId);
                  return;
                }
                const sibOk = sibRes.ok && interpretCrossTradeResponse(sibRes.status, sibBody)?.success === true;
                database.updateBrokerOrderStatus(account.id, sibOrderId, sibOk ? 'acknowledged' : 'uncertain',
                  sibOk ? undefined : sibBody.slice(0, 500), siblingToRePair.proxyDeliveryId);
                database.createBridgeLog(account.userId, 'crosstrade', {
                  event: 'crossTradeOcoRepaired', accountId: account.id, bracketId: siblingBracketId,
                  orderId: sibOrderId, wireId: sibWireId, success: sibOk,
                });
              } catch (error) {
                if (released()) {
                  // Fetch aborted by watchdog — the send may have landed.
                  database.updateBrokerOrderStatus(account.id, sibOrderId, 'uncertain', 'queue released while send in flight', siblingToRePair.proxyDeliveryId);
                  return;
                }
                const sibErr = error instanceof Error ? error.message : String(error);
                database.updateBrokerOrderStatus(account.id, sibOrderId, 'uncertain', sibErr, siblingToRePair.proxyDeliveryId);
                database.createBridgeLog(account.userId, 'crosstrade', {
                  event: 'crossTradeOcoRepaired', accountId: account.id, bracketId: siblingBracketId,
                  orderId: sibOrderId, wireId: sibWireId, success: false, failureMessage: sibErr,
                });
                emitToUser(account.userId, 'toast:warning', {
                  persistent: true,
                  message: `CrossTrade OCO re-pair sent but outcome unknown for ${siblingBracketId} — check both arms`,
                });
              }
            }
          }
        } catch (error) {
          if (released()) return;
          const errText = error instanceof Error ? error.message : String(error);
          database.updateBrokerOrderStatus(account.id, orderId, 'uncertain', errText, delivery.id);
          database.createProxyDeliveryAttempt({ proxyDeliveryId: delivery.id, success: false, errorText: errText });
          database.createBridgeLog(account.userId, 'crosstrade', {
            event: 'crossTradeEntryAutoRetry', accountId: account.id, bracketId: row.bracketId,
            orderId, wireId, success: false, failureMessage: errText,
          });
        }
      }));
    }
  };

  const sweepUncertainCrossTradeOrders = async (force = false): Promise<void> => {
    const now = Date.now();
    const cutoff = new Date(now - CT_PROBE_GRACE_MS).toISOString();
    // acknowledged rows only get probed inside the verify window — once NT8's
    // book confirms them ('ct-verified') or the window lapses they leave the
    // work list instead of being re-probed every tick forever.
    const ackHorizon = new Date(now - CT_VERIFY_WINDOW_MS).toISOString();
    const unresolved = database.listUnresolvedCrossTradeOrdersBefore(cutoff, ackHorizon);

    // One orders-list read answers every open order on the account — the old
    // per-order probe+fallback cost up to 2 reads per order per sweep.
    const ordersByAccount = new Map<string, BrokerOrder[]>();
    for (const order of unresolved) {
      const list = ordersByAccount.get(order.accountId) ?? [];
      list.push(order);
      ordersByAccount.set(order.accountId, list);
    }
    // Books already fetched this pass — reused for flat-close sync below so
    // each account costs at most one orders read per sweep.
    const booksByAccount = new Map<string, CrossTradeApiResult>();
    // Accounts whose open legs were already synced against their book read —
    // the sweepAccounts pass skips re-running the same work.
    const legSyncedAccounts = new Set<string>();
    for (const [accountId, orders] of ordersByAccount) {
      const account = database.findAccountById(accountId);
      const destination = account ? database.getTradersPostAccountDestination(account.id) : undefined;
      if (!account || !isCrossTradeConfigured(destination)) continue;
      if (!force && (ctSweepAccountCooldown.get(accountId) ?? 0) > now) continue;
      const ctDestination: CrossTradeDestination = {
        webhookUrl: destination!.crossTradeWebhookUrl!,
        secretKey: destination!.crossTradeSecretKey!,
        accountName: destination!.crossTradeAccountName || account.name,
      };
      const book = await fetchCrossTradeOrders(ctDestination);
      if (!book.ok) {
        noteCtSweepReadFailure(account, book);
        continue;
      }
      clearCtSweepReadFailure(accountId);
      booksByAccount.set(accountId, book);
      const nt8Rows = (book.data?.orders ?? []) as CrossTradeOrderRow[];
      const probed = new Set(orders.map((o) => o.id));
      for (const order of orders) {
        try {
          const result = await resolveCrossTradeBrokerOrder(account, ctDestination, order, nt8Rows);
          console.info(JSON.stringify({ level: 'info', event: 'crossTradeSweepProbe', accountId: account.id, orderId: order.orderId, outcome: result.outcome, nt8State: result.nt8State, error: result.error }));
          emitCtResolutionToast(account, order, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeSweepError', accountId: account.id, orderId: order.orderId, error: message }));
          emitToUser(account.userId, 'toast:warning', { message: `CrossTrade sweep failed to check ${order.orderId}: ${message}` });
        }
      }
      await retryRejectedCtEntries(account, ctDestination, destination!);
      await syncCtAccountLegs(account, ctDestination, nt8Rows, probed);
      legSyncedAccounts.add(accountId);
    }

    // Position sync: entries the broker confirms filled open positions that
    // Pine lifecycle events may never report (or report late). When the book
    // is flat on the instrument and no working legs remain for the bracket,
    // the position is gone — synthesize trade_closed so Open Orders and the
    // journal stop carrying a phantom. Runs once per CT account per sweep.
    const sweepAccounts = new Map<string, BridgeAccount>();
    for (const [accountId] of ordersByAccount) {
      const account = database.findAccountById(accountId);
      if (account) sweepAccounts.set(account.id, account);
    }
    const closedCandidateCutoff = new Date(now - CT_VERIFY_WINDOW_MS).toISOString();
    for (const accountId of [
      ...database.listAccountsWithFilledMonitorRows(),
      // Pine-closed rows still need the broker-realization upgrade pass —
      // without this the account drops out of the sweep set entirely.
      ...database.listAccountsWithRecentlyClosedMonitorRows(closedCandidateCutoff),
      // Adoption needs the widest net: any account that ever dispatched to CT
      // is the universe of recognizable wire ids — a live NT8 leg whose local
      // bookkeeping is gone (monitor cancelled, ledger resolved) shows up in
      // none of the activity-based lists above.
      ...database.listAccountsWithCrossTradeOrders(),
    ]) {
      const account = database.findAccountById(accountId);
      if (!account) continue;
      const dest = database.getTradersPostAccountDestination(account.id);
      if (isCrossTradeConfigured(dest)) sweepAccounts.set(account.id, account);
    }
    for (const account of sweepAccounts.values()) {
      const destination = database.getTradersPostAccountDestination(account.id);
      if (!isCrossTradeConfigured(destination)) continue;
      // An account whose book read just failed (or is backed off) skips the
      // sync too — hammering the positions endpoint after the orders read
      // failed is the other half of the same rate-limit problem.
      if (!force && (ctSweepAccountCooldown.get(account.id) ?? 0) > Date.now()) continue;
      const ctDestination: CrossTradeDestination = {
        webhookUrl: destination!.crossTradeWebhookUrl!,
        secretKey: destination!.crossTradeSecretKey!,
        accountName: destination!.crossTradeAccountName || account.name,
      };
      try {
        // Ensure an orders read for this account — probe accounts already
        // hold one; monitor-activity accounts need theirs fetched here.
        // Leg sync + adoption then run for every swept account, not just
        // the probe-eligible set.
        let book = booksByAccount.get(account.id);
        if (!book) {
          book = await fetchCrossTradeOrders(ctDestination);
          if (!book.ok) {
            noteCtSweepReadFailure(account, book);
            continue;
          }
          clearCtSweepReadFailure(account.id);
          booksByAccount.set(account.id, book);
        }
        // Entry retry runs before leg sync — a hard-rejected arm the retry can
        // resend looks exactly like an orphaned arm (dead leg, terminal ledger)
        // and would be retired before the retry ever ran. Accounts probed above
        // already ran retry+leg sync this sweep — skip them or a back-to-back
        // second retry could send in the same pass.
        if (!legSyncedAccounts.has(account.id)) {
          await retryRejectedCtEntries(account, ctDestination, destination!);
          await syncCtAccountLegs(account, ctDestination, (book.data?.orders ?? []) as CrossTradeOrderRow[], new Set());
          legSyncedAccounts.add(account.id);
        }
        await syncFilledBracketClosures(account, ctDestination, book);
      } catch (error) {
        console.warn(JSON.stringify({ level: 'warn', event: 'crossTradePositionSyncError', accountId: account.id, error: error instanceof Error ? error.message : String(error) }));
      }
    }
  };

  const processFailureEmail = (
    user: { id: string },
    account: BridgeAccount,
    inbound: InboundEmail,
    parsed: ParsedTradersPostEmail,
    attributedBy?: string,
  ): number => {
    const parsedRoot = continuousTickerRoot(parsed.ticker);
    // Ledger rows store normalized ids (CR/LF stripped, ' → r) — normalize the
    // echoed id the same way before comparing.
    const parsedBracketId = parsed.bracketId?.replace(/[\r\n]/g, '').replace(/'/g, 'r');
    const parsedAction = parsed.action?.toLowerCase();
    const instrumentMatchWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const candidates = database.listOpenBrokerOrdersByAccount(account.id).filter((order) => {
      // An echoed bracket id names one specific order — reject only that row,
      // never same-instrument neighbors. The bracket spans entry + TP legs
      // with opposite actions, so the echoed action still scopes the match.
      if (parsedBracketId) {
        return order.bracketId === parsedBracketId && (!parsedAction || order.action === parsedAction);
      }
      // Without a bracket id the email only identifies an instrument — limit
      // to recent rows so an old still-open order is not falsely resolved.
      if (!parsedRoot || order.createdAt < instrumentMatchWindowStart) return false;
      if (continuousTickerRoot(order.instrument) !== parsedRoot) return false;
      if (parsedAction && order.action !== parsedAction) return false;
      return true;
    });
    // An unbracketed email only proves "something on this instrument failed" —
    // with several open dispatches on the same root there is no safe way to
    // pick one, so resolve only a unique candidate and log the rest for review.
    const ambiguous = !parsedBracketId && candidates.length > 1;
    const resolved = ambiguous ? [] : candidates;

    const rejectedOrderIds = new Set(resolved.map((order) => order.orderId));
    const openOrders = database
      .listOpenBrokerOrdersByAccount(account.id)
      .filter((order) => !rejectedOrderIds.has(order.orderId));
    const retiredBrackets: string[] = [];
    for (const order of resolved) {
      database.updateBrokerOrderStatus(order.accountId, order.orderId, 'rejected', parsed.errorText, undefined, 'email');
      // A rejected entry dispatch can leave an armed monitor row claiming the
      // order is still working — retire it unless another open dispatch covers
      // the same arm (e.g. a resend attempt that may still exist at the broker).
      retiredBrackets.push(
        ...retireUncoveredArmedMonitorRows(user.id, order, openOrders, `email-reject-${order.orderId}`),
      );
    }

    emitEmailLog(user.id, inbound, parsed, {
      accountId: account.id,
      accountName: account.name,
      attributedBy: attributedBy ?? 'route',
      matchedOrders: resolved.map((order) => order.orderId),
      ...(ambiguous ? { ambiguous: true, candidateOrders: candidates.map((order) => order.orderId) } : {}),
      ...(retiredBrackets.length ? { retiredBrackets } : {}),
      success: resolved.length > 0,
    });
    const signal = [parsed.ticker, parsed.action].filter(Boolean).join(' ');
    emitToUser(user.id, 'toast:error', {
      message: `TradersPost reported a broker failure for ${account.name}${signal ? ` · ${signal}` : ''}: ${parsed.errorText}`,
      persistent: true,
    });
    console.warn('[email-ingest] TradersPost failure email processed', {
      userId: user.id,
      accountId: account.id,
      subject: inbound.subject,
      bracketId: parsed.bracketId ?? null,
      ticker: parsed.ticker ?? null,
      matched: resolved.length,
      ambiguous,
    });
    return resolved.length;
  };

  app.post('/email/:userId/:accountId/:secret', (req, res, next) => {
    try {
      const user = database.findUserByWebhook(req.params.userId, req.params.secret);
      if (!user) {
        res.status(401).json({ error: 'invalid webhook credentials' });
        return;
      }
      const account = database.findAccountById(req.params.accountId);
      if (!account || account.userId !== user.id) {
        res.status(404).json({ error: 'account not found' });
        return;
      }
      const gate = readInboundEmail(req.body);
      if ('status' in gate) {
        res.status(gate.status).json({ error: gate.error });
        return;
      }
      if (!gate.parsed.isFailure) {
        emitEmailLog(user.id, gate.inbound, gate.parsed, {
          accountId: account.id,
          accountName: account.name,
          attributedBy: 'route',
          matchedOrders: [],
          success: false,
          notFailure: true,
        });
        res.status(202).json({ accepted: true, matched: 0, stored: true, notFailure: true });
        return;
      }
      const matched = processFailureEmail(user, account, gate.inbound, gate.parsed);
      res.status(202).json({ accepted: true, matched });
    } catch (error) {
      next(error);
    }
  });

  // Generic variant: one shared secret and the bridge attributes the failure to
  // the owning account itself — the echoed bracketId identifies it exactly, the
  // TP strategy name is the fallback. Every normalized email is stored for
  // review; only failure mail attempts ledger mutation, and unattributable
  // failures still surface as an admin bridge log + toast.
  app.post('/email/:secret', (req, res, next) => {
    try {
      if (!emailIngestSecret || !matchesSecret(emailIngestSecret, req.params.secret)) {
        res.status(401).json({ error: 'invalid email credentials' });
        return;
      }
      const gate = readInboundEmail(req.body);
      if ('status' in gate) {
        res.status(gate.status).json({ error: gate.error });
        return;
      }
      const { inbound, parsed } = gate;

      let account: BridgeAccount | undefined;
      let attributedBy: string | undefined;
      const parsedBracketId = parsed.bracketId?.replace(/[\r\n]/g, '').replace(/'/g, 'r');
      if (parsedBracketId) {
        const accountIds = new Set(
          database.findBrokerOrdersByBracketId(parsedBracketId).map((order) => order.accountId),
        );
        if (accountIds.size === 1) {
          account = database.findAccountById([...accountIds][0]);
          attributedBy = 'bracketId';
        }
      }
      if (!account && parsed.strategy) {
        const matches = database.findAccountsByName(parsed.strategy);
        if (matches.length === 1) {
          account = matches[0];
          attributedBy = 'strategy';
        }
      }
      const accountUser = account ? database.findUserById(account.userId) : undefined;

      // Non-failure mail is stored verbatim for review but never mutates the
      // ledger. It lands on the attributed owner's log when identifiable,
      // otherwise on the admin's.
      if (!parsed.isFailure) {
        const target = accountUser ?? database.findUserByEmail(adminUserEmail ?? '');
        if (target) {
          emitEmailLog(target.id, inbound, parsed, {
            accountId: account?.id ?? null,
            accountName: account?.name ?? null,
            attributedBy: attributedBy ?? null,
            matchedOrders: [],
            success: false,
            notFailure: true,
            ...(account ? {} : { unattributed: true }),
          });
        }
        res.status(202).json({ accepted: true, matched: 0, stored: true, notFailure: true });
        return;
      }

      if (!account || !accountUser) {
        const admin = database.findUserByEmail(adminUserEmail ?? '');
        if (admin) {
          emitEmailLog(admin.id, inbound, parsed, {
            attributedBy: null,
            matchedOrders: [],
            success: false,
            unattributed: true,
          });
          emitToUser(admin.id, 'toast:error', {
            message: `TradersPost failure email could not be attributed to an account: ${parsed.errorText}`,
            persistent: true,
          });
          console.warn('[email-ingest] Unattributable TradersPost failure email', {
            subject: inbound.subject,
            bracketId: parsed.bracketId ?? null,
            ticker: parsed.ticker ?? null,
          });
        }
        res.status(202).json({ accepted: true, matched: 0, attributed: false });
        return;
      }

      const matched = processFailureEmail(accountUser, account, inbound, parsed, attributedBy);
      res.status(202).json({ accepted: true, matched, attributed: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/test/webhooks/:userId/:secret', async (req, res, next) => {
    try {
      const user = database.findUserByWebhook(req.params.userId, req.params.secret);
      if (!user) {
        res.status(401).json({ error: 'invalid test credentials' });
        return;
      }
      const alerts = buildRangeSimulationAlerts(database);
      const results = await Promise.all(
        alerts.map((payload) => processProxyPayload(payload, JSON.stringify(payload))),
      );
      console.info('[test] Simulated routed alerts created', { userId: user.id, count: results.length });
      res.status(202).json({
        status: 'test alerts routed',
        count: results.length,
        results,
        message: 'Two simulated R5 MWF alerts were routed through the shared proxy flow.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/test-complete/webhooks/:userId/:secret', async (req, res, next) => {
    try {
      const user = database.findUserByWebhook(req.params.userId, req.params.secret);
      if (!user) {
        res.status(401).json({ error: 'invalid test credentials' });
        return;
      }
      if (Date.now() < completeTestRunEndsAt) {
        res.status(429).json({ error: 'test-complete lifecycle is already in progress' });
        return;
      }
      const schedule = scheduleLifecycleTest(user.id, 'test-complete', buildCompleteRangeLifecycleSimulation());
      res.status(202).json({
        status: 'test-complete lifecycle scheduled',
        rangeName: 'Test Range',
        ...schedule,
        message: 'The complete Test Range lifecycle has been scheduled and will arrive immediately, then every 3 seconds.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/test-win/webhooks/:userId/:secret', async (req, res, next) => {
    try {
      const user = database.findUserByWebhook(req.params.userId, req.params.secret);
      if (!user) {
        res.status(401).json({ error: 'invalid test credentials' });
        return;
      }
      if (Date.now() < completeTestRunEndsAt) {
        res.status(429).json({ error: 'test-win lifecycle is already in progress' });
        return;
      }
      const schedule = scheduleLifecycleTest(user.id, 'test-win', buildWinningRangeLifecycleSimulation());
      res.status(202).json({
        status: 'test-win lifecycle scheduled',
        rangeName: 'Test Range',
        ...schedule,
        message: 'The winning Test Range lifecycle has been scheduled and will arrive immediately, then every 3 seconds.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/test-lose/webhooks/:userId/:secret', async (req, res, next) => {
    try {
      const user = database.findUserByWebhook(req.params.userId, req.params.secret);
      if (!user) {
        res.status(401).json({ error: 'invalid test credentials' });
        return;
      }
      if (Date.now() < completeTestRunEndsAt) {
        res.status(429).json({ error: 'test-lose lifecycle is already in progress' });
        return;
      }
      const schedule = scheduleLifecycleTest(user.id, 'test-lose', buildLosingRangeLifecycleSimulation());
      res.status(202).json({
        status: 'test-lose lifecycle scheduled',
        rangeName: 'Test Range',
        ...schedule,
        message: 'The losing Test Range lifecycle has been scheduled and will arrive immediately, then every 3 seconds.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/test/reset', (req, res) => {
    const user = resolveTestUserWithLog('test');
    if (!user) {
      res.status(409).json({
        error: config.TEST_USER_EMAIL
          ? 'configured test user was not found'
          : 'this shortcut requires exactly one bridge user or TEST_USER_EMAIL',
      });
      return;
    }
    const deletedDraftCount = database.clearDrafts(user.id);
    console.info('[test] Draft history reset', { userId: user.id, deletedDraftCount });
    res.status(200).json({
      status: 'test drafts reset',
      deletedDraftCount,
      message: 'All draft history for the single bridge user was cleared.',
    });
  });

  app.get(['/test', '/test/webhooks/'], async (req, res, next) => {
    const now = Date.now();
    if (now - lastPublicTestAt < 30_000) {
      res.status(429).json({ error: 'test notification is limited to once per 30 seconds' });
      return;
    }
    const user = resolveTestUserWithLog('test');
    if (!user) {
      res.status(409).json({
        error: config.TEST_USER_EMAIL
          ? 'configured test user was not found'
          : 'this shortcut requires exactly one bridge user or TEST_USER_EMAIL',
      });
      return;
    }
    lastPublicTestAt = now;
    try {
      const alerts = buildRangeSimulationAlerts(database);
      const results = await Promise.all(
        alerts.map((payload) => processProxyPayload(payload, JSON.stringify(payload))),
      );
      console.info('[test] Public simulated alerts created', { userId: user.id, count: results.length });
      res.status(202).json({
        status: 'test alerts routed',
        count: results.length,
        results,
        message: 'Two simulated R5 MWF alerts were routed through the shared proxy flow.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(['/test-complete', '/test-complete/webhooks/'], async (req, res, next) => {
    if (Date.now() < completeTestRunEndsAt) {
      res.status(429).json({ error: 'test-complete lifecycle is already in progress' });
      return;
    }
    const user = resolveTestUserWithLog('test-lose');
    if (!user) {
      res.status(409).json({
        error: config.TEST_USER_EMAIL
          ? 'configured test user was not found'
          : 'this shortcut requires exactly one bridge user or TEST_USER_EMAIL',
      });
      return;
    }
    try {
      const schedule = scheduleLifecycleTest(user.id, 'test-complete', buildCompleteRangeLifecycleSimulation());
      res.status(202).json({
        status: 'test-complete lifecycle scheduled',
        rangeName: 'Test Range',
        ...schedule,
        message: 'The complete Test Range lifecycle has been scheduled and will arrive immediately, then every 3 seconds.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(['/test-win', '/test-win/webhooks/'], async (req, res, next) => {
    if (Date.now() < completeTestRunEndsAt) {
      res.status(429).json({ error: 'test-win lifecycle is already in progress' });
      return;
    }
    const user = testUser();
    if (!user) {
      res.status(409).json({
        error: config.TEST_USER_EMAIL
          ? 'configured test user was not found'
          : 'this shortcut requires exactly one bridge user or TEST_USER_EMAIL',
      });
      return;
    }
    try {
      const schedule = scheduleLifecycleTest(user.id, 'test-win', buildWinningRangeLifecycleSimulation());
      res.status(202).json({
        status: 'test-win lifecycle scheduled',
        rangeName: 'Test Range',
        ...schedule,
        message: 'The winning Test Range lifecycle has been scheduled and will arrive immediately, then every 3 seconds.',
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(['/test-lose', '/test-lose/webhooks/'], async (req, res, next) => {
    if (Date.now() < completeTestRunEndsAt) {
      res.status(429).json({ error: 'test-lose lifecycle is already in progress' });
      return;
    }
    const user = testUser();
    if (!user) {
      res.status(409).json({
        error: config.TEST_USER_EMAIL
          ? 'configured test user was not found'
          : 'this shortcut requires exactly one bridge user or TEST_USER_EMAIL',
      });
      return;
    }
    try {
      const schedule = scheduleLifecycleTest(user.id, 'test-lose', buildLosingRangeLifecycleSimulation());
      res.status(202).json({
        status: 'test-lose lifecycle scheduled',
        rangeName: 'Test Range',
        ...schedule,
        message: 'The losing Test Range lifecycle has been scheduled and will arrive immediately, then every 3 seconds.',
      });
    } catch (error) {
      next(error);
    }
  });

  const requireExtensionAuth = (req: Request, res: Response, next: NextFunction) => {
    const user = database.findUserByExtensionToken(req.header('x-extension-token') ?? '');
    if (!user) {
      res.status(401).json({ error: 'invalid extension token' });
      return;
    }
    res.locals.extension = { userId: user.id, email: user.email } satisfies ExtensionSession;
    next();
  };

  app.get('/api/extension/session', requireExtensionAuth, (_req, res) => {
    res.status(200).json(res.locals.extension satisfies ExtensionSession);
  });

  app.post('/api/forex-factory/snapshots/import', requireExtensionAuth, (req, res) => {
    try {
      const input = extensionForexFactoryImportSchema.parse(req.body);
      const snapshot = importForexFactorySnapshot(database, { forexFactoryCache, forexFactoryRangeCache }, input.range, input.html);
      res.status(200).json({
        snapshot: {
          range: snapshot.range,
          timezone: snapshot.timezone,
          fetchedAt: snapshot.fetchedAt,
          count: snapshot.events.length,
          highImpactCount: filterForexFactoryEvents(snapshot.events, 'high').length,
        },
      });
    } catch (error) {
      if (error instanceof ForexFactoryError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  app.put('/api/tradovate/connection', requireExtensionAuth, async (req, res, next) => {
    try {
      if (!config.CREDENTIAL_ENCRYPTION_KEY) {
        res.status(503).json({ error: 'broker credential storage is not configured' });
        return;
      }
      const credentials = tradovateConnectionSchema.parse(req.body);
      const client = await TradovateClient.connect(credentials);
      const accounts = await client.listAccounts();
      const user = res.locals.extension as ExtensionSession;
      database.saveTradovateConnection(
        user.userId,
        credentials.environment,
        encrypt(JSON.stringify(credentials satisfies TradovateCredentials), config.CREDENTIAL_ENCRYPTION_KEY),
      );
      res.status(200).json({ environment: credentials.environment, accounts });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/tradovate/connection', requireExtensionAuth, (req, res) => {
    const user = res.locals.extension as ExtensionSession;
    const connection = database.getTradovateConnection(user.userId);
    res.status(200).json(connection
      ? {
        connected: true,
        environment: connection.environment,
        account: connection.accountId != null
          ? { id: connection.accountId, name: connection.accountSpec }
          : null,
      }
      : { connected: false, account: null });
  });

  app.put('/api/tradovate/account', requireExtensionAuth, async (req, res, next) => {
    try {
      if (!config.CREDENTIAL_ENCRYPTION_KEY) {
        res.status(503).json({ error: 'broker credential storage is not configured' });
        return;
      }
      const user = res.locals.extension as ExtensionSession;
      const connection = database.getTradovateConnection(user.userId);
      if (!connection) {
        res.status(409).json({ error: 'connect Tradovate before selecting an account' });
        return;
      }
      const { accountId } = tradovateAccountSchema.parse(req.body);
      const credentials = JSON.parse(
        decrypt(connection.encryptedCredentials, config.CREDENTIAL_ENCRYPTION_KEY),
      ) as TradovateCredentials;
      const account = (await TradovateClient.connect(credentials).then((client) => client.listAccounts()))
        .find((candidate) => candidate.id === accountId);
      if (!account) {
        res.status(400).json({ error: 'selected account is not available to this connection' });
        return;
      }
      database.setTradovateAccount(user.userId, account.id, account.name);
      res.status(200).json({ account });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/drafts', requireExtensionAuth, (req, res, next) => {
    try {
      const status = z.enum(['pending', 'reviewed']).default('pending').parse(req.query.status);
      const user = res.locals.extension as ExtensionSession;
      res.status(200).json({ drafts: database.listDrafts(user.userId, status, { extensionOnly: true }) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/drafts/history', requireExtensionAuth, (req, res, next) => {
    try {
      const limit = z.coerce.number().int().min(1).max(200).default(200).parse(req.query.limit);
      const sinceHours = z.coerce.number().int().min(1).max(168).default(12).parse(req.query.sinceHours);
      const status = z.enum(['all', 'reviewed', 'submitted', 'rejected', 'expired']).default('all').parse(req.query.status);
      const query = z.string().trim().max(256).optional().parse(req.query.query) || undefined;
      const accountId = z.string().trim().max(64).default('all').parse(req.query.accountId);
      const user = res.locals.extension as ExtensionSession;
      res.status(200).json({
        drafts: database.listRecentDrafts(user.userId, {
          limit,
          sinceHours,
          status,
          query,
          accountId,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/drafts/:id/reviewed', requireExtensionAuth, (req, res, next) => {
    try {
      const user = res.locals.extension as ExtensionSession;
      const draftId = z.string().uuid().parse(req.params.id);
      const draft = database.markReviewed(user.userId, draftId);
      if (!draft) {
        res.status(409).json({ error: 'draft is not pending or does not exist' });
        return;
      }
      res.status(200).json({ draft });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/drafts/:id/rejected', requireExtensionAuth, (req, res, next) => {
    try {
      const user = res.locals.extension as ExtensionSession;
      const draftId = z.string().uuid().parse(req.params.id);
      if (!database.rejectDraft(user.userId, draftId)) {
        res.status(409).json({ error: 'draft is not pending or does not exist' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/drafts/:id/submitted', requireExtensionAuth, (req, res, next) => {
    try {
      const user = res.locals.extension as ExtensionSession;
      const draftId = z.string().uuid().parse(req.params.id);
      const draft = database.markSubmitted(user.userId, draftId);
      if (!draft) {
        res.status(409).json({ error: 'draft is not pending or does not exist' });
        return;
      }
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // Mobile order review: the extension's review page works outside the
  // extension via ?token=<extensionToken> (persisted to localStorage on first
  // visit), so serve the same assets over HTTP for browsers that can't run it.
  app.get('/order-review', (req, res, next) => {
    const reviewPage = join(process.cwd(), 'dist', 'extension', 'review.html');
    if (!existsSync(reviewPage)) {
      res.status(503).send(page('Order review unavailable', '<p>The order review page is not available on this server yet.</p>'));
      return;
    }
    // review.html references popup.css/review.js relatively, which only
    // resolves under the trailing-slash URL. Non-strict routing also matches
    // '/order-review/' here — hand that off to the static mount below, and
    // redirect the bare URL to it, keeping the ?token= query for first-visit
    // auth persistence.
    if (req.path !== '/order-review') {
      next();
      return;
    }
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
    res.redirect(`/order-review/${query}`);
  });
  // /app/order-review is a React route; the /app/*splat handler below serves the
  // SPA for it (session-gated like every other app view).
  app.use('/order-review', express.static(join(process.cwd(), 'dist', 'extension'), { index: 'review.html' }));

  app.use(
    '/app',
    express.static(join(process.cwd(), 'client/dist'), {
      index: false,
      setHeaders: (res) => {
        if (!isProduction) {
          res.setHeader('Cache-Control', 'no-store, must-revalidate');
        }
      },
    }),
  );

  app.get('/app/*splat', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/app/api/')) {
      next();
      return;
    }
    renderAppView('journal')(req, res);
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      console.error('[zod error]', req.method, req.path, error.issues);
      res.status(400).json({ error: 'invalid request', details: error.issues });
      return;
    }
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      console.error('[unique constraint]', req.method, req.path, error.message);
      res.status(409).json({ error: 'resource already exists' });
      return;
    }
    console.error('[express error]', req.method, req.path, req.query, error);
    res.status(500).json({ error: 'internal server error' });
  });

  // EOD flatten/cancel scheduler: each account has its own EOD cancel and exit
  // times.  At the cancel time we cancel every open bracket order for that account;
  // at the exit time we flatten every open position.  Both events are retried for
  // up to MAX_EOD_RETRY_MINUTES after the scheduled time until they succeed.
  const MAX_EOD_RETRY_MINUTES = 5;
  const lastEodRunDateByKey = new Map<string, string>();
  const eodAttemptStateByKey = new Map<string, { date: string; count: number }>();
  const timeToMinutes = (time: string): number => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
  };
  const isWithinEodWindow = (scheduledTime: string, currentTimeKey: string): boolean => {
    const scheduledMinutes = timeToMinutes(scheduledTime);
    const currentMinutes = timeToMinutes(currentTimeKey);
    return currentMinutes >= scheduledMinutes && currentMinutes <= scheduledMinutes + MAX_EOD_RETRY_MINUTES;
  };
  const lastNewsFlattenByEventKey = new Map<string, string>();
  // One persistent summary toast per account per flatten event/day.
  const eodToastByKey = new Map<string, string>();
  const newsToastByKey = new Map<string, string>();
  // Drafts marked at EOD once per user per day — the exit window opening is
  // the "day is done" signal; pending drafts are stale by then anyway.
  const draftsSubmittedEodByKey = new Set<string>();
  const scheduler = setInterval(() => {
    const now = new Date();
    const shiftedNow = journalShiftedDate(now);
    const currentDateKey = [
      shiftedNow.getUTCFullYear(),
      String(shiftedNow.getUTCMonth() + 1).padStart(2, '0'),
      String(shiftedNow.getUTCDate()).padStart(2, '0'),
    ].join('-');
    const currentTimeKey = `${String(shiftedNow.getUTCHours()).padStart(2, '0')}:${String(shiftedNow.getUTCMinutes()).padStart(2, '0')}`;

    for (const user of database.listUsers()) {
      // Deprecated accounts are included so their open brackets/positions still get
      // closed locally at EOD — they just never send TradersPost traffic.
      for (const account of database.listAccounts(user.id)) {
        const destination = database.getTradersPostAccountDestination(account.id);
        const cancelTime = destination?.eodCancelTime ?? '16:30';
        const exitTime = destination?.eodExitTime ?? '16:45';
        // Auto-submit pending drafts once at the user's first EOD exit window.
        if (isWithinEodWindow(exitTime, currentTimeKey)) {
          const draftsKey = `${user.id}:${currentDateKey}`;
          if (!draftsSubmittedEodByKey.has(draftsKey)) {
            draftsSubmittedEodByKey.add(draftsKey);
            const marked = database.markAllPendingDraftsSubmitted(user.id);
            if (marked > 0) {
              emitToUser(user.id, 'drafts:refresh', {});
              console.info('[eod-scheduler] Marked pending drafts submitted at EOD', { userId: user.id, count: marked });
            }
          }
        }
        const accountId = account.id;
        const userId = account.userId;
        const accountCanSend = Boolean(!account.deprecated && destination?.enabled);
        const eodCanSend = Boolean(accountCanSend && destination?.eodEnabled !== false);
        // EOD deliveries are account-level but proxy_deliveries.range_route_id is a
        // required FK — borrow a real route for bookkeeping (prefer the order's range).
        const resolveEodRouteId = (rangeName?: string): string | undefined => {
          const accountRoutes = database.listRangeRoutes(userId).filter((route) => route.accountId === accountId);
          if (rangeName) {
            const match = accountRoutes.find((route) => route.rangeName === rangeName);
            if (match) return match.id;
          }
          return accountRoutes[0]?.id;
        };
        // Roots the account touched recently (last 24h of TradersPost entries plus any
        // still-open instruments) — EOD also flattens these even when nothing is open,
        // so stray broker-side orders/positions outside Bridge bookkeeping are cleared.
        const collectRecentEodRoots = (): Set<string> => {
          const roots = new Set<string>();
          for (const ticker of database.listAccountRecentTradersPostTickers(accountId, 24)) {
            const root = continuousTickerRoot(ticker);
            if (root) roots.add(root);
          }
          for (const instrument of database.getAccountOpenInstruments(accountId)) {
            const root = continuousTickerRoot(instrument);
            if (root) roots.add(root);
          }
          return roots;
        };
        // Per-account EOD summary — collects this pass's send outcomes and
        // local-only closes so the operator gets one persistent toast per
        // account per day instead of digging through stdout logs.
        const eodReport = { sends: [] as Promise<boolean>[], localCloses: 0 };
        try {

        if (isWithinEodWindow(cancelTime, currentTimeKey)) {
          const openOrders = database.getOpenBracketOrdersForAccount(accountId);
          for (const order of openOrders) {
            if (isCryptoFutureTicker(order.ticker)) continue;
            const cancelKey = `cancel:${accountId}:${order.bracketId}`;
            if (lastEodRunDateByKey.get(cancelKey) === currentDateKey) continue;
            const cancelAttemptState = eodAttemptStateByKey.get(cancelKey);
            if (cancelAttemptState?.date === currentDateKey && cancelAttemptState.count >= MAX_EOD_RETRY_MINUTES) {
              recordBridgeGeneratedEntryCancelled({ userId, accountId }, {
                ticker: order.ticker,
                action: 'cancel',
                tradeId: order.tradeId,
                quantity: order.quantity,
                bracketSide: order.side,
                extras: { rangeName: order.rangeName ?? '', reason: 'eod_cancel' },
              }, now.toISOString());
              lastEodRunDateByKey.set(cancelKey, currentDateKey);
              eodReport.localCloses++;
              console.warn('[eod-scheduler] EOD cancel retries exhausted; recorded local close', { accountId, bracketId: order.bracketId, cancelKey });
              continue;
            }
            const cancelAttemptCount = cancelAttemptState?.date === currentDateKey ? cancelAttemptState.count + 1 : 1;
            eodAttemptStateByKey.set(cancelKey, { date: currentDateKey, count: cancelAttemptCount });

            const cancelOrderType = database.getEntryOrderTypeForBracket(accountId, order.bracketId);
            const baseTicker = applyAccountDestinationToPayload(
              { ticker: order.ticker } as { ticker: string },
              destination,
            );
            const cancelPayload: TradersPostPayload = {
              ...baseTicker,
              action: 'cancel',
              bracketId: order.bracketId,
              bracketSide: order.side,
              tradeId: order.tradeId,
              quantity: order.quantity,
              ...(cancelOrderType ? { cancelOrderType } : {}),
              time: now.toISOString(),
              extras: {
                reason: 'eod_cancel',
                source: 'bridge-eod-scheduler',
                ...(order.rangeName ? { rangeName: order.rangeName } : {}),
              },
            };

            if (!eodCanSend) {
              recordBridgeGeneratedEntryCancelled({ userId, accountId }, cancelPayload, now.toISOString());
              lastEodRunDateByKey.set(cancelKey, currentDateKey);
              eodReport.localCloses++;
              console.info('[eod-scheduler] Recorded local EOD cancel (no TradersPost destination)', { accountId, bracketId: order.bracketId, cancelKey });
              continue;
            }

            const routeId = resolveEodRouteId(order.rangeName);
            if (!routeId) {
              recordBridgeGeneratedEntryCancelled({ userId, accountId }, cancelPayload, now.toISOString());
              lastEodRunDateByKey.set(cancelKey, currentDateKey);
              eodReport.localCloses++;
              console.warn('[eod-scheduler] EOD cancel route missing; recorded local close', { accountId, bracketId: order.bracketId, cancelKey });
              continue;
            }

            const proxyAlert = database.createProxyAlert({
              action: 'cancel',
              ticker: cancelPayload.ticker,
              payloadJson: JSON.stringify(cancelPayload),
              sourceReference: `bridge-eod-cancel-${order.bracketId}`,
            });
            const proxyDelivery = database.createProxyDelivery({
              proxyAlertId: proxyAlert.id,
              rangeRouteId: routeId,
              userId,
              accountId,
              extensionEnabled: false,
              traderspostEnabled: true,
              status: 'pending_traderspost',
            });
            eodReport.sends.push(forwardToTradersPost(proxyDelivery, proxyAlert.payloadJson, {
              source: 'eod_cancel',
              userId,
              rangeName: order.rangeName,
            }).then((updatedDelivery) => {
              if (updatedDelivery.status === 'traderspost_delivered' || updatedDelivery.status === 'extension_draft_created_and_traderspost_delivered') {
                recordBridgeGeneratedEntryCancelled(updatedDelivery, cancelPayload, now.toISOString());
                lastEodRunDateByKey.set(cancelKey, currentDateKey);
                console.info('[eod-scheduler] EOD cancel delivered', { accountId, bracketId: order.bracketId, cancelKey });
                return true;
              }
              console.error('[eod-scheduler] EOD cancel not delivered; will retry', { accountId, bracketId: order.bracketId, status: updatedDelivery.status });
              return false;
            }).catch((error) => {
              console.error('[eod-scheduler] EOD cancel forward failed; will retry', {
                accountId,
                bracketId: order.bracketId,
                error: error instanceof Error ? error.message : String(error),
              });
              return false;
            }));
          }

          // Instrument-scoped cancels for recently-active roots not covered by an open
          // bracket above — clears stray working orders even when nothing is open locally.
          if (eodCanSend) {
            const coveredCancelTickers = new Set(
              openOrders.map((order) => applyAccountDestinationToPayload(
                { ticker: order.ticker } as { ticker: string },
                destination,
              ).ticker),
            );
            for (const root of collectRecentEodRoots()) {
              if (isCryptoFutureTicker(root)) continue;
              const cancelTicker = applyAccountDestinationToPayload(
                { ticker: `${root}1!` } as { ticker: string },
                destination,
              ).ticker;
              if (coveredCancelTickers.has(cancelTicker)) continue;
              const cancelKey = `cancel-instrument:${accountId}:${cancelTicker}`;
              if (lastEodRunDateByKey.get(cancelKey) === currentDateKey) continue;
              const cancelAttemptState = eodAttemptStateByKey.get(cancelKey);
              if (cancelAttemptState?.date === currentDateKey && cancelAttemptState.count >= MAX_EOD_RETRY_MINUTES) {
                lastEodRunDateByKey.set(cancelKey, currentDateKey);
                console.warn('[eod-scheduler] EOD instrument cancel retries exhausted', { accountId, ticker: cancelTicker, cancelKey });
                continue;
              }
              const cancelAttemptCount = cancelAttemptState?.date === currentDateKey ? cancelAttemptState.count + 1 : 1;
              eodAttemptStateByKey.set(cancelKey, { date: currentDateKey, count: cancelAttemptCount });

              const routeId = resolveEodRouteId();
              if (!routeId) {
                lastEodRunDateByKey.set(cancelKey, currentDateKey);
                console.warn('[eod-scheduler] EOD instrument cancel route missing; skipped', { accountId, ticker: cancelTicker });
                continue;
              }

              const cancelPayload: TradersPostPayload = {
                ticker: cancelTicker,
                action: 'cancel',
                time: now.toISOString(),
                extras: {
                  reason: 'eod_cancel',
                  source: 'bridge-eod-scheduler',
                },
              };
              const proxyAlert = database.createProxyAlert({
                action: 'cancel',
                ticker: cancelTicker,
                payloadJson: JSON.stringify(cancelPayload),
                sourceReference: `bridge-eod-cancel-${accountId}-${cancelTicker}-${currentDateKey}`,
              });
              const proxyDelivery = database.createProxyDelivery({
                proxyAlertId: proxyAlert.id,
                rangeRouteId: routeId,
                userId,
                accountId,
                extensionEnabled: false,
                traderspostEnabled: true,
                status: 'pending_traderspost',
              });
              eodReport.sends.push(forwardToTradersPost(proxyDelivery, proxyAlert.payloadJson, {
                source: 'eod_cancel',
                userId,
              }).then((updatedDelivery) => {
                if (updatedDelivery.status === 'traderspost_delivered' || updatedDelivery.status === 'extension_draft_created_and_traderspost_delivered') {
                  lastEodRunDateByKey.set(cancelKey, currentDateKey);
                  console.info('[eod-scheduler] EOD instrument cancel delivered', { accountId, ticker: cancelTicker, cancelKey });
                  return true;
                }
                console.error('[eod-scheduler] EOD instrument cancel not delivered; will retry', { accountId, ticker: cancelTicker, status: updatedDelivery.status });
                return false;
              }).catch((error) => {
                console.error('[eod-scheduler] EOD instrument cancel forward failed; will retry', {
                  accountId,
                  ticker: cancelTicker,
                  error: error instanceof Error ? error.message : String(error),
                });
                return false;
              }));
            }
          }
        }

        if (isWithinEodWindow(exitTime, currentTimeKey)) {
          const openInstruments = database.getAccountOpenInstruments(accountId);
          for (const instrument of openInstruments) {
            if (isCryptoFutureTicker(instrument)) continue;
            const exitKey = `exit:${accountId}:${instrument}`;
            if (lastEodRunDateByKey.get(exitKey) === currentDateKey) continue;
            const exitAttemptState = eodAttemptStateByKey.get(exitKey);
            if (exitAttemptState?.date === currentDateKey && exitAttemptState.count >= MAX_EOD_RETRY_MINUTES) {
              const closed = recordFlattenedPositions(userId, accountId, instrument, now.toISOString(), undefined, 'eod');
              lastEodRunDateByKey.set(exitKey, currentDateKey);
              eodReport.localCloses++;
              console.warn('[eod-scheduler] EOD exit retries exhausted; recorded local close', { accountId, instrument, closed, exitKey });
              continue;
            }
            const exitAttemptCount = exitAttemptState?.date === currentDateKey ? exitAttemptState.count + 1 : 1;
            eodAttemptStateByKey.set(exitKey, { date: currentDateKey, count: exitAttemptCount });

            const basePayload: ExitPayload = {
              ticker: instrument,
              action: 'exit',
              time: now.toISOString(),
              extras: {
                reason: 'eod_exit',
                source: 'bridge-eod-scheduler',
              },
            };
            const exitPayload = buildExplicitMarketExitPayload(basePayload, destination);

            if (!eodCanSend) {
              const closed = recordFlattenedPositions(userId, accountId, instrument, now.toISOString(), undefined, 'eod');
              lastEodRunDateByKey.set(exitKey, currentDateKey);
              eodReport.localCloses++;
              console.info('[eod-scheduler] Recorded local EOD exit (no TradersPost destination)', { accountId, instrument, closed, exitKey });
              continue;
            }

            const routeId = resolveEodRouteId();
            if (!routeId) {
              const closed = recordFlattenedPositions(userId, accountId, instrument, now.toISOString(), undefined, 'eod');
              lastEodRunDateByKey.set(exitKey, currentDateKey);
              eodReport.localCloses++;
              console.warn('[eod-scheduler] EOD exit route missing; recorded local close', { accountId, instrument, closed, exitKey });
              continue;
            }

            const proxyAlert = database.createProxyAlert({
              action: 'exit',
              ticker: exitPayload.ticker,
              payloadJson: JSON.stringify(exitPayload),
              sourceReference: `bridge-eod-exit-${accountId}-${instrument}-${now.toISOString()}`,
            });
            const proxyDelivery = database.createProxyDelivery({
              proxyAlertId: proxyAlert.id,
              rangeRouteId: routeId,
              userId,
              accountId,
              extensionEnabled: false,
              traderspostEnabled: true,
              status: 'pending_traderspost',
            });
            eodReport.sends.push(forwardToTradersPost(proxyDelivery, proxyAlert.payloadJson, {
              source: 'eod_exit',
              userId,
            }).then((updatedDelivery) => {
              if (updatedDelivery.status === 'traderspost_delivered' || updatedDelivery.status === 'extension_draft_created_and_traderspost_delivered') {
                const closed = recordFlattenedPositions(userId, accountId, instrument, now.toISOString(), proxyAlert.id, 'eod');
                lastEodRunDateByKey.set(exitKey, currentDateKey);
                console.info('[eod-scheduler] Recorded breakeven close for flattened positions', {
                  accountId,
                  instrument,
                  closed,
                });
                return true;
              }
              console.error('[eod-scheduler] EOD exit not delivered; will retry', { accountId, instrument, status: updatedDelivery.status });
              return false;
            }).catch((error) => {
              console.error('[eod-scheduler] EOD exit forward failed; will retry', {
                accountId,
                instrument: exitPayload.ticker,
                error: error instanceof Error ? error.message : String(error),
              });
              return false;
            }));
          }

          // Instrument-scoped exits for recently-active roots with no open position —
          // flattens stray broker-side positions outside Bridge bookkeeping.
          if (eodCanSend) {
            const coveredExitTickers = new Set(
              openInstruments.map((instrument) => applyAccountDestinationToPayload(
                { ticker: instrument } as { ticker: string },
                destination,
              ).ticker),
            );
            for (const root of collectRecentEodRoots()) {
              if (isCryptoFutureTicker(root)) continue;
              const exitTicker = applyAccountDestinationToPayload(
                { ticker: `${root}1!` } as { ticker: string },
                destination,
              ).ticker;
              if (coveredExitTickers.has(exitTicker)) continue;
              const exitKey = `exit-instrument:${accountId}:${exitTicker}`;
              if (lastEodRunDateByKey.get(exitKey) === currentDateKey) continue;
              const exitAttemptState = eodAttemptStateByKey.get(exitKey);
              if (exitAttemptState?.date === currentDateKey && exitAttemptState.count >= MAX_EOD_RETRY_MINUTES) {
                lastEodRunDateByKey.set(exitKey, currentDateKey);
                console.warn('[eod-scheduler] EOD instrument exit retries exhausted', { accountId, ticker: exitTicker, exitKey });
                continue;
              }
              const exitAttemptCount = exitAttemptState?.date === currentDateKey ? exitAttemptState.count + 1 : 1;
              eodAttemptStateByKey.set(exitKey, { date: currentDateKey, count: exitAttemptCount });

              const routeId = resolveEodRouteId();
              if (!routeId) {
                lastEodRunDateByKey.set(exitKey, currentDateKey);
                console.warn('[eod-scheduler] EOD instrument exit route missing; skipped', { accountId, ticker: exitTicker });
                continue;
              }

              const basePayload: ExitPayload = {
                ticker: exitTicker,
                action: 'exit',
                time: now.toISOString(),
                extras: {
                  reason: 'eod_exit',
                  source: 'bridge-eod-scheduler',
                },
              };
              const exitPayload = buildExplicitMarketExitPayload(basePayload, destination);
              const proxyAlert = database.createProxyAlert({
                action: 'exit',
                ticker: exitPayload.ticker,
                payloadJson: JSON.stringify(exitPayload),
                sourceReference: `bridge-eod-exit-${accountId}-${exitTicker}-${currentDateKey}`,
              });
              const proxyDelivery = database.createProxyDelivery({
                proxyAlertId: proxyAlert.id,
                rangeRouteId: routeId,
                userId,
                accountId,
                extensionEnabled: false,
                traderspostEnabled: true,
                status: 'pending_traderspost',
              });
              eodReport.sends.push(forwardToTradersPost(proxyDelivery, proxyAlert.payloadJson, {
                source: 'eod_exit',
                userId,
              }).then((updatedDelivery) => {
                if (updatedDelivery.status === 'traderspost_delivered' || updatedDelivery.status === 'extension_draft_created_and_traderspost_delivered') {
                  const closed = recordFlattenedPositions(userId, accountId, exitTicker, now.toISOString(), proxyAlert.id, 'eod');
                  lastEodRunDateByKey.set(exitKey, currentDateKey);
                  console.info('[eod-scheduler] EOD instrument exit delivered', { accountId, ticker: exitTicker, closed, exitKey });
                  return true;
                }
                console.error('[eod-scheduler] EOD instrument exit not delivered; will retry', { accountId, ticker: exitTicker, status: updatedDelivery.status });
                return false;
              }).catch((error) => {
                console.error('[eod-scheduler] EOD instrument exit forward failed; will retry', {
                  accountId,
                  ticker: exitTicker,
                  error: error instanceof Error ? error.message : String(error),
                });
                return false;
              }));
            }
          }
        }

        // One toast per account per day summarizing this EOD pass — success
        // when every send delivered, warning when retries/local closes remain.
        const eodToastKey = `eod:${accountId}`;
        if ((eodReport.sends.length > 0 || eodReport.localCloses > 0) && eodToastByKey.get(eodToastKey) !== currentDateKey) {
          eodToastByKey.set(eodToastKey, currentDateKey);
          const localCloses = eodReport.localCloses;
          void Promise.all(eodReport.sends).then((results) => {
            const delivered = results.filter(Boolean).length;
            const allOk = delivered === results.length && localCloses === 0;
            database.createBridgeLog(userId, 'traderspost', {
              event: 'eodCloseout', accountId, accountName: account.name,
              delivered, attempted: results.length, localCloses, success: allOk,
            });
            emitToUser(userId, allOk ? 'toast:success' : 'toast:warning', {
              persistent: true,
              message: allOk
                ? `EOD close-out complete for ${account.name} — ${delivered} flatten send${delivered === 1 ? '' : 's'} delivered`
                : `EOD close-out for ${account.name}: ${delivered}/${results.length} sends delivered${localCloses > 0 ? `, ${localCloses} position(s) closed locally without a send` : ''} — check remaining positions`,
            });
          });
        }

        if (destination?.newsFlattenEnabled && destination?.newsFlattenMinutes) {
          const snapshot = database.findForexFactoryRangeSnapshotCovering(now);
          if (!snapshot) {
            // Snapshots only arrive via manual Settings import — warn once per
            // day so a coverage gap doesn't silently skip flattens.
            const warnKey = `news-no-snapshot:${currentDateKey}`;
            if (lastNewsFlattenByEventKey.get(warnKey) !== currentDateKey) {
              lastNewsFlattenByEventKey.set(warnKey, currentDateKey);
              console.warn('[news-flatten-scheduler] No ForexFactory snapshot covers today — import the current week/month in Settings or red-folder flattens will be skipped', { date: currentDateKey, accountId });
            }
          }
          const nextEvent = snapshot ? nextForexFactoryEvent(snapshot, now) : undefined;
          if (nextEvent && typeof nextEvent.eventAt === 'number') {
            const msUntil = nextEvent.eventAt - now.getTime();
            const flattenWindowMs = destination.newsFlattenMinutes * 60 * 1_000;
            if (msUntil >= 0 && msUntil <= flattenWindowMs) {
              const newsFlattenKey = `news-flatten:${accountId}:${nextEvent.eventId}`;
              if (lastNewsFlattenByEventKey.get(newsFlattenKey) !== currentDateKey) {
                const newsAttemptState = eodAttemptStateByKey.get(newsFlattenKey);
                const newsExhausted = newsAttemptState?.date === currentDateKey && newsAttemptState.count >= MAX_EOD_RETRY_MINUTES;
                if (!accountCanSend || newsExhausted) {
                  // Disabled/deprecated destination or retries exhausted — close the
                  // books locally like EOD so the journal does not show brackets still
                  // live through the event window.
                  const newsToastKey = `news:${accountId}:${nextEvent.eventId}`;
                  if (newsToastByKey.get(newsToastKey) !== currentDateKey) {
                    newsToastByKey.set(newsToastKey, currentDateKey);
                    database.createBridgeLog(userId, 'crosstrade', {
                      event: 'newsFlatten', accountId, accountName: account.name,
                      eventTitle: nextEvent.title, sent: false,
                      reason: !accountCanSend ? 'destination disabled' : 'retries exhausted',
                    });
                    emitToUser(userId, 'toast:warning', {
                      persistent: true,
                      message: `News flatten for ${account.name} could not send (${!accountCanSend ? 'destination disabled' : 'retries exhausted'}) — positions closed locally only, verify the book is flat`,
                    });
                  }
                  for (const order of database.getOpenBracketOrdersForAccount(accountId)) {
                    recordBridgeGeneratedEntryCancelled({ userId, accountId }, {
                      ticker: order.ticker,
                      action: 'cancel',
                      tradeId: order.tradeId,
                      quantity: order.quantity,
                      bracketSide: order.side,
                      extras: { rangeName: order.rangeName ?? '', reason: 'news_flatten_cancel' },
                    }, now.toISOString());
                  }
                  for (const instrument of database.getAccountOpenInstruments(accountId)) {
                    recordFlattenedPositions(userId, accountId, instrument, now.toISOString(), undefined, 'news_flatten');
                  }
                  lastNewsFlattenByEventKey.set(newsFlattenKey, currentDateKey);
                  console.warn('[news-flatten-scheduler] Recorded local close (no send)', {
                    accountId,
                    eventId: nextEvent.eventId,
                    reason: !accountCanSend ? 'destination not sendable' : 'retries exhausted',
                  });
                } else {
                  const newsAttemptCount = newsAttemptState?.date === currentDateKey ? newsAttemptState.count + 1 : 1;
                  eodAttemptStateByKey.set(newsFlattenKey, { date: currentDateKey, count: newsAttemptCount });
                  console.info('[news-flatten-scheduler] Flattening before high-impact news', {
                    accountId,
                    eventId: nextEvent.eventId,
                    title: nextEvent.title,
                    eventAt: new Date(nextEvent.eventAt).toISOString(),
                    minutesUntil: Math.round(msUntil / 60 / 1_000),
                    attempt: newsAttemptCount,
                  });

                  // Each send resolves to whether it was delivered; the event is only
                  // marked done when a pass actually sent and every send succeeded, so
                  // a failure (or a bracket that opens mid-window) is retried next tick.
                  const newsSends: Array<Promise<boolean>> = [];
                  const isDelivered = (status: string): boolean =>
                    status === 'traderspost_delivered' || status === 'extension_draft_created_and_traderspost_delivered';

                  const newsCancelOrders = database.getOpenBracketOrdersForAccount(accountId);
                  for (const order of newsCancelOrders) {
                    const cancelOrderType = database.getEntryOrderTypeForBracket(accountId, order.bracketId);
                    const baseTicker = applyAccountDestinationToPayload(
                      { ticker: order.ticker } as { ticker: string },
                      destination,
                    );
                    const cancelPayload: TradersPostPayload = {
                      ...baseTicker,
                      action: 'cancel',
                      bracketId: order.bracketId,
                      bracketSide: order.side,
                      tradeId: order.tradeId,
                      quantity: order.quantity,
                      ...(cancelOrderType ? { cancelOrderType } : {}),
                      time: now.toISOString(),
                      extras: {
                        reason: 'news_flatten_cancel',
                        source: 'bridge-news-flatten-scheduler',
                        ...(order.rangeName ? { rangeName: order.rangeName } : {}),
                      },
                    };
                    const proxyAlert = database.createProxyAlert({
                      action: 'cancel',
                      ticker: cancelPayload.ticker,
                      payloadJson: JSON.stringify(cancelPayload),
                      sourceReference: `bridge-news-flatten-cancel-${order.bracketId}`,
                    });
                    const routeId = resolveEodRouteId(order.rangeName);
                    if (!routeId) {
                      console.warn('[news-flatten-scheduler] Skipping cancel: no route for account', { accountId, bracketId: order.bracketId });
                      newsSends.push(Promise.resolve(false));
                      continue;
                    }
                    const proxyDelivery = database.createProxyDelivery({
                      proxyAlertId: proxyAlert.id,
                      rangeRouteId: routeId,
                      userId: user.id,
                      accountId,
                      extensionEnabled: false,
                      traderspostEnabled: true,
                      status: 'pending_traderspost',
                    });
                    newsSends.push(forwardToTradersPost(proxyDelivery, proxyAlert.payloadJson, {
                      source: 'news_flatten_cancel',
                      userId: user.id,
                      rangeName: order.rangeName,
                    }).then((updatedDelivery) => {
                      if (isDelivered(updatedDelivery.status)) {
                        recordBridgeGeneratedEntryCancelled(updatedDelivery, cancelPayload, now.toISOString());
                        return true;
                      }
                      console.error('[news-flatten-scheduler] Cancel not delivered; will retry', {
                        accountId,
                        bracketId: order.bracketId,
                        status: updatedDelivery.status,
                      });
                      return false;
                    }).catch((error) => {
                      console.error('[news-flatten-scheduler] Cancel forward failed; will retry', {
                        accountId,
                        bracketId: order.bracketId,
                        error: error instanceof Error ? error.message : String(error),
                      });
                      return false;
                    }));
                  }

                  const newsOpenInstruments = database.getAccountOpenInstruments(accountId);
                  for (const instrument of newsOpenInstruments) {
                    const basePayload: ExitPayload = {
                      ticker: instrument,
                      action: 'exit',
                      time: now.toISOString(),
                      extras: {
                        reason: 'news_flatten_exit',
                        source: 'bridge-news-flatten-scheduler',
                      },
                    };
                    const exitPayload = buildExplicitMarketExitPayload(basePayload, destination);
                    const proxyAlert = database.createProxyAlert({
                      action: 'exit',
                      ticker: exitPayload.ticker,
                      payloadJson: JSON.stringify(exitPayload),
                      sourceReference: `bridge-news-flatten-exit-${accountId}-${instrument}-${now.toISOString()}`,
                    });
                    const routeId = resolveEodRouteId();
                    if (!routeId) {
                      console.warn('[news-flatten-scheduler] Skipping exit: no route for account', { accountId, instrument });
                      newsSends.push(Promise.resolve(false));
                      continue;
                    }
                    const proxyDelivery = database.createProxyDelivery({
                      proxyAlertId: proxyAlert.id,
                      rangeRouteId: routeId,
                      userId: user.id,
                      accountId,
                      extensionEnabled: false,
                      traderspostEnabled: true,
                      status: 'pending_traderspost',
                    });
                    newsSends.push(forwardToTradersPost(proxyDelivery, proxyAlert.payloadJson, {
                      source: 'news_flatten_exit',
                      userId: user.id,
                    }).then((updatedDelivery) => {
                      if (isDelivered(updatedDelivery.status)) {
                        const closed = recordFlattenedPositions(user.id, accountId, instrument, now.toISOString(), proxyAlert.id, 'news_flatten');
                        console.info('[news-flatten-scheduler] Recorded news-flatten close', {
                          accountId,
                          instrument,
                          closed,
                        });
                        return true;
                      }
                      console.error('[news-flatten-scheduler] Exit not delivered; will retry', {
                        accountId,
                        instrument,
                        status: updatedDelivery.status,
                      });
                      return false;
                    }).catch((error) => {
                      console.error('[news-flatten-scheduler] Exit forward failed; will retry', {
                        accountId,
                        instrument: exitPayload.ticker,
                        error: error instanceof Error ? error.message : String(error),
                      });
                      return false;
                    }));
                  }

                  void Promise.all(newsSends).then((results) => {
                    if (newsSends.length > 0 && results.every(Boolean)) {
                      lastNewsFlattenByEventKey.set(newsFlattenKey, currentDateKey);
                    }
                    const newsToastKey = `news:${accountId}:${nextEvent.eventId}`;
                    if (newsSends.length > 0 && newsToastByKey.get(newsToastKey) !== currentDateKey) {
                      newsToastByKey.set(newsToastKey, currentDateKey);
                      const delivered = results.filter(Boolean).length;
                      const allOk = delivered === results.length;
                      database.createBridgeLog(userId, 'crosstrade', {
                        event: 'newsFlatten', accountId, accountName: account.name,
                        eventTitle: nextEvent.title, eventId: nextEvent.eventId,
                        delivered, attempted: results.length, success: allOk,
                      });
                      emitToUser(userId, allOk ? 'toast:success' : 'toast:warning', {
                        persistent: true,
                        message: allOk
                          ? `News flatten delivered for ${account.name} — ${delivered} send${delivered === 1 ? '' : 's'} before ${nextEvent.title}`
                          : `News flatten for ${account.name}: ${delivered}/${results.length} sends delivered before ${nextEvent.title} — check remaining positions`,
                      });
                    }
                  });
                }
              }
            }
          }
        }
        } catch (error) {
          console.error('[eod-scheduler] EOD pass failed for account', {
            accountId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }, 60_000);
  // CrossTrade evidence sweep: probes NT8 for CT dispatches stuck
  // pending/uncertain past the grace window. Failures are logged, never fatal.
  const CT_SWEEP_INTERVAL_MS = Math.max(2_000, Number(process.env.CT_SWEEP_INTERVAL_MS) || 60_000);
  // The periodic sweep only auto-runs in production — dev/test runs would
  // otherwise burn the shared CrossTrade rate budget on throwaway state.
  // Operators trigger passes manually via /app/debugging/ct-sweep-now (the
  // Journal Open Orders header shows a dev-only button). CT_SWEEP_ENABLED
  // overrides either direction.
  const ctSweepEnabled = process.env.CT_SWEEP_ENABLED !== undefined
    ? /^(1|true|yes)$/i.test(process.env.CT_SWEEP_ENABLED)
    : process.env.NODE_ENV === 'production';
  // Adaptive cadence: every CT_SWEEP_INTERVAL_MS while there is open work
  // (unresolved CT ledger rows or an armed/filled bracket on a CT-configured
  // account), CT_SWEEP_IDLE_MS when flat — idle sweeps exist mainly to catch
  // broker-side activity, which doesn't need minute cadence.
  const CT_SWEEP_IDLE_MS = Math.max(CT_SWEEP_INTERVAL_MS, Number(process.env.CT_SWEEP_IDLE_MS) || 15 * 60_000);
  const ctSweepHasOpenWork = (): boolean => {
    if (database.listUnresolvedCrossTradeOrdersBefore(new Date(Date.now() + 1_000).toISOString()).length > 0) return true;
    for (const accountId of database.listAccountsWithOpenMonitorRows()) {
      const dest = database.getTradersPostAccountDestination(accountId);
      if (isCrossTradeConfigured(dest)) return true;
    }
    return false;
  };
  let ctSweepInFlight = false;
  let ctSweepTimer: ReturnType<typeof setTimeout> | undefined;
  const ctSweepTick = (): void => {
    if (ctSweepInFlight) {
      ctSweepTimer = setTimeout(ctSweepTick, CT_SWEEP_INTERVAL_MS);
      return;
    }
    ctSweepInFlight = true;
    void sweepUncertainCrossTradeOrders()
      .catch((error) => {
        console.warn(JSON.stringify({ level: 'warn', event: 'crossTradeSweepError', error: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => {
        ctSweepInFlight = false;
        ctSweepTimer = setTimeout(ctSweepTick, ctSweepHasOpenWork() ? CT_SWEEP_INTERVAL_MS : CT_SWEEP_IDLE_MS);
      });
  };
  if (ctSweepEnabled) ctSweepTimer = setTimeout(ctSweepTick, CT_SWEEP_INTERVAL_MS);
  if (!ctSweepEnabled) {
    console.info(JSON.stringify({ level: 'info', event: 'crossTradeSweepDisabled', reason: 'non-production environment', override: 'CT_SWEEP_ENABLED=1 to force' }));
  }
  app.locals.dispose = () => {
    clearInterval(scheduler);
    if (ctSweepTimer) clearTimeout(ctSweepTimer);
    for (const timer of ctVerifyTimers.values()) clearTimeout(timer);
    ctVerifyTimers.clear();
  };

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const isError = err instanceof Error;
    console.error(JSON.stringify({
      level: 'error',
      event: 'expressUnhandledError',
      name: isError ? err.name : undefined,
      message: isError ? err.message : String(err),
      stack: isError ? err.stack : undefined,
    }));
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
