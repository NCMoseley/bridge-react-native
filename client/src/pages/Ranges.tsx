import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { Input } from '../components/Input'
import { Button } from '../components/Button'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { RedFolderMiniCalendar } from '../components/RedFolderMiniCalendar'
import { RedFolderPanel } from '../components/RedFolderPanel'
import { RangeDetailCard } from '../components/RangeDetailCard'
import { EquityChart } from '../components/ModelEquityChart'
import { GaugeChart } from '../components/GaugeChart'
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
  type RangeScheduleState,
} from '../utils/ranges'
import { tradingViewInstrumentIconUrl } from '../utils/instruments'
import {
  classForCents,
  formatPnl,
  formatTicks,
} from '../utils/format'
import { getDeepLifePath } from '../utils/numerology'
import { useToast } from '../context/ToastContext'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { getCachedRanges, getCachedRangesOptimistic, RANGES_CACHE_TTL_MS, setCachedRanges } from '../utils/ranges-cache'
import { scrollToElement } from '../utils/scroll'
import { getJson, postForm, postJson } from '../api/client'
import { modelColor } from '../utils/model-color'
import type {
  RangeConfiguration,
  RangeSubcategory,
  RangeSubcategoryAssignment,
  SharedRangeDetail,
  SharedRangeSubscription,
} from '../types'

const HIGHLIGHT_CLOSE_MS = 30 * 60 * 1000

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'range'
}

// A range can belong to several models — returns every model it is a member
// of (sorted, 'Uncategorized' when it has none).
function categoriesForRange(
  rangeName: string,
  assignments: RangeSubcategoryAssignment[],
): string[] {
  const names = assignments
    .filter((a) => a.rangeName === rangeName)
    .map((a) => a.subcategoryName)
    .sort()
  return names.length > 0 ? names : ['Uncategorized']
}

function primaryCategoryForRange(
  rangeName: string,
  assignments: RangeSubcategoryAssignment[],
): string {
  return categoriesForRange(rangeName, assignments)[0] ?? 'Uncategorized'
}





