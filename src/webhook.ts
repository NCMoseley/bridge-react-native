import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { OrderDraft, TradeEventType, TradeOutcome } from './types.js';

const takeProfitSchema = z.object({
  limitPrice: z.number().positive().optional(),
  amount: z.number().positive().optional(),
  percent: z.number().positive().optional(),
}).strict();

const stopLossSchema = z.object({
  type: z.enum(['stop', 'stop_limit', 'trailing_stop']).optional(),
  stopPrice: z.number().positive().optional(),
  limitPrice: z.number().positive().optional(),
  amount: z.number().positive().optional(),
  percent: z.number().positive().optional(),
}).strict();

const commonPayloadFields = {
  ticker: z.string().min(1).max(64),
  time: z.string().min(1).max(128).optional(),
  interval: z.string().min(1).max(32).optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
};

const tradersPostOrderTypeSchema = z.enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop']);
const tradersPostSentimentSchema = z.enum(['long', 'short', 'flat', 'bullish', 'bearish']);
const tradersPostQuantityTypeSchema = z.enum([
  'fixed_quantity',
  'dollar_amount',
  'risk_dollar_amount',
  'risk_percent',
  'percent_of_equity',
  'percent_of_position',
]);

const tradersPostOrderFields = {
  sentiment: tradersPostSentimentSchema.optional(),
  quantity: z.number().positive().optional(),
  quantityType: tradersPostQuantityTypeSchema.optional(),
  price: z.number().positive().optional(),
  signalPrice: z.number().positive().optional(),
  orderType: tradersPostOrderTypeSchema.optional(),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  trailAmount: z.number().positive().optional(),
  trailPercent: z.number().positive().optional(),
  takeProfit: takeProfitSchema.optional(),
  stopLoss: stopLossSchema.optional(),
  cancel: z.boolean().optional(),
  cancelOrderType: tradersPostOrderTypeSchema.optional(),
  bracketId: z.string().min(1).max(256).optional(),
  bracketSide: z.enum(['long', 'short']).optional(),
} as const;

const entryPayloadSchema = z.object({
  ...commonPayloadFields,
  action: z.enum(['buy', 'sell']),
  ...tradersPostOrderFields,
}).passthrough().superRefine(validateTradersPostOrderFields);

const cancelPayloadSchema = z.object({
  ...commonPayloadFields,
  action: z.literal('cancel'),
  cancelOrderType: tradersPostOrderTypeSchema.optional(),
  bracketId: z.string().max(256).optional(),
  bracketSide: z.enum(['long', 'short']).optional(),
  tradeId: z.string().max(256).optional(),
  quantity: z.number().positive().optional(),
  cancel: z.boolean().optional(),
}).passthrough();

const exitPayloadSchema = z.object({
  ...commonPayloadFields,
  action: z.literal('exit'),
  sentiment: tradersPostSentimentSchema.optional(),
  quantity: z.number().positive().optional(),
  quantityType: tradersPostQuantityTypeSchema.optional(),
  price: z.number().positive().optional(),
  signalPrice: z.number().positive().optional(),
  orderType: tradersPostOrderTypeSchema.optional(),
  limitPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  trailAmount: z.number().positive().optional(),
  trailPercent: z.number().positive().optional(),
  cancel: z.boolean().optional(),
  cancelOrderType: tradersPostOrderTypeSchema.optional(),
  bracketId: z.string().min(1).max(256).optional(),
  bracketSide: z.enum(['long', 'short']).optional(),
}).passthrough().superRefine(validateTradersPostOrderFields);

export const tradersPostPayloadSchema = z.discriminatedUnion('action', [
  entryPayloadSchema,
  cancelPayloadSchema,
  exitPayloadSchema,
]);

export type EntryPayload = z.infer<typeof entryPayloadSchema>;
export type CancelPayload = z.infer<typeof cancelPayloadSchema>;
export type ExitPayload = z.infer<typeof exitPayloadSchema>;
export type TradersPostPayload =
  | EntryPayload
  | CancelPayload
  | ExitPayload;
