// Remove every artifact of a range from a bridge database — beyond what the
// app's deleteRange covers (it keeps bracket_monitor, broker_orders, aliases,
// reapply ops, and the journal). Usage:
//
//   node scripts/clean-range.mjs "HEAVEN"                 # dry-run counts
//   node scripts/clean-range.mjs "HEAVEN" --yes           # delete
//   node scripts/clean-range.mjs "HEAVEN" --yes --journal # also delete trade_events (P&L history)
//
//   --db <path>  target DB (default: PT_DB | DATABASE_PATH | ./data/bridge.sqlite;
//                prod disk is /var/data/bridge.sqlite in the Render shell)
//
// Dry-run is the default. Deletes run in one BEGIN IMMEDIATE transaction, so a
// live WAL-mode database tolerates it — still prefer quiet hours.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const Sqlite = require('better-sqlite3');

const args = process.argv.slice(2);
const YES = args.includes('--yes');
const JOURNAL = args.includes('--journal');
const dbIdx = args.indexOf('--db');
const rangeInput = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');
const DB_PATH = path.resolve(dbIdx >= 0 ? args[dbIdx + 1] : (process.env.PT_DB || process.env.DATABASE_PATH || './data/bridge.sqlite'));

if (!rangeInput) {
  console.error('usage: node scripts/clean-range.mjs <rangeName> [--db path] [--journal] [--yes]');
  process.exit(1);
}

const normalize = (v) => String(v).replace(/[\r\n]/g, '').trim().replace(/\s+/g, ' ');
const wanted = normalize(rangeInput);

const db = new Sqlite(DB_PATH);
const existingTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));

// Resolve stored spellings (whitespace variants of the same logical name), the
// same way resolveStoredRangeAliases does.
const RANGE_TABLES = ['tracked_ranges', 'range_configurations', 'range_routes', 'proxy_alerts',
  'bracket_monitor', 'broker_orders', 'trade_events', 'range_trade_events',
  'bracket_reapply_aliases', 'precise_take_profit_intents', 'range_subcategory_assignments',
  'range_review_flags', 'range_review_candidates', 'range_calendar_visibility']
  .filter((t) => existingTables.has(t));
const stored = new Set();
for (const t of RANGE_TABLES) {
  for (const row of db.prepare(`SELECT DISTINCT range_name n FROM ${t}`).all()) {
    if (normalize(row.n) === wanted) stored.add(row.n);
  }
}
if (stored.size === 0) {
  console.log(`No rows found for range "${rangeInput}" in ${DB_PATH}`);
  process.exit(0);
}
const names = [...stored];
const inNames = (col) => `${col} IN (${names.map(() => '?').join(',')})`;

// LIKE pattern for reapply_operations.data_json — bound, with wildcards escaped.
const escLike = (v) => v.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const opPatterns = names.map((n) => `%"${escLike(n)}"%`);
const opWhere = opPatterns.map(() => `data_json LIKE ? ESCAPE '\\'`).join(' OR ');

// Children first: attempts -> broker_orders/monitor/aliases -> deliveries ->
// drafts -> alerts -> routes/config -> tracked. trade_events keeps its rows but
// drops the alert link unless --journal (journal erasure is a separate choice).
const scopes = [
  ['proxy_delivery_attempts',
    `proxy_delivery_id IN (SELECT id FROM proxy_deliveries WHERE
      proxy_alert_id IN (SELECT id FROM proxy_alerts WHERE ${inNames('range_name')})
      OR range_route_id IN (SELECT id FROM range_routes WHERE ${inNames('range_name')}))`,
    ...names, ...names],
  ['broker_orders', inNames('range_name'), ...names],
  ['bracket_reapply_aliases', inNames('range_name'), ...names],
  ['bracket_monitor', inNames('range_name'), ...names],
  // Only completed ops are deleted — an in-flight op mentioning this range may
  // still be re-arming OTHER ranges on the same instrument. Incomplete matches
  // are reported for manual review instead.
  ['reapply_operations', `(${opWhere}) AND completed = 1`, ...opPatterns],
  ['precise_take_profit_intents', inNames('range_name'), ...names],
  ['range_trade_events', inNames('range_name'), ...names],
  ['proxy_deliveries',
    `proxy_alert_id IN (SELECT id FROM proxy_alerts WHERE ${inNames('range_name')})
     OR range_route_id IN (SELECT id FROM range_routes WHERE ${inNames('range_name')})`,
    ...names, ...names],
  ['proxy_alerts', inNames('range_name'), ...names],
  ['range_routes', inNames('range_name'), ...names],
  ['range_subcategory_assignments', inNames('range_name'), ...names],
  ['range_review_flags', inNames('range_name'), ...names],
  ['range_review_candidates', inNames('range_name'), ...names],
  ['range_calendar_visibility', inNames('range_name'), ...names],
  ['range_configurations', inNames('range_name'), ...names],
  ['tracked_ranges', inNames('range_name'), ...names],
];

