import { createHash } from 'node:crypto';
import type { TradersPostPayload } from './webhook.js';

// CrossTrade webhook destination (https://crosstrade.io/docs/api/webhook-trading).
// The bridge's internal TradersPost-shaped payload is converted to CrossTrade's
// flat JSON command vocabulary. The secret key travels in the `key` body field —
// no Authorization header is used.
export interface CrossTradeDestination {
  webhookUrl: string;
  secretKey: string;
  // The NinjaTrader account name as NT8 reports it (e.g. Sim101).
  accountName: string;
}

export type CrossTradeMessage = Record<string, string | number | boolean>;

// CrossTrade dispatch activates only on a COMPLETE credential pair (webhook
// URL + secret key). Partial rows must never select the CT path or suppress
// TradersPost-side behaviour — every caller goes through this one predicate.
export function isCrossTradeConfigured(destination?: {
  crossTradeWebhookUrl?: string;
  crossTradeSecretKey?: string;
  crossTradeEnabled?: boolean;
} | null): boolean {
  return Boolean(
    destination?.crossTradeWebhookUrl
    && destination?.crossTradeSecretKey
    && destination?.crossTradeEnabled !== false,
  );
}

// The outbound message carries the secret in `key`. Log/event surfaces show
// the wire shape for debugging, but the credential must never leave the POST
// body — swap it before persisting or emitting.
export function redactCrossTradeMessage(message: CrossTradeMessage): CrossTradeMessage {
  return 'key' in message ? { ...message, key: '[redacted]' } : message;
}

