import { useEffect, useMemo, useState } from 'react'
import { getJson } from '../api/client'
import { LoadingSpinner } from './LoadingSpinner'
import { CollapsibleSection } from './CollapsibleSection'
import { currentJournalDateKey, journalDateFromKey } from '../utils/ranges'
import {
  currentForexFactoryWeekRange,
  formatForexFactoryEventDateLabel,
  type ForexFactoryEvent,
  type ForexFactoryRangeView,
} from '../utils/forex-factory'

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const DAY_LABELS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

function startOfWeekMonday(date: Date): Date {
  const day = date.getUTCDay()
  const dayOffset =
    day === 0 ? 1 : day === 6 ? 2 : 1 - day
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + dayOffset,
    ),
  )
}

function timeBadge(time: string): string {
  const normalized = time.toLowerCase().replace(/\s/g, '')
  if (normalized === 'tentative' || normalized.includes('day')) {
    return time
  }
  return time
}

function miniDayClasses(hasHigh: boolean, hasMedium: boolean, isToday: boolean): string {
  let base = 'flex flex-col items-center rounded border px-1.5 py-0.5 leading-tight '
  if (hasHigh) {
    base += 'border-redfolder-600/50 bg-redfolder-600/20 '
  } else if (hasMedium) {
    base += 'border-amber-400/60 bg-amber-400/15 '
  } else {
    base += 'border-slate-700 bg-slate-900 '
  }
  if (isToday) {
    base += 'ring-1 ring-white/70'
  }
  return base
}

function dayClasses(hasHigh: boolean, hasMedium: boolean, isToday: boolean): string {
  let base = 'flex min-h-[8rem] flex-col rounded border p-2 '
  if (hasHigh && hasMedium) {
    base +=
      'border-redfolder-600/50 bg-gradient-to-br from-redfolder-600/30 via-redfolder-500/20 to-redfolder-900/25 '
  } else if (hasHigh) {
    base +=
      'border-redfolder-600/50 bg-gradient-to-br from-redfolder-600/30 to-redfolder-900/25 '
  } else if (hasMedium) {
    base +=
      'border-amber-400/60 bg-gradient-to-br from-amber-400/25 to-yellow-500/15 '
  } else {
    base += 'border-slate-700 bg-slate-900 '
  }
  if (isToday) {
    base += 'ring-2 ring-white ring-offset-2 ring-offset-slate-950'
  }
  return base
}

export function RedFolderMiniCalendar() {
  const [snapshot, setSnapshot] = useState<ForexFactoryRangeView | undefined>(
    undefined,
  )
  const [fetching, setFetching] = useState(false)
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const weekRange = currentForexFactoryWeekRange()

  useEffect(() => {
    setFetching(true)
    getJson<ForexFactoryRangeView>(
      `/api/forex-factory/events?range=${weekRange}&impact=all`,
    )
      .then(setSnapshot)
      .catch(() => {})
      .finally(() => setFetching(false))
  }, [weekRange])

  const days = useMemo(() => {
    const today = journalDateFromKey(currentJournalDateKey())
    const monday = startOfWeekMonday(today)
    return Array.from({ length: 5 }, (_, index) => {
      const date = new Date(
        Date.UTC(
          monday.getUTCFullYear(),
          monday.getUTCMonth(),
          monday.getUTCDate() + index,
        ),
      )
      const label = formatForexFactoryEventDateLabel(date)
      const allEvents =
        snapshot?.events.filter((event) => event.date === label) ?? []
      const highEvents = allEvents.filter(
        (event) => event.impact.toLowerCase() === 'high',
      )
      const mediumEvents = allEvents.filter(
        (event) => event.impact.toLowerCase() === 'medium',
      )
      const isToday =
        date.getUTCDate() === today.getUTCDate() &&
        date.getUTCMonth() === today.getUTCMonth() &&
        date.getUTCFullYear() === today.getUTCFullYear()
      return { date, label, highEvents, mediumEvents, isToday, index }
    })
  }, [snapshot])

  const todayHasRed =
    (days.find((d) => d.isToday)?.highEvents.length ?? 0) > 0
  const isOpen = userOpen ?? todayHasRed

  if (fetching) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <div className="flex items-center gap-2 text-slate-400">
          <LoadingSpinner size={14} />
          <span className="text-xs">Loading news calendar…</span>
        </div>
      </div>
    )
  }

  if (!snapshot || snapshot.events.length === 0) {
    return null
  }

  function eventCard(event: ForexFactoryEvent, colorClass: string) {
    return (
      <div
        key={event.eventId}
        className="rounded bg-slate-950/40 px-1 py-0.5"
        title={`${event.title} · ${event.currency}`}
      >
        <div className="truncate text-[10px] font-semibold text-slate-200">
          {event.title}
        </div>
        <div className="flex items-center gap-1 text-[9px] text-slate-400">
          <span className={colorClass}>{timeBadge(event.time)}</span>
          <span>·</span>
          <span>{event.currency}</span>
        </div>
      </div>
    )
  }

  const titleNode = (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span>News</span>
      {!isOpen && (
        <div className="hidden flex-1 items-center gap-2 md:flex">
          {days.map(({ date, highEvents, mediumEvents, isToday, index }) => (
            <div
              key={index}
              className={`flex-1 ${miniDayClasses(
                highEvents.length > 0,
                mediumEvents.length > 0,
                isToday,
              )}`}
              title={
                highEvents.length
                  ? `${highEvents.length} high-impact event${highEvents.length > 1 ? 's' : ''}`
                  : mediumEvents.length
                    ? `${mediumEvents.length} medium-impact event${mediumEvents.length > 1 ? 's' : ''}`
                    : 'No news'
              }
            >
              <span className="text-[10px] font-bold text-slate-300">
                {DAY_LABELS_FULL[index]}
              </span>
              <span className="text-[9px] text-slate-400">
                {formatForexFactoryEventDateLabel(date)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <CollapsibleSection
      title={titleNode}
      open={isOpen}
      onToggle={() => setUserOpen((prev) => !(prev ?? todayHasRed))}
      className={
        todayHasRed
          ? 'rounded-xl border border-slate-700 bg-gradient-to-br from-slate-900 via-redfolder-950/30 to-redfolder-950/20'
          : 'rounded-xl border border-slate-700 bg-slate-800'
      }
    >
      <div className="flex flex-col md:grid w-full grid-cols-5 gap-2">
        {days.map(({ date, highEvents, mediumEvents, isToday, index }) => {
          const hasHigh = highEvents.length > 0
          const hasMedium = mediumEvents.length > 0
          const dayNameColor = hasHigh
            ? 'text-redfolder-400'
            : hasMedium
              ? 'text-slate-100'
              : 'text-slate-400'

          return (
            <div
              key={index}
              className={dayClasses(hasHigh, hasMedium, isToday)}
            >
              <div className="mb-1 border-b border-slate-700/50 pb-1">
                <div
                  className={`text-sm font-bold ${dayNameColor}`}
                >
                  {DAY_LABELS[index]}
                </div>
                <div className="text-[10px] text-slate-500">
                  {formatForexFactoryEventDateLabel(date)}
                </div>
              </div>

              {highEvents.length === 0 && mediumEvents.length === 0 ? (
                <div className="mt-auto text-[10px] text-slate-600">
                  No news
                </div>
              ) : (
                <div className="flex flex-1 flex-col gap-1 overflow-hidden">
                  {highEvents.map((event) =>
                    eventCard(event, 'text-redfolder-400'),
                  )}
                  {mediumEvents.map((event) =>
                    eventCard(event, 'text-amber-300'),
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}
