import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { getJson } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { emitEvent } from '../utils/events'
import {
  BalanceBar,
  Button,
  Card,
  RingChart,
  SelectPicker,
  Stat,
  colors,
  hexToRgba,
  pnlColor,
  themedStyles,
} from '../components/ui'
import { EquityChart, JournalDate } from '../components/charts'
import { TradeAdjustForm } from '../components/TradeAdjustForm'
import { getCachedRanges, getCachedRangesOptimistic, setCachedRanges } from '../utils/ranges-cache'
import {
  calendarMonthLabel,
  formatDollars,
  formatJournalDateKey,
  formatPercent,
  formatPnl,
  formatPnlCompact,
  formatQuantity,
  formatTicks,
} from '../utils/format'
import { currentJournalDateKey, journalDateFromKey } from '../utils/ranges'
import {
  formatForexFactoryEventDateLabel,
  useForexFactoryEvents,
  type ForexFactoryEvent,
} from '../utils/forex-factory'
import { getDeepLifePath } from '../utils/numerology'
import { displayInstrument } from '../utils/instruments'
import { placeholderMonthView } from '../utils/calendar-placeholder'
import type {
  CalendarDay,
  RangeTradeEvent,
  TradeCalendarMonthView,
} from '../types'

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

function daysInMonth(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number)
  return new Date(year, month, 0).getDate()
}

function monthOffset(monthKey: string): number {
  const [year, month] = monthKey.split('-').map(Number)
  return new Date(year, month - 1, 1).getDay()
}

function MetricsPanel({ calendar }: { calendar: TradeCalendarMonthView }) {
  const { summary } = calendar
  const winRate = summary.winRate == null ? 0 : Math.max(0, Math.min(100, summary.winRate * 100))
  const avgWinAbs = summary.averageWinDollarsCents == null ? 0 : Math.abs(summary.averageWinDollarsCents)
  const avgLossAbs = summary.averageLossDollarsCents == null ? 0 : Math.abs(summary.averageLossDollarsCents)
  const avgTotal = Math.max(1, avgWinAbs + avgLossAbs)
  const avgWinPct = Math.round((avgWinAbs / avgTotal) * 100)
  const avgLossPct = 100 - avgWinPct
  const avgWinLossValue =
    avgWinAbs === 0 && avgLossAbs === 0 ? '—' : `${formatDollars(avgWinAbs)} / ${formatDollars(avgLossAbs)}`

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
    <View style={styles.metricsGrid}>
      <Card title="Trade win %">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <RingChart positive={winRate} negative={Math.max(0, 100 - winRate)} label={formatPercent(summary.winRate)} size={72} />
          <View>
            <Text style={styles.dim}>Wins <Text style={styles.value}>{summary.wins}</Text></Text>
            <Text style={styles.dim}>Losses <Text style={styles.value}>{summary.losses}</Text></Text>
            <Text style={styles.dim}>BE <Text style={styles.value}>{summary.breakevens}</Text></Text>
          </View>
        </View>
      </Card>
      <Card title="Avg win/loss">
        <Text style={styles.metricBig}>{avgWinLossValue}</Text>
        <BalanceBar positive={avgWinPct} negative={avgLossPct} />
        <Text style={[styles.dim, { marginTop: 6 }]}>
          Avg win <Text style={styles.value}>{summary.averageWinDollarsCents == null ? '—' : formatDollars(summary.averageWinDollarsCents)}</Text>
        </Text>
        <Text style={styles.dim}>
          Avg loss <Text style={styles.value}>{summary.averageLossDollarsCents == null ? '—' : formatDollars(summary.averageLossDollarsCents)}</Text>
        </Text>
      </Card>
      <Card title="Max drawdown">
        <Text style={styles.metricBig}>{maxDrawdownCents > 0 ? formatDollars(-maxDrawdownCents) : '—'}</Text>
        <Text style={[styles.dim, { marginTop: 6 }]}>Peak {ddPeakDate ? formatJournalDateKey(ddPeakDate) : '—'}</Text>
        <Text style={styles.dim}>Trough {ddTroughDate ? formatJournalDateKey(ddTroughDate) : '—'}</Text>
      </Card>
      <Card title="R earned">
        <Text style={[styles.metricBig, { color: pnlColor(summary.rEarned ?? 0) }]}>
          {summary.rEarned == null ? '—' : `${summary.rEarned > 0 ? '+' : ''}${summary.rEarned.toFixed(1)}R`}
        </Text>
        <Text style={[styles.dim, { marginTop: 6 }]}>Realized <Text style={styles.value}>{formatDollars(summary.realizedDollarsCents)}</Text></Text>
        <Text style={styles.dim}>Trades <Text style={styles.value}>{summary.closedCount}</Text></Text>
      </Card>
    </View>
  )
}

