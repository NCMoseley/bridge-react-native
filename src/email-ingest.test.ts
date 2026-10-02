import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { Database } from './database.js';
import { createApp } from './server.js';
import {
  isTradersPostSender,
  normalizeInboundEmail,
  parseTradersPostEmail,
} from './email-ingest.js';

process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? 'test-admin-api-key-000000000000000000000000000000';

const SESSION_SECRET = 'test-session-secret-000000000000000000000000000000';
const INITIAL_USER_PASSWORD = 'test-password-000000000000000000000000000000';

const FAILURE_BODY = `Hi,

A trade for MBTV2026 from your strategy Nate in your account 83 failed to execute.

Review the details below to help resolve the issue:

Error:
InvalidPrice: Please check the order price. The current price is outside the price limits set for this product.

Payload:
{
    "ticker": "MBT1!",
    "time": "1789895160000",
    "interval": "1",
    "extras": {
        "source": "ultra-v5.3",
        "strategyStopPrice": 80333,
        "strategyStopMode": "intrabar",
        "orderRole": "range_bracket",
        "orderLeg": "single",
        "rangeName": "SATOSHI"
    },
    "action": "buy",
    "quantity": 5,
    "quantityType": "fixed_quantity",
    "price": 80770,
    "signalPrice": 80770,
    "orderType": "stop",
    "stopPrice": 80770,
    "takeProfit": {
        "percent": 0.4828525443
    },
    "stopLoss": {
        "type": "stop",
        "percent": 0.5410424663
    },
    "bracketId": "ultra-v5.3-MBT1!-1789880460000-23-long-arm-23",
    "bracketSide": "long"
}`;

function inbound(overrides: Record<string, unknown> = {}) {
  return {
    from: 'alerts@traderspost.io',
    subject: 'TradersPost order failed',
    text: FAILURE_BODY,
    ...overrides,
  };
}

function setup() {
  const database = new Database(':memory:');
  const user = database.createUser('test@example.com');
  const account = database.createAccount({
    userId: user.id,
    name: 'Nate',
    startingBalanceCents: 0,
  });
  const app = createApp(database, {
    sessionSecret: SESSION_SECRET,
    initialUserPassword: INITIAL_USER_PASSWORD,
    proxyWebhookSecret: 'test-proxy-secret',
    emailIngestSecret: 'test-email-secret',
    adminUserEmail: 'test@example.com',
  });
  return { database, user, account, app };
}

function emailUrl(userId: string, accountId: string, secret: string) {
  return `/email/${userId}/${accountId}/${secret}`;
}

describe('normalizeInboundEmail', () => {
  it('accepts the relay JSON contract', () => {
    const email = normalizeInboundEmail(inbound());
    expect(email).toMatchObject({
      from: 'alerts@traderspost.io',
      subject: 'TradersPost order failed',
    });
  });

  it('accepts form-style provider field names', () => {
    const email = normalizeInboundEmail({
      sender: 'alerts@traderspost.io',
      subject: 'TradersPost order failed',
      'body-plain': FAILURE_BODY,
    });
    expect(email?.from).toBe('alerts@traderspost.io');
    expect(email?.text).toBe(FAILURE_BODY);
  });

  it('rejects bodies without sender or text', () => {
    expect(normalizeInboundEmail({ subject: 'x' })).toBeUndefined();
    expect(normalizeInboundEmail(null)).toBeUndefined();
  });

  it('decodes a raw multipart MIME message (Cloudflare worker posts message.raw)', () => {
    const raw = [
      'From: TradersPost <alerts@traderspost.io>',
      'To: tp@example.com',
      'Subject: TradersPost order failed',
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="bnd123"',
      '',
      '--bnd123',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(FAILURE_BODY).toString('base64'),
      '',
      '--bnd123',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>failed</p>').toString('base64'),
      '',
      '--bnd123--',
    ].join('\r\n');
    const email = normalizeInboundEmail({ raw });
    expect(email?.from).toContain('traderspost.io');
    expect(email?.subject).toBe('TradersPost order failed');
    expect(email?.text).toContain('ultra-v5.3-MBT1!-1789880460000-23-long-arm-23');
    expect(email?.html).toContain('<p>failed</p>');
  });
});

