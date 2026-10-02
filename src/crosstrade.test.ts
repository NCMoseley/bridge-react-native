import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  crossTradeApiBase,
  crossTradeExitPricesFromTicks,
  ctUserDataOrderId,
  ctWireOrderId,
  fetchCrossTradeOrder,
  fetchCrossTradeOrders,
  fetchCrossTradePositions,
  interpretCrossTradeResponse,
  isCrossTradeConfigured,
  mapNt8OrderState,
  matchesCtOrderId,
  redactCrossTradeMessage,
  toCrossTradeMessage,
  type CrossTradeDestination,
} from './crosstrade.js';
import type { TradersPostPayload } from './webhook.js';

const DESTINATION: CrossTradeDestination = {
  webhookUrl: 'https://app.crosstrade.io/v1/send/uid/channel',
  secretKey: 'secret-abc',
  accountName: 'TEST-ACCOUNT',
};

const payload = (overrides: Record<string, unknown> = {}): TradersPostPayload =>
  ({
    ticker: 'MNQ1!',
    action: 'buy',
    quantity: 1,
    orderType: 'stop',
    stopPrice: 24500.25,
    bracketId: 'bracket-1',
    extras: { rangeName: 'TEST RANGE' },
    ...overrides,
  }) as TradersPostPayload;

