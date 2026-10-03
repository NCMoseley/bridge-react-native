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
import { getJson, postForm, postJson } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { onEvent } from '../utils/events'
import {
  Badge,
  Button,
  Card,
  CollapsibleSection,
  Field,
  Input,
  SelectPicker,
  colors,
  pnlColor,
} from '../components/ui'
import { JournalDate } from '../components/charts'
import { getCachedDebugging, setCachedDebugging } from '../utils/debugging-cache'
import { formatJournalDate, formatPnl, JOURNAL_TIME_ZONE } from '../utils/format'
import type {
  BrokerOrder,
  DebuggingData,
  ProcessRun,
} from '../types'

function formatMb(bytes?: number): string {
  if (bytes == null) return '—'
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function processRunStatus(run: ProcessRun): { label: string; bad: boolean } {
  if (run.fatal) return { label: `crashed (${run.fatal.event})`, bad: true }
  if (run.endedAt) {
    return run.cleanExit ? { label: 'exited cleanly', bad: false } : { label: 'exited (unclean)', bad: true }
  }
  const lastBeat = run.lastHeartbeatAt ? new Date(run.lastHeartbeatAt).getTime() : 0
  if (Date.now() - lastBeat > 3 * 60 * 1000) return { label: 'killed — no heartbeat', bad: true }
  return { label: 'running', bad: false }
}

function parseCentsFromDisplay(value: string): number | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  const scaled = Number(normalized) * 100
  if (!Number.isFinite(scaled)) return undefined
  const rounded = Math.round(scaled)
  return Number.isSafeInteger(rounded) ? rounded : undefined
}

const reasonLabels: Record<string, string> = {
  test_data: 'Test data',
  erroneous: 'Erroneous',
}

const HOURS_OPTIONS = [
  { value: 1, label: '1 hour' },
  { value: 4, label: '4 hours' },
  { value: 12, label: '12 hours' },
  { value: 24, label: '24 hours' },
  { value: 48, label: '48 hours' },
]

const ORDER_PAGE_SIZE = 50
const RUNS_PAGE_SIZE = 5

