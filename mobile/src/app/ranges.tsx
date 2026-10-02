import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { getJson, postForm } from '../api/client'
import { Card, Spinner, colors, pnlColor } from '../components/ui'
import type {
  RangeConfiguration,
  RangesData,
  SharedRangeDetail,
} from '../types'
import { formatPercent, formatPnl } from '../utils/format'

const DAY_KEYS = [
  ['runSunday', 'S'],
  ['runMonday', 'M'],
  ['runTuesday', 'T'],
  ['runWednesday', 'W'],
  ['runThursday', 'T'],
  ['runFriday', 'F'],
  ['runSaturday', 'S'],
] as const

function runDays(config?: RangeConfiguration): string {
  if (!config) return '—'
  return DAY_KEYS.map(([k, l]) => (config[k] ? l : '·')).join('')
}

function RangeCard({
  range,
  config,
  onDelete,
}: {
  range: SharedRangeDetail
  config?: RangeConfiguration
  onDelete: (name: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Card>
      <Pressable onPress={() => setExpanded((v) => !v)}>
        <View style={styles.rowBetween}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rangeName}>
              {range.rangeName}
              {range.reviewFlag ? ' ⚑' : ''}
            </Text>
            <Text style={styles.sub}>
              {config?.instrument ?? ''} · {runDays(config)} ·{' '}
              {range.subscriptions.length} sub
              {range.subscriptions.length === 1 ? '' : 's'}
              {config?.stopOnlyEntries ? ' · stop-only' : ''}
            </Text>
          </View>
          <Text
            style={[
              styles.pnl,
              { color: pnlColor(range.currentMonth.realizedDollarsCents) },
            ]}
          >
            {formatPnl(range.currentMonth.realizedDollarsCents)}
          </Text>
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.body}>
          <Text style={styles.sub}>
            Today {formatPnl(range.currentDay.realizedDollarsCents)} · Week{' '}
            {formatPnl(range.currentWeek.realizedDollarsCents)} · All{' '}
            {formatPnl(range.allTime.realizedDollarsCents)} · WR{' '}
            {formatPercent(range.allTime.winRate)}
          </Text>
          {config ? (
            <Text style={styles.sub}>
              TP {config.takeProfitTicksCents / 100}t ({config.takeProfitStyle})
              · SL {config.stopLossTicksCents / 100}t ({config.stopLossStyle})
              · {config.entriesPerRange} entries
              {config.breakEvenEnabled
                ? ` · BE@${config.breakEvenTriggerTicksCents / 100}t`
                : ''}
            </Text>
          ) : null}
          {range.subscriptions.map((s) => (
            <Text key={`${s.user.id}-${s.account.id}`} style={styles.sub}>
              {s.account.name} ({s.user.email}) — ext
              {s.extensionEnabled ? '✓' : '✗'} tp
              {s.traderspostEnabled ? '✓' : '✗'}
              {s.modelNames?.length ? ` · ${s.modelNames.join(', ')}` : ''}
            </Text>
          ))}
          <Pressable
            onPress={() =>
              Alert.alert('Delete range', `Delete "${range.rangeName}"?`, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => onDelete(range.rangeName),
                },
              ])
            }
            style={styles.deleteButton}
          >
            <Text style={styles.deleteText}>Delete range</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  )
}

export default function RangesScreen() {
  const [data, setData] = useState<RangesData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newRange, setNewRange] = useState('')
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await getJson<RangesData>('/api/ranges'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load ranges')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const configMap = useMemo(
    () =>
      new Map(
        (data?.rangeConfigurations ?? []).map((c) => [c.rangeName, c]),
      ),
    [data],
  )

  const groups = useMemo(() => {
    const details = data?.sharedRangeDetails ?? []
    const assignMap = new Map(
      (data?.rangeSubcategoryAssignments ?? []).map((a) => [
        a.rangeName,
        a.subcategoryName,
      ]),
    )
    const map = new Map<string, SharedRangeDetail[]>()
    for (const r of details) {
      const key = assignMap.get(r.rangeName) ?? 'Ungrouped'
      const list = map.get(key) ?? []
      list.push(r)
      map.set(key, list)
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [data])

  const addRange = async () => {
    const name = newRange.trim()
    if (!name || adding) return
    setAdding(true)
    try {
      await postForm('/tracked-ranges', { rangeName: name })
      setNewRange('')
      await load()
    } catch (e) {
      Alert.alert('Add range failed', e instanceof Error ? e.message : 'Error')
    } finally {
      setAdding(false)
    }
  }

  const deleteRange = (name: string) => {
    postForm('/ranges/delete', { rangeName: name })
      .then(load)
      .catch((e) =>
        Alert.alert(
          'Delete failed',
          e instanceof Error ? e.message : 'Error',
        ),
      )
  }

  if (loading && !data) return <Spinner />
  if (error && !data) return <Text style={styles.error}>{error}</Text>

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
      <View style={styles.addRow}>
        <TextInput
          onChangeText={setNewRange}
          onSubmitEditing={addRange}
          placeholder="New range name"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={newRange}
        />
        <Pressable
          disabled={adding || !newRange.trim()}
          onPress={addRange}
          style={[styles.addButton, (!newRange.trim() || adding) && { opacity: 0.5 }]}
        >
          <Text style={styles.addText}>Add</Text>
        </Pressable>
      </View>
      {groups.map(([group, ranges]) => (
        <View key={group}>
          <Text style={styles.groupLabel}>{group}</Text>
          {ranges.map((r) => (
            <RangeCard
              key={r.rangeName}
              range={r}
              config={configMap.get(r.rangeName)}
              onDelete={deleteRange}
            />
          ))}
        </View>
      ))}
      {(data?.sharedRangeDetails.length ?? 0) === 0 ? (
        <Text style={styles.sub}>No tracked ranges.</Text>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  addButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  addText: { color: '#082f49', fontWeight: '700' },
  body: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    marginTop: 8,
    paddingTop: 8,
  },
  container: { backgroundColor: colors.bg, flex: 1 },
  deleteButton: { marginTop: 10 },
  deleteText: { color: colors.negative, fontSize: 13 },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  groupLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 6,
    marginTop: 6,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  list: { padding: 12 },
  pnl: { fontSize: 15, fontWeight: '700', marginLeft: 8 },
  rangeName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowBetween: { alignItems: 'center', flexDirection: 'row' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
})
