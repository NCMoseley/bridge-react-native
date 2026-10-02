// Remove the PT_* fixtures an e2e live run wrote into a shared (dev) database.
// Deletion is scoped to <PT_WORKDIR>/ids.json: only entities seed.ts marked as
// newly created are removed outright; entities it reused keep their rows, and
// only children created at/after `seededAt` or carrying this run's tag are
// deleted. Pre-existing rows are never touched. Dry-run by default; --yes runs.
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
const Sqlite = require('better-sqlite3');

const DB_PATH = path.resolve(process.env.PT_DB || process.env.DATABASE_PATH || './data/bridge.sqlite');
const WORKDIR = process.env.PT_WORKDIR || '/tmp/pt-e2e-live';
const YES = process.argv.includes('--yes');

let ids;
try {
  ids = JSON.parse(fs.readFileSync(path.join(WORKDIR, 'ids.json'), 'utf8'));
} catch {
  console.error(`Cannot read ${WORKDIR}/ids.json — without the seed manifest the cleanup cannot tell created fixtures from pre-existing rows. Refusing to delete.`);
  process.exit(1);
}
const TAG = process.env.PT_TAG || ids.runTag || '';
const SEEDED_AT = ids.seededAt || '9999';
const c = ids.created ?? {};
const r = ids.reused ?? {};
const createdAccounts = c.accountIds ?? [];
const createdRanges = c.rangeNames ?? [];
const createdUsers = c.userIds ?? [];
const createdSubcats = c.subcategoryNames ?? [];
const reusedAccounts = r.accountIds ?? [];
const reusedRanges = r.rangeNames ?? [];

// Seeded sessions: hash the tokens recorded by seed.ts so only our rows are
// removed — the operator's real browser session must survive.
const seededTokenHashes = [];
const secret = process.env.SESSION_SECRET;
for (const s of [ids.adminSession, ids.viewerSession].filter(Boolean)) {
  if (secret) seededTokenHashes.push(createHmac('sha256', secret).update(s.token).digest('base64url'));
}

const db = new Sqlite(DB_PATH);
const inList = (col, vals) => vals.length ? `${col} IN (${vals.map(() => '?').join(',')})` : '1=0';
// "This run's" child rows under a reused fixture: created at/after the seed ran,
// or carrying the run tag (bracket ids, trade ids, event ids, order ids).
const tagLike = TAG ? `LIKE '%${TAG}%'` : `LIKE 'pt-e2e-untagged-run'`;
const since = (col) => `${col} >= '${SEEDED_AT}'`;

