import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { getJson, postForm, postJson } from '../../api/client'
import { useAuth } from '../../context/AuthContext'
import { useToast } from '../../context/ToastContext'
import { onEvent } from '../../utils/events'
import {
  Badge,
  Button,
  Card,
  CollapsibleSection,
  Field,
  GaugeChart,
  Input,
  colors,
  pnlColor,
  toneForCents,
} from '../../components/ui'
import { EquityChart } from '../../components/charts'
import { RangeDetailCard } from '../../components/RangeDetailCard'
import { RedFolderMiniCalendar, RedFolderPanel } from '../../components/RedFolder'
import {
  buildRangeDaySchedule,
  currentJournalDateKey,
  currentJournalWeekday,
  defaultRangeConfiguration,
  describeRangeScheduleState,
  formatScheduleWindow,
  journalDateFromKey,
  rangeRunsOnWeekday,
  type RangeDaySchedule,
} from '../../utils/ranges'
import { classForCents as _cls, formatPnl, formatTicks } from '../../utils/format'
import { getDeepLifePath } from '../../utils/numerology'
import {
  getCachedRanges,
  getCachedRangesOptimistic,
  RANGES_CACHE_TTL_MS,
  setCachedRanges,
} from '../../utils/ranges-cache'
import { modelColor } from '../../utils/model-color'
import type {
  RangeConfiguration,
  RangeSubcategory,
  RangeSubcategoryAssignment,
  SharedRangeDetail,
  SharedRangeSubscription,
} from '../../types'

const HIGHLIGHT_CLOSE_MS = 30 * 60 * 1000

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'range'
}

function categoriesForRange(rangeName: string, assignments: RangeSubcategoryAssignment[]): string[] {
  const names = assignments
    .filter((a) => a.rangeName === rangeName)
    .map((a) => a.subcategoryName)
    .sort()
  return names.length > 0 ? names : ['Uncategorized']
}

function primaryCategoryForRange(rangeName: string, assignments: RangeSubcategoryAssignment[]): string {
  return categoriesForRange(rangeName, assignments)[0] ?? 'Uncategorized'
}

export function SubscriptionBadges({
  subscriptions,
  currentUserId,
}: {
  subscriptions: SharedRangeSubscription[]
  currentUserId?: string
}) {
  const filtered = currentUserId ? subscriptions.filter((sub) => sub.user.id === currentUserId) : subscriptions
  if (filtered.length === 0) return <Text style={styles.dim}>No subscriptions</Text>
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
      {filtered.map((sub) => (
        <View key={`${sub.account.id}-${sub.user.id}`} style={styles.subBadge}>
          <Text style={styles.dimSmall}>
            {sub.account.name}
            {sub.extensionEnabled ? ' · Ext' : ''}
            {sub.traderspostEnabled ? ' · TP' : ''}
          </Text>
        </View>
      ))}
    </View>
  )
}

function SubscriptionChip({ range }: { range: SharedRangeDetail }) {
  if (range.subscriptions.length === 0) return null
  return (
    <Text style={styles.dimSmall}>
      {range.subscriptions.map((s) => s.account.name).slice(0, 3).join(', ')}
      {range.subscriptions.length > 3 ? ` +${range.subscriptions.length - 3}` : ''}
    </Text>
  )
}

