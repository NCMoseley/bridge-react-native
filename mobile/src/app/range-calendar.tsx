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
import { useLocalSearchParams, useRouter } from 'expo-router'
import { getJson, postForm } from '../api/client'
import { useToast } from '../context/ToastContext'
import { emitEvent } from '../utils/events'
import {
  Badge,
  Button,
  SelectPicker,
  Spinner,
  Stat,
  colors,
  hexToRgba,
  pnlColor,
  themedStyles,
} from '../components/ui'
import { EquityChart, JournalDate } from '../components/charts'
import { RangeDetailSections } from '../components/RangeDetailSections'
import { TradeAdjustForm } from '../components/TradeAdjustForm'
import { getCachedRangeCalendar, setCachedRangeCalendar } from '../utils/range-calendar-cache'
import {
  calendarMonthLabel,
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
import type { CalendarDay, RangeTradeEvent, TradeCalendarMonthView } from '../types'

function journalMonthKey(): string {
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

function RedDot({ events }: { events: ForexFactoryEvent[] }) {
  const [show, setShow] = useState(false)
  return (
    <View>
      <Pressable onPress={() => setShow((v) => !v)} style={styles.redDot} />
      {show ? (
        <View style={styles.redDotDetail}>
          {events.map((e) => (
            <Text key={e.eventId} style={styles.dimSmall}>
              {e.time} · {e.title} ({e.currency})
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  )
}

export default function RangeCalendarScreen() {
  const params = useLocalSearchParams<{ range?: string; month?: string }>()
  const router = useRouter()
  const { success, error } = useToast()
  const currentMonth = useMemo(() => journalMonthKey(), [])
  const [pickerRange, setPickerRange] = useState('')
  const [ranges, setRanges] = useState<string[]>([])
  const rangeName = params.range || pickerRange
  const [month, setMonth] = useState(params.month ?? currentMonth)
  const [serverCalendar, setServerCalendar] = useState<TradeCalendarMonthView | undefined>(() =>
    rangeName ? getCachedRangeCalendar(rangeName, month) : undefined,
  )
  const [, setFetching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null)
  const [editingTrade, setEditingTrade] = useState<RangeTradeEvent | null>(null)

  useEffect(() => {
    if (params.range) return
    getJson<{ rangeConfigurations: { rangeName: string }[] }>('/api/ranges')
      .then((d) => {
        const names = d.rangeConfigurations.map((c) => c.rangeName).sort()
        setRanges(names)
        if (names.length && !pickerRange) setPickerRange(names[0])
      })
      .catch(() => {})
  }, [])

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
      .catch(() => {})
      .finally(() => {
        setFetching(false)
        setRefreshing(false)
      })
  }, [rangeName, month])

  const [nextCalendar, setNextCalendar] = useState<TradeCalendarMonthView | undefined>()
  useEffect(() => {
    if (!rangeName || !month) return
    const [y, m] = month.split('-').map(Number)
    if (!y || !m) return
    const nextKey = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`
    getJson<TradeCalendarMonthView>(
      `/api/range/calendar?range=${encodeURIComponent(rangeName)}&month=${nextKey}`,
    ).then(setNextCalendar).catch(() => setNextCalendar(undefined))
  }, [rangeName, month])

  useEffect(() => {
    const cached = rangeName ? getCachedRangeCalendar(rangeName, month) : undefined
    if (cached) setServerCalendar(cached)
    fetchCalendar()
  }, [fetchCalendar])

  const go = (nextMonth: string) => {
    setMonth(nextMonth)
  }

  const { events: redFolderEvents } = useForexFactoryEvents(month)

  const toggleHidden = (dateKey: string, currentlyHidden: boolean) => {
    const nextHidden = !currentlyHidden
    postForm('/ranges/calendar/day-visibility', {
      rangeName,
      dateKey,
      hidden: String(nextHidden),
      month: calendar.month,
    })
      .then(() => {
        success(nextHidden ? 'Day excluded' : 'Day included')
        fetchCalendar()
      })
      .catch((err) => error(err instanceof Error ? err.message : 'Failed to update day'))
  }

  const calendar = serverCalendar ?? placeholderMonthView(month)
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
  const [yearNum, monthNum] = calendar.month.split('-').map(Number)
  const prevMonthDays = new Date(yearNum, monthNum - 1, 0).getDate()
  const prevMonthKey = `${monthNum === 1 ? yearNum - 1 : yearNum}-${String(monthNum === 1 ? 12 : monthNum - 1).padStart(2, '0')}`
  const summary = calendar.summary
  const todayKey = currentJournalDateKey()
  const canGoNext = month < currentMonth

  if (!rangeName) {
    return (
      <View style={styles.container}>
        {loadingOrNothing(ranges.length === 0)}
        <SelectPicker
          label="Range"
          options={ranges.map((r) => ({ value: r, label: r }))}
          value={pickerRange}
          onChange={setPickerRange}
        />
      </View>
    )
  }

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
      {!params.range ? (
        <SelectPicker
          label="Range"
          options={ranges.map((r) => ({ value: r, label: r }))}
          value={pickerRange}
          onChange={setPickerRange}
        />
      ) : null}
      <Button
        small
        variant="ghost"
        title="← Back to ranges"
        onPress={() => router.push(`/ranges?range=${encodeURIComponent(rangeName)}`)}
        style={{ alignSelf: 'flex-start', marginBottom: 8 }}
      />

      <RangeDetailSections rangeName={rangeName} sections={['settings']} />

      {rangeName ? (
        <EquityChart label={rangeName} query={`range=${encodeURIComponent(rangeName)}`} />
      ) : null}

      <View style={styles.monthNav}>
        <Button small variant="ghost" title="← Prev" onPress={() => go(shiftMonth(month, -1))} />
        <Text style={styles.monthLabel}>{calendarMonthLabel(calendar.month)}</Text>
        <Button small variant="ghost" title="Next →" disabled={!canGoNext} onPress={() => go(shiftMonth(month, 1))} />
      </View>

      <View style={styles.summaryRow}>
        <Stat label="Month P&L" value={formatPnl(summary.realizedDollarsCents)} color={pnlColor(summary.realizedDollarsCents)} />
        <Stat label="Ticks" value={formatTicks(summary.netTicksCents)} color={pnlColor(summary.netTicksCents)} />
        <Stat label="Triggered" value={String(summary.closedCount)} />
        <Stat label="W/L" value={`${summary.wins}/${summary.losses}`} />
        <Stat label="Win rate" value={formatPercent(summary.winRate)} />
        <Stat
          label="R earned"
          value={summary.rEarned == null ? '—' : `${summary.rEarned > 0 ? '+' : ''}${summary.rEarned.toFixed(1)}R`}
          color={pnlColor(summary.rEarned ?? 0)}
        />
      </View>

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
                <Text style={[styles.dayPnl, { color: pnlColor(day.realizedDollarsCents) }]}>
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
              onLongPress={() => day && rangeName && toggleHidden(day.date, hidden)}
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
                  {dayRedEvents.length > 0 ? <RedDot events={dayRedEvents} /> : null}
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
      <Text style={[styles.dimSmall, { marginTop: 4 }]}>
        Long-press a day to exclude/include it from range performance.
      </Text>

      <RangeDetailSections rangeName={rangeName} sections={['simulation', 'alerts', 'dispatches', 'ct-dispatches']} />

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
                    setSelectedDay(null)
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
                <View style={styles.summaryRow}>
                  <Stat label="P&L" value={formatPnl(selectedDay.realizedDollarsCents)} color={pnlColor(selectedDay.realizedDollarsCents)} />
                  <Stat label="Ticks" value={formatTicks(selectedDay.netTicksCents)} color={pnlColor(selectedDay.netTicksCents)} />
                  <Stat label="Win rate" value={formatPercent(selectedDay.winRate)} />
                  <Stat label="Closed" value={String(selectedDay.closedCount)} />
                  <Stat
                    label="R earned"
                    value={selectedDay.rEarned == null ? '—' : `${selectedDay.rEarned > 0 ? '+' : ''}${selectedDay.rEarned.toFixed(1)}R`}
                    color={pnlColor(selectedDay.rEarned ?? 0)}
                  />
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
                          {event.time} · {event.title} ({event.currency})
                        </Text>
                      ))}
                    </View>
                  ) : null
                })()}
                <Text style={[styles.sectionTitle, { marginTop: 8 }]}>Trades taken</Text>
                {(selectedDay.trades ?? []).map((trade) => (
                  <View key={trade.id} style={styles.tradeRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.value}>
                        {displayInstrument(trade.instrument)} · {trade.side}
                      </Text>
                      <Text style={styles.dimSmall}>
                        <JournalDate value={trade.occurredAt} /> · qty {formatQuantity(trade.quantity)}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Badge
                        status={trade.outcome === 'win' ? 'online' : trade.outcome === 'loss' ? 'error' : 'offline'}
                      >
                        {trade.outcome ?? '—'}
                      </Badge>
                      <Text style={{ color: pnlColor(trade.realizedDollarsCents ?? 0), fontWeight: '700', fontSize: 13 }}>
                        {formatPnl(trade.realizedDollarsCents ?? 0)}
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

function loadingOrNothing(loading: boolean) {
  return loading ? <Spinner /> : null
}

const styles = themedStyles((c) => StyleSheet.create({
  container: { backgroundColor: c.bg, flex: 1, padding: 12 },
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
  dimSmall: { color: c.muted, fontSize: 11 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
    justifyContent: 'flex-start',
  },
  gridHeader: {
    color: c.faint,
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
    width: '13.5%',
  },
  lp: { color: c.accent, fontSize: 9, fontWeight: '700' },
  modalBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.75)',
    flex: 1,
    justifyContent: 'center',
    padding: 12,
  },
  modalCard: {
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: '92%',
    padding: 14,
  },
  monthLabel: { color: c.text, fontSize: 16, fontWeight: '700' },
  monthNav: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 8,
  },
  redDot: {
    backgroundColor: '#dc2626',
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  redDotDetail: {
    position: 'absolute',
    right: 0,
    top: 10,
    width: 140,
    zIndex: 10,
  },
  sectionTitle: { color: c.text, fontSize: 14, fontWeight: '700', marginBottom: 4 },
  summaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginBottom: 8 },
  tradeRow: {
    borderTopColor: c.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
  },
  value: { color: c.text, fontSize: 13, fontWeight: '600' },
}))
