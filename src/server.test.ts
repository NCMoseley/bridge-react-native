import { afterEach, describe, expect, it, vi } from 'vitest'
import supertest from 'supertest'
import { createSessionToken, hashSessionToken } from './auth.js'
import { Database } from './database.js'
import { createApp } from './server.js'

const PROXY_SECRET = 'test-proxy-secret'

function makeClosedTradePayload(rangeName: string, overrides: Record<string, unknown> = {}) {
  return {
    eventType: 'trade_closed',
    eventId: 'evt-1',
    tradeId: 'trade-1',
    ticker: 'MNQ1!',
    action: 'sell',
    side: 'short',
    quantity: 1,
    closedAt: '2026-08-20T20:00:00.000Z',
    realizedTicks: 50,
    realizedDollars: 500,
    outcome: 'win',
    extras: { rangeName },
    ...overrides,
  }
}

function createWebSession(database: Database, userId: string, sessionSecret: string) {
  const token = createSessionToken()
  const csrfToken = createSessionToken()
  database.createSession(
    hashSessionToken(token, sessionSecret),
    userId,
    csrfToken,
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  )
  return { token, csrfToken }
}

describe('trade exclusion web endpoint', () => {
  it('toggles a trade from included to erroneous and back', async () => {
    const database = new Database(':memory:')
    const user = database.createUser('test@example.com')
    const account = database.createAccount({
      userId: user.id,
      name: 'Test Account',
      startingBalanceCents: 0,
    })
    const app = createApp(database, {
      proxyWebhookSecret: PROXY_SECRET,
      sessionSecret: 'test-session-secret',
    })
    const { event } = database.createTradeEvent({
      userId: user.id,
      accountId: account.id,
      rangeName: 'EXCLUSION RANGE',
      eventId: 'exclusion-event-1',
      tradeId: 'exclusion-trade-1',
      eventType: 'trade_closed',
      instrument: 'MNQ1!',
      side: 'short',
      action: 'exit',
      quantity: 1,
      entryPrice: 20_000,
      exitPrice: 20_000,
      realizedTicksCents: 0,
      realizedDollarsCents: 0,
      outcome: 'breakeven',
      occurredAt: '2026-08-20T20:00:00.000Z',
    })
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    const { token, csrfToken } = createWebSession(database, user.id, 'test-session-secret')
    const markErroneous = await supertest(app)
      .post('/app/trade-exclusions')
      .set('Cookie', `bridge_session=${token}`)
      .type('form')
      .send({ eventId: event.id, erroneous: 'true', csrfToken })
    expect(markErroneous.status).toBe(303)

    let journal = database.getTradeJournal(user.id)
    let updated = journal.recentClosedTrades.find((trade) => trade.id === event.id)
    expect(updated).toBeDefined()
    expect(updated?.excludedFromPerformance).toBe(true)
    expect(updated?.exclusionReason).toBe('erroneous')

    const markIncluded = await supertest(app)
      .post('/app/trade-exclusions')
      .set('Cookie', `bridge_session=${token}`)
      .type('form')
      .send({ eventId: event.id, csrfToken })
    expect(markIncluded.status).toBe(303)

    journal = database.getTradeJournal(user.id)
    updated = journal.recentClosedTrades.find((trade) => trade.id === event.id)
    expect(updated?.excludedFromPerformance).toBe(false)
    expect(updated?.exclusionReason).toBeUndefined()
  })

  it('rejects an invalid event id when toggling exclusion', async () => {
    const database = new Database(':memory:')
    const user = database.createUser('test@example.com')
    const app = createApp(database, {
      proxyWebhookSecret: PROXY_SECRET,
      sessionSecret: 'test-session-secret',
    })
    const { token, csrfToken } = createWebSession(database, user.id, 'test-session-secret')
    const res = await supertest(app)
      .post('/app/trade-exclusions')
      .set('Cookie', `bridge_session=${token}`)
      .type('form')
      .send({ eventId: 'not-a-valid-uuid', erroneous: 'true', csrfToken })
    expect(res.status).toBe(400)
    expect(res.text).toContain('Review the exclusion settings')
  })
})

describe('CrossTrade destination save — write-only secret', () => {
  const SESSION_SECRET = 'test-session-secret';
  const TP_URL = 'https://traderspost.example/hook';
  const CT_URL = 'https://app.crosstrade.io/v1/send/uid/channel';

  const setup = () => {
    const database = new Database(':memory:');
    const user = database.createUser('ct@example.com');
    const account = database.createAccount({ userId: user.id, name: 'CT acct', startingBalanceCents: 0 });
    const app = createApp(database, { proxyWebhookSecret: PROXY_SECRET, sessionSecret: SESSION_SECRET });
    const session = createWebSession(database, user.id, SESSION_SECRET);
    const post = (body: Record<string, unknown>) =>
      supertest(app).post('/app/traderspost-destination')
        .set('Cookie', `bridge_session=${session.token}`)
        .send({ csrfToken: session.csrfToken, ...body });
    return { database, account, app, session, post };
  };

  it('returns a saved-marker instead of the credential, and preserves the stored key on re-save', async () => {
    const { database, account, app, session, post } = setup();

    const first = await post({
      accountId: account.id,
      webhookUrl: TP_URL,
      crossTradeWebhookUrl: CT_URL,
      crossTradeSecretKey: 'ct-secret',
    });
    expect(first.status).toBe(303);

    const accounts = await supertest(app).get('/app/api/accounts').set('Cookie', `bridge_session=${session.token}`);
    expect(accounts.status).toBe(200);
    const pub = accounts.body.destinations[account.id];
    expect(pub.crossTradeSecretKeySet).toBe(true);
    expect(pub.crossTradeSecretKey).toBeUndefined();
    expect(JSON.stringify(accounts.body)).not.toContain('ct-secret');

    // Re-saving without the key field must not wipe the stored credential.
    const second = await post({ accountId: account.id, webhookUrl: TP_URL, crossTradeWebhookUrl: CT_URL });
    expect(second.status).toBe(303);
    expect(database.getTradersPostAccountDestination(account.id)?.crossTradeSecretKey).toBe('ct-secret');
  });

  it('rejects a CrossTrade webhook URL with no usable secret key', async () => {
    const { database, account, post } = setup();
    const res = await post({ accountId: account.id, webhookUrl: TP_URL, crossTradeWebhookUrl: CT_URL });
    expect(res.status).toBe(400);
    // Nothing persisted — a partial CT configuration must never reach the DB.
    expect(database.getTradersPostAccountDestination(account.id)).toBeUndefined();
  });

  it('clearing the webhook URL clears all CrossTrade fields', async () => {
    const { database, account, post } = setup();
    await post({ accountId: account.id, webhookUrl: TP_URL, crossTradeWebhookUrl: CT_URL, crossTradeSecretKey: 'ct-secret' });
    const res = await post({ accountId: account.id, webhookUrl: TP_URL, crossTradeWebhookUrl: '' });
    expect(res.status).toBe(303);
    const stored = database.getTradersPostAccountDestination(account.id);
    expect(stored?.crossTradeWebhookUrl).toBeUndefined();
    expect(stored?.crossTradeSecretKey).toBeUndefined();
  });
});

