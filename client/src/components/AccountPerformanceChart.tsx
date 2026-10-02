import { formatPnl, formatPercent } from '../utils/format'
import type { AccountJournal, TradeStats } from '../types'

interface AccountPerformanceChartProps {
  accounts: AccountJournal[]
}

function stat(stats: TradeStats | undefined, key: keyof TradeStats): string {
  if (!stats) return '—'
  const v = stats[key]
  if (v == null) return '—'
  if (key === 'profitFactor') return v === Number.POSITIVE_INFINITY ? '∞' : Number(v).toFixed(2)
  if (key === 'expectancyDollarsCents' || key === 'maxDrawdownDollarsCents' || key === 'largestWinDollarsCents' || key === 'largestLossDollarsCents')
    return formatPnl(v)
  return String(v)
}

function MetricsTable({ accounts }: { accounts: AccountJournal[] }) {
  const columns: Array<{ label: string; render: (aj: AccountJournal) => string; tone?: (aj: AccountJournal) => string }> = [
    { label: 'Trades', render: (aj) => String(aj.allTime.closedCount) },
    { label: 'Win %', render: (aj) => aj.allTime.winRate != null ? formatPercent(aj.allTime.winRate) : '—' },
    { label: 'Profit factor', render: (aj) => stat(aj.stats, 'profitFactor') },
    { label: 'Expectancy', render: (aj) => stat(aj.stats, 'expectancyDollarsCents') },
    { label: 'Avg win', render: (aj) => aj.allTime.averageWinDollarsCents != null ? formatPnl(aj.allTime.averageWinDollarsCents) : '—' },
    { label: 'Avg loss', render: (aj) => aj.allTime.averageLossDollarsCents != null ? formatPnl(aj.allTime.averageLossDollarsCents) : '—' },
    { label: 'Max drawdown', render: (aj) => aj.stats ? `-${formatPnl(aj.stats.maxDrawdownDollarsCents)}` : '—', tone: () => 'text-negative-400' },
    { label: 'Best trade', render: (aj) => stat(aj.stats, 'largestWinDollarsCents'), tone: () => 'text-positive' },
    { label: 'Worst trade', render: (aj) => stat(aj.stats, 'largestLossDollarsCents'), tone: () => 'text-negative-400' },
    { label: 'Win streak', render: (aj) => stat(aj.stats, 'longestWinStreak') },
    { label: 'Loss streak', render: (aj) => stat(aj.stats, 'longestLossStreak') },
  ]
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-slate-700 bg-slate-800">
      <table className="w-full min-w-[960px] text-left text-sm">
        <thead>
          <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
            <th className="px-4 py-2.5">Account</th>
            {columns.map((c) => (
              <th key={c.label} className="px-3 py-2.5 text-right">{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-700">
          {accounts.map((aj) => (
            <tr key={aj.account.id}>
              <td className="px-4 py-2.5 font-semibold text-slate-200">{aj.account.name}</td>
              {columns.map((c) => (
                <td key={c.label} className={`px-3 py-2.5 text-right ${c.tone ? c.tone(aj) : 'text-slate-200'}`}>
                  {c.render(aj)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AccountPerformanceChart({
  accounts,
}: AccountPerformanceChartProps) {
  if (!accounts.length) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-6 text-slate-400">
        No account performance to chart yet.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-800 p-4">
      <MetricsTable accounts={accounts} />
    </div>
  )
}
