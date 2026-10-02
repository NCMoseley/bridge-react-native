import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PineTS } = require('pinets') as { PineTS: new (candles: unknown[]) => { run(src: string): Promise<{ plots: Record<string, { data: Array<{ value: unknown }> }> }> } };

// PineTS cannot run the full ultra script (syminfo.* needs symbol metadata and
// the alert/varip surface is beyond its API coverage). Instead we extract the
// fill-predicate functions VERBATIM from ultra-v5.5.pine and run them inside a
// minimal harness — the test executes the real production logic under real
// Pine series semantics, and any drift in the predicate is exercised here.
const source = readFileSync(join(__dirname, '../pinescript/ultra-v5.5.pine'), 'utf8');
const extractFn = (name: string): string => {
  const m = source.match(new RegExp(`^${name}\\([\\s\\S]*?\\n\\n`, 'm'));
  if (!m) throw new Error(`${name} not found in ultra-v5.5.pine`);
  return m[0];
};

type Candle = { openTime: number; open: number; high: number; low: number; close: number; volume: number };
const candle = (i: number, open: number, high: number, low: number, close: number): Candle =>
  ({ openTime: Date.UTC(2026, 0, 5) + i * 60_000, open, high, low, close, volume: 1 });

// Harness mirrors the real call site: `state == ORDER_ARMED` plus the fill
// predicate; `armBar`/`armIsStop` are set the way the arm blocks set them.
const harness = (side: 'long' | 'short', isStop: boolean, level: number, armBarIdx: number) => `
//@version=6
indicator("armedLevelFill harness")

${extractFn('barSpansLevel')}
${extractFn('armedLevelFill')}

var bool armed = false
var bool filled = false
var bool armIsStop = false
var float level = na
var int armBar = na

if bar_index == ${armBarIdx} and not armed
    armed := true
    armIsStop := ${isStop}
    level := ${level}
    armBar := bar_index

if armed and not filled and armedLevelFill(armIsStop, ${side === 'long'}, level, armBar)
    filled := true

plot(filled ? 1 : 0, "filled")
`;

const run = async (side: 'long' | 'short', isStop: boolean, level: number, armBarIdx: number, candles: Candle[]) => {
  const { plots } = await new PineTS(candles).run(harness(side, isStop, level, armBarIdx));
  return plots.filled.data.map((d) => d.value === 1);
};

// Bars 0-2 sit flat at 100; the order arms on bar 2.
const flat = (n: number, at = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => candle(i, at, at + 0.5, at - 0.5, at));

describe('armedLevelFill — prior-armed orders fill on gap-through', () => {
  it('buy stop fills when a later bar gaps entirely above the level', async () => {
    const candles = [...flat(3), candle(3, 102, 102.5, 101.8, 102)];
    const filled = await run('long', true, 101, 2, candles);
    // barSpansLevel would fail here (low 101.8 > level 101) — the broker
    // would fill at the open; the predicate must agree.
    expect(filled[3]).toBe(true);
  });

  it('sell stop fills when a later bar gaps entirely below the level', async () => {
    const candles = [...flat(3), candle(3, 98, 98.2, 97.5, 98)];
    const filled = await run('short', true, 99, 2, candles);
    expect(filled[3]).toBe(true);
  });

  it('buy limit fills when a later bar gaps entirely below the level', async () => {
    const candles = [...flat(3, 100), candle(3, 98, 98.2, 97.5, 98)];
    const filled = await run('long', false, 99, 2, candles);
    expect(filled[3]).toBe(true);
  });

  it('sell limit fills when a later bar gaps entirely above the level', async () => {
    const candles = [...flat(3), candle(3, 102, 102.5, 101.8, 102)];
    const filled = await run('short', false, 101, 2, candles);
    expect(filled[3]).toBe(true);
  });

  it('does not fill when the level is never touched', async () => {
    const candles = [...flat(5), candle(5, 99, 99.9, 99.1, 99.5)];
    const filled = await run('long', true, 101, 2, candles);
    expect(filled.every((v) => v === false)).toBe(true);
  });

  it('a stop order does NOT fill on a bar entirely below the level', async () => {
    const candles = [...flat(3), candle(3, 98, 98.5, 97.8, 98)];
    const filled = await run('long', true, 101, 2, candles);
    expect(filled[3]).toBe(false);
  });
});

describe('armedLevelFill — same-bar arms keep the containment guard', () => {
  it('same-bar arm on a stale level does not phantom-fill', async () => {
    // Bar 2 trades entirely below the level when the arm fires on it —
    // the order was not resting while that range printed.
    const candles = [
      candle(0, 100, 100.5, 99.5, 100),
      candle(1, 100, 100.5, 99.5, 100),
      candle(2, 98, 98.5, 97.8, 98),   // arm on this bar; level 99 is above the whole bar
    ];
    const filled = await run('long', true, 99, 2, candles);
    expect(filled[2]).toBe(false);
  });

  it('same-bar arm fills when the bar contains the level', async () => {
    const candles = [
      candle(0, 100, 100.5, 99.5, 100),
      candle(1, 100, 100.5, 99.5, 100),
      candle(2, 99, 101.5, 98.8, 101), // bar 2 spans level 99
    ];
    const filled = await run('long', true, 99, 2, candles);
    expect(filled[2]).toBe(true);
  });
});
