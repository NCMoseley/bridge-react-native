import { useCallback, useEffect, useState } from 'react'
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson } from '../../api/client'
import { Card, Spinner, colors } from '../../components/ui'
import type { BrokerOrder, MonitoringData, OpenTradeSanity } from '../../types'
import { formatPrice, formatQuantity, formatTime } from '../../utils/format'

const STATUS_COLORS: Record<string, string> = {
  filled: colors.positive,
  acknowledged: colors.positive,
  closed: colors.positive,
  rejected: colors.negative,
  cancelled: colors.muted,
  uncertain: '#fbbf24',
  pending: '#fbbf24',
}

function statusColor(s?: string): string {
  return (s && STATUS_COLORS[s]) || colors.muted
}

function OpenTradeRow({ t }: { t: OpenTradeSanity }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>
          {t.instrument} · {t.side} ×{formatQuantity(t.quantity)}
          {t.entryPrice != null ? ` @ ${formatPrice(t.entryPrice)}` : ''}
        </Text>
        <Text style={styles.rowSub}>
          {t.accountName} · {t.rangeName} · {t.state}
          {t.deliveryStatus ? ` · ${t.deliveryStatus}` : ''}
        </Text>
        {t.brokerOrderErrorText ? (
          <Text style={styles.errText}>{t.brokerOrderErrorText}</Text>
        ) : null}
      </View>
      <Text style={[styles.status, { color: statusColor(t.brokerOrderStatus) }]}>
        {t.brokerOrderStatus ?? '—'}
      </Text>
    </View>
  )
}

function BrokerOrderRow({ o }: { o: BrokerOrder }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>
          {o.action} {o.instrument}
          {o.quantity != null ? ` ×${formatQuantity(o.quantity)}` : ''}
          {o.side ? ` · ${o.side}` : ''}
          {o.destination === 'crosstrade' ? ' · CT' : ''}
        </Text>
        <Text style={styles.rowSub}>
          {o.accountName ?? o.accountId} · {o.rangeName} ·{' '}
          {formatTime(o.occurredAt)}
          {o.dispatchStatus && o.dispatchStatus !== o.status
            ? ` · dispatched ${o.dispatchStatus}`
            : ''}
        </Text>
        {o.errorText ? <Text style={styles.errText}>{o.errorText}</Text> : null}
      </View>
      <Text style={[styles.status, { color: statusColor(o.status) }]}>
        {o.status}
      </Text>
    </View>
  )
}

export default function MonitoringScreen() {
  const [data, setData] = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await getJson<MonitoringData>('/api/monitoring'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load monitoring')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !data) return <Spinner />
  if (error && !data) return <Text style={styles.error}>{error}</Text>

  const openTrades = data?.openTradeSanity ?? []
  const orders = (data?.brokerOrders ?? [])
    .slice()
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 50)

  return (
    <ScrollView
      contentContainerStyle={styles.list}
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
      style={styles.container}
    >
      <Card title={`Open trades (${openTrades.length})`}>
        {openTrades.length === 0 ? (
          <Text style={styles.empty}>No open trades.</Text>
        ) : (
          openTrades.map((t) => <OpenTradeRow key={t.bracketId} t={t} />)
        )}
      </Card>
      <Card title={`Broker orders (last ${orders.length})`}>
        {orders.length === 0 ? (
          <Text style={styles.empty}>No broker orders.</Text>
        ) : (
          orders.map((o) => <BrokerOrderRow key={o.id} o={o} />)
        )}
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bg, flex: 1 },
  empty: { color: colors.muted, fontSize: 12 },
  errText: { color: colors.negative, fontSize: 11, marginTop: 2 },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  list: { padding: 12 },
  row: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingVertical: 8,
  },
  rowSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  status: { fontSize: 12, fontWeight: '700', marginLeft: 8 },
})
