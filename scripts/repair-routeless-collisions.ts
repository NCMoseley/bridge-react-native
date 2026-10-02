// Second-pass collision repair for ranges whose range_routes rows were removed
// after the damage occurred. repair-collided-lifecycle.ts discovers affected
// accounts by joining range_routes; once a route is deleted that join yields
// nothing and the dropped events stay invisible.
//
// This pass derives accounts from the damage itself:
//   Phase A — every OPEN bracket_monitor row: replay its trade's range_trade_events
//             rows that are missing from trade_events for that account, in
//             occurred_at order. The monitor row proves the range was routed there.
//   Phase B — every rte event whose te insert was stolen by a winner row on the same
//             account, where the account journaled other events for that range on the
//             same UTC date (same-day footprint = routed + scheduled that day).
//
// Usage: npx tsx scripts/repair-routeless-collisions.ts [dbPath] [--apply]
// Default is a dry run — pass --apply to write. Bookkeeping only; no broker traffic.

import { Database } from '../src/database.js';
import type { TradeEventType } from '../src/database.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbPath = args.find((a) => !a.startsWith('--')) ?? 'data/bridge.sqlite';

const database = new Database(dbPath);
const raw = (database as unknown as { db: import('better-sqlite3').Database }).db;

interface RteRow {
  range_name: string;
  event_id: string;
  trade_id: string;
  event_type: TradeEventType;
  instrument: string;
  side: 'long' | 'short';
  action: 'buy' | 'sell' | 'cancel' | 'exit' | null;
  quantity: number;
  entry_price: number | null;
  exit_price: number | null;
  realized_ticks_cents: number | null;
  realized_dollars_cents: number | null;
  outcome: 'win' | 'loss' | 'breakeven' | null;
  occurred_at: string;
  proxy_alert_id: string | null;
}

const bracketBase = (tradeId: string) => tradeId.replace(/-lifecycle-[a-z]+-\d+$/, '');