function UpcomingRangeCard({
  schedule,
  state,
  nowMs,
  onJump,
  configuration,
  subscriptions,
  currentUserId,
  isNext,
}: {
  schedule: RangeDaySchedule
  state: { state: string; status: string; countdown: string; countdownValue?: string }
  nowMs: number
  onJump: (rangeName: string) => void
  configuration?: RangeConfiguration
  subscriptions?: SharedRangeSubscription[]
  currentUserId?: string
  isNext?: boolean
}) {
  const isEndingSoon = state.state === 'active' && schedule.endAt - nowMs < HIGHLIGHT_CLOSE_MS
  const instrument = configuration?.instrument ?? schedule.instrument
  return (
    <View style={[styles.upcomingCard, isEndingSoon && { borderColor: colors.negative }]}>
      {isNext && state.state === 'upcoming' ? (
        <View style={styles.nextBadge}>
          <Text style={styles.nextBadgeText}>Next</Text>
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <Pressable onPress={() => onJump(schedule.rangeName)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
          <Text style={styles.upcomingName} numberOfLines={1}>{schedule.rangeName}</Text>
          {instrument ? (
            <View style={styles.instrumentBadge}>
              <Text style={styles.instrumentBadgeText}>{instrument}</Text>
            </View>
          ) : null}
        </Pressable>
        {subscriptions && subscriptions.length > 0 ? (
          <SubscriptionBadges subscriptions={subscriptions.map((sub) => ({ ...sub, modelName: undefined }))} currentUserId={currentUserId} />
        ) : (
          <Text style={styles.dimSmall}>No subscribed accounts.</Text>
        )}
        <View style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>
          <Text style={styles.dimSmall}>{formatScheduleWindow(schedule)}</Text>
          <Text style={styles.dimSmall}>
            {schedule.entriesPerRange} {schedule.entriesPerRange === 1 ? 'entry' : 'entries'} ·{' '}
            <Text style={{ color: state.state === 'active' ? colors.positive : colors.text, fontWeight: '600' }}>
              {state.status}
            </Text>{' '}
            <Text style={{ color: isEndingSoon ? colors.negative : colors.text }}>{state.countdown}</Text>
          </Text>
        </View>
      </View>
    </View>
  )
}

function RangeScheduleRow({ schedule, onJump }: { schedule: RangeDaySchedule; onJump: (rangeName: string) => void }) {
  const firedAt = new Date(schedule.startAt).toLocaleTimeString('en-US', {
    timeZone: 'Etc/GMT+4',
    hour: 'numeric',
    minute: '2-digit',
  })
  return (
    <View style={styles.scheduleRow}>
      <Pressable onPress={() => onJump(schedule.rangeName)}>
        <Text style={styles.upcomingName}>{schedule.rangeName}</Text>
      </Pressable>
      <Text style={styles.dimSmall}>Formed at {firedAt}</Text>
    </View>
  )
}

type SubcategoryDayKey =
  | 'runMonday' | 'runTuesday' | 'runWednesday' | 'runThursday'
  | 'runFriday' | 'runSaturday' | 'runSunday'

const MODEL_DAY_KEYS: { label: string; key: SubcategoryDayKey }[] = [
  { label: 'Mon', key: 'runMonday' },
  { label: 'Tue', key: 'runTuesday' },
  { label: 'Wed', key: 'runWednesday' },
  { label: 'Thu', key: 'runThursday' },
  { label: 'Fri', key: 'runFriday' },
  { label: 'Sat', key: 'runSaturday' },
  { label: 'Sun', key: 'runSunday' },
]

function ModelDayButtons({
  rangeName,
  model,
  assignment,
  configuration,
  onUpdateSchedule,
}: {
  rangeName: string
  model: string
  assignment: RangeSubcategoryAssignment | undefined
  configuration: RangeConfiguration | undefined
  onUpdateSchedule: (rangeName: string, subcategoryName: string, day: SubcategoryDayKey, value: boolean | null) => void
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 3 }}>
      {MODEL_DAY_KEYS.map(({ label, key }) => {
        const override = assignment?.[key]
        const inherited = Boolean(configuration?.[key])
        const effective = override == null ? inherited : override
        const next = override == null ? true : override ? false : null
        return (
          <Pressable
            key={key}
            onPress={() => onUpdateSchedule(rangeName, model, key, next)}
            style={[
              styles.modelDay,
              override == null
                ? effective
                  ? { borderColor: colors.border }
                  : { borderColor: colors.border, opacity: 0.5 }
                : effective
                  ? { borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.12)' }
                  : { borderColor: colors.border },
            ]}
          >
            <Text
              style={[
                styles.modelDayText,
                override != null && !effective && { textDecorationLine: 'line-through' },
                override != null && effective && { color: '#a5b4fc' },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function ModelEquity({ model }: { model: string }) {
  return <EquityChart label={model} query={`subcategory=${encodeURIComponent(model)}`} />
}

// Bars/columns/gauges performance chart for a set of ranges.
function RangeCategoryChart({
  ranges,
  scaleRanges,
  gaugeLabel,
  assignments,
  subcategories,
}: {
  category?: string
  ranges: SharedRangeDetail[]
  scaleRanges?: SharedRangeDetail[]
  gaugeLabel?: string
  assignments?: RangeSubcategoryAssignment[]
  subcategories?: RangeSubcategory[]
}) {
  const [view, setView] = useState<'bars' | 'columns' | 'gauges'>('bars')
  const effectiveView = view === 'gauges' && !gaugeLabel ? 'bars' : view
  const rows = useMemo(() => {
    const data = ranges
      .filter((r) => r.performanceAllTime.closedCount > 0 || r.performanceAllTime.netTicksCents !== 0)
      .map((r) => ({
        range: r,
        label: r.rangeName,
        descriptor: `${r.performanceAllTime.closedCount} trade${r.performanceAllTime.closedCount === 1 ? '' : 's'} · W/L ${r.performanceAllTime.wins}/${r.performanceAllTime.losses} · BE ${r.performanceAllTime.breakevens}`,
        value: r.performanceAllTime.netTicksCents,
        realizedDollarsCents: r.performanceAllTime.realizedDollarsCents,
        winTicksCents: (r.performanceAllTime.averageWinTicksCents ?? 0) * r.performanceAllTime.wins,
        lossTicksCents: (r.performanceAllTime.averageLossTicksCents ?? 0) * r.performanceAllTime.losses,
      }))
    data.sort((a, b) => b.value - a.value)
    return data
  }, [ranges])
  const scaleSource = scaleRanges ?? ranges
  const maxTicks = useMemo(
    () =>
      Math.max(
        1,
        ...scaleSource.map((r) =>
          Math.max(
            Math.abs((r.performanceAllTime.averageWinTicksCents ?? 0) * r.performanceAllTime.wins),
            Math.abs((r.performanceAllTime.averageLossTicksCents ?? 0) * r.performanceAllTime.losses),
          ),
        ),
      ),
    [scaleSource],
  )
  const maxPnl = useMemo(
    () => Math.max(1, ...scaleSource.map((r) => Math.abs(r.performanceAllTime.realizedDollarsCents))),
    [scaleSource],
  )

  if (rows.length === 0) {
    return (
      <Card>
        <Text style={styles.dim}>No performance to chart yet.</Text>
      </Card>
    )
  }

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text style={styles.sectionTitle}>Performance</Text>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          {(['bars', 'columns', 'gauges'] as const)
            .filter((v) => v !== 'gauges' || gaugeLabel)
            .map((v) => (
              <Pressable
                key={v}
                onPress={() => setView(v)}
                style={[styles.viewToggle, effectiveView === v && styles.viewToggleActive]}
              >
                <Text style={[styles.viewToggleText, effectiveView === v && { color: colors.text }]}>
                  {v === 'bars' ? 'Dollars / Ticks' : v === 'columns' ? 'Ticks' : 'Win rate'}
                </Text>
              </Pressable>
            ))}
        </View>
      </View>
      {effectiveView === 'gauges' && gaugeLabel ? <ModelGaugeGrid label={gaugeLabel} ranges={ranges} /> : null}
      {effectiveView === 'columns' ? (
        <NetTicksColumnChart ranges={ranges} assignments={assignments ?? []} subcategories={subcategories ?? []} />
      ) : null}
      {effectiveView === 'bars'
        ? rows.map((row) => {
            const lossWidth = row.lossTicksCents === 0 ? 0 : Math.max(6, Math.round((Math.abs(row.lossTicksCents) / maxTicks) * 100))
            const winWidth = row.winTicksCents === 0 ? 0 : Math.max(6, Math.round((Math.abs(row.winTicksCents) / maxTicks) * 100))
            const pnlWidth = row.realizedDollarsCents === 0 ? 0 : Math.max(6, Math.round((Math.abs(row.realizedDollarsCents) / maxPnl) * 100))
            return (
              <View key={row.label} style={styles.perfRow}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.upcomingName}>{row.label}</Text>
                  <Text style={styles.dimSmall}>{row.descriptor}</Text>
                </View>
                <Text style={[styles.perfPnl, { color: pnlColor(row.realizedDollarsCents) }]}>
                  {formatPnl(row.realizedDollarsCents)}
                </Text>
                <View style={styles.pnlBarTrack}>
                  <View style={styles.pnlBarMid} />
                  <View
                    style={[
                      styles.pnlBar,
                      row.realizedDollarsCents >= 0
                        ? { left: '50%', width: `${pnlWidth / 2}%`, backgroundColor: colors.positive }
                        : { right: '50%', width: `${pnlWidth / 2}%`, backgroundColor: colors.negative },
                    ]}
                  />
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={styles.tickTrack}>
                    <View style={{ backgroundColor: '#60a5fa', borderRadius: 999, height: '100%', width: `${winWidth}%` }} />
                  </View>
                  <Text style={[styles.tickLabel, { color: '#60a5fa' }]}>{formatTicks(row.winTicksCents)}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={styles.tickTrack}>
                    <View style={{ backgroundColor: '#c084fc', borderRadius: 999, height: '100%', width: `${lossWidth}%` }} />
                  </View>
                  <Text style={[styles.tickLabel, { color: '#c084fc' }]}>{formatTicks(row.lossTicksCents)}</Text>
                </View>
                <Text style={[styles.dimSmall, { textAlign: 'center', marginTop: 2 }]}>
                  Net ticks <Text style={{ color: row.value > 0 ? '#60a5fa' : row.value < 0 ? '#c084fc' : colors.text, fontWeight: '700' }}>{formatTicks(row.value)}</Text>
                </Text>
              </View>
            )
          })
        : null}
    </Card>
  )
}

function NetTicksColumnChart({
  ranges,
  assignments,
  subcategories,
}: {
  ranges: SharedRangeDetail[]
  assignments: RangeSubcategoryAssignment[]
  subcategories: RangeSubcategory[]
}) {
  const router = useRouter()
  const items = ranges
    .filter((r) => r.performanceAllTime.closedCount > 0 || r.performanceAllTime.netTicksCents !== 0)
    .map((r) => ({ label: r.rangeName, value: r.performanceAllTime.netTicksCents }))
    .sort((a, b) => a.label.localeCompare(b.label))
  if (items.length === 0) return <Text style={styles.dim}>No performance to chart yet.</Text>
  const maxAbs = Math.max(1, ...items.map((i) => Math.abs(i.value)))
  const track = 140
  const heightFor = (v: number) => Math.max(4, Math.round((Math.abs(v) / maxAbs) * track))
  const upH = Math.max(0, ...items.filter((i) => i.value >= 0).map((i) => heightFor(i.value))) + 12
  const downH = Math.max(0, ...items.filter((i) => i.value < 0).map((i) => heightFor(i.value))) + 4
  return (
    <ScrollView horizontal>
      <View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
          {items.map((item) => {
            const itemModels = categoriesForRange(item.label, assignments).filter((m) => m !== 'Uncategorized')
            const barColor = itemModels[0] ? modelColor(itemModels[0], subcategories) : '#38bdf8'
            return (
              <Pressable
                key={item.label}
                onPress={() => router.push(`/range-calendar?range=${encodeURIComponent(item.label)}`)}
                style={{ alignItems: 'center', width: 56 }}
              >
                <View style={{ height: upH, justifyContent: 'flex-end' }}>
                  {item.value >= 0 ? (
                    <View style={{ backgroundColor: barColor, borderTopLeftRadius: 3, borderTopRightRadius: 3, height: heightFor(item.value), width: 32 }} />
                  ) : null}
                </View>
                <View style={{ backgroundColor: colors.muted, height: 1, width: '100%' }} />
                <View style={{ height: downH }}>
                  {item.value < 0 ? (
                    <View style={{ backgroundColor: '#c084fc', borderBottomLeftRadius: 3, borderBottomRightRadius: 3, height: heightFor(item.value), width: 32 }} />
                  ) : null}
                </View>
                <Text numberOfLines={2} style={styles.columnLabel}>{item.label}</Text>
                <View style={{ flexDirection: 'row', gap: 2 }}>
                  {itemModels.map((m) => (
                    <View key={m} style={{ backgroundColor: modelColor(m, subcategories), borderRadius: 4, height: 8, width: 8 }} />
                  ))}
                </View>
              </Pressable>
            )
          })}
        </View>
      </View>
    </ScrollView>
  )
}

function ModelGaugeGrid({ label, ranges }: { label: string; ranges: SharedRangeDetail[] }) {
  const router = useRouter()
  const items = ranges
    .filter((r) => r.performanceAllTime.closedCount > 0)
    .map((r) => ({
      range: r,
      winRate: (r.performanceAllTime.wins / r.performanceAllTime.closedCount) * 100,
    }))
    .sort((a, b) => b.winRate - a.winRate)
  if (items.length === 0) return null
  return (
    <View>
      <Text style={[styles.dim, { marginBottom: 8, textTransform: 'uppercase' }]}>{label} — win rate</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-evenly', gap: 12 }}>
        {items.map(({ range, winRate }) => (
          <Pressable
            key={range.rangeName}
            onPress={() => router.push(`/range-calendar?range=${encodeURIComponent(range.rangeName)}`)}
            style={{ alignItems: 'center', width: 150 }}
          >
            <GaugeChart value={winRate} label={`${winRate.toFixed(1)}%`} size={130} />
            <Text style={styles.upcomingName}>{range.rangeName}</Text>
            <Text style={styles.dimSmall}>
              {range.performanceAllTime.closedCount} trades · W/L {range.performanceAllTime.wins}/{range.performanceAllTime.losses}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

function RangeCategorySection({
  category,
  ranges,
  assignments,
  onBulkDays,
  currentUserId,
  children,
}: {
  category: string
  ranges: SharedRangeDetail[]
  assignments: RangeSubcategoryAssignment[]
  open: boolean
  onToggle: () => void
  onBulkDays: (enabled: boolean) => void
  currentUserId?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const fullModelSubscriptions = useMemo(() => {
    if (!currentUserId || ranges.length === 0) return []
    const subs = ranges
      .flatMap((r) => r.subscriptions)
      .filter((s) => s.user.id === currentUserId && (s.modelNames ?? (s.modelName ? [s.modelName] : [])).includes(category))
    const byAccount = new Map<string, SharedRangeSubscription>()
    const rangeCountByAccount = new Map<string, number>()
    for (const sub of subs) {
      if (!byAccount.has(sub.account.id)) byAccount.set(sub.account.id, sub)
      rangeCountByAccount.set(sub.account.id, (rangeCountByAccount.get(sub.account.id) ?? 0) + 1)
    }
    const result: SharedRangeSubscription[] = []
    for (const [accountId, sub] of byAccount) {
      if (rangeCountByAccount.get(accountId) === ranges.length) result.push(sub)
    }
    return result
  }, [ranges, currentUserId, category])

  const modelDayFlags = useMemo(() => {
    const flags = ['runMonday', 'runTuesday', 'runWednesday', 'runThursday', 'runFriday', 'runSaturday', 'runSunday'] as const
    const enabled = ranges.length > 0 && ranges.every((range) => {
      const a = assignments.find((x) => x.rangeName === range.rangeName && x.subcategoryName === category)
      return a ? flags.every((flag) => a[flag] === true) : false
    })
    const disabled = ranges.length > 0 && ranges.every((range) => {
      const a = assignments.find((x) => x.rangeName === range.rangeName && x.subcategoryName === category)
      return a ? flags.every((flag) => a[flag] === false) : false
    })
    return { enabled, disabled }
  }, [ranges, assignments, category])

  const metrics = useMemo(
    () =>
      ranges.reduce(
        (acc, r) => {
          acc.netTicksCents += r.performanceAllTime.netTicksCents
          acc.closedCount += r.performanceAllTime.closedCount
          acc.wins += r.performanceAllTime.wins
          acc.losses += r.performanceAllTime.losses
          acc.breakevens += r.performanceAllTime.breakevens
          return acc
        },
        { netTicksCents: 0, closedCount: 0, wins: 0, losses: 0, breakevens: 0 },
      ),
    [ranges],
  )

  return (
    <View style={styles.categoryCard}>
      <Pressable onPress={() => setOpen((v) => !v)}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={styles.categoryTitle}>{category}</Text>
          <View style={styles.countBadge}>
            <Text style={styles.dimSmall}>{ranges.length}</Text>
          </View>
        </View>
        {fullModelSubscriptions.length > 0 ? (
          <SubscriptionBadges
            subscriptions={fullModelSubscriptions.map((sub) => ({ ...sub, modelName: undefined }))}
            currentUserId={currentUserId}
          />
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          <View style={styles.countBadge}>
            <Text style={[styles.dimSmall, { color: pnlColor(metrics.netTicksCents) }]}>{formatTicks(metrics.netTicksCents)}</Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={styles.dimSmall}>Trades {metrics.closedCount}</Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={styles.dimSmall}>
              W/L <Text style={{ color: colors.positive }}>{metrics.wins}</Text>/
              <Text style={{ color: colors.negative }}>{metrics.losses}</Text>
            </Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={styles.dimSmall}>BE {metrics.breakevens}</Text>
          </View>
          <View style={styles.countBadge}>
            <Text style={styles.dimSmall}>{open ? 'HIDE ▲' : 'SHOW ▼'}</Text>
          </View>
        </View>
      </Pressable>
      {open ? (
        <View style={{ borderTopColor: colors.border, borderTopWidth: 1, marginTop: 10, paddingTop: 10 }}>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
            <Button
              small
              variant="ghost"
              title={`${modelDayFlags.enabled ? '✓ ' : ''}Run all`}
              onPress={() => onBulkDays(true)}
            />
            <Button
              small
              variant="ghost"
              title={`${modelDayFlags.disabled ? '✗ ' : ''}Off all`}
              onPress={() => onBulkDays(false)}
            />
          </View>
          {children}
        </View>
      ) : null}
    </View>
  )
}

function SubcategoryManager({
  subcategories,
  onAdd,
  onRename,
  onRemove,
  onColor,
}: {
  subcategories: RangeSubcategory[]
  onAdd: (name: string) => void
  onRename: (currentName: string, nextName: string) => void
  onRemove: (name: string) => void
  onColor: (name: string, color: string | null) => void
}) {
  const [newName, setNewName] = useState('')
  const [renames, setRenames] = useState<Record<string, string>>({})
  return (
    <Card title="Models">
      <Text style={[styles.dim, { marginBottom: 8 }]}>
        Create reusable models, then assign them from each range card to compare grouped performance.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1 }}>
          <Input value={newName} onChangeText={setNewName} placeholder="JESUS FISH" />
        </View>
        <Button
          title="✓"
          onPress={() => {
            if (!newName.trim()) return
            onAdd(newName.trim())
            setNewName('')
          }}
        />
      </View>
      {subcategories.length === 0 ? (
        <Text style={styles.dim}>No models yet.</Text>
      ) : (
        subcategories.map((sub) => (
          <View key={sub.name} style={styles.modelRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{ backgroundColor: modelColor(sub.name, subcategories), borderRadius: 5, height: 10, width: 10 }} />
              <Text style={styles.upcomingName}>{sub.name}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
              <View style={{ flex: 1 }}>
                <Input
                  value={renames[sub.name] ?? sub.name}
                  onChangeText={(v) => setRenames((p) => ({ ...p, [sub.name]: v }))}
                />
              </View>
              <Button small variant="ghost" title="Rename" onPress={() => onRename(sub.name, (renames[sub.name] ?? sub.name).trim())} />
              {sub.color ? (
                <Button small variant="ghost" title="Reset color" onPress={() => onColor(sub.name, null)} />
              ) : null}
              <Button
                small
                variant="ghost"
                title="✕"
                onPress={() =>
                  Alert.alert('Delete model', `Delete the ${sub.name} model?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => onRemove(sub.name) },
                  ])
                }
              />
            </View>
          </View>
        ))
      )}
    </Card>
  )
}

function AddRangeForm({ onAdd }: { onAdd: (rangeName: string) => void }) {
  const [name, setName] = useState('')
  return (
    <Card title="Add range">
      <Text style={[styles.dim, { marginBottom: 8 }]}>
        Create a shared tracked range with only the exact range name. You can add routes and stored settings later.
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Input value={name} onChangeText={setName} placeholder="Opening Range" />
        </View>
        <Button
          title="✓"
          onPress={() => {
            if (!name.trim()) return
            onAdd(name.trim())
            setName('')
          }}
        />
      </View>
    </Card>
  )
}

export default function RangesScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams<{ range?: string }>()
  const [now, setNow] = useState<Date>(new Date())
  const [initialCached] = useState(() => getCachedRangesOptimistic())
  const [tracked, setTracked] = useState<SharedRangeDetail[]>(initialCached?.sharedRangeDetails ?? [])
  const [subcategories, setSubcategories] = useState<RangeSubcategory[]>(initialCached?.rangeSubcategories ?? [])
  const [assignments, setAssignments] = useState<RangeSubcategoryAssignment[]>(initialCached?.rangeSubcategoryAssignments ?? [])
  const [configs, setConfigs] = useState<Map<string, RangeConfiguration>>(
    () => new Map((initialCached?.rangeConfigurations ?? []).map((c) => [c.rangeName, c])),
  )
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set())
  const [appliedCategories, setAppliedCategories] = useState<Set<string>>(new Set())
  const [showSchedule, setShowSchedule] = useState(true)
  const [ready, setReady] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const { success, error } = useToast()
  const [openRange, setOpenRange] = useState<string | null>(null)
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const currentUserId = user?.userId ?? ''
  const currentUserIdRef = useRef('')
  currentUserIdRef.current = currentUserId

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const refresh = useCallback(() => {
    setFetching(true)
    return getJson<{
      sharedRangeDetails: SharedRangeDetail[]
      rangeSubcategories: RangeSubcategory[]
      rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
      rangeConfigurations: RangeConfiguration[]
    }>('/api/ranges')
      .then((data) => {
        setTracked(data.sharedRangeDetails)
        setSubcategories(data.rangeSubcategories)
        setAssignments(data.rangeSubcategoryAssignments)
        setConfigs(new Map(data.rangeConfigurations.map((c) => [c.rangeName, c])))
        setCachedRanges(data, currentUserIdRef.current)
      })
      .catch(() => {})
      .finally(() => {
        setFetching(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    if (!currentUserId) return
    const cached = getCachedRanges(currentUserId)
    if (cached) {
      setTracked(cached.sharedRangeDetails)
      setSubcategories(cached.rangeSubcategories)
      setAssignments(cached.rangeSubcategoryAssignments)
      setConfigs(new Map(cached.rangeConfigurations.map((c) => [c.rangeName, c])))
      if (cached.fetchedAt && Date.now() - cached.fetchedAt < RANGES_CACHE_TTL_MS) return
    }
    void refresh()
  }, [currentUserId, refresh])

  useEffect(() => onEvent('journal:refresh', () => void refresh()), [refresh])

  useEffect(() => {
    if (subcategories.length === 0 || ready) return
    const all = new Set(subcategories.map((s) => s.name))
    setSelectedCategories(all)
    setAppliedCategories(all)
    setReady(true)
  }, [subcategories, ready])

  // Deep link: ?range=<name> expands that range's detail card.
  const deepLinked = useRef(false)
  useEffect(() => {
    if (!ready || deepLinked.current || tracked.length === 0) return
    const target = params.range
    if (!target) return
    const match = tracked.find((r) => r.rangeName.toLowerCase() === target.toLowerCase())
    if (!match) return
    deepLinked.current = true
    setOpenRange(match.rangeName)
  }, [ready, tracked, params.range])

  const todayDateKey = useMemo(() => currentJournalDateKey(now), [now])
  const todayDateLabel = useMemo(
    () =>
      journalDateFromKey(todayDateKey).toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: 'Etc/GMT+4',
      }),
    [todayDateKey],
  )
  const todayLifePath = useMemo(() => getDeepLifePath(todayDateKey).lifePathNumber, [todayDateKey])
  const todayWeekday = useMemo(() => currentJournalWeekday(now), [now])
  const nowMs = now.getTime()

  const categories = useMemo(() => {
    const set = new Set(Array.from(configs.values()).flatMap((c) => categoriesForRange(c.rangeName, assignments)))
    return subcategories.filter((s) => set.has(s.name)).map((s) => s.name)
  }, [subcategories, assignments, configs])

  const todaySchedules = useMemo(() => {
    return Array.from(configs.values())
      .filter((configuration) => rangeRunsOnWeekday(configuration, todayWeekday))
      .map((configuration) => buildRangeDaySchedule(configuration, todayDateKey))
      .filter((schedule): schedule is RangeDaySchedule => Boolean(schedule))
      .sort((a, b) => a.startAt - b.startAt || a.rangeName.localeCompare(b.rangeName))
  }, [todayDateKey, todayWeekday, configs])

  const scheduleStates = useMemo(
    () =>
      new Map(
        todaySchedules.map((schedule) => [
          schedule.rangeName,
          describeRangeScheduleState(schedule.startAt, schedule.endAt, nowMs),
        ]),
      ),
    [todaySchedules, nowMs],
  )

  const filteredSchedules = useMemo(() => {
    if (appliedCategories.size === 0) return todaySchedules
    return todaySchedules.filter((schedule) =>
      categoriesForRange(schedule.rangeName, assignments).some((cat) => appliedCategories.has(cat)),
    )
  }, [todaySchedules, appliedCategories, assignments])

  const { upcoming, completed } = useMemo(() => {
    const up = filteredSchedules
      .filter((s) => s.endAt >= nowMs)
      .sort((a, b) => {
        const aState = scheduleStates.get(a.rangeName)!
        const bState = scheduleStates.get(b.rangeName)!
        const aRank = aState.state === 'active' ? 0 : 1
        const bRank = bState.state === 'active' ? 0 : 1
        return aRank - bRank || a.endAt - b.endAt || a.startAt - b.startAt || a.rangeName.localeCompare(b.rangeName)
      })
    const comp = todaySchedules
      .filter((s) => s.endAt < nowMs)
      .sort((a, b) => a.startAt - b.startAt || a.rangeName.localeCompare(b.rangeName))
    return { upcoming: up, completed: comp }
  }, [filteredSchedules, todaySchedules, scheduleStates, nowMs])

  const groupedRanges = useMemo(() => {
    const map = new Map<string, SharedRangeDetail[]>()
    for (const range of tracked) {
      for (const cat of categoriesForRange(range.rangeName, assignments)) {
        const list = map.get(cat) ?? []
        list.push(range)
        map.set(cat, list)
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.rangeName.localeCompare(b.rangeName))
    const ordered = subcategories.filter((s) => map.has(s.name)).map((s) => [s.name, map.get(s.name)!] as const)
    const seen = new Set(ordered.map(([name]) => name))
    const extra = [...map.keys()].filter((name) => !seen.has(name)).sort()
    for (const name of extra) ordered.push([name, map.get(name)!])
    return ordered
  }, [tracked, assignments, subcategories])

  const rangeByName = useMemo(() => new Map(tracked.map((range) => [range.rangeName, range])), [tracked])

  const handleAddRange = (rangeName: string) => {
    const existing = tracked.find((r) => r.rangeName.toLowerCase() === rangeName.trim().toLowerCase())
    if (existing) {
      error(`Range "${existing.rangeName}" already exists`)
      return
    }
    postForm('/tracked-ranges', { rangeName })
      .then(() => {
        refresh()
        success('Range added')
      })
      .catch((err) => error((err as { reason?: string })?.reason ?? 'Failed to add range'))
  }

  const handleAssignCategory = (rangeName: string, subcategoryName: string, assigned: boolean) => {
    postForm('/range-subcategory-assignments', {
      rangeName,
      subcategoryName: subcategoryName === 'Uncategorized' ? '' : subcategoryName,
      mode: assigned ? 'add' : 'remove',
      timeframe: 'all',
    })
      .then(() => {
        refresh()
        success(assigned ? 'Model added' : 'Model removed')
      })
      .catch(() => error('Failed to update model membership'))
  }

  const handleUpdateSubcategorySchedule = (
    rangeName: string,
    subcategoryName: string,
    day: SubcategoryDayKey,
    value: boolean | null,
  ) => {
    postJson('/api/range-subcategory-schedule', { rangeName, subcategoryName, [day]: value })
      .then((res) => res.json() as Promise<RangeSubcategoryAssignment>)
      .then((saved) => {
        setAssignments((prev) => {
          const next = prev.filter(
            (a) => !(a.rangeName === saved.rangeName && a.subcategoryName === saved.subcategoryName),
          )
          next.push(saved)
          return next
        })
        success('Model day schedule saved')
      })
      .catch(() => error('Failed to update model day schedule'))
  }

  const dayFlagRegex = /^(runSunday|runMonday|runTuesday|runWednesday|runThursday|runFriday|runSaturday)$/
  const handleUpdateConfig = (rangeName: string, patch: Partial<RangeConfiguration>) => {
    const previous = new Map(configs)
    const current = previous.get(rangeName)
    const isDayPatch = Object.keys(patch).some(
      (k) => dayFlagRegex.test(k) && current && current[k as keyof RangeConfiguration] !== patch[k as keyof RangeConfiguration],
    )
    setConfigs((prev) => {
      const cur = prev.get(rangeName)
      const next = new Map(prev)
      if (!cur) {
        next.set(rangeName, { ...defaultRangeConfiguration(rangeName), ...patch })
      } else {
        next.set(rangeName, { ...cur, ...patch, updatedAt: new Date().toISOString() })
      }
      return next
    })
    postJson('/api/range-configurations/patch', { rangeName, ...patch })
      .then((res) => res.json() as Promise<RangeConfiguration>)
      .then((saved) => {
        setConfigs((prev) => new Map(prev).set(rangeName, saved))
        success(isDayPatch ? 'Run days saved' : 'Range settings saved')
      })
      .catch(() => {
        setConfigs(previous)
        error(isDayPatch ? 'Failed to save run days' : 'Failed to save range settings')
      })
  }

  const handleBulkDays = (subcategoryName: string, enabled: boolean) => {
    const targetCategory = subcategoryName || 'Uncategorized'
    const isModel = targetCategory !== 'Uncategorized'
    const previousConfigs = new Map(configs)
    const previousAssignments = [...assignments]
    if (isModel) {
      setAssignments((prev) =>
        prev.map((a) =>
          a.subcategoryName === targetCategory
            ? {
                ...a,
                runMonday: enabled,
                runTuesday: enabled,
                runWednesday: enabled,
                runThursday: enabled,
                runFriday: enabled,
                runSaturday: enabled,
                runSunday: enabled,
                updatedAt: new Date().toISOString(),
              }
            : a,
        ),
      )
    } else {
      setConfigs((prev) => {
        const next = new Map(prev)
        for (const range of tracked) {
          if (!categoriesForRange(range.rangeName, assignments).includes(targetCategory)) continue
          const current = next.get(range.rangeName)
          if (!current) continue
          next.set(range.rangeName, {
            ...current,
            runMonday: enabled,
            runTuesday: enabled,
            runWednesday: enabled,
            runThursday: enabled,
            runFriday: enabled,
            runSaturday: enabled,
            runSunday: enabled,
            updatedAt: new Date().toISOString(),
          })
        }
        return next
      })
    }
    postJson('/api/range-configurations/bulk-days', {
      subcategoryName: subcategoryName === 'Uncategorized' ? '' : subcategoryName,
      enabled,
    })
      .then((res) => res.json() as Promise<{ updated: number; rangeNames: string[] }>)
      .then((result) => {
        refresh()
        if (result.updated === 0) {
          error('No ranges were updated — check the category assignment')
          return
        }
        success(
          enabled
            ? `All days enabled for ${result.updated} range${result.updated === 1 ? '' : 's'}`
            : `All days disabled for ${result.updated} range${result.updated === 1 ? '' : 's'}`,
        )
      })
      .catch(() => {
        setConfigs(previousConfigs)
        setAssignments(previousAssignments)
        error('Failed to update run days')
      })
  }

  const handleDelete = (rangeName: string) => {
    return postForm('/ranges/delete', { rangeName })
      .then(() => refresh())
      .then(() => success('Range deleted'))
      .catch(() => error('Failed to delete range'))
  }

  const handleRenameRange = (currentRangeName: string, newRangeName: string) => {
    return postForm('/ranges/rename', { currentRangeName, newRangeName })
      .then(() => refresh())
      .then(() => success('Range renamed'))
      .catch(() => error('Failed to rename range'))
  }

  const handleFlagRange = (rangeName: string, flag: 'test_data' | 'erroneous' | 'clear') => {
    return postForm('/range-review-flags', {
      rangeName,
      testData: flag === 'test_data' ? 'true' : undefined,
      erroneous: flag === 'erroneous' ? 'true' : undefined,
    })
      .then(() => refresh())
      .then(() => success('Review flag updated'))
      .catch(() => error('Failed to update review flag'))
  }

  const handleAddSubcategory = (name: string) => {
    postForm('/range-subcategories', { name })
      .then(() => {
        refresh()
        success('Model added')
      })
      .catch(() => error('Failed to add model'))
  }

  const handleRenameSubcategory = (currentName: string, nextName: string) => {
    postForm('/range-subcategories/rename', { currentName, newName: nextName })
      .then(() => {
        refresh()
        success('Model renamed')
      })
      .catch(() => error('Failed to rename model'))
  }

  const handleSetSubcategoryColor = (name: string, color: string | null) => {
    postForm('/range-subcategories/color', { name, color: color ?? '' })
      .then(() => {
        refresh()
        success('Model color updated')
      })
      .catch(() => error('Failed to set model color'))
  }

  const handleDeleteSubcategory = (name: string) => {
    postForm('/range-subcategories/delete', { name })
      .then(() => {
        refresh()
        success('Model deleted')
      })
      .catch(() => error('Failed to delete model'))
  }

  const handleJump = (rangeName: string) => {
    setOpenRange(rangeName)
  }

  const toggleCategory = (name: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  // All-ranges directory filtering
  const sortedRanges = [...tracked].sort((a, b) => a.rangeName.localeCompare(b.rangeName))
  const visibleRanges = selectedModels.size === 0
    ? sortedRanges
    : sortedRanges.filter((range) =>
        categoriesForRange(range.rangeName, assignments).some((m) => selectedModels.has(m)),
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
            void refresh()
          }}
          tintColor={colors.accent}
        />
      }
    >
      <RedFolderMiniCalendar />

      <Card>
        <Pressable onPress={() => setShowSchedule((p) => !p)} style={styles.scheduleHeader}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={styles.sectionTitle}>{todayDateLabel}</Text>
              <View style={styles.lpBadge}>
                <Text style={styles.lpText}>LP {todayLifePath}</Text>
              </View>
            </View>
            <RedFolderPanel />
            {upcoming.length > 0 ? (
              !showSchedule ? (
                <Text style={[styles.dimSmall, { color: colors.positive, marginTop: 4 }]}>
                  {upcoming[0].rangeName}{' '}
                  {scheduleStates.get(upcoming[0].rangeName)!.state === 'active'
                    ? 'is forming now'
                    : `in ${scheduleStates.get(upcoming[0].rangeName)!.countdownValue}`}
                </Text>
              ) : null
            ) : (
              <Text style={[styles.dim, { marginTop: 4 }]}>No more ranges today</Text>
            )}
          </View>
          <Text style={styles.dim}>{showSchedule ? 'Hide ▲' : 'Show ▼'}</Text>
        </Pressable>

        {showSchedule ? (
          <View style={{ marginTop: 8 }}>
            {upcoming.length === 0 && completed.length === 0 ? (
              <Text style={styles.dim}>No ranges today.</Text>
            ) : null}
            {upcoming.map((schedule, index) => (
              <UpcomingRangeCard
                key={schedule.rangeName}
                schedule={schedule}
                state={scheduleStates.get(schedule.rangeName)!}
                nowMs={nowMs}
                onJump={handleJump}
                configuration={configs.get(schedule.rangeName)}
                subscriptions={rangeByName.get(schedule.rangeName)?.subscriptions}
                currentUserId={currentUserId}
                isNext={index === 0}
              />
            ))}
            {completed.length > 0 ? (
              <View style={{ marginTop: 10 }}>
                <Text style={[styles.dimSmall, { marginBottom: 4, textTransform: 'uppercase' }]}>
                  Ranges taken earlier today
                </Text>
                {completed.map((schedule) => (
                  <RangeScheduleRow key={schedule.rangeName} schedule={schedule} onJump={handleJump} />
                ))}
              </View>
            ) : null}
            {categories.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                {categories
                  .filter((cat) => cat !== 'Evaluation')
                  .map((cat) => (
                    <Pressable
                      key={cat}
                      onPress={() => toggleCategory(cat)}
                      style={[styles.catChip, selectedCategories.has(cat) && styles.catChipActive]}
                    >
                      <Text style={[styles.dimSmall, selectedCategories.has(cat) && { color: '#a5b4fc' }]}>{cat}</Text>
                    </Pressable>
                  ))}
                <Button small title="✓" onPress={() => setAppliedCategories(new Set(selectedCategories))} />
              </View>
            ) : null}
          </View>
        ) : null}
      </Card>

      <CollapsibleSection title={<Text style={styles.sectionTitle}>Model Library</Text>} storageKey="ranges:section:library">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Expand a range to review its global performance, subscribers, and stored settings. Performance values are in ticks.
        </Text>
        {groupedRanges.length === 0 ? (
          <Text style={styles.dim}>No shared ranges are tracked yet.</Text>
        ) : null}
        {groupedRanges
          .filter(([category]) => category !== 'Uncategorized')
          .map(([category, ranges]) => (
            <RangeCategorySection
              key={category}
              category={category}
              ranges={ranges}
              assignments={assignments}
              open={false}
              onToggle={() => {}}
              onBulkDays={(enabled) => handleBulkDays(category, enabled)}
              currentUserId={currentUserId}
            >
              <View style={styles.modelRangeList}>
                {ranges.map((range) => {
                  const assignment = assignments.find(
                    (a) => a.rangeName === range.rangeName && a.subcategoryName === category,
                  )
                  return (
                    <View key={range.rangeName} style={styles.modelRangeRow}>
                      <Text style={styles.upcomingName}>{range.rangeName}</Text>
                      <SubscriptionChip range={range} />
                      <ModelDayButtons
                        rangeName={range.rangeName}
                        model={category}
                        assignment={assignment}
                        configuration={configs.get(range.rangeName)}
                        onUpdateSchedule={handleUpdateSubcategorySchedule}
                      />
                      <Pressable
                        style={{ marginLeft: 'auto' }}
                        onPress={() => handleAssignCategory(range.rangeName, category, false)}
                      >
                        <Text style={{ color: colors.negative, fontSize: 16 }}>×</Text>
                      </Pressable>
                    </View>
                  )
                })}
              </View>
              <ModelEquity model={category} />
            </RangeCategorySection>
          ))}
      </CollapsibleSection>

      <CollapsibleSection title={<Text style={styles.sectionTitle}>All Ranges</Text>} storageKey="ranges:section:allRanges">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Every tracked range. Filter by model to narrow the list — expand a row for full detail and membership editing.
        </Text>
        {subcategories.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {subcategories.map((s) => (
              <Pressable
                key={s.name}
                onPress={() =>
                  setSelectedModels((prev) => {
                    const next = new Set(prev)
                    if (next.has(s.name)) next.delete(s.name)
                    else next.add(s.name)
                    return next
                  })
                }
                style={[styles.catChip, selectedModels.has(s.name) && styles.catChipActive]}
              >
                <View style={{ backgroundColor: modelColor(s.name, subcategories), borderRadius: 5, height: 10, width: 10 }} />
                <Text style={[styles.dimSmall, selectedModels.has(s.name) && { color: '#a5b4fc' }]}>{s.name}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {visibleRanges.length === 0 ? (
          <Text style={styles.dim}>No ranges match.</Text>
        ) : (
          visibleRanges.map((range) => (
            <View key={range.rangeName} style={styles.rangeItem}>
              <CollapsibleSection
                title={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <View style={styles.rangeAvatar}>
                      <Text style={styles.rangeAvatarText}>{range.rangeName[0]?.toUpperCase()}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Pressable onPress={() => router.push(`/range-calendar?range=${encodeURIComponent(range.rangeName)}`)}>
                          <Text style={styles.upcomingName}>{range.rangeName}</Text>
                        </Pressable>
                        {categoriesForRange(range.rangeName, assignments)
                          .filter((m) => m !== 'Uncategorized')
                          .map((m) => (
                            <View key={m} style={{ backgroundColor: modelColor(m, subcategories), borderRadius: 5, height: 10, width: 10 }} />
                          ))}
                      </View>
                      <SubscriptionBadges subscriptions={range.subscriptions} currentUserId={currentUserId} />
                      <Text style={styles.dimSmall}>
                        All time <Text style={{ color: pnlColor(range.allTime.netTicksCents) }}>{formatTicks(range.allTime.netTicksCents)}</Text>
                        {'  '}Week <Text style={{ color: pnlColor(range.currentWeek.netTicksCents) }}>{formatTicks(range.currentWeek.netTicksCents)}</Text>
                        {'  '}Closed {range.allTime.closedCount} · W/L {range.allTime.wins}/{range.allTime.losses}
                      </Text>
                    </View>
                  </View>
                }
                open={openRange === range.rangeName}
                storageKey={undefined}
              >
                <RangeDetailCard
                  range={range}
                  configuration={configs.get(range.rangeName)}
                  currentCategories={categoriesForRange(range.rangeName, assignments)}
                  subcategories={subcategories}
                  onAssignCategory={handleAssignCategory}
                  onUpdateConfig={handleUpdateConfig}
                  onRename={handleRenameRange}
                  onFlagRange={handleFlagRange}
                  onDelete={handleDelete}
                  compact
                />
              </CollapsibleSection>
              {openRange === range.rangeName ? null : null}
            </View>
          ))
        )}
        <RangeCategoryChart
          category="Filtered ranges"
          ranges={visibleRanges}
          scaleRanges={tracked}
          gaugeLabel={selectedModels.size === 1 ? [...selectedModels][0] : undefined}
          assignments={assignments}
          subcategories={subcategories}
        />
      </CollapsibleSection>

      <CollapsibleSection title={<Text style={styles.sectionTitle}>Manage Ranges and Models</Text>} storageKey="ranges:section:manage" defaultOpen={false}>
        <AddRangeForm onAdd={handleAddRange} />
        <SubcategoryManager
          subcategories={subcategories}
          onAdd={handleAddSubcategory}
          onRename={handleRenameSubcategory}
          onRemove={handleDeleteSubcategory}
          onColor={handleSetSubcategoryColor}
        />
      </CollapsibleSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  catChip: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  catChipActive: { backgroundColor: 'rgba(99,102,241,0.12)', borderColor: '#6366f1' },
  categoryCard: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 10,
    padding: 12,
  },
  categoryTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  columnLabel: {
    color: colors.muted,
    fontSize: 9,
    fontWeight: '600',
    height: 28,
    marginTop: 4,
    textAlign: 'center',
  },
  container: { backgroundColor: colors.bg, flex: 1 },
  countBadge: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  dim: { color: colors.muted, fontSize: 12 },
  dimSmall: { color: colors.muted, fontSize: 11 },
  instrumentBadge: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  instrumentBadgeText: { color: colors.text, fontSize: 10, fontWeight: '700' },
  lpBadge: {
    backgroundColor: 'rgba(99,102,241,0.12)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  lpText: { color: '#818cf8', fontSize: 12, fontWeight: '700' },
  modelDay: {
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  modelDayText: { color: colors.muted, fontSize: 9, fontWeight: '700' },
  modelRangeList: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
  },
  modelRangeRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    padding: 8,
  },
  modelRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  nextBadge: {
    backgroundColor: colors.negative,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    position: 'absolute',
    right: 8,
    top: -8,
  },
  nextBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', textTransform: 'uppercase' },
  perfPnl: { fontSize: 16, fontWeight: '700', marginTop: 4 },
  perfRow: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
    padding: 10,
  },
  pnlBar: { borderRadius: 999, position: 'absolute', top: 0, bottom: 0 },
  pnlBarMid: {
    backgroundColor: colors.muted,
    bottom: 0,
    left: '50%',
    position: 'absolute',
    top: 0,
    width: 1,
  },
  pnlBarTrack: {
    backgroundColor: colors.card,
    borderRadius: 999,
    height: 10,
    marginVertical: 6,
    overflow: 'hidden',
  },
  rangeAvatar: {
    alignItems: 'center',
    backgroundColor: colors.border,
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  rangeAvatarText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  rangeItem: { marginBottom: 6 },
  scheduleHeader: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 10,
  },
  scheduleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  subBadge: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tickLabel: { fontSize: 11, fontWeight: '700', width: 70, textAlign: 'right' },
  tickTrack: {
    backgroundColor: colors.card,
    borderRadius: 999,
    flex: 1,
    height: 8,
    overflow: 'hidden',
  },
  upcomingCard: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 2,
    marginTop: 8,
    padding: 10,
  },
  upcomingName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  viewToggle: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  viewToggleActive: { backgroundColor: 'rgba(99,102,241,0.2)' },
  viewToggleText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
})
