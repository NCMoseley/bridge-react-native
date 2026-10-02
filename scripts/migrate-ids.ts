import 'dotenv/config';
import { existsSync, copyFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const dbPath = process.env.DATABASE_PATH ?? join(projectRoot, 'data', 'bridge.sqlite');
const backupPath = `${dbPath}.pre-id-migration.${new Date().toISOString().replace(/[:.]/g, '-')}`;

if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

console.log(`Backing up ${dbPath} -> ${backupPath}`);
copyFileSync(dbPath, backupPath);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function controlCharFix(value: string | null): string | null {
  if (value == null) return null;
  return value
    .replace(/\r/g, 'r')
    .replace(/\n/g, 'n')
    .replace(/ulta/g, 'ultra');
}

function log(label: string, changes: number) {
  console.log(`  ${label}: ${changes} rows`);
}

function runV4xColumnFix(table: string, columns: string[]) {
  for (const column of columns) {
    const sql = `
      UPDATE ${table}
      SET ${column} = REPLACE(REPLACE(REPLACE(${column}, CHAR(13), 'r'), CHAR(10), 'n'), 'ulta', 'ultra')
      WHERE ${column} LIKE '%' || CHAR(13) || '%'
         OR ${column} LIKE '%' || CHAR(10) || '%'
         OR ${column} LIKE '%ulta%'
    `;
    const result = db.prepare(sql).run();
    log(`${table}.${column}`, result.changes);
  }
}

try {
  db.exec('BEGIN EXCLUSIVE');

  console.log('=== V4.x control-char/ulta repair ===');

  runV4xColumnFix('proxy_alerts', ['source_reference']);
  runV4xColumnFix('bracket_monitor', ['bracket_id', 'trade_id', 'last_event_id']);
  // Note: trade_events and range_trade_events intentionally skipped here because
  // corrupted event_ids can collide with already-clean rows; the reapply path
  // only needs bracket_monitor and proxy_alerts to be consistent.
  runV4xColumnFix('precise_take_profit_intents', ['bracket_id']);
  runV4xColumnFix('range_review_candidates', ['latest_source_reference']);

  // Note: proxy_alerts.payload_json is intentionally not rewritten here.
  // The stored raw JSON is left as-is; the parsing layer sanitizes on read.

  console.log('=== V5.0 side-specific bracket_id repair ===');

  // Note: v5.0 proxy_alerts.payload_json and source_reference are intentionally
  // not rewritten to side/arm form here to avoid JSON-parsing risks.  The
  // getLatestBracketOrderPayload fallback (range/ticker/action) handles lookup.

  // Normalize precise_take_profit_intents bracket_id (column only).
  const ptpFix = db.prepare(`
    UPDATE precise_take_profit_intents
    SET bracket_id = replace(
          bracket_id,
          '-arm-',
          '-' || side || '-arm-'
        )
    WHERE bracket_id LIKE 'ultra-v5%'
      AND bracket_id LIKE '%-arm-%'
      AND bracket_id NOT LIKE '%-long-arm-%'
      AND bracket_id NOT LIKE '%-short-arm-%'
  `);
  const ptpResult = ptpFix.run();
  log('precise_take_profit_intents bracket_id side-specific', ptpResult.changes);

  // Move/merge bracket_monitor no-side rows to side-specific rows.
  const noSideRows = db.prepare(`
    SELECT account_id, range_name, bracket_id, side, instrument, state, quantity, trade_id, entry_price,
           last_event_id, last_event_type, last_occurred_at, created_at, updated_at
    FROM bracket_monitor
    WHERE bracket_id LIKE 'ultra-v5%'
      AND bracket_id LIKE '%-arm-%'
      AND bracket_id NOT LIKE '%-long-arm-%'
      AND bracket_id NOT LIKE '%-short-arm-%'
  `).all() as Array<{
    account_id: string;
    range_name: string;
    bracket_id: string;
    side: 'long' | 'short';
    instrument: string;
    state: string;
    quantity: number;
    trade_id: string;
    entry_price: number | null;
    last_event_id: string;
    last_event_type: string;
    last_occurred_at: string;
    created_at: string;
    updated_at: string;
  }>;

  let renamed = 0;
  let deleted = 0;
  for (const row of noSideRows) {
    const newBracketId = row.bracket_id.replace(/-arm-(\d+)$/, `-${row.side}-arm-$1`);
    const existing = db.prepare(`
      SELECT 1 FROM bracket_monitor
      WHERE account_id = ? AND range_name = ? AND bracket_id = ? AND side = ?
    `).get(row.account_id, row.range_name, newBracketId, row.side);

    if (existing) {
      db.prepare(`
        DELETE FROM bracket_monitor
        WHERE account_id = ? AND range_name = ? AND bracket_id = ? AND side = ?
      `).run(row.account_id, row.range_name, row.bracket_id, row.side);
      deleted += 1;
    } else {
      db.prepare(`
        UPDATE bracket_monitor
        SET bracket_id = ?, trade_id = ?, last_event_id = ?
        WHERE account_id = ? AND range_name = ? AND bracket_id = ? AND side = ?
      `).run(
        newBracketId,
        controlCharFix(row.trade_id),
        controlCharFix(row.last_event_id),
        row.account_id,
        row.range_name,
        row.bracket_id,
        row.side,
      );
      renamed += 1;
    }
  }
  log('bracket_monitor no-side rows renamed', renamed);
  log('bracket_monitor no-side rows deleted (duplicates)', deleted);

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
