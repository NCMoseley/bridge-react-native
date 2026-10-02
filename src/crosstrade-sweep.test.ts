import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './database.js';
import {
  fetchCrossTradeOrders,
  fetchCrossTradePositions,
  resetCrossTradeRateLimiterForTests,
} from './crosstrade.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const makeDb = () => {
  const directory = mkdtempSync(join(tmpdir(), 'ct-sweep-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = new Database(join(directory, 'bridge.sqlite'));
  cleanup.push(() => database.close());
  return database;
};

// The sweep's work list: pending/uncertain rows are always eligible past the
// grace cutoff, but acknowledged rows only get probed inside the verify
// horizon — and never once the NT8 book has confirmed them ('ct-verified').
// Without that, every verified order was re-probed every sweep forever.
describe('listUnresolvedCrossTradeOrdersBefore', () => {
  it('keeps acknowledged rows inside the horizon, drops verified and stale ones', () => {
    const database = makeDb();
    const user = database.createUser('sweep@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Acct', startingBalanceCents: 0 });
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const cutoff = ago(60_000);
    const horizon = ago(30 * 60_000);
    const seed = (orderId: string, status: 'pending' | 'uncertain' | 'acknowledged', occurredAt: string, statusSource?: string) =>
      database.createBrokerOrder({
        accountId: account.id,
        rangeName: 'V3X',
        bracketId: `${orderId}-bracket`,
        orderId,
        action: 'buy',
        status,
        instrument: 'MNQ1!',
        destination: 'crosstrade',
        occurredAt,
        ...(statusSource ? { statusSource: statusSource as never } : {}),
      });

    seed('pending-old', 'pending', ago(10 * 60_000));
    seed('uncertain-old', 'uncertain', ago(10 * 60_000));
    seed('ack-dispatch-in-window', 'acknowledged', ago(10 * 60_000));
    seed('ack-verified-in-window', 'acknowledged', ago(10 * 60_000), 'ct-verified');
    seed('ack-stale', 'acknowledged', ago(60 * 60_000));
    seed('ack-null-source', 'acknowledged', ago(10 * 60_000), 'legacy');
    seed('pending-too-new', 'pending', ago(30_000));

    const ids = database.listUnresolvedCrossTradeOrdersBefore(cutoff, horizon).map((o) => o.orderId);
    expect(ids).toEqual(expect.arrayContaining([
      'pending-old', 'uncertain-old', 'ack-dispatch-in-window', 'ack-null-source',
    ]));
    expect(ids).not.toContain('ack-verified-in-window');
    expect(ids).not.toContain('ack-stale');
    expect(ids).not.toContain('pending-too-new');
  });
});

