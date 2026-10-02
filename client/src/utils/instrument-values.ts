const FUTURES_ROOTS = [
  'M2K',
  'MCL',
  'MGC',
  'MES',
  'MNQ',
  'MYM',
  'RTY',
  'SIL',
  'BTC',
  'MBT',
  'NQ',
  'ES',
  'GC',
  'SI',
  'CL',
  'NG',
  'YM',
].sort((a, b) => b.length - a.length)

export function futuresRootFromTicker(ticker: string): string {
  const normalized = ticker.trim().toUpperCase()
  for (const root of FUTURES_ROOTS) {
    if (normalized.startsWith(root)) return root
  }
  return normalized.replace(/[^A-Z]/gi, '').slice(0, 4).toUpperCase()
}

export function inferredTickSize(ticker: string): number {
  const root = futuresRootFromTicker(ticker)
  if (['MNQ', 'NQ', 'MES', 'ES', 'RTY', 'M2K', 'MYM', 'YM'].includes(root)) return 0.25
  if (['MGC', 'GC', 'SIL', 'SI'].includes(root)) return 0.1
  if (['CL', 'MCL', 'NG', 'MBT', 'BTC'].includes(root)) return 0.01
  return 0.25
}

const POINT_VALUES: Record<string, number> = {
  NQ: 20,
  MNQ: 2,
  ES: 50,
  MES: 5,
  YM: 5,
  MYM: 0.5,
  RTY: 50,
  M2K: 5,
  GC: 100,
  MGC: 10,
  SI: 5000,
  SIL: 500,
  CL: 1000,
  MCL: 100,
  NG: 10000,
}

export function inferredPointValue(ticker: string): number {
  const root = futuresRootFromTicker(ticker)
  return POINT_VALUES[root] ?? 1
}

export function inferredDollarPerTick(ticker: string): number {
  return inferredTickSize(ticker) * inferredPointValue(ticker)
}
