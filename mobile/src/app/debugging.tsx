import { useCallback, useEffect, useState } from 'react'
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson } from '../api/client'
import { Card, Spinner, colors } from '../components/ui'
import type { DebuggingData } from '../types'
import { formatPrice, formatQuantity, formatTime } from '../utils/format'

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <Card title={count != null ? `${title} (${count})` : title}>
      {children}
    </Card>
  )
}

function Empty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>
}

export default function DebuggingScreen() {
  const [data, setData] = useState<DebuggingData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await getJson<DebuggingData>('/api/debugging'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load debugging data')
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

  const flagged = data?.flaggedRanges ?? []
  const untracked = data?.untrackedRangeNames ?? []
  const reapply = data?.reapplyOperations ?? []
  const excluded = data?.excludedTrades ?? []
  const runs = data?.processRuns ?? []

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
      <Section title="Flagged ranges" count={flagged.length}>
        {flagged.length === 0 ? (
          <Empty text="None." />
        ) : (
          flagged.map((f) => (
            <Text key={f.rangeName} style={styles.rowText}>
              ⚑ {f.rangeName}
              {f.reason ? ` — ${f.reason}` : ''}
            </Text>
          ))
        )}
      </Section>

      <Section title="Untracked ranges" count={untracked.length}>
        {untracked.length === 0 ? (
          <Empty text="None." />
        ) : (
          untracked.map((u) => (
            <Text key={u.rangeName} style={styles.rowText}>
              {u.rangeName}
              {u.lastSeenAt ? ` · ${formatTime(u.lastSeenAt)}` : ''}
            </Text>
          ))
        )}
      </Section>

      <Section title="Reapply operations" count={reapply.length}>
        {reapply.length === 0 ? (
          <Empty text="None." />
        ) : (
          reapply.slice(0, 50).map((op) => (
            <Text key={op.id} style={styles.rowText}>
              {op.rangeName ?? '—'} · {op.status ?? '—'}
              {op.updatedAt ? ` · ${formatTime(op.updatedAt)}` : ''}
            </Text>
          ))
        )}
      </Section>

      <Section title="Excluded trades" count={excluded.length}>
        {excluded.length === 0 ? (
          <Empty text="None." />
        ) : (
          excluded.slice(0, 50).map((t) => (
            <View key={t.id} style={styles.tradeRow}>
              <Text style={styles.rowText}>
                {t.instrument} {t.side} ×{formatQuantity(t.quantity)} @{' '}
                {formatPrice(t.entryPrice)} · {t.rangeName}
              </Text>
              <Text style={styles.sub}>
                {t.exclusionReason ?? 'excluded'} · {formatTime(t.occurredAt)}
              </Text>
            </View>
          ))
        )}
      </Section>

      <Section title="Process runs" count={runs.length}>
        {runs.length === 0 ? (
          <Empty text="None recorded." />
        ) : (
          runs.slice(0, 20).map((r) => (
            <Text key={r.id} style={styles.rowText}>
              pid {r.pid ?? '?'} · started {formatTime(r.startedAt)} ·{' '}
              {r.endedAt
                ? `ended ${formatTime(r.endedAt)}${r.cleanExit ? ' (clean)' : ''}`
                : r.lastHeartbeatAt
                  ? `heartbeat ${formatTime(r.lastHeartbeatAt)}`
                  : 'no heartbeat'}
            </Text>
          ))
        )}
      </Section>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bg, flex: 1 },
  empty: { color: colors.muted, fontSize: 12 },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  list: { padding: 12 },
  rowText: { color: colors.text, fontSize: 13, paddingVertical: 3 },
  sub: { color: colors.muted, fontSize: 11 },
  tradeRow: { paddingVertical: 3 },
})