// CrossTrade budgets REST reads per user key (not per account), so reads
// serialize per credential with spacing — and a 429 with Retry-After parks the
// whole key instead of letting queued calls retry into the limit.
describe('CrossTrade REST rate limiter', () => {
  const DESTINATION = {
    webhookUrl: 'https://app.crosstrade.io/v1/send/uid/channel',
    secretKey: 'secret-abc',
    accountName: 'TEST-ACCOUNT',
  };
  const OTHER_KEY_DESTINATION = { ...DESTINATION, secretKey: 'secret-xyz' };

  beforeEach(() => {
    resetCrossTradeRateLimiterForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetCrossTradeRateLimiterForTests();
  });

  it('serializes and spaces calls sharing one credential', async () => {
    const fetchMock = vi.fn(async () => new Response('{"success":true,"orders":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const calls = [fetchCrossTradeOrders(DESTINATION), fetchCrossTradePositions(DESTINATION), fetchCrossTradeOrders(DESTINATION)];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const result of await Promise.all(calls)) expect(result.ok).toBe(true);
  });

  it('does not share a bucket across different credentials', async () => {
    const fetchMock = vi.fn(async () => new Response('{"success":true,"orders":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const calls = [fetchCrossTradeOrders(DESTINATION), fetchCrossTradeOrders(OTHER_KEY_DESTINATION)];
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const result of await Promise.all(calls)) expect(result.ok).toBe(true);
  });

  it('honors Retry-After on a 429 instead of letting queued calls retry', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => new Response('{"success":false,"error":"rate limited","retryAfter":2}', {
        status: 429,
        headers: { 'retry-after': '2' },
      }))
      .mockImplementation(async () => new Response('{"success":true,"orders":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const limited = fetchCrossTradeOrders(DESTINATION);
    const queued = fetchCrossTradeOrders(DESTINATION);
    await vi.advanceTimersByTimeAsync(0);
    const first = await limited;
    expect(first.ok).toBe(false);
    expect(first.statusCode).toBe(429);
    // The queued call must wait out the server-supplied cooldown, not the
    // ordinary spacing.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await queued).ok).toBe(true);
  });
});

// The wire order_id (bracket id) fans out to every routed account — an
// unscoped order_id lookup poisons account A's resolution with account B's
// row. Regression for the stuck-acknowledged bug found on dev.
describe('findBrokerOrder account scoping', () => {
  it('returns the owning account row even when a sibling shares the order_id', () => {
    const database = makeDb();
    const user = database.createUser('scope@example.com');
    const a1 = database.createAccount({ userId: user.id, name: 'A1', startingBalanceCents: 0 });
    const a2 = database.createAccount({ userId: user.id, name: 'A2', startingBalanceCents: 0 });
    const oid = 'SHARED-ultra-v5.3-MNQ1!-1-short-arm-1';
    for (const [acct, status] of [[a1, 'cancelled'], [a2, 'acknowledged']] as const) {
      database.createBrokerOrder({
        accountId: acct.id, rangeName: 'DAMN', bracketId: oid, orderId: oid,
        action: 'sell', status, instrument: 'MNQ1!', side: 'short', quantity: 1,
        destination: 'crosstrade', occurredAt: new Date().toISOString(),
      });
    }
    const row = database.findBrokerOrder(a2.id, oid);
    expect(row?.accountId).toBe(a2.id);
    expect(row?.status).toBe('acknowledged');
    expect(database.findBrokerOrder(a1.id, oid)?.status).toBe('cancelled');
  });
});

// Adoption identity lives in the monitor even when the ledger row is gone —
// a cancelled monitor must still identify its bracket (ledger purge case).
describe('listBracketMonitorEntriesForAdoption', () => {
  const seedArm = (database: Database, userId: string, accountId: string, bracketId: string) =>
    database.createTradeEvent({
      userId, accountId, rangeName: 'HEAVEN', eventId: `${bracketId}-arm`,
      tradeId: `${bracketId}-lifecycle-short-0`, eventType: 'entry_armed',
      instrument: 'MGC1!', side: 'short', action: 'sell', quantity: 1,
      entryPrice: 4000, occurredAt: new Date().toISOString(),
    });

  it('returns armed, filled, and cancelled rows — closed stays out', () => {
    const database = makeDb();
    const user = database.createUser('adopt@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Acct', startingBalanceCents: 0 });
    const at = () => new Date().toISOString();

    seedArm(database, user.id, account.id, 'armed-b');
    seedArm(database, user.id, account.id, 'cancelled-b');
    seedArm(database, user.id, account.id, 'filled-b');
    seedArm(database, user.id, account.id, 'closed-b');

    const cancelled = database.findBracketMonitorEntry(account.id, 'HEAVEN', 'cancelled-b', 'short')!;
    database.retireBracketMonitorEntry(user.id, cancelled, 'entry_cancelled', `${cancelled.bracketId}-cxl`, at());
    const filled = database.findBracketMonitorEntry(account.id, 'HEAVEN', 'filled-b', 'short')!;
    database.retireBracketMonitorEntry(user.id, filled, 'entry_filled', `${filled.bracketId}-fill`, at());
    const closed = database.findBracketMonitorEntry(account.id, 'HEAVEN', 'closed-b', 'short')!;
    database.retireBracketMonitorEntry(user.id, closed, 'trade_closed', `${closed.bracketId}-close`, at());

    const ids = database.listBracketMonitorEntriesForAdoption(account.id).map((m) => m.bracketId);
    expect(ids).toEqual(expect.arrayContaining(['armed-b', 'cancelled-b', 'filled-b']));
    expect(ids).not.toContain('closed-b');
  });

  it('reactivateBracketMonitorArm revives only cancelled rows', () => {
    const database = makeDb();
    const user = database.createUser('revive@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Acct', startingBalanceCents: 0 });
    const at = () => new Date().toISOString();

    seedArm(database, user.id, account.id, 'revive-b');
    const row = database.findBracketMonitorEntry(account.id, 'HEAVEN', 'revive-b', 'short')!;
    database.retireBracketMonitorEntry(user.id, row, 'entry_cancelled', 'revive-b-cxl', at());
    expect(database.findBracketMonitorEntry(account.id, 'HEAVEN', 'revive-b', 'short')?.state).toBe('cancelled');
    database.reactivateBracketMonitorArm(user.id, row);
    expect(database.findBracketMonitorEntry(account.id, 'HEAVEN', 'revive-b', 'short')?.state).toBe('armed');

    seedArm(database, user.id, account.id, 'norevive-b');
    const f = database.findBracketMonitorEntry(account.id, 'HEAVEN', 'norevive-b', 'short')!;
    database.retireBracketMonitorEntry(user.id, f, 'entry_filled', 'norevive-b-fill', at());
    database.reactivateBracketMonitorArm(user.id, f); // filled must not flip back
    expect(database.findBracketMonitorEntry(account.id, 'HEAVEN', 'norevive-b', 'short')?.state).toBe('filled');
  });
});

// CT-only accounts store the CT webhook in webhook_url. Once CT is parked that
// alias is NOT a TradersPost target — the read model blanks it so dispatch
// sees the account as unconfigured.
describe('parked CrossTrade destination mapping', () => {
  it('blanks webhook_url when CT is parked and the stored TP url equals the CT url', () => {
    const database = makeDb();
    const user = database.createUser('parked@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Acct', startingBalanceCents: 0 });
    const CT = 'https://app.crosstrade.io/v1/send/u/c';

    // The blanking lives in the read mapper — assert on the getter, not the
    // upsert's constructed return value.
    database.upsertTradersPostAccountDestination(
      user.id, account.id, CT, undefined, undefined, true, false, false,
      '16:30', '16:45', true, false, 5, false,
      { webhookUrl: CT, secretKey: 'k', accountName: 'NT8-A', enabled: false },
    );
    expect(database.getTradersPostAccountDestination(account.id)?.webhookUrl).toBe('');

    database.upsertTradersPostAccountDestination(
      user.id, account.id, 'https://traderspost.example/hook', undefined, undefined, true, false, false,
      '16:30', '16:45', true, false, 5, false,
      { webhookUrl: CT, secretKey: 'k', accountName: 'NT8-A', enabled: false },
    );
    expect(database.getTradersPostAccountDestination(account.id)?.webhookUrl).toBe('https://traderspost.example/hook');

    // Live CT with the alias in webhook_url keeps it (the alias is only
    // poisonous while CT is parked).
    database.upsertTradersPostAccountDestination(
      user.id, account.id, CT, undefined, undefined, true, false, false,
      '16:30', '16:45', true, false, 5, false,
      { webhookUrl: CT, secretKey: 'k', accountName: 'NT8-A', enabled: true },
    );
    expect(database.getTradersPostAccountDestination(account.id)?.webhookUrl).toBe(CT);
  });
});
