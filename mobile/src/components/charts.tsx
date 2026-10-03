import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, Line, Path, Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg'
import { getJson } from '../api/client'
import {
  formatDollars,
  formatPercent,
  formatPnl,
  formatTicks,
  JOURNAL_TIME_ZONE,
 formatJournalDate } from '../utils/format'
import type { AccountJournal, CalendarDay, JournalMetrics, TradeStats } from '../types'
import { colors, pnlColor, RingChart, toneForCents, GlassSurface ,
  themedStyles,
} from './ui'

// ---- JournalDate ----


// ---- DailyCumulativeChart ----

export function DailyCumulativeChart({
  days,
  month,
  monthLabel,
}: {
  days: CalendarDay[]
  month: JournalMetrics
  monthLabel: string
}) {
  const data = useMemo(() => {
    let cumulative = 0
    return days.map((d) => {
      cumulative += d.realizedDollarsCents
      return { date: d.date, day: Number(d.date.slice(8)), cumulative }
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

  const points = data.map((d, i) => ({
    x: padding.left + (i / total) * plotWidth,
    y: padding.top + plotHeight - ((d.cumulative / 100 + yMax) / (2 * yMax)) * plotHeight,
    ...d,
  }))
  const linePath = points.length ? `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}` : ''
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x} ${padding.top + plotHeight} L ${points[0].x} ${padding.top + plotHeight} Z`
    : ''
  const ticks = [yMax, yMax / 2, 0, -yMax / 2, -yMax]
  const curveColor = month.realizedDollarsCents < 0 ? colors.negative : colors.positive
  const xLabels = useMemo(() => {
    if (data.length === 0) return []
    const mid = Math.floor(data.length / 2)
    const labels = [
      { day: data[0].day, index: 0, date: data[0].date },
      { day: data[mid].day, index: mid, date: data[mid].date },
      { day: data[data.length - 1].day, index: data.length - 1, date: data[data.length - 1].date },
    ]
    return labels.filter((l, i) => labels.findIndex((o) => o.index === l.index) === i)
  }, [data])

  return (
    <GlassSurface style={chartStyles.panel}>
      <View style={chartStyles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={chartStyles.title}>Daily net cumulative P&L</Text>
          <Text style={chartStyles.subtitle}>Running monthly curve using the selected journal scope.</Text>
        </View>
        <View>
          <Text style={chartStyles.headerKicker}>{monthLabel}</Text>
          <Text style={[chartStyles.headerValue, { color: pnlColor(month.realizedDollarsCents) }]}>
            {formatPnl(month.realizedDollarsCents)}
          </Text>
        </View>
      </View>
      <Svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: undefined, aspectRatio: width / height }}>
        <Defs>
          <LinearGradient id="cumulativeArea" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={curveColor} stopOpacity={0.28} />
            <Stop offset="100%" stopColor={curveColor} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>
        {ticks.map((tick) => {
          const y = padding.top + plotHeight - ((tick + yMax) / (2 * yMax)) * plotHeight
          return (
            <Svg key={tick}>
              <Line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke={colors.border} strokeWidth={1} />
              <SvgText x={padding.left - 12} y={y + 4} textAnchor="end" fill={colors.faint} fontSize={12}>
                {formatDollars(tick * 100)}
              </SvgText>
            </Svg>
          )
        })}
        {xLabels.map((label) => (
          <SvgText
            key={label.date}
            x={padding.left + (label.index / total) * plotWidth}
            y={height - padding.bottom + 24}
            textAnchor="middle"
            fill={colors.faint}
            fontSize={12}
          >
            {label.day}
          </SvgText>
        ))}
        {areaPath ? <Path d={areaPath} fill="url(#cumulativeArea)" /> : null}
        {linePath ? <Path d={linePath} fill="none" stroke={colors.faint} strokeWidth={2} /> : null}
        {points.map((p, i) => (
          <Circle key={i} cx={p.x} cy={p.y} r={1.75} fill={curveColor} />
        ))}
      </Svg>
    </GlassSurface>
  )
}

// ---- MonthlyPerformanceMix ----

export function MonthlyPerformanceMix({
  overall,
  month,
  activeDays,
}: {
  overall: JournalMetrics
  month: JournalMetrics
  activeDays: number
}) {
  return (
    <GlassSurface style={chartStyles.panel}>
      <Text style={chartStyles.title}>Monthly Performance</Text>
      <Text style={chartStyles.subtitle}>Quick read on this month&apos;s trade distribution and averages.</Text>
      <View style={{ alignItems: 'center', flexDirection: 'row', gap: 16, marginVertical: 12 }}>
        <RingChart positive={overall.wins} negative={overall.losses} label={String(month.closedCount)} size={110} />
        <View>
          <Text style={chartStyles.mixStat}>Wins <Text style={chartStyles.mixStrong}>{overall.wins}</Text></Text>
          <Text style={chartStyles.mixStat}>Losses <Text style={chartStyles.mixStrong}>{overall.losses}</Text></Text>
          <Text style={chartStyles.mixStat}>Breakevens <Text style={chartStyles.mixStrong}>{overall.breakevens}</Text></Text>
        </View>
      </View>
      <View style={{ gap: 6 }}>
        <View style={chartStyles.mixRow}>
          <Text style={chartStyles.mixStat}>Avg win</Text>
          <Text style={{ color: colors.positive, fontWeight: '600' }}>
            {overall.averageWinDollarsCents == null ? '—' : formatDollars(overall.averageWinDollarsCents)}
          </Text>
        </View>
        <View style={chartStyles.mixRow}>
          <Text style={chartStyles.mixStat}>Avg loss</Text>
          <Text style={{ color: colors.negative, fontWeight: '600' }}>
            {overall.averageLossDollarsCents == null ? '—' : formatDollars(overall.averageLossDollarsCents)}
          </Text>
        </View>
        <View style={chartStyles.mixRow}>
          <Text style={chartStyles.mixStat}>Net ticks</Text>
          <Text style={{ color: pnlColor(overall.netTicksCents), fontWeight: '600' }}>
            {formatTicks(overall.netTicksCents)}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <Text style={chartStyles.chip}>Decisive trades {month.closedCount}</Text>
        <Text style={chartStyles.chip}>Active days {activeDays}</Text>
      </View>
    </GlassSurface>
  )
}

// ---- ModelEquityChart / EquityChart ----

const EQUITY_WINDOWS = [7, 14, 30, 90] as const

export function EquityChart({ label, query }: { label: string; query: string }) {
  const [windowDays, setWindowDays] = useState<number>(30)
  const [days, setDays] = useState<{ date: string; realizedDollarsCents: number }[]>([])
  useEffect(() => {
    let cancelled = false
    setDays([])
    getJson<{ days: { date: string; realizedDollarsCents: number }[] }>(
      `/api/model-equity?${query}&days=${windowDays}`,
    )
      .then((res) => {
        if (!cancelled) setDays(res.days)
      })
      .catch(() => {
        if (!cancelled) setDays([])
      })
    return () => {
      cancelled = true
    }
  }, [query, windowDays])

  const selector = (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {EQUITY_WINDOWS.map((n) => (
        <Pressable
          key={n}
          onPress={() => setWindowDays(n)}
          style={[chartStyles.windowBtn, windowDays === n && chartStyles.windowBtnActive]}
        >
          <Text style={[chartStyles.windowBtnText, windowDays === n && { color: colors.text }]}>{n}d</Text>
        </Pressable>
      ))}
    </View>
  )
  return <ModelEquityChart days={days} model={label} windowDays={windowDays} windowSelector={selector} />
}

export function ModelEquityChart({
  days,
  model,
  windowDays,
  windowSelector,
}: {
  days: { date: string; realizedDollarsCents: number }[]
  model: string
  windowDays: number
  windowSelector?: React.ReactNode
}) {
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
    y: padding.top + plotHeight - ((d.cumulative / 100 + yMax) / (2 * yMax)) * plotHeight,
    ...d,
  }))
  const linePath = points.length ? `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}` : ''
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x} ${padding.top + plotHeight} L ${points[0].x} ${padding.top + plotHeight} Z`
    : ''
  const yTicks = [yMax, yMax / 2, 0, -yMax / 2, -yMax]
  const curveColor = total < 0 ? colors.negative : colors.positive

  if (data.length === 0) {
    return (
      <GlassSurface style={[chartStyles.panel, { marginTop: 8 }]}>
        {windowSelector ? <View style={{ alignItems: 'flex-end', marginBottom: 4 }}>{windowSelector}</View> : null}
        <Text style={chartStyles.subtitle}>No closed trades in the last {windowDays} days.</Text>
    </GlassSurface>
    )
  }

  return (
    <GlassSurface style={[chartStyles.panel, { marginTop: 8 }]}>
      <View style={chartStyles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={chartStyles.titleSmall}>{model} — {windowDays}-day equity</Text>
          <Text style={chartStyles.subtitle}>Cumulative realized P&L</Text>
        </View>
        {windowSelector}
        <Text style={[chartStyles.headerValue, { color: pnlColor(total), marginLeft: 12 }]}>
          {formatPnl(total)}
        </Text>
      </View>
      <Svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: undefined, aspectRatio: width / height }}>
        <Defs>
          <LinearGradient id="equityArea" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0%" stopColor={curveColor} stopOpacity={0.28} />
            <Stop offset="100%" stopColor={curveColor} stopOpacity={0.02} />
          </LinearGradient>
        </Defs>
        {yTicks.map((tick) => {
          const y = padding.top + plotHeight - ((tick + yMax) / (2 * yMax)) * plotHeight
          return (
            <Svg key={tick}>
              <Line x1={padding.left} y1={y} x2={width - padding.right} y2={y} stroke={colors.border} strokeWidth={1} />
              <SvgText x={padding.left - 10} y={y + 4} textAnchor="end" fill={colors.faint} fontSize={12}>
                {formatDollars(tick * 100)}
              </SvgText>
            </Svg>
          )
        })}
        {areaPath ? <Path d={areaPath} fill="url(#equityArea)" /> : null}
        {linePath ? <Path d={linePath} fill="none" stroke={colors.faint} strokeWidth={2} /> : null}
        {points.map((p, i) => (
          <Circle key={i} cx={p.x} cy={p.y} r={1.75} fill={curveColor} />
        ))}
      </Svg>
    </GlassSurface>
  )
}

// ---- AccountPerformanceChart (metrics table) ----

function statCell(stats: TradeStats | undefined, key: keyof TradeStats): string {
  if (!stats) return '—'
  const v = stats[key]
  if (v == null) return '—'
  if (key === 'profitFactor') return v === Number.POSITIVE_INFINITY ? '∞' : Number(v).toFixed(2)
  if (
    key === 'expectancyDollarsCents' ||
    key === 'maxDrawdownDollarsCents' ||
    key === 'largestWinDollarsCents' ||
    key === 'largestLossDollarsCents'
  )
    return formatPnl(v)
  return String(v)
}

const PERF_COLUMNS: {
  label: string
  render: (aj: AccountJournal) => string
  tone?: (aj: AccountJournal) => string | undefined
}[] = [
  { label: 'Trades', render: (aj) => String(aj.allTime.closedCount) },
  { label: 'Win %', render: (aj) => (aj.allTime.winRate != null ? formatPercent(aj.allTime.winRate) : '—') },
  { label: 'Profit factor', render: (aj) => statCell(aj.stats, 'profitFactor') },
  { label: 'Expectancy', render: (aj) => statCell(aj.stats, 'expectancyDollarsCents') },
  { label: 'Avg win', render: (aj) => (aj.allTime.averageWinDollarsCents != null ? formatPnl(aj.allTime.averageWinDollarsCents) : '—') },
  { label: 'Avg loss', render: (aj) => (aj.allTime.averageLossDollarsCents != null ? formatPnl(aj.allTime.averageLossDollarsCents) : '—') },
  { label: 'Max DD', render: (aj) => (aj.stats ? `-${formatPnl(aj.stats.maxDrawdownDollarsCents)}` : '—'), tone: () => colors.negative },
  { label: 'Best', render: (aj) => statCell(aj.stats, 'largestWinDollarsCents'), tone: () => colors.positive },
  { label: 'Worst', render: (aj) => statCell(aj.stats, 'largestLossDollarsCents'), tone: () => colors.negative },
  { label: 'W streak', render: (aj) => statCell(aj.stats, 'longestWinStreak') },
  { label: 'L streak', render: (aj) => statCell(aj.stats, 'longestLossStreak') },
]

export function AccountPerformanceChart({ accounts }: { accounts: AccountJournal[] }) {
  if (!accounts.length) {
    return (
      <GlassSurface style={chartStyles.panel}>
        <Text style={chartStyles.subtitle}>No account performance to chart yet.</Text>
    </GlassSurface>
    )
  }
  return (
    <ScrollView horizontal>
      <GlassSurface style={chartStyles.panel}>
        <View style={chartStyles.tableHeader}>
          <Text style={[chartStyles.tableHeaderCell, { width: 110, textAlign: 'left' }]}>Account</Text>
          {PERF_COLUMNS.map((c) => (
            <Text key={c.label} style={chartStyles.tableHeaderCell}>{c.label}</Text>
          ))}
        </View>
        {accounts.map((aj) => (
          <View key={aj.account.id} style={chartStyles.tableRow}>
            <Text style={[chartStyles.tableCell, { width: 110, fontWeight: '600', textAlign: 'left' }]}>
              {aj.account.name}
            </Text>
            {PERF_COLUMNS.map((c) => (
              <Text key={c.label} style={[chartStyles.tableCell, c.tone?.(aj) ? { color: c.tone(aj) } : null]}>
                {c.render(aj)}
              </Text>
            ))}
          </View>
        ))}
      </GlassSurface>
    </ScrollView>
  )
}

export function JournalDate({ value }: { value: string }) {
  const formatted = formatJournalDate(value)
  const split = formatted.lastIndexOf(', ')
  const date = split > -1 ? formatted.slice(0, split) : formatted
  const time = split > -1 ? formatted.slice(split + 2) : ''
  return (
    <View>
      <Text style={{ color: colors.text, fontSize: 13 }}>{date}</Text>
      {time ? <Text style={{ color: colors.muted, fontSize: 11 }}>{time}</Text> : null}
    </View>
  )
}

// ---- Utc4Clock (compact header variant) ----

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: JOURNAL_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
})
const nyHourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: JOURNAL_TIME_ZONE,
  hour: 'numeric',
  hour12: false,
})
const nyDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: JOURNAL_TIME_ZONE,
  weekday: 'short',
})

