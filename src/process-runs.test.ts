import { describe, expect, it } from 'vitest';
import { isConcurrentProcessRun, pidAlive } from './process-runs.js';

describe('process-run forensics', () => {
  it('treats a live pid owned by another process as concurrent', () => {
    // PID 1 (or the init/system pid) is alive on every host and is not this process.
    expect(isConcurrentProcessRun(1, process.pid)).toBe(process.pid !== 1);
  });

  it('treats a stale row carrying our own pid as reuse, not concurrency', () => {
    // PID reuse after a container restart: the old row's pid is alive because it
    // is this process — it must still be reported as an abnormal exit.
    expect(isConcurrentProcessRun(process.pid)).toBe(false);
  });

  it('treats a dead pid as a corpse worth reporting', () => {
    // Find a pid nobody owns.
    let dead = 2 ** 22;
    while (pidAlive(dead)) dead += 1;
    expect(isConcurrentProcessRun(dead)).toBe(false);
  });
});
