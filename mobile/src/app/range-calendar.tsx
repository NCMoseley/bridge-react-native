import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson } from '../api/client'
import { Spinner, colors, pnlColor } from '../components/ui'
import type { RangesData, TradeCalendarMonthView } from '../types'
import {
  calendarMonthLabel,
  formatJournalDateKey,
  formatPnl,
  journalMonthKey,
  shiftMonth,
} from '../utils/format'

export default function RangeCalendarScreen() {
  const [ranges, setRanges] = useState<string[]>([])
  const [range, setRange] = useState<string>('')
  const [month, setMonth] = useState(journalMonthKey())
  const [calendar, setCalendar] = useState<TradeCalendarMonthView | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getJson<RangesData>('/api/ranges')
      .then((d) => {
        const names = d.rangeConfigurations.map((c) => c.rangeName).sort()
        setRanges(names)
        if (names.length) setRange(names[0])
      })
      .catch(() => setError('Failed to load ranges'))
      .finally(() => setLoading(false))
  }, [])

  const load = useCallback(async () => {
    if (!range) return
    try {
      setCalendar(
        await getJson<TradeCalendarMonthView>(
          `/api/range/calendar?range=${encodeURIComponent(range)}&month=${month}`,
        ),
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load calendar')
    } finally {
      setRefreshing(false)
    }
  }, [range, month])

  useEffect(() => {
    void load()
  }, [load])

  const days = useMemo(
    () =>
      (calendar?.days ?? [])
        .filter((d) => d.closedCount > 0)
        .slice()
        .sort((a, b) => b.date.localeCompare(a.date)),
    [calendar],
  )

  if (loading) return <Spinner />

  return (
    <View style={styles.container}>
      <FlatList
        contentContainerStyle={styles.list}
        data={days}
        keyExtractor={(d) => d.date}
        ListHeaderComponent={
          <>
            <FlatList
              data={ranges}
              horizontal
              keyExtractor={(r) => r}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => setRange(item)}
                  style={[styles.chip, item === range && styles.chipActive]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      item === range && styles.chipTextActive,
                    ]}
                  >
                    {item}
                  </Text>
                </Pressable>
              )}
              showsHorizontalScrollIndicator={false}
            />
            <View style={styles.monthNav}>
              <Pressable onPress={() => setMonth(shiftMonth(month, -1))}>
                <Text style={styles.navArrow}>‹</Text>
              </Pressable>
              <Text style={styles.monthLabel}>{calendarMonthLabel(month)}</Text>
              <Pressable onPress={() => setMonth(shiftMonth(month, 1))}>
                <Text style={styles.navArrow}>›</Text>
              </Pressable>
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {calendar && days.length === 0 ? (
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
          <View style={styles.dayRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.dayDate}>
                {formatJournalDateKey(item.date)}
              </Text>
              <Text style={styles.sub}>
                {item.closedCount} closed · {item.wins}W/{item.losses}L
              </Text>
            </View>
            <Text
              style={[
                styles.dayPnl,
                { color: pnlColor(item.realizedDollarsCents) },
              ]}
            >
              {formatPnl(item.realizedDollarsCents)}
            </Text>
          </View>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    marginRight: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.muted, fontSize: 12 },
  chipTextActive: { color: '#082f49', fontWeight: '700' },
  container: { backgroundColor: colors.bg, flex: 1 },
  dayDate: { color: colors.text, fontSize: 14, fontWeight: '600' },
  dayPnl: { fontSize: 15, fontWeight: '700' },
  dayRow: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 12,
  },
  empty: { color: colors.muted, paddingVertical: 16, textAlign: 'center' },
  error: { color: colors.negative, marginVertical: 12, textAlign: 'center' },
  list: { padding: 12 },
  monthLabel: { color: colors.text, fontSize: 16, fontWeight: '700' },
  monthNav: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  navArrow: { color: colors.accent, fontSize: 28, paddingHorizontal: 16 },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
})