export function Utc4Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const nyHour = Number(nyHourFormatter.format(now))
  const nyDay = nyDayFormatter.format(now)
  const marketClosed =
    nyHour === 17 || nyDay === 'Sat' || (nyDay === 'Fri' && nyHour >= 17) || (nyDay === 'Sun' && nyHour < 18)
  return (
    <View style={{ alignItems: 'center', flexDirection: 'row', gap: 6 }}>
      <View
        style={{
          backgroundColor: marketClosed ? '#ef4444' : '#34d399',
          borderRadius: 4,
          height: 8,
          width: 8,
        }}
      />
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] }}>
        {timeFormatter.format(now)}
      </Text>
    </View>
  )
}

const chartStyles = themedStyles((c) => StyleSheet.create({
  chip: {
    backgroundColor: c.bg,
    borderColor: c.border,
    borderRadius: 999,
    borderWidth: 1,
    color: c.muted,
    fontSize: 11,
    fontWeight: '600',
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  headerKicker: {
    color: c.muted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textAlign: 'right',
    textTransform: 'uppercase',
  },
  headerRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerValue: { fontSize: 18, fontWeight: '700', textAlign: 'right' },
  mixRow: { flexDirection: 'row', justifyContent: 'space-between' },
  mixStat: { color: c.muted, fontSize: 13 },
  mixStrong: { color: c.text, fontWeight: '700' },
  panel: {
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    padding: 14,
  },
  subtitle: { color: c.muted, fontSize: 12 },
  tableCell: {
    color: c.text,
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 8,
    textAlign: 'right',
    width: 86,
  },
  tableHeader: {
    borderBottomColor: c.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
  },
  tableHeaderCell: {
    color: c.muted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    paddingHorizontal: 8,
    paddingVertical: 8,
    textAlign: 'right',
    textTransform: 'uppercase',
    width: 86,
  },
  tableRow: {
    borderBottomColor: c.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
  },
  title: { color: c.text, fontSize: 16, fontWeight: '600' },
  titleSmall: { color: c.text, fontSize: 13, fontWeight: '600' },
  windowBtn: {
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  windowBtnActive: { backgroundColor: c.border },
  windowBtnText: { color: c.muted, fontSize: 10, fontWeight: '600' },
}))