describe('toCrossTradeMessage', () => {
  it('converts a stop entry into a CrossTrade place command', () => {
    const message = toCrossTradeMessage(payload(), DESTINATION, 'proxy');
    expect(message).toMatchObject({
      key: 'secret-abc',
      destination: 'nt8',
      account: 'TEST-ACCOUNT',
      command: 'place',
      action: 'buy',
      instrument: 'MNQ1!',
      qty: 1,
      order_type: 'stopmarket',
      stop_price: 24500.25,
      order_id: 'bracket-1',
      tif: 'day',
    });
    expect(String(message.notes)).toContain('src:proxy');
    expect(String(message.notes)).toContain('rangeName:TEST RANGE');
    expect(String(message.notes)).toContain('bracket:bracket-1');
  });

  it('always routes through the NT8 Add-On', () => {
    const cancel = toCrossTradeMessage(payload({ action: 'cancel' }), DESTINATION);
    expect(cancel.destination).toBe('nt8');
    // The account field is the NT8 account name (e.g. Sim101).
    expect(cancel.account).toBe('TEST-ACCOUNT');
  });

  it('attaches ATM strategy only on explicit request (default: plain entries)', () => {
    // rangeName alone no longer attaches ATM — most ranges have no breakeven
    // rule and run plain OCO + TP/SL entries. The dispatch site injects
    // appendAtm only for ranges whose config has breakEvenEnabled.
    const plain = toCrossTradeMessage(payload(), DESTINATION);
    expect(plain.atm_strategy).toBeUndefined();
    expect(plain.append_atm).toBeUndefined();

    // appendAtm=true + rangeName → template named after the range.
    const grouped = toCrossTradeMessage(
      payload({ extras: { rangeName: 'TEST RANGE', appendAtm: true } }),
      DESTINATION,
    );
    expect(grouped.atm_strategy).toBe('TEST RANGE');
    expect(grouped.append_atm).toBe('true');

    // extras.atmStrategy overrides the group name.
    const named = toCrossTradeMessage(
      payload({ extras: { rangeName: 'TEST RANGE', atmStrategy: 'My ATM' } }),
      DESTINATION,
    );
    expect(named.atm_strategy).toBe('My ATM');
    expect(named.append_atm).toBe('true');

    // appendAtm=false opts out entirely.
    const optedOut = toCrossTradeMessage(
      payload({ extras: { rangeName: 'TEST RANGE', appendAtm: false } }),
      DESTINATION,
    );
    expect(optedOut.atm_strategy).toBeUndefined();
    expect(optedOut.append_atm).toBeUndefined();

    // No name at all + appendAtm=true → CrossTrade's built-in strategy.
    const builtin = toCrossTradeMessage(
      payload({ extras: { appendAtm: true } }),
      DESTINATION,
    );
    expect(builtin.atm_strategy).toBe('crosstrade');
    expect(builtin.append_atm).toBe('true');

    // Non-place commands ignore the ATM fields entirely.
    const cancel = toCrossTradeMessage(
      payload({ action: 'cancel', extras: { rangeName: 'TEST RANGE' } }),
      DESTINATION,
    );
    expect(cancel.atm_strategy).toBeUndefined();
    expect(cancel.append_atm).toBeUndefined();
  });

  it('links a range\'s arms with a per-event oco_id so NT8 drops the loser', () => {
    // NT8 burns an oco_id once its group resolves — the group key must be
    // unique per arming event, so it derives from the bracket-id stem (the
    // -long/-short token removed), not the reusable range name.
    const long = toCrossTradeMessage(
      payload({ bracketId: 'ultra-v5.3-MNQ1!-1790052240000-18-long-arm-18' }),
      DESTINATION,
    );
    const short = toCrossTradeMessage(
      payload({ bracketId: 'ultra-v5.3-MNQ1!-1790052240000-18-short-arm-18', action: 'sell' }),
      DESTINATION,
    );
    expect(long.oco_id).toBe('ultra-v5.3-MNQ1!-1790052240000-18-arm-18');
    expect(short.oco_id).toBe(long.oco_id);

    // A side token anywhere in the id still groups the pair (debug/sim ids).
    expect(toCrossTradeMessage(payload({ bracketId: 'debug-ab12-long' }), DESTINATION).oco_id).toBe('debug-ab12');
    expect(toCrossTradeMessage(payload({ bracketId: 'sim-rng-short-run9' }), DESTINATION).oco_id).toBe('sim-rng-run9');

    // extras.ocoId overrides the group key.
    expect(
      toCrossTradeMessage(payload({ extras: { rangeName: 'R', ocoId: 'PAIR-1' } }), DESTINATION).oco_id,
    ).toBe('PAIR-1');

    // extras.oco=false opts out.
    const optedOut = toCrossTradeMessage(
      payload({ extras: { rangeName: 'R', oco: false } }),
      DESTINATION,
    );
    expect(optedOut.oco_id).toBeUndefined();

    // A bracket id with no side token maps to itself — unique per leg, so no
    // accidental grouping. No bracket id at all → no OCO grouping.
    expect(toCrossTradeMessage(payload({ bracketId: 'bracket-1' }), DESTINATION).oco_id).toBe('bracket-1');
    expect(toCrossTradeMessage(payload({ bracketId: undefined }), DESTINATION).oco_id).toBeUndefined();

    // cancel/flatten never carry an OCO id.
    expect(toCrossTradeMessage(payload({ action: 'cancel' }), DESTINATION).oco_id).toBeUndefined();
  });

  it('maps limit and stop_limit order types with the right price fields', () => {
    const limit = toCrossTradeMessage(
      payload({ orderType: 'limit', limitPrice: 100, stopPrice: undefined }),
      DESTINATION,
    );
    expect(limit).toMatchObject({ order_type: 'limit', limit_price: 100 });
    expect(limit.stop_price).toBeUndefined();

    const stopLimit = toCrossTradeMessage(
      payload({ orderType: 'stop_limit', limitPrice: 100, stopPrice: 99 }),
      DESTINATION,
    );
    expect(stopLimit).toMatchObject({ order_type: 'stoplimit', stop_price: 99, limit_price: 100 });
  });

  it('passes absolute take-profit/stop-loss prices through', () => {
    const message = toCrossTradeMessage(
      payload({
        takeProfit: { limitPrice: 24600 },
        stopLoss: { stopPrice: 24400 },
      }),
      DESTINATION,
    );
    expect(message.take_profit).toBe(24600);
    expect(message.stop_loss).toBe(24400);
  });

  it('emits relative tick/percent strings when amounts are provided', () => {
    const message = toCrossTradeMessage(
      payload({
        takeProfit: { amount: 40 },
        stopLoss: { percent: 0.5 },
      }),
      DESTINATION,
    );
    expect(message.take_profit).toBe('40 ticks');
    expect(message.stop_loss).toBe('0.5%');
  });

  it('drops explicit TP/SL legs when an ATM strategy owns the bracket', () => {
    // The ATM template defines its own SL/TP/BE exits — sending plain legs
    // alongside it double-specifies the bracket and can orphan a leg when the
    // strategy's exit path fires (e.g., a breakeven stop-out leaving the TP).
    const withAtm = toCrossTradeMessage(
      payload({
        takeProfit: { limitPrice: 24600 },
        stopLoss: { stopPrice: 24400, limitPrice: 24395 },
        extras: { rangeName: 'TEST RANGE', appendAtm: true },
      }),
      DESTINATION,
    );
    expect(withAtm.atm_strategy).toBe('TEST RANGE');
    expect(withAtm.take_profit).toBeUndefined();
    expect(withAtm.stop_loss).toBeUndefined();
    expect(withAtm.stop_loss_limit).toBeUndefined();

    // Same payload without ATM keeps the explicit legs.
    const noAtm = toCrossTradeMessage(
      payload({
        takeProfit: { limitPrice: 24600 },
        stopLoss: { stopPrice: 24400, limitPrice: 24395 },
      }),
      DESTINATION,
    );
    expect(noAtm.atm_strategy).toBeUndefined();
    expect(noAtm.take_profit).toBe(24600);
    expect(noAtm.stop_loss).toBe(24400);
    expect(noAtm.stop_loss_limit).toBe(24395);
  });

  it('converts TP and SL tick inputs to absolute prices by side', () => {
    expect(crossTradeExitPricesFromTicks({
      action: 'buy', ticker: 'MGC1!', entryPrice: 4300, takeProfitTicks: 40, stopLossTicks: 20,
    })).toEqual({ takeProfitPrice: 4304, stopLossPrice: 4298 });
    expect(crossTradeExitPricesFromTicks({
      action: 'sell', ticker: 'MGC1!', entryPrice: 4300, takeProfitTicks: 40, stopLossTicks: 20,
    })).toEqual({ takeProfitPrice: 4296, stopLossPrice: 4302 });
  });

  it('uses ZL price increments when converting TP and SL ticks', () => {
    expect(crossTradeExitPricesFromTicks({
      action: 'buy', ticker: 'ZL1!', entryPrice: 68, takeProfitTicks: 10, stopLossTicks: 5,
    })).toEqual({ takeProfitPrice: 68.1, stopLossPrice: 67.95 });
    expect(crossTradeExitPricesFromTicks({
      action: 'sell', ticker: 'ZL 12-26', entryPrice: 68, takeProfitTicks: 10, stopLossTicks: 5,
    })).toEqual({ takeProfitPrice: 67.9, stopLossPrice: 68.05 });
  });

  it('returns no computed levels for an unusable entry reference price', () => {
    expect(crossTradeExitPricesFromTicks({ action: 'buy', ticker: 'MNQ1!', entryPrice: 0, takeProfitTicks: 4 })).toEqual({});
  });

  it('resolves percent exits to absolute tick-rounded prices anchored on the alert entry', () => {
    const long = toCrossTradeMessage(payload({
      action: 'buy',
      price: 30935.25,
      takeProfit: { percent: 0.0484883749 },
      stopLoss: { percent: 0.0323255833 },
    }), DESTINATION);
    expect(long.take_profit).toBe(30950.25);
    expect(long.stop_loss).toBe(30925.25);
    const short = toCrossTradeMessage(payload({
      action: 'sell',
      price: 30935.25,
      takeProfit: { percent: 0.0484883749 },
      stopLoss: { percent: 0.0323255833 },
    }), DESTINATION);
    expect(short.take_profit).toBe(30920.25);
    expect(short.stop_loss).toBe(30945.25);
  });

  it('passes percent through when no usable entry price anchors it', () => {
    const msg = toCrossTradeMessage(payload({
      action: 'buy',
      takeProfit: { percent: 0.5 },
    }), DESTINATION);
    expect(msg.take_profit).toBe('0.5%');
  });

  it('converts cancel into an instrument-scoped cancelorders command', () => {
    const message = toCrossTradeMessage(
      payload({ action: 'cancel' }),
      DESTINATION,
      'bridge-reapply',
    );
    expect(message).toMatchObject({
      command: 'cancelorders',
      instrument: 'MNQ1!',
      account: 'TEST-ACCOUNT',
    });
    expect(message.action).toBeUndefined();
    expect(message.qty).toBeUndefined();
  });

  it('converts exit into a flatten command', () => {
    const message = toCrossTradeMessage(payload({ action: 'exit' }), DESTINATION);
    expect(message).toMatchObject({ command: 'flatten', instrument: 'MNQ1!' });
    expect(message.action).toBeUndefined();
  });

  it('strips CrossTrade-unsafe characters from notes', () => {
    const message = toCrossTradeMessage(
      payload({ extras: { rangeName: 'BAD;NAME=X\r\nY' } }),
      DESTINATION,
    );
    expect(String(message.notes)).not.toMatch(/[;=\r\n]/);
  });

  it('sets tif day on market orders too — NT8 requires it on every place', () => {
    const message = toCrossTradeMessage(
      payload({ orderType: 'market', stopPrice: undefined }),
      DESTINATION,
    );
    expect(message.tif).toBe('day');
  });
});