export type ControlPayload = CancelPayload | ExitPayload;
export type DraftEligiblePayload = EntryPayload & {
  quantity: number;
  orderType?: 'market' | 'limit' | 'stop' | 'stop_limit';
};

const lifecycleEventTypes = [
  'entry_armed',
  'entry_filled',
  'entry_cancelled',
  'exit_filled',
  'trade_closed',
] as const satisfies readonly TradeEventType[];

const lifecycleOutcomes = ['win', 'loss', 'breakeven'] as const satisfies readonly TradeOutcome[];

export function decimalToIntegerCents(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.toString());
  if (!match) return undefined;

  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  const signedCents = match[1] === '-' ? -cents : cents;
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (signedCents > maximum || signedCents < -maximum) return undefined;
  return Number(signedCents);
}

const lifecyclePayloadSchemaBase = z.object({
  eventType: z.enum(lifecycleEventTypes),
  eventId: z.string().trim().min(1).max(256),
  tradeId: z.string().trim().min(1).max(256),
  ticker: z.string().trim().min(1).max(64),
  action: z.enum(['buy', 'sell', 'cancel', 'exit']).optional(),
  side: z.enum(['long', 'short']).optional(),
  quantity: z.number().finite().positive(),
  entryPrice: z.number().finite().positive().optional(),
  exitPrice: z.number().finite().positive().optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  closedAt: z.iso.datetime({ offset: true }).optional(),
  realizedTicks: z.number().finite().optional(),
  realizedDollars: z.number().finite().optional(),
  outcome: z.enum(lifecycleOutcomes).optional(),
  extras: z.record(z.string(), z.unknown()),
}).strict().superRefine((payload, ctx) => {
  const rangeName = payload.extras.rangeName;
  if (typeof rangeName !== 'string' || rangeName.trim().length === 0 || rangeName.length > 256) {
    ctx.addIssue({
      code: 'custom',
      path: ['extras', 'rangeName'],
      message: 'lifecycle events require extras.rangeName',
    });
  }
  if (!payload.side && !payload.action) {
    ctx.addIssue({
      code: 'custom',
      path: ['side'],
      message: 'lifecycle events require side or action context',
    });
  }
  if (!payload.side && (payload.action === 'cancel' || payload.action === 'exit')) {
    ctx.addIssue({
      code: 'custom',
      path: ['side'],
      message: 'cancel and exit lifecycle events require side context',
    });
  }
  if (payload.eventType !== 'trade_closed') return;

  if (!payload.closedAt) {
    ctx.addIssue({ code: 'custom', path: ['closedAt'], message: 'trade_closed requires closedAt' });
  }
  if (payload.realizedTicks == null) {
    ctx.addIssue({ code: 'custom', path: ['realizedTicks'], message: 'trade_closed requires realizedTicks' });
  } else if (decimalToIntegerCents(payload.realizedTicks) == null) {
    ctx.addIssue({ code: 'custom', path: ['realizedTicks'], message: 'realizedTicks must have at most two decimal places and be safely representable' });
  }
  if (payload.realizedDollars == null) {
    ctx.addIssue({ code: 'custom', path: ['realizedDollars'], message: 'trade_closed requires realizedDollars' });
  } else if (decimalToIntegerCents(payload.realizedDollars) == null) {
    ctx.addIssue({ code: 'custom', path: ['realizedDollars'], message: 'realizedDollars must have at most two decimal places and be safely representable as cents' });
  }
  if (!payload.outcome) {
    ctx.addIssue({ code: 'custom', path: ['outcome'], message: 'trade_closed requires outcome' });
  }
});

export const lifecyclePayloadSchema = lifecyclePayloadSchemaBase;
export type LifecyclePayload = z.infer<typeof lifecyclePayloadSchema>;

export const proxyPayloadSchema = z.union([tradersPostPayloadSchema, lifecyclePayloadSchema]);

