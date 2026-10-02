import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from './Card'
import { CollapsibleSection } from './CollapsibleSection'
import { LoadingSpinner } from './LoadingSpinner'
import { RangeDetailCard } from './RangeDetailCard'
import { getJson, postForm, postJson } from '../api/client'
import { useToast } from '../context/ToastContext'
import type {
  BrokerOrder,
  JournalMetrics,
  RangeConfiguration,
  RangeSubcategory,
  SharedRangeDetail,
} from '../types'
import { JournalDate } from '../components/JournalDate'

interface RangeAlert {
  alertId: string
  receivedAt: string
  action: 'buy' | 'sell' | 'cancel' | 'exit'
  ticker: string
  payloadJson: string
}

interface RangeAccount {
  accountId: string
  accountName: string
  destinationEnabled: boolean
  crossTrade?: boolean
}

interface RangeDetail {
  rangeName: string
  instrument: string | null
  configuration: RangeConfiguration | null
  rangeDetail: SharedRangeDetail | null
  subcategories: RangeSubcategory[]
  modelNames?: string[]
  modelName: string | null
  latestTop: number | null
  latestTopAt: string | null
  latestBottom: number | null
  latestBottomAt: string | null
  latestQuantity: number | null
  alerts: RangeAlert[]
  dispatches: BrokerOrder[]
  accounts: RangeAccount[]
  subscriptions: Array<{
    accountId: string
    accountName: string
    traderspostEnabled: boolean
    extensionEnabled: boolean
    runScheduled: boolean
    crossTrade?: boolean
  }>
}

interface SimAccountResult {
  accountId: string
  accountName?: string
  destination?: 'crosstrade' | 'traderspost'
  action?: 'buy' | 'sell'
  status?: number
  error?: string
  outboundPayloads?: string[]
  results?: Array<{ status?: number; body?: string; error?: string }>
  computed?: { entryPrice: number; tickSize: number; tpDistance?: number; slDistance?: number; tpPercent?: number; slPercent?: number }
}

const STATUS_STYLES: Record<string, string> = {
  acknowledged: 'bg-slate-700 text-slate-200',
  pending: 'bg-amber-900/60 text-amber-200',
  uncertain: 'bg-amber-900/60 text-amber-200',
  rejected: 'bg-negative-900 text-negative-100',
  filled: 'bg-positive-900 text-positive-100',
  closed: 'bg-slate-800 text-slate-400',
  cancelled: 'bg-slate-800 text-slate-400',
}

const TIME_FILTERS = [
  { key: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'All', ms: null as number | null },
] as const

function withinWindow(iso: string, ms: number | null): boolean {
  if (ms == null) return true
  const t = Date.parse(iso)
  return Number.isFinite(t) && Date.now() - t <= ms
}

function ageLabel(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m old`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h old`
  return `${Math.floor(hours / 24)}d old`
}

function parseCentsFromDisplay(value: string): number | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  const scaled = Number(normalized) * 100
  if (!Number.isFinite(scaled)) return undefined
  const rounded = Math.round(scaled)
  return Number.isSafeInteger(rounded) ? rounded : undefined
}

const EMPTY_METRICS: JournalMetrics = {
  realizedDollarsCents: 0,
  netTicksCents: 0,
  closedCount: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  winRate: null,
  averageWinDollarsCents: null,
  averageLossDollarsCents: null,
  averageWinTicksCents: null,
  averageLossTicksCents: null,
}

const inputCls =
  'w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none'

type RangeDetailSectionKey = 'settings' | 'simulation' | 'alerts' | 'dispatches' | 'ct-dispatches'

