import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RangeCalendar } from '../components/RangeCalendar'
import { EquityChart } from '../components/ModelEquityChart'
import { RangeDetailSections } from '../components/RangeDetailSections'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { getCachedRangeCalendar, setCachedRangeCalendar } from '../utils/range-calendar-cache'
import { getJson } from '../api/client'
import {
  classForCents,
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
import { TradeAdjustForm } from '../components/TradeAdjustForm'
import type { CalendarDay, RangeTradeEvent, TradeCalendarMonthView } from '../types'
import { JournalDate } from '../components/JournalDate'
import { displayInstrument } from '../utils/instruments'
import { placeholderMonthView } from '../utils/calendar-placeholder'

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function journalMonthKey(): string {
  const shifted = new Date(Date.now() - 4 * 60 * 60 * 1000)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

export function RangeCalendarPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rangeName = searchParams.get('range') ?? ''

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [rangeName])

  const currentMonth = useMemo(() => journalMonthKey(), [])

  const [month, setMonth] = useState(searchParams.get('month') ?? currentMonth)
  const [serverCalendar, setServerCalendar] = useState<
    TradeCalendarMonthView | undefined
  >(() => (rangeName ? getCachedRangeCalendar(rangeName, month) : undefined))
  const [fetching, setFetching] = useState(false)
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null)
  const [editingTrade, setEditingTrade] = useState<RangeTradeEvent | null>(null)

  const fetchCalendar = useCallback(() => {
    if (!rangeName || !month) return
    setFetching(true)
    getJson<TradeCalendarMonthView>(
      `/api/range/calendar?range=${encodeURIComponent(rangeName)}&month=${month}`,
    )
      .then((fresh) => {
        setServerCalendar(fresh)
        setCachedRangeCalendar(rangeName, month, fresh)
      })
      .catch((error) => {
        console.error('Failed to load range calendar:', error)
      })
      .finally(() => {
        setFetching(false)
      })
  }, [rangeName, month])

  useEffect(() => {
    fetchCalendar()
  }, [fetchCalendar])

  const go = (nextMonth: string) => {
    setMonth(nextMonth)
    setSearchParams({ range: rangeName, month: nextMonth })
  }

  if (!rangeName) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-6 text-slate-100">
        No range selected.
      </div>
    )
  }

  const canGoNext = month < currentMonth
  const { events: redFolderEvents } = useForexFactoryEvents(month)

  return (
    <div className="space-y-6 text-slate-100">
      <PageHeader
        title={`${rangeName}`}
        subtitle="Range detail"
        description="Alerts, TradersPost dispatches, resend, and the daily calendar for this range."
        onTitleClick={() => void fetchCalendar()}
      >
        {fetching && <LoadingSpinner size={18} />}
      </PageHeader>

      <div className="flex items-center gap-2">
        <Link
          to={rangeName ? `/app/ranges?range=${encodeURIComponent(rangeName)}` : '/app/ranges'}
          className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700"
        >
          Back to ranges
        </Link>
      </div>

      <RangeDetailSections rangeName={rangeName} sections={['settings']} />

      {rangeName && (
        <EquityChart
          label={rangeName}
          query={`range=${encodeURIComponent(rangeName)}`}
        />
      )}

      <div className="flex items-center gap-2">
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

      <div className={!serverCalendar && fetching ? 'animate-pulse opacity-60' : ''}>
        <RangeCalendar
          calendar={serverCalendar ?? placeholderMonthView(month)}
          rangeName={rangeName}
          onRefresh={fetchCalendar}
          onDayClick={(day) => (serverCalendar ? setSelectedDay(day) : undefined)}
          redFolderEvents={redFolderEvents}
        />
      </div>

      <RangeDetailSections rangeName={rangeName} sections={['simulation', 'alerts', 'dispatches', 'ct-dispatches']} />

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
                <div className="grid gap-4 md:grid-cols-5">
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
                  <div className="rounded-lg bg-slate-900 p-3 text-sm">
                    <div className="text-slate-400">R earned</div>
                    <div
                      className={`text-lg font-bold ${
                        (selectedDay.rEarned ?? 0) > 0
                          ? 'text-positive'
                          : (selectedDay.rEarned ?? 0) < 0
                            ? 'text-negative-400'
                            : 'text-slate-100'
                      }`}
                    >
                      {selectedDay.rEarned == null
                        ? '—'
                        : `${selectedDay.rEarned > 0 ? '+' : ''}${selectedDay.rEarned.toFixed(1)}R`}
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

                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">
                    Trades taken
                  </h3>
                  <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
                        <tr>
                          <th className="px-4 py-3">Time</th>
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
                </div>

                <div className="mt-4 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost" 
                    onClick={() => setSelectedDay(null)}
                  >
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
