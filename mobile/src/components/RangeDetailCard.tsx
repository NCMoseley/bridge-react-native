import { useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { defaultRangeConfiguration } from '../utils/ranges'
import { modelColor } from '../utils/model-color'
import { formatDollars, formatPercent, formatTicks } from '../utils/format'
import type { RangeConfiguration, RangeSubcategory, SharedRangeDetail } from '../types'
import { Button, Field, Input, SelectPicker, colors, pnlColor } from './ui'
import { JournalDate } from './charts'

interface RangeDetailCardProps {
  range: SharedRangeDetail
  configuration: RangeConfiguration | undefined
  currentCategories: string[]
  subcategories: RangeSubcategory[]
  onAssignCategory: (rangeName: string, subcategoryName: string, assigned: boolean) => void
  onUpdateConfig: (rangeName: string, patch: Partial<RangeConfiguration>) => void
  onRename: (currentRangeName: string, newRangeName: string) => Promise<unknown>
  onFlagRange: (rangeName: string, flag: 'test_data' | 'erroneous' | 'clear') => Promise<unknown>
  onDelete: (rangeName: string) => Promise<unknown>
  compact?: boolean
}

function MetricPair({
  label,
  allTime,
  current,
  allTimeColor,
}: {
  label: string
  allTime: string
  current: string
  allTimeColor?: string
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.dim}>{label}</Text>
      <Text style={[styles.metricValue, allTimeColor ? { color: allTimeColor } : null]}>{allTime}</Text>
      <Text style={styles.dimSmall}>This week {current}</Text>
    </View>
  )
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 14 }}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      {children}
    </View>
  )
}

function parseCents(value: string): number | undefined {
  const normalized = value.trim()
  if (!normalized) return undefined
  const scaled = Number(normalized) * 100
  if (!Number.isFinite(scaled)) return undefined
  const rounded = Math.round(scaled)
  return Number.isSafeInteger(rounded) ? rounded : undefined
}

function formatCents(cents: number | undefined): string {
  return cents === undefined ? '' : (cents / 100).toFixed(2)
}

const DAYS: { label: string; key: keyof RangeConfiguration }[] = [
  { label: 'Mon', key: 'runMonday' },
  { label: 'Tue', key: 'runTuesday' },
  { label: 'Wed', key: 'runWednesday' },
  { label: 'Thu', key: 'runThursday' },
  { label: 'Fri', key: 'runFriday' },
  { label: 'Sat', key: 'runSaturday' },
  { label: 'Sun', key: 'runSunday' },
]

