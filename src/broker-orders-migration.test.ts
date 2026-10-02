import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './database.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

// The original broker_orders DDL made bracket_id/side/quantity NOT NULL and added
// UNIQUE(account_id, bracket_id, side, action). Reapply cancel/exit steps have none of
// those, so createBrokerOrder threw and stranded operations mid-plan. Opening an old
// database must rebuild the table with the current nullable DDL.
describe('broker_orders legacy schema migration', () => {
  it('rebuilds broker_orders so cancel/exit bookkeeping rows accept null arm fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'broker-orders-migration-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'bridge.sqlite');

    const fresh = new Database(filename);
    const user = fresh.createUser('legacy@example.com');
    const account = fresh.createAccount({ userId: user.id, name: 'Legacy', startingBalanceCents: 0 });
    fresh.close();

    // Swap the current table for the legacy NOT NULL variant, as an older build created it.
    const raw = new BetterSqlite3(filename);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec(`
      DROP TABLE broker_orders;
      CREATE TABLE broker_orders (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        range_name TEXT NOT NULL COLLATE BINARY,
        bracket_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'cancel', 'exit')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'rejected', 'filled', 'closed', 'cancelled')),
        instrument TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('long', 'short')),
        quantity REAL NOT NULL CHECK (quantity > 0),
        price REAL,
        stop_price REAL,
        limit_price REAL,
        proxy_alert_id TEXT REFERENCES proxy_alerts(id),
        proxy_delivery_id TEXT REFERENCES proxy_deliveries(id),
        error_text TEXT,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (account_id, order_id),
        UNIQUE (account_id, bracket_id, side, action)
      ) STRICT;
    `);
    raw.prepare(
      `INSERT INTO broker_orders (
        id, account_id, range_name, bracket_id, order_id, action, status, instrument,
        side, quantity, occurred_at, created_at, updated_at
      ) VALUES (?, ?, 'V3X', 'bracket-1', 'order-1', 'buy', 'filled', 'MNQ1!', 'long', 1, '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z', '2026-09-17T00:00:00Z')`,
    ).run('legacy-1', account.id);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.close();

    const database = new Database(filename);
    cleanup.push(() => database.close());

    const check = new BetterSqlite3(filename);
    cleanup.push(() => check.close());
    const columns = check.prepare('PRAGMA table_info(broker_orders)').all() as Array<{ name: string; notnull: number }>;
    expect(columns.find((c) => c.name === 'bracket_id')?.notnull).toBe(0);
    expect(columns.find((c) => c.name === 'side')?.notnull).toBe(0);
    expect(columns.find((c) => c.name === 'quantity')?.notnull).toBe(0);

    // The legacy row survived the rebuild.
    const migrated = check.prepare('SELECT id, order_id, status FROM broker_orders').all();
    expect(migrated).toEqual([{ id: 'legacy-1', order_id: 'order-1', status: 'filled' }]);

    // A cancel-step bookkeeping row (no bracket, side, or quantity) now inserts.
    const order = database.createBrokerOrder({
      accountId: account.id,
      rangeName: 'V3X',
      orderId: 'bridge-reapply-test',
      action: 'cancel',
      status: 'pending',
      instrument: 'MNQ1!',
      occurredAt: new Date().toISOString(),
    });
    expect(order.orderId).toBe('bridge-reapply-test');
  });
});
