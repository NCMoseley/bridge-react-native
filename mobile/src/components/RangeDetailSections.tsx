import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { getJson, postForm, postJson } from '../api/client'
import { useToast } from '../context/ToastContext'
import { onEvent } from '../utils/events'
import { Badge, Button, Card, CollapsibleSection, Field, Input, SelectPicker, Spinner, colors ,
  themedStyles,
} from './ui'
import { JournalDate } from './charts'
import { RangeDetailCard } from './RangeDetailCard'
import type {
  BrokerOrder,
  JournalMetrics,
  RangeAlert,
  RangeConfiguration,
  RangeSubcategory,
  SharedRangeDetail,
} from '../types'

interface RangeAccount {
  accountId: string
  accountName: string
  destinationEnabled: boolean
  crossTrade?: boolean
}

export interface RangeDetail {
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
  subscriptions: {
    accountId: string
    accountName: string
    traderspostEnabled: boolean
    extensionEnabled: boolean
    runScheduled: boolean
    crossTrade?: boolean
  }[]
}

interface SimAccountResult {
  accountId: string
  accountName?: string
  destination?: 'crosstrade' | 'traderspost'
  action?: 'buy' | 'sell'
  status?: number
  error?: string
  outboundPayloads?: string[]
  results?: { status?: number; body?: string; error?: string }[]
  computed?: {
    entryPrice: number
    tickSize: number
    tpDistance?: number
    slDistance?: number
    tpPercent?: number
    slPercent?: number
  }
}

const TIME_FILTERS = [
  { key: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: 'all', label: 'All', ms: null as number | null },
] as const

type TimeFilterKey = (typeof TIME_FILTERS)[number]['key']

const TIME_OPTIONS = TIME_FILTERS.map((f) => ({ value: f.key, label: f.label }))

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
  winRate: 0,
  averageWinDollarsCents: null,
  averageLossDollarsCents: null,
  averageWinTicksCents: null,
  averageLossTicksCents: null,
}

export type RangeDetailSectionKey = 'settings' | 'simulation' | 'alerts' | 'dispatches' | 'ct-dispatches'

function WindowPicker({ value, onChange }: { value: TimeFilterKey; onChange: (v: TimeFilterKey) => void }) {
  return (
    <View style={{ width: 130 }}>
      <SelectPicker options={TIME_OPTIONS} value={value} onChange={onChange} />
    </View>
  )
}

function DispatchTable({ rows }: { rows: BrokerOrder[] }) {
  return (
    <View>
      {rows.map((o) => (
        <View key={o.id} style={styles.listRow}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <JournalDate value={o.occurredAt} />
            <Text style={styles.value}>{o.accountName ?? o.accountId.slice(0, 8)}</Text>
            <Badge status={o.status === 'rejected' ? 'error' : o.status === 'filled' ? 'online' : 'warning'}>
              {o.status}
            </Badge>
          </View>
          <Text style={styles.dimSmall}>
            {o.action} {o.side ?? '—'} ×{o.quantity ?? '—'} @ {o.price ?? (o.stopPrice != null ? `${o.stopPrice} stop` : '—')}
          </Text>
          {o.errorText ? <Text style={{ color: colors.negative, fontSize: 11 }}>{o.errorText}</Text> : null}
        </View>
      ))}
    </View>
  )
}

