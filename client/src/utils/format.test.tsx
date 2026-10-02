import { describe, expect, it } from 'vitest'
import { annualizedSharpe, annualizedSharpeFromTrades, formatQuantity, journalDateKey } from './format'

describe('annualizedSharpe', () => {
  it('annualizes sample-standard-deviation Sharpe from daily returns', () => {
    const expected = Math.sqrt(252) * 0.02 / Math.sqrt(0.0002)
    expect(annualizedSharpe([0.01, 0.03])).toBeCloseTo(expected)
  })

  it('returns null when fewer than two daily observations exist', () => {
    expect(annualizedSharpe([])).toBeNull()
    expect(annualizedSharpe([0.01])).toBeNull()
  })

  it('returns null when daily returns have no variance', () => {
    expect(annualizedSharpe([0.01, 0.01, 0.01])).toBeNull()
  })

  it('rejects non-finite returns', () => {
    expect(annualizedSharpe([0.01, Number.NaN])).toBeNull()
  })
})

describe('annualizedSharpeFromTrades', () => {
  it('uses daily portfolio returns against rolling realized equity and ignores excluded trades', () => {
    const result = annualizedSharpeFromTrades(
      [
        { accountId: 'a', occurredAt: '2026-09-28T05:00:00.000Z', realizedDollarsCents: 10_000, excludedFromPerformance: false },
        { accountId: 'a', occurredAt: '2026-09-29T05:00:00.000Z', realizedDollarsCents: -5_000, excludedFromPerformance: false },
        { accountId: 'a', occurredAt: '2026-09-30T05:00:00.000Z', realizedDollarsCents: 500_000, excludedFromPerformance: true },
      ],
      [{ id: 'a', startingBalanceCents: 100_000 }],
    )
    const dailyReturns = [0.1, -5_000 / 110_000]
    const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / dailyReturns.length
    const variance = dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (dailyReturns.length - 1)
    expect(result).toBeCloseTo(Math.sqrt(252) * mean / Math.sqrt(variance))
  })

  it('returns null when an account with performance trades has no positive starting balance', () => {
    expect(annualizedSharpeFromTrades(
      [
        { accountId: 'a', occurredAt: '2026-09-28T05:00:00.000Z', realizedDollarsCents: 100, excludedFromPerformance: false },
        { accountId: 'a', occurredAt: '2026-09-29T05:00:00.000Z', realizedDollarsCents: -50, excludedFromPerformance: false },
      ],
      [{ id: 'a', startingBalanceCents: 0 }],
    )).toBeNull()
  })
})

describe('journalDateKey', () => {
  it('groups timestamps in the journal timezone', () => {
    expect(journalDateKey('2026-09-28T02:00:00.000Z')).toBe('2026-09-27')
    expect(journalDateKey('2026-09-28T05:00:00.000Z')).toBe('2026-09-28')
  })
})

describe('formatQuantity', () => {
  it('snaps float noise to integers and trims real fractions', () => {
    expect(formatQuantity(1.2000000000000002)).toBe('1')
    expect(formatQuantity(6)).toBe('6')
    expect(formatQuantity(0.5)).toBe('1')
    expect(formatQuantity(0.4)).toBe('0.4')
    expect(formatQuantity(1.23456789)).toBe('1')
    expect(formatQuantity(undefined)).toBe('—')
  })
})