function RangeCategoryChart({
  category: _category,
  ranges,
  scaleRanges,
  gaugeLabel,
  assignments,
  subcategories,
}: {
  category: string
  ranges: SharedRangeDetail[]
  /** Unfiltered set used to calibrate bar widths — keeps the scale absolute
      so filtering doesn't stretch a weaker range to full width. */
  scaleRanges?: SharedRangeDetail[]
  /** Model name when a single model is selected — enables the Gauges
      position on the view toggle. */
  gaugeLabel?: string
  /** Model memberships — used to tint/dot the column-chart labels. */
  assignments?: RangeSubcategoryAssignment[]
  /** Model definitions — `color` overrides the hashed fallback. */
  subcategories?: RangeSubcategory[]
}) {
  const [view, setView] = useState<'bars' | 'columns' | 'gauges'>('bars')
  const effectiveView = view === 'gauges' && !gaugeLabel ? 'bars' : view
  const cardRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLDivElement>(null)
  const toggleTop = useRef<number | null>(null)
  // View changes can grow the card a lot — pin the toggle's viewport position
  // so the button doesn't move under the user's cursor.
  const switchView = (v: 'bars' | 'columns' | 'gauges') => {
    toggleTop.current = toggleRef.current?.getBoundingClientRect().top ?? null
    setView(v)
  }
  useLayoutEffect(() => {
    if (toggleTop.current === null || !toggleRef.current) return
    const delta = toggleRef.current.getBoundingClientRect().top - toggleTop.current
    toggleTop.current = null
    if (Math.abs(delta) > 1) window.scrollBy(0, delta)
  }, [effectiveView])
  const rows = useMemo(() => {
    const data = ranges
      .filter(
        (r) =>
          r.performanceAllTime.closedCount > 0 ||
          r.performanceAllTime.netTicksCents !== 0,
      )
      .map((r) => ({
        range: r,
        label: r.rangeName,
        descriptor: `${r.performanceAllTime.closedCount} trade${
          r.performanceAllTime.closedCount === 1 ? '' : 's'
        } · W/L ${r.performanceAllTime.wins}/${
          r.performanceAllTime.losses
        } · BE ${r.performanceAllTime.breakevens}`,
        value: r.performanceAllTime.netTicksCents,
        wins: r.performanceAllTime.wins,
        losses: r.performanceAllTime.losses,
        breakevens: r.performanceAllTime.breakevens,
        closedCount: r.performanceAllTime.closedCount,
        realizedDollarsCents: r.performanceAllTime.realizedDollarsCents,
        winTicksCents:
          (r.performanceAllTime.averageWinTicksCents ?? 0) *
          r.performanceAllTime.wins,
        lossTicksCents:
          (r.performanceAllTime.averageLossTicksCents ?? 0) *
          r.performanceAllTime.losses,
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
            Math.abs(
              (r.performanceAllTime.averageWinTicksCents ?? 0) *
                r.performanceAllTime.wins,
            ),
            Math.abs(
              (r.performanceAllTime.averageLossTicksCents ?? 0) *
                r.performanceAllTime.losses,
            ),
          ),
        ),
      ),
    [scaleSource],
  )
  const maxPnl = useMemo(
    () =>
      Math.max(
        1,
        ...scaleSource.map((r) =>
          Math.abs(r.performanceAllTime.realizedDollarsCents),
        ),
      ),
    [scaleSource],
  )

  if (rows.length === 0) {
    return (
      <div className="my-4 rounded-xl border border-slate-700 bg-slate-800 px-2 py-5 sm:p-5 text-center text-sm text-slate-400">
        No performance to chart yet.
      </div>
    )
  }

  return (
    <div ref={cardRef} className="my-4 rounded-2xl border border-slate-700/50 bg-gradient-to-br from-slate-800 to-slate-900 px-2 py-5 sm:p-5 shadow-lg">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold text-slate-100">
            Performance
          </h3>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs text-slate-300">
          {effectiveView === 'bars' && (
            <>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-gradient-to-r from-blue-400 to-blue-500" />
                Win ticks
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-gradient-to-r from-purple-400 to-purple-500" />
                Loss ticks
              </span>
            </>
          )}
          <div ref={toggleRef} className="flex gap-1 rounded-lg border border-slate-700 bg-slate-950/40 p-1">
            {(['bars', 'columns', 'gauges'] as const).filter((v) => v !== 'gauges' || gaugeLabel).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => switchView(v)}
                className={`rounded-md px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                  view === v
                    ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent'
                }`}
              >
                {v === 'bars' ? 'Dollars / Ticks' : v === 'columns' ? 'Ticks' : 'Win rate'}
              </button>
            ))}
          </div>
        </div>
      </div>
      {effectiveView === 'gauges' && gaugeLabel ? (
        <ModelGaugeGrid label={gaugeLabel} ranges={ranges} />
      ) : null}
      {effectiveView === 'columns' ? (
        <NetTicksColumnChart ranges={ranges} assignments={assignments ?? []} subcategories={subcategories ?? []} />
      ) : null}
      {effectiveView !== 'bars' ? null : (<>

      <div className="overflow-x-auto">
        <div
          className="hidden sm:grid gap-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400"
          style={{ gridTemplateColumns: '1.4fr 0.6fr 1fr' }}
        >
          <span>Range / net P&L</span>
          <span className="text-center">Net ticks</span>
          <span className="text-right">Win / loss ticks</span>
        </div>

        <div className="space-y-2">
          {rows.map((row) => {
            const lossWidth =
              row.lossTicksCents === 0
                ? 0
                : Math.max(
                    6,
                    Math.round((Math.abs(row.lossTicksCents) / maxTicks) * 100),
                  )
            const winWidth =
              row.winTicksCents === 0
                ? 0
                : Math.max(
                    6,
                    Math.round((Math.abs(row.winTicksCents) / maxTicks) * 100),
                  )
            const netValueClass =
              row.value > 0
                ? 'text-blue-400'
                : row.value < 0
                  ? 'text-purple-500'
                  : 'text-slate-200'
            const pnlClass = classForCents(row.realizedDollarsCents)

            const pnlWidth =
              row.realizedDollarsCents === 0
                ? 0
                : Math.max(
                    6,
                    Math.round(
                      (Math.abs(row.realizedDollarsCents) / maxPnl) * 100,
                    ),
                  )

            return (
              <Fragment key={row.label}>
               <div
                className="hidden md:grid items-center gap-4 rounded-xl border border-slate-700/30 bg-slate-800/50 px-3 py-2"
                style={{ gridTemplateColumns: '1.4fr 0.6fr 1fr' }}
              >
                <div>
                  <div className="flex flex-row flex-wrap items-center gap-2">
                    <Link
                      to={`/app/ranges/calendar?range=${encodeURIComponent(row.label)}`}
                      className="font-bold text-slate-100 hover:text-indigo-400 hover:underline"
                    >
                      {row.label}
                    </Link>
                    <div className="text-xs text-slate-400">{row.descriptor}</div>
                  </div>
                  <div className="mt-2">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      {/* <span className="text-slate-500">Net P&L</span> */}
                      <span className={`font-semibold text-lg ${pnlClass}`}>
                        {formatPnl(row.realizedDollarsCents)}
                      </span>
                    </div>
                    <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]">
                      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-500" />
                      {row.realizedDollarsCents >= 0 ? (
                        <div
                          className="absolute top-0 bottom-0 h-full rounded-full bg-gradient-to-r from-emerald-500 to-positive-400 shadow-[0_0_10px_rgba(52,211,153,0.35)]"
                          style={{ left: '50%', width: `${pnlWidth}%` }}
                        />
                      ) : (
                        <div
                          className="absolute top-0 bottom-0 h-full rounded-full bg-gradient-to-l from-negative-400 to-negative-500 shadow-[0_0_10px_rgba(248,113,113,0.35)]"
                          style={{ right: '50%', width: `${pnlWidth}%` }}
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="text-center">
                  <div className="sm:hidden text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Net ticks
                  </div>
                  <div className={`text-lg font-bold ${netValueClass}`}>
                    {formatTicks(row.value)}
                  </div>
                </div>

                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <div className="hidden md:block h-2.5 w-full overflow-hidden rounded-full bg-slate-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-500 shadow-[0_0_10px_rgba(96,165,250,0.35)]"
                        style={{ width: `${winWidth}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-sm font-semibold text-blue-400">
                      {formatTicks(row.winTicksCents)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="hidden md:block h-2.5 w-full overflow-hidden rounded-full bg-slate-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-purple-400 to-purple-500 shadow-[0_0_10px_rgba(192,132,252,0.35)]"
                        style={{ width: `${lossWidth}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-sm font-semibold text-purple-400">
                      {formatTicks(row.lossTicksCents)}
                    </span>
                  </div>
                </div>
              </div>

              <div
                className="md:hidden grid items-center gap-4 rounded-xl border border-slate-700/30 bg-slate-800/50 px-3 py-2"
              >
                <div>
                  <div className="flex flex-row flex-wrap items-center gap-2">
                    <Link
                      to={`/app/ranges/calendar?range=${encodeURIComponent(row.label)}`}
                      className="font-bold text-slate-100 hover:text-indigo-400 hover:underline"
                    >
                      {row.label}
                    </Link>
                    <div className="text-xs text-slate-400">{row.descriptor}</div>
                  </div>
                  <div className="mt-2">
                    <div className="mb-1 flex items-center justify-between text-xs">
                      {/* <span className="text-slate-500">Net P&L</span> */}
                      <span className={`font-semibold text-lg ${pnlClass}`}>
                        {formatPnl(row.realizedDollarsCents)}
                      </span>
                    </div>
                    <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]">
                      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-500" />
                      {row.realizedDollarsCents >= 0 ? (
                        <div
                          className="absolute top-0 bottom-0 h-full rounded-full bg-gradient-to-r from-emerald-500 to-positive-400 shadow-[0_0_10px_rgba(52,211,153,0.35)]"
                          style={{ left: '50%', width: `${pnlWidth}%` }}
                        />
                      ) : (
                        <div
                          className="absolute top-0 bottom-0 h-full rounded-full bg-gradient-to-l from-negative-400 to-negative-500 shadow-[0_0_10px_rgba(248,113,113,0.35)]"
                          style={{ right: '50%', width: `${pnlWidth}%` }}
                        />
                      )}
                    </div>
                  </div>
                </div>

                <div className="text-center">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                    Net ticks
                  </div>
                  <div className={`text-lg font-bold ${netValueClass}`}>
                    {formatTicks(row.value)}
                  </div>
                </div>

                <div className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-blue-400 to-blue-500 shadow-[0_0_10px_rgba(96,165,250,0.35)]"
                        style={{ width: `${winWidth}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-sm font-semibold text-blue-400">
                      {formatTicks(row.winTicksCents)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-900 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-purple-400 to-purple-500 shadow-[0_0_10px_rgba(192,132,252,0.35)]"
                        style={{ width: `${lossWidth}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-sm font-semibold text-purple-400">
                      {formatTicks(row.lossTicksCents)}
                    </span>
                  </div>
                </div>
              </div>
              </Fragment>
            )
          })}
        </div>
      </div>
      </>)}
    </div>
  )
}

function RangeCategorySection({
  category,
  ranges,
  assignments,
  open,
  onToggle,
  onBulkDays,
  currentUserId,
  fetching = false,
  children,
}: {
  category: string
  ranges: SharedRangeDetail[]
  assignments: RangeSubcategoryAssignment[]
  open: boolean
  onToggle: (anchor?: HTMLElement) => void
  onBulkDays: (enabled: boolean) => void
  currentUserId?: string
  fetching?: boolean
  children: React.ReactNode
}) {
  const fullModelSubscriptions = useMemo(() => {
    if (!currentUserId || ranges.length === 0) return []
    const subs = ranges
      .flatMap((r) => r.subscriptions)
      .filter((s) =>
        s.user.id === currentUserId &&
        (s.modelNames ?? (s.modelName ? [s.modelName] : [])).includes(category),
      )
    const byAccount = new Map<string, SharedRangeSubscription>()
    const rangeCountByAccount = new Map<string, number>()
    for (const sub of subs) {
      if (!byAccount.has(sub.account.id)) byAccount.set(sub.account.id, sub)
      rangeCountByAccount.set(
        sub.account.id,
        (rangeCountByAccount.get(sub.account.id) ?? 0) + 1,
      )
    }
    const result: SharedRangeSubscription[] = []
    for (const [accountId, sub] of byAccount) {
      if (rangeCountByAccount.get(accountId) === ranges.length) {
        result.push(sub)
      }
    }
    return result
  }, [ranges, currentUserId, category])

  // The bulk-day indicators read the MODEL's assignment day flags — the
  // ranges' own run_* configs stay untouched by model-level bulk updates.
  const modelDayFlags = useMemo(() => {
    const flags = [
      'runMonday', 'runTuesday', 'runWednesday', 'runThursday',
      'runFriday', 'runSaturday', 'runSunday',
    ] as const
    const enabled = ranges.length > 0 && ranges.every((range) => {
      const a = assignments.find(
        (x) => x.rangeName === range.rangeName && x.subcategoryName === category,
      )
      return a ? flags.every((flag) => a[flag] === true) : false
    })
    const disabled = ranges.length > 0 && ranges.every((range) => {
      const a = assignments.find(
        (x) => x.rangeName === range.rangeName && x.subcategoryName === category,
      )
      return a ? flags.every((flag) => a[flag] === false) : false
    })
    return { enabled, disabled }
  }, [ranges, assignments, category])
  const allDaysEnabled = modelDayFlags.enabled
  const allDaysDisabled = modelDayFlags.disabled

  const metrics = useMemo(() => {
    return ranges.reduce(
      (acc, r) => {
        acc.netTicksCents += r.performanceAllTime.netTicksCents
        acc.closedCount += r.performanceAllTime.closedCount
        acc.wins += r.performanceAllTime.wins
        acc.losses += r.performanceAllTime.losses
        acc.breakevens += r.performanceAllTime.breakevens
        return acc
      },
      {
        netTicksCents: 0,
        closedCount: 0,
        wins: 0,
        losses: 0,
        breakevens: 0,
      },
    )
  }, [ranges])

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 px-2 py-5 sm:p-5">
      <div
        className="group flex cursor-pointer flex-col gap-4 xl:flex-row xl:items-start xl:justify-between"
        onClick={(e) => onToggle(e.currentTarget)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle(e.currentTarget)
          }
        }}
      >
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-bold uppercase tracking-wide text-slate-100 transition-colors group-hover:text-indigo-400">
              {category}
            </h2>
            {fetching && <LoadingSpinner size={16} />}
            <span className="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-500 transition-colors">
              {ranges.length}
            </span>
            {fullModelSubscriptions.length > 0 && (
              <SubscriptionBadges
                subscriptions={fullModelSubscriptions.map((sub) => ({ ...sub, modelName: undefined }))}
                currentUserId={currentUserId}
              />
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                onBulkDays(true)
              }}
            >
              <span className="flex items-center gap-1">
                {allDaysEnabled && <span className="text-green-400">&#10003;</span>}
                Run all
              </span>
            </Button>
            <Button
              variant="ghost"
              className="px-2 py-1 text-xs"
              onClick={(e) => {
                e.stopPropagation()
                onBulkDays(false)
              }}
            >
              <span className="flex items-center gap-1">
                {allDaysDisabled && <span className="text-red-400">&#10007;</span>}
                Off all
              </span>
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <span className="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-300">
            <span className={classForCents(metrics.netTicksCents)}>
              {formatTicks(metrics.netTicksCents)}
            </span>
          </span>
          <span className="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-300">
            Trades {metrics.closedCount}
          </span>
          <span className="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-300">
            W/L{' '}
            <span className="text-positive">{metrics.wins}</span>
            <span className="text-slate-300">/</span>
            <span className="text-negative-400">{metrics.losses}</span>
          </span>
          <span className="rounded-full border border-slate-600 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-300">
            BE {metrics.breakevens}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggle(e.currentTarget)
            }}
            className="flex items-center gap-1 rounded-full border border-slate-600 bg-slate-900 text-xs px-2.5 py-1 font-semibold text-slate-300 hover:bg-slate-700 group-hover:border-indigo-500 group-hover:text-indigo-400"
          >
            {open ? 'HIDE' : 'SHOW'}
            <span className="text-slate-400">{open ? '▲' : '▼'}</span>
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-5 border-t border-slate-700 pt-5">
          {children}
        </div>
      )}
    </div>
  )
}

