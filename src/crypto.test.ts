import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto.js';

describe('credential encryption', () => {
  const secret = 'a-test-only-encryption-secret-that-is-long-enough';

  it('round-trips credential plaintext', () => {
    const encrypted = encrypt('demo-credentials', secret);
    expect(encrypted).not.toContain('demo-credentials');
    expect(decrypt(encrypted, secret)).toBe('demo-credentials');
  });

  it('rejects tampered ciphertext', () => {
    const encrypted = encrypt('demo-credentials', secret);
    expect(() => decrypt(`${encrypted}x`, secret)).toThrow();
  });
});
