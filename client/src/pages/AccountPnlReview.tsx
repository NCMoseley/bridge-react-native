import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { getJson } from '../api/client'
import {
  classForCents,
  formatDollars,
  formatJournalDate,
  formatPercent,
  formatPnl,
  formatRatio,
  formatTicks,
  profitFactor,
  JOURNAL_TIME_ZONE,
} from '../utils/format'
import type { AccountPnlReview, CalendarDayRange, TradeEvent } from '../types'
import { JournalDate } from '../components/JournalDate'
import { displayInstrument } from '../utils/instruments'

// The API returns the complete window so the summary, ranges, equity curve, and
// best/worst cards stay consistent; only the table renders a bounded slice.
const TABLE_DISPLAY_LIMIT = 200

function formatHourLabel(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: JOURNAL_TIME_ZONE,
  }).format(new Date(value))
}

interface EquityPoint {
  at: string
  cumulativeCents: number
  trade?: TradeEvent
}

function EquityCurve({ since, until, trades }: { since: string; until: string; trades: TradeEvent[] }) {
  const { points, yMax, maxDrawdownCents } = useMemo(() => {
    const ordered = [...trades]
      .filter((trade) => !trade.excludedFromPerformance)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    const data: EquityPoint[] = [{ at: since, cumulativeCents: 0 }]
    let cumulative = 0
    let peak = 0
    let drawdown = 0
    for (const trade of ordered) {
      cumulative += trade.realizedDollarsCents ?? 0
      data.push({ at: trade.occurredAt, cumulativeCents: cumulative, trade })
      peak = Math.max(peak, cumulative)
      drawdown = Math.max(drawdown, peak - cumulative)
    }
    data.push({ at: until, cumulativeCents: cumulative })
    const maxAbs = Math.max(1, ...data.map((point) => Math.abs(point.cumulativeCents)))
    return { points: data, yMax: Math.ceil(maxAbs / 5000) * 5000, maxDrawdownCents: drawdown }
  }, [since, until, trades])

  const width = 720
  const height = 280
  const padding = { top: 24, right: 20, bottom: 44, left: 72 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const start = new Date(since).getTime()
  const end = new Date(until).getTime()
  const span = Math.max(1, end - start)

  const toX = (at: string) => padding.left + ((new Date(at).getTime() - start) / span) * plotWidth
  const toY = (cents: number) =>
    padding.top + plotHeight - ((cents + yMax) / (2 * yMax)) * plotHeight

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(p.at)} ${toY(p.cumulativeCents)}`).join(' ')
  const zeroY = toY(0)
  const areaPath = `${linePath} L ${toX(until)} ${zeroY} L ${toX(since)} ${zeroY} Z`
  const finalCents = points[points.length - 1]?.cumulativeCents ?? 0
  const ticks = [yMax, yMax / 2, 0, -yMax / 2, -yMax]
  const hourLabels = [since, new Date(start + span / 2).toISOString(), until]
  const [hovered, setHovered] = useState<EquityPoint | null>(null)

  return (
    <div className="relative">
      <div className="mb-3 flex items-start justify-between gap-4">
        <p className="text-sm text-slate-400">
          Cumulative realized P&L, trade by trade.
        </p>
        <div className="text-right text-xs text-slate-400">
          Max drawdown{' '}
          <span className={classForCents(-maxDrawdownCents)}>
            {maxDrawdownCents > 0 ? `-${formatDollars(maxDrawdownCents)}` : formatDollars(0)}
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full cursor-crosshair" role="img" aria-label="Cumulative P&L curve">
        <defs>
          <linearGradient id="pnlArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={finalCents >= 0 ? 'var(--color-positive)' : 'var(--color-negative-400)'} stopOpacity="0.25" />
            <stop offset="100%" stopColor={finalCents >= 0 ? 'var(--color-positive)' : 'var(--color-negative-400)'} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => {
          const y = toY(tick)
          return (
            <g key={tick}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke={tick === 0 ? 'var(--color-slate-700)' : 'var(--color-slate-800)'}
                strokeWidth={tick === 0 ? 1.5 : 1}
                strokeDasharray={tick === 0 ? '4 3' : undefined}
              />
              <text x={padding.left - 10} y={y + 4} textAnchor="end" fill="#8fa1b8" fontSize={11}>
                {formatDollars(tick)}
              </text>
            </g>
          )
        })}
        {hourLabels.map((label, i) => (
          <text
            key={label}
            x={toX(label)}
            y={height - padding.bottom + 20}
            textAnchor={i === 0 ? 'start' : i === hourLabels.length - 1 ? 'end' : 'middle'}
            fill="#8fa1b8"
            fontSize={11}
          >
            {formatHourLabel(label)}
          </text>
        ))}
        <path d={areaPath} fill="url(#pnlArea)" stroke="none" />
        {points.slice(1).map((p, i) => {
          const prev = points[i]
          const segStroke =
            p.cumulativeCents > prev.cumulativeCents
              ? 'var(--color-positive)'
              : p.cumulativeCents < prev.cumulativeCents
                ? 'var(--color-negative-400)'
                : 'var(--color-slate-500)'
          return (
            <line
              key={`seg-${p.trade?.id ?? p.at}`}
              x1={toX(prev.at)}
              y1={toY(prev.cumulativeCents)}
              x2={toX(p.at)}
              y2={toY(p.cumulativeCents)}
              stroke={segStroke}
              strokeWidth={2}
            />
          )
        })}
        {points
          .map((p, i) => ({ p, prev: points[i - 1] }))
          .filter(({ p }) => p.trade)
          .map(({ p, prev }) => (
            <circle
              key={p.trade?.id ?? p.at}
              cx={toX(p.at)}
              cy={toY(p.cumulativeCents)}
              r={1.75}
              fill={
                p.cumulativeCents > (prev?.cumulativeCents ?? 0)
                  ? 'var(--color-positive)'
                  : p.cumulativeCents < (prev?.cumulativeCents ?? 0)
                    ? 'var(--color-negative-400)'
                    : 'var(--color-slate-500)'
              }
            />
          ))}
        {points
          .map((p, i) => ({ p, prev: points[i - 1] }))
          .filter(({ p }) => p.trade)
          .map(({ p, prev }) => (
            <rect
              key={`zone-${p.trade?.id ?? p.at}`}
              x={toX(prev?.at ?? since)}
              y={padding.top}
              width={Math.max(0, toX(p.at) - toX(prev?.at ?? since))}
              height={plotHeight}
              fill="transparent"
              className="hover:fill-slate-400/10"
              onMouseEnter={() => setHovered(p)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
      </svg>
      {hovered?.trade && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-slate-600 bg-slate-900/95 px-2.5 py-1.5 text-xs text-slate-100 shadow-lg"
          style={{
            left: `${Math.min(88, Math.max(12, (toX(hovered.at) / width) * 100))}%`,
            top: `${Math.max(4, (toY(hovered.cumulativeCents) / height) * 100 - 3)}%`,
          }}
        >
          {`${hovered.trade.rangeName} · ${formatJournalDate(hovered.at)} · ${formatPnl(
            hovered.trade.realizedDollarsCents ?? 0,
          )} → ${formatDollars(hovered.cumulativeCents)}`}
        </div>
      )}
    </div>
  )
}

function OutcomeDonut({ wins, losses, breakevens }: { wins: number; losses: number; breakevens: number }) {
  const total = wins + losses + breakevens
  const radius = 56
  const circumference = 2 * Math.PI * radius
  const segments = [
    { label: 'Wins', value: wins, color: 'var(--color-positive)' },
    { label: 'Losses', value: losses, color: 'var(--color-negative-400, #f87171)' },
    { label: 'Breakeven', value: breakevens, color: '#64748b' },
  ].filter((segment) => segment.value > 0)

  let offset = 0
  const arcs = segments.map((segment) => {
    const fraction = total ? segment.value / total : 0
    const arc = { ...segment, dash: fraction * circumference, offset }
    offset += arc.dash
    return arc
  })

  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 140 140" className="h-32 w-32 shrink-0" role="img" aria-label="Trade outcomes">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--color-slate-800)" strokeWidth="16" />
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth="16"
            strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
            strokeDashoffset={-arc.offset + circumference / 4}
          />
        ))}
        <text x="70" y="66" textAnchor="middle" fill="#f1f5f9" fontSize="22" fontWeight="700">
          {total}
        </text>
        <text x="70" y="84" textAnchor="middle" fill="#8fa1b8" fontSize="10">
          {total === 1 ? 'trade' : 'trades'}
        </text>
      </svg>
      <div className="grid gap-2 text-sm">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
            <span className="text-slate-400">{segment.label}</span>
            <span className="font-semibold text-slate-200">{segment.value}</span>
            <span className="text-xs text-slate-500">
              {total ? `(${formatPercent(segment.value / total)})` : ''}
            </span>
          </div>
        ))}
        {total === 0 && <span className="text-slate-500">No closed trades</span>}
      </div>
    </div>
  )
}

function RangeBars({ ranges }: { ranges: CalendarDayRange[] }) {
  const maxAbs = Math.max(1, ...ranges.map((range) => Math.abs(range.realizedDollarsCents)))
  return (
    <div className="grid gap-2">
      {ranges.map((range) => {
        const widthPct = Math.max(3, (Math.abs(range.realizedDollarsCents) / maxAbs) * 100)
        const positive = range.realizedDollarsCents >= 0
        return (
          <div key={`${range.rangeName}\u0000${range.instrument}`}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-medium text-slate-200" title={range.rangeName}>
                {range.rangeName}
                <span className="ml-2 text-xs font-normal text-slate-500">{displayInstrument(range.instrument)}</span>
              </span>
              <span className={`font-semibold ${classForCents(range.realizedDollarsCents)}`}>
                {formatPnl(range.realizedDollarsCents)}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full rounded-full ${positive ? 'bg-positive' : 'bg-negative-400'}`}
                  style={{ width: `${widthPct}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-slate-500">
                {range.closedCount} {range.closedCount === 1 ? 'trade' : 'trades'} · {range.wins}W/{range.losses}L
                {range.breakevens > 0 ? `/${range.breakevens}BE` : ''}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatCard({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold ${tone ?? 'text-slate-100'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  )
}

export function AccountPnlReviewPage() {
  const { accountId } = useParams<{ accountId: string }>()
  const [review, setReview] = useState<AccountPnlReview | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [fetching, setFetching] = useState(false)

  const refresh = useCallback(() => {
    if (!accountId) return
    setFetching(true)
    getJson<AccountPnlReview>(`/api/accounts/${accountId}/pnl-review`)
      .then((data) => {
        setReview(data)
        setLoadError(undefined)
      })
      .catch((err) => {
        console.error('Failed to load P&L review:', err)
        setLoadError('Failed to load P&L review')
      })
      .finally(() => setFetching(false))
  }, [accountId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const best = useMemo(
    () =>
      review?.trades
        .filter((trade) => !trade.excludedFromPerformance)
        .reduce<TradeEvent | undefined>(
          (current, trade) =>
            (trade.realizedDollarsCents ?? 0) > (current?.realizedDollarsCents ?? Number.NEGATIVE_INFINITY)
              ? trade
              : current,
          undefined,
        ),
    [review],
  )
  const worst = useMemo(
    () =>
      review?.trades
        .filter((trade) => !trade.excludedFromPerformance)
        .reduce<TradeEvent | undefined>(
          (current, trade) =>
            (trade.realizedDollarsCents ?? 0) < (current?.realizedDollarsCents ?? Number.POSITIVE_INFINITY)
              ? trade
              : current,
          undefined,
        ),
    [review],
  )

  if (!review && !loadError) {
    return (
      <div className="flex justify-center py-24">
        <LoadingSpinner />
      </div>
    )
  }

  if (loadError || !review) {
    return (
      <div className="space-y-6">
        <PageHeader title="Account P&L" subtitle="Last 24 hours" onTitleClick={refresh} />
        <Card>
          <p className="text-negative-400">{loadError ?? 'Account not found'}</p>
          <Link to="/app/accounts" className="mt-3 inline-block text-sm text-indigo-400 hover:text-indigo-300">
            Back to accounts
          </Link>
        </Card>
      </div>
    )
  }

  const { account, summary, ranges, trades, since, until } = review

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${account.name} P&L`}
        subtitle="Last 24 hours"
        description={`Closed trades from ${formatJournalDate(since)} to ${formatJournalDate(until)}. Click the title to refresh.`}
        onTitleClick={refresh}
      >
        {fetching && <LoadingSpinner className="h-5 w-5" />}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Net P&L"
          value={formatPnl(summary.realizedDollarsCents)}
          tone={classForCents(summary.realizedDollarsCents)}
          sub={`${formatTicks(summary.netTicksCents)} ticks`}
        />
        <StatCard
          label="Trades"
          value={String(summary.closedCount)}
          sub={`${summary.wins}W · ${summary.losses}L · ${summary.breakevens}BE`}
        />
        <StatCard label="Win rate" value={formatPercent(summary.winRate)} />
        <StatCard label="Profit factor" value={formatRatio(profitFactor(summary))} />
        <StatCard
          label="Avg win"
          value={summary.averageWinDollarsCents == null ? '—' : formatPnl(summary.averageWinDollarsCents)}
          tone="text-positive"
        />
        <StatCard
          label="Avg loss"
          value={summary.averageLossDollarsCents == null ? '—' : formatPnl(summary.averageLossDollarsCents)}
          tone="text-negative-400"
        />
        <StatCard
          label="Best trade"
          value={best ? formatPnl(best.realizedDollarsCents ?? 0) : '—'}
          tone={best ? classForCents(best.realizedDollarsCents ?? 0) : undefined}
          sub={best?.rangeName}
        />
        <StatCard
          label="Worst trade"
          value={worst ? formatPnl(worst.realizedDollarsCents ?? 0) : '—'}
          tone={worst ? classForCents(worst.realizedDollarsCents ?? 0) : undefined}
          sub={worst?.rangeName}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Equity curve" className="lg:col-span-2">
          {summary.closedCount === 0 ? (
            <p className="py-12 text-center text-slate-500">No closed trades in the last 24 hours.</p>
          ) : (
            <EquityCurve since={since} until={until} trades={trades} />
          )}
        </Card>
        <Card title="Outcomes">
          <OutcomeDonut wins={summary.wins} losses={summary.losses} breakevens={summary.breakevens} />
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="By range">
          {ranges.length === 0 ? (
            <p className="py-8 text-center text-slate-500">No range activity.</p>
          ) : (
            <RangeBars ranges={ranges} />
          )}
        </Card>
        <Card title="Closed trades" className="lg:col-span-2">
          {trades.length === 0 ? (
            <p className="py-8 text-center text-slate-500">Nothing closed in this window.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-widest text-slate-500">
                    <th className="pb-2 pr-4 font-medium">Time</th>
                    <th className="pb-2 pr-4 font-medium">Range</th>
                    <th className="pb-2 pr-4 font-medium">Side</th>
                    <th className="pb-2 pr-4 font-medium">Result</th>
                    <th className="pb-2 text-right font-medium">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, TABLE_DISPLAY_LIMIT).map((trade) => (
                    <tr key={trade.id} className="border-b border-slate-800 last:border-0">
                      <td className="py-2.5 pr-4 whitespace-nowrap text-slate-400">
                        <JournalDate value={trade.occurredAt} />
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className="text-slate-200">{trade.rangeName}</span>
                        <span className="ml-2 text-xs text-slate-500">{displayInstrument(trade.instrument)}</span>
                        {trade.excludedFromPerformance && (
                          <span className="ml-2 rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-400">
                            excluded
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 capitalize text-slate-300">{trade.side}</td>
                      <td className="py-2.5 pr-4">
                        <span
                          className={
                            trade.outcome === 'win'
                              ? 'text-positive'
                              : trade.outcome === 'loss'
                                ? 'text-negative-400'
                                : 'text-slate-400'
                          }
                        >
                          {trade.outcome ?? '—'}
                        </span>
                      </td>
                      <td className={`py-2.5 text-right font-semibold ${classForCents(trade.realizedDollarsCents ?? 0)}`}>
                        {formatPnl(trade.realizedDollarsCents ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {trades.length > TABLE_DISPLAY_LIMIT && (
                <p className="pt-3 text-center text-xs text-slate-500">
                  Showing {TABLE_DISPLAY_LIMIT} of {trades.length} trades — totals and charts include all of them.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