// CrossTrade rejects values containing ';', '=' or control characters, so
// record-keeping notes are emitted as 'key:value' pairs with those stripped.
const sanitizeField = (value: unknown): string =>
  String(value).replace(/[;=\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();

const crossTradeNotes = (payload: TradersPostPayload, source?: string): string | undefined => {
  const parts: string[] = [];
  const extras = payload.extras ?? {};
  // extras.source already carries the dispatch origin when present — don't
  // double it with a src: prefix.
  if (source && extras.source == null) parts.push(`src:${sanitizeField(source)}`);
  if (payload.bracketId) parts.push(`bracket:${sanitizeField(payload.bracketId)}`);
  for (const [key, value] of Object.entries(extras)) {
    if (value == null || typeof value === 'object') continue;
    parts.push(`${sanitizeField(key)}:${sanitizeField(value)}`);
  }
  const notes = parts.join(' ').slice(0, 400);
  return notes || undefined;
};

// Relative price helpers — takeProfit/stopLoss carry either an absolute price
// (limitPrice/stopPrice) or a magnitude (amount → ticks, percent → %).

// Tick-size table shared with the message builder: percent exits are resolved
// to absolute prices here so the wire always carries exact levels.
export function inferredTickSize(ticker: string): number {
  if (/^(MNQ|NQ|MES|ES)/i.test(ticker)) return 0.25;
  if (/^(RTY|M2K)/i.test(ticker)) return 0.1;   // russell ticks 0.10 pt
  if (/^(MYM|YM)/i.test(ticker)) return 1;     // dow ticks 1 pt
  if (/^(SIL|SI)/i.test(ticker)) return 0.005;
  if (/^(MGC|GC)/i.test(ticker)) return 0.1;
  if (/^(NG|MNG)/i.test(ticker)) return 0.001;
  if (/^MBT/i.test(ticker)) return 5;
  if (/^BT/i.test(ticker)) return 5;
  if (/^(CL|MCL|ZL)/i.test(ticker)) return 0.01;
  return 0.25;
}

export function roundToTick(price: number, tickSize: number): number {
  return Number((Math.round(price / tickSize) * tickSize).toFixed(10));
}

export function crossTradeExitPricesFromTicks(input: {
  action: 'buy' | 'sell';
  ticker: string;
  entryPrice: number;
  takeProfitTicks?: number;
  stopLossTicks?: number;
}): { takeProfitPrice?: number; stopLossPrice?: number } {
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0) return {};
  const direction = input.action === 'buy' ? 1 : -1;
  const tickSize = inferredTickSize(input.ticker);
  return {
    ...(input.takeProfitTicks != null
      ? { takeProfitPrice: roundToTick(input.entryPrice + direction * input.takeProfitTicks * tickSize, tickSize) }
      : {}),
    ...(input.stopLossTicks != null
      ? { stopLossPrice: roundToTick(input.entryPrice - direction * input.stopLossTicks * tickSize, tickSize) }
      : {}),
  };
}

const relativeOrAbsolute = (absolute: number | undefined, amount: number | undefined, percent: number | undefined): number | string | undefined => {
  if (absolute != null) return absolute;
  if (amount != null) return `${amount} ticks`;
  if (percent != null) return `${percent}%`;
  return undefined;
};

// Resolve a percent exit to the absolute price Ultra intended, anchored on the
// alert's own entry price — a percent left on the wire would re-anchor on the
// broker fill and let slippage move the bracket's levels.
const exitLevel = (
  absolute: number | undefined,
  amount: number | undefined,
  percent: number | undefined,
  anchor: number | undefined,
  tickSize: number,
  sign: 1 | -1,
): number | string | undefined => {
  if (absolute != null) return absolute;
  if (percent != null && anchor != null && Number.isFinite(anchor)) {
    // Same convention as the server: <0.01 is already a fraction, larger
    // values are true percents (guards mis-scaled Pine values).
    const frac = percent < 0.01 ? percent : percent / 100;
    return roundToTick(anchor * (1 + sign * frac), tickSize);
  }
  if (amount != null) return `${amount} ticks`;
  if (percent != null) return `${percent}%`;
  return undefined;
};

const ORDER_TYPE_MAP: Record<string, string> = {
  market: 'market',
  limit: 'limit',
  stop: 'stopmarket',
  stop_limit: 'stoplimit',
  trailing_stop: 'trailingstop',
};

export function toCrossTradeMessage(
  payload: TradersPostPayload,
  destination: CrossTradeDestination,
  source?: string,
): CrossTradeMessage {
  const base: CrossTradeMessage = {
    key: destination.secretKey,
    // This integration only routes through the CrossTrade NT8 Add-On.
    destination: 'nt8',
    account: destination.accountName,
    instrument: payload.ticker,
  };
  const notes = crossTradeNotes(payload, source);
  if (notes) base.notes = notes;

  if (payload.action === 'cancel') {
    // Instrument-scoped working-order sweep — TradersPost 'cancel' equivalent.
    return { ...base, command: 'cancelorders' };
  }
  if (payload.action === 'exit') {
    // Flatten the position on this instrument — TradersPost 'exit' equivalent.
    return { ...base, command: 'flatten' };
  }

  const message: CrossTradeMessage = {
    ...base,
    command: 'place',
    action: payload.action,
    qty: payload.quantity ?? 1,
    order_type: ORDER_TYPE_MAP[payload.orderType ?? 'market'] ?? 'market',
  };
  const limitPrice = payload.limitPrice ?? payload.price;
  const stopPrice = payload.stopPrice;
  if (message.order_type === 'limit' && limitPrice != null) message.limit_price = limitPrice;
  if (message.order_type === 'stopmarket' && stopPrice != null) message.stop_price = stopPrice;
  if (message.order_type === 'stoplimit') {
    if (stopPrice != null) message.stop_price = stopPrice;
    if (limitPrice != null) message.limit_price = limitPrice;
  }
  if (message.order_type === 'trailingstop') {
    if (stopPrice != null) message.stop_price = stopPrice;
    const trailOffset = payload.trailAmount ?? payload.stopLoss?.amount;
    if (trailOffset != null) message.trail_offset = trailOffset;
  }
  // NT8 requires TIF on every place command — 'day' matches how we treat
  // entries (they're managed/flattened within the session by our own cleanup).
  message.tif = 'day';

  // NT8 ATM strategy grouping (https://crosstrade.io/docs/webhooks/commands/place-order):
  // opt-in only. Most ranges have no breakeven rule and send plain entries —
  // the OCO pairing below is native and needs no ATM. A range whose strategy
  // requires breakeven gets appendAtm injected at dispatch from its range
  // configuration (breakEvenEnabled); its atm_strategy names the NT8
  // template that must exist or NT8 rejects the place — an intentional failure,
  // since a BE range without its template would run unprotected. extras.
  // atmStrategy overrides the template name; extras.appendAtm=false opts out;
  // appendAtm=true with no name falls back to the range name then 'crosstrade'.
  const atmOptOut = payload.extras?.appendAtm === false
    || String(payload.extras?.appendAtm).toLowerCase() === 'false';
  const rawStrategy = payload.extras?.atmStrategy;
  const namedStrategy = typeof rawStrategy === 'string' && rawStrategy.trim()
    ? sanitizeField(rawStrategy) : undefined;
  const rangeName = typeof payload.extras?.rangeName === 'string' && payload.extras.rangeName.trim()
    ? sanitizeField(payload.extras.rangeName) : undefined;
  const appendAtmRequested = payload.extras?.appendAtm === true
    || String(payload.extras?.appendAtm).toLowerCase() === 'true';
  if (!atmOptOut && (namedStrategy ?? appendAtmRequested)) {
    message.atm_strategy = namedStrategy ?? rangeName ?? 'crosstrade';
    message.append_atm = 'true';
  }

  // Explicit bracket legs only when no ATM owns the exits. Sending
  // take_profit/stop_loss alongside atm_strategy double-specifies the
  // bracket — the plain legs aren't linked to the strategy's exits, so a
  // breakeven stop-out can leave them working as orphans.
  if (!message.atm_strategy) {
    const direction = payload.action === 'buy' ? 1 : -1;
    const anchor = typeof payload.price === 'number' && payload.price > 0
      ? payload.price
      : (typeof payload.signalPrice === 'number' && payload.signalPrice > 0 ? payload.signalPrice : undefined);
    const tickSize = inferredTickSize(payload.ticker);
    const takeProfit = payload.takeProfit
      ? exitLevel(payload.takeProfit.limitPrice, payload.takeProfit.amount, payload.takeProfit.percent, anchor, tickSize, direction)
      : undefined;
    if (takeProfit != null) message.take_profit = takeProfit;
    const stopLoss = payload.stopLoss
      ? exitLevel(payload.stopLoss.stopPrice, payload.stopLoss.amount, payload.stopLoss.percent, anchor, tickSize, -direction as 1 | -1)
      : undefined;
    if (stopLoss != null) message.stop_loss = stopLoss;
    if (payload.stopLoss?.limitPrice != null) message.stop_loss_limit = payload.stopLoss.limitPrice;
  }

  // NT8 native OCO: both arms of a range share an oco_id, so when one entry
  // fills NinjaTrader cancels the other at the broker — no dependence on our
  // follow-up cancelorders dispatch. NT8 permanently burns an oco_id once its
  // group resolves, so the key must be unique per arming event: ULTRA arm
  // pairs share one bracket-id stem differing only in the -long/-short token
  // (e.g. 'ultra-v5.3-MNQ1!-<ms>-<seq>-long-arm-18'), so the stem with that
  // token removed groups the pair and is never reused. A bracket id with no
  // side token maps to itself — unpaired, which degrades to no OCO grouping
  // rather than a wrong one. extras.ocoId overrides the group key entirely;
  // extras.oco=false opts out.
  const ocoOptOut = payload.extras?.oco === false
    || String(payload.extras?.oco).toLowerCase() === 'false';
  const rawOco = payload.extras?.ocoId;
  const bracketStem = payload.bracketId?.replace(/-(long|short)(?=-|$)(?![\s\S]*-(?:long|short)(?=-|$))/, '');
  const ocoId = typeof rawOco === 'string' && rawOco.trim()
    ? sanitizeField(rawOco)
    : bracketStem?.trim()
      ? sanitizeField(bracketStem)
      : undefined;
  if (!ocoOptOut && ocoId) message.oco_id = ocoId;

  // CrossTrade tracks order_id for cancels/changes and forwards it as clOrdId —
  // the bracket id keeps our entries traceable on the broker side.
  if (payload.bracketId) message.order_id = payload.bracketId;
  return message;
}

export interface CrossTradeSendResult {
  statusCode: number;
  body: string;
  // Strict success: CrossTrade responses must report success explicitly — same
  // rule as TradersPost. Absence of a success flag is not treated as delivered.
  success: boolean;
  failureMessage?: string;
}

export function interpretCrossTradeResponse(statusCode: number, body: string): CrossTradeSendResult {
  let parsed: { success?: boolean; failureMessage?: string; error?: string; message?: string } | undefined;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const failureMessage = parsed?.failureMessage ?? parsed?.error;
  const success = statusCode >= 200 && statusCode < 300 && parsed?.success === true;
  return {
    statusCode,
    body,
    success,
    ...(failureMessage ? { failureMessage } : !success && parsed?.message ? { failureMessage: parsed.message } : {}),
  };
}

// --- CrossTrade REST read API ---------------------------------------------
// Separate from the webhook surface: Bearer-token GETs under /v1/api that the
// connected NT8 add-on answers live (NT8 must be running). Used for operator
// inspection and reconciliation — e.g. querying an order by the order_id we
// supplied at placement (CrossTrade stores it in UserData/AutomatedTradingOrderId).

export interface CrossTradeOrderRow {
  id: string;
  ocoId?: string;
  name?: string;
  account?: string;
  instrument?: string;
  orderType?: string;
  orderState?: string;
  orderAction?: string;
  quantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  filled?: number;
  averageFillPrice?: number;
  timeInForce?: string;
  time?: string;
  ownerStrategy?: { id: string | null; name: string | null; displayName: string | null };
  [key: string]: unknown;
}

export interface CrossTradePositionRow {
  account?: string;
  instrument?: string;
  quantity?: number;
  marketPosition?: string;
  averagePrice?: number;
  [key: string]: unknown;
}

export interface CrossTradeApiResult {
  ok: boolean;
  statusCode: number | null;
  data?: Record<string, unknown>;
  error?: string;
}

// The API base derives from the configured webhook URL's origin — webhooks hit
// /v1/send/… while reads live under /v1/api on the same host.
export function crossTradeApiBase(destination: Pick<CrossTradeDestination, 'webhookUrl'>): string | undefined {
  try {
    return `${new URL(destination.webhookUrl).origin}/v1/api`;
  } catch {
    return undefined;
  }
}

const CROSSTRADE_API_TIMEOUT_MS = 10_000;

// CrossTrade budgets REST reads per user key (~3 rps / 180 rpm, burst ~20)
// and answers 429 with Retry-After. Multiple accounts can share one key, so
// the limiter keys on the credential, not the account: calls serialize per
// key with minimum spacing, and a 429 parks the whole key for the server-
// supplied cooldown instead of letting queued calls retry into the wall.
const CT_API_MIN_INTERVAL_MS = Math.max(25, Number(process.env.CT_API_MIN_INTERVAL_MS) || 350);
const CT_API_DEFAULT_RETRY_AFTER_MS = Math.max(500, Number(process.env.CT_API_DEFAULT_RETRY_AFTER_MS) || 5_000);
const CT_API_MAX_RETRY_AFTER_MS = 5 * 60_000;

interface CrossTradeRateState { chain: Promise<unknown>; nextAt: number }
const crossTradeRateStates = new Map<string, CrossTradeRateState>();

// The rate bucket belongs to the credential — never key shared state on the
// raw secret, hash it.
const crossTradeRateKey = (destination: CrossTradeDestination): string =>
  createHash('sha256').update(destination.secretKey).digest('hex').slice(0, 16);

export function resetCrossTradeRateLimiterForTests(): void {
  crossTradeRateStates.clear();
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function crossTradeRetryAfterMs(res: Response, parsed: Record<string, unknown> | undefined): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(Math.max(0, seconds * 1000), CT_API_MAX_RETRY_AFTER_MS);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), CT_API_MAX_RETRY_AFTER_MS);
  }
  // CT also returns retryAfter in the body (seconds); tolerate a ms value.
  const body = Number(parsed?.retryAfter ?? parsed?.retry_after);
  if (Number.isFinite(body) && body > 0) {
    return Math.min(body > 1000 ? body : body * 1000, CT_API_MAX_RETRY_AFTER_MS);
  }
  return CT_API_DEFAULT_RETRY_AFTER_MS;
}

