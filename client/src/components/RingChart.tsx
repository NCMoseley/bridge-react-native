interface RingChartProps {
  positive: number
  negative?: number
  label: string
  size?: number
  positiveColor?: string
  negativeColor?: string
}

export function RingChart({
  positive,
  negative = 100 - positive,
  label,
  size = 90,
  positiveColor = 'var(--color-positive)',
  negativeColor = 'var(--color-negative-400)',
}: RingChartProps) {
  const total = Math.max(1, positive + negative)
  const positivePct = positive / total
  const negativePct = negative / total

  const stroke = Math.max(8, size * 0.11)
  const r = (size - stroke) / 2 - 1
  const c = size / 2
  const circumference = 2 * Math.PI * r
  // Rounded caps eat a little into each arc — a tiny inset keeps the two
  // ends visually separated instead of bleeding into each other.
  const capGap = Math.min(0.012, 2 / circumference)
  const posLen = Math.max(0, (positivePct - capGap) * circumference)
  const negLen = Math.max(0, (negativePct - capGap) * circumference)
  const posOffset = 0
  const negOffset = -(positivePct + capGap) * circumference

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* neutral track */}
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke="var(--color-slate-700)"
          strokeOpacity={0.35}
          strokeWidth={stroke}
        />
        {/* win arc */}
        {posLen > 0 && (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={positiveColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${posLen} ${circumference}`}
            strokeDashoffset={posOffset}
            transform={`rotate(-90 ${c} ${c})`}
            style={{ filter: 'drop-shadow(0 0 4px rgba(0,166,81,0.35))' }}
          />
        )}
        {/* loss arc */}
        {negLen > 0 && (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={negativeColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${negLen} ${circumference}`}
            strokeDashoffset={negOffset}
            transform={`rotate(-90 ${c} ${c})`}
            style={{ filter: 'drop-shadow(0 0 4px rgba(220,38,38,0.3))' }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-sm font-bold text-slate-100">{label}</span>
      </div>
    </div>
  )
}
