import { useMemo } from 'react'
import { classForCents, formatDollars, formatPnl } from '../utils/format'
import type { CalendarDay, JournalMetrics } from '../types'

interface DailyCumulativeChartProps {
  days: CalendarDay[]
  month: JournalMetrics
  monthLabel: string
}

export function DailyCumulativeChart({
  days,
  month,
  monthLabel,
}: DailyCumulativeChartProps) {
  const data = useMemo(() => {
    let cumulative = 0
    return days.map((d) => {
      cumulative += d.realizedDollarsCents
      return {
        date: d.date,
        day: Number(d.date.slice(8)),
        cumulative,
      }
    })
  }, [days])

  const yMax = useMemo(() => {
    const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.cumulative / 100)))
    return Math.ceil(maxAbs / 5000) * 5000
  }, [data])

  const width = 800
  const height = 290
  const padding = { top: 40, right: 40, bottom: 44, left: 90 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const total = Math.max(1, data.length - 1)

  const points = data.map((d, i) => {
    const x = padding.left + (i / total) * plotWidth
    const y =
      padding.top +
      plotHeight -
      ((d.cumulative / 100 + yMax) / (2 * yMax)) * plotHeight
    return { x, y, ...d }
  })

  const linePath = points.length
    ? `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}`
    : ''
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x} ${
        padding.top + plotHeight
      } L ${points[0].x} ${padding.top + plotHeight} Z`
    : ''

  const ticks = [yMax, yMax / 2, 0, -yMax / 2, -yMax]
  const curveColor =
    month.realizedDollarsCents < 0
      ? 'var(--color-negative)'
      : 'var(--color-positive)'
  const xLabels = useMemo(() => {
    if (data.length === 0) return []
    const mid = Math.floor(data.length / 2)
    return [
      { day: data[0].day, index: 0 },
      { day: data[mid].day, index: mid },
      { day: data[data.length - 1].day, index: data.length - 1 },
    ]
  }, [data])

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-100">
            Daily net cumulative P&L
          </h3>
          <p className="text-sm text-slate-400">
            Running monthly curve using the selected journal scope.
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs font-bold uppercase tracking-widest text-slate-400">
            {monthLabel}
          </div>
          <div
            className={`text-lg font-bold ${classForCents(
              month.realizedDollarsCents,
            )}`}
          >
            {formatPnl(month.realizedDollarsCents)}
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label="Daily cumulative P&L"
      >
        <defs>
          <linearGradient id="cumulativeArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={curveColor} stopOpacity="0.28" />
            <stop offset="100%" stopColor={curveColor} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {ticks.map((tick) => {
          const y =
            padding.top +
            plotHeight -
            ((tick + yMax) / (2 * yMax)) * plotHeight
          return (
            <g key={tick}>
              <line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="var(--color-slate-800)"
                strokeWidth={1}
              />
              <text
                x={padding.left - 12}
                y={y + 4}
                textAnchor="end"
                fill="var(--color-slate-500)"
                fontSize={12}
              >
                {formatDollars(tick * 100)}
              </text>
            </g>
          )
        })}

        {xLabels.map((label) => {
          const x = padding.left + (label.index / total) * plotWidth
          return (
            <text
              key={label.day}
              x={x}
              y={height - padding.bottom + 24}
              textAnchor="middle"
              fill="var(--color-slate-500)"
              fontSize={12}
            >
              {label.day}
            </text>
          )
        })}

        <path d={areaPath} fill="url(#cumulativeArea)" stroke="none" />
        <path d={linePath} fill="none" stroke="var(--color-slate-500)" strokeWidth={2} />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={1.75} fill={curveColor} />
        ))}
      </svg>
    </div>
  )
}
