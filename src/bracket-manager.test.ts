import { describe, expect, it } from 'vitest';
import { Database } from './database.js';
import {
  bracketArmIdFromLifecycleTradeId,
  BracketMonitor,
  parseBracketArmId,
} from './bracket-manager.js';

describe('bracket-manager', () => {
  describe('parseBracketArmId', () => {
    it('parses a long arm id', () => {
      expect(parseBracketArmId('ultra-v5.0-NQ1!-1234567890-1-long-arm-1')).toEqual({
        base: 'ultra-v5.0-NQ1!-1234567890-1',
        side: 'long',
        index: 1,
      });
    });

    it('parses a short arm id', () => {
      expect(parseBracketArmId('ultra-v5.0-NQ1!-1234567890-1-short-arm-2')).toEqual({
        base: 'ultra-v5.0-NQ1!-1234567890-1',
        side: 'short',
        index: 2,
      });
    });

    it('ignores CR/LF characters', () => {
      expect(parseBracketArmId('ultra-v5.0-NQ1!-1234567890-1-long-arm-1\r\n')).toEqual({
        base: 'ultra-v5.0-NQ1!-1234567890-1',
        side: 'long',
        index: 1,
      });
    });

    it('returns undefined for legacy arm ids', () => {
      expect(parseBracketArmId('ultra-v5.0-NQ1!-1234567890-1-arm-1')).toBeUndefined();
    });

    it('returns undefined for non-arm ids', () => {
      expect(parseBracketArmId('some-trade-id')).toBeUndefined();
    });
  });

  describe('bracketArmIdFromLifecycleTradeId', () => {
    it('strips the lifecycle suffix', () => {
      expect(bracketArmIdFromLifecycleTradeId('base-long-arm-1-lifecycle-long-0')).toBe('base-long-arm-1');
    });

    it('returns the input when there is no lifecycle suffix', () => {
      expect(bracketArmIdFromLifecycleTradeId('base-long-arm-1')).toBe('base-long-arm-1');
    });

    it('removes CR/LF characters', () => {
      expect(bracketArmIdFromLifecycleTradeId('base-long-arm-1\r\n-lifecycle-long-0')).toBe('base-long-arm-1');
    });
  });

  describe('BracketMonitor', () => {
    function createTestDatabase() {
      return new Database(':memory:');
    }

    function seedAccount(db: Database) {
      const user = db.createUser('test@example.com');
      const account = db.createAccount({ userId: user.id, name: 'Test', startingBalanceCents: 100_000 });
      return { user, account };
    }

    it('records armed state and reads it back', () => {
      const db = createTestDatabase();
      const { account } = seedAccount(db);
      const monitor = new BracketMonitor(db);
      monitor.recordEvent({
        accountId: account.id,
        rangeName: 'TEST RANGE',
        tradeId: 'base-long-arm-1-lifecycle-long-0',
        eventType: 'entry_armed',
        instrument: 'NQ1!',
        side: 'long',
        quantity: 2,
        occurredAt: '2026-01-01T00:00:00.000Z',
        eventId: 'evt-armed',
      });
      const entry = db.findBracketMonitorEntry(account.id, 'TEST RANGE', 'base-long-arm-1', 'long');
      expect(entry).toBeDefined();
      expect(entry?.state).toBe('armed');
      expect(entry?.bracketId).toBe('base-long-arm-1');
    });

    it('transitions arm state from armed to filled and to closed', () => {
      const db = createTestDatabase();
      const { account } = seedAccount(db);
      const monitor = new BracketMonitor(db);
      const base = {
        accountId: account.id,
        rangeName: 'TEST RANGE',
        instrument: 'NQ1!',
        side: 'long' as const,
        quantity: 2,
      };
      monitor.recordEvent({ ...base, tradeId: 'base-long-arm-1-lifecycle-long-0', eventType: 'entry_armed', occurredAt: '2026-01-01T00:00:00.000Z', eventId: 'evt-1' });
      monitor.recordEvent({ ...base, tradeId: 'base-long-arm-1-lifecycle-long-1', eventType: 'entry_filled', occurredAt: '2026-01-01T00:00:01.000Z', eventId: 'evt-2' });
      let entry = db.findBracketMonitorEntry(account.id, 'TEST RANGE', 'base-long-arm-1', 'long');
      expect(entry?.state).toBe('filled');
      monitor.recordEvent({ ...base, tradeId: 'base-long-arm-1-lifecycle-long-2', eventType: 'trade_closed', occurredAt: '2026-01-01T00:00:02.000Z', eventId: 'evt-3' });
      entry = db.findBracketMonitorEntry(account.id, 'TEST RANGE', 'base-long-arm-1', 'long');
      expect(entry?.state).toBe('closed');
    });
  });
});