export function DebuggingContent({ monitoringOnly = false }: { monitoringOnly?: boolean }) {
  const { user } = useAuth()
  const isAdmin = Boolean(user?.isAdmin)
  const { success, error } = useToast()
  const cached = getCachedDebugging()
  const [data, setData] = useState<DebuggingData | undefined>(cached)
  const [fetching, setFetching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  // Admin tool state
  const [reassignTarget, setReassignTarget] = useState<Record<string, string>>({})
  const [moveSource, setMoveSource] = useState('')
  const [moveTarget, setMoveTarget] = useState('')
  const [reprocessRange, setReprocessRange] = useState('')
  const [reprocessLimit, setReprocessLimit] = useState('1000')
  const [reprocessRunScheduledOnly, setReprocessRunScheduledOnly] = useState(true)
  const [reprocessResult, setReprocessResult] = useState<Record<string, unknown> | null>(null)
  const [reconAccount, setReconAccount] = useState('')
  const [reconCrypto, setReconCrypto] = useState(false)
  const [reconResult, setReconResult] = useState<Record<string, unknown> | null>(null)
  const [reconBusy, setReconBusy] = useState(false)
  const [reconYesterdayResult, setReconYesterdayResult] = useState<Record<string, unknown> | null>(null)
  const [reconYesterdayBusy, setReconYesterdayBusy] = useState(false)
  const [clearOpsBusy, setClearOpsBusy] = useState(false)
  const [reconcilingOrderId, setReconcilingOrderId] = useState<string | null>(null)
  const [simRange, setSimRange] = useState('')
  const [simAccount, setSimAccount] = useState('')
  const [simAction, setSimAction] = useState<'buy' | 'sell'>('buy')
  const [simTop, setSimTop] = useState('')
  const [simBottom, setSimBottom] = useState('')
  const [simQuantity, setSimQuantity] = useState('1')
  const [simOrderType, setSimOrderType] = useState('stop')
  const [simTpTicks, setSimTpTicks] = useState('')
  const [simSlTicks, setSimSlTicks] = useState('')
  const [simTpStyle, setSimTpStyle] = useState('')
  const [simSlStyle, setSimSlStyle] = useState('')
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null)
  const [armRange, setArmRange] = useState('')
  const [armTop, setArmTop] = useState('')
  const [armBottom, setArmBottom] = useState('')
  const [armQuantity, setArmQuantity] = useState('1')
  const [armBusy, setArmBusy] = useState(false)
  const [armResult, setArmResult] = useState<Record<string, unknown> | null>(null)
  const [ctAccount, setCtAccount] = useState('')
  const [ctAction, setCtAction] = useState<'buy' | 'sell' | 'cancel' | 'exit' | 'both'>('buy')
  const [ctInstrument, setCtInstrument] = useState('MNQ1!')
  const [ctQuantity, setCtQuantity] = useState('1')
  const [ctOrderType, setCtOrderType] = useState('market')
  const [ctLimitPrice, setCtLimitPrice] = useState('')
  const [ctStopPrice, setCtStopPrice] = useState('')
  const [ctBottomPrice, setCtBottomPrice] = useState('')
  const [ctTpTicks, setCtTpTicks] = useState('')
  const [ctSlTicks, setCtSlTicks] = useState('')
  const [ctTakeProfit, setCtTakeProfit] = useState('')
  const [ctStopLoss, setCtStopLoss] = useState('')
  const [ctUseTickExits, setCtUseTickExits] = useState(false)
  const [ctReferencePrice, setCtReferencePrice] = useState('')
  const [ctNotes, setCtNotes] = useState('')
  const [ctAtmStrategy, setCtAtmStrategy] = useState('')
  const [ctOcoId, setCtOcoId] = useState('')
  const [ctSending, setCtSending] = useState(false)
  const [ctResult, setCtResult] = useState<Record<string, unknown> | null>(null)
  const [ctStateAccount, setCtStateAccount] = useState('')
  const [ctStateBusy, setCtStateBusy] = useState(false)
  const [ctState, setCtState] = useState<Record<string, unknown> | null>(null)
  const [ctReconcileBusy, setCtReconcileBusy] = useState(false)
  const [ctReconcileResult, setCtReconcileResult] = useState<Record<string, unknown> | null>(null)
  const [ctOrderLookup, setCtOrderLookup] = useState('')
  const [ctOrderBusy, setCtOrderBusy] = useState(false)
  const [ctOrderResult, setCtOrderResult] = useState<Record<string, unknown> | null>(null)

  const [logs, setLogs] = useState<Record<string, unknown>[]>([])
  const [paused, setPaused] = useState(false)
  const [historyHours, setHistoryHours] = useState(4)
  const [reapplyHours, setReapplyHours] = useState(4)
  const [historyCategory, setHistoryCategory] = useState<'all' | 'traderspost' | 'routing' | 'lifecycle'>('all')
  const [logsLoading, setLogsLoading] = useState(false)
  const [sanityFilterText, setSanityFilterText] = useState('')
  const [sanityOnlyProblems, setSanityOnlyProblems] = useState(false)
  const [orderFilter, setOrderFilter] = useState<'attention' | 'open' | 'all'>('attention')
  const [orderHours, setOrderHours] = useState(4)
  const [orderPage, setOrderPage] = useState(0)
  const [runsPage, setRunsPage] = useState(0)
  const [emailOpenId, setEmailOpenId] = useState<string | null>(null)
  const [emails, setEmails] = useState<(Record<string, unknown> & { id: string })[]>([])
  const [emailHours, setEmailHours] = useState(4)

  const accounts = data?.accounts ?? []
  const traderspostDestinations = data?.traderspostDestinations ?? []
  const rangeConfigurations = data?.rangeConfigurations ?? []
  const flaggedRanges = data?.flaggedRanges ?? []
  const excludedTrades = data?.excludedTrades ?? []
  const untrackedRangeNames = data?.untrackedRangeNames ?? []
  const reapplyOperations = data?.reapplyOperations ?? []
  const reapplyCutoff = Date.now() - reapplyHours * 60 * 60 * 1000
  const visibleReapplyOperations = reapplyOperations.filter(
    (op) => new Date(op.createdAt).getTime() >= reapplyCutoff,
  )
  const openTradeSanity = data?.openTradeSanity ?? []
  const brokerOrders = data?.brokerOrders ?? []
  const processRuns = data?.processRuns ?? []

  const orderCutoff = orderHours > 0 ? Date.now() - orderHours * 60 * 60 * 1000 : 0
  const filteredBrokerOrders = brokerOrders.filter((order) => {
    if (new Date(order.occurredAt).getTime() < orderCutoff) return false
    if (orderFilter === 'all') return true
    if (orderFilter === 'open') return ['pending', 'acknowledged', 'uncertain'].includes(order.status)
    return ['pending', 'uncertain', 'rejected'].includes(order.status)
  })
  const orderPageCount = Math.max(1, Math.ceil(filteredBrokerOrders.length / ORDER_PAGE_SIZE))
  const effectiveOrderPage = Math.min(orderPage, orderPageCount - 1)
  const pagedBrokerOrders = filteredBrokerOrders.slice(
    effectiveOrderPage * ORDER_PAGE_SIZE,
    (effectiveOrderPage + 1) * ORDER_PAGE_SIZE,
  )
  const runsPageCount = Math.max(1, Math.ceil(processRuns.length / RUNS_PAGE_SIZE))
  const effectiveRunsPage = Math.min(runsPage, runsPageCount - 1)
  const pagedProcessRuns = processRuns.slice(effectiveRunsPage * RUNS_PAGE_SIZE, (effectiveRunsPage + 1) * RUNS_PAGE_SIZE)

  const filteredSanity = useMemo(() => {
    const text = sanityFilterText.trim().toLowerCase()
    return openTradeSanity
      .map((row) => {
        const isOffSchedule = row.routeRunScheduled && row.isScheduledDay === false
        const source = row.bracketId.startsWith('bridge-reapply-')
          ? 'reapply'
          : row.bracketId.startsWith('reconcile-')
            ? 'reconcile'
            : row.bracketId.includes('ultra-')
              ? 'pine'
              : 'other'
        const isReapply = source === 'reapply'
        const isPine = source === 'pine'
        const isMissingEvent = isPine && !row.hasTradeEvent
        const brokerRejected = row.brokerOrderStatus === 'rejected'
        const brokerUncertain = row.brokerOrderStatus === 'uncertain'
        const displayState = isOffSchedule
          ? 'off schedule'
          : brokerRejected
            ? 'rejected'
            : brokerUncertain
              ? 'uncertain'
              : isReapply
                ? 'reapply'
                : isMissingEvent
                  ? 'missing'
                  : row.state
        const hasProblem =
          ((isPine && !row.hasTradeEvent) ||
            !row.hasDispatchAlert ||
            row.deliveryStatus === 'traderspost_failed' ||
            brokerRejected ||
            brokerUncertain) &&
          !isOffSchedule
        const ageHours = (Date.now() - new Date(row.lastOccurredAt).getTime()) / 36e5
        const matchesText =
          !text ||
          [row.rangeName, row.instrument, row.accountName, row.side].some((v) =>
            v.toLowerCase().includes(text),
          )
        const matchesProblem = !sanityOnlyProblems || hasProblem
        const matchesAge = ageHours <= 168
        return { row, hasProblem, displayState, isOffSchedule, isReapply, isMissingEvent, brokerRejected, brokerUncertain, source, visible: matchesText && matchesProblem && matchesAge }
      })
      .filter((r) => r.visible)
  }, [openTradeSanity, sanityFilterText, sanityOnlyProblems])

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const trackedRangeNames = useMemo(() => rangeConfigurations.map((c) => c.rangeName), [rangeConfigurations])

  const load = useCallback(() => {
    setFetching(true)
    getJson<DebuggingData>(monitoringOnly ? '/api/monitoring' : '/api/debugging')
      .then((payload) => {
        setData(payload)
        setCachedDebugging(payload)
      })
      .catch(() => {})
      .finally(() => {
        setFetching(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => onEvent('journal:refresh', () => load()), [load])

  const fetchBridgeLogs = useCallback(() => {
    setLogsLoading(true)
    getJson<{ logs: { id: string; category: string; timestamp: string; data: Record<string, unknown> }[] }>(
      `/api/bridge-logs?hours=${historyHours}&category=${historyCategory}`,
    )
      .then((res) => {
        setLogs(
          res.logs
            .map((log) => ({
              ...log.data,
              id: log.id,
              category: log.data.category ?? log.category,
              timestamp: log.data.timestamp ?? log.timestamp,
            }))
            .slice(0, 200),
        )
      })
      .catch(() => error('Failed to load Bridge logs'))
      .finally(() => setLogsLoading(false))
  }, [historyHours, historyCategory])

  useEffect(() => {
    fetchBridgeLogs()
  }, [fetchBridgeLogs])

  const fetchEmails = useCallback(() => {
    getJson<{ logs: { id: string; category: string; timestamp: string; data: Record<string, unknown> }[] }>(
      `/api/bridge-logs?hours=${emailHours}&category=email`,
    )
      .then((res) => {
        setEmails(
          res.logs.map((log) => ({
            ...(log.data as Record<string, unknown>),
            id: log.id,
            timestamp: String(log.data.timestamp ?? log.timestamp),
          })),
        )
      })
      .catch(() => {})
  }, [emailHours])

  useEffect(() => {
    fetchEmails()
  }, [fetchEmails])

  // Live stream → prepend new log/email entries unless paused.
  useEffect(
    () =>
      onEvent('bridge:log', (detail) => {
        if (paused) return
        const entry = detail as Record<string, unknown>
        if (entry.category === 'email') {
          setEmails((prev) => [{ ...entry, id: String(entry.id ?? `live-${Date.now()}`) } as never, ...prev].slice(0, 100))
        }
        setLogs((prev) => [entry, ...prev].slice(0, 200))
      }),
    [paused],
  )

  const handleReassign = async (name: string) => {
    const target = reassignTarget[name]
    if (!target) return
    try {
      await postForm('/debugging/untracked-ranges/reassign', {
        sourceRangeName: name,
        targetRangeName: target,
      })
      success(`Reassigned ${name} to ${target}`)
      load()
    } catch {}
  }

  const handleClearFlag = async (rangeName: string) => {
    try {
      await postForm('/range-review-flags', { rangeName })
      success(`Cleared flag for ${rangeName}`)
      load()
    } catch {}
  }

  const handleMoveRange = async () => {
    if (!moveSource.trim() || !moveTarget.trim()) return
    try {
      await postForm('/ranges/move', {
        sourceRangeName: moveSource.trim(),
        targetRangeName: moveTarget.trim(),
      })
      success(`Moved ${moveSource} history to ${moveTarget}`)
      setMoveSource('')
      setMoveTarget('')
      load()
    } catch {}
  }

  const handleReconcile = async (mode: 'orders' | 'positions' | 'both', all = false) => {
    if (!all && !reconAccount) return
    const run = async () => {
      setReconBusy(true)
      try {
        const res = await postJson('/debugging/reconcile-bookkeeping', {
          accountId: all ? '*' : reconAccount,
          mode,
          includeCrypto: reconCrypto,
        })
        const result = (await res.json()) as Record<string, unknown>
        setReconResult(result)
        success(`Reconciled: ${result.ordersCancelled} order(s) cancelled, ${result.positionsClosed} position(s) closed`)
        load()
      } catch {
        error('Reconcile failed')
      } finally {
        setReconBusy(false)
      }
    }
    if (all) {
      Alert.alert('Reconcile all', 'Reconcile bookkeeping for ALL accounts? This writes journal entries for every stale order/position.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Reconcile', onPress: () => void run() },
      ])
    } else {
      void run()
    }
  }

  const handleReconcilePreviousDays = async () => {
    Alert.alert(
      'Reconcile open trades',
      "Close bracket_monitor rows whose last event was before today's session? Filled rows become breakeven closes; armed rows become erroneous closes.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reconcile',
          onPress: () => {
            setReconYesterdayBusy(true)
            void (async () => {
              try {
                const res = await postJson('/debugging/reconcile-previous-days', {})
                const result = (await res.json()) as Record<string, unknown>
                setReconYesterdayResult(result)
                success(`Reconciled: ${result.filledClosed} filled closed, ${result.armedCancelled} armed cancelled`)
                load()
              } catch {
                error('Reconcile failed')
              } finally {
                setReconYesterdayBusy(false)
              }
            })()
          },
        },
      ],
    )
  }

  const handleClearReapplyOps = async () => {
    Alert.alert(
      'Clear reapply log',
      'Clear the reapply log? Incomplete operations are marked cleared and completed history is dismissed. Bookkeeping only — no broker traffic.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            setClearOpsBusy(true)
            void (async () => {
              try {
                const res = await postJson('/debugging/clear-reapply-operations', { brokerReconciled: true })
                const result = (await res.json()) as { cleared?: number }
                success(`Cleared ${result.cleared ?? 0} reapply operation(s)`)
                load()
              } catch {
                error('Clear failed')
              } finally {
                setClearOpsBusy(false)
              }
            })()
          },
        },
      ],
    )
  }

  const handleReconcileOrder = async (order: BrokerOrder, status: string) => {
    const label = `${order.accountName ?? accountById.get(order.accountId)?.name ?? order.accountId} ${order.rangeName} ${order.action} @ ${order.price ?? order.stopPrice ?? '—'}`
    Alert.alert('Reconcile order', `Mark ${label} as ${status}? Bookkeeping only — no broker traffic is sent.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Mark',
        onPress: () => {
          setReconcilingOrderId(order.orderId)
          void (async () => {
            try {
              const res = await postJson('/debugging/reconcile-broker-order', { orderId: order.orderId, status })
              const result = (await res.json()) as { retiredBrackets?: string[]; error?: string }
              if (!res.ok) throw new Error(result.error ?? 'reconcile failed')
              success(`Marked ${status}${result.retiredBrackets?.length ? `; retired ${result.retiredBrackets.length} armed row(s)` : ''}`)
              load()
            } catch {
              error('Reconcile broker order failed')
            } finally {
              setReconcilingOrderId(null)
            }
          })()
        },
      },
    ])
  }

  const handleRetireArm = async (order: BrokerOrder) => {
    const label = `${order.accountName ?? accountById.get(order.accountId)?.name ?? order.accountId} ${order.rangeName} ${order.action} @ ${order.price ?? order.stopPrice ?? '—'}`
    Alert.alert('Retire arm', `Retire the armed open-trade row covered by ${label}? Confirm the arm is truly dead at the broker.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Retire',
        style: 'destructive',
        onPress: () => {
          setReconcilingOrderId(order.orderId)
          void (async () => {
            try {
              const res = await postJson('/debugging/reconcile-broker-order', { orderId: order.orderId, retireArm: true })
              const result = (await res.json()) as { retiredBrackets?: string[]; error?: string }
              if (!res.ok) throw new Error(result.error ?? 'reconcile failed')
              success(result.retiredBrackets?.length ? `Retired ${result.retiredBrackets.length} armed row(s)` : 'No armed row covered this order')
              load()
            } catch {
              error('Retire arm failed')
            } finally {
              setReconcilingOrderId(null)
            }
          })()
        },
      },
    ])
  }

  const handleReprocessLifecycle = async () => {
    const range = reprocessRange.trim()
    try {
      const res = await postJson('/debugging/reprocess-lifecycle', {
        ...(range ? { rangeName: range } : {}),
        limit: Number(reprocessLimit) || 1000,
        runScheduledOnly: reprocessRunScheduledOnly,
      })
      const result = (await res.json()) as Record<string, unknown>
      setReprocessResult(result)
      success(`Reprocessed ${result.processed} lifecycle alert${result.processed === 1 ? '' : 's'}`)
      load()
    } catch {}
  }

  const inspectCtOrder = async (order: BrokerOrder) => {
    setCtStateAccount(order.accountId)
    setCtOrderLookup(order.orderId)
    setCtOrderBusy(true)
    setCtOrderResult(null)
    try {
      const result = await getJson<Record<string, unknown>>(
        `/debugging/crosstrade-order?accountId=${encodeURIComponent(order.accountId)}&orderId=${encodeURIComponent(order.orderId)}`,
      )
      setCtOrderResult(result)
      if (result.ok === true) success('NT8 order found — see CrossTrade broker state card')
      else error(String(result.error ?? 'NT8 did not find the order'))
    } catch (err) {
      error(`Order lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCtOrderBusy(false)
    }
  }

  const renderOrderReconcile = (order: BrokerOrder) => {
    if (!isAdmin) return null
    const inspect = order.destination === 'crosstrade' ? (
      <Button small variant="ghost" title="inspect" disabled={ctOrderBusy} onPress={() => void inspectCtOrder(order)} />
    ) : null
    if (['pending', 'uncertain', 'acknowledged'].includes(order.status)) {
      return (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {inspect}
          {(['acknowledged', 'filled', 'closed', 'rejected', 'cancelled'] as const).map((s) => (
            <Button
              key={s}
              small
              variant="ghost"
              title={reconcilingOrderId === order.orderId ? '…' : s}
              disabled={reconcilingOrderId === order.orderId}
              onPress={() => void handleReconcileOrder(order, s)}
            />
          ))}
        </View>
      )
    }
    if (order.uncoveredArm) {
      return (
        <View style={{ flexDirection: 'row', gap: 4, marginTop: 4 }}>
          {inspect}
          <Button
            small
            variant="ghost"
            title="acknowledge"
            disabled={reconcilingOrderId === order.orderId}
            onPress={() => void handleRetireArm(order)}
          />
        </View>
      )
    }
    return inspect
  }

  const ctAccounts = traderspostDestinations.filter(
    (dest) => dest.crossTradeWebhookUrl && dest.crossTradeEnabled !== false && !accountById.get(dest.accountId)?.deprecated,
  )

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            load()
          }}
          tintColor={colors.accent}
        />
      }
    >
      {isAdmin && !monitoringOnly ? (
        <>
          <Text style={styles.groupLabel}>Account-related</Text>

          <Card title="TradersPost API Test">
            <Text style={styles.dim}>
              Send a synthetic test entry for a selected range to one configured TradersPost destination. Top/bottom become the bracket TP/SL.
            </Text>
            <SelectPicker
              label="Range"
              options={rangeConfigurations.map((c) => ({ value: c.rangeName, label: c.rangeName }))}
              value={simRange}
              onChange={setSimRange}
            />
            <View style={{ height: 8 }} />
            <SelectPicker
              label="Account"
              options={traderspostDestinations
                .filter((d) => accountById.get(d.accountId) && !accountById.get(d.accountId)!.deprecated)
                .map((d) => ({ value: d.accountId, label: accountById.get(d.accountId)!.name }))}
              value={simAccount}
              onChange={setSimAccount}
            />
            <View style={{ height: 8 }} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <SelectPicker
                  label="Action"
                  options={[
                    { value: 'buy', label: 'Buy' },
                    { value: 'sell', label: 'Sell' },
                  ]}
                  value={simAction}
                  onChange={(v) => setSimAction(v)}
                />
              </View>
              <View style={{ flex: 1 }}>
                <SelectPicker
                  label="Order type"
                  options={['market', 'limit', 'stop', 'stop_limit'].map((v) => ({ value: v, label: v }))}
                  value={simOrderType}
                  onChange={setSimOrderType}
                />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="Range top">
                  <Input value={simTop} onChangeText={setSimTop} keyboardType="decimal-pad" />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Range bottom">
                  <Input value={simBottom} onChangeText={setSimBottom} keyboardType="decimal-pad" />
                </Field>
              </View>
              <View style={{ flex: 0.6 }}>
                <Field label="Qty">
                  <Input value={simQuantity} onChangeText={setSimQuantity} keyboardType="numeric" />
                </Field>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="TP ticks">
                  <Input value={simTpTicks} onChangeText={setSimTpTicks} keyboardType="decimal-pad" />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="SL ticks">
                  <Input value={simSlTicks} onChangeText={setSimSlTicks} keyboardType="decimal-pad" />
                </Field>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="TP style">
                  <Input value={simTpStyle} onChangeText={setSimTpStyle} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="SL style">
                  <Input value={simSlStyle} onChangeText={setSimSlStyle} />
                </Field>
              </View>
            </View>
            <Button
              title="Send simulation"
              disabled={!simRange || !simAccount || simTop === '' || simBottom === ''}
              onPress={() => {
                void (async () => {
                  try {
                    const res = await postJson('/debugging/range-simulation', {
                      accountId: simAccount,
                      rangeName: simRange,
                      action: simAction,
                      top: Number(simTop),
                      bottom: Number(simBottom),
                      quantity: Number(simQuantity),
                      orderType: simOrderType,
                      ...(simTpTicks ? { takeProfitTicksCents: parseCentsFromDisplay(simTpTicks) } : {}),
                      ...(simSlTicks ? { stopLossTicksCents: parseCentsFromDisplay(simSlTicks) } : {}),
                      ...(simTpStyle ? { takeProfitStyle: simTpStyle } : {}),
                      ...(simSlStyle ? { stopLossStyle: simSlStyle } : {}),
                    })
                    const result = (await res.json()) as Record<string, unknown>
                    setSimResult(result)
                    success(`Range simulation sent to ${String(result.accountName)}`)
                  } catch {
                    error('Range simulation failed')
                  }
                })()
              }}
            />
            {simResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>{JSON.stringify(simResult.computed ?? simResult, null, 2)}</Text>
              </View>
            ) : null}
          </Card>

          <Card title="CrossTrade API test">
            <Text style={styles.dim}>
              Send a manual order to an account&rsquo;s configured CrossTrade endpoint — or the OCO pair action to send both arms of a range sharing one oco_id.
            </Text>
            <SelectPicker
              label="Account"
              options={ctAccounts.map((d) => ({ value: d.accountId, label: accountById.get(d.accountId)?.name ?? d.accountId }))}
              value={ctAccount}
              onChange={setCtAccount}
            />
            <View style={{ height: 8 }} />
            <SelectPicker
              label="Action"
              options={[
                { value: 'buy', label: 'Buy (place)' },
                { value: 'sell', label: 'Sell (place)' },
                { value: 'both', label: 'OCO pair — buy top / sell bottom' },
                { value: 'cancel', label: 'Cancel orders' },
                { value: 'exit', label: 'Flatten position' },
              ]}
              value={ctAction}
              onChange={(v) => setCtAction(v)}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="Instrument">
                  <Input value={ctInstrument} onChangeText={setCtInstrument} />
                </Field>
              </View>
              <View style={{ flex: 0.6 }}>
                <Field label="Quantity">
                  <Input value={ctQuantity} onChangeText={setCtQuantity} keyboardType="numeric" />
                </Field>
              </View>
            </View>
            {ctAction === 'buy' || ctAction === 'sell' ? (
              <>
                <SelectPicker
                  label="Order type"
                  options={['market', 'limit', 'stop', 'stop_limit'].map((v) => ({ value: v, label: v }))}
                  value={ctOrderType}
                  onChange={setCtOrderType}
                />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Field label="Limit price">
                      <Input value={ctLimitPrice} onChangeText={setCtLimitPrice} keyboardType="decimal-pad" />
                    </Field>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="Stop price">
                      <Input value={ctStopPrice} onChangeText={setCtStopPrice} keyboardType="decimal-pad" />
                    </Field>
                  </View>
                </View>
                <Pressable style={styles.checkRow} onPress={() => setCtUseTickExits((v) => !v)}>
                  <View style={[styles.checkbox, ctUseTickExits && { borderColor: colors.accent }]}>
                    {ctUseTickExits ? <Text style={{ color: colors.accent }}>✓</Text> : null}
                  </View>
                  <Text style={styles.dim}>Use TP/SL ticks (converted to prices)</Text>
                </Pressable>
                {ctUseTickExits ? (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Field label="TP ticks">
                        <Input value={ctTpTicks} onChangeText={setCtTpTicks} keyboardType="decimal-pad" />
                      </Field>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Field label="SL ticks">
                        <Input value={ctSlTicks} onChangeText={setCtSlTicks} keyboardType="decimal-pad" />
                      </Field>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Field label="Ref entry price">
                        <Input value={ctReferencePrice} onChangeText={setCtReferencePrice} keyboardType="decimal-pad" />
                      </Field>
                    </View>
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Field label="Take profit">
                        <Input value={ctTakeProfit} onChangeText={setCtTakeProfit} keyboardType="decimal-pad" />
                      </Field>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Field label="Stop loss">
                        <Input value={ctStopLoss} onChangeText={setCtStopLoss} keyboardType="decimal-pad" />
                      </Field>
                    </View>
                  </View>
                )}
              </>
            ) : null}
            {ctAction === 'both' ? (
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <View style={{ flex: 1 }}>
                  <Field label="Top (buy stop)">
                    <Input value={ctStopPrice} onChangeText={setCtStopPrice} keyboardType="decimal-pad" />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Bottom (sell stop)">
                    <Input value={ctBottomPrice} onChangeText={setCtBottomPrice} keyboardType="decimal-pad" />
                  </Field>
                </View>
              </View>
            ) : null}
            {ctAction === 'both' ? (
              <>
                <Pressable style={[styles.checkRow, { marginTop: 8 }]} onPress={() => setCtUseTickExits((v) => !v)}>
                  <View style={[styles.checkbox, ctUseTickExits && { borderColor: colors.accent }]}>
                    {ctUseTickExits ? <Text style={{ color: colors.accent }}>✓</Text> : null}
                  </View>
                  <Text style={styles.dim}>TP/SL in ticks (convert to prices)</Text>
                </Pressable>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Field label="TP ticks">
                      <Input value={ctTpTicks} onChangeText={setCtTpTicks} keyboardType="decimal-pad" />
                    </Field>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field label="SL ticks">
                      <Input value={ctSlTicks} onChangeText={setCtSlTicks} keyboardType="decimal-pad" />
                    </Field>
                  </View>
                </View>
              </>
            ) : null}
            {ctAction === 'buy' || ctAction === 'sell' || ctAction === 'both' ? (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Field label="ATM strategy">
                    <Input value={ctAtmStrategy} onChangeText={setCtAtmStrategy} />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="OCO id">
                    <Input value={ctOcoId} onChangeText={setCtOcoId} />
                  </Field>
                </View>
              </View>
            ) : null}
            <Field label="Notes">
              <Input value={ctNotes} onChangeText={setCtNotes} />
            </Field>
            <Button
              title={ctSending ? 'Sending…' : 'Send CrossTrade order'}
              disabled={
                ctSending ||
                !ctAccount ||
                !ctInstrument ||
                (ctAction === 'both' && (!ctStopPrice || !ctBottomPrice))
              }
              onPress={() => {
                if (ctUseTickExits && (ctAction === 'buy' || ctAction === 'sell') && ctOrderType === 'market' && (ctTpTicks || ctSlTicks) && !ctReferencePrice) {
                  error('Enter a reference entry price to convert market-order TP/SL ticks to absolute levels.')
                  return
                }
                setCtSending(true)
                void (async () => {
                  try {
                    const res = await postJson('/debugging/crosstrade-test', {
                      accountId: ctAccount,
                      action: ctAction,
                      instrument: ctInstrument,
                      quantity: Number(ctQuantity) || 1,
                      ...(ctAction === 'both'
                        ? {
                            stopPrice: Number(ctStopPrice),
                            bottomPrice: Number(ctBottomPrice),
                            ...(ctTpTicks ? { takeProfitTicks: Number(ctTpTicks) } : {}),
                            ...(ctSlTicks ? { stopLossTicks: Number(ctSlTicks) } : {}),
                            convertTicksToPrices: ctUseTickExits,
                          }
                        : {}),
                      ...(ctAction === 'buy' || ctAction === 'sell'
                        ? {
                            orderType: ctOrderType,
                            ...(ctLimitPrice ? { limitPrice: Number(ctLimitPrice) } : {}),
                            ...(ctStopPrice ? { stopPrice: Number(ctStopPrice) } : {}),
                            ...(ctUseTickExits
                              ? {
                                  ...(ctTpTicks ? { takeProfitTicks: Number(ctTpTicks) } : {}),
                                  ...(ctSlTicks ? { stopLossTicks: Number(ctSlTicks) } : {}),
                                  convertTicksToPrices: true,
                                  ...(ctOrderType === 'market' && ctReferencePrice ? { referencePrice: Number(ctReferencePrice) } : {}),
                                }
                              : {
                                  ...(ctTakeProfit ? { takeProfit: Number(ctTakeProfit) } : {}),
                                  ...(ctStopLoss ? { stopLoss: Number(ctStopLoss) } : {}),
                                }),
                          }
                        : {}),
                      ...(ctNotes ? { notes: ctNotes } : {}),
                      ...((ctAction === 'buy' || ctAction === 'sell' || ctAction === 'both') && ctAtmStrategy.trim()
                        ? { atmStrategy: ctAtmStrategy.trim() }
                        : {}),
                      ...((ctAction === 'buy' || ctAction === 'sell' || ctAction === 'both') && ctOcoId.trim()
                        ? { ocoId: ctOcoId.trim() }
                        : {}),
                    })
                    const result = (await res.json()) as Record<string, unknown>
                    setCtResult(result)
                    const legs = (result.legs as { success?: boolean }[] | undefined) ?? [result]
                    if (legs.every((leg) => leg.success === true)) success('CrossTrade order accepted')
                    else error('CrossTrade order was not fully accepted — see result')
                  } catch (err) {
                    error(`CrossTrade send failed: ${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setCtSending(false)
                  }
                })()
              }}
            />
            {ctResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>{JSON.stringify(ctResult, null, 2)}</Text>
              </View>
            ) : null}
          </Card>

          <Card title="CrossTrade broker state">
            <Text style={styles.dim}>
              Live NT8 state via the CrossTrade REST API — working orders, positions, and per-order lookup.
            </Text>
            <SelectPicker
              label="Account"
              options={ctAccounts.map((d) => ({ value: d.accountId, label: accountById.get(d.accountId)?.name ?? d.accountId }))}
              value={ctStateAccount}
              onChange={(v) => {
                setCtStateAccount(v)
                setCtState(null)
                setCtOrderResult(null)
              }}
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <Button
                small
                title={ctStateBusy ? 'Fetching…' : 'Fetch live state'}
                disabled={!ctStateAccount || ctStateBusy}
                onPress={() => {
                  setCtStateBusy(true)
                  setCtState(null)
                  void (async () => {
                    try {
                      const result = await getJson<Record<string, unknown>>(
                        `/debugging/crosstrade-state?accountId=${encodeURIComponent(ctStateAccount)}`,
                      )
                      setCtState(result)
                    } catch (err) {
                      error(`CrossTrade state fetch failed: ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setCtStateBusy(false)
                    }
                  })()
                }}
              />
              <Button
                small
                variant="ghost"
                title={ctReconcileBusy ? 'Reconciling…' : 'Reconcile local rows'}
                disabled={!ctStateAccount || ctReconcileBusy}
                onPress={() => {
                  setCtReconcileBusy(true)
                  setCtReconcileResult(null)
                  void (async () => {
                    try {
                      const res = await postJson('/debugging/reconcile-crosstrade', { accountId: ctStateAccount })
                      const result = (await res.json()) as Record<string, unknown>
                      setCtReconcileResult(result)
                      const outcomes = (result.outcomes as { outcome?: string }[] | undefined) ?? []
                      const resolved = outcomes.filter((o) => o.outcome !== 'unknown' && o.outcome !== 'in_flight').length
                      success(`Probed ${String(result.probed)} unresolved dispatch(es) — ${resolved} resolved by NT8 evidence`)
                    } catch (err) {
                      error(`Reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setCtReconcileBusy(false)
                    }
                  })()
                }}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Input value={ctOrderLookup} onChangeText={setCtOrderLookup} placeholder="order_id / bracket id" />
              </View>
              <Button
                small
                variant="ghost"
                title={ctOrderBusy ? '…' : 'Lookup'}
                disabled={!ctStateAccount || !ctOrderLookup.trim() || ctOrderBusy}
                onPress={() => {
                  setCtOrderBusy(true)
                  setCtOrderResult(null)
                  void (async () => {
                    try {
                      const result = await getJson<Record<string, unknown>>(
                        `/debugging/crosstrade-order?accountId=${encodeURIComponent(ctStateAccount)}&orderId=${encodeURIComponent(ctOrderLookup.trim())}`,
                      )
                      setCtOrderResult(result)
                    } catch (err) {
                      error(`Lookup failed: ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setCtOrderBusy(false)
                    }
                  })()
                }}
              />
            </View>
            {ctOrderResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>{JSON.stringify(ctOrderResult, null, 2)}</Text>
              </View>
            ) : null}
            {ctReconcileResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>{JSON.stringify(ctReconcileResult, null, 2)}</Text>
              </View>
            ) : null}
            {ctState ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>{JSON.stringify(ctState, null, 2)}</Text>
              </View>
            ) : null}
          </Card>

          <Text style={styles.groupLabel}>Range-related</Text>

          <Card title="Simulate range arm alerts">
            <Text style={styles.dim}>
              Send synthetic arm alerts for both sides of a range — CrossTrade accounts get the converted wire format.
            </Text>
            <SelectPicker
              label="Range"
              options={[{ value: '', label: 'Select a range' }, ...rangeConfigurations.map((c) => ({ value: c.rangeName, label: c.rangeName }))]}
              value={armRange}
              onChange={setArmRange}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="Range top (long entry)">
                  <Input value={armTop} onChangeText={setArmTop} keyboardType="decimal-pad" placeholder="Buy stop rests here" />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Range bottom (short entry)">
                  <Input value={armBottom} onChangeText={setArmBottom} keyboardType="decimal-pad" placeholder="Sell stop rests here" />
                </Field>
              </View>
              <View style={{ flex: 0.6 }}>
                <Field label="Qty">
                  <Input value={armQuantity} onChangeText={setArmQuantity} keyboardType="numeric" />
                </Field>
              </View>
            </View>
            <Button
              title={armBusy ? 'Sending…' : 'Send arm alerts (both sides)'}
              disabled={armBusy || !armRange || armTop === '' || armBottom === ''}
              onPress={() => {
                setArmBusy(true)
                void (async () => {
                  try {
                    const res = await postJson('/debugging/alert-simulation', {
                      rangeName: armRange,
                      top: Number(armTop),
                      bottom: Number(armBottom),
                      quantity: Number(armQuantity) || 1,
                    })
                    const result = (await res.json()) as Record<string, unknown>
                    setArmResult(result)
                    if (res.ok) success(`Arm alerts sent for ${String(result.rangeName)}`)
                    else error(String(result.error ?? 'Alert simulation failed'))
                  } catch {
                    error('Alert simulation failed')
                  } finally {
                    setArmBusy(false)
                  }
                })()
              }}
            />
            {armResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>
                  {String(armResult.rangeName)} · {String(armResult.instrument)}{'\n'}
                  {JSON.stringify(armResult.results ?? armResult, null, 2)}
                </Text>
              </View>
            ) : null}
          </Card>

          <Card title="Unrecognized alerts">
            <Text style={styles.dim}>
              Normalized incoming names that still are not tracked stay here until you reassign them to an existing range.
            </Text>
            {untrackedRangeNames.length === 0 ? (
              <Text style={styles.dim}>No untracked range names are waiting for review.</Text>
            ) : (
              untrackedRangeNames.map((untracked) => (
                <View key={untracked.name} style={styles.listRow}>
                  <Text style={styles.value}>{untracked.name}</Text>
                  <Text style={styles.dim}>
                    {untracked.alertCount} alerts · {untracked.latestInstrument} · <JournalDate value={untracked.latestReceivedAt} />
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                    <View style={{ flex: 1 }}>
                      <SelectPicker
                        options={[{ value: '', label: 'Select range' }, ...trackedRangeNames.map((n) => ({ value: n, label: n }))]}
                        value={reassignTarget[untracked.name] ?? ''}
                        onChange={(v) => setReassignTarget((prev) => ({ ...prev, [untracked.name]: v }))}
                      />
                    </View>
                    <Button small title="✓" onPress={() => void handleReassign(untracked.name)} />
                  </View>
                </View>
              ))
            )}
          </Card>

          <Card title="Globally flagged ranges">
            <Text style={styles.dim}>
              Test data ranges are removed from account performance. Erroneous ranges are also blocked from extension and TradersPost routing until cleared.
            </Text>
            {flaggedRanges.length === 0 ? (
              <Text style={styles.dim}>No ranges are currently flagged.</Text>
            ) : (
              flaggedRanges.map((flag) => (
                <View key={flag.rangeName} style={styles.listRow}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={styles.value}>{flag.rangeName}</Text>
                    <Button small variant="ghost" title="Clear" onPress={() => void handleClearFlag(flag.rangeName)} />
                  </View>
                  <Text style={styles.dim}>
                    {reasonLabels[flag.reason] ?? flag.reason} · {flag.flaggedByEmail}
                  </Text>
                </View>
              ))
            )}
          </Card>

          <Card title="Range history move">
            <Text style={styles.dim}>
              Move all alert and lifecycle history from one tracked range name to another. This is a destructive admin action and cannot be undone.
            </Text>
            <Field label="Source range">
              <Input value={moveSource} onChangeText={setMoveSource} placeholder="Old range name" />
            </Field>
            <Field label="Target range">
              <Input value={moveTarget} onChangeText={setMoveTarget} placeholder="New range name" />
            </Field>
            <Button small title="Move history" onPress={() => void handleMoveRange()} />
          </Card>

          <Text style={styles.groupLabel}>Bookkeeping-related</Text>

          <Card title="Reprocess lifecycle">
            <Text style={styles.dim}>
              Re-run lifecycle processing for stored alerts that were not recorded for the selected range, or for all tracked ranges.
            </Text>
            <SelectPicker
              label="Range"
              options={[
                { value: '', label: 'Select a tracked range' },
                { value: '*', label: 'All tracked ranges' },
                ...trackedRangeNames.map((n) => ({ value: n, label: n })),
              ]}
              value={reprocessRange}
              onChange={setReprocessRange}
            />
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Field label="Limit">
                  <Input value={reprocessLimit} onChangeText={setReprocessLimit} keyboardType="numeric" />
                </Field>
              </View>
              <Pressable style={styles.checkRow} onPress={() => setReprocessRunScheduledOnly((v) => !v)}>
                <View style={[styles.checkbox, reprocessRunScheduledOnly && { borderColor: colors.accent }]}>
                  {reprocessRunScheduledOnly ? <Text style={{ color: colors.accent }}>✓</Text> : null}
                </View>
                <Text style={styles.dim}>Scheduled days only</Text>
              </Pressable>
            </View>
            <Button small title="Reprocess" disabled={!reprocessRange} onPress={() => void handleReprocessLifecycle()} />
            {reprocessResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>
                  Processed: {String(reprocessResult.processed)}{'\n'}
                  Created: {String(reprocessResult.created)}{'\n'}
                  Trade events: {String(reprocessResult.tradeEvents)}{'\n'}
                  Errors: {String(reprocessResult.errors)}
                </Text>
              </View>
            ) : null}
          </Card>

          <Card title="Reconcile bookkeeping">
            <Text style={styles.dim}>
              Fix stale local bookkeeping for an account: records entry_cancelled for orders the DB still considers open, and closes open positions as breakeven. No broker traffic is sent.
            </Text>
            <SelectPicker
              label="Account"
              options={[
                { value: '', label: 'Select an account' },
                ...accounts.filter((a) => !a.deprecated).map((a) => ({ value: a.id, label: a.name })),
              ]}
              value={reconAccount}
              onChange={setReconAccount}
            />
            <Pressable style={[styles.checkRow, { marginVertical: 8 }]} onPress={() => setReconCrypto((v) => !v)}>
              <View style={[styles.checkbox, reconCrypto && { borderColor: colors.accent }]}>
                {reconCrypto ? <Text style={{ color: colors.accent }}>✓</Text> : null}
              </View>
              <Text style={styles.dim}>Include crypto futures</Text>
            </Pressable>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button small variant="ghost" title="Reconcile" disabled={!reconAccount || reconBusy} onPress={() => void handleReconcile('both')} />
              <Button small title="Reconcile all accounts" disabled={reconBusy} onPress={() => void handleReconcile('both', true)} />
            </View>
            {reconResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>
                  Orders cancelled: {String(reconResult.ordersCancelled)}{'\n'}
                  Positions closed (BE): {String(reconResult.positionsClosed)}{'\n'}
                  Crypto skipped: {String(reconResult.skippedCrypto)}
                </Text>
                {Array.isArray(reconResult.details) && reconResult.details.length > 0 ? (
                  <Text style={[styles.dim, { marginTop: 4 }]}>
                    {(reconResult.details as string[]).join('\n')}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </Card>

          <Card title="Reconcile open trades from previous days">
            <Text style={styles.dim}>
              Close any bracket_monitor row still armed or filled whose last event was before the current journal day. No broker traffic is sent.
            </Text>
            <Button
              small
              title={reconYesterdayBusy ? 'Working…' : 'Reconcile open trades from previous days'}
              disabled={reconYesterdayBusy}
              onPress={() => void handleReconcilePreviousDays()}
            />
            {reconYesterdayResult ? (
              <View style={styles.resultBox}>
                <Text style={styles.resultText}>
                  Filled closed: {String(reconYesterdayResult.filledClosed)}{'\n'}
                  Armed cancelled: {String(reconYesterdayResult.armedCancelled)}{'\n'}
                  Skipped: {String(reconYesterdayResult.skipped)}{'\n'}
                  Total inspected: {String(reconYesterdayResult.total)}
                </Text>
              </View>
            ) : null}
          </Card>

          <Card title="Excluded trade records">
            <Text style={styles.dim}>
              These closed trades stay visible for review, but they no longer affect journal, account, or range performance.
            </Text>
            {excludedTrades.length === 0 ? (
              <Text style={styles.dim}>No excluded trade records.</Text>
            ) : (
              excludedTrades.map((t) => (
                <View key={t.id} style={styles.listRow}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={styles.value}>{t.rangeName}</Text>
                    <Text style={{ color: pnlColor(t.realizedDollarsCents ?? 0), fontWeight: '600' }}>
                      {formatPnl(t.realizedDollarsCents ?? 0)}
                    </Text>
                  </View>
                  <Text style={styles.dim}>
                    {accountById.get(t.accountId)?.name ?? t.accountId} ·{' '}
                    {t.exclusionReason ? (reasonLabels[t.exclusionReason] ?? t.exclusionReason) : '—'} ·{' '}
                    <JournalDate value={t.occurredAt} />
                  </Text>
                </View>
              ))
            )}
          </Card>
        </>
      ) : null}

      {/* Monitoring sections */}
      <Text style={styles.groupLabel}>Monitoring</Text>

      <CollapsibleSection
        storageKey="monitoring:bridgeLog:open"
        title={<Text style={styles.sectionTitle}>Server logs</Text>}
        actions={<Button small variant="ghost" title="↻" disabled={logsLoading} onPress={fetchBridgeLogs} />}
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <View style={{ flex: 1, minWidth: 120 }}>
            <SelectPicker label="Hours" options={HOURS_OPTIONS} value={historyHours} onChange={setHistoryHours} />
          </View>
          <View style={{ flex: 1, minWidth: 120 }}>
            <SelectPicker
              label="Category"
              options={[
                { value: 'all', label: 'All' },
                { value: 'traderspost', label: 'TradersPost' },
                { value: 'routing', label: 'Routing' },
                { value: 'lifecycle', label: 'Lifecycle' },
              ]}
              value={historyCategory}
              onChange={(v) => setHistoryCategory(v)}
            />
          </View>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <Button small variant={paused ? 'primary' : 'ghost'} title={paused ? 'Resume' : 'Pause'} onPress={() => setPaused(!paused)} />
            <Button small variant="ghost" title="Clear" onPress={() => setLogs([])} />
          </View>
        </View>
        {logs.length === 0 ? (
          <Text style={styles.dim}>No Bridge activity in the selected window.</Text>
        ) : (
          logs.map((log, idx) => {
            const category = String(log.category ?? 'unknown')
            const phase = String(log.phase ?? '')
            const ok = log.success === true
            const badge = (() => {
              if (category === 'traderspost' && phase === 'request') return { text: 'REQ', color: '#60a5fa' }
              if (category === 'traderspost' && ok) return { text: 'OK', color: colors.positive }
              if (category === 'traderspost') return { text: 'ERR', color: colors.negative }
              if (category === 'routing') return { text: 'ROUTE', color: '#a5b4fc' }
              if (category === 'lifecycle') return { text: 'LIFE', color: '#2dd4bf' }
              if (category === 'reapply') return { text: 'REAP', color: colors.amber }
              if (category === 'email') return { text: 'MAIL', color: colors.negative }
              return { text: category.toUpperCase().slice(0, 4), color: colors.muted }
            })()
            const summary = (() => {
              if (category === 'traderspost') {
                const payload = log.payload as Record<string, unknown> | undefined
                const action = payload?.action ?? '-'
                const ticker = payload?.ticker ?? '-'
                const quantity = payload?.quantity ?? '-'
                if (phase === 'request') return `${action} ${ticker} ×${quantity}`
                return `${action} ${ticker} → HTTP ${(log.statusCode as number | undefined) ?? '-'}`
              }
              if (category === 'routing') {
                return `${log.action ?? '-'} ${log.ticker ?? '-'} → ${log.status ?? '-'} (${log.accountName ?? '-'})`
              }
              if (category === 'lifecycle') {
                return `${log.eventType ?? '-'} ${log.ticker ?? '-'}${log.outcome ? ` · ${log.outcome}` : ''} (${log.rangeName ?? '-'})`
              }
              if (category === 'reapply') return String(log.message ?? 'Reapply event')
              if (category === 'email') {
                const ticker = log.ticker ? String(log.ticker) : ''
                const subject = String(log.subject ?? 'TradersPost email')
                const matched = Array.isArray(log.matchedOrders) ? log.matchedOrders.length : 0
                const base = `${subject}${ticker ? ` · ${ticker}` : ''}`
                if (log.unattributed) return `${base} · unattributed`
                if (log.notFailure) return `${base} · stored (not a failure)`
                if (log.ambiguous) return `${base} · ambiguous — review`
                return `${base} · ${matched} order${matched === 1 ? '' : 's'} marked rejected`
              }
              return 'Bridge log entry'
            })()
            const details = (() => {
              if (category === 'traderspost') {
                const payload = log.payload as Record<string, unknown> | undefined
                const range = (payload?.extras as Record<string, unknown> | undefined)?.rangeName ?? log.rangeName ?? '-'
                return `${log.source ?? '-'} · ${range} · ${log.accountName ?? '-'}`
              }
              if (category === 'routing') {
                return `${log.rangeName ?? '-'} · ${log.suppressed === true ? 'suppressed' : 'routed'}`
              }
              if (category === 'lifecycle') {
                return `${log.side ?? '-'} ×${log.quantity ?? '-'} · ${log.recorded === false ? 'not recorded' : 'recorded'}`
              }
              return ''
            })()
            return (
              <View key={String(log.id ?? idx)} style={styles.logRow}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[styles.logBadge, { color: badge.color }]}>{badge.text}</Text>
                  <Text style={styles.logSummary} numberOfLines={2}>{summary}</Text>
                </View>
                <Text style={styles.logMeta}>
                  {String(log.timestamp ?? '').slice(11, 19)} {details ? `· ${details}` : ''}
                </Text>
              </View>
            )
          })
        )}
      </CollapsibleSection>

      <CollapsibleSection
        storageKey="monitoring:reapplyOps:open"
        title={<Text style={styles.sectionTitle}>TradersPost Reapply Logs (OCO function)</Text>}
        actions={
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {isAdmin ? <Button small variant="ghost" title="Clear" disabled={clearOpsBusy} onPress={() => void handleClearReapplyOps()} /> : null}
            <Button small variant="ghost" title="↻" disabled={fetching} onPress={load} />
          </View>
        }
      >
        <View style={{ width: 160, marginBottom: 8 }}>
          <SelectPicker label="Hours" options={HOURS_OPTIONS} value={reapplyHours} onChange={setReapplyHours} />
        </View>
        {visibleReapplyOperations.length === 0 ? (
          <Text style={styles.dim}>No reapply operations in the selected window.</Text>
        ) : (
          visibleReapplyOperations.map((op) => (
            <View key={op.id} style={styles.listRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <JournalDate value={op.createdAt} />
                <Text style={styles.value}>{op.instrument}</Text>
                <Text style={styles.dim}>{accountById.get(op.accountId)?.name ?? op.accountId}</Text>
                <Badge status={op.completed ? 'offline' : 'warning'}>
                  {op.completed ? (op.reason ?? 'Completed') : 'Incomplete'}
                </Badge>
              </View>
              <Text style={styles.dim}>
                closed {op.closingRangeName} · rearmed {op.rearmedRangeNames.length ? op.rearmedRangeNames.join(', ') : '—'}
              </Text>
            </View>
          ))
        )}
      </CollapsibleSection>

      {brokerOrders.length === 0 ? (
        <Card>
          <Text style={styles.dim}>No broker orders.</Text>
        </Card>
      ) : (
        <CollapsibleSection
          storageKey="monitoring:brokerOrders:open"
          title={<Text style={styles.sectionTitle}>Order attempts and local state</Text>}
          actions={<Button small variant="ghost" title="↻" disabled={fetching} onPress={load} />}
        >
          <Text style={[styles.dim, { marginBottom: 6 }]}>
            Webhook acceptance is not a broker fill or flatten confirmation. Lifecycle and Bridge statuses are local bookkeeping; operator statuses are manually reported.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <View style={{ minWidth: 200, flex: 1 }}>
              <SelectPicker
                options={[
                  { value: 'attention', label: 'Needs attention (pending / uncertain / rejected)' },
                  { value: 'open', label: 'Open / submitted' },
                  { value: 'all', label: 'All (latest 200)' },
                ]}
                value={orderFilter}
                onChange={(v) => {
                  setOrderFilter(v)
                  setOrderPage(0)
                }}
              />
            </View>
            <View style={{ width: 130 }}>
              <SelectPicker
                options={[
                  { value: 0, label: 'All time' },
                  { value: 4, label: 'Last 4 hours' },
                  { value: 12, label: 'Last 12 hours' },
                  { value: 24, label: 'Last 24 hours' },
                  { value: 48, label: 'Last 48 hours' },
                ]}
                value={orderHours}
                onChange={(v) => {
                  setOrderHours(v)
                  setOrderPage(0)
                }}
              />
            </View>
          </View>
          <Text style={styles.dim}>
            {filteredBrokerOrders.length} of {brokerOrders.length} shown
          </Text>
          {orderPageCount > 1 ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginVertical: 4 }}>
              <Button small variant="ghost" title="Prev" disabled={effectiveOrderPage === 0} onPress={() => setOrderPage(effectiveOrderPage - 1)} />
              <Text style={styles.dim}>Page {effectiveOrderPage + 1} of {orderPageCount}</Text>
              <Button small variant="ghost" title="Next" disabled={effectiveOrderPage >= orderPageCount - 1} onPress={() => setOrderPage(effectiveOrderPage + 1)} />
            </View>
          ) : null}
          {pagedBrokerOrders.length === 0 ? (
            <Text style={styles.dim}>No orders match this filter.</Text>
          ) : (
            pagedBrokerOrders.map((order) => (
              <View key={order.id} style={styles.listRow}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  <JournalDate value={order.createdAt} />
                  <Text style={styles.value}>{order.rangeName}</Text>
                  <Text style={styles.dim}>{order.instrument}</Text>
                  <Text style={styles.dim}>{order.accountName ?? accountById.get(order.accountId)?.name ?? order.accountId}</Text>
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 2 }}>
                  <Text style={[styles.value, { textTransform: 'uppercase' }]}>
                    {order.action}
                    {order.side ? ` · ${order.side}` : ''}
                    {order.quantity != null ? ` ×${order.quantity}` : ''}
                  </Text>
                  <Badge status={order.status === 'rejected' ? 'error' : order.status === 'uncertain' || order.status === 'pending' ? 'warning' : 'offline'}>
                    {order.status}
                  </Badge>
                  <Badge status={order.destination === 'crosstrade' ? 'info' : 'offline'}>
                    {order.destination === 'crosstrade' ? 'CT' : 'TP'}
                  </Badge>
                  <Text style={styles.dimSmall}>
                    {order.statusSource ?? 'legacy'} · dispatch {order.dispatchStatus ?? 'unknown'}
                  </Text>
                </View>
                <Text style={styles.dimSmall} numberOfLines={1}>{order.orderId}</Text>
                {order.errorText ? <Text style={{ color: colors.negative, fontSize: 11 }}>{order.errorText}</Text> : null}
                {renderOrderReconcile(order)}
              </View>
            ))
          )}
        </CollapsibleSection>
      )}

      {isAdmin && processRuns.length > 0 ? (
        <CollapsibleSection
          storageKey="monitoring:processRuns:open"
          title={<Text style={styles.sectionTitle}>Server Process Uptime</Text>}
        >
          <Text style={[styles.dim, { marginBottom: 6 }]}>
            One row per server process lifetime. A row with no end and a stale heartbeat means the process was killed without running its exit handlers.
          </Text>
          {runsPageCount > 1 ? (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <Button small variant="ghost" title="Prev" disabled={effectiveRunsPage === 0} onPress={() => setRunsPage(effectiveRunsPage - 1)} />
              <Text style={styles.dim}>Page {effectiveRunsPage + 1} of {runsPageCount}</Text>
              <Button small variant="ghost" title="Next" disabled={effectiveRunsPage >= runsPageCount - 1} onPress={() => setRunsPage(effectiveRunsPage + 1)} />
            </View>
          ) : null}
          {pagedProcessRuns.map((run) => {
            const status = processRunStatus(run)
            return (
              <View key={run.id} style={[styles.listRow, status.bad && { borderColor: colors.negative }]}>
                <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text style={[styles.value, status.bad && { color: colors.negative }]}>{status.label}</Text>
                  <Text style={styles.dim}>pid {run.pid}</Text>
                  <JournalDate value={run.startedAt} />
                </View>
                {run.fatal?.message ? (
                  <Text style={{ color: colors.negative, fontSize: 11 }}>{run.fatal.name}: {run.fatal.message}</Text>
                ) : null}
                <Text style={styles.dimSmall}>
                  ended {run.endedAt ? formatJournalDate(run.endedAt) : '—'} · beat {run.lastHeartbeatAt ? formatJournalDate(run.lastHeartbeatAt) : '—'} · rss {formatMb(run.rssBytes)} · heap {formatMb(run.heapUsedBytes)} · lag {run.eventLoopLagMs !== undefined ? `${run.eventLoopLagMs} ms` : '—'}
                </Text>
              </View>
            )
          })}
        </CollapsibleSection>
      ) : null}

      <CollapsibleSection
        storageKey="monitoring:emailIngest:open"
        title={<Text style={styles.sectionTitle}>Ingested emails{emails.length > 0 ? ` (${emails.length})` : ''}</Text>}
        actions={<Button small variant="ghost" title="↻" onPress={fetchEmails} />}
      >
        <View style={{ width: 160, marginBottom: 8 }}>
          <SelectPicker label="Hours" options={HOURS_OPTIONS} value={emailHours} onChange={setEmailHours} />
        </View>
        {emails.length === 0 ? (
          <Text style={styles.dim}>No ingested emails in the selected window.</Text>
        ) : (
          emails.map((mail) => {
            const matched = Array.isArray(mail.matchedOrders) ? mail.matchedOrders.length : 0
            const open = emailOpenId === mail.id
            return (
              <View
                key={mail.id}
                style={[
                  styles.listRow,
                  Boolean(mail.unattributed || mail.ambiguous) && { borderColor: colors.amber },
                  matched > 0 ? { borderColor: colors.negative } : null,
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Text style={styles.dimSmall}>
                    {new Date(String(mail.timestamp)).toLocaleString('en-US', { timeZone: JOURNAL_TIME_ZONE })}
                  </Text>
                  <Text style={[styles.logBadge, { color: colors.negative }]}>MAIL</Text>
                  <Text style={styles.value} numberOfLines={1}>{String(mail.subject ?? 'TradersPost email')}</Text>
                  <Button small variant="ghost" title={open ? 'Hide' : 'View'} onPress={() => setEmailOpenId(open ? null : mail.id)} />
                </View>
                <Text style={styles.dimSmall}>
                  {[mail.accountName, mail.ticker].filter(Boolean).join(' · ')}{' '}
                  {mail.unattributed
                    ? 'unattributed'
                    : mail.notFailure
                      ? 'stored (not a failure)'
                      : mail.ambiguous
                        ? 'ambiguous — review'
                        : `${matched} order${matched === 1 ? '' : 's'} rejected`}
                  {mail.senderTrusted === false ? ' · untrusted sender' : ''}
                </Text>
                {open ? (
                  <View style={{ marginTop: 6 }}>
                    <Text style={styles.dimSmall}>From: {String(mail.from ?? '-')}</Text>
                    <Text style={styles.dimSmall}>To: {String(mail.to ?? '-')}</Text>
                    {mail.bracketId ? <Text style={styles.dimSmall}>Bracket: {String(mail.bracketId)}</Text> : null}
                    {mail.attributedBy ? <Text style={styles.dimSmall}>Attributed by: {String(mail.attributedBy)}</Text> : null}
                    <Text style={[styles.dimSmall, { marginTop: 4 }]}>{String(mail.body ?? mail.errorText ?? 'No body captured')}</Text>
                  </View>
                ) : null}
              </View>
            )
          })
        )}
      </CollapsibleSection>

      {openTradeSanity.length === 0 ? (
        <Card>
          <Text style={styles.dim}>No open brackets.</Text>
        </Card>
      ) : (
        <CollapsibleSection
          storageKey="monitoring:openTradeSanity:open"
          title={<Text style={styles.sectionTitle}>Open Trade Sanity</Text>}
          actions={<Button small variant="ghost" title="↻" disabled={fetching} onPress={load} />}
        >
          <Text style={[styles.dim, { marginBottom: 6 }]}>
            Where each open bracket came from. A red row means a Pine alert is missing its journal record, or the bracket has no dispatch / a failed delivery.
          </Text>
          <Field label="Filter">
            <Input value={sanityFilterText} onChangeText={setSanityFilterText} placeholder="range / instrument / account / side" />
          </Field>
          <Pressable style={[styles.checkRow, { marginBottom: 8 }]} onPress={() => setSanityOnlyProblems((v) => !v)}>
            <View style={[styles.checkbox, sanityOnlyProblems && { borderColor: colors.accent }]}>
              {sanityOnlyProblems ? <Text style={{ color: colors.accent }}>✓</Text> : null}
            </View>
            <Text style={styles.dim}>Only problems</Text>
          </Pressable>
          {filteredSanity.length === 0 ? (
            <Text style={styles.dim}>No open brackets match the current filters.</Text>
          ) : (
            filteredSanity.map(({ row, hasProblem, displayState, isOffSchedule, isReapply, isMissingEvent, brokerRejected, brokerUncertain, source }) => (
              <View key={`${row.accountId}-${row.rangeName}-${row.bracketId}-${row.side}`} style={[styles.listRow, hasProblem && { borderColor: colors.negative }]}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.value}>{row.rangeName}</Text>
                  <Text style={styles.dim}>{row.instrument}</Text>
                  <Text style={styles.dim}>{row.accountName}</Text>
                  <Text style={[styles.dim, { textTransform: 'uppercase' }]}>{row.side}</Text>
                  <Text style={styles.dim}>×{row.quantity}</Text>
                  <Badge
                    status={
                      brokerRejected || brokerUncertain
                        ? 'error'
                        : isOffSchedule || isMissingEvent
                          ? 'offline'
                          : isReapply
                            ? 'info'
                            : row.state === 'filled'
                              ? 'online'
                              : 'warning'
                    }
                  >
                    {displayState}
                  </Badge>
                  {row.oppositeSideExists ? (
                    <Badge status="offline">opposite {row.oppositeSideState ?? 'unknown'}</Badge>
                  ) : null}
                </View>
                <Text style={styles.dimSmall}>
                  event: {row.hasTradeEvent ? (row.tradeEventType ?? 'yes') : isReapply ? 'bridge reapply' : source === 'reconcile' ? 'manual reconcile' : row.hasLifecycleAlert ? 'arrived but not journaled' : 'none'} ·
                  dispatch: {row.hasDispatchAlert ? (row.deliveryStatus ?? 'pending') : 'missing'}
                  {row.brokerOrderStatus ? ` · broker: ${row.brokerOrderStatus}` : ''} ·
                  TP: {row.routeTraderspostEnabled ? 'on' : 'off'} ·
                  Ext: {row.routeExtensionEnabled ? 'on' : 'off'} ·
                  scheduled: {row.routeRunScheduled ? (row.isScheduledDay ? 'yes' : 'no') : 'n/a'}
                </Text>
                <JournalDate value={row.lastOccurredAt} />
              </View>
            ))
          )}
        </CollapsibleSection>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  checkRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  checkbox: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  container: { backgroundColor: colors.bg, flex: 1 },
  dim: { color: colors.muted, fontSize: 12 },
  dimSmall: { color: colors.faint, fontSize: 11 },
  groupLabel: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    color: colors.faint,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 10,
    marginTop: 8,
    paddingBottom: 4,
    textTransform: 'uppercase',
  },
  listRow: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    padding: 10,
  },
  logBadge: { fontSize: 10, fontWeight: '800' },
  logMeta: { color: colors.faint, fontSize: 10, marginTop: 2 },
  logRow: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 6,
  },
  logSummary: { color: colors.text, flex: 1, fontSize: 12 },
  resultBox: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 10,
    padding: 10,
  },
  resultText: { color: colors.text, fontFamily: 'Menlo', fontSize: 10 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  value: { color: colors.text, fontSize: 13, fontWeight: '600' },
})

export default function DebuggingScreen() {
  return <DebuggingContent />
}
