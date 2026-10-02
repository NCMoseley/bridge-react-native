import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './database.js';
import { createApp } from './server.js';
import { rangeSlugForLookup } from './webhook.js';
import type { EntryPayload, LifecyclePayload, TradersPostPayload } from './webhook.js';

const SECRET = 'reapply-safety-test';
const WEBHOOK = 'https://hooks.traderspost.io/webhook/test';
const cleanup: Array<() => void> = [];
function testApp(database: Database, options: Parameters<typeof createApp>[1]) {
  const app = createApp(database, options);
  cleanup.push(() => { app.locals.dispose(); database.close(); });
  return app;
}
type Arm = { range: string; side: 'long' | 'short'; ticker: string; index: number; price: number };
const arm = (range: string, overrides: Partial<Arm> = {}): Arm => ({ range, side: 'long', ticker: 'MNQ1!', index: 1, price: 25000, ...overrides });
// Fixture ids arrive already range-scoped (like Ultra 5.3 native output) so
// ingest leaves them unchanged and assertion ids equal stored ids.
const bracketId = (a: Arm) => `${rangeSlugForLookup(a.range)}-ultra-v5.1-${a.ticker}-123-${a.range}-${a.side}-arm-${a.index}`;
const tradeId = (a: Arm) => `${bracketId(a)}-lifecycle-${a.side}-0`;
const entry = (a: Arm): EntryPayload => ({ ticker: a.ticker, action: a.side === 'long' ? 'buy' : 'sell', bracketId: bracketId(a), bracketSide: a.side, quantity: 1, quantityType: 'fixed_quantity', orderType: 'stop', stopPrice: a.price, takeProfit: { percent: 0.1 }, stopLoss: { type: 'stop', percent: 0.1 }, extras: { rangeName: a.range } });
const lifecycle = (a: Arm, eventType: LifecyclePayload['eventType']): LifecyclePayload => ({ eventType, eventId: `${tradeId(a)}-${eventType}`, tradeId: tradeId(a), ticker: a.ticker, side: a.side, action: eventType === 'trade_closed' ? 'exit' : a.side === 'long' ? 'buy' : 'sell', quantity: 1, entryPrice: a.price, extras: { rangeName: a.range }, ...(eventType === 'trade_closed' ? { closedAt: new Date().toISOString(), exitPrice: a.price - 10, realizedTicks: 40, realizedDollars: 20, outcome: 'win' as const } : {}) });

class BrokerModel {
  calls: TradersPostPayload[] = [];
  pending = new Map<string, EntryPayload>();
  positions = new Map<string, EntryPayload>();
  protection = new Map<string, { ticker: string; stop: boolean; target: boolean }>();
  reject?: (payload: TradersPostPayload) => Response | undefined;
  beforeSend?: (payload: TradersPostPayload) => Promise<void>;
  afterSend?: (payload: TradersPostPayload) => Promise<void>;

  fetch: typeof fetch = async (_url, init) => {
    const payload = JSON.parse(String(init?.body)) as TradersPostPayload;
    this.calls.push(payload);
    await this.beforeSend?.(payload);
    const rejection = this.reject?.(payload);
    if (rejection) return rejection;
    if (payload.action === 'cancel') {
      expect(payload).not.toHaveProperty('bracketId');
      expect(payload).not.toHaveProperty('bracketSide');
      expect(payload).not.toHaveProperty('tradeId');
      for (const [id, order] of this.pending) if (order.ticker === payload.ticker) this.pending.delete(id);
      for (const [id, order] of this.protection) if (order.ticker === payload.ticker) this.protection.delete(id);
    } else if (payload.action === 'exit') {
      for (const [id, order] of this.positions) if (order.ticker === payload.ticker) this.positions.delete(id);
      for (const [id, order] of this.protection) if (order.ticker === payload.ticker) this.protection.delete(id);
    } else {
      this.pending.set(`${payload.bracketId}:${payload.action}`, payload);
    }
    await this.afterSend?.(payload);
    return new Response('{"success":true}', { status: 200 });
  };

  fill(a: Arm) {
    const match = [...this.pending].find(([, p]) => p.extras?.rangeName === a.range && p.bracketSide === a.side && !p.extras?.preciseTakeProfitAfterFill);
    expect(match, `working order for ${a.range} ${a.side}`).toBeDefined();
    this.pending.delete(match![0]);
    this.positions.set(match![0], match![1]);
    this.protection.set(match![0], { ticker: match![1].ticker, stop: Boolean(match![1].stopLoss), target: Boolean(match![1].takeProfit) });
  }

  close(a: Arm) {
    for (const [id, order] of this.positions) {
      if (order.extras?.rangeName === a.range && order.bracketSide === a.side) { this.positions.delete(id); this.protection.delete(id); }
    }
  }
}

