import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { getJson, postJson } from '../../api/client'
import { useToast } from '../../context/ToastContext'
import { Button, Card, Field, Input, SelectPicker, Spinner, colors ,
  themedStyles,
} from '../../components/ui'
import type { DraftStatus, OrderDraft } from '../../types'

import {
  absoluteProtection,
  entryPrice,
  formatDraftAge,
  formatProtection,
  formatStrategyStop,
  strategyStopPresentation,
  formatPrice,
} from '../../utils/drafts'

type DraftAction = 'submitted' | 'rejected' | 'reviewed' | 'resend'

const DEFAULT_SINCE_HOURS = 72
const RECENT_DRAFT_LIMIT = 25

// Getters — `colors` mutates in place on theme change, so module-level
// captures would bake the boot palette forever.
const STATUS_COLORS: Record<DraftStatus, string> = {
  get pending() { return colors.amber },
  get reviewed() { return colors.accent },
  get submitted() { return colors.positive },
  get rejected() { return colors.negative },
  get expired() { return colors.muted },
}

const HEADING_COLORS: Record<OrderDraft['action'], string> = {
  get buy() { return colors.positive },
  get sell() { return colors.negative },
  get cancel() { return colors.amber },
}

function CopyButton({ value }: { value: string }) {
  const { error } = useToast()
  const [copied, setCopied] = useState(false)
  return (
    <Pressable
      onPress={() => {
        Clipboard.setStringAsync(value)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => error('Could not copy to the clipboard.'))
      }}
      style={{ paddingHorizontal: 6 }}
    >
      <Text style={{ color: copied ? colors.positive : colors.muted, fontSize: 13 }}>
        {copied ? '✓' : '⧉'}
      </Text>
    </Pressable>
  )
}

function DraftField({ label, value, note, copyValue }: { label: string; value: string; note?: string; copyValue?: string }) {
  return (
    <View style={{ minWidth: '30%', flex: 1, marginBottom: 8 }}>
      <Text style={styles.dimSmall}>{label.toUpperCase()}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={styles.fieldValue}>{value}</Text>
        {copyValue != null ? <CopyButton value={copyValue} /> : null}
      </View>
      {note ? <Text style={styles.dimSmall}>{note}</Text> : null}
    </View>
  )
}

function DraftFields({ draft }: { draft: OrderDraft }) {
  const strategyStop = strategyStopPresentation(draft)
  const takeProfit = absoluteProtection(draft, 'takeProfit')
  const stopLoss = absoluteProtection(draft, 'stopLoss')
  const entry = entryPrice(draft)
  const fields: { label: string; value: string; note?: string; copyValue?: string }[] = [
    { label: 'Side', value: draft.action.toUpperCase() },
    { label: 'Quantity', value: String(draft.quantity), copyValue: String(draft.quantity) },
    { label: 'Order type', value: draft.orderType.toUpperCase() },
    {
      label: 'Entry',
      value: formatPrice(draft.ticker, entry),
      copyValue: entry != null ? formatPrice(draft.ticker, entry) : undefined,
    },
    { label: 'Account', value: draft.accountName ?? 'Unassigned' },
    {
      label: 'Take profit',
      value: formatProtection(draft, 'takeProfit'),
      copyValue: takeProfit != null ? formatPrice(draft.ticker, takeProfit) : undefined,
    },
    ...(strategyStop
      ? [
          {
            label: strategyStop.label,
            value: formatStrategyStop(draft, strategyStop.price),
            note: 'Informational only — not filled into Tradovate.',
            copyValue: formatPrice(draft.ticker, strategyStop.price),
          },
        ]
      : [
          {
            label: 'Stop loss',
            value: formatProtection(draft, 'stopLoss'),
            copyValue: stopLoss != null ? formatPrice(draft.ticker, stopLoss) : undefined,
          },
        ]),
  ]
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
      {fields.map((f) => (
        <DraftField key={f.label} {...f} />
      ))}
    </View>
  )
}

