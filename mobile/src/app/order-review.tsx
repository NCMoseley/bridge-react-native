import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson, postJson } from '../api/client'
import { Spinner, colors } from '../components/ui'
import type { DraftStatus, OrderDraft } from '../types'
import { formatPrice, formatQuantity, formatTime } from '../utils/format'

type DraftAction = 'submitted' | 'rejected' | 'reviewed' | 'resend'

const STATUS_COLORS: Record<DraftStatus, string> = {
  pending: '#fbbf24',
  reviewed: colors.accent,
  submitted: colors.positive,
  rejected: colors.negative,
  expired: colors.muted,
}

function DraftCard({
  draft,
  onAction,
  busy,
}: {
  draft: OrderDraft
  onAction: (d: OrderDraft, a: DraftAction) => void
  busy: boolean
}) {
  const pending = draft.status === 'pending'
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.title}>
          {draft.action.toUpperCase()} {draft.ticker} ×
          {formatQuantity(draft.quantity)}
        </Text>
        <Text style={[styles.status, { color: STATUS_COLORS[draft.status] }]}>
          {draft.status}
        </Text>
      </View>
      <Text style={styles.sub}>
        {draft.orderType}
        {draft.limitPrice != null ? ` @ ${formatPrice(draft.limitPrice)}` : ''}
        {draft.stopPrice != null ? ` stop ${formatPrice(draft.stopPrice)}` : ''}
        {draft.rangeName ? ` · ${draft.rangeName}` : ''}
        {draft.accountName ? ` · ${draft.accountName}` : ''}
      </Text>
      <Text style={styles.sub}>received {formatTime(draft.receivedAt)}</Text>
      {pending ? (
        <View style={styles.actions}>
          <Pressable
            disabled={busy}
            onPress={() => onAction(draft, 'submitted')}
            style={[styles.actionButton, { backgroundColor: colors.positive }]}
          >
            <Text style={styles.actionText}>Mark submitted</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={() => onAction(draft, 'rejected')}
            style={[styles.actionButton, { backgroundColor: colors.negative }]}
          >
            <Text style={styles.actionText}>Reject</Text>
          </Pressable>
          <Pressable
            disabled={busy}
            onPress={() => onAction(draft, 'resend')}
            style={[styles.actionButton, { backgroundColor: colors.accent }]}
          >
            <Text style={styles.actionText}>Resend</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

export default function OrderReviewScreen() {
  const [pending, setPending] = useState<OrderDraft[]>([])
  const [history, setHistory] = useState<OrderDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [p, h] = await Promise.all([
        getJson<{ drafts: OrderDraft[] }>('/api/drafts'),
        getJson<{ drafts: OrderDraft[] }>(
          '/api/drafts/history?limit=25&sinceHours=72&accountId=all',
        ),
      ])
      setPending(
        p.drafts.sort(
          (a, b) =>
            new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
        ),
      )
      setHistory(h.drafts)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load drafts')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = setInterval(load, 15_000)
    return () => clearInterval(interval)
  }, [load])

  const onAction = async (draft: OrderDraft, action: DraftAction) => {
    setBusy(true)
    try {
      await postJson(`/api/drafts/${draft.id}/${action}`, {})
      await load()
    } catch (e) {
      Alert.alert('Action failed', e instanceof Error ? e.message : 'Error')
    } finally {
      setBusy(false)
    }
  }

  const submitAll = () => {
    Alert.alert(
      'Submit all',
      `Mark all ${pending.length} pending drafts as submitted?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Submit all',
          onPress: async () => {
            setBusy(true)
            try {
              await postJson('/api/drafts/submit-all', {})
              await load()
            } catch (e) {
              Alert.alert(
                'Submit all failed',
                e instanceof Error ? e.message : 'Error',
              )
            } finally {
              setBusy(false)
            }
          },
        },
      ],
    )
  }

  if (loading && !pending.length && !history.length) return <Spinner />
  if (error && !pending.length) return <Text style={styles.error}>{error}</Text>

  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={history}
      keyExtractor={(d) => d.id}
      ListHeaderComponent={
        <>
          <View style={styles.rowBetween}>
            <Text style={styles.section}>
              Pending ({pending.length})
            </Text>
            {pending.length > 0 ? (
              <Pressable disabled={busy} onPress={submitAll}>
                <Text style={styles.submitAll}>Submit all</Text>
              </Pressable>
            ) : null}
          </View>
          {pending.length === 0 ? (
            <Text style={styles.empty}>No pending drafts.</Text>
          ) : (
            pending.map((d) => (
              <DraftCard
                key={d.id}
                draft={d}
                onAction={onAction}
                busy={busy}
              />
            ))
          )}
          <Text style={styles.section}>Recent history</Text>
        </>
      }
      ListEmptyComponent={
        <Text style={styles.empty}>No recent draft history.</Text>
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
        <DraftCard draft={item} onAction={onAction} busy={busy} />
      )}
      style={styles.container}
    />
  )
}

const styles = StyleSheet.create({
  actionButton: {
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  actionText: { color: '#082f49', fontSize: 13, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    padding: 12,
  },
  container: { backgroundColor: colors.bg, flex: 1 },
  empty: { color: colors.muted, marginBottom: 12, fontSize: 13 },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  list: { padding: 12 },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  section: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  status: { fontSize: 12, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  submitAll: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
})
