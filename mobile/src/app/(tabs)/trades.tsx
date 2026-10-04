import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { storage } from '../../utils/storage'
import { getJson, postForm, postJson } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import {
  Badge,
  Button,
  Card,
  CollapsibleSection,
  SelectPicker,
  Spinner,
  colors,
  pnlColor,
  themedStyles,
} from '../../components/ui'
import { JournalDate, MonthlyPerformanceMix } from '../../components/charts'
import { onEvent } from '../../utils/events'
import { formatPrice } from '../../utils/drafts'
import { displayInstrument } from '../../utils/instruments'


import {
  formatJournalDateKey,
  formatPnl,
  formatQuantity,
  formatTicks,
} from '../../utils/format'
import type {
  TradeCalendarMonthView,
  TradeEvent,
  TradeJournal,
  TradeJournalDay,
} from '../../types'
const PAGE_SIZE = 25

const TRADE_TIME_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
]

const OUTCOME_OPTIONS = [
  { value: 'all', label: 'All outcomes' },
  { value: 'win', label: 'Wins' },
  { value: 'loss', label: 'Losses' },
  { value: 'breakeven', label: 'Breakeven' },
]

const EXCLUSION_OPTIONS = [
  { value: 'all', label: 'All records' },
  { value: 'non_excluded', label: 'Non-excluded' },
  { value: 'excluded', label: 'Excluded' },
  { value: 'test_data', label: 'Test data' },
  { value: 'erroneous', label: 'Erroneous' },
]