// Delete children before parents (FK constraints):
// attempts -> deliveries -> alerts/routes/accounts; broker_orders/trade_events
// -> alerts/deliveries; routes -> accounts/ranges; sessions/accounts -> users.
const scopes = [
  ['proxy_delivery_attempts',
    `proxy_delivery_id IN (SELECT id FROM proxy_deliveries WHERE
      ${inList('account_id', createdAccounts)}
      OR (${inList('account_id', reusedAccounts)} AND ${since('created_at')})
      OR range_route_id IN (SELECT id FROM range_routes WHERE ${inList('range_name', createdRanges)}))`,
    ...createdAccounts, ...reusedAccounts, ...createdRanges],
  ['broker_orders',
    `${inList('account_id', createdAccounts)}
     OR (${inList('account_id', reusedAccounts)} AND ${since('created_at')})
     OR bracket_id ${tagLike} OR order_id ${tagLike}
     OR ${inList('range_name', createdRanges)}`,
    ...createdAccounts, ...reusedAccounts, ...createdRanges],
  ['trade_events',
    `${inList('account_id', createdAccounts)} OR ${inList('user_id', createdUsers)}
     OR (${inList('account_id', reusedAccounts)} AND ${since('occurred_at')})
     OR trade_id ${tagLike} OR event_id ${tagLike}
     OR ${inList('range_name', createdRanges)}`,
    ...createdAccounts, ...createdUsers, ...reusedAccounts, ...createdRanges],
  ['bracket_reapply_aliases',
    `${inList('account_id', createdAccounts)}
     OR current_bracket_id ${tagLike} OR original_bracket_id ${tagLike} OR logical_trade_id ${tagLike}
     OR ${inList('range_name', createdRanges)}`,
    ...createdAccounts, ...createdRanges],
  ['bracket_monitor',
    `${inList('account_id', createdAccounts)}
     OR (${inList('account_id', reusedAccounts)} AND ${since('created_at')})
     OR bracket_id ${tagLike} OR trade_id ${tagLike}
     OR ${inList('range_name', createdRanges)}`,
    ...createdAccounts, ...reusedAccounts, ...createdRanges],
  ['reapply_operations',
    `${inList('account_id', createdAccounts)} OR data_json ${tagLike}`, ...createdAccounts],
  ['precise_take_profit_intents',
    `${inList('account_id', createdAccounts)}
     OR (${inList('account_id', reusedAccounts)} AND ${since('created_at')})
     OR bracket_id ${tagLike}
     OR ${inList('range_name', createdRanges)}`,
    ...createdAccounts, ...reusedAccounts, ...createdRanges],
  ['range_trade_events',
    `${inList('range_name', createdRanges)} OR trade_id ${tagLike}
     OR (${inList('range_name', reusedRanges)} AND ${since('occurred_at')})`,
    ...createdRanges, ...reusedRanges],
  ['proxy_deliveries',
    `${inList('account_id', createdAccounts)}
     OR (${inList('account_id', reusedAccounts)} AND ${since('created_at')})
     OR range_route_id IN (SELECT id FROM range_routes WHERE ${inList('range_name', createdRanges)})`,
    ...createdAccounts, ...reusedAccounts, ...createdRanges],
  ['proxy_alerts',
    `${inList('range_name', createdRanges)}
     OR (${inList('range_name', reusedRanges)} AND ${since('received_at')})
     OR source_reference ${tagLike}
     OR id IN (SELECT proxy_alert_id FROM proxy_deliveries WHERE ${inList('account_id', createdAccounts)})`,
    ...createdRanges, ...reusedRanges, ...createdAccounts],
  ['order_drafts', inList('user_id', createdUsers), ...createdUsers],
  ['range_routes', inList('range_name', createdRanges), ...createdRanges],
  ['range_subcategory_assignments',
    `${inList('range_name', createdRanges)} OR ${inList('subcategory_name', createdSubcats)}`,
    ...createdRanges, ...createdSubcats],
  ['range_subcategories', inList('name', createdSubcats), ...createdSubcats],
  ['range_calendar_visibility', inList('range_name', createdRanges), ...createdRanges],
  ['range_configurations', inList('range_name', createdRanges), ...createdRanges],
  ['range_review_candidates', inList('range_name', createdRanges), ...createdRanges],
  ['range_review_flags', inList('range_name', createdRanges), ...createdRanges],
  // PT-NEW-<tag> ranges are created mid-run by the driver, not by the seed.
  ['tracked_ranges', `${inList('range_name', createdRanges)}${TAG ? ` OR range_name LIKE '%-${TAG}'` : ''}`, ...createdRanges],
  ['traderspost_account_destinations', inList('account_id', createdAccounts), ...createdAccounts],
  ['bridge_logs', `${inList('user_id', createdUsers)} OR data_json ${tagLike}`, ...createdUsers],
  ['sessions',
    `${inList('user_id', createdUsers)} OR ${inList('token_hash', seededTokenHashes)}`,
    ...createdUsers, ...seededTokenHashes],
  ['accounts', inList('id', createdAccounts), ...createdAccounts],
  ['users', inList('id', createdUsers), ...createdUsers],
];

// Schemas drift between dev and isolated DBs — skip tables this DB lacks.
const existingTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name));
const activeScopes = scopes.filter(([table]) => existingTables.has(table));
const skipped = scopes.filter(([table]) => !existingTables.has(table)).map(([t]) => t);
if (skipped.length) console.log(`skipping absent tables: ${skipped.join(', ')}`);

console.log(`run tag: ${TAG || '(none)'}  seededAt: ${ids.seededAt ?? '(unknown)'}`);
console.log(`created accounts: ${createdAccounts.length}  reused accounts kept: ${reusedAccounts.length}`);
console.log(`created ranges:   ${createdRanges.length}  reused ranges kept: ${reusedRanges.length}`);
console.log(`created users:    ${createdUsers.length}`);
if (reusedAccounts.length || reusedRanges.length || (r.userIds ?? []).length) {
  console.log('NOTE: reused fixtures are kept — only rows created at/after seededAt or tagged with this run are deleted under them.');
}
if (!YES) {
  for (const [table, where, ...args] of activeScopes) {
    const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args).c;
    if (n) console.log(`  would delete ${n} from ${table}`);
  }
  console.log('\ndry run — re-run with --yes to execute');
} else {
  db.transaction(() => {
    for (const [table, where, ...args] of activeScopes) {
      const n = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes;
      if (n) console.log(`  deleted ${n} from ${table}`);
    }
  })();
  console.log('done');
}
db.close();
