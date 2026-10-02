import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { createSessionToken, hashSessionToken } from './auth.js';
import { Database } from './database.js';
import { createApp } from './server.js';
import type { ReapplyOperation } from './reapply.js';
import { rangeSlugForLookup, scopePayloadIdsToRange, unscopeIdForRange } from './webhook.js';
import type { EntryPayload, LifecyclePayload, TradersPostPayload } from './webhook.js';

const PROXY_SECRET = 'safeguard-test-secret';
const SESSION_SECRET = 'safeguard-session-secret';
const WEBHOOK = 'https://hooks.traderspost.io/webhook/safeguard';
const cleanup: Array<() => void> = [];

const sid = (range: string, id: string) => `${rangeSlugForLookup(range)}-${id}`;

function testApp(database: Database, options: Parameters<typeof createApp>[1]) {
  const app = createApp(database, options);
  cleanup.push(() => { app.locals.dispose(); database.close(); });
  return app;
}

function webSession(database: Database, userId: string) {
  const token = createSessionToken();
  const csrfToken = createSessionToken();
  database.createSession(
    hashSessionToken(token, SESSION_SECRET),
    userId,
    csrfToken,
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  );
  return { token, csrfToken };
}

const entry = (range: string, ticker = 'MNQ1!'): EntryPayload => ({
  ticker,
  action: 'buy',
  bracketId: `br-${ticker}-${range}-long`,
  bracketSide: 'long',
  quantity: 1,
  quantityType: 'fixed_quantity',
  orderType: 'stop',
  stopPrice: 25000,
  takeProfit: { percent: 0.1 },
  stopLoss: { type: 'stop', percent: 0.1 },
  extras: { rangeName: range },
});

const lifecycle = (range: string, ticker: string, eventType: LifecyclePayload['eventType']): LifecyclePayload => ({
  eventType,
  eventId: `${eventType}-${range}-${ticker}`,
  tradeId: `br-${ticker}-${range}-long-lifecycle-long-0`,
  ticker,
  side: 'long',
  action: eventType === 'trade_closed' ? 'exit' : 'buy',
  quantity: 1,
  entryPrice: 25000,
  extras: { rangeName: range },
});

const armed = (range: string, ticker = 'MNQ1!'): LifecyclePayload => lifecycle(range, ticker, 'entry_armed');

class BrokerModel {
  calls: TradersPostPayload[] = [];
  respond: (payload: TradersPostPayload) => Response | undefined = () => undefined;
  fetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as TradersPostPayload;
    this.calls.push(payload);
    const custom = this.respond(payload);
    return custom ?? new Response('{"success":true}', { status: 200 });
  };
}

function fixture(options: { outboundTicker?: string; outboundTickerMode?: 'micros_only'; routeEnabled?: boolean } = {}) {
  const database = new Database(':memory:');
  const user = database.createUser('safeguard@example.com');
  const account = database.createAccount({ userId: user.id, name: 'Safeguard acct', startingBalanceCents: 0 });
  database.upsertTradersPostAccountDestination(user.id, account.id, WEBHOOK, options.outboundTicker, options.outboundTickerMode, true, false, false, '16:30', '16:45', false, false, 5, true);
  const broker = new BrokerModel();
  const brokers = new Map([[WEBHOOK, broker]]);
  const mockFetch: typeof fetch = async (url, init) => {
    const target = brokers.get(String(url));
    if (!target) throw new Error('Unexpected destination in isolated test');
    return target.fetch(url, init);
  };
  const app = testApp(database, { proxyWebhookSecret: PROXY_SECRET, sessionSecret: SESSION_SECRET, adminUserEmail: 'safeguard@example.com', fetch: mockFetch });
  const { token, csrfToken } = webSession(database, user.id);
  const sessionPost = (path: string, body: Record<string, unknown>) =>
    supertest(app).post(path).set('Cookie', `bridge_session=${token}`).send({ ...body, csrfToken });
  const sessionGet = (path: string) =>
    supertest(app).get(path).set('Cookie', `bridge_session=${token}`);
  const proxyPost = async (payload: TradersPostPayload | LifecyclePayload) => {
    const response = await supertest(app).post(`/proxy/${PROXY_SECRET}`).send(payload);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return response.body;
  };
  const armBracket = async (range: string, ticker = 'MNQ1!') => {
    database.createTrackedRange(range, user.id);
    database.upsertRangeRoute({ userId: user.id, accountId: account.id, rangeName: range, extensionEnabled: false, traderspostEnabled: options.routeEnabled ?? true, runScheduled: false });
    await proxyPost(entry(range, ticker));
    await proxyPost(armed(range, ticker));
  };
  return { database, user, account, broker, app, sessionPost, sessionGet, proxyPost, armBracket };
}

function reapplyOperation(f: ReturnType<typeof fixture>, overrides: Partial<ReapplyOperation> = {}): ReapplyOperation {
  return {
    id: randomUUID(),
    accountId: f.account.id,
    eventId: `evt-${randomUUID()}`,
    instrument: 'MNQ1!',
    route: { id: 'route-1', userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    payload: { eventType: 'trade_closed', eventId: 'evt-1', tradeId: 't-1', ticker: 'MNQ1!', side: 'long', action: 'exit', quantity: 1, closedAt: new Date().toISOString(), realizedTicks: 1, realizedDollars: 1, outcome: 'win', extras: { rangeName: 'A' } },
    occurredAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    destinationKey: 'key',
    completed: false,
    planned: true,
    arms: [],
    steps: [],
    ...overrides,
  };
}

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

describe('cancel-all safeguard', () => {
  it('does not reconcile bookkeeping when TradersPost reports success:false with HTTP 200', async () => {
    const f = fixture();
    await f.armBracket('A');
    f.broker.respond = () => new Response('{"success":false,"failureMessage":"no open orders"}', { status: 200 });
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    const row = f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long');
    expect(row?.state).toBe('armed');
    expect(res.body.reconciled.flattenedPositions).toBe(0);
  });

  it('marks the order uncertain and completes the flatten when a fetch never settles', async () => {
    const f = fixture();
    await f.armBracket('A');
    f.broker.fetch = () => new Promise<Response>(() => {});
    const database = f.database;
    const app = testApp(database, { proxyWebhookSecret: PROXY_SECRET, sessionSecret: SESSION_SECRET, adminUserEmail: 'safeguard@example.com', fetch: f.broker.fetch, traderspostHardTimeoutMs: 50 });
    const { token, csrfToken } = webSession(database, f.user.id);
    const res = await supertest(app).post('/app/exit-all-safeguard').set('Cookie', `bridge_session=${token}`).send({ accountId: f.account.id, csrfToken });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeGreaterThan(0);
    const orders = database.listBrokerOrdersByAccount(f.account.id).filter((o) => o.orderId.startsWith('bridge-safeguard-'));
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.status === 'uncertain')).toBe(true);
  });

  it('marks the order uncertain when the account queue watchdog releases the flatten mid-send', async () => {
    const f = fixture();
    await f.armBracket('A');
    let resolveFetch: ((response: Response) => void) | undefined;
    f.broker.fetch = () => new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const database = f.database;
    // The outer account-queue watchdog releases the task while the inner
    // limiter is still inside its window — the inner run() then resolves
    // normally once the send settles, so the released send itself must record
    // the pending order uncertain instead of orphaning it.
    const app = testApp(database, {
      proxyWebhookSecret: PROXY_SECRET,
      sessionSecret: SESSION_SECRET,
      adminUserEmail: 'safeguard@example.com',
      fetch: f.broker.fetch,
      traderspostSafeguardTaskTimeoutMs: 40,
      traderspostRateLimitTaskTimeoutMs: 10_000,
      traderspostHardTimeoutMs: 10_000,
    });
    const { token, csrfToken } = webSession(database, f.user.id);
    const res = await supertest(app).post('/app/exit-all-safeguard').set('Cookie', `bridge_session=${token}`).send({ accountId: f.account.id, csrfToken });
    expect(res.status).toBe(500);
    expect(resolveFetch).toBeDefined();
    resolveFetch!(new Response('{"success":true}', { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const orders = database.listBrokerOrdersByAccount(f.account.id).filter((o) => o.orderId.startsWith('bridge-safeguard-'));
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.status === 'uncertain')).toBe(true);
  });

  it('records safeguard dispatches in the broker order ledger', async () => {
    const f = fixture();
    await f.armBracket('A');
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);
    const orders = f.database.listBrokerOrdersByAccount(f.account.id);
    const safeguardOrders = orders.filter((o) => o.orderId.startsWith('bridge-safeguard-'));
    expect(safeguardOrders.length).toBeGreaterThan(0);
    // Acknowledged at dispatch; the reconcile then closes exit rows for flattened roots.
    expect(safeguardOrders.every(o => o.action === 'exit' && (o.status === 'acknowledged' || o.status === 'closed'))).toBe(true);
  });

  it('reconciles local tickers after destination mapping (outboundTicker override NQ -> MNQ)', async () => {
    const f = fixture({ outboundTicker: 'MNQ1!' });
    await f.armBracket('A', 'NQ1!');
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);
    expect(f.broker.calls.every(p => p.ticker === 'MNQ1!')).toBe(true);
    const row = f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-NQ1!-A-long', 'long');
    expect(row?.state).toBe('cancelled');
  });

  it('does not reconcile on a 2xx response without an explicit success body', async () => {
    const f = fixture();
    await f.armBracket('A');
    f.broker.respond = () => new Response('', { status: 200 });
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(res.body.reconciled.flattenedPositions).toBe(0);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long')?.state).toBe('armed');
    const order = f.database.listBrokerOrdersByAccount(f.account.id).find((o) => o.orderId.startsWith('bridge-safeguard-'));
    expect(order?.status).toBe('uncertain');
  });

  it('normalizes month-coded instruments before micros_only destination mapping', async () => {
    const f = fixture({ outboundTickerMode: 'micros_only' });
    await f.armBracket('A', 'NQU26');
    f.broker.calls = [];
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);
    expect(f.broker.calls.length).toBeGreaterThan(0);
    // No call may go out as an NQ month contract — month codes normalize to continuous
    // before micros_only maps them to MNQ.
    expect(f.broker.calls.every((p) => !String(p.ticker).startsWith('NQ'))).toBe(true);
    expect(f.broker.calls.some((p) => p.ticker === 'MNQ1!')).toBe(true);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-NQU26-A-long', 'long')?.state).toBe('cancelled');
  });

  it('normalizes a single-digit-year instrument before micros_only destination mapping', async () => {
    const f = fixture({ outboundTickerMode: 'micros_only' });
    await f.armBracket('A', 'NQU6');
    f.broker.calls = [];
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);
    // A one-digit year (NQU6) is the same NQ September contract as NQU26 — it must
    // reach the broker as the micro continuous, not an unmapped month ticker.
    expect(f.broker.calls.every((p) => !String(p.ticker).startsWith('NQ'))).toBe(true);
    expect(f.broker.calls.some((p) => p.ticker === 'MNQ1!')).toBe(true);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-NQU6-A-long', 'long')?.state).toBe('cancelled');
  });

  it('flattens the continuous ticker when the exact outbound ticker is month-coded', async () => {
    const f = fixture({ outboundTicker: 'MNQU26' });
    await f.armBracket('A', 'MNQ1!');
    f.broker.calls = [];
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);
    // Entries re-normalize the exact outbound override to continuous (MNQ1!); the
    // safeguard must flatten the same instrument or it misses the real positions.
    expect(f.broker.calls.every((p) => p.ticker === 'MNQ1!')).toBe(true);
  });
});