const replay = (e: RteRow, accountId: string, userId: string, label: string) => {
  const before = raw.prepare(
    `SELECT state FROM bracket_monitor WHERE account_id = ? AND range_name = ? AND side = ?
     AND (bracket_id = ? OR trade_id = ?)`,
  ).get(accountId, e.range_name, e.side, bracketBase(e.trade_id), e.trade_id) as { state: string } | undefined;
  if (apply) {
    database.createTradeEvent({
      userId,
      accountId,
      rangeName: e.range_name,
      eventId: e.event_id,
      tradeId: e.trade_id,
      eventType: e.event_type,
      instrument: e.instrument,
      side: e.side,
      ...(e.action ? { action: e.action } : {}),
      quantity: e.quantity,
      ...(e.entry_price != null ? { entryPrice: e.entry_price } : {}),
      ...(e.exit_price != null ? { exitPrice: e.exit_price } : {}),
      ...(e.realized_ticks_cents != null ? { realizedTicksCents: e.realized_ticks_cents } : {}),
      ...(e.realized_dollars_cents != null ? { realizedDollarsCents: e.realized_dollars_cents } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
      occurredAt: e.occurred_at,
      ...(e.proxy_alert_id ? { proxyAlertId: e.proxy_alert_id } : {}),
    });
  }
  const after = raw.prepare(
    `SELECT state FROM bracket_monitor WHERE account_id = ? AND range_name = ? AND side = ?
     AND (bracket_id = ? OR trade_id = ?)`,
  ).get(accountId, e.range_name, e.side, bracketBase(e.trade_id), e.trade_id) as { state: string } | undefined;
  console.log(`  [${label}] ${e.range_name} ${e.side} ${e.event_type} @${e.occurred_at} acct=${accountId.slice(0, 8)} monitor ${before?.state ?? 'none'} → ${after?.state ?? 'none'}`);
};

// Phase A: open monitors whose trade has rte events missing from te for that account.
const openMonitors = raw.prepare(
  `SELECT bm.account_id, bm.range_name, bm.trade_id, bm.bracket_id, bm.side, bm.state, a.user_id
   FROM bracket_monitor bm JOIN accounts a ON a.id = bm.account_id
   WHERE bm.state IN ('armed', 'filled')`,
).all() as Array<{ account_id: string; range_name: string; trade_id: string; bracket_id: string; side: string; state: string; user_id: string }>;

let phaseA = 0;
for (const m of openMonitors) {
  const missing = raw.prepare(
    `SELECT * FROM range_trade_events rte
     WHERE rte.range_name = ? AND rte.trade_id = ?
       AND NOT EXISTS (SELECT 1 FROM trade_events te
         WHERE te.event_id = rte.event_id AND te.account_id = ? AND te.range_name = rte.range_name)
     ORDER BY rte.occurred_at ASC`,
  ).all(m.range_name, m.trade_id, m.account_id) as RteRow[];
  for (const e of missing) {
    replay(e, m.account_id, m.user_id, 'A');
    phaseA += 1;
  }
}

// Phase B: dropped events where the route rows are gone (undeletable by phase 1).
// Candidate accounts carry a winner te row for the same event_id. To avoid journaling
// events on accounts where the range was legitimately unrouted/unscheduled that day,
// require a same-day footprint: any existing te or monitor row for that range+account
// on the event's UTC date proves the alert stream reached the account.
const candidates = raw.prepare(
  `SELECT rte.*, te2.account_id
   FROM range_trade_events rte
   JOIN trade_events te2 ON te2.event_id = rte.event_id AND te2.range_name != rte.range_name
   WHERE NOT EXISTS (SELECT 1 FROM trade_events te
     WHERE te.event_id = rte.event_id AND te.account_id = te2.account_id AND te.range_name = rte.range_name)
     AND EXISTS (SELECT 1 FROM trade_events t
       WHERE t.range_name = rte.range_name AND t.account_id = te2.account_id
         AND substr(t.occurred_at, 1, 10) = substr(rte.occurred_at, 1, 10))
   ORDER BY rte.occurred_at ASC`,
).all() as Array<RteRow & { account_id: string }>;

const acctUser = new Map<string, string>(
  (raw.prepare(`SELECT id, user_id FROM accounts`).all() as Array<{ id: string; user_id: string }>).map((a) => [a.id, a.user_id]),
);
let phaseB = 0;
for (const e of candidates) {
  replay(e, e.account_id, acctUser.get(e.account_id)!, 'B');
  phaseB += 1;
}

// Phase C: a replayed entry_armed can create a monitor while its terminal event already
// sits in te (it won the original race, when no monitor existed to transition). Re-feed
// every terminal te row belonging to a still-open monitor's trade — the conflict path in
// createTradeEvent re-applies recordBracketMonitorEvent without duplicating the journal.
const terminalForOpen = raw.prepare(
  `SELECT te.*, a.user_id AS acct_user_id
   FROM trade_events te
   JOIN bracket_monitor bm ON bm.account_id = te.account_id AND bm.range_name = te.range_name
     AND bm.trade_id = te.trade_id AND bm.state IN ('armed', 'filled')
   JOIN accounts a ON a.id = te.account_id
   WHERE te.event_type IN ('entry_cancelled', 'exit_filled', 'trade_closed')
   ORDER BY te.occurred_at ASC`,
).all() as Array<RteRow & { account_id: string; acct_user_id: string }>;

let phaseC = 0;
for (const e of terminalForOpen) {
  replay(e, e.account_id, e.acct_user_id, 'C');
  phaseC += 1;
}

console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'} — phase A: ${phaseA} replays, phase B: ${phaseB} journal inserts, phase C: ${phaseC} terminal re-applies`);

const openMonitorsAfter = raw.prepare(
  `SELECT range_name, side, state, COUNT(*) n FROM bracket_monitor
   WHERE state IN ('armed','filled') GROUP BY range_name, side, state`,
).all();
console.log('open monitors:', JSON.stringify(openMonitorsAfter));
