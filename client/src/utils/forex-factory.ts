import { useEffect, useState } from 'react'
import { getJson } from '../api/client'

const MONTH_ABBREVIATIONS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
] as const

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

const MONTH_INDEX_BY_ABBREVIATION: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function shiftedForexFactoryDate(now = new Date()): Date {
  return new Date(now.getTime() + (-4 * 60 * 60 * 1000))
}

function formatForexFactoryDate(date: Date): string {
  return `${MONTH_ABBREVIATIONS[date.getUTCMonth()]}${date.getUTCDate()}.${date.getUTCFullYear()}`
}

export interface ForexFactoryEvent {
  eventId: string
  date: string
  time: string
  currency: string
  title: string
  actual: string
  previous: string
  forecast: string
  impact: string
}

export interface ForexFactoryRangeView {
  source: 'ForexFactory'
  range: string
  timezone: string
  fetchedAt: string
  events: ForexFactoryEvent[]
  count: number
  cached: boolean
}

function forexFactoryWeekRangeForDate(date: Date): string {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 5))
  return `${formatForexFactoryDate(start)}-${formatForexFactoryDate(end)}`
}

export function currentForexFactoryWeekRange(now = new Date()): string {
  return forexFactoryWeekRangeForDate(shiftedForexFactoryDate(now))
}

export function currentForexFactoryMonthRange(now = new Date()): string {
  const shifted = shiftedForexFactoryDate(now)
  const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1))
  const end = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0))
  return `${formatForexFactoryDate(start)}-${formatForexFactoryDate(end)}`
}

export function formatForexFactoryEventDateLabel(date: Date): string {
  return `${WEEKDAY_LABELS[date.getUTCDay()]} ${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

export function monthRangeForKey(monthKey: string): string | undefined {
  const [year, month] = monthKey.split('-').map(Number)
  if (!year || !month || month < 1 || month > 12) return undefined
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(year, month, 0))
  return `${formatForexFactoryDate(start)}-${formatForexFactoryDate(end)}`
}

export function monthRangeFromHtml(
  html: string,
  now = new Date(),
): string | undefined {
  const plainText = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')

  const patterns = [
    /\b(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/gi,
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/gi,
  ]

  const counts = new Map<string, number>()
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(plainText)) != null) {
      const month = match[1].toLowerCase()
      counts.set(month, (counts.get(month) ?? 0) + 1)
    }
  }

  let bestMonth = ''
  let bestCount = 0
  for (const [month, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count
      bestMonth = month
    }
  }

  const monthIndex = MONTH_INDEX_BY_ABBREVIATION[bestMonth]
  if (monthIndex == null) return undefined

  const shifted = shiftedForexFactoryDate(now)
  const currentMonth = shifted.getUTCMonth()
  const currentYear = shifted.getUTCFullYear()
  const year = monthIndex < currentMonth ? currentYear + 1 : currentYear

  const start = new Date(Date.UTC(year, monthIndex, 1))
  const end = new Date(Date.UTC(year, monthIndex + 1, 0))
  return `${formatForexFactoryDate(start)}-${formatForexFactoryDate(end)}`
}

export function useForexFactoryEvents(
  monthKey: string | undefined,
): { events: ForexFactoryEvent[]; fetching: boolean } {
  const [events, setEvents] = useState<ForexFactoryEvent[]>([])
  const [fetching, setFetching] = useState(false)

  useEffect(() => {
    if (!monthKey) return
    const range = monthRangeForKey(monthKey)
    if (!range) return
    setFetching(true)
    getJson<ForexFactoryRangeView>(
      `/api/forex-factory/events?range=${range}&impact=high`,
    )
      .then((view) => setEvents(view.events))
      .catch(() => setEvents([]))
      .finally(() => setFetching(false))
  }, [monthKey])

  return { events, fetching }
}