describe('interpretCrossTradeResponse', () => {
  it('requires an explicit success flag on a 2xx', () => {
    expect(interpretCrossTradeResponse(200, '{"success":true}').success).toBe(true);
    expect(interpretCrossTradeResponse(200, '{"ok":true}').success).toBe(false);
    expect(interpretCrossTradeResponse(200, 'plain text ack').success).toBe(false);
  });

  it('extracts failure messages from CrossTrade-style error fields', () => {
    const result = interpretCrossTradeResponse(200, '{"success":false,"error":"bad account"}');
    expect(result.success).toBe(false);
    expect(result.failureMessage).toBe('bad account');
  });
});

describe('CrossTrade REST API', () => {
  const API_DESTINATION: CrossTradeDestination = DESTINATION;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (status: number, body: string) => {
    const fetchMock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('derives the REST base from the webhook URL origin', () => {
    expect(crossTradeApiBase({ webhookUrl: 'https://app.crosstrade.io/v1/send/uid/channel' }))
      .toBe('https://app.crosstrade.io/v1/api');
    expect(crossTradeApiBase({ webhookUrl: 'http://localhost:3000/mock/crosstrade' }))
      .toBe('http://localhost:3000/v1/api');
    expect(crossTradeApiBase({ webhookUrl: 'not-a-url' })).toBeUndefined();
  });

  it('falls back to the secret key when no API token is set', async () => {
    // CrossTrade's single Secret Key doubles as the REST Bearer token.
    const fetchMock = stubFetch(200, '{"success":true,"orders":[]}');
    const result = await fetchCrossTradeOrders(DESTINATION);
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-abc');
  });

  it('refuses to call the API with no credential at all', async () => {
    const result = await fetchCrossTradeOrders({ webhookUrl: DESTINATION.webhookUrl, secretKey: '', accountName: 'X' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('secret key');
  });

  it('sends Bearer auth and the per-account orders path', async () => {
    const fetchMock = stubFetch(200, '{"success":true,"orders":[{"id":"o1"}]}');
    const result = await fetchCrossTradeOrders(API_DESTINATION);
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://app.crosstrade.io/v1/api/accounts/TEST-ACCOUNT/orders?activeOnly=false');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-abc');
  });

  it('queries positions and single orders under the same account path', async () => {
    let fetchMock = stubFetch(200, '{"success":true,"positions":[]}');
    await fetchCrossTradePositions(API_DESTINATION);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe('https://app.crosstrade.io/v1/api/accounts/TEST-ACCOUNT/positions');

    fetchMock = stubFetch(200, '{"success":true,"order":{"id":"b1"}}');
    await fetchCrossTradeOrder(API_DESTINATION, 'bracket id/1');
    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe('https://app.crosstrade.io/v1/api/accounts/TEST-ACCOUNT/orders/bracket%20id%2F1');
  });

  it('surfaces HTTP failures with the body message', async () => {
    stubFetch(503, '{"success":false,"error":"nt8 offline"}');
    const result = await fetchCrossTradeOrders(API_DESTINATION);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.error).toBe('nt8 offline');
  });

  it('treats a 200 with success:false as a failure', async () => {
    stubFetch(200, '{"success":false,"error":"unknown order id"}');
    const result = await fetchCrossTradeOrder(API_DESTINATION, 'gone');
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBe('unknown order id');
  });

  it('treats a 200 without an explicit success flag as a failure', async () => {
    // An empty/flag-less body must never read as "no orders" — only an explicit
    // success:true is a successful API read.
    stubFetch(200, '{"orders":[]}');
    const result = await fetchCrossTradeOrders(API_DESTINATION);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(200);
    expect(result.error).toContain('did not report success');
  });

  it('returns an error result on malformed JSON and network failure', async () => {
    stubFetch(200, 'not json');
    const malformed = await fetchCrossTradeOrders(API_DESTINATION);
    // Malformed body is a failed read even though HTTP itself was fine —
    // an unreadable payload must not masquerade as an empty book.
    expect(malformed.ok).toBe(false);
    expect(malformed.statusCode).toBe(200);
    expect(malformed.error).toContain('unreadable');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hangup'); }));
    const network = await fetchCrossTradePositions(API_DESTINATION);
    expect(network.ok).toBe(false);
    expect(network.statusCode).toBeNull();
    expect(network.error).toBe('socket hangup');
  });
});


describe('matchesCtOrderId', () => {
  const row = (overrides: Record<string, unknown> = {}) =>
    ({ orderState: 'Working', ...overrides }) as Parameters<typeof matchesCtOrderId>[0];

  it('matches on any echoed id field', () => {
    const r = row({ orderId: 'bracket-1', name: 'other' });
    expect(matchesCtOrderId(r, 'bracket-1', 'buy')).toBe(true);
    expect(matchesCtOrderId(row({ automatedTradingOrderId: 'bracket-1' }), 'bracket-1', 'buy')).toBe(true);
    expect(matchesCtOrderId(row({ orderId: 'bracket-9' }), 'bracket-1', 'buy')).toBe(false);
  });

  it('strips the ledger-only -r<n> retry suffix before matching', () => {
    // NT8 saw 'bracket-1'; the ledger attempt row is 'bracket-1-r2'.
    expect(matchesCtOrderId(row({ orderId: 'bracket-1' }), 'bracket-1-r2', 'buy')).toBe(true);
    expect(matchesCtOrderId(row({ orderId: 'bracket-1' }), 'bracket-1-r2')).toBe(true);
  });

  it('accepts -a<n> re-arm resend forms on both sides of the match', () => {
    // Logical bracket id must find the resent wire id at NT8.
    expect(matchesCtOrderId(row({ orderId: 'bracket-1-a1' }), 'bracket-1', 'buy')).toBe(true);
    // Ledger wire id (already -a suffixed, possibly with a retry suffix).
    expect(matchesCtOrderId(row({ orderId: 'bracket-1-a1' }), 'bracket-1-a1', 'buy')).toBe(true);
    expect(matchesCtOrderId(row({ orderId: 'bracket-1-a1' }), 'bracket-1-a1-r3', 'buy')).toBe(true);
  });

  it('falls back to oco_id + action when NT8 regenerated the order id', () => {
    const nt8 = row({ ocoId: 'ultra-v5.4-RNG-MNQ-99-3-arm-1', orderAction: 'Sell' });
    expect(matchesCtOrderId(nt8, 'ultra-v5.4-RNG-MNQ-99-3-arm-1-short', 'sell')).toBe(true);
    // Wrong action must not match — buy↔long, sell↔short are distinct legs.
    expect(matchesCtOrderId(nt8, 'ultra-v5.4-RNG-MNQ-99-3-arm-1-long', 'buy')).toBe(false);
    // Resent wire id lands '-a<n>' inside the oco stem as well.
    const resent = row({ ocoId: 'ultra-v5.4-RNG-MNQ-99-3-arm-1-a2', orderAction: 'Sell' });
    expect(matchesCtOrderId(resent, 'ultra-v5.4-RNG-MNQ-99-3-arm-1-short', 'sell')).toBe(true);
    expect(matchesCtOrderId(resent, 'ultra-v5.4-RNG-MNQ-99-3-arm-1-short-a2-r1', 'sell')).toBe(true);
  });

  it('does not treat a different bracket as a resend', () => {
    expect(matchesCtOrderId(row({ orderId: 'bracket-1-a1' }), 'bracket-2', 'buy')).toBe(false);
    expect(matchesCtOrderId(row({ orderId: 'bracket-10' }), 'bracket-1', 'buy')).toBe(false);
  });
});

describe('ctWireOrderId', () => {
  it('strips only the ledger retry-attempt suffix', () => {
    expect(ctWireOrderId('bracket-1-r2')).toBe('bracket-1');
    expect(ctWireOrderId('bracket-1-a1-r2')).toBe('bracket-1-a1');
    expect(ctWireOrderId('bracket-1')).toBe('bracket-1');
    // A real id tail like '-arm-18' is not an attempt suffix.
    expect(ctWireOrderId('ultra-v5.4-RNG-MNQ-99-3-arm-18')).toBe('ultra-v5.4-RNG-MNQ-99-3-arm-18');
  });
});

describe('mapNt8OrderState', () => {
  it('maps NT8 states onto ledger evidence states', () => {
    expect(mapNt8OrderState('Working')).toBe('working');
    expect(mapNt8OrderState('Accepted')).toBe('working');
    expect(mapNt8OrderState('TriggerPending')).toBe('working');
    expect(mapNt8OrderState('Filled')).toBe('filled');
    expect(mapNt8OrderState('PartFilled')).toBe('filled');
    expect(mapNt8OrderState('Cancelled')).toBe('cancelled');
    expect(mapNt8OrderState('Rejected')).toBe('rejected');
  });
  it('returns unknown for unrecognized or missing states', () => {
    expect(mapNt8OrderState('Teleporting')).toBe('unknown');
    expect(mapNt8OrderState('')).toBe('unknown');
    expect(mapNt8OrderState(undefined)).toBe('unknown');
    expect(mapNt8OrderState(null)).toBe('unknown');
  });
});

describe('isCrossTradeConfigured', () => {
  it('requires the complete credential pair — never half of it', () => {
    expect(isCrossTradeConfigured({ crossTradeWebhookUrl: 'https://x', crossTradeSecretKey: 'k' })).toBe(true);
    expect(isCrossTradeConfigured({ crossTradeWebhookUrl: 'https://x' })).toBe(false);
    expect(isCrossTradeConfigured({ crossTradeSecretKey: 'k' })).toBe(false);
    expect(isCrossTradeConfigured({})).toBe(false);
    expect(isCrossTradeConfigured(undefined)).toBe(false);
  });

  it('treats crossTradeEnabled=false as parked — configured but not routing', () => {
    const parked = { crossTradeWebhookUrl: 'https://x', crossTradeSecretKey: 'k', crossTradeEnabled: false };
    expect(isCrossTradeConfigured(parked)).toBe(false);
    expect(isCrossTradeConfigured({ ...parked, crossTradeEnabled: true })).toBe(true);
    // Legacy rows carry no flag — configured credentials stay active.
    expect(isCrossTradeConfigured({ crossTradeWebhookUrl: 'https://x', crossTradeSecretKey: 'k', crossTradeEnabled: undefined })).toBe(true);
  });
});

describe('redactCrossTradeMessage', () => {
  it('strips the secret from the wire message for logs and events', () => {
    const message = { key: 'real-secret', destination: 'nt8', command: 'place' };
    const redacted = redactCrossTradeMessage(message);
    expect(redacted.key).toBe('[redacted]');
    expect(JSON.stringify(redacted)).not.toContain('real-secret');
    // The outbound body itself is untouched — only the log copy is sanitized.
    expect(message.key).toBe('real-secret');
  });
});

describe('ctUserDataOrderId', () => {
  it('extracts the echoed order id from NT8 XML userData', () => {
    const xml = '<NinjaTrader><AutomatedTradingOrderId>HEAVEN-ultra-v5.3-MGC1!-1790688780000-18-short-arm-18</AutomatedTradingOrderId></NinjaTrader>';
    expect(ctUserDataOrderId(xml)).toBe('HEAVEN-ultra-v5.3-MGC1!-1790688780000-18-short-arm-18');
  });
  it('returns undefined for absent or non-XML userData', () => {
    expect(ctUserDataOrderId(undefined)).toBeUndefined();
    expect(ctUserDataOrderId(null)).toBeUndefined();
    expect(ctUserDataOrderId('manual order, no xml')).toBeUndefined();
    expect(ctUserDataOrderId('<AutomatedTradingOrderId></AutomatedTradingOrderId>')).toBeUndefined();
  });
});

describe('matchesCtOrderId', () => {
  const row = (over: Record<string, unknown>) => ({
    id: '676173541025',
    orderId: null,
    orderAction: 'Sell',
    orderState: 'Working',
    instrument: 'MGC 12-26',
    ...over,
  });

  it('matches the XML-wrapped echo — raw userData never equals the wire id', () => {
    const wire = 'HEAVEN-ultra-v5.3-MGC1!-1790688780000-18-short-arm-18';
    const r = row({ userData: `<NinjaTrader><AutomatedTradingOrderId>${wire}</AutomatedTradingOrderId></NinjaTrader>` });
    // Regression: comparing the raw blob never matched; extraction does.
    expect(matchesCtOrderId(r, wire, 'sell')).toBe(true);
  });

  it('matches resend wire forms (-a<n>) via userData, orderId, and name', () => {
    const wire = 'BRACKET-1-short-arm-1';
    expect(matchesCtOrderId(row({ userData: `<NinjaTrader><AutomatedTradingOrderId>${wire}-a1</AutomatedTradingOrderId></NinjaTrader>` }), wire, 'sell')).toBe(true);
    expect(matchesCtOrderId(row({ orderId: `${wire}-a2` }), wire, 'sell')).toBe(true);
    expect(matchesCtOrderId(row({ name: `${wire}-a1` }), wire, 'sell')).toBe(true);
  });

  it('falls back to oco_id + action when no id echoes (plain entries)', () => {
    const wire = 'RANGE-BRACKET-short-arm-3';
    // The oco stem drops only the side token — '-arm-<n>' stays.
    const stem = 'RANGE-BRACKET-arm-3';
    expect(matchesCtOrderId(row({ ocoId: stem, orderAction: 'Sell' }), wire, 'sell')).toBe(true);
    expect(matchesCtOrderId(row({ ocoId: `${stem}-a1`, orderAction: 'Sell' }), wire, 'sell')).toBe(true);
    // Wrong action does not claim the same oco stem.
    expect(matchesCtOrderId(row({ ocoId: stem, orderAction: 'Buy' }), wire, 'sell')).toBe(false);
    // No action provided → oco fallback must not fire.
    expect(matchesCtOrderId(row({ ocoId: stem, orderAction: 'Sell' }), wire)).toBe(false);
  });

  it('ignores untagged manual orders', () => {
    expect(matchesCtOrderId(row({}), 'ANY-BRACKET-short-arm-1', 'sell')).toBe(false);
  });
});

describe('mapNt8OrderState partial fills', () => {
  it('maps PartFilled variants to filled for close-proof use', () => {
    for (const s of ['PartFilled', 'Part Filled', 'PartiallyFilled', 'part_filled']) {
      expect(mapNt8OrderState(s)).toBe('filled');
    }
  });
});
