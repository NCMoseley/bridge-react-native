import { useState } from 'react'
import { Button } from './Button'
import { Input } from './Input'
import { LoadingSpinner } from './LoadingSpinner'
import { defaultRangeConfiguration } from '../utils/ranges'
import { modelColor } from '../utils/model-color'
import {
  classForCents,
  formatDollars,
  formatPercent,
  formatTicks,
} from '../utils/format'
import type {
  RangeConfiguration,
  RangeSubcategory,
  SharedRangeDetail,
} from '../types'
import { JournalDate } from '../components/JournalDate'

interface RangeDetailCardProps {
  range: SharedRangeDetail
  configuration: RangeConfiguration | undefined
  currentCategories: string[]
  subcategories: RangeSubcategory[]
  onAssignCategory: (rangeName: string, subcategoryName: string, assigned: boolean) => void
  onUpdateConfig: (rangeName: string, patch: Partial<RangeConfiguration>) => void
  onRename: (currentRangeName: string, newRangeName: string) => Promise<unknown>
  onFlagRange: (
    rangeName: string,
    flag: 'test_data' | 'erroneous' | 'clear',
  ) => Promise<unknown>
  onDelete: (rangeName: string) => Promise<unknown>
  compact?: boolean
}

function MetricPair({
  label,
  allTime,
  current,
  toneClass,
  allTimeToneClass,
}: {
  label: string
  allTime: string
  current: string
  toneClass?: string
  allTimeToneClass?: string
}) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm">
      <div className="text-slate-400">{label}</div>
      <div className={`mt-1 text-lg font-bold ${allTimeToneClass ?? 'text-slate-100'}`}>{allTime}</div>
      <div className={`text-xs ${toneClass ?? 'text-slate-400'}`}>
        This week {current}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-lg font-semibold text-slate-100">{title}</h3>
      {children}
    </div>
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

  const subscribedUsers = new Set(
    range.subscriptions.map((s) => s.user.id),
  ).size
  const creatorSummary = range.createdBy
    ? `Created by ${range.createdBy.email} · ${subscribedUsers} user${
        subscribedUsers === 1 ? '' : 's'
      } · ${range.subscriptions.length} account route${
        range.subscriptions.length === 1 ? '' : 's'
      }`
    : `Tracked globally · ${subscribedUsers} user${
        subscribedUsers === 1 ? '' : 's'
      } · ${range.subscriptions.length} account route${
        range.subscriptions.length === 1 ? '' : 's'
      }`

  const [modelPending, setModelPending] = useState(false)
  const handleCategoryToggle = (subcategoryName: string, checked: boolean) => {
    setModelPending(true)
    Promise.resolve(onAssignCategory(range.rangeName, subcategoryName, checked))
      .finally(() => setModelPending(false))
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
    const breakEvenTriggerCents = parseCents(rawNumeric.breakEvenTriggerTicks)
    if (breakEvenTriggerCents !== undefined) next.breakEvenTriggerTicksCents = breakEvenTriggerCents
    const breakEvenOffsetCents = parseCents(rawNumeric.breakEvenOffsetTicks)
    if (breakEvenOffsetCents !== undefined) next.breakEvenOffsetTicksCents = breakEvenOffsetCents
    onUpdateConfig(range.rangeName, next)
    setEdit(false)
  }

  const updateDraft = (patch: Partial<RangeConfiguration>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : undefined))
  }

  const handleRename = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!renameInput.trim() || renameInput.trim() === range.rangeName) return
    setWorking('rename')
    try {
      await onRename(range.rangeName, renameInput.trim())
    } finally {
      setWorking(null)
    }
  }

  const days: { label: string; key: keyof RangeConfiguration }[] = [
    { label: 'Mon', key: 'runMonday' },
    { label: 'Tue', key: 'runTuesday' },
    { label: 'Wed', key: 'runWednesday' },
    { label: 'Thu', key: 'runThursday' },
    { label: 'Fri', key: 'runFriday' },
    { label: 'Sat', key: 'runSaturday' },
    { label: 'Sun', key: 'runSunday' },
  ]

  const allWinTicks =
    range.allTime.averageWinTicksCents == null
      ? '—'
      : formatTicks(range.allTime.averageWinTicksCents)
  const allLossTicks =
    range.allTime.averageLossTicksCents == null
      ? '—'
      : formatTicks(range.allTime.averageLossTicksCents)
  const weekWinTicks =
    range.currentWeek.averageWinTicksCents == null
      ? '—'
      : formatTicks(range.currentWeek.averageWinTicksCents)
  const weekLossTicks =
    range.currentWeek.averageLossTicksCents == null
      ? '—'
      : formatTicks(range.currentWeek.averageLossTicksCents)

  return (
    <div className="space-y-6">
      <Section
        title={
          <span className="inline-flex items-center gap-2">
            Models
            {modelPending && <LoadingSpinner size={14} />}
          </span>
        }
      >
        {!compact && (
          <p className="mb-3 text-sm text-slate-400">
            A range can belong to several models. Accounts routed through a
            model follow that model's per-range run days.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {subcategories.map((s) => {
            const assigned = currentCategories.includes(s.name)
            return (
              <label
                key={s.name}
                className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  assigned
                    ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20'
                    : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500 hover:bg-slate-700 hover:text-slate-200'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={assigned}
                  onChange={(e) => handleCategoryToggle(s.name, e.target.checked)}
                />
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: modelColor(s.name, subcategories) }}
                />
                {s.name}
              </label>
            )
          })}
          {subcategories.length === 0 && (
            <span className="text-sm text-slate-500">No models yet.</span>
          )}
        </div>
      </Section>
      {!compact && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
        <MetricPair
          label="Net ticks"
          allTime={formatTicks(range.allTime.netTicksCents)}
          current={formatTicks(range.currentWeek.netTicksCents)}
          toneClass={classForCents(range.currentWeek.netTicksCents)}
          allTimeToneClass={classForCents(range.allTime.netTicksCents)}
        />
        <MetricPair
          label="Closed / wins / losses"
          allTime={`${range.allTime.closedCount} / ${range.allTime.wins} / ${range.allTime.losses}`}
          current={`${range.currentWeek.closedCount} / ${range.currentWeek.wins} / ${range.currentWeek.losses}`}
        />
        <MetricPair
          label="Breakevens / win rate"
          allTime={`${range.allTime.breakevens} / ${formatPercent(
            range.allTime.winRate,
          )}`}
          current={`${range.currentWeek.breakevens} / ${formatPercent(
            range.currentWeek.winRate,
          )}`}
        />
        <MetricPair
          label="Average win / loss ticks"
          allTime={`${allWinTicks} / ${allLossTicks}`}
          current={`${weekWinTicks} / ${weekLossTicks}`}
        />
          </div>

         
        </>
      )}

      <Section title="Days of the week to run">
        <p className="mb-3 text-sm text-slate-400">
          These are the days that this range will be included in the schedule. When an account is 
          subscibed with "Only Scheduled", it will only take trades on these days.
        </p>
        <div className="flex flex-wrap gap-2">
          {days.map(({ label, key }) => {
            const active = configuration ? Boolean(configuration[key]) : false
            return (
              <label
                key={key}
                className={`cursor-pointer rounded px-3 py-1.5 text-sm ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'border border-slate-700 bg-slate-900 text-slate-400'
                }`}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={active}
                  onChange={() => toggleRunDay(key)}
                />
                {label}
              </label>
            )
          })}
        </div>
      </Section>

      <Section title="Range settings">
        <p className="mb-3 text-sm text-slate-400">
          These are the saved reference settings for this range.
        </p>
        {configuration ? (
          <div className="grid gap-2 text-sm md:grid-cols-2">
            <div>
              <span className="text-slate-400">Instrument</span>
              <div className="text-slate-100">{configuration.instrument}</div>
            </div>
            <div>
              <span className="text-slate-400">Range window</span>
              <div className="text-slate-100">{configuration.rangeWindow}</div>
            </div>
            <div>
              <span className="text-slate-400">Trading session</span>
              <div className="text-slate-100">{configuration.tradingSession}</div>
            </div>
            <div>
              <span className="text-slate-400">Risk</span>
              <div className="text-slate-100">
                {formatDollars(configuration.riskDollarsCents)}
              </div>
            </div>
            <div>
              <span className="text-slate-400">Take profit</span>
              <div className="text-slate-100">
                {configuration.takeProfitStyle} · {formatTicks(configuration.takeProfitTicksCents)}
              </div>
            </div>
            <div>
              <span className="text-slate-400">Stop loss</span>
              <div className="text-slate-100">
                {configuration.stopLossStyle} · {formatTicks(configuration.stopLossTicksCents)}
              </div>
            </div>
            <div>
              <span className="text-slate-400">Break-even</span>
              <div className="text-slate-100">
                {configuration.breakEvenEnabled
                  ? `on · trigger ${formatTicks(configuration.breakEvenTriggerTicksCents)} · offset ${formatTicks(configuration.breakEvenOffsetTicksCents)}`
                  : 'off'}
              </div>
            </div>
            <div>
              <span className="text-slate-400">Arm pairing</span>
              <div className="text-slate-100">
                {configuration.ocoMode === 'both' ? 'Both sides' : 'OCO pair'}
              </div>
            </div>
            <div>
              <span className="text-slate-400">Crossed-level entries</span>
              <div className="text-slate-100">
                {configuration.stopOnlyEntries ? 'Blocked' : 'Allowed'}
              </div>
            </div>
            <div>
              <span className="text-slate-400">Entries per range</span>
              <div className="text-slate-100">{configuration.entriesPerRange}</div>
            </div>
            <div>
              <span className="text-slate-400">Description</span>
              <div className="text-slate-100">{configuration.description}</div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No stored configuration found.</p>
        )}
      </Section>

      <Section title="">
        <p className="mb-3 text-sm text-slate-400">
          These records are for reference but do control Bridge or Ultra 
          functionality in some cases.
        </p>
        {!edit ? (
          <div className="flex items-center gap-3">
            <Button onClick={() => {
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
            }}>Edit settings</Button>
            {configuration?.breakEvenEnabled && (
              <a
                href={`/app/api/ranges/${encodeURIComponent(range.rangeName)}/atm-template`}
                download
                className="rounded-lg border border-slate-700 bg-transparent px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
                title="Download the NT8 ATM template — drop it into Documents\NinjaTrader 8\templates\AtmStrategy\"
              >
                Download NT8 ATM template
              </a>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                label="Instrument"
                value={draft?.instrument ?? ''}
                onChange={(e) => updateDraft({ instrument: e.target.value })}
              />
              <Input
                label="Range window (HHMM-HHMM)"
                value={draft?.rangeWindow ?? ''}
                onChange={(e) => updateDraft({ rangeWindow: e.target.value })}
              />
              <Input
                label="Trading session"
                value={draft?.tradingSession ?? ''}
                onChange={(e) => updateDraft({ tradingSession: e.target.value })}
              />
              <Input
                label="Risk ($)"
                type="text"
                inputMode="decimal"
                value={rawNumeric.riskDollars}
                onChange={(e) =>
                  setRawNumeric((prev) => ({ ...prev, riskDollars: e.target.value }))
                }
                onBlur={() => {
                  const cents = parseCents(rawNumeric.riskDollars)
                  setRawNumeric((prev) => ({
                    ...prev,
                    riskDollars: cents === undefined ? prev.riskDollars : formatCents(cents),
                  }))
                  if (cents !== undefined) updateDraft({ riskDollarsCents: cents })
                }}
              />
              <Input
                label="Take profit style"
                value={draft?.takeProfitStyle ?? ''}
                onChange={(e) => updateDraft({ takeProfitStyle: e.target.value })}
              />
              <Input
                label="Take profit ticks"
                type="text"
                inputMode="decimal"
                value={rawNumeric.takeProfitTicks}
                onChange={(e) =>
                  setRawNumeric((prev) => ({ ...prev, takeProfitTicks: e.target.value }))
                }
                onBlur={() => {
                  const cents = parseCents(rawNumeric.takeProfitTicks)
                  setRawNumeric((prev) => ({
                    ...prev,
                    takeProfitTicks: cents === undefined ? prev.takeProfitTicks : formatCents(cents),
                  }))
                  if (cents !== undefined) updateDraft({ takeProfitTicksCents: cents })
                }}
              />
              <Input
                label="Stop loss style"
                value={draft?.stopLossStyle ?? ''}
                onChange={(e) => updateDraft({ stopLossStyle: e.target.value })}
              />
              <Input
                label="Stop loss ticks"
                type="text"
                inputMode="decimal"
                value={rawNumeric.stopLossTicks}
                onChange={(e) =>
                  setRawNumeric((prev) => ({ ...prev, stopLossTicks: e.target.value }))
                }
                onBlur={() => {
                  const cents = parseCents(rawNumeric.stopLossTicks)
                  setRawNumeric((prev) => ({
                    ...prev,
                    stopLossTicks: cents === undefined ? prev.stopLossTicks : formatCents(cents),
                  }))
                  if (cents !== undefined) updateDraft({ stopLossTicksCents: cents })
                }}
              />
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">
                  Break-even stop
                </label>
                <select
                  value={draft?.breakEvenEnabled ? 'on' : 'off'}
                  onChange={(e) => updateDraft({ breakEvenEnabled: e.target.value === 'on' })}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="off">Off</option>
                  <option value="on">On</option>
                </select>
              </div>
              <Input
                label="BE trigger ticks"
                type="text"
                inputMode="decimal"
                value={rawNumeric.breakEvenTriggerTicks}
                onChange={(e) =>
                  setRawNumeric((prev) => ({ ...prev, breakEvenTriggerTicks: e.target.value }))
                }
                onBlur={() => {
                  const cents = parseCents(rawNumeric.breakEvenTriggerTicks)
                  setRawNumeric((prev) => ({
                    ...prev,
                    breakEvenTriggerTicks: cents === undefined ? prev.breakEvenTriggerTicks : formatCents(cents),
                  }))
                  if (cents !== undefined) updateDraft({ breakEvenTriggerTicksCents: cents })
                }}
              />
              <Input
                label="BE offset ticks"
                type="text"
                inputMode="decimal"
                value={rawNumeric.breakEvenOffsetTicks}
                onChange={(e) =>
                  setRawNumeric((prev) => ({ ...prev, breakEvenOffsetTicks: e.target.value }))
                }
                onBlur={() => {
                  const cents = parseCents(rawNumeric.breakEvenOffsetTicks)
                  setRawNumeric((prev) => ({
                    ...prev,
                    breakEvenOffsetTicks: cents === undefined ? prev.breakEvenOffsetTicks : formatCents(cents),
                  }))
                  if (cents !== undefined) updateDraft({ breakEvenOffsetTicksCents: cents })
                }}
              />
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">
                  Arm pairing
                </label>
                <select
                  value={draft?.ocoMode ?? 'oco'}
                  onChange={(e) => updateDraft({ ocoMode: e.target.value as 'oco' | 'both' })}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="oco">OCO pair</option>
                  <option value="both">Both sides</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">
                  Crossed-level entries
                </label>
                <select
                  value={draft?.stopOnlyEntries ? 'off' : 'on'}
                  onChange={(e) => updateDraft({ stopOnlyEntries: e.target.value === 'off' })}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
                >
                  <option value="off">Blocked — stop orders only (default)</option>
                  <option value="on">Allow — may chase a crossed level</option>
                </select>
              </div>
              <Input
                label="Entries per range"
                type="number"
                value={draft?.entriesPerRange ?? ''}
                onChange={(e) =>
                  updateDraft({ entriesPerRange: Number(e.target.value) })
                }
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-300">
                Description
              </label>
              <textarea
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
                rows={3}
                value={draft?.description ?? ''}
                onChange={(e) => updateDraft({ description: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={saveConfig}>Save settings</Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(configuration)
                  setEdit(false)
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Section>

      {!compact && (
        <>
      <Section title="Subscribers">
        <p className="mb-3 text-sm text-slate-400">
          Who is enrolled, where the range routes, and who originally shared it
          when that information is available.
        </p>
        {range.subscriptions.length === 0 ? (
          <p className="text-sm text-slate-500">
            No subscribers yet. Performance is still tracked from lifecycle
            results.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="hidden sm:table-cell px-4 py-3">Extension</th>
                  <th className="hidden sm:table-cell px-4 py-3">Broker</th>
                  <th className="hidden sm:table-cell px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700">
                {range.subscriptions.map((sub, i) => (
                  <tr key={i}>
                    <td className="px-4 py-3 text-slate-100">
                      {sub.user.email.substring(0, 10)}{"..."}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {sub.account.name}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-slate-400">
                      {sub.extensionEnabled ? 'Enabled' : 'Disabled'}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-slate-400">
                      {sub.traderspostEnabled
                        ? sub.crossTradeEnabled
                          ? 'CrossTrade'
                          : 'TradersPost'
                        : 'Disabled'}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-slate-400">
                      <JournalDate value={sub.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="text-sm text-slate-400">{creatorSummary}</div>

      <form onSubmit={handleRename} className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input
          label="New name"
          value={renameInput}
          onChange={(e) => setRenameInput(e.target.value)}
          placeholder={range.rangeName}
          maxLength={256}
          disabled={working === 'rename'}
        />
        <Button type="submit" variant="primary" disabled={working === 'rename'}>
          {working === 'rename' ? 'Renaming…' : 'Rename range'}
        </Button>
      </form>

      <Section title="Review">
        <p className="mb-3 text-sm text-slate-400">
          Manage this shared range. Deleting removes it from the working view.
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant={range.reviewFlag?.reason === 'test_data' ? 'primary' : 'ghost'}
            disabled={Boolean(working) || range.reviewFlag?.reason === 'test_data'}
            onClick={async () => {
              setWorking('flag-test_data')
              try {
                await onFlagRange(range.rangeName, 'test_data')
              } finally {
                setWorking(null)
              }
            }}
          >
            {working === 'flag-test_data'
              ? 'Saving…'
              : range.reviewFlag?.reason === 'test_data'
                ? 'flagged as test data'
                : 'Flag as test data'}
          </Button>
          <Button
            type="button"
            variant={range.reviewFlag?.reason === 'erroneous' ? 'primary' : 'ghost'}
            disabled={Boolean(working) || range.reviewFlag?.reason === 'erroneous'}
            onClick={async () => {
              setWorking('flag-erroneous')
              try {
                await onFlagRange(range.rangeName, 'erroneous')
              } finally {
                setWorking(null)
              }
            }}
          >
            {working === 'flag-erroneous'
              ? 'Saving…'
              : range.reviewFlag?.reason === 'erroneous'
                ? 'flagged as erroneous'
                : 'Flag as erroneous'}
          </Button>
          {range.reviewFlag?.reason ?
          <Button
            type="button"
            variant="ghost"
            disabled={Boolean(working)}
            onClick={async () => {
              setWorking('flag-clear')
              try {
                await onFlagRange(range.rangeName, 'clear')
              } finally {
                setWorking(null)
              }
            }}
          >
            {working === 'flag-clear' ? 'Saving…' : 'Clear flag'}
          </Button>
          : null}
        </div>
        <Button
          variant="danger"
          disabled={Boolean(working)}
          onClick={async () => {
            if (confirm(`Delete ${range.rangeName} and its stored history?`)) {
              setWorking('delete')
              try {
                await onDelete(range.rangeName)
              } finally {
                setWorking(null)
              }
            }
          }}
        >
          {working === 'delete' ? 'Deleting…' : 'Delete range'}
        </Button>
      </Section>
        </>
      )}
    </div>
  )
}
