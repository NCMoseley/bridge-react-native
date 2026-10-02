import 'dotenv/config';
import { existsSync, copyFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const dbPath = process.env.DATABASE_PATH ?? join(projectRoot, 'data', 'bridge.sqlite');
const backupPath = `${dbPath}.pre-v5-no-side-migration.${new Date().toISOString().replace(/[:.]/g, '-')}`;

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

console.log(`Backing up ${dbPath} -> ${backupPath}`);
copyFileSync(dbPath, backupPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function sideSpecificBracketId(noSideBracketId: string, side: 'long' | 'short'): string {
  // ultra-v5.0-<ticker>-<time>-<rangeId>-arm-<N> -> ultra-v5.0-<ticker>-<time>-<rangeId>-<side>-arm-<N>
  return noSideBracketId.replace(/-arm-(\d+)$/, `-${side}-arm-$1`);
}

function sideSpecificTradeId(noSideTradeId: string, side: 'long' | 'short'): string {
  // ultra-v5.0-...-arm-<N>-lifecycle-<side>-<M> -> ultra-v5.0-...-<side>-arm-<N>-lifecycle-<side>-<M>
  return noSideTradeId.replace(
    /-arm-(\d+)-lifecycle-(long|short)/,
    `-${side}-arm-$1-lifecycle-$2`,
  );
}

try {
  db.exec('BEGIN EXCLUSIVE');

  const noSideRows = db.prepare(`
    SELECT account_id, range_name, side, bracket_id, trade_id, last_event_id
    FROM bracket_monitor
    WHERE bracket_id LIKE 'ultra-v5.0%'
      AND bracket_id LIKE '%-arm-%'
      AND bracket_id NOT LIKE '%-long-arm-%'
      AND bracket_id NOT LIKE '%-short-arm-%'
  `).all() as Array<{
    account_id: string;
    range_name: string;
    side: 'long' | 'short';
    bracket_id: string;
    trade_id: string;
    last_event_id: string;
  }>;

  let renamed = 0;
  let deleted = 0;

  for (const row of noSideRows) {
    const newBracketId = sideSpecificBracketId(row.bracket_id, row.side);
    const newTradeId = sideSpecificTradeId(row.trade_id, row.side);
    const newLastEventId = sideSpecificTradeId(row.last_event_id, row.side);

    const existing = db.prepare(`
      SELECT 1 FROM bracket_monitor
      WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?
    `).get(row.account_id, row.range_name, newBracketId, row.side);

    if (existing) {
      // Side-specific row already exists; this no-side row is a leftover duplicate.
      db.prepare(`
        DELETE FROM bracket_monitor
        WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?
      `).run(row.account_id, row.range_name, row.bracket_id, row.side);
      deleted += 1;
    } else {
      db.prepare(`
        UPDATE bracket_monitor
        SET bracket_id = ?, trade_id = ?, last_event_id = ?
        WHERE account_id = ? AND range_name = ? COLLATE BINARY AND bracket_id = ? AND side = ?
      `).run(
        newBracketId,
        newTradeId,
        newLastEventId,
        row.account_id,
        row.range_name,
        row.bracket_id,
        row.side,
      );
      renamed += 1;
    }
  }

  console.log(`  bracket_monitor no-side rows renamed: ${renamed}`);
  console.log(`  bracket_monitor no-side rows deleted (duplicates): ${deleted}`);

  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log('Migration committed successfully.');
} catch (error) {
  console.error('Migration failed; rolling back.', error);
  try {
    db.exec('ROLLBACK');
  } catch {
    // ignore
  }
  process.exit(1);
} finally {
  db.close();
}
