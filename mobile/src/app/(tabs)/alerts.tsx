import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert as RnAlert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { getJson, postForm } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import {
  Button,
  Field,
  Input,
  SelectPicker,
  Spinner,
  Stat,
  colors,
  themedStyles,
} from '../../components/ui'
import type {
  AlertActivityFilter,
  AlertFeedEntry,
  AlertFeedSummary,
  AlertTimeFilter,
} from '../../types'
import { getCachedAlerts, getPreloadedPage, setCachedAlerts } from '../../utils/alerts-cache'

const PAGE_SIZE = 50

const TIME_MS: Record<AlertTimeFilter, number> = {
  all: Number.POSITIVE_INFINITY,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  hour: 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
}

const TIME_OPTIONS: { value: AlertTimeFilter; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: '15m', label: 'Past 15 minutes' },
  { value: '30m', label: 'Past 30 minutes' },
  { value: 'hour', label: 'Past hour' },
  { value: '2h', label: 'Past 2 hours' },
  { value: '4h', label: 'Past 4 hours' },
  { value: '12h', label: 'Past 12 hours' },
  { value: 'day', label: 'Past 24 hours' },
  { value: '3d', label: 'Past 3 days' },
  { value: 'week', label: 'Past 7 days' },
]

const ACTIVITY_OPTIONS: { value: AlertActivityFilter; label: string }[] = [
  { value: 'all', label: 'All activity' },
  { value: 'routed', label: 'Routed only' },
  { value: 'unrouted', label: 'Unrouted only' },
  { value: 'lifecycle', label: 'Lifecycle only' },
  { value: 'traderspost_delivered', label: 'Broker delivered' },
  { value: 'traderspost_failed', label: 'Broker failed' },
]

interface AlertsResponse {
  alerts: AlertFeedEntry[]
  totalCount: number
  rangeNames: string[]
  summary: AlertFeedSummary
}

function describeActivity(alert: AlertFeedEntry): string {
  if (alert.tradeEventCount > 0) {
    return alert.deliveryCount > 0 ? 'Lifecycle recorded' : 'Lifecycle stored'
  }
  if (alert.deliveryCount === 0) return 'Not routed'
  const notes: string[] = []
  if (alert.traderspostDeliveredCount > 0) notes.push(`${alert.traderspostDeliveredCount} broker delivered`)
  if (alert.traderspostPendingCount > 0) notes.push(`${alert.traderspostPendingCount} broker pending`)
  if (alert.traderspostFailedCount > 0) notes.push(`${alert.traderspostFailedCount} broker failed`)
  if (alert.traderspostNotConfiguredCount > 0) notes.push(`${alert.traderspostNotConfiguredCount} destination missing`)
  return notes.length
    ? `${alert.deliveryCount} route${alert.deliveryCount === 1 ? '' : 's'} matched · ${notes.join(' · ')}`
    : `${alert.deliveryCount} route${alert.deliveryCount === 1 ? '' : 's'} matched`
}

function statusIcon(alert: AlertFeedEntry): string {
  if (alert.tradeEventCount > 0) return '↻'
  if (alert.deliveryCount === 0) return '⏚'
  if (alert.traderspostFailedCount > 0) return '✕'
  if (alert.traderspostPendingCount > 0) return '⏳'
  if (alert.traderspostDeliveredCount > 0) return '䷧'
  if (alert.traderspostNotConfiguredCount > 0) return '⚠'
  return '↖︎'
}

function statusColor(alert: AlertFeedEntry): string {
  if (alert.tradeEventCount > 0) return colors.accent
  if (alert.deliveryCount === 0) return colors.faint
  if (alert.traderspostFailedCount > 0) return colors.negative
  if (alert.traderspostPendingCount > 0) return colors.amber
  if (alert.traderspostDeliveredCount > 0) return colors.positive
  if (alert.traderspostNotConfiguredCount > 0) return colors.amber
  return colors.positive
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Etc/GMT+4',
  })
}

