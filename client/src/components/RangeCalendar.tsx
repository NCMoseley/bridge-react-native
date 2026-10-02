import { useMemo, useRef, useState } from 'react'
import { getDeepLifePath } from '../utils/numerology'
import {
  classForCents,
  formatPnl,
  formatTicks,
  formatPercent,
  calendarMonthLabel,
} from '../utils/format'
import { postForm } from '../api/client'
import { useToast } from '../context/ToastContext'
import { journalDateFromKey, currentJournalDateKey } from '../utils/ranges'
import {
  formatForexFactoryEventDateLabel,
  type ForexFactoryEvent,
} from '../utils/forex-factory'
import type { CalendarDay, TradeCalendarMonthView } from '../types'

interface RangeCalendarProps {
  calendar: TradeCalendarMonthView
  className?: string
  rangeName?: string
  onRefresh?: () => void
  onDayClick?: (day: CalendarDay) => void
  redFolderEvents?: ForexFactoryEvent[]
}

function daysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number)
  return new Date(year, month, 0).getDate()
}

function monthOffset(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number)
  return new Date(year, month - 1, 1).getDay()
}

function RedDot({ events }: { events: ForexFactoryEvent[] }) {
  const [show, setShow] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setShow(true), 300)
  }
  const handleLeave = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setShow(false)
  }

  return (
    <div
      className="relative inline-flex h-4 w-4 cursor-help items-center justify-center"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <span className="h-3 w-3 rounded-full bg-redfolder-500" />
      {show && (
        <div className="absolute right-0 top-full z-10 mt-1 w-44 rounded border border-redfolder-600/50 bg-slate-900 p-2 text-xs shadow-xl">
          {events.map((event) => (
            <div key={event.eventId} className="mb-1 last:mb-0">
              <div className="truncate font-semibold text-slate-200">
                {event.title}
              </div>
              <div className="text-slate-400">
                <span className="text-redfolder-400">{event.time}</span>
                <span> · </span>
                <span>{event.currency}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function RangeCalendar({
  calendar,
  className = '',
  rangeName,
  onRefresh,
  onDayClick,
  redFolderEvents = [],
}: RangeCalendarProps) {
  const { success, error } = useToast()

  const toggleHidden = (dateKey: string, currentlyHidden: boolean) => {
    if (!rangeName || !onRefresh) return
    const nextHidden = !currentlyHidden
    postForm('/ranges/calendar/day-visibility', {
      rangeName,
      dateKey,
      hidden: String(nextHidden),
      month: calendar.month,
    })
      .then(() => {
        success(nextHidden ? 'Day excluded' : 'Day included')
        onRefresh()
      })
      .catch((err) => {
        console.error('Failed to toggle day visibility:', err)
        error(err instanceof Error ? err.message : 'Failed to update day')
      })
  }

  const dayMap = new Map(calendar.days.map((day) => [day.date, day]))
  const trailingMap = new Map((calendar.trailingDays ?? []).map((day) => [day.date, day]))

  const eventsByDate = useMemo(() => {
    const map = new Map<string, ForexFactoryEvent[]>()
    for (const event of redFolderEvents) {
      if (event.impact.toLowerCase() !== 'high') continue
      const list = map.get(event.date) ?? []
      list.push(event)
      map.set(event.date, list)
    }
    return map
  }, [redFolderEvents])

  const prefix = `${calendar.month}-`
  const offset = monthOffset(calendar.month)
  const totalDays = daysInMonth(calendar.month)
  // Trailing days of the previous month — fills the leading empty cells.
  const [year, month] = calendar.month.split('-').map(Number)
  const prevMonthDays = new Date(year, month - 1, 0).getDate()
  const prevMonthKey = `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}`
  const summary = calendar.summary
  const summaryClass = classForCents(summary.netTicksCents)
  const todayKey = currentJournalDateKey()

  const headerDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-100">
            {calendarMonthLabel(calendar.month)}
          </h3>
          <p className="text-sm text-slate-400">
            Daily ticks, trigger count, and win/loss mix.
          </p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-6">
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
          <div className="text-xs text-slate-400">Monthly P&L</div>
          <div
            className={`text-lg font-bold ${classForCents(
              summary.realizedDollarsCents,
            )}`}
          >
            {formatPnl(summary.realizedDollarsCents)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
          <div className="text-xs text-slate-400">Monthly ticks</div>
          <div className={`text-lg font-bold ${summaryClass}`}>
            {formatTicks(summary.netTicksCents)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
          <div className="text-xs text-slate-400">Triggered</div>
          <div className="text-lg font-bold text-slate-100">
            {summary.closedCount}
          </div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
          <div className="text-xs text-slate-400">Wins / losses</div>
          <div className="text-lg font-bold text-slate-100">
            {summary.wins} / {summary.losses}
          </div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
          <div className="text-xs text-slate-400">Win rate</div>
          <div className="text-lg font-bold text-slate-100">
            {formatPercent(summary.winRate)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
          <div className="text-xs text-slate-400">R earned</div>
          <div
            className={`text-lg font-bold ${
              (summary.rEarned ?? 0) > 0
                ? 'text-positive'
                : (summary.rEarned ?? 0) < 0
                  ? 'text-negative-400'
                  : 'text-slate-100'
            }`}
          >
            {summary.rEarned == null
              ? '—'
              : `${summary.rEarned > 0 ? '+' : ''}${summary.rEarned.toFixed(1)}R`}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-900 p-3">
        <div
          className="mb-2 hidden grid-cols-7 gap-2 text-center text-xs font-semibold text-slate-400 lg:grid"
        >
          {headerDays.map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-7">
          {Array.from({ length: offset }, (_, i) => {
            const dayNumber = prevMonthDays - offset + i + 1
            const dateKey = `${prevMonthKey}-${String(dayNumber).padStart(2, '0')}`
            const day = trailingMap.get(dateKey)
            return (
              <div
                key={`prev-${i}`}
                className="hidden min-h-[11rem] rounded-lg border border-dashed border-slate-700/50 bg-slate-900/20 p-2 text-xs opacity-60 lg:block"
              >
                <div className="flex items-start justify-between">
                  <span className="font-bold text-slate-500">{dayNumber}</span>
                  <span className="text-[10px] font-semibold text-slate-600">
                    LP {getDeepLifePath(dateKey).lifePathNumber}
                  </span>
                </div>
                {day && (
                  <div className="mt-2 space-y-0.5">
                    <div className={`text-sm font-bold ${classForCents(day.realizedDollarsCents)}`}>
                      {formatPnl(day.realizedDollarsCents)}
                    </div>
                    <div className="text-slate-500">
                      {day.closedCount} trade{day.closedCount === 1 ? '' : 's'} · W/L {day.wins}/{day.losses}
                    </div>
                    <div className="text-slate-500">Rate {formatPercent(day.winRate)}</div>
                  </div>
                )}
              </div>
            )
          })}
          {Array.from({ length: totalDays }, (_, i) => {
            const dayNumber = i + 1
            const dateKey = `${prefix}${String(dayNumber).padStart(2, '0')}`
            const day = dayMap.get(dateKey)
            const numerology = getDeepLifePath(dateKey)
            const hidden = day?.hiddenFromPerformance ?? false
            const dateLabel = formatForexFactoryEventDateLabel(
              journalDateFromKey(dateKey),
            )
            const dayRedEvents = eventsByDate.get(dateLabel) ?? []

            const isBeDay =
              day && day.netTicksCents === 0 && (day?.closedCount ?? 0) > 0
            const isGrey =
              !day ||
              hidden

            const cardClass = day
              ? isBeDay
                ? 'border border-positive-500/50 bg-positive-950/20'
                : isGrey
                  ? 'border border-slate-600 bg-slate-800/60 text-slate-400'
                  : day.realizedDollarsCents > 0
                    ? 'border border-positive-500/50 bg-positive-950/20'
                    : 'border border-negative-500/50 bg-negative-950/20'
              : 'border border-dashed border-slate-700/50 bg-slate-900/20'

            return (
              <div
                key={dateKey}
                className={`flex min-h-[11rem] flex-col justify-between rounded-lg p-2 text-xs ${cardClass}`}
              >
                <div className="flex items-start justify-between">
                  <span className="font-bold text-slate-100">{dayNumber}</span>
                  <div className="flex items-center gap-1.5">
                    {dayRedEvents.length > 0 && <RedDot events={dayRedEvents} />}
                    <span className="text-[10px] font-semibold text-indigo-300">
                      LP {numerology.lifePathNumber}
                    </span>
                  </div>
                </div>
                {day ? (
                  <div
                    onClick={() => onDayClick && onDayClick(day)}
                    className="space-y-0.5 cursor-pointer"
                  >
                    <div
                      className={`text-base font-bold ${
                        isBeDay ? 'text-positive' : classForCents(day.realizedDollarsCents)
                      }`}
                    >
                      {formatPnl(day.realizedDollarsCents)}
                    </div>
                    <div className="text-slate-400">
                      {day.closedCount} trade
                      {day.closedCount === 1 ? '' : 's'} · {day.ranges.length}{' '}
                      range
                      {day.ranges.length === 1 ? '' : 's'}
                    </div>
                    <div className="text-slate-400">
                      W/L{' '}
                      <span className="text-positive">{day.wins}</span>
                      <span className="text-slate-500">/</span>
                      <span className="text-negative-400">{day.losses}</span>
                    </div>
                    <div className="text-slate-400">
                      Rate {formatPercent(day.winRate)}
                    </div>
                    {hidden ? (
                      <div>
                        <span className="rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-300">
                          Excluded
                        </span>
                      </div>
                    ) : isBeDay ? (
                      <div>
                        <span className="rounded bg-positive-900 px-1.5 py-0.5 text-[10px] font-semibold text-positive-100">
                          BE
                        </span>
                      </div>
                    ) : null}
                    {day && rangeName && (
                      <div className="mt-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            toggleHidden(day.date, hidden)
                          }}
                          className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200 hover:bg-slate-600"
                        >
                          {hidden ? 'Include' : 'Exclude'}
                        </button>
                      </div>
                    )}
                    {day && onDayClick && (
                      <div className="mt-1">
                        <div className="mt-2 text-xs font-semibold text-slate-200 hover:text-white">
                          Details
                        </div>
                      </div>
                    )}
                  </div>
                ) : dateKey <= todayKey ? (
                  <div className="mt-auto text-slate-500">No trades</div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
