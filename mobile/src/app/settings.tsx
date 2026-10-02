import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson, postForm } from '../api/client'
import { Card, Spinner, colors } from '../components/ui'
import type { RangeRoute, SettingsData } from '../types'

interface RouteEdit {
  rangeName: string
  accountId: string
  extensionEnabled: boolean
  traderspostEnabled: boolean
  runScheduled: boolean
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      style={[styles.toggle, value && styles.toggleOn]}
    >
      <Text style={[styles.toggleText, value && styles.toggleTextOn]}>
        {label}
      </Text>
    </Pressable>
  )
}

export default function SettingsScreen() {
  const [data, setData] = useState<SettingsData | null>(null)
  const [routes, setRoutes] = useState<RouteEdit[]>([])
  const [dirtyRanges, setDirtyRanges] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await getJson<SettingsData>('/api/settings')
      setData(d)
      setRoutes(
        d.rangeRoutes.map((r: RangeRoute) => ({
          rangeName: r.rangeName,
          accountId: r.accountId,
          extensionEnabled: r.extensionEnabled,
          traderspostEnabled: r.traderspostEnabled,
          runScheduled: r.runScheduled,
        })),
      )
      setDirtyRanges(new Set())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const accounts = useMemo(
    () => (data?.accounts ?? []).filter((a) => !a.deprecated),
    [data],
  )

  const updateRoute = (
    rangeName: string,
    accountId: string,
    patch: Partial<RouteEdit>,
  ) => {
    setRoutes((current) => {
      const next = [...current]
      const idx = next.findIndex(
        (r) => r.rangeName === rangeName && r.accountId === accountId,
      )
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...patch }
      } else {
        next.push({
          rangeName,
          accountId,
          extensionEnabled: false,
          traderspostEnabled: false,
          runScheduled: false,
          ...patch,
        })
      }
      return next
    })
    setDirtyRanges((prev) => new Set(prev).add(rangeName))
  }

  const save = async () => {
    if (dirtyRanges.size === 0) return
    setSaving(true)
    try {
      for (const rangeName of dirtyRanges) {
        const rangeRoutes = routes.filter((r) => r.rangeName === rangeName)
        const selected = rangeRoutes.filter(
          (r) => r.extensionEnabled || r.traderspostEnabled,
        )
        await postForm('/range-routes', {
          rangeName,
          extensionAccountIds: rangeRoutes
            .filter((r) => r.extensionEnabled)
            .map((r) => r.accountId),
          traderspostAccountIds: rangeRoutes
            .filter((r) => r.traderspostEnabled)
            .map((r) => r.accountId),
          runScheduledAccountIds: selected
            .filter((r) => r.runScheduled)
            .map((r) => r.accountId),
        })
      }
      await load()
      Alert.alert('Saved', 'Subscription settings saved.')
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Error')
    } finally {
      setSaving(false)
    }
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
      <Card title="Extension">
        <Text style={styles.sub}>Version {data?.extensionVersion ?? '—'}</Text>
        <Text selectable style={styles.token}>
          {data?.extensionToken ?? '—'}
        </Text>
      </Card>

      <View style={styles.rowBetween}>
        <Text style={styles.section}>Range subscriptions</Text>
        {dirtyRanges.size > 0 ? (
          <Pressable disabled={saving} onPress={save}>
            <Text style={styles.saveText}>
              {saving ? 'Saving…' : `Save (${dirtyRanges.size})`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {(data?.rangeNames ?? []).map((rangeName) => (
        <Card key={rangeName}>
          <Pressable
            onPress={() =>
              setExpanded((cur) => (cur === rangeName ? null : rangeName))
            }
          >
            <View style={styles.rowBetween}>
              <Text style={styles.rangeName}>{rangeName}</Text>
              {dirtyRanges.has(rangeName) ? (
                <Text style={styles.dirtyDot}>●</Text>
              ) : null}
            </View>
          </Pressable>
          {expanded === rangeName
            ? accounts.map((account) => {
                const route =
                  routes.find(
                    (r) =>
                      r.rangeName === rangeName &&
                      r.accountId === account.id,
                  ) ??
                  ({
                    extensionEnabled: false,
                    traderspostEnabled: false,
                    runScheduled: false,
                  } as const)
                const set = (patch: Partial<RouteEdit>) =>
                  updateRoute(rangeName, account.id, patch)
                return (
                  <View key={account.id} style={styles.accountRow}>
                    <Text style={styles.accountName}>{account.name}</Text>
                    <View style={styles.toggleRow}>
                      <Toggle
                        label="Ext"
                        value={route.extensionEnabled}
                        onChange={(v) => set({ extensionEnabled: v })}
                      />
                      <Toggle
                        label="TP"
                        value={route.traderspostEnabled}
                        onChange={(v) => set({ traderspostEnabled: v })}
                      />
                      <Toggle
                        label="Sched"
                        value={route.runScheduled}
                        onChange={(v) => set({ runScheduled: v })}
                      />
                    </View>
                  </View>
                )
              })
            : null}
        </Card>
      ))}
      {(data?.rangeNames.length ?? 0) === 0 ? (
        <Text style={styles.sub}>No tracked ranges.</Text>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  accountName: {
    color: colors.text,
    flex: 1,
    fontSize: 13,
  },
  accountRow: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingVertical: 6,
  },
  container: { backgroundColor: colors.bg, flex: 1 },
  dirtyDot: { color: '#fbbf24', fontSize: 12 },
  error: { color: colors.negative, margin: 20, textAlign: 'center' },
  list: { padding: 12 },
  rangeName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowBetween: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  saveText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
  section: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  sub: { color: colors.muted, fontSize: 12 },
  token: { color: colors.text, fontFamily: 'Menlo', fontSize: 11, marginTop: 6 },
  toggle: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  toggleOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  toggleRow: { flexDirection: 'row', gap: 6 },
  toggleText: { color: colors.muted, fontSize: 12 },
  toggleTextOn: { color: '#082f49', fontWeight: '700' },
})
