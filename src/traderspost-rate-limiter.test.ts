import { describe, it, expect } from 'vitest';
import { TradersPostRateLimiter } from './traderspost-rate-limiter.js';

describe('TradersPostRateLimiter', () => {
  it('runs calls sequentially for the same account', async () => {
    const limiter = new TradersPostRateLimiter(0);
    const calls: string[] = [];
    const p1 = limiter.run('acct-1', async () => { calls.push('first'); return 'a'; });
    const p2 = limiter.run('acct-1', async () => { calls.push('second'); return 'b'; });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('a');
    expect(r2).toBe('b');
    expect(calls).toEqual(['first', 'second']);
  });

  it('enforces a minimum interval between calls for the same account', async () => {
    const minInterval = 50;
    const limiter = new TradersPostRateLimiter(minInterval);
    const start = Date.now();
    await limiter.run('acct-1', async () => 'a');
    await limiter.run('acct-1', async () => 'b');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(minInterval);
  });

  it('does not serialize calls across accounts', async () => {
    const limiter = new TradersPostRateLimiter(100);
    const start = Date.now();
    const p1 = limiter.run('acct-1', async () => { await new Promise((r) => setTimeout(r, 30)); return 'a'; });
    const p2 = limiter.run('acct-2', async () => 'b');
    const [r1, r2] = await Promise.all([p1, p2]);
    const elapsed = Date.now() - start;
    expect(r1).toBe('a');
    expect(r2).toBe('b');
    expect(elapsed).toBeLessThan(60);
  });

  it('continues processing after a rejected call', async () => {
    const limiter = new TradersPostRateLimiter(0);
    const p1 = limiter.run('acct-1', async () => { throw new Error('boom'); });
    const p2 = limiter.run('acct-1', async () => 'ok');
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('releases the account queue when a task never settles', async () => {
    const limiter = new TradersPostRateLimiter(0, 40);
    const hung = limiter.run('acct-1', () => new Promise<string>(() => {}));
    const next = limiter.run('acct-1', async () => 'ok');
    await expect(hung).rejects.toThrow('exceeded');
    await expect(next).resolves.toBe('ok');
  });

  it('aborts the task signal on watchdog so looping tasks stop promptly', async () => {
    const limiter = new TradersPostRateLimiter(0, 40);
    let observed: AbortSignal | undefined;
    const hung = limiter.run('acct-1', (signal) => {
      observed = signal;
      return new Promise<string>(() => {});
    });
    await expect(hung).rejects.toThrow('exceeded');
    expect(observed?.aborted).toBe(true);
  });

  it('honors a per-call timeout override for batch tasks', async () => {
    const limiter = new TradersPostRateLimiter(0, 40);
    const quick = limiter.run('acct-1', () => new Promise<string>((r) => setTimeout(() => r('ok'), 80)), 200);
    await expect(quick).resolves.toBe('ok');
  });

  it('runs a reserved follow-up before already queued account work', async () => {
    const limiter = new TradersPostRateLimiter(0);
    const calls: string[] = [];
    let releaseFirst = () => {};
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = () => {};
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = limiter.run('acct-1', async () => {
      calls.push('first');
      firstStarted();
      await firstMayFinish;
    });
    await firstDidStart;
    const queued = limiter.run('acct-1', async () => {
      calls.push('queued');
    });
    const followUp = limiter.runNext('acct-1', async () => {
      calls.push('follow-up');
    });
    releaseFirst();

    await Promise.all([first, queued, followUp]);
    expect(calls).toEqual(['first', 'follow-up', 'queued']);
  });
});
