type QueueEntry<T> = {
  fn: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timeoutMs: number;
  controller: AbortController;
};

export class TradersPostRateLimiter {
  private readonly intervals = new Map<string, number>();
  private readonly pending = new Map<string, QueueEntry<unknown>[]>();
  private readonly running = new Set<string>();

  // A task that never settles (e.g. an undici fetch whose abort doesn't take)
  // would otherwise wedge the account's queue forever; release it after a
  // hard cap so later dispatches can proceed. The task's signal is aborted at
  // the same time so looping tasks stop promptly instead of mutating state
  // alongside the next dispatch.
  constructor(
    private readonly minIntervalMs = 250,
    private readonly taskTimeoutMs = 60_000,
  ) {}

  run<T>(accountId: string, fn: (signal: AbortSignal) => Promise<T>, timeoutMs = this.taskTimeoutMs): Promise<T> {
    return this.enqueue(accountId, fn, false, timeoutMs);
  }

  runNext<T>(accountId: string, fn: (signal: AbortSignal) => Promise<T>, timeoutMs = this.taskTimeoutMs): Promise<T> {
    return this.enqueue(accountId, fn, true, timeoutMs);
  }

  private enqueue<T>(accountId: string, fn: (signal: AbortSignal) => Promise<T>, next: boolean, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const queue = this.pending.get(accountId) ?? [];
      this.pending.set(accountId, queue);
      const entry = { fn, resolve, reject, timeoutMs, controller: new AbortController() } as QueueEntry<unknown>;
      if (next) queue.unshift(entry);
      else queue.push(entry);
      this.processQueue(accountId);
    });
  }

  private async processQueue(accountId: string): Promise<void> {
    if (this.running.has(accountId)) return;
    const queue = this.pending.get(accountId);
    if (!queue || queue.length === 0) return;

    this.running.add(accountId);
    const entry = queue.shift()!;

    const last = this.intervals.get(accountId) ?? 0;
    const wait = Math.max(0, last + this.minIntervalMs - Date.now());
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }

    let watchdog: ReturnType<typeof setTimeout> | undefined;
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
      entry.resolve(result);
    } catch (err) {
      this.intervals.set(accountId, Date.now());
      entry.reject(err);
    } finally {
      clearTimeout(watchdog);
      this.running.delete(accountId);
      this.processQueue(accountId);
    }
  }
}