describe('isTradersPostSender', () => {
  it('accepts traderspost.io senders', () => {
    expect(isTradersPostSender('alerts@traderspost.io')).toBe(true);
    expect(isTradersPostSender('TradersPost <noreply@mail.traderspost.io>')).toBe(true);
  });

  it('rejects spoofed domains', () => {
    expect(isTradersPostSender('alerts@traderspost.io.evil.com')).toBe(false);
    expect(isTradersPostSender('attacker@example.com')).toBe(false);
  });
});

describe('parseTradersPostEmail', () => {
  it('extracts bracket, ticker, and action from a real TP failure email', () => {
    const parsed = parseTradersPostEmail({
      from: 'alerts@traderspost.io',
      subject: 'TradersPost order failed',
      text: FAILURE_BODY,
    });
    expect(parsed.isFailure).toBe(true);
    expect(parsed.bracketId).toBe('ultra-v5.3-MBT1!-1789880460000-23-long-arm-23');
    expect(parsed.ticker).toBe('MBT1!');
    expect(parsed.action).toBe('buy');
    expect(parsed.bracketSide).toBe('long');
    expect(parsed.strategy).toBe('Nate');
    expect(parsed.tpAccount).toBe('83');
    expect(parsed.errorText).toContain('InvalidPrice');
    expect(parsed.errorText).not.toContain('Hi,');
  });

  it('extracts fields from entity-escaped HTML mail (real TP failure shape)', () => {
    // The real "Buy MBTV2026 failed from 83" email arrives HTML-only; the
    // echoed payload shows up as &quot;field&quot;: &quot;value&quot;.
    const html = FAILURE_BODY.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    const parsed = parseTradersPostEmail(inbound({ text: `<div>${html}</div>` }));
    expect(parsed.isFailure).toBe(true);
    expect(parsed.bracketId).toBe('ultra-v5.3-MBT1!-1789880460000-23-long-arm-23');
    expect(parsed.action).toBe('buy');
    expect(parsed.ticker).toBe('MBT1!');
    expect(parsed.errorText).toContain('InvalidPrice');
  });

  it('marks non-failure mail as not a failure', () => {
    const parsed = parseTradersPostEmail({
      from: 'alerts@traderspost.io',
      subject: 'Your weekly TradersPost summary',
      text: 'Everything executed normally this week.',
    });
    expect(parsed.isFailure).toBe(false);
  });

  it('falls back to a ticker pattern when no JSON is embedded', () => {
    const parsed = parseTradersPostEmail({
      from: 'alerts@traderspost.io',
      subject: 'TradersPost order failed',
      text: 'The order for MNQ1! was rejected by the broker.',
    });
    expect(parsed.isFailure).toBe(true);
    expect(parsed.ticker).toBe('MNQ1!');
  });

  it('captures multi-word strategy names', () => {
    const parsed = parseTradersPostEmail({
      from: 'alerts@traderspost.io',
      subject: 'TradersPost order failed',
      text: 'A trade for MNQ1! from your strategy Test Account in your account 5 failed to execute.',
    });
    expect(parsed.strategy).toBe('Test Account');
    expect(parsed.tpAccount).toBe('5');
  });

  it('falls back to a standalone broker error line when no Error: block exists', () => {
    const parsed = parseTradersPostEmail({
      from: 'alerts@traderspost.io',
      subject: 'TradersPost order failed',
      text: 'Your order could not be completed.\n\nInvalidPrice: outside price limits.\n\nPayload: {"ticker":"MBT1!","bracketId":"b-1"}',
    });
    expect(parsed.isFailure).toBe(true);
    expect(parsed.errorText).toContain('InvalidPrice');
    expect(parsed.errorText).not.toContain('could not be completed');
  });
});

