// Prepopulates range_configurations from the ULTRA v5.3 preset tables
// (pinescript/ultra-v5.3.pine):
//  - Existing config rows for preset names: sync ONLY the breakeven fields
//    (breakEvenEnabled / breakEvenTriggerTicksCents / breakEvenOffsetTicksCents)
//    — ULTRA is the source of truth for these; other operator-tuned fields
//    (risk, tp/sl, windows, days) are left untouched.
//  - Presets with no tracked range: create the tracked range and a full
//    preset-derived configuration row.
// ocoMode is not an ULTRA concept — pairing stays 'oco' (the default).
// Idempotent; safe to re-run.   npx tsx scripts/prepopulate-ultra-configs.ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../src/database.js';

const PINE_PATH = path.resolve('pinescript/ultra-v5.3.pine');
const src = fs.readFileSync(PINE_PATH, 'utf8');
const ADMIN_EMAIL = (process.env.ADMIN_USER_EMAIL ?? '').toLowerCase();

// Parse `<type> name = switch selectedPreset` blocks into preset -> value maps,
// keyed '*' for the trailing default arm.
const parseSwitch = (varName: string): Map<string, string> => {
  const re = new RegExp(
    `(?:int|float|string|bool)\\s+${varName}\\s*=\\s*switch selectedPreset\\n([\\s\\S]*?)\\n\\s*=>\\s*([^\\n]+)`,
  );
  const m = src.match(re);
  const map = new Map<string, string>();
  if (!m) throw new Error(`preset table not found: ${varName}`);
  for (const line of m[1].split('\n')) {
    const p = line.match(/^\s*"([^"]+)"\s*=>\s*(.+?)\s*$/);
    if (p) map.set(p[1], p[2]);
  }
  map.set('*', m[2].trim());
  return map;
};

const tables = {
  instrument: parseSwitch('presetInstrument'),
  session: parseSwitch('activeRangeSession'),
  riskUsd: parseSwitch('presetRiskAmountUsd'),
  tpStyle: parseSwitch('presetTpStyle'),
  tpTicks: parseSwitch('presetTpTicksOverride'),
  slStyle: parseSwitch('presetSlStyle'),
  slTicks: parseSwitch('presetSlTicksOverride'),
  entries: parseSwitch('presetEntriesPerRange'),
  beFlag: parseSwitch('presetBeStopFlag'),
  beTrigger: parseSwitch('presetBeTriggerTicks'),
  beOffset: parseSwitch('presetBeOffsetTicks'),
};

const lookup = (table: Map<string, string>, preset: string) => table.get(preset) ?? table.get('*')!;
const num = (table: Map<string, string>, preset: string) => Number(lookup(table, preset));
const str = (table: Map<string, string>, preset: string) => lookup(table, preset).replace(/^"|"$/g, '');

// ULTRA style labels -> bridge style vocabulary: 'Ticks' -> 'ticks' (uses the
// tick override), '1× range'/'½ range'/'1.414 range' -> '1x'/'1/2x'/'1.414x'
// (range multipliers understood by parseMultiplierStyle).
const normalizeStyle = (style: string): string => {
  const s = style.trim();
  if (/^ticks$/i.test(s)) return 'ticks';
  const m = s
    .replace(/½/g, '1/2')
    .replace(/¼/g, '1/4')
    .replace(/×\s*range/i, 'x')
    .replace(/\s*range/i, 'x')
    .replace(/x$/i, 'x');
  return m.toLowerCase();
};

const presetNames = [...tables.instrument.keys()].filter((k) => k !== '*');

const db = new Database();
const admin = db.findUserByEmail(ADMIN_EMAIL);
if (!admin) throw new Error(`Admin user ${ADMIN_EMAIL} not found`);

let synced = 0;
let created = 0;
const changes: string[] = [];

for (const preset of presetNames) {
  const beEnabled = num(tables.beFlag, preset) > 0;
  const beTriggerCents = num(tables.beTrigger, preset) * 100;
  const beOffsetCents = num(tables.beOffset, preset) * 100;

  const existing = db.getRangeConfiguration(preset);
  if (existing) {
    const delta: string[] = [];
    if (existing.breakEvenEnabled !== beEnabled) delta.push(`enabled ${existing.breakEvenEnabled}→${beEnabled}`);
    if (existing.breakEvenTriggerTicksCents !== beTriggerCents) delta.push(`trigger ${existing.breakEvenTriggerTicksCents / 100}→${beTriggerCents / 100}`);
    if (existing.breakEvenOffsetTicksCents !== beOffsetCents) delta.push(`offset ${existing.breakEvenOffsetTicksCents / 100}→${beOffsetCents / 100}`);
    if (delta.length === 0) continue;
    db.upsertRangeConfiguration({
      ...existing,
      breakEvenEnabled: beEnabled,
      breakEvenTriggerTicksCents: beTriggerCents,
      breakEvenOffsetTicksCents: beOffsetCents,
    });
    synced += 1;
    changes.push(`  ${preset}: ${delta.join(', ')}`);
    continue;
  }

  const tpStyle = normalizeStyle(str(tables.tpStyle, preset));
  const slStyle = normalizeStyle(str(tables.slStyle, preset));
  db.createTrackedRange(preset, admin.id);
  const saved = db.upsertRangeConfiguration({
    rangeName: preset,
    instrument: str(tables.instrument, preset) || 'NQ1!',
    description: 'ULTRA 5.3 preset',
    riskDollarsCents: Math.round(num(tables.riskUsd, preset) * 100),
    rangeWindow: str(tables.session, preset) || '0000-2359',
    tradingSession: '',
    takeProfitStyle: tpStyle,
    takeProfitTicksCents: tpStyle === 'ticks' ? num(tables.tpTicks, preset) * 100 : 0,
    stopLossStyle: slStyle,
    stopLossTicksCents: slStyle === 'ticks' ? num(tables.slTicks, preset) * 100 : 0,
    breakEvenEnabled: beEnabled,
    breakEvenTriggerTicksCents: beTriggerCents,
    breakEvenOffsetTicksCents: beOffsetCents,
    ocoMode: 'oco', stopOnlyEntries: true,
    runMonday: true, runTuesday: true, runWednesday: true, runThursday: true,
    runFriday: true, runSaturday: true, runSunday: true,
    entriesPerRange: Math.max(1, num(tables.entries, preset)),
  });
  if (!saved) {
    changes.push(`  ${preset}: !! upsert returned nothing (tracked-range creation failed?)`);
    continue;
  }
  created += 1;
  changes.push(`  ${preset}: created (instrument=${saved.instrument} window=${saved.rangeWindow} tp=${saved.takeProfitStyle}/${saved.takeProfitTicksCents / 100}t sl=${saved.stopLossStyle}/${saved.stopLossTicksCents / 100}t be=${beEnabled ? `on trig=${beTriggerCents / 100} off=${beOffsetCents / 100}` : 'off'})`);
}

console.log(`ULTRA 5.3 presets: ${presetNames.length} — synced ${synced}, created ${created}`);
for (const c of changes) console.log(c);
db.close();