async function crossTradeApiGetThrottled(
  destination: CrossTradeDestination,
  url: string,
  state: CrossTradeRateState,
): Promise<CrossTradeApiResult> {
  const wait = state.nextAt - Date.now();
  if (wait > 0) await sleep(wait);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${destination.secretKey}`,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(CROSSTRADE_API_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, statusCode: null, error: error instanceof Error ? error.message : String(error) };
  }
  // Space subsequent request starts regardless of the outcome.
  state.nextAt = Date.now() + CT_API_MIN_INTERVAL_MS;
  const body = await res.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    parsed = undefined;
  }
  if (res.status === 429) {
    const retryMs = crossTradeRetryAfterMs(res, parsed);
    state.nextAt = Math.max(state.nextAt, Date.now() + retryMs);
    const message = (parsed?.error ?? parsed?.failureMessage ?? parsed?.message) as string | undefined;
    return {
      ok: false,
      statusCode: 429,
      error: message || `CrossTrade rate limit exceeded — cooling down ${Math.ceil(retryMs / 1000)}s`,
    };
  }
  if (!res.ok) {
    const message = (parsed?.error ?? parsed?.failureMessage ?? parsed?.message ?? body.slice(0, 300)) as string | undefined;
    return { ok: false, statusCode: res.status, error: message || `HTTP ${res.status}` };
  }
  // A 2xx is not proof the read succeeded — only an explicit success:true
  // counts. Malformed or flag-less bodies are failures, otherwise an empty
  // payload would masquerade as "no orders/positions" and hide live state.
  if (parsed === undefined) {
    return { ok: false, statusCode: res.status, error: 'CrossTrade returned an unreadable response' };
  }
  if (parsed.success !== true) {
    return { ok: false, statusCode: res.status, data: parsed, error: String(parsed.error ?? parsed.failureMessage ?? 'CrossTrade response did not report success') };
  }
  return { ok: true, statusCode: res.status, data: parsed };
}

async function crossTradeApiGet(destination: CrossTradeDestination, path: string): Promise<CrossTradeApiResult> {
  const base = crossTradeApiBase(destination);
  if (!base) return { ok: false, statusCode: null, error: 'invalid CrossTrade webhook URL' };
  // CrossTrade issues a single Secret Key that doubles as the Bearer token for
  // the REST API and webhooks.
  if (!destination.secretKey) return { ok: false, statusCode: null, error: 'no CrossTrade secret key configured' };
  const key = crossTradeRateKey(destination);
  let state = crossTradeRateStates.get(key);
  if (!state) {
    state = { chain: Promise.resolve(), nextAt: 0 };
    crossTradeRateStates.set(key, state);
  }
  const run = state.chain.then(() => crossTradeApiGetThrottled(destination, `${base}${path}`, state!));
  // The stored chain never rejects — a poisoned tail would break every later call.
  state.chain = run.then(() => undefined, () => undefined);
  return run;
}

export function fetchCrossTradeOrders(destination: CrossTradeDestination, activeOnly = false): Promise<CrossTradeApiResult> {
  return crossTradeApiGet(destination, `/accounts/${encodeURIComponent(destination.accountName)}/orders?activeOnly=${activeOnly}`);
}

export function fetchCrossTradePositions(destination: CrossTradeDestination): Promise<CrossTradeApiResult> {
  return crossTradeApiGet(destination, `/accounts/${encodeURIComponent(destination.accountName)}/positions`);
}

// Lists the NT8 ATM strategy template names saved in the local NinjaTrader
// install. Not account-scoped — templates live in the user data directory.
// The bridge attaches them by name for break-even ranges, so this is the
// preflight source for "does the required template actually exist?".
export function fetchCrossTradeAtmTemplates(destination: CrossTradeDestination): Promise<CrossTradeApiResult> {
  return crossTradeApiGet(destination, '/atm-templates');
}

// orderId accepts either the NT8-assigned id or our caller-supplied order_id
// (the bracket id), which CrossTrade resolves from the order's UserData.
export function fetchCrossTradeOrder(destination: CrossTradeDestination, orderId: string): Promise<CrossTradeApiResult> {
  return crossTradeApiGet(destination, `/accounts/${encodeURIComponent(destination.accountName)}/orders/${encodeURIComponent(orderId)}`);
}

// Maps an NT8 orderState string onto the bookkeeping states the ledger
// understands. 'unknown' means "the read succeeded but the state is
// unrecognized" — callers must treat it as no-evidence, never as absence.
export type CrossTradeObservedState = 'working' | 'filled' | 'cancelled' | 'rejected' | 'unknown';
export function mapNt8OrderState(orderState: string | undefined | null): CrossTradeObservedState {
  const s = (orderState ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (['filled', 'partfilled', 'partialfill', 'partiallyfilled'].includes(s)) return 'filled';
  if (['cancelled', 'canceled'].includes(s)) return 'cancelled';
  if (s === 'rejected') return 'rejected';
  if (['working', 'accepted', 'submitted', 'triggerpending', 'changepending', 'pending', 'initialized', 'suspended'].includes(s)) return 'working';
  return 'unknown';
}

// The id NT8 echoes back is the order_id we sent on the wire — the bracket
// id, plus '-a<n>' when Ultra reused a bracket id after a terminal close and
// the re-armed resend needed a fresh wire id (NT8 permanently burns used
// ids). The broker_orders ledger's own order_id additionally carries '-r<n>'
// retry-attempt suffixes that never left the bridge. Both directions reach
// this matcher: callers pass ledger order_ids (newest attempt) or the logical
// bracket_id (monitor/journal rows), so normalize ledger suffixes off and
// accept resend forms on the NT8 side.
export function ctWireOrderId(ledgerOrWireId: string): string {
  return ledgerOrWireId.replace(/-r\d+$/, '');
}

const ctResendMatch = (stem: string): ((value: string) => boolean) => {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const resend = new RegExp(`^${escaped}-a\\d+$`);
  return (value: string) => value === stem || resend.test(value);
};

// NT8 wraps the echoed order id in a userData XML blob —
// <NinjaTrader><AutomatedTradingOrderId>id</AutomatedTradingOrderId></NinjaTrader>
// — so the raw field never equals the wire id. Extract before comparing.
export function ctUserDataOrderId(userData: unknown): string | undefined {
  if (typeof userData !== 'string') return undefined;
  return /<AutomatedTradingOrderId>([^<]+)<\/AutomatedTradingOrderId>/.exec(userData)?.[1]?.trim();
}

/* Matches a CT book row against the order id we sent on the wire. */
export function matchesCtOrderId(row: CrossTradeOrderRow, wireId: string, action?: string): boolean {
  const idMatches = ctResendMatch(ctWireOrderId(wireId));
  if ([row.id, row.orderId, ctUserDataOrderId(row.userData), row.automatedTradingOrderId, row.name]
    .some((value) => typeof value === 'string' && (value === wireId || idMatches(value)))) return true;
  // NT8 only echoes our order_id on ATM-attached orders — plain entries get a
  // generated AutomatedTradingOrderId, so the exact match above misses them.
  // The oco_id we sent carries the bracket stem; oco_id + order action
  // uniquely identifies the leg (buy↔long, sell↔short).
  if (!action || typeof row.ocoId !== 'string' || !row.ocoId) return false;
  const stem = ctWireOrderId(wireId).replace(/-(long|short)(?=-|$)(?![\s\S]*-(?:long|short)(?=-|$))/, '');
  return ctResendMatch(stem)(row.ocoId)
    && String(row.orderAction ?? '').toLowerCase() === action.toLowerCase();
}