function RangeRowHeader({
  range,
  configuration,
  currentUserId,
  assignments,
  subcategories,
}: {
  range: SharedRangeDetail
  configuration: RangeConfiguration | undefined
  currentUserId?: string
  assignments?: RangeSubcategoryAssignment[]
  subcategories?: RangeSubcategory[]
}) {
  const calendarUrl = `/app/ranges/calendar?range=${encodeURIComponent(
    range.rangeName,
  )}`
  return (
    <div className="flex w-full items-center justify-between">
      <div className="flex items-center gap-3">
        {configuration?.instrument ? (
          <img
            src={tradingViewInstrumentIconUrl(configuration.instrument)}
            alt={configuration.instrument}
            className="h-8 w-8 flex-none rounded-full bg-slate-700 p-1"
          />
        ) : (
          <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-slate-700 text-xs font-bold text-slate-200">
            {range.rangeName[0]?.toUpperCase()}
          </div>
        )}
        <div>
          <div className="flex items-center gap-2">
            <Link
              to={calendarUrl}
              onClick={(e) => e.stopPropagation()}
              className="font-bold text-slate-100 transition-colors hover:text-indigo-400"
            >
              {range.rangeName}
            </Link>
            {/* Model membership dots — one per model this range belongs to */}
            {assignments &&
              categoriesForRange(range.rangeName, assignments)
                .filter((m) => m !== 'Uncategorized')
                .map((m) => (
                  <span
                    key={m}
                    title={m}
                    className="h-2.5 w-2.5 flex-none rounded-full"
                    style={{ backgroundColor: modelColor(m, subcategories ?? []) }}
                  />
                ))}
          </div>
          <div className="mt-1">
            <SubscriptionBadges
              subscriptions={range.subscriptions}
              currentUserId={currentUserId}
            />
          </div>
        </div>
      </div>

      <div className="hidden sm:flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-sm">
        <span>
          All time{' '}
          <span className={classForCents(range.allTime.netTicksCents)}>
            {formatTicks(range.allTime.netTicksCents)}
          </span>
        </span>
        <span>
          This week{' '}
          <span className={classForCents(range.currentWeek.netTicksCents)}>
            {formatTicks(range.currentWeek.netTicksCents)}
          </span>
        </span>
        <span>Closed {range.allTime.closedCount}</span>
        <span>
          W/L{' '}
          <span className="text-positive">{range.allTime.wins}</span>
          <span className="text-slate-300">/</span>
          <span className="text-negative-400">{range.allTime.losses}</span>
        </span>
        <Link
          to={calendarUrl}
          onClick={(e) => e.stopPropagation()}
          className="rounded border border-slate-600 bg-slate-900 px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-slate-700"
        >
          Open range
        </Link>
      </div>
    </div>
  )
}

export function SubscriptionBadges({
  subscriptions,
  currentUserId,
}: {
  subscriptions: SharedRangeSubscription[]
  currentUserId?: string
}) {
  const filtered = currentUserId
    ? subscriptions.filter((sub) => sub.user.id === currentUserId)
    : subscriptions
  if (filtered.length === 0) {
    return <span className="text-xs text-slate-500">No subscriptions</span>
  }
  return (
    <div className="flex flex-wrap gap-2 text-xs">
      {filtered.map((sub) => (
        <span
          key={`${sub.account.id}-${sub.user.id}`}
          className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-slate-300"
        >
          {sub.account.name}
          {sub.extensionEnabled && (
            <span className="rounded bg-indigo-900 px-1 text-[10px] text-indigo-100">
              Ext
            </span>
          )}
          {sub.traderspostEnabled && (
            <span className="rounded bg-positive-900 px-1 text-[10px] text-positive-100">
              TP
            </span>
          )}
        </span>
      ))}
    </div>
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
  state: RangeScheduleState
  nowMs: number
  onJump: (rangeName: string) => void
  configuration?: RangeConfiguration
  subscriptions?: SharedRangeSubscription[]
  currentUserId?: string
  isNext?: boolean
}) {
  const isEndingSoon =
    state.state === 'active' && schedule.endAt - nowMs < HIGHLIGHT_CLOSE_MS
  const borderClass = isEndingSoon
    ? 'border-negative-500 bg-negative-950/10'
    : 'border-slate-700 bg-slate-900'
  const instrument = configuration?.instrument ?? schedule.instrument

  return (
    <div
      className={`relative rounded-xl border-2 px-3 py-2 transition-colors ${borderClass}`}
    >
      {isNext && state.state === 'upcoming' && (
        <div className="absolute -top-2 left-4 rounded bg-negative-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
          Next
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => onJump(schedule.rangeName)}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          {instrument ? (
            <img
              src={tradingViewInstrumentIconUrl(instrument)}
              alt={instrument}
              className="hidden h-7 w-7 flex-none rounded-full bg-slate-700 p-1 sm:block"
            />
          ) : (
            <div className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-700 text-xs font-bold text-slate-200">
              {schedule.rangeName[0]?.toUpperCase()}
            </div>
          )}
          <span className="truncate font-bold text-slate-100 hover:text-indigo-400">
            {schedule.rangeName}
          </span>
          {instrument && (
            <span className="flex-none rounded border border-slate-600 bg-slate-950 px-1.5 py-0.5 text-[10px] font-bold text-slate-300">
              {instrument}
            </span>
          )}
        </button>

        <div className="text-sm text-slate-300">
          {subscriptions && subscriptions.length > 0 ? (
            <SubscriptionBadges
              subscriptions={subscriptions.map((sub) => ({ ...sub, modelName: undefined }))}
              currentUserId={currentUserId}
            />
          ) : (
            <span className="text-xs text-slate-500">No subscribed accounts.</span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2.5 gap-y-0.5 text-sm text-slate-300">
          <span className="whitespace-nowrap">
            {formatScheduleWindow(schedule)}
          </span>
          <span className="whitespace-nowrap text-slate-500">
            {schedule.entriesPerRange}{' '}
            {schedule.entriesPerRange === 1 ? 'entry' : 'entries'}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className={`hidden sm:block rounded px-2 py-0.5 text-xs font-semibold ${
                state.state === 'active'
                  ? isEndingSoon
                    ? 'bg-negative-900 text-negative-100'
                    : 'bg-positive-900 text-positive-100'
                  : 'bg-slate-800 text-slate-100'
              }`}
            >
              {state.status}
            </span>
            <span
              className={
                isEndingSoon
                  ? 'font-semibold text-negative-200'
                  : 'text-slate-200'
              }
            >
              {state.countdown}
            </span>
          </span>
        </div>
      </div>
    </div>
  )
}

function RangeScheduleRow({
  schedule,
  onJump,
}: {
  schedule: RangeDaySchedule
  onJump: (rangeName: string) => void
}) {
  const firedAt = new Date(schedule.startAt).toLocaleTimeString('en-US', {
    timeZone: 'Etc/GMT+4',
    hour: 'numeric',
    minute: '2-digit',
  })
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 py-1">
      <button
        type="button"
        onClick={() => onJump(schedule.rangeName)}
        className="text-left text-sm font-semibold text-slate-100 hover:text-indigo-400"
      >
        {schedule.rangeName}
      </button>
      <span className="text-xs text-slate-400">Formed at {firedAt}</span>
    </div>
  )
}

export function SubcategoryManager({
  subcategories,
  onAdd,
  onRename,
  onRemove,
  onColor,
  fetching = false,
}: {
  subcategories: RangeSubcategory[]
  onAdd: (name: string) => void
  onRename: (currentName: string, nextName: string) => void
  onRemove: (name: string) => void
  onColor: (name: string, color: string | null) => void
  fetching?: boolean
}) {
  const [newName, setNewName] = useState('')

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) return
    onAdd(newName.trim())
    setNewName('')
  }

  const rename = (currentName: string, nextName: string) => {
    onRename(currentName, nextName.trim())
  }

  const remove = (name: string) => {
    if (!confirm(`Delete the ${name} model?`)) return
    onRemove(name)
  }

  return (
    <Card title="Models" className="px-2 sm:px-4 sm:py-3">
      <p className="mb-4 text-sm text-slate-400">
        Create reusable models, then assign them from each range card to
        compare grouped performance.
      </p>
      <form onSubmit={handleAdd} className="mb-4 flex flex-wrap gap-4">
        <Input
          label="New Model"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="JESUS FISH"
          className="min-w-[200px] md:min-w-[280px] lg:min-w-[400px]"
          required
          maxLength={128}
        />
        <div className="flex items-end">
          <Button type="submit" variant="primary">
            ✓
          </Button>
        </div>
      </form>

      {subcategories.length === 0 ? (
        <p className="text-sm text-slate-500">No models yet.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-800 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-2 py-2 sm:px-4 sm:py-3">Name</th>
                <th className="px-2 py-2 sm:px-4 sm:py-3">Color</th>
                <th className="px-2 py-2 sm:px-4 sm:py-3">Rename</th>
                <th className="px-2 py-2 sm:px-4 sm:py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {subcategories.map((sub) => (
                <tr key={sub.name}>
                  <td className="px-2 py-2 text-slate-100 sm:px-4 sm:py-3">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: modelColor(sub.name, subcategories) }}
                      />
                      {sub.name}
                      {fetching && <LoadingSpinner size={12} />}
                    </span>
                  </td>
                  <td className="px-2 py-2 sm:px-4 sm:py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <input
                        type="color"
                        value={sub.color ?? modelColor(sub.name, subcategories)}
                        onChange={(e) => onColor(sub.name, e.target.value)}
                        title={`${sub.name} color`}
                        className="h-7 w-9 cursor-pointer rounded border border-slate-700 bg-slate-900 p-0.5"
                      />
                      {sub.color && (
                        <button
                          type="button"
                          onClick={() => onColor(sub.name, null)}
                          title="Reset to automatic color"
                          className="text-xs text-slate-500 hover:text-slate-300"
                        >
                          ×
                        </button>
                      )}
                    </span>
                  </td>
                  <td className="px-2 py-2 sm:px-4 sm:py-3">
                    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          const input = e.currentTarget.elements.namedItem(
                            'newName',
                          ) as HTMLInputElement
                          rename(sub.name, input.value)
                        }}
                        className="flex w-full flex-col gap-1 sm:w-auto sm:flex-row sm:gap-2"
                      >
                        <Input
                          name="newName"
                          defaultValue={sub.name}
                          maxLength={128}
                          className="min-w-[200px] md:min-w-[280px] lg:min-w-[400px]"
                        />
                        <Button type="submit" variant="ghost" className="!px-2 !py-1 !text-xs sm:!px-4 sm:!py-2 sm:!text-sm">
                          ✓
                        </Button>
                      </form>
                      </div>
                      </td>
                      <td className="px-2 py-2 sm:px-4 sm:py-3">
                      <Button
                        type="button"
                        variant="ghost"
                        // className="!px-2 !py-1 !text-xs sm:!px-4 sm:!py-2 sm:!text-sm"
                        onClick={() => remove(sub.name)}
                      >
                        X
                      </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// Fetches and renders a model's cumulative equity curve over an adjustable
