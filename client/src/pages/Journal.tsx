import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../components/Button'
import { Card } from '../components/Card'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { PageHeader } from '../components/PageHeader'
import { RingChart } from '../components/RingChart'
import { formatPrice } from '../utils/drafts'
import { displayInstrument } from '../utils/instruments'
import { BalanceBar } from '../components/BalanceBar'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { DailyCumulativeChart } from '../components/DailyCumulativeChart'
import { MonthlyPerformanceMix } from '../components/MonthlyPerformanceMix'
import { ManualTradeForm } from '../components/ManualTradeForm'
import {
  annualizedSharpeFromTrades,
  calendarMonthLabel,
  classForCents,
  formatDollars,
  formatJournalDateKey,
  formatPnl,
  formatQuantity,
  formatPercent,
  formatRatio,
  formatTicks,
  grossPerformance,
  journalActiveDays,
  profitFactor,
} from '../utils/format'
import { getJson, postForm, postJson } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { tradingViewInstrumentIconUrl } from '../utils/instruments'
import {
  getCachedJournal,
  getCachedJournalOptimistic,
  isCachedJournalFresh,
  setCachedJournal,
} from '../utils/journal-cache'
import { getDeepLifePath } from '../utils/numerology'
import type { CalendarDay, CalendarDayRange, JournalMetrics, TradeCalendarMonthView, TradeEvent, TradeJournal, TradeJournalDay } from '../types'
import { JournalDate } from '../components/JournalDate'

const PAGE_SIZE = 25

const TRADE_TIME_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
]

const OUTCOME_OPTIONS = [
  { value: 'all', label: 'All outcomes' },
  { value: 'win', label: 'Wins' },
  { value: 'loss', label: 'Losses' },
  { value: 'breakeven', label: 'Breakeven' },
]

const EXCLUSION_OPTIONS = [
  { value: 'all', label: 'All records' },
  { value: 'non_excluded', label: 'Non-excluded' },
  { value: 'excluded', label: 'Excluded' },
  { value: 'test_data', label: 'Test data' },
  { value: 'erroneous', label: 'Erroneous' },
]

// Static class map — Tailwind needs literal class names at build time.
const OPEN_TRADE_GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
}

function isWithinTradeTime(occurredAt: string, filter: string): boolean {
  const now = new Date()
  const occurred = new Date(occurredAt)
  const diffMs = now.getTime() - occurred.getTime()
  if (filter === 'all') return true
  if (filter === 'day') return diffMs < 24 * 60 * 60 * 1000
  if (filter === 'week') return diffMs < 7 * 24 * 60 * 60 * 1000
  if (filter === 'month') return diffMs < 30 * 24 * 60 * 60 * 1000
  return true
}

function mergeMetrics(metrics: JournalMetrics[]): JournalMetrics {
  const realizedDollarsCents = metrics.reduce(
    (sum, m) => sum + m.realizedDollarsCents,
    0,
  )
  const netTicksCents = metrics.reduce((sum, m) => sum + m.netTicksCents, 0)
  const closedCount = metrics.reduce((sum, m) => sum + m.closedCount, 0)
  const wins = metrics.reduce((sum, m) => sum + m.wins, 0)
  const losses = metrics.reduce((sum, m) => sum + m.losses, 0)
  const breakevens = metrics.reduce((sum, m) => sum + m.breakevens, 0)
  const winRate =
    wins + losses > 0 ? wins / (wins + losses) : null

  const grossWinDollars = metrics.reduce(
    (sum, m) => sum + (m.averageWinDollarsCents ?? 0) * m.wins,
    0,
  )
  const grossLossDollars = metrics.reduce(
    (sum, m) => sum + (m.averageLossDollarsCents ?? 0) * m.losses,
    0,
  )
  const grossWinTicks = metrics.reduce(
    (sum, m) => sum + (m.averageWinTicksCents ?? 0) * m.wins,
    0,
  )
  const grossLossTicks = metrics.reduce(
    (sum, m) => sum + (m.averageLossTicksCents ?? 0) * m.losses,
    0,
  )

  return {
    realizedDollarsCents,
    netTicksCents,
    closedCount,
    wins,
    losses,
    breakevens,
    winRate,
    averageWinDollarsCents:
      wins > 0 ? Math.round(grossWinDollars / wins) : null,
    averageLossDollarsCents:
      losses > 0 ? Math.round(grossLossDollars / losses) : null,
    averageWinTicksCents: wins > 0 ? Math.round(grossWinTicks / wins) : null,
    averageLossTicksCents:
      losses > 0 ? Math.round(grossLossTicks / losses) : null,
  }
}

const emptyMetrics: JournalMetrics = {
  realizedDollarsCents: 0,
  netTicksCents: 0,
  closedCount: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  winRate: null,
  averageWinDollarsCents: null,
  averageLossDollarsCents: null,
  averageWinTicksCents: null,
  averageLossTicksCents: null,
}

