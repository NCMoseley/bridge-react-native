import { beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createSessionToken, hashSessionToken } from './auth.js';
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
  };
}

function setupFlowTest(reapplyOnTradeCloseEnabled = true) {
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

  const sendBracket = async (app: ReturnType<typeof createApp>, rangeName: string, bracketId: string, side: 'long' | 'short', entryPrice: number) => {
    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({
        ticker: 'MNQ1!',
        action: side === 'long' ? 'buy' : 'sell',
        orderType: 'stop',
        stopPrice: entryPrice,
        quantity: 1,
        bracketId,
        tradeId: bracketId,
        extras: { rangeName },
      });
    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_armed', bracketId, {
        side,
        action: side === 'long' ? 'buy' : 'sell',
        orderType: 'stop',
        entryPrice,
        stopPrice: entryPrice,
        extras: { rangeName },
      }));
  };

  return { database, user, account, createRange, sendBracket };
}

describe('TradersPost reapply flow', () => {
  beforeAll(() => {
    if (!process.env.ADMIN_API_KEY) {
      process.env.ADMIN_API_KEY = 'test-admin-api-key-000000000000000000000000000000';
    }
  });

  it('sends the expected exit, cancel and reapply payloads on trade_close', async () => {
    const { database, createRange, sendBracket } = setupFlowTest(true);
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    createRange('RANGE-A');
    createRange('RANGE-B');
    createRange('RANGE-C');

    const originalBracketA = 'bracket-a';
    const originalBracketB = 'bracket-b';
    const originalBracketC = 'bracket-c';

    await sendBracket(app, 'RANGE-A', originalBracketA, 'short', 29400);
    await sendBracket(app, 'RANGE-B', originalBracketB, 'long', 29500);
    // Below the 29440 close — a sell stop above the market would be rejected,
    // and the reapply guard now skips re-arm dispatches at stale levels.
    await sendBracket(app, 'RANGE-C', originalBracketC, 'short', 29350);

    const originalBuySellCount = fetchCalls.length;
    expect(originalBuySellCount).toBe(3);

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_filled', originalBracketA, {
        side: 'short',
        action: 'sell',
        extras: { rangeName: 'RANGE-A' },
      }));

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', originalBracketA, {
        side: 'short',
        entryPrice: 29400,
        exitPrice: 29440,
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));

    expect(res.status).toBe(202);

    const exitRequests = fetchCalls.filter((c) => (c.body as Record<string, unknown>).action === 'exit');
    const cancelRequests = fetchCalls.filter((c) => (c.body as Record<string, unknown>).action === 'cancel');
    const reapplyRequests = fetchCalls.filter((c) => {
      const action = (c.body as Record<string, unknown>).action;
      return action === 'buy' || action === 'sell';
    });

    expect(exitRequests).toHaveLength(1);
    expect(cancelRequests).toHaveLength(1);
    expect(reapplyRequests).toHaveLength(2);

    expect(exitRequests[0].body).toMatchObject({
      ticker: 'MNQ1!',
      action: 'exit',
      orderType: 'market',
      extras: {
        rangeName: 'RANGE-A',
        lifecycleExit: 'trade_closed',
        reapplyOnTradeClose: true,
      },
    });
    expect(exitRequests[0].body).not.toHaveProperty('bracketId');
    expect(exitRequests[0].body).not.toHaveProperty('bracketSide');
    expect(exitRequests[0].body).not.toHaveProperty('tradeId');
    expect(exitRequests[0].body).not.toHaveProperty('quantity');
    expect(exitRequests[0].body).not.toHaveProperty('quantityType');

    expect(cancelRequests[0].body).toMatchObject({
      ticker: 'MNQ1!',
      action: 'cancel',
      extras: {
        rangeName: 'RANGE-A',
        lifecycleCancel: 'trade_closed',
        reapplyOnTradeClose: true,
        reason: 'reapply_cancel',
      },
    });
    expect(cancelRequests[0].body).not.toHaveProperty('bracketId');
    expect(cancelRequests[0].body).not.toHaveProperty('bracketSide');
    expect(cancelRequests[0].body).not.toHaveProperty('tradeId');

    for (const req of reapplyRequests) {
      const body = req.body as Record<string, unknown>;
      expect(['buy', 'sell']).toContain(body.action);
      expect(body).toHaveProperty('bracketId');
      expect(body).toHaveProperty('tradeId');
      expect(body.bracketId).not.toBe(originalBracketA);
      expect(body.tradeId).not.toBe(originalBracketA);
      expect(body).not.toHaveProperty('eventType');
      expect((body.extras as Record<string, unknown>)).toMatchObject({
        rangeName: expect.any(String),
      });
    }

    const reapplyedRangeNames = reapplyRequests.map((r) => (r.body as Record<string, unknown>).extras?.rangeName as string);
    expect(reapplyedRangeNames).not.toContain('RANGE-A');
    expect(reapplyedRangeNames.sort()).toEqual(['RANGE-B', 'RANGE-C']);
  });

  it('a hung dispatch still fails closed and lets other accounts dispatch', async () => {
    const database = new Database(':memory:');
    const user = database.createUser('test@example.com');
    const hangAccount = database.createAccount({ userId: user.id, name: 'Hang Account', startingBalanceCents: 0 });
    const okAccount = database.createAccount({ userId: user.id, name: 'Ok Account', startingBalanceCents: 0 });
    const HANG_URL = 'https://hooks.traderspost.io/webhook/hang';
    const OK_URL = 'https://hooks.traderspost.io/webhook/ok';
    for (const [acct, url] of [[hangAccount, HANG_URL], [okAccount, OK_URL]] as const) {
      database.upsertTradersPostAccountDestination(user.id, acct.id, url, undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, true);
    }
    database.createTrackedRange('HANG RANGE', user.id);
    database.upsertRangeConfiguration({
      rangeName: 'HANG RANGE',
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
      runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
      runFriday: true, runSaturday: true, runSunday: true,
      entriesPerRange: 1,
    });
    for (const acct of [hangAccount, okAccount]) {
      database.upsertRangeRoute({
        userId: user.id,
        rangeName: 'HANG RANGE',
        accountId: acct.id,
        extensionEnabled: false,
        traderspostEnabled: true,
        runScheduled: false,
      });
    }

    const fetchedUrls: string[] = [];
    const mockFetch = async (url: string | URL) => {
      fetchedUrls.push(String(url));
      if (String(url) === HANG_URL) return new Promise<Response>(() => {});
      return new Response('{"success":true}', { status: 200, statusText: 'OK' });
    };
    const app = createApp(database, {
      ...appOptions(mockFetch as unknown as typeof globalThis.fetch),
      traderspostHardTimeoutMs: 60,
      traderspostQueueTaskTimeoutMs: 5_000,
    });

    const sendEntry = (bracketId: string) => supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({
        ticker: 'MNQ1!',
        action: 'buy',
        orderType: 'stop',
        stopPrice: 29500,
        quantity: 1,
        bracketId,
        tradeId: bracketId,
        extras: { rangeName: 'HANG RANGE' },
      });

    await sendEntry('hang-bracket-1');

    // Both accounts got a delivery row; the hung account resolved as failed +
    // uncertain broker order instead of wedging the fan-out forever.
    const hangOrders = database.listBrokerOrdersByAccount(hangAccount.id);
    const okOrders = database.listBrokerOrdersByAccount(okAccount.id);
    expect(hangOrders).toHaveLength(1);
    expect(hangOrders[0].status).toBe('uncertain');
    expect(okOrders).toHaveLength(1);
    expect(okOrders[0].status).toBe('acknowledged');
    expect(fetchedUrls.filter((u) => u === OK_URL)).toHaveLength(1);

    // The wedged account's queue was released: a fresh alert dispatches again.
    await sendEntry('hang-bracket-2');
    expect(fetchedUrls.filter((u) => u === HANG_URL)).toHaveLength(2);
    expect(database.listBrokerOrdersByAccount(hangAccount.id)).toHaveLength(2);
  });

  it('does not mutate the ledger when a send resolves after the limiter watchdog released it', async () => {
    const database = new Database(':memory:');
    const user = database.createUser('test@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Slow Account', startingBalanceCents: 0 });
    database.upsertTradersPostAccountDestination(user.id, account.id, WEBHOOK_URL, undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, true);
    database.createTrackedRange('SLOW RANGE', user.id);
    database.upsertRangeConfiguration({
      rangeName: 'SLOW RANGE',
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
      runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
      runFriday: true, runSaturday: true, runSunday: true,
      entriesPerRange: 1,
    });
    database.upsertRangeRoute({
      userId: user.id,
      rangeName: 'SLOW RANGE',
      accountId: account.id,
      extensionEnabled: false,
      traderspostEnabled: true,
      runScheduled: false,
    });

    // The fetch outlives the inner limiter watchdog; it resolves only after the
    // queue released the send slot, simulating an undici request whose abort
    // never takes.
    let resolveFetch: ((response: Response) => void) | undefined;
    const mockFetch = async () => new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const app = createApp(database, {
      ...appOptions(mockFetch as unknown as typeof globalThis.fetch),
      traderspostRateLimitTaskTimeoutMs: 40,
      traderspostHardTimeoutMs: 10_000,
      traderspostQueueTaskTimeoutMs: 10_000,
    });

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({
        ticker: 'MNQ1!',
        action: 'buy',
        orderType: 'stop',
        stopPrice: 29500,
        quantity: 1,
        bracketId: 'slow-bracket',
        tradeId: 'slow-bracket',
        extras: { rangeName: 'SLOW RANGE' },
      });

    // The queue-level failure path owns the released send's ledger.
    const orders = database.listBrokerOrdersByAccount(account.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('uncertain');
    const deliveryId = orders[0].proxyDeliveryId!;
    const attemptsAfterRelease = database.listProxyDeliveryAttempts(deliveryId).length;
    expect(attemptsAfterRelease).toBeGreaterThan(0);

    // The zombie fetch resolves late — the post-release callback must not flip
    // the order to acknowledged or append attempt rows alongside the next task.
    expect(resolveFetch).toBeDefined();
    resolveFetch!(new Response('{"success":true}', { status: 200, statusText: 'OK' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const ordersAfter = database.listBrokerOrdersByAccount(account.id);
    expect(ordersAfter).toHaveLength(1);
    expect(ordersAfter[0].status).toBe('uncertain');
    expect(database.listProxyDeliveryAttempts(deliveryId)).toHaveLength(attemptsAfterRelease);
    expect(database.findProxyDelivery(deliveryId)?.status).not.toBe('traderspost_delivered');
  });

  it('persists the separate take-profit obligation when the entry send is released mid-flight', async () => {
    const database = new Database(':memory:');
    const user = database.createUser('test@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Slow Account', startingBalanceCents: 0 });
    // useLimitPriceTP: the take profit is a mandatory second dispatch — if the
    // entry may have reached TradersPost, the obligation must be recorded even
    // when the queue released the task.
    database.upsertTradersPostAccountDestination(user.id, account.id, WEBHOOK_URL, undefined, undefined, true, true, false, '16:30', '16:45', false, false, 5, true);
    database.createTrackedRange('SLOW RANGE', user.id);
    database.upsertRangeConfiguration({
      rangeName: 'SLOW RANGE',
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
      runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
      runFriday: true, runSaturday: true, runSunday: true,
      entriesPerRange: 1,
    });
    database.upsertRangeRoute({
      userId: user.id,
      rangeName: 'SLOW RANGE',
      accountId: account.id,
      extensionEnabled: false,
      traderspostEnabled: true,
      runScheduled: false,
    });

    let fetchCount = 0;
    let resolveFetch: ((response: Response) => void) | undefined;
    const mockFetch = async () => {
      fetchCount += 1;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    };
    const app = createApp(database, {
      ...appOptions(mockFetch as unknown as typeof globalThis.fetch),
      traderspostRateLimitTaskTimeoutMs: 40,
      traderspostHardTimeoutMs: 10_000,
      traderspostQueueTaskTimeoutMs: 10_000,
    });

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({
        ticker: 'MNQ1!',
        action: 'buy',
        orderType: 'stop',
        stopPrice: 29500,
        quantity: 1,
        bracketId: 'slow-bracket',
        bracketSide: 'long',
        tradeId: 'slow-bracket',
        takeProfit: { percent: 0.1 },
        stopLoss: { type: 'stop', percent: 0.1 },
        extras: { rangeName: 'SLOW RANGE' },
      });

    // The entry's outcome is uncertain — the queue-level failure path owns the
    // ledger — while the zombie request is still in flight.
    const entryOrder = database.listBrokerOrdersByAccount(account.id).find((o) => o.action === 'buy');
    expect(entryOrder?.status).toBe('uncertain');

    // When the released send finally settles, the task must persist the
    // protection obligation — an intent row plus a resendable pending TP
    // delivery — without dispatching the take profit itself.
    expect(resolveFetch).toBeDefined();
    resolveFetch!(new Response('{"success":true}', { status: 200, statusText: 'OK' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(database.findPreciseTakeProfitIntent(account.id, 'SLOW RANGE', sid('SLOW RANGE', 'slow-bracket'), 'long')).toBeDefined();
    expect(database.hasPreciseTakeProfitDelivery(account.id, 'SLOW RANGE', sid('SLOW RANGE', 'slow-bracket'), 'long')).toBe(true);
    expect(fetchCount).toBe(1);
  });

  it('only returns process run forensics to admin sessions', async () => {
    const database = new Database(':memory:');
    const user = database.createUser('member@example.com');
    database.createAccount({ userId: user.id, name: 'Acct', startingBalanceCents: 0 });
    const runId = database.createProcessRun();
    database.endProcessRun(runId, { clean: false, fatal: { event: 'uncaughtException', message: 'boom', stack: 'secret-stack' } });

    const app = createApp(database, {
      ...appOptions(async () => new Response('{"success":true}', { status: 200 })),
      adminUserEmail: 'admin@example.com',
    });
    const token = createSessionToken();
    database.createSession(
      hashSessionToken(token, SESSION_SECRET),
      user.id,
      'csrf',
      new Date(Date.now() + 60_000).toISOString(),
    );

    const res = await supertest(app).get('/app/api/monitoring').set('Cookie', `bridge_session=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.processRuns).toEqual([]);
  });

  it('sweeps deliveries and orders interrupted by a restart', async () => {
    const database = new Database(':memory:');
    const user = database.createUser('test@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Acct', startingBalanceCents: 0 });
    database.createTrackedRange('SWEEP RANGE', user.id);
    const route = database.upsertRangeRoute({
      userId: user.id,
      rangeName: 'SWEEP RANGE',
      accountId: account.id,
      extensionEnabled: false,
      traderspostEnabled: true,
      runScheduled: false,
    });
    const alert = database.createProxyAlert({
      rangeName: 'SWEEP RANGE',
      action: 'buy',
      ticker: 'MNQ1!',
      payloadJson: '{}',
      sourceReference: 'sweep-bracket',
    });
    const delivery = database.createProxyDelivery({
      proxyAlertId: alert.id,
      rangeRouteId: route.id,
      userId: user.id,
      accountId: account.id,
      extensionEnabled: false,
      traderspostEnabled: true,
      status: 'pending_traderspost',
    });
    database.createBrokerOrder({
      accountId: account.id,
      rangeName: 'SWEEP RANGE',
      orderId: 'ord-pending',
      action: 'buy',
      status: 'pending',
      instrument: 'MNQ1!',
      occurredAt: new Date().toISOString(),
      proxyDeliveryId: delivery.id,
    });

    const swept = database.sweepInterruptedTradersPostDispatches();
    expect(swept).toEqual({ deliveries: 1, orders: 1 });
    expect(database.findProxyDelivery(delivery.id)?.status).toBe('traderspost_failed');
    expect(database.listBrokerOrdersByAccount(account.id)[0].status).toBe('uncertain');
  });

  it('retries a transport-level fetch failure once and ledgers both attempts', async () => {
    const { database, createRange, sendBracket } = setupFlowTest(false);
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.1:443') });
      }
      return new Response('{"success":true}', { status: 200, statusText: 'OK' });
    };
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));
    createRange('RANGE-A');
    await sendBracket(app, 'RANGE-A', 'transport-retry-bracket', 'long', 29500);
    // The single retry waits ~750ms before re-sending.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(calls).toBe(2);
    // Each outbound POST gets its own ledger row: the failed first send stays
    // uncertain (it may have reached TradersPost), the retry row (-r1) carries
    // the acknowledged outcome.
    const orders = database.listAllBrokerOrders(10);
    expect(orders).toHaveLength(2);
    const retryRow = orders.find((o) => o.orderId.endsWith('-r1'))!;
    const firstRow = orders.find((o) => !o.orderId.endsWith('-r1'))!;
    expect(retryRow.status).toBe('acknowledged');
    expect(firstRow.status).toBe('uncertain');
    expect(firstRow.errorText).toContain('ECONNREFUSED');
    const attempts = database.listProxyDeliveryAttempts(retryRow.proxyDeliveryId!);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].success).toBe(false);
    expect(attempts[0].errorText).toContain('retrying');
    expect(attempts[0].errorText).toContain('ECONNREFUSED');
    expect(attempts[1].success).toBe(true);
  });

  it('does not retry a response body-read failure — the POST was already accepted', async () => {
    const { database, createRange, sendBracket } = setupFlowTest(false);
    let calls = 0;
    // undici can reject res.text() with a TypeError carrying a cause — that is a
    // post-send failure, not a transport failure, so it must not re-dispatch.
    const mockFetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => { throw new TypeError('fetch failed', { cause: new Error('terminated: body read failed') }); },
      } as unknown as Response;
    };
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));
    createRange('RANGE-A');
    await sendBracket(app, 'RANGE-A', 'body-read-no-retry-bracket', 'long', 29500);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(calls).toBe(1);
    const orders = database.listAllBrokerOrders(10);
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe('uncertain');
  });

  it('does not auto-retry abort/timeout failures for entries', async () => {
    const { database, createRange, sendBracket } = setupFlowTest(false);
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));
    createRange('RANGE-A');
    await sendBracket(app, 'RANGE-A', 'abort-no-retry-bracket', 'long', 29500);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(calls).toBe(1);
    expect(database.listAllBrokerOrders(10)[0].status).toBe('uncertain');
  });

  it('auto-retries abort/timeout failures for cancel/exit dispatches', async () => {
    const { database, createRange } = setupFlowTest(false);
    let calls = 0;
    const mockFetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      }
      return new Response('{"success":true}', { status: 200, statusText: 'OK' });
    };
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));
    createRange('RANGE-A');
    // A cancel/exit may already be in flight when the send aborts — but a
    // duplicate flatten leg is a no-op at the broker, so it retries once.
    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({ ticker: 'MNQ1!', action: 'cancel', extras: { rangeName: 'RANGE-A', reason: 'eod_cancel' } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(calls).toBe(2);
    const orders = database.listAllBrokerOrders(10).filter((o) => o.action === 'cancel');
    expect(orders.map((o) => o.status).sort()).toEqual(['acknowledged', 'uncertain']);
    expect(orders.some((o) => o.orderId.endsWith('-r1'))).toBe(true);
  });

  it('does not send reapply payloads when reapplyOnTradeCloseEnabled is false', async () => {
    const { database, createRange, sendBracket } = setupFlowTest(false);
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));

    createRange('RANGE-A');
    createRange('RANGE-B');

    const originalBracketA = 'bracket-a';
    const originalBracketB = 'bracket-b';

    await sendBracket(app, 'RANGE-A', originalBracketA, 'short', 29400);
    await sendBracket(app, 'RANGE-B', originalBracketB, 'long', 29500);

    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('entry_filled', originalBracketA, {
        side: 'short',
        action: 'sell',
        extras: { rangeName: 'RANGE-A' },
      }));

    fetchCalls.length = 0;

    const res = await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send(makeLifecyclePayload('trade_closed', originalBracketA, {
        side: 'short',
        entryPrice: 29400,
        exitPrice: 29440,
        extras: { rangeName: 'RANGE-A', exitReason: 'take_profit' },
      }));

    expect(res.status).toBe(202);

    const exitRequests = fetchCalls.filter((c) => (c.body as Record<string, unknown>).action === 'exit');
    const cancelRequests = fetchCalls.filter((c) => (c.body as Record<string, unknown>).action === 'cancel');
    const reapplyRequests = fetchCalls.filter((c) => {
      const action = (c.body as Record<string, unknown>).action;
      return action === 'buy' || action === 'sell';
    });

    expect(exitRequests).toHaveLength(0);
    expect(cancelRequests).toHaveLength(0);
    expect(reapplyRequests).toHaveLength(0);
  });

  it('routes dispatches to the CrossTrade endpoint in the flat command format', async () => {
    const { database, user, account, createRange, sendBracket } = setupFlowTest(false);
    const { fetchCalls, mockFetch } = createMockFetch();
    const ctUrl = 'https://app.crosstrade.io/v1/send/uid/channel';
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
      false,
      { webhookUrl: ctUrl, secretKey: 'ct-secret', accountName: 'CT-ACCT' },
    );
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));
    createRange('RANGE-A');

    await sendBracket(app, 'RANGE-A', 'ct-bracket', 'long', 29500);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const entryCalls = fetchCalls.filter((c) => (c.body as Record<string, unknown>).command === 'place');
    expect(entryCalls).toHaveLength(1);
    expect(entryCalls[0].url).toBe(ctUrl);
    expect(entryCalls[0].body).toMatchObject({
      key: 'ct-secret',
      destination: 'nt8',
      account: 'CT-ACCT',
      command: 'place',
      action: 'buy',
      instrument: 'MNQ1!',
      qty: 1,
      order_type: 'stopmarket',
      stop_price: 29500,
      order_id: sid('RANGE-A', 'ct-bracket'),
    });
    // The broker ledger still records the normalized internal shape.
    const orders = database.listAllBrokerOrders(10);
    expect(orders).toHaveLength(1);
    expect(orders[0].action).toBe('buy');
    expect(orders[0].status).toBe('acknowledged');
    expect(orders[0].instrument).toBe('MNQ1!');

    // The persisted bridge log shows the wire message but never the credential —
    // `key` must be redacted before the payload is stored or streamed.
    const logs = database.listBridgeLogs({ userId: user.id, since: new Date(Date.now() - 60_000).toISOString() });
    const requestLog = logs.find((l) => l.category === 'traderspost' && l.data?.phase === 'request');
    expect(requestLog).toBeDefined();
    expect((requestLog!.data.payload as Record<string, unknown>).key).toBe('[redacted]');
    expect(JSON.stringify(requestLog!.data)).not.toContain('ct-secret');

    // Cancel maps to CrossTrade's instrument-scoped command on the same URL.
    // (Inbound `exit` alerts are bookkeeping-only by design — the exit→flatten
    // mapping is covered by the crosstrade unit tests.)
    fetchCalls.length = 0;
    await supertest(app)
      .post(`/proxy/${PROXY_SECRET}`)
      .send({ ticker: 'MNQ1!', action: 'cancel', extras: { rangeName: 'RANGE-A' } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetchCalls.every((c) => c.url === ctUrl)).toBe(true);
    expect(fetchCalls.map((c) => (c.body as Record<string, unknown>).command))
      .toEqual(['cancelorders']);
  });

  it('applies the account quantity override on TradersPost and CrossTrade dispatches', async () => {
    const { database, user, account, createRange, sendBracket } = setupFlowTest(false);
    const { fetchCalls, mockFetch } = createMockFetch();
    const app = createApp(database, appOptions(mockFetch as unknown as typeof globalThis.fetch));
    createRange('RANGE-A');

    // Percent — the alert sends quantity:1, 300% triples it.
    database.upsertTradersPostAccountDestination(
      user.id, account.id, WEBHOOK_URL,
      undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
      undefined,
      { mode: 'percent', value: 300 },
    );
    await sendBracket(app, 'RANGE-A', 'qty-pct', 'long', 29500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pctBuy = fetchCalls.find((c) => (c.body as Record<string, unknown>).action === 'buy');
    expect(pctBuy?.body).toMatchObject({ quantity: 3 });

    // Fixed — replaces the alert quantity outright.
    database.upsertTradersPostAccountDestination(
      user.id, account.id, WEBHOOK_URL,
      undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
      undefined,
      { mode: 'fixed', value: 7 },
    );
    fetchCalls.length = 0;
    await sendBracket(app, 'RANGE-A', 'qty-fixed', 'long', 29500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fixedBuy = fetchCalls.find((c) => (c.body as Record<string, unknown>).action === 'buy');
    expect(fixedBuy?.body).toMatchObject({ quantity: 7 });

    // CrossTrade path carries the same sized quantity through to `qty`.
    const ctUrl = 'https://crosstrade.local/webhook';
    database.upsertTradersPostAccountDestination(
      user.id, account.id, WEBHOOK_URL,
      undefined, undefined, true, false, false, '16:30', '16:45', false, false, 5, false,
      { webhookUrl: ctUrl, secretKey: 'ct-secret', accountName: 'CT-ACCT' },
      { mode: 'percent', value: 200 },
    );
    fetchCalls.length = 0;
    await sendBracket(app, 'RANGE-A', 'qty-ct', 'long', 29500);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ctCall = fetchCalls.find((c) => (c.body as Record<string, unknown>).command === 'place');
    expect(ctCall?.url).toBe(ctUrl);
    expect(ctCall?.body).toMatchObject({ qty: 2 });
  });
});
