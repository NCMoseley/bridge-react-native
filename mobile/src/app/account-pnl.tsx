import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { getJson } from '../api/client'
import { Card, Spinner, Stat, colors, pnlColor } from '../components/ui'
import type { AccountPnlReview } from '../types'
import {
  formatDollars,
  formatJournalDateKey,
  formatPercent,
  formatPnl,
  formatPrice,
  formatQuantity,
  formatTicks,
  formatTime,
} from '../utils/format'

export default function AccountPnlScreen() {
  const { accountId } = useLocalSearchParams<{ accountId: string }>()
  const [review, setReview] = useState<AccountPnlReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!accountId) return
    try {
      setReview(
        await getJson<AccountPnlReview>(
          `/api/accounts/${accountId}/pnl-review`,
        ),
      )
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load P&L review')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [accountId])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !review) return <Spinner />

  const summary = review?.summary

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: review?.account.name ?? 'P&L review' }} />
      {error && !review ? (
        <Text style={styles.error}>{error}</Text>
      ) : (
        <FlatList
          contentContainerStyle={styles.list}
          data={review?.trades ?? []}
          keyExtractor={(t) => t.id}
          ListHeaderComponent={
            <>
              {summary ? (
                <Card title={`Summary (${review?.since ?? ''} → ${review?.until ?? ''})`}>
                  <View style={styles.metricsRow}>
                    <Stat
                      label="Realized"
                      value={formatPnl(summary.realizedDollarsCents)}
                      color={pnlColor(summary.realizedDollarsCents)}
                    />
                    <Stat
                      label="Ticks"
                      value={formatTicks(summary.netTicksCents)}
                      color={pnlColor(summary.netTicksCents)}
                    />
                    <Stat label="Closed" value={String(summary.closedCount)} />
                    <Stat
                      label="Win rate"
                      value={formatPercent(summary.winRate)}
                    />
                  </View>
                </Card>
              ) : null}
              {review?.ranges.length ? (
                <Card title="By range">
                  {review.ranges.map((r) => (
                    <View key={r.rangeName} style={styles.rangeRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rangeName}>
                          {r.rangeName} ({r.instrument})
                        </Text>
                        <Text style={styles.sub}>
                          {r.closedCount} closed · {r.wins}W/{r.losses}L
                        </Text>
                      </View>
                      <Text
                        style={{
                          color: pnlColor(r.realizedDollarsCents),
                          fontWeight: '700',
                        }}
                      >
                        {formatPnl(r.realizedDollarsCents)}
                      </Text>
                    </View>
                  ))}
                </Card>
              ) : null}
              <Text style={styles.section}>Trades</Text>
            </>
          }
          ListEmptyComponent={<Text style={styles.empty}>No trades.</Text>}
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
            <View style={styles.tradeRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.tradeTitle}>
                  {item.instrument} · {item.side} ×
                  {formatQuantity(item.quantity)}
                </Text>
                <Text style={styles.sub}>
                  {item.rangeName} · {item.eventType.replace('_', ' ')} ·{' '}
                  {formatJournalDateKey(item.occurredAt.slice(0, 10))}{' '}
                  {formatTime(item.occurredAt)}
                  {item.entryPrice != null
                    ? ` · @ ${formatPrice(item.entryPrice)}`
                    : ''}
                  {item.exitPrice != null
                    ? ` → ${formatPrice(item.exitPrice)}`
                    : ''}
                </Text>
              </View>
              {item.realizedDollarsCents != null ? (
                <Text
                  style={[
                    styles.tradePnl,
                    { color: pnlColor(item.realizedDollarsCents) },
                  ]}
                >
                  {formatDollars(item.realizedDollarsCents)}
                </Text>
              ) : null}
            </View>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bg, flex: 1 },
  empty: { color: colors.muted, fontSize: 13 },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  list: { padding: 12 },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  rangeName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rangeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingVertical: 5,
  },
  section: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  tradePnl: { fontSize: 14, fontWeight: '700' },
  tradeRow: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 12,
  },
  tradeTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
})
