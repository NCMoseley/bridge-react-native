import { useEffect, useMemo, useState } from 'react'
import { LoadingSpinner } from './LoadingSpinner'
import { getJson } from '../api/client'
import {
  currentJournalDateKey,
  journalDateAtTime,
  journalDateFromKey,
} from '../utils/ranges'

interface ForexFactoryEvent {
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

interface ForexFactoryDayView {
  source: 'ForexFactory'
  day: string
  timezone: string
  fetchedAt: string
  events: ForexFactoryEvent[]
  count: number
  cached: boolean
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

function parseTime12(time: string): { hour: number; minute: number } | undefined {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})(am|pm)$/i)
  if (!match) return undefined
  const hour12 = Number(match[1])
  const minute = Number(match[2])
  const period = match[3].toLowerCase()
  const hour24 =
    period === 'pm'
      ? hour12 === 12
        ? 12
        : hour12 + 12
      : hour12 === 12
        ? 0
        : hour12
  return { hour: hour24, minute }
}

function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  const hours = Math.floor(abs / (60 * 60 * 1000))
  const minutes = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000))
  if (hours === 0 && minutes === 0) return '< 1m'
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  return parts.join(' ')
}

function eventDayLabel(eventAt: number): string {
  const todayKey = currentJournalDateKey()
  const eventKey = currentJournalDateKey(new Date(eventAt))
  if (eventKey === todayKey) return 'Today'
  const tomorrowKey = currentJournalDateKey(
    new Date(Date.now() + 24 * 60 * 60 * 1000),
  )
  if (eventKey === tomorrowKey) return 'Tomorrow'
  const date = journalDateFromKey(eventKey)
  return date.toLocaleDateString('en-US', {
    timeZone: 'Etc/GMT+4',
    weekday: 'long',
  })
}

function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function RedFolderPanel() {
  const [snapshot, setSnapshot] = useState<ForexFactoryDayView | undefined>(
    undefined,
  )
  const [fetching, setFetching] = useState(false)
  const day = currentJournalDateKey()
  const now = useNow()

  useEffect(() => {
    setFetching(true)
    getJson<ForexFactoryDayView>(
      `/api/forex-factory/events?day=${day}&impact=high`,
    )
      .then(setSnapshot)
      .catch(() => {})
      .finally(() => setFetching(false))
  }, [day])

  const upcoming = useMemo(() => {
    if (!snapshot) return []
    return snapshot.events
      .map((event) => {
        const parsed = parseTime12(event.time)
        const eventAt = parsed
          ? journalDateAtTime(day, parsed.hour, parsed.minute)
          : undefined
        const timeUntil = eventAt !== undefined ? eventAt - now : undefined
        return { event, eventAt, timeUntil }
      })
      .filter(
        (item): item is { event: ForexFactoryEvent; eventAt: number; timeUntil: number } =>
          item.eventAt !== undefined && item.timeUntil !== undefined && item.timeUntil > 0,
      )
  }, [day, now, snapshot])

  if (fetching) {
    return (
      <div className="flex items-center gap-2 text-slate-400">
        <LoadingSpinner size={14} />
        <span className="text-xs">Loading red folder…</span>
      </div>
    )
  }

  if (!snapshot || upcoming.length === 0) {
    return null
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {upcoming.map(({ event, eventAt, timeUntil }) => {
        const urgent =
          timeUntil !== undefined &&
          timeUntil > 0 &&
          timeUntil < TWO_HOURS_MS
        const label = eventDayLabel(eventAt!)
        const timer =
          timeUntil !== undefined
            ? timeUntil >= 0
              ? `in ${formatDuration(timeUntil)}`
              : `${formatDuration(timeUntil)} ago`
            : ''
        return (
          <div
            key={event.eventId}
            className={`flex items-center gap-1.5 rounded border bg-slate-950/50 px-2 py-1 ${
              urgent ? 'border-redfolder-600' : 'border-slate-700'
            }`}
          >
            <span className="rounded bg-redfolder-600 px-1 py-0.5 text-[10px] font-bold text-white">
              HIGH
            </span>
            <span className="truncate text-xs font-medium text-slate-100">
              {event.title}
            </span>
            <span className="text-[10px] text-slate-400">
              {label} at {event.time} · {event.currency}
            </span>
            {timer && (
              <span
                className={`text-[10px] ${
                  urgent ? 'font-semibold text-redfolder-400' : 'text-slate-400'
                }`}
              >
                {timer}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
