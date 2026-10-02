import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const scryptKeyLength = 64;

export function createPasswordHash(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('base64url');
  return { salt, hash: scryptSync(password, salt, scryptKeyLength).toString('base64url') };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const expected = Buffer.from(expectedHash, 'base64url');
  const actual = scryptSync(password, salt, scryptKeyLength);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string, sessionSecret: string): string {
  return createHmac('sha256', sessionSecret).update(token).digest('base64url');
}