export default function CategoryCalendarScreen() {
  const { user } = useAuth()
  const params = useLocalSearchParams<{ category?: string; month?: string; week?: string; ranges?: string }>()
  const [subcategory, setSubcategory] = useState(params.category ?? '')
  const [month, setMonth] = useState(params.month ?? thisMonth())
  const [week, setWeek] = useState<string>(params.week ?? '')
  const [includedRanges, setIncludedRanges] = useState<string[]>(
    params.ranges?.split(',').filter(Boolean) ?? [],
  )
  const [rangesData, setRangesData] = useState<RangesData | undefined>(() => getCachedRangesOptimistic())
  const [serverCalendar, setServerCalendar] = useState<TradeCalendarMonthView | undefined>()
  const [fetching, setFetching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
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
      .catch(() => {})
  }, [user?.userId])

  const subcategories = useMemo(() => rangesData?.rangeSubcategories ?? [], [rangesData])

  const assignedRangeNames = useMemo(() => {
    const assignments = rangesData?.rangeSubcategoryAssignments ?? []
    if (!subcategory) return []
    return [...new Set(assignments.filter((a) => a.subcategoryName === subcategory).map((a) => a.rangeName))]
  }, [rangesData, subcategory])

  const fetchCalendar = useCallback(() => {
    if (!subcategory || !month) return
    setFetching(true)
    const rangeParam = includedRanges.length > 0 ? `&ranges=${encodeURIComponent(includedRanges.join(','))}` : ''
    const weekParam = week ? `&week=${encodeURIComponent(week)}` : ''
    getJson<TradeCalendarMonthView>(
      `/api/category/calendar?subcategory=${encodeURIComponent(subcategory)}&month=${month}${weekParam}${rangeParam}`,
    )
      .then((fresh) => setServerCalendar(fresh))
      .catch(() => {})
      .finally(() => {
        setFetching(false)
        setRefreshing(false)
      })
  }, [subcategory, month, week, includedRanges])

  useEffect(() => {
    fetchCalendar()
  }, [fetchCalendar])

  const [nextCalendar, setNextCalendar] = useState<TradeCalendarMonthView | undefined>()
  useEffect(() => {
    const [y, m] = month.split('-').map(Number)
    if (!y || !m) return
    const nextKey = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`
    const rangeParam = includedRanges.length > 0 ? `&ranges=${encodeURIComponent(includedRanges.join(','))}` : ''
    getJson<TradeCalendarMonthView>(
      `/api/category/calendar?subcategory=${encodeURIComponent(subcategory)}&month=${nextKey}${rangeParam}`,
    ).then(setNextCalendar).catch(() => setNextCalendar(undefined))
  }, [subcategory, month, includedRanges])

  const calendar = serverCalendar ?? placeholderCalendar
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

  const offset = monthOffset(calendar.month)
  const totalDays = daysInMonth(calendar.month)
  const [yearNum, monthNum] = calendar.month.split('-').map(Number)
  const prevMonthDays = new Date(yearNum, monthNum - 1, 0).getDate()
  const prevMonthKey = `${monthNum === 1 ? yearNum - 1 : yearNum}-${String(monthNum === 1 ? 12 : monthNum - 1).padStart(2, '0')}`
  const todayKey = currentJournalDateKey()
  const canGoNext = month < thisMonth()
  const prefix = `${calendar.month}-`

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            fetchCalendar()
          }}
          tintColor={colors.accent}
        />
      }
    >
      <MetricsPanel calendar={calendar} />

      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
        <View style={{ flex: 1 }}>
          <SelectPicker
            label="Model"
            options={[
              { value: '', label: 'Select a model' },
              ...subcategories.map((c) => ({ value: c.name, label: c.name })),
            ]}
            value={subcategory}
            onChange={(v) => {
              setSubcategory(v)
              setIncludedRanges([])
            }}
          />
        </View>
        <Button small variant="ghost" title={showFilters ? 'Hide filters ▲' : 'Filters ▼'} onPress={() => setShowFilters((s) => !s)} />
      </View>

      {showFilters ? (
        <Card title="Filters">
          <SelectPicker
            label="Week"
            options={[
              { value: '', label: 'All weeks' },
              { value: '1', label: 'Week 1' },
              { value: '2', label: 'Week 2' },
              { value: '3', label: 'Week 3' },
              { value: '4', label: 'Week 4' },
              { value: '5', label: 'Week 5' },
            ]}
            value={week}
            onChange={setWeek}
          />
          <View style={{ flexDirection: 'row', gap: 8, marginVertical: 8 }}>
            <Button small variant="ghost" title="← Prev" onPress={() => setMonth(shiftMonth(month, -1))} />
            <Button small variant="ghost" title="Next →" disabled={!canGoNext} onPress={() => setMonth(shiftMonth(month, 1))} />
          </View>
          {subcategory && assignedRangeNames.length > 0 ? (
            <View>
              <Text style={[styles.dim, { marginBottom: 6 }]}>Filter ranges</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {assignedRangeNames.map((rangeName) => {
                  const checked = includedRanges.length === 0 || includedRanges.includes(rangeName)
                  return (
                    <Pressable
                      key={rangeName}
                      onPress={() =>
                        setIncludedRanges(
                          checked && includedRanges.length > 0
                            ? includedRanges.filter((r) => r !== rangeName)
                            : [...includedRanges, rangeName],
                        )
                      }
                      style={[styles.chip, checked && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, checked && { color: colors.accent }]}>{rangeName}</Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          ) : null}
        </Card>
      ) : null}

      {subcategory ? <EquityChart label={subcategory} query={`subcategory=${encodeURIComponent(subcategory)}`} /> : null}

      <Text style={[styles.sectionTitle, { marginTop: 8 }]}>{calendarMonthLabel(calendar.month)}{fetching ? ' …' : ''}</Text>
      <View style={styles.grid}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
          <Text key={i} style={styles.gridHeader}>{d}</Text>
        ))}
        {Array.from({ length: offset }, (_, i) => {
          const dayNumber = prevMonthDays - offset + i + 1
          const dateKey = `${prevMonthKey}-${String(dayNumber).padStart(2, '0')}`
          const day = trailingMap.get(dateKey)
          return (
            <View key={`prev-${i}`} style={[styles.dayCell, { opacity: 0.6 }]}>
              <Text style={styles.dayNumDim}>{dayNumber}</Text>
              {day ? (
                <Text style={[styles.dayPnl, { color: pnlColor(day.realizedDollarsCents) }]} numberOfLines={1}>
                  {formatPnl(day.realizedDollarsCents)}
                </Text>
              ) : null}
            </View>
          )
        })}
        {Array.from({ length: totalDays }, (_, i) => {
          const dayNumber = i + 1
          const dateKey = `${prefix}${String(dayNumber).padStart(2, '0')}`
          const day = dayMap.get(dateKey)
          const numerology = getDeepLifePath(dateKey)
          const hidden = day?.hiddenFromPerformance ?? false
          const dateLabel = formatForexFactoryEventDateLabel(journalDateFromKey(dateKey))
          const dayRedEvents = eventsByDate.get(dateLabel) ?? []
          const isBeDay = day && day.netTicksCents === 0 && (day?.closedCount ?? 0) > 0
          const isGrey = !day || hidden
          return (
            <Pressable
              key={dateKey}
              disabled={!day}
              onPress={() => serverCalendar && day && setSelectedDay(day)}
              style={[
                styles.dayCell,
                day
                  ? isBeDay || (!isGrey && day.realizedDollarsCents > 0)
                    ? { backgroundColor: hexToRgba(colors.positive, 0.16), borderColor: colors.positive }
                    : isGrey
                      ? { opacity: 0.6 }
                      : { backgroundColor: hexToRgba(colors.negative, 0.16), borderColor: colors.negative }
                  : null,
                dateKey === todayKey && { borderColor: colors.accent },
              ]}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={styles.dayNum}>{dayNumber}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  {dayRedEvents.length > 0 ? <View style={styles.redDot} /> : null}
                  <Text style={styles.lp}>{numerology.lifePathNumber}</Text>
                </View>
              </View>
              {day ? (
                <>
                  <Text style={[styles.dayPnl, { color: pnlColor(day.realizedDollarsCents) }]} numberOfLines={1}>
                    {formatPnlCompact(day.realizedDollarsCents)}
                  </Text>
                  {hidden ? <Text style={styles.dayTag}>EXCL</Text> : isBeDay ? <Text style={[styles.dayTag, { color: colors.positive }]}>BE</Text> : null}
                </>
              ) : dateKey <= todayKey ? (
                <Text style={styles.daySub}>—</Text>
              ) : null}
            </Pressable>
          )
        })}
        {(() => {
          const usedCells = offset + totalDays
          const nextCount = usedCells % 7 === 0 ? 0 : 7 - (usedCells % 7)
          const nextMap = new Map((nextCalendar?.days ?? []).map((d) => [d.date, d]))
          const [ny, nm] = month.split('-').map(Number)
          const nextMonthKey = `${nm === 12 ? ny + 1 : ny}-${String(nm === 12 ? 1 : nm + 1).padStart(2, '0')}`
          return Array.from({ length: nextCount }, (_, i) => {
            const dateKey = `${nextMonthKey}-${String(i + 1).padStart(2, '0')}`
            const day = nextMap.get(dateKey)
            return (
              <View key={`next-${i}`} style={[styles.dayCell, { opacity: 0.6 }]}>
                <Text style={styles.dayNumDim}>{i + 1}</Text>
                {day ? (
                  <Text style={[styles.dayPnl, { color: pnlColor(day.realizedDollarsCents) }]}>
                    {formatPnl(day.realizedDollarsCents)}
                  </Text>
                ) : null}
              </View>
            )
          })
        })()}
      </View>

      <Modal visible={selectedDay !== null} transparent animationType="fade" onRequestClose={() => { setSelectedDay(null); setEditingTrade(null) }}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            {editingTrade ? (
              <ScrollView>
                <Button small variant="ghost" title="← Back to day" onPress={() => setEditingTrade(null)} />
                <TradeAdjustForm
                  trade={editingTrade}
                  onCancel={() => setEditingTrade(null)}
                  onSave={() => {
                    setEditingTrade(null)
                    fetchCalendar()
                    emitEvent('journal:refresh')
                  }}
                  onDelete={() => {
                    setEditingTrade(null)
                    fetchCalendar()
                    emitEvent('journal:refresh')
                  }}
                />
              </ScrollView>
            ) : selectedDay ? (
              <ScrollView>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={styles.monthLabel}>{formatJournalDateKey(selectedDay.date)}</Text>
                  <Button small variant="ghost" title="Close" onPress={() => setSelectedDay(null)} />
                </View>
                <View style={styles.metricsRow}>
                  <Stat label="P&L" value={formatPnl(selectedDay.realizedDollarsCents)} color={pnlColor(selectedDay.realizedDollarsCents)} />
                  <Stat label="Ticks" value={formatTicks(selectedDay.netTicksCents)} color={pnlColor(selectedDay.netTicksCents)} />
                  <Stat label="Win rate" value={formatPercent(selectedDay.winRate)} />
                  <Stat label="Closed" value={String(selectedDay.closedCount)} />
                </View>
                {(() => {
                  const dayNews = redFolderEvents.filter(
                    (event) =>
                      event.impact.toLowerCase() === 'high' &&
                      event.date === formatForexFactoryEventDateLabel(journalDateFromKey(selectedDay.date)),
                  )
                  return dayNews.length > 0 ? (
                    <View style={{ marginVertical: 8 }}>
                      <Text style={styles.sectionTitle}>Red folder news</Text>
                      {dayNews.map((event) => (
                        <Text key={event.eventId} style={styles.dimSmall}>
                          {event.title} · {event.time} · {event.currency}
                        </Text>
                      ))}
                    </View>
                  ) : null
                })()}
                {selectedDay.ranges.length > 0 ? (
                  <View style={{ marginVertical: 8 }}>
                    <Text style={styles.sectionTitle}>Range breakdown</Text>
                    {selectedDay.ranges.map((range) => (
                      <View key={`${range.rangeName}-${range.instrument}`} style={styles.breakRow}>
                        <Text style={styles.value}>{range.rangeName} ({displayInstrument(range.instrument)})</Text>
                        <Text style={[styles.dimSmall, { color: pnlColor(range.realizedDollarsCents) }]}>
                          {formatPnl(range.realizedDollarsCents)} · {formatTicks(range.netTicksCents)} · {range.closedCount} closed
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <Text style={[styles.sectionTitle, { marginTop: 8 }]}>Trades taken</Text>
                {(selectedDay.trades ?? []).map((trade) => (
                  <View key={trade.id} style={styles.tradeRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.value}>
                        {trade.rangeName} · {displayInstrument(trade.instrument)} · {trade.side}
                      </Text>
                      <Text style={styles.dimSmall}>
                        <JournalDate value={trade.occurredAt} /> · qty {formatQuantity(trade.quantity)}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ color: pnlColor(trade.realizedDollarsCents ?? 0), fontWeight: '700', fontSize: 13 }}>
                        {formatPnl(trade.realizedDollarsCents ?? 0)} ({trade.outcome ?? '—'})
                      </Text>
                      <Text style={styles.dimSmall}>{formatTicks(trade.realizedTicksCents ?? 0)}</Text>
                      <Button small variant="ghost" title="Adjust" onPress={() => setEditingTrade(trade)} />
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>
    </ScrollView>
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  breakRow: {
    borderBottomColor: c.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  chip: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipActive: { backgroundColor: hexToRgba(c.accent, 0.12), borderColor: c.accent },
  chipText: { color: c.muted, fontSize: 11 },
  container: { backgroundColor: c.bg, flex: 1 },
  dayCell: {
    aspectRatio: 0.85,
    backgroundColor: c.card,
    borderColor: c.borderLight,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
    width: '13.5%',
  },
  dayNum: { color: c.text, fontSize: 11, fontWeight: '700' },
  dayNumDim: { color: c.faint, fontSize: 11, fontWeight: '700' },
  dayPnl: { fontSize: 10, fontWeight: '700' },
  daySub: { color: c.muted, fontSize: 9 },
  dayTag: { color: c.muted, fontSize: 8, fontWeight: '800' },
  dim: { color: c.muted, fontSize: 12 },
  dimSmall: { color: c.muted, fontSize: 11 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  gridHeader: { color: c.faint, fontSize: 10, fontWeight: '700', textAlign: 'center', width: '13.5%' },
  lp: { color: c.accent, fontSize: 9, fontWeight: '700' },
  metricBig: { color: c.text, fontSize: 20, fontWeight: '800' },
  metricsGrid: { gap: 8, marginBottom: 8 },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginVertical: 8 },
  modalBackdrop: { backgroundColor: 'rgba(0,0,0,0.75)', flex: 1, justifyContent: 'center', padding: 12 },
  modalCard: {
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: '92%',
    padding: 14,
  },
  monthLabel: { color: c.text, fontSize: 16, fontWeight: '700' },
  redDot: { backgroundColor: '#dc2626', borderRadius: 4, height: 8, width: 8 },
  sectionTitle: { color: c.text, fontSize: 14, fontWeight: '700', marginBottom: 4 },
  tradeRow: {
    borderTopColor: c.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
  },
  value: { color: c.text, fontSize: 13, fontWeight: '600' },
}))