describe('POST /email/:userId/:accountId/:secret', () => {
  it('rejects invalid credentials', async () => {
    const { user, account, app } = setup();
    await supertest(app)
      .post(emailUrl(user.id, account.id, 'wrong-secret'))
      .send(inbound())
      .expect(401);
  });

  it('rejects an account belonging to another user', async () => {
    const { database, user, app } = setup();
    const other = database.createUser('other@example.com');
    const otherAccount = database.createAccount({ userId: other.id, name: 'Other', startingBalanceCents: 0 });
    await supertest(app)
      .post(emailUrl(user.id, otherAccount.id, user.webhookSecret))
      .send(inbound())
      .expect(404);
  });

  it('stores non-TradersPost senders for review and still processes the failure', async () => {
    const { database, user, account, app } = setup();
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'ultra-v5.3-MBT1!-1789880460000-23-long-arm-23',
      orderId: 'bridge-fwd',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound({ from: 'n.c.moseley@gmail.com' }))
      .expect(202);
    expect(res.body.matched).toBe(1);
    expect(database.findBrokerOrder(account.id, 'bridge-fwd')?.status).toBe('rejected');
    const logs = database.listBridgeLogs({ userId: user.id, since: new Date(Date.now() - 60000).toISOString() });
    const emailLog = logs.find((l) => l.category === 'email');
    expect(emailLog?.data?.senderTrusted).toBe(false);
  });

  it('stores non-failure mail for review without touching the ledger', async () => {
    const { database, user, account, app } = setup();
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'ultra-v5.3-MBT1!-1789880460000-23-long-arm-23',
      orderId: 'bridge-1',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound({ subject: 'Your weekly TradersPost summary', text: 'All good.' }))
      .expect(202);
    expect(res.body.stored).toBe(true);
    expect(res.body.notFailure).toBe(true);
    expect(database.findBrokerOrder(account.id, 'bridge-1')?.status).toBe('acknowledged');
    const logs = database.listBridgeLogs({ userId: user.id, since: new Date(Date.now() - 60000).toISOString() });
    const emailLog = logs.find((l) => l.category === 'email');
    expect(emailLog?.data?.notFailure).toBe(true);
  });

  it('marks the matching open broker order rejected', async () => {
    const { database, user, account, app } = setup();
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'ultra-v5.3-MBT1!-1789880460000-23-long-arm-23',
      orderId: 'bridge-1',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound())
      .expect(202);
    expect(res.body.matched).toBe(1);
    const order = database.findBrokerOrder(account.id, 'bridge-1');
    expect(order?.status).toBe('rejected');
    expect(order?.errorText).toContain('InvalidPrice');
    const logs = database.listBridgeLogs({ userId: user.id, since: new Date(Date.now() - 60000).toISOString() });
    expect(logs.some((l) => l.category === 'email')).toBe(true);
  });

  it('correlates by instrument root when no bracket id is present', async () => {
    const { database, user, account, app } = setup();
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      orderId: 'bridge-2',
      action: 'sell',
      status: 'uncertain',
      instrument: 'MBT1!',
      side: 'short',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound({
        subject: 'TradersPost order failed',
        text: 'The order for MBTZ5 was rejected by the broker.',
      }))
      .expect(202);
    expect(res.body.matched).toBe(1);
    expect(database.findBrokerOrder(account.id, 'bridge-2')?.status).toBe('rejected');
  });

  it('does not sweep same-instrument neighbors when a bracket id is present', async () => {
    const { database, user, account, app } = setup();
    // Same instrument + action + recent — but a DIFFERENT bracket than the email's.
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'ultra-v5.3-MBT1!-9999999999999-99-long-arm-99',
      orderId: 'bridge-neighbor',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound())
      .expect(202);
    expect(res.body.matched).toBe(0);
    expect(database.findBrokerOrder(account.id, 'bridge-neighbor')?.status).toBe('acknowledged');
  });

  it('matches ledger rows whose bracket id was normalized on storage', async () => {
    const { database, user, account, app } = setup();
    // Pine ids are normalized on ingest (' → r); the email echoes the raw form.
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'ultra-v5.3-MBT1!-1789880460000-23-long-arm-r3',
      orderId: 'bridge-norm',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound({
        text: FAILURE_BODY.replace('long-arm-23', "long-arm-'3"),
      }))
      .expect(202);
    expect(res.body.matched).toBe(1);
    expect(database.findBrokerOrder(account.id, 'bridge-norm')?.status).toBe('rejected');
  });

  it('does not match a different account or unrelated instrument', async () => {
    const { database, user, account, app } = setup();
    const other = database.createAccount({ userId: user.id, name: 'Other', startingBalanceCents: 0 });
    database.upsertBrokerOrder({
      accountId: other.id,
      rangeName: 'SATOSHI',
      bracketId: 'ultra-v5.3-MBT1!-1789880460000-23-long-arm-23',
      orderId: 'bridge-3',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound())
      .expect(202);
    expect(res.body.matched).toBe(0);
    expect(database.findBrokerOrder(other.id, 'bridge-3')?.status).toBe('acknowledged');
  });
});

