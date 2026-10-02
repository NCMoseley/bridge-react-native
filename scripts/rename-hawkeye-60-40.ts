// Renames every stored spelling of the HAWKEYE 60/40 range to the canonical
// 'HAWKEYE 60-40'. The UI rename (moveRangeHistory) already covered
// trade_events / range_trade_events / proxy_alerts / routes / configs /
// flags / assignments, but it never touched the broker-side tables — this
// pass finishes the job there and re-applies the canonical move anywhere a
// stale spelling still exists (e.g. prod, where no rename ran yet):
//   bracket_monitor, broker_orders, bracket_reapply_aliases,
//   reapply_operations (event_id '<range>|<eventId>' + data_json),
//   plus every range-keyed table for completeness.
// order_drafts / bridge_logs keep their raw payloads — they are the faithful
// record of what was received, not lookup state.
//
// Usage: npx tsx scripts/rename-hawkeye-60-40.ts [dbPath] [--apply]
// Default is a dry run — pass --apply to write. Bookkeeping only; no broker traffic.

import { Database } from '../src/database.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbPath = args.find((a) => !a.startsWith('--')) ?? 'data/bridge.sqlite';
const TARGET = 'HAWKEYE 60-40';

const database = new Database(dbPath);
const raw = (database as unknown as { db: import('better-sqlite3').Database }).db;

// Any stored 'HAWKEYE …60…40…' spelling other than the canonical target is stale.
const RANGE_TABLES = [
  'tracked_ranges',
  'range_configurations',
  'range_review_flags',
  'range_subcategory_assignments',
  'range_routes',
  'range_calendar_visibility',
  'range_trade_events',
  'trade_events',
  'proxy_alerts',
  'bracket_monitor',
  'broker_orders',
  'bracket_reapply_aliases',
  'precise_take_profit_intents',
];

const staleNames = new Set<string>();
for (const table of RANGE_TABLES) {
  const rows = raw.prepare(
    `SELECT DISTINCT range_name FROM ${table} WHERE range_name LIKE 'HAWKEYE%60%40%' AND range_name <> ?`,
  ).all(TARGET) as Array<{ range_name: string }>;
  for (const row of rows) staleNames.add(row.range_name);
}
// reapply_operations keys its event_id '<rangeName>|<eventId>' — sweep spellings
// that only ever reached that table too.
const reapplyNames = raw.prepare(
  `SELECT DISTINCT substr(event_id, 1, instr(event_id, '|') - 1) AS range_name
   FROM reapply_operations
   WHERE event_id LIKE 'HAWKEYE%60%40%|%'`,
).all() as Array<{ range_name: string }>;
for (const row of reapplyNames) if (row.range_name && row.range_name !== TARGET) staleNames.add(row.range_name);

console.log(`target: ${TARGET}`);
console.log(`stale spellings: ${[...staleNames].map((n) => JSON.stringify(n)).join(', ') || '(none)'}`);

const counts = new Map<string, number>();
const bump = (key: string, n: number) => counts.set(key, (counts.get(key) ?? 0) + n);