describe('account deprecation', () => {
  it('flattens the broker and retires open brackets when deprecating a live account', async () => {
    const f = fixture();
    await f.armBracket('A');
    const res = await f.sessionPost('/app/accounts/deprecate', { accountId: f.account.id, deprecated: 'true' });
    expect(res.status).toBe(204);
    // The deprecate close-out reuses the safeguard flatten: a market exit with
    // cancel:true reaches TradersPost for the armed instrument.
    expect(f.broker.calls.some((p) => p.action === 'exit' && p.ticker === 'MNQ1!')).toBe(true);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long')?.state).toBe('cancelled');
    expect(f.database.findAccountById(f.account.id)?.deprecated).toBeTruthy();
  });

  it('closes the journal locally without broker traffic when the destination is disabled', async () => {
    const f = fixture();
    f.database.upsertTradersPostAccountDestination(f.user.id, f.account.id, WEBHOOK, undefined, undefined, false, false, false, '16:30', '16:45', false, false, 5, true);
    await f.armBracket('A');
    const res = await f.sessionPost('/app/accounts/deprecate', { accountId: f.account.id, deprecated: 'true' });
    expect(res.status).toBe(204);
    expect(f.broker.calls.length).toBe(0);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long')?.state).toBe('cancelled');
    expect(f.database.findAccountById(f.account.id)?.deprecated).toBeTruthy();
  });
});

describe('flatten submitted instruments', () => {
  it('does not send broker traffic for alerts that never reached TradersPost', async () => {
    const f = fixture({ routeEnabled: false });
    f.database.createTrackedRange('BLOCKED', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'BLOCKED', extensionEnabled: false, traderspostEnabled: false, runScheduled: false });
    await f.proxyPost(entry('BLOCKED', 'ES1!'));
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    expect(f.broker.calls).toEqual([]);
    expect(res.body.accounts).toEqual([]);
  });

  it('flattens instruments whose recent deliveries reached TradersPost', async () => {
    const f = fixture();
    await f.armBracket('A', 'ES1!');
    f.broker.calls = [];
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    expect(f.broker.calls.length).toBeGreaterThan(0);
    expect(f.broker.calls.every(p => p.ticker.startsWith('ES'))).toBe(true);
  });

  it('does not treat a definitely-rejected entry as submitted state', async () => {
    const f = fixture();
    f.database.createTrackedRange('REJ', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'REJ', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
    f.broker.respond = () => new Response('{"success":false,"failureMessage":"rejected"}', { status: 200 });
    await f.proxyPost(entry('REJ', 'ES1!'));
    f.broker.respond = () => undefined;
    expect(f.database.listBrokerOrdersByAccount(f.account.id).some(o => o.status === 'rejected')).toBe(true);
    f.broker.calls = [];
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    expect(f.broker.calls).toEqual([]);
  });

  it('still treats a delivery with an uncertain outcome as submitted state', async () => {
    const f = fixture();
    f.database.createTrackedRange('UNC', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'UNC', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
    f.broker.respond = () => new Response('upstream error', { status: 503 });
    await f.proxyPost(entry('UNC', 'ES1!'));
    f.broker.respond = () => undefined;
    expect(f.database.listBrokerOrdersByAccount(f.account.id).some(o => o.status === 'uncertain')).toBe(true);
    f.broker.calls = [];
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    expect(f.broker.calls.length).toBeGreaterThan(0);
  });

  it('retires extension-enabled pending deliveries so their queued send cannot fire after flatten', async () => {
    const f = fixture();
    f.database.createTrackedRange('EXT', f.user.id);
    const route = f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'EXT', extensionEnabled: true, traderspostEnabled: true, runScheduled: false })!;
    const alert = f.database.createProxyAlert({
      rangeName: 'EXT',
      action: 'buy',
      ticker: 'ES1!',
      payloadJson: JSON.stringify(entry('EXT', 'ES1!')),
      sourceReference: 'br-ext',
    });
    const delivery = f.database.createProxyDelivery({
      proxyAlertId: alert.id,
      rangeRouteId: route.id,
      userId: f.user.id,
      accountId: f.account.id,
      extensionEnabled: true,
      traderspostEnabled: true,
      status: 'extension_draft_created_and_pending_traderspost',
    });
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    expect(f.broker.calls.some(p => String(p.ticker).startsWith('ES'))).toBe(true);
    expect(f.database.findProxyDelivery(delivery.id)?.status).toBe('suppressed_safeguard');
  });

  it('reports every disabled-destination account as skipped, even with no submitted state', async () => {
    const f = fixture();
    const disabled = f.database.createAccount({ userId: f.user.id, name: 'Disabled acct', startingBalanceCents: 0 });
    f.database.upsertTradersPostAccountDestination(f.user.id, disabled.id, `${WEBHOOK}-off`, undefined, undefined, false);
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    expect(res.body.skipped).toContain('Disabled acct (destination disabled)');
  });

  it('discovers and reconciles submitted state beyond the broker-order display cap', async () => {
    const f = fixture();
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'OLD', orderId: 'ord-old', action: 'buy', status: 'acknowledged', instrument: 'ES1!', occurredAt: new Date().toISOString() });
    for (let i = 0; i < 510; i += 1) {
      f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'PAD', orderId: `ord-pad-${i}`, action: 'buy', status: 'closed', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    }
    // Force the open row to be the oldest so a newest-first display cap would hide it.
    (f.database as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
      .db.prepare('UPDATE broker_orders SET created_at = ? WHERE order_id = ?').run('2020-01-01T00:00:00.000Z', 'ord-old');
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    expect(f.broker.calls.some(p => String(p.ticker).startsWith('ES'))).toBe(true);
    expect(f.database.findBrokerOrder(f.account.id, 'ord-old')?.status).toBe('cancelled');
  });

  it('does not synthesize cancel history for a bracket that filled while the flatten was in flight', async () => {
    const f = fixture();
    await f.armBracket('A');
    // A Pine fill lands while the safeguard's broker request is in flight — monitor
    // writes do not wait on the account queue, so the armed snapshot is stale.
    f.broker.respond = () => {
      (f.database as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
        .db.prepare("UPDATE bracket_monitor SET state = 'filled' WHERE account_id = ? AND range_name = ?")
        .run(f.account.id, 'A');
      return new Response('{"success":true}', { status: 200 });
    };
    const res = await f.sessionPost('/app/debugging/flatten-submitted-instruments', {});
    expect(res.status).toBe(200);
    const events = f.database.listRangeTradeEventsByTrade('A', sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    // The stale armed snapshot must not synthesize a working-order cancel for the live
    // fill; the filled-position reconcile records a real breakeven exit instead.
    expect(events.some(e => e.eventType === 'entry_cancelled')).toBe(false);
    expect(events.some(e => e.eventType === 'exit_filled')).toBe(true);
    expect(events.some(e => e.eventType === 'trade_closed')).toBe(true);
  });
});