describe('POST /email/:secret (generic attribution)', () => {
  it('rejects a wrong ingest secret', async () => {
    const { app } = setup();
    await supertest(app).post('/email/wrong-secret').send(inbound()).expect(401);
  });

  it('attributes via bracketId to the owning account, even across users', async () => {
    const { database, app } = setup();
    const other = database.createUser('other@example.com');
    const otherAccount = database.createAccount({ userId: other.id, name: 'Other', startingBalanceCents: 0 });
    database.upsertBrokerOrder({
      accountId: otherAccount.id,
      rangeName: 'SATOSHI',
      bracketId: 'ultra-v5.3-MBT1!-1789880460000-23-long-arm-23',
      orderId: 'bridge-4',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post('/email/test-email-secret')
      .send(inbound())
      .expect(202);
    expect(res.body.attributed).toBe(true);
    expect(res.body.matched).toBe(1);
    expect(database.findBrokerOrder(otherAccount.id, 'bridge-4')?.status).toBe('rejected');
    const logs = database.listBridgeLogs({ userId: other.id, since: new Date(Date.now() - 60000).toISOString() });
    expect(logs.some((l) => l.category === 'email')).toBe(true);
  });

  it('falls back to strategy name for attribution but never guesses orders', async () => {
    const { database, user, account, app } = setup();
    // Same instrument but a different bracket — the email's bracketId is absent
    // from the ledger, so attribution still lands but no row may be resolved.
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'unrelated-bracket',
      orderId: 'bridge-5',
      action: 'buy',
      status: 'uncertain',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post('/email/test-email-secret')
      .send(inbound())
      .expect(202);
    expect(res.body.attributed).toBe(true);
    expect(res.body.matched).toBe(0);
    expect(database.findBrokerOrder(account.id, 'bridge-5')?.status).toBe('uncertain');
    const logs = database.listBridgeLogs({ userId: user.id, since: new Date(Date.now() - 60000).toISOString() });
    const emailLog = logs.find((l) => l.category === 'email');
    expect(emailLog?.data?.attributedBy).toBe('strategy');
  });

  it('scopes a bracket match to the echoed action so a TP sibling survives', async () => {
    const { database, account, app } = setup();
    // Entry and take-profit dispatches share one bracketId but carry opposite
    // actions — a failed buy must not resolve the still-open sell leg.
    for (const [orderId, action] of [['bridge-entry', 'buy'], ['bridge-tp', 'sell']] as const) {
      database.upsertBrokerOrder({
        accountId: account.id,
        rangeName: 'SATOSHI',
        bracketId: 'ultra-v5.3-MBT1!-1789880460000-23-long-arm-23',
        orderId,
        action,
        status: 'acknowledged',
        instrument: 'MBT1!',
        side: 'long',
        quantity: 5,
        occurredAt: new Date().toISOString(),
      });
    }
    const res = await supertest(app)
      .post('/email/test-email-secret')
      .send(inbound())
      .expect(202);
    expect(res.body.matched).toBe(1);
    expect(database.findBrokerOrder(account.id, 'bridge-entry')?.status).toBe('rejected');
    expect(database.findBrokerOrder(account.id, 'bridge-tp')?.status).toBe('acknowledged');
  });

  it('leaves ambiguous unbracketed instrument matches for operator review', async () => {
    const { database, user, account, app } = setup();
    // Two open dispatches on the same root with no bracket id in the email —
    // there is no safe pick, so nothing may be mutated.
    for (const [orderId, side] of [['bridge-a', 'long'], ['bridge-b', 'short']] as const) {
      database.upsertBrokerOrder({
        accountId: account.id,
        rangeName: 'SATOSHI',
        bracketId: `unrelated-${orderId}`,
        orderId,
        action: 'buy',
        status: 'acknowledged',
        instrument: 'MBT1!',
        side,
        quantity: 5,
        occurredAt: new Date().toISOString(),
      });
    }
    const res = await supertest(app)
      .post('/email/test-email-secret')
      .send(inbound({
        text: 'The order for MBT1! was rejected by the broker. From your strategy Nate.',
      }))
      .expect(202);
    expect(res.body.attributed).toBe(true);
    expect(res.body.matched).toBe(0);
    expect(database.findBrokerOrder(account.id, 'bridge-a')?.status).toBe('acknowledged');
    expect(database.findBrokerOrder(account.id, 'bridge-b')?.status).toBe('acknowledged');
    const logs = database.listBridgeLogs({ userId: user.id, since: new Date(Date.now() - 60000).toISOString() });
    const emailLog = logs.find((l) => l.category === 'email');
    expect(emailLog?.data?.ambiguous).toBe(true);
    expect(emailLog?.data?.candidateOrders).toEqual(expect.arrayContaining(['bridge-a', 'bridge-b']));
  });

  it('retires the armed monitor row when the emailed rejection kills its only order', async () => {
    const { database, account, app } = setup();
    // The prod failure shape: a delivered re-arm order whose broker rejection
    // arrives asynchronously by email while bracket_monitor still says armed.
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'bridge-reapply-arm1',
      orderId: 'bridge-reapply-arm1',
      action: 'buy',
      status: 'acknowledged',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    database.recordBracketMonitorEvent({
      accountId: account.id,
      rangeName: 'SATOSHI',
      tradeId: 'bridge-reapply-arm1',
      eventId: 'bridge-reapply-arm1-entry_armed',
      eventType: 'entry_armed',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const res = await supertest(app)
      .post('/email/test-email-secret')
      .send(inbound({
        text: FAILURE_BODY.replace('ultra-v5.3-MBT1!-1789880460000-23-long-arm-23', 'bridge-reapply-arm1'),
      }))
      .expect(202);
    expect(res.body.matched).toBe(1);
    expect(database.findBrokerOrder(account.id, 'bridge-reapply-arm1')?.status).toBe('rejected');
    const monitor = database.findBracketMonitorEntry(account.id, 'SATOSHI', 'bridge-reapply-arm1', 'long');
    expect(monitor?.state).toBe('cancelled');
    expect(monitor?.lastEventId).toBe('email-reject-bridge-reapply-arm1');
  });

  it('retires only the rejected arm — a same-account sibling arm stays armed', async () => {
    const { database, account, app } = setup();
    for (const [id, action, side] of [['bridge-reapply-long', 'buy', 'long'], ['bridge-reapply-short', 'sell', 'short']] as const) {
      database.upsertBrokerOrder({
        accountId: account.id,
        rangeName: 'SATOSHI',
        bracketId: id,
        orderId: id,
        action,
        status: 'acknowledged',
        instrument: 'MBT1!',
        side,
        quantity: 5,
        occurredAt: new Date().toISOString(),
      });
      database.recordBracketMonitorEvent({
        accountId: account.id,
        rangeName: 'SATOSHI',
        tradeId: id,
        eventId: `${id}-entry_armed`,
        eventType: 'entry_armed',
        instrument: 'MBT1!',
        side,
        quantity: 5,
        occurredAt: new Date().toISOString(),
      });
    }
    const res = await supertest(app)
      .post('/email/test-email-secret')
      .send(inbound({
        text: FAILURE_BODY.replace('ultra-v5.3-MBT1!-1789880460000-23-long-arm-23', 'bridge-reapply-long'),
      }))
      .expect(202);
    expect(res.body.matched).toBe(1);
    expect(database.findBracketMonitorEntry(account.id, 'SATOSHI', 'bridge-reapply-long', 'long')?.state).toBe('cancelled');
    expect(database.findBracketMonitorEntry(account.id, 'SATOSHI', 'bridge-reapply-short', 'short')?.state).toBe('armed');
    expect(database.findBrokerOrder(account.id, 'bridge-reapply-short')?.status).toBe('acknowledged');
  });

  it('does not retire an arm on another account sharing the instrument', async () => {
    const { database, user, account, app } = setup();
    const other = database.createAccount({ userId: user.id, name: 'Other', startingBalanceCents: 0 });
    for (const acct of [account, other]) {
      database.upsertBrokerOrder({
        accountId: acct.id,
        rangeName: 'SATOSHI',
        bracketId: 'bridge-reapply-arm1',
        orderId: 'bridge-reapply-arm1',
        action: 'buy',
        status: 'acknowledged',
        instrument: 'MBT1!',
        side: 'long',
        quantity: 5,
        occurredAt: new Date().toISOString(),
      });
      database.recordBracketMonitorEvent({
        accountId: acct.id,
        rangeName: 'SATOSHI',
        tradeId: 'bridge-reapply-arm1',
        eventId: 'bridge-reapply-arm1-entry_armed',
        eventType: 'entry_armed',
        instrument: 'MBT1!',
        side: 'long',
        quantity: 5,
        occurredAt: new Date().toISOString(),
      });
    }
    const res = await supertest(app)
      .post(emailUrl(user.id, account.id, user.webhookSecret))
      .send(inbound({
        text: FAILURE_BODY.replace('ultra-v5.3-MBT1!-1789880460000-23-long-arm-23', 'bridge-reapply-arm1'),
      }))
      .expect(202);
    expect(res.body.matched).toBe(1);
    expect(database.findBracketMonitorEntry(account.id, 'SATOSHI', 'bridge-reapply-arm1', 'long')?.state).toBe('cancelled');
    expect(database.findBracketMonitorEntry(other.id, 'SATOSHI', 'bridge-reapply-arm1', 'long')?.state).toBe('armed');
    expect(database.findBrokerOrder(other.id, 'bridge-reapply-arm1')?.status).toBe('acknowledged');
  });

  it('exposes the broker rejection in open trade sanity even when delivery succeeded', async () => {
    const { database, user, account } = setup();
    // Pre-fix divergence: delivery says TradersPost accepted the webhook while
    // the ledger row was later rejected by the broker via the failure email.
    database.upsertBrokerOrder({
      accountId: account.id,
      rangeName: 'SATOSHI',
      bracketId: 'bridge-reapply-arm1',
      orderId: 'bridge-reapply-arm1',
      action: 'buy',
      status: 'rejected',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      errorText: 'InvalidPrice: outside price limits',
      occurredAt: new Date().toISOString(),
    });
    database.recordBracketMonitorEvent({
      accountId: account.id,
      rangeName: 'SATOSHI',
      tradeId: 'bridge-reapply-arm1',
      eventId: 'bridge-reapply-arm1-entry_armed',
      eventType: 'entry_armed',
      instrument: 'MBT1!',
      side: 'long',
      quantity: 5,
      occurredAt: new Date().toISOString(),
    });
    const sanity = database.listOpenTradeSanity(user.id);
    const row = sanity.find((r) => r.bracketId === 'bridge-reapply-arm1');
    expect(row?.brokerOrderStatus).toBe('rejected');
    expect(row?.brokerOrderErrorText).toContain('InvalidPrice');
  });

  it('surfaces unattributable failures to the admin without touching ledgers', async () => {
    const { database, user, app } = setup();
    const res = await supertest(app)
      .post('/email/test-email-secret')
      .send(inbound({ text: FAILURE_BODY.replace('strategy Nate', 'strategy Ghost') }))
      .expect(202);
    expect(res.body.attributed).toBe(false);
    expect(res.body.matched).toBe(0);
    // setup() makes the first user the admin fallback target
    const logs = database.listBridgeLogs({ userId: user.id, since: new Date(Date.now() - 60000).toISOString() });
    const emailLog = logs.find((l) => l.category === 'email');
    expect(emailLog?.data?.unattributed).toBe(true);
  });
});