// Ultra's bracket id is ticker+epoch scoped, not range scoped — two ranges
// anchored to the same price box mint identical ids and collapse into one
// physical NT8 bracket. Ultra ≥5.3 mints range-scoped ids natively; older
// alerts get the same normalization here at ingest, keyed off extras.rangeName.
// The slug is an escaped form of the normalized range name. The same
// normalization the database applies first (stripControlCharacters + trim +
// whitespace collapse — inlined here because this module is upstream of
// database.ts) so an alert spelled 'A\tB' or 'A  B' converges on the stored
// 'A B' slug instead of a parallel identity. Case is preserved: tracked_ranges
// is COLLATE BINARY so 'A' and 'a' are distinct ranges and need distinct
// slugs. Escapes are FIXED-WIDTH so the encoding is injective over arbitrary
// Unicode: '-' → '--', cp ≤ 0xFF → '-XX', cp > 0xFF → '-uXXXX'. ('A\fE'→'AE'
// after control-strip, 'Aî'→'A-EE' — no variable-width collision.) Ids that
// carry the slug in the native position pass through; only the incoming
// format's identity is rewritten — the broker wire id is what matters. The
// Pine helper implements the same scheme for the printable-ASCII set range
// names actually use; exotic codepoints collapse to -5F there, which diverges
// cosmetically but never collides (ingest re-prefixes, still unique per range).
const rangeNameSlug = (name: string): string =>
  [...name.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ')].map((c) => {
    if (c === '-') return '--';
    if (/[A-Za-z0-9]/.test(c)) return c;
    const cp = c.codePointAt(0)!;
    return cp <= 0xFF
      ? `-${cp.toString(16).toUpperCase().padStart(2, '0')}`
      : `-u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }).join('');

const idCarriesRange = (id: string, slug: string): boolean => {
  // Explicit prefix — the shape this function itself writes (`<slug>-<id>`).
  // The remainder can't begin with '-': a slug never ends in one ('-' encodes
  // as '--'), so 'SIM--ALL--MNQ-x' under range 'SIM' belongs to a LONGER slug
  // ('SIM-ALL-MNQ'), not this one — claiming it would collide prefixes across
  // ranges. Reject and re-prefix; the result stays unique per range.
  const prefixed = id.slice(slug.length + 1);
  // ...and the remainder can't be '-'-leading (a longer range's slug —
  // 'SIM--ALL--MNQ-x' is 'SIM-ALL-MNQ' scope, not 'SIM') nor a version token:
  // for range 'ultra' a native 'ultra-v5.4-...' id would otherwise satisfy
  // the prefix claim and skip scoping entirely.
  if (id.startsWith(slug + '-') && !/^-|^v\d/.test(prefixed)) return true;
  // Native Ultra shape: ultra-vX-<slug>-<ticker>-<epoch>-<seq>. The slug can
  // itself contain '-', so locate it positionally after the version token —
  // which has no '-'. Only v5.3+ mints the slug there: on v5.2-and-earlier ids
  // that position holds the ticker, and a ticker matching the range slug is
  // NOT proof of scoping (that ambiguity is the collision being fixed).
  const m = id.match(/^ultra-v(\d+)(?:\.(\d+))?-/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? '0');
  if (major < 5 || (major === 5 && minor < 3)) return false;
  const versionEnd = m[0].length;
  if (id.slice(versionEnd) === slug) return true;
  if (!id.startsWith(slug + '-', versionEnd)) return false;
  // Residual ambiguity: a pre-slug v5.3 id puts the TICKER where the slug
  // sits, and a range named exactly like its ticker (e.g. range 'MNQ1',
  // ticker 'MNQ1') matches positionally. Proof of the native shape is
  // structural — <slug>-<ticker>-<epoch>-<seq>: the ticker segment contains a
  // non-digit (letters/'/!'), epoch and seq are pure digits. A pre-slug tail
  // like '1759-3-long-arm-1' puts digits in the ticker slot → not native.
  const rest = id.slice(versionEnd + slug.length + 1);
  return /^(?=[^-]*[^\d-])[^-]+-\d+(?:-|$)/.test(rest);
};

// Exported for DB-side callers that need to map a raw incoming id onto the
// normalized row it was stored under (bidirectional fallback in
// resolveBracketMonitorId). Name keeps the verb-noun style distinct from the
// private encoder.
export const rangeSlugForLookup = rangeNameSlug;

export function scopePayloadIdsToRange<T extends { extras?: Record<string, unknown> }>(payload: T, rangeName?: string): T {
  const name = rangeName ?? payload.extras?.rangeName;
  if (typeof name !== 'string') return payload;
  const slug = rangeNameSlug(name);
  if (!slug) return payload;
  for (const key of ['bracketId', 'tradeId', 'eventId', 'armId'] as const) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length > 0 && !idCarriesRange(value, slug)) {
      (payload as Record<string, unknown>)[key] = `${slug}-${value}`;
    }
  }
  return payload;
}

// The inverse of scopePayloadIdsToRange: given a normalized id, recover the
// pre-normalization value so a pre-deploy monitor/ledger row can still be
// matched. Only strips a genuine `<slug>-` prefix — ids the code itself
// prefixed at ingest. A native ultra id whose payload got no prefix carries
// the slug inside the id, not before it, and returns itself.
export function unscopeIdForRange(id: string, rangeName: string): string {
  const slug = rangeNameSlug(rangeName);
  if (!slug || !id.startsWith(slug + '-')) return id;
  const rest = id.slice(slug.length + 1);
  // Same discriminator as ingestion, inverted: '-'-leading rests belong to a
  // longer range's slug, and a 'v<digit>' rest means the id itself is a native
  // ultra-v* id (range 'ultra' would otherwise strip its version marker off).
  return /^-|^v\d/.test(rest) ? id : rest;
}

export function isLifecyclePayload(payload: z.infer<typeof proxyPayloadSchema>): payload is LifecyclePayload {
  if (!payload || typeof payload !== 'object') return false;
  const eventType = (payload as Record<string, unknown>).eventType;
  const eventId = (payload as Record<string, unknown>).eventId;
  const tradeId = (payload as Record<string, unknown>).tradeId;
  return (
    typeof eventType === 'string' &&
    lifecycleEventTypes.includes(eventType as typeof lifecycleEventTypes[number]) &&
    typeof eventId === 'string' &&
    eventId.length > 0 &&
    typeof tradeId === 'string' &&
    tradeId.length > 0
  );
}

export function lifecycleSide(payload: LifecyclePayload): 'long' | 'short' {
  if (payload.side) return payload.side;
  return payload.action === 'buy' ? 'long' : 'short';
}

export function isDraftEligiblePayload(payload: TradersPostPayload): payload is DraftEligiblePayload {
  return (payload.action === 'buy' || payload.action === 'sell')
    && payload.quantity != null
    && payload.orderType !== 'trailing_stop';
}

export function strategyStopMetadata(
  extras: Record<string, unknown> | undefined,
): Pick<OrderDraft, 'strategyStopPrice' | 'strategyStopMode'> {
  const strategyStopPrice = extras?.strategyStopPrice;
  if (typeof strategyStopPrice !== 'number' || !Number.isFinite(strategyStopPrice) || strategyStopPrice <= 0) {
    return {};
  }

  const strategyStopMode = extras?.strategyStopMode;
  return {
    strategyStopPrice,
    ...(strategyStopMode === 'close_confirmed' || strategyStopMode === 'intrabar' ? { strategyStopMode } : {}),
  };
}

export function toDraft(
  userId: string,
  payload: DraftEligiblePayload,
  account?: { id: string; name: string },
): Omit<OrderDraft, 'id' | 'status' | 'receivedAt'> {
  const serialized = JSON.stringify(payload);
  const orderLeg = typeof payload.extras?.orderLeg === 'string' ? payload.extras.orderLeg : 'single';
  const bracketOrderPrice = payload.stopPrice ?? payload.limitPrice ?? 'market';
  const accountPart = account ? `:${account.id}` : '';
  const idempotencyKey = payload.bracketId
    ? `${payload.bracketId}:${payload.action}:${bracketOrderPrice}:${orderLeg}:${payload.time ?? 'notime'}${accountPart}`
    : createHash('sha256').update(serialized + accountPart).digest('hex');

  return {
    userId,
    idempotencyKey,
    ticker: payload.ticker,
    action: payload.action,
    ...(normalizeDraftSentiment(payload.sentiment) ? { sentiment: normalizeDraftSentiment(payload.sentiment) } : {}),
    quantity: payload.quantity,
    orderType: payload.orderType ?? 'market',
    ...(payload.signalPrice != null || payload.price != null ? { signalPrice: payload.signalPrice ?? payload.price } : {}),
    ...(payload.limitPrice != null ? { limitPrice: payload.limitPrice } : {}),
    ...(payload.stopPrice != null ? { stopPrice: payload.stopPrice } : {}),
    ...(payload.takeProfit ? { takeProfit: payload.takeProfit } : {}),
    ...(payload.stopLoss ? { stopLoss: payload.stopLoss } : {}),
    ...strategyStopMetadata(payload.extras),
    ...(payload.bracketId ? { bracketId: payload.bracketId } : {}),
    ...(payload.bracketSide ? { bracketSide: payload.bracketSide } : {}),
    ...(typeof payload.extras?.rangeName === 'string' ? { rangeName: payload.extras.rangeName } : {}),
    ...(orderLeg !== 'single' ? { orderLeg } : {}),
    ...(account ? { accountId: account.id, accountName: account.name } : {}),
  };
}

export function toCancellationReminderDraft(
  userId: string,
  payload: CancelPayload,
  account?: { id: string; name: string },
): Omit<OrderDraft, 'id' | 'status' | 'receivedAt'> {
  const rangeName = typeof payload.extras?.rangeName === 'string' ? payload.extras.rangeName : undefined;
  const accountPart = account ? `:${account.id}` : '';
  const idempotencyKey = payload.bracketId
    ? `${payload.bracketId}:cancel:${rangeName ?? 'unassigned'}${accountPart}`
    : createHash('sha256').update(JSON.stringify(payload) + accountPart).digest('hex');

  return {
    userId,
    idempotencyKey,
    ticker: payload.ticker,
    action: 'cancel',
    quantity: 0,
    orderType: 'cancel',
    ...(payload.bracketId ? { bracketId: payload.bracketId } : {}),
    ...(payload.bracketSide ? { bracketSide: payload.bracketSide } : {}),
    ...(rangeName ? { rangeName } : {}),
    ...(account ? { accountId: account.id, accountName: account.name } : {}),
    cancellationMessage: `Cancel opposite entry${rangeName ? ` for ${rangeName}` : ''}`,
  };
}

function validateTradersPostOrderFields(
  payload: {
    action: string;
    orderType?: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop';
    limitPrice?: number;
    stopPrice?: number;
    trailAmount?: number;
    trailPercent?: number;
  },
  ctx: z.RefinementCtx,
): void {
  if (payload.orderType === 'limit' && payload.limitPrice == null) {
    ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'limit orders require limitPrice' });
  }
  if ((payload.orderType === 'stop' || payload.orderType === 'stop_limit') && payload.stopPrice == null) {
    ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'stop orders require stopPrice' });
  }
  if (payload.orderType === 'stop_limit' && payload.limitPrice == null) {
    ctx.addIssue({ code: 'custom', path: ['limitPrice'], message: 'stop limit orders require limitPrice' });
  }
  if (payload.orderType === 'trailing_stop' && payload.trailAmount == null && payload.trailPercent == null) {
    ctx.addIssue({ code: 'custom', path: ['trailAmount'], message: 'trailing stop orders require trailAmount or trailPercent' });
  }
}

function normalizeDraftSentiment(
  sentiment: 'long' | 'short' | 'flat' | 'bullish' | 'bearish' | undefined,
): 'long' | 'short' | 'flat' | undefined {
  if (sentiment === 'bullish') return 'long';
  if (sentiment === 'bearish') return 'short';
  return sentiment;
}