function DraftCard({
  draft,
  actionable,
  now,
  onAction,
}: {
  draft: OrderDraft
  actionable: boolean
  now: number
  onAction: (draft: OrderDraft, action: DraftAction) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (action: DraftAction) => {
    setBusy(action)
    try {
      await onAction(draft, action)
    } catch {
      setBusy(null)
    }
  }

  const heading =
    draft.action === 'cancel'
      ? (draft.cancellationMessage ?? 'Cancel opposite entry')
      : `${draft.action.toUpperCase()} ${draft.quantity} ${draft.ticker}${
          draft.rangeName ? ` - ${draft.rangeName}` : ''
        }${draft.orderLeg ? ` (${draft.orderLeg})` : ''}${draft.accountName ? ` - ${draft.accountName}` : ''}`

  return (
    <View
      style={[
        styles.draftCard,
        draft.action === 'cancel' && draft.status === 'pending' && { borderColor: colors.amber },
      ]}
    >
      <View style={styles.rowBetween}>
        <Text style={[styles.title, { color: HEADING_COLORS[draft.action], flex: 1 }]}>{heading}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {draft.extensionEligible === false ? (
            <View style={styles.statusBadge}>
              <Text style={styles.dimSmall}>web only</Text>
            </View>
          ) : null}
          <View style={[styles.statusBadge, { borderColor: STATUS_COLORS[draft.status] }]}>
            <Text style={[styles.dimSmall, { color: STATUS_COLORS[draft.status] }]}>{draft.status}</Text>
          </View>
        </View>
      </View>

      {draft.action === 'cancel' ? (
        <View>
          <Text style={styles.value}>Review and cancel the opposite {draft.ticker} entry in Tradovate.</Text>
          {draft.accountName ? <DraftField label="Account" value={draft.accountName} /> : null}
        </View>
      ) : (
        <DraftFields draft={draft} />
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Text style={styles.dimSmall}>Received {new Date(draft.receivedAt).toLocaleString()}</Text>
        {actionable ? (
          <Text style={styles.dimSmall}>Age: {formatDraftAge(draft.receivedAt, now)}</Text>
        ) : null}
      </View>

      {actionable ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          {draft.action === 'cancel' ? (
            <Button
              small
              variant="ghost"
              disabled={busy !== null}
              title={busy === 'reviewed' ? 'Marking…' : 'Mark reminder handled'}
              onPress={() => void act('reviewed')}
            />
          ) : (
            <Button
              small
              variant="ghost"
              disabled={busy !== null}
              title={busy === 'submitted' ? 'Marking…' : 'Mark as submitted'}
              onPress={() => void act('submitted')}
            />
          )}
        </View>
      ) : null}

      {!actionable && draft.status !== 'pending' ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
          <Button
            small
            variant="ghost"
            disabled={busy !== null}
            title={busy === 'resend' ? 'Resending…' : 'Resend'}
            onPress={() => void act('resend')}
          />
        </View>
      ) : null}
    </View>
  )
}

export default function OrderReviewScreen() {
  const [pending, setPending] = useState<OrderDraft[] | null>(null)
  const [history, setHistory] = useState<OrderDraft[] | null>(null)
  const [, setIsLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [statusIsError, setStatusIsError] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [rangeFilter, setRangeFilter] = useState('all')
  const [accountFilter, setAccountFilter] = useState('all')
  const [sinceHours, setSinceHours] = useState(DEFAULT_SINCE_HOURS)
  const [query, setQuery] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!pending?.length) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [pending?.length])

  const load = useCallback(
    async (options?: { since?: number; search?: string }) => {
      const since = options?.since ?? sinceHours
      const search = options?.search ?? query
      setIsLoading(true)
      try {
        const [pendingRes, historyRes] = await Promise.all([
          getJson<{ drafts: OrderDraft[] }>('/api/drafts'),
          getJson<{ drafts: OrderDraft[] }>(
            `/api/drafts/history?limit=${RECENT_DRAFT_LIMIT}&sinceHours=${since}&accountId=all${
              search ? `&query=${encodeURIComponent(search)}` : ''
            }`,
          ),
        ])
        setPending(
          pendingRes.drafts.sort(
            (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
          ),
        )
        setHistory(historyRes.drafts)
        setStatusIsError(false)
        setStatusMessage(
          pendingRes.drafts.length === 0
            ? 'No pending order drafts.'
            : `${pendingRes.drafts.length} order draft(s) require review.`,
        )
      } catch (err) {
        setStatusIsError(true)
        setStatusMessage(err instanceof Error ? err.message : 'Could not load drafts.')
      } finally {
        setIsLoading(false)
        setRefreshing(false)
      }
    },
    [sinceHours, query],
  )

  useEffect(() => {
    void load()
  }, [])

  const [submittingAll, setSubmittingAll] = useState(false)
  const submitAll = useCallback(async () => {
    if (submittingAll || !pending?.length) return
    setSubmittingAll(true)
    try {
      await postJson('/api/drafts/submit-all', {})
      setStatusIsError(false)
      setStatusMessage('All pending drafts marked submitted.')
      await load()
    } catch {
      setStatusIsError(true)
      setStatusMessage('Could not mark all drafts submitted.')
    } finally {
      setSubmittingAll(false)
    }
  }, [submittingAll, pending, load])

  const onAction = useCallback(
    async (draft: OrderDraft, action: DraftAction) => {
      const friendly = {
        submitted: 'Could not mark draft submitted.',
        rejected: 'Could not reject draft.',
        reviewed: 'Could not mark reminder handled.',
        resend: 'Could not resend draft.',
      }[action]
      try {
        await postJson(`/api/drafts/${draft.id}/${action}`, {})
        await load()
      } catch (err) {
        setStatusIsError(true)
        setStatusMessage(friendly)
        throw err
      }
    },
    [load],
  )

  const accountOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const draft of history ?? []) {
      if (draft.accountId && draft.accountName) map.set(draft.accountId, draft.accountName)
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [history])

  const rangeOptions = useMemo(
    () => [...new Set((history ?? []).map((d) => d.rangeName).filter((n): n is string => Boolean(n)))].sort(),
    [history],
  )

  const filteredHistory = useMemo(
    () =>
      (history ?? []).filter(
        (draft) =>
          (accountFilter === 'all' || draft.accountId === accountFilter) &&
          (rangeFilter === 'all' || draft.rangeName === rangeFilter),
      ),
    [history, accountFilter, rangeFilter],
  )

  const historySummary = useMemo(() => {
    const notes = [`Showing the last ${sinceHours} hours.`]
    if (rangeFilter !== 'all') notes.push(`Range: ${rangeFilter}.`)
    if (query) notes.push(`Filter: "${query}".`)
    if (accountFilter !== 'all') {
      notes.push(`Account: ${accountOptions.find(([id]) => id === accountFilter)?.[1] ?? accountFilter}.`)
    }
    notes.push(`${filteredHistory.length} result${filteredHistory.length === 1 ? '' : 's'}.`)
    return notes.join(' ')
  }, [sinceHours, rangeFilter, query, accountFilter, accountOptions, filteredHistory.length])

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
      data={[]}
      renderItem={null}
      ListHeaderComponent={
        <View>
          <Text style={[statusIsError ? styles.statusError : styles.dim, { marginBottom: 8 }]}>
            {statusMessage}
          </Text>
          {pending !== null && pending.length > 0 ? (
            <Button
              small
              title={submittingAll ? 'Marking...' : `Mark all as submitted (${pending.length})`}
              disabled={submittingAll}
              onPress={() => void submitAll()}
              style={{ marginBottom: 10 }}
            />
          ) : null}
          {pending === null ? (
            <Spinner />
          ) : pending.length === 0 ? (
            <Text style={[styles.dim, { marginBottom: 12 }]}>No pending drafts or reminders right now.</Text>
          ) : (
            pending.map((draft) => (
              <DraftCard key={draft.id} draft={draft} actionable now={now} onAction={onAction} />
            ))
          )}

          <Card title="Completed orders and reminders" style={{ marginTop: 8 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <SelectPicker
                  label="Range"
                  options={[{ value: 'all', label: 'All ranges' }, ...rangeOptions.map((n) => ({ value: n, label: n }))]}
                  value={rangeFilter}
                  onChange={setRangeFilter}
                />
              </View>
              <View style={{ flex: 1 }}>
                <SelectPicker
                  label="Account"
                  options={[{ value: 'all', label: 'All accounts' }, ...accountOptions.map(([id, name]) => ({ value: id, label: name }))]}
                  value={accountFilter}
                  onChange={setAccountFilter}
                />
              </View>
              <View style={{ flex: 1 }}>
                <SelectPicker
                  label="Since"
                  options={[
                    { value: 12, label: '12 hours' },
                    { value: 24, label: '24 hours' },
                    { value: 48, label: '48 hours' },
                    { value: 72, label: '3 days' },
                    { value: 168, label: '1 week' },
                  ]}
                  value={sinceHours}
                  onChange={(next) => {
                    setSinceHours(next)
                    void load({ since: next })
                  }}
                />
              </View>
            </View>
            <Field label="Search">
              <Input
                value={query}
                onChangeText={(next) => {
                  setQuery(next)
                  if (searchTimer.current) clearTimeout(searchTimer.current)
                  searchTimer.current = setTimeout(() => void load({ search: next }), 150)
                }}
                placeholder="Range, ticker, action"
              />
            </Field>
            <Text style={[styles.dimSmall, { marginBottom: 8 }]}>{historySummary}</Text>
            {history === null ? (
              <Spinner />
            ) : filteredHistory.length === 0 ? (
              <Text style={styles.dim}>No completed drafts match the current filters.</Text>
            ) : (
              filteredHistory.map((draft) => (
                <DraftCard key={draft.id} draft={draft} actionable={false} now={now} onAction={onAction} />
              ))
            )}
          </Card>
        </View>
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            void load()
          }}
          tintColor={colors.accent}
        />
      }
    />
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  container: { backgroundColor: c.bg, flex: 1 },
  dim: { color: c.muted, fontSize: 12 },
  dimSmall: { color: c.faint, fontSize: 11 },
  draftCard: {
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
    padding: 14,
  },
  fieldValue: { color: c.text, fontSize: 13, fontWeight: '700' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  statusBadge: {
    borderColor: c.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  statusError: { color: c.negative, fontSize: 12 },
  title: { fontSize: 15, fontWeight: '700' },
  value: { color: c.text, fontSize: 13, fontWeight: '600' },
}))
