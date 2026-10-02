// Semicircle gauge — three colored bands (negative / amber / positive) with a
// needle at `value` percent. Bands match the app's theme color vars.
export function GaugeChart({
  value,
  label,
  size = 170,
}: {
  /** 0–100 */
  value: number
  label: string
  size?: number
}) {
  const pct = Math.max(0, Math.min(100, value))
  const stroke = Math.max(10, size * 0.1)
  const w = size
  const h = size * 0.62
  const cx = w / 2
  const cy = h - 6
  const r = Math.min(w / 2, cy) - stroke / 2 - 2

  // Arc from angle degrees (180 = left, 0 = right) on the semicircle.
  const point = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) }
  }
  const band = (fromPct: number, toPct: number) => {
    const a = point(180 - (fromPct / 100) * 180)
    const b = point(180 - (toPct / 100) * 180)
    return `M ${a.x} ${a.y} A ${r} ${r} 0 0 1 ${b.x} ${b.y}`
  }
  const needleTip = (() => {
    const rad = ((180 - (pct / 100) * 180) * Math.PI) / 180
    const len = r - stroke / 2 - 4
    return { x: cx + len * Math.cos(rad), y: cy - len * Math.sin(rad) }
  })()

  return (
    <div style={{ width: '100%', maxWidth: size }}>
      <svg className="h-auto w-full" viewBox={`0 0 ${w} ${h}`}>
        <defs>
          {/* Continuous red→amber→green sweep across the arc — replaces the
             hard band edges with a smooth gradient. CSS vars keep it themed. */}
          <linearGradient id="gauge-arc" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-negative-500)" />
            <stop offset="50%" stopColor="var(--color-amber-400)" />
            <stop offset="100%" stopColor="var(--color-positive-500)" />
          </linearGradient>
          {/* Specular sheen — translucent white fade for the glass themes. */}
          <linearGradient id="gauge-gloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.55)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
        <path d={band(0, 100)} fill="none" stroke="url(#gauge-arc)" strokeOpacity={0.9} strokeWidth={stroke} />
        {/* Glass highlight — hidden unless a theme enables .gauge-gloss. */}
        <path className="gauge-gloss" d={band(0, 100)} fill="none" stroke="url(#gauge-gloss)" strokeWidth={stroke * 0.35} strokeLinecap="round" transform={`translate(0 ${-stroke * 0.22})`} />
        <circle cx={cx} cy={cy} r={stroke * 0.45} fill="currentColor" className="text-slate-200" />
        <line
          x1={cx}
          y1={cy}
          x2={needleTip.x}
          y2={needleTip.y}
          stroke="currentColor"
          className="text-slate-200"
          strokeWidth={Math.max(3, size * 0.025)}
          strokeLinecap="round"
        />
      </svg>
      <div className="mt-1 text-center text-lg font-bold text-slate-100">{label}</div>
    </div>
  )
}
