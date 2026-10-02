// Process-run forensics helpers. `index.ts` reports stale `process_runs` rows
// (no ended_at, dead heartbeat) as abnormal exits on boot.

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but we may not signal it — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// A stale run whose pid is still alive on this host is a concurrent process
// (dev watcher, draining old deploy), not a corpse — skip it. A pid equal to
// ours is reuse (e.g. PID 1 after a container restart), not a live concurrent
// process — that stale row is exactly what the forensics should report.
export function isConcurrentProcessRun(runPid: number, currentPid: number = process.pid): boolean {
  return runPid !== currentPid && pidAlive(runPid);
}
