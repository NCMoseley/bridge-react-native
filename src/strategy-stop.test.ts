import { describe, expect, it } from 'vitest';
import { strategyStopPresentation } from '../extension/src/shared.js';
import { strategyStopMetadata, tradersPostPayloadSchema } from './webhook.js';

describe('strategy stop metadata', () => {
  it('parses valid display-only metadata and keeps a root broker stop authoritative', () => {
    expect(strategyStopMetadata({
      strategyStopPrice: 23025,
      strategyStopMode: 'close_confirmed',
    })).toEqual({
      strategyStopPrice: 23025,
      strategyStopMode: 'close_confirmed',
    });
    expect(strategyStopPresentation({
      strategyStopPrice: 23025,
      strategyStopMode: 'close_confirmed',
    })).toEqual({
      label: 'Strategy stop (close-confirmed)',
      price: 23025,
    });
    expect(strategyStopPresentation({
      stopLoss: { type: 'stop', stopPrice: 23020 },
      strategyStopPrice: 23025,
      strategyStopMode: 'close_confirmed',
    })).toBeUndefined();
  });

  it('ignores malformed strategy stop metadata without rejecting a legacy-compatible payload', () => {
    const parsed = tradersPostPayloadSchema.safeParse({
      ticker: 'MNQ1!',
      action: 'buy',
      quantity: 1,
      extras: {
        strategyStopPrice: '23025',
        strategyStopMode: 'not-a-stop-mode',
      },
    });
    expect(parsed.success).toBe(true);
    expect(strategyStopMetadata(parsed.success ? parsed.data.extras : undefined)).toEqual({});
    expect(strategyStopMetadata({ strategyStopPrice: 0, strategyStopMode: 'intrabar' })).toEqual({});
    expect(strategyStopMetadata({ strategyStopPrice: Number.POSITIVE_INFINITY, strategyStopMode: 'intrabar' })).toEqual({});
    expect(strategyStopMetadata({ strategyStopPrice: 23025, strategyStopMode: 'invalid' })).toEqual({
      strategyStopPrice: 23025,
    });
  });
});
