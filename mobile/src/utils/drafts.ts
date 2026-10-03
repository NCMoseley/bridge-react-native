import type { OrderDraft } from '../types'

export function priceIncrement(ticker: string): number {
  if (ticker.startsWith('MGC') || ticker.startsWith('GC')) return 0.1
  if (ticker.startsWith('MCL') || ticker.startsWith('CL')) return 0.01
  if (ticker.startsWith('MBT') || ticker.startsWith('BT')) return 5
  return 0.25
}

export function roundPrice(ticker: string, price: number): number {
  const increment = priceIncrement(ticker)
  return Math.round((price + Number.EPSILON) / increment) * increment
}

export function formatPrice(ticker: string, price: number | undefined): string {
  if (price == null) return 'Not provided'
  const increment = priceIncrement(ticker)
  const decimals = increment >= 1 ? 0 : increment === 0.1 ? 1 : 2
  return roundPrice(ticker, price).toFixed(decimals)
}

export function entryPrice(draft: OrderDraft): number | undefined {
  return draft.stopPrice ?? draft.limitPrice ?? draft.signalPrice
}

// Ultra v5.0 sends percent as a decimal fraction (e.g. 0.003373 = 0.337%);
// older versions send a percent value (e.g. 0.02 = 0.02%). Mirrors the
// server's percentAsDecimal heuristic in src/server.ts.
const PERCENT_FRACTION_THRESHOLD = 0.01

export function percentAsDecimal(percent: number): number {
  return percent < PERCENT_FRACTION_THRESHOLD ? percent : percent / 100
}

export function absoluteProtection(
  draft: OrderDraft,
  field: 'takeProfit' | 'stopLoss',
): number | undefined {
  const protection = draft[field]
  if (!protection) return undefined
  const directPrice = field === 'takeProfit' ? protection.limitPrice : protection.stopPrice
  if (typeof directPrice === 'number') return directPrice
  const percent = protection.percent
  const entry = entryPrice(draft)
  if (typeof percent !== 'number' || entry == null) return undefined
  const decimal = percentAsDecimal(percent)
  const isBuy = draft.action === 'buy'
  if (field === 'takeProfit') return entry * (isBuy ? 1 + decimal : 1 - decimal)
  return entry * (isBuy ? 1 - decimal : 1 + decimal)
}

function tickDistance(ticker: string, from: number, to: number): number {
  const distance = Math.abs(roundPrice(ticker, from) - roundPrice(ticker, to))
  return Math.round(distance / priceIncrement(ticker))
}

export function formatProtection(
  draft: OrderDraft,
  field: 'takeProfit' | 'stopLoss',
): string {
  const protection = draft[field]
  const absolute = absoluteProtection(draft, field)
  const entry = entryPrice(draft)
  if (!protection || absolute == null) return 'Not provided'
  const parts = [formatPrice(draft.ticker, absolute)]
  if (entry != null) {
    const ticks = tickDistance(draft.ticker, absolute, entry)
    parts.push(`${ticks} tick${ticks === 1 ? '' : 's'}`)
  }
  return parts.join(' | ')
}

export function strategyStopPresentation(
  draft: Pick<OrderDraft, 'stopLoss' | 'strategyStopPrice' | 'strategyStopMode'>,
): { label: string; price: number } | undefined {
  if (draft.stopLoss || draft.strategyStopPrice == null) return undefined
  return {
    label:
      draft.strategyStopMode === 'close_confirmed'
        ? 'Strategy stop (close-confirmed)'
        : 'Strategy stop',
    price: draft.strategyStopPrice,
  }
}

export function formatStrategyStop(draft: OrderDraft, strategyStopPrice: number): string {
  const parts = [formatPrice(draft.ticker, strategyStopPrice)]
  const entry = entryPrice(draft)
  if (entry != null) {
    const ticks = tickDistance(draft.ticker, strategyStopPrice, entry)
    parts.push(`${ticks} tick${ticks === 1 ? '' : 's'}`)
  }
  return parts.join(' | ')
}

export function formatDraftAge(receivedAt: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(receivedAt).getTime()) / 1000))
  const hours = Math.floor(elapsedSeconds / 3600)
  const minutes = Math.floor((elapsedSeconds % 3600) / 60)
  const seconds = elapsedSeconds % 60
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s old` : `${minutes}m ${seconds}s old`
}