// trailing window (7/14/30/90 days).
function ModelEquity({ model }: { model: string }) {
  return (
    <EquityChart
      label={model}
      query={`subcategory=${encodeURIComponent(model)}`}
    />
  )
}

type SubcategoryDayKey =
  | 'runMonday' | 'runTuesday' | 'runWednesday' | 'runThursday'
  | 'runFriday' | 'runSaturday' | 'runSunday'

const MODEL_DAY_KEYS: Array<{ label: string; key: SubcategoryDayKey }> = [
  { label: 'Mon', key: 'runMonday' },
  { label: 'Tue', key: 'runTuesday' },
  { label: 'Wed', key: 'runWednesday' },
  { label: 'Thu', key: 'runThursday' },
  { label: 'Fri', key: 'runFriday' },
  { label: 'Sat', key: 'runSaturday' },
  { label: 'Sun', key: 'runSunday' },
]

// The per-model run-day editor for one range: each day cycles
// inherit → on → off → inherit. Inherit (dimmed) follows the range's own
// schedule; explicit on/off is highlighted/struck.
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
  onUpdateSchedule: (
    rangeName: string,
    subcategoryName: string,
    day: SubcategoryDayKey,
    value: boolean | null,
  ) => void
}) {
  return (
    <>
      {MODEL_DAY_KEYS.map(({ label, key }) => {
        const override = assignment?.[key]
        const inherited = Boolean(configuration?.[key])
        const effective = override == null ? inherited : override
        const next = override == null ? true : override ? false : null
        return (
          <button
            key={key}
            type="button"
            title={`${model} ${label}: ${override == null ? `inherit (follows range schedule — ${inherited ? 'on' : 'off'})` : override ? 'on (forced)' : 'off (suppressed)'} — click cycles inherit → on → off`}
            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
              override == null
                ? effective
                  ? 'border-slate-600 text-slate-400'
                  : 'border-slate-700 text-slate-600'
                : effective
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-300'
                  : 'border-slate-600 text-slate-500 line-through'
            }`}
            onClick={(e) => {
              e.stopPropagation()
              onUpdateSchedule(rangeName, model, key, next)
            }}
          >
            {label}
          </button>
        )
      })}
    </>
  )
}

function SubscriptionChip({ range }: { range: SharedRangeDetail }) {
  if (range.subscriptions.length === 0) return null
  return (
    <span
      className="rounded-full bg-slate-700/60 px-2 py-0.5 text-xs text-slate-400"
      title={range.subscriptions
        .map((s) => `${s.account.name} (${s.user.email})`)
        .join(', ')}
    >
      {range.subscriptions
        .map((s) => s.account.name)
        .slice(0, 3)
        .join(', ')}
      {range.subscriptions.length > 3 && ` +${range.subscriptions.length - 3}`}
    </span>
  )
}


// Vertical column chart — one column per range, height = all-time net ticks.
// Positive columns rise above the baseline (theme blue), negatives drop below
// (theme negative). Labels rotate under the axis.
function NetTicksColumnChart({
  ranges,
  assignments,
  subcategories,
}: {
  ranges: SharedRangeDetail[]
  assignments: RangeSubcategoryAssignment[]
  subcategories: RangeSubcategory[]
}) {
  const items = ranges
    .filter(
      (r) =>
        r.performanceAllTime.closedCount > 0 ||
        r.performanceAllTime.netTicksCents !== 0,
    )
    .map((r) => ({
      label: r.rangeName,
      value: r.performanceAllTime.netTicksCents,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-500">No performance to chart yet.</p>
  }
  const maxAbs = Math.max(1, ...items.map((i) => Math.abs(i.value)))
  const track = 180 // px at full scale
  const heightFor = (v: number) => Math.max(4, Math.round((Math.abs(v) / maxAbs) * track))
  // Zone heights track the data — no dead space when one side is empty.
  const upH = Math.max(0, ...items.filter((i) => i.value >= 0).map((i) => heightFor(i.value))) + 12
  const downH = Math.max(0, ...items.filter((i) => i.value < 0).map((i) => heightFor(i.value))) + 4
  // Label zone grows with the longest name — no cap, long names get room.
  const labelH = Math.max(48, ...items.map((i) => i.label.length * 6 + 20))
  // Fewer columns → wider cells (capped); many → compact 16px cells.
  // Bars take up ~80% of the cell so few-column charts look substantial.
  const cellW = Math.min(72, Math.max(16, Math.round(640 / items.length)))
  const barW = Math.max(10, Math.min(56, Math.round(cellW * 0.8)))
  const gridFractions = [0.25, 0.5, 0.75, 1]
  // Down-side labels need ~14px each to be legible — thin negative zones
  // get only the max label, or none.
  const downFractions = downH > 56 ? gridFractions : downH > 16 ? [1] : []
  return (
    <div className="overflow-x-auto rounded-lg bg-white p-3">
      {/* chart area: gridlines behind, columns overlaid */}
      <div className="relative" style={{ height: upH + downH + 1 }}>
        {gridFractions.map((f) => (
          <div key={`u${f}`} className="absolute inset-x-0 flex items-center gap-2" style={{ top: upH - upH * f }}>
            <span className="w-12 flex-none text-right text-[9px]" style={{ color: '#64748b' }}>{formatTicks(maxAbs * f)}</span>
            <div className="h-px flex-1" style={{ backgroundColor: '#cbd5e1' }} />
          </div>
        ))}
        {downFractions.map((f) => (
          <div key={`d${f}`} className="absolute inset-x-0 flex items-center gap-2" style={{ top: upH + downH * f }}>
            <span className="w-12 flex-none text-right text-[9px]" style={{ color: '#64748b' }}>{formatTicks(-maxAbs * f)}</span>
            <div className="h-px flex-1" style={{ backgroundColor: '#cbd5e1' }} />
          </div>
        ))}
        {/* baseline */}
        <div className="absolute inset-x-0" style={{ top: upH }}>
          <div className="ml-14 h-px" style={{ backgroundColor: '#94a3b8' }} />
        </div>
        <div className={`absolute inset-0 ml-14 flex items-end gap-1 ${cellW > 16 ? 'justify-center' : 'justify-start'}`}>
          {items.map((item) => {
            const itemModels = categoriesForRange(item.label, assignments).filter((m) => m !== 'Uncategorized')
            const barColor = itemModels[0] ? modelColor(itemModels[0], subcategories) : undefined
            return (
            <div key={item.label} className="flex h-full min-w-4 flex-1 flex-col items-center" style={{ maxWidth: cellW }}>
              <div className="flex w-full flex-col justify-end" style={{ height: upH }}>
                {item.value >= 0 && (
                  <div
                    className="mx-auto rounded-t-sm"
                    style={{ height: heightFor(item.value), width: barW, backgroundColor: barColor ?? '#38bdf8' }}
                    title={`${item.label}: ${formatTicks(item.value)}`}
                  />
                )}
              </div>
              <div className="flex w-full flex-col justify-start" style={{ height: downH }}>
                {item.value < 0 && (
                  <div
                    className="mx-auto rounded-b-sm bg-gradient-to-b from-purple-500 to-purple-400"
                    style={{ height: heightFor(item.value), width: barW }}
                    title={`${item.label}: ${formatTicks(item.value)}`}
                  />
                )}
              </div>
            </div>
            )
          })}
        </div>
      </div>
      {/* vertical labels aligned under their columns */}
      <div className={`ml-14 mt-2 flex gap-1 ${cellW > 16 ? 'justify-center' : 'justify-start'}`}>
        {items.map((item) => {
          const models = categoriesForRange(item.label, assignments).filter((m) => m !== 'Uncategorized')
          return (
            <div key={item.label} className="flex min-w-4 flex-1 flex-col items-center overflow-hidden" style={{ height: labelH, maxWidth: cellW }}>
              <Link
                to={`/app/ranges/calendar?range=${encodeURIComponent(item.label)}`}
                className="block whitespace-nowrap text-[10px] font-semibold hover:text-indigo-600"
                style={{ writingMode: 'vertical-rl', color: '#1e293b' }}
                title={`${item.label}: ${formatTicks(item.value)}${models.length ? ` · ${models.join(', ')}` : ''}`}
              >
                {item.label}
              </Link>
              {models.length > 0 && (
                <div className="mt-0.5 flex flex-col items-center gap-1">
                  {models.map((m) => (
                    <span
                      key={m}
                      title={m}
                      className="block h-2 w-2 rounded-full"
                      style={{ backgroundColor: modelColor(m, subcategories) }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// One gauge per range in the selected model — needle is win rate
// (wins / closedCount — breakevens count, matching the journal's convention);
// ranges with no closed trades are skipped.
function ModelGaugeGrid({
  label,
  ranges,
}: {
  label: string
  ranges: SharedRangeDetail[]
}) {
  const items = ranges
    .filter((r) => r.performanceAllTime.closedCount > 0)
    .map((r) => ({
      range: r,
      winRate: (r.performanceAllTime.wins / r.performanceAllTime.closedCount) * 100,
    }))
    .sort((a, b) => b.winRate - a.winRate)
  if (items.length === 0) return null
  return (
    <div className="my-2">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
        {label} — win rate
      </h3>
      <div className="flex flex-wrap justify-evenly gap-x-4 gap-y-6">
        {items.map(({ range, winRate }) => (
          <div key={range.rangeName} className="flex w-32 flex-col items-center gap-2 sm:w-44">
            <GaugeChart value={winRate} label={`${winRate.toFixed(1)}%`} />
            <div className="text-center">
              <Link
                to={`/app/ranges/calendar?range=${encodeURIComponent(range.rangeName)}`}
                className="text-sm font-semibold text-slate-200 hover:text-indigo-400 hover:underline"
              >
                {range.rangeName}
              </Link>
              <div className="text-xs text-slate-400">
                {range.performanceAllTime.closedCount} trades · W/L{' '}
                {range.performanceAllTime.wins}/{range.performanceAllTime.losses}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Every tracked range as a detailed collapsible card, filterable by model.
// The per-range card carries the full detail (performance, subscribers,
// settings, model membership chips).
export function AllRangesDirectory({
  ranges,
  assignments,
  subcategories,
  configs,
  openRange,
  onToggleRange,
  detailCardProps,
}: {
  ranges: SharedRangeDetail[]
  assignments: RangeSubcategoryAssignment[]
  subcategories: RangeSubcategory[]
  configs: Map<string, RangeConfiguration>
  openRange: string | null
  onToggleRange: (rangeName: string, anchor?: HTMLElement) => void
  detailCardProps: {
    currentUserId?: string
    onAssignCategory: (rangeName: string, subcategoryName: string, assigned: boolean) => void
    onUpdateConfig: (rangeName: string, patch: Partial<RangeConfiguration>) => void
    onRename: (currentRangeName: string, newRangeName: string) => Promise<unknown>
    onFlagRange: (rangeName: string, flag: 'test_data' | 'erroneous' | 'clear') => Promise<unknown>
    onDelete: (rangeName: string) => Promise<unknown>
  }
}) {
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set())
  const sorted = [...ranges].sort((a, b) => a.rangeName.localeCompare(b.rangeName))
  const visible = selectedModels.size === 0
    ? sorted
    : sorted.filter((range) =>
        categoriesForRange(range.rangeName, assignments).some((m) => selectedModels.has(m)),
      )

  return (
    <>
    <Card title="All ranges" className="px-2 sm:px-4 sm:py-3">
      <p className="mb-4 text-sm text-slate-400">
        Every tracked range. Filter by model to narrow the list — expand a row
        for full detail and membership editing.
      </p>
      {subcategories.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {subcategories.map((s) => (
            <label
              key={s.name}
              className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                selectedModels.has(s.name)
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20'
                  : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500 hover:bg-slate-700 hover:text-slate-200'
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={selectedModels.has(s.name)}
                onChange={() =>
                  setSelectedModels((prev) => {
                    const next = new Set(prev)
                    if (next.has(s.name)) next.delete(s.name)
                    else next.add(s.name)
                    return next
                  })
                }
              />
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: modelColor(s.name, subcategories) }}
              />
              {s.name}
            </label>
          ))}
        </div>
      )}
      {visible.length === 0 ? (
        <p className="text-sm text-slate-500">No ranges match.</p>
      ) : (
        <div className="space-y-4">
          {visible.map((range) => (
            <div
              key={range.rangeName}
              id={`range-detail-${slugify(range.rangeName)}`}
            >
              <CollapsibleSection
                title={
                  <RangeRowHeader
                    range={range}
                    configuration={configs.get(range.rangeName)}
                    currentUserId={detailCardProps.currentUserId}
                    assignments={assignments}
                    subcategories={subcategories}
                  />
                }
                open={openRange === range.rangeName}
                onToggle={(anchor) => onToggleRange(range.rangeName, anchor)}
              >
                <RangeDetailCard
                  range={range}
                  configuration={configs.get(range.rangeName)}
                  currentCategories={categoriesForRange(range.rangeName, assignments)}
                  subcategories={subcategories}
                  onAssignCategory={detailCardProps.onAssignCategory}
                  onUpdateConfig={detailCardProps.onUpdateConfig}
                  onRename={detailCardProps.onRename}
                  onFlagRange={detailCardProps.onFlagRange}
                  onDelete={detailCardProps.onDelete}
                  compact
                />
              </CollapsibleSection>
            </div>
          ))}
        </div>
      )}
    </Card>
    {/* Performance follows the model filter — same `visible` set as the list
        above, so narrowing the list narrows the chart too. */}
    <RangeCategoryChart
      category="Filtered ranges"
      ranges={visible}
      scaleRanges={ranges}
      gaugeLabel={selectedModels.size === 1 ? [...selectedModels][0] : undefined}
      assignments={assignments}
      subcategories={subcategories}
    />
  </>
  )
}

function AddRangeForm({
  onAdd,
}: {
  onAdd: (rangeName: string) => void
}) {
  const [name, setName] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim())
    setName('')
  }

  return (
    <Card title="Add range" className="px-2 sm:px-4 sm:py-3">
      <p className="mb-4 text-sm text-slate-400">
        Create a shared tracked range with only the exact range name. You can add
        routes and stored settings later.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-wrap gap-4">
        <Input
          label="Exact range name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Opening Range"
          className="min-w-[200px] md:min-w-[280px] lg:min-w-[400px]"
          required
          maxLength={256}
        />
        <div className="flex items-end">
          <Button type="submit" variant="primary">
           ✓
          </Button>
        </div>
      </form>
    </Card>
  )
}

export function RangesPage() {
  const [now, setNow] = useState<Date>(new Date())
  // Optimistic mount read: last-known ranges paint instantly on reload; the
  // effect below re-verifies the cached userId once the session resolves.
  const [initialCached] = useState(() => getCachedRangesOptimistic())
  const [tracked, setTracked] = useState<SharedRangeDetail[]>(initialCached?.sharedRangeDetails ?? [])
  const [subcategories, setSubcategories] = useState<RangeSubcategory[]>(initialCached?.rangeSubcategories ?? [])
  const [assignments, setAssignments] = useState<RangeSubcategoryAssignment[]>(
    initialCached?.rangeSubcategoryAssignments ?? [],
  )
  const [configs, setConfigs] = useState<Map<string, RangeConfiguration>>(
    () => new Map((initialCached?.rangeConfigurations ?? []).map((c) => [c.rangeName, c])),
  )
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    () => {
      try {
        const saved = window.localStorage.getItem('ranges:selectedCategories')
        if (saved) return new Set(JSON.parse(saved) as string[])
      } catch {
        // ignore
      }
      return new Set<string>()
    },
  )
  const [appliedCategories, setAppliedCategories] = useState<Set<string>>(
    () => {
      try {
        const saved = window.localStorage.getItem('ranges:selectedCategories')
        if (saved) return new Set(JSON.parse(saved) as string[])
      } catch {
        // ignore
      }
      return new Set<string>()
    },
  )
  const [scheduleColumns, setScheduleColumns] = useState(() => {
    if (typeof window === 'undefined') return 1
    try {
      const raw = Number(localStorage.getItem('bridge:ranges:scheduleColumns'))
      if (raw >= 1 && raw <= 3) return raw
    } catch {
      // ignore
    }
    return 1
  })
  const [showSchedule, setShowSchedule] = useState(() => {
    if (typeof window === 'undefined') return true
    try {
      const raw = localStorage.getItem('bridge:ranges:schedule')
      if (raw === 'true') return true
      if (raw === 'false') return false
    } catch {
      // ignore
    }
    return true
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      localStorage.setItem('bridge:ranges:schedule', String(showSchedule))
    } catch {
      // ignore
    }
  }, [showSchedule])

  const [ready, setReady] = useState(false)
  const [fetching, setFetching] = useState(false)
  const { success, error } = useToast()
  const savedScrollY = useRef<number | null>(null)
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const [openRange, setOpenRange] = useState<string | null>(null)
  // When a collapse/expand shifts layout (e.g. an open section above closing),
  // pin the clicked element's viewport position so the view doesn't jump.
  const pinnedAnchor = useRef<{ el: HTMLElement; top: number } | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string>('')
  // refresh() is a stable []-dep callback — the ref gives it the latest
  // session id when it stamps the user-scoped cache.
  const currentUserIdRef = useRef('')
  currentUserIdRef.current = currentUserId

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    getJson<{ userId: string }>('/api/session')
      .then(({ userId }) => setCurrentUserId(userId))
      .catch(() => setCurrentUserId('__unknown__'))
  }, [])

  // Wait for session identity before trusting the cache: bridge:ranges is
  // shared localStorage across logins, so freshness is meaningless until we
  // know which user stored it.
  useEffect(() => {
    if (currentUserId === '') return
    const cached = getCachedRanges(currentUserId)
    if (cached) {
      setTracked(cached.sharedRangeDetails)
      setSubcategories(cached.rangeSubcategories)
      setAssignments(cached.rangeSubcategoryAssignments)
      setConfigs(
        new Map(
          cached.rangeConfigurations.map((configuration) => [
            configuration.rangeName,
            configuration,
          ]),
        ),
      )
      // Fresh cache → skip the redundant mount fetch. SSE journal:refresh
      // events and manual actions still call refresh() directly.
      if (cached.fetchedAt && Date.now() - cached.fetchedAt < RANGES_CACHE_TTL_MS) {
        return
      }
    }
    refresh()
  }, [currentUserId])

  useEffect(() => {
    if (subcategories.length === 0 || ready) return
    const all = new Set(subcategories.map((s) => s.name))
    try {
      const saved = window.localStorage.getItem('ranges:selectedCategories')
      if (saved) {
        const parsed = JSON.parse(saved) as string[]
        const known = new Set(parsed.filter((name) => all.has(name)))
        if (known.size > 0) {
          setSelectedCategories(known)
          setAppliedCategories(known)
          setReady(true)
          return
        }
      }
    } catch {
      // ignore
    }
    setSelectedCategories(all)
    setAppliedCategories(all)
    setReady(true)
  }, [subcategories, ready])

  useEffect(() => {
    if (!ready) return
    try {
      window.localStorage.setItem(
        'ranges:selectedCategories',
        JSON.stringify([...appliedCategories]),
      )
    } catch {
      // ignore
    }
  }, [appliedCategories, ready])

  useLayoutEffect(() => {
    if (savedScrollY.current !== null) {
      window.scrollTo({ top: savedScrollY.current, behavior: 'instant' })
      savedScrollY.current = null
    }
  }, [appliedCategories])



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
  const todayLifePath = useMemo(
    () => getDeepLifePath(todayDateKey).lifePathNumber,
    [todayDateKey],
  )
  const todayWeekday = useMemo(() => currentJournalWeekday(now), [now])
  const nowMs = now.getTime()

  const categories = useMemo(() => {
    const set = new Set(
      Array.from(configs.values()).flatMap((c) =>
        categoriesForRange(c.rangeName, assignments),
      ),
    )
    const ordered = subcategories
      .filter((s) => set.has(s.name))
      .map((s) => s.name)
    return ordered
  }, [subcategories, assignments, configs])

  const todaySchedules = useMemo(() => {
    return Array.from(configs.values())
      .filter((configuration) => rangeRunsOnWeekday(configuration, todayWeekday))
      .map((configuration) =>
        buildRangeDaySchedule(configuration, todayDateKey),
      )
      .filter((schedule): schedule is RangeDaySchedule => Boolean(schedule))
      .sort(
        (a, b) =>
          a.startAt - b.startAt || a.rangeName.localeCompare(b.rangeName),
      )
  }, [todayDateKey, todayWeekday, configs])

  const scheduleStates = useMemo(() => {
    return new Map(
      todaySchedules.map((schedule) => [
        schedule.rangeName,
        describeRangeScheduleState(schedule.startAt, schedule.endAt, nowMs),
      ]),
    )
  }, [todaySchedules, nowMs])

  const filteredSchedules = useMemo(() => {
    if (appliedCategories.size === 0) return todaySchedules
    return todaySchedules.filter((schedule) =>
      categoriesForRange(schedule.rangeName, assignments).some((cat) =>
        appliedCategories.has(cat),
      ),
    )
  }, [todaySchedules, appliedCategories, assignments])

  const { upcoming, completed } = useMemo(() => {
    const now = nowMs
    const up = filteredSchedules
      .filter((s) => s.endAt >= now)
      .sort((a, b) => {
        const aState = scheduleStates.get(a.rangeName)!
        const bState = scheduleStates.get(b.rangeName)!
        const aRank = aState.state === 'active' ? 0 : 1
        const bRank = bState.state === 'active' ? 0 : 1
        return (
          aRank - bRank ||
          a.endAt - b.endAt ||
          a.startAt - b.startAt ||
          a.rangeName.localeCompare(b.rangeName)
        )
      })
    const comp = todaySchedules
      .filter((s) => s.endAt < now)
      .sort(
        (a, b) =>
          a.startAt - b.startAt || a.rangeName.localeCompare(b.rangeName),
      )
    return { upcoming: up, completed: comp }
  }, [filteredSchedules, todaySchedules, scheduleStates, nowMs])

  const groupedRanges = useMemo(() => {
    const map = new Map<string, SharedRangeDetail[]>()
    for (const range of tracked) {
      // A range in multiple models appears under each of its model groups.
      for (const cat of categoriesForRange(range.rangeName, assignments)) {
        const list = map.get(cat) ?? []
        list.push(range)
        map.set(cat, list)
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.rangeName.localeCompare(b.rangeName))
    }
    const ordered = subcategories
      .filter((s) => map.has(s.name))
      .map((s) => [s.name, map.get(s.name)!] as const)
    const seen = new Set(ordered.map(([name]) => name))
    const extra = [...map.keys()]
      .filter((name) => !seen.has(name))
      .sort()
    for (const name of extra) {
      ordered.push([name, map.get(name)!])
    }
    return ordered
  }, [tracked, assignments, subcategories])

  const rangeByName = useMemo(
    () => new Map(tracked.map((range) => [range.rangeName, range])),
    [tracked],
  )

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
        setConfigs(
          new Map(
            data.rangeConfigurations.map((configuration) => [
              configuration.rangeName,
              configuration,
            ]),
          ),
        )
        setCachedRanges(data, currentUserIdRef.current)
      })
      .catch((err) => {
        console.error('Failed to load ranges from server:', err)
      })
      .finally(() => {
        setFetching(false)
      })
  }, [])

  useEffect(() => {
    const onRefresh = () => {
      void refresh()
    }
    window.addEventListener('journal:refresh', onRefresh)
    return () => window.removeEventListener('journal:refresh', onRefresh)
  }, [refresh])

  const handleAddRange = (rangeName: string) => {
    const existing = tracked.find(
      (r) => r.rangeName.toLowerCase() === rangeName.trim().toLowerCase(),
    )
    if (existing) {
      error(`Range "${existing.rangeName}" already exists`)
      return
    }
    postForm('/tracked-ranges', { rangeName })
      .then(() => {
        refresh()
        success('Range added')
      })
      .catch((err) => {
        console.error('Failed to add range:', err)
        error((err as { reason?: string })?.reason ?? 'Failed to add range')
      })
  }

  const handleAssignCategory = (
    rangeName: string,
    subcategoryName: string,
    assigned: boolean,
  ) => {
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
      .catch((err) => {
        console.error('Failed to update model membership:', err)
        error('Failed to update model membership')
      })
  }

  const handleUpdateSubcategorySchedule = (
    rangeName: string,
    subcategoryName: string,
    day: keyof RangeConfiguration & `run${string}`,
    value: boolean | null,
  ) => {
    postJson('/api/range-subcategory-schedule', {
      rangeName,
      subcategoryName,
      [day]: value,
    })
      .then((res) => res.json() as Promise<RangeSubcategoryAssignment>)
      .then((saved) => {
        setAssignments((prev) => {
          const next = prev.filter(
            (a) =>
              !(
                a.rangeName === saved.rangeName &&
                a.subcategoryName === saved.subcategoryName
              ),
          )
          next.push(saved)
          return next
        })
        success('Model day schedule saved')
      })
      .catch((err) => {
        console.error('Failed to update model day schedule:', err)
        error('Failed to update model day schedule')
      })
  }

  const dayFlagRegex = /^(runSunday|runMonday|runTuesday|runWednesday|runThursday|runFriday|runSaturday)$/
  const handleUpdateConfig = (
    rangeName: string,
    patch: Partial<RangeConfiguration>,
  ) => {
    const previous = new Map(configs)
    const current = previous.get(rangeName)
    const isDayPatch = Object.keys(patch).some(
      (k) =>
        dayFlagRegex.test(k) &&
        current &&
        current[k as keyof RangeConfiguration] !== patch[k as keyof RangeConfiguration],
    )
    setConfigs((prev) => {
      const current = prev.get(rangeName)
      const next = new Map(prev)
      if (!current) {
        next.set(rangeName, { ...defaultRangeConfiguration(rangeName), ...patch })
      } else {
        next.set(rangeName, { ...current, ...patch, updatedAt: new Date().toISOString() })
      }
      return next
    })
    postJson('/api/range-configurations/patch', { rangeName, ...patch })
      .then((res) => res.json() as Promise<RangeConfiguration>)
      .then((saved) => {
        setConfigs((prev) => new Map(prev).set(rangeName, saved))
        success(isDayPatch ? 'Run days saved' : 'Range settings saved')
      })
      .catch((err) => {
        console.error('Failed to update range config:', err)
        setConfigs(previous)
        error(isDayPatch ? 'Failed to save run days' : 'Failed to save range settings')
      })
  }

  const handleBulkDays = (subcategoryName: string, enabled: boolean) => {
    const targetCategory = subcategoryName || 'Uncategorized'
    const isModel = targetCategory !== 'Uncategorized'
    // Named models write per-range assignment days (per-model schedule);
    // Uncategorized keeps writing each range's own run_* flags.
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
        // Re-sync with the server's authoritative set — the optimistic update
        // and the server's assignment-based selection can diverge.
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
      .catch((err) => {
        console.error('Failed to bulk update run days:', err)
        setConfigs(previousConfigs)
        setAssignments(previousAssignments)
        error('Failed to update run days')
      })
  }

  const handleDelete = (rangeName: string) => {
    return postForm('/ranges/delete', { rangeName })
      .then(() => refresh())
      .then(() => {
        success('Range deleted')
      })
      .catch((err) => {
        console.error('Failed to delete range:', err)
        error('Failed to delete range')
      })
  }

  const handleRenameRange = (
    currentRangeName: string,
    newRangeName: string,
  ) => {
    return postForm('/ranges/rename', { currentRangeName, newRangeName })
      .then(() => refresh())
      .then(() => {
        success('Range renamed')
      })
      .catch((err) => {
        console.error('Failed to rename range:', err)
        error('Failed to rename range')
      })
  }

  const handleFlagRange = (
    rangeName: string,
    flag: 'test_data' | 'erroneous' | 'clear',
  ) => {
    return postForm('/range-review-flags', {
      rangeName,
      testData: flag === 'test_data' ? 'true' : undefined,
      erroneous: flag === 'erroneous' ? 'true' : undefined,
    })
      .then(() => refresh())
      .then(() => {
        success('Review flag updated')
      })
      .catch((err) => {
        console.error('Failed to update range review flag:', err)
        error('Failed to update review flag')
      })
  }

  const handleAddSubcategory = (name: string) => {
    postForm('/range-subcategories', { name })
      .then(() => {
        refresh()
        success('Model added')
      })
      .catch((err) => {
        console.error('Failed to add model:', err)
        error('Failed to add model')
      })
  }

  const handleRenameSubcategory = (
    currentName: string,
    nextName: string,
  ) => {
    postForm('/range-subcategories/rename', {
      currentName,
      newName: nextName,
    })
      .then(() => {
        refresh()
        success('Model renamed')
      })
      .catch((err) => {
        console.error('Failed to rename model:', err)
        error('Failed to rename model')
      })
  }

  const handleSetSubcategoryColor = (name: string, color: string | null) => {
    postForm('/range-subcategories/color', { name, color: color ?? '' })
      .then(() => {
        refresh()
        success('Model color updated')
      })
      .catch((err) => {
        console.error('Failed to set model color:', err)
        error('Failed to set model color')
      })
  }

  const handleDeleteSubcategory = (name: string) => {
    postForm('/range-subcategories/delete', { name })
      .then(() => {
        refresh()
        success('Model deleted')
      })
      .catch((err) => {
        console.error('Failed to delete model:', err)
        error('Failed to delete model')
      })
  }

  const handleJump = (rangeName: string) => {
    const category = primaryCategoryForRange(rangeName, assignments)
    setOpenCategory(category)
    setOpenRange(rangeName)
    const id = `range-detail-${slugify(rangeName)}`
    setTimeout(() => {
      const el = document.getElementById(id)
      if (el) scrollToElement(el)
    }, 60)
  }

  const [searchParams, setSearchParams] = useSearchParams()
  const deepLinked = useRef(false)
  useEffect(() => {
    if (!ready || deepLinked.current || tracked.length === 0) return
    const target = searchParams.get('range')
    if (!target) return
    const match = tracked.find(
      (r) => r.rangeName.toLowerCase() === target.toLowerCase(),
    )
    if (!match) return
    deepLinked.current = true
    setSearchParams({}, { replace: true })
    setOpenCategory(primaryCategoryForRange(match.rangeName, assignments))
    setOpenRange(match.rangeName)
    const id = `range-detail-${slugify(match.rangeName)}`
    let attempts = 0
    const tryScroll = () => {
      const el = document.getElementById(id)
      if (el) {
        scrollToElement(el)
      } else if (attempts++ < 20) {
        setTimeout(tryScroll, 100)
      }
    }
    tryScroll()
  }, [ready, tracked, searchParams, assignments, setSearchParams])

  // Restore the clicked element's viewport position after open/close layout
  // shifts — runs after React commits the new tree.
  useLayoutEffect(() => {
    const pin = pinnedAnchor.current
    if (!pin) return
    pinnedAnchor.current = null
    if (!pin.el.isConnected) return
    const delta = pin.el.getBoundingClientRect().top - pin.top
    if (Math.abs(delta) > 1) window.scrollBy(0, delta)
  }, [openCategory, openRange])

  const toggleRangeCategory = (category: string, anchor?: HTMLElement) => {
    pinnedAnchor.current = anchor ? { el: anchor, top: anchor.getBoundingClientRect().top } : null
    setOpenRange((prevRange) => {
      if (openCategory === category && !prevRange) return null
      return null
    })
    setOpenCategory((prev) => (prev === category ? null : category))
  }

  const toggleRangeDetail = (rangeName: string, anchor?: HTMLElement) => {
    pinnedAnchor.current = anchor ? { el: anchor, top: anchor.getBoundingClientRect().top } : null
    const category = primaryCategoryForRange(rangeName, assignments)
    setOpenRange((prev) => {
      if (prev === rangeName) {
        return null
      }
      setOpenCategory(category)
      return rangeName
    })
  }

  const toggleCategory = (name: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const applyCategories = () => {
    savedScrollY.current = window.scrollY
    setAppliedCategories(new Set(selectedCategories))
  }

  return (
    <div className="space-y-8 text-slate-100">
      <PageHeader title="Ranges" subtitle="Range management" onTitleClick={() => void refresh()}>
        {fetching && <LoadingSpinner size={20} />}
      </PageHeader>

      <RedFolderMiniCalendar />

      <Card className="bg-gradient-to-br pb-2 from-slate-900 to-slate-950">
        <div onClick={() => setShowSchedule((prev) => !prev)} className="mb-4 flex cursor-pointer items-end justify-between gap-4 border-b border-slate-700 pb-4">
          <div>
            <h2 className="flex w-full flex-wrap items-center justify-between gap-2 text-lg font-bold text-slate-100">
              <div className="hidden sm:flex items-center gap-2">
                <span>{todayDateLabel}</span>
                <span className="rounded bg-indigo-500/10 px-2 py-0.5 text-sm font-semibold text-indigo-500">
                  LP {todayLifePath}
                </span>
                {fetching && <LoadingSpinner size={16} />}
              </div>
              <RedFolderPanel />
            </h2>
            {upcoming.length > 0 ? (
              !showSchedule ? (
              <>
                <div className="rounded bg-positive-900 px-1.5 py-0.5 mt-2 text-[10px] font-bold uppercase text-positive-100">
                  {upcoming[0].rangeName}{' '}
                  {scheduleStates.get(upcoming[0].rangeName)!.state === 'active'
                    ? 'is forming now'
                    : `in ${scheduleStates.get(upcoming[0].rangeName)!.countdownValue}`}
                </div>
              </>
            ) : null
            ) : (
              <p className="text-sm text-slate-400">No more ranges today</p>
            )}
          </div>
          {/* Column picker is meaningless on mobile — the grid is always 1-col. */}
          <div
            className={`items-center gap-0.5 rounded-md border border-slate-700 p-0.5 ${
              showSchedule ? 'hidden sm:flex' : 'hidden'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {[1, 2, 3].map((cols) => (
              <button
                key={cols}
                type="button"
                title={`${cols} column${cols === 1 ? '' : 's'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setScheduleColumns(cols)
                  try {
                    localStorage.setItem('bridge:ranges:scheduleColumns', String(cols))
                  } catch {
                    // ignore
                  }
                }}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition ${
                  scheduleColumns === cols
                    ? 'bg-slate-600 text-white'
                    : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                }`}
              >
                {cols}
              </button>
            ))}
          </div>
          <button
            type="button"
            // onClick={() => setShowSchedule((prev) => !prev)}
            className="flex items-center gap-1 rounded-full border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-slate-300 hover:bg-slate-700"
          >
            <span className="text-slate-400">{showSchedule ? '▲' : '▼'}</span>
            {showSchedule ? 'Hide Schedule' : 'Show'}
          </button>
        </div>

        {showSchedule && (
          <div className="space-y-6">
            {upcoming.length === 0 && completed.length === 0 && (
              <div className="text-center text-slate-400">
                No ranges today.
              </div>
            )}

            {upcoming.length > 0 && (
              <div
                className={
                  scheduleColumns === 1
                    ? 'space-y-1.5'
                    : `grid gap-1.5 ${scheduleColumns === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-2 xl:grid-cols-3'}`
                }
              >
                {upcoming.map((schedule, index) => (
                  <UpcomingRangeCard
                    key={schedule.rangeName}
                    schedule={schedule}
                    state={scheduleStates.get(schedule.rangeName)!}
                    nowMs={nowMs}
                    onJump={handleJump}
                    configuration={configs.get(schedule.rangeName)}
                    subscriptions={
                      rangeByName.get(schedule.rangeName)?.subscriptions
                    }
                    currentUserId={currentUserId}
                    isNext={index === 0}
                  />
                ))}
              </div>
            )}

            {completed.length > 0 && (
              <div>
                <div className="mb-2 text-xs font-bold uppercase tracking-widest text-slate-400">
                  RANGES TAKEN EARLIER TODAY
                </div>
                <div className="space-y-1 px-4">
                  {completed.map((schedule) => (
                    <RangeScheduleRow
                      key={schedule.rangeName}
                      schedule={schedule}
                      onJump={handleJump}
                    />
                  ))}
                </div>
              </div>
            )}

            {categories.length > 0 && (
              <div className="wide p-2">
                <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  {categories.filter(cat => cat !== 'Evaluation').map((cat) => (
                    <label
                      key={cat}
                      className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                        selectedCategories.has(cat)
                          ? 'border-indigo-500 bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500/20'
                          : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500 hover:bg-slate-700 hover:text-slate-200'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={selectedCategories.has(cat)}
                        onChange={() => toggleCategory(cat)}
                      />
                      {cat}
                    </label>
                  ))}
                    <Button
                      type="button"
                      variant="primary"
                      onClick={applyCategories}
                      className="ml-auto"
                      >
                      ✓
                    </Button>
                  </div>
              </div>
            )}
          </div>
        )}
      </Card>

      <CollapsibleSection
        title="Model Library"
        storageKey="ranges:section:library"
        defaultOpen
      >
        <p className="mb-4 text-sm text-slate-400">
          Expand a range to review its global performance, subscribers, and
          stored settings. Performance values are in ticks.
        </p>

        {groupedRanges.length === 0 && (
          <div className="rounded-xl border border-slate-700 bg-slate-800 p-5 text-center text-slate-400">
            No shared ranges are tracked yet.
          </div>
        )}

        {groupedRanges
          .filter(([category]) => category !== 'Uncategorized')
          .map(([category, ranges]) => (
          <RangeCategorySection
            key={category}
            category={category}
            ranges={ranges}
            assignments={assignments}
            open={openCategory === category}
            onToggle={(anchor) => toggleRangeCategory(category, anchor)}
            onBulkDays={(enabled) => handleBulkDays(category, enabled)}
            currentUserId={currentUserId}
            fetching={fetching}
          >
           
            <div className="divide-y divide-slate-800 rounded-xl border border-slate-700 bg-slate-900">
              {ranges.map((range) => {
                const assignment = assignments.find(
                  (a) => a.rangeName === range.rangeName && a.subcategoryName === category,
                )
                return (
                  <div
                    key={range.rangeName}
                    className="flex flex-wrap items-center gap-2 px-3 py-2"
                  >
                    <span className="font-semibold text-slate-100">{range.rangeName}</span>
                    <SubscriptionChip range={range} />
                    <span className="flex items-center gap-1">
                      <ModelDayButtons
                        rangeName={range.rangeName}
                        model={category}
                        assignment={assignment}
                        configuration={configs.get(range.rangeName)}
                        onUpdateSchedule={handleUpdateSubcategorySchedule}
                      />
                    </span>
                    <button
                      type="button"
                      title={`Remove ${range.rangeName} from ${category}`}
                      className="ml-auto text-slate-500 hover:text-rose-400"
                      onClick={() => handleAssignCategory(range.rangeName, category, false)}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>

            <ModelEquity model={category} />
          </RangeCategorySection>
        ))}

      </CollapsibleSection>

      <CollapsibleSection
        title="All Ranges"
        storageKey="ranges:section:allRanges"
        defaultOpen
      >
        <AllRangesDirectory
          ranges={tracked}
          assignments={assignments}
          subcategories={subcategories}
          configs={configs}
          openRange={openRange}
          onToggleRange={toggleRangeDetail}
          detailCardProps={{
            currentUserId,
            onAssignCategory: handleAssignCategory,
            onUpdateConfig: handleUpdateConfig,
            onRename: handleRenameRange,
            onFlagRange: handleFlagRange,
            onDelete: handleDelete,
          }}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title="Manage Ranges and Models"
        storageKey="ranges:section:manage"
      >
        <div className="space-y-4">
          <AddRangeForm onAdd={handleAddRange} />
          <SubcategoryManager
            subcategories={subcategories}
            onAdd={handleAddSubcategory}
            onRename={handleRenameSubcategory}
            onRemove={handleDeleteSubcategory}
            onColor={handleSetSubcategoryColor}
            fetching={fetching}
          />
        </div>
      </CollapsibleSection>
    </div>
  )
}