describe('CrossTrade API test tick-to-price conversion', () => {
  it('sends absolute TP/SL prices for one-side and both-side tick inputs', async () => {
    const database = new Database(':memory:');
    const user = database.createUser('admin@example.com');
    const account = database.createAccount({ userId: user.id, name: 'CT account', startingBalanceCents: 0 });
    const ctUrl = 'https://app.crosstrade.io/v1/send/test/channel';
    database.upsertTradersPostAccountDestination(
      user.id, account.id, 'https://traderspost.example/hook', undefined, undefined,
      true, false, false, '16:30', '16:45', false, false, 5, false,
      { webhookUrl: ctUrl, secretKey: 'ct-secret', accountName: 'Sim101' },
    );
    const sent: Array<{ url: string; payload: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/v1/api/')) {
        return new Response(JSON.stringify({ order: { orderState: 'Working' } }), { status: 200 });
      }
      sent.push({ url, payload: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const sessionSecret = 'ct-test-session-secret';
    const app = createApp(database, {
      proxyWebhookSecret: PROXY_SECRET,
      sessionSecret,
      adminUserEmail: user.email,
      fetch: fetchMock as typeof globalThis.fetch,
    });
    const session = createWebSession(database, user.id, sessionSecret);
    const post = (body: Record<string, unknown>) => supertest(app)
      .post('/app/debugging/crosstrade-test')
      .set('Cookie', `bridge_session=${session.token}`)
      .send({ accountId: account.id, csrfToken: session.csrfToken, ...body });

    const single = await post({
      action: 'buy', instrument: 'MGC1!', orderType: 'stop', stopPrice: 4300,
      takeProfitTicks: 40, stopLossTicks: 20, convertTicksToPrices: true,
    });
    expect(single.status).toBe(200);
    expect(single.body.sent).toMatchObject({ take_profit: 4304, stop_loss: 4298 });

    const both = await post({
      action: 'both', instrument: 'MGC1!', stopPrice: 4300, bottomPrice: 4290,
      takeProfitTicks: 40, stopLossTicks: 20, convertTicksToPrices: true,
    });
    expect(both.status).toBe(200);
    expect((both.body.legs as Array<{ sent: Record<string, unknown> }>).map((leg) => [leg.sent.take_profit, leg.sent.stop_loss]))
      .toEqual([[4304, 4298], [4286, 4292]]);

    const market = await post({
      action: 'sell', instrument: 'MGC1!', orderType: 'market', referencePrice: 4300,
      takeProfitTicks: 40, stopLossTicks: 20, convertTicksToPrices: true,
    });
    expect(market.status).toBe(200);
    expect(market.body.sent).toMatchObject({ take_profit: 4296, stop_loss: 4302 });
    expect(sent.filter((item) => item.url === ctUrl)).toHaveLength(4);
  });

  it('requires an explicit reference price to convert market-order exits', async () => {
    const database = new Database(':memory:');
    const user = database.createUser('admin@example.com');
    const account = database.createAccount({ userId: user.id, name: 'CT account', startingBalanceCents: 0 });
    database.upsertTradersPostAccountDestination(
      user.id, account.id, 'https://traderspost.example/hook', undefined, undefined,
      true, false, false, '16:30', '16:45', false, false, 5, false,
      { webhookUrl: 'https://app.crosstrade.io/v1/send/test/channel', secretKey: 'ct-secret', accountName: 'Sim101' },
    );
    const fetchMock = vi.fn();
    const sessionSecret = 'ct-test-session-secret';
    const app = createApp(database, {
      proxyWebhookSecret: PROXY_SECRET,
      sessionSecret,
      adminUserEmail: user.email,
      fetch: fetchMock as typeof globalThis.fetch,
    });
    const session = createWebSession(database, user.id, sessionSecret);
    const res = await supertest(app)
      .post('/app/debugging/crosstrade-test')
      .set('Cookie', `bridge_session=${session.token}`)
      .send({
        accountId: account.id, csrfToken: session.csrfToken, action: 'buy', instrument: 'MGC1!',
        orderType: 'market', takeProfitTicks: 40, convertTicksToPrices: true,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('reference entry price');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
