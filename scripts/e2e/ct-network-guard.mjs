import assert from 'node:assert/strict';
import { assertIsolation } from './isolation.mjs';

export function assertCtIsolation() {
  assert.notEqual(process.env.PT_E2E_LIVE, '1', 'CrossTrade E2E cannot use live mode');
  assert.equal(process.env.CT_E2E, '1', 'Run node scripts/e2e/ct-run.mjs instead');
  const marker = assertIsolation();
  assert.equal(marker.mockPort, marker.bridgePort);
  assert.equal(process.env.PUBLIC_BASE_URL, process.env.MOCK_BASE_URL);
  return marker;
}

assertCtIsolation();
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const brokerPath = (method === 'POST' && /^\/mock\/(traderspost|crosstrade)$/.test(url.pathname))
    || (method === 'GET' && /^\/v1\/api\/(accounts\/[^/]+\/(orders(?:\/[^/]+)?|positions)|atm-templates)$/.test(url.pathname));
  const driverPath = process.env.CT_E2E_DRIVER === '1' && (
    /^\/mock\/(traderspost|crosstrade)(\/(calls|state|clear|fill))?$/.test(url.pathname)
    || url.pathname === `/proxy/${process.env.PROXY_WEBHOOK_SECRET}`
    || url.pathname === '/app/debugging/ct-sweep-now'
    || url.pathname === '/app/debugging/crosstrade-test'
  );
  if (url.origin !== process.env.MOCK_BASE_URL || (!brokerPath && !driverPath)) {
    throw new Error(`CrossTrade E2E blocked request to ${url.origin}`);
  }
  return originalFetch(input, { ...init, redirect: 'error' });
};