function fixture(options: { enabled?: boolean; routeEnabled?: boolean; reapply?: boolean; micros?: boolean; exactTp?: boolean; filename?: string } = {}) {
  const database = new Database(options.filename ?? ':memory:');
  const user = database.createUser('reapply-safety@example.com');
  const account = database.createAccount({ userId: user.id, name: 'Safety test', startingBalanceCents: 0 });
  const broker = new BrokerModel();
  const configure = (enabled = options.enabled ?? true) => database.upsertTradersPostAccountDestination(user.id, account.id, WEBHOOK, undefined, options.micros ? 'micros_only' : undefined, enabled, options.exactTp ?? false, true, '16:30', '16:45', false, false, 5, options.reapply ?? true);
  configure();
  const brokers = new Map([[WEBHOOK, broker]]);
  const mockFetch: typeof fetch = async (url, init) => {
    const target = brokers.get(String(url));
    if (!target) throw new Error('Unexpected destination in isolated test');
    return target.fetch(url, init);
  };
  // Flatten legs default to multi-pass retries in production; these tests
  // assert single-pass-per-execute() semantics, so pin the policy to one send.
  const appOptions = { proxyWebhookSecret: SECRET, fetch: mockFetch, reapplyFlattenMaxSends: 1, reapplyFlattenRetryDelayMs: 0 };
  const app = testApp(database, appOptions);
  const post = async (payload: TradersPostPayload | LifecyclePayload) => {
    const response = await supertest(app).post(`/proxy/${SECRET}`).send(payload);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return response.body;
  };
  const place = async (a: Arm) => {
    if (!database.findRangeRoutes(a.range).length) {
      database.createTrackedRange(a.range, user.id);
      database.upsertRangeRoute({ userId: user.id, accountId: account.id, rangeName: a.range, extensionEnabled: false, traderspostEnabled: options.routeEnabled ?? true, runScheduled: false });
    }
    await post(entry(a));
    await post(lifecycle(a, 'entry_armed'));
  };
  const fill = async (a: Arm) => { broker.fill(a); await post(lifecycle(a, 'entry_filled')); };
  const close = async (a: Arm) => { broker.close(a); await post(lifecycle(a, 'trade_closed')); };
  return { database, account, user, broker, brokers, appOptions, app, configure, post, place, fill, close };
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

describe('reapply broker-state safety', () => {
  it('rebuilds only other ranges on the same instrument and preserves their order protection', async () => {
    const f = fixture();
    const a = arm('A'), opposite = arm('A', { side: 'short' }), b = arm('B'), gold = arm('GOLD', { ticker: 'MGC1!', price: 3500 });
    for (const order of [a, opposite, b, gold]) await f.place(order);
    await f.fill(a);
    f.broker.calls = [];
    await f.close(a);
    expect([...f.broker.pending.values()].map(p => p.extras?.rangeName).sort()).toEqual(['B', 'GOLD']);
    const replacement = [...f.broker.pending.values()].find(p => p.extras?.rangeName === 'B')!;
    expect(replacement.bracketId).not.toBe(bracketId(b));
    expect(replacement).toMatchObject({ action: 'buy', stopPrice: b.price, quantity: 1, takeProfit: { percent: 0.1 }, stopLoss: { type: 'stop', percent: 0.1 } });
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'exit', 'buy']);
  }, 15000);

  it('shows rearmed brackets as armed open trades until the next Pine lifecycle event', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a); await f.close(a);
    const original = f.database.findBracketMonitorEntry(f.account.id, 'B', bracketId(b), 'long');
    expect(original?.state).toBe('cancelled');
    const replacement = f.broker.calls.find(p => p.extras?.source === 'reapply')!;
    const row = f.database.findBracketMonitorEntry(f.account.id, 'B', String(replacement.bracketId), 'long');
    expect(row?.state).toBe('armed');
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id).openTrades;
    expect(open.map(t => t.bracketId)).toContain(String(replacement.bracketId));
    await f.fill(b);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'B', String(replacement.bracketId), 'long')?.state).toBe('filled');
    expect(f.database.listActiveBracketMonitorEntries(f.account.id).filter(e => e.rangeName === 'B').map(e => e.state)).toEqual(['filled']);
  }, 15000);

  it('does not resurrect a cancelled replacement arm when a paused reapply is retried', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), c = arm('C');
    await f.place(a); await f.place(b); await f.place(c); await f.fill(a);
    let reapplyEntries = 0;
    f.broker.reject = p => p.extras?.source === 'reapply' && ++reapplyEntries === 2 ? new Response('rejected', { status: 400 }) : undefined;
    await f.close(a);
    const op = f.database.listIncompleteReapplyOperations()[0];
    expect(op).toBeTruthy();
    const firstReapply = f.broker.calls.find(p => p.extras?.source === 'reapply')!;
    const firstRange = String(firstReapply.extras!.rangeName);
    const firstArm = firstRange === 'B' ? b : c;
    const replacementId = String(firstReapply.bracketId);
    expect(f.database.findBracketMonitorEntry(f.account.id, firstRange, replacementId, 'long')?.state).toBe('armed');
    await f.post(lifecycle(firstArm, 'entry_cancelled'));
    expect(f.database.findBracketMonitorEntry(f.account.id, firstRange, replacementId, 'long')?.state).toBe('cancelled');
    f.broker.reject = undefined;
    const res = await supertest(f.app).post(`/admin/reapply-operations/${op.id}/retry`).set('x-admin-key', process.env.ADMIN_API_KEY!);
    expect(res.status).toBe(200);
    expect(f.database.findBracketMonitorEntry(f.account.id, firstRange, replacementId, 'long')?.state).toBe('cancelled');
  }, 15000);

  it('tracks a later Pine fill against the replacement and protects it from another close', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), c = arm('C');
    for (const order of [a, b, c]) await f.place(order);
    await f.fill(a); await f.close(a); await f.fill(b);
    f.broker.calls = [];
    await f.close(c);
    expect(f.broker.calls).toEqual([]);
    expect([...f.broker.positions.values()].map(p => p.extras?.rangeName)).toEqual(['B']);
  }, 15000);

  it('tracks Pine same-side rearming after a closed trade', async () => {
    const f = fixture({ reapply: false }); const a = arm('A');
    await f.place(a); await f.fill(a); await f.close(a);
    const next = arm('A', { index: 2 }); await f.place(next);
    expect(f.database.getArmedBracketsForReapply(f.account.id, a.ticker).map(p => p.bracketId)).toContain(bracketId(next));
  });

  it.each([{ enabled: false }, { routeEnabled: false }])('never trades through disabled controls: %j', async options => {
    const f = fixture(options); const a = arm('A');
    await f.place(a); await f.place(arm('B')); await f.post(lifecycle(a, 'trade_closed'));
    expect(f.broker.calls).toEqual([]);
  });

  it('protects an MNQ position when an NQ close maps to the same destination instrument', async () => {
    const f = fixture({ micros: true }); const a = arm('A', { ticker: 'NQ1!' }), b = arm('B');
    for (const order of [a, arm('A', { ticker: 'NQ1!', side: 'short' }), b]) await f.place(order);
    await f.fill(a); await f.fill(b); f.broker.calls = [];
    await f.close(a);
    expect(f.broker.calls).toEqual([]);
    expect(f.broker.positions.size).toBe(1);
    expect([...f.broker.protection.values()]).toEqual([{ ticker: 'MNQ1!', stop: true, target: true }]);
  }, 15000);

  it('does not rearm when the safeguard exit is rejected', async () => {
    const f = fixture(); const a = arm('A');
    await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.action === 'exit' ? new Response('rejected', { status: 503 }) : undefined;
    f.broker.calls = [];
    await f.post(lifecycle(a, 'trade_closed'));
    expect(f.broker.pending.size).toBe(0);
    expect(f.broker.positions.size).toBe(1);
    expect(f.broker.calls.filter(p => p.action === 'buy' || p.action === 'sell')).toEqual([]);
  }, 15000);

  it('still safeguards the final close when there are no pending arms', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.fill(a);
    await f.post(lifecycle(a, 'trade_closed'));
    expect(f.broker.positions.size).toBe(0);
    expect(f.broker.calls.some(p => p.action === 'exit')).toBe(true);
  });

  it('does not duplicate an identical entry webhook', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.post(entry(a));
    expect(f.broker.calls.filter(p => p.action === 'buy')).toHaveLength(1);
  });

  it('marks an armed bracket as suppressed when its entry delivery was refused as a duplicate', async () => {
    const f = fixture(); const a = arm('A');
    f.database.createTrackedRange('A', f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
    await f.post(entry(a));
    await f.post(entry(a));
    expect(f.database.latestEntryDeliveryStatusForBracket(f.account.id, 'A', bracketId(a), 'buy', 'long')).toBe('suppressed_duplicate');
    expect(f.broker.calls.filter(p => p.action === 'buy')).toHaveLength(1);
    await f.post(lifecycle(a, 'entry_armed'));
    const row = f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(a), 'long');
    expect(row?.state).toBe('armed');
    expect(row?.deliverySuppressed).toBe(true);
    // Delivery attribution ranks stronger evidence before recency: the first
    // attempt delivered, so the later suppressed_duplicate must NOT make the
    // arm look blocked — 'delivered' wins over the stale dup.
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id).openTrades.find(t => t.tradeId === tradeId(a));
    expect(open?.entryArmedDeliveryStatus).toBe('delivered');
  });

  it('delivers new entries even when an unfinished reapply exists on the instrument', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.action === 'exit' ? new Response('unknown outcome', { status: 503 }) : undefined;
    await f.close(a);
    const c = arm('C'); await f.place(c);
    expect(f.broker.calls.some(p => p.extras?.rangeName === 'C' && p.action === 'buy')).toBe(true);
    expect(f.database.latestEntryDeliveryStatusForBracket(f.account.id, 'C', bracketId(c), 'buy', 'long')).toBe('traderspost_delivered');
    const row = f.database.findBracketMonitorEntry(f.account.id, 'C', bracketId(c), 'long');
    expect(row?.state).toBe('armed');
    expect(row?.deliverySuppressed).toBe(false);
    const open = f.database.getTradeJournal(f.user.id, new Date(), f.account.id).openTrades.find(t => t.tradeId === tradeId(c));
    expect(open?.entryArmedDeliveryStatus).not.toBe('blocked');
  });

  it('ignores a filled monitor whose entry was never dispatched when a close needs cleanup', async () => {
    const f = fixture();
    // GHOST's route never reaches TradersPost — its Pine fill is simulated only,
    // so it must not block instrument cleanup for real positions.
    const ghost = arm('GHOST', { price: 24900 });
    f.database.createTrackedRange(ghost.range, f.user.id);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: ghost.range, extensionEnabled: false, traderspostEnabled: false, runScheduled: false });
    await f.post(entry(ghost));
    await f.post(lifecycle(ghost, 'entry_armed'));
    await f.post(lifecycle(ghost, 'entry_filled'));
    expect(f.broker.calls).toEqual([]);

    const b = arm('B'); await f.place(b); await f.fill(b); f.broker.calls = [];
    await f.close(b);
    expect(f.broker.calls.some(p => p.action === 'cancel' && p.ticker === b.ticker)).toBe(true);
    expect(f.broker.calls.some(p => p.action === 'exit' && p.ticker === b.ticker)).toBe(true);
  });

  it('still blocks cleanup when the filled monitor has an attempted but unresolved entry', async () => {
    const f = fixture(); const a = arm('A');
    f.broker.reject = p => p.bracketId === bracketId(a) ? new Response('unknown outcome', { status: 503 }) : undefined;
    await f.place(a);
    f.broker.reject = undefined;
    // Ultra reports the fill even though the dispatch outcome is uncertain — the
    // order may be live at the broker, so it must keep blocking cleanup.
    await f.post(lifecycle(a, 'entry_filled'));

    const b = arm('B'); await f.place(b); await f.fill(b); f.broker.calls = [];
    await f.close(b);
    expect(f.broker.calls.some(p => p.action === 'cancel' || p.action === 'exit')).toBe(false);
  });

  it('selects the original entry rather than its separately placed exact TP', async () => {
    const f = fixture({ exactTp: true }); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a); f.broker.calls = [];
    await f.close(a);
    const replacement = f.broker.calls.find(p => p.extras?.source === 'reapply' && !p.extras?.preciseTakeProfitAfterFill);
    expect(replacement).toMatchObject({ action: 'buy', orderType: 'stop', stopPrice: b.price, bracketSide: 'long' });
  }, 15000);

  it('rechecks fills arriving while cancellation is in flight', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a);
    f.broker.beforeSend = async p => { if (p.action === 'cancel') { f.broker.beforeSend = undefined; await f.fill(b); } };
    f.broker.calls = [];
    await f.close(a);
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel']);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'B', bracketId(b), 'long')?.state).toBe('filled');
    expect(f.broker.positions.size).toBe(1);
  });

  it('ignores entry_cancelled on a filled bracket so a live position is not erased', async () => {
    const f = fixture(); const a = arm('A'), opposite = arm('A', { side: 'short' });
    await f.place(a); await f.place(opposite); await f.fill(a); await f.fill(opposite);
    await f.close(a);
    await f.post(lifecycle(opposite, 'entry_cancelled'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(opposite), 'short')?.state).toBe('filled');
  }, 15000);

  it('retires the opposite arm in bracket_monitor without a synthetic journal row', async () => {
    const f = fixture(); const a = arm('A', { index: 2 }), opposite = arm('A', { side: 'short' });
    await f.place(a); await f.place(opposite); await f.fill(a); await f.close(a);
    expect(f.database.listRangeTradeEventsByTrade('A', tradeId(opposite)).some(e => e.eventType === 'entry_cancelled')).toBe(false);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(opposite), 'short')?.state).toBe('cancelled');
    // The retired arm's working entry was removed by the instrument cancel — its dispatch
    // row must not linger as acknowledged broker state.
    const oppositeOrder = f.database.listBrokerOrdersByAccount(f.account.id).find(o => o.action === 'sell' && o.bracketId === bracketId(opposite));
    expect(oppositeOrder?.status).toBe('cancelled');
  });

  it('resumes a rejected cancel on close retry and does not rerun completed cleanup', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('rate limited', { status: 429 }) : undefined;
    const close = lifecycle(a, 'trade_closed'); f.broker.calls = []; await f.post(close);
    // The rejected cancel does not excuse the safeguard exit: it still goes out in
    // the same pass, and only the re-arm entries wait for the retry.
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'exit']);
    f.broker.reject = undefined; f.broker.calls = []; await f.post(close);
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'buy']);
    f.broker.calls = []; await f.post(close); expect(f.broker.calls).toEqual([]);
  });

  it('still sends the safeguard exit when the cancel outcome is uncertain, but holds re-arms', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('broker error', { status: 503 }) : undefined;
    f.broker.calls = []; await f.post(lifecycle(a, 'trade_closed'));
    // The uncertain cancel does not excuse the flatten: the exit still goes out.
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'exit']);
    // No fresh orders are placed over unresolved cleanup — B's re-arm waits.
    expect(f.broker.calls.some(p => p.action === 'buy')).toBe(false);
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
    // The unconfirmed cancel never retired B's monitor row.
    expect(f.database.findBracketMonitorEntry(f.account.id, 'B', bracketId(b), 'long')?.state).toBe('armed');
  });

  it('replays an uncertain cancel on recovery instead of staying wedged', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a);
    // The cancel send fails ambiguously (5xx — may or may not have arrived) —
    // the exit still flattens, the re-arm waits, and the op pauses incomplete.
    f.broker.reject = p => p.action === 'cancel' ? new Response('broker error', { status: 503 }) : undefined;
    f.broker.calls = []; await f.post(lifecycle(a, 'trade_closed'));
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'exit']);
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
    // A duplicate cancel is a broker no-op, so recovery replays the uncertain
    // leg rather than leaving the instrument's working orders in limbo.
    f.broker.reject = undefined; f.broker.calls = [];
    await testApp(f.database, f.appOptions).locals.recoverReapplyOperations();
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'buy']);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
    // The uncertain first attempt keeps its own ledger row; the replay is -r1.
    const cancels = f.database.listBrokerOrdersByAccount(f.account.id).filter(o => o.action === 'cancel');
    expect(cancels.map(o => o.status).sort()).toEqual(['acknowledged', 'uncertain']);
    expect(cancels.some(o => o.orderId.endsWith('-r1'))).toBe(true);
  });

  it('retries a failing cancel inside the same operation until the broker accepts', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a);
    // Flatten legs get multiple send passes per run — fail twice, then accept.
    let cancelCalls = 0;
    f.broker.reject = p => p.action === 'cancel' && ++cancelCalls <= 2 ? new Response('broker error', { status: 503 }) : undefined;
    f.broker.calls = [];
    const app = testApp(f.database, { ...f.appOptions, reapplyFlattenMaxSends: 10 });
    const response = await supertest(app).post(`/proxy/${SECRET}`).send(lifecycle(a, 'trade_closed'));
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    // cancel fails twice then lands; the exit and B's re-arm follow in the same run.
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'cancel', 'cancel', 'exit', 'buy']);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
    const cancels = f.database.listBrokerOrdersByAccount(f.account.id).filter(o => o.action === 'cancel');
    expect(cancels.map(o => o.status).sort()).toEqual(['acknowledged', 'uncertain', 'uncertain']);
    expect(cancels.some(o => o.orderId.endsWith('-r2'))).toBe(true);
  });

  it('pauses once the flatten send budget is exhausted', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('broker error', { status: 503 }) : undefined;
    f.broker.calls = [];
    const app = testApp(f.database, { ...f.appOptions, reapplyFlattenMaxSends: 3 });
    const response = await supertest(app).post(`/proxy/${SECRET}`).send(lifecycle(a, 'trade_closed'));
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    // Three cancel passes, then the exit still runs — re-arms stay held.
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'cancel', 'cancel', 'exit']);
    const incomplete = f.database.listIncompleteReapplyOperations();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].reason).toContain('flatten send failed 3 times');
    // B's monitor row was never retired by an unconfirmed cancel.
    expect(f.database.findBracketMonitorEntry(f.account.id, 'B', bracketId(b), 'long')?.state).toBe('armed');
    // A later retry gets a fresh budget and completes the op.
    f.broker.reject = undefined; f.broker.calls = [];
    await testApp(f.database, { ...f.appOptions, reapplyFlattenMaxSends: 3 }).locals.recoverReapplyOperations();
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'buy']);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
  });

  it('supersedes a wedged reapply and runs fresh cleanup on the next close', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), d = arm('D');
    await f.place(a); await f.place(b); await f.place(d); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('broker error', { status: 503 }) : undefined;
    await f.post(lifecycle(a, 'trade_closed'));
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
    f.broker.reject = undefined; f.broker.calls = [];
    // The next close on the instrument must not be blocked by the wedged plan.
    await f.post(lifecycle(d, 'trade_closed'));
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'exit', 'buy']);
    const stale = f.database.listReapplyOperationsForUser(f.user.id)
      .find(o => o.eventId === `A|${tradeId(a)}-trade_closed`);
    expect(stale?.completed).toBe(true);
    expect(stale?.reason).toContain('Superseded');
    // B was still armed, so the fresh plan re-arms it.
    const rearm = f.broker.calls.find(p => p.action === 'buy' && p.extras?.source === 'reapply');
    expect(rearm?.extras?.originalBracketId).toBe(bracketId(b));
  });

  it('carries arms retired by a superseded op into the fresh re-arm plan', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), d = arm('D');
    await f.place(a); await f.place(b); await f.place(d); await f.fill(a);
    // Cancel+exit deliver and retire every armed row, then the re-arm 503s and
    // the op pauses mid-plan — B's monitor row is left cancelled-but-unresolved.
    f.broker.reject = p => p.extras?.source === 'reapply' ? new Response('broker error', { status: 503 }) : undefined;
    await f.post(lifecycle(a, 'trade_closed'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'B', bracketId(b), 'long')?.state).toBe('cancelled');
    f.broker.reject = undefined; f.broker.calls = [];
    await f.post(lifecycle(d, 'trade_closed'));
    const rearm = f.broker.calls.find(p => p.action === 'buy' && p.extras?.source === 'reapply'
      && p.extras?.originalBracketId === bracketId(b));
    expect(rearm, 'B should be carried forward and re-armed').toBeDefined();
    // The new close's own range is never re-armed.
    expect(f.broker.calls.some(p => p.extras?.originalBracketId === bracketId(d))).toBe(false);
  });

  it('resolves an existing bracket after its schedule is disabled without admitting a new bracket', async () => {
    const f = fixture(); const a = arm('A');
    await f.place(a);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: true, runScheduled: true });
    await f.post(lifecycle(a, 'entry_filled'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(a), a.side)?.state).toBe('filled');
    f.broker.calls = [];
    await f.post(lifecycle(a, 'trade_closed'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(a), a.side)?.state).toBe('closed');
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'exit']);
    const newArm = arm('A', { index: 2 });
    await f.post(lifecycle(newArm, 'entry_armed'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(newArm), newArm.side)).toBeUndefined();
  });

  it('records cancellation for an existing disabled route without broker dispatch', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: f.account.id, rangeName: 'A', extensionEnabled: false, traderspostEnabled: false, runScheduled: true });
    f.broker.calls = [];
    await f.post(lifecycle(a, 'entry_cancelled'));
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(a), a.side)?.state).toBe('cancelled');
    expect(f.broker.calls).toEqual([]);
  });

  it('requires explicit webhook success and retains dispatch evidence through Pine lifecycle', async () => {
    const f = fixture({ reapply: false }); const a = arm('A');
    f.broker.reject = () => new Response('ok', { status: 200 });
    await f.place(a);
    expect(f.database.listBrokerOrdersByAccount(f.account.id)[0]?.status).toBe('uncertain');
    await f.post(lifecycle(a, 'entry_filled'));
    expect(f.database.listBrokerOrdersByAccount(f.account.id)[0]).toMatchObject({ status: 'filled', statusSource: 'lifecycle', dispatchStatus: 'uncertain' });
  });

  it('classifies an explicit 200 rejection consistently for reapply', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('{"success":false}', { status: 200 }) : undefined;
    await f.close(a);
    expect(f.database.listIncompleteReapplyOperations()[0]?.steps[0].state).toBe('rejected');
    expect(f.database.listBrokerOrdersByAccount(f.account.id).find(o => o.action === 'cancel')).toMatchObject({ status: 'rejected', dispatchStatus: 'rejected', statusSource: 'dispatch' });
  });

  it('preserves carried arms across consecutive failed recovery generations', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), d = arm('D'), e = arm('E');
    for (const item of [a, b, d, e]) await f.place(item);
    await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' ? new Response('broker error', { status: 503 }) : undefined;
    await f.post(lifecycle(a, 'trade_closed'));
    await f.post(lifecycle(d, 'trade_closed'));
    f.broker.reject = undefined;
    f.broker.calls = [];
    await f.post(lifecycle(e, 'trade_closed'));
    const rearms = f.broker.calls.filter(p => p.extras?.source === 'reapply');
    expect(rearms.map(p => p.extras?.rangeName)).toEqual(['B']);
    expect(f.database.listActiveBracketMonitorEntries(f.account.id).map(a => a.rangeName)).toEqual(['B']);
  });

  it.each([true, false])('preserves earlier uncertain attempts on duplicate fills (side present: %s)', async (withSide) => {
    const f = fixture({ reapply: false }); const a = arm('A');
    await f.place(a);
    const original = f.database.listBrokerOrdersByAccount(f.account.id)[0];
    f.database.updateBrokerOrderStatus(f.account.id, original.orderId, 'uncertain');
    f.database.createBrokerOrder({ accountId: f.account.id, rangeName: a.range, bracketId: bracketId(a),
      orderId: 'resend', action: 'buy', status: 'acknowledged', instrument: a.ticker,
      ...(withSide ? { side: a.side } : {}), occurredAt: new Date().toISOString() });
    await f.post(lifecycle(a, 'entry_filled'));
    await f.post(lifecycle(a, 'entry_filled'));
    const orders = f.database.listBrokerOrdersByAccount(f.account.id);
    expect(orders.find(o => o.orderId === original.orderId)?.status).toBe('uncertain');
    expect(orders.find(o => o.orderId === 'resend')?.status).toBe('filled');
    await f.post(lifecycle(a, 'trade_closed'));
    await f.post(lifecycle(a, 'trade_closed'));
    expect(f.database.listBrokerOrdersByAccount(f.account.id).find(o => o.orderId === original.orderId)?.status).toBe('uncertain');
  });

  it('correlates a Pine fill that arrives before the replacement HTTP response', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a);
    f.broker.afterSend = async p => {
      if (p.extras?.source === 'reapply') { f.broker.afterSend = undefined; await f.fill(b); }
    };
    await f.close(a);
    expect(f.database.listActiveBracketMonitorEntries(f.account.id).filter(a => a.rangeName === 'B').map(a => a.state)).toEqual(['filled']);
  });

  it('ledgers a later close on the original bracket when no replacement monitor was bound', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    await f.place(a); await f.place(b); await f.fill(a);
    f.broker.afterSend = async p => {
      if (p.extras?.source === 'reapply') { f.broker.afterSend = undefined; await f.fill(b); }
    };
    await f.close(a);
    // The fill landed while the re-arm was in flight: the alias exists but no
    // replacement monitor row was created, so Pine's close resolves the original
    // row — and the ledger must transition that same row, not the replacement's.
    await f.close(b);
    const original = f.database.listBrokerOrdersByAccount(f.account.id)
      .find((o) => o.bracketId === bracketId(b) && o.action === 'buy');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'B', bracketId(b), 'long')?.state).toBe('closed');
    expect(original?.status).toBe('closed');
  });

  it('preserves the original Pine identity through reapply and fill', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B');
    for (const order of [a, b]) await f.place(order);
    await f.fill(a); await f.close(a); await f.fill(b);
    expect(f.database.listActiveBracketMonitorEntries(f.account.id).filter(a => a.rangeName === 'B').map(a => a.state)).toEqual(['filled']);
    await f.close(b);
    expect(f.database.listActiveBracketMonitorEntries(f.account.id)).toEqual([]);
  }, 15000);

  it('preserves the original Pine identity through two replacement generations', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), c = arm('C');
    for (const order of [a, b, c]) await f.place(order);
    await f.fill(a); await f.close(a); await f.fill(c); await f.close(c); await f.fill(b);
    expect(f.database.listActiveBracketMonitorEntries(f.account.id).filter(a => a.rangeName === 'B').map(a => a.state)).toEqual(['filled']);
    await f.close(b);
    expect(f.database.listActiveBracketMonitorEntries(f.account.id)).toEqual([]);
  }, 15000);

  it('does not resend a re-arm entry for an arm Pine cancelled while the reapply was paused', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), c = arm('C');
    await f.place(a); await f.place(b); await f.place(c); await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' && p.extras.rangeName === 'C' ? new Response('rejected', { status: 400 }) : undefined;
    await f.close(a);
    const op = f.database.listIncompleteReapplyOperations()[0];
    expect(op).toBeTruthy();
    // The monitor row is already 'cancelled' from the reapply retire, so this Pine cancel is
    // ignored by bracket_monitor but still journaled; the retry must not recreate the order.
    await f.post(lifecycle(c, 'entry_cancelled'));
    f.broker.reject = undefined; f.broker.calls = [];
    const res = await supertest(f.app).post(`/admin/reapply-operations/${op.id}/retry`).set('x-admin-key', process.env.ADMIN_API_KEY!);
    expect(res.status).toBe(200);
    expect(f.broker.calls.filter(p => p.extras?.rangeName === 'C')).toEqual([]);
    expect(f.database.listActiveBracketMonitorEntries(f.account.id).filter(e => e.rangeName === 'C')).toEqual([]);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'C', bracketId(c), 'long')?.state).toBe('cancelled');
  }, 15000);

  it('does not resend a re-arm entry for an arm Pine closed while the reapply was paused', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), c = arm('C');
    await f.place(a); await f.place(b); await f.place(c); await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' && p.extras.rangeName === 'C' ? new Response('rejected', { status: 400 }) : undefined;
    await f.close(a);
    const op = f.database.listIncompleteReapplyOperations()[0];
    expect(op).toBeTruthy();
    // The monitor row already carries the reapply retire marker ('cancelled'), so this
    // Pine trade_closed only exists in the journal — the retry must still not re-arm it.
    f.database.createTradeEvent({
      userId: f.user.id,
      accountId: f.account.id,
      rangeName: 'C',
      eventId: `${tradeId(c)}-trade_closed`,
      tradeId: tradeId(c),
      eventType: 'trade_closed',
      instrument: c.ticker,
      side: c.side,
      action: 'exit',
      quantity: 1,
      realizedTicksCents: 100,
      realizedDollarsCents: 100,
      outcome: 'win',
      occurredAt: new Date().toISOString(),
    });
    f.broker.reject = undefined; f.broker.calls = [];
    const res = await supertest(f.app).post(`/admin/reapply-operations/${op.id}/retry`).set('x-admin-key', process.env.ADMIN_API_KEY!);
    expect(res.status).toBe(200);
    expect(f.broker.calls.filter(p => p.extras?.rangeName === 'C')).toEqual([]);
  }, 15000);

  it('pauses when a delivered re-arm resolves mid-flight instead of orphaning the order', async () => {
    const f = fixture(); const a = arm('A'), c = arm('C');
    await f.place(a); await f.place(c); await f.fill(a);
    let injected = false;
    f.broker.beforeSend = async (p) => {
      // Pine cancels C's bracket after the re-arm request was accepted in flight —
      // the order may be live at the broker with no monitor row to reconcile it.
      if (!injected && p.extras?.source === 'reapply' && p.extras.rangeName === 'C') {
        injected = true;
        f.database.createTradeEvent({
          userId: f.user.id,
          accountId: f.account.id,
          rangeName: 'C',
          eventId: `${tradeId(c)}-mid-cancel`,
          tradeId: tradeId(c),
          eventType: 'entry_cancelled',
          instrument: c.ticker,
          side: c.side,
          action: 'cancel',
          quantity: 1,
          occurredAt: new Date().toISOString(),
        });
      }
    };
    await f.close(a);
    expect(injected).toBe(true);
    expect(f.broker.calls.some(p => p.extras?.source === 'reapply' && p.extras.rangeName === 'C')).toBe(true);
    const op = f.database.listIncompleteReapplyOperations()[0];
    expect(op).toBeTruthy();
    expect(op.completed).toBe(false);
    expect(op.reason).toContain('resolved while the request was in flight');
    const step = op.steps.find(s => s.kind === 'entry' && s.arm?.rangeName === 'C');
    expect(step?.state).toBe('uncertain');
    expect(f.database.findBracketMonitorEntry(f.account.id, 'C', String(step?.payload.bracketId), 'long')).toBeUndefined();
  }, 15000);

  it('ledgers each resend of a reapply step as its own attempt row', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' ? new Response('rejected', { status: 400 }) : undefined;
    await f.close(a);
    const op = f.database.listIncompleteReapplyOperations()[0];
    const step = op.steps.find(s => s.kind === 'entry')!;
    const baseId = step.brokerOrderId!;
    expect(f.database.findBrokerOrder(f.account.id, baseId)?.status).toBe('rejected');
    f.broker.reject = undefined;
    const res = await supertest(f.app).post(`/admin/reapply-operations/${op.id}/retry`).set('x-admin-key', process.env.ADMIN_API_KEY!);
    expect(res.status).toBe(200);
    // The first attempt keeps its rejection history; the resend ledgers a fresh row.
    expect(f.database.findBrokerOrder(f.account.id, baseId)?.status).toBe('rejected');
    const resend = f.database.findBrokerOrder(f.account.id, `${baseId}-r1`);
    expect(resend?.status).toBe('acknowledged');
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
  }, 15000);

  it('does not dispatch a reapply resend whose delivery was suppressed while queued', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' ? new Response('rejected', { status: 400 }) : undefined;
    await f.close(a);
    const op = f.database.listIncompleteReapplyOperations()[0];
    const step = op.steps.find(s => s.kind === 'entry')!;
    // Simulate the flatten sweep retiring the delivery between rejection and retry.
    f.database.updateProxyDeliveryStatus(step.deliveryId!, 'suppressed_safeguard');
    f.broker.reject = undefined; f.broker.calls = [];
    const res = await supertest(f.app).post(`/admin/reapply-operations/${op.id}/retry`).set('x-admin-key', process.env.ADMIN_API_KEY!);
    // The resend was suppressed, so the operation stays paused — but nothing may dispatch.
    expect(res.status).toBe(409);
    expect(f.broker.calls).toEqual([]);
  }, 15000);

  it('marks an in-flight reapply entry as uncertain rather than rejected in the ledger', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.afterSend = async p => { if (p.extras?.source === 'reapply') throw new Error('connection lost after broker accepted entry'); };
    await f.close(a);
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
    const order = f.database.listBrokerOrdersByAccount(f.account.id).find(o => o.action === 'buy');
    expect(order?.status).toBe('uncertain');
  }, 15000);

  it('records a broker order row for ordinary entries with the mapped instrument and quantity', async () => {
    const f = fixture({ micros: true });
    await f.place(arm('NQ', { ticker: 'NQ1!' }));
    const order = f.database.listBrokerOrdersByAccount(f.account.id).find(o => o.action === 'buy');
    expect(order?.instrument).toBe('MNQ1!');
    expect(order?.quantity).toBe(10);
    expect(order?.status).toBe('acknowledged');
  });

  it('recovers only the rejected tail after reconstructing the app', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'), c = arm('C');
    for (const order of [a, b, c]) await f.place(order);
    await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' && p.extras.rangeName === 'C' ? new Response('rate limited', { status: 429 }) : undefined;
    await f.close(a);
    const firstReplacement = [...f.broker.pending.values()].find(p => p.extras?.rangeName === 'B')?.bracketId;
    const restarted = testApp(f.database, f.appOptions);
    f.broker.reject = undefined; f.broker.calls = [];
    await restarted.locals.recoverReapplyOperations();
    expect(f.broker.calls.map(p => [p.action, p.extras?.rangeName])).toEqual([['buy', 'C']]);
    expect([...f.broker.pending.values()].find(p => p.extras?.rangeName === 'B')?.bracketId).toBe(firstReplacement);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
    f.broker.calls = []; await restarted.locals.recoverReapplyOperations(); expect(f.broker.calls).toEqual([]);
  }, 15000);

  it('does not blindly replay a request accepted before its response was lost', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.afterSend = async p => { if (p.extras?.source === 'reapply') throw new Error('connection lost after broker accepted entry'); };
    await f.close(a);
    const ids = [...f.broker.pending.keys()]; expect(ids).toHaveLength(1);
    f.broker.afterSend = undefined; f.broker.calls = [];
    const restarted = testApp(f.database, f.appOptions); await restarted.locals.recoverReapplyOperations();
    expect(f.broker.calls).toEqual([]);
    expect([...f.broker.pending.keys()]).toEqual(ids);
    expect(f.database.listIncompleteReapplyOperations()[0]?.steps.at(-1)?.state).toBe('uncertain');
  });

  it('uses a persisted successful attempt if completion bookkeeping was interrupted', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    const save = f.database.saveReapplyOperation.bind(f.database);
    let interrupted = false;
    vi.spyOn(f.database, 'saveReapplyOperation').mockImplementation(op => {
      if (!interrupted && op.steps.some(step => step.kind === 'entry' && step.state === 'delivered')) { interrupted = true; throw new Error('simulated crash before step completion'); }
      save(op);
    });
    const response = await supertest(f.app).post(`/proxy/${SECRET}`).send(lifecycle(a, 'trade_closed'));
    expect(response.status).toBe(202);
    expect(response.body.warning).toContain('simulated crash before step completion');
    vi.mocked(f.database.saveReapplyOperation).mockRestore();
    f.broker.calls = [];
    await testApp(f.database, f.appOptions).locals.recoverReapplyOperations();
    expect(f.broker.calls).toEqual([]);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
    expect([...f.broker.pending.values()].some(p => p.extras?.rangeName === 'B')).toBe(true);
  });

  it('recreates a missing ledger row when recovery finds an already-delivered step', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    const save = f.database.saveReapplyOperation.bind(f.database);
    let interrupted = false;
    vi.spyOn(f.database, 'saveReapplyOperation').mockImplementation(op => {
      if (!interrupted && op.steps.some(step => step.kind === 'entry' && step.state === 'delivered')) { interrupted = true; throw new Error('simulated crash before step completion'); }
      save(op);
    });
    await supertest(f.app).post(`/proxy/${SECRET}`).send(lifecycle(a, 'trade_closed'));
    vi.mocked(f.database.saveReapplyOperation).mockRestore();
    const op = f.database.listIncompleteReapplyOperations()[0];
    const entryStep = op.steps.find(step => step.kind === 'entry')!;
    // Simulate an operation written before the broker-order row existed.
    (f.database as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
      .db.prepare('DELETE FROM broker_orders WHERE order_id = ?').run(entryStep.brokerOrderId);
    expect(f.database.findBrokerOrder(f.account.id, entryStep.brokerOrderId!)).toBeUndefined();
    await testApp(f.database, f.appOptions).locals.recoverReapplyOperations();
    expect(f.database.findBrokerOrder(f.account.id, entryStep.brokerOrderId!)?.status).toBe('acknowledged');
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
  });

  it('stops recovery if a destination is disabled or the plan is stale', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('rate limited', { status: 429 }) : undefined;
    await f.close(a); f.broker.reject = undefined; f.broker.calls = []; f.configure(false);
    await testApp(f.database, f.appOptions).locals.recoverReapplyOperations(); expect(f.broker.calls).toEqual([]);
    f.configure(true);
    const op = f.database.listIncompleteReapplyOperations()[0]; op.createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); f.database.saveReapplyOperation(op);
    await testApp(f.database, f.appOptions).locals.recoverReapplyOperations(); expect(f.broker.calls).toEqual([]);
  });

  it('recovers from a reopened SQLite file without replaying delivered cancel/exit steps', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'reapply-test-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'test.sqlite');
    const f = fixture({ filename }); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' ? new Response('rate limited', { status: 429 }) : undefined;
    await f.close(a);
    f.app.locals.dispose(); f.database.close();
    const reopened = new Database(filename);
    const restarted = testApp(reopened, f.appOptions);
    f.broker.calls = []; f.broker.reject = undefined;
    await restarted.locals.recoverReapplyOperations();
    expect(f.broker.calls.map(p => p.action)).toEqual(['buy']);
    expect(reopened.listIncompleteReapplyOperations()).toEqual([]);
  });

  it('atomically records the close and its recovery obligation', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    vi.spyOn(f.database, 'saveReapplyOperation').mockImplementationOnce(() => { throw new Error('cannot persist operation'); });
    await f.post(lifecycle(a, 'trade_closed'));
    expect(f.database.listRangeTradeEventsByTrade('A', tradeId(a)).some(e => e.eventType === 'trade_closed')).toBe(false);
    expect(f.database.findBracketMonitorEntry(f.account.id, 'A', bracketId(a), a.side)?.state).toBe('filled');
    vi.mocked(f.database.saveReapplyOperation).mockRestore();
    await f.close(a); expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
  });

  it('does not report completion if a separate replacement TP was rejected', async () => {
    const f = fixture({ exactTp: true }); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' && p.extras.preciseTakeProfitAfterFill ? new Response('TP rejected', { status: 400 }) : undefined;
    await f.close(a);
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
    f.broker.calls = []; await testApp(f.database, f.appOptions).locals.recoverReapplyOperations();
    expect(f.broker.calls).toEqual([]);
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
  }, 15000);

  it('invalidates paused reapply after another instrument-wide cancel', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.extras?.source === 'reapply' ? new Response('rate limited', { status: 429 }) : undefined;
    await f.close(a); f.broker.reject = undefined;
    await f.post({ ticker: a.ticker, action: 'cancel', bracketId: bracketId(a), bracketSide: a.side, tradeId: tradeId(a), extras: { rangeName: 'A', reason: 'eod_cancel' } });
    f.broker.calls = []; await testApp(f.database, f.appOptions).locals.recoverReapplyOperations();
    expect(f.broker.calls).toEqual([]);
    expect(f.database.listIncompleteReapplyOperations()[0]?.invalidated).toBeTruthy();
  });

  it('does not let the generic delivery retry bypass an uncertain reapply step', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.afterSend = async p => { if (p.extras?.source === 'reapply') throw new Error('response lost'); };
    await f.close(a); f.broker.afterSend = undefined; f.broker.calls = [];
    const op = f.database.listIncompleteReapplyOperations()[0];
    const response = await supertest(f.app).post(`/admin/proxy-deliveries/${op.steps.at(-1)!.deliveryId}/retry`).set('x-admin-key', process.env.ADMIN_API_KEY!);
    expect(response.status).toBe(409);
    expect(f.broker.calls).toEqual([]);
  });

  it('requires explicit reconciliation confirmation before abandoning a paused operation', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('rate limited', { status: 429 }) : undefined;
    await f.close(a);
    const op = f.database.listIncompleteReapplyOperations()[0];
    const path = `/admin/reapply-operations/${op.id}/abandon`;
    expect((await supertest(f.app).post(path).send({ brokerReconciled: true })).status).toBe(401);
    expect((await supertest(f.app).post(path).set('x-admin-key', process.env.ADMIN_API_KEY!).send({})).status).toBe(400);
    f.broker.calls = [];
    expect((await supertest(f.app).post(path).set('x-admin-key', process.env.ADMIN_API_KEY!).send({ brokerReconciled: true })).status).toBe(200);
    expect(f.broker.calls).toEqual([]);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
    expect(f.database.getArmedBracketsForReapply(f.account.id, a.ticker)).toEqual([]);
  });

  it('does not touch another account or borrow its differently sized source entry', async () => {
    const f = fixture(); const a = arm('A'), b = arm('B'); await f.place(a); await f.place(b);
    const second = f.database.createAccount({ userId: f.user.id, name: 'Other account', startingBalanceCents: 0 });
    const webhook = `${WEBHOOK}-other`; const otherBroker = new BrokerModel(); f.brokers.set(webhook, otherBroker);
    f.database.upsertTradersPostAccountDestination(f.user.id, second.id, webhook, undefined, undefined, true, false, false, '16:30', '16:45', false);
    f.database.upsertRangeRoute({ userId: f.user.id, accountId: second.id, rangeName: 'B', extensionEnabled: false, traderspostEnabled: true, runScheduled: false });
    await f.post({ ...entry(b), quantity: 7 }); await f.post(lifecycle(b, 'entry_armed'));
    const before = [...otherBroker.pending.values()]; expect(before).toHaveLength(1);
    otherBroker.calls = []; await f.fill(a); await f.close(a);
    expect(otherBroker.calls).toEqual([]);
    expect([...otherBroker.pending.values()]).toEqual(before);
    expect([...f.broker.pending.values()].find(p => p.extras?.rangeName === 'B')?.quantity).toBe(1);
  });

  it('still dispatches new entries while the instrument has an unresolved delivery', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.action === 'exit' ? new Response('unknown outcome', { status: 503 }) : undefined;
    await f.close(a); f.broker.calls = []; await f.place(arm('C'));
    expect(f.broker.calls.map(p => `${p.action} ${p.extras?.rangeName}`)).toEqual(['buy C']);
    expect(f.database.listIncompleteReapplyOperations()).toHaveLength(1);
  });

  it('recognizes a durable 429 rejection even if saving the step result was interrupted', async () => {
    const f = fixture(); const a = arm('A'); await f.place(a); await f.place(arm('B')); await f.fill(a);
    f.broker.reject = p => p.action === 'cancel' ? new Response('rate limited', { status: 429 }) : undefined;
    const save = f.database.saveReapplyOperation.bind(f.database);
    vi.spyOn(f.database, 'saveReapplyOperation').mockImplementation(op => {
      if (op.steps[0]?.state === 'rejected') throw new Error('crash after recording HTTP rejection');
      save(op);
    });
    await f.close(a);
    vi.mocked(f.database.saveReapplyOperation).mockRestore();
    f.broker.calls = []; f.broker.reject = undefined;
    await testApp(f.database, f.appOptions).locals.recoverReapplyOperations();
    expect(f.broker.calls.map(p => p.action)).toEqual(['cancel', 'exit', 'buy']);
    expect(f.database.listIncompleteReapplyOperations()).toEqual([]);
  });

  it('reads dispatch provenance, not the flipped effective status, for broker evidence', () => {
    const database = new Database(':memory:');
    cleanup.push(() => database.close());
    const user = database.createUser('evidence@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Evidence', startingBalanceCents: 0 });
    const occurredAt = new Date().toISOString();
    const mkOrder = (bracket: string, status: 'filled' | 'closed' | 'rejected', dispatchStatus?: 'rejected' | 'acknowledged' | 'uncertain') =>
      database.createBrokerOrder({
        accountId: account.id, rangeName: 'A', bracketId: bracket, orderId: `ord-${bracket}`,
        action: 'buy', status, dispatchStatus, instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt,
      });

    // A definitely-rejected send whose effective status was later flipped (a
    // Pine fill, an operator reconcile) still proves nothing reached the broker.
    mkOrder('br-flip', 'filled', 'rejected');
    expect(database.hasAttemptedEntryOrder(account.id, 'A', 'br-flip', 'long')).toBe(false);

    // Acknowledged or uncertain dispatches count even after lifecycle resolves
    // the effective status — the order may still exist at the broker.
    mkOrder('br-ack', 'closed', 'acknowledged');
    expect(database.hasAttemptedEntryOrder(account.id, 'A', 'br-ack', 'long')).toBe(true);
    mkOrder('br-uncertain', 'closed', 'uncertain');
    expect(database.hasAttemptedEntryOrder(account.id, 'A', 'br-uncertain', 'long')).toBe(true);

    // Rows with no dispatch provenance fall back to the effective status.
    mkOrder('br-legacy-filled', 'filled');
    expect(database.hasAttemptedEntryOrder(account.id, 'A', 'br-legacy-filled', 'long')).toBe(true);
    mkOrder('br-legacy-rejected', 'rejected');
    (database as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
      .db.prepare("UPDATE broker_orders SET dispatch_status = NULL WHERE order_id = 'ord-br-legacy-rejected'").run();
    expect(database.hasAttemptedEntryOrder(account.id, 'A', 'br-legacy-rejected', 'long')).toBe(false);
  });

  it('lets a late dispatch response record its outcome without regressing a resolved status', () => {
    const database = new Database(':memory:');
    cleanup.push(() => database.close());
    const user = database.createUser('race@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Race', startingBalanceCents: 0 });
    const occurredAt = new Date().toISOString();
    database.createBrokerOrder({
      accountId: account.id, rangeName: 'A', bracketId: 'br-race', orderId: 'ord-race',
      action: 'buy', status: 'pending', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt,
    });
    const order = () => database.listBrokerOrdersByAccount(account.id)[0];

    // A Pine entry_filled lands while the HTTP request is still in flight.
    database.updateBrokerOrderStatus(account.id, 'ord-race', 'filled', undefined, undefined, 'lifecycle');
    // The late dispatch success arrives — it must not flip the order back open.
    database.updateBrokerOrderStatus(account.id, 'ord-race', 'acknowledged');
    expect(order()).toMatchObject({ status: 'filled', statusSource: 'lifecycle', dispatchStatus: 'acknowledged' });

    // Same protection for an operator-closed row: dispatch_status records the
    // late outcome but the effective state stays resolved.
    database.createBrokerOrder({
      accountId: account.id, rangeName: 'A', bracketId: 'br-op', orderId: 'ord-op',
      action: 'buy', status: 'pending', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt,
    });
    database.updateBrokerOrderStatus(account.id, 'ord-op', 'closed', 'operator flat', undefined, 'operator');
    database.updateBrokerOrderStatus(account.id, 'ord-op', 'acknowledged');
    expect(database.listBrokerOrdersByAccount(account.id).find(o => o.orderId === 'ord-op'))
      .toMatchObject({ status: 'closed', statusSource: 'operator', dispatchStatus: 'acknowledged' });

    // Unresolved rows still take the dispatch outcome normally.
    database.createBrokerOrder({
      accountId: account.id, rangeName: 'A', bracketId: 'br-pend', orderId: 'ord-pend',
      action: 'buy', status: 'pending', instrument: 'MNQ1!', side: 'long', quantity: 1, occurredAt,
    });
    database.updateBrokerOrderStatus(account.id, 'ord-pend', 'acknowledged');
    expect(database.listBrokerOrdersByAccount(account.id).find(o => o.orderId === 'ord-pend'))
      .toMatchObject({ status: 'acknowledged', statusSource: 'dispatch', dispatchStatus: 'acknowledged' });

    // A non-terminal lifecycle write (pending row) does not block dispatch either.
    database.updateBrokerOrderStatus(account.id, 'ord-pend', 'uncertain', undefined, undefined, 'bridge');
    database.updateBrokerOrderStatus(account.id, 'ord-pend', 'rejected', 'definite 4xx');
    expect(database.listBrokerOrdersByAccount(account.id).find(o => o.orderId === 'ord-pend'))
      .toMatchObject({ status: 'rejected', statusSource: 'dispatch', dispatchStatus: 'rejected' });
  });

  it('keeps ranges that share Ultra event/bracket ids as distinct trades on the same account', () => {
    // Ultra mints ids as `ultra-<ver>-<ticker>-<epoch>-<seq>-<side>-arm-<seq>` — no range
    // component — so two ranges on the same instrument/anchor epoch emit identical
    // event_ids and bracket_ids (observed in prod: GOLDEN OPPORTUNITY LITE vs V3X GOLD).
    // The per-account journal and monitor must treat them as distinct events.
    const database = new Database(':memory:');
    cleanup.push(() => database.close());
    const user = database.createUser('collision@example.com');
    const account = database.createAccount({ userId: user.id, name: 'Collision', startingBalanceCents: 0 });
    const bracket = 'ultra-v5.3-MGC1!-1790028000000-22-short-arm-22';
    const trade = `${bracket}-lifecycle-short-0`;
    const mkEvent = (rangeName: string, eventType: 'entry_armed' | 'entry_filled' | 'trade_closed', occurredAt: string) =>
      database.createTradeEvent({
        userId: user.id,
        accountId: account.id,
        rangeName,
        eventId: `${trade}-${eventType}-leg-${eventType === 'trade_closed' ? 1 : 0}`,
        tradeId: trade,
        eventType,
        instrument: 'MGC1!',
        side: 'short',
        action: eventType === 'trade_closed' ? 'exit' : 'sell',
        quantity: 1,
        entryPrice: 4400,
        ...(eventType === 'trade_closed'
          ? { exitPrice: 4410, realizedTicksCents: 100, realizedDollarsCents: 100, outcome: 'win' as const }
          : {}),
        occurredAt,
      });
    const mkOrder = (rangeName: string, orderId: string) =>
      database.createBrokerOrder({
        accountId: account.id, rangeName, bracketId: bracket, orderId,
        action: 'sell', status: 'acknowledged', dispatchStatus: 'acknowledged',
        instrument: 'MGC1!', side: 'short', quantity: 1, occurredAt: '2026-09-22T02:30:00.000Z',
      });

    // Both ranges arm the identical bracket id on the shared account.
    mkOrder('V3X GOLD', 'ord-v3x-sell'); mkOrder('GOLDEN OPPORTUNITY LITE', 'ord-gol-sell');
    expect(mkEvent('V3X GOLD', 'entry_armed', '2026-09-22T02:30:02.000Z').created).toBe(true);
    expect(mkEvent('GOLDEN OPPORTUNITY LITE', 'entry_armed', '2026-09-22T02:30:04.000Z').created).toBe(true);
    expect(database.findBracketMonitorEntry(account.id, 'V3X GOLD', bracket, 'short')?.state).toBe('armed');
    expect(database.findBracketMonitorEntry(account.id, 'GOLDEN OPPORTUNITY LITE', bracket, 'short')?.state).toBe('armed');

    // Both ranges' fills journal independently.
    expect(mkEvent('V3X GOLD', 'entry_filled', '2026-09-22T04:01:13.000Z').created).toBe(true);
    expect(mkEvent('GOLDEN OPPORTUNITY LITE', 'entry_filled', '2026-09-22T04:01:12.000Z').created).toBe(true);
    expect(database.findBracketMonitorEntry(account.id, 'GOLDEN OPPORTUNITY LITE', bracket, 'short')?.state).toBe('filled');

    // V3X GOLD's close resolves only its own monitor and ledger row — the identical
    // bracket_id must not bleed across ranges.
    expect(mkEvent('V3X GOLD', 'trade_closed', '2026-09-22T05:24:00.000Z').created).toBe(true);
    expect(database.findBracketMonitorEntry(account.id, 'V3X GOLD', bracket, 'short')?.state).toBe('closed');
    expect(database.findBracketMonitorEntry(account.id, 'GOLDEN OPPORTUNITY LITE', bracket, 'short')?.state).toBe('filled');
    expect(database.listBrokerOrdersByAccount(account.id).find(o => o.orderId === 'ord-v3x-sell'))
      .toMatchObject({ status: 'closed', statusSource: 'lifecycle' });
    // GOL's row was resolved to 'filled' by its own fill — V3X GOLD's close must not touch it.
    expect(database.listBrokerOrdersByAccount(account.id).find(o => o.orderId === 'ord-gol-sell'))
      .toMatchObject({ status: 'filled', statusSource: 'lifecycle' });

    // GOL's later close with the same event_id is a distinct event, not a duplicate.
    expect(mkEvent('GOLDEN OPPORTUNITY LITE', 'trade_closed', '2026-09-22T05:36:00.000Z').created).toBe(true);
    expect(database.findBracketMonitorEntry(account.id, 'GOLDEN OPPORTUNITY LITE', bracket, 'short')?.state).toBe('closed');
    expect(database.listBrokerOrdersByAccount(account.id).find(o => o.orderId === 'ord-gol-sell'))
      .toMatchObject({ status: 'closed', statusSource: 'lifecycle' });
  });
});
