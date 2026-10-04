import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { Database } from './database.js';
import { createApp } from './server.js';
import { rangeSlugForLookup } from './webhook.js';
import type { TradersPostPayload } from './webhook.js';

const SECRET = 'dispatch-stress-test';
const cleanup: Array<() => void> = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function testApp(database: Database, options: Parameters<typeof createApp>[1]) {
  const app = createApp(database, options);
  cleanup.push(() => { app.locals.dispose(); database.close(); });
  return app;
}

// Stress fixture: one webhook per account, per-account concurrency counters
// and a beforeSend hook that can throw/hold sends.
function fixture(accountCount: number, options: Record<string, unknown> = {}) {
  const database = new Database(':memory:');
  const user = database.createUser('stress@example.com');
  const accounts = Array.from({ length: accountCount }, (_, i) =>
    database.createAccount({ userId: user.id, name: `S${i}`, startingBalanceCents: 0 }));
  const calls: Array<{ accountIndex: number; payload: TradersPostPayload }> = [];
  const inFlightByAccount = accounts.map(() => 0);
  const maxInFlightByAccount = accounts.map(() => 0);
  let beforeSend: ((payload: TradersPostPayload) => Promise<void>) | undefined;
  accounts.forEach((account, i) => {
    database.upsertTradersPostAccountDestination(user.id, account.id, `https://hooks.test/s${i}`, undefined, undefined, true, false, true, '16:30', '16:45', false, false, 5, true);
  });
  const mockFetch: typeof fetch = async (url, init) => {
    const i = Number(String(url).split('/s').pop());
    const payload = JSON.parse(String(init?.body)) as TradersPostPayload;
    calls.push({ accountIndex: i, payload });
    inFlightByAccount[i] += 1;
    maxInFlightByAccount[i] = Math.max(maxInFlightByAccount[i], inFlightByAccount[i]);
    try {
      await beforeSend?.(payload);
    } finally {
      inFlightByAccount[i] -= 1;
    }
    return new Response('{"success":true}', { status: 200 });
  };
  const appOptions = { proxyWebhookSecret: SECRET, fetch: mockFetch, ...options };
  const app = testApp(database, appOptions);
  const post = async (payload: TradersPostPayload) => {
    const response = await supertest(app).post(`/proxy/${SECRET}`).send(payload);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return response.body;
  };
  const route = (rangeName: string, i: number) =>
    database.upsertRangeRoute({ userId: user.id, accountId: accounts[i].id, rangeName, extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
  const trackRange = (rangeName: string) => database.createTrackedRange(rangeName, user.id);
  const setBeforeSend = (fn: typeof beforeSend) => { beforeSend = fn; };
  return { database, user, accounts, app, appOptions, calls, maxInFlightByAccount, post, route, trackRange, setBeforeSend };
}

const entry = (range: string, index: number, ticker = 'MNQ1!'): TradersPostPayload => ({
  ticker,
  action: 'buy',
  bracketId: `${rangeSlugForLookup(range)}-ultra-v5.1-${ticker}-123-${range}-long-arm-${index}`,
  bracketSide: 'long',
  quantity: 1,
  quantityType: 'fixed_quantity',
  orderType: 'stop',
  stopPrice: 25000,
  takeProfit: { percent: 0.1 },
  stopLoss: { type: 'stop', percent: 0.1 },
  extras: { rangeName: range },
});

const cancel = (range: string, ticker = 'MNQ1!'): TradersPostPayload => ({
  ticker,
  action: 'cancel',
  quantity: 1,
  quantityType: 'fixed_quantity',
  extras: { rangeName: range },
});

beforeEach(() => {
  vi.stubEnv('PROXY_ASYNC', '0');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('dispatch queue — adversarial', () => {
  it('keeps FIFO per account while a cancel jumps the queued backlog', async () => {
    const f = fixture(1);
    f.trackRange('R1');
    f.route('R1', 0);
    let firstSendDone = false;
    f.setBeforeSend(async () => { if (!firstSendDone) { await sleep(80); firstSendDone = true; } });
    // Fire 4 entries + a cancel mid-queue. Post order = lane enqueue order.
    const posts = [
      f.post(entry('R1', 1)),
      f.post(entry('R1', 2)),
      f.post(entry('R1', 3)),
      f.post(cancel('R1')),
      f.post(entry('R1', 4)),
    ];
    await sleep(10); // let e1 start before the others enqueue
    await Promise.all(posts);
    const actions = f.calls.map((c) => `${c.payload.action}:${c.payload.bracketId ?? '-'}`);
    // e1 in flight; cancel unshifted ahead of e2/e3/e4; e4 stays last.
    expect(actions).toEqual([
      'buy:' + entry('R1', 1).bracketId,
      'cancel:-',
      'buy:' + entry('R1', 2).bracketId,
      'buy:' + entry('R1', 3).bracketId,
      'buy:' + entry('R1', 4).bracketId,
    ]);
  });

  it('keeps lanes serial under a concurrent 3-account storm with failures', async () => {
    const f = fixture(3, { traderspostDeferredRetryBaseMs: 40 });
    f.trackRange('R1');
    for (let i = 0; i < 3; i += 1) f.route('R1', i);
    // Account 0's first send transport-fails → the inline retry must still
    // converge to delivered (entries never get deferred resends).
    f.setBeforeSend(async () => {
      if (f.calls.filter((c) => c.accountIndex === 0).length === 1) {
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') });
      }
    });
    const storms: Promise<unknown>[] = [];
    for (let i = 0; i < 3; i += 1) {
      for (let trade = 1; trade <= 5; trade += 1) {
        storms.push(f.post(entry('R1', trade + i * 100, i === 0 ? 'MNQ1!' : i === 1 ? 'MGC1!' : 'MES1!')));
      }
    }
    await Promise.all(storms);
    expect(f.calls.length).toBeGreaterThanOrEqual(15);
    // Lane seriality: no account ever had two sends in flight at once.
    expect(f.maxInFlightByAccount).toEqual([1, 1, 1]);
    // All 15 deliveries reached a terminal delivered status.
    for (const account of f.accounts) {
      expect(f.database.listPendingTradersPostDeliveries(account.id)).toHaveLength(0);
    }
  });

  it('restart mid-queue: queued deliveries resume, in-flight ones are swept — never double-sent', async () => {
    const f = fixture(1);
    f.trackRange('R1');
    const route = f.route('R1', 0)!;
    const makePending = async (index: number, state: 'queued' | 'inflight' | 'attempted') => {
      const payload = entry('R1', index);
      const alert = f.database.createProxyAlert({
        rangeName: 'R1', action: 'buy', ticker: 'MNQ1!',
        payloadJson: JSON.stringify(payload), sourceReference: payload.bracketId,
      });
      const delivery = f.database.createProxyDelivery({
        proxyAlertId: alert.id, rangeRouteId: route.id, userId: f.user.id,
        accountId: f.accounts[0].id, extensionEnabled: false, traderspostEnabled: true,
        resumable: state !== 'attempted',
        status: 'pending_traderspost',
      });
      if (state === 'inflight') {
        // A broker_orders row exists (upserted before fetch) but no attempt —
        // exactly the state a kill leaves when the request was on the wire.
        f.database.upsertBrokerOrder({
          accountId: f.accounts[0].id, rangeName: 'R1',
          bracketId: payload.bracketId, orderId: `bridge-${delivery.id}`,
          action: 'buy', status: 'pending', instrument: 'MNQ1!',
          proxyAlertId: alert.id, proxyDeliveryId: delivery.id,
          payloadJson: alert.payloadJson, occurredAt: delivery.createdAt,
        });
      } else if (state === 'attempted') {
        f.database.createProxyDeliveryAttempt({ proxyDeliveryId: delivery.id, success: false, errorText: 'timeout' });
      }
      return delivery;
    };
    await makePending(1, 'queued');    // never started → safe to resume
    await makePending(2, 'queued');
    const inflight = await makePending(3, 'inflight');   // kill-mid-send → sweep
    const attempted = await makePending(4, 'attempted'); // known-failed → sweep

    const restarted = testApp(f.database, f.appOptions);
    cleanup.push(() => restarted.locals.dispose());
    await restarted.locals.recoverReapplyOperations();

    // queued deliveries sent; in-flight + attempted never re-sent
    expect(f.calls).toHaveLength(2);
    const sentBrackets = f.calls.map((c) => c.payload.bracketId);
    expect(sentBrackets.some((b) => String(b).endsWith('arm-1'))).toBe(true);
    expect(sentBrackets.some((b) => String(b).endsWith('arm-2'))).toBe(true);
    expect(sentBrackets.some((b) => String(b).endsWith('arm-3'))).toBe(false);
    expect(sentBrackets.some((b) => String(b).endsWith('arm-4'))).toBe(false);
    // and the sweep resolved the unresumable ones
    expect(f.database.findProxyDelivery(inflight.id)?.status).toBe('traderspost_failed');
    expect(f.database.findProxyDelivery(attempted.id)?.status).toBe('traderspost_failed');
  });
});