export default function TradesScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const { error: toastError } = useToast()
  const [ctSweeping, setCtSweeping] = useState(false)
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [selectedOutcome, setSelectedOutcome] = useState('all')
  const [selectedRange, setSelectedRange] = useState('all')
  const [selectedInstrument, setSelectedInstrument] = useState('all')
  const [selectedDate, setSelectedDate] = useState('all')
  const [selectedExclusion, setSelectedExclusion] = useState('non_excluded')
  const [page, setPage] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [isSpinning, setIsSpinning] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [showClosedFilters, setShowClosedFilters] = useState(false)
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [refreshKey, setRefreshKey] = useState(0)
  const [serverTradeJournal, setServerTradeJournal] = useState<TradeJournal | undefined>()
  const [serverCalendar, setServerCalendar] = useState<TradeCalendarMonthView | undefined>()
  const [serverJournalDays, setServerJournalDays] = useState<Record<string, TradeJournalDay> | undefined>()

  const refresh = useCallback(() => {
    setIsSpinning(true)
    setRefreshKey((k) => k + 1)
    setTimeout(() => setIsSpinning(false), 600)
  }, [])

  const tradeJournal = serverTradeJournal
  const journalDays = serverJournalDays

  const accountNames = useMemo(
    () => new Map((tradeJournal?.accounts ?? []).map((a) => [a.account.id, a.account.name])),
    [tradeJournal],
  )
  const allAccounts = (tradeJournal?.accounts ?? []).map((a) => a.account)

  useEffect(() => {
    if (!user) return
    const params = new URLSearchParams()
    for (const id of selectedAccountIds) params.append('account', id)
    const query = `?${params.toString()}`
    void getJson<{
      tradeJournal: TradeJournal
      calendar: TradeCalendarMonthView
      journalDays: Record<string, TradeJournalDay>
    }>(`/api/journal${query}`)
      .then((data) => {
        setServerTradeJournal(data.tradeJournal)
        setServerCalendar(data.calendar)
        setServerJournalDays(data.journalDays)
        setIsLoading(false)
      })
      .catch(() => setIsLoading(false))
  }, [selectedAccountIds, refreshKey, user?.userId])

  useEffect(() => onEvent('journal:refresh', refresh), [refresh])

  const recentClosedTrades = tradeJournal?.recentClosedTrades ?? []
  const openTrades = (tradeJournal?.openTrades ?? []).filter(
    (t) => t.entryArmedDeliveryStatus !== 'extension',
  )
  const rangeEntries = tradeJournal?.rangeEntries ?? {}
  const pairedClosedTrades = tradeJournal?.pairedClosedTrades ?? []
  const openTradeCards = useMemo(() => {
    const groups = new Map<string, TradeEvent[]>()
    const openKeyToGroupKey = new Map<string, string>()
    for (const trade of openTrades) {
      const d = new Date(trade.occurredAt)
      const sessionStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 22))
      if (d < sessionStart) sessionStart.setUTCDate(sessionStart.getUTCDate() - 1)
      const key = `${trade.rangeName}::${sessionStart.toISOString()}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(trade)
      openKeyToGroupKey.set(`${trade.accountId}:${trade.rangeName}:${trade.instrument}:${trade.side}`, key)
    }
    for (const trade of pairedClosedTrades) {
      const oppositeSide = trade.side === 'long' ? 'short' : 'long'
      const groupKey = openKeyToGroupKey.get(`${trade.accountId}:${trade.rangeName}:${trade.instrument}:${oppositeSide}`)
      if (groupKey) groups.get(groupKey)!.push(trade)
    }
    return groups
  }, [openTrades, pairedClosedTrades])

  const rangeOptions = useMemo(
    () => [{ value: 'all', label: 'All ranges' }, ...(tradeJournal?.rangeNames ?? []).map((r) => ({ value: r, label: r }))],
    [serverTradeJournal],
  )
  const instrumentOptions = useMemo(
    () => [
      { value: 'all', label: 'All instruments' },
      ...[...new Set(recentClosedTrades.map((t) => t.instrument))].sort().map((i) => ({ value: i, label: i })),
    ],
    [recentClosedTrades],
  )
  const dateOptions = useMemo(
    () => [
      { value: 'all', label: 'All dates' },
      ...[...new Set(recentClosedTrades.map((t) => t.occurredAt.slice(0, 10)))]
        .sort()
        .reverse()
        .map((d) => ({ value: d, label: formatJournalDateKey(d) })),
    ],
    [recentClosedTrades],
  )

  const filteredTrades = useMemo(() => {
    return recentClosedTrades.filter((trade) => {
      if (selectedAccountIds.size > 0 && !selectedAccountIds.has(trade.accountId)) return false
      if (selectedOutcome !== 'all' && trade.outcome !== selectedOutcome) return false
      if (selectedRange !== 'all' && trade.rangeName !== selectedRange) return false
      if (selectedInstrument !== 'all' && trade.instrument !== selectedInstrument) return false
      if (selectedDate !== 'all' && !trade.occurredAt.startsWith(selectedDate)) return false
      if (selectedExclusion === 'excluded' && !trade.excludedFromPerformance) return false
      if (selectedExclusion === 'non_excluded' && trade.excludedFromPerformance) return false
      return true
    })
  }, [recentClosedTrades, selectedAccountIds, selectedOutcome, selectedRange, selectedInstrument, selectedDate, selectedExclusion])

  const closedTradeGroups = useMemo(() => {
    const map = new Map<string, TradeEvent[]>()
    for (const t of filteredTrades) {
      const key = `${t.occurredAt.slice(0, 10)}|${t.rangeName}`
      const g = map.get(key)
      if (g) g.push(t)
      else map.set(key, [t])
    }
    return [...map.entries()].map(([key, trades]) => ({ key, trades }))
  }, [filteredTrades])

  const pageCount = Math.max(1, Math.ceil(closedTradeGroups.length / PAGE_SIZE))
  const effectivePage = Math.min(page, pageCount)
  const pageStart = (effectivePage - 1) * PAGE_SIZE
  const pageGroups = closedTradeGroups.slice(pageStart, pageStart + PAGE_SIZE)

  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const handleTradeExclusion = (eventId: string, reason: 'test_data' | 'erroneous' | 'clear') => {
    return postForm('/trade-exclusions', {
      eventId,
      testData: reason === 'test_data' ? 'true' : undefined,
      erroneous: reason === 'erroneous' ? 'true' : undefined,
    })
      .then(() => refresh())
      .catch(() => refresh())
  }

  const handleTradeDelete = (eventId: string) => {
    Alert.alert('Delete trade', 'Delete this trade record? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          postForm('/trade-events/delete', { eventId })
            .then(() => refresh())
            .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
        },
      },
    ])
  }

  const handleReconcile = (trade: TradeEvent) => {
    postJson('/api/journal/reconcile-be', { eventId: trade.id })
      .then(() => refresh())
      .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
  }

  const handleResend = (trade: TradeEvent) => {
    if (!trade.entryArmedDeliveryId || resendingId) return
    const message =
      trade.entryArmedDeliveryStatus === 'delivered'
        ? trade.eventType === 'entry_filled'
          ? 'This position is already filled. Resending sends another entry order and could double your position. Continue?'
          : 'This entry was already delivered to TradersPost. Send another order?'
        : trade.entryArmedDeliveryStatus === 'failed'
          ? 'Resend this entry order to TradersPost? If the earlier attempt actually reached the broker, this will create a duplicate order.'
          : trade.entryArmedDeliveryStatus === 'blocked'
            ? 'The entry order was suppressed and never sent to TradersPost. Send it now?'
            : 'Send this entry order to TradersPost?'
    Alert.alert('Resend entry order', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send',
        onPress: () => {
          setResendingId(trade.id)
          postJson('/api/journal/resend-delivery', { deliveryId: trade.entryArmedDeliveryId })
            .then(() => refresh())
            .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
            .finally(() => setResendingId(null))
        },
      },
    ])
  }

  const ctSweepButton = user?.devMode && user.isAdmin ? (
    <Button
      small
      variant="secondary"
      title={ctSweeping ? 'Sweeping…' : 'CT sweep'}
      disabled={ctSweeping}
      onPress={() => {
        setCtSweeping(true)
        postJson('/api/journal/ct-sweep', {})
          .catch((e) => toastError(e instanceof Error ? e.message : 'Failed'))
          .finally(() => setCtSweeping(false))
      }}
    />
  ) : null

  if (isLoading && !tradeJournal) return <Spinner />

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={isSpinning} onRefresh={refresh} tintColor={colors.accent} />}
    >
      <View style={styles.topBar}>
        <Pressable onPress={() => setShowFilters((s) => !s)}>
          <Text style={styles.topLink}>{showFilters ? 'Hide account filter' : 'Filter accounts'}</Text>
        </Pressable>
      </View>

      {showFilters ? (
        <Card>
          <View style={styles.chipRow}>
            {allAccounts.map((a) => {
              const selected = selectedAccountIds.has(a.id)
              return (
                <Pressable
                  key={a.id}
                  onPress={() =>
                    setSelectedAccountIds((prev) => {
                      const next = new Set(prev)
                      if (selected) next.delete(a.id)
                      else next.add(a.id)
                      return next
                    })
                  }
                  style={[styles.chip, selected && styles.chipSelected]}
                >
                  <Text style={[styles.chipText, selected && { color: colors.text }]}>
                    {selected ? '✓ ' : ''}
                    {a.name}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </Card>
      ) : null}

      {serverCalendar?.summary ? (
        <MonthlyPerformanceMix
          overall={serverCalendar.summary}
          month={serverCalendar.summary}
          activeDays={(serverCalendar.days ?? []).filter((d) => (d.closedCount ?? 0) > 0).length}
        />
      ) : null}

      {/* Open Orders */}
      {openTrades.length === 0 ? (
        <Card>
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: 10 }}>
            <Text style={styles.dim}>No open trades.</Text>
            {ctSweepButton}
          </View>
        </Card>
      ) : (
        <CollapsibleSection
          storageKey="journal:openTrades:open"
          title={
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Open Orders</Text>
              {ctSweepButton}
            </View>
          }
        >
          <Text style={[styles.dim, { marginBottom: 8 }]}>Tap the price of a row to resend the order.</Text>
          {Array.from(openTradeCards.entries())
            .sort(([, a], [, b]) => {
              const aFilled = a.some((t) => t.eventType === 'entry_filled') ? 1 : 0
              const bFilled = b.some((t) => t.eventType === 'entry_filled') ? 1 : 0
              return bFilled - aFilled
            })
            .filter(([, rangeTrades]) =>
              rangeTrades.some((t) => t.eventType === 'entry_armed' || t.eventType === 'entry_filled'),
            )
            .map(([key, rangeTrades]) => {
              const rangeName = rangeTrades[0].rangeName
              const instrument = rangeTrades[0].instrument
              const liveTrades = rangeTrades.filter(
                (t) => t.eventType === 'entry_armed' || t.eventType === 'entry_filled',
              )
              const latestOccurredAt = liveTrades.reduce(
                (latest, t) => (t.occurredAt > latest ? t.occurredAt : latest),
                liveTrades[0]?.occurredAt ?? rangeTrades[0].occurredAt,
              )
              const hasFilled = rangeTrades.some((t) => t.eventType === 'entry_filled')
              const accountMap = rangeTrades.reduce((acc, t) => {
                if (!acc.has(t.accountId)) acc.set(t.accountId, [])
                acc.get(t.accountId)!.push(t)
                return acc
              }, new Map<string, TradeEvent[]>())
              return (
                <View
                  key={key}
                  style={[styles.openCard, hasFilled && { borderColor: 'rgba(52,211,153,0.5)' }]}
                >
                  <View style={styles.openCardHeader}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Pressable onPress={() => router.push(`/range-calendar?range=${encodeURIComponent(rangeName)}`)}>
                        <Text style={[styles.openCardTitle, hasFilled && { color: colors.positive }]}>{rangeName}</Text>
                      </Pressable>
                      <Text style={styles.daySub}>{displayInstrument(instrument)}</Text>
                    </View>
                    {hasFilled ? <View style={styles.filledDot} /> : null}
                    <JournalDate value={latestOccurredAt} />
                  </View>
                  {Array.from(accountMap)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .flatMap(([accountId, trades]) => {
                      const accountName = accountNames.get(accountId) ?? accountId
                      return trades
                        .slice()
                        .sort((a, b) => {
                          if (a.side === b.side) return 0
                          return a.side === 'long' ? -1 : 1
                        })
                        .map((trade) => {
                          const filled = trade.eventType === 'entry_filled'
                          const closed = trade.eventType === 'trade_closed'
                          const cancelled = trade.eventType === 'entry_cancelled'
                          const delivery = trade.entryArmedDeliveryStatus ?? 'unknown'
                          const resendable =
                            trade.entryArmedDeliveryId &&
                            (delivery === 'failed' || delivery === 'delivered' || delivery === 'blocked') &&
                            trade.entryArmedDeliveryDetail !== 'suppressed_duplicate' &&
                            !trade.bracketId?.startsWith('bridge-reapply-')
                          return (
                            <View
                              key={trade.id}
                              style={[styles.openRow, filled && { backgroundColor: 'rgba(6,78,59,0.4)' }]}
                            >
                              <Text style={[styles.openCell, { flex: 1.4 }]} numberOfLines={1}>{accountName}</Text>
                              <Text style={[styles.openCell, { flex: 0.8 }]}>{trade.side}</Text>
                              <Text style={[styles.openCell, { flex: 0.5 }]}>{formatQuantity(trade.quantity)}</Text>
                              <Pressable
                                style={{ flex: 1 }}
                                disabled={!resendable || resendingId === trade.id}
                                onPress={() => handleResend(trade)}
                              >
                                <Text
                                  style={[
                                    styles.openCell,
                                    { textAlign: 'right' },
                                    resendable && { color: colors.accent, textDecorationLine: 'underline' },
                                    delivery === 'failed' && resendable && { color: colors.negative },
                                  ]}
                                >
                                  {resendingId === trade.id
                                    ? '…'
                                    : trade.entryPrice == null
                                      ? '—'
                                      : formatPrice(trade.instrument, trade.entryPrice)}
                                </Text>
                              </Pressable>
                              <Pressable style={{ flex: 1.2 }} onPress={() => !cancelled && !closed && handleReconcile(trade)}>
                                <Text style={[styles.openCell, { textAlign: 'right' }]}>
                                  {cancelled
                                    ? 'Cancelled'
                                    : closed
                                      ? `Closed${trade.outcome ? ` (${trade.outcome})` : ''}`
                                      : filled
                                        ? 'Filled'
                                        : delivery === 'extension'
                                          ? 'Ext'
                                          : 'Armed'}
                                  {delivery === 'delivered' ? ' ✓' : delivery === 'failed' ? ' ✗' : ''}
                                </Text>
                                {delivery === 'blocked' ? (
                                  <Text style={[styles.daySub, { color: colors.amber, textAlign: 'right' }]}>Blocked</Text>
                                ) : null}
                              </Pressable>
                            </View>
                          )
                        })
                    })}
                  {rangeEntries[rangeName] != null ? (
                    <Text style={[styles.daySub, { marginTop: 6 }]}>
                      {rangeEntries[rangeName] === 1 ? 'OCO — one entry per range' : `${rangeEntries[rangeName]} entries per range`}
                    </Text>
                  ) : null}
                </View>
              )
            })}
        </CollapsibleSection>
      )}
      {/* Closed Trades */}
      <CollapsibleSection
        storageKey="journal:closedTrades:open"
        title={
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Closed Trades</Text>
          </View>
        }
      >
        <Pressable onPress={() => setShowClosedFilters((s) => !s)} style={{ marginBottom: 8 }}>
          <Text style={styles.topLink}>{showClosedFilters ? 'Hide filters' : 'Show filters'}</Text>
        </Pressable>
        {showClosedFilters ? (
          <View style={{ gap: 10, marginBottom: 10 }}>
            <Text style={styles.dim}>
              Use the Review column to flag a trade and remove it from your journal. It remains tracked on its range page.
            </Text>
            <SelectPicker label="Date" options={dateOptions} value={selectedDate} onChange={(v) => { setSelectedDate(v); setPage(1) }} />
            <SelectPicker label="Range" options={rangeOptions} value={selectedRange} onChange={(v) => { setSelectedRange(v); setPage(1) }} />
            <SelectPicker label="Outcome" options={OUTCOME_OPTIONS} value={selectedOutcome} onChange={(v) => { setSelectedOutcome(v); setPage(1) }} />
            <SelectPicker label="Instrument" options={instrumentOptions} value={selectedInstrument} onChange={(v) => { setSelectedInstrument(v); setPage(1) }} />
            <SelectPicker label="Exclusion" options={EXCLUSION_OPTIONS} value={selectedExclusion} onChange={(v) => { setSelectedExclusion(v); setPage(1) }} />
          </View>
        ) : null}

        {pageGroups.length === 0 ? (
          <Text style={styles.dim}>No closed trades match the selected filters.</Text>
        ) : (
          pageGroups.map((group) => {
            const expanded = expandedGroups.has(group.key)
            const instruments = new Set(group.trades.map((t) => t.instrument))
            const sides = new Set(group.trades.map((t) => t.side))
            const outcomes = new Set(group.trades.map((t) => t.outcome))
            const accounts = new Set(group.trades.map((t) => t.accountId))
            const pnlSum = group.trades.every((t) => t.realizedDollarsCents == null)
              ? null
              : group.trades.reduce((s, t) => s + (t.realizedDollarsCents ?? 0), 0)
            const tickSum = group.trades.every((t) => t.realizedTicksCents == null)
              ? null
              : group.trades.reduce((s, t) => s + (t.realizedTicksCents ?? 0), 0)
            const qtySum = group.trades.reduce((s, t) => s + (t.quantity ?? 0), 0)
            const singleOutcome = outcomes.size === 1 ? [...outcomes][0] : null
            return (
              <View key={group.key} style={styles.groupCard}>
                <Pressable onPress={() => toggleGroup(group.key)} style={styles.groupHeader}>
                  <View style={{ flex: 1 }}>
                    <JournalDate value={group.trades[0]!.occurredAt} />
                    <Pressable onPress={() => router.push(`/ranges?range=${encodeURIComponent(group.trades[0]!.rangeName)}`)}>
                      <Text style={styles.groupRange}>{group.trades[0]!.rangeName}</Text>
                    </Pressable>
                    <Text style={styles.daySub}>
                      {accounts.size} account{accounts.size === 1 ? '' : 's'} ·{' '}
                      {instruments.size === 1 ? displayInstrument([...instruments][0]) : 'Mixed'} ·{' '}
                      {sides.size === 1 ? [...sides][0] : 'Mixed'} · qty {formatQuantity(qtySum)}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Badge
                      status={
                        singleOutcome === 'win' ? 'online' : singleOutcome === 'loss' ? 'error' : 'offline'
                      }
                    >
                      {singleOutcome ?? 'Mixed'}
                    </Badge>
                    <Text style={[styles.groupPnl, { color: pnlColor(pnlSum ?? 0) }]}>
                      {pnlSum == null ? '—' : formatPnl(pnlSum)}
                    </Text>
                    <Text style={[styles.daySub, { color: pnlColor(tickSum ?? 0) }]}>
                      {tickSum == null ? '—' : formatTicks(tickSum)}
                    </Text>
                    <Text style={styles.daySub}>{expanded ? '▾' : '▸'}</Text>
                  </View>
                </Pressable>
                {expanded
                  ? group.trades.map((trade) => (
                      <ClosedTradeRow
                        key={trade.id}
                        trade={trade}
                        accountById={accountNames}
                        onUpdateExclusion={handleTradeExclusion}
                        onDelete={handleTradeDelete}
                      />
                    ))
                  : null}
              </View>
            )
          })
        )}
        {closedTradeGroups.length > 0 ? (
          <View style={styles.pager}>
            <Text style={styles.dim}>
              {pageStart + 1}-{Math.min(pageStart + PAGE_SIZE, closedTradeGroups.length)} of {closedTradeGroups.length} (
              {filteredTrades.length} trades)
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button small variant="ghost" title="Prev" disabled={effectivePage <= 1} onPress={() => setPage((p) => Math.max(1, p - 1))} />
              <Button small variant="ghost" title="Next" disabled={effectivePage >= pageCount} onPress={() => setPage((p) => Math.min(pageCount, p + 1))} />
            </View>
          </View>
        ) : null}
      </CollapsibleSection>
    </ScrollView>
  )
}

function ClosedTradeRow({
  trade,
  accountById,
  onUpdateExclusion,
  onDelete,
}: {
  trade: TradeEvent
  accountById: Map<string, string>
  onUpdateExclusion: (eventId: string, reason: 'test_data' | 'erroneous' | 'clear') => Promise<void>
  onDelete: (eventId: string) => void
}) {
  const [updating, setUpdating] = useState<string | null>(null)
  const handle = async (reason: 'test_data' | 'erroneous' | 'clear') => {
    setUpdating(reason)
    try {
      await onUpdateExclusion(trade.id, reason)
    } catch {
      setUpdating(null)
    }
  }
  return (
    <View style={styles.nestedRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.strong}>{accountById.get(trade.accountId) ?? trade.accountId}</Text>
        <Text style={styles.daySub}>
          {trade.side} · {trade.outcome ?? '—'} · qty {formatQuantity(trade.quantity)}
        </Text>
        <View style={{ alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          <Badge status={trade.excludedFromPerformance ? 'offline' : 'online'}>
            {trade.excludedFromPerformance ? 'Excluded' : 'Included'}
          </Badge>
          {(['test_data', 'erroneous', 'clear'] as const).map((reason) => (
            <Pressable key={reason} disabled={updating != null} onPress={() => void handle(reason)}>
              <Text style={[styles.reviewBtn, updating === reason && { opacity: 0.4 }]}>
                {updating === reason ? '…' : reason === 'test_data' ? 'Test' : reason === 'erroneous' ? 'Erroneous' : 'Clear'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: pnlColor(trade.realizedDollarsCents ?? 0), fontWeight: '600' }}>
          {trade.realizedDollarsCents == null ? '—' : formatPnl(trade.realizedDollarsCents)}
        </Text>
        <Text style={[styles.daySub, { color: pnlColor(trade.realizedTicksCents ?? 0) }]}>
          {trade.realizedTicksCents == null ? '—' : formatTicks(trade.realizedTicksCents)}
        </Text>
        <Pressable onPress={() => onDelete(trade.id)}>
          <Text style={{ color: colors.negative, fontSize: 14, marginTop: 4 }}>✕</Text>
        </Pressable>
      </View>
    </View>
  )
}


const styles = themedStyles((c) => StyleSheet.create({
  chip: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  chipSelected: { backgroundColor: c.border, borderColor: c.accent },
  chipText: { color: c.muted, fontSize: 13 },
  container: { backgroundColor: c.bg, flex: 1 },
  content: { padding: 12, paddingBottom: 40 },
  daySub: { color: c.muted, fontSize: 8 },
  dim: { color: c.muted, fontSize: 13 },
  filledDot: {
    backgroundColor: c.positive,
    borderRadius: 4,
    height: 8,
    marginRight: 6,
    width: 8,
  },
  groupCard: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  groupHeader: { flexDirection: 'row', padding: 10 },
  groupPnl: { fontSize: 16, fontWeight: '700' },
  groupRange: { color: c.accent, fontSize: 14, fontWeight: '600' },
  nestedRow: {
    borderTopColor: c.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    padding: 10,
  },
  openCard: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    padding: 10,
  },
  openCardHeader: { alignItems: 'center', flexDirection: 'row', marginBottom: 6 },
  openCardTitle: { color: c.text, fontSize: 14, fontWeight: '700' },
  openCell: { color: c.text, fontSize: 11 },
  openRow: {
    alignItems: 'center',
    backgroundColor: c.card,
    borderRadius: 6,
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pager: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  reviewBtn: { color: c.accent, fontSize: 11, fontWeight: '600' },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sectionTitle: { color: c.text, fontSize: 15, fontWeight: '700' },
  strong: { color: c.text, fontSize: 13, fontWeight: '600' },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  topLink: { color: c.muted, fontSize: 12 },
}))