// Drafts created for this range's deliveries.
const draftIds = existingTables.has('order_drafts')
  ? db.prepare(`SELECT DISTINCT d.draft_id id FROM proxy_deliveries d
      JOIN proxy_alerts a ON a.id = d.proxy_alert_id
      WHERE ${inNames('a.range_name')} AND d.draft_id IS NOT NULL`).all(...names).map((r) => r.id)
  : [];

console.log(`range "${rangeInput}" resolves to stored name(s): ${names.map((n) => `"${n}"`).join(', ')}`);
console.log(`db: ${DB_PATH}`);

const report = [];
for (const [table, where, ...params] of scopes) {
  if (!existingTables.has(table)) continue;
  const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...params).c;
  if (n) report.push([`DELETE ${table}`, n]);
}
if (existingTables.has('trade_events')) {
  const n = db.prepare(`SELECT COUNT(*) c FROM trade_events WHERE ${inNames('range_name')}`).get(...names).c;
  if (n) report.push([JOURNAL ? 'DELETE trade_events' : 'UNLINK trade_events (kept; proxy_alert_id=NULL)', n]);
}
if (draftIds.length) report.push(['DELETE order_drafts', draftIds.length]);
const openOps = existingTables.has('reapply_operations')
  ? db.prepare(`SELECT COUNT(*) c FROM reapply_operations WHERE (${opWhere}) AND completed = 0`).get(...opPatterns).c
  : 0;
if (openOps) report.push([`KEEP reapply_operations (in-flight — review manually)`, openOps]);

if (!report.length) { console.log('nothing to delete'); process.exit(0); }
for (const [label, n] of report) console.log(`  ${label}: ${n}`);

if (!YES) {
  console.log(`\ndry run — re-run with --yes to execute${JOURNAL ? '' : ' (add --journal to also erase the trade_events journal)'}`);
} else {
  if (openOps) {
    // An in-flight reapply may still be reading these broker_orders /
    // bracket_monitor rows and can re-arm other ranges on the same instrument —
    // deleting underneath it strands or corrupts the operation.
    console.error(`refusing to run: ${openOps} in-flight reapply_operations mention this range — let them settle or resolve them first`);
    process.exit(1);
  }
  db.transaction(() => {
    // trade_events references proxy_alerts — unlink (or delete) before the
    // alert rows go, otherwise the FK constraint fails.
    if (existingTables.has('trade_events')) {
      const n = JOURNAL
        ? db.prepare(`DELETE FROM trade_events WHERE ${inNames('range_name')}`).run(...names).changes
        : db.prepare(`UPDATE trade_events SET proxy_alert_id = NULL WHERE ${inNames('range_name')}`).run(...names).changes;
      if (n) console.log(`  ${JOURNAL ? 'deleted' : 'unlinked'} ${n} trade_events`);
    }
    for (const [table, where, ...params] of scopes) {
      if (!existingTables.has(table)) continue;
      const n = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes;
      if (n) console.log(`  deleted ${n} from ${table}`);
    }
    for (const id of draftIds) db.prepare('DELETE FROM order_drafts WHERE id = ?').run(id);
    if (draftIds.length) console.log(`  deleted ${draftIds.length} order_drafts`);
  }).immediate();
  console.log('done');
}
db.close();