describe('broker order ledger lifecycle', () => {
  const entryOrder = (f: ReturnType<typeof fixture>, bracket = 'br-MNQ1!-A-long') =>
    f.database.listBrokerOrdersByAccount(f.account.id).find((o) => o.bracketId === sid('A', bracket) && o.action === 'buy');

  it('transitions an ordinary entry order through Pine lifecycle events', async () => {
    const f = fixture();
    await f.armBracket('A');
    expect(entryOrder(f)?.status).toBe('acknowledged');
    await f.proxyPost(lifecycle('A', 'MNQ1!', 'entry_filled'));
    expect(entryOrder(f)?.status).toBe('filled');
    await f.proxyPost({
      ...lifecycle('A', 'MNQ1!', 'trade_closed'),
      closedAt: new Date().toISOString(),
      realizedTicks: 100,
      realizedDollars: 200,
      outcome: 'win',
    });
    expect(entryOrder(f)?.status).toBe('closed');
  });

  it('marks an ordinary entry order cancelled on entry_cancelled', async () => {
    const f = fixture();
    await f.armBracket('A');
    await f.proxyPost(lifecycle('A', 'MNQ1!', 'entry_cancelled'));
    expect(entryOrder(f)?.status).toBe('cancelled');
  });

  it('transitions a cancelled entry order to filled when Pine reports the fill late', async () => {
    const f = fixture();
    await f.armBracket('A');
    await f.proxyPost(lifecycle('A', 'MNQ1!', 'entry_cancelled'));
    expect(entryOrder(f)?.status).toBe('cancelled');
    await f.proxyPost(lifecycle('A', 'MNQ1!', 'entry_filled'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long')?.state).toBe('filled');
    expect(entryOrder(f)?.status).toBe('filled');
  });

  it('resends a failed entry delivery through the journal resend endpoint', async () => {
    const f = fixture();
    f.broker.respond = () => new Response('rejected', { status: 400 });
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    expect(open?.entryArmedDeliveryStatus).toBe('failed');
    expect(open?.entryArmedDeliveryId).toBeTruthy();
    f.broker.respond = () => undefined;
    f.broker.calls = [];
    const res = await f.sessionPost('/app/api/journal/resend-delivery', { deliveryId: open!.entryArmedDeliveryId });
    expect(res.status).toBe(200);
    expect(f.broker.calls.filter((p) => p.action === 'buy')).toHaveLength(1);
    expect(f.database.findProxyDeliveryForRetry(open!.entryArmedDeliveryId!)?.delivery.status).toBe('traderspost_delivered');
  });

  it('resends an already-delivered entry from the journal resend endpoint', async () => {
    const f = fixture();
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    expect(open?.entryArmedDeliveryStatus).toBe('delivered');
    f.broker.calls = [];
    const res = await f.sessionPost('/app/api/journal/resend-delivery', { deliveryId: open!.entryArmedDeliveryId });
    expect(res.status).toBe(200);
    expect(f.broker.calls.filter((p) => p.action === 'buy')).toHaveLength(1);
  });

  it('resends a suppressed entry while its bracket is still live', async () => {
    const f = fixture();
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    f.database.updateProxyDeliveryStatus(open!.entryArmedDeliveryId!, 'suppressed_guard');
    const blocked = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    expect(blocked?.entryArmedDeliveryStatus).toBe('blocked');
    f.broker.calls = [];
    const res = await f.sessionPost('/app/api/journal/resend-delivery', { deliveryId: open!.entryArmedDeliveryId });
    expect(res.status).toBe(200);
    expect(f.broker.calls.filter((p) => p.action === 'buy')).toHaveLength(1);
    expect(f.database.findProxyDeliveryForRetry(open!.entryArmedDeliveryId!)?.delivery.status).toBe('traderspost_delivered');
  });

  it('refuses to resend a suppressed entry whose bracket already resolved', async () => {
    const f = fixture();
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    f.database.updateProxyDeliveryStatus(open!.entryArmedDeliveryId!, 'suppressed_guard');
    const monitor = f.database.listActiveBracketMonitorEntries(f.account.id)
      .find((e) => e.bracketId === sid('A', 'br-MNQ1!-A-long'));
    f.database.retireBracketMonitorEntry(f.user.id, monitor!, 'entry_cancelled', 'cancel-test', new Date().toISOString());
    f.broker.calls = [];
    const res = await f.sessionPost('/app/api/journal/resend-delivery', { deliveryId: open!.entryArmedDeliveryId });
    expect(res.status).toBe(409);
    expect(f.broker.calls.filter((p) => p.action === 'buy')).toHaveLength(0);
  });

  it('refuses to resend a suppressed duplicate entry', async () => {
    const f = fixture();
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    f.database.updateProxyDeliveryStatus(open!.entryArmedDeliveryId!, 'suppressed_duplicate');
    f.broker.calls = [];
    const res = await f.sessionPost('/app/api/journal/resend-delivery', { deliveryId: open!.entryArmedDeliveryId });
    expect(res.status).toBe(409);
    expect(f.broker.calls.filter((p) => p.action === 'buy')).toHaveLength(0);
  });

  it('refuses to resend a delivery owned by another user', async () => {
    const f = fixture();
    f.broker.respond = () => new Response('rejected', { status: 400 });
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    const other = f.database.createUser('other-resend@example.com');
    const { token, csrfToken } = webSession(f.database, other.id);
    const res = await supertest(f.app).post('/app/api/journal/resend-delivery')
      .set('Cookie', `bridge_session=${token}`)
      .send({ deliveryId: open!.entryArmedDeliveryId, csrfToken });
    expect(res.status).toBe(404);
  });

  it('resends an entry even while a prior broker attempt is uncertain', async () => {
    const f = fixture();
    f.broker.respond = () => new Response('oops', { status: 500 });
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    expect(open?.entryArmedDeliveryStatus).toBe('failed');
    expect(f.database.listBrokerOrdersForDelivery(open!.entryArmedDeliveryId!).some((o) => o.status === 'uncertain')).toBe(true);
    f.broker.respond = () => undefined;
    f.broker.calls = [];
    const res = await f.sessionPost('/app/api/journal/resend-delivery', { deliveryId: open!.entryArmedDeliveryId });
    expect(res.status).toBe(200);
    expect(res.body.delivery.status).toBe('traderspost_delivered');
    // Operator-initiated resends are allowed to double the order if the earlier
    // request secretly reached TradersPost — the uncertain attempt stays
    // unresolved in the ledger rather than being overwritten.
    expect(f.broker.calls.filter((p) => p.action === 'buy')).toHaveLength(1);
    expect(f.database.listBrokerOrdersForDelivery(open!.entryArmedDeliveryId!).some((o) => o.status === 'uncertain')).toBe(true);
  });

  it('refuses to resend an entry after the destination is disabled', async () => {
    const f = fixture();
    await f.armBracket('A');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    expect(open?.entryArmedDeliveryStatus).toBe('delivered');
    f.database.upsertTradersPostAccountDestination(f.user.id, f.account.id, WEBHOOK, undefined, undefined, false, false, false, '16:30', '16:45', false, false, 5, true);
    f.broker.calls = [];
    const res = await f.sessionPost('/app/api/journal/resend-delivery', { deliveryId: open!.entryArmedDeliveryId });
    expect(res.status).toBe(200);
    expect(res.body.delivery.status).toBe('routing_disabled');
    expect(f.broker.calls.filter((p) => p.action === 'buy')).toHaveLength(0);
  });

  it('keeps an earlier uncertain attempt unresolved when Pine fills after a later attempt', async () => {
    const f = fixture();
    f.broker.respond = () => new Response('oops', { status: 500 });
    await f.armBracket('A');
    const first = f.database.listBrokerOrdersByAccount(f.account.id)
      .find((o) => o.action === 'buy' && o.bracketId === sid('A', 'br-MNQ1!-A-long'));
    expect(first?.status).toBe('uncertain');
    f.database.upsertBrokerOrder({
      accountId: f.account.id,
      rangeName: 'A',
      bracketId: sid('A', 'br-MNQ1!-A-long'),
      orderId: 'manual-later-attempt',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MNQ1!',
      side: 'long',
      quantity: 1,
      occurredAt: new Date().toISOString(),
    });
    await f.proxyPost(lifecycle('A', 'MNQ1!', 'entry_filled'));
    const orders = f.database.listBrokerOrdersByAccount(f.account.id)
      .filter((o) => o.action === 'buy' && o.bracketId === sid('A', 'br-MNQ1!-A-long'));
    expect(orders.find((o) => o.orderId === 'manual-later-attempt')?.status).toBe('filled');
    expect(orders.find((o) => o.orderId === first!.orderId)?.status).toBe('uncertain');
  });

  it('flattens a position recorded under a contract outside the generated month pair', async () => {
    const f = fixture();
    await f.armBracket('A', 'NQZ26');
    await f.proxyPost(lifecycle('A', 'NQZ26', 'entry_filled'));
    expect(f.database.getOpenPositionsForAccount(f.account.id, 'NQZ26').length).toBeGreaterThan(0);
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.reconciled.flattenedPositions).toBeGreaterThan(0);
    expect(f.database.getOpenPositionsForAccount(f.account.id, 'NQZ26')).toHaveLength(0);
  });

  it('does not regress a filled monitor to entry_cancelled during safeguard reconcile', async () => {
    const f = fixture();
    await f.armBracket('A');
    const monitor = f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long');
    expect(monitor?.state).toBe('armed');
    let midFlight = true;
    f.broker.respond = () => {
      if (midFlight) {
        midFlight = false;
        // Pine fills and closes while the flatten request is in flight.
        const now = new Date().toISOString();
        f.database.retireBracketMonitorEntry(f.user.id, monitor!, 'entry_filled', 'mid-fill', now);
        f.database.createTradeEvent({
          userId: f.user.id,
          accountId: f.account.id,
          rangeName: 'A',
          eventId: 'mid-close',
          tradeId: 'br-MNQ1!-A-long-lifecycle-long-0',
          eventType: 'trade_closed',
          instrument: 'MNQ1!',
          side: 'long',
          action: 'exit',
          quantity: 1,
          realizedTicksCents: 0,
          realizedDollarsCents: 0,
          outcome: 'breakeven',
          occurredAt: now,
        });
      }
      return new Response('{"success":true}', { status: 200 });
    };
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    const row = f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long');
    expect(row?.state).toBe('closed');
  });

  it('keeps a separate ledger row for each retry dispatch attempt', async () => {
    const f = fixture();
    f.database.createTrackedRange('A', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
    f.broker.respond = () => new Response('{"success":false,"failureMessage":"no"}', { status: 200 });
    await f.proxyPost(entry('A'));
    f.broker.respond = () => undefined;
    const rejected = f.database.listBrokerOrdersByAccount(f.account.id).find((o) => o.status === 'rejected');
    expect(rejected?.proxyDeliveryId).toBeTruthy();
    const res = await supertest(f.app)
      .post(`/admin/proxy-deliveries/${rejected!.proxyDeliveryId}/retry`)
      .set('x-admin-key', process.env.ADMIN_API_KEY!)
      .send({});
    expect(res.status).toBe(200);
    const rows = f.database.listBrokerOrdersByAccount(f.account.id).filter((o) => o.proxyDeliveryId === rejected!.proxyDeliveryId);
    expect(rows).toHaveLength(2);
    expect(rows.find((o) => o.orderId === `bridge-${rejected!.proxyDeliveryId}`)?.status).toBe('rejected');
    const retry = rows.find((o) => o.orderId === `bridge-${rejected!.proxyDeliveryId}-r1`);
    expect(retry?.status).toBe('acknowledged');
  });

  it('records suppressed_duplicate when a cleanup retry finds the cleanup already delivered', async () => {
    const f = fixture();
    f.database.createTrackedRange('A', f.user.id);
    const route = f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: false })!;
    const bracketId = 'br-MNQ1!-A-long';
    const deliveryFor = (payload: Record<string, unknown>, status: 'traderspost_delivered' | 'traderspost_failed') => {
      const alert = f.database.createProxyAlert({
        rangeName: 'A',
        action: 'sell',
        ticker: 'MNQ1!',
        payloadJson: JSON.stringify(payload),
        sourceReference: bracketId,
      });
      return f.database.createProxyDelivery({
        proxyAlertId: alert.id,
        rangeRouteId: route.id,
        userId: f.user.id,
        accountId: f.account.id,
        extensionEnabled: false,
        traderspostEnabled: true,
        status,
      });
    };
    // A successful precise TP plus a successful cleanup — the retry must see both.
    deliveryFor({ ticker: 'MNQ1!', action: 'sell', bracketId, bracketSide: 'long', extras: { rangeName: 'A', preciseTakeProfitAfterFill: true } }, 'traderspost_delivered');
    const cleanupPayload = { ticker: 'MNQ1!', action: 'sell', bracketId, bracketSide: 'long', extras: { rangeName: 'A', preciseTakeProfitStopoutCleanup: true } };
    deliveryFor(cleanupPayload, 'traderspost_delivered');
    const failed = deliveryFor(cleanupPayload, 'traderspost_failed');
    f.database.upsertPreciseTakeProfitIntent({ accountId: f.account.id, rangeName: 'A', bracketId, instrument: 'MNQ1!', side: 'long', action: 'sell', payloadJson: '{}' });
    f.broker.calls = [];
    const res = await supertest(f.app)
      .post(`/admin/proxy-deliveries/${failed.id}/retry`)
      .set('x-admin-key', process.env.ADMIN_API_KEY!)
      .send({});
    expect(res.status).toBe(200);
    expect(f.broker.calls).toEqual([]);
    expect(f.database.findProxyDelivery(failed.id)?.status).toBe('suppressed_duplicate');
  });

  it('shows the entry delivery, not a precise take profit delivery sharing the bracket id', async () => {
    const f = fixture();
    await f.armBracket('A');
    const route = f.database.listRangeRoutes(f.user.id).find((r) => r.rangeName === 'A')!;
    const bracketId = 'br-MNQ1!-A-long';
    // A precise-TP order shares the entry's source_reference but carries the
    // opposite action — it must not be mistaken for the entry delivery.
    const tpAlert = f.database.createProxyAlert({
      rangeName: 'A',
      action: 'sell',
      ticker: 'MNQ1!',
      payloadJson: JSON.stringify({
        ticker: 'MNQ1!',
        action: 'sell',
        bracketId,
        bracketSide: 'long',
        quantity: 1,
        extras: { rangeName: 'A', preciseTakeProfitAfterFill: true },
      }),
      sourceReference: bracketId,
    });
    const tpDelivery = f.database.createProxyDelivery({
      proxyAlertId: tpAlert.id,
      rangeRouteId: route.id,
      userId: f.user.id,
      accountId: f.account.id,
      extensionEnabled: false,
      traderspostEnabled: true,
      status: 'traderspost_failed',
    });
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id)
      .openTrades.find((t) => t.tradeId === sid('A', 'br-MNQ1!-A-long-lifecycle-long-0'));
    expect(open?.entryArmedDeliveryStatus).toBe('delivered');
    expect(open?.entryArmedDeliveryId).not.toBe(tpDelivery.id);
  });

  it('does not synthesize duplicate cancel history for a bracket with a journaled lifecycle close', async () => {
    const f = fixture();
    await f.armBracket('A');
    const tradeId = 'br-MNQ1!-A-long-lifecycle-long-0';
    const scopedTradeId = sid('A', tradeId);
    // A lifecycle close is already journaled for this trade while the monitor row
    // is still armed — the flatten must not write a second synthetic cancellation.
    f.database.createTradeEvent({
      userId: f.user.id,
      accountId: f.account.id,
      rangeName: 'A',
      eventId: `tc-${tradeId}`,
      tradeId,
      eventType: 'trade_closed',
      instrument: 'MNQ1!',
      side: 'long',
      action: 'exit',
      quantity: 1,
      realizedTicksCents: 0,
      realizedDollarsCents: 0,
      outcome: 'breakeven',
      occurredAt: new Date().toISOString(),
    });
    const res = await f.sessionPost('/app/exit-all-safeguard', { accountId: f.account.id });
    expect(res.status).toBe(200);
    const events = f.database.listRangeTradeEventsByTrade('A', scopedTradeId);
    expect(events.filter((e) => e.eventType === 'entry_cancelled')).toHaveLength(0);
    // The stale armed row is still resolved — closed to match the journaled close.
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-MNQ1!-A-long', 'long')?.state).toBe('closed');
  });
});

