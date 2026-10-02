import { afterEach, describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './database.js';
import type { RangeConfiguration } from './types.js';

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const makeDb = () => {
  const directory = mkdtempSync(join(tmpdir(), 'model-days-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const database = new Database(join(directory, 'bridge.sqlite'));
  cleanup.push(() => database.close());
  return database;
};

const ALL_DAYS_DISABLED: typeof ALL_DAYS = {
  runMonday: false, runTuesday: false, runWednesday: false, runThursday: false,
  runFriday: false, runSaturday: false, runSunday: false,
};

const ALL_DAYS: Pick<RangeConfiguration,
  'runMonday' | 'runTuesday' | 'runWednesday' | 'runThursday' | 'runFriday' | 'runSaturday' | 'runSunday'> = {
  runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
  runFriday: true, runSaturday: true, runSunday: true,
};

const fixture = () => {
  const database = makeDb();
  const user = database.createUser('models@example.com');
  const account = database.createAccount({ userId: user.id, name: 'Acct', startingBalanceCents: 0 });
  const configFor = (rangeName: string, days: Partial<typeof ALL_DAYS> = {}) =>
    database.upsertRangeConfiguration({
      rangeName, instrument: 'MNQ1!', description: '', riskDollarsCents: 10_000,
      rangeWindow: '0000-2359', tradingSession: '', takeProfitStyle: 'ticks',
      takeProfitTicksCents: 1_000, stopLossStyle: 'ticks', stopLossTicksCents: 1_000,
      breakEvenEnabled: false, breakEvenTriggerTicksCents: 0, breakEvenOffsetTicksCents: 0,
      ocoMode: 'oco', ...ALL_DAYS, ...days, entriesPerRange: 1,
    });
  const route = (rangeName: string) =>
    database.upsertRangeRoute({
      userId: user.id, accountId: account.id, rangeName,
      extensionEnabled: false, traderspostEnabled: true, runScheduled: true,
    });
  return { database, user, account, configFor, route };
};

describe('shared range models', () => {
  it('migrates the single-model assignments table to a composite key with day columns', () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-days-migration-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const filename = join(directory, 'bridge.sqlite');
    const first = new Database(filename);
    const user = first.createUser('migrate@example.com');
    first.createRangeSubcategory('MODEL A', user.id);
    first.createRangeSubcategory('MODEL B', user.id);
    first.createTrackedRange('R1', user.id);
    first.close();

    // Swap in the legacy single-model schema, then reopen — the migration
    // should rebuild it and preserve the row.
    const raw = new BetterSqlite3(filename);
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec(`
      DROP TABLE range_subcategory_assignments;
      CREATE TABLE range_subcategory_assignments (
        range_name TEXT PRIMARY KEY COLLATE BINARY,
        subcategory_name TEXT NOT NULL REFERENCES range_subcategories(name) ON DELETE CASCADE,
        assigned_by_user_id TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO range_subcategory_assignments (range_name, subcategory_name, assigned_by_user_id, updated_at)
        VALUES ('R1', 'MODEL A', '${user.id}', '2026-01-01T00:00:00Z');
    `);
    raw.close();

    const database = new Database(filename);
    cleanup.push(() => database.close());
    const assignments = database.listRangeSubcategoryAssignments();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ rangeName: 'R1', subcategoryName: 'MODEL A', runMonday: null });
    // Composite PK: the same range can now join a second model.
    expect(database.addRangeSubcategoryAssignment('R1', 'MODEL B', user.id)).toBe(true);
    expect(database.listRangeSubcategoryAssignments()).toHaveLength(2);
  });

  it('stores per-model day overrides and preserves them across re-sync', () => {
    const { database, user } = fixture();
    database.createTrackedRange('R1', user.id);
    database.createRangeSubcategory('A', user.id);
    database.createRangeSubcategory('B', user.id);
    expect(database.setRangeSubcategoryAssignments('R1', ['A'], user.id)).toBe(true);
    const saved = database.setRangeSubcategorySchedule('R1', 'A', { runMonday: false, runTuesday: true });
    expect(saved?.runMonday).toBe(false);
    expect(saved?.runTuesday).toBe(true);
    // Re-sync to a superset keeps the A row (and its schedule) untouched.
    database.setRangeSubcategoryAssignments('R1', ['A', 'B'], user.id);
    const a = database.listRangeSubcategoryAssignments().find((x) => x.subcategoryName === 'A')!;
    expect(a.runMonday).toBe(false);
    expect(a.runTuesday).toBe(true);
    // Clearing a flag returns to inherit (null).
    const cleared = database.setRangeSubcategorySchedule('R1', 'A', { runMonday: null });
    expect(cleared?.runMonday).toBeNull();
  });

  it('gates routes by model days when the account is subscribed through the model', () => {
    const { database, user, account, configFor, route } = fixture();
    database.createTrackedRange('R1', user.id);
    database.createTrackedRange('R2', user.id);
    const config = configFor('R1')!;
    configFor('R2');
    route('R1');
    route('R2');
    database.createRangeSubcategory('MON-ONLY', user.id);
    database.addRangeSubcategoryAssignment('R1', 'MON-ONLY', user.id);
    database.addRangeSubcategoryAssignment('R2', 'MON-ONLY', user.id);
    // The account is routed to every range in MON-ONLY, so it is subscribed to
    // the model — the model's per-range day flags apply instead of the
    // range's own all-days schedule.
    database.setRangeSubcategorySchedule('R1', 'MON-ONLY', {
      runMonday: true, runTuesday: false, runWednesday: false, runThursday: false,
      runFriday: false, runSaturday: false, runSunday: false,
    });
    const r = { userId: user.id, accountId: account.id, rangeName: 'R1' };
    expect(database.routeRunsOnWeekday(r, config, 1)).toBe(true);   // Monday
    expect(database.routeRunsOnWeekday(r, config, 3)).toBe(false);  // Wednesday blocked by model
    expect(database.routeRunsOnWeekday(r, config, 2)).toBe(false);

    // An account routed to R1 only (not the whole model) uses the range's own
    // days — a direct subscription ignores the model schedule.
    const other = database.createAccount({ userId: user.id, name: 'Direct', startingBalanceCents: 0 });
    database.upsertRangeRoute({
      userId: user.id, accountId: other.id, rangeName: 'R1',
      extensionEnabled: false, traderspostEnabled: true, runScheduled: true,
    });
    expect(database.routeRunsOnWeekday({ userId: user.id, accountId: other.id, rangeName: 'R1' }, config, 3)).toBe(true);
  });

  it('unions schedules across multiple models and inherits NULL flags from the range', () => {
    const { database, user, account, configFor, route } = fixture();
    database.createTrackedRange('R1', user.id);
    // Range itself runs Sunday only.
    const config = configFor('R1', {
      runMonday: false, runTuesday: false, runWednesday: false, runThursday: false,
      runFriday: false, runSaturday: false, runSunday: true,
    })!;
    route('R1');
    database.createRangeSubcategory('WEEKDAYS', user.id);
    database.createRangeSubcategory('MONDAYS', user.id);
    for (const m of ['WEEKDAYS', 'MONDAYS']) {
      database.addRangeSubcategoryAssignment('R1', m, user.id);
    }
    // WEEKDAYS: only Tue–Thu on, others off (explicit, overriding range days).
    database.setRangeSubcategorySchedule('R1', 'WEEKDAYS', {
      runMonday: false, runTuesday: true, runWednesday: true, runThursday: true,
      runFriday: false, runSaturday: false, runSunday: false,
    });
    // MONDAYS: Monday on; every other day NULL = inherit range flag (Sun on).
    database.setRangeSubcategorySchedule('R1', 'MONDAYS', { runMonday: true });
    const r = { userId: user.id, accountId: account.id, rangeName: 'R1' };
    expect(database.routeRunsOnWeekday(r, config, 1)).toBe(true);  // MONDAYS
    expect(database.routeRunsOnWeekday(r, config, 2)).toBe(true);  // WEEKDAYS
    expect(database.routeRunsOnWeekday(r, config, 5)).toBe(false); // neither model allows
    expect(database.routeRunsOnWeekday(r, config, 0)).toBe(true);  // MONDAYS inherits range's Sunday=true
  });

  it('model bulk-days sets every member range to the same explicit days', () => {
    const { database, user, account, configFor, route } = fixture();
    database.createTrackedRange('R1', user.id);
    database.createTrackedRange('R2', user.id);
    // Ranges' own schedules stay off — bulk-days must go through the model.
    const c1 = configFor('R1', ALL_DAYS_DISABLED)!;
    const c2 = configFor('R2', ALL_DAYS_DISABLED)!;
    route('R1');
    route('R2');
    database.createRangeSubcategory('M', user.id);
    database.addRangeSubcategoryAssignment('R1', 'M', user.id);
    database.addRangeSubcategoryAssignment('R2', 'M', user.id);

    const r1 = { userId: user.id, accountId: account.id, rangeName: 'R1' };
    const r2 = { userId: user.id, accountId: account.id, rangeName: 'R2' };
    // Before "run all": model-subscribed routes are blocked even though
    // nothing was explicitly set — inherit means they follow the range (off).
    expect(database.routeRunsOnWeekday(r1, c1, 2)).toBe(false);

    const result = database.setSubcategoryMemberRunDays('M', true);
    expect(result.rangeNames.sort()).toEqual(['R1', 'R2']);
    for (const [route_, cfg] of [[r1, c1], [r2, c2]] as const) {
      for (let day = 0; day < 7; day++) {
        expect(database.routeRunsOnWeekday(route_, cfg, day)).toBe(true);
      }
    }
    // The ranges' own configurations were not touched.
    expect(database.getRangeConfiguration('R1')?.runMonday).toBe(false);

    // "Stop all" disables every member for model-subscribed accounts.
    database.setSubcategoryMemberRunDays('M', false);
    expect(database.routeRunsOnWeekday(r1, c1, 1)).toBe(false);
    expect(database.routeRunsOnWeekday(r2, c2, 4)).toBe(false);
  });

  it('listSubcategoryDailyPnl sums closed-trade dollars across a model\'s ranges', () => {
    const { database, user, account } = fixture();
    database.createTrackedRange('IN', user.id);
    database.createTrackedRange('OUT', user.id);
    database.createRangeSubcategory('M', user.id);
    database.addRangeSubcategoryAssignment('IN', 'M', user.id);
    const close = (rangeName: string, realizedDollarsCents: number, occurredAt: string, seq: number) =>
      database.createTradeEvent({
        userId: user.id, accountId: account.id, rangeName,
        eventId: `e${seq}`, tradeId: `t${seq}`, eventType: 'trade_closed',
        instrument: 'MNQ1!', side: 'long', quantity: 1,
        entryPrice: 100, exitPrice: 100,
        realizedTicksCents: 0, realizedDollarsCents, outcome: 'win',
        occurredAt,
      });
    close('IN', 10_000, '2026-09-20T15:00:00Z', 1);
    close('IN', -4_000, '2026-09-20T18:00:00Z', 2);
    close('IN', 2_500, '2026-09-21T15:00:00Z', 3);
    close('OUT', 99_000, '2026-09-20T15:00:00Z', 4); // not in the model
    const rows = database.listSubcategoryDailyPnl('M', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.realizedDollarsCents)).toEqual([10_000, -4_000, 2_500]);
  });

  it('adding a range to a model propagates a route to existing model subscribers', () => {
    const { database, user, account, configFor, route } = fixture();
    database.createTrackedRange('R1', user.id);
    database.createTrackedRange('R2', user.id);
    const c1 = configFor('R1', ALL_DAYS_DISABLED)!;
    const c2 = configFor('R2', ALL_DAYS_DISABLED)!;
    database.createRangeSubcategory('M', user.id);
    database.addRangeSubcategoryAssignment('R1', 'M', user.id);
    // Subscribed to M while it has only R1 — extension off to prove flags clone.
    const r1 = database.upsertRangeRoute({
      userId: user.id, accountId: account.id, rangeName: 'R1',
      extensionEnabled: false, traderspostEnabled: true, runScheduled: true,
    })!;

    // The new member gets a route for the subscribed account automatically…
    database.addRangeSubcategoryAssignment('R2', 'M', user.id);
    const r2 = database.findRangeRoutes('R2').find((r) => r.accountId === account.id);
    expect(r2).toBeDefined();
    expect(r2?.extensionEnabled).toBe(false);
    expect(r2?.traderspostEnabled).toBe(true);
    expect(r2?.runScheduled).toBe(true);

    // …so model days apply to it, and the account stays subscribed.
    database.setRangeSubcategorySchedule('R2', 'M', { runMonday: true, runTuesday: false });
    const route_ = { userId: user.id, accountId: account.id, rangeName: 'R2' };
    expect(database.routeRunsOnWeekday(route_, c2, 1)).toBe(true);
    expect(database.routeRunsOnWeekday(route_, c2, 2)).toBe(false);
    // An account never routed to the model gets nothing.
    const other = database.createAccount({ userId: user.id, name: 'Out', startingBalanceCents: 0 });
    expect(database.findRangeRoutes('R2').some((r) => r.accountId === other.id)).toBe(false);
    void c1; void route; void r1;
  });
});
