import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { getJson } from '../api/client'
import {
  Button,
  Card,
  Spinner,
  colors,
  pnlColor,
  themedStyles,
} from '../components/ui'
import { JournalDate } from '../components/charts'
import {
  formatDollars,
  formatJournalDate,
  formatPercent,
  formatPnl,
  formatRatio,
  formatTicks,
  profitFactor,
  JOURNAL_TIME_ZONE,
} from '../utils/format'
import { displayInstrument } from '../utils/instruments'
import type { AccountPnlReview, CalendarDayRange, TradeEvent } from '../types'

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

  const width = 360
  const height = 200
  const padding = { top: 12, right: 8, bottom: 24, left: 56 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const start = new Date(since).getTime()
  const end = new Date(until).getTime()
  const span = Math.max(1, end - start)
  const toX = (at: string) => padding.left + ((new Date(at).getTime() - start) / span) * plotWidth
  const toY = (cents: number) => padding.top + plotHeight - ((cents + yMax) / (2 * yMax)) * plotHeight
  const ticks = [yMax, yMax / 2, 0, -yMax / 2, -yMax]
  const hourLabels = [since, new Date(start + span / 2).toISOString(), until]

  return (
    <View>
      <Text style={styles.dimSmall}>
        Cumulative realized P&L, trade by trade. Max drawdown{' '}
        <Text style={{ color: colors.negative }}>
          {maxDrawdownCents > 0 ? `-${formatDollars(maxDrawdownCents)}` : formatDollars(0)}
        </Text>
      </Text>
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
        {ticks.map((tick) => {
          const y = toY(tick)
          return (
            <Svg key={tick}>
              <Line
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke={tick === 0 ? colors.muted : colors.border}
                strokeWidth={tick === 0 ? 1.5 : 1}
                strokeDasharray={tick === 0 ? '4 3' : undefined}
              />
              <SvgText x={padding.left - 6} y={y + 3} textAnchor="end" fill={colors.muted} fontSize={8}>
                {formatDollars(tick)}
              </SvgText>
            </Svg>
          )
        })}
        {hourLabels.map((label, i) => (
          <SvgText
            key={label}
            x={toX(label)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === hourLabels.length - 1 ? 'end' : 'middle'}
            fill={colors.muted}
            fontSize={8}
          >
            {formatHourLabel(label)}
          </SvgText>
        ))}
        {points.slice(1).map((p, i) => {
          const prev = points[i]
          const segStroke =
            p.cumulativeCents > prev.cumulativeCents
              ? colors.positive
              : p.cumulativeCents < prev.cumulativeCents
                ? colors.negative
                : colors.muted
          return (
            <Line
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
          .filter((p) => p.trade)
          .map((p, i) => {
            const prev = points[points.indexOf(p) - 1]
            return (
              <Circle
                key={p.trade?.id ?? p.at}
                cx={toX(p.at)}
                cy={toY(p.cumulativeCents)}
                r={2}
                fill={
                  p.cumulativeCents > (prev?.cumulativeCents ?? 0)
                    ? colors.positive
                    : p.cumulativeCents < (prev?.cumulativeCents ?? 0)
                      ? colors.negative
                      : colors.muted
                }
              />
            )
          })}
      </Svg>
    </View>
  )
}

function OutcomeDonut({ wins, losses, breakevens }: { wins: number; losses: number; breakevens: number }) {
  const total = wins + losses + breakevens
  const radius = 44
  const circumference = 2 * Math.PI * radius
  const segments = [
    { label: 'Wins', value: wins, color: colors.positive },
    { label: 'Losses', value: losses, color: colors.negative },
    { label: 'Breakeven', value: breakevens, color: colors.faint },
  ].filter((segment) => segment.value > 0)

  let offset = 0
  const arcs = segments.map((segment) => {
    const fraction = total ? segment.value / total : 0
    const arc = { ...segment, dash: fraction * circumference, offset }
    offset += arc.dash
    return arc
  })

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
      <Svg width={110} height={110} viewBox="0 0 110 110">
        <Circle cx={55} cy={55} r={radius} fill="none" stroke={colors.border} strokeWidth={12} />
        {arcs.map((arc) => (
          <Circle
            key={arc.label}
            cx={55}
            cy={55}
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth={12}
            strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
            strokeDashoffset={-arc.offset + circumference / 4}
          />
        ))}
        <SvgText x={55} y={52} textAnchor="middle" fill={colors.text} fontSize={16} fontWeight="bold">
          {total}
        </SvgText>
        <SvgText x={55} y={66} textAnchor="middle" fill={colors.muted} fontSize={8}>
          {total === 1 ? 'trade' : 'trades'}
        </SvgText>
      </Svg>
      <View>
        {segments.map((segment) => (
          <View key={segment.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ backgroundColor: segment.color, borderRadius: 4, height: 8, width: 8 }} />
            <Text style={styles.dim}>
              {segment.label}: <Text style={styles.value}>{segment.value}</Text>
              {total ? ` (${formatPercent(segment.value / total)})` : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}

function RangeBars({ ranges }: { ranges: CalendarDayRange[] }) {
  const maxAbs = Math.max(1, ...ranges.map((range) => Math.abs(range.realizedDollarsCents)))
  return (
    <View>
      {ranges.map((range) => {
        const widthPct = Math.max(3, (Math.abs(range.realizedDollarsCents) / maxAbs) * 100)
        const positive = range.realizedDollarsCents >= 0
        return (
          <View key={`${range.rangeName}${range.instrument}`} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={styles.value}>{range.rangeName}</Text>
              <Text style={{ color: pnlColor(range.realizedDollarsCents), fontWeight: '700', fontSize: 13 }}>
                {formatPnl(range.realizedDollarsCents)}
              </Text>
            </View>
            <View style={styles.barTrack}>
              <View
                style={{
                  backgroundColor: positive ? colors.positive : colors.negative,
                  borderRadius: 999,
                  height: '100%',
                  width: `${widthPct}%`,
                }}
              />
            </View>
            <Text style={styles.dimSmall}>
              {range.closedCount} {range.closedCount === 1 ? 'trade' : 'trades'} · {range.wins}W/{range.losses}L
              {range.breakevens > 0 ? `/${range.breakevens}BE` : ''}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

export default function AccountPnlScreen() {
  const params = useLocalSearchParams<{ accountId?: string }>()
  const accountId = params.accountId ?? ''
  const router = useRouter()
  const [review, setReview] = useState<AccountPnlReview | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [, setFetching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(() => {
    if (!accountId) return
    setFetching(true)
    getJson<AccountPnlReview>(`/api/accounts/${accountId}/pnl-review`)
      .then((data) => {
        setReview(data)
        setLoadError(undefined)
      })
      .catch(() => setLoadError('Failed to load P&L review'))
      .finally(() => {
        setFetching(false)
        setRefreshing(false)
      })
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
      <View style={styles.container}>
        <Spinner />
      </View>
    )
  }

  if (loadError || !review) {
    return (
      <View style={styles.container}>
        <Card>
          <Text style={styles.dim}>{loadError}</Text>
          <Button small title="Back to accounts" onPress={() => router.push('/(tabs)/accounts')} />
        </Card>
      </View>
    )
  }

  const { account, summary, ranges, trades, since, until } = review

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            refresh()
          }}
          tintColor={colors.accent}
        />
      }
    >
      <Text style={styles.title}>{account.name} P&L</Text>
      <Text style={[styles.dim, { marginBottom: 10 }]}>
        Last 24 hours — {formatJournalDate(since)} to {formatJournalDate(until)}.
      </Text>

      <View style={styles.statGrid}>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: pnlColor(summary.realizedDollarsCents) }]}>
            {formatPnl(summary.realizedDollarsCents)}
          </Text>
          <Text style={styles.dimSmall}>Net P&L · {formatTicks(summary.netTicksCents)}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{summary.closedCount}</Text>
          <Text style={styles.dimSmall}>Trades · {summary.wins}W {summary.losses}L {summary.breakevens}BE</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{formatPercent(summary.winRate)}</Text>
          <Text style={styles.dimSmall}>Win rate</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{formatRatio(profitFactor(summary))}</Text>
          <Text style={styles.dimSmall}>Profit factor</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.positive }]}>
            {summary.averageWinDollarsCents == null ? '—' : formatPnl(summary.averageWinDollarsCents)}
          </Text>
          <Text style={styles.dimSmall}>Avg win</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: colors.negative }]}>
            {summary.averageLossDollarsCents == null ? '—' : formatPnl(summary.averageLossDollarsCents)}
          </Text>
          <Text style={styles.dimSmall}>Avg loss</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: best ? pnlColor(best.realizedDollarsCents ?? 0) : colors.text }]}>
            {best ? formatPnl(best.realizedDollarsCents ?? 0) : '—'}
          </Text>
          <Text style={styles.dimSmall}>Best trade{best ? ` · ${best.rangeName}` : ''}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={[styles.statValue, { color: worst ? pnlColor(worst.realizedDollarsCents ?? 0) : colors.text }]}>
            {worst ? formatPnl(worst.realizedDollarsCents ?? 0) : '—'}
          </Text>
          <Text style={styles.dimSmall}>Worst trade{worst ? ` · ${worst.rangeName}` : ''}</Text>
        </View>
      </View>

      <Card title="Equity curve">
        {summary.closedCount === 0 ? (
          <Text style={styles.dim}>No closed trades in this window.</Text>
        ) : (
          <EquityCurve since={since} until={until} trades={trades} />
        )}
      </Card>

      <Card title="Outcomes">
        <OutcomeDonut wins={summary.wins} losses={summary.losses} breakevens={summary.breakevens} />
      </Card>

      <Card title="By range">
        {ranges.length === 0 ? <Text style={styles.dim}>No range breakdown.</Text> : <RangeBars ranges={ranges} />}
      </Card>

      <Card title="Trades">
        {trades.length === 0 ? (
          <Text style={styles.dim}>No trades in this window.</Text>
        ) : (
          trades.slice(0, TABLE_DISPLAY_LIMIT).map((trade) => (
            <View key={trade.id} style={styles.tradeRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.value}>
                  {trade.rangeName} · {displayInstrument(trade.instrument)} · {trade.side}
                </Text>
                <Text style={styles.dimSmall}>
                  <JournalDate value={trade.occurredAt} />
                  {trade.excludedFromPerformance ? ' · excluded' : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text
                  style={{
                    color:
                      trade.outcome === 'win'
                        ? colors.positive
                        : trade.outcome === 'loss'
                          ? colors.negative
                          : colors.muted,
                    fontWeight: '700',
                    fontSize: 13,
                  }}
                >
                  {formatPnl(trade.realizedDollarsCents ?? 0)}
                </Text>
                <Text style={styles.dimSmall}>{formatTicks(trade.realizedTicksCents ?? 0)}</Text>
              </View>
            </View>
          ))
        )}
      </Card>
    </ScrollView>
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  barTrack: {
    backgroundColor: c.bg,
    borderRadius: 999,
    height: 8,
    marginVertical: 4,
    overflow: 'hidden',
  },
  container: { backgroundColor: c.bg, flex: 1 },
  dim: { color: c.muted, fontSize: 12 },
  dimSmall: { color: c.faint, fontSize: 11 },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  statItem: { marginBottom: 12, marginRight: 24 },
  statValue: { color: c.text, fontSize: 18, fontWeight: '800' },
  title: { color: c.text, fontSize: 18, fontWeight: '800' },
  tradeRow: {
    borderTopColor: c.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
  },
  value: { color: c.text, fontSize: 13, fontWeight: '600' },
}))