describe('debugging clear endpoints', () => {
  it('reconciles an uncertain broker order to an operator-verified status', async () => {
    const f = fixture();
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-uncertain', action: 'sell', status: 'uncertain', instrument: 'MNQ1!', occurredAt: new Date().toISOString(), errorText: 'fetch failed' });
    const res = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-uncertain', status: 'acknowledged' });
    expect(res.status).toBe(200);
    const order = f.database.findBrokerOrder(f.account.id, 'ord-uncertain');
    expect(order?.status).toBe('acknowledged');
    expect(order?.errorText).toBe('fetch failed');
  });

  it('retires the armed monitor row when an entry order is reconciled rejected', async () => {
    const f = fixture();
    // The prod shape: webhook accepted (acknowledged), then the broker denied
    // it asynchronously — the operator verifies at TradersPost and marks it.
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', bracketId: 'br-A-long', orderId: 'ord-denied', action: 'buy', status: 'acknowledged', instrument: 'MNQ1!', side: 'long', occurredAt: new Date().toISOString() });
    f.database.recordBracketMonitorEvent({
      accountId: f.account.id,
      rangeName: 'A',
      tradeId: 'br-A-long',
      eventId: 'br-A-long-entry_armed',
      eventType: 'entry_armed',
      instrument: 'MNQ1!',
      side: 'long',
      quantity: 1,
      occurredAt: new Date().toISOString(),
    });
    const res = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-denied', status: 'rejected', note: 'verified rejected at broker' });
    expect(res.status).toBe(200);
    expect(res.body.retiredBrackets).toContain('br-A-long');
    const order = f.database.findBrokerOrder(f.account.id, 'ord-denied');
    expect(order?.status).toBe('rejected');
    expect(order?.errorText).toBe('verified rejected at broker');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-A-long', 'long')?.state).toBe('cancelled');
  });

  it('refuses to reconcile a terminal broker order', async () => {
    const f = fixture();
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-done', action: 'buy', status: 'filled', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    const res = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-done', status: 'rejected' });
    expect(res.status).toBe(409);
    expect(f.database.findBrokerOrder(f.account.id, 'ord-done')?.status).toBe('filled');
  });

  it('retires the armed row for an already-rejected entry via retireArm without rewriting history', async () => {
    const f = fixture();
    // The InvalidPrice shape: the dispatch itself recorded a definite reject,
    // so the row is terminal before the operator ever looks at it — but the
    // armed monitor row lingers since dispatch-time rejects never touch it.
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', bracketId: 'br-A-long', orderId: 'ord-invalid', action: 'buy', status: 'rejected', instrument: 'MNQ1!', side: 'long', occurredAt: new Date().toISOString(), errorText: 'InvalidPrice: outside price limits' });
    f.database.recordBracketMonitorEvent({
      accountId: f.account.id,
      rangeName: 'A',
      tradeId: 'br-A-long',
      eventId: 'br-A-long-entry_armed',
      eventType: 'entry_armed',
      instrument: 'MNQ1!',
      side: 'long',
      quantity: 1,
      occurredAt: new Date().toISOString(),
    });
    // A status re-mark on a terminal row is still refused…
    const res = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-invalid', status: 'cancelled' });
    expect(res.status).toBe(409);
    // …but retireArm resolves the lingering arm while leaving the row as-is.
    const retire = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-invalid', retireArm: true });
    expect(retire.status).toBe(200);
    expect(retire.body.retiredBrackets).toContain('br-A-long');
    const order = f.database.findBrokerOrder(f.account.id, 'ord-invalid');
    expect(order?.status).toBe('rejected');
    expect(order?.errorText).toBe('InvalidPrice: outside price limits');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-A-long', 'long')?.state).toBe('cancelled');
  });

  it('dismisses a resolved ledger row but refuses live dispatches and filled evidence', async () => {
    const f = fixture();
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-rej', action: 'buy', status: 'rejected', instrument: 'MNQ1!', occurredAt: new Date().toISOString(), errorText: 'InvalidPrice: outside price limits' });
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-live', action: 'buy', status: 'uncertain', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-fill', action: 'buy', status: 'filled', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    const dismiss = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-rej', dismiss: true });
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.dismissed).toBe(true);
    expect(f.database.findBrokerOrder(f.account.id, 'ord-rej')).toBeUndefined();
    // Unresolved dispatches and filled rows keep their ledger evidence.
    const live = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-live', dismiss: true });
    expect(live.status).toBe(409);
    const fill = await f.sessionPost('/app/debugging/reconcile-broker-order', { orderId: 'ord-fill', dismiss: true });
    expect(fill.status).toBe(409);
    expect(f.database.findBrokerOrder(f.account.id, 'ord-live')?.status).toBe('uncertain');
    expect(f.database.findBrokerOrder(f.account.id, 'ord-fill')?.status).toBe('filled');
  });

  it('closes open broker orders then deletes resolved rows, keeping filled history', async () => {
    const f = fixture();
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-open', action: 'buy', status: 'pending', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-exit', action: 'exit', status: 'acknowledged', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-done', action: 'buy', status: 'filled', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-rej', action: 'buy', status: 'rejected', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    const res = await f.sessionPost('/app/debugging/clear-broker-orders', {});
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);
    expect(res.body.purged).toBe(3);
    const orders = f.database.listBrokerOrdersByAccount(f.account.id);
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe('ord-done');
    expect(orders[0].status).toBe('filled');
  });

  it('leaves armed monitor rows untouched when clearing broker orders', async () => {
    const f = fixture();
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', bracketId: 'br-1', orderId: 'ord-arm', action: 'buy', status: 'uncertain', instrument: 'MNQ1!', side: 'long', occurredAt: new Date().toISOString() });
    f.database.recordBracketMonitorEvent({
      accountId: f.account.id, rangeName: 'A', tradeId: 'br-1', eventId: 'br-1-entry_armed',
      eventType: 'entry_armed', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt: new Date().toISOString(),
    });
    f.database.recordBracketMonitorEvent({
      accountId: f.account.id, rangeName: 'B', tradeId: 'br-2', eventId: 'br-2-entry_armed',
      eventType: 'entry_armed', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt: new Date().toISOString(),
    });
    const res = await f.sessionPost('/app/debugging/clear-broker-orders', {});
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(1);
    // Clearing the ledger is bookkeeping-only — it proves nothing about the
    // broker, so a healthy working order must not lose its Open Orders row.
    // Arms retire only via Pine lifecycle, EOD, reconcile, or per-row operator
    // reconcile where real broker state is asserted.
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'br-1', 'long')?.state).toBe('armed');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'B', 'br-2', 'long')?.state).toBe('armed');
  });

  it('closes incomplete reapply operations and dismisses completed history', async () => {
    const f = fixture();
    f.database.saveReapplyOperation(reapplyOperation(f, { completed: true }));
    f.database.saveReapplyOperation(reapplyOperation(f, { completed: false }));
    const res = await f.sessionPost('/app/debugging/clear-reapply-operations', { brokerReconciled: true });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);
    const ops = f.database.listReapplyOperationsForUser(f.user.id, 50);
    expect(ops).toHaveLength(2);
    expect(ops.filter(o => !o.dismissed)).toHaveLength(0);
    expect(ops.every(o => o.completed)).toBe(true);
  });

  it('requires explicit broker reconciliation confirmation to clear operations', async () => {
    const f = fixture();
    f.database.saveReapplyOperation(reapplyOperation(f));
    const res = await f.sessionPost('/app/debugging/clear-reapply-operations', {});
    expect(res.status).toBe(400);
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
  });

  it('still surfaces an active operation when newer dismissed operations exceed the page limit', () => {
    const f = fixture();
    const active = reapplyOperation(f, { completed: false, createdAt: '2020-01-01T00:00:00.000Z' });
    f.database.saveReapplyOperation(active);
    for (let i = 0; i < 55; i += 1) {
      f.database.saveReapplyOperation(reapplyOperation(f, {
        completed: true,
        dismissed: true,
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      }));
    }
    const ops = f.database.listReapplyOperationsForUser(f.user.id, 50, false);
    expect(ops).toHaveLength(1);
    expect(ops[0].id).toBe(active.id);
  });

  it('does not reopen an operation cleared while a coordinator step was in flight', async () => {
    const f = fixture();
    const inFlight = reapplyOperation(f);
    f.database.saveReapplyOperation(inFlight);
    const res = await f.sessionPost('/app/debugging/clear-reapply-operations', { brokerReconciled: true });
    expect(res.status).toBe(200);
    // A coordinator that snapshotted the operation before the clear must not be
    // able to write completed:false back over the terminal state.
    f.database.saveReapplyOperation({ ...inFlight, completed: false, dismissed: false });
    const stored = f.database.findReapplyOperation(f.account.id, inFlight.eventId);
    expect(stored?.completed).toBe(true);
    expect(stored?.dismissed).toBe(true);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
  });

  it('clears incomplete operations across all users, not just the admin session user', async () => {
    const f = fixture();
    const other = f.database.createUser('other@example.com');
    const otherAccount = f.database.createAccount({ userId: other.id, name: 'Other acct', startingBalanceCents: 0 });
    f.database.saveReapplyOperation(reapplyOperation(f));
    const otherOp = reapplyOperation(f, { accountId: otherAccount.id });
    otherOp.route = { ...otherOp.route, userId: other.id, accountId: otherAccount.id };
    f.database.saveReapplyOperation(otherOp);
    const res = await f.sessionPost('/app/debugging/clear-reapply-operations', { brokerReconciled: true });
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
  });

  it('shows broker orders across all users in the debugging ledger, not just the admin session user', async () => {
    const f = fixture();
    const other = f.database.createUser('other@example.com');
    const otherAccount = f.database.createAccount({ userId: other.id, name: 'Other acct', startingBalanceCents: 0 });
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: 'A', orderId: 'ord-mine', action: 'buy', status: 'acknowledged', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    f.database.createBrokerOrder({ accountId: otherAccount.id, rangeName: 'A', orderId: 'ord-other', action: 'sell', status: 'uncertain', instrument: 'MGC1!', occurredAt: new Date().toISOString() });
    const res = await f.sessionGet('/app/api/debugging');
    expect(res.status).toBe(200);
    const orders = res.body.brokerOrders as Array<{ orderId: string; accountName?: string; status: string }>;
    expect(orders.find(o => o.orderId === 'ord-mine')?.accountName).toBe('Safeguard acct');
    expect(orders.find(o => o.orderId === 'ord-other')?.accountName).toBe('Other acct');
    expect(orders.find(o => o.orderId === 'ord-other')?.status).toBe('uncertain');
  });

  it('closes open broker orders across all users, not just the admin session user', async () => {
    const f = fixture();
    const other = f.database.createUser('other@example.com');
    const otherAccount = f.database.createAccount({ userId: other.id, name: 'Other acct', startingBalanceCents: 0 });
    f.database.createBrokerOrder({ accountId: otherAccount.id, rangeName: 'A', orderId: 'ord-other', action: 'buy', status: 'pending', instrument: 'MNQ1!', occurredAt: new Date().toISOString() });
    const res = await f.sessionPost('/app/debugging/clear-broker-orders', {});
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(1);
    expect(res.body.purged).toBe(1);
    expect(f.database.listBrokerOrdersByAccount(otherAccount.id)).toHaveLength(0);
  });
});

