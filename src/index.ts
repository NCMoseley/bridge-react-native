import { Database } from './database.js';
import { createApp } from './server.js';
import { config } from './config.js';
import { isConcurrentProcessRun } from './process-runs.js';

function logMemory(prefix: string) {
  const usage = process.memoryUsage();
  console.info(JSON.stringify({
    level: 'info',
    event: 'memory',
    prefix,
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
  }));
}

function logFatal(event: string, data: Record<string, unknown>) {
  console.error(JSON.stringify({ level: 'fatal', event, ...data }));
}

const database = new Database();
const processRunId = database.createProcessRun();

// Any earlier run row still marked unclean means that process never reached
// its exit handlers — a kill (OOM, host) rather than a managed shutdown. A row
// whose pid is still alive on this host is a concurrent process (dev watcher,
// draining old deploy), not a corpse — skip it. A pid equal to ours is reuse
// (e.g. PID 1 after a container restart) and must be reported.
for (const run of database.listAbnormalProcessRuns(processRunId)) {
  if (isConcurrentProcessRun(run.pid)) continue;
  logFatal('previousProcessAbnormalExit', {
    startedAt: run.startedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    fatal: run.fatal,
    warnings: run.warnings,
    lastActivity: run.lastActivity,
    context: run.context,
    rssBytes: run.rssBytes,
    heapUsedBytes: run.heapUsedBytes,
    eventLoopLagMs: run.eventLoopLagMs,
    pid: run.pid,
  });
}

let appInstance: ReturnType<typeof createApp> | undefined;

// Last-known-work snapshot for crash forensics. For a managed fatal exit this
// is written as context_json alongside the error; for a hard kill the
// heartbeat's copy in last_activity_json is what survives.
function currentActivity() {
  const ring = (appInstance?.locals?.recentRequests as Array<Record<string, unknown>> | undefined) ?? [];
  const tail = ring.slice(-50);
  const queues = (appInstance?.locals?.dispatchQueueStats?.() as Array<{ pending: number }> | undefined) ?? [];
  return {
    at: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    requestCount: ring.length,
    inFlight: tail.filter((r) => r.statusCode === undefined).length,
    queuedDispatches: queues.reduce((sum, q) => sum + (q.pending ?? 0), 0),
    recentRequests: tail,
  };
}

function persistFatal(fatal: { event: string; name?: string; message?: string; stack?: string }) {
  try {
    database.endProcessRun(processRunId, { clean: false, fatal, context: currentActivity() });
  } catch {
    // The database itself may be the casualty — the stdout log above is the fallback.
  }
}

