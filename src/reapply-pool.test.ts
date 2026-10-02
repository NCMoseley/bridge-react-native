import { beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { Database } from './database.js';
import { createApp } from './server.js';
import { rangeSlugForLookup } from './webhook.js';

process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'test-admin-api-key-000000000000000000000000000000';

const PROXY_SECRET = 'test-proxy-secret';
const SESSION_SECRET = 'test-session-secret-000000000000000000000000000000';
const INITIAL_USER_PASSWORD = 'test-password-000000000000000000000000000000';
const WEBHOOK_URL = 'https://hooks.traderspost.io/webhook/test';
const sid = (range: string, id: string) => `${rangeSlugForLookup(range)}-${id}`;

type FetchCall = { url: string; body: unknown; timestamp: number };

function makeLifecyclePayload(
  eventType: 'entry_armed' | 'entry_filled' | 'entry_cancelled' | 'trade_closed',
  tradeId: string,
  overrides: Record<string, unknown> = {},
) {
  const base: Record<string, unknown> = {
    eventType,
    eventId: `${eventType}-${tradeId}-${Date.now()}`,
    tradeId,
    ticker: 'MNQ1!',
    side: 'short',
    quantity: 1,
    extras: { rangeName: 'TEST RANGE' },
  };
  if (eventType === 'trade_closed') {
    base.closedAt = new Date().toISOString();
    base.realizedTicks = 50;
    base.realizedDollars = 500;
    base.outcome = 'win';
  }
  return { ...base, ...overrides };
}

function createMockFetch() {
  const fetchCalls: FetchCall[] = [];
  const mockFetch = async (_url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetchCalls.push({ url: String(_url), body, timestamp: Date.now() });
    return new Response('{"success":true}', { status: 200, statusText: 'OK' });
  };
  return { fetchCalls, mockFetch };
}

function appOptions(fetch: typeof globalThis.fetch) {
  return {
    proxyWebhookSecret: PROXY_SECRET,
    sessionSecret: SESSION_SECRET,
    initialUserPassword: INITIAL_USER_PASSWORD,
    fetch,
    // Keep flatten sends single-pass per execute() run; dedicated retry-policy
    // coverage lives in reapply-safety.test.ts.
    reapplyFlattenMaxSends: 1,
    reapplyFlattenRetryDelayMs: 0,
  };
}

function setupReapplyTest(reapplyOnTradeCloseEnabled = true) {
  const database = new Database(':memory:');
  const user = database.createUser('test@example.com');
  const account = database.createAccount({
    userId: user.id,
    name: 'Test Account',
    startingBalanceCents: 0,
  });

  database.upsertTradersPostAccountDestination(
    user.id,
    account.id,
    WEBHOOK_URL,
    undefined,
    undefined,
    true,
    false,
    false,
    '16:30',
    '16:45',
    false,
    false,
    5,
    reapplyOnTradeCloseEnabled,
  );

  const createRange = (rangeName: string) => {
    database.createTrackedRange(rangeName, user.id);
    database.upsertRangeConfiguration({
      rangeName,
      instrument: 'MNQ1!',
      description: '',
      riskDollarsCents: 10_000,
      rangeWindow: '0000-2359',
      tradingSession: '',
      takeProfitStyle: 'ticks',
      takeProfitTicksCents: 1_000,
      stopLossStyle: 'ticks',
      stopLossTicksCents: 1_000,
    breakEvenEnabled: false, breakEvenTriggerTicksCents: 0, breakEvenOffsetTicksCents: 0, ocoMode: 'oco',
      runMonday: true,
      runTuesday: true,
      runWednesday: true,
      runThursday: true,
      runFriday: true,
      runSaturday: true,
      runSunday: true,
      entriesPerRange: 1,
    });
    database.upsertRangeRoute({
      userId: user.id,
      rangeName,
      accountId: account.id,
      extensionEnabled: false,
      traderspostEnabled: true,
      runScheduled: false,
    });
  };

  return { database, user, account, createRange };
}

describe('Reapply on trade close', () => {
  beforeAll(() => {
    if (!process.env.ADMIN_API_KEY) {
      process.env.ADMIN_API_KEY = 'test-admin-api-key-000000000000000000000000000000';
    }
  });

  it('cancels open orders, sends safeguard exit, then re-arms the remaining ranges', async () => {
    const { database, createRange } = setupReapplyTest();
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    const ranges = [
      { rangeName: 'RANGE-A', bracketId: 'bracket-a', side: 'short' as const, entryPrice: 29400 },
      // Below the 29440 close — a sell stop must sit under the market or the
      // broker rejects it, and the reapply guard now skips those levels.
      { rangeName: 'RANGE-B', bracketId: 'bracket-b', side: 'short' as const, entryPrice: 29420 },
      { rangeName: 'RANGE-C', bracketId: 'bracket-c', side: 'short' as const, entryPrice: 29300 },
      { rangeName: 'RANGE-D', bracketId: 'bracket-d', side: 'long' as const, entryPrice: 29500 },
    ];

    const bracketIdToSide: Record<string, 'long' | 'short'> = {
      'bracket-a': 'short',
      'bracket-b': 'short',
      'bracket-c': 'short',
      'bracket-d': 'long',
    };

    for (const r of ranges) {
      createRange(r.rangeName);
    }

    for (const r of ranges) {
      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send({
          ticker: 'MNQ1!',
          action: r.side === 'long' ? 'buy' : 'sell',
          orderType: 'stop',
          stopPrice: r.entryPrice,
          quantity: 1,
          bracketId: r.bracketId,
          tradeId: r.bracketId,
          extras: { rangeName: r.rangeName },
        });

      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send(makeLifecyclePayload('entry_armed', r.bracketId, {
          side: r.side,
          action: r.side === 'long' ? 'buy' : 'sell',
          orderType: 'stop',
          entryPrice: r.entryPrice,
          stopPrice: r.entryPrice,
          extras: { rangeName: r.rangeName },
        }));
    }

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_filled', 'bracket-a', {
        side: 'short',
        action: 'sell',
        extras: { rangeName: 'RANGE-A' },
      }));

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', 'bracket-a', {
        side: 'short',
        entryPrice: 29400,
        exitPrice: 29440,
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));

    expect(res.status).toBe(202);

    const exitRequests = fetchCalls.filter(
      (c) => c.body && (c.body as Record<string, unknown>).action === 'exit',
    );
    const cancelRequests = fetchCalls.filter(
      (c) => c.body && (c.body as Record<string, unknown>).action === 'cancel',
    );
    const reapplyRequests = fetchCalls.filter(
      (c) => {
        const action = (c.body as Record<string, unknown>).action;
        return action === 'buy' || action === 'sell';
      },
    );

    // 1. safeguard market exit for the instrument that just closed
    expect(exitRequests.length).toBeGreaterThanOrEqual(1);
    for (const req of exitRequests) {
      const b = req.body as Record<string, unknown>;
      expect(b.ticker).toBe('MNQ1!');
      expect(b.action).toBe('exit');
      expect(b.orderType).toBe('market');
      expect(b).not.toHaveProperty('quantity');
      expect(b).not.toHaveProperty('quantityType');
    }
    for (const c of exitRequests) {
      expect(c.body).not.toHaveProperty('bracketSide');
      expect(c.body).not.toHaveProperty('sentiment');
    }

    // 2. one instrument-scoped cancel for all open orders on this instrument
    expect(cancelRequests).toHaveLength(1);
    const cancel = cancelRequests[0].body as Record<string, unknown>;
    expect(cancel.ticker).toBe('MNQ1!');
    expect(cancel.action).toBe('cancel');
    expect(cancel).not.toHaveProperty('bracketId');
    expect(cancel).not.toHaveProperty('bracketSide');
    expect(cancel).not.toHaveProperty('tradeId');

    // 3. cancel is delivered before the market exit
    const cancelIndex = fetchCalls.findIndex(
      (c) => (c.body as Record<string, unknown> | undefined)?.action === 'cancel',
    );
    const exitIndex = fetchCalls.findIndex(
      (c) => (c.body as Record<string, unknown> | undefined)?.action === 'exit',
    );
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThanOrEqual(0);
    expect(cancelIndex).toBeLessThan(exitIndex);

    // 4. re-arms the remaining ranges (B, C, D)
    expect(reapplyRequests).toHaveLength(3);
  });

  it('skips re-arm dispatches whose stop level is already through the close price', async () => {
    const { database, account, createRange } = setupReapplyTest();
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    // A closes long at 29520. B's buy stop (29500) and C's sell stop (29560) now
    // sit on the wrong side of the market and would be rejected by the broker;
    // D's buy stop and E's sell stop remain valid.
    const ranges = [
      { rangeName: 'RANGE-A', bracketId: 'bracket-a', side: 'long' as const, entryPrice: 29500 },
      { rangeName: 'RANGE-B', bracketId: 'bracket-b', side: 'long' as const, entryPrice: 29500 },
      { rangeName: 'RANGE-C', bracketId: 'bracket-c', side: 'short' as const, entryPrice: 29560 },
      { rangeName: 'RANGE-D', bracketId: 'bracket-d', side: 'long' as const, entryPrice: 29540 },
      { rangeName: 'RANGE-E', bracketId: 'bracket-e', side: 'short' as const, entryPrice: 29490 },
    ];
    for (const r of ranges) createRange(r.rangeName);
    for (const r of ranges) {
      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send({
          ticker: 'MNQ1!',
          action: r.side === 'long' ? 'buy' : 'sell',
          orderType: 'stop',
          stopPrice: r.entryPrice,
          quantity: 1,
          bracketId: r.bracketId,
          tradeId: r.bracketId,
          extras: { rangeName: r.rangeName },
        });
      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send(makeLifecyclePayload('entry_armed', r.bracketId, {
          side: r.side,
          action: r.side === 'long' ? 'buy' : 'sell',
          orderType: 'stop',
          entryPrice: r.entryPrice,
          stopPrice: r.entryPrice,
          extras: { rangeName: r.rangeName },
        }));
    }

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_filled', 'bracket-a', {
        side: 'long',
        action: 'buy',
        extras: { rangeName: 'RANGE-A' },
      }));

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', 'bracket-a', {
        side: 'long',
        entryPrice: 29500,
        exitPrice: 29520,
        eventId: 'close-evt-stale-1',
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));
    expect(res.status).toBe(202);

    const reapplyEntries = fetchCalls.filter((c) => {
      const b = c.body as Record<string, unknown> | undefined;
      return b && (b.action === 'buy' || b.action === 'sell')
        && typeof b.bracketId === 'string' && String(b.bracketId).startsWith('bridge-reapply-');
    });
    // Only the still-valid arms dispatch: D's buy stop above the close and E's
    // sell stop below it. The stale stops never reach TradersPost.
    expect(reapplyEntries).toHaveLength(2);
    const dispatchedStops = reapplyEntries
      .map((c) => (c.body as Record<string, unknown>).stopPrice)
      .sort((a, b) => Number(a) - Number(b));
    expect(dispatchedStops).toEqual([29490, 29540]);

    // The cancel sweep still retired the stale arms; no replacement was bound.
    expect(database.findBracketMonitorEntry(account.id, 'RANGE-B', 'bracket-b', 'long')?.state).toBe('cancelled');
    expect(database.findBracketMonitorEntry(account.id, 'RANGE-C', 'bracket-c', 'short')?.state).toBe('cancelled');
    const armed = database.listActiveBracketMonitorEntries(account.id).filter((e) => e.state === 'armed');
    expect(armed.filter((e) => e.rangeName === 'RANGE-D')).toHaveLength(1);
    expect(armed.filter((e) => e.rangeName === 'RANGE-E')).toHaveLength(1);
    expect(armed.filter((e) => e.rangeName === 'RANGE-B' || e.rangeName === 'RANGE-C')).toHaveLength(0);

    const op = database.findReapplyOperation(account.id, `RANGE-A|${sid('RANGE-A', 'close-evt-stale-1')}`);
    expect(op?.steps.filter((s) => s.state === 'skipped')).toHaveLength(2);
  });

  it('skips the entire flow when another bracket is filled on the same account and instrument', async () => {
    const { database, createRange } = setupReapplyTest();
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    createRange('RANGE-A');
    createRange('RANGE-B');

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_armed', 'bracket-a', {
        side: 'short',
        action: 'sell',
        orderType: 'stop',
        entryPrice: 29400,
        stopPrice: 29400,
        extras: { rangeName: 'RANGE-A' },
      }));

    // an opposite-side order in the same range should not be cancelled either
    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_armed', 'bracket-a2', {
        side: 'long',
        action: 'buy',
        orderType: 'stop',
        entryPrice: 29500,
        stopPrice: 29500,
        extras: { rangeName: 'RANGE-A' },
      }));

    // The filled bracket's entry must actually dispatch — a Pine fill without a
    // broker order is simulated state and no longer blocks instrument cleanup.
    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({
        ticker: 'MNQ1!',
        action: 'buy',
        bracketId: 'bracket-b',
        bracketSide: 'long',
        quantity: 1,
        quantityType: 'fixed_quantity',
        orderType: 'stop',
        stopPrice: 29450,
        extras: { rangeName: 'RANGE-B' },
      });

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_armed', 'bracket-b', {
        side: 'long',
        action: 'buy',
        orderType: 'stop',
        entryPrice: 29450,
        stopPrice: 29450,
        extras: { rangeName: 'RANGE-B' },
      }));

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_filled', 'bracket-b', {
        side: 'long',
        action: 'buy',
        extras: { rangeName: 'RANGE-B' },
      }));

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', 'bracket-a', {
        side: 'short',
        entryPrice: 29400,
        exitPrice: 29440,
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));

    expect(res.status).toBe(202);

    const exitRequests = fetchCalls.filter(
      (c) => c.body && (c.body as Record<string, unknown>).action === 'exit',
    );
    const cancelRequests = fetchCalls.filter(
      (c) => c.body && (c.body as Record<string, unknown>).action === 'cancel',
    );
    const reapplyRequests = fetchCalls.filter(
      (c) => {
        const action = (c.body as Record<string, unknown>).action;
        return action === 'buy' || action === 'sell';
      },
    );

    expect(exitRequests).toHaveLength(0);
    expect(cancelRequests).toHaveLength(0);
    expect(reapplyRequests).toHaveLength(0);
  });

  it('does not send any broker action when reapplyOnTradeCloseEnabled is false', async () => {
    const { database, createRange } = setupReapplyTest(false);
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    const ranges = [
      { rangeName: 'RANGE-A', bracketId: 'bracket-a', side: 'short' as const, entryPrice: 29400 },
      { rangeName: 'RANGE-B', bracketId: 'bracket-b', side: 'long' as const, entryPrice: 29500 },
    ];

    for (const r of ranges) {
      createRange(r.rangeName);
      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send({
          ticker: 'MNQ1!',
          action: r.side === 'long' ? 'buy' : 'sell',
          orderType: 'stop',
          stopPrice: r.entryPrice,
          quantity: 1,
          bracketId: r.bracketId,
          tradeId: r.bracketId,
          extras: { rangeName: r.rangeName },
        });
      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send(makeLifecyclePayload('entry_armed', r.bracketId, {
          side: r.side,
          action: r.side === 'long' ? 'buy' : 'sell',
          orderType: 'stop',
          entryPrice: r.entryPrice,
          stopPrice: r.entryPrice,
          extras: { rangeName: r.rangeName },
        }));
    }

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_filled', 'bracket-a', {
        side: 'short',
        action: 'sell',
        extras: { rangeName: 'RANGE-A' },
      }));

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', 'bracket-a', {
        side: 'short',
        entryPrice: 29400,
        exitPrice: 29440,
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));

    expect(res.status).toBe(202);
    expect(res.body.rangeTradeEventId).toBeDefined();
    expect(fetchCalls).toHaveLength(0);
  });

  it('records the trade_closed lifecycle to the journal when reapply is off', async () => {
    const { database, createRange } = setupReapplyTest(false);
    const { mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    createRange('RANGE-A');

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({
        ticker: 'MNQ1!',
        action: 'sell',
        orderType: 'stop',
        stopPrice: 29400,
        quantity: 1,
        bracketId: 'bracket-a',
        tradeId: 'bracket-a',
        extras: { rangeName: 'RANGE-A' },
      });

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', 'bracket-a', {
        side: 'short',
        entryPrice: 29400,
        exitPrice: 29440,
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));

    expect(res.status).toBe(202);
    expect(database.listRangeTradeEventsByTrade('RANGE-A', sid('RANGE-A', 'bracket-a')).some((e) => e.eventType === 'trade_closed')).toBe(true);
  });

  it('records entry_cancelled only for the opposite arm of the closing range', async () => {
    const { database, createRange } = setupReapplyTest();
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    createRange('RANGE-A');
    createRange('RANGE-B');

    const shortArmId = 'range-a-short-arm-1';
    const longArmId = 'range-a-long-arm-1';
    const otherArmId = 'range-b-long-arm-1';
    const shortTradeId = `${shortArmId}-lifecycle-short-0`;
    const longTradeId = `${longArmId}-lifecycle-long-0`;
    const otherLongTradeId = `${otherArmId}-lifecycle-long-0`;

    for (const { armId, tradeId, side, action, price, rangeName } of [
      { armId: shortArmId, tradeId: shortTradeId, side: 'short', action: 'sell', price: 29400, rangeName: 'RANGE-A' },
      { armId: longArmId, tradeId: longTradeId, side: 'long', action: 'buy', price: 29500, rangeName: 'RANGE-A' },
      { armId: otherArmId, tradeId: otherLongTradeId, side: 'long', action: 'buy', price: 29450, rangeName: 'RANGE-B' },
    ]) {
      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send({
          ticker: 'MNQ1!',
          action,
          orderType: 'stop',
          stopPrice: price,
          quantity: 1,
          bracketId: armId,
          tradeId: armId,
          extras: { rangeName },
        });

      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send(makeLifecyclePayload('entry_armed', tradeId, {
          side,
          action,
          orderType: 'stop',
          entryPrice: price,
          stopPrice: price,
          extras: { rangeName },
        }));
    }

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', shortTradeId, {
        side: 'short',
        entryPrice: 29400,
        exitPrice: 29440,
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));

    expect(res.status).toBe(202);

    // Reapply does not create synthetic entry_cancelled journal rows; bracket_monitor is retired directly.
    expect(database.listRangeTradeEventsByTrade('RANGE-A', longTradeId).some((e) => e.eventType === 'entry_cancelled')).toBe(false);
    expect(database.listRangeTradeEventsByTrade('RANGE-A', shortTradeId).some((e) => e.eventType === 'entry_cancelled')).toBe(false);
    expect(database.listRangeTradeEventsByTrade('RANGE-B', otherLongTradeId).some((e) => e.eventType === 'entry_cancelled')).toBe(false);

    // The instrument-scoped cancel is still sent once with no bracket identifiers.
    const cancelRequests = fetchCalls.filter(
      (c) => c.body && (c.body as Record<string, unknown>).action === 'cancel',
    );
    expect(cancelRequests).toHaveLength(1);
    const cancel = cancelRequests[0].body as Record<string, unknown>;
    expect(cancel).not.toHaveProperty('bracketId');
    expect(cancel).not.toHaveProperty('bracketSide');
    expect(cancel).not.toHaveProperty('tradeId');

    // The reapply candidate in RANGE-B is re-armed.
    const reapplyRequests = fetchCalls.filter(
      (c) => {
        const action = (c.body as Record<string, unknown>).action;
        return action === 'buy' || action === 'sell';
      },
    );
    expect(reapplyRequests).toHaveLength(1);
  });

  it('does not send a cancel on entry_filled', async () => {
    const { database, account, createRange } = setupReapplyTest();
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    createRange('RANGE-A');

    const shortArmId = 'range-a-short-arm-1';
    const longArmId = 'range-a-long-arm-1';
    const shortTradeId = `${shortArmId}-lifecycle-short-0`;
    const longTradeId = `${longArmId}-lifecycle-long-0`;

    for (const { armId, tradeId, side, action, price } of [
      { armId: shortArmId, tradeId: shortTradeId, side: 'short' as const, action: 'sell' as const, price: 29400 },
      { armId: longArmId, tradeId: longTradeId, side: 'long' as const, action: 'buy' as const, price: 29500 },
    ]) {
      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send({
          ticker: 'MNQ1!',
          action,
          orderType: 'stop',
          stopPrice: price,
          quantity: 1,
          bracketId: armId,
          tradeId: armId,
          extras: { rangeName: 'RANGE-A' },
        });

      await supertest(app)
        .post(`/proxy/${PROXY_SECRET}`)
        .send(makeLifecyclePayload('entry_armed', tradeId, {
          side,
          action,
          orderType: 'stop',
          entryPrice: price,
          stopPrice: price,
          extras: { rangeName: 'RANGE-A' },
        }));
    }

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_filled', shortTradeId, {
        side: 'short',
        action: 'sell',
        extras: { rangeName: 'RANGE-A' },
      }));

    expect(res.status).toBe(202);

    const cancelRequests = fetchCalls.filter(
      (c) => c.body && (c.body as Record<string, unknown>).action === 'cancel',
    );
    expect(cancelRequests).toHaveLength(0);

    expect(database.listRangeTradeEventsByTrade('RANGE-A', longTradeId).some((e) => e.eventType === 'entry_cancelled')).toBe(false);
    expect(database.findBracketMonitorEntry(account.id, 'RANGE-A', longArmId, 'long')?.state).toBe('armed');
    expect(database.findBracketMonitorEntry(account.id, 'RANGE-A', shortArmId, 'short')?.state).toBe('filled');
  });
});
