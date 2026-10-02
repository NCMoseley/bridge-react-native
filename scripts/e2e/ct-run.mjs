import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.PT_E2E_LIVE === '1' || process.env.PT_SHARED_DB || process.env.PT_WORKDIR || process.env.PT_DB || process.env.CT_E2E) {
  throw new Error('CrossTrade E2E requires a fresh isolated workspace; live/shared overrides are disabled');
}
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-')));
fs.chmodSync(workdir, 0o700);
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const runId = randomUUID();
fs.writeFileSync(path.join(workdir, 'run.json'), JSON.stringify({ runId, bridgePort: port, mockPort: port }), { mode: 0o600 });
const env = {
  PATH: process.env.PATH, HOME: workdir, TMPDIR: os.tmpdir(),
  NODE_ENV: 'development', DOTENV_CONFIG_PATH: '/dev/null', PROXY_ASYNC: '0', CT_E2E: '1',
  PT_WORKDIR: workdir, PT_RUN_ID: runId, PT_DB: path.join(workdir, 'bridge.sqlite'),
  DATABASE_PATH: path.join(workdir, 'bridge.sqlite'),
  BRIDGE_PORT: String(port), PORT: String(port),
  MOCK_BASE_URL: `http://127.0.0.1:${port}`, PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
  ADMIN_API_KEY: randomUUID(), PROXY_WEBHOOK_SECRET: randomUUID(), SESSION_SECRET: randomUUID(),
  INITIAL_USER_PASSWORD: randomUUID(), ADMIN_USER_EMAIL: 'admin@ct-e2e.local',
  CT_SWEEP_INTERVAL_MS: '60000', CT_VERIFY_DELAY_MS: '500', CT_PROBE_GRACE_MS: '1000',
};
const children = [];
const start = (args, extraEnv = {}, stdio = 'inherit') => {
  const child = spawn(process.execPath, ['--import', './scripts/e2e/ct-network-guard.mjs', ...args], {
    cwd: repo, env: { ...env, ...extraEnv }, stdio,
  });
  children.push(child);
  return child;
};
const finished = child => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`CrossTrade E2E child exited: ${code ?? signal}`)));
});
const stop = async () => {
  await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null).map(child => new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  })));
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().then(() => process.exit(1)); });
console.log(`CrossTrade E2E artifacts: ${workdir}`);
try {
  await finished(start(['--import', 'tsx', '--input-type=module', '-e', `
    import { Database } from './src/database.ts';
    const db = new Database();
    db.createUser(process.env.ADMIN_USER_EMAIL);
    db.close();
    await import('./scripts/dev-dual-mock-seed.ts');
  `]));
  const log = fs.openSync(path.join(workdir, 'server.log'), 'wx', 0o600);
  let server;
  try { server = start(['--import', 'tsx', 'src/index.ts'], {}, ['ignore', log, log]); }
  finally { fs.closeSync(log); }
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${env.PUBLIC_BASE_URL}/app/api/session`, { signal: AbortSignal.timeout(500), redirect: 'error' });
      if (response.status === 401) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Isolated server did not become ready; inspect ${workdir}/server.log`);
  await finished(start(['scripts/e2e/ct-live-e2e.mjs'], { CT_E2E_DRIVER: '1' }));
} finally {
  await stop();
}