process.on('uncaughtException', (error) => {
  logMemory('uncaughtException');
  logFatal('uncaughtException', {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  persistFatal({ event: 'uncaughtException', name: error.name, message: error.message, stack: error.stack });
  setTimeout(() => process.exit(1), 250);
});

process.on('unhandledRejection', (reason) => {
  logMemory('unhandledRejection');
  const isError = reason instanceof Error;
  logFatal('unhandledRejection', {
    name: isError ? reason.name : undefined,
    message: isError ? reason.message : String(reason),
    stack: isError ? reason.stack : undefined,
  });
  persistFatal({
    event: 'unhandledRejection',
    name: isError ? reason.name : undefined,
    message: isError ? reason.message : String(reason),
    stack: isError ? reason.stack : undefined,
  });
  setTimeout(() => process.exit(1), 250);
});

process.on('warning', (warning) => {
  console.error(JSON.stringify({
    level: 'warn',
    event: 'processWarning',
    name: warning.name,
    message: warning.message,
    stack: warning.stack,
  }));
  try {
    database.recordProcessWarning(processRunId, {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  } catch {
    // Warnings must never take the process down with them.
  }
});

process.on('exit', (code) => {
  console.error(JSON.stringify({ level: 'fatal', event: 'processExit', exitCode: code }));
  try {
    database.endProcessRun(processRunId, { exitCode: code, clean: code === 0 });
  } catch {
    // Nothing reliable left to do during exit.
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.error(JSON.stringify({ level: 'info', event: 'signalReceived', signal }));
    process.exit(0);
  });
}

logMemory('startup');

const app = createApp(database);
appInstance = app;
if (process.env.NODE_ENV !== 'test') {
  // Boot must not wedge on recovery: a crashed or slow reapply must never keep
  // the listener from accepting webhooks (the wedged-boot crash this guards
  // against). Recovery still shares the per-account queue, and it resumes
  // incomplete operations one at a time — each op is only enqueued after the
  // previous one settles — so a live entry waits behind at most a single
  // recovery op, bounded by that op's watchdog. Priority-queueing a live
  // entry ahead of an in-flight reapply cancel would be unsafe: the entry's
  // own instrument-scoped cancel could kill an order the reapply just sent.
  void app.locals.recoverReapplyOperations().catch((error: unknown) => {
    logFatal('startupRecoveryFailed', { message: error instanceof Error ? error.message : String(error) });
  });
}
app.listen(config.PORT, () => {
  console.info(JSON.stringify({ level: 'info', event: 'serverListening', port: config.PORT }));
});

// Heartbeat doubles as an event-loop lag probe: the interval fires late when
// the loop is blocked, so the drift is recorded alongside memory stats. 15s
// keeps the last-known-work snapshot fresh — for a hard kill (SIGKILL/OOM)
// the heartbeat's copy is the only forensic record that survives.
const HEARTBEAT_MS = Math.max(5_000, Number(process.env.HEARTBEAT_MS) || 15_000);
// Pressure thresholds: warn BEFORE the kill. A hard kill leaves no trace —
// these warnings are the pre-mortem breadcrumb in warnings_json.
const LAG_WARN_MS = Math.max(1_000, Number(process.env.EVENT_LOOP_LAG_WARN_MS) || 5_000);
const HEAP_WARN_RATIO = Math.min(0.99, Number(process.env.HEAP_WARN_RATIO) || 0.9);
const RSS_WARN_BYTES = Math.max(64 * 1024 * 1024, Number(process.env.RSS_WARN_MB) * 1024 * 1024 || 400 * 1024 * 1024);
let heartbeatExpected = Date.now() + HEARTBEAT_MS;
setInterval(() => {
  const lag = Math.max(0, Date.now() - heartbeatExpected);
  heartbeatExpected = Date.now() + HEARTBEAT_MS;
  logMemory('heartbeat');
  const usage = process.memoryUsage();
  try {
    database.heartbeatProcessRun(processRunId, {
      rssBytes: usage.rss,
      heapUsedBytes: usage.heapUsed,
      eventLoopLagMs: Math.round(lag),
    });
    database.updateProcessRunActivity(processRunId, currentActivity());
    const heapRatio = usage.heapTotal > 0 ? usage.heapUsed / usage.heapTotal : 0;
    const pressure: Array<{ name: string; message: string }> = [];
    if (lag > LAG_WARN_MS) pressure.push({ name: 'EventLoopLag', message: `event loop lag ${Math.round(lag)}ms exceeded ${LAG_WARN_MS}ms` });
    if (heapRatio > HEAP_WARN_RATIO) pressure.push({ name: 'HeapPressure', message: `heap ${Math.round(heapRatio * 100)}% full (${usage.heapUsed}/${usage.heapTotal} bytes)` });
    if (usage.rss > RSS_WARN_BYTES) pressure.push({ name: 'RssPressure', message: `rss ${usage.rss} bytes exceeded ${RSS_WARN_BYTES}` });
    for (const w of pressure) {
      console.warn(JSON.stringify({ level: 'warn', event: 'processPressure', ...w }));
      database.recordProcessWarning(processRunId, w);
    }
  } catch {
    // Non-fatal: stdout heartbeat above still records memory.
  }
}, HEARTBEAT_MS);
