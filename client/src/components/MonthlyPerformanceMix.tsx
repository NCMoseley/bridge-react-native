import { RingChart } from './RingChart'
import { formatDollars, formatTicks } from '../utils/format'
import type { JournalMetrics } from '../types'

interface MonthlyPerformanceMixProps {
  overall: JournalMetrics
  month: JournalMetrics
  activeDays: number
}

export function MonthlyPerformanceMix({
  overall,
  month,
  activeDays,
}: MonthlyPerformanceMixProps) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 p-5">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-slate-100">
          Monthly Performance
        </h3>
        <p className="text-sm text-slate-400">
          Quick read on this month&apos;s trade distribution and averages.
        </p>
      </div>

      <div className="mb-6 flex items-center gap-4">
        <RingChart
          positive={overall.wins}
          negative={overall.losses}
          label={String(month.closedCount)}
          size={110}
        />
        <div className="space-y-1 text-sm">
          <div className="text-slate-400">
            Wins <strong className="text-slate-100">{overall.wins}</strong>
          </div>
          <div className="text-slate-400">
            Losses <strong className="text-slate-100">{overall.losses}</strong>
          </div>
          <div className="text-slate-400">
            Breakevens{' '}
            <strong className="text-slate-100">{overall.breakevens}</strong>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">Avg win</span>
          <span className="font-semibold text-positive">
            {overall.averageWinDollarsCents == null
              ? '—'
              : formatDollars(overall.averageWinDollarsCents)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">Avg loss</span>
          <span className="font-semibold text-negative-400">
            {overall.averageLossDollarsCents == null
              ? '—'
              : formatDollars(overall.averageLossDollarsCents)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-400">Net ticks</span>
          <span
            className={`font-semibold ${
              overall.netTicksCents > 0
                ? 'text-positive'
                : overall.netTicksCents < 0
                  ? 'text-negative-400'
                  : 'text-slate-200'
            }`}
          >
            {formatTicks(overall.netTicksCents)}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">
          Decisive trades {month.closedCount}
        </span>
        <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300">
          Active days {activeDays}
        </span>
      </div>
    </div>
  )
}