describe('bulk subscription copy', () => {
  it('copies every source subscription to the target and replaces its existing routes', async () => {
    const f = fixture();
    const target = f.database.createAccount({ userId: f.user.id, name: 'Target', startingBalanceCents: 0 })!;
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: true, traderspostEnabled: true, runScheduled: true });
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'B', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: target.id, rangeName: 'STALE', extensionEnabled: true, traderspostEnabled: true, runScheduled: false });

    const res = await f.sessionPost('/app/account/subscriptions/copy', { fromAccountId: f.account.id, toAccountId: target.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ copied: 2, removed: 1 });

    const targetRoutes = f.database.listRangeRoutes(f.user.id).filter(r => r.accountId === target.id);
    expect(targetRoutes).toHaveLength(2);
    const a = targetRoutes.find(r => r.rangeName === 'A')!;
    expect([a.extensionEnabled, a.traderspostEnabled, a.runScheduled]).toEqual([true, true, true]);
    const b = targetRoutes.find(r => r.rangeName === 'B')!;
    expect([b.extensionEnabled, b.traderspostEnabled, b.runScheduled]).toEqual([false, true, false]);
    expect(f.database.listRangeRoutes(f.user.id).filter(r => r.accountId === f.account.id)).toHaveLength(2);
  });

  it('replaces a target whose deliveries have broker-order ledger rows', async () => {
    const f = fixture();
    await f.armBracket('STALE'); // route + delivery + broker_orders row on the target
    const linkedOrder = f.database.listBrokerOrdersByAccount(f.account.id)[0]!;
    const source = f.database.createAccount({ userId: f.user.id, name: 'Source', startingBalanceCents: 0 })!;
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: source.id, rangeName: 'NEW', extensionEnabled: true, traderspostEnabled: true, runScheduled: false });

    const res = await f.sessionPost('/app/account/subscriptions/copy', { fromAccountId: source.id, toAccountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ copied: 1, removed: 1 });

    const targetRoutes = f.database.listRangeRoutes(f.user.id).filter(r => r.accountId === f.account.id);
    expect(targetRoutes.map(r => r.rangeName)).toEqual(['NEW']);
    // The dispatch ledger survives; only the link to the deleted delivery is detached.
    const order = f.database.listBrokerOrdersByAccount(f.account.id).find(o => o.id === linkedOrder.id);
    expect(order?.proxyDeliveryId).toBeUndefined();
  });

  it('rejects copying onto the same account or an account owned by another user', async () => {
    const f = fixture();
    const same = await f.sessionPost('/app/account/subscriptions/copy', { fromAccountId: f.account.id, toAccountId: f.account.id });
    expect(same.status).toBe(403);
    const other = f.database.createUser('other@example.com');
    const foreign = f.database.createAccount({ userId: other.id, name: 'Other', startingBalanceCents: 0 })!;
    const res = await f.sessionPost('/app/account/subscriptions/copy', { fromAccountId: f.account.id, toAccountId: foreign.id });
    expect(res.status).toBe(403);
    expect(f.database.listRangeRoutes(f.user.id)).toHaveLength(0);
  });
});

