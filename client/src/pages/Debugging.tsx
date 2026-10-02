import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { PageHeader } from '../components/PageHeader'
import { Input } from '../components/Input'
import { Button } from '../components/Button'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { getCachedDebugging, setCachedDebugging } from '../utils/debugging-cache'
import { getJson, postForm, postJson } from '../api/client'
import { EmailIngestCard } from '../components/EmailIngestCard'
import { formatJournalDate, formatPnl, JOURNAL_TIME_ZONE } from '../utils/format'
import { tradingViewInstrumentIconUrl } from '../utils/instruments'
import type {
  BridgeAccount,
  BrokerOrder,
  OpenTradeSanity,
  ProcessRun,
  RangeConfiguration,
  RangeReviewFlag,
  ReapplyOperationSummary,
  TradeEvent,
  TradersPostAccountDestination,
  UntrackedRange,
} from '../types'
import { JournalDate } from '../components/JournalDate'

const reasonLabels: Record<string, string> = {
  test_data: 'Test data',
  erroneous: 'Erroneous',
}

function formatMb(bytes?: number): string {
  if (bytes === undefined) return '—'
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

function processRunStatus(run: ProcessRun): { label: string; tone: 'ok' | 'bad' | 'muted' } {
  if (!run.endedAt) {
    const lastAlive = run.lastHeartbeatAt ?? run.startedAt
    const silenceMs = Date.now() - new Date(lastAlive).getTime()
    if (silenceMs < 3 * 60 * 1000) return { label: 'running', tone: 'ok' }
    if (run.lastHeartbeatAt) return { label: `killed or hung — last heartbeat $<JournalDate value={run.lastHeartbeatAt} />`, tone: 'bad' }
    return { label: 'killed — no exit handler ran (SIGKILL / OOM / host)', tone: 'bad' }
  }
  if (run.cleanExit) return { label: `clean (exit ${run.exitCode ?? 0})`, tone: 'muted' }
  if (run.fatal) return { label: `crash — ${run.fatal.event}`, tone: 'bad' }
  return { label: `abnormal exit ${run.exitCode ?? '?'}`, tone: 'bad' }
}

function parseCentsFromDisplay(value: string): number | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  const scaled = Number(normalized) * 100
  if (!Number.isFinite(scaled)) return undefined
  const rounded = Math.round(scaled)
  return Number.isSafeInteger(rounded) ? rounded : undefined
}

export interface DebuggingData {
  accounts: BridgeAccount[]
  traderspostDestinations: TradersPostAccountDestination[]
  rangeConfigurations: RangeConfiguration[]
  flaggedRanges: RangeReviewFlag[]
  excludedTrades: TradeEvent[]
  untrackedRangeNames: UntrackedRange[]
  reapplyOperations: ReapplyOperationSummary[]
  openTradeSanity: OpenTradeSanity[]
  brokerOrders: BrokerOrder[]
  processRuns?: ProcessRun[]
}

