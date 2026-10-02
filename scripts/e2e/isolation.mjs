import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function assertIsolation() {
  if (process.env.PT_E2E_LIVE === '1') {
    console.warn('[e2e] LIVE MODE: targeting an existing database/server — isolation checks bypassed, PT_* fixtures will be written into it');
    return { live: true };
  }
  assert.notEqual(process.env.PT_SHARED_DB, '1', 'Shared-database E2E is disabled');
  const workdir = fs.realpathSync(process.env.PT_WORKDIR ?? '');
  const root = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(workdir), root);
  assert.match(path.basename(workdir), /^bridge-e2e-/);
  const marker = JSON.parse(fs.readFileSync(path.join(workdir, 'run.json'), 'utf8'));
  assert.ok(process.env.PT_RUN_ID && marker.runId === process.env.PT_RUN_ID, 'Invalid E2E run identity');
  assert.equal(path.resolve(process.env.DATABASE_PATH ?? ''), path.join(workdir, 'bridge.sqlite'));
  assert.equal(process.env.PT_DB, process.env.DATABASE_PATH);
  assert.equal(process.env.MOCK_BASE_URL, `http://127.0.0.1:${marker.mockPort}`);
  assert.equal(process.env.BRIDGE_PORT, String(marker.bridgePort));
  assert.equal(process.env.DOTENV_CONFIG_PATH, '/dev/null');
  for (const name of ['bridge.sqlite', 'bridge.sqlite-wal', 'bridge.sqlite-shm']) {
    const file = path.join(workdir, name);
    if (fs.existsSync(file)) assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'Database must not be a symlink');
  }
  return marker;
}