describe('mock TradersPost endpoint', () => {
  it('records dispatches and returns a TradersPost-style success', async () => {
    const f = fixture();
    const res = await supertest(f.app).post('/mock/traderspost').send({ ticker: 'MNQ1!', action: 'buy', orderType: 'stop', bracketId: 'b1', bracketSide: 'long', quantity: 1 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const calls = await supertest(f.app).get('/mock/traderspost/calls');
    const last = calls.body.calls.at(-1);
    expect(last.payload.ticker).toBe('MNQ1!');
    expect(last.responseStatus).toBe(200);
  });

  it('returns success:false in reject mode and an HTTP error in error mode', async () => {
    const f = fixture();
    const reject = await supertest(f.app).post('/mock/traderspost?mode=reject').send({ ticker: 'MNQ1!', action: 'exit' });
    expect(reject.status).toBe(200);
    expect(reject.body.success).toBe(false);
    const error = await supertest(f.app).post('/mock/traderspost?mode=error&status=503').send({ ticker: 'MNQ1!', action: 'exit' });
    expect(error.status).toBe(503);
  });

  it('derives working orders and positions per ticker', async () => {
    const f = fixture();
    await supertest(f.app).post('/mock/traderspost/clear');
    await supertest(f.app).post('/mock/traderspost').send({ ticker: 'MNQ1!', action: 'buy', orderType: 'stop', bracketId: 'b1', bracketSide: 'long', quantity: 1 });
    let state = (await supertest(f.app).get('/mock/traderspost/state')).body;
    expect(state.tickers.find((t: { ticker: string }) => t.ticker === 'MNQ1!').workingOrders).toHaveLength(1);
    await supertest(f.app).post('/mock/traderspost').send({ ticker: 'MNQ1!', action: 'cancel' });
    state = (await supertest(f.app).get('/mock/traderspost/state')).body;
    expect(state.tickers.find((t: { ticker: string }) => t.ticker === 'MNQ1!').workingOrders).toHaveLength(0);
  });

  it('nets opposing market orders into a signed position', async () => {
    const f = fixture();
    await supertest(f.app).post('/mock/traderspost/clear');
    const send = async (action: 'buy' | 'sell', quantity: number) => {
      await supertest(f.app).post('/mock/traderspost').send({ ticker: 'MNQ1!', action, orderType: 'market', quantity });
      return (await supertest(f.app).get('/mock/traderspost/state')).body.tickers
        .find((t: { ticker: string }) => t.ticker === 'MNQ1!').position;
    };
    expect(await send('buy', 2)).toEqual({ side: 'long', quantity: 2 });
    expect(await send('sell', 1)).toEqual({ side: 'long', quantity: 1 });
    expect(await send('sell', 2)).toEqual({ side: 'short', quantity: 1 });
    expect(await send('buy', 1)).toBeNull();
  });

  it('replays only accepted calls into derived broker state', async () => {
    const f = fixture();
    await supertest(f.app).post('/mock/traderspost/clear');
    const mnq = async () => (await supertest(f.app).get('/mock/traderspost/state')).body.tickers
      .find((t: { ticker: string }) => t.ticker === 'MNQ1!');
    // A rejected entry must not become a working order.
    await supertest(f.app).post('/mock/traderspost?mode=reject').send({ ticker: 'MNQ1!', action: 'buy', orderType: 'stop', quantity: 1 });
    // An errored cancel must not clear anything.
    await supertest(f.app).post('/mock/traderspost?mode=error&status=503').send({ ticker: 'MNQ1!', action: 'cancel' });
    expect(await mnq()).toBeUndefined();
    // A rejected exit must not flatten a real working order.
    await supertest(f.app).post('/mock/traderspost').send({ ticker: 'MNQ1!', action: 'buy', orderType: 'stop', quantity: 1 });
    await supertest(f.app).post('/mock/traderspost?mode=reject').send({ ticker: 'MNQ1!', action: 'exit' });
    expect((await mnq()).workingOrders).toHaveLength(1);
  });
});

describe('account pnl review', () => {
  const close = (f: ReturnType<typeof fixture>, i: number, overrides: Record<string, unknown> = {}) =>
    f.database.createTradeEvent({
      userId: f.user.id,
      accountId: f.account.id,
      rangeName: 'A',
      eventId: `evt-${i}`,
      tradeId: `trade-${i}`,
      eventType: 'trade_closed',
      instrument: 'MNQ1!',
      side: 'long',
      action: 'exit',
      quantity: 1,
      realizedTicksCents: 100,
      realizedDollarsCents: 200,
      outcome: 'win',
      occurredAt: new Date().toISOString(),
      ...overrides,
    } as Parameters<Database['createTradeEvent']>[0]);

  it('returns the full window so visuals agree with the totals', () => {
    const f = fixture();
    for (let i = 0; i < 205; i += 1) close(f, i);
    const review = f.database.getAccountPnlReview(f.account.id, new Date(Date.now() - 60_000).toISOString());
    expect(review?.trades.length).toBe(205);
    expect(review?.summary.closedCount).toBe(205);
    expect(review?.summary.realizedDollarsCents).toBe(205 * 200);
  });

  it('excludes future-dated closes from the review window', () => {
    const f = fixture();
    close(f, 0);
    close(f, 1, { occurredAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() });
    const review = f.database.getAccountPnlReview(f.account.id, new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());
    expect(review?.summary.closedCount).toBe(1);
    expect(review?.trades).toHaveLength(1);
  });

  it('keeps range aggregates separate per instrument', () => {
    const f = fixture();
    close(f, 0, { instrument: 'MNQ1!' });
    close(f, 1, { instrument: 'MGC1!' });
    const review = f.database.getAccountPnlReview(f.account.id, new Date(Date.now() - 60_000).toISOString());
    expect(review?.ranges).toHaveLength(2);
    expect(review?.ranges.map((r) => r.instrument).sort()).toEqual(['MGC1!', 'MNQ1!']);
  });

  it('does not merge distinct pairs whose names collide under plain concatenation', () => {
    const f = fixture();
    close(f, 0, { rangeName: 'AB', instrument: 'C!' });
    close(f, 1, { rangeName: 'A', instrument: 'BC!' });
    const review = f.database.getAccountPnlReview(f.account.id, new Date(Date.now() - 60_000).toISOString());
    expect(review?.ranges).toHaveLength(2);
  });
});

describe('CrossTrade REST read endpoints', () => {
  const CT_WEBHOOK = 'https://app.crosstrade.io/v1/send/uid/channel';

  function ctFixture(options: { crossTrade?: boolean; orderStates?: Record<string, string | 'missing' | 'net-error'> } = {}) {
    const database = new Database(':memory:');
    const admin = database.createUser('safeguard@example.com');
    const account = database.createAccount({ userId: admin.id, name: 'CT acct', startingBalanceCents: 0 });
    database.upsertTradersPostAccountDestination(
      admin.id, account.id, WEBHOOK, undefined, undefined, true, false, false,
      '16:30', '16:45', false, false, 5, false,
      options.crossTrade === false
        ? undefined
        : { webhookUrl: CT_WEBHOOK, secretKey: 'ct-key', accountName: 'SIM101' },
    );
    const apiCalls: Array<{ url: string; headers: Record<string, string> }> = [];
    const mockFetch: typeof fetch = async (url, init) => {
      const target = String(url);
      apiCalls.push({ url: target, headers: (init?.headers ?? {}) as Record<string, string> });
      if (target.endsWith('/orders?activeOnly=false')) {
        return new Response('{"success":true,"orders":[{"id":"nt8-1","instrument":"MNQ 09-25","orderState":"Working"}]}', { status: 200 });
      }
      if (target.endsWith('/positions')) {
        return new Response('{"success":true,"positions":[{"instrument":"MNQ 09-25","marketPosition":"Long","quantity":1}]}', { status: 200 });
      }
      if (target.endsWith('/atm-templates')) {
        return new Response('{"success":true,"templates":["T1"]}', { status: 200 });
      }
      if (target.includes('/orders/known')) {
        return new Response('{"success":true,"order":{"id":"nt8-1","orderState":"Working"}}', { status: 200 });
      }
      const single = /\/orders\/([^/?]+)$/.exec(target);
      if (single && options.orderStates) {
        const orderId = decodeURIComponent(single[1]);
        const state = options.orderStates[orderId] ?? 'missing';
        if (state === 'net-error') throw new Error('NT8 unreachable');
        if (state === 'missing') {
          return new Response(`{"success":false,"error":"order ${orderId} not found"}`, { status: 404 });
        }
        return new Response(`{"success":true,"order":{"id":"${orderId}","orderState":"${state}"}}`, { status: 200 });
      }
      return new Response('{"success":false,"error":"unexpected url"}', { status: 404 });
    };
    // crossTradeApiGet uses the global fetch — stub it so these tests can never
    // reach the real API. The option-level mockFetch covers any dispatch path.
    vi.stubGlobal('fetch', mockFetch);
    cleanup.push(() => vi.unstubAllGlobals());
    const app = testApp(database, { proxyWebhookSecret: PROXY_SECRET, sessionSecret: SESSION_SECRET, adminUserEmail: 'safeguard@example.com', fetch: mockFetch });
    const { token, csrfToken } = webSession(database, admin.id);
    const sessionGet = (path: string, sessionToken = token) =>
      supertest(app).get(path).set('Cookie', `bridge_session=${sessionToken}`);
    const sessionPost = (path: string, body: Record<string, unknown>) =>
      supertest(app).post(path).set('Cookie', `bridge_session=${token}`).send({ ...body, csrfToken });
    return { database, admin, account, apiCalls, sessionGet, sessionPost };
  }

  it('returns live orders, positions, and local bookkeeping side by side', async () => {
    const f = ctFixture();
    const res = await f.sessionGet(`/app/debugging/crosstrade-state?accountId=${f.account.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.account.name).toBe('CT acct');
    expect(res.body.nt8Account).toBe('SIM101');
    expect(res.body.orders).toMatchObject({ ok: true, statusCode: 200 });
    expect(res.body.orders.orders).toHaveLength(1);
    expect(res.body.positions).toMatchObject({ ok: true, statusCode: 200 });
    expect(res.body.positions.positions).toHaveLength(1);
    expect(res.body.atmTemplates).toMatchObject({ ok: true, statusCode: 200, templates: ['T1'] });
    expect(res.body.local).toEqual({ openOrders: [], monitorRows: [] });
    expect(f.apiCalls.every((c) => c.headers.authorization === 'Bearer ct-key')).toBe(true);
    expect(f.apiCalls.every((c) =>
      c.url.startsWith('https://app.crosstrade.io/v1/api/accounts/SIM101/')
      || c.url === 'https://app.crosstrade.io/v1/api/atm-templates')).toBe(true);
  });

  it('reports unresolved CT dispatches and active monitor rows on the local side', async () => {
    const f = ctFixture();
    f.database.upsertBrokerOrder({
      accountId: f.account.id, orderId: 'br-1', bracketId: 'br-1', rangeName: 'R1', action: 'buy',
      instrument: 'MNQ1!', status: 'uncertain', destination: 'crosstrade',
      occurredAt: new Date().toISOString(),
    });
    const res = await f.sessionGet(`/app/debugging/crosstrade-state?accountId=${f.account.id}`);
    expect(res.status).toBe(200);
    expect(res.body.local.openOrders).toHaveLength(1);
    expect(res.body.local.openOrders[0].orderId).toBe('br-1');
  });

  it('uses the secret key as the Bearer token when no API token is set', async () => {
    const f = ctFixture();
    const res = await f.sessionGet(`/app/debugging/crosstrade-state?accountId=${f.account.id}`);
    expect(res.status).toBe(200);
    expect(f.apiCalls.every((c) => c.headers.authorization === 'Bearer ct-key')).toBe(true);
  });

  it('rejects non-CrossTrade accounts', async () => {
    const f = ctFixture({ crossTrade: false });
    const res = await f.sessionGet(`/app/debugging/crosstrade-state?accountId=${f.account.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not CrossTrade-configured');
  });

  it('scopes reads to the account owner or admin', async () => {
    const f = ctFixture();
    const other = f.database.createUser('other@example.com');
    const { token: otherToken } = webSession(f.database, other.id);
    const res = await f.sessionGet(`/app/debugging/crosstrade-state?accountId=${f.account.id}`, otherToken);
    expect(res.status).toBe(404);
    expect(f.apiCalls).toHaveLength(0);
  });

  it('looks up a single order by our caller-supplied order_id', async () => {
    const f = ctFixture();
    const res = await f.sessionGet(`/app/debugging/crosstrade-order?accountId=${f.account.id}&orderId=${encodeURIComponent('known id')}`);
    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe('known id');
    expect(res.body.ok).toBe(true);
    expect(f.apiCalls[0].url).toBe('https://app.crosstrade.io/v1/api/accounts/SIM101/orders/known%20id');
  });

  it('still returns 200 with ok:false when the order is unknown upstream', async () => {
    const f = ctFixture();
    const res = await f.sessionGet(`/app/debugging/crosstrade-order?accountId=${f.account.id}&orderId=not/there`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('unexpected url');
  });

  it('requires an orderId parameter', async () => {
    const f = ctFixture();
    const res = await f.sessionGet(`/app/debugging/crosstrade-order?accountId=${f.account.id}`);
    expect(res.status).toBe(400);
    expect(f.apiCalls).toHaveLength(0);
  });
});

describe('CrossTrade reconcile-from-broker', () => {
  const CT_WEBHOOK = 'https://app.crosstrade.io/v1/send/uid/channel';
  const OLD = new Date(Date.now() - 10 * 60_000).toISOString();
  const FRESH = new Date().toISOString();

  function fixture(orderStates: Record<string, string | 'missing' | 'net-error'> = {}) {
    const database = new Database(':memory:');
    const admin = database.createUser('safeguard@example.com');
    const account = database.createAccount({ userId: admin.id, name: 'CT acct', startingBalanceCents: 0 });
    database.upsertTradersPostAccountDestination(
      admin.id, account.id, WEBHOOK, undefined, undefined, true, false, false,
      '16:30', '16:45', false, false, 5, false,
      { webhookUrl: CT_WEBHOOK, secretKey: 'ct-key', accountName: 'SIM101' },
    );
    const mockFetch: typeof fetch = async (url) => {
      const single = /\/orders\/([^/?]+)$/.exec(String(url));
      if (!single) return new Response('{"success":false,"error":"unexpected url"}', { status: 404 });
      const orderId = decodeURIComponent(single[1]);
      const state = orderStates[orderId] ?? 'missing';
      if (state === 'net-error') throw new Error('NT8 unreachable');
      if (state === 'missing') {
        return new Response(`{"success":false,"error":"order ${orderId} not found"}`, { status: 404 });
      }
      return new Response(`{"success":true,"order":{"id":"${orderId}","orderState":"${state}"}}`, { status: 200 });
    };
    vi.stubGlobal('fetch', mockFetch);
    cleanup.push(() => vi.unstubAllGlobals());
    const app = testApp(database, { proxyWebhookSecret: PROXY_SECRET, sessionSecret: SESSION_SECRET, adminUserEmail: 'safeguard@example.com', fetch: mockFetch });
    const { token, csrfToken } = webSession(database, admin.id);
    const sessionPost = (path: string, body: Record<string, unknown>, sessionToken = token) =>
      supertest(app).post(path).set('Cookie', `bridge_session=${sessionToken}`).send({ ...body, csrfToken });
    const ctOrder = (orderId: string, status = 'uncertain', occurredAt = OLD) =>
      database.createBrokerOrder({
        accountId: account.id, rangeName: 'A', bracketId: orderId, orderId, action: 'buy',
        status: status as 'uncertain', instrument: 'MNQ1!', side: 'long',
        destination: 'crosstrade', occurredAt,
      });
    const armMonitor = (bracketId: string) => database.recordBracketMonitorEvent({
      accountId: account.id, rangeName: 'A', tradeId: bracketId,
      eventId: `${bracketId}-armed`, eventType: 'entry_armed', instrument: 'MNQ1!',
      side: 'long', quantity: 1, occurredAt: OLD,
    });
    return { database, admin, account, app, sessionPost, ctOrder, armMonitor };
  }

  it('resolves an uncertain dispatch to acknowledged when NT8 reports Working', async () => {
    const f = fixture({ 'ord-work': 'Working' });
    f.ctOrder('ord-work');
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcomes[0]).toMatchObject({ orderId: 'ord-work', outcome: 'acknowledged', nt8State: 'Working' });
    const order = f.database.findBrokerOrder(f.account.id, 'ord-work');
    expect(order?.status).toBe('acknowledged');
    expect(order?.statusSource).toBe('bridge');
  });

  it('resolves an uncertain dispatch to filled when NT8 reports Filled', async () => {
    const f = fixture({ 'ord-fill': 'Filled' });
    f.ctOrder('ord-fill');
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.outcomes[0].outcome).toBe('filled');
    expect(f.database.findBrokerOrder(f.account.id, 'ord-fill')?.status).toBe('filled');
  });

  it('marks cancelled and retires the armed monitor row when NT8 reports Cancelled', async () => {
    const f = fixture({ 'ord-cx': 'Cancelled' });
    f.ctOrder('ord-cx');
    f.armMonitor('ord-cx');
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.outcomes[0].outcome).toBe('cancelled');
    expect(res.body.outcomes[0].retiredBrackets).toContain('ord-cx');
    expect(f.database.findBrokerOrder(f.account.id, 'ord-cx')?.status).toBe('cancelled');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', 'ord-cx', 'long')?.state).toBe('cancelled');
  });

  it('treats not-found as rejected only after the grace window', async () => {
    const f = fixture({ 'ord-old': 'missing', 'ord-new': 'missing' });
    f.ctOrder('ord-old', 'uncertain', OLD);
    f.ctOrder('ord-new', 'uncertain', FRESH);
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.outcomes.map((o: { orderId: string }) => [o.orderId, o]));
    expect(byId['ord-old'].outcome).toBe('rejected');
    expect(byId['ord-new'].outcome).toBe('in_flight');
    expect(f.database.findBrokerOrder(f.account.id, 'ord-old')?.status).toBe('rejected');
    expect(f.database.findBrokerOrder(f.account.id, 'ord-new')?.status).toBe('uncertain');
  });

  it('never converts a read failure into evidence — network error stays unresolved', async () => {
    const f = fixture({ 'ord-down': 'net-error' });
    f.ctOrder('ord-down');
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.outcomes[0].outcome).toBe('unknown');
    expect(f.database.findBrokerOrder(f.account.id, 'ord-down')?.status).toBe('uncertain');
  });

  it('leaves an unrecognized NT8 state unresolved', async () => {
    const f = fixture({ 'ord-weird': 'Teleporting' });
    f.ctOrder('ord-weird');
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.outcomes[0].outcome).toBe('unknown');
    expect(f.database.findBrokerOrder(f.account.id, 'ord-weird')?.status).toBe('uncertain');
  });

  it('does not probe TradersPost-destination rows', async () => {
    const f = fixture({});
    f.database.createBrokerOrder({
      accountId: f.account.id, rangeName: 'A', orderId: 'ord-tp', action: 'buy',
      status: 'uncertain', instrument: 'MNQ1!', destination: 'traderspost', occurredAt: OLD,
    });
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id });
    expect(res.status).toBe(200);
    expect(res.body.probed).toBe(0);
    expect(f.database.findBrokerOrder(f.account.id, 'ord-tp')?.status).toBe('uncertain');
  });

  it('is admin-only and requires CSRF', async () => {
    const f = fixture({});
    const other = f.database.createUser('other@example.com');
    const { token: otherToken } = webSession(f.database, other.id);
    const res = await f.sessionPost('/app/debugging/reconcile-crosstrade', { accountId: f.account.id }, otherToken);
    expect(res.status).toBe(403);
    const { token } = webSession(f.database, f.admin.id);
    const res2 = await supertest(f.app).post('/app/debugging/reconcile-crosstrade')
      .set('Cookie', `bridge_session=${token}`).send({ accountId: f.account.id, csrfToken: 'bogus' });
    expect(res2.status).toBe(403);
  });
});

