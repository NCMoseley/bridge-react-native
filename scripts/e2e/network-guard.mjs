import { assertIsolation } from './isolation.mjs';

assertIsolation();
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== process.env.MOCK_BASE_URL || !/^\/tp\/a[12]$/.test(url.pathname)) {
    throw new Error(`E2E blocked outbound request to ${url.origin}`);
  }
  return originalFetch(input, { ...init, redirect: 'error' });
};
