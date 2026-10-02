export const JOURNAL_TIME_ZONE = 'Etc/GMT+4'

export function formatDollars(cents: number): string {
  const absolute = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}$${(absolute / 100).toFixed(2)}`
}

export function formatPnl(cents: number): string {
  return cents > 0 ? `+${formatDollars(cents)}` : formatDollars(cents)
}

export function formatTicks(cents: number): string {
  const value = cents / 100
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
}

export function formatPercent(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(1)}%`
}

export function formatQuantity(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 0.5) return String(Math.round(value))
  return String(Number(value.toFixed(4)))
}

export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return String(value)
}

export function journalDateKey(date: Date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: JOURNAL_TIME_ZONE })
}

export function journalMonthKey(date: Date = new Date()): string {
  return journalDateKey(date).slice(0, 7)
}

export function formatJournalDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-')
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), 16),
  ).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: JOURNAL_TIME_ZONE,
  })
}

export function calendarMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-')
  if (!year || !month) return '—'
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, 1, 16),
  ).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: JOURNAL_TIME_ZONE,
  })
}
