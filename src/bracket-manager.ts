import type { Database } from './database.js';
import type { TradeEvent } from './types.js';

/**
 * Bracket lifecycle helpers for Ultra range-bracket state tracking.
 *
 * Pine emits bracket arm IDs in the form `{base}-{side}-arm-{index}`
 * (e.g. `ultra-v5.0-NQ1!-1234567890-1-short-arm-1`). Lifecycle trade IDs
 * append `-lifecycle-{side}-{leg}` to the arm ID. This module parses those
 * IDs so the bridge can map lifecycle events back to the correct arm.
 */

export interface BracketArm {
  base: string;
  side: 'long' | 'short';
  index: number;
}

const ARM_ID_REGEX = /^(.+)-(long|short)-arm-(\d+)$/;

export function parseBracketArmId(armId: string): BracketArm | undefined {
  const normalized = armId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
  const match = ARM_ID_REGEX.exec(normalized);
  if (!match) return undefined;
  const index = parseInt(match[3], 10);
  if (!Number.isFinite(index) || index <= 0) return undefined;
  return {
    base: match[1],
    side: match[2] as 'long' | 'short',
    index,
  };
}

export function getOppositeBracketArmId(armId: string): string | undefined {
  const parsed = parseBracketArmId(armId);
  if (!parsed) return undefined;
  const oppositeSide = parsed.side === 'long' ? 'short' : 'long';
  return `${parsed.base}-${oppositeSide}-arm-${parsed.index}`;
}

/**
 * Strip the lifecycle suffix from a trade ID so the result is the arm ID.
 * Also removes CR/LF characters that Pine historically injected.
 */
export function bracketArmIdFromLifecycleTradeId(tradeId: string): string {
  const normalized = tradeId.replace(/[\r\n]/g, '').replace(/'/g, 'r');
  const lifecycleIndex = normalized.indexOf('-lifecycle-');
  return lifecycleIndex === -1 ? normalized : normalized.slice(0, lifecycleIndex);
}

export type BracketMonitorEventInput = Pick<
  TradeEvent,
  'accountId' | 'rangeName' | 'tradeId' | 'eventType' | 'instrument' | 'side' | 'quantity' | 'entryPrice' | 'occurredAt' | 'eventId'
>;

/**
 * Durable bracket monitor that persists bracket arm state in SQLite.
 *
 * On every lifecycle event the monitor records the bracket arm's state.
 */
export class BracketMonitor {
  constructor(private readonly database: Database) {}

  recordEvent(event: BracketMonitorEventInput): ReturnType<Database['recordBracketMonitorEvent']> {
    return this.database.recordBracketMonitorEvent(event);
  }
}
