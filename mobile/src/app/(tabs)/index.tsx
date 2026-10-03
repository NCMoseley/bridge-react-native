import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { storage } from '../../utils/storage'
import { getJson, postForm, postJson } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import {
  Badge,
  BalanceBar,
  Button,
  Card,
  CollapsibleSection,
  KpiRow,
  RingChart,
  Spinner,
  SelectPicker,
  colors,
  hexToRgba,
  pnlColor,
  toneForCents,
  themedStyles,
} from '../../components/ui'
import {
  DailyCumulativeChart,
  JournalDate,
  MonthlyPerformanceMix,
} from '../../components/charts'
import { onEvent } from '../../utils/events'
import { unreadCount } from '../../utils/messages'
import { formatPrice as formatDraftPrice } from '../../utils/drafts'
import { displayInstrument } from '../../utils/instruments'
import {
  getCachedJournal,
  getCachedJournalOptimistic,
  isCachedJournalFresh,
  setCachedJournal,
} from '../../utils/journal-cache'
import { getDeepLifePath } from '../../utils/numerology'
import {
  annualizedSharpeFromTrades,
  calendarMonthLabel,
  formatDollars,
  formatJournalDateKey,
  formatPercent,
  formatPnl,
  formatPnlCompact,
  formatQuantity,
  formatRatio,
  formatTicks,
  grossPerformance,
  journalActiveDays,
  profitFactor,
} from '../../utils/format'
import type {
  CalendarDay,
  CalendarDayRange,
  JournalMetrics,
  TradeCalendarMonthView,
  TradeEvent,
  TradeJournal,
  TradeJournalDay,
} from '../../types'

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
  const realizedDollarsCents = metrics.reduce((sum, m) => sum + m.realizedDollarsCents, 0)
  const netTicksCents = metrics.reduce((sum, m) => sum + m.netTicksCents, 0)
  const closedCount = metrics.reduce((sum, m) => sum + m.closedCount, 0)
  const wins = metrics.reduce((sum, m) => sum + m.wins, 0)
  const losses = metrics.reduce((sum, m) => sum + m.losses, 0)
  const breakevens = metrics.reduce((sum, m) => sum + m.breakevens, 0)
  const winRate = wins + losses > 0 ? wins / (wins + losses) : null
  const grossWinDollars = metrics.reduce((sum, m) => sum + (m.averageWinDollarsCents ?? 0) * m.wins, 0)
  const grossLossDollars = metrics.reduce((sum, m) => sum + (m.averageLossDollarsCents ?? 0) * m.losses, 0)
  const grossWinTicks = metrics.reduce((sum, m) => sum + (m.averageWinTicksCents ?? 0) * m.wins, 0)
  const grossLossTicks = metrics.reduce((sum, m) => sum + (m.averageLossTicksCents ?? 0) * m.losses, 0)
  return {
    realizedDollarsCents,
    netTicksCents,
    closedCount,
    wins,
    losses,
    breakevens,
    winRate,
    averageWinDollarsCents: wins > 0 ? Math.round(grossWinDollars / wins) : null,
    averageLossDollarsCents: losses > 0 ? Math.round(grossLossDollars / losses) : null,
    averageWinTicksCents: wins > 0 ? Math.round(grossWinTicks / wins) : null,
    averageLossTicksCents: losses > 0 ? Math.round(grossLossTicks / losses) : null,
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

export default function JournalScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const { error: toastError } = useToast()
  const [ctSweeping, setCtSweeping] = useState(false)
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [selectedOutcome, setSelectedOutcome] = useState('all')
  const [selectedTime, setSelectedTime] = useState('all')
  const [selectedRange, setSelectedRange] = useState('all')
  const [page, setPage] = useState(1)
  const [selectedDay, setSelectedDay] = useState<TradeJournalDay | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedInstrument, setSelectedInstrument] = useState('all')
  const [selectedDate, setSelectedDate] = useState('all')
  const [selectedExclusion, setSelectedExclusion] = useState('non_excluded')
  const [isLoading, setIsLoading] = useState(true)
  const [isSpinning, setIsSpinning] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [showClosedFilters, setShowClosedFilters] = useState(false)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [unread, setUnread] = useState(unreadCount())
  useEffect(() => {
    const update = () => setUnread(unreadCount())
    update()
    return onEvent('messages:updated', update)
  }, [])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  const refresh = useCallback(() => {
    setIsSpinning(true)
    const finish = () => {
      setTimeout(() => setIsSpinning(false), 1000)
      setRefreshKey((k) => k + 1)
    }
    if (user?.isAdmin) {
      postJson('/debugging/ct-sweep-now', {})
        .catch(() => undefined)
        .finally(finish)
    } else {
      finish()
    }
  }, [user?.isAdmin])

  const cached = useMemo(() => getCachedJournalOptimistic(), [])
  const [viewedMonth, setViewedMonth] = useState(cached?.calendar?.month ?? todayKey().slice(0, 7))
  const [serverTradeJournal, setServerTradeJournal] = useState<TradeJournal | undefined>(cached?.tradeJournal)
  const [serverCalendar, setServerCalendar] = useState<TradeCalendarMonthView | undefined>(cached?.calendar)
  const [calendarView, setCalendarView] = useState<'grid' | 'list'>(
    () => (storage.getItem('journal:calendar:view') as 'grid' | 'list') ?? 'list',
  )
  const [serverJournalDays, setServerJournalDays] = useState<Record<string, TradeJournalDay> | undefined>(cached?.journalDays)
  const [nextJournalDays, setNextJournalDays] = useState<Record<string, TradeJournalDay>>({})

  const tradeJournal = serverTradeJournal
  const calendar = serverCalendar
  const journalDays = serverJournalDays

  const accountNames = useMemo(
    () => new Map((tradeJournal?.accounts ?? []).map((aj) => [aj.account.id, aj.account.name])),
    [tradeJournal],
  )

  useEffect(() => {
    if (!user?.userId) return
    const accountsKey = Array.from(selectedAccountIds).sort().join(',')
    const cachedNow = getCachedJournal(user.userId)
    const freshCache =
      refreshKey === 0 && cachedNow && isCachedJournalFresh(cachedNow, viewedMonth, accountsKey, user.userId)
    const sameViewCache =
      refreshKey === 0 && cachedNow && cachedNow.month === viewedMonth && cachedNow.accountsKey === accountsKey
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
          setCachedJournal(data.tradeJournal, data.calendar, data.journalDays, viewedMonth, accountsKey, user.userId)
          setIsLoading(false)
        })
        .catch(() => setIsLoading(false))
    if (!freshCache) void fetchJournal()
    const [y, m] = viewedMonth.split('-').map(Number)
    if (y && m) {
      const nextKey = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`
      const nextParams = new URLSearchParams()
      for (const id of selectedAccountIds) nextParams.append('account', id)
      nextParams.set('month', nextKey)
      void getJson<{ journalDays: Record<string, TradeJournalDay> }>(`/api/journal?${nextParams.toString()}`)
        .then((data) => setNextJournalDays(data.journalDays ?? {}))
        .catch(() => setNextJournalDays({}))
    }
    const poll = setInterval(() => void fetchJournal(), 15_000)
    return () => clearInterval(poll)
  }, [selectedAccountIds, viewedMonth, refreshKey, user?.userId])

  useEffect(() => onEvent('journal:refresh', refresh), [refresh])

  useEffect(() => {
    if (!selectedDay || !serverJournalDays) return
    const updated = serverJournalDays[selectedDay.date]
    if (updated === selectedDay) return
    setSelectedDay(updated ?? null)
  }, [selectedDay, serverJournalDays])

  const handleTradeExclusion = (eventId: string, reason: 'test_data' | 'erroneous' | 'clear') => {
    return postForm('/trade-exclusions', {
      eventId,
      testData: reason === 'test_data' ? 'true' : undefined,
      erroneous: reason === 'erroneous' ? 'true' : undefined,
    })
      .then(() => refresh())
      .catch(() => refresh())
  }

  const handleDayRangeAccountExclusion = (date: string, accountId: string, rangeName: string) => {
    Alert.alert('Exclude trades', `Remove all ${rangeName} trades for this account on ${date}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          postJson('/api/journal/exclude-day-range-account', { date, accountId, rangeName })
            .then(() => refresh())
            .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
        },
      },
    ])
  }

  const handleTradeDelete = (eventId: string) => {
    Alert.alert('Delete trade', 'Delete this trade record? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          postForm('/trade-events/delete', { eventId })
            .then(() => {
              setSelectedDay(null)
              refresh()
            })
            .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
        },
      },
    ])
  }

  const handleReconcile = (trade: TradeEvent) => {
    postJson('/api/journal/reconcile-be', { eventId: trade.id })
      .then(() => {
        setSelectedDay(null)
        refresh()
      })
      .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
  }

  const handleResend = (trade: TradeEvent) => {
    if (!trade.entryArmedDeliveryId || resendingId) return
    const message =
      trade.entryArmedDeliveryStatus === 'delivered'
        ? trade.eventType === 'entry_filled'
          ? 'This position is already filled. Resending sends another entry order and could double your position. Continue?'
          : 'This entry was already delivered to TradersPost. Send another order?'
        : trade.entryArmedDeliveryStatus === 'failed'
          ? 'Resend this entry order to TradersPost? If the earlier attempt actually reached the broker, this will create a duplicate order.'
          : trade.entryArmedDeliveryStatus === 'blocked'
            ? 'The entry order was suppressed and never sent to TradersPost. Send it now?'
            : 'Send this entry order to TradersPost?'
    Alert.alert('Resend entry order', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send',
        onPress: () => {
          setResendingId(trade.id)
          postJson('/api/journal/resend-delivery', { deliveryId: trade.entryArmedDeliveryId })
            .then(() => refresh())
            .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
            .finally(() => setResendingId(null))
        },
      },
    ])
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
      if (d < sessionStart) sessionStart.setUTCDate(sessionStart.getUTCDate() - 1)
      const key = `${trade.rangeName}::${sessionStart.toISOString()}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(trade)
      openKeyToGroupKey.set(`${trade.accountId}:${trade.rangeName}:${trade.instrument}:${trade.side}`, key)
    }
    for (const trade of pairedClosedTrades) {
      const oppositeSide = trade.side === 'long' ? 'short' : 'long'
      const groupKey = openKeyToGroupKey.get(`${trade.accountId}:${trade.rangeName}:${trade.instrument}:${oppositeSide}`)
      if (groupKey) groups.get(groupKey)!.push(trade)
    }
    return groups
  }, [openTrades, pairedClosedTrades])

  const rangeOptions = useMemo(
    () => [{ value: 'all', label: 'All ranges' }, ...(tradeJournal?.rangeNames ?? []).map((r) => ({ value: r, label: r }))],
    [serverTradeJournal],
  )
  const instrumentOptions = useMemo(
    () => [
      { value: 'all', label: 'All instruments' },
      ...[...new Set(recentClosedTrades.map((t) => t.instrument))].sort().map((i) => ({ value: i, label: i })),
    ],
    [recentClosedTrades],
  )
  const dateOptions = useMemo(
    () => [
      { value: 'all', label: 'All dates' },
      ...[...new Set(recentClosedTrades.map((t) => t.occurredAt.slice(0, 10)))]
        .sort()
        .reverse()
        .map((d) => ({ value: d, label: formatJournalDateKey(d) })),
    ],
    [recentClosedTrades],
  )

  const filteredTrades = useMemo(() => {
    return recentClosedTrades.filter((trade) => {
      if (selectedAccountIds.size > 0 && !selectedAccountIds.has(trade.accountId)) return false
      if (selectedOutcome !== 'all' && trade.outcome !== selectedOutcome) return false
      if (selectedRange !== 'all' && trade.rangeName !== selectedRange) return false
      if (selectedInstrument !== 'all' && trade.instrument !== selectedInstrument) return false
      if (selectedDate !== 'all' && !trade.occurredAt.startsWith(selectedDate)) return false
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
    if (!monthKey) return { month: monthKey, days: [] as CalendarDay[], trailingDays: [] as CalendarDay[], summary: emptyMetrics }
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
      const dayFilteredTrades = day.trades.filter((t) => {
        if (selectedAccountIds.size > 0 && !selectedAccountIds.has(t.accountId)) return false
        if (selectedOutcome !== 'all' && t.outcome !== selectedOutcome) return false
        if (selectedRange !== 'all' && t.rangeName !== selectedRange) return false
        if (!isWithinTradeTime(t.occurredAt, selectedTime)) return false
        return true
      })
      if (dayFilteredTrades.length === 0) continue
      const rangeMap = new Map<string, CalendarDayRange>()
      for (const t of dayFilteredTrades) {
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
      const realizedDollarsCents = ranges.reduce((s, r) => s + r.realizedDollarsCents, 0)
      const netTicksCents = ranges.reduce((s, r) => s + r.netTicksCents, 0)
      const closedCount = ranges.reduce((s, r) => s + r.closedCount, 0)
      const wins = ranges.reduce((s, r) => s + r.wins, 0)
      const losses = ranges.reduce((s, r) => s + r.losses, 0)
      const breakevens = ranges.reduce((s, r) => s + r.breakevens, 0)
      const winRate = closedCount > 0 ? wins / closedCount : null
      days.push({ date: dateKey, realizedDollarsCents, netTicksCents, closedCount, wins, losses, breakevens, winRate, ranges })
    }
    const summary: JournalMetrics = {
      realizedDollarsCents: days.reduce((s, d) => s + d.realizedDollarsCents, 0),
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
    summary.winRate = summary.closedCount > 0 ? summary.wins / summary.closedCount : null
    const filtersDefault = selectedOutcome === 'all' && selectedRange === 'all' && selectedTime === 'all'
    const trailingDays = filtersDefault ? (serverCalendar?.trailingDays ?? []) : []
    return { month: monthKey, days, trailingDays, summary }
  }, [selectedAccountIds, selectedOutcome, selectedRange, selectedTime, serverCalendar, serverJournalDays, tradeJournal])

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

  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
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
    tradeJournal && selectedAccountJournals.length > 0 && selectedAccountJournals.length < allAccounts.length
      ? {
          allTime: mergeMetrics(selectedAccountJournals.map((aj) => aj.allTime)),
          currentWeek: mergeMetrics(selectedAccountJournals.map((aj) => aj.currentWeek)),
          currentDay: mergeMetrics(selectedAccountJournals.map((aj) => aj.currentDay)),
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
  const avgWinAbs = overall.averageWinDollarsCents == null ? 0 : Math.abs(overall.averageWinDollarsCents)
  const avgLossAbs = overall.averageLossDollarsCents == null ? 0 : Math.abs(overall.averageLossDollarsCents)
  const avgTradeTotal = Math.max(1, avgWinAbs + avgLossAbs)
  const avgWinPct = Math.round((avgWinAbs / avgTradeTotal) * 100)
  const avgLossPct = 100 - avgWinPct
  const factor = profitFactor(overall)
  const sharpeRatio = useMemo(
    () =>
      annualizedSharpeFromTrades(
        tradeJournal?.recentClosedTrades ?? [],
        selectedAccountJournals.map((entry) => entry.account),
      ),
    [tradeJournal?.recentClosedTrades, selectedAccountJournals],
  )
  const overallWinRate = overall.winRate == null ? 0 : Math.max(0, Math.min(100, overall.winRate * 100))
  const overallPnl = formatPnl(overall.realizedDollarsCents)
  const monthPnl = formatPnl(month.realizedDollarsCents)
  const avgWinLossValue = formatRatio(
    avgLossAbs === 0 ? (avgWinAbs > 0 ? Number.POSITIVE_INFINITY : null) : avgWinAbs / avgLossAbs,
  )

  const ctSweepButton = user?.devMode && user.isAdmin ? (
    <Button
      small
      variant="ghost"
      title={ctSweeping ? 'Sweeping…' : 'CT sweep'}
      disabled={ctSweeping}
      onPress={() => {
        setCtSweeping(true)
        postForm('/debugging/ct-sweep-now', {})
          .then(() => refresh())
          .catch(() => {})
          .finally(() => setCtSweeping(false))
      }}
    />
  ) : null

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={isSpinning} onRefresh={refresh} tintColor={colors.accent} />}
    >
      <View style={styles.topBar}>
        <Pressable onPress={() => router.push('/order-review')}>
          <Text style={styles.topLink}>Order Review</Text>
        </Pressable>
        <Pressable onPress={() => setShowFilters((s) => !s)}>
          <Text style={styles.topLink}>{showFilters ? 'Hide filters' : 'Filters'}</Text>
        </Pressable>
        {isLoading ? <Text style={styles.topLink}>…</Text> : null}
        <View style={{ flex: 1 }} />
        <Pressable hitSlop={8} onPress={() => router.push('/messages')} style={{ padding: 2 }}>
          <Ionicons color={unread > 0 ? colors.accent : colors.muted} name="notifications-outline" size={18} />
          {unread > 0 ? (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {showFilters ? (
        <Card>
          <View style={styles.chipRow}>
            {allAccounts.map((aj) => {
              const selected = selectedAccountIds.has(aj.account.id)
              return (
                <Pressable
                  key={aj.account.id}
                  onPress={() => {
                    setSelectedAccountIds((prev) => {
                      const next = new Set(prev)
                      if (selected) next.delete(aj.account.id)
                      else next.add(aj.account.id)
                      return next
                    })
                    setPage(1)
                  }}
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && { color: colors.text }]}>
                    {selected ? '✓ ' : ''}
                    {aj.account.name}
                  </Text>
                </Pressable>
              )
            })}
          </View>
          <View style={{ gap: 10 }}>
            <SelectPicker label="Outcome" options={OUTCOME_OPTIONS} value={selectedOutcome} onChange={(v) => { setSelectedOutcome(v); setPage(1) }} />
            <SelectPicker label="Time" options={TRADE_TIME_OPTIONS} value={selectedTime} onChange={(v) => { setSelectedTime(v); setPage(1) }} />
            <SelectPicker label="Range" options={rangeOptions} value={selectedRange} onChange={(v) => { setSelectedRange(v); setPage(1) }} />
          </View>
        </Card>
      ) : null}

      {/* KPI cards */}
      <Card>
        <View style={styles.kpiHeader}>
          <Text style={styles.kicker}>Net P&L</Text>
          <Badge status="offline">{overall.closedCount} closed</Badge>
        </View>
        <Text style={[styles.bigValue, { color: pnlColor(overall.realizedDollarsCents) }]}>{overallPnl}</Text>
        <KpiRow label="Net ticks" value={formatTicks(overall.netTicksCents)} tone={toneForCents(overall.netTicksCents)} />
        <KpiRow
          label="This week"
          value={formatPnl(journal?.currentWeek.realizedDollarsCents ?? 0)}
          tone={toneForCents(journal?.currentWeek.realizedDollarsCents ?? 0)}
        />
      </Card>

      <Card>
        <View style={styles.kpiHeader}>
          <Text style={styles.kicker}>Trade win %</Text>
          <Badge status="offline">
            {overall.wins}/{overall.losses}
          </Badge>
        </View>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: 16 }}>
          <RingChart positive={overallWinRate} negative={Math.max(0, 100 - overallWinRate)} label={formatPercent(overall.winRate)} />
          <View>
            <Text style={styles.dim}>Wins <Text style={styles.strong}>{overall.wins}</Text></Text>
            <Text style={styles.dim}>Losses <Text style={styles.strong}>{overall.losses}</Text></Text>
            <Text style={styles.dim}>BE <Text style={styles.strong}>{overall.breakevens}</Text></Text>
          </View>
        </View>
      </Card>

      <Card>
        <View style={styles.kpiHeader}>
          <Text style={styles.kicker}>Avg win/loss</Text>
          <Badge status="offline">All time</Badge>
        </View>
        <Text style={[styles.bigValue, { color: colors.text }]}>{avgWinLossValue}</Text>
        <BalanceBar positive={avgWinPct} negative={avgLossPct} />
        <View style={{ marginTop: 8 }}>
          <KpiRow
            label="Avg win"
            value={overall.averageWinDollarsCents == null ? '—' : formatDollars(overall.averageWinDollarsCents)}
            tone="positive"
          />
          <KpiRow
            label="Avg loss"
            value={overall.averageLossDollarsCents == null ? '—' : formatDollars(overall.averageLossDollarsCents)}
            tone="negative"
          />
        </View>
      </Card>

      <Card>
        <View style={styles.kpiHeader}>
          <Text style={styles.kicker}>Profit factor</Text>
          <Badge status="offline">{grossLossAbsCents === 0 && grossWinsCents > 0 ? 'No losses' : 'P&L'}</Badge>
        </View>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: 16 }}>
          <RingChart
            positive={grossWinsCents + grossLossAbsCents === 0 ? 0 : (grossWinsCents / (grossWinsCents + grossLossAbsCents)) * 100}
            negative={grossWinsCents + grossLossAbsCents === 0 ? 100 : (grossLossAbsCents / (grossWinsCents + grossLossAbsCents)) * 100}
            label={formatRatio(factor)}
          />
          <View>
            <Text style={styles.dim}>
              Gross win <Text style={{ color: colors.positive, fontWeight: '700' }}>{grossWinsCents === 0 ? '—' : formatDollars(grossWinsCents)}</Text>
            </Text>
            <Text style={styles.dim}>
              Gross loss <Text style={{ color: colors.negative, fontWeight: '700' }}>{grossLossAbsCents === 0 ? '—' : formatDollars(-grossLossAbsCents)}</Text>
            </Text>
          </View>
        </View>
        <View style={{ borderTopColor: colors.border, borderTopWidth: 1, marginTop: 10, paddingTop: 8 }}>
          <KpiRow label="Sharpe ratio" value={formatRatio(sharpeRatio)} tone={sharpeRatio == null ? 'neutral' : toneForCents(Math.sign(sharpeRatio))} />
          <Text style={{ color: colors.faint, fontSize: 10, textAlign: 'right' }}>Annualized · active days</Text>
        </View>
      </Card>

      <Card>
        <View style={styles.kpiHeader}>
          <Text style={styles.kicker}>{calendarMonthLabel(filteredCalendar.month)}</Text>
          <Badge status="offline">{journalActiveDays(filteredCalendar)} days</Badge>
        </View>
        <Text style={[styles.bigValue, { color: pnlColor(month.realizedDollarsCents) }]}>{monthPnl}</Text>
        <KpiRow label="Win rate" value={formatPercent(month.winRate)} />
        <KpiRow label="R earned" value={month.rEarned == null ? '—' : `${month.rEarned > 0 ? '+' : ''}${month.rEarned.toFixed(1)}R`} />
        <KpiRow label="Trades" value={String(month.closedCount)} />
      </Card>

      <DailyCumulativeChart days={filteredCalendar.days} month={month} monthLabel={calendarMonthLabel(filteredCalendar.month)} />
      <MonthlyPerformanceMix overall={month} month={month} activeDays={journalActiveDays(filteredCalendar)} />

      {/* Calendar */}
      <CollapsibleSection
        storageKey="journal:calendar:open"
        title={
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{calendarMonthLabel(viewedMonth)}</Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button
                small
                hitSlop={8}
                variant="ghost"
                title={calendarView === 'grid' ? '≡' : '▦'}
                onPress={() => {
                  setCalendarView((v) => {
                    const next = v === 'grid' ? 'list' : 'grid'
                    storage.setItem('journal:calendar:view', next)
                    return next
                  })
                }}
              />
              <Button small hitSlop={8} variant="ghost" title="‹" onPress={() => setViewedMonth((m) => shiftMonthKey(m, -1))} />
              <Button small hitSlop={8} variant="ghost" title="›" onPress={() => setViewedMonth((m) => shiftMonthKey(m, 1))} />
            </View>
          </View>
        }
      >
        <View style={{ alignItems: 'flex-end', marginBottom: 6 }}>
          <Text style={styles.dim}>Closed: {filteredCalendar.summary.closedCount}</Text>
          <Text style={{ color: pnlColor(filteredCalendar.summary.realizedDollarsCents), fontWeight: '600' }}>
            {formatPnl(filteredCalendar.summary.realizedDollarsCents)}
          </Text>
        </View>
        {calendarView === 'list' ? (
          <View>
            {[...filteredCalendar.days]
              .filter((d) => d.closedCount > 0)
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((day) => {
                const isBeDay = day.netTicksCents === 0 && day.closedCount > 0
                const numerology = getDeepLifePath(day.date)
                return (
                  <Pressable
                    key={day.date}
                    onPress={() => setSelectedDay(journalDays?.[day.date] ?? null)}
                    style={styles.dayListRow}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.dayListDate}>
                        {formatJournalDateKey(day.date)}{' '}
                        <Text style={styles.dayListLp}>LP{numerology.lifePathNumber}</Text>
                      </Text>
                      <Text style={styles.daySub}>
                        {day.closedCount}t{' '}
                        <Text style={{ color: colors.positive }}>{day.wins}</Text>/
                        <Text style={{ color: colors.negative }}>{day.losses}</Text>
                        {' '}· {formatPercent(day.winRate)}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[styles.dayListPnl, { color: isBeDay ? colors.positive : pnlColor(day.realizedDollarsCents) }]}>
                        {formatPnl(day.realizedDollarsCents)}
                      </Text>
                      <Text style={styles.daySub}>{formatTicks(day.netTicksCents)}</Text>
                    </View>
                  </Pressable>
                )
              })}
            {filteredCalendar.days.filter((d) => d.closedCount > 0).length === 0 ? (
              <Text style={[styles.dim, { paddingVertical: 12, textAlign: 'center' }]}>No trades this month.</Text>
            ) : null}
          </View>
        ) : null}
        {calendarView === 'grid' ? <View style={styles.calendarHeader}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
            <Text key={i} style={styles.calendarHeaderCell}>{d}</Text>
          ))}
        </View> : null}
        {calendarView === 'grid' ? <View style={styles.calendarGrid}>
          {(() => {
            const [year, mon] = filteredCalendar.month.split('-').map(Number)
            if (!year) return null
            const totalDays = new Date(year, mon, 0).getDate()
            const startDay = new Date(year, mon - 1, 1).getDay()
            const dayMap = new Map(filteredCalendar.days.map((d) => [d.date, d]))
            const prefix = `${filteredCalendar.month}-`
            const prevMonthDays = new Date(year, mon - 1, 0).getDate()
            const prevMonthKey = `${mon === 1 ? year - 1 : year}-${String(mon === 1 ? 12 : mon - 1).padStart(2, '0')}`
            const trailingMap = new Map((filteredCalendar.trailingDays ?? []).map((d) => [d.date, d]))
            const cells: React.ReactNode[] = []
            for (let i = 0; i < startDay; i++) {
              const dayNumber = prevMonthDays - startDay + i + 1
              const dateKey = `${prevMonthKey}-${String(dayNumber).padStart(2, '0')}`
              const day = trailingMap.get(dateKey)
              cells.push(
                <View key={`off-${i}`} style={[styles.dayCell, styles.dayCellOff]}>
                  <Text style={styles.dayNumOff}>{dayNumber}</Text>
                  {day ? (
                    <Text style={[styles.dayPnl, { color: pnlColor(day.realizedDollarsCents) }]} numberOfLines={1}>
                      {formatPnlCompact(day.realizedDollarsCents)}
                    </Text>
                  ) : null}
                </View>,
              )
            }
            for (let i = 1; i <= totalDays; i++) {
              const dateKey = `${prefix}${String(i).padStart(2, '0')}`
              const day = dayMap.get(dateKey)
              const isToday = dateKey === todayKey()
              const hasTrades = Boolean(day && day.closedCount > 0)
              const numerology = getDeepLifePath(dateKey)
              const isBeDay = day && day.netTicksCents === 0 && day.closedCount > 0
              cells.push(
                <Pressable
                  key={dateKey}
                  disabled={!hasTrades}
                  onPress={() => setSelectedDay(journalDays?.[dateKey] ?? null)}
                  style={[
                    styles.dayCell,
                    isToday && styles.dayCellToday,
                    hasTrades && !isBeDay && {
                      backgroundColor: day!.realizedDollarsCents > 0 ? hexToRgba(colors.positive, 0.16) : hexToRgba(colors.negative, 0.16),
                      borderColor: day!.realizedDollarsCents > 0 ? colors.positive : colors.negative,
                    },
                    isBeDay && { backgroundColor: hexToRgba(colors.positive, 0.16), borderColor: colors.positive },
                  ]}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={styles.dayNum}>{i}</Text>
                    <Text style={styles.dayLp}>LP{numerology.lifePathNumber}</Text>
                  </View>
                  {hasTrades && day ? (
                    <Text numberOfLines={1} style={[styles.dayPnl, { color: isBeDay ? colors.positive : pnlColor(day.realizedDollarsCents) }]}>
                      {formatPnlCompact(day.realizedDollarsCents)}
                    </Text>
                  ) : dateKey <= todayKey() ? (
                    <Text style={styles.daySub}>·</Text>
                  ) : null}
                </Pressable>,
              )
            }
            const usedCells = startDay + totalDays
            const spillCount = usedCells % 7 === 0 ? 0 : 7 - (usedCells % 7)
            const nextMonthKey = `${mon === 12 ? year + 1 : year}-${String(mon === 12 ? 1 : mon + 1).padStart(2, '0')}`
            for (let i = 1; i <= spillCount; i++) {
              const dateKey = `${nextMonthKey}-${String(i).padStart(2, '0')}`
              const day = nextJournalDays[dateKey]
              cells.push(
                <View key={`next-${dateKey}`} style={[styles.dayCell, styles.dayCellOff]}>
                  <Text style={styles.dayNumOff}>{i}</Text>
                  {day ? (
                    <Text style={[styles.dayPnl, { color: pnlColor(day.summary.realizedDollarsCents) }]} numberOfLines={1}>
                      {formatPnlCompact(day.summary.realizedDollarsCents)}
                    </Text>
                  ) : null}
                </View>,
              )
            }
            return cells
          })()}
        </View> : null}
      </CollapsibleSection>

      {/* Open Orders */}
      {openTrades.length === 0 ? (
        <Card>
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: 10 }}>
            <Text style={styles.dim}>No open trades.</Text>
            {ctSweepButton}
          </View>
        </Card>
      ) : (
        <CollapsibleSection
          storageKey="journal:openTrades:open"
          title={
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Open Orders</Text>
              {ctSweepButton}
            </View>
          }
        >
          <Text style={[styles.dim, { marginBottom: 8 }]}>Tap the price of a row to resend the order.</Text>
          {Array.from(openTradeCards.entries())
            .sort(([, a], [, b]) => {
              const aFilled = a.some((t) => t.eventType === 'entry_filled') ? 1 : 0
              const bFilled = b.some((t) => t.eventType === 'entry_filled') ? 1 : 0
              return bFilled - aFilled
            })
            .filter(([, rangeTrades]) =>
              rangeTrades.some((t) => t.eventType === 'entry_armed' || t.eventType === 'entry_filled'),
            )
            .map(([key, rangeTrades]) => {
              const rangeName = rangeTrades[0].rangeName
              const instrument = rangeTrades[0].instrument
              const liveTrades = rangeTrades.filter(
                (t) => t.eventType === 'entry_armed' || t.eventType === 'entry_filled',
              )
              const latestOccurredAt = liveTrades.reduce(
                (latest, t) => (t.occurredAt > latest ? t.occurredAt : latest),
                liveTrades[0]?.occurredAt ?? rangeTrades[0].occurredAt,
              )
              const hasFilled = rangeTrades.some((t) => t.eventType === 'entry_filled')
              const accountMap = rangeTrades.reduce((acc, t) => {
                if (!acc.has(t.accountId)) acc.set(t.accountId, [])
                acc.get(t.accountId)!.push(t)
                return acc
              }, new Map<string, TradeEvent[]>())
              return (
                <View
                  key={key}
                  style={[styles.openCard, hasFilled && { borderColor: 'rgba(52,211,153,0.5)' }]}
                >
                  <View style={styles.openCardHeader}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Pressable onPress={() => router.push(`/range-calendar?range=${encodeURIComponent(rangeName)}`)}>
                        <Text style={[styles.openCardTitle, hasFilled && { color: colors.positive }]}>{rangeName}</Text>
                      </Pressable>
                      <Text style={styles.daySub}>{displayInstrument(instrument)}</Text>
                    </View>
                    {hasFilled ? <View style={styles.filledDot} /> : null}
                    <JournalDate value={latestOccurredAt} />
                  </View>
                  {Array.from(accountMap)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .flatMap(([accountId, trades]) => {
                      const accountName = accountNames.get(accountId) ?? accountId
                      return trades
                        .slice()
                        .sort((a, b) => {
                          if (a.side === b.side) return 0
                          return a.side === 'long' ? -1 : 1
                        })
                        .map((trade) => {
                          const filled = trade.eventType === 'entry_filled'
                          const closed = trade.eventType === 'trade_closed'
                          const cancelled = trade.eventType === 'entry_cancelled'
                          const delivery = trade.entryArmedDeliveryStatus ?? 'unknown'
                          const resendable =
                            trade.entryArmedDeliveryId &&
                            (delivery === 'failed' || delivery === 'delivered' || delivery === 'blocked') &&
                            trade.entryArmedDeliveryDetail !== 'suppressed_duplicate' &&
                            !trade.bracketId?.startsWith('bridge-reapply-')
                          return (
                            <View
                              key={trade.id}
                              style={[styles.openRow, filled && { backgroundColor: 'rgba(6,78,59,0.4)' }]}
                            >
                              <Text style={[styles.openCell, { flex: 1.4 }]} numberOfLines={1}>{accountName}</Text>
                              <Text style={[styles.openCell, { flex: 0.8 }]}>{trade.side}</Text>
                              <Text style={[styles.openCell, { flex: 0.5 }]}>{formatQuantity(trade.quantity)}</Text>
                              <Pressable
                                style={{ flex: 1 }}
                                disabled={!resendable || resendingId === trade.id}
                                onPress={() => handleResend(trade)}
                              >
                                <Text
                                  style={[
                                    styles.openCell,
                                    { textAlign: 'right' },
                                    resendable && { color: colors.accent, textDecorationLine: 'underline' },
                                    delivery === 'failed' && resendable && { color: colors.negative },
                                  ]}
                                >
                                  {resendingId === trade.id
                                    ? '…'
                                    : trade.entryPrice == null
                                      ? '—'
                                      : formatDraftPrice(trade.instrument, trade.entryPrice)}
                                </Text>
                              </Pressable>
                              <Pressable style={{ flex: 1.2 }} onPress={() => !cancelled && !closed && handleReconcile(trade)}>
                                <Text style={[styles.openCell, { textAlign: 'right' }]}>
                                  {cancelled
                                    ? 'Cancelled'
                                    : closed
                                      ? `Closed${trade.outcome ? ` (${trade.outcome})` : ''}`
                                      : filled
                                        ? 'Filled'
                                        : delivery === 'extension'
                                          ? 'Ext'
                                          : 'Armed'}
                                  {delivery === 'delivered' ? ' ✓' : delivery === 'failed' ? ' ✗' : ''}
                                </Text>
                                {delivery === 'blocked' ? (
                                  <Text style={[styles.daySub, { color: colors.amber, textAlign: 'right' }]}>Blocked</Text>
                                ) : null}
                              </Pressable>
                            </View>
                          )
                        })
                    })}
                  {rangeEntries[rangeName] != null ? (
                    <Text style={[styles.daySub, { marginTop: 6 }]}>
                      {rangeEntries[rangeName] === 1 ? 'OCO — one entry per range' : `${rangeEntries[rangeName]} entries per range`}
                    </Text>
                  ) : null}
                </View>
              )
            })}
        </CollapsibleSection>
      )}

      {/* Closed Trades */}
      <CollapsibleSection
        storageKey="journal:closedTrades:open"
        title={
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Closed Trades</Text>
          </View>
        }
      >
        <Pressable onPress={() => setShowClosedFilters((s) => !s)} style={{ marginBottom: 8 }}>
          <Text style={styles.topLink}>{showClosedFilters ? 'Hide filters' : 'Show filters'}</Text>
        </Pressable>
        {showClosedFilters ? (
          <View style={{ gap: 10, marginBottom: 10 }}>
            <Text style={styles.dim}>
              Use the Review column to flag a trade and remove it from your journal. It remains tracked on its range page.
            </Text>
            <SelectPicker label="Date" options={dateOptions} value={selectedDate} onChange={(v) => { setSelectedDate(v); setPage(1) }} />
            <SelectPicker label="Range" options={rangeOptions} value={selectedRange} onChange={(v) => { setSelectedRange(v); setPage(1) }} />
            <SelectPicker label="Outcome" options={OUTCOME_OPTIONS} value={selectedOutcome} onChange={(v) => { setSelectedOutcome(v); setPage(1) }} />
            <SelectPicker label="Instrument" options={instrumentOptions} value={selectedInstrument} onChange={(v) => { setSelectedInstrument(v); setPage(1) }} />
            <SelectPicker label="Exclusion" options={EXCLUSION_OPTIONS} value={selectedExclusion} onChange={(v) => { setSelectedExclusion(v); setPage(1) }} />
          </View>
        ) : null}

        {pageGroups.length === 0 ? (
          <Text style={styles.dim}>No closed trades match the selected filters.</Text>
        ) : (
          pageGroups.map((group) => {
            const expanded = expandedGroups.has(group.key)
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
            const singleOutcome = outcomes.size === 1 ? [...outcomes][0] : null
            return (
              <View key={group.key} style={styles.groupCard}>
                <Pressable onPress={() => toggleGroup(group.key)} style={styles.groupHeader}>
                  <View style={{ flex: 1 }}>
                    <JournalDate value={group.trades[0]!.occurredAt} />
                    <Pressable onPress={() => router.push(`/ranges?range=${encodeURIComponent(group.trades[0]!.rangeName)}`)}>
                      <Text style={styles.groupRange}>{group.trades[0]!.rangeName}</Text>
                    </Pressable>
                    <Text style={styles.daySub}>
                      {accounts.size} account{accounts.size === 1 ? '' : 's'} ·{' '}
                      {instruments.size === 1 ? displayInstrument([...instruments][0]) : 'Mixed'} ·{' '}
                      {sides.size === 1 ? [...sides][0] : 'Mixed'} · qty {formatQuantity(qtySum)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Badge
                      status={
                        singleOutcome === 'win' ? 'online' : singleOutcome === 'loss' ? 'error' : 'offline'
                      }
                    >
                      {singleOutcome ?? 'Mixed'}
                    </Badge>
                    <Text style={[styles.groupPnl, { color: pnlColor(pnlSum ?? 0) }]}>
                      {pnlSum == null ? '—' : formatPnl(pnlSum)}
                    </Text>
                    <Text style={[styles.daySub, { color: pnlColor(tickSum ?? 0) }]}>
                      {tickSum == null ? '—' : formatTicks(tickSum)}
                    </Text>
                    <Text style={styles.daySub}>{expanded ? '▾' : '▸'}</Text>
                  </View>
                </Pressable>
                {expanded
                  ? group.trades.map((trade) => (
                      <ClosedTradeRow
                        key={trade.id}
                        trade={trade}
                        accountById={accountNames}
                        onUpdateExclusion={handleTradeExclusion}
                        onDelete={handleTradeDelete}
                      />
                    ))
                  : null}
              </View>
            )
          })
        )}
        {closedTradeGroups.length > 0 ? (
          <View style={styles.pager}>
            <Text style={styles.dim}>
              {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, closedTradeGroups.length)} of {closedTradeGroups.length} (
              {filteredTrades.length} trades)
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button small variant="ghost" title="Prev" disabled={effectivePage <= 1} onPress={() => setPage((p) => Math.max(1, p - 1))} />
              <Button small variant="ghost" title="Next" disabled={effectivePage >= pageCount} onPress={() => setPage((p) => Math.min(pageCount, p + 1))} />
            </View>
          </View>
        ) : null}
      </CollapsibleSection>

      {/* Manual trade modal */}

      {/* Day detail modal */}
      <Modal visible={selectedDay != null} animationType="slide" transparent onRequestClose={() => setSelectedDay(null)}>
        <View style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 64, paddingBottom: 48 }}>
            {selectedDay ? (
              <Card title={formatJournalDateKey(selectedDay.date)}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 10 }}>
                  <View>
                    <Text style={styles.daySub}>Realized P&L</Text>
                    <Text style={[styles.groupPnl, { color: pnlColor(selectedDay.summary.realizedDollarsCents) }]}>
                      {formatPnl(selectedDay.summary.realizedDollarsCents)}
                    </Text>
                  </View>
                  <View>
                    <Text style={styles.daySub}>Net ticks</Text>
                    <Text style={[styles.groupPnl, { color: pnlColor(selectedDay.summary.netTicksCents) }]}>
                      {formatTicks(selectedDay.summary.netTicksCents)}
                    </Text>
                  </View>
                  <View>
                    <Text style={styles.daySub}>Win rate</Text>
                    <Text style={styles.groupPnl}>{formatPercent(selectedDay.summary.winRate)}</Text>
                  </View>
                  <View>
                    <Text style={styles.daySub}>Closed</Text>
                    <Text style={styles.groupPnl}>{selectedDay.summary.closedCount}</Text>
                  </View>
                </View>
                {selectedDay.ranges.length > 0 ? (
                  <View style={{ marginBottom: 10 }}>
                    <Text style={[styles.sectionTitle, { marginBottom: 6 }]}>Range breakdown</Text>
                    {selectedDay.ranges.map((range) => {
                      const rangeAccountIds = [
                        ...new Set(
                          selectedDay.trades.filter((t) => t.rangeName === range.rangeName).map((t) => t.accountId),
                        ),
                      ]
                      return (
                        <View key={range.rangeName} style={styles.rangeBreakdown}>
                          <Text style={styles.strong}>
                            {range.rangeName} ({displayInstrument(range.instrument)})
                          </Text>
                          <Text style={{ color: pnlColor(range.realizedDollarsCents), fontWeight: '600' }}>
                            {formatPnl(range.realizedDollarsCents)} · {formatTicks(range.netTicksCents)} · {range.closedCount} closed
                          </Text>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                            {rangeAccountIds.map((accountId) => (
                              <Pressable
                                key={accountId}
                                onPress={() => handleDayRangeAccountExclusion(selectedDay.date, accountId, range.rangeName)}
                                style={styles.accountChip}
                              >
                                <Text style={styles.daySub}>
                                  {accountNames.get(accountId) ?? accountId} ×
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      )
                    })}
                  </View>
                ) : null}
                <Text style={[styles.sectionTitle, { marginBottom: 6 }]}>Trades taken</Text>
                {selectedDay.trades.map((trade) => (
                  <View key={trade.id} style={styles.rangeBreakdown}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={styles.strong}>
                        {displayInstrument(trade.instrument)} · {trade.side}
                      </Text>
                      <Badge status={trade.outcome === 'win' ? 'online' : trade.outcome === 'loss' ? 'error' : 'offline'}>
                        {trade.outcome ?? '—'}
                      </Badge>
                    </View>
                    <Text style={styles.daySub}>
                      {accountNames.get(trade.accountId) ?? trade.accountId} · {trade.rangeName}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 14, marginTop: 4 }}>
                      <Text style={{ color: pnlColor(trade.realizedDollarsCents ?? 0), fontWeight: '600' }}>
                        {trade.realizedDollarsCents == null ? '—' : formatPnl(trade.realizedDollarsCents)}
                      </Text>
                      <Text style={styles.daySub}>{formatTicks(trade.realizedTicksCents ?? 0)}</Text>
                      <Text style={styles.daySub}>Qty {formatQuantity(trade.quantity)}</Text>
                    </View>
                    <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                      <JournalDate value={trade.occurredAt} />
                      <Button small variant="ghost" title="Delete" onPress={() => handleTradeDelete(trade.id)} />
                    </View>
                  </View>
                ))}
                <View style={{ alignItems: 'flex-end', marginTop: 8 }}>
                  <Button small variant="ghost" title="Close" onPress={() => setSelectedDay(null)} />
                </View>
              </Card>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </ScrollView>
  )
}

function ClosedTradeRow({
  trade,
  accountById,
  onUpdateExclusion,
  onDelete,
}: {
  trade: TradeEvent
  accountById: Map<string, string>
  onUpdateExclusion: (eventId: string, reason: 'test_data' | 'erroneous' | 'clear') => Promise<void>
  onDelete: (eventId: string) => void
}) {
  const [updating, setUpdating] = useState<string | null>(null)
  const handle = async (reason: 'test_data' | 'erroneous' | 'clear') => {
    setUpdating(reason)
    try {
      await onUpdateExclusion(trade.id, reason)
    } catch {
      setUpdating(null)
    }
  }
  return (
    <View style={styles.nestedRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.strong}>{accountById.get(trade.accountId) ?? trade.accountId}</Text>
        <Text style={styles.daySub}>
          {trade.side} · {trade.outcome ?? '—'} · qty {formatQuantity(trade.quantity)}
        </Text>
        <View style={{ alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          <Badge status={trade.excludedFromPerformance ? 'offline' : 'online'}>
            {trade.excludedFromPerformance ? 'Excluded' : 'Included'}
          </Badge>
          {(['test_data', 'erroneous', 'clear'] as const).map((reason) => (
            <Pressable key={reason} disabled={updating != null} onPress={() => void handle(reason)}>
              <Text style={[styles.reviewBtn, updating === reason && { opacity: 0.4 }]}>
                {updating === reason ? '…' : reason === 'test_data' ? 'Test' : reason === 'erroneous' ? 'Erroneous' : 'Clear'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: pnlColor(trade.realizedDollarsCents ?? 0), fontWeight: '600' }}>
          {trade.realizedDollarsCents == null ? '—' : formatPnl(trade.realizedDollarsCents)}
        </Text>
        <Text style={[styles.daySub, { color: pnlColor(trade.realizedTicksCents ?? 0) }]}>
          {trade.realizedTicksCents == null ? '—' : formatTicks(trade.realizedTicksCents)}
        </Text>
        <Pressable onPress={() => onDelete(trade.id)}>
          <Text style={{ color: colors.negative, fontSize: 14, marginTop: 4 }}>✕</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  accountChip: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  bigValue: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarHeader: { flexDirection: 'row', marginBottom: 4 },
  calendarHeaderCell: {
    color: c.muted,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
    width: '13.5%',
  },
  chip: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chipSelected: { backgroundColor: c.border, borderColor: c.accent },
  chipText: { color: c.muted, fontSize: 13 },
  container: { backgroundColor: c.bg, flex: 1 },
  content: { padding: 12, paddingBottom: 40 },
  dayCell: {
    borderColor: c.borderLight,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 3,
    minHeight: 44,
    padding: 3,
    width: '13.5%',
  },
  dayCellOff: { borderStyle: 'dashed', opacity: 0.6 },
  dayCellToday: { borderColor: c.accent },
  dayLp: { color: c.accent, fontSize: 7, fontWeight: '600' },
  dayNum: { color: c.text, fontSize: 12, fontWeight: '700' },
  dayNumOff: { color: c.faint, fontSize: 12, fontWeight: '700' },
  dayListDate: { color: c.text, fontSize: 13, fontWeight: '700' },
  dayListLp: { color: '#a855f7', fontSize: 11, fontWeight: '700' },
  dayListPnl: { fontSize: 14, fontWeight: '800' },
  dayListRow: {
    alignItems: 'center',
    borderBottomColor: c.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingVertical: 9,
  },
  dayPnl: { fontSize: 9, fontWeight: '700', marginTop: 1 },
  daySub: { color: c.muted, fontSize: 8 },
  dim: { color: c.muted, fontSize: 13 },
  filledDot: {
    backgroundColor: c.positive,
    borderRadius: 4,
    height: 8,
    marginRight: 6,
    width: 8,
  },
  groupCard: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  groupHeader: { flexDirection: 'row', padding: 10 },
  groupPnl: { fontSize: 16, fontWeight: '700' },
  groupRange: { color: c.accent, fontSize: 14, fontWeight: '600' },
  kicker: {
    color: c.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  kpiHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  modalBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.75)',
    flex: 1,
    justifyContent: 'center',
  },
  nestedRow: {
    borderTopColor: c.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    padding: 10,
  },
  openCard: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    padding: 10,
  },
  openCardHeader: { alignItems: 'center', flexDirection: 'row', marginBottom: 6 },
  openCardTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  openCell: { color: c.text, fontSize: 11 },
  openRow: {
    alignItems: 'center',
    backgroundColor: c.card,
    borderRadius: 6,
    flexDirection: 'row',
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  pager: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  rangeBreakdown: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 6,
    padding: 10,
  },
  reviewBtn: { color: c.accent, fontSize: 11, fontWeight: '600' },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  strong: { color: c.text, fontSize: 13, fontWeight: '600' },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  topLink: { color: c.muted, fontSize: 12 },
  unreadBadge: {
    alignItems: 'center',
    backgroundColor: c.negative,
    borderRadius: 7,
    justifyContent: 'center',
    minWidth: 14,
    paddingHorizontal: 3,
    position: 'absolute',
    right: -6,
    top: -4,
  },
  unreadBadgeText: { color: '#fff', fontSize: 8, fontWeight: '800' },
}))