export function RangeDetailSections({
  rangeName,
  sections,
}: {
  rangeName: string
  /** When set, only these panels render — lets a page place panels in separate slots. */
  sections?: RangeDetailSectionKey[]
}) {
  const show = (key: RangeDetailSectionKey) => !sections || sections.includes(key)
  const [detail, setDetail] = useState<RangeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const { success, error } = useToast()
  const navigate = useNavigate()

  const [simAccount, setSimAccount] = useState('all')
  const [simAction, setSimAction] = useState<'buy' | 'sell' | 'both'>('buy')
  const [simOrderType, setSimOrderType] = useState('stop')
  const [simTop, setSimTop] = useState<number | ''>('')
  const [simBottom, setSimBottom] = useState<number | ''>('')
  const [simQuantity, setSimQuantity] = useState<number | ''>(1)
  const [simTpTicks, setSimTpTicks] = useState('')
  const [simSlTicks, setSimSlTicks] = useState('')
  const [simTpStyle, setSimTpStyle] = useState('')
  const [simSlStyle, setSimSlStyle] = useState('')
  const [sending, setSending] = useState(false)
  const [simResults, setSimResults] = useState<SimAccountResult[] | null>(null)

  const [alertWindow, setAlertWindow] = useState<(typeof TIME_FILTERS)[number]['key']>('24h')
  const [dispatchWindow, setDispatchWindow] = useState<(typeof TIME_FILTERS)[number]['key']>('24h')
  const [ctDispatchWindow, setCtDispatchWindow] = useState<(typeof TIME_FILTERS)[number]['key']>('24h')
  const [expandedAlerts, setExpandedAlerts] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    setLoading(true)
    getJson<RangeDetail>(`/api/ranges/${encodeURIComponent(rangeName)}/detail`)
      .then((data) => {
        setDetail((prev) => {
          if (!prev) {
            if (data.latestTop != null) setSimTop(data.latestTop)
            if (data.latestBottom != null) setSimBottom(data.latestBottom)
            if (data.latestQuantity != null) setSimQuantity(data.latestQuantity)
          }
          return data
        })
        setNotFound(false)
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false))
  }, [rangeName])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onRefresh = () => load()
    window.addEventListener('journal:refresh', onRefresh)
    return () => window.removeEventListener('journal:refresh', onRefresh)
  }, [load])

  const alertMs = TIME_FILTERS.find((f) => f.key === alertWindow)?.ms ?? null
  const dispatchMs = TIME_FILTERS.find((f) => f.key === dispatchWindow)?.ms ?? null
  const ctDispatchMs = TIME_FILTERS.find((f) => f.key === ctDispatchWindow)?.ms ?? null
  const visibleAlerts = useMemo(
    () => (detail?.alerts ?? []).filter((a) => withinWindow(a.receivedAt, alertMs)),
    [detail, alertMs],
  )
  const visibleDispatches = useMemo(
    () => (detail?.dispatches ?? []).filter((o) => o.destination !== 'crosstrade' && withinWindow(o.occurredAt, dispatchMs)),
    [detail, dispatchMs],
  )
  const visibleCtDispatches = useMemo(
    () => (detail?.dispatches ?? []).filter((o) => o.destination === 'crosstrade' && withinWindow(o.occurredAt, ctDispatchMs)),
    [detail, ctDispatchMs],
  )

  const toggleAlertJson = (id: string) => {
    setExpandedAlerts((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSimulate = (e: FormEvent) => {
    e.preventDefault()
    if (sending || simTop === '' || simBottom === '' || simQuantity === '') return
    setSending(true)
    setSimResults(null)
    postJson(`/api/ranges/${encodeURIComponent(rangeName)}/simulate`, {
      accountId: simAccount,
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
      .then(async (res) => {
        const body = (await res.json()) as { results?: SimAccountResult[] }
        setSimResults(body.results ?? [])
        const names = (body.results ?? []).map((r) => r.accountName ?? r.accountId).join(', ')
        success(`Range simulation sent to ${names}`)
      })
      .catch(() => error('Range simulation failed'))
      .finally(() => setSending(false))
  }

  const configuration = detail?.configuration ?? null

  const handleUpdateConfig = (name: string, patch: Partial<RangeConfiguration>) => {
    const isDayPatch = Object.keys(patch).some((k) => /^run(Mon|Tue|Wed|Thu|Fri|Sat|Sun)day$/.test(k))
    postJson('/api/range-configurations/patch', { rangeName: name, ...patch })
      .then(async (res) => {
        const saved = (await res.json()) as RangeConfiguration
        setDetail((prev) => (prev ? { ...prev, configuration: saved } : prev))
        success(isDayPatch ? 'Run days saved' : 'Range settings saved')
      })
      .catch(() => error(isDayPatch ? 'Failed to save run days' : 'Failed to save range settings'))
  }

  const handleAssignCategory = (name: string, subcategoryName: string, assigned: boolean) => {
    postForm('/range-subcategory-assignments', {
      rangeName: name,
      subcategoryName: subcategoryName === 'Uncategorized' ? '' : subcategoryName,
      mode: assigned ? 'add' : 'remove',
      timeframe: 'all',
    })
      .then(() => {
        load()
        success(assigned ? 'Model added' : 'Model removed')
      })
      .catch(() => error('Failed to update model membership'))
  }

  const handleRename = (currentRangeName: string, newRangeName: string) => {
    return postForm('/ranges/rename', { currentRangeName, newRangeName })
      .then(() => {
        success('Range renamed')
        navigate(`/app/ranges/calendar?range=${encodeURIComponent(newRangeName)}`)
      })
      .catch(() => error('Failed to rename range'))
  }

  const handleFlagRange = (
    name: string,
    flag: 'test_data' | 'erroneous' | 'clear',
  ) => {
    return postForm('/range-review-flags', {
      rangeName: name,
      testData: flag === 'test_data' ? 'true' : undefined,
      erroneous: flag === 'erroneous' ? 'true' : undefined,
    })
      .then(() => {
        load()
        success('Review flag updated')
      })
      .catch(() => error('Failed to update review flag'))
  }

  const handleDelete = (name: string) => {
    return postForm('/ranges/delete', { rangeName: name })
      .then(() => {
        success('Range deleted')
        navigate('/app/ranges')
      })
      .catch(() => error('Failed to delete range'))
  }

  const sharedDetail: SharedRangeDetail = detail?.rangeDetail ?? {
    rangeName,
    createdAt: '',
    allTime: EMPTY_METRICS,
    currentMonth: EMPTY_METRICS,
    currentWeek: EMPTY_METRICS,
    currentDay: EMPTY_METRICS,
    performanceAllTime: EMPTY_METRICS,
    performanceCurrentMonth: EMPTY_METRICS,
    performanceCurrentWeek: EMPTY_METRICS,
    performanceCurrentDay: EMPTY_METRICS,
    subscriptions: [],
  }

  if (notFound && !loading) {
    return (
      <Card title="Range details">
        <p className="text-sm text-slate-400">
          No data for range <span className="font-semibold">{rangeName}</span>.
        </p>
      </Card>
    )
  }

  const filterSelect = (
    value: string,
    onChange: (v: (typeof TIME_FILTERS)[number]['key']) => void,
  ) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as (typeof TIME_FILTERS)[number]['key'])}
      className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
    >
      {TIME_FILTERS.map((f) => (
        <option key={f.key} value={f.key}>
          {f.label}
        </option>
      ))}
    </select>
  )

  return (
    <div className="space-y-6">
      {loading && !detail && (
        <Card title="Range details">
          <div className="flex items-center gap-2 py-4 text-slate-300">
            <LoadingSpinner size={16} />
            Loading range detail…
          </div>
        </Card>
      )}

      {detail && (
        <>
          {show('settings') && (
          <CollapsibleSection
            className="rounded-xl border border-slate-700 bg-slate-900"
            storageKey={`range-detail:${rangeName}:settings`}
            title={<h3 className="text-lg font-semibold text-slate-100">Range details</h3>}
          >
            <div className="mb-4">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">
                Subscribed accounts
              </div>
              {detail.subscriptions.length === 0 ? (
                <p className="text-sm text-slate-500">None of your accounts are routed to this range.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {detail.subscriptions.map((s) => (
                    <span
                      key={s.accountId}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs text-slate-200"
                    >
                      {s.accountName}
                      <span
                        className={`rounded px-1 text-[10px] font-bold ${s.traderspostEnabled ? 'bg-indigo-600 text-white' : 'border border-slate-600 text-slate-500'}`}
                        title={s.crossTrade ? 'CrossTrade routing' : 'TradersPost routing'}
                      >
                        {s.crossTrade ? 'CT' : 'TP'}
                      </span>
                      <span
                        className={`rounded px-1 text-[10px] font-bold ${s.extensionEnabled ? 'bg-indigo-600 text-white' : 'border border-slate-600 text-slate-500'}`}
                        title="Extension drafts"
                      >
                        EXT
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <RangeDetailCard
              range={sharedDetail}
              configuration={configuration ?? undefined}
              currentCategories={detail.modelNames ?? (detail.modelName ? [detail.modelName] : [])}
              subcategories={detail.subcategories}
              onAssignCategory={handleAssignCategory}
              onUpdateConfig={handleUpdateConfig}
              onRename={handleRename}
              onFlagRange={handleFlagRange}
              onDelete={handleDelete}
              compact={!detail.rangeDetail}
            />
          </CollapsibleSection>
          )}
          {show('simulation') && (
          <CollapsibleSection
            className="rounded-xl border border-slate-700 bg-slate-900"
            storageKey={`range-detail:${rangeName}:simulation`}
            title={
              <h3 className="text-lg font-semibold text-slate-100">
                Resend Trade{detail.instrument ? ` (${detail.instrument})` : ''}
              </h3>
            }
          >
            <p className="mb-4 text-sm text-slate-400">
              Send entries for {detail.rangeName} to the account's configured
              broker destination (TradersPost or CrossTrade).
            </p>
            <p className="mb-4 flex items-center gap-2 rounded-lg border border-amber-600/50 bg-amber-950/40 px-3 py-2 text-sm font-medium text-amber-200">
              <span className="text-amber-400">⚠</span>
              <span>
                Range top and bottom are prefilled from the latest buy/sell alerts for this range
                {detail.latestTopAt || detail.latestBottomAt
                  ? ` (${[
                      detail.latestTopAt ? `top alert ${ageLabel(detail.latestTopAt)}` : null,
                      detail.latestBottomAt ? `bottom alert ${ageLabel(detail.latestBottomAt)}` : null,
                    ]
                      .filter(Boolean)
                      .join(', ')})`
                  : ''}{' '}
                — confirm they still reflect the live range before sending.
              </span>
            </p>
            <form onSubmit={handleSimulate} className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-400">Account</label>
                <select
                  value={simAccount}
                  onChange={(e) => setSimAccount(e.target.value)}
                  required
                  className={inputCls}
                >
                  <option value="all">All accounts</option>
                  {detail.accounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.accountName} · {a.crossTrade ? 'CrossTrade' : 'TradersPost'}
                      {a.destinationEnabled ? '' : ' (destination off)'}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">Action</label>
                <select
                  value={simAction}
                  onChange={(e) => setSimAction(e.target.value as 'buy' | 'sell' | 'both')}
                  className={inputCls}
                >
                  <option value="buy">Buy (long)</option>
                  <option value="sell">Sell (short)</option>
                  <option value="both">Both (buy + sell)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">Order type</label>
                <select
                  value={simOrderType}
                  onChange={(e) => setSimOrderType(e.target.value)}
                  className={inputCls}
                >
                  <option value="market">Market</option>
                  <option value="limit">Limit</option>
                  <option value="stop">Stop</option>
                  <option value="stop_limit">Stop limit</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">Quantity (contracts)</label>
                <input
                  type="number"
                  step="1"
                  min="1"
                  value={simQuantity}
                  onChange={(e) => setSimQuantity(e.target.value === '' ? '' : Number(e.target.value))}
                  required
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">Range top: {detail.latestTop != null
                    ? `Latest buy-alert level: ${ageLabel(detail.latestTopAt ?? '')}`
                    : 'The upper bound of the range — use an up-to-date live price.'}</label>
                <input
                  type="number"
                  step="any"
                  value={simTop}
                  onChange={(e) => setSimTop(e.target.value === '' ? '' : Number(e.target.value))}
                  required
                  placeholder="Use a current market price"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">Range bottom: {detail.latestBottom != null
                    ? `Latest sell-alert level: ${ageLabel(detail.latestBottomAt ?? '')}`
                    : 'The lower bound of the range — use an up-to-date live price.'}</label>
                <input
                  type="number"
                  step="any"
                  value={simBottom}
                  onChange={(e) => setSimBottom(e.target.value === '' ? '' : Number(e.target.value))}
                  required
                  placeholder="Use a current market price"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">TP value Override</label>
                <input
                  type="number"
                  step="0.01"
                  value={simTpTicks}
                  onChange={(e) => setSimTpTicks(e.target.value)}
                  placeholder="e.g. 1.00 for 1x, 99 for 99 ticks"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">SL value Override</label>
                <input
                  type="number"
                  step="0.01"
                  value={simSlTicks}
                  onChange={(e) => setSimSlTicks(e.target.value)}
                  placeholder="e.g. 99 for 99 ticks"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">TP style Override</label>
                <input
                  type="text"
                  value={simTpStyle}
                  onChange={(e) => setSimTpStyle(e.target.value)}
                  placeholder="e.g. fixed or multiplier"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-400">SL style Override</label>
                <input
                  type="text"
                  value={simSlStyle}
                  onChange={(e) => setSimSlStyle(e.target.value)}
                  placeholder="e.g. fixed"
                  className={inputCls}
                />
              </div>
              <div className="flex justify-end md:col-span-2">
                <button
                  type="submit"
                  disabled={sending || detail.accounts.length === 0}
                  className="rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-md shadow-indigo-900/20 transition hover:from-blue-500 hover:to-purple-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
                >
                  {sending ? 'Sending…' : 'Send simulated request'}
                </button>
              </div>
            </form>
            {simResults && (
              <div className="mt-4 space-y-3">
                {simResults.map((r, i) => (
                  <div key={`${r.accountId}-${r.action ?? i}`} className="rounded-lg border border-slate-600 bg-slate-900 p-3 text-sm text-slate-300">
                    <div className="mb-2 font-medium">
                      {detail.rangeName} · {r.accountName ?? r.accountId}
                      {r.destination ? (
                        <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-200">
                          {r.destination === 'crosstrade' ? 'CrossTrade' : 'TradersPost'}
                        </span>
                      ) : null}
                      {r.action ? <span className="ml-2 text-slate-400">· {r.action}</span> : null}
                      {r.error ? <span className="ml-2 text-negative-400">{r.error}</span> : null}
                    </div>
                    {r.computed ? (
                      <div className="mb-3 rounded border border-slate-700 p-2 text-xs text-slate-400">
                        <div>Entry: {r.computed.entryPrice} · Tick: {r.computed.tickSize}</div>
                        <div>
                          TP: {r.computed.tpDistance} ({r.computed.tpPercent}%) · SL:{' '}
                          {r.computed.slDistance} ({r.computed.slPercent}%)
                        </div>
                      </div>
                    ) : null}
                    <div className="space-y-2">
                      {(r.outboundPayloads ?? []).map((p, i) => (
                        <details key={i} className="rounded border border-slate-700 p-2">
                          <summary className="cursor-pointer text-xs text-slate-400">
                            Payload {i + 1}
                            {r.results?.[i]?.status != null ? ` · HTTP ${r.results[i].status}` : ''}
                          </summary>
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-slate-300">
                            {p}
                          </pre>
                          {r.results?.[i]?.body ? (
                            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-xs text-slate-400">
                              {r.results[i].body}
                            </pre>
                          ) : null}
                        </details>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>
          )}
          {show('alerts') && (
          <CollapsibleSection
            className="rounded-xl border border-slate-700 bg-slate-900"
            storageKey={`range-detail:${rangeName}:alerts`}
            title={<h3 className="text-lg font-semibold text-slate-100">Trading View alerts</h3>}
            actions={filterSelect(alertWindow, setAlertWindow)}
          >
            {visibleAlerts.length === 0 ? (
              <p className="text-sm text-slate-500">No alerts in this window.</p>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-700">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-4 py-2">Received</th>
                      <th className="px-4 py-2">Action</th>
                      <th className="px-4 py-2">Ticker</th>
                      <th className="px-4 py-2 text-right">JSON</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-700">
                    {visibleAlerts.map((a) => (
                      <tr key={a.alertId}>
                        <td className="px-4 py-2 text-slate-200"><JournalDate value={a.receivedAt} /></td>
                        <td className="px-4 py-2 text-slate-200">{a.action}</td>
                        <td className="px-4 py-2 text-slate-200">{a.ticker}</td>
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => toggleAlertJson(a.alertId)}
                            className="rounded border border-slate-600 bg-slate-900 px-2 py-0.5 text-xs font-semibold text-slate-300 hover:bg-slate-700"
                          >
                            {expandedAlerts.has(a.alertId) ? 'Hide' : 'JSON'}
                          </button>
                          {expandedAlerts.has(a.alertId) && (
                            <pre className="mt-2 max-w-md overflow-x-auto whitespace-pre-wrap break-all rounded border border-slate-700 bg-slate-950 p-2 text-left text-xs text-slate-300">
                              {(() => {
                                try {
                                  return JSON.stringify(JSON.parse(a.payloadJson), null, 2)
                                } catch {
                                  return a.payloadJson
                                }
                              })()}
                            </pre>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CollapsibleSection>
          )}
          {show('dispatches') && (
          <CollapsibleSection
            className="rounded-xl border border-slate-700 bg-slate-900"
            storageKey={`range-detail:${rangeName}:dispatches`}
            title={<h3 className="text-lg font-semibold text-slate-100">TradersPost dispatches</h3>}
            actions={filterSelect(dispatchWindow, setDispatchWindow)}
          >
            {visibleDispatches.length === 0 ? (
              <p className="text-sm text-slate-500">No dispatches in this window.</p>
            ) : renderDispatchTable(visibleDispatches)}
          </CollapsibleSection>
          )}
          {show('ct-dispatches') && (
          <CollapsibleSection
            className="rounded-xl border border-slate-700 bg-slate-900"
            storageKey={`range-detail:${rangeName}:ct-dispatches`}
            title={<h3 className="text-lg font-semibold text-slate-100">CrossTrade dispatches</h3>}
            actions={filterSelect(ctDispatchWindow, setCtDispatchWindow)}
          >
            {visibleCtDispatches.length === 0 ? (
              <p className="text-sm text-slate-500">No dispatches in this window.</p>
            ) : renderDispatchTable(visibleCtDispatches)}
          </CollapsibleSection>
          )}
        </>
      )}
    </div>
  )
}

const renderDispatchTable = (rows: BrokerOrder[]) => (
  <div className="overflow-x-auto rounded-xl border border-slate-700">
    <table className="w-full min-w-[640px] text-left text-sm">
      <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
        <tr>
          <th className="px-4 py-2">Time</th>
          <th className="px-4 py-2">Account</th>
          <th className="px-4 py-2">Action</th>
          <th className="px-4 py-2">Side</th>
          <th className="px-4 py-2 text-right">Qty</th>
          <th className="px-4 py-2 text-right">Price</th>
          <th className="px-4 py-2">Status</th>
          <th className="px-4 py-2">Error</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-700">
        {rows.map((o) => (
          <tr key={o.id}>
            <td className="px-4 py-2 text-slate-200"><JournalDate value={o.occurredAt} /></td>
            <td className="px-4 py-2 text-slate-200">{o.accountName ?? o.accountId.slice(0, 8)}</td>
            <td className="px-4 py-2 text-slate-200">{o.action}</td>
            <td className="px-4 py-2 text-slate-200">{o.side ?? '—'}</td>
            <td className="px-4 py-2 text-right text-slate-200">{o.quantity ?? '—'}</td>
            <td className="px-4 py-2 text-right text-slate-200">
              {o.price ?? (o.stopPrice != null ? `${o.stopPrice} stop` : '—')}
            </td>
            <td className="px-4 py-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[o.status] ?? 'bg-slate-700 text-slate-300'}`}
              >
                {o.status}
              </span>
            </td>
            <td className="max-w-[220px] truncate px-4 py-2 text-xs text-slate-500" title={o.errorText ?? ''}>
              {o.errorText ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)
