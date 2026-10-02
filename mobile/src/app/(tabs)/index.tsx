import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { Card, Spinner, Stat, colors, pnlColor } from '../../components/ui'
import type {
  CalendarDay,
  JournalMetrics,
  TradeCalendarMonthView,
  TradeEvent,
  TradeJournal,
  TradeJournalDay,
} from '../../types'
import {
  calendarMonthLabel,
  formatJournalDateKey,
  formatPercent,
  formatPnl,
  formatPrice,
  formatQuantity,
  formatTicks,
  formatTime,
  journalMonthKey,
  shiftMonth,
} from '../../utils/format'

interface JournalResponse {
  tradeJournal: TradeJournal
  calendar: TradeCalendarMonthView
  journalDays: Record<string, TradeJournalDay>
}

function MetricsRow({ metrics }: { metrics: JournalMetrics }) {
  return (
    <View style={styles.metricsRow}>
      <Stat
        label="Realized"
        value={formatPnl(metrics.realizedDollarsCents)}
        color={pnlColor(metrics.realizedDollarsCents)}
      />
      <Stat
        label="Ticks"
        value={formatTicks(metrics.netTicksCents)}
        color={pnlColor(metrics.netTicksCents)}
      />
      <Stat label="Closed" value={String(metrics.closedCount)} />
      <Stat label="Win rate" value={formatPercent(metrics.winRate)} />
      <Stat
        label="W / L / BE"
        value={`${metrics.wins}/${metrics.losses}/${metrics.breakevens}`}
      />
    </View>
  )
}

function TradeRow({ trade }: { trade: TradeEvent }) {
  const pnl = trade.realizedDollarsCents
  return (
    <View style={styles.tradeRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.tradeTitle}>
          {trade.instrument} · {trade.side} ×{formatQuantity(trade.quantity)}
        </Text>
        <Text style={styles.tradeSub}>
          {trade.rangeName} · {trade.eventType.replace('_', ' ')} ·{' '}
          {formatTime(trade.occurredAt)}
          {trade.entryPrice != null ? ` · @ ${formatPrice(trade.entryPrice)}` : ''}
          {trade.exitPrice != null ? ` → ${formatPrice(trade.exitPrice)}` : ''}
        </Text>
      </View>
      {pnl != null ? (
        <Text style={[styles.tradePnl, { color: pnlColor(pnl) }]}>
          {formatPnl(pnl)}
        </Text>
      ) : trade.outcome ? (
        <Text style={styles.tradeSub}>{trade.outcome}</Text>
      ) : null}
    </View>
  )
}

function DayItem({ day, detail }: { day: CalendarDay; detail?: TradeJournalDay }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <View style={styles.day}>
      <Pressable onPress={() => setExpanded((v) => !v)} style={styles.dayHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.dayDate}>{formatJournalDateKey(day.date)}</Text>
          <Text style={styles.daySub}>
            {day.closedCount} closed · {day.wins}W/{day.losses}L
            {day.breakevens ? `/${day.breakevens}BE` : ''}
          </Text>
        </View>
        <Text style={[styles.dayPnl, { color: pnlColor(day.realizedDollarsCents) }]}>
          {formatPnl(day.realizedDollarsCents)}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.dayBody}>
          {day.ranges.map((r) => (
            <Text key={r.rangeName} style={styles.rangeLine}>
              {r.rangeName} ({r.instrument}) — {formatPnl(r.realizedDollarsCents)},{' '}
              {r.closedCount} closed
            </Text>
          ))}
          {(detail?.trades ?? [])
            .filter((t) => t.eventType === 'trade_closed' || t.eventType === 'exit_filled')
            .map((t) => (
              <TradeRow key={t.id} trade={t} />
            ))}
          {!detail || detail.trades.length === 0 ? (
            <Text style={styles.daySub}>No trade detail for this day.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

export default function JournalScreen() {
  const { user } = useAuth()
  const [month, setMonth] = useState(journalMonthKey())
  const [data, setData] = useState<JournalResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await getJson<JournalResponse>(`/api/journal?month=${month}`)
      setData(res)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load journal')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [month])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load, user?.userId])

  const summary = data?.calendar.summary
  const days = (data?.calendar.days ?? [])
    .filter((d) => d.closedCount > 0)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))

  return (
    <View style={styles.container}>
      <View style={styles.monthNav}>
        <Pressable onPress={() => setMonth(shiftMonth(month, -1))}>
          <Text style={styles.navArrow}>‹</Text>
        </Pressable>
        <Text style={styles.monthLabel}>{calendarMonthLabel(month)}</Text>
        <Pressable
          disabled={month >= journalMonthKey()}
          onPress={() => setMonth(shiftMonth(month, 1))}
        >
          <Text
            style={[
              styles.navArrow,
              month >= journalMonthKey() && { opacity: 0.3 },
            ]}
          >
            ›
          </Text>
        </Pressable>
      </View>
      {loading && !data ? (
        <Spinner />
      ) : error && !data ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={days}
          keyExtractor={(d) => d.date}
          ListHeaderComponent={
            <>
              {summary ? (
                <Card title="Month summary">
                  <MetricsRow metrics={summary} />
                </Card>
              ) : null}
              {data?.tradeJournal?.openTrades?.length ? (
                <Card title="Open trades">
                  {data.tradeJournal.openTrades.map((t) => (
                    <TradeRow key={t.id} trade={t} />
                  ))}
                </Card>
              ) : null}
              {days.length === 0 ? (
                <Text style={styles.empty}>No closed trades this month.</Text>
              ) : null}
            </>
          }
          refreshControl={
            <RefreshControl
              onRefresh={() => {
                setRefreshing(true)
                void load()
              }}
              refreshing={refreshing}
              tintColor={colors.accent}
            />
          }
          renderItem={({ item }) => (
            <DayItem day={item} detail={data?.journalDays[item.date]} />
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bg, flex: 1 },
  day: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    padding: 12,
  },
  dayBody: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    marginTop: 8,
    paddingTop: 8,
  },
  dayDate: { color: colors.text, fontSize: 15, fontWeight: '600' },
  dayHeader: { alignItems: 'center', flexDirection: 'row' },
  dayPnl: { fontSize: 16, fontWeight: '700' },
  daySub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  empty: { color: colors.muted, paddingVertical: 20, textAlign: 'center' },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  list: { padding: 12 },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  monthLabel: { color: colors.text, fontSize: 17, fontWeight: '700' },
  monthNav: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  navArrow: { color: colors.accent, fontSize: 28, paddingHorizontal: 16 },
  rangeLine: { color: colors.muted, fontSize: 12, marginBottom: 6 },
  tradePnl: { fontSize: 14, fontWeight: '700' },
  tradeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingVertical: 6,
  },
  tradeSub: { color: colors.muted, fontSize: 12 },
  tradeTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
})