describe('range-scoped id transition', () => {
  const lifecycleFor = (range: string, tradeId: string, eventType: LifecyclePayload['eventType'], index = 0): LifecyclePayload => ({
    eventType,
    eventId: `${eventType}-${tradeId}-${index}`,
    tradeId,
    ticker: 'MNQ1!',
    side: 'long',
    action: eventType === 'trade_closed' ? 'exit' : 'buy',
    quantity: 1,
    entryPrice: 25000,
    extras: { rangeName: range },
    ...(eventType === 'trade_closed' ? { closedAt: new Date().toISOString(), exitPrice: 25010, realizedTicks: 40, realizedDollars: 20, outcome: 'win' as const } : {}),
  });

  it('slugs are injective over punctuation variants and match the wire prefix', () => {
    expect(rangeSlugForLookup('A/B')).not.toBe(rangeSlugForLookup('A-B'));
    expect(rangeSlugForLookup('A-B')).not.toBe(rangeSlugForLookup('A B'));
    expect(rangeSlugForLookup('A/B')).not.toBe(rangeSlugForLookup('A B'));
    expect(rangeSlugForLookup('SIM-CT-MNQ')).toBe('SIM--CT--MNQ');
    expect(rangeSlugForLookup('V3X GOLD')).toBe('V3X-20GOLD');
    // Case-sensitive: 'A' and 'a' are distinct ranges under COLLATE BINARY.
    expect(rangeSlugForLookup('a')).not.toBe(rangeSlugForLookup('A'));
    // Fixed-width escapes: no variable-width hex collisions.
    expect(rangeSlugForLookup('Aî')).toBe('A-EE');
    expect(rangeSlugForLookup('A\u000cE')).toBe('AE'); // control char stripped
    expect(rangeSlugForLookup('A𐍈')).toBe('A-u10348'); // >0xFF uses -uXXXX
    // Database normalizeRangeName equivalent: control-strip + whitespace collapse.
    expect(rangeSlugForLookup('A  B')).toBe(rangeSlugForLookup('A B'));
    expect(rangeSlugForLookup('  A B  ')).toBe(rangeSlugForLookup('A B'));
    expect(rangeSlugForLookup('A\tB')).toBe('AB'); // tab is a control char — stripped, not collapsed
  });

  it('ingest prefixes raw ids but leaves scoped ids untouched', () => {
    const f = fixture();
    const raw = { bracketId: 'ultra-v5.2-MNQ1!-1-long-arm-1', tradeId: 'ultra-v5.2-MNQ1!-1-long-arm-1-lifecycle-long-0', extras: { rangeName: 'A' } };
    const scoped = scopePayloadIdsToRange({ ...raw });
    expect(scoped.bracketId).toBe('A-ultra-v5.2-MNQ1!-1-long-arm-1');
    // Already-prefixed and native-position ids pass through unchanged.
    expect(scopePayloadIdsToRange({ ...scoped }).bracketId).toBe(scoped.bracketId);
    const native = { bracketId: 'ultra-v5.3-A-MNQ1!-1-long-arm-1', extras: { rangeName: 'A' } };
    expect(scopePayloadIdsToRange({ ...native }).bracketId).toBe(native.bracketId);
    // A ticker matching the range slug elsewhere in the id is NOT proof of scoping.
    const legacy = { bracketId: 'ultra-v5.2-MNQ-999-1-long-arm-1', extras: { rangeName: 'MNQ' } };
    expect(scopePayloadIdsToRange({ ...legacy }).bracketId).toBe('MNQ-ultra-v5.2-MNQ-999-1-long-arm-1');
    // Not even in the native position on a pre-slug v5.3 id — range 'MNQ1' on
    // ticker MNQ1 still gets prefixed; only a ticker segment after the slug
    // counts as native.
    const preSlug53 = { bracketId: 'ultra-v5.3-MNQ1-1759-3', extras: { rangeName: 'MNQ1' } };
    expect(scopePayloadIdsToRange({ ...preSlug53 }).bracketId).toBe('MNQ1-ultra-v5.3-MNQ1-1759-3');
    const native54 = { bracketId: 'ultra-v5.4-MNQ1-MNQ1-1759-3', extras: { rangeName: 'MNQ1' } };
    expect(scopePayloadIdsToRange({ ...native54 }).bracketId).toBe(native54.bracketId);
    // Structural proof required: a pre-slug v5.3 arm tail ('-long-arm-1') is
    // not evidence of a native slug — the segment after the claimed slug must
    // be ticker-epoch-seq shaped.
    const preSlugArm = { bracketId: 'ultra-v5.3-MNQ1-1759-3-long-arm-1', extras: { rangeName: 'MNQ1' } };
    expect(scopePayloadIdsToRange({ ...preSlugArm }).bracketId).toBe('MNQ1-ultra-v5.3-MNQ1-1759-3-long-arm-1');
    // Prefix chains: an id scoped for 'SIM-ALL-MNQ' (slug 'SIM--ALL--MNQ') is
    // not claimed by range 'SIM' — the remainder starts with '-'.
    const chained = { bracketId: 'SIM--ALL--MNQ-ultra-v5.2-MNQ1!-1-long-arm-1', extras: { rangeName: 'SIM' } };
    expect(scopePayloadIdsToRange({ ...chained }).bracketId).toBe('SIM-SIM--ALL--MNQ-ultra-v5.2-MNQ1!-1-long-arm-1');
    // Same chain guard inside the native v5.4 position.
    const nativeChain = { bracketId: 'ultra-v5.4-SIM--ALL--MNQ-MNQ1-1759-3', extras: { rangeName: 'SIM' } };
    expect(scopePayloadIdsToRange({ ...nativeChain }).bracketId).toBe('SIM-ultra-v5.4-SIM--ALL--MNQ-MNQ1-1759-3');
    // Range 'ultra' collides with the 'ultra-v' marker itself: a native id is
    // not a prefixed id — scope on the way in, never strip on the way out.
    const ultraRange = { bracketId: 'ultra-v5.4-A-MNQ-1-2', extras: { rangeName: 'ultra' } };
    expect(scopePayloadIdsToRange({ ...ultraRange }).bracketId).toBe('ultra-ultra-v5.4-A-MNQ-1-2');
    expect(unscopeIdForRange('ultra-ultra-v5.4-A-MNQ-1-2', 'ultra')).toBe('ultra-v5.4-A-MNQ-1-2');
    expect(unscopeIdForRange('ultra-v5.4-ultra-MNQ-1-2', 'ultra')).toBe('ultra-v5.4-ultra-MNQ-1-2');
    expect(unscopeIdForRange('A-ultra-v5.3-MNQ-1-2', 'A')).toBe('ultra-v5.3-MNQ-1-2');
    void f;
  });

  it('maps normalized lifecycle events onto an open pre-deploy monitor row', async () => {
    const f = fixture();
    const legacyBracket = 'ultra-v5.2-MNQ1!-7-long-arm-3';
    const legacyTrade = `${legacyBracket}-lifecycle-long-0`;
    // Pre-deploy state: monitor + journal rows written under the unprefixed id.
    f.database.recordBracketMonitorEvent({
      accountId: f.account.id, rangeName: 'A', tradeId: legacyTrade, eventId: `${legacyTrade}-armed`,
      eventType: 'entry_armed', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt: new Date().toISOString(),
    });
    f.database.createTrackedRange('A', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });

    // Post-deploy lifecycle alert arrives — ingest prefixes the ids.
    await f.proxyPost(lifecycleFor('A', legacyTrade, 'entry_filled'));
    await f.proxyPost(lifecycleFor('A', legacyTrade, 'trade_closed', 1));

    // The legacy row absorbed the events — still a single monitor identity.
    const mon = f.database.findBracketMonitorEntry(f.account.id, 'A', legacyBracket, 'long');
    expect(mon?.state).toBe('closed');
    // And the journal kept the legacy trade identity for every event.
    const events = f.database.listRangeTradeEventsByTrade('A', legacyTrade);
    expect(events.map(e => e.eventType)).toEqual(expect.arrayContaining(['entry_filled', 'trade_closed']));
  });

  it('does not alias a closed pre-deploy row onto a post-deploy re-arm', async () => {
    const f = fixture();
    const legacyBracket = 'ultra-v5.2-MNQ1!-8-long-arm-1';
    const legacyTrade = `${legacyBracket}-lifecycle-long-0`;
    f.database.recordBracketMonitorEvent({
      accountId: f.account.id, rangeName: 'A', tradeId: legacyTrade, eventId: `${legacyTrade}-armed`,
      eventType: 'entry_armed', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt: new Date().toISOString(),
    });
    f.database.recordBracketMonitorEvent({
      accountId: f.account.id, rangeName: 'A', tradeId: legacyTrade, eventId: `${legacyTrade}-closed`,
      eventType: 'trade_closed', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt: new Date().toISOString(),
    });
    f.database.createTrackedRange('A', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });

    await f.proxyPost(lifecycleFor('A', legacyTrade, 'entry_armed', 9));
    // The closed legacy row stays closed; the re-arm lives under the normalized id.
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', legacyBracket, 'long')?.state).toBe('closed');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', sid('A', legacyBracket), 'long')?.state).toBe('armed');
  });

  it('scopes ids under the canonical range spelling — one prefix, once', () => {
    // The stored/tracked spelling wins over raw extras: 'A  B' and 'A B'
    // converge on the same slug instead of minting parallel identities.
    const payload = { bracketId: 'bracket-1', extras: { rangeName: 'A  B' } };
    expect(scopePayloadIdsToRange({ ...payload }, 'A B').bracketId).toBe('A-20B-bracket-1');
    // Idempotent under the same canonical name — a second pass must not
    // double-prefix.
    const once = scopePayloadIdsToRange({ ...payload }, 'A B');
    expect(scopePayloadIdsToRange({ ...once }, 'A B').bracketId).toBe('A-20B-bracket-1');
    // An id already scoped for a different range gets prefixed for this one —
    // mislabeled payloads converge on the range they actually carry.
    expect(scopePayloadIdsToRange({ ...once }, 'B').bracketId).toBe('B-A-20B-bracket-1');
  });

  it('keeps scoped lifecycle ids when an exact scoped row exists beside a legacy row', async () => {
    const f = fixture();
    const bracket = 'ultra-v5.2-MNQ1!-9-long-arm-1';
    const legacyTrade = `${bracket}-lifecycle-long-0`;
    const scopedTrade = `${sid('A', bracket)}-lifecycle-long-0`;
    const monEvent = (tradeId: string, eventType: 'entry_armed' | 'trade_closed', at: string) => ({
      accountId: f.account.id, rangeName: 'A', tradeId, eventId: `${tradeId}-${eventType}`,
      eventType, instrument: 'MNQ1!', side: 'long' as const, quantity: 1, occurredAt: at,
    });
    // Pre-deploy bracket ran its cycle and closed.
    f.database.recordBracketMonitorEvent(monEvent(legacyTrade, 'entry_armed', '2026-01-01T10:00:00Z'));
    f.database.recordBracketMonitorEvent(monEvent(legacyTrade, 'trade_closed', '2026-01-01T11:00:00Z'));
    // Post-deploy arm while the legacy row sat closed → scoped monitor row.
    f.database.recordBracketMonitorEvent(monEvent(scopedTrade, 'entry_armed', '2026-01-01T12:00:00Z'));
    // A replayed pre-deploy (unscoped) arm re-opens the legacy row — now an
    // open legacy row and an open scoped row share the unprefixed base.
    f.database.recordBracketMonitorEvent(monEvent(legacyTrade, 'entry_armed', '2026-01-01T13:00:00Z'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracket, 'long')?.state).toBe('armed');
    f.database.createTrackedRange('A', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });

    await f.proxyPost(lifecycleFor('A', scopedTrade, 'entry_filled'));

    // The exact scoped row wins — the event is STORED under the scoped trade
    // id (the dual-form lookup still surfaces it via the legacy spelling) and
    // the legacy monitor row is left alone.
    const stored = f.database.listRangeTradeEventsByTrade('A', scopedTrade).filter(e => e.eventType === 'entry_filled');
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.every(e => e.tradeId === scopedTrade)).toBe(true);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', sid('A', bracket), 'long')?.state).toBe('filled');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracket, 'long')?.state).toBe('armed');
  });
});
