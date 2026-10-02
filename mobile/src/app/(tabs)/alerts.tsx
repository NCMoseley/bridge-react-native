import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { Card, Spinner, Stat, colors } from '../../components/ui'
import type {
  AlertActivityFilter,
  AlertFeedEntry,
  AlertFeedSummary,
  AlertTimeFilter,
} from '../../types'
import { formatTime } from '../../utils/format'

const PAGE_SIZE = 25

const TIME_MS: Record<Exclude<AlertTimeFilter, 'all'>, number> = {
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  hour: 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  day: 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
}

const TIME_OPTIONS: { value: AlertTimeFilter; label: string }[] = [
  { value: '15m', label: '15m' },
  { value: 'hour', label: '1h' },
  { value: '4h', label: '4h' },
  { value: 'day', label: '24h' },
  { value: '3d', label: '3d' },
  { value: 'week', label: '7d' },
  { value: 'all', label: 'All' },
]

const ACTIVITY_OPTIONS: { value: AlertActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'routed', label: 'Routed' },
  { value: 'unrouted', label: 'Unrouted' },
  { value: 'lifecycle', label: 'Lifecycle' },
  { value: 'traderspost_delivered', label: 'TP delivered' },
  { value: 'traderspost_failed', label: 'TP failed' },
]

interface AlertsResponse {
  alerts: AlertFeedEntry[]
  totalCount: number
  rangeNames: string[]
  summary: AlertFeedSummary
}

function ChipRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.chipRow}>
        {options.map((o) => (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={[styles.chip, value === o.value && styles.chipActive]}
          >
            <Text
              style={[
                styles.chipText,
                value === o.value && styles.chipTextActive,
              ]}
            >
              {o.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  )
}

function deliveryColor(a: AlertFeedEntry): string {
  if (a.traderspostFailedCount > 0) return colors.negative
  if (a.traderspostPendingCount > 0) return '#fbbf24'
  if (a.traderspostDeliveredCount > 0) return colors.positive
  return colors.muted
}

export default function AlertsScreen() {
  const { user } = useAuth()
  const [time, setTime] = useState<AlertTimeFilter>('day')
  const [activity, setActivity] = useState<AlertActivityFilter>('all')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<AlertsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (activity !== 'all') params.set('activity', activity)
    if (time !== 'all') {
      params.set(
        'receivedAfter',
        new Date(Date.now() - TIME_MS[time]).toISOString(),
      )
    }
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String((page - 1) * PAGE_SIZE))
    try {
      setData(await getJson<AlertsResponse>(`/api/alerts?${params}`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load alerts')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [time, activity, page])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load, user?.userId])

  const totalPages = Math.max(1, Math.ceil((data?.totalCount ?? 0) / PAGE_SIZE))
  const summary = data?.summary

  return (
    <View style={styles.container}>
      <View style={styles.filters}>
        <ChipRow
          options={TIME_OPTIONS}
          value={time}
          onChange={(v) => {
            setTime(v)
            setPage(1)
          }}
        />
        <ChipRow
          options={ACTIVITY_OPTIONS}
          value={activity}
          onChange={(v) => {
            setActivity(v)
            setPage(1)
          }}
        />
      </View>
      {summary ? (
        <View style={styles.summaryRow}>
          <Stat label="Total" value={String(summary.totalAlerts)} />
          <Stat label="Routed" value={String(summary.routedAlerts)} />
          <Stat
            label="Delivered"
            value={String(summary.traderspostDeliveredCount)}
            color={colors.positive}
          />
          <Stat
            label="Failed"
            value={String(summary.traderspostFailedCount)}
            color={
              summary.traderspostFailedCount > 0
                ? colors.negative
                : colors.text
            }
          />
        </View>
      ) : null}
      {loading && !data ? (
        <Spinner />
      ) : error && !data ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <>
          <FlatList
            contentContainerStyle={styles.list}
            data={data?.alerts ?? []}
            keyExtractor={(a) => a.alertId}
            ListEmptyComponent={
              <Text style={styles.empty}>No alerts in this window.</Text>
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
              <View style={styles.alertRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.alertTitle}>
                    {item.action.toUpperCase()} {item.ticker}
                    {item.rangeName ? ` · ${item.rangeName}` : ''}
                  </Text>
                  <Text style={styles.alertSub}>
                    {formatTime(item.receivedAt)} · {item.matchedAccountCount}{' '}
                    acct{item.matchedAccountCount === 1 ? '' : 's'}
                    {item.matchedAccountNames.length
                      ? ` (${item.matchedAccountNames.join(', ')})`
                      : ''}
                  </Text>
                </View>
                <Text style={[styles.delivery, { color: deliveryColor(item) }]}>
                  {item.traderspostFailedCount > 0
                    ? `${item.traderspostFailedCount} failed`
                    : item.traderspostPendingCount > 0
                      ? 'pending'
                      : item.traderspostDeliveredCount > 0
                        ? 'delivered'
                        : 'unrouted'}
                </Text>
              </View>
            )}
          />
          <View style={styles.pager}>
            <Pressable
              disabled={page <= 1}
              onPress={() => setPage((p) => p - 1)}
            >
              <Text style={[styles.pagerText, page <= 1 && styles.disabled]}>
                ‹ Prev
              </Text>
            </Pressable>
            <Text style={styles.pagerText}>
              {page} / {totalPages}
            </Text>
            <Pressable
              disabled={page >= totalPages}
              onPress={() => setPage((p) => p + 1)}
            >
              <Text
                style={[
                  styles.pagerText,
                  page >= totalPages && styles.disabled,
                ]}
              >
                Next ›
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  alertRow: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 12,
  },
  alertSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  alertTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
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
  chipRow: { flexDirection: 'row', paddingVertical: 4 },
  chipText: { color: colors.muted, fontSize: 12 },
  chipTextActive: { color: '#082f49', fontWeight: '700' },
  container: { backgroundColor: colors.bg, flex: 1 },
  delivery: { fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.3 },
  empty: { color: colors.muted, paddingVertical: 20, textAlign: 'center' },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  filters: { paddingHorizontal: 12, paddingTop: 8 },
  list: { padding: 12 },
  pager: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 12,
  },
  pagerText: { color: colors.accent, fontSize: 14 },
  summaryRow: {
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
})
