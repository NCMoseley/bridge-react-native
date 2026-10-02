import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Link } from 'expo-router'
import { getJson } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { Card, Spinner, Stat, colors, pnlColor } from '../../components/ui'
import type {
  AccountAlertSummary,
  AccountJournal,
  TradersPostAccountDestination,
} from '../../types'
import { formatDollars, formatPercent, formatPnl } from '../../utils/format'

interface AccountsResponse {
  accounts: AccountJournal[]
  alertSummaries: Record<string, AccountAlertSummary>
  destinations: Record<string, TradersPostAccountDestination | undefined>
  enabledRouteCounts: Record<string, number>
}

function AccountCard({
  item,
  alerts,
  destination,
  routeCount,
}: {
  item: AccountJournal
  alerts?: AccountAlertSummary
  destination?: TradersPostAccountDestination
  routeCount?: number
}) {
  const balance = item.internalBalanceCents
  return (
    <Link
      href={`/account-pnl?accountId=${encodeURIComponent(item.account.id)}`}
      asChild
    >
      <Pressable>
    <Card>
      <View style={styles.cardHeader}>
        <Text style={styles.accountName}>
          {item.account.name}
          {item.account.deprecated ? ' (deprecated)' : ''}
        </Text>
        <Text style={styles.balance}>{formatDollars(balance)}</Text>
      </View>
      <View style={styles.metricsRow}>
        <Stat
          label="Today"
          value={formatPnl(item.currentDay.realizedDollarsCents)}
          color={pnlColor(item.currentDay.realizedDollarsCents)}
        />
        <Stat
          label="This week"
          value={formatPnl(item.currentWeek.realizedDollarsCents)}
          color={pnlColor(item.currentWeek.realizedDollarsCents)}
        />
        <Stat
          label="All time"
          value={formatPnl(item.allTime.realizedDollarsCents)}
          color={pnlColor(item.allTime.realizedDollarsCents)}
        />
        <Stat
          label="Win rate"
          value={formatPercent(item.allTime.winRate)}
        />
        <Stat label="Closed" value={String(item.allTime.closedCount)} />
      </View>
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          {routeCount ?? 0} routes ·{' '}
          {destination
            ? destination.enabled
              ? 'TradersPost on'
              : 'TradersPost off'
            : 'no destination'}
          {destination?.crossTradeEnabled ? ' · CrossTrade on' : ''}
        </Text>
        {alerts ? (
          <Text style={styles.footerText}>
            alerts: {alerts.processed}/{alerts.totalReceived} processed
            {alerts.traderspostFailed
              ? ` · ${alerts.traderspostFailed} failed`
              : ''}
          </Text>
        ) : null}
      </View>
    </Card>
      </Pressable>
    </Link>
  )
}

export default function AccountsScreen() {
  const { user } = useAuth()
  const [data, setData] = useState<AccountsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await getJson<AccountsResponse>('/api/accounts'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load accounts')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, user?.userId])

  if (loading && !data) return <Spinner />
  if (error && !data) return <Text style={styles.error}>{error}</Text>

  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={data?.accounts ?? []}
      keyExtractor={(a) => a.account.id}
      ListEmptyComponent={<Text style={styles.empty}>No accounts.</Text>}
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
        <AccountCard
          item={item}
          alerts={data?.alertSummaries[item.account.id]}
          destination={data?.destinations[item.account.id]}
          routeCount={data?.enabledRouteCounts[item.account.id]}
        />
      )}
      style={styles.container}
    />
  )
}

const styles = StyleSheet.create({
  accountName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  balance: { color: colors.text, fontSize: 16, fontWeight: '700' },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  container: { backgroundColor: colors.bg, flex: 1 },
  empty: { color: colors.muted, paddingVertical: 20, textAlign: 'center' },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  footer: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    marginTop: 8,
    paddingTop: 8,
  },
  footerText: { color: colors.muted, fontSize: 12, marginTop: 2 },
  list: { padding: 12 },
  metricsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
})