function formatPayload(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

const EMPTY_SUMMARY: AlertFeedSummary = {
  totalAlerts: 0,
  routedAlerts: 0,
  unroutedAlerts: 0,
  traderspostDeliveredCount: 0,
  traderspostPendingCount: 0,
  traderspostFailedCount: 0,
}

export default function AlertsScreen() {
  const { user } = useAuth()
  const [name, setName] = useState('')
  const [time, setTime] = useState<AlertTimeFilter>('all')
  const [activity, setActivity] = useState<AlertActivityFilter>('all')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedAlert, setSelectedAlert] = useState<AlertFeedEntry | null>(null)
  const { success, error: showError } = useToast()

  const [serverAlertFeed, setServerAlertFeed] = useState<{ alerts: AlertFeedEntry[]; totalCount: number } | undefined>()
  const [serverAlertRangeNames, setServerAlertRangeNames] = useState<string[] | undefined>()
  const [serverAlertSummary, setServerAlertSummary] = useState<AlertFeedSummary | undefined>()

  const alertFeed = serverAlertFeed ?? { alerts: [], totalCount: 0 }
  const alertRangeNames = serverAlertRangeNames ?? []
  const alertSummary = serverAlertSummary ?? EMPTY_SUMMARY

  useEffect(() => {
    setPage(1)
  }, [name, time, activity])

  useEffect(() => {
    const offset = (page - 1) * PAGE_SIZE
    const params = new URLSearchParams()
    if (activity !== 'all') params.set('activity', activity)
    if (name.trim()) params.set('name', name.trim())
    if (time !== 'all') {
      params.set('receivedAfter', new Date(Date.now() - TIME_MS[time]).toISOString())
    }
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    const query = params.toString()

    const cached = getCachedAlerts(query)
    if (cached) {
      setServerAlertFeed({ alerts: cached.alerts, totalCount: cached.totalCount })
      setServerAlertRangeNames(cached.rangeNames)
      setServerAlertSummary(cached.summary)
      setLoading(false)
    } else {
      const preloaded =
        !name.trim() && time === 'all' && activity === 'all' && page <= 2
          ? getPreloadedPage(page, PAGE_SIZE)
          : undefined
      if (preloaded) {
        setServerAlertFeed({ alerts: preloaded.alerts, totalCount: preloaded.totalCount })
        setServerAlertRangeNames(preloaded.rangeNames)
        setServerAlertSummary(preloaded.summary)
        setLoading(false)
      } else {
        setLoading(true)
      }
    }

    getJson<AlertsResponse>(`/api/alerts${query ? `?${query}` : ''}`)
      .then((data) => {
        setServerAlertFeed({ alerts: data.alerts, totalCount: data.totalCount })
        setServerAlertRangeNames(data.rangeNames)
        setServerAlertSummary(data.summary)
        setCachedAlerts(query, {
          alerts: data.alerts,
          totalCount: data.totalCount,
          rangeNames: data.rangeNames,
          summary: data.summary,
        })
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [name, time, activity, page, refreshKey, user?.userId])

  const handleDeleteAlert = useCallback(
    (alert: AlertFeedEntry) => {
      RnAlert.alert(
        'Delete alert',
        `Delete alert for ${alert.rangeName ?? '—'} from ${formatDateTime(alert.receivedAt)}? This will also remove its deliveries.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              postForm('/alerts/delete', { alertId: alert.alertId })
                .then(() => {
                  setSelectedAlert(null)
                  setRefreshKey((k) => k + 1)
                  success('Alert deleted')
                })
                .catch(() => showError('Failed to delete alert'))
            },
          },
        ],
      )
    },
    [success, showError],
  )

  const totalPages = Math.max(1, Math.ceil(alertFeed.totalCount / PAGE_SIZE))

  return (
    <View style={styles.container}>
      <FlatList
        data={alertFeed.alerts}
        keyExtractor={(a) => a.alertId}
        contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
        ListHeaderComponent={
          <View>
            <View style={styles.summaryRow}>
              <Stat label="Received" value={String(alertSummary.totalAlerts)} />
              <Stat label="Drafts sent" value={String(alertSummary.routedAlerts)} />
              <Stat
                label="Broker delivered"
                value={String(alertSummary.traderspostDeliveredCount)}
                color={colors.positive}
              />
              <Stat
                label="Failed"
                value={String(alertSummary.traderspostFailedCount)}
                color={alertSummary.traderspostFailedCount > 0 ? colors.negative : colors.text}
              />
            </View>
            <View style={styles.filterCard}>
              <Field label="Name">
                <Input value={name} onChangeText={setName} placeholder="Breakfast" />
              </Field>
              {alertRangeNames.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
                    {alertRangeNames.slice(0, 12).map((range) => (
                      <Pressable key={range} onPress={() => setName(range)} style={styles.nameChip}>
                        <Text style={styles.nameChipText}>{range}</Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <SelectPicker label="Time" options={TIME_OPTIONS} value={time} onChange={setTime} />
                </View>
                <View style={{ flex: 1 }}>
                  <SelectPicker label="Activity" options={ACTIVITY_OPTIONS} value={activity} onChange={setActivity} />
                </View>
              </View>
            </View>
            <View style={styles.pagerRow}>
              <Text style={styles.dim}>
                Page {page} of {totalPages} · {alertFeed.alerts.length} of {alertFeed.totalCount} alerts
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button small variant="ghost" title="Prev" disabled={page <= 1} onPress={() => setPage((p) => p - 1)} />
                <Button
                  small
                  variant="ghost"
                  title="Next"
                  disabled={page * PAGE_SIZE >= alertFeed.totalCount}
                  onPress={() => setPage((p) => p + 1)}
                />
              </View>
            </View>
            {loading && alertFeed.alerts.length === 0 ? <Spinner /> : null}
          </View>
        }
        ListEmptyComponent={
          !loading ? <Text style={styles.dimCenter}>No alerts match the selected filters.</Text> : null
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true)
              setRefreshKey((k) => k + 1)
            }}
            tintColor={colors.accent}
          />
        }
        renderItem={({ item: alert }) => (
          <View style={styles.alertRow}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Text style={styles.alertTitle}>{alert.rangeName ?? '—'}</Text>
                <Text style={styles.alertAction}>{alert.action}</Text>
                <Text style={styles.dim}>{alert.ticker}</Text>
              </View>
              <Text style={styles.dimSmall}>{formatDateTime(alert.receivedAt)}</Text>
              {alert.currentUserLinked ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                  <Text style={{ color: statusColor(alert), fontSize: 13, fontWeight: '700' }}>
                    {statusIcon(alert)}
                  </Text>
                  <Text style={[styles.dimSmall, { flex: 1 }]} numberOfLines={2}>
                    {describeActivity(alert)}
                  </Text>
                </View>
              ) : (
                <Text style={styles.dimSmall}>—</Text>
              )}
            </View>
            <View style={{ gap: 4 }}>
              <Button small variant="ghost" title="JSON" onPress={() => setSelectedAlert(alert)} />
              <Button small variant="ghost" title="✕" onPress={() => handleDeleteAlert(alert)} />
            </View>
          </View>
        )}
      />

      <Modal visible={selectedAlert !== null} transparent animationType="fade" onRequestClose={() => setSelectedAlert(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Alert from {selectedAlert ? formatDateTime(selectedAlert.receivedAt) : ''}
            </Text>
            <ScrollView style={{ maxHeight: 400 }}>
              <Text style={styles.json}>{selectedAlert ? formatPayload(selectedAlert.payloadJson) : ''}</Text>
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <Button
                small
                variant="danger"
                title="Delete"
                onPress={() => selectedAlert && handleDeleteAlert(selectedAlert)}
              />
              <Button small variant="ghost" title="Close" onPress={() => setSelectedAlert(null)} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  alertAction: { color: c.accent, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  alertRow: {
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 12,
  },
  alertTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  container: { backgroundColor: c.bg, flex: 1 },
  dim: { color: c.muted, fontSize: 12 },
  dimCenter: { color: c.muted, fontSize: 13, paddingVertical: 30, textAlign: 'center' },
  dimSmall: { color: c.muted, fontSize: 11 },
  filterCard: {
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 10,
    padding: 12,
  },
  json: { color: c.text, fontFamily: 'Menlo', fontSize: 10 },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    flex: 1,
    justifyContent: 'center',
    padding: 16,
  },
  modalCard: {
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: '85%',
    padding: 16,
    width: '100%',
  },
  modalTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 10 },
  nameChip: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  nameChipText: { color: c.muted, fontSize: 11 },
  pagerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  summaryRow: { flexDirection: 'row', gap: 16, marginBottom: 10 },
}))
