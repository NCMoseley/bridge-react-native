import { useEffect, useMemo, useState } from 'react'
import { getJson } from '../api/client'
import { classForCents, formatPnl } from '../utils/format'

const EQUITY_WINDOWS = [7, 14, 30, 90] as const

// Fetches and renders a cumulative equity curve over an adjustable trailing
// window. `query` is the endpoint's identifying params, e.g.
// `subcategory=ALPHA` or `range=OPENING RANGE`.
export function EquityChart({ label, query }: { label: string; query: string }) {
  const [windowDays, setWindowDays] = useState<number>(30)
  const [days, setDays] = useState<Array<{ date: string; realizedDollarsCents: number }>>([])
  useEffect(() => {
    let cancelled = false
    // Drop the old series immediately — stale data must never be relabeled
    // under a new query or window.
    setDays([])
    getJson<{ days: Array<{ date: string; realizedDollarsCents: number }> }>(
      `/api/model-equity?${query}&days=${windowDays}`,
    )
      .then((res) => {
        if (!cancelled) setDays(res.days)
      })
      .catch(() => {
        // Clear rather than leave old data relabeled under the new window.
        if (!cancelled) setDays([])
      })
    return () => {
      cancelled = true
    }
  }, [query, windowDays])
  const selector = (
    <div className="flex items-center gap-0.5 rounded-md border border-slate-700 p-0.5">
      {EQUITY_WINDOWS.map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => setWindowDays(n)}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition ${
            windowDays === n
              ? 'bg-slate-600 text-white'
              : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200'
          }`}
        >
          {n}d
        </button>
      ))}
    </div>
  )
  return (
    <ModelEquityChart
      days={days}
      model={label}
      windowDays={windowDays}
      windowSelector={selector}
    />
  )
}

interface ModelEquityChartProps {
  days: Array<{ date: string; realizedDollarsCents: number }>
  model: string
  windowDays: number
  windowSelector?: React.ReactNode
}

// N-day cumulative realized P&L curve for one model — the same equity-line
// shape as the journal's daily cumulative chart.
export function ModelEquityChart({ days, model, windowDays, windowSelector }: ModelEquityChartProps) {
  const data = useMemo(() => {
    let cumulative = 0
    return days.map((d) => {
      cumulative += d.realizedDollarsCents
      return { date: d.date, cumulative }
    })
  }, [days])

  const total = data.length ? data[data.length - 1].cumulative : 0

  const yMax = useMemo(() => {
    const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.cumulative / 100)))
    return Math.ceil(maxAbs / 500) * 500
  }, [data])

  const width = 800
  const height = 220
  const padding = { top: 24, right: 24, bottom: 32, left: 64 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const span = Math.max(1, data.length - 1)

  const points = data.map((d, i) => ({
    x: padding.left + (i / span) * plotWidth,
    y:
      padding.top +
      plotHeight -
      ((d.cumulative / 100 + yMax) / (2 * yMax)) * plotHeight,
    ...d,
  }))

  const linePath = points.length
    ? `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}`
    : ''
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x} ${
        padding.top + plotHeight
      } L ${points[0].x} ${padding.top + plotHeight} Z`
    : ''

  const yTicks = [yMax, yMax / 2, 0, -yMax / 2, -yMax]
  const curveColor =
    total < 0 ? 'var(--color-negative)' : 'var(--color-positive)'

  if (data.length === 0) {
    return (
      <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800 px-2 py-5 text-center text-sm text-slate-400 sm:p-5">
        {windowSelector && <div className="mb-2 flex justify-end">{windowSelector}</div>}
        No closed trades in the last {windowDays} days.
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900 p-4">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h4 className="text-sm font-semibold text-slate-100">
            {model} — {windowDays}-day equity
          </h4>
          <p className="text-xs text-slate-400">
            Cumulative realized P&L for {model}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {windowSelector}
          <span className={`text-sm font-semibold ${classForCents(total)}`}>
            {formatPnl(total)}
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`${model} ${windowDays}-day cumulative equity`}
      >
        {yTicks.map((tick) => {
          const y =
            padding.top +
            plotHeight -
            ((tick + yMax) / (2 * yMax)) * plotHeight
          return (
            <g key={tick}>
              <line
                x1={padding.left}
                x2={padding.left + plotWidth}
                y1={y}
                y2={y}
                stroke={tick === 0 ? '#64748b' : '#334155'}
                strokeDasharray={tick === 0 ? '' : '3 3'}
                strokeWidth={tick === 0 ? 1.2 : 0.8}
              />
              <text
                x={padding.left - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-slate-500"
                fontSize={11}
              >
                {formatPnl(tick * 100)}
              </text>
            </g>
          )
        })}
        {points.length > 0 && (
          <>
            <path d={areaPath} fill={curveColor} opacity={0.12} />
            <path
              d={linePath}
              fill="none"
              stroke={curveColor}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          </>
        )}
        <text
          x={padding.left}
          y={height - 8}
          className="fill-slate-500"
          fontSize={11}
        >
          {data[0].date.slice(5)}
        </text>
        <text
          x={padding.left + plotWidth}
          y={height - 8}
          textAnchor="end"
          className="fill-slate-500"
          fontSize={11}
        >
          {data[data.length - 1].date.slice(5)}
        </text>
      </svg>
    </div>
  )
}
