import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RangeCalendar } from '../components/RangeCalendar'
import { EquityChart } from '../components/ModelEquityChart'
import { RingChart } from '../components/RingChart'
import { BalanceBar } from '../components/BalanceBar'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { TradeAdjustForm } from '../components/TradeAdjustForm'
import { getCachedRanges, getCachedRangesOptimistic, setCachedRanges } from '../utils/ranges-cache'
import { useAuth } from '../context/AuthContext'
import { getJson } from '../api/client'
import {
  classForCents,
  formatDollars,
  formatJournalDateKey,
  formatPercent,
  formatPnl,
  formatQuantity,
  formatTicks,
} from '../utils/format'
import { journalDateFromKey } from '../utils/ranges'
import {
  formatForexFactoryEventDateLabel,
  useForexFactoryEvents,
} from '../utils/forex-factory'
import type { CalendarDay, RangeTradeEvent, TradeCalendarMonthView } from '../types'
import { JournalDate } from '../components/JournalDate'
import { displayInstrument } from '../utils/instruments'
import { placeholderMonthView } from '../utils/calendar-placeholder'

type RangesData = NonNullable<ReturnType<typeof getCachedRanges>>

function thisMonth(): string {
  const shifted = new Date(Date.now() - 4 * 60 * 60 * 1000)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function MetricsPanel({
  calendar,
}: {
  calendar: TradeCalendarMonthView
}) {
  const { summary } = calendar
  const winRate =
    summary.winRate == null
      ? 0
      : Math.max(0, Math.min(100, summary.winRate * 100))
  const avgWinAbs =
    summary.averageWinDollarsCents == null
      ? 0
      : Math.abs(summary.averageWinDollarsCents)
  const avgLossAbs =
    summary.averageLossDollarsCents == null
      ? 0
      : Math.abs(summary.averageLossDollarsCents)
  const avgTotal = Math.max(1, avgWinAbs + avgLossAbs)
  const avgWinPct = Math.round((avgWinAbs / avgTotal) * 100)
  const avgLossPct = 100 - avgWinPct
  const avgWinLossValue =
    avgWinAbs === 0 && avgLossAbs === 0
      ? '—'
      : `${formatDollars(avgWinAbs)} / ${formatDollars(avgLossAbs)}`

  // Max drawdown: deepest peak-to-trough decline on the cumulative daily
  // P/L curve. Days hidden from performance are excluded, matching the
  // other cards' denominators.
  let peak = 0
  let cumulative = 0
  let maxDrawdownCents = 0
  let peakDate: string | null = null
  let ddPeakDate: string | null = null
  let ddTroughDate: string | null = null
  for (const day of [...calendar.days].sort((a, b) => a.date.localeCompare(b.date))) {
    if (day.hiddenFromPerformance) continue
    cumulative += day.realizedDollarsCents
    if (cumulative > peak) {
      peak = cumulative
      peakDate = day.date
    }
    if (peak - cumulative > maxDrawdownCents) {
      maxDrawdownCents = peak - cumulative
      ddPeakDate = peakDate
      ddTroughDate = day.date
    }
  }

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-4">
        <Card title="Trade win %">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <RingChart
              positive={winRate}
              negative={Math.max(0, 100 - winRate)}
              label={formatPercent(summary.winRate)}
            />
            <div className="space-y-1 text-sm">
              <div className="text-slate-400">
                Wins{' '}
                <strong className="text-slate-100">{summary.wins}</strong>
              </div>
              <div className="text-slate-400">
                Losses{' '}
                <strong className="text-slate-100">{summary.losses}</strong>
              </div>
              <div className="text-slate-400">
                BE{' '}
                <strong className="text-slate-100">{summary.breakevens}</strong>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Avg win/loss">
          <div className="mb-3 text-2xl font-bold text-slate-100">
            {avgWinLossValue}
          </div>
          <BalanceBar positive={avgWinPct} negative={avgLossPct} />
          <div className="mt-3 space-y-1 text-sm">
            <div className="text-slate-400">
              Avg win{' '}
              <strong className="text-slate-100">
                {summary.averageWinDollarsCents == null
                  ? '—'
                  : formatDollars(summary.averageWinDollarsCents)}
              </strong>
            </div>
            <div className="text-slate-400">
              Avg loss{' '}
              <strong className="text-slate-100">
                {summary.averageLossDollarsCents == null
                  ? '—'
                  : formatDollars(summary.averageLossDollarsCents)}
              </strong>
            </div>
          </div>
        </Card>

        <Card title="Max drawdown">
          <div className="mb-3 text-2xl font-bold text-slate-100">
            {maxDrawdownCents > 0 ? formatDollars(-maxDrawdownCents) : '—'}
          </div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="text-slate-400">
              Peak{' '}
              <strong className="text-slate-100">{ddPeakDate ?? '—'}</strong>
            </div>
            <div className="text-slate-400">
              Trough{' '}
              <strong className="text-slate-100">{ddTroughDate ?? '—'}</strong>
            </div>
          </div>
        </Card>

        <Card title="R earned">
          <div
            className={`mb-3 text-2xl font-bold ${
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
          <div className="mt-3 space-y-1 text-sm">
            <div className="text-slate-400">
              Realized{' '}
              <strong className="text-slate-100">
                {formatDollars(summary.realizedDollarsCents)}
              </strong>
            </div>
            <div className="text-slate-400">
              Trades{' '}
              <strong className="text-slate-100">{summary.closedCount}</strong>
            </div>
          </div>
        </Card>
      </div>
    </>
  )
}

export function CategoryCalendarPage() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [subcategory, setSubcategory] = useState(searchParams.get('category') ?? '')
  const [month, setMonth] = useState(searchParams.get('month') ?? thisMonth())
  const [week, setWeek] = useState<string>(() => searchParams.get('week') ?? '')
  const [includedRanges, setIncludedRanges] = useState<string[]>(
    searchParams.get('ranges')?.split(',').filter(Boolean) ?? [],
  )
  const [rangesData, setRangesData] = useState<RangesData | undefined>(() => getCachedRangesOptimistic())
  const [serverCalendar, setServerCalendar] = useState<TradeCalendarMonthView | undefined>()
  const [fetching, setFetching] = useState(false)
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null)
  const [editingTrade, setEditingTrade] = useState<RangeTradeEvent | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const { events: redFolderEvents } = useForexFactoryEvents(month)
  const placeholderCalendar = useMemo(() => placeholderMonthView(month), [month])

  useEffect(() => {
    if (!user?.userId) return
    const userId = user.userId
    getJson<RangesData>('/api/ranges')
      .then((data) => {
        setRangesData(data)
        setCachedRanges(data, userId)
      })
      .catch((err) => console.error('Failed to load ranges:', err))
  }, [user?.userId])

  const subcategories = useMemo(
    () => rangesData?.rangeSubcategories ?? [],
    [rangesData],
  )

  const assignedRangeNames = useMemo(() => {
    const assignments = rangesData?.rangeSubcategoryAssignments ?? []
    if (!subcategory) return []
    return [
      ...new Set(
        assignments
          .filter((a) => a.subcategoryName === subcategory)
          .map((a) => a.rangeName),
      ),
    ]
  }, [rangesData, subcategory])

  const updateSearchParams = useCallback(
    (next: { category?: string; month?: string; week?: string; ranges?: string }) => {
      const params = new URLSearchParams(searchParams)
      Object.entries(next).forEach(([key, value]) => {
        if (value) params.set(key, value)
        else params.delete(key)
      })
      setSearchParams(params)
    },
    [searchParams, setSearchParams],
  )

  const fetchCalendar = useCallback(() => {
    if (!subcategory || !month) return
    setFetching(true)
    const rangeParam =
      includedRanges.length > 0
        ? `&ranges=${encodeURIComponent(includedRanges.join(','))}`
        : ''
    const weekParam = week ? `&week=${encodeURIComponent(week)}` : ''
    getJson<TradeCalendarMonthView>(
      `/api/category/calendar?subcategory=${encodeURIComponent(
        subcategory,
      )}&month=${month}${weekParam}${rangeParam}`,
    )
      .then((fresh) => setServerCalendar(fresh))
      .catch((err) =>
        console.error('Failed to load category calendar:', err),
      )
      .finally(() => setFetching(false))
  }, [subcategory, month, week, includedRanges])

  useEffect(() => {
    fetchCalendar()
  }, [fetchCalendar])

  const go = (nextMonth: string) => {
    setMonth(nextMonth)
    updateSearchParams({
      category: subcategory,
      month: nextMonth,
      week,
      ranges: includedRanges.join(','),
    })
  }

  const onWeekChange = (value: string) => {
    setWeek(value)
    updateSearchParams({
      category: subcategory,
      month,
      week: value,
      ranges: includedRanges.join(','),
    })
    fetchCalendar()
  }

  const toggleRange = (rangeName: string) => {
    const next = includedRanges.includes(rangeName)
      ? includedRanges.filter((r) => r !== rangeName)
      : [...includedRanges, rangeName]
    setIncludedRanges(next)
    updateSearchParams({
      category: subcategory,
      month,
      week,
      ranges: next.join(','),
    })
    fetchCalendar()
  }

  const onCategoryChange = (value: string) => {
    setSubcategory(value)
    setIncludedRanges([])
    updateSearchParams({ category: value, month, week })
  }

  const canGoNext = month < thisMonth()

  return (
    <div className="space-y-6 text-slate-100">
      <PageHeader
        title={`${subcategory || 'Model'} Calendar`}
        subtitle="Model calendar"
        description="Daily ticks, trigger count, and win/loss mix for all ranges in a model."
        onTitleClick={() => void fetchCalendar()}
      >
        {fetching && <LoadingSpinner size={18} />}
      </PageHeader>

      <MetricsPanel calendar={serverCalendar ?? placeholderCalendar} />

      <div className="flex items-end justify-between gap-3">
        <label className="block w-56">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Model
          </span>
          <select
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            value={subcategory}
            onChange={(e) => onCategoryChange(e.target.value)}
          >
            <option value="">Select a model</option>
            {subcategories.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs text-slate-300 hover:border-slate-500 hover:text-slate-100"
          onClick={() => setShowFilters((s) => !s)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={showFilters ? 'rotate-180 transition-transform' : 'transition-transform'}>
            <path d="m6 9 6 6 6-6" />
          </svg>
          Filters
        </button>
      </div>

      {showFilters && (
      <Card title="Filters">
        <div className="grid gap-4 md:grid-cols-3">

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">
              Month
            </span>
            <input
              type="month"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              value={month}
              onChange={(e) => go(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">
              Week
            </span>
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              value={week}
              onChange={(e) => onWeekChange(e.target.value)}
            >
              <option value="">All weeks</option>
              <option value="1">Week 1</option>
              <option value="2">Week 2</option>
              <option value="3">Week 3</option>
              <option value="4">Week 4</option>
              <option value="5">Week 5</option>
            </select>
          </label>

          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => go(shiftMonth(month, -1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => go(shiftMonth(month, 1))}
              disabled={!canGoNext}
            >
              Next
            </Button>
          </div>
        </div>

        {subcategory && assignedRangeNames.length > 0 && (
          <div className="mt-4">
            <span className="mb-2 block text-xs font-medium text-slate-400">
              Filter ranges
            </span>
            <div className="flex flex-wrap gap-2">
              {assignedRangeNames.map((rangeName) => {
                const checked =
                  includedRanges.length === 0 ||
                  includedRanges.includes(rangeName)
                return (
                  <label
                    key={rangeName}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                      checked={checked}
                      onChange={() => toggleRange(rangeName)}
                    />
                    {rangeName}
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </Card>
      )}

      {subcategory && (
        <EquityChart
          label={subcategory}
          query={`subcategory=${encodeURIComponent(subcategory)}`}
        />
      )}

      <div className={!serverCalendar && fetching ? 'animate-pulse opacity-60' : ''}>
        <RangeCalendar
          calendar={serverCalendar ?? placeholderCalendar}
          onRefresh={fetchCalendar}
          onDayClick={(day) => (serverCalendar ? setSelectedDay(day) : undefined)}
          redFolderEvents={redFolderEvents}
        />
      </div>

      {selectedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card
            title={formatJournalDateKey(selectedDay.date)}
            right={
              <Button type="button" variant="ghost" onClick={() => setSelectedDay(null)}>
                Close
              </Button>
            }
            className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-y-auto"
          >
            {editingTrade ? (
              <>
                <div className="mb-4 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditingTrade(null)}
                  >
                    Back to day
                  </Button>
                </div>
                <TradeAdjustForm
                  trade={editingTrade}
                  onCancel={() => setEditingTrade(null)}
                  onSave={(_updated) => {
                    setEditingTrade(null)
                    fetchCalendar()
                    window.dispatchEvent(new CustomEvent('journal:refresh'))
                  }}
                  onDelete={() => {
                    setEditingTrade(null)
                    fetchCalendar()
                    window.dispatchEvent(new CustomEvent('journal:refresh'))
                  }}
                />
              </>
            ) : (
              <>
                <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Realized P&L</div>
                <div
                  className={`text-lg font-bold ${classForCents(
                    selectedDay.realizedDollarsCents,
                  )}`}
                >
                  {formatPnl(selectedDay.realizedDollarsCents)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Net ticks</div>
                <div
                  className={`text-lg font-bold ${classForCents(
                    selectedDay.netTicksCents,
                  )}`}
                >
                  {formatTicks(selectedDay.netTicksCents)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Win rate</div>
                <div className="text-lg font-bold text-slate-100">
                  {formatPercent(selectedDay.winRate)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Closed</div>
                <div className="text-lg font-bold text-slate-100">
                  {selectedDay.closedCount}
                </div>
              </div>
            </div>

            {(() => {
              const dayNews = redFolderEvents.filter(
                (event) =>
                  event.impact.toLowerCase() === 'high' &&
                  event.date ===
                    formatForexFactoryEventDateLabel(
                      journalDateFromKey(selectedDay.date),
                    ),
              )
              return dayNews.length > 0 ? (
                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">
                    Red folder news
                  </h3>
                  <div className="grid gap-2 md:grid-cols-2">
                    {dayNews.map((event) => (
                      <div
                        key={event.eventId}
                        className="rounded-lg border border-redfolder-600/30 bg-redfolder-600/10 p-3 text-sm"
                      >
                        <div className="font-medium text-slate-100">
                          {event.title}
                        </div>
                        <div className="text-xs text-slate-400">
                          {event.time} · {event.currency}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null
            })()}

            {selectedDay.ranges.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-200">
                  Range breakdown
                </h3>
                <div className="grid gap-2 md:grid-cols-2">
                  {selectedDay.ranges.map((range) => (
                    <div
                      key={`${range.rangeName}-${range.instrument}`}
                      className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm"
                    >
                      <div className="font-medium text-slate-100">
                        {range.rangeName} ({displayInstrument(range.instrument)})
                      </div>
                      <div
                        className={`font-medium ${classForCents(
                          range.realizedDollarsCents,
                        )}`}
                      >
                        {formatPnl(range.realizedDollarsCents)} ·{' '}
                        {formatTicks(range.netTicksCents)} · {range.closedCount}{' '}
                        closed
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-200">
                Trades taken
              </h3>
              <div className="hidden overflow-hidden rounded-xl border border-slate-700 bg-slate-900 md:block">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-3">Time</th>
                      <th className="px-4 py-3">Range</th>
                      <th className="px-4 py-3">Instrument</th>
                      <th className="px-4 py-3">Side</th>
                      <th className="px-4 py-3">Outcome</th>
                      <th className="px-4 py-3 text-right">P&L</th>
                      <th className="px-4 py-3 text-right">Ticks</th>
                      <th className="px-4 py-3 text-right">Qty</th>
                      <th className="px-4 py-3 text-right"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {(selectedDay.trades ?? []).map((trade) => (
                      <tr key={trade.id}>
                        <td className="px-4 py-3 text-slate-200">
                          <JournalDate value={trade.occurredAt} />
                        </td>
                        <td className="px-4 py-3 text-slate-200">
                          {trade.rangeName}
                        </td>
                        <td className="px-4 py-3 text-slate-200">
                          {displayInstrument(trade.instrument)}
                        </td>
                        <td className="px-4 py-3 text-slate-200">
                          {trade.side}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              trade.outcome === 'win'
                                ? 'bg-positive-900 text-positive-100'
                                : trade.outcome === 'loss'
                                  ? 'bg-negative-900 text-negative-100'
                                  : 'bg-slate-700 text-slate-300'
                            }`}
                          >
                            {trade.outcome ?? '—'}
                          </span>
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-medium ${classForCents(
                            trade.realizedDollarsCents ?? 0,
                          )}`}
                        >
                          {formatPnl(trade.realizedDollarsCents ?? 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-200">
                          {formatTicks(trade.realizedTicksCents ?? 0)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-200">
                          {formatQuantity(trade.quantity)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setEditingTrade(trade)}
                            className="rounded bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
                          >
                            Adjust
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden space-y-2">
                {(selectedDay.trades ?? []).map((trade) => (
                  <div
                    key={trade.id}
                    className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-slate-200">
                        <JournalDate value={trade.occurredAt} />
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          trade.outcome === 'win'
                            ? 'bg-positive-900 text-positive-100'
                            : trade.outcome === 'loss'
                              ? 'bg-negative-900 text-negative-100'
                              : 'bg-slate-700 text-slate-300'
                        }`}
                      >
                        {trade.outcome ?? '—'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-slate-300">
                      <div>{trade.rangeName}</div>
                      <div>{displayInstrument(trade.instrument)}</div>
                      <div>{trade.side}</div>
                      <div
                        className={`text-right ${classForCents(
                          trade.realizedDollarsCents ?? 0,
                        )}`}
                      >
                        {formatPnl(trade.realizedDollarsCents ?? 0)}
                      </div>
                      <div>{formatTicks(trade.realizedTicksCents ?? 0)} ticks</div>
                      <div className="text-right">Qty {formatQuantity(trade.quantity)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <Button type="button" variant="ghost" onClick={() => setSelectedDay(null)}>
                Close
              </Button>
            </div>
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
