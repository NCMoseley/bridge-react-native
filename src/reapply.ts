import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database.js';
import type { BracketMonitorEntry, BrokerOrderAction, ProxyDelivery, ProxyDeliveryStatus, RangeRoute } from './types.js';
import { type LifecyclePayload, type TradersPostPayload } from './webhook.js';
import { TradersPostRateLimiter } from './traderspost-rate-limiter.js';
import { isCrossTradeConfigured } from './crosstrade.js';

export interface ReapplyStep {
  kind: 'cancel' | 'exit' | 'entry';
  route: RangeRoute;
  payload: TradersPostPayload;
  deliveryId?: string;
  brokerOrderId?: string;
  state: 'pending' | 'sending' | 'delivered' | 'rejected' | 'uncertain' | 'skipped';
  arm?: BracketMonitorEntry;
}

export interface ReapplyOperation {
  id: string;
  accountId: string;
  eventId: string;
  instrument: string;
  route: RangeRoute;
  payload: LifecyclePayload;
  occurredAt: string;
  createdAt: string;
  destinationKey: string;
  completed: boolean;
  planned: boolean;
  invalidated?: string;
  dismissed?: boolean;
  reason?: string;
  arms: BracketMonitorEntry[];
  steps: ReapplyStep[];
}

type Dependencies = {
  instrument: (accountId: string, ticker: string) => string;
  routeEnabled: (route: RangeRoute, cleanup?: boolean) => boolean;
  forward: (delivery: ProxyDelivery, payload: TradersPostPayload, route: RangeRoute, preflight: () => { allowed: true } | { allowed: false; reason: string; status?: ProxyDeliveryStatus }, brokerOrder?: { orderId: string; occurredAt: string }, taskSignal?: AbortSignal) => Promise<ProxyDelivery>;
  protectionReady: (step: ReapplyStep) => boolean;
  notify: (userId: string, message: string, level?: 'error' | 'warning') => void;
  queueTaskTimeoutMs?: number;
  flattenMaxSends?: number;
  flattenRetryDelayMs?: number;
};

// Flatten legs (cancel/exit) are retried inside the operation rather than
// pausing on the first failure: each pass dispatches a fresh send (ledgered
// -r<n>) because a duplicate flatten is a no-op at the broker. The bound is per
// execute() run — recovery/manual retry get a fresh budget so a capped op can
// still be driven forward by the operator.
const REAPPLY_FLATTEN_MAX_SENDS = 10;
const REAPPLY_FLATTEN_RETRY_DELAY_MS = 2_000;

const flattenRetryDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function onAbort() { done(); }
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class ReapplyCoordinator {
  readonly queue: TradersPostRateLimiter;
  private readonly flattenMaxSends: number;
  private readonly flattenRetryDelayMs: number;

  constructor(private readonly database: Database, private readonly deps: Dependencies) {
    this.queue = new TradersPostRateLimiter(0, deps.queueTaskTimeoutMs);
    this.flattenMaxSends = deps.flattenMaxSends ?? REAPPLY_FLATTEN_MAX_SENDS;
    this.flattenRetryDelayMs = deps.flattenRetryDelayMs ?? REAPPLY_FLATTEN_RETRY_DELAY_MS;
  }

  private destinationKey(accountId: string): string {
    const d = this.database.getTradersPostAccountDestination(accountId);
    return createHash('sha256').update(JSON.stringify([d?.webhookUrl, d?.outboundTicker, d?.outboundTickerMode, d?.useLimitPriceTP, d?.useAlertTP, d?.crossTradeWebhookUrl, d?.crossTradeEnabled])).digest('hex');
  }

  // A `filled` monitor only counts as broker evidence when an entry order was
  // actually dispatched for it. Pine fills are simulated — a bracket whose send
  // never ran (wedged queue, suppressed route) or was rejected holds nothing at
  // the broker and must not block instrument cleanup.
  private hasFilled(accountId: string, instrument: string): boolean {
    return this.database.listActiveBracketMonitorEntries(accountId).some(
      a => a.state === 'filled'
        && this.deps.instrument(accountId, a.instrument) === instrument
        && this.database.hasAttemptedEntryOrder(accountId, a.rangeName, a.bracketId, a.side),
    );
  }

  enqueueClose(payload: LifecyclePayload, route: RangeRoute, occurredAt: string): void {
    // Ultra event ids are not range-unique — two ranges sharing an instrument and
    // anchor epoch emit identical ids — so the stored key is namespaced by range to
    // keep a same-named event on another range from suppressing this close's op.
    const eventId = `${route.rangeName}|${payload.eventId.replace(/[\r\n]/g, '').replace(/'/g, 'r')}`;
    const destination = this.database.getTradersPostAccountDestination(route.accountId);
    if (this.database.findReapplyOperation(route.accountId, eventId) || !this.deps.routeEnabled(route, true) || !destination?.reapplyOnTradeCloseEnabled || isCrossTradeConfigured(destination)) return;
    this.database.saveReapplyOperation({ id: randomUUID(), accountId: route.accountId, eventId, route, payload, occurredAt, createdAt: new Date().toISOString(), instrument: this.deps.instrument(route.accountId, payload.ticker), destinationKey: this.destinationKey(route.accountId), completed: false, planned: false, arms: [], steps: [] });
  }

  async onClose(payload: LifecyclePayload, route: RangeRoute): Promise<void> {
    // An operation runs many sequentially-capped sends — batch-sized bound, and
    // the task signal stops the step loop promptly if the watchdog releases it.
    await this.queue.run(route.accountId, async (taskSignal) => {
      const eventId = `${route.rangeName}|${payload.eventId.replace(/[\r\n]/g, '').replace(/'/g, 'r')}`;
      const operation = this.database.findReapplyOperation(route.accountId, eventId);
      if (operation && !operation.completed) await this.execute(operation, taskSignal);
    }, 10 * 60_000);
  }

  invalidate(accountId: string, ticker: string): void {
    for (const op of this.database.listIncompleteReapplyOperations()) {
      if (op.accountId !== accountId || op.instrument !== this.deps.instrument(accountId, ticker)) continue;
      op.invalidated = 'Another instrument-level cancel or exit changed broker state during this operation';
      this.pause(op, op.invalidated);
    }
  }

  private plan(payload: LifecyclePayload, route: RangeRoute, occurredAt: string, queued: ReapplyOperation): ReapplyOperation | undefined {
    const instrument = this.deps.instrument(route.accountId, payload.ticker);
    const destination = this.database.getTradersPostAccountDestination(route.accountId);
    if (!this.deps.routeEnabled(route, true) || !destination?.reapplyOnTradeCloseEnabled || isCrossTradeConfigured(destination)) return undefined;
    // A newer close obsoletes any older unfinished plan on this instrument: its
    // instrument-wide cancel/exit covers whatever broker state the stale op left,
    // and a wedged plan must never block the next cleanup. Steps that reached the
    // wire keep their ledger state; never-sent steps are retired as skipped.
    const prior = this.database.listIncompleteReapplyOperations();
    const queuedIdx = prior.findIndex(op => op.id === queued.id);
    const staleOps = (queuedIdx === -1 ? prior : prior.slice(0, queuedIdx))
      .filter(op => op.accountId === route.accountId && op.instrument === instrument);
    for (const stale of staleOps) this.supersede(stale, queued.eventId);
    // 1. Skip if another filled bracket is already running on this account/instrument.
    if (this.hasFilled(route.accountId, instrument)) return undefined;
    const armed = this.database.listActiveBracketMonitorEntries(route.accountId).filter(a => a.state === 'armed' && this.deps.instrument(route.accountId, a.instrument) === instrument);
    // Arms a superseded op already retired for its own cancel sweep are cancelled
    // in the monitor but were never resolved by Pine — carry them forward so their
    // ranges get re-armed instead of silently dying with the old plan. Arms whose
    // logical trade already has an armed replacement (the stale op delivered that
    // entry before pausing) are not carried — re-arming them would double the order.
    const hasArmedSibling = (a: BracketMonitorEntry) => armed.some(x =>
      x.rangeName === a.rangeName && x.side === a.side
      && this.database.logicalReapplyTradeId(x) === this.database.logicalReapplyTradeId(a));
    const carried = staleOps.flatMap(stale => stale.arms
      .filter(a => a.rangeName !== stale.route.rangeName)
      .map(a => this.database.findBracketMonitorEntry(route.accountId, a.rangeName, a.bracketId, a.side))
      .filter((a): a is BracketMonitorEntry => a !== undefined
        && !hasArmedSibling(a)
        && !this.armResolved(route.accountId, a)));
    const pool = [...new Map([...carried, ...armed].map(a => [
      JSON.stringify([a.rangeName, a.side, this.database.logicalReapplyTradeId(a)]), a,
    ])).values()];
    const base = { ticker: payload.ticker, time: occurredAt };
    // 2. Cancel all open, unfilled orders for the account and instrument.
    const cancel: TradersPostPayload = { ...base, action: 'cancel', extras: { ...payload.extras, rangeName: route.rangeName, lifecycleCancel: 'trade_closed', reapplyOnTradeClose: true, reason: 'reapply_cancel' } };
    const cancelOrderId = `bridge-reapply-${randomUUID()}`;
    // 3. Exit any open position because no bracket is filled on this account/instrument.
    const exit: TradersPostPayload = { ...base, action: 'exit', orderType: 'market', extras: { ...payload.extras, rangeName: route.rangeName, lifecycleExit: 'trade_closed', reapplyOnTradeClose: true } };
    const exitOrderId = `bridge-reapply-${randomUUID()}`;
    const operation: ReapplyOperation = {
      ...queued, planned: true, arms: pool,
      steps: [
        { kind: 'cancel', route, payload: cancel, brokerOrderId: cancelOrderId, state: 'pending' },
        { kind: 'exit', route, payload: exit, brokerOrderId: exitOrderId, state: 'pending' },
      ],
    };
    // 4. Reapply armed brackets from other ranges, closest to the trade close price first.
    const beacon = payload.exitPrice ?? payload.entryPrice ?? 0;
    const candidates = pool.filter(a => a.rangeName !== route.rangeName).sort((a, b) => Math.abs((a.entryPrice ?? 0) - beacon) - Math.abs((b.entryPrice ?? 0) - beacon));
    let rearmed = 0;
    const missingNames: string[] = [];
    const staleLevels: string[] = [];
    for (const a of candidates) {
      const candidateRoute = this.database.findRangeRoutes(a.rangeName).find(r => r.accountId === route.accountId);
      if (!candidateRoute || !this.deps.routeEnabled(candidateRoute)) continue;
      const source = this.database.getOriginalBracketPayload(a.bracketId, route.accountId, a.side);
      if (!source) {
        missingNames.push(`${a.rangeName} ${a.side}`);
        continue;
      }
      const original = JSON.parse(source) as TradersPostPayload;
      const id = `bridge-reapply-${randomUUID()}`;
      const payload = { ...original, bracketId: id, tradeId: id, time: operation.createdAt, extras: { ...original.extras, rangeName: a.rangeName, source: 'reapply', originalBracketId: a.bracketId, reapplyOnTradeClose: true } };
      // The replayed level is the original entry price — if the market has moved
      // through it since the arm, the broker will reject the stop (a buy stop
      // must sit above the market, a sell stop below). Record the step as
      // skipped so the arm stays cancelled after the cancel sweep instead of
      // dispatching a doomed order and leaving a fake armed replacement.
      const level = typeof original.stopPrice === 'number' ? original.stopPrice
        : typeof original.price === 'number' ? original.price : undefined;
      const stale = original.orderType === 'stop' && level !== undefined && beacon > 0
        && ((original.action === 'buy' && level <= beacon) || (original.action === 'sell' && level >= beacon));
      if (stale) staleLevels.push(`${a.rangeName} ${a.side} @ ${level}`);
      operation.steps.push({ kind: 'entry', route: candidateRoute, arm: a, state: stale ? 'skipped' : 'pending', brokerOrderId: id, payload });
      if (!stale) rearmed += 1;
    }
    if (staleLevels.length > 0) {
      this.deps.notify(route.userId, `Reapply skipped ${staleLevels.length} re-arm(s) on ${instrument} — the market has moved through their stop levels (close ${beacon}): ${staleLevels.join(', ')}`, 'warning');
    }
    if (candidates.length > 0 && rearmed === 0 && staleLevels.length === 0) {
      this.deps.notify(route.userId, `Reapply error: original payloads are missing for all armed candidates on ${instrument} (${missingNames.join(', ')}). Cancel and exit will still be sent, but no rearm.`);
    }
    return operation;
  }

  private guard(op: ReapplyOperation): { allowed: boolean; reason: string } {
    const destination = this.database.getTradersPostAccountDestination(op.accountId);
    let reason = '';
    const stored = this.database.findReapplyOperation(op.accountId, op.eventId);
    if (stored?.invalidated) reason = stored.invalidated;
    else if (stored?.completed) reason = 'Operation was already completed or superseded';
    else if (!destination?.enabled || !destination.reapplyOnTradeCloseEnabled || !this.deps.routeEnabled(op.route, true)) reason = 'Destination or range route is disabled';
    else if (op.destinationKey !== this.destinationKey(op.accountId)) reason = 'Destination configuration changed during reapply';
    else if (Date.now() - Date.parse(op.createdAt) > 15 * 60 * 1000) reason = 'Reapply is more than 15 minutes old; broker reconciliation is required';
    else if (this.hasFilled(op.accountId, op.instrument)) reason = 'A bracket is filled on the destination instrument';
    return { allowed: !reason, reason };
  }

  // A newer close replaces an unfinished plan outright: the fresh op's
  // instrument-wide cancel/exit covers whatever broker state the stale op left.
  // Steps that may have reached the wire keep their ledger truth; pending steps
  // are skipped and their queued deliveries suppressed so nothing lingers.
  private supersede(stale: ReapplyOperation, eventId: string): void {
    for (const step of stale.steps) {
      if (step.state !== 'pending') continue;
      step.state = 'skipped';
      if (step.deliveryId) this.database.updateProxyDeliveryStatus(step.deliveryId, 'suppressed_reapply');
    }
    stale.completed = true;
    stale.reason = `Superseded by newer trade_close ${eventId}; fresh cleanup planned from current state`;
    this.database.saveReapplyOperation(stale);
    this.deps.notify(stale.route.userId, `Reapply for ${stale.instrument} superseded by a newer trade_close — fresh cleanup planned from current state.`, 'warning');
  }

  private pause(op: ReapplyOperation, reason: string): void {
    const stored = this.database.findReapplyOperation(op.accountId, op.eventId);
    if (stored?.completed) {
      // An external path (e.g. cancel-all safeguard) already resolved this operation;
      // keep its terminal state instead of resurrecting an in-flight pause.
      op.completed = true;
      op.reason = stored.reason ?? reason;
      this.database.saveReapplyOperation(op);
      return;
    }
    op.reason = reason;
    this.database.saveReapplyOperation(op);
    this.deps.notify(op.route.userId, `Reapply paused for ${op.instrument}: ${reason}. Inspect broker positions and orders before retrying.`, 'warning');
  }

  // A monitor row is unavailable for re-arming when the logical trade resolved (filled or
  // closed) or was cancelled by anyone other than this bridge's own reapply retire — the
  // retire writes no journal rows, so a journaled entry_cancelled or trade_closed means
  // Pine/EOD resolved it (a cancelled monitor row keeps its state but still journals the close).
  private armResolved(accountId: string, entry: BracketMonitorEntry | undefined): boolean {
    if (!entry) return false;
    if (entry.state === 'filled' || entry.state === 'closed') return true;
    if (entry.state !== 'cancelled') return false;
    const logicalTradeId = this.database.logicalReapplyTradeId(entry);
    return this.database.hasEntryCancellationEvent(accountId, entry.rangeName, logicalTradeId)
      || this.database.hasTradeClosedEvent(accountId, entry.rangeName, logicalTradeId);
  }

  // 'fresh' = dispatched a new broker request this call; 'prior' = reused an
  // already-delivered attempt (recovery/retry re-bind). The distinction matters
  // for entry steps: a resolution racing a fresh dispatch can orphan the order,
  // while a prior delivery resolved later is already reconciled in the journal.
  private async send(op: ReapplyOperation, step: ReapplyStep, taskSignal?: AbortSignal): Promise<'fresh' | 'prior' | false> {
    if (!step.deliveryId) {
      step.deliveryId = this.database.createReapplyDelivery(op, step).id;
    }
    if (!step.brokerOrderId) {
      step.brokerOrderId = `bridge-reapply-${randomUUID()}`;
    }
    const delivery = this.database.findProxyDelivery(step.deliveryId)!;
    const orderId = step.brokerOrderId!;
    const attempts = this.database.listProxyDeliveryAttempts(delivery.id);
    // step.brokerOrderId is the stable logical identity (alias target and the
    // replacement monitor row's bracket id). Each actual resend ledgers a fresh
    // order_id suffixed -r<n>, so status writes must target the newest attempt
    // row rather than the first attempt's historical outcome.
    const latestOrderId = () => this.database.latestBrokerOrderAttempt(op.accountId, orderId)?.orderId ?? orderId;
    if (attempts.some(a => a.success)) {
      if (!this.database.latestBrokerOrderAttempt(op.accountId, orderId)) {
        // Ops persisted before brokerOrderId existed, or that crashed before the ledger
        // insert, reach recovery with a delivered step but no row — create it so the
        // accepted dispatch stays visible rather than silently completing.
        this.database.createBrokerOrder({
          accountId: op.accountId,
          rangeName: step.route.rangeName,
          bracketId: typeof step.payload.bracketId === 'string' ? step.payload.bracketId : undefined,
          orderId,
          action: (step.payload.action ?? 'buy') as BrokerOrderAction,
          status: 'acknowledged',
          instrument: this.deps.instrument(op.accountId, step.payload.ticker),
          side: step.arm?.side,
          quantity: typeof step.payload.quantity === 'number' ? step.payload.quantity : step.arm?.quantity,
          price: typeof step.payload.price === 'number' ? step.payload.price : undefined,
          stopPrice: typeof step.payload.stopPrice === 'number' ? step.payload.stopPrice : undefined,
          proxyDeliveryId: delivery.id,
          occurredAt: op.occurredAt,
        });
      } else {
        this.database.updateBrokerOrderStatus(op.accountId, latestOrderId(), 'acknowledged', undefined, delivery.id);
      }
      if (!this.deps.protectionReady(step)) {
        step.state = 'uncertain';
        this.pause(op, 'Entry was delivered but its separate take profit was not confirmed; reconcile protection without resending the entry');
        return false;
      }
      step.state = 'delivered';
      this.database.saveReapplyOperation(op);
      return 'prior';
    }
    const priorStatus = attempts.at(-1)?.statusCode;
    if (step.state === 'sending' && priorStatus != null && priorStatus >= 400 && priorStatus < 500 && priorStatus !== 408) step.state = 'rejected';
    if (step.state === 'sending' || step.state === 'uncertain') {
      if (step.kind === 'entry') {
        this.database.updateBrokerOrderStatus(op.accountId, latestOrderId(), 'uncertain', `Delivery ${delivery.id} may already have reached TradersPost; it will not be replayed automatically`, delivery.id);
        step.state = 'uncertain';
        this.pause(op, `Delivery ${delivery.id} may already have reached TradersPost; it will not be replayed automatically`);
        return false;
      }
      // Cancel/exit flatten legs are idempotent — a duplicate is a no-op at the
      // broker — so an uncertain or interrupted send is replayed rather than
      // pausing the operation. The resend ledgers a fresh -r<n> broker_orders
      // row, preserving the uncertain attempt's evidence.
    }
    // Flatten legs keep re-dispatching inside the operation until the broker
    // accepts (bounded by flattenMaxSends per execute() run) — an
    // undelivered cancel/exit is what strands orders at the broker. Entries stay
    // single-shot: a duplicated entry could double exposure. Preflight blocks
    // (guard/routing) are not broker failures, so they pause immediately.
    const flatten = step.kind !== 'entry';
    for (let pass = 0; ; pass++) {
      if (taskSignal?.aborted) {
        this.pause(op, `Delivery ${delivery.id} was interrupted when the account queue watchdog released the task; reconcile and retry`);
        return false;
      }
      this.database.transaction(() => {
        step.state = 'sending';
        this.database.saveReapplyOperation(op);
      });
      let result: ProxyDelivery;
      try {
        result = await this.deps.forward(delivery, step.payload, step.route, () => {
          const guard = this.guard(op);
          if (!guard.allowed) return guard;
          if (!this.deps.routeEnabled(step.route, step.kind !== 'entry')) return { allowed: false, reason: 'Replacement route was disabled while queued', status: 'routing_disabled' };
          if (step.arm) {
            const current = this.database.findBracketMonitorEntry(op.accountId, step.arm.rangeName, String(step.payload.bracketId), step.arm.side)
              ?? this.database.findBracketMonitorEntry(op.accountId, step.arm.rangeName, step.arm.bracketId, step.arm.side);
            if (this.armResolved(op.accountId, current)) return { allowed: false, reason: 'Replacement arm changed state while queued', status: 'suppressed_guard' };
          }
          return guard;
        }, { orderId, occurredAt: op.occurredAt }, taskSignal);
      } catch {
        if (taskSignal?.aborted) {
          // Watchdog abort — the queue-level failure path owns the broker ledger.
          this.pause(op, `Delivery ${delivery.id} was in flight when the account queue watchdog released the task; reconcile and retry`);
          return false;
        }
        this.database.updateBrokerOrderStatus(op.accountId, latestOrderId(), 'uncertain', `Delivery ${delivery.id} interrupted with unknown outcome`, delivery.id);
        step.state = 'uncertain';
        this.database.saveReapplyOperation(op);
        if (!flatten || pass + 1 >= this.flattenMaxSends) {
          this.pause(op, `Delivery ${delivery.id} interrupted with unknown outcome`);
          return false;
        }
        await flattenRetryDelay(this.flattenRetryDelayMs, taskSignal);
        continue;
      }
      if (taskSignal?.aborted) {
        // The send resolved (or is still pending) after the outer queue released
        // the account. Leave the step 'sending' — retry reconciles it from the
        // attempt ledger rather than mutating alongside the next account task.
        this.pause(op, `Delivery ${delivery.id} was in flight when the account queue watchdog released the task; reconcile and retry`);
        return false;
      }
      const latest = this.database.listProxyDeliveryAttempts(delivery.id).at(-1);
      if (result.status === 'traderspost_delivered' || result.status === 'extension_draft_created_and_traderspost_delivered') {
        this.database.updateBrokerOrderStatus(op.accountId, latestOrderId(), 'acknowledged', undefined, delivery.id);
        if (!this.deps.protectionReady(step)) {
          step.state = 'uncertain';
          this.pause(op, 'Entry was delivered but its separate take profit failed; reconcile protection before continuing');
          return false;
        }
        step.state = 'delivered';
        this.database.saveReapplyOperation(op);
        return 'fresh';
      }
      const errorText = latest?.errorText ?? `Delivery ${delivery.id} did not succeed`;
      const rejected = this.database.latestBrokerOrderAttempt(op.accountId, orderId)?.dispatchStatus === 'rejected' || result.status === 'routing_disabled' || result.status.startsWith('suppressed_') || (latest?.statusCode != null && latest.statusCode >= 400 && latest.statusCode < 500 && latest.statusCode !== 408);
      this.database.updateBrokerOrderStatus(op.accountId, latestOrderId(), rejected ? 'rejected' : 'uncertain', errorText, delivery.id);
      step.state = rejected ? 'rejected' : 'uncertain';
      this.database.saveReapplyOperation(op);
      const preflightBlocked = result.status === 'routing_disabled' || result.status.startsWith('suppressed_');
      if (!flatten || preflightBlocked || pass + 1 >= this.flattenMaxSends) {
        this.pause(op, flatten && !preflightBlocked && pass + 1 >= this.flattenMaxSends
          ? `${errorText} (flatten send failed ${pass + 1} times this run)` : errorText);
        return false;
      }
      await flattenRetryDelay(this.flattenRetryDelayMs, taskSignal);
    }
  }

  private async execute(op: ReapplyOperation, taskSignal?: AbortSignal): Promise<void> {
    const initialGuard = this.guard(op);
    if (!op.planned && this.hasFilled(op.accountId, op.instrument)) {
      op.completed = true;
      op.reason = 'Skipped: another bracket is filled on the destination instrument';
      this.database.saveReapplyOperation(op);
      return;
    }
    if (!initialGuard.allowed) { this.pause(op, initialGuard.reason); return; }
    if (!op.planned) {
      const planned = this.database.transaction(() => {
        const next = this.plan(op.payload, op.route, op.occurredAt, op);
        if (next) this.database.saveReapplyOperation(next);
        return next;
      });
      if (!planned) {
        op.completed = true;
        op.reason = 'Skipped: no safe reapply plan';
        this.database.saveReapplyOperation(op);
        return;
      }
      op = planned;
      this.database.saveReapplyOperation(op);
    }
    // Flatten legs are always attempted: an uncertain or rejected cancel does not
    // excuse skipping the exit that flattens a possibly-live position. Only entry
    // steps wait — placing fresh orders over unresolved cleanup could compound
    // exposure. A failed entry still halts the remaining re-arms.
    let flattenUnresolved = false;
    for (const step of op.steps) {
      if (taskSignal?.aborted) {
        this.pause(op, 'Operation interrupted: account queue watchdog released the task; reconcile and retry');
        return;
      }
      if (step.state === 'skipped') continue;
      if (step.kind === 'entry') {
        if (flattenUnresolved) continue;
        const a = step.arm!;
        const current = this.database.findBracketMonitorEntry(op.accountId, a.rangeName, String(step.payload.bracketId), a.side)
          ?? this.database.findBracketMonitorEntry(op.accountId, a.rangeName, a.bracketId, a.side);
        if (step.state !== 'delivered' && (this.armResolved(op.accountId, current) || !this.deps.routeEnabled(step.route))) {
          step.state = 'skipped'; this.database.saveReapplyOperation(op); continue;
        }
      }
      let freshDispatch = false;
      if (step.state !== 'delivered') {
        const guard = this.guard(op);
        if (!guard.allowed) { this.pause(op, guard.reason); return; }
        const sent = await this.send(op, step, taskSignal);
        if (!sent) {
          if (step.kind === 'entry') return;
          flattenUnresolved = true;
          continue;
        }
        freshDispatch = sent === 'fresh';
      }
      if (step.kind === 'cancel') {
        // Mark every armed bracket (closing range + reapply candidates) as cancelled in bracket_monitor only.
        for (const a of op.arms) this.database.retireReapplyArm(a, op.occurredAt);
      }
      if (step.kind === 'entry') {
        const bound = this.database.bindReappliedArm(step.arm!, String(step.payload.bracketId), op.occurredAt, true);
        if (bound === 'resolved' && freshDispatch) {
          // The entry was accepted at the broker but the bracket resolved while
          // the request was in flight — the replacement order may be live with
          // no monitor row or future lifecycle event to reconcile it. Pause for
          // reconciliation rather than completing the operation silently.
          step.state = 'uncertain';
          this.pause(op, `Re-arm for ${step.arm!.rangeName} was delivered but the bracket resolved while the request was in flight; reconcile the possibly-live replacement order before retrying`);
          return;
        }
      }
    }
    if (flattenUnresolved) return; // send() already paused the op on the failing step
    const stored = this.database.findReapplyOperation(op.accountId, op.eventId);
    op.completed = true;
    op.reason = stored?.completed && stored.reason ? stored.reason : undefined;
    this.database.saveReapplyOperation(op);
  }

  async abandon(operation: ReapplyOperation): Promise<void> {
    await this.queue.run(operation.accountId, async () => {
      const op = this.database.findReapplyOperation(operation.accountId, operation.eventId);
      if (!op || op.completed) return;
      this.database.transaction(() => {
        for (const arm of op.arms) {
          const logicalTradeId = this.database.logicalReapplyTradeId(arm);
          const active = this.database.listActiveBracketMonitorEntries(op.accountId).find(a => this.database.logicalReapplyTradeId(a) === logicalTradeId);
          if (active?.state === 'filled') continue;
          this.database.retireReapplyArm(arm, new Date().toISOString());
        }
        for (const step of op.steps) {
          if (step.kind !== 'entry' || !step.arm) continue;
          const current = this.database.findBracketMonitorEntry(op.accountId, step.arm.rangeName, String(step.payload.bracketId), step.arm.side);
          if (current?.state === 'armed') this.database.retireReapplyArm(current, new Date().toISOString());
        }
        op.completed = true;
        op.reason = 'Abandoned after explicit operator confirmation of broker reconciliation';
        this.database.saveReapplyOperation(op);
        this.database.createBridgeLog(op.route.userId, 'reapply', { operationId: op.id, message: op.reason });
      });
    });
  }

  async recover(): Promise<void> {
    const swept = this.database.sweepInterruptedTradersPostDispatches();
    if (swept.deliveries > 0 || swept.orders > 0) {
      console.warn('[recovery] Resolved dispatches interrupted by restart', swept);
    }
    for (const op of this.database.listIncompleteReapplyOperations()) {
      try {
        await this.queue.run(op.accountId, async (taskSignal) => {
          const current = this.database.findReapplyOperation(op.accountId, op.eventId);
          if (current && !current.completed) await this.execute(current, taskSignal);
        }, 10 * 60_000);
      } catch (err) {
        // A failed or never-settling recovery task must not abort startup — the
        // operation stays incomplete (instrument stays blocked) for operator retry.
        console.warn('[recovery] Reapply operation recovery failed; left for operator retry', {
          accountId: op.accountId,
          eventId: op.eventId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