export function DebuggingPage({ view = 'full' }: { view?: 'full' | 'monitoring' } = {}) {
  const { success, error, toast } = useToast()
  const { user } = useAuth()
  const isAdmin = Boolean(user?.isAdmin)
  const [exclusionFilter] = useState<'all' | 'test_data' | 'erroneous'>('all')
  const cached = getCachedDebugging()
  const [data, setData] = useState<DebuggingData | undefined>(cached)
  const [fetching, setFetching] = useState(false)
  const [reassignTarget, setReassignTarget] = useState<Record<string, string>>(
    {},
  )
  const [moveSource, setMoveSource] = useState('')
  const [moveTarget, setMoveTarget] = useState('')
  const [reprocessRange, setReprocessRange] = useState('')
  const [reprocessLimit, setReprocessLimit] = useState(1000)
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
  const [simOrderType, setSimOrderType] = useState<string>('stop')
  const [simTpTicks, setSimTpTicks] = useState('')
  const [simSlTicks, setSimSlTicks] = useState('')
  const [simTpStyle, setSimTpStyle] = useState('')
  const [armRange, setArmRange] = useState('')
  const [armTop, setArmTop] = useState('')
  const [armBottom, setArmBottom] = useState('')
  const [armQuantity, setArmQuantity] = useState('1')
  const [armBusy, setArmBusy] = useState(false)
  const [armResult, setArmResult] = useState<Record<string, unknown> | null>(null)
  const [simSlStyle, setSimSlStyle] = useState('')
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null)
  const [ctAccount, setCtAccount] = useState('')
  const [ctAction, setCtAction] = useState<'buy' | 'sell' | 'cancel' | 'exit' | 'both'>('buy')
  const [ctInstrument, setCtInstrument] = useState('MNQ1!')
  const [ctQuantity, setCtQuantity] = useState('1')
  const [ctOrderType, setCtOrderType] = useState<string>('market')
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
  const [spinReapply, setSpinReapply] = useState(false)
  const [spinBridge, setSpinBridge] = useState(false)

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

  const [sanityFilterText, setSanityFilterText] = useState('')
  const [sanityOnlyProblems, setSanityOnlyProblems] = useState(false)
  const [orderFilter, setOrderFilter] = useState<'attention' | 'open' | 'all'>('attention')
  const [orderHours, setOrderHours] = useState(4) // 0 = all time
  const [orderPage, setOrderPage] = useState(0)

  const ORDER_PAGE_SIZE = 50
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
  const [runsPage, setRunsPage] = useState(0)
  const RUNS_PAGE_SIZE = 5
  const runsPageCount = Math.max(1, Math.ceil(processRuns.length / RUNS_PAGE_SIZE))
  const effectiveRunsPage = Math.min(runsPage, runsPageCount - 1)
  const pagedProcessRuns = processRuns.slice(
    effectiveRunsPage * RUNS_PAGE_SIZE,
    (effectiveRunsPage + 1) * RUNS_PAGE_SIZE,
  )

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
        // The webhook can be accepted while the broker still rejects the order
        // asynchronously — the ledger status is the ground truth for "working".
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

  const accountById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  )

  const filteredExclusions = useMemo(() => {
    if (exclusionFilter === 'all') return excludedTrades
    return excludedTrades.filter((t) => t.exclusionReason === exclusionFilter)
  }, [excludedTrades, exclusionFilter])

  const trackedRangeNames = useMemo(
    () => rangeConfigurations.map((c) => c.rangeName),
    [rangeConfigurations],
  )

  const load = useCallback(() => {
    setFetching(true)
    getJson<DebuggingData>(view === 'monitoring' ? '/api/monitoring' : '/api/debugging')
      .then((fresh) => {
        setData(fresh)
        setCachedDebugging(fresh)
      })
      .catch((err) => {
        console.error('Failed to load debugging data:', err)
        error('Failed to load debugging data')
      })
      .finally(() => {
        setFetching(false)
      })
  }, [view])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onRefresh = () => {
      void load()
    }
    window.addEventListener('journal:refresh', onRefresh)
    return () => window.removeEventListener('journal:refresh', onRefresh)
  }, [load])

  useEffect(() => {
    const handler = (e: Event) => {
      if (paused) return
      const data = (e as CustomEvent<Record<string, unknown>>).detail
      if (!data) return
      if (historyCategory !== 'all' && data.category !== historyCategory) return
      setLogs((prev) => [data, ...prev].slice(0, 200))
    }
    window.addEventListener('bridge:log', handler)
    return () => window.removeEventListener('bridge:log', handler)
  }, [paused, historyCategory])

  const fetchBridgeLogs = useCallback(() => {
    setLogsLoading(true)
    getJson<{ logs: Array<{ id: string; category: string; timestamp: string; data: Record<string, unknown> }> }>(
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
      .catch((err) => {
        console.error('Failed to load bridge logs:', err)
        error('Failed to load Bridge logs; check the console or refresh.')
      })
      .finally(() => setLogsLoading(false))
  }, [historyHours, historyCategory])

  useEffect(() => {
    fetchBridgeLogs()
  }, [fetchBridgeLogs])

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
    } catch (err) {
      console.error('Failed to reassign range:', err)
    }
  }

  const handleClearFlag = async (rangeName: string) => {
    try {
      await postForm('/range-review-flags', { rangeName })
      success(`Cleared flag for ${rangeName}`)
      load()
    } catch (err) {
      console.error('Failed to clear range flag:', err)
    }
  }

  const handleMoveRange = async (e: React.FormEvent) => {
    e.preventDefault()
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
    } catch (err) {
      console.error('Failed to move range history:', err)
    }
  }

  const handleReconcile = async (mode: 'orders' | 'positions' | 'both', all = false) => {
    if (!all && !reconAccount) return
    if (all && !window.confirm('Reconcile bookkeeping for ALL accounts? This writes journal entries (cancels and breakeven closes) for every stale order/position.')) return
    setReconBusy(true)
    try {
      const res = await postJson('/debugging/reconcile-bookkeeping', {
        accountId: all ? '*' : reconAccount,
        mode,
        includeCrypto: reconCrypto,
      })
      const result = (await res.json()) as Record<string, unknown>
      setReconResult(result)
      success(
        `Reconciled: ${result.ordersCancelled} order(s) cancelled, ${result.positionsClosed} position(s) closed`,
      )
      load()
    } catch (err) {
      console.error('Failed to reconcile bookkeeping:', err)
      error('Reconcile failed')
    } finally {
      setReconBusy(false)
    }
  }

  const handleReconcilePreviousDays = async () => {
    if (!window.confirm('Reconcile open trades from previous days? This writes breakeven/erroneous closes only for bracket_monitor rows whose last event was before the current journal day (i.e. before today\'s trading session).')) return
    setReconYesterdayBusy(true)
    try {
      const res = await postJson('/debugging/reconcile-previous-days', {})
      const result = (await res.json()) as Record<string, unknown>
      setReconYesterdayResult(result)
      success(
        `Reconciled open trades from previous days: ${result.filledClosed} filled closed, ${result.armedCancelled} armed cancelled`,
      )
      load()
    } catch (err) {
      console.error('Failed to reconcile open trades from previous days:', err)
      error('Reconcile open trades from previous days failed')
    } finally {
      setReconYesterdayBusy(false)
    }
  }

  const handleClearReapplyOps = async () => {
    if (!window.confirm('Clear the reapply log? Incomplete operations are marked cleared and completed history is dismissed. Bookkeeping only — no broker traffic is sent and armed open-trade rows are left untouched. Confirm only after you have reconciled any outstanding orders at the broker.')) return
    setClearOpsBusy(true)
    try {
      const res = await postJson('/debugging/clear-reapply-operations', { brokerReconciled: true })
      const result = (await res.json()) as { cleared?: number }
      success(`Cleared ${result.cleared ?? 0} reapply operation(s)`)
      load()
    } catch (err) {
      console.error('Failed to clear reapply operations:', err)
      error('Clear reapply operations failed')
    } finally {
      setClearOpsBusy(false)
    }
  }

  const handleReconcileOrder = async (order: BrokerOrder, status: string) => {
    const label = `${order.accountName ?? accountById.get(order.accountId)?.name ?? order.accountId} ${order.rangeName} ${order.action} @ ${order.price ?? order.stopPrice ?? '—'}`
    if (!window.confirm(`Mark ${label} as ${status}? Bookkeeping only — verify the outcome at TradersPost/Tradovate first; no broker traffic is sent.`)) return
    setReconcilingOrderId(order.orderId)
    try {
      const res = await postJson('/debugging/reconcile-broker-order', { orderId: order.orderId, status })
      const result = (await res.json()) as { retiredBrackets?: string[]; error?: string }
      if (!res.ok) throw new Error(result.error ?? 'reconcile failed')
      success(`Marked ${status}${result.retiredBrackets?.length ? `; retired ${result.retiredBrackets.length} armed monitor row(s)` : ''}`)
      load()
    } catch (err) {
      console.error('Failed to reconcile broker order:', err)
      error('Reconcile broker order failed')
    } finally {
      setReconcilingOrderId(null)
    }
  }

  const handleRetireArm = async (order: BrokerOrder) => {
    const label = `${order.accountName ?? accountById.get(order.accountId)?.name ?? order.accountId} ${order.rangeName} ${order.action} @ ${order.price ?? order.stopPrice ?? '—'}`
    if (!window.confirm(`Retire the armed open-trade row covered by ${label}? The order is already ${order.status} — confirm the arm is truly dead at the broker. Bookkeeping only; no broker traffic is sent.`)) return
    setReconcilingOrderId(order.orderId)
    try {
      const res = await postJson('/debugging/reconcile-broker-order', { orderId: order.orderId, retireArm: true })
      const result = (await res.json()) as { retiredBrackets?: string[]; error?: string }
      if (!res.ok) throw new Error(result.error ?? 'reconcile failed')
      success(result.retiredBrackets?.length ? `Retired ${result.retiredBrackets.length} armed monitor row(s)` : 'No armed monitor row covered this order')
      load()
    } catch (err) {
      console.error('Failed to retire arm:', err)
      error('Retire arm failed')
    } finally {
      setReconcilingOrderId(null)
    }
  }

  const handleReprocessLifecycle = async (e: React.FormEvent) => {
    e.preventDefault()
    const range = reprocessRange.trim()
    try {
      const res = await postJson('/debugging/reprocess-lifecycle', {
        ...(range ? { rangeName: range } : {}),
        limit: reprocessLimit,
        runScheduledOnly: reprocessRunScheduledOnly,
      })
      const result = (await res.json()) as Record<string, unknown>
      setReprocessResult(result)
      success(
        `Reprocessed ${result.processed} lifecycle alert${result.processed === 1 ? '' : 's'}`,
      )
      load()
    } catch (err) {
      console.error('Failed to reprocess lifecycle:', err)
    }
  }
  const inspectCtOrder = async (order: BrokerOrder) => {
    setCtStateAccount(order.accountId)
    setCtOrderLookup(order.orderId)
    setCtOrderBusy(true)
    setCtOrderResult(null)
    try {
      const result = await getJson<Record<string, unknown>>(`/debugging/crosstrade-order?accountId=${encodeURIComponent(order.accountId)}&orderId=${encodeURIComponent(order.orderId)}`)
      setCtOrderResult(result)
      if (result.ok === true) {
        success('NT8 order found — see CrossTrade broker state card')
      } else {
        error(String(result.error ?? 'NT8 did not find the order — see CrossTrade broker state card'))
      }
    } catch (err) {
      console.error('CrossTrade order lookup failed:', err)
      error(`Order lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCtOrderBusy(false)
    }
  }

  const renderOrderReconcile = (order: BrokerOrder) => {
    if (!isAdmin) return null
    // CT rows can be checked against live NT8 state via the REST API — the
    // result lands in the "CrossTrade broker state" card.
    const inspect = order.destination === 'crosstrade' ? (
      <Button
        type="button"
        variant="ghost"
        className="px-1 py-0.5 text-xs"
        disabled={ctOrderBusy}
        title="Query NT8 for this order id via the CrossTrade API"
        onClick={() => void inspectCtOrder(order)}
      >
        inspect
      </Button>
    ) : null
    if (['pending', 'uncertain', 'acknowledged'].includes(order.status)) {
      return (
        <span className="flex items-center gap-1">
          {inspect}
          <select
            className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-xs text-slate-300"
            value=""
            disabled={reconcilingOrderId === order.orderId}
            onChange={(e) => { if (e.target.value) void handleReconcileOrder(order, e.target.value) }}
          >
            <option value="">mark…</option>
            <option value="acknowledged">acknowledged</option>
            <option value="filled">filled</option>
            <option value="closed">closed</option>
            <option value="rejected">rejected</option>
            <option value="cancelled">cancelled</option>
          </select>
        </span>
      )
    }
    // Resolved rows need nothing. Terminal entry orders (e.g. an InvalidPrice
    // rejection) can leave an armed open-trade row that nothing will ever
    // fill — the server flags those rows (uncoveredArm) and they get a direct
    // retire button; clean resolved rows show only inspect.
    if (order.uncoveredArm) {
      return (
        <span className="flex items-center gap-1">
          {inspect}
          <Button
            type="button"
            variant="ghost"
            className="px-1 py-0.5 text-xs text-amber-400"
            disabled={reconcilingOrderId === order.orderId}
            title="Terminal dispatch left an armed open-trade row — acknowledge to close the phantom arm"
            onClick={() => void handleRetireArm(order)}
          >
            acknowledge
          </Button>
        </span>
      )
    }
    return inspect
  }
  return (
    <div className="space-y-6 text-slate-100">
      <PageHeader
        title={view === 'monitoring' ? 'Monitoring' : 'd3_bugg1ng_rev13w'}
        subtitle={view === 'monitoring' ? 'Live bridge activity' : 'Admin review'}
        description={view === 'monitoring' ? undefined : 'super l337 h4x0r area'}
        onTitleClick={() => void load()}
      >
        {fetching && <LoadingSpinner size={20} />}
      </PageHeader>

      {view !== 'monitoring' && (
        <div className="grid gap-6 lg:grid-cols-2">
        <div className="order-[1] flex items-center gap-3 lg:col-span-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Account-related</span>
          <div className="h-px flex-1 bg-slate-700" />
        </div>
        <div className="order-[5] flex items-center gap-3 lg:col-span-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Range-related</span>
          <div className="h-px flex-1 bg-slate-700" />
        </div>
        <div className="order-[11] flex items-center gap-3 lg:col-span-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Bookkeeping-related</span>
          <div className="h-px flex-1 bg-slate-700" />
        </div>
        <Card shape="notch" title="Reprocess lifecycle" className="order-[6]">
          <p className="mb-4 text-sm text-slate-400">
            Re-run lifecycle processing for stored alerts that were not recorded for
            the selected range, or for all tracked ranges. Only scheduled will
            respect each route's configured run days.
          </p>
          <form onSubmit={handleReprocessLifecycle} className="grid gap-4 md:grid-cols-5">
            <div className="md:col-span-5">
            <label className="block md:col-span-2">
              <span className="mb-1 block text-xs font-medium text-slate-400">
                Range
              </span>
              <select
                value={reprocessRange}
                onChange={(e) => setReprocessRange(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Select a tracked range</option>
                <option value="*">All tracked ranges</option>
                {trackedRangeNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">
                Limit
              </span>
              <input
                type="number"
                min={1}
                max={10000}
                value={reprocessLimit}
                onChange={(e) => setReprocessLimit(Number(e.target.value))}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 pt-5">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                checked={reprocessRunScheduledOnly}
                onChange={(e) => setReprocessRunScheduledOnly(e.target.checked)}
              />
              <span className="text-sm text-slate-300">
                Run considering scheduled days
              </span>
            </label>
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="primary">
                Reprocess
              </Button>
            </div>
          </form>
          {reprocessResult && (
            <div className="mt-4 rounded-lg border border-slate-600 bg-slate-900 p-3 text-sm text-slate-300">
              <div>Processed: {String(reprocessResult.processed)}</div>
              <div>Created: {String(reprocessResult.created)}</div>
              <div>Trade events: {String(reprocessResult.tradeEvents)}</div>
              <div>Errors: {String(reprocessResult.errors)}</div>
            </div>
          )}
        </Card>

        <Card shape="notch" title="Reconcile bookkeeping" className="order-[12]">
          <p className="mb-4 text-sm text-slate-400">
            Fix stale local bookkeeping for an account: records{' '}
            <code>entry_cancelled</code> for orders the DB still considers open,
            and closes open positions as breakeven (
            <code>exit_filled</code> + <code>trade_closed</code>). No broker
            traffic is sent — this only updates the journal/guards. Matches what
            the EOD scheduler now records automatically.
          </p>
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-400">
                  Account
                </span>
                <select
                  value={reconAccount}
                  onChange={(e) => setReconAccount(e.target.value)}
                  className="w-48 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">Select an account</option>
                  {accounts
                    .filter((a) => !a.deprecated)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="flex items-center gap-2 pb-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                  checked={reconCrypto}
                  onChange={(e) => setReconCrypto(e.target.checked)}
                />
                <span className="text-sm text-slate-300">Include crypto futures</span>
              </label>
              <Button
                type="button"
                variant="ghost"
                disabled={!reconAccount || reconBusy}
                onClick={() => handleReconcile('both')}
              >
                Reconcile
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-slate-700 bg-slate-900/50 p-3">
              <div>
                <span className="block text-sm font-medium text-slate-200">All accounts</span>
                <span className="text-xs text-slate-500">Every non-deprecated account</span>
              </div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-600 focus:ring-indigo-500"
                  checked={reconCrypto}
                  onChange={(e) => setReconCrypto(e.target.checked)}
                />
                <span className="text-sm text-slate-300">Include crypto futures</span>
              </label>
              <Button
                type="button"
                variant="primary"
                disabled={reconBusy}
                onClick={() => handleReconcile('both', true)}
              >
                Reconcile all accounts
              </Button>
            </div>
          </div>
          {reconResult && (
            <div className="mt-4 rounded-lg border border-slate-600 bg-slate-900 p-3 text-sm text-slate-300">
              <div>Orders cancelled: {String(reconResult.ordersCancelled)}</div>
              <div>Positions closed (BE): {String(reconResult.positionsClosed)}</div>
              <div>Crypto skipped: {String(reconResult.skippedCrypto)}</div>
              {Array.isArray(reconResult.details) && reconResult.details.length > 0 && (
                <ul className="mt-2 max-h-40 list-disc overflow-y-auto pl-5 text-xs text-slate-400">
                  {(reconResult.details as string[]).map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>

        <Card shape="notch" title="Reconcile open trades from previous days" className="order-[13]">
          <p className="mb-4 text-sm text-slate-400">
            Close any <code>bracket_monitor</code> row that is still <code>armed</code> or{' '}
            <code>filled</code> but whose last event was before the current journal day (i.e.
            before today's trading session). Filled rows become breakeven{' '}
            <code>trade_closed</code>; armed rows become erroneous <code>trade_closed</code>. No
            broker traffic is sent.
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-slate-700 bg-slate-900/50 p-3">
            <div>
              <span className="block text-sm font-medium text-slate-200">Close stale open</span>
              <span className="text-xs text-slate-500">Only previous days</span>
            </div>
            <Button
              type="button"
              variant="primary"
              disabled={reconYesterdayBusy}
              onClick={handleReconcilePreviousDays}
            >
              Reconcile open trades from previous days
            </Button>
          </div>
          {reconYesterdayResult && (
            <div className="mt-4 rounded-lg border border-slate-600 bg-slate-900 p-3 text-sm text-slate-300">
              <div>Filled closed: {String(reconYesterdayResult.filledClosed)}</div>
              <div>Armed cancelled: {String(reconYesterdayResult.armedCancelled)}</div>
              <div>Skipped: {String(reconYesterdayResult.skipped)}</div>
              <div>Total inspected: {String(reconYesterdayResult.total)}</div>
            </div>
          )}
        </Card>

        <Card shape="notch" title="Unrecognized alerts" className="order-[8]">
          <p className="mb-4 text-sm text-slate-400">
            Normalized incoming names that still are not tracked stay here until
            you reassign them to an existing range.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="py-2 pr-2">Name</th>
                  <th className="py-2 pr-2">Number</th>
                  <th className="py-2 pr-2">Time</th>
                  <th className="py-2">Reassign</th>
                </tr>
              </thead>
              <tbody>
                {untrackedRangeNames.length === 0 && (
                  <tr>
                    <td className="py-3 text-slate-500" colSpan={5}>
                      No untracked range names are waiting for review.
                    </td>
                  </tr>
                )}
                {untrackedRangeNames.map((untracked) => (
                  <tr key={untracked.name}>
                    <td className="py-2 pr-2">{untracked.name}</td>
                    <td className="py-2 pr-2 text-center">{untracked.alertCount}</td>
                    <td className="py-2 pr-2">
                      <JournalDate value={untracked.latestReceivedAt} />
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={reassignTarget[untracked.name] ?? ''}
                          onChange={(e) =>
                            setReassignTarget((prev) => ({
                              ...prev,
                              [untracked.name]: e.target.value,
                            }))
                          }
                          className="max-w-[200px] rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100"
                        >
                          <option value="">Select range</option>
                          {trackedRangeNames.map((name) => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => handleReassign(untracked.name)}
                        >
                          ✓
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card shape="notch" title="TradersPost API Test" className="order-[2]">
          <p className="mb-4 text-sm text-slate-400">
            Send a synthetic test entry for a selected range to one configured TradersPost
            destination. The top and bottom are used as the bracket take-profit and stop-loss.
            Account settings (exact TP/SL, outbound ticker, etc.) are pulled from the account.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (!simRange || !simAccount || simTop === '' || simBottom === '') return
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
              } catch (err) {
                console.error('Failed to send range simulation:', err)
                error('Range simulation failed')
              }
            }}
            className="grid gap-4 md:grid-cols-2"
          >
            <div>
              <label className="block text-xs font-medium text-slate-400">Range</label>
              <select
                value={simRange}
                onChange={(e) => {
                  setSimRange(e.target.value)
                }}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Select a range</option>
                {rangeConfigurations.map((c) => (
                  <option key={c.rangeName} value={c.rangeName}>
                    {c.rangeName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Account</label>
              <select
                value={simAccount}
                onChange={(e) => setSimAccount(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Select an account</option>
                {traderspostDestinations.map((dest) => {
                  const account = accountById.get(dest.accountId)
                  return account && !account.deprecated ? (
                    <option key={dest.accountId} value={dest.accountId}>
                      {account.name}
                    </option>
                  ) : null
                })}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Action</label>
              <select
                value={simAction}
                onChange={(e) => setSimAction(e.target.value as 'buy' | 'sell')}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="buy">Buy (long)</option>
                <option value="sell">Sell (short)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Order type</label>
              <select
                value={simOrderType}
                onChange={(e) => setSimOrderType(e.target.value as string)}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="market">Market</option>
                <option value="limit">Limit</option>
                <option value="stop">Stop</option>
                <option value="stop_limit">Stop limit</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Range top</label>
              <input
                type="number"
                step="any"
                value={simTop}
                onChange={(e) => setSimTop(e.target.value)}
                required
                placeholder="Use a current market price"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-slate-500">
                The upper bound of the range — use an up-to-date live price.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Range bottom</label>
              <input
                type="number"
                step="any"
                value={simBottom}
                onChange={(e) => setSimBottom(e.target.value)}
                required
                placeholder="Use a current market price"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <p className="mt-1 text-[10px] text-slate-500">
                The lower bound of the range — use an up-to-date live price.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Quantity (contracts)</label>
              <input
                type="number"
                step="1"
                min="1"
                value={simQuantity}
                onChange={(e) => setSimQuantity(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">TP value</label>
              <input
                type="number"
                step="0.01"
                value={simTpTicks}
                onChange={(e) => setSimTpTicks(e.target.value)}
                placeholder="e.g. 1.00 for 1x, 99 for 99 ticks"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">SL value</label>
              <input
                type="number"
                step="0.01"
                value={simSlTicks}
                onChange={(e) => setSimSlTicks(e.target.value)}
                placeholder="e.g. 99 for 99 ticks"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">TP style</label>
              <input
                type="text"
                value={simTpStyle}
                onChange={(e) => setSimTpStyle(e.target.value)}
                placeholder="e.g. fixed or multiplier"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">SL style</label>
              <input
                type="text"
                value={simSlStyle}
                onChange={(e) => setSimSlStyle(e.target.value)}
                placeholder="e.g. fixed"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" variant="primary">
                Send simulated request
              </Button>
            </div>
          </form>
          {simResult && (
            <div className="mt-4 rounded-lg border border-slate-600 bg-slate-900 p-3 text-sm text-slate-300">
              <div className="mb-2 font-medium">{String(simResult.rangeName)} · {String(simResult.accountName)}</div>
              {simResult.computed ? (
                <div className="mb-3 rounded border border-slate-700 p-2 text-xs text-slate-400">
                  {(() => {
                    const computed = simResult.computed as Record<string, unknown>
                    return (
                      <>
                        <div>Entry: {String(computed.entryPrice)} · Tick: {String(computed.tickSize)}</div>
                        <div>TP: {String(computed.tpDistance)} ({String(computed.tpPercent)}%)</div>
                        <div>SL: {String(computed.slDistance)} ({String(computed.slPercent)}%)</div>
                      </>
                    )
                  })()}
                </div>
              ) : null}
              <div className="space-y-2">
                {(simResult.outboundPayloads as string[]).map((p, i) => (
                  <details key={i} className="rounded border border-slate-700 p-2">
                    <summary className="cursor-pointer text-xs text-slate-400">
                      Payload {i + 1}
                      {simResult.results && ((simResult.results as { status?: number }[])[i]?.status != null)
                        ? ` · HTTP ${(simResult.results as { status?: number }[])[i].status}`
                        : ''}
                    </summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-slate-300">
                      {p}
                    </pre>
                    {simResult.results && ((simResult.results as { body?: string }[])[i]?.body) ? (
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-slate-400">
                        {String((simResult.results as { body: string }[])[i].body)}
                      </pre>
                    ) : null}
                  </details>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card shape="notch" title="Simulate range arm alerts" className="order-[7]">
          <p className="mb-4 text-sm text-slate-400">
            Sends the real ULTRA arming sequence through the shared proxy pipeline: a buy stop at
            the range top and a sell stop at the bottom, each followed by its entry_armed lifecycle
            event. Instrument, TP/SL distances, and the breakeven strategy stop come from the stored
            range configuration. Dispatches to every account with an enabled route for the range —
            CrossTrade accounts get the converted wire format.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (!armRange || armTop === '' || armBottom === '') return
              setArmBusy(true)
              try {
                const res = await postJson('/debugging/alert-simulation', {
                  rangeName: armRange,
                  top: Number(armTop),
                  bottom: Number(armBottom),
                  quantity: Number(armQuantity) || 1,
                })
                const result = (await res.json()) as Record<string, unknown>
                setArmResult(result)
                if (res.ok) {
                  success(`Arm alerts sent for ${String(result.rangeName)}`)
                } else {
                  error(String(result.error ?? 'Alert simulation failed'))
                }
              } catch (err) {
                console.error('Alert simulation failed:', err)
                error('Alert simulation failed')
              } finally {
                setArmBusy(false)
              }
            }}
            className="grid gap-4 md:grid-cols-2"
          >
            <div>
              <label className="block text-xs font-medium text-slate-400">Range</label>
              <select
                value={armRange}
                onChange={(e) => setArmRange(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Select a range</option>
                {rangeConfigurations.map((c) => (
                  <option key={c.rangeName} value={c.rangeName}>
                    {c.rangeName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Quantity</label>
              <input
                type="number"
                min={1}
                value={armQuantity}
                onChange={(e) => setArmQuantity(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Range top (long entry)</label>
              <input
                type="number"
                step="any"
                value={armTop}
                onChange={(e) => setArmTop(e.target.value)}
                required
                placeholder="Buy stop rests here"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Range bottom (short entry)</label>
              <input
                type="number"
                step="any"
                value={armBottom}
                onChange={(e) => setArmBottom(e.target.value)}
                required
                placeholder="Sell stop rests here"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" variant="primary" disabled={armBusy}>
                {armBusy ? 'Sending…' : 'Send arm alerts (both sides)'}
              </Button>
            </div>
          </form>
          {armResult && (
            <div className="mt-4 rounded-lg border border-slate-600 bg-slate-900 p-3 text-sm text-slate-300">
              <div className="mb-2 font-medium">
                {String(armResult.rangeName)} · {String(armResult.instrument)}
              </div>
              <div className="space-y-2">
                {((armResult.results as Array<{ kind: string; side: string; result: Record<string, unknown> }>) ?? []).map((r, i) => (
                  <details key={i} className="rounded border border-slate-700 p-2">
                    <summary className="cursor-pointer text-xs text-slate-400">
                      {r.side} · {r.kind}
                    </summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-slate-300">
                      {JSON.stringify(r.result, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            </div>
          )}
        </Card>

        <Card shape="notch" title="CrossTrade API test" className="order-[3]">
          <p className="mb-4 text-sm text-slate-400">
            Send a manual order to an account&apos;s configured CrossTrade endpoint — or pick
            the OCO pair action to send both arms of a range (buy stop at the top, sell stop at
            the bottom) sharing one oco_id, so NT8 cancels the loser natively on a fill. The
            request is built as an internal payload and converted with the same mutation used
            for live dispatch — the exact message sent is shown below. Requires a CrossTrade
            webhook URL and secret key on the account config.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              if (!ctAccount || !ctInstrument) return
              if (ctAction === 'both' && (!ctStopPrice || !ctBottomPrice)) return
              if (ctUseTickExits && (ctAction === 'buy' || ctAction === 'sell') && ctOrderType === 'market' && (ctTpTicks || ctSlTicks) && !ctReferencePrice) {
                error('Enter a reference entry price to convert market-order TP/SL ticks to absolute levels.')
                return
              }
              setCtSending(true)
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
                type CtLeg = { success?: boolean; statusCode?: number; nt8?: { state?: string; raw?: string; error?: string } }
                const legs = (result.legs as CtLeg[] | undefined) ?? [result as CtLeg]
                const allAccepted = legs.every((leg) => leg.success === true)
                // A webhook ACK isn't a fill — NT8 can reject asynchronously, so
                // each leg carries a post-send REST probe of the order's NT8 state.
                const nt8Rejected = legs.find((leg) => leg.nt8 && ['rejected', 'cancelled'].includes(String(leg.nt8.state)))
                const nt8Missing = legs.find((leg) => leg.nt8?.state === 'not_found')
                const nt8Unknown = legs.find((leg) => leg.nt8?.state === 'unknown')
                if (!allAccepted) {
                  error(String(result.error ?? result.failureMessage ?? `CrossTrade did not report success (HTTP ${String(result.statusCode ?? '—')})`))
                } else if (nt8Rejected) {
                  error(`CrossTrade accepted, but NT8 rejected the order (${nt8Rejected.nt8?.raw ?? nt8Rejected.nt8?.state})`)
                } else if (nt8Missing) {
                  error('CrossTrade accepted, but the order is not visible at NT8')
                } else if (nt8Unknown) {
                  toast(`CrossTrade accepted — NT8 state unconfirmed (${nt8Unknown.nt8?.error ?? 'no response'})`, 'warning')
                } else if (legs.some((leg) => leg.nt8)) {
                  // Only claim broker confirmation when a leg actually carried
                  // an NT8 probe — cancel/exit sends have no order to verify.
                  success(`CrossTrade accepted${legs.length > 1 ? ' both legs' : ''} · NT8 confirmed · HTTP ${String(result.statusCode ?? legs[0]?.statusCode)}`)
                } else {
                  success(`CrossTrade accepted${legs.length > 1 ? ' both legs' : ''} · HTTP ${String(result.statusCode ?? legs[0]?.statusCode)}`)
                }
              } catch (err) {
                console.error('CrossTrade test failed:', err)
                error('CrossTrade test failed')
              } finally {
                setCtSending(false)
              }
            }}
            className="grid gap-4 md:grid-cols-2"
          >
            <div>
              <label className="block text-xs font-medium text-slate-400">Account</label>
              <select
                value={ctAccount}
                onChange={(e) => setCtAccount(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Select an account</option>
                {traderspostDestinations
                  .filter((dest) => dest.crossTradeWebhookUrl && dest.crossTradeEnabled !== false)
                  .map((dest) => {
                    const account = accountById.get(dest.accountId)
                    return account && !account.deprecated ? (
                      <option key={dest.accountId} value={dest.accountId}>
                        {account.name}
                      </option>
                    ) : null
                  })}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Action</label>
              <select
                value={ctAction}
                onChange={(e) => setCtAction(e.target.value as 'buy' | 'sell' | 'cancel' | 'exit' | 'both')}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="buy">Buy (place)</option>
                <option value="sell">Sell (place)</option>
                <option value="both">OCO pair — buy top / sell bottom</option>
                <option value="cancel">Cancel orders</option>
                <option value="exit">Flatten position</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Instrument</label>
              <input
                type="text"
                value={ctInstrument}
                onChange={(e) => setCtInstrument(e.target.value)}
                required
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Quantity</label>
              <input
                type="number"
                min={1}
                value={ctQuantity}
                onChange={(e) => setCtQuantity(e.target.value)}
                disabled={ctAction === 'cancel'}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
              />
            </div>
            {(ctAction === 'buy' || ctAction === 'sell' || ctAction === 'both') && (
              <>
                {ctAction !== 'both' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-400">Order type</label>
                      <select
                        value={ctOrderType}
                        onChange={(e) => setCtOrderType(e.target.value)}
                        className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="market">Market</option>
                        <option value="limit">Limit</option>
                        <option value="stop">Stop</option>
                        <option value="stop_limit">Stop limit</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-400">Limit price</label>
                      <input
                        type="number"
                        step="any"
                        value={ctLimitPrice}
                        onChange={(e) => setCtLimitPrice(e.target.value)}
                        required={ctOrderType === 'limit' || ctOrderType === 'stop_limit'}
                        className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                  </>
                )}
                  <div className="md:col-span-2 rounded-lg border border-slate-700 p-3">
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-200">
                      <input
                        type="checkbox"
                        checked={ctUseTickExits}
                        onChange={(e) => setCtUseTickExits(e.target.checked)}
                        className="rounded border-slate-600 bg-slate-900"
                      />
                      Convert TP/SL ticks to absolute prices
                    </label>
                    <p className="mt-1 text-xs text-slate-500">
                      Uses the entry reference and instrument tick size. For both-side orders, each side uses its own entry level; market orders need a reference price.
                    </p>
                  </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400">
                    {ctAction === 'both' ? 'Range top (buy stop)' : 'Stop price'}
                  </label>
                  <input
                    type="number"
                    step="any"
                    value={ctStopPrice}
                    onChange={(e) => setCtStopPrice(e.target.value)}
                    required={ctAction === 'both' || ctOrderType === 'stop' || ctOrderType === 'stop_limit'}
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                {ctAction === 'both' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-slate-400">Range bottom (sell stop)</label>
                      <input
                        type="number"
                        step="any"
                        value={ctBottomPrice}
                        onChange={(e) => setCtBottomPrice(e.target.value)}
                        className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-400">{ctUseTickExits ? 'Take profit (ticks → absolute price)' : 'Take profit (ticks, relative to fill)'}</label>
                      <input
                        type="number"
                        min={1}
                        value={ctTpTicks}
                        onChange={(e) => setCtTpTicks(e.target.value)}
                        className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-400">{ctUseTickExits ? 'Stop loss (ticks → absolute price)' : 'Stop loss (ticks, relative to fill)'}</label>
                      <input
                        type="number"
                        min={1}
                        value={ctSlTicks}
                        onChange={(e) => setCtSlTicks(e.target.value)}
                        className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                      />
                    </div>
                  </>
                )}
                {ctAction !== 'both' && (
                  ctUseTickExits ? (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">Take profit (ticks)</label>
                        <input
                          type="number"
                          min={1}
                          value={ctTpTicks}
                          onChange={(e) => setCtTpTicks(e.target.value)}
                          className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">Stop loss (ticks)</label>
                        <input
                          type="number"
                          min={1}
                          value={ctSlTicks}
                          onChange={(e) => setCtSlTicks(e.target.value)}
                          className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                      {ctOrderType === 'market' && (
                        <div>
                          <label className="block text-xs font-medium text-slate-400">Reference entry price (market order)</label>
                          <input
                            type="number"
                            step="any"
                            min={0.000001}
                            value={ctReferencePrice}
                            onChange={(e) => setCtReferencePrice(e.target.value)}
                            required={Boolean(ctTpTicks || ctSlTicks)}
                            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">Take profit price (absolute)</label>
                        <input
                          type="number"
                          step="any"
                          value={ctTakeProfit}
                          onChange={(e) => setCtTakeProfit(e.target.value)}
                          className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-400">Stop loss price (absolute)</label>
                        <input
                          type="number"
                          step="any"
                          value={ctStopLoss}
                          onChange={(e) => setCtStopLoss(e.target.value)}
                          className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                    </>
                  )
                )}
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-400">ATM strategy name (optional)</label>
                  <input
                    type="text"
                    value={ctAtmStrategy}
                    onChange={(e) => setCtAtmStrategy(e.target.value)}
                    placeholder="defaults to the range name"
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    When set, the NT8 ATM template owns the exits; explicit TP/SL prices and tick conversions are omitted from the request.
                  </p>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-400">OCO group id (optional)</label>
                  <input
                    type="text"
                    value={ctOcoId}
                    onChange={(e) => setCtOcoId(e.target.value)}
                    placeholder="auto — unique per test run"
                    className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Orders sharing an oco_id cancel each other on fill. NT8 burns the id after one use, so it derives from the bracket id (the arm pair shares a stem) — each test run gets a fresh group. Set a value only to force a specific group.
                  </p>
                </div>
              </>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-400">Notes (optional)</label>
              <input
                type="text"
                value={ctNotes}
                onChange={(e) => setCtNotes(e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" variant="primary" disabled={ctSending}>
                {ctSending ? 'Sending…' : 'Send to CrossTrade'}
              </Button>
            </div>
          </form>
          {ctResult && (
            <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs">
              {(ctResult.legs as Array<Record<string, unknown>> | undefined) ? (
                <div className="space-y-2">
                  {((ctResult.legs as Array<Record<string, unknown>>) ?? []).map((leg, i) => (
                    <div key={i} className="rounded border border-slate-700 p-2">
                      <div className="mb-2 font-medium">
                        {String(leg.side)} · HTTP {String(leg.statusCode ?? '—')}
                        {leg.success === true
                          ? ' · success'
                          : leg.failureMessage != null
                            ? ` · ${String(leg.failureMessage)}`
                            : ''}
                        {leg.error != null ? ` · ${String(leg.error)}` : ''}
                      </div>
                      <details>
                        <summary className="cursor-pointer text-slate-400">Sent message</summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-slate-300">
                          {JSON.stringify(leg.sent, null, 2)}
                        </pre>
                      </details>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-slate-400">Response body</summary>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-slate-300">
                          {String(leg.responseBody || '(empty)')}
                        </pre>
                      </details>
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="mb-2 font-medium">
                    HTTP {String(ctResult.statusCode ?? '—')}
                    {ctResult.success === true
                      ? ' · success'
                      : ctResult.failureMessage != null
                        ? ` · ${String(ctResult.failureMessage)}`
                        : ''}
                    {ctResult.error != null ? ` · ${String(ctResult.error)}` : ''}
                  </div>
                  <details>
                    <summary className="cursor-pointer text-slate-400">Sent message</summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-slate-300">
                      {JSON.stringify(ctResult.sent, null, 2)}
                    </pre>
                  </details>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-slate-400">Response body</summary>
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-slate-300">
                      {String(ctResult.responseBody || '(empty)')}
                    </pre>
                  </details>
                </>
              )}
            </div>
          )}
        </Card>

        <Card shape="notch" title="CrossTrade broker state" className="order-[4]">
          <p className="mb-4 text-sm text-slate-400">
            Live NT8 state via the CrossTrade REST API — working orders, positions, and a per-order
            lookup that resolves our <code>order_id</code> (the bracket id) straight out of NT8.
            Uses the account's secret key as the Bearer token; NT8 must be running with the add-on connected.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-48">
              <label className="block text-xs font-medium text-slate-400">Account</label>
              <select
                value={ctStateAccount}
                onChange={(e) => { setCtStateAccount(e.target.value); setCtState(null); setCtOrderResult(null) }}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Select an account</option>
                {traderspostDestinations
                  .filter((dest) => dest.crossTradeWebhookUrl && dest.crossTradeEnabled !== false)
                  .map((dest) => {
                    const account = accountById.get(dest.accountId)
                    return account && !account.deprecated ? (
                      <option key={dest.accountId} value={dest.accountId}>
                        {account.name}
                      </option>
                    ) : null
                  })}
              </select>
            </div>
            <Button
              type="button"
              variant="primary"
              disabled={!ctStateAccount || ctStateBusy}
              onClick={async () => {
                setCtStateBusy(true)
                setCtState(null)
                try {
                  const result = await getJson<Record<string, unknown>>(`/debugging/crosstrade-state?accountId=${encodeURIComponent(ctStateAccount)}`)
                  setCtState(result)
                } catch (err) {
                  console.error('CrossTrade state fetch failed:', err)
                  error(`CrossTrade state fetch failed: ${err instanceof Error ? err.message : String(err)}`)
                } finally {
                  setCtStateBusy(false)
                }
              }}
            >
              {ctStateBusy ? 'Fetching…' : 'Fetch live state'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!ctStateAccount || ctReconcileBusy}
              onClick={async () => {
                setCtReconcileBusy(true)
                setCtReconcileResult(null)
                try {
                  const res = await postJson('/debugging/reconcile-crosstrade', { accountId: ctStateAccount })
                  const result = await res.json() as Record<string, unknown>
                  setCtReconcileResult(result)
                  const outcomes = (result.outcomes as Array<{ outcome?: string }> | undefined) ?? []
                  const resolved = outcomes.filter((o) => o.outcome !== 'unknown' && o.outcome !== 'in_flight').length
                  success(`Probed ${String(result.probed)} unresolved dispatch(es) — ${resolved} resolved by NT8 evidence`)
                } catch (err) {
                  console.error('CrossTrade reconcile failed:', err)
                  error(`Reconcile failed: ${err instanceof Error ? err.message : String(err)}`)
                } finally {
                  setCtReconcileBusy(false)
                }
              }}
            >
              {ctReconcileBusy ? 'Reconciling…' : 'Reconcile local rows'}
            </Button>
            <div className="flex min-w-56 items-end gap-2">
              <input
                type="text"
                value={ctOrderLookup}
                onChange={(e) => setCtOrderLookup(e.target.value)}
                placeholder="order_id / bracket id"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <Button
                type="button"
                variant="ghost"
                disabled={!ctStateAccount || !ctOrderLookup.trim() || ctOrderBusy}
                onClick={async () => {
                  setCtOrderBusy(true)
                  setCtOrderResult(null)
                  try {
                    const result = await getJson<Record<string, unknown>>(`/debugging/crosstrade-order?accountId=${encodeURIComponent(ctStateAccount)}&orderId=${encodeURIComponent(ctOrderLookup.trim())}`)
                    setCtOrderResult(result)
                  } catch (err) {
                    console.error('CrossTrade order lookup failed:', err)
                    error(`Order lookup failed: ${err instanceof Error ? err.message : String(err)}`)
                  } finally {
                    setCtOrderBusy(false)
                  }
                }}
              >
                {ctOrderBusy ? '…' : 'Lookup order'}
              </Button>
            </div>
          </div>
          {ctOrderResult && (
            <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs">
              <div className="mb-1 font-medium text-slate-200">
                Order lookup — HTTP {String(ctOrderResult.statusCode ?? '—')}
                {ctOrderResult.ok === true ? ' · found' : ` · ${String(ctOrderResult.error ?? 'not found')}`}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-slate-300">
                {JSON.stringify(ctOrderResult.data ?? ctOrderResult, null, 2)}
              </pre>
            </div>
          )}
          {ctReconcileResult && (
            <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs">
              <div className="mb-1 font-medium text-slate-200">Reconcile from broker — per-dispatch outcome</div>
              <pre className="overflow-x-auto whitespace-pre-wrap text-slate-300">
                {JSON.stringify(ctReconcileResult.outcomes ?? ctReconcileResult, null, 2)}
              </pre>
            </div>
          )}
          {ctState && (
            <div className="mt-4 space-y-4 text-xs">
              {(() => {
                const orders = ctState.orders as { ok?: boolean; error?: string; orders?: Array<Record<string, unknown>> } | undefined
                const positions = ctState.positions as { ok?: boolean; error?: string; positions?: Array<Record<string, unknown>> } | undefined
                const atmTemplates = ctState.atmTemplates as { ok?: boolean; error?: string; templates?: string[] } | undefined
                const atmPreflight = ctState.atmPreflight as { required?: string[]; missing?: string[] } | undefined
                const local = ctState.local as { openOrders?: BrokerOrder[]; monitorRows?: Array<Record<string, unknown>> } | undefined
                return (
                  <>
                    <div>
                      <div className="mb-2 font-medium text-slate-200">
                        NT8 working orders — {orders?.ok ? `${orders.orders?.length ?? 0} order(s)` : `unavailable: ${orders?.error ?? 'unknown error'}`}
                      </div>
                      {(orders?.orders?.length ?? 0) > 0 && (
                        <div className="overflow-x-auto rounded-lg border border-slate-700">
                          <table className="w-full text-left">
                            <thead className="bg-slate-800 uppercase tracking-wide text-slate-400">
                              <tr>
                                <th className="px-3 py-1.5">Instrument</th>
                                <th className="px-3 py-1.5">Action</th>
                                <th className="px-3 py-1.5">Type</th>
                                <th className="px-3 py-1.5">State</th>
                                <th className="px-3 py-1.5 text-right">Qty</th>
                                <th className="px-3 py-1.5 text-right">Stop</th>
                                <th className="px-3 py-1.5 text-right">Limit</th>
                                <th className="px-3 py-1.5">OCO</th>
                                <th className="px-3 py-1.5">Strategy</th>
                                <th className="px-3 py-1.5">Order id</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {orders!.orders!.map((o, i) => (
                                <tr key={String(o.id ?? i)} className="text-slate-300">
                                  <td className="px-3 py-1.5">{String(o.instrument ?? '—')}</td>
                                  <td className="px-3 py-1.5">{String(o.orderAction ?? '—')}</td>
                                  <td className="px-3 py-1.5">{String(o.orderType ?? '—')}</td>
                                  <td className="px-3 py-1.5">{String(o.orderState ?? '—')}</td>
                                  <td className="px-3 py-1.5 text-right">{String(o.quantity ?? '—')}</td>
                                  <td className="px-3 py-1.5 text-right">{o.stopPrice ? String(o.stopPrice) : '—'}</td>
                                  <td className="px-3 py-1.5 text-right">{o.limitPrice ? String(o.limitPrice) : '—'}</td>
                                  <td className="px-3 py-1.5">{o.ocoId ? String(o.ocoId) : '—'}</td>
                                  <td className="px-3 py-1.5">{String((o.ownerStrategy as Record<string, unknown> | undefined)?.displayName ?? (o.ownerStrategy as Record<string, unknown> | undefined)?.name ?? '—')}</td>
                                  <td className="max-w-[160px] truncate px-3 py-1.5" title={String(o.id ?? '')}>{String(o.id ?? '—')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="mb-2 font-medium text-slate-200">
                        NT8 positions — {positions?.ok ? `${positions.positions?.length ?? 0} position(s)` : `unavailable: ${positions?.error ?? 'unknown error'}`}
                      </div>
                      {(positions?.positions?.length ?? 0) > 0 && (
                        <div className="overflow-x-auto rounded-lg border border-slate-700">
                          <table className="w-full text-left">
                            <thead className="bg-slate-800 uppercase tracking-wide text-slate-400">
                              <tr>
                                <th className="px-3 py-1.5">Instrument</th>
                                <th className="px-3 py-1.5">Position</th>
                                <th className="px-3 py-1.5 text-right">Qty</th>
                                <th className="px-3 py-1.5 text-right">Avg price</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {positions!.positions!.map((p, i) => (
                                <tr key={String(p.instrument ?? i)} className="text-slate-300">
                                  <td className="px-3 py-1.5">{String(p.instrument ?? '—')}</td>
                                  <td className="px-3 py-1.5">{String(p.marketPosition ?? '—')}</td>
                                  <td className="px-3 py-1.5 text-right">{String(p.quantity ?? '—')}</td>
                                  <td className="px-3 py-1.5 text-right">{String(p.averagePrice ?? '—')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="mb-2 font-medium text-slate-200">
                        NT8 ATM templates — {atmTemplates?.ok
                          ? `${atmTemplates.templates?.length ?? 0} saved · ${(atmPreflight?.required?.length ?? 0) - (atmPreflight?.missing?.length ?? 0)}/${atmPreflight?.required?.length ?? 0} required present`
                          : `unavailable: ${atmTemplates?.error ?? 'unknown error'}`}
                      </div>
                      {(atmPreflight?.missing?.length ?? 0) > 0 && (
                        <div className="mb-2 rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-amber-200">
                          Missing break-even template{atmPreflight!.missing!.length === 1 ? '' : 's'} — entries for {atmPreflight!.missing!.join(', ')} will reject until the named NT8 ATM template exists.
                        </div>
                      )}
                      {(atmTemplates?.templates?.length ?? 0) > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {atmTemplates!.templates!.map((name) => (
                            <span
                              key={name}
                              className={`rounded px-2 py-0.5 ${(atmPreflight?.required ?? []).includes(name) && !(atmPreflight?.missing ?? []).includes(name) ? 'bg-emerald-900/60 text-emerald-200' : 'bg-slate-800 text-slate-400'}`}
                            >
                              {name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="mb-2 font-medium text-slate-200">
                        Local bookkeeping — {(local?.openOrders?.length ?? 0)} unresolved CT dispatch(es), {(local?.monitorRows?.length ?? 0)} active bracket(s)
                      </div>
                      {(local?.openOrders?.length ?? 0) > 0 && (
                        <ul className="list-inside list-disc text-slate-400">
                          {local!.openOrders!.map((o) => (
                            <li key={o.id}>
                              {o.rangeName} · {o.action}{o.side ? ` ${o.side}` : ''} · {o.status}
                              <span className="text-slate-500"> · {o.orderId}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {(local?.monitorRows?.length ?? 0) > 0 && (
                        <ul className="mt-1 list-inside list-disc text-slate-400">
                          {local!.monitorRows!.map((m) => (
                            <li key={String(m.bracketId ?? m.bracket_id)}>
                              {String(m.rangeName ?? m.range_name)} · {String(m.side ?? '—')} · {String(m.state)}
                              <span className="text-slate-500"> · {String(m.bracketId ?? m.bracket_id)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </>
                )
              })()}
            </div>
          )}
        </Card>

        <Card shape="notch" title="Excluded trade records" className="order-[14]">
          <p className="mb-4 text-sm text-slate-400">
            These closed trades stay visible for review, but they no longer affect
            journal, account, or range performance.
          </p>
          <div className="max-h-96 overflow-x-auto overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="py-2 pr-2">Date</th>
                  <th className="py-2 pr-2">Account</th>
                  <th className="py-2 pr-2">Range</th>
                  <th className="py-2 pr-2">Reason</th>
                  <th className="py-2">P&L</th>
                </tr>
              </thead>
              <tbody>
                {filteredExclusions.length === 0 && (
                  <tr>
                    <td className="py-3 text-slate-500" colSpan={7}>
                      No excluded trade records.
                    </td>
                  </tr>
                )}
                {filteredExclusions.map((t) => {
                  const account = accountById.get(t.accountId)
                  return (
                    <tr key={t.id} className="border-t border-slate-700/50">
                      <td className="py-2 pr-2">
                        <JournalDate value={t.occurredAt} />
                      </td>
                      <td className="py-2 pr-2">
                        {account?.name ?? t.accountId}
                      </td>
                      <td className="py-2 pr-2">{t.rangeName}</td>
                      <td className="py-2 pr-2">
                        {t.exclusionReason
                          ? reasonLabels[t.exclusionReason] ?? t.exclusionReason
                          : '—'}
                      </td>
                      <td className="py-2">
                        {formatPnl(t.realizedDollarsCents ?? 0)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card shape="notch" title="Globally flagged ranges" className="order-[9]">
          <p className="mb-4 text-sm text-slate-400">
            Test data ranges are removed from account performance. Erroneous ranges
            are also blocked from extension and TradersPost routing until the flag
            is cleared.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="py-2 pr-2">Range</th>
                  <th className="py-2 pr-2">Reason</th>
                  <th className="py-2 pr-2">Flagged by</th>
                  <th className="py-2">Action</th>
                </tr>
              </thead>
              <tbody>
                {flaggedRanges.length === 0 && (
                  <tr>
                    <td className="py-3 text-slate-500" colSpan={4}>
                      No ranges are currently flagged.
                    </td>
                  </tr>
                )}
                {flaggedRanges.map((flag) => (
                  <tr key={flag.rangeName} className="border-t border-slate-700/50">
                    <td className="py-2 pr-2">{flag.rangeName}</td>
                    <td className="py-2 pr-2">
                      {reasonLabels[flag.reason] ?? flag.reason}
                    </td>
                    <td className="py-2 pr-2">{flag.flaggedByEmail}</td>
                    <td className="py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => handleClearFlag(flag.rangeName)}
                      >
                        Clear
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card shape="notch" title="Range history move" className="order-[10]">
          <p className="mb-4 text-sm text-slate-400">
            Move all alert and lifecycle history from one tracked range name to
            another. This is a destructive admin action and cannot be undone.
          </p>
          <form onSubmit={handleMoveRange} className="grid gap-4 md:grid-cols-3">
            <Input
              label="Source range"
              value={moveSource}
              onChange={(e) => setMoveSource(e.target.value)}
              placeholder="Old range name"
              required
              maxLength={256}
            />
            <Input
              label="Target range"
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              placeholder="New range name"
              required
              maxLength={256}
            />
            <div className="flex items-end">
              <Button type="submit" variant="primary">
                Move history
              </Button>
            </div>
          </form>
        </Card>

      </div>
      )}

      {view === 'monitoring' && (
        <div className="grid gap-6 lg:grid-cols-2">
        <CollapsibleSection
          className="rounded-xl border border-slate-700 bg-slate-900 lg:col-span-2"
          storageKey="monitoring:bridgeLog:open"
          title={<h3 className="text-lg font-semibold text-slate-100">Server logs</h3>}
          actions={<Button type="button" variant="ghost" className="px-2 py-1" onClick={() => { setSpinBridge(true); setTimeout(() => setSpinBridge(false), 1000); fetchBridgeLogs() }} disabled={logsLoading}><span className={(logsLoading || spinBridge) ? 'inline-block animate-spin' : ''}>↻</span></Button>}
        >
          <div className="mb-3 flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400">Hours</label>
              <select
                value={historyHours}
                onChange={(e) => setHistoryHours(Number(e.target.value))}
                className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value={1}>1 hour</option>
                <option value={4}>4 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400">Category</label>
              <select
                value={historyCategory}
                onChange={(e) => setHistoryCategory(e.target.value as typeof historyCategory)}
                className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="all">All</option>
                <option value="traderspost">TradersPost</option>
                <option value="routing">Routing</option>
                <option value="lifecycle">Lifecycle</option>
              </select>
            </div>
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant={paused ? 'primary' : 'ghost'}
                onClick={() => setPaused(!paused)}
              >
                {paused ? 'Resume' : 'Pause'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setLogs([])}
              >
                Clear
              </Button>
            </div>
          </div>
          {logs.length === 0 ? (
            <p className="text-sm text-slate-400">No Bridge activity in the selected window.</p>
          ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900/50 p-2 text-xs">
            {logs.map((log, idx) => {
              const category = String(log.category ?? 'unknown')
              const phase = String(log.phase ?? '')
              const success = log.success === true
              const isTraderspostResponse = category === 'traderspost' && phase === 'response'
              const isError = isTraderspostResponse && !success
              const badge = (() => {
                if (category === 'traderspost' && phase === 'request') {
                  return { text: 'REQ', class: 'bg-blue-600/30 text-blue-100' }
                }
                if (category === 'traderspost' && success) {
                  return { text: 'OK', class: 'bg-positive-600/30 text-positive-100' }
                }
                if (category === 'traderspost') {
                  return { text: 'ERR', class: 'bg-negative-600/30 text-negative-100' }
                }
                if (category === 'routing') {
                  return { text: 'ROUTE', class: 'bg-indigo-600/30 text-indigo-100' }
                }
                if (category === 'lifecycle') {
                  return { text: 'LIFE', class: 'bg-teal-600/30 text-teal-100' }
                }
                if (category === 'reapply') {
                  return { text: 'REAP', class: 'bg-amber-600/30 text-amber-100' }
                }
                if (category === 'email') {
                  return { text: 'MAIL', class: 'bg-negative-600/30 text-negative-100' }
                }
                return { text: category.toUpperCase().slice(0, 4), class: 'bg-slate-600/30 text-slate-100' }
              })()
              const summary = (() => {
                if (category === 'traderspost') {
                  const payload = log.payload as Record<string, unknown> | undefined
                  const action = payload?.action ?? '-'
                  const ticker = payload?.ticker ?? '-'
                  const quantity = payload?.quantity ?? '-'
                  const statusCode = log.statusCode as number | undefined
                  if (phase === 'request') {
                    return `${action} ${ticker} ×${quantity}`
                  }
                  return `${action} ${ticker} → HTTP ${statusCode ?? '-'}`
                }
                if (category === 'routing') {
                  const action = log.action ?? '-'
                  const ticker = log.ticker ?? '-'
                  const status = log.status ?? '-'
                  const accountName = log.accountName ?? '-'
                  return `${action} ${ticker} → ${status} (${accountName})`
                }
                if (category === 'lifecycle') {
                  const eventType = log.eventType ?? '-'
                  const ticker = log.ticker ?? '-'
                  const rangeName = log.rangeName ?? '-'
                  const outcome = log.outcome ?? ''
                  return `${eventType} ${ticker} ${outcome ? `· ${outcome}` : ''} (${rangeName})`
                }
                if (category === 'reapply') {
                  return String(log.message ?? 'Reapply event')
                }
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
                  const range =
                    (payload?.extras as Record<string, unknown> | undefined)?.rangeName ??
                    log.rangeName ??
                    '-'
                  const source = log.source ?? '-'
                  const accountName = log.accountName ?? '-'
                  return `${source} · ${range} · ${accountName}`
                }
                if (category === 'routing') {
                  const rangeName = log.rangeName ?? '-'
                  const suppressed = log.suppressed === true ? 'suppressed' : 'routed'
                  return `${rangeName} · ${suppressed}`
                }
                if (category === 'lifecycle') {
                  const side = log.side ?? '-'
                  const quantity = log.quantity ?? '-'
                  const recorded = log.recorded === true ? 'recorded' : 'ignored'
                  return `${side} · ×${quantity} · ${recorded}`
                }
                return ''
              })()
              return (
                <div
                  key={String(log.id ?? idx)}
                  className={`rounded border p-2 ${
                    category === 'traderspost' && phase === 'request'
                      ? 'border-blue-600/40 bg-blue-900/20'
                      : isError
                        ? 'border-negative-600/40 bg-negative-900/20'
                        : category === 'traderspost'
                          ? 'border-positive-600/40 bg-positive-900/20'
                          : category === 'routing'
                            ? 'border-indigo-600/40 bg-indigo-900/20'
                            : category === 'lifecycle'
                              ? 'border-teal-600/40 bg-teal-900/20'
                              : 'border-slate-600/40 bg-slate-900/20'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 font-mono text-slate-200">
                    <span className="text-slate-400">
                      {new Date(String(log.timestamp)).toLocaleTimeString('en-US', {
                        timeZone: JOURNAL_TIME_ZONE,
                      })}
                    </span>
                    <span className={`rounded px-1.5 py-0.5 font-semibold ${badge.class}`}>
                      {badge.text}
                    </span>
                    <span className="font-bold text-slate-100">{summary}</span>
                    {details && <span className="text-slate-500">{details}</span>}
                  </div>
                  <details className="mt-1">
                    <summary className="cursor-pointer text-slate-500 hover:text-slate-300">
                      Details
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-950 p-2 text-[10px] text-slate-300">
                      {JSON.stringify(log, null, 2)}
                    </pre>
                  </details>
                </div>
              )
            })}
          </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          className="rounded-xl border border-slate-700 bg-slate-900 lg:col-span-2"
          storageKey="monitoring:reapplyOps:open"
          title={<h3 className="text-lg font-semibold text-slate-100">TradersPost Reapply Logs (OCO function)</h3>}
          actions={<div className="flex items-center gap-2">{isAdmin && <Button type="button" variant="ghost" className="px-2 py-1" onClick={handleClearReapplyOps} disabled={clearOpsBusy}>Clear</Button>}<Button type="button" variant="ghost" className="px-2 py-1" onClick={() => { setSpinReapply(true); setTimeout(() => setSpinReapply(false), 1000); load() }} disabled={fetching}><span className={(fetching || spinReapply) ? 'inline-block animate-spin' : ''}>↻</span></Button></div>}
        >
          <div className="mb-3 flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-400">Hours</label>
              <select
                value={reapplyHours}
                onChange={(e) => setReapplyHours(Number(e.target.value))}
                className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value={1}>1 hour</option>
                <option value={4}>4 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
              </select>
            </div>
          </div>
          {visibleReapplyOperations.length === 0 ? (
            <p className="text-sm text-slate-400">No reapply operations in the selected window.</p>
          ) : (
            <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
                    <th className="py-2 pr-4">Time</th>
                    <th className="py-2 pr-4">Account</th>
                    <th className="py-2 pr-4">Instrument</th>
                    <th className="py-2 pr-4">Closed range</th>
                    <th className="py-2 pr-4">Rearmed ranges</th>
                    <th className="py-2 pr-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {visibleReapplyOperations.map((op) => (
                    <tr key={op.id} className="text-slate-200">
                      <td className="py-2 pr-4 whitespace-nowrap"><JournalDate value={op.createdAt} /></td>
                      <td className="py-2 pr-4">{accountById.get(op.accountId)?.name ?? op.accountId}</td>
                      <td className="py-2 pr-4">{op.instrument}</td>
                      <td className="py-2 pr-4">{op.closingRangeName}</td>
                      <td className="py-2 pr-4">{op.rearmedRangeNames.length ? op.rearmedRangeNames.join(', ') : '—'}</td>
                      <td className="py-2 pr-4">{op.completed ? (op.reason ?? 'Completed') : 'Incomplete'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 md:hidden">
              {visibleReapplyOperations.map((op) => (
                <div key={op.id} className="rounded border border-slate-700/60 bg-slate-900/40 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-slate-400"><JournalDate value={op.createdAt} /></span>
                    <span className="font-bold text-slate-100">{op.instrument}</span>
                    <span className="text-slate-400">{accountById.get(op.accountId)?.name ?? op.accountId}</span>
                    <span className={`rounded px-1.5 py-0.5 font-semibold ${op.completed ? 'bg-slate-600/30 text-slate-100' : 'bg-amber-600/30 text-amber-100'}`}>
                      {op.completed ? (op.reason ?? 'Completed') : 'Incomplete'}
                    </span>
                  </div>
                  <div className="mt-1 text-slate-500">
                    closed {op.closingRangeName} · rearmed {op.rearmedRangeNames.length ? op.rearmedRangeNames.join(', ') : '—'}
                  </div>
                </div>
              ))}
            </div>
            </>
          )}
        </CollapsibleSection>

        {brokerOrders.length === 0 ? (
          <p className="rounded-xl border border-slate-800 px-4 py-3 text-sm text-slate-500 lg:col-span-2">
            No broker orders.
          </p>
        ) : (
        <CollapsibleSection
          className="rounded-xl border border-slate-700 bg-slate-900 lg:col-span-2"
          storageKey="monitoring:brokerOrders:open"
          title={<h3 className="text-lg font-semibold text-slate-100">Order attempts and local state</h3>}
          actions={<Button type="button" variant="ghost" className="px-2 py-1" onClick={() => { setSpinReapply(true); setTimeout(() => setSpinReapply(false), 1000); load() }} disabled={fetching}><span className={(fetching || spinReapply) ? 'inline-block animate-spin' : ''}>↻</span></Button>}
        >
            <p className="mb-3 text-xs text-slate-400">Webhook acceptance is not a broker fill or flatten confirmation. Lifecycle and Bridge statuses are local bookkeeping; operator statuses are manually reported. Legacy rows have unknown provenance.</p>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <select
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300"
                value={orderFilter}
                onChange={(e) => { setOrderFilter(e.target.value as 'attention' | 'open' | 'all'); setOrderPage(0) }}
              >
                <option value="attention">Needs attention (pending / uncertain / rejected)</option>
                <option value="open">Open / submitted</option>
                <option value="all">All (latest 200)</option>
              </select>
              <select
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300"
                value={orderHours}
                onChange={(e) => { setOrderHours(Number(e.target.value)); setOrderPage(0) }}
              >
                <option value={0}>All time</option>
                <option value={4}>Last 4 hours</option>
                <option value={12}>Last 12 hours</option>
                <option value={24}>Last 24 hours</option>
                <option value={48}>Last 48 hours</option>
              </select>
              <span className="text-xs text-slate-500">
                {filteredBrokerOrders.length} of {brokerOrders.length} shown
              </span>
              {orderPageCount > 1 && (
                <span className="flex items-center gap-2 text-xs text-slate-400">
                  <Button type="button" variant="ghost" className="px-2 py-0.5" disabled={effectiveOrderPage === 0} onClick={() => setOrderPage(effectiveOrderPage - 1)}>Prev</Button>
                  Page {effectiveOrderPage + 1} of {orderPageCount}
                  <Button type="button" variant="ghost" className="px-2 py-0.5" disabled={effectiveOrderPage >= orderPageCount - 1} onClick={() => setOrderPage(effectiveOrderPage + 1)}>Next</Button>
                </span>
              )}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
                    <th className="py-2 pr-4">Time</th>
                    <th className="py-2 pr-4">Account</th>
                    <th className="py-2 pr-4">Range</th>
                    <th className="py-2 pr-4">Instrument</th>
                    <th className="py-2 pr-4">Dest</th>
                    <th className="py-2 pr-4">Action</th>
                    <th className="py-2 pr-4">Side</th>
                    <th className="py-2 pr-4">Qty</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Order ID</th>
                    <th className="py-2 pr-4">Error</th>
                    {isAdmin && <th className="py-2 pr-4">Reconcile</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {pagedBrokerOrders.length === 0 && (
                    <tr><td colSpan={isAdmin ? 12 : 11} className="py-4 text-center text-slate-500">No orders match this filter.</td></tr>
                  )}
                  {pagedBrokerOrders.map((order) => (
                    <tr key={order.id} className="text-slate-200">
                      <td className="py-2 pr-4 whitespace-nowrap"><JournalDate value={order.createdAt} /></td>
                      <td className="py-2 pr-4">{order.accountName ?? accountById.get(order.accountId)?.name ?? order.accountId}</td>
                      <td className="py-2 pr-4">{order.rangeName}</td>
                      <td className="py-2 pr-4">{order.instrument}</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${order.destination === 'crosstrade' ? 'bg-sky-500/20 text-slate-100' : 'bg-slate-700/50 text-slate-400'}`}>
                          {order.destination === 'crosstrade' ? 'CT' : 'TP'}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{order.action}</td>
                      <td className="py-2 pr-4">{order.side ?? '—'}</td>
                      <td className="py-2 pr-4">{order.quantity ?? '—'}</td>
                      <td className="py-2 pr-4">{order.status}<span className="block text-xs text-slate-400">Source: {order.statusSource ?? 'legacy'} · Dispatch: {order.dispatchStatus ?? 'unknown'}</span></td>
                      <td className="py-2 pr-4 max-w-[120px] truncate" title={order.orderId}>{order.orderId}</td>
                      <td className="py-2 pr-4">{order.errorText ?? '—'}</td>
                      {isAdmin && (
                        <td className="py-2 pr-4">{renderOrderReconcile(order)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 md:hidden">
              {pagedBrokerOrders.length === 0 && (
                <p className="py-4 text-center text-sm text-slate-500">No orders match this filter.</p>
              )}
              {pagedBrokerOrders.map((order) => (
                <div key={order.id} className="rounded border border-slate-700/60 bg-slate-900/40 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-slate-400"><JournalDate value={order.createdAt} /></span>
                    <span className="font-bold text-slate-100">{order.rangeName}</span>
                    <span className="text-slate-400">{order.instrument}</span>
                    <span className="text-slate-400">{order.accountName ?? accountById.get(order.accountId)?.name ?? order.accountId}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="uppercase text-slate-300">
                      {order.action}{order.side ? ` · ${order.side}` : ''}{order.quantity != null ? ` ×${order.quantity}` : ''}
                    </span>
                    <span className="rounded bg-slate-700/50 px-1.5 py-0.5 font-semibold text-slate-100">{order.status}</span>
                    <span className={`rounded px-1.5 py-0.5 font-semibold ${order.destination === 'crosstrade' ? 'bg-sky-500/20 text-slate-100' : 'bg-slate-700/50 text-slate-400'}`}>
                      {order.destination === 'crosstrade' ? 'CT' : 'TP'}
                    </span>
                    <span className="text-slate-500">{order.statusSource ?? 'legacy'} · dispatch {order.dispatchStatus ?? 'unknown'}</span>
                  </div>
                  <div className="mt-1 truncate text-slate-500" title={order.orderId}>{order.orderId}</div>
                  {order.errorText && <div className="mt-1 break-words text-rose-300">{order.errorText}</div>}
                  <div className="mt-2 empty:mt-0">{renderOrderReconcile(order)}</div>
                </div>
              ))}
            </div>
        </CollapsibleSection>
        )}

        {isAdmin && processRuns.length > 0 && (
        <CollapsibleSection
          className="rounded-xl border border-slate-700 bg-slate-900 lg:col-span-2"
          storageKey="monitoring:processRuns:open"
          title={<h3 className="text-lg font-semibold text-slate-100">Server Process Uptime</h3>}
        >
          <p className="mb-3 text-sm text-slate-400">
            One row per server process lifetime. A row with no end and a stale heartbeat means the
            process was killed without running its exit handlers (OOM, host kill) — the last
            heartbeat and memory columns show its final recorded state.
          </p>
          {runsPageCount > 1 && (
            <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
              <Button type="button" variant="ghost" className="px-2 py-0.5" disabled={effectiveRunsPage === 0} onClick={() => setRunsPage(effectiveRunsPage - 1)}>Prev</Button>
              Page {effectiveRunsPage + 1} of {runsPageCount}
              <Button type="button" variant="ghost" className="px-2 py-0.5" disabled={effectiveRunsPage >= runsPageCount - 1} onClick={() => setRunsPage(effectiveRunsPage + 1)}>Next</Button>
            </div>
          )}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs text-slate-400">
                  <th className="py-2 pr-4">Started</th>
                  <th className="py-2 pr-4">Ended</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Last heartbeat</th>
                  <th className="py-2 pr-4">RSS</th>
                  <th className="py-2 pr-4">Heap</th>
                  <th className="py-2 pr-4">Loop lag</th>
                  <th className="py-2 pr-4">PID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {pagedProcessRuns.map((run) => {
                  const status = processRunStatus(run)
                  return (
                    <tr key={run.id} className={status.tone === 'bad' ? 'text-red-300' : 'text-slate-200'}>
                      <td className="py-2 pr-4 whitespace-nowrap"><JournalDate value={run.startedAt} /></td>
                      <td className="py-2 pr-4 whitespace-nowrap">{run.endedAt ? formatJournalDate(run.endedAt) : '—'}</td>
                      <td className="py-2 pr-4">
                        {status.label}
                        {run.fatal?.message && (
                          <div className="max-w-[320px] truncate text-xs text-red-400" title={run.fatal.stack ?? run.fatal.message}>
                            {run.fatal.name}: {run.fatal.message}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">{run.lastHeartbeatAt ? formatJournalDate(run.lastHeartbeatAt) : '—'}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatMb(run.rssBytes)}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatMb(run.heapUsedBytes)}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{run.eventLoopLagMs !== undefined ? `${run.eventLoopLagMs} ms` : '—'}</td>
                      <td className="py-2 pr-4">{run.pid}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 md:hidden">
            {pagedProcessRuns.map((run) => {
              const status = processRunStatus(run)
              return (
                <div
                  key={run.id}
                  className={`rounded border p-2 text-xs ${status.tone === 'bad' ? 'border-red-700/50 bg-red-900/10 text-red-300' : 'border-slate-700/60 bg-slate-900/40 text-slate-200'}`}
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-bold">{status.label}</span>
                    <span className="text-slate-400">pid {run.pid}</span>
                    <span className="text-slate-400">started <JournalDate value={run.startedAt} /></span>
                  </div>
                  {run.fatal?.message && (
                    <div className="mt-1 break-words text-red-400">{run.fatal.name}: {run.fatal.message}</div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-slate-500">
                    <span>ended {run.endedAt ? formatJournalDate(run.endedAt) : '—'}</span>
                    <span>beat {run.lastHeartbeatAt ? formatJournalDate(run.lastHeartbeatAt) : '—'}</span>
                    <span>rss {formatMb(run.rssBytes)}</span>
                    <span>heap {formatMb(run.heapUsedBytes)}</span>
                    <span>lag {run.eventLoopLagMs !== undefined ? `${run.eventLoopLagMs} ms` : '—'}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </CollapsibleSection>
        )}

        <EmailIngestCard />

        {openTradeSanity.length === 0 ? (
          <p className="rounded-xl border border-slate-800 px-4 py-3 text-sm text-slate-500 lg:col-span-2">
            No open brackets.
          </p>
        ) : (
        <CollapsibleSection
          className="rounded-xl border border-slate-700 bg-slate-900 lg:col-span-2"
          storageKey="monitoring:openTradeSanity:open"
          title={<h3 className="text-lg font-semibold text-slate-100">Open Trade Sanity</h3>}
          actions={<Button type="button" variant="ghost" className="px-2 py-1" onClick={() => { setSpinReapply(true); setTimeout(() => setSpinReapply(false), 1000); load() }} disabled={fetching}><span className={(fetching || spinReapply) ? 'inline-block animate-spin' : ''}>↻</span></Button>}
        >
          <p className="mb-3 text-sm text-slate-400">
            Where each open bracket came from. A red row means a Pine alert is missing its journal record, or the bracket has no dispatch / a failed TradersPost delivery.
          </p>
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <Input
              label="Filter"
              type="text"
              value={sanityFilterText}
              onChange={(e) => setSanityFilterText(e.target.value)}
              placeholder="range / instrument / account / side"
            />
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-600"
                checked={sanityOnlyProblems}
                onChange={(e) => setSanityOnlyProblems(e.target.checked)}
              />
              Only problems
            </label>
          </div>
          {filteredSanity.length === 0 ? (
            <p className="text-sm text-slate-500">No open brackets match the current filters.</p>
          ) : (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {filteredSanity.map(({ row, hasProblem, displayState, isOffSchedule, isReapply, isMissingEvent, brokerRejected, brokerUncertain, source }) => (
                <div
                  key={`${row.accountId}-${row.rangeName}-${row.bracketId}-${row.side}`}
                  className={`rounded border p-2 text-xs ${
                    hasProblem
                      ? 'border-rose-600/40 bg-rose-900/20'
                      : 'border-slate-600/40 bg-slate-900/20'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 font-mono text-slate-200">
                    <img
                      src={tradingViewInstrumentIconUrl(row.instrument)}
                      alt={row.instrument}
                      className="h-5 w-5 flex-none rounded-full bg-slate-700 p-0.5"
                    />
                    <span className="font-bold text-slate-100">{row.rangeName}</span>
                    <span className="text-slate-400">{row.instrument}</span>
                    <span className="text-slate-400">{row.accountName}</span>
                    <span className="uppercase text-slate-300">{row.side}</span>
                    <span className="text-slate-400">×{row.quantity}</span>
                    <span className={`rounded px-1.5 py-0.5 font-semibold ${
                      brokerRejected
                        ? 'bg-rose-600/30 text-rose-100'
                        : brokerUncertain
                          ? 'bg-orange-600/30 text-orange-100'
                          : isOffSchedule || isMissingEvent
                            ? 'bg-slate-600/30 text-slate-100'
                            : isReapply
                              ? 'bg-blue-600/30 text-blue-100'
                              : row.state === 'filled'
                                ? 'bg-emerald-600/30 text-emerald-100'
                                : 'bg-amber-600/30 text-amber-100'
                    }`}>
                      {displayState}
                    </span>
                    {row.oppositeSideExists && (
                      <span className="rounded bg-slate-600/30 px-1.5 py-0.5 text-slate-100">
                        opposite {row.oppositeSideState ?? 'unknown'}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 text-slate-500">
                    <span>
                      event:{' '}
                      {row.hasTradeEvent
                        ? row.tradeEventType ?? 'yes'
                        : isReapply
                          ? 'bridge reapply'
                          : source === 'reconcile'
                            ? 'manual reconcile'
                            : row.hasLifecycleAlert
                              ? 'arrived but not journaled'
                              : 'none'}
                    </span>
                    <span>
                      dispatch: {row.hasDispatchAlert ? (row.deliveryStatus ?? 'pending') : 'missing'}
                    </span>
                    {row.brokerOrderStatus && (
                      <span
                        className={
                          row.brokerOrderStatus === 'rejected' || row.brokerOrderStatus === 'uncertain'
                            ? 'text-rose-300'
                            : undefined
                        }
                        title={row.brokerOrderErrorText ?? undefined}
                      >
                        broker: {row.brokerOrderStatus}
                      </span>
                    )}
                    <span>TP: {row.routeTraderspostEnabled ? 'on' : 'off'}</span>
                    <span>Ext: {row.routeExtensionEnabled ? 'on' : 'off'}</span>
                    <span>scheduled: {row.routeRunScheduled ? (row.isScheduledDay ? 'yes' : 'no') : 'n/a'}</span>
                    <span><JournalDate value={row.lastOccurredAt} /></span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>
        )}

      </div>
      )}
    </div>
  )
}