export function RangeDetailSections({
  rangeName,
  sections,
}: {
  rangeName: string
  sections?: RangeDetailSectionKey[]
}) {
  const show = (key: RangeDetailSectionKey) => !sections || sections.includes(key)
  const [detail, setDetail] = useState<RangeDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const { success, error } = useToast()
  const router = useRouter()

  const [simAccount, setSimAccount] = useState('all')
  const [simAction, setSimAction] = useState<'buy' | 'sell' | 'both'>('buy')
  const [simOrderType, setSimOrderType] = useState('stop')
  const [simTop, setSimTop] = useState('')
  const [simBottom, setSimBottom] = useState('')
  const [simQuantity, setSimQuantity] = useState('1')
  const [simTpTicks, setSimTpTicks] = useState('')
  const [simSlTicks, setSimSlTicks] = useState('')
  const [simTpStyle, setSimTpStyle] = useState('')
  const [simSlStyle, setSimSlStyle] = useState('')
  const [sending, setSending] = useState(false)
  const [simResults, setSimResults] = useState<SimAccountResult[] | null>(null)

  const [alertWindow, setAlertWindow] = useState<TimeFilterKey>('24h')
  const [dispatchWindow, setDispatchWindow] = useState<TimeFilterKey>('24h')
  const [ctDispatchWindow, setCtDispatchWindow] = useState<TimeFilterKey>('24h')
  const [expandedAlerts, setExpandedAlerts] = useState<Set<string>>(new Set())

  const load = useCallback(() => {
    setLoading(true)
    getJson<RangeDetail>(`/api/ranges/${encodeURIComponent(rangeName)}/detail`)
      .then((data) => {
        setDetail((prev) => {
          if (!prev) {
            if (data.latestTop != null) setSimTop(String(data.latestTop))
            if (data.latestBottom != null) setSimBottom(String(data.latestBottom))
            if (data.latestQuantity != null) setSimQuantity(String(data.latestQuantity))
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

  useEffect(() => onEvent('journal:refresh', () => load()), [load])

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

  const handleSimulate = () => {
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
        load()
      })
      .catch(() => error('Failed to rename range'))
  }

  const handleFlagRange = (name: string, flag: 'test_data' | 'erroneous' | 'clear') => {
    return postForm('/range-review-flags', {
      rangeName: name,
      testData: flag === 'test_data' ? 'true' : undefined,
      erroneous: flag === 'erroneous' ? 'true' : undefined,
    })
      .then(() => {
        success('Review flag updated')
        load()
      })
      .catch(() => error('Failed to update review flag'))
  }

  const handleDelete = (name: string) => {
    return postForm('/ranges/delete', { rangeName: name })
      .then(() => {
        success('Range deleted')
        router.push('/ranges')
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
        <Text style={styles.dim}>No stored range named {rangeName}.</Text>
      </Card>
    )
  }

  if (loading && !detail) {
    return <Spinner />
  }

  return (
    <View>
      {detail && (
        <>
          {show('settings') ? (
            <CollapsibleSection
              storageKey={`range-detail:${rangeName}:settings`}
              title={<Text style={styles.sectionTitle}>Range details</Text>}
            >
              <View style={{ marginBottom: 10 }}>
                <Text style={[styles.dimSmall, { marginBottom: 4, textTransform: 'uppercase' }]}>
                  Subscribed accounts
                </Text>
                {detail.subscriptions.length === 0 ? (
                  <Text style={styles.dim}>None of your accounts are routed to this range.</Text>
                ) : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {detail.subscriptions.map((s) => (
                      <View key={s.accountId} style={styles.subChip}>
                        <Text style={styles.value}>{s.accountName}</Text>
                        {s.traderspostEnabled ? (
                          <Text style={[styles.subTag, styles.subTagOn]}>
                            {s.crossTrade ? 'CT' : 'TP'}
                          </Text>
                        ) : null}
                        {s.extensionEnabled ? (
                          <Text style={[styles.subTag, styles.subTagOn]}>
                            EXT
                          </Text>
                        ) : null}
                      </View>
                    ))}
                  </View>
                )}
              </View>
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
          ) : null}

          {show('simulation') ? (
            <CollapsibleSection
              storageKey={`range-detail:${rangeName}:simulation`}
              title={
                <Text style={styles.sectionTitle}>
                  Resend Trade{detail.instrument ? ` (${detail.instrument})` : ''}
                </Text>
              }
            >
              <Text style={[styles.dim, { marginBottom: 6 }]}>
                Send entries for {detail.rangeName} to the account&rsquo;s configured broker destination (TradersPost or CrossTrade).
              </Text>
              <View style={styles.warnBox}>
                <Text style={styles.warnText}>
                  ⚠ Range top and bottom are prefilled from the latest buy/sell alerts for this range
                  {detail.latestTopAt || detail.latestBottomAt
                    ? ` (${[
                        detail.latestTopAt ? `top alert ${ageLabel(detail.latestTopAt)}` : null,
                        detail.latestBottomAt ? `bottom alert ${ageLabel(detail.latestBottomAt)}` : null,
                      ]
                        .filter(Boolean)
                        .join(', ')})`
                    : ''}{' '}
                  — confirm they still reflect the live range before sending.
                </Text>
              </View>
              <SelectPicker
                label="Account"
                options={[
                  { value: 'all', label: 'All subscribed accounts' },
                  ...detail.accounts.map((a) => ({
                    value: a.accountId,
                    label: `${a.accountName}${a.crossTrade ? ' (CrossTrade)' : ''}`,
                  })),
                ]}
                value={simAccount}
                onChange={setSimAccount}
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <View style={{ flex: 1 }}>
                  <SelectPicker
                    label="Action"
                    options={[
                      { value: 'buy', label: 'Buy (long)' },
                      { value: 'sell', label: 'Sell (short)' },
                      { value: 'both', label: 'Both (buy + sell)' },
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
                <View style={{ flex: 0.7 }}>
                  <Field label="Quantity">
                    <Input value={simQuantity} onChangeText={setSimQuantity} keyboardType="numeric" />
                  </Field>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Field label={`Range top${detail.latestTop != null ? ` (latest ${ageLabel(detail.latestTopAt ?? '')})` : ''}`}>
                    <Input value={simTop} onChangeText={setSimTop} keyboardType="decimal-pad" placeholder="Use a current market price" />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  <Field label={`Range bottom${detail.latestBottom != null ? ` (latest ${ageLabel(detail.latestBottomAt ?? '')})` : ''}`}>
                    <Input value={simBottom} onChangeText={setSimBottom} keyboardType="decimal-pad" placeholder="Use a current market price" />
                  </Field>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Field label="TP value Override">
                    <Input value={simTpTicks} onChangeText={setSimTpTicks} keyboardType="decimal-pad" placeholder="e.g. 1.00 for 1x" />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="SL value Override">
                    <Input value={simSlTicks} onChangeText={setSimSlTicks} keyboardType="decimal-pad" placeholder="e.g. 99 for 99 ticks" />
                  </Field>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Field label="TP style Override">
                    <Input value={simTpStyle} onChangeText={setSimTpStyle} placeholder="e.g. fixed or multiplier" />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="SL style Override">
                    <Input value={simSlStyle} onChangeText={setSimSlStyle} placeholder="e.g. fixed" />
                  </Field>
                </View>
              </View>
              <Button
                title={sending ? 'Sending…' : 'Send simulated request'}
                disabled={sending || detail.accounts.length === 0}
                onPress={handleSimulate}
              />
              {simResults ? (
                <View style={{ marginTop: 10 }}>
                  {simResults.map((r, i) => (
                    <View key={`${r.accountId}-${r.action ?? i}`} style={styles.listRow}>
                      <Text style={styles.value}>
                        {detail.rangeName} · {r.accountName ?? r.accountId}
                        {r.destination ? ` · ${r.destination === 'crosstrade' ? 'CrossTrade' : 'TradersPost'}` : ''}
                        {r.action ? ` · ${r.action}` : ''}
                      </Text>
                      {r.error ? <Text style={{ color: colors.negative, fontSize: 11 }}>{r.error}</Text> : null}
                      {r.computed ? (
                        <Text style={styles.dimSmall}>
                          Entry: {r.computed.entryPrice} · Tick: {r.computed.tickSize}{'\n'}
                          TP: {r.computed.tpDistance} ({r.computed.tpPercent}%) · SL: {r.computed.slDistance} ({r.computed.slPercent}%)
                        </Text>
                      ) : null}
                      {(r.outboundPayloads ?? []).map((p, pi) => (
                        <Text key={pi} style={styles.payload}>
                          Payload {pi + 1}{r.results?.[pi]?.status != null ? ` · HTTP ${r.results[pi].status}` : ''}
                          {'\n'}{p}
                          {r.results?.[pi]?.body ? `\n${r.results[pi].body}` : ''}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              ) : null}
            </CollapsibleSection>
          ) : null}

          {show('alerts') ? (
            <CollapsibleSection
              storageKey={`range-detail:${rangeName}:alerts`}
              title={<Text style={styles.sectionTitle}>Trading View alerts</Text>}
              actions={<WindowPicker value={alertWindow} onChange={setAlertWindow} />}
            >
              {visibleAlerts.length === 0 ? (
                <Text style={styles.dim}>No alerts in this window.</Text>
              ) : (
                visibleAlerts.map((a) => (
                  <View key={a.alertId} style={styles.listRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <JournalDate value={a.receivedAt} />
                      <Text style={styles.value}>{a.action}</Text>
                      <Text style={styles.dim}>{a.ticker}</Text>
                      <View style={{ flex: 1 }} />
                      <Button small variant="ghost" title={expandedAlerts.has(a.alertId) ? 'Hide' : 'JSON'} onPress={() => toggleAlertJson(a.alertId)} />
                    </View>
                    {expandedAlerts.has(a.alertId) ? (
                      <Text style={styles.payload}>
                        {(() => {
                          try {
                            return JSON.stringify(JSON.parse(a.payloadJson), null, 2)
                          } catch {
                            return a.payloadJson
                          }
                        })()}
                      </Text>
                    ) : null}
                  </View>
                ))
              )}
            </CollapsibleSection>
          ) : null}

          {show('dispatches') ? (
            <CollapsibleSection
              storageKey={`range-detail:${rangeName}:dispatches`}
              title={<Text style={styles.sectionTitle}>TradersPost dispatches</Text>}
              actions={<WindowPicker value={dispatchWindow} onChange={setDispatchWindow} />}
            >
              {visibleDispatches.length === 0 ? (
                <Text style={styles.dim}>No dispatches in this window.</Text>
              ) : (
                <DispatchTable rows={visibleDispatches} />
              )}
            </CollapsibleSection>
          ) : null}

          {show('ct-dispatches') ? (
            <CollapsibleSection
              storageKey={`range-detail:${rangeName}:ct-dispatches`}
              title={<Text style={styles.sectionTitle}>CrossTrade dispatches</Text>}
              actions={<WindowPicker value={ctDispatchWindow} onChange={setCtDispatchWindow} />}
            >
              {visibleCtDispatches.length === 0 ? (
                <Text style={styles.dim}>No dispatches in this window.</Text>
              ) : (
                <DispatchTable rows={visibleCtDispatches} />
              )}
            </CollapsibleSection>
          ) : null}
        </>
      )}
    </View>
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  dim: { color: c.muted, fontSize: 12 },
  dimSmall: { color: c.faint, fontSize: 11 },
  listRow: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    padding: 10,
  },
  payload: {
    color: c.muted,
    fontFamily: 'Menlo',
    fontSize: 9,
    marginTop: 6,
  },
  sectionTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  subChip: {
    alignItems: 'center',
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  subTag: { borderRadius: 3, fontSize: 9, fontWeight: '800', overflow: 'hidden', paddingHorizontal: 4 },
  subTagOn: { backgroundColor: c.accent, color: '#fff' },
  value: { color: c.text, fontSize: 13, fontWeight: '600' },
  warnBox: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: c.amber,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    padding: 10,
  },
  warnText: { color: c.amber, fontSize: 12 },
}))
