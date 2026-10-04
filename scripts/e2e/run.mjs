import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.PT_SHARED_DB === '1' || process.env.PT_WORKDIR || process.env.PT_DB) {
  throw new Error('E2E requires a new isolated workspace; shared databases and workspace overrides are disabled');
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-')));
fs.chmodSync(workdir, 0o700);
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const bridgePort = await freePort();
let mockPort = await freePort();
while (mockPort === bridgePort) mockPort = await freePort();
const runId = randomUUID();
fs.writeFileSync(path.join(workdir, 'run.json'), JSON.stringify({ runId, bridgePort, mockPort }), { mode: 0o600 });
const env = {
  PATH: process.env.PATH, HOME: workdir, TMPDIR: os.tmpdir(),
  NODE_ENV: 'development', DOTENV_CONFIG_PATH: '/dev/null', PROXY_ASYNC: '0',
  PT_WORKDIR: workdir, PT_RUN_ID: runId, PT_DB: path.join(workdir, 'bridge.sqlite'),
  DATABASE_PATH: path.join(workdir, 'bridge.sqlite'),
  BRIDGE_PORT: String(bridgePort), PORT: String(bridgePort), MOCK_PORT: String(mockPort),
  MOCK_BASE_URL: `http://127.0.0.1:${mockPort}`, PUBLIC_BASE_URL: `http://127.0.0.1:${bridgePort}`,
  ADMIN_API_KEY: randomUUID(), PROXY_WEBHOOK_SECRET: randomUUID(), SESSION_SECRET: randomUUID(),
  INITIAL_USER_PASSWORD: randomUUID(), ADMIN_USER_EMAIL: 'admin@e2e.local',
  // Shrink lane-breaker cooldowns for the suite — the outage phase trips them
  // for real (that's coverage), but production-scale 2s→25s backoffs would
  // stretch the 503 storm past the driver's patience.
  TP_BREAKER_BASE_MS: '100', TP_BREAKER_MAX_MS: '500',
};
const children = [];
const start = (args, stdio = 'inherit') => {
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio });
  children.push(child);
  return child;
};
const finished = child => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`E2E child exited: ${code ?? signal}`)));
});
const stop = async () => {
  await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null).map(child => new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  })));
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(1)); });
try {
  const ids = fs.openSync(path.join(workdir, 'ids.json'), 'wx', 0o600);
  try { await finished(start(['--import', 'tsx', 'scripts/e2e/seed.ts'], ['ignore', ids, 'inherit'])); }
  finally { fs.closeSync(ids); }
  const mock = start(['scripts/e2e/mock-traderspost.mjs']);
  const server = start(['--import', './scripts/e2e/network-guard.mjs', '--import', 'tsx', 'src/index.ts']);
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && mock.exitCode === null && server.exitCode === null) {
    try {
      const response = await fetch(`${env.MOCK_BASE_URL}/__identity`, { signal: AbortSignal.timeout(500) });
      const identity = await response.json();
      const session = await fetch(`${env.PUBLIC_BASE_URL}/app/api/session`, { signal: AbortSignal.timeout(500) });
      if (identity.runId === runId && session.status === 401) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Isolated E2E servers did not become ready');
  console.log(`E2E artifacts: ${workdir}`);
  await finished(start(['scripts/e2e/driver.mjs']));
} finally {
  await stop();
}
