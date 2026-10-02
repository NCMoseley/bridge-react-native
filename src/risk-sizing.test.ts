import { describe, expect, it } from 'vitest';
import { applyAccountFixedQuantityOverride } from './server.js';

const entry = (over: Record<string, unknown> = {}) => ({
  ticker: 'MNQ1!',
  action: 'buy',
  quantity: 4,
  quantityType: 'fixed_quantity',
  stopPrice: 29500,
  stopLoss: { stopPrice: 29480 }, // 20 pts = 80 MNQ ticks
  ...over,
});

const dest = (mode: 'percent' | 'fixed' | 'risk', value: number, outboundTickerMode?: 'micros_only') => ({
  quantityOverrideMode: mode,
  quantityOverrideValue: value,
  outboundTickerMode,
});

describe('per-account order sizing — risk mode', () => {
  it('sizes from $ risk ÷ (stop ticks × tick value)', () => {
    // $100 risk, 80 ticks @ $0.50 (MNQ) → $40/contract → 2 contracts
    const out = applyAccountFixedQuantityOverride(entry(), dest('risk', 100));
    expect(out.quantity).toBe(2);
  });

  it('floors to whole contracts — never exceeds the risk budget', () => {
    // $100 / $40 per contract → 2.5 → 2, not 3
    const out = applyAccountFixedQuantityOverride(entry(), dest('risk', 99));
    expect(out.quantity).toBe(2);
  });

  it('sizes against the OUTBOUND micro contract when micros_only', () => {
    // NQ alert routed to MNQ: 80 ticks × $0.50 = $40/contract → $200 → 5
    const out = applyAccountFixedQuantityOverride(entry({ ticker: 'NQ1!' }), dest('risk', 200, 'micros_only'));
    expect(out.quantity).toBe(5);
    expect(out.ticker).toBe('NQ1!'); // ticker override is a separate step
  });

  it('mini contract tick values scale sizing down', () => {
    // NQ $5/tick, same 80-tick stop → $400/contract → $200 → 0.5 → min 1
    const out = applyAccountFixedQuantityOverride(entry({ ticker: 'NQ1!' }), dest('risk', 200));
    expect(out.quantity).toBe(1);
  });

  it('reads the strategy stop from extras when stopLoss is absent', () => {
    const out = applyAccountFixedQuantityOverride(
      entry({ stopLoss: undefined, extras: { strategyStopPrice: 29480 } }),
      dest('risk', 100),
    );
    expect(out.quantity).toBe(2);
  });

  it('resolves a percent stopLoss into distance', () => {
    // 0.5% of 29500 = 147.5 pts = 590 ticks @ $0.50 = $295/contract → $100 → 0.33 → 1
    const out = applyAccountFixedQuantityOverride(
      entry({ stopLoss: { percent: 0.5 } }),
      dest('risk', 100),
    );
    expect(out.quantity).toBe(1);
  });

  it('leaves the alert quantity when no stop distance is provable', () => {
    const out = applyAccountFixedQuantityOverride(
      entry({ stopLoss: undefined, extras: undefined }),
      dest('risk', 100),
    );
    expect(out.quantity).toBe(4); // unchanged — never guesses a size
  });

  it('leaves the alert quantity on an unrecognized ticker', () => {
    const out = applyAccountFixedQuantityOverride(entry({ ticker: 'XYZ1!' }), dest('risk', 100));
    expect(out.quantity).toBe(4);
  });

  it('gold (MGC) sizes at $1/tick', () => {
    // 200-pt stop = 2000 ticks × $1 = $2000/contract → $500 → 0.25 → min 1
    const out = applyAccountFixedQuantityOverride(
      entry({ ticker: 'MGC1!', stopPrice: 2400, stopLoss: { stopPrice: 2390 } }),
      dest('risk', 500),
    );
    // 10 pts = 100 ticks × $1 = $100/contract → $500 → 5
    expect(out.quantity).toBe(5);
  });
});

describe('existing modes unchanged', () => {
  it('percent still multiplies', () => {
    expect(applyAccountFixedQuantityOverride(entry(), dest('percent', 25)).quantity).toBe(1);
  });
  it('fixed still replaces', () => {
    expect(applyAccountFixedQuantityOverride(entry(), dest('fixed', 7)).quantity).toBe(7);
  });
  it('off passes through', () => {
    const destOff = { quantityOverrideMode: undefined, quantityOverrideValue: undefined };
    expect(applyAccountFixedQuantityOverride(entry(), destOff).quantity).toBe(4);
  });
});
