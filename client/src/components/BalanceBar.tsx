interface BalanceBarProps {
  positive: number
  negative: number
}

export function BalanceBar({ positive, negative }: BalanceBarProps) {
  const total = Math.max(1, positive + negative)
  const positivePct = Math.round((positive / total) * 100)
  const negativePct = 100 - positivePct

  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-slate-900">
      {positivePct > 0 && (
        <div
          className="h-full bg-positive-400"
          style={{ width: `${positivePct}%` }}
        />
      )}
      {negativePct > 0 && (
        <div
          className="h-full bg-negative-400"
          style={{ width: `${negativePct}%` }}
        />
      )}
    </div>
  )
}
