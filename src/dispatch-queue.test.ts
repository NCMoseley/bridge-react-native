import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { Database } from './database.js';
import { createApp } from './server.js';
import { rangeSlugForLookup } from './webhook.js';
import { TradersPostRateLimiter } from './traderspost-rate-limiter.js';
import type { TradersPostPayload } from './webhook.js';

const SECRET = 'dispatch-queue-test';
const cleanup: Array<() => void> = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function testApp(database: Database, options: Parameters<typeof createApp>[1]) {
  const app = createApp(database, options);
  cleanup.push(() => { app.locals.dispose(); database.close(); });
  return app;
}

// Fan-out / priority / resume coverage for the dispatch lanes. The mock fetch
// measures concurrency per destination URL (one webhook per account) so tests
// can assert cross-account parallelism and intra-account queue ordering.
function fixture(accountCount: number, options: Record<string, unknown> = {}) {
  const database = new Database(':memory:');
  const user = database.createUser('dq@example.com');
  const accounts = Array.from({ length: accountCount }, (_, i) =>
    database.createAccount({ userId: user.id, name: `Acct${i}`, startingBalanceCents: 0 }));
  const calls: Array<{ accountIndex: number; payload: TradersPostPayload }> = [];
  const concurrencyByAccount = accounts.map(() => 0);
  const maxConcurrent = accounts.map(() => 0);
  // Optional per-request stall — tests use it to hold the first send in
  // flight while later payloads queue behind it.
  let beforeSend: ((payload: TradersPostPayload) => Promise<void>) | undefined;
  accounts.forEach((account, i) => {
    const webhook = `https://hooks.test/acct${i}`;
    database.upsertTradersPostAccountDestination(user.id, account.id, webhook, undefined, undefined, true, false, true, '16:30', '16:45', false, false, 5, true);
    (account as { webhook?: string }).webhook = webhook;
  });
  const mockFetch: typeof fetch = async (url, init) => {
    const i = accounts.findIndex((a) => (a as { webhook?: string }).webhook === String(url));
    if (i === -1) throw new Error(`Unexpected destination ${String(url)}`);
    const payload = JSON.parse(String(init?.body)) as TradersPostPayload;
    calls.push({ accountIndex: i, payload });
    concurrencyByAccount[i] += 1;
    maxConcurrent[i] = Math.max(maxConcurrent[i], concurrencyByAccount[i]);
    try {
      await beforeSend?.(payload);
    } finally {
      concurrencyByAccount[i] -= 1;
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
  const route = (rangeName: string, accountIndex: number) =>
    database.upsertRangeRoute({ userId: user.id, accountId: accounts[accountIndex].id, rangeName, extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
  const trackRange = (rangeName: string) => database.createTrackedRange(rangeName, user.id);
  const setBeforeSend = (fn: typeof beforeSend) => { beforeSend = fn; };
  return { database, user, accounts, app, appOptions, calls, maxConcurrent, post, route, trackRange, setBeforeSend };
}

const entry = (range: string, ticker = 'MNQ1!', index = 1): TradersPostPayload => ({
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

describe('dispatch queue', () => {
  it('circuit breaker backs a lane off after consecutive failures and resets on success', async () => {
    // threshold 2, ~30ms base backoff — a tripped lane delays the next task
    // but a success clears the breaker instantly.
    const limiter = new TradersPostRateLimiter(0, 5_000, 2, 30, 60);
    const fail = () => Promise.reject(new Error('dest down'));
    await expect(limiter.run('acct', fail)).rejects.toThrow();
    await expect(limiter.run('acct', fail)).rejects.toThrow();
    expect(limiter.breakerState('acct')).toMatchObject({ failures: 2 });
    expect(limiter.breakerState('acct').cooldownUntilMs).not.toBeNull();
    const t0 = Date.now();
    await limiter.run('acct', () => Promise.resolve(1));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    expect(limiter.breakerState('acct').failures).toBe(0);
    const t1 = Date.now();
    await limiter.run('acct', () => Promise.resolve(1));
    expect(Date.now() - t1).toBeLessThan(15);
  });

  it('breaker counts handled failures: resolved-but-failed outcomes trip it', async () => {
    // The send path resolves with a failed delivery instead of throwing —
    // a rejecting destination must still count toward the cooldown.
    const limiter = new TradersPostRateLimiter(0, 5_000, 2, 60, 120);
    const failedOutcome = () => 'failure' as const;
    await limiter.run('acct', () => Promise.resolve('send failed'), undefined, failedOutcome);
    await limiter.run('acct', () => Promise.resolve('send failed'), undefined, failedOutcome);
    expect(limiter.breakerState('acct').failures).toBe(2);
    expect(limiter.breakerState('acct').cooldownUntilMs).not.toBeNull();
    // 'neutral' neither trips nor resets — but it still waits out the cooldown.
    const t0 = Date.now();
    await limiter.run('acct', () => Promise.resolve('suppressed'), undefined, () => 'neutral');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
    expect(limiter.breakerState('acct').failures).toBe(2);
    // Cooldown elapsed during the neutral wait — success runs immediately and clears.
    await limiter.run('acct', () => Promise.resolve('delivered'), undefined, () => 'success');
    expect(limiter.breakerState('acct').failures).toBe(0);
  });


  it('fans out to routed accounts in parallel, not serially', async () => {
    const f = fixture(2);
    f.trackRange('R1');
    f.route('R1', 0);
    f.route('R1', 1);
    // Hold each send ~80ms — serial fan-out would still show maxConcurrent 1.
    f.setBeforeSend(() => sleep(80));
    await f.post(entry('R1'));
    expect(f.calls).toHaveLength(2);
    expect(f.maxConcurrent).toEqual([1, 1]);
    // Both accounts got a delivery row.
    for (const account of f.accounts) {
      const deliveries = f.database.listPendingTradersPostDeliveries(account.id);
      expect(deliveries).toHaveLength(0); // delivered, not pending
    }
  });

  it('runs cancel deliveries ahead of queued entries on the same account', async () => {
    const f = fixture(1);
    f.trackRange('R1');
    f.route('R1', 0);
    // Hold the first send so B's entry and the cancel enqueue behind it.
    let released = false;
    f.setBeforeSend(async () => { if (!released) { await sleep(60); released = true; } });
    const p1 = f.post(entry('R1', 'MNQ1!', 1));
    await sleep(20); // let A's task start running before queuing the rest
    const p2 = f.post(entry('R1', 'MNQ1!', 2));
    const p3 = f.post({ ticker: 'MNQ1!', action: 'cancel', quantity: 1, quantityType: 'fixed_quantity', extras: { rangeName: 'R1' } });
    await Promise.all([p1, p2, p3]);
    const actions = f.calls.map((c) => c.payload.action);
    // A runs first (already in flight); the cancel jumps the still-queued B.
    expect(actions).toEqual(['buy', 'cancel', 'buy']);
    expect(f.calls[2].payload.bracketId).toContain('arm-2');
  });

  it('resumes never-attempted pending deliveries on restart', async () => {
    const f = fixture(1);
    f.trackRange('R1');
    const route = f.route('R1', 0)!;
    // Simulate a delivery persisted but never dispatched (process died in
    // the queue gap) — no attempt rows.
    const payload = entry('R1');
    const alert = f.database.createProxyAlert({
      rangeName: 'R1',
      action: 'buy',
      ticker: 'MNQ1!',
      payloadJson: JSON.stringify(payload),
      sourceReference: payload.bracketId,
    });
    f.database.createProxyDelivery({
      proxyAlertId: alert.id,
      rangeRouteId: route.id,
      userId: f.user.id,
      accountId: f.accounts[0].id,
      extensionEnabled: false,
      traderspostEnabled: true,
      resumable: true,
      status: 'pending_traderspost',
    });
    await f.app.locals.recoverReapplyOperations();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].payload.action).toBe('buy');
    // Delivered, not swept to failed.
    expect(f.database.listPendingTradersPostDeliveries(f.accounts[0].id)).toHaveLength(0);
  });

  it('leaves attempted pending deliveries for the interrupted sweep', async () => {
    const f = fixture(1);
    f.trackRange('R1');
    const route = f.route('R1', 0)!;
    const payload = entry('R1');
    const alert = f.database.createProxyAlert({
      rangeName: 'R1',
      action: 'buy',
      ticker: 'MNQ1!',
      payloadJson: JSON.stringify(payload),
      sourceReference: payload.bracketId,
    });
    const delivery = f.database.createProxyDelivery({
      proxyAlertId: alert.id,
      rangeRouteId: route.id,
      userId: f.user.id,
      accountId: f.accounts[0].id,
      extensionEnabled: false,
      traderspostEnabled: true,
      status: 'pending_traderspost',
    });
    // An attempt exists — the in-flight send may have reached the broker;
    // the sweep must fail it, not resend.
    f.database.createProxyDeliveryAttempt({ proxyDeliveryId: delivery.id, success: false, errorText: 'timeout' });
    await f.app.locals.recoverReapplyOperations();
    expect(f.calls).toHaveLength(0);
    expect(f.database.findProxyDelivery(delivery.id)?.status).toBe('traderspost_failed');
  });

  it('fans 5 trades out to 10 users x 3 accounts with cross-user parallelism', async () => {
    const USER_COUNT = 10;
    const ACCOUNTS_PER_USER = 3;
    const database = new Database(':memory:');
    const users = Array.from({ length: USER_COUNT }, (_, i) => database.createUser(`u${i}@example.com`));
    const accounts = users.flatMap((user, ui) =>
      Array.from({ length: ACCOUNTS_PER_USER }, (_, ai) =>
        database.createAccount({ userId: user.id, name: `U${ui}A${ai}`, startingBalanceCents: 0 })));
    // One webhook per account — index the fetch by URL suffix.
    accounts.forEach((account, i) => {
      const user = users[Math.floor(i / ACCOUNTS_PER_USER)];
      database.upsertTradersPostAccountDestination(user.id, account.id, `https://hooks.test/u${i}`, undefined, undefined, true, false, true, '16:30', '16:45', false, false, 5, true);
    });
    const calls: Array<{ accountIndex: number; payload: TradersPostPayload }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const mockFetch: typeof fetch = async (url, init) => {
      const i = Number(String(url).split('/u').pop());
      const payload = JSON.parse(String(init?.body)) as TradersPostPayload;
      calls.push({ accountIndex: i, payload });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await sleep(30);
      } finally {
        inFlight -= 1;
      }
      return new Response('{"success":true}', { status: 200 });
    };
    const appOptions = { proxyWebhookSecret: SECRET, fetch: mockFetch };
    const app = testApp(database, appOptions);
    const post = async (payload: TradersPostPayload) => {
      const response = await supertest(app).post(`/proxy/${SECRET}`).send(payload);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      return response.body;
    };
    // Every user's every account routes the same range.
    database.createTrackedRange('R1', users[0].id);
    for (const [i, account] of accounts.entries()) {
      const user = users[Math.floor(i / ACCOUNTS_PER_USER)];
      database.upsertRangeRoute({ userId: user.id, accountId: account.id, rangeName: 'R1', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
    }
    for (let trade = 1; trade <= 5; trade += 1) {
      await post(entry('R1', 'MNQ1!', trade));
    }
    // 5 trades x 30 accounts = 150 sends, all delivered.
    expect(calls).toHaveLength(150);
    const perAccount = new Map<number, number>();
    for (const c of calls) perAccount.set(c.accountIndex, (perAccount.get(c.accountIndex) ?? 0) + 1);
    expect(perAccount.size).toBe(30);
    for (const count of perAccount.values()) expect(count).toBe(5);
    // Serial fan-out would cap at 1 in flight — lanes must overlap broadly.
    expect(maxInFlight).toBeGreaterThanOrEqual(10);
    // Nothing left pending anywhere.
    for (const account of accounts) {
      expect(database.listPendingTradersPostDeliveries(account.id)).toHaveLength(0);
    }
  });

  it('re-enqueues transport failures on cancel/flatten at the back of the lane', async () => {
    // Transport failure (TypeError with cause — undici's shape) fails the send
    // AND its inline retry; flatten-class actions are safe to duplicate so the
    // delivery defers to the back of the lane and converges.
    const f = fixture(1, { traderspostDeferredRetryBaseMs: 60 });
    f.trackRange('R1');
    f.route('R1', 0);
    let failures = 0;
    f.setBeforeSend(async () => {
      failures += 1;
      if (failures <= 3) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED') });
    });
    await f.post({ ticker: 'MNQ1!', action: 'cancel', quantity: 1, quantityType: 'fixed_quantity', extras: { rangeName: 'R1' } });
    // attempts: send1 fail + inline fail → deferred retry #1 (~60ms): send3
    // fail → deferred retry #2: send4 succeeds.
    const deadline = Date.now() + 5_000;
    while (f.calls.length < 4 && Date.now() < deadline) await sleep(50);
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every((c) => c.payload.action === 'cancel')).toBe(true);
    expect(f.database.listPendingTradersPostDeliveries(f.accounts[0].id)).toHaveLength(0);
  });

  it('does not defer failures on entries (ambiguous outcome stays operator-gated)', async () => {
    const f = fixture(1, { traderspostDeferredRetryBaseMs: 60 });
    f.trackRange('R1');
    f.route('R1', 0);
    f.setBeforeSend(async () => {
      throw Object.assign(new Error('request never settled'), { name: 'AbortError' });
    });
    await f.post(entry('R1'));
    await sleep(400);
    // One send, no deferred retry — an entry timeout may already be live.
    expect(f.calls).toHaveLength(1);
  });
});
