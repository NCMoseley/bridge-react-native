import { describe, expect, it } from 'vitest';
import { defaultMicroContinuousTicker, formatPrice, resolveContinuousTicker } from '../extension/src/shared.js';

describe('continuous contract mapping', () => {
  it('defaults full-size continuous index and gold alerts to micros', () => {
    expect(defaultMicroContinuousTicker('NQ1!')).toBe('MNQ1!');
    expect(defaultMicroContinuousTicker('GC1!')).toBe('MGC1!');
    expect(defaultMicroContinuousTicker('CL1!')).toBe('MCL1!');
    expect(defaultMicroContinuousTicker('BT1!')).toBe('MBT1!');
  });

  it('resolves micro and full-size contracts to their matching front month', () => {
    const date = new Date(2026, 6, 30);
    expect(resolveContinuousTicker('MNQ1!', date)).toBe('MNQU6');
    expect(resolveContinuousTicker('NQ1!', date)).toBe('NQU6');
    expect(resolveContinuousTicker('MGC1!', date)).toBe('MGCQ6');
    expect(resolveContinuousTicker('GC1!', date)).toBe('GCQ6');
    expect(resolveContinuousTicker('MCL1!', date)).toBe('MCLN6');
    expect(resolveContinuousTicker('CL1!', date)).toBe('CLN6');
    expect(resolveContinuousTicker('MBT1!', date)).toBe('MBTN6');
    expect(resolveContinuousTicker('BT1!', date)).toBe('BTN6');
  });

  it('uses bitcoin tick sizing when formatting bt-family prices', () => {
    expect(formatPrice('MBT1!', 114237)).toBe('114235');
    expect(formatPrice('BT1!', 114238)).toBe('114240');
  });

  it('uses oil tick sizing when formatting cl-family prices', () => {
    expect(formatPrice('MCL1!', 67.126)).toBe('67.13');
    expect(formatPrice('CL1!', 67.124)).toBe('67.12');
  });
});