function todayKey(): string {
  const now = new Date()
  const shifted = new Date(now.getTime() - 4 * 60 * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

function shiftMonthKey(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1 + delta, 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`
}

function KpiStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-positive'
      : tone === 'negative'
        ? 'text-negative-400'
        : 'text-slate-200'
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-400">{label}</span>
      <span className={`font-semibold ${toneClass}`}>{value}</span>
    </div>
  )
}

export function JournalPage() {
  const { user } = useAuth()
  const [ctSweeping, setCtSweeping] = useState(false)
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set(),
  )
  const [selectedOutcome, setSelectedOutcome] = useState('all')
  const [selectedTime, setSelectedTime] = useState('all')
  const [selectedRange, setSelectedRange] = useState('all')
  const [page, setPage] = useState(1)
  const [selectedDay, setSelectedDay] = useState<TradeJournalDay | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedInstrument, setSelectedInstrument] = useState('all')
  const [selectedDate, setSelectedDate] = useState('all')
  const [selectedExclusion, setSelectedExclusion] = useState('non_excluded')

  const refresh = () => {
    setIsSpinning(true)
    const finish = () => {
      setTimeout(() => setIsSpinning(false), 1000)
      setRefreshKey((k) => k + 1)
    }
    // Admin sessions also fire a CrossTrade sweep first, so Open Orders shows
    // broker-verified state — adoption, orphan retirement, ghost resolution —
    // not just a re-read of local bookkeeping. Viewers get the local refresh.
    if (user?.isAdmin) {
      postJson('/debugging/ct-sweep-now', {})
        .catch(() => undefined)
        .finally(finish)
    } else {
      finish()
    }
  }

  // Optimistic mount read: paints the stored cache instantly on hard reload,
  // before auth resolves. Once the session lands, the effect below re-verifies
  // the cached userId and serves/revalidates accordingly.
  const cached = useMemo(() => getCachedJournalOptimistic(), [])

  const [viewedMonth, setViewedMonth] = useState(
    cached?.calendar?.month ?? todayKey(),
  )

  const [serverTradeJournal, setServerTradeJournal] = useState<
    TradeJournal | undefined
  >(cached?.tradeJournal)
  const [serverCalendar, setServerCalendar] = useState<
    TradeCalendarMonthView | undefined
  >(cached?.calendar)
  const [serverJournalDays, setServerJournalDays] = useState<
    Record<string, TradeJournalDay> | undefined
  >(cached?.journalDays)
  const [isLoading, setIsLoading] = useState(true)
  const [isSpinning, setIsSpinning] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [showClosedFilters, setShowClosedFilters] = useState(false)
  const [showManualTrade, setShowManualTrade] = useState(false)
  const [openTradeCols, setOpenTradeCols] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem('journal:openTrades:cols'))
    return [1, 2, 3, 4].includes(saved) ? saved : 2
  })
  useEffect(() => {
    window.localStorage.setItem('journal:openTrades:cols', String(openTradeCols))
  }, [openTradeCols])

  const tradeJournal = serverTradeJournal
  const calendar = serverCalendar
  const journalDays = serverJournalDays

  const accountNames = useMemo(
    () =>
      new Map(
        (tradeJournal?.accounts ?? []).map((aj) => [aj.account.id, aj.account.name]),
      ),
    [tradeJournal],
  )

  useEffect(() => {
    if (!user?.userId) return
    const accountsKey = Array.from(selectedAccountIds).sort().join(',')
    const cachedNow = getCachedJournal(user.userId)
    // Fresh cache + identical view params → serve it without a round-trip
    // (the poll below still runs, keeping Open Orders live). A stale cache of
    // the SAME view stays on screen while the fetch runs — navigating back
    // should never blank to zeros. Any refreshKey bump bypasses the cache.
    const freshCache =
      refreshKey === 0 &&
      cachedNow &&
      isCachedJournalFresh(cachedNow, viewedMonth, accountsKey, user.userId)
    const sameViewCache =
      refreshKey === 0 &&
      cachedNow &&
      cachedNow.month === viewedMonth &&
      cachedNow.accountsKey === accountsKey
    if (freshCache || sameViewCache) {
      setServerTradeJournal(cachedNow!.tradeJournal)
      setServerCalendar(cachedNow!.calendar)
      setServerJournalDays(cachedNow!.journalDays)
      if (freshCache) setIsLoading(false)
    }
    if (!freshCache) {
      setIsLoading(true)
      setSelectedDay(null)
    }
    const params = new URLSearchParams()
    if (selectedAccountIds.size > 0) {
      params.set('account', Array.from(selectedAccountIds).join(','))
    }
    params.set('month', viewedMonth)
    const query = `?${params.toString()}`
    const fetchJournal = () =>
      getJson<{
        tradeJournal: TradeJournal
        calendar: TradeCalendarMonthView
        journalDays: Record<string, TradeJournalDay>
      }>(`/api/journal${query}`)
        .then((data) => {
          setServerTradeJournal(data.tradeJournal)
          setServerCalendar(data.calendar)
          setServerJournalDays(data.journalDays)
          setCachedJournal(
            data.tradeJournal,
            data.calendar,
            data.journalDays,
            viewedMonth,
            accountsKey,
            user.userId,
          )
          setIsLoading(false)
        })
        .catch((error) => {
          console.error('Failed to load journal from server:', error)
          setIsLoading(false)
        })
    if (!freshCache) void fetchJournal()
    // Poll while the page is mounted — keeps Open Orders (the fastest-moving
    // section) current without a manual refresh. Skips hidden tabs.
    const poll = window.setInterval(() => {
      if (document.hidden) return
      void fetchJournal()
    }, 15_000)
    return () => window.clearInterval(poll)
  }, [selectedAccountIds, viewedMonth, refreshKey, user?.userId])

  useEffect(() => {
    const onRefresh = () => refresh()
    window.addEventListener('journal:refresh', onRefresh)
    return () => window.removeEventListener('journal:refresh', onRefresh)
  }, [])

  useEffect(() => {
    if (!selectedDay || !serverJournalDays) return
    const updated = serverJournalDays[selectedDay.date]
    if (updated === selectedDay) return
    setSelectedDay(updated ?? null)
  }, [selectedDay, serverJournalDays])

  const handleTradeExclusion = (
    eventId: string,
    reason: 'test_data' | 'erroneous' | 'clear',
  ) => {
    return postForm('/trade-exclusions', {
      eventId,
      testData: reason === 'test_data' ? 'true' : undefined,
      erroneous: reason === 'erroneous' ? 'true' : undefined,
    })
      .then(() => refresh())
      .catch((error) => {
        console.error('Failed to update trade exclusion:', error)
        refresh()
      })
  }

  const handleDayRangeAccountExclusion = (
    date: string,
    accountId: string,
    rangeName: string,
  ) => {
    if (!window.confirm(`Remove all ${rangeName} trades for this account on ${date}?`)) return
    postJson('/api/journal/exclude-day-range-account', { date, accountId, rangeName })
      .then(() => refresh())
      .catch((error) => {
        console.error('Failed to exclude range account day:', error)
      })
  }

  const handleTradeDelete = (eventId: string) => {
    if (!window.confirm('Delete this trade record? This cannot be undone.')) return
    postForm('/trade-events/delete', { eventId })
      .then(() => {
        setSelectedDay(null)
        refresh()
      })
      .catch((error) => {
        console.error('Failed to delete trade:', error)
      })
  }

  const handleReconcile = (trade: TradeEvent) => {
    postJson('/api/journal/reconcile-be', { eventId: trade.id })
      .then(() => {
        setSelectedDay(null)
        refresh()
      })
      .catch((error) => {
        console.error('Failed to reconcile trade:', error)
      })
  }

  const [resendingId, setResendingId] = useState<string | null>(null)
  const handleResend = (trade: TradeEvent) => {
    if (!trade.entryArmedDeliveryId || resendingId) return
    const message = trade.entryArmedDeliveryStatus === 'delivered'
      ? trade.eventType === 'entry_filled'
        ? 'This position is already filled. Resending sends another entry order and could double your position. Continue?'
        : 'This entry was already delivered to TradersPost. Send another order?'
      : trade.entryArmedDeliveryStatus === 'failed'
        ? 'Resend this entry order to TradersPost? If the earlier attempt actually reached the broker, this will create a duplicate order.'
        : trade.entryArmedDeliveryStatus === 'blocked'
          ? 'The entry order was suppressed and never sent to TradersPost. Send it now?'
          : 'Send this entry order to TradersPost?'
    if (!window.confirm(message)) return
    setResendingId(trade.id)
    postJson('/api/journal/resend-delivery', { deliveryId: trade.entryArmedDeliveryId })
      .then(() => refresh())
      .catch((error) => {
        console.error('Failed to resend delivery:', error)
      })
      .finally(() => setResendingId(null))
  }

  const recentClosedTrades = tradeJournal?.recentClosedTrades ?? []
  const openTrades = (tradeJournal?.openTrades ?? []).filter(
    (t) => t.entryArmedDeliveryStatus !== 'extension',
  )
  const rangeEntries = tradeJournal?.rangeEntries ?? {}
  const pairedClosedTrades = tradeJournal?.pairedClosedTrades ?? []
  const openTradeCards = useMemo(() => {
    const groups = new Map<string, TradeEvent[]>()
    const openKeyToGroupKey = new Map<string, string>()
    for (const trade of openTrades) {
      const d = new Date(trade.occurredAt)
      const sessionStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22))
      if (d < sessionStart) {
        sessionStart.setUTCDate(sessionStart.getUTCDate() - 1)
      }
      const key = `${trade.rangeName}::${sessionStart.toISOString()}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(trade)
      openKeyToGroupKey.set(`${trade.accountId}:${trade.rangeName}:${trade.instrument}:${trade.side}`, key)
    }
    for (const trade of pairedClosedTrades) {
      const oppositeSide = trade.side === 'long' ? 'short' : 'long'
      const groupKey = openKeyToGroupKey.get(`${trade.accountId}:${trade.rangeName}:${trade.instrument}:${oppositeSide}`)
      if (groupKey) {
        groups.get(groupKey)!.push(trade)
      }
    }
    return groups
  }, [openTrades, pairedClosedTrades])

  const rangeOptions = useMemo(
    () => ['all', ...(tradeJournal?.rangeNames ?? [])],
    [serverTradeJournal],
  )

  const instrumentOptions = useMemo(
    () => ['all', ...[...new Set(recentClosedTrades.map((t) => t.instrument))].sort()],
    [recentClosedTrades],
  )
  const dateOptions = useMemo(
    () => ['all', ...[...new Set(recentClosedTrades.map((t) => t.occurredAt.slice(0, 10)))].sort().reverse()],
    [recentClosedTrades],
  )

  const filteredTrades = useMemo(() => {
    return recentClosedTrades.filter((trade) => {
      if (selectedAccountIds.size > 0 && !selectedAccountIds.has(trade.accountId))
        return false
      if (selectedOutcome !== 'all' && trade.outcome !== selectedOutcome)
        return false
      if (selectedRange !== 'all' && trade.rangeName !== selectedRange)
        return false
      if (selectedInstrument !== 'all' && trade.instrument !== selectedInstrument)
        return false
      if (selectedDate !== 'all' && !trade.occurredAt.startsWith(selectedDate))
        return false
      if (!isWithinTradeTime(trade.occurredAt, selectedTime)) return false
      if (selectedExclusion === 'non_excluded' && trade.excludedFromPerformance) return false
      if (selectedExclusion === 'excluded' && !trade.excludedFromPerformance) return false
      if (selectedExclusion === 'test_data' && trade.exclusionReason !== 'test_data') return false
      if (selectedExclusion === 'erroneous' && trade.exclusionReason !== 'erroneous') return false
      return true
    })
  }, [
    selectedAccountIds,
    selectedOutcome,
    selectedRange,
    selectedInstrument,
    selectedDate,
    selectedTime,
    selectedExclusion,
    serverTradeJournal,
    recentClosedTrades,
  ])

  const filteredCalendar = useMemo(() => {
    const monthKey = calendar?.month ?? ''
    if (!monthKey) return { month: monthKey, days: [], trailingDays: [], summary: emptyMetrics }
    const [year, month] = monthKey.split('-').map(Number)
    const totalDays = new Date(year, month, 0).getDate()
    const days: CalendarDay[] = []
    const dayMap = journalDays ?? {}
    let grossWinDollarsCents = 0
    let grossLossDollarsCents = 0
    let grossWinTicksCents = 0
    let grossLossTicksCents = 0
    let rEarnedSum = 0
    let rEarnedCovered = 0
    const rangeRisk = tradeJournal?.rangeRisk ?? {}
    for (let i = 1; i <= totalDays; i++) {
      const dateKey = `${monthKey}-${String(i).padStart(2, '0')}`
      const day = dayMap[dateKey]
      if (!day) continue
      const filteredTrades = day.trades.filter((t) => {
        if (selectedAccountIds.size > 0 && !selectedAccountIds.has(t.accountId))
          return false
        if (selectedOutcome !== 'all' && t.outcome !== selectedOutcome)
          return false
        if (selectedRange !== 'all' && t.rangeName !== selectedRange)
          return false
        if (!isWithinTradeTime(t.occurredAt, selectedTime)) return false
        return true
      })
      if (filteredTrades.length === 0) continue
      const rangeMap = new Map<string, CalendarDayRange>()
      for (const t of filteredTrades) {
        const risk = t.rangeName ? rangeRisk[t.rangeName] : undefined
        if (risk && risk > 0) {
          rEarnedSum += (t.realizedDollarsCents ?? 0) / risk
          rEarnedCovered += 1
        }
        const key = `${t.rangeName}|${t.instrument}`
        const r =
          rangeMap.get(key) ?? {
            rangeName: t.rangeName,
            instrument: t.instrument,
            realizedDollarsCents: 0,
            netTicksCents: 0,
            closedCount: 0,
            wins: 0,
            losses: 0,
            breakevens: 0,
          }
        r.realizedDollarsCents += t.realizedDollarsCents ?? 0
        r.netTicksCents += t.realizedTicksCents ?? 0
        r.closedCount += 1
        if (t.outcome === 'win') {
          r.wins += 1
          grossWinDollarsCents += t.realizedDollarsCents ?? 0
          grossWinTicksCents += t.realizedTicksCents ?? 0
        } else if (t.outcome === 'loss') {
          r.losses += 1
          grossLossDollarsCents += Math.abs(t.realizedDollarsCents ?? 0)
          grossLossTicksCents += Math.abs(t.realizedTicksCents ?? 0)
        } else if (t.outcome === 'breakeven') {
          r.breakevens += 1
        }
        rangeMap.set(key, r)
      }
      const ranges = [...rangeMap.values()]
      const realizedDollarsCents = ranges.reduce(
        (s, r) => s + r.realizedDollarsCents,
        0,
      )
      const netTicksCents = ranges.reduce((s, r) => s + r.netTicksCents, 0)
      const closedCount = ranges.reduce((s, r) => s + r.closedCount, 0)
      const wins = ranges.reduce((s, r) => s + r.wins, 0)
      const losses = ranges.reduce((s, r) => s + r.losses, 0)
      const breakevens = ranges.reduce((s, r) => s + r.breakevens, 0)
      const winRate = closedCount > 0 ? wins / closedCount : null
      days.push({
        date: dateKey,
        realizedDollarsCents,
        netTicksCents,
        closedCount,
        wins,
        losses,
        breakevens,
        winRate,
        ranges,
      })
    }
    const summary: JournalMetrics = {
      realizedDollarsCents: days.reduce(
        (s, d) => s + d.realizedDollarsCents,
        0,
      ),
      netTicksCents: days.reduce((s, d) => s + d.netTicksCents, 0),
      closedCount: days.reduce((s, d) => s + d.closedCount, 0),
      wins: days.reduce((s, d) => s + d.wins, 0),
      losses: days.reduce((s, d) => s + d.losses, 0),
      breakevens: days.reduce((s, d) => s + d.breakevens, 0),
      winRate: null,
      averageWinDollarsCents:
        days.reduce((s, d) => s + d.wins, 0) > 0
          ? Math.round(grossWinDollarsCents / days.reduce((s, d) => s + d.wins, 0))
          : null,
      averageLossDollarsCents:
        days.reduce((s, d) => s + d.losses, 0) > 0
          ? Math.round(-grossLossDollarsCents / days.reduce((s, d) => s + d.losses, 0))
          : null,
      averageWinTicksCents:
        days.reduce((s, d) => s + d.wins, 0) > 0
          ? Math.round(grossWinTicksCents / days.reduce((s, d) => s + d.wins, 0))
          : null,
      averageLossTicksCents:
        days.reduce((s, d) => s + d.losses, 0) > 0
          ? Math.round(-grossLossTicksCents / days.reduce((s, d) => s + d.losses, 0))
          : null,
      rEarned: rEarnedCovered > 0 ? rEarnedSum : null,
    }
    summary.winRate =
      summary.closedCount > 0
        ? summary.wins / summary.closedCount
        : null
    // Trailing days come pre-aggregated from the server (account-scoped via
    // the query param) — only surface them when no client-side filter would
    // make their numbers disagree with the rest of the view.
    const filtersDefault =
      selectedOutcome === 'all' && selectedRange === 'all' && selectedTime === 'all'
    const trailingDays = filtersDefault ? (serverCalendar?.trailingDays ?? []) : []
    return { month: monthKey, days, trailingDays, summary }
  }, [
    selectedAccountIds,
    selectedOutcome,
    selectedRange,
    selectedTime,
    serverCalendar,
    serverJournalDays,
    tradeJournal,
  ])

  // Group closed trades by journal-day + range so a range that fired across
  // multiple accounts collapses into one expandable row. UI-only grouping —
  // bookkeeping rows are unchanged.
  const closedTradeGroups = useMemo(() => {
    const map = new Map<string, TradeEvent[]>()
    for (const t of filteredTrades) {
      const key = `${t.occurredAt.slice(0, 10)}|${t.rangeName}`
      const g = map.get(key)
      if (g) g.push(t)
      else map.set(key, [t])
    }
    return [...map.entries()].map(([key, trades]) => ({ key, trades }))
  }, [filteredTrades])

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  // Random accent hue assigned when a group opens — stacked groups get
  // distinct rail colors. Stable for the session.
  const groupAccentHues = useRef<Map<string, number>>(new Map())
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else {
        next.add(key)
        if (!groupAccentHues.current.has(key)) {
          groupAccentHues.current.set(key, Math.floor(Math.random() * 360))
        }
      }
      return next
    })

  const pageCount = Math.max(1, Math.ceil(closedTradeGroups.length / PAGE_SIZE))
  const effectivePage = Math.min(page, pageCount)
  const pageStart = (effectivePage - 1) * PAGE_SIZE
  const pageGroups = closedTradeGroups.slice(pageStart, pageStart + PAGE_SIZE)

  const allAccounts = tradeJournal?.accounts ?? []
  const selectedAccountJournals = useMemo(
    () => allAccounts.filter((aj) => selectedAccountIds.size === 0 || selectedAccountIds.has(aj.account.id)),
    [allAccounts, selectedAccountIds],
  )
  const journal: TradeJournal | undefined =
    tradeJournal &&
    selectedAccountJournals.length > 0 &&
    selectedAccountJournals.length < allAccounts.length
      ? {
          allTime: mergeMetrics(
            selectedAccountJournals.map((aj) => aj.allTime),
          ),
          currentWeek: mergeMetrics(
            selectedAccountJournals.map((aj) => aj.currentWeek),
          ),
          currentDay: mergeMetrics(
            selectedAccountJournals.map((aj) => aj.currentDay),
          ),
          accounts: selectedAccountJournals,
          openTrades: tradeJournal.openTrades,
          pairedClosedTrades: tradeJournal.pairedClosedTrades,
          recentClosedTrades: tradeJournal.recentClosedTrades,
          rangeNames: tradeJournal.rangeNames,
          rangeEntries: tradeJournal.rangeEntries,
        }
      : tradeJournal

  const overall = journal?.allTime ?? emptyMetrics
  const month = filteredCalendar.summary
  const { grossWinsCents, grossLossAbsCents } = grossPerformance(overall)
  const avgWinAbs =
    overall.averageWinDollarsCents == null
      ? 0
      : Math.abs(overall.averageWinDollarsCents)
  const avgLossAbs =
    overall.averageLossDollarsCents == null
      ? 0
      : Math.abs(overall.averageLossDollarsCents)
  const avgTradeTotal = Math.max(1, avgWinAbs + avgLossAbs)
  const avgWinPct = Math.round((avgWinAbs / avgTradeTotal) * 100)
  const avgLossPct = 100 - avgWinPct
  const factor = profitFactor(overall)
  const sharpeRatio = useMemo(
    () => annualizedSharpeFromTrades(tradeJournal?.recentClosedTrades ?? [], selectedAccountJournals.map((entry) => entry.account)),
    [tradeJournal?.recentClosedTrades, selectedAccountJournals],
  )
  const monthTone = classForCents(month.realizedDollarsCents)
  const overallWinRate =
    overall.winRate == null ? 0 : Math.max(0, Math.min(100, overall.winRate * 100))

  function textSizeForValue(value: string): string {
    const len = value.length
    if (len > 12) return 'text-lg'
    if (len > 9) return 'text-2xl'
    if (len > 6) return 'text-3xl'
    return 'text-4xl'
  }

  const overallPnl = formatPnl(overall.realizedDollarsCents)
  const monthPnl = formatPnl(month.realizedDollarsCents)
  const avgWinLossValue = formatRatio(
    avgLossAbs === 0
      ? avgWinAbs > 0
        ? Number.POSITIVE_INFINITY
        : null
      : avgWinAbs / avgLossAbs,
  )

  return (
    <div className="space-y-8 text-slate-100">
      <PageHeader title="Trading Journal" subtitle="Account Performance" onTitleClick={refresh}>
        {isLoading && (
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-500" />
        )}
      </PageHeader>

      <div className="-mt-4 mb-4 flex items-center justify-between">
        <Link
          to="/app/order-review"
          className="!px-3 !py-1 !text-xs hover:text-slate-400"
        >
          Order Review
        </Link>
        <div
          className="!px-3 !py-1 !text-xs hover:cursor-pointer hover:text-slate-400"
          onClick={() => setShowFilters((s) => !s)}
        >
          {showFilters ? 'Hide filters' : 'Filters'}
        </div>
      </div>

       {showFilters && (
        <section className="grid gap-4 rounded-xl p-4">
          <div>
            <div className="flex flex-wrap gap-2 pb-2">
              {allAccounts.map((aj) => {
                const selected = selectedAccountIds.has(aj.account.id)
                return (
                  <label
                    key={aj.account.id}
                    className={`inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      selected
                        ? 'sub-chip-selected'
                        : 'sub-chip border-slate-600 bg-slate-900 text-slate-300 hover:border-slate-500 hover:bg-slate-800'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={selected}
                      onChange={(e) => {
                        setSelectedAccountIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(aj.account.id)
                          else next.delete(aj.account.id)
                          return next
                        })
                        setPage(1)
                      }}
                    />
                    {selected && <span aria-hidden="true" className="sub-chip-check">✓</span>}
                    {aj.account.name}
                  </label>
                )
              })}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
          <label className="block">
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              value={selectedOutcome}
              onChange={(e) => {
                setSelectedOutcome(e.target.value)
                setPage(1)
              }}
            >
              {OUTCOME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              value={selectedTime}
              onChange={(e) => {
                setSelectedTime(e.target.value)
                setPage(1)
              }}
            >
              {TRADE_TIME_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              value={selectedRange}
              onChange={(e) => {
                setSelectedRange(e.target.value)
                setPage(1)
              }}
            >
              {rangeOptions.map((range) => (
                <option key={range} value={range}>
                  {range === 'all' ? 'All ranges' : range}
                </option>
              ))}
            </select>
          </label>
          </div>
        </section>
      )}

      <>
      <section className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Net P&L</span>
            <span className="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-300">
              {overall.closedCount} closed
            </span>
          </div>
          <div
            className={`mb-4 ${textSizeForValue(overallPnl)} font-bold ${classForCents(
              overall.realizedDollarsCents,
            )}`}
          >
            {overallPnl}
          </div>
          <div className="space-y-2">
            <KpiStat
              label="Net ticks"
              value={formatTicks(overall.netTicksCents)}
              tone={
                overall.netTicksCents > 0
                  ? 'positive'
                  : overall.netTicksCents < 0
                    ? 'negative'
                    : 'neutral'
              }
            />
            <KpiStat
              label="This week"
              value={formatPnl(
                journal?.currentWeek.realizedDollarsCents ?? 0,
              )}
              tone={
                (journal?.currentWeek.realizedDollarsCents ?? 0) > 0
                  ? 'positive'
                  : (journal?.currentWeek.realizedDollarsCents ?? 0) < 0
                    ? 'negative'
                    : 'neutral'
              }
            />
          </div>
        </div>

        <div className="hidden md:block rounded-xl border border-slate-700 bg-slate-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
              Trade win %
            </span>
            <span className="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-300">
              {overall.wins}/{overall.losses}
            </span>
          </div>
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <RingChart
              positive={overallWinRate}
              negative={Math.max(0, 100 - overallWinRate)}
              label={formatPercent(overall.winRate)}
            />
            <div className="space-y-1 text-sm">
              <div className="text-slate-400">
                Wins <strong className="text-slate-100">{overall.wins}</strong>
              </div>
              <div className="text-slate-400">
                Losses{' '}
                <strong className="text-slate-100">{overall.losses}</strong>
              </div>
              <div className="text-slate-400">
                BE{' '}
                <strong className="text-slate-100">{overall.breakevens}</strong>
              </div>
            </div>
          </div>
        </div>

        <div className="hidden md:block rounded-xl border border-slate-700 bg-slate-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
              Avg win/loss
            </span>
            <span className="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-300">
              All time
            </span>
          </div>
          <div className={`mb-3 ${textSizeForValue(avgWinLossValue)} font-bold text-slate-100`}>
            {avgWinLossValue}
          </div>
          <div className="mb-3">
            <BalanceBar positive={avgWinPct} negative={avgLossPct} />
          </div>
          <div className="space-y-2">
            <KpiStat
              label="Avg win"
              value={
                overall.averageWinDollarsCents == null
                  ? '—'
                  : formatDollars(overall.averageWinDollarsCents)
              }
              tone="positive"
            />
            <KpiStat
              label="Avg loss"
              value={
                overall.averageLossDollarsCents == null
                  ? '—'
                  : formatDollars(overall.averageLossDollarsCents)
              }
              tone="negative"
            />
          </div>
        </div>

        <div className="hidden md:block rounded-xl border border-slate-700 bg-slate-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
              Profit factor
            </span>
            <span className="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-300">
              {grossLossAbsCents === 0 && grossWinsCents > 0
                ? 'No losses'
                : 'P&L'}
            </span>
          </div>
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <RingChart
              positive={
                grossWinsCents + grossLossAbsCents === 0
                  ? 0
                  : (grossWinsCents / (grossWinsCents + grossLossAbsCents)) * 100
              }
              negative={
                grossWinsCents + grossLossAbsCents === 0
                  ? 100
                  : (grossLossAbsCents / (grossWinsCents + grossLossAbsCents)) * 100
              }
              label={formatRatio(factor)}
            />
            <div className="space-y-1 text-sm">
              <div className="text-slate-400">
                Gross win{' '}
                <strong className="text-positive">
                  {grossWinsCents === 0
                    ? '—'
                    : formatDollars(grossWinsCents)}
                </strong>
              </div>
              <div className="text-slate-400">
                Gross loss{' '}
                <strong className="text-negative-400">
                  {grossLossAbsCents === 0
                    ? '—'
                    : formatDollars(-grossLossAbsCents)}
                </strong>
              </div>
            </div>
          </div>
          <div
            className="mt-4 border-t border-slate-700 pt-3"
            title="Annualized with √252 from daily realized returns on dates with closed trades, using a 0% risk-free rate and current account starting balances. Excludes performance-excluded trades; deposits, withdrawals, and unrealized P&L are not included."
          >
            <KpiStat
              label="Sharpe ratio"
              value={formatRatio(sharpeRatio)}
              tone={sharpeRatio == null ? 'neutral' : sharpeRatio > 0 ? 'positive' : sharpeRatio < 0 ? 'negative' : 'neutral'}
            />
            <div className="mt-1 text-right text-[10px] text-slate-500">Annualized · active days</div>
          </div>
        </div>

        <div className="hidden md:block rounded-xl border border-slate-700 bg-slate-900 p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
              {calendarMonthLabel(filteredCalendar.month)}
            </span>
            <span className="rounded-full border border-slate-600 bg-slate-800/80 px-2.5 py-1 text-xs font-semibold text-slate-300 whitespace-nowrap">
              {journalActiveDays(filteredCalendar)}{' '}
              <span className="text-[10px]">days</span>
            </span>
          </div>
          <div
            className={`mb-4 ${textSizeForValue(monthPnl)} font-bold ${monthTone}`}
          >
            {monthPnl}
          </div>
          <div className="space-y-2">
            <KpiStat
              label="Win rate"
              value={formatPercent(month.winRate)}
            />
            <KpiStat
              label="R earned"
              value={
                month.rEarned == null
                  ? '—'
                  : `${month.rEarned > 0 ? '+' : ''}${month.rEarned.toFixed(1)}R`
              }
            />
            <KpiStat label="Trades" value={String(month.closedCount)} />
          </div>
        </div>
      </section>

      <section className="mt-6 hidden md:grid gap-4 lg:grid-cols-[2fr_1fr]">
        <DailyCumulativeChart
          days={filteredCalendar.days}
          month={month}
          monthLabel={calendarMonthLabel(filteredCalendar.month)}
        />
        <MonthlyPerformanceMix
          overall={month}
          month={month}
          activeDays={journalActiveDays(filteredCalendar)}
        />
      </section>
      </>

      <CollapsibleSection
        title={
          <div className="flex w-full items-center justify-between pr-4">
            <span>{calendarMonthLabel(viewedMonth)}</span>
            <div
              className="flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <Button
                type="button"
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => setViewedMonth((m) => shiftMonthKey(m, -1))}
              >
                ‹
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="px-2 py-1 text-xs"
                onClick={() => setViewedMonth((m) => shiftMonthKey(m, 1))}
              >
                ›
              </Button>
              <Button
                type="button"
                variant="ghost"
                title="Add manual trade"
                className="px-2 py-1 text-xs"
                onClick={() => setShowManualTrade(true)}
              >
                +
              </Button>
              <Button
                type="button"
                variant="ghost"
                title="Refresh"
                className="px-2 py-1 text-xs"
                onClick={refresh}
              >
                <span className={isLoading || isSpinning ? 'inline-block animate-spin' : ''}>↻</span>
              </Button>
            </div>
          </div>
        }
        defaultOpen
        storageKey="journal:calendar:open"
      >
        <section>
        <div className="mb-4 flex items-end justify-between">
          <div className="text-right text-sm text-slate-400">
            <div>Closed: {filteredCalendar.summary.closedCount}</div>
            <div className={classForCents(filteredCalendar.summary.realizedDollarsCents)}>
              {formatPnl(filteredCalendar.summary.realizedDollarsCents)}
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 max-h-[70vh] overflow-y-auto min-[900px]:max-h-none min-[900px]:overflow-visible">
          <div className="mb-2 hidden grid-cols-7 gap-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-400 min-[900px]:grid">
            <div>Sun</div>
            <div>Mon</div>
            <div>Tue</div>
            <div>Wed</div>
            <div>Thu</div>
            <div>Fri</div>
            <div>Sat</div>
          </div>
          <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-5 min-[900px]:grid-cols-7">
            {(() => {
              const [year, month] = filteredCalendar.month.split('-').map(Number)
              const totalDays = new Date(year, month, 0).getDate()
              const startDay = new Date(year, month - 1, 1).getDay()
              const dayMap = new Map(filteredCalendar.days.map((d) => [d.date, d]))
              const prefix = `${filteredCalendar.month}-`
              // Trailing days of the previous month fill the leading cells —
              // with their real results when the month payload carries them.
              const prevMonthDays = new Date(year, month - 1, 0).getDate()
              const prevMonthKey = `${month === 1 ? year - 1 : year}-${String(month === 1 ? 12 : month - 1).padStart(2, '0')}`
              const trailingMap = new Map(
                (filteredCalendar.trailingDays ?? []).map((d) => [d.date, d]),
              )

              return (
                <>
                  {Array.from({ length: startDay }, (_, i) => {
                    const dayNumber = prevMonthDays - startDay + i + 1
                    const dateKey = `${prevMonthKey}-${String(dayNumber).padStart(2, '0')}`
                    const day = trailingMap.get(dateKey)
                    return (
                      <div
                        key={`offset-${i}`}
                        className="hidden min-h-[7rem] rounded-lg border border-dashed border-slate-700/50 bg-slate-900/20 px-1 py-3 opacity-60 min-[480px]:block min-[480px]:min-h-[6rem] min-[480px]:px-1 min-[480px]:py-2 min-[900px]:min-h-[9rem] min-[900px]:p-3"
                        aria-hidden
                      >
                        <div className="flex items-start justify-between">
                          <span className="text-base font-bold text-slate-500 min-[900px]:text-lg">
                            {dayNumber}
                          </span>
                          <span className="text-xs font-semibold text-slate-600">
                            LP {getDeepLifePath(dateKey).lifePathNumber}
                          </span>
                        </div>
                        {day && (
                          <div className="mt-2 space-y-0.5">
                            <div className={`text-sm font-bold ${classForCents(day.realizedDollarsCents)}`}>
                              {formatPnl(day.realizedDollarsCents)}
                            </div>
                            <div className="text-xs text-slate-500">
                              {day.closedCount} trades · W/L {day.wins}/{day.losses}
                            </div>
                            <div className="text-xs text-slate-500">
                              Rate {formatPercent(day.winRate)}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {Array.from({ length: totalDays }, (_, i) => {
                    const dayNumber = i + 1
                    const dateKey = `${prefix}${String(dayNumber).padStart(2, '0')}`
                    const day = dayMap.get(dateKey)
                    const isToday = dateKey === todayKey()
                    const hasTrades = Boolean(day && day.closedCount > 0)
                    const numerology = getDeepLifePath(dateKey)
                    const rangeCount =
                      day ? new Set(day.ranges.map((r) => r.rangeName)).size : 0

                    const isBeDay =
                      day && day.netTicksCents === 0 && day.closedCount > 0
                    const isGrey = !hasTrades
                    const cardClass = day
                      ? isToday
                        ? 'border border-indigo-500/50 bg-slate-800/60'
                        : isBeDay
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
                        onClick={() =>
                          hasTrades && setSelectedDay(journalDays![dateKey] ?? null)
                        }
                        className={`flex min-h-[9rem] flex-col justify-between rounded-lg px-1 py-3 text-sm min-[480px]:min-h-[6rem] min-[480px]:px-1 min-[480px]:py-2 min-[900px]:min-h-[9rem] min-[900px]:p-3 ${cardClass} ${
                          hasTrades ? 'cursor-pointer' : 'cursor-default'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <span className="text-base font-bold text-slate-100 min-[900px]:text-lg">
                            {dayNumber}
                          </span>
                          <span className="text-xs font-semibold text-indigo-500">
                            LP {numerology.lifePathNumber}
                          </span>
                        </div>

                        {hasTrades && day ? (
                          <div className="space-y-0.5">
                            <div
                              className={`text-base font-bold min-[900px]:text-lg ${
                                isBeDay ? 'text-positive' : classForCents(day.realizedDollarsCents)
                              }`}
                            >
                              {formatPnl(day.realizedDollarsCents)}
                            </div>
                            <div className="text-xs text-slate-400">
                              {day.closedCount} trades
                            </div>
                            <div className="text-xs text-slate-400">
                              {rangeCount} range{rangeCount === 1 ? '' : 's'}
                            </div>
                            <div className="text-xs text-slate-400">
                              W/L{' '}
                              <span className="text-positive">
                                {day.wins}
                              </span>
                              <span className="text-slate-500">/</span>
                              <span className="text-negative-400">
                                {day.losses}
                              </span>
                            </div>
                            <div className="text-xs text-slate-400">
                              Rate {formatPercent(day.winRate)}
                            </div>
                            <div className="mt-2 text-xs font-semibold text-slate-200 hover:text-white">
                              Details
                            </div>
                          </div>
                        ) : dateKey <= todayKey() ? (
                          <div className="mt-auto text-sm text-slate-500">No trades</div>
                        ) : null}
                      </div>
                    )
                  })}
                </>
              )
            })()}
          </div>
        </div>
      </section>
      </CollapsibleSection>

      {openTrades.length === 0 ? (
        <div className="flex items-center gap-3 rounded-xl border border-slate-800 px-4 py-3 text-sm text-slate-500">
          <p>No open trades.</p>
          {user?.devMode && user.isAdmin && (
            <Button
              type="button"
              variant="ghost"
              title="Run a CrossTrade sweep now (dev only — no automatic sweeps in dev)"
              className="px-2 py-1 text-xs"
              disabled={ctSweeping}
              onClick={() => {
                setCtSweeping(true)
                postForm('/debugging/ct-sweep-now', {})
                  .then(() => refresh())
                  .catch(() => {})
                  .finally(() => setCtSweeping(false))
              }}
            >
              {ctSweeping ? 'Sweeping…' : 'CT sweep'}
            </Button>
          )}
        </div>
      ) : (
      <CollapsibleSection
        title={
          <div className="flex w-full items-center justify-between gap-2 pr-4">
            <span>Open Orders</span>
            <div className="flex items-center gap-2">
              {user?.devMode && user.isAdmin && (
                <Button
                  type="button"
                  variant="ghost"
                  title="Run a CrossTrade sweep now (dev only — no automatic sweeps in dev)"
                  className="px-2 py-1 text-xs"
                  disabled={ctSweeping}
                  onClick={(e) => {
                    e.stopPropagation()
                    setCtSweeping(true)
                    postForm('/debugging/ct-sweep-now', {})
                      .then(() => refresh())
                      .catch(() => {})
                      .finally(() => setCtSweeping(false))
                  }}
                >
                  {ctSweeping ? 'Sweeping…' : 'CT sweep'}
                </Button>
              )}
              {/* Column picker is meaningless on mobile — the grid is always 1-col. */}
              <div className="hidden items-center gap-0.5 rounded-md border border-slate-700 p-0.5 sm:flex">
                {[1, 2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    title={`${n} column${n === 1 ? '' : 's'}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenTradeCols(n)
                    }}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition ${
                      openTradeCols === n
                        ? 'bg-slate-600 text-white'
                        : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                title="Refresh"
                className="px-2 py-1 text-xs"
                onClick={(e) => {
                  e.stopPropagation()
                  refresh()
                }}
              >
                <span className={isLoading || isSpinning ? 'inline-block animate-spin' : ''}>↻</span>
              </Button>
            </div>
          </div>
        }
        defaultOpen
        storageKey="journal:openTrades:open"
      >
        <section>
          <div className="mb-4 space-y-3">
            <p className="text-slate-400">
              You can click the price of a row to resend the order. 
            </p>
            {openTradeCards.size > 0 && (
              <div className={`grid gap-4 ${OPEN_TRADE_GRID_COLS[openTradeCols]}`}>
                {Array.from(openTradeCards.entries())
                  .sort(([, a], [, b]) => {
                    const aFilled = a.some((t) => t.eventType === 'entry_filled') ? 1 : 0;
                    const bFilled = b.some((t) => t.eventType === 'entry_filled') ? 1 : 0;
                    return bFilled - aFilled;
                  })
                  .filter(([, rangeTrades]) =>
                    rangeTrades.some((t) => t.eventType === 'entry_armed' || t.eventType === 'entry_filled'),
                  )
                  .map(([key, rangeTrades]) => {
                  const rangeName = rangeTrades[0].rangeName;
                  const instrument = rangeTrades[0].instrument;
                  const liveTrades = rangeTrades.filter((t) => t.eventType === 'entry_armed' || t.eventType === 'entry_filled');
                  const latestOccurredAt = liveTrades.reduce(
                    (latest, t) => (t.occurredAt > latest ? t.occurredAt : latest),
                    liveTrades[0]?.occurredAt ?? rangeTrades[0].occurredAt,
                  );
                  const hasFilled = rangeTrades.some((t) => t.eventType === 'entry_filled');
                  const accountMap = rangeTrades.reduce((acc, t) => {
                    if (!acc.has(t.accountId)) acc.set(t.accountId, []);
                    acc.get(t.accountId)!.push(t);
                    return acc;
                  }, new Map<string, TradeEvent[]>());
                  return (
                    <div
                      key={key}
                      className={`rounded-xl border p-4 shadow-sm ${
                        hasFilled
                          ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-900/30 to-slate-900 text-emerald-50'
                          : 'border-slate-700 bg-gradient-to-br from-slate-800 to-slate-900 text-slate-100'
                      }`}
                    >
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <img
                            src={tradingViewInstrumentIconUrl(instrument)}
                            alt={instrument}
                            className="h-6 w-6 flex-none rounded-full bg-slate-700 p-0.5"
                          />
                          <h4 className={`font-semibold ${hasFilled ? 'text-emerald-300' : 'text-slate-100'}`}>
                            <Link
                              to={`/app/ranges/calendar?range=${encodeURIComponent(rangeName)}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:text-indigo-400 hover:underline"
                            >
                              {rangeName}
                            </Link>
                          </h4>
                          <span className="text-xs text-slate-500">{displayInstrument(instrument)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {hasFilled && (
                            <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                          )}
                          <span className="text-right text-xs text-slate-500"><JournalDate value={latestOccurredAt} /></span>
                        </div>
                      </div>
                      <div
                        className="mb-1 grid items-center gap-2 rounded-md px-2 py-1.5 text-[10px] uppercase tracking-wide text-slate-500"
                        style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(2.8rem,0.7fr) 0.4fr minmax(4.2rem,0.9fr) max-content' }}
                      >
                        <span>Account</span>
                        <span>Side</span>
                        <span>Qty</span>
                        <span className="text-right">Entry</span>
                        <span>Status</span>
                      </div>
                      <div className="space-y-1">
                        {Array.from(accountMap)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .flatMap(([accountId, trades]) => {
                            const accountName = accountNames.get(accountId) ?? accountId;
                            return trades
                              .slice()
                              .sort((a, b) => {
                                if (a.side === b.side) return 0;
                                return a.side === 'long' ? -1 : 1;
                              })
                              .map((trade) => {
                                const filled = trade.eventType === 'entry_filled';
                                const closed = trade.eventType === 'trade_closed';
                                const cancelled = trade.eventType === 'entry_cancelled';
                                const delivery = trade.entryArmedDeliveryStatus ?? 'unknown';
                                if (cancelled) {
                                  return (
                                    <div
                                      key={trade.id}
                                      className="grid items-baseline gap-2 rounded-md bg-slate-950/40 px-2 py-1.5 text-xs text-slate-300"
                                      style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(2.8rem,0.7fr) 0.4fr minmax(4.2rem,0.9fr) max-content' }}
                                    >
                                      <span className="truncate font-medium" title={accountName}>{accountName}</span>
                                      <span className="capitalize">{trade.side}</span>
                                      <span>{formatQuantity(trade.quantity)}</span>
                                      <span className="text-right">
                                        {trade.entryPrice == null ? '—' : formatPrice(trade.instrument, trade.entryPrice)}
                                      </span>
                                      <span className="inline-flex items-baseline gap-1 text-slate-300">
                                        <span className="uppercase tracking-wide">Cancelled</span>
                                      </span>
                                      <span className="text-right self-center">
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          className="!px-2 !py-1 !text-xs opacity-60 cursor-not-allowed"
                                          disabled
                                        >
                                          Cancelled
                                        </Button>
                                      </span>
                                    </div>
                                  );
                                }
                                if (closed) {
                                  const pnl = trade.realizedDollarsCents ?? 0;
                                  const pnlClass =
                                    pnl > 0 ? 'text-positive' : pnl < 0 ? 'text-negative-300' : 'text-slate-200';
                                  const outcome = trade.outcome ?? 'unknown';
                                  return (
                                    <div
                                      key={trade.id}
                                      className="grid items-baseline gap-2 rounded-md bg-slate-950/40 px-2 py-1.5 text-xs text-slate-300"
                                      style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(2.8rem,0.7fr) 0.4fr minmax(4.2rem,0.9fr) max-content' }}
                                    >
                                      <span className="truncate font-medium" title={accountName}>{accountName}</span>
                                      <span className="capitalize">{trade.side}</span>
                                      <span>{formatQuantity(trade.quantity)}</span>
                                      <span className="text-right">
                                        {trade.entryPrice == null ? '—' : formatPrice(trade.instrument, trade.entryPrice)}
                                      </span>
                                      <span className={`inline-flex items-baseline gap-1 ${pnlClass}`}>
                                        <span className="uppercase tracking-wide">Closed</span>
                                        <span className="text-[10px] opacity-80">({outcome})</span>
                                      </span>
                                      <span className="text-right self-center">
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          className="!px-2 !py-1 !text-xs opacity-60 cursor-not-allowed"
                                          disabled
                                        >
                                          Closed
                                        </Button>
                                      </span>
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    key={trade.id}
                                    className={`grid items-baseline gap-2 rounded-md px-2 py-1.5 text-xs ${
                                      filled
                                        ? 'bg-emerald-950/50 text-emerald-200'
                                        : 'bg-slate-950/40 text-slate-300'
                                    }`}
                                    style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(2.8rem,0.7fr) 0.4fr minmax(4.2rem,0.9fr) max-content' }}
                                  >
                                    <span className="truncate font-medium" title={accountName}>{accountName}</span>
                                    <span className="capitalize">{trade.side}</span>
                                    <span>{formatQuantity(trade.quantity)}</span>
                                    <span className="text-right">
                                      {trade.entryArmedDeliveryId
                                        && (delivery === 'failed' || delivery === 'delivered' || delivery === 'blocked')
                                        && trade.entryArmedDeliveryDetail !== 'suppressed_duplicate'
                                        && !trade.bracketId?.startsWith('bridge-reapply-') ? (
                                        <button
                                          type="button"
                                          className={`rounded px-1 -mx-1 hover:text-white hover:underline underline-offset-2 disabled:opacity-50 ${
                                            delivery === 'failed' ? 'text-negative resend-failed-pulse' : ''
                                          }`}
                                          title={
                                            delivery === 'failed'
                                              ? 'Resend the entry order to TradersPost'
                                              : delivery === 'blocked'
                                                ? 'Entry order was suppressed — send it now'
                                                : filled
                                                  ? 'Send another entry order — may double the position'
                                                  : 'Send the entry order to TradersPost again'
                                          }
                                          disabled={resendingId === trade.id}
                                          onClick={() => handleResend(trade)}
                                        >
                                          {resendingId === trade.id
                                            ? '…'
                                            : trade.entryPrice == null
                                              ? '—'
                                              : formatPrice(trade.instrument, trade.entryPrice)}
                                        </button>
                                      ) : (
                                        (trade.entryPrice == null ? '—' : formatPrice(trade.instrument, trade.entryPrice))
                                      )}
                                    </span>
                                    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                                      <button
                                        type="button"
                                        title="Reconcile — re-verify this order against the broker"
                                        className={`rounded -mx-1 px-1 hover:text-white hover:underline underline-offset-2 ${
                                          filled && delivery !== 'extension'
                                            ? 'text-amber-300'
                                            : 'text-slate-100'
                                        }`}
                                        onClick={() => handleReconcile(trade)}
                                      >
                                        {filled ? 'Filled' : delivery === 'extension' ? 'Ext' : 'Armed'}
                                      </button>
                                      {delivery === 'delivered' ? (
                                        <span className="text-emerald-400">✓</span>
                                      ) : delivery === 'failed' ? (
                                        <span className="text-rose-400">✗</span>
                                      ) : delivery === 'blocked' ? (
                                        <span
                                          className="rounded bg-amber-500/20 px-1 text-[10px] uppercase tracking-wide text-amber-300"
                                          title={trade.entryArmedDeliveryDetail ?? 'suppressed'}
                                        >
                                          Blocked
                                        </span>
                                      ) : null}
                                      {filled && delivery === 'extension' ? (
                                        <span className="text-[10px] text-slate-100">Ext</span>
                                      ) : null}
                                    </span>
                                  </div>
                                );
                              });
                          })}
                      </div>
                      {rangeEntries[rangeName] != null && (
                        <p className="mt-3 text-[11px] text-slate-500">
                          {rangeEntries[rangeName] === 1
                            ? 'OCO — one entry per range'
                            : `${rangeEntries[rangeName]} entries per range`}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </CollapsibleSection>
      )}

      <CollapsibleSection
        title={
          <div className="flex w-full items-center justify-between pr-4">
            <span>Closed Trades</span>
            <Button
              type="button"
              variant="ghost"
              title="Refresh"
              className="px-2 py-1 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                refresh()
              }}
            >
              <span className={isLoading || isSpinning ? 'inline-block animate-spin' : ''}>↻</span>
            </Button>
          </div>
        }
        defaultOpen
        storageKey="journal:closedTrades:open"
      >
        <section>
        <div className="mb-2 md:hidden">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            onClick={() => setShowClosedFilters((s) => !s)}
          >
            {showClosedFilters ? 'Hide filters' : 'Show filters'}
          </button>
        </div>
        <div className={`mb-4 space-y-3 ${showClosedFilters ? 'block' : 'hidden'} md:block`}>
          <p className="text-slate-400">
            Use the Review column to flag a trade and remove it from your journal. It will remain tracked on it's ranges page.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Date</span>
              <select
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value)
                  setPage(1)
                }}
              >
                {dateOptions.map((date) => (
                  <option key={date} value={date}>
                    {date === 'all' ? 'All dates' : formatJournalDateKey(date)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Range</span>
              <select
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                value={selectedRange}
                onChange={(e) => {
                  setSelectedRange(e.target.value)
                  setPage(1)
                }}
              >
                {rangeOptions.map((range) => (
                  <option key={range} value={range}>
                    {range === 'all' ? 'All ranges' : range}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Outcome</span>
              <select
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                value={selectedOutcome}
                onChange={(e) => {
                  setSelectedOutcome(e.target.value)
                  setPage(1)
                }}
              >
                {OUTCOME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Instrument</span>
              <select
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                value={selectedInstrument}
                onChange={(e) => {
                  setSelectedInstrument(e.target.value)
                  setPage(1)
                }}
              >
                {instrumentOptions.map((instrument) => (
                  <option key={instrument} value={instrument}>
                    {instrument === 'all' ? 'All instruments' : instrument}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Exclusion</span>
              <select
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                value={selectedExclusion}
                onChange={(e) => {
                  setSelectedExclusion(e.target.value)
                  setPage(1)
                }}
              >
                {EXCLUSION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-800">
          <table className="w-full min-w-[60rem] text-left text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Range</th>
                <th className="px-3 py-2">Instrument</th>
                <th className="px-3 py-2">Side</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2 text-right">P&L</th>
                <th className="px-3 py-2 text-right">Ticks</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2" colSpan={2}></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {pageGroups.length ? (
                pageGroups.map((group) => {
                  const expanded = expandedGroups.has(group.key)
                  const accent = `hsl(${groupAccentHues.current.get(group.key) ?? 220} 75% 62%)`
                  const instruments = new Set(group.trades.map((t) => t.instrument))
                  const sides = new Set(group.trades.map((t) => t.side))
                  const outcomes = new Set(group.trades.map((t) => t.outcome))
                  const accounts = new Set(group.trades.map((t) => t.accountId))
                  const pnlSum = group.trades.every((t) => t.realizedDollarsCents == null)
                    ? null
                    : group.trades.reduce((s, t) => s + (t.realizedDollarsCents ?? 0), 0)
                  const tickSum = group.trades.every((t) => t.realizedTicksCents == null)
                    ? null
                    : group.trades.reduce((s, t) => s + (t.realizedTicksCents ?? 0), 0)
                  const qtySum = group.trades.reduce((s, t) => s + (t.quantity ?? 0), 0)
                  const single = group.trades.length === 1
                  return (
                    <Fragment key={group.key}>
                      <tr
                        className={`cursor-pointer select-none transition-colors hover:bg-slate-700/30 ${expanded ? 'bg-slate-700/20 trade-group-open' : ''}`}
                        style={expanded ? { ['--group-accent' as string]: accent } : undefined}
                        onClick={() => toggleGroup(group.key)}
                        title={single ? 'Show account detail' : `Show ${group.trades.length} account rows`}
                      >
                        <td className="px-3 py-2 text-slate-200">
                          <JournalDate value={group.trades[0]!.occurredAt} />
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {accounts.size} account{accounts.size === 1 ? '' : 's'}
                        </td>
                        <td className="px-3 py-2 text-slate-200">
                          <Link
                            to={`/app/ranges?range=${encodeURIComponent(group.trades[0]!.rangeName)}`}
                            className="hover:text-indigo-400 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {group.trades[0]!.rangeName}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-slate-200">
                          {instruments.size === 1 ? displayInstrument([...instruments][0]) : 'Mixed'}
                        </td>
                        <td className="px-3 py-2 text-slate-200">
                          {sides.size === 1 ? [...sides][0] : 'Mixed'}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              outcomes.size === 1 && [...outcomes][0] === 'win'
                                ? 'bg-positive-900 text-positive-100'
                                : outcomes.size === 1 && [...outcomes][0] === 'loss'
                                  ? 'bg-negative-900 text-negative-100'
                                  : 'bg-slate-700 text-slate-300'
                            }`}
                          >
                            {outcomes.size === 1 ? ([...outcomes][0] ?? '—') : 'Mixed'}
                          </span>
                        </td>
                        <td className={`px-3 py-2 text-right font-medium ${classForCents(pnlSum ?? 0)}`}>
                          {pnlSum == null ? '—' : formatPnl(pnlSum)}
                        </td>
                        <td className={`px-3 py-2 text-right font-medium ${classForCents(tickSum ?? 0)}`}>
                          {tickSum == null ? '—' : formatTicks(tickSum)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-200">{formatQuantity(qtySum)}</td>
                        <td className="px-3 py-2 text-right text-slate-400" colSpan={2}>
                          <span className="inline-block transition-transform" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>▸</span>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="trade-row-nested-wrap">
                          <td colSpan={10} className="!p-0 trade-row-nested-wrap-td" style={{ ['--group-accent' as string]: accent, position: 'relative' }}>
                            <span
                              aria-hidden="true"
                              className="pointer-events-none select-none absolute inset-y-0 left-3 flex items-center text-2xl font-bold uppercase tracking-widest opacity-[0.12]"
                            >
                              {group.trades[0]!.rangeName}
                            </span>
                            <table className="text-sm relative" style={{ marginLeft: 'auto', marginBottom: '0.5rem' }}>
                              <thead>
                                <tr className="trade-row-nested text-[10px] uppercase tracking-wide text-slate-500">
                                  <th className="px-3 py-1.5 text-left font-medium" style={{ paddingLeft: '1rem' }}>Account</th>
                                  <th className="px-3 py-1.5 text-left font-medium">Side</th>
                                  <th className="px-3 py-1.5 text-left font-medium">Outcome</th>
                                  <th className="px-3 py-1.5 text-right font-medium">P&L</th>
                                  <th className="px-3 py-1.5 text-right font-medium">Ticks</th>
                                  <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                                  <th className="px-3 py-1.5 text-left font-medium">Review</th>
                                  <th className="px-3 py-1.5" />
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-700/60">
                                {group.trades.map((trade) => (
                                  <TradeRow
                                    key={trade.id}
                                    trade={trade}
                                    accountById={accountNames}
                                    isLoading={isLoading}
                                    onUpdateExclusion={handleTradeExclusion}
                                    onDelete={handleTradeDelete}
                                    nested
                                  />
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              ) : (
                <tr>
                  <td
                    colSpan={10}
                    className="px-4 py-8 text-center text-slate-400"
                  >
                    No closed trades match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {closedTradeGroups.length > 0 && (
            <div className="flex items-center justify-between border-t border-slate-700 px-4 py-3 text-sm text-slate-400">
              <span>
                Showing {pageStart + 1}-
                {Math.min(pageStart + PAGE_SIZE, closedTradeGroups.length)} of{' '}
                {closedTradeGroups.length} range{closedTradeGroups.length === 1 ? '' : 's'} (
                {filteredTrades.length} trade{filteredTrades.length === 1 ? '' : 's'})
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={effectivePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={effectivePage >= pageCount}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
</CollapsibleSection>

      {showManualTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-2xl">
            <ManualTradeForm
              accounts={allAccounts}
              onCancel={() => setShowManualTrade(false)}
              onSave={() => {
                setShowManualTrade(false)
                refresh()
              }}
            />
          </div>
        </div>
      )}

      {selectedDay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card
            title={formatJournalDateKey(selectedDay.date)}
            right={
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  title="Refresh"
                  className="px-2 py-1 text-xs"
                  onClick={refresh}
                >
                  <span className={isLoading || isSpinning ? 'inline-block animate-spin' : ''}>↻</span>
                </Button>
                <Button type="button" variant="ghost" onClick={() => setSelectedDay(null)}>
                  Close
                </Button>
              </div>
            }
            className="flex max-h-[95vh] w-full max-w-5xl flex-col overflow-y-auto"
          >
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Realized P&L</div>
                <div
                  className={`text-lg font-bold ${classForCents(
                    selectedDay.summary.realizedDollarsCents,
                  )}`}
                >
                  {formatPnl(selectedDay.summary.realizedDollarsCents)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Net ticks</div>
                <div
                  className={`text-lg font-bold ${classForCents(
                    selectedDay.summary.netTicksCents,
                  )}`}
                >
                  {formatTicks(selectedDay.summary.netTicksCents)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Win rate</div>
                <div className="text-lg font-bold text-slate-100">
                  {formatPercent(selectedDay.summary.winRate)}
                </div>
              </div>
              <div className="rounded-lg bg-slate-900 p-3 text-sm">
                <div className="text-slate-400">Closed</div>
                <div className="text-lg font-bold text-slate-100">
                  {selectedDay.summary.closedCount}
                </div>
              </div>
            </div>

            {selectedDay.ranges.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-200">
                  Range breakdown
                </h3>
                <div className="grid gap-2 md:grid-cols-2">
                  {selectedDay.ranges.map((range) => {
                    const rangeAccountIds = [
                      ...new Set(
                        selectedDay.trades
                          .filter((t) => t.rangeName === range.rangeName)
                          .map((t) => t.accountId),
                      ),
                    ]
                    return (
                      <div
                        key={range.rangeName}
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
                        {rangeAccountIds.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
                            {rangeAccountIds.map((accountId) => (
                              <span
                                key={accountId}
                                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-slate-300"
                              >
                                {accountNames.get(accountId) ?? accountId}
                                <button
                                  type="button"
                                  title="Remove this account's trades for this range today"
                                  className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-[10px] text-slate-400 hover:bg-red-900/30 hover:text-red-400"
                                  onClick={() =>
                                    selectedDay &&
                                    handleDayRangeAccountExclusion(
                                      selectedDay.date,
                                      accountId,
                                      range.rangeName,
                                    )
                                  }
                                >
                                  &times;
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
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
                      <th className="px-3 py-2">Time</th>
                      <th className="px-3 py-2">Account</th>
                      <th className="px-3 py-2">Range</th>
                      <th className="px-3 py-2">Instrument</th>
                      <th className="px-3 py-2">Side</th>
                      <th className="px-3 py-2">Outcome</th>
                      <th className="px-3 py-2 text-right">P&L</th>
                      <th className="px-3 py-2 text-right">Ticks</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {selectedDay.trades.map((trade) => (
                      <tr key={trade.id}>
                        <td className="px-3 py-2 text-slate-200">
                          <JournalDate value={trade.occurredAt} />
                        </td>
                        <td className="px-3 py-2 text-slate-200">
                          {accountNames.get(trade.accountId) ?? trade.accountId}
                        </td>
                        <td className="px-3 py-2 text-slate-200">
                          {trade.rangeName}
                        </td>
                        <td className="px-3 py-2 text-slate-200">
                          {displayInstrument(trade.instrument)}
                        </td>
                        <td className="px-3 py-2 text-slate-200">
                          {trade.side}
                        </td>
                        <td className="px-3 py-2">
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
                          className={`px-3 py-2 text-right font-medium ${classForCents(
                            trade.realizedDollarsCents ?? 0,
                          )}`}
                        >
                          {trade.realizedDollarsCents == null
                            ? '—'
                            : formatPnl(trade.realizedDollarsCents)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-medium ${classForCents(
                            trade.realizedTicksCents ?? 0,
                          )}`}
                        >
                          {trade.realizedTicksCents == null
                            ? '—'
                            : formatTicks(trade.realizedTicksCents)}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-200">
                          {formatQuantity(trade.quantity)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            className="!px-2 !py-1 !text-xs"
                            onClick={() => handleTradeDelete(trade.id)}
                          >
                            X
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden space-y-2">
                {selectedDay.trades.map((trade) => (
                  <div
                    key={trade.id}
                    className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm"
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <div className="font-medium text-slate-100">
                        {displayInstrument(trade.instrument)} · {trade.side}
                      </div>
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
                    <div className="text-xs text-slate-400">
                      {accountNames.get(trade.accountId) ?? trade.accountId} · {trade.rangeName}
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <div
                        className={`font-medium ${classForCents(
                          trade.realizedDollarsCents ?? 0,
                        )}`}
                      >
                        {trade.realizedDollarsCents == null
                          ? '—'
                          : formatPnl(trade.realizedDollarsCents)}
                      </div>
                      <div className="text-slate-400">
                        {formatTicks(trade.realizedTicksCents ?? 0)}
                      </div>
                      <div className="text-slate-300">Qty {formatQuantity(trade.quantity)}</div>
                    </div>
                    <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                      <span><JournalDate value={trade.occurredAt} /></span>
                      <Button
                        type="button"
                        variant="ghost"
                        className="!px-2 !py-1 !text-xs"
                        onClick={() => handleTradeDelete(trade.id)}
                      >
                        X
                      </Button>
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
          </Card>
        </div>
      )}
    </div>
  )
}

function TradeRow({
  trade,
  accountById,
  isLoading,
  onUpdateExclusion,
  onDelete,
  nested,
}: {
  trade: TradeEvent
  accountById: Map<string, string>
  isLoading: boolean
  nested?: boolean
  onUpdateExclusion: (
    eventId: string,
    reason: 'test_data' | 'erroneous' | 'clear',
  ) => Promise<void>
  onDelete: (eventId: string) => void
}) {
  const [updating, setUpdating] = useState<'test_data' | 'erroneous' | 'clear' | null>(null)
  const wasLoadingRef = useRef(isLoading)
  const handleUpdate = async (reason: 'test_data' | 'erroneous' | 'clear') => {
    setUpdating(reason)
    try {
      await onUpdateExclusion(trade.id, reason)
    } catch {
      setUpdating(null)
    }
  }
  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && updating) {
      setUpdating(null)
    }
    wasLoadingRef.current = isLoading
  }, [isLoading, updating])
  const accountCell = (
    <td className="px-3 py-2 text-slate-200" style={nested ? { paddingLeft: '1rem' } : undefined}>
      {accountById.get(trade.accountId) ?? trade.accountId}
    </td>
  )
  const outcomeCell = (
    <td className="px-3 py-2">
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
  )
  const pnlCell = (
    <td
      className={`px-3 py-2 text-right font-medium ${classForCents(
        trade.realizedDollarsCents ?? 0,
      )}`}
    >
      {trade.realizedDollarsCents == null
        ? '—'
        : formatPnl(trade.realizedDollarsCents)}
    </td>
  )
  const ticksCell = (
    <td
      className={`px-3 py-2 text-right font-medium ${classForCents(
        trade.realizedTicksCents ?? 0,
      )}`}
    >
      {trade.realizedTicksCents == null
        ? '—'
        : formatTicks(trade.realizedTicksCents)}
    </td>
  )
  const qtyCell = (
    <td className="px-3 py-2 text-right text-slate-200">
      {formatQuantity(trade.quantity)}
    </td>
  )
  const sideCell = <td className="px-3 py-2 text-slate-200">{trade.side}</td>
  const reviewCell = (
    <td className="px-3 py-2 text-slate-200">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            trade.excludedFromPerformance
              ? 'bg-slate-700 text-slate-300'
              : 'bg-positive-900 text-positive-100'
          }`}
        >
          {trade.excludedFromPerformance ? 'Excluded' : 'Included'}
        </span>
        {(['test_data', 'erroneous', 'clear'] as const).map((reason) => (
          <button
            key={reason}
            type="button"
            disabled={updating != null}
            onClick={() => handleUpdate(reason)}
            className="text-[10px] text-slate-400 hover:text-slate-200 disabled:opacity-50"
          >
            {updating === reason ? (
              <LoadingSpinner size={12} />
            ) : reason === 'test_data' ? (
              'Test'
            ) : reason === 'erroneous' ? (
              'Erroneous'
            ) : (
              'Clear'
            )}
          </button>
        ))}
      </div>
    </td>
  )
  const deleteCell = (
    <td className="px-3 py-2 text-right">
      <Button
        type="button"
        variant="ghost"
        className="!px-2 !py-1 !text-xs"
        onClick={() => onDelete(trade.id)}
      >
        X
      </Button>
    </td>
  )
  if (nested) {
    return (
      <tr className="trade-row-nested">
        {accountCell}
        {sideCell}
        {outcomeCell}
        {pnlCell}
        {ticksCell}
        {qtyCell}
        {reviewCell}
        {deleteCell}
      </tr>
    )
  }
  return (
    <tr>
      <td className="px-3 py-2 text-slate-200">
        <JournalDate value={trade.occurredAt} />
      </td>
      {accountCell}
      <td className="px-3 py-2 text-slate-200">
        <Link
          to={`/app/ranges?range=${encodeURIComponent(trade.rangeName)}`}
          className="hover:text-indigo-400 hover:underline"
        >
          {trade.rangeName}
        </Link>
      </td>
      <td className="px-3 py-2 text-slate-200">{displayInstrument(trade.instrument)}</td>
      {sideCell}
      {outcomeCell}
      {pnlCell}
      {ticksCell}
      {qtyCell}
      {reviewCell}
      {deleteCell}
    </tr>
  )

}