const run = () => {
  for (const source of staleNames) {
    // Single-row-per-range tables: canonical row wins on conflict, else rename.
    for (const table of ['tracked_ranges', 'range_configurations', 'range_review_flags', 'range_subcategory_assignments']) {
      const targetExists = Boolean(raw.prepare(
        `SELECT 1 FROM ${table} WHERE range_name = ? COLLATE BINARY`,
      ).get(TARGET));
      if (targetExists) {
        bump(table, Number(raw.prepare(`DELETE FROM ${table} WHERE range_name = ? COLLATE BINARY`).run(source).changes));
      } else {
        bump(table, Number(raw.prepare(`UPDATE ${table} SET range_name = ? WHERE range_name = ? COLLATE BINARY`).run(TARGET, source).changes));
      }
    }

    // Routes: merge into the canonical route for the same user+account when it
    // exists (rewiring its deliveries first), else plain rename.
    const sourceRoutes = raw.prepare(
      `SELECT id, user_id, account_id FROM range_routes WHERE range_name = ? COLLATE BINARY`,
    ).all(source) as Array<{ id: string; user_id: string; account_id: string }>;
    for (const route of sourceRoutes) {
      const targetRoute = raw.prepare(
        `SELECT id FROM range_routes WHERE range_name = ? COLLATE BINARY AND user_id = ? AND account_id = ?`,
      ).get(TARGET, route.user_id, route.account_id) as { id: string } | undefined;
      if (targetRoute) {
        raw.prepare(
          `DELETE FROM proxy_deliveries
           WHERE range_route_id = ?
             AND proxy_alert_id IN (SELECT proxy_alert_id FROM proxy_deliveries WHERE range_route_id = ?)`,
        ).run(route.id, targetRoute.id);
        raw.prepare(`UPDATE proxy_deliveries SET range_route_id = ? WHERE range_route_id = ?`).run(targetRoute.id, route.id);
        bump('range_routes', Number(raw.prepare(`DELETE FROM range_routes WHERE id = ?`).run(route.id).changes));
      } else {
        bump('range_routes', Number(raw.prepare(
          `UPDATE range_routes SET range_name = ?, updated_at = ? WHERE id = ?`,
        ).run(TARGET, new Date().toISOString(), route.id).changes));
      }
    }

    bump('range_calendar_visibility', Number(raw.prepare(
      `INSERT INTO range_calendar_visibility (range_name, date_key, hidden_by_user_id, updated_at)
       SELECT ?, date_key, hidden_by_user_id, updated_at FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY
       ON CONFLICT(range_name, date_key) DO UPDATE SET hidden_by_user_id = excluded.hidden_by_user_id, updated_at = excluded.updated_at`,
    ).run(TARGET, source).changes));
    raw.prepare(`DELETE FROM range_calendar_visibility WHERE range_name = ? COLLATE BINARY`).run(source);

    bump('precise_take_profit_intents', Number(raw.prepare(
      `INSERT INTO precise_take_profit_intents (account_id, range_name, bracket_id, instrument, side, action, payload_json, created_at, updated_at)
       SELECT account_id, ?, bracket_id, instrument, side, action, payload_json, created_at, updated_at
       FROM precise_take_profit_intents WHERE range_name = ? COLLATE BINARY
       ON CONFLICT(account_id, range_name, bracket_id, side) DO NOTHING`,
    ).run(TARGET, source).changes));
    raw.prepare(`DELETE FROM precise_take_profit_intents WHERE range_name = ? COLLATE BINARY`).run(source);

    // Journal tables: drop rows that are exact duplicates of a canonical row
    // (same unique key modulo range_name), rename the rest.
    bump('trade_events(dup)', Number(raw.prepare(
      `DELETE FROM trade_events WHERE range_name = ? COLLATE BINARY
       AND EXISTS (SELECT 1 FROM trade_events t WHERE t.range_name = ? COLLATE BINARY
         AND t.event_id = trade_events.event_id AND t.account_id = trade_events.account_id)`,
    ).run(source, TARGET).changes));
    bump('trade_events', Number(raw.prepare(
      `UPDATE trade_events SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
    ).run(TARGET, source).changes));
    bump('range_trade_events(dup)', Number(raw.prepare(
      `DELETE FROM range_trade_events WHERE range_name = ? COLLATE BINARY
       AND EXISTS (SELECT 1 FROM range_trade_events t WHERE t.range_name = ? COLLATE BINARY
         AND t.event_id = range_trade_events.event_id)`,
    ).run(source, TARGET).changes));
    bump('range_trade_events', Number(raw.prepare(
      `UPDATE range_trade_events SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
    ).run(TARGET, source).changes));

    // Alerts: rename and rewrite extras.rangeName inside the stored payload.
    const alerts = raw.prepare(
      `SELECT id, payload_json FROM proxy_alerts WHERE range_name = ? COLLATE BINARY`,
    ).all(source) as Array<{ id: string; payload_json: string }>;
    for (const alert of alerts) {
      let payloadJson = alert.payload_json;
      try {
        const payload = JSON.parse(payloadJson) as { extras?: { rangeName?: unknown } };
        if (typeof payload.extras?.rangeName === 'string' && payload.extras.rangeName !== TARGET) {
          payloadJson = JSON.stringify({ ...payload, extras: { ...payload.extras, rangeName: TARGET } });
        }
      } catch { /* keep raw payload */ }
      bump('proxy_alerts', Number(raw.prepare(
        `UPDATE proxy_alerts SET range_name = ?, payload_json = ? WHERE id = ?`,
      ).run(TARGET, payloadJson, alert.id).changes));
    }

    // Broker-side residue the UI rename never reached.
    bump('bracket_monitor(dup)', Number(raw.prepare(
      `DELETE FROM bracket_monitor WHERE range_name = ? COLLATE BINARY
       AND EXISTS (SELECT 1 FROM bracket_monitor t WHERE t.range_name = ? COLLATE BINARY
         AND t.account_id = bracket_monitor.account_id AND t.bracket_id = bracket_monitor.bracket_id
         AND t.side = bracket_monitor.side)`,
    ).run(source, TARGET).changes));
    bump('bracket_monitor', Number(raw.prepare(
      `UPDATE bracket_monitor SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
    ).run(TARGET, source).changes));

    bump('broker_orders', Number(raw.prepare(
      `UPDATE broker_orders SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
    ).run(TARGET, source).changes));

    bump('bracket_reapply_aliases(dup)', Number(raw.prepare(
      `DELETE FROM bracket_reapply_aliases WHERE range_name = ? COLLATE BINARY
       AND EXISTS (SELECT 1 FROM bracket_reapply_aliases t WHERE t.range_name = ? COLLATE BINARY
         AND t.account_id = bracket_reapply_aliases.account_id
         AND t.original_bracket_id = bracket_reapply_aliases.original_bracket_id)`,
    ).run(source, TARGET).changes));
    bump('bracket_reapply_aliases', Number(raw.prepare(
      `UPDATE bracket_reapply_aliases SET range_name = ? WHERE range_name = ? COLLATE BINARY`,
    ).run(TARGET, source).changes));

    // reapply_operations: event_id is '<rangeName>|<eventId>'; data_json embeds
    // both that id and the rangeName field.
    const ops = raw.prepare(
      `SELECT id, account_id, event_id FROM reapply_operations WHERE event_id LIKE ? || '|%'`,
    ).all(source) as Array<{ id: string; account_id: string; event_id: string }>;
    for (const op of ops) {
      const nextEventId = TARGET + op.event_id.slice(source.length);
      const twin = raw.prepare(
        `SELECT 1 FROM reapply_operations WHERE account_id = ? AND event_id = ? AND id <> ?`,
      ).get(op.account_id, nextEventId, op.id);
      if (twin) {
        bump('reapply_operations(dup)', Number(raw.prepare(`DELETE FROM reapply_operations WHERE id = ?`).run(op.id).changes));
      } else {
        bump('reapply_operations', Number(raw.prepare(
          `UPDATE reapply_operations SET event_id = ? WHERE id = ?`,
        ).run(nextEventId, op.id).changes));
      }
    }
    bump('reapply_operations(data_json)', Number(raw.prepare(
      `UPDATE reapply_operations SET data_json = replace(data_json, ?, ?) WHERE data_json LIKE '%' || ? || '%'`,
    ).run(source, TARGET, source).changes));
  }
};

// Dry runs execute inside a transaction that is rolled back, so the reported
// counts reflect exactly what --apply would persist.
raw.exec('BEGIN IMMEDIATE');
try {
  run();
  if (apply) {
    raw.exec('COMMIT');
  } else {
    raw.exec('ROLLBACK');
  }
} catch (error) {
  raw.exec('ROLLBACK');
  throw error;
}

for (const [key, n] of [...counts.entries()].sort()) console.log(`  ${key}: ${n}`);
console.log(apply ? 'APPLIED' : 'DRY RUN — pass --apply to write');

// Immutable history that still mentions the old spelling (left as received).
for (const table of ['order_drafts', 'bridge_logs']) {
  const col = table === 'order_drafts' ? 'payload_json' : 'data_json';
  const n = (raw.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} LIKE '%HAWKEYE 60/40%' OR ${col} LIKE '%HAWKEYE 60.40%'`,
  ).get() as { n: number }).n;
  if (n) console.log(`note: ${n} ${table} row(s) still reference the old spelling (raw history — left unchanged)`);
}
database.close();
