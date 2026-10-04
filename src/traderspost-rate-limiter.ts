type QueueOutcome = 'success' | 'failure' | 'neutral';
type QueueEntry<T> = {
  fn: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timeoutMs: number;
  controller: AbortController;
  // Resolved tasks aren't automatically successes for the circuit breaker —
  // the send path catches broker failures and returns a failed result, so
  // the caller reports the real outcome. 'neutral' (suppressed/blocked sends)
  // neither trips nor resets the breaker.
  outcome?: (value: T) => QueueOutcome;
};

export class TradersPostRateLimiter {
  private readonly intervals = new Map<string, number>();
  private readonly pending = new Map<string, QueueEntry<unknown>[]>();
  private readonly running = new Set<string>();
  private readonly stats = new Map<string, { tasksRun: number; totalTaskMs: number; lastTaskMs: number }>();
  private readonly failures = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();

  // Per-lane circuit breaker: after `failureThreshold` consecutive task
  // failures the lane backs off exponentially (`failureBackoffBaseMs`,
  // doubling to `failureBackoffMaxMs`) until a task succeeds. A dead or
  // rejecting destination can't spin retries back-to-back — and since lanes
  // are per-key, its cooldown never stalls other accounts.
  constructor(
    private readonly minIntervalMs = 250,
    private readonly taskTimeoutMs = 60_000,
    private readonly failureThreshold = 3,
    private readonly failureBackoffBaseMs = 2_000,
    // Must stay below the enclosing queue watchdog (default 60s) minus send
    // time — a cooldown at/above the watchdog means the next task is killed
    // before it can succeed, and the lane can never reset its own breaker.
    private readonly failureBackoffMaxMs = 25_000,
  ) {}

  run<T>(accountId: string, fn: (signal: AbortSignal) => Promise<T>, timeoutMs = this.taskTimeoutMs, outcome?: (value: T) => QueueOutcome): Promise<T> {
    return this.enqueue(accountId, fn, false, timeoutMs, outcome);
  }

  runNext<T>(accountId: string, fn: (signal: AbortSignal) => Promise<T>, timeoutMs = this.taskTimeoutMs, outcome?: (value: T) => QueueOutcome): Promise<T> {
    return this.enqueue(accountId, fn, true, timeoutMs, outcome);
  }

  // Per-account queue telemetry for the Monitoring dispatch card.
  snapshot(): Array<{ accountId: string; pending: number; running: boolean; tasksRun: number; avgTaskMs: number | null; lastTaskMs: number | null; failures: number; cooldownUntilMs: number | null }> {
    const keys = new Set([...this.pending.keys(), ...this.running, ...this.stats.keys(), ...this.cooldownUntil.keys()]);
    return [...keys].map((accountId) => {
      const s = this.stats.get(accountId);
      return {
        accountId,
        pending: this.pending.get(accountId)?.length ?? 0,
        running: this.running.has(accountId),
        tasksRun: s?.tasksRun ?? 0,
        avgTaskMs: s && s.tasksRun > 0 ? Math.round(s.totalTaskMs / s.tasksRun) : null,
        lastTaskMs: s?.lastTaskMs ?? null,
        failures: this.failures.get(accountId) ?? 0,
        cooldownUntilMs: this.cooldownUntil.get(accountId) ?? null,
      };
    }).filter((row) => row.pending > 0 || row.running || row.tasksRun > 0 || row.failures > 0);
  }

  // Lane-level breaker state for monitoring — cooldown expiry and the
  // consecutive-failure count that put it there.
  breakerState(accountId: string): { failures: number; cooldownUntilMs: number | null } {
    return {
      failures: this.failures.get(accountId) ?? 0,
      cooldownUntilMs: this.cooldownUntil.get(accountId) ?? null,
    };
  }

  private enqueue<T>(accountId: string, fn: (signal: AbortSignal) => Promise<T>, next: boolean, timeoutMs: number, outcome?: (value: T) => QueueOutcome): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.pending.get(accountId) ?? [];
      this.pending.set(accountId, queue);
      const entry = { fn, resolve, reject, timeoutMs, controller: new AbortController(), outcome } as QueueEntry<unknown>;
      if (next) queue.unshift(entry);
      else queue.push(entry);
      this.processQueue(accountId);
    });
  }

  private recordFailure(accountId: string): void {
    const failures = (this.failures.get(accountId) ?? 0) + 1;
    this.failures.set(accountId, failures);
    if (failures >= this.failureThreshold) {
      const backoff = Math.min(
        this.failureBackoffBaseMs * 2 ** (failures - this.failureThreshold),
        this.failureBackoffMaxMs,
      );
      this.cooldownUntil.set(accountId, Date.now() + backoff);
    }
  }

  private async processQueue(accountId: string): Promise<void> {
    if (this.running.has(accountId)) return;
    const queue = this.pending.get(accountId);
    if (!queue || queue.length === 0) return;

    this.running.add(accountId);
    const entry = queue.shift()!;

    const last = this.intervals.get(accountId) ?? 0;
    const cooldown = this.cooldownUntil.get(accountId) ?? 0;
    const wait = Math.max(0, Math.max(last + this.minIntervalMs, cooldown) - Date.now());
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    try {
      const result = await Promise.race([
        entry.fn(entry.controller.signal),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => {
              entry.controller.abort();
              reject(new Error(`Queued task exceeded ${entry.timeoutMs}ms and was released`));
            },
            entry.timeoutMs,
          );
        }),
      ]);
      this.intervals.set(accountId, Date.now());
      let kind: QueueOutcome = 'success';
      try {
        kind = entry.outcome ? entry.outcome(result) : 'success';
      } catch {
        kind = 'neutral';
      }
      if (kind === 'success') {
        this.failures.delete(accountId);
        this.cooldownUntil.delete(accountId);
      } else if (kind === 'failure') {
        this.recordFailure(accountId);
      }
      entry.resolve(result);
    } catch (err) {
      this.intervals.set(accountId, Date.now());
      this.recordFailure(accountId);
      entry.reject(err);
    } finally {
      clearTimeout(watchdog);
      const s = this.stats.get(accountId) ?? { tasksRun: 0, totalTaskMs: 0, lastTaskMs: 0 };
      s.tasksRun += 1;
      s.lastTaskMs = Date.now() - startedAt;
      s.totalTaskMs += s.lastTaskMs;
      this.stats.set(accountId, s);
      this.running.delete(accountId);
      this.processQueue(accountId);
    }
  }
}
