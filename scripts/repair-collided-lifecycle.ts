// Repairs bookkeeping damage from non-range-unique Ultra lifecycle ids.
//
// Ultra mints event_id/trade_id/bracket_id as `ultra-<ver>-<ticker>-<epoch>-<seq>-...`
// with no range component, so ranges sharing an instrument + anchor epoch emit
// identical ids. Before trade_events was keyed UNIQUE(event_id, account_id, range_name),
// the second range's per-account journal insert conflicted and was dropped — no monitor
// write, no ledger transition, no close dispatch for that range.
//
// Phase 1 replays every range_trade_events row whose per-account coverage was stolen by
// another range (detectable: a te row with the same event_id exists on that account under
// a different range_name) through createTradeEvent — the same path live alerts take.
// The monitor transition guards make this safe: closed rows ignore late events, and
// replay runs in occurred_at order so sequences resolve to their true final state.
//
// Phase 2 resolves open entry broker_orders whose covering bracket_monitor row is
// already terminal — the "winner" side's rows the cross-range bleed left acknowledged.
//
// Usage: npx tsx scripts/repair-collided-lifecycle.ts [dbPath] [--apply]
// Default is a dry run — pass --apply to write. Bookkeeping only; no broker traffic.

import { Database } from '../src/database.js';
import type { TradeEventType } from '../src/database.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbPath = args.find((a) => !a.startsWith('--')) ?? 'data/bridge.sqlite';

const database = new Database(dbPath);
const raw = (database as unknown as { db: import('better-sqlite3').Database }).db;

interface DroppedRow {
  id: string;
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
  account_id: string;
  user_id: string;
  stolen_by: string;
}

const dropped = raw.prepare(
  `SELECT rte.*, rr.account_id, a.user_id,
     (SELECT GROUP_CONCAT(DISTINCT te2.range_name) FROM trade_events te2
      WHERE te2.event_id = rte.event_id AND te2.account_id = rr.account_id AND te2.range_name != rte.range_name) stolen_by
   FROM range_trade_events rte
   JOIN range_routes rr ON rr.range_name = rte.range_name
   JOIN accounts a ON a.id = rr.account_id
   WHERE NOT EXISTS (SELECT 1 FROM trade_events te
     WHERE te.event_id = rte.event_id AND te.account_id = rr.account_id AND te.range_name = rte.range_name)
     AND EXISTS (SELECT 1 FROM trade_events te2
       WHERE te2.event_id = rte.event_id AND te2.account_id = rr.account_id AND te2.range_name != rte.range_name)
   ORDER BY rte.occurred_at ASC`,
).all() as DroppedRow[];

console.log(`${dropped.length} collision-dropped (event, account) pairs${apply ? ' — APPLYING' : ' — dry run'}`);

let journaled = 0;
const monitorChanges: string[] = [];
for (const e of dropped) {
  const before = raw.prepare(
    `SELECT state FROM bracket_monitor WHERE account_id = ? AND range_name = ? AND side = ?
     AND (bracket_id = ? OR trade_id = ?)`,
  ).get(e.account_id, e.range_name, e.side, e.trade_id.replace(/-lifecycle-[a-z]+-\d+$/, ''), e.trade_id) as { state: string } | undefined;
  if (apply) {
    database.createTradeEvent({
      userId: e.user_id,
      accountId: e.account_id,
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
    journaled += 1;
  }
  const after = raw.prepare(
    `SELECT state FROM bracket_monitor WHERE account_id = ? AND range_name = ? AND side = ?
     AND (bracket_id = ? OR trade_id = ?)`,
  ).get(e.account_id, e.range_name, e.side, e.trade_id.replace(/-lifecycle-[a-z]+-\d+$/, ''), e.trade_id) as { state: string } | undefined;
  const change = `${before?.state ?? 'none'} → ${after?.state ?? 'none'}`;
  if (before?.state !== after?.state) {
    monitorChanges.push(`  ${e.range_name} ${e.side} ${e.event_type} @${e.occurred_at} acct=${e.account_id.slice(0, 8)} monitor ${change} (stolen by ${e.stolen_by})`);
  }
}

// Phase 2: open entry orders whose monitor row is already terminal — the winner side's
// ledger rows the old unscoped update skipped.
const orphans = raw.prepare(
  `SELECT bo.id, bo.account_id, bo.range_name, bo.bracket_id, bo.order_id, bo.action, bo.side, bo.status, bo.created_at,
     bm.state AS monitor_state
   FROM broker_orders bo
   LEFT JOIN bracket_monitor bm ON bm.account_id = bo.account_id AND bm.range_name = bo.range_name
     AND bm.bracket_id = COALESCE(bo.bracket_id, bo.order_id)
     AND bm.side = COALESCE(bo.side, CASE bo.action WHEN 'buy' THEN 'long' ELSE 'short' END)
   WHERE bo.status IN ('pending', 'acknowledged', 'uncertain') AND bo.action IN ('buy', 'sell')`,
).all() as Array<{ id: string; account_id: string; range_name: string; bracket_id: string | null; order_id: string; action: string; side: string | null; status: string; created_at: string; monitor_state: string | null }>;

let resolved = 0;
const orphanReport: string[] = [];
const unresolved: string[] = [];
for (const o of orphans) {
  const target = o.monitor_state === 'closed' ? 'closed' : o.monitor_state === 'cancelled' ? 'cancelled' : null;
  if (!target) {
    unresolved.push(`  ${o.range_name} ${o.order_id} ${o.action} ${o.status} — no/again-live monitor, left alone`);
    continue;
  }
  orphanReport.push(`  ${o.range_name} ${o.order_id} ${o.action} ${o.status} → ${target} (monitor ${o.monitor_state})`);
  if (apply) {
    database.updateBrokerOrderStatus(
      o.account_id,
      o.order_id,
      target,
      'collision-cleanup: covering monitor already resolved',
      undefined,
      'operator',
    );
    resolved += 1;
  }
}

console.log(`\nPhase 1: ${apply ? journaled : dropped.length} events ${apply ? 'journaled' : 'would be journaled'}; monitor transitions:`);
console.log(monitorChanges.length ? monitorChanges.join('\n') : '  (none)');
console.log(`\nPhase 2: ${orphanReport.length} orphaned open entry orders ${apply ? `resolved (${resolved})` : 'to resolve'}:`);
console.log(orphanReport.join('\n') || '  (none)');
if (unresolved.length) {
  console.log('Skipped (no terminal monitor — review manually):');
  console.log(unresolved.join('\n'));
}

const openMonitors = raw.prepare(`SELECT range_name, side, state, COUNT(*) n FROM bracket_monitor WHERE state IN ('armed','filled') GROUP BY range_name, side, state`).all();
const openOrders = raw.prepare(`SELECT range_name, action, status, COUNT(*) n FROM broker_orders WHERE status IN ('pending','acknowledged','uncertain') GROUP BY range_name, action, status`).all();
console.log('\n=== after ===');
console.log('open monitors:', JSON.stringify(openMonitors));
console.log('open orders:', JSON.stringify(openOrders));

database.close();
