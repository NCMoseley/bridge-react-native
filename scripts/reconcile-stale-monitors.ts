// Bookkeeping-only equivalent of POST /app/debugging/reconcile-previous-days:
// retires bracket_monitor rows whose last_occurred_at is before the current journal
// day, writing the same synthetic lifecycle events the endpoint writes (filled →
// exit_filled + breakeven trade_closed; armed → entry_cancelled + breakeven
// trade_closed). No broker traffic.
//
// Usage: npx tsx scripts/reconcile-stale-monitors.ts [dbPath] [--apply]

import { Database } from '../src/database.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbPath = args.find((a) => !a.startsWith('--')) ?? 'data/bridge.sqlite';

const database = new Database(dbPath);
const cutoff = database.getJournalDayStartISO();
const rows = database.listStaleBracketMonitorEntries(cutoff);
console.log(`${rows.length} stale monitor rows before ${cutoff}${apply ? ' — APPLYING' : ' — dry run'}`);

const now = new Date().toISOString();
for (const row of rows) {
  const account = database.findAccountById(row.accountId);
  if (!account) {
    console.log(`  SKIP ${row.rangeName} ${row.bracketId} ${row.side} — account ${row.accountId} not found`);
    continue;
  }
  console.log(`  ${row.state === 'filled' ? 'CLOSE' : 'CANCEL'} ${row.rangeName} ${row.bracketId} ${row.side} acct=${row.accountId.slice(0, 8)} last=${row.lastOccurredAt}`);
  if (!apply) continue;
  if (row.state === 'filled') {
    database.createTradeEvent({
      userId: account.userId,
      accountId: row.accountId,
      rangeName: row.rangeName,
      eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-exit_filled`,
      tradeId: row.tradeId,
      eventType: 'exit_filled',
      instrument: row.instrument,
      side: row.side,
      action: 'exit',
      quantity: row.quantity,
      occurredAt: now,
      ...(row.entryPrice != null ? { entryPrice: row.entryPrice } : {}),
    });
    const { event: closedEvent } = database.createTradeEvent({
      userId: account.userId,
      accountId: row.accountId,
      rangeName: row.rangeName,
      eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-trade_closed`,
      tradeId: row.tradeId,
      eventType: 'trade_closed',
      instrument: row.instrument,
      side: row.side,
      action: 'exit',
      quantity: row.quantity,
      occurredAt: now,
      realizedTicksCents: 0,
      realizedDollarsCents: 0,
      outcome: 'breakeven',
      ...(row.entryPrice != null ? { entryPrice: row.entryPrice, exitPrice: row.entryPrice } : {}),
    });
    database.retireBracketMonitorEntry(account.userId, row, 'trade_closed', closedEvent.eventId, now);
  } else {
    database.createTradeEvent({
      userId: account.userId,
      accountId: row.accountId,
      rangeName: row.rangeName,
      eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-entry_cancelled`,
      tradeId: row.tradeId,
      eventType: 'entry_cancelled',
      instrument: row.instrument,
      side: row.side,
      action: 'cancel',
      quantity: row.quantity,
      occurredAt: now,
    });
    const { event: closedEvent } = database.createTradeEvent({
      userId: account.userId,
      accountId: row.accountId,
      rangeName: row.rangeName,
      eventId: `reconcile-yesterday-${row.bracketId}-${row.side}-trade_closed`,
      tradeId: row.tradeId,
      eventType: 'trade_closed',
      instrument: row.instrument,
      side: row.side,
      action: 'exit',
      quantity: row.quantity,
      occurredAt: now,
      realizedTicksCents: 0,
      realizedDollarsCents: 0,
      outcome: 'breakeven',
      ...(row.entryPrice != null ? { entryPrice: row.entryPrice, exitPrice: row.entryPrice } : {}),
    });
    database.retireBracketMonitorEntry(account.userId, row, 'trade_closed', closedEvent.eventId, now);
  }
}

const remaining = database.listStaleBracketMonitorEntries(cutoff);
console.log(`remaining stale: ${remaining.length}`);
database.close();