export function RangeDetailCard({
  range,
  configuration,
  currentCategories,
  subcategories,
  onAssignCategory,
  onUpdateConfig,
  onRename,
  onFlagRange,
  onDelete,
  compact = false,
}: RangeDetailCardProps) {
  const [edit, setEdit] = useState(false)
  const [draft, setDraft] = useState<RangeConfiguration | undefined>(configuration)
  const [rawNumeric, setRawNumeric] = useState({
    riskDollars: '',
    takeProfitTicks: '',
    stopLossTicks: '',
    breakEvenTriggerTicks: '',
    breakEvenOffsetTicks: '',
  })
  const [renameInput, setRenameInput] = useState(range.rangeName)
  const [working, setWorking] = useState<string | null>(null)

  const subscribedUsers = new Set(range.subscriptions.map((s) => s.user.id)).size
  const creatorSummary = range.createdBy
    ? `Created by ${range.createdBy.email} · ${subscribedUsers} user${subscribedUsers === 1 ? '' : 's'} · ${range.subscriptions.length} account route${range.subscriptions.length === 1 ? '' : 's'}`
    : `Tracked globally · ${subscribedUsers} user${subscribedUsers === 1 ? '' : 's'} · ${range.subscriptions.length} account route${range.subscriptions.length === 1 ? '' : 's'}`

  const handleCategoryToggle = (subcategoryName: string, assigned: boolean) => {
    void Promise.resolve(onAssignCategory(range.rangeName, subcategoryName, assigned))
  }

  const toggleRunDay = (day: keyof RangeConfiguration) => {
    const active = configuration ? Boolean(configuration[day]) : false
    onUpdateConfig(range.rangeName, { [day]: !active } as Partial<RangeConfiguration>)
  }

  const saveConfig = () => {
    if (!draft) return
    const next = { ...draft }
    const riskCents = parseCents(rawNumeric.riskDollars)
    if (riskCents !== undefined) next.riskDollarsCents = riskCents
    const takeCents = parseCents(rawNumeric.takeProfitTicks)
    if (takeCents !== undefined) next.takeProfitTicksCents = takeCents
    const stopCents = parseCents(rawNumeric.stopLossTicks)
    if (stopCents !== undefined) next.stopLossTicksCents = stopCents
    const beTrigger = parseCents(rawNumeric.breakEvenTriggerTicks)
    if (beTrigger !== undefined) next.breakEvenTriggerTicksCents = beTrigger
    const beOffset = parseCents(rawNumeric.breakEvenOffsetTicks)
    if (beOffset !== undefined) next.breakEvenOffsetTicksCents = beOffset
    onUpdateConfig(range.rangeName, next)
    setEdit(false)
  }

  const updateDraft = (patch: Partial<RangeConfiguration>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : undefined))
  }

  const handleRename = async () => {
    if (!renameInput.trim() || renameInput.trim() === range.rangeName) return
    setWorking('rename')
    try {
      await onRename(range.rangeName, renameInput.trim())
    } finally {
      setWorking(null)
    }
  }

  const allWinTicks = range.allTime.averageWinTicksCents == null ? '—' : formatTicks(range.allTime.averageWinTicksCents)
  const allLossTicks = range.allTime.averageLossTicksCents == null ? '—' : formatTicks(range.allTime.averageLossTicksCents)
  const weekWinTicks = range.currentWeek.averageWinTicksCents == null ? '—' : formatTicks(range.currentWeek.averageWinTicksCents)
  const weekLossTicks = range.currentWeek.averageLossTicksCents == null ? '—' : formatTicks(range.currentWeek.averageLossTicksCents)

  return (
    <View>
      <Section title="Models">
        {!compact ? (
          <Text style={[styles.dim, { marginBottom: 6 }]}>
            A range can belong to several models. Accounts routed through a model follow that model&rsquo;s per-range run days.
          </Text>
        ) : null}
        <View style={styles.chipRow}>
          {subcategories.map((s) => {
            const assigned = currentCategories.includes(s.name)
            return (
              <Pressable
                key={s.name}
                onPress={() => handleCategoryToggle(s.name, !assigned)}
                style={[styles.chip, assigned && styles.chipActive]}
              >
                <View style={[styles.dot, { backgroundColor: modelColor(s.name, subcategories) }]} />
                <Text style={[styles.chipText, assigned && { color: colors.accent }]}>{s.name}</Text>
              </Pressable>
            )
          })}
          {subcategories.length === 0 ? <Text style={styles.dim}>No models yet.</Text> : null}
        </View>
      </Section>

      {!compact ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          <MetricPair
            label="Net ticks"
            allTime={formatTicks(range.allTime.netTicksCents)}
            current={formatTicks(range.currentWeek.netTicksCents)}
            allTimeColor={pnlColor(range.allTime.netTicksCents)}
          />
          <MetricPair
            label="Closed / wins / losses"
            allTime={`${range.allTime.closedCount} / ${range.allTime.wins} / ${range.allTime.losses}`}
            current={`${range.currentWeek.closedCount} / ${range.currentWeek.wins} / ${range.currentWeek.losses}`}
          />
          <MetricPair
            label="Breakevens / win rate"
            allTime={`${range.allTime.breakevens} / ${formatPercent(range.allTime.winRate)}`}
            current={`${range.currentWeek.breakevens} / ${formatPercent(range.currentWeek.winRate)}`}
          />
          <MetricPair
            label="Avg win / loss ticks"
            allTime={`${allWinTicks} / ${allLossTicks}`}
            current={`${weekWinTicks} / ${weekLossTicks}`}
          />
        </View>
      ) : null}

      <Section title="Days of the week to run">
        <Text style={[styles.dim, { marginBottom: 6 }]}>
          These are the days that this range will be included in the schedule. When an account is subscribed with &quot;Only Scheduled&quot;, it will only take trades on these days.
        </Text>
        <View style={styles.chipRow}>
          {DAYS.map(({ label, key }) => {
            const active = configuration ? Boolean(configuration[key]) : false
            return (
              <Pressable
                key={key}
                onPress={() => toggleRunDay(key)}
                style={[styles.dayChip, active && styles.dayChipActive]}
              >
                <Text style={[styles.chipText, active && { color: '#fff' }]}>{label}</Text>
              </Pressable>
            )
          })}
        </View>
      </Section>

      <Section title="Range settings">
        {configuration ? (
          <View style={{ gap: 6 }}>
            {(
              [
                ['Instrument', configuration.instrument],
                ['Range window', configuration.rangeWindow],
                ['Trading session', configuration.tradingSession],
                ['Risk', formatDollars(configuration.riskDollarsCents)],
                ['Take profit', `${configuration.takeProfitStyle} · ${formatTicks(configuration.takeProfitTicksCents)}`],
                ['Stop loss', `${configuration.stopLossStyle} · ${formatTicks(configuration.stopLossTicksCents)}`],
                [
                  'Break-even',
                  configuration.breakEvenEnabled
                    ? `on · trigger ${formatTicks(configuration.breakEvenTriggerTicksCents)} · offset ${formatTicks(configuration.breakEvenOffsetTicksCents)}`
                    : 'off',
                ],
                ['Arm pairing', configuration.ocoMode === 'both' ? 'Both sides' : 'OCO pair'],
                ['Crossed-level entries', configuration.stopOnlyEntries ? 'Blocked' : 'Allowed'],
                ['Entries per range', String(configuration.entriesPerRange)],
                ['Description', configuration.description],
              ] as [string, string | undefined][]
            ).map(([label, value]) => (
              <View key={label} style={styles.settingRow}>
                <Text style={styles.dim}>{label}</Text>
                <Text style={styles.settingValue}>{value || '—'}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.dim}>No stored configuration found.</Text>
        )}
      </Section>

      <Section>
        <Text style={[styles.dim, { marginBottom: 6 }]}>
          These records are for reference but do control Bridge or Ultra functionality in some cases.
        </Text>
        {!edit ? (
          <Button
            small
            variant="secondary"
            title="Edit settings"
            onPress={() => {
              const base = draft ?? configuration ?? defaultRangeConfiguration(range.rangeName)
              setDraft(base)
              setRawNumeric({
                riskDollars: formatCents(base.riskDollarsCents),
                takeProfitTicks: formatCents(base.takeProfitTicksCents),
                stopLossTicks: formatCents(base.stopLossTicksCents),
                breakEvenTriggerTicks: formatCents(base.breakEvenTriggerTicksCents),
                breakEvenOffsetTicks: formatCents(base.breakEvenOffsetTicksCents),
              })
              setEdit(true)
            }}
          />
        ) : (
          <View>
            <Field label="Instrument">
              <Input value={draft?.instrument ?? ''} onChangeText={(v) => updateDraft({ instrument: v })} />
            </Field>
            <Field label="Range window (HHMM-HHMM)">
              <Input value={draft?.rangeWindow ?? ''} onChangeText={(v) => updateDraft({ rangeWindow: v })} />
            </Field>
            <Field label="Trading session">
              <Input value={draft?.tradingSession ?? ''} onChangeText={(v) => updateDraft({ tradingSession: v })} />
            </Field>
            <Field label="Risk ($)">
              <Input
                value={rawNumeric.riskDollars}
                onChangeText={(v) => setRawNumeric((p) => ({ ...p, riskDollars: v }))}
                keyboardType="decimal-pad"
              />
            </Field>
            <Field label="Take profit style">
              <Input value={draft?.takeProfitStyle ?? ''} onChangeText={(v) => updateDraft({ takeProfitStyle: v })} />
            </Field>
            <Field label="Take profit ticks">
              <Input
                value={rawNumeric.takeProfitTicks}
                onChangeText={(v) => setRawNumeric((p) => ({ ...p, takeProfitTicks: v }))}
                keyboardType="decimal-pad"
              />
            </Field>
            <Field label="Stop loss style">
              <Input value={draft?.stopLossStyle ?? ''} onChangeText={(v) => updateDraft({ stopLossStyle: v })} />
            </Field>
            <Field label="Stop loss ticks">
              <Input
                value={rawNumeric.stopLossTicks}
                onChangeText={(v) => setRawNumeric((p) => ({ ...p, stopLossTicks: v }))}
                keyboardType="decimal-pad"
              />
            </Field>
            <SelectPicker
              label="Break-even stop"
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ]}
              value={draft?.breakEvenEnabled ? 'on' : 'off'}
              onChange={(v) => updateDraft({ breakEvenEnabled: v === 'on' })}
            />
            <View style={{ height: 10 }} />
            <Field label="BE trigger ticks">
              <Input
                value={rawNumeric.breakEvenTriggerTicks}
                onChangeText={(v) => setRawNumeric((p) => ({ ...p, breakEvenTriggerTicks: v }))}
                keyboardType="decimal-pad"
              />
            </Field>
            <Field label="BE offset ticks">
              <Input
                value={rawNumeric.breakEvenOffsetTicks}
                onChangeText={(v) => setRawNumeric((p) => ({ ...p, breakEvenOffsetTicks: v }))}
                keyboardType="decimal-pad"
              />
            </Field>
            <SelectPicker
              label="Arm pairing"
              options={[
                { value: 'oco', label: 'OCO pair' },
                { value: 'both', label: 'Both sides' },
              ]}
              value={draft?.ocoMode ?? 'oco'}
              onChange={(v) => updateDraft({ ocoMode: v })}
            />
            <View style={{ height: 10 }} />
            <SelectPicker
              label="Crossed-level entries"
              options={[
                { value: 'off', label: 'Blocked — stop orders only (default)' },
                { value: 'on', label: 'Allow — may chase a crossed level' },
              ]}
              value={draft?.stopOnlyEntries ? 'off' : 'on'}
              onChange={(v) => updateDraft({ stopOnlyEntries: v === 'off' })}
            />
            <View style={{ height: 10 }} />
            <Field label="Entries per range">
              <Input
                value={String(draft?.entriesPerRange ?? '')}
                onChangeText={(v) => updateDraft({ entriesPerRange: Number(v) })}
                keyboardType="numeric"
              />
            </Field>
            <Field label="Description">
              <Input value={draft?.description ?? ''} onChangeText={(v) => updateDraft({ description: v })} multiline />
            </Field>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button small title="Save settings" onPress={saveConfig} />
              <Button
                small
                variant="ghost"
                title="Cancel"
                onPress={() => {
                  setDraft(configuration)
                  setEdit(false)
                }}
              />
            </View>
          </View>
        )}
      </Section>

      {!compact ? (
        <>
          <Section title="Subscribers">
            {range.subscriptions.length === 0 ? (
              <Text style={styles.dim}>
                No subscribers yet. Performance is still tracked from lifecycle results.
              </Text>
            ) : (
              range.subscriptions.map((sub, i) => (
                <View key={i} style={styles.subRow}>
                  <Text style={styles.settingValue}>{sub.user.email.substring(0, 10)}…</Text>
                  <Text style={styles.dim}>{sub.account.name}</Text>
                  <Text style={styles.dim}>Ext {sub.extensionEnabled ? 'on' : 'off'} · TP {sub.traderspostEnabled ? 'on' : 'off'}</Text>
                  <JournalDate value={sub.createdAt} />
                </View>
              ))
            )}
          </Section>
          <Text style={[styles.dim, { marginTop: 8 }]}>{creatorSummary}</Text>

          <Section title="Rename">
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}>
                <Input value={renameInput} onChangeText={setRenameInput} placeholder={range.rangeName} />
              </View>
              <Button
                small
                title={working === 'rename' ? 'Renaming…' : 'Rename'}
                disabled={working === 'rename'}
                onPress={() => void handleRename()}
              />
            </View>
          </Section>

          <Section title="Review">
            <Text style={[styles.dim, { marginBottom: 6 }]}>
              Manage this shared range. Deleting removes it from the working view.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <Button
                small
                variant={range.reviewFlag?.reason === 'test_data' ? 'primary' : 'ghost'}
                disabled={Boolean(working) || range.reviewFlag?.reason === 'test_data'}
                title={
                  working === 'flag-test_data'
                    ? 'Saving…'
                    : range.reviewFlag?.reason === 'test_data'
                      ? 'flagged as test data'
                      : 'Flag as test data'
                }
                onPress={async () => {
                  setWorking('flag-test_data')
                  try {
                    await onFlagRange(range.rangeName, 'test_data')
                  } finally {
                    setWorking(null)
                  }
                }}
              />
              <Button
                small
                variant={range.reviewFlag?.reason === 'erroneous' ? 'primary' : 'ghost'}
                disabled={Boolean(working) || range.reviewFlag?.reason === 'erroneous'}
                title={
                  working === 'flag-erroneous'
                    ? 'Saving…'
                    : range.reviewFlag?.reason === 'erroneous'
                      ? 'flagged as erroneous'
                      : 'Flag as erroneous'
                }
                onPress={async () => {
                  setWorking('flag-erroneous')
                  try {
                    await onFlagRange(range.rangeName, 'erroneous')
                  } finally {
                    setWorking(null)
                  }
                }}
              />
              {range.reviewFlag?.reason ? (
                <Button
                  small
                  variant="ghost"
                  disabled={Boolean(working)}
                  title={working === 'flag-clear' ? 'Saving…' : 'Clear flag'}
                  onPress={async () => {
                    setWorking('flag-clear')
                    try {
                      await onFlagRange(range.rangeName, 'clear')
                    } finally {
                      setWorking(null)
                    }
                  }}
                />
              ) : null}
            </View>
            <Button
              small
              variant="danger"
              disabled={Boolean(working)}
              title={working === 'delete' ? 'Deleting…' : 'Delete range'}
              onPress={() => {
                Alert.alert('Delete range', `Delete ${range.rangeName} and its stored history?`, [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => {
                      setWorking('delete')
                      void onDelete(range.rangeName).finally(() => setWorking(null))
                    },
                  },
                ])
              }}
            />
          </Section>
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  chip: {
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
  chipActive: { backgroundColor: 'rgba(99,102,241,0.12)', borderColor: '#6366f1' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chipText: { color: colors.muted, fontSize: 13 },
  dayChip: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dayChipActive: { backgroundColor: '#4f46e5', borderColor: '#4f46e5' },
  dim: { color: colors.muted, fontSize: 12 },
  dimSmall: { color: colors.faint, fontSize: 11 },
  dot: { borderRadius: 5, height: 10, width: 10 },
  metric: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: '47%',
    padding: 10,
  },
  metricValue: { color: colors.text, fontSize: 16, fontWeight: '700', marginVertical: 2 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  settingRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  settingValue: { color: colors.text, flexShrink: 1, fontSize: 13, textAlign: 'right' },
  subRow: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
})
