import { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { getJson } from '../api/client'
import {
  currentJournalDateKey,
  journalDateAtTime,
  journalDateFromKey,
} from '../utils/ranges'
import {
  currentForexFactoryWeekRange,
  formatForexFactoryEventDateLabel,
  type ForexFactoryEvent,
  type ForexFactoryRangeView,
} from '../utils/forex-factory'
import { colors } from './ui'

interface ForexFactoryDayView {
  source: 'ForexFactory'
  day: string
  timezone: string
  fetchedAt: string
  events: ForexFactoryEvent[]
  count: number
  cached: boolean
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const RED = '#dc2626'

function parseTime12(time: string): { hour: number; minute: number } | undefined {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})(am|pm)$/i)
  if (!match) return undefined
  const hour12 = Number(match[1])
  const minute = Number(match[2])
  const period = match[3].toLowerCase()
  const hour24 = period === 'pm' ? (hour12 === 12 ? 12 : hour12 + 12) : hour12 === 12 ? 0 : hour12
  return { hour: hour24, minute }
}

function formatDuration(ms: number): string {
  const abs = Math.abs(ms)
  const hours = Math.floor(abs / (60 * 60 * 1000))
  const minutes = Math.floor((abs % (60 * 60 * 1000)) / (60 * 1000))
  if (hours === 0 && minutes === 0) return '< 1m'
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  return parts.join(' ')
}

function eventDayLabel(eventAt: number): string {
  const todayKey = currentJournalDateKey()
  const eventKey = currentJournalDateKey(new Date(eventAt))
  if (eventKey === todayKey) return 'Today'
  const tomorrowKey = currentJournalDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000))
  if (eventKey === tomorrowKey) return 'Tomorrow'
  return journalDateFromKey(eventKey).toLocaleDateString('en-US', {
    timeZone: 'Etc/GMT+4',
    weekday: 'long',
  })
}

function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function RedFolderPanel() {
  const [snapshot, setSnapshot] = useState<ForexFactoryDayView | undefined>(undefined)
  const [fetching, setFetching] = useState(false)
  const day = currentJournalDateKey()
  const now = useNow()

  useEffect(() => {
    setFetching(true)
    getJson<ForexFactoryDayView>(`/api/forex-factory/events?day=${day}&impact=high`)
      .then(setSnapshot)
      .catch(() => {})
      .finally(() => setFetching(false))
  }, [day])

  const upcoming = useMemo(() => {
    if (!snapshot) return []
    return snapshot.events
      .map((event) => {
        const parsed = parseTime12(event.time)
        const eventAt = parsed ? journalDateAtTime(day, parsed.hour, parsed.minute) : undefined
        const timeUntil = eventAt !== undefined ? eventAt - now : undefined
        return { event, eventAt, timeUntil }
      })
      .filter(
        (item): item is { event: ForexFactoryEvent; eventAt: number; timeUntil: number } =>
          item.eventAt !== undefined && item.timeUntil !== undefined && item.timeUntil > 0,
      )
  }, [day, now, snapshot])

  if (fetching || !snapshot || upcoming.length === 0) return null

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {upcoming.map(({ event, eventAt, timeUntil }) => {
        const urgent = timeUntil > 0 && timeUntil < TWO_HOURS_MS
        const label = eventDayLabel(eventAt)
        return (
          <View
            key={event.eventId}
            style={[
              styles.eventChip,
              { borderColor: urgent ? RED : colors.border },
            ]}
          >
            <Text style={styles.highBadge}>HIGH</Text>
            <Text style={styles.eventTitle} numberOfLines={1}>
              {event.title}
            </Text>
            <Text style={styles.eventMeta}>
              {label} at {event.time} · {event.currency}
            </Text>
            <Text style={[styles.eventMeta, urgent && { color: RED, fontWeight: '700' }]}>
              in {formatDuration(timeUntil)}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

function startOfWeekMonday(date: Date): Date {
  const day = date.getUTCDay()
  const dayOffset = day === 0 ? 1 : day === 6 ? 2 : 1 - day
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + dayOffset))
}

export function RedFolderMiniCalendar() {
  const [snapshot, setSnapshot] = useState<ForexFactoryRangeView | undefined>(undefined)
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined)
  const weekRange = currentForexFactoryWeekRange()

  useEffect(() => {
    getJson<ForexFactoryRangeView>(`/api/forex-factory/events?range=${weekRange}&impact=all`)
      .then(setSnapshot)
      .catch(() => {})
  }, [weekRange])

  const days = useMemo(() => {
    const today = journalDateFromKey(currentJournalDateKey())
    const monday = startOfWeekMonday(today)
    return Array.from({ length: 5 }, (_, index) => {
      const date = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + index))
      const label = formatForexFactoryEventDateLabel(date)
      const allEvents = snapshot?.events.filter((event) => event.date === label) ?? []
      const highEvents = allEvents.filter((event) => event.impact.toLowerCase() === 'high')
      const mediumEvents = allEvents.filter((event) => event.impact.toLowerCase() === 'medium')
      const isToday =
        date.getUTCDate() === today.getUTCDate() &&
        date.getUTCMonth() === today.getUTCMonth() &&
        date.getUTCFullYear() === today.getUTCFullYear()
      return { date, label, highEvents, mediumEvents, isToday, index }
    })
  }, [snapshot])

  const todayHasRed = (days.find((d) => d.isToday)?.highEvents.length ?? 0) > 0
  const isOpen = userOpen ?? todayHasRed

  if (!snapshot || snapshot.events.length === 0) return null

  return (
    <View style={[styles.calendarCard, todayHasRed && { borderColor: RED }]}>
      <Pressable onPress={() => setUserOpen((prev) => !(prev ?? todayHasRed))} style={styles.calendarHeader}>
        <Text style={styles.calendarTitle}>News</Text>
        <View style={{ flexDirection: 'row', gap: 4, flex: 1 }}>
          {days.map(({ highEvents, mediumEvents, isToday, index }) => (
            <View
              key={index}
              style={[
                styles.miniDay,
                highEvents.length > 0 && { backgroundColor: 'rgba(220,38,38,0.25)', borderColor: RED },
                highEvents.length === 0 && mediumEvents.length > 0 && { backgroundColor: 'rgba(251,191,36,0.15)', borderColor: colors.amber },
                isToday && { borderColor: '#fff' },
              ]}
            >
              <Text style={styles.miniDayLabel}>{DAY_LABELS[index]}</Text>
            </View>
          ))}
        </View>
        <Text style={{ color: colors.muted, fontSize: 16 }}>{isOpen ? '−' : '+'}</Text>
      </Pressable>
      {isOpen
        ? days.map(({ date, highEvents, mediumEvents, index }) => {
            const hasHigh = highEvents.length > 0
            const hasMedium = mediumEvents.length > 0
            return (
              <View
                key={index}
                style={[
                  styles.dayColumn,
                  hasHigh && { borderColor: RED, backgroundColor: 'rgba(220,38,38,0.15)' },
                  !hasHigh && hasMedium && { borderColor: colors.amber, backgroundColor: 'rgba(251,191,36,0.1)' },
                ]}
              >
                <Text style={[styles.dayName, hasHigh && { color: RED }]}>
                  {DAY_LABELS[index]}{' '}
                  <Text style={styles.eventMeta}>{formatForexFactoryEventDateLabel(date)}</Text>
                </Text>
                {highEvents.length === 0 && mediumEvents.length === 0 ? (
                  <Text style={styles.eventMeta}>No news</Text>
                ) : (
                  [...highEvents, ...mediumEvents].map((event) => (
                    <View key={event.eventId} style={styles.eventRow}>
                      <Text style={styles.eventTitle} numberOfLines={1}>{event.title}</Text>
                      <Text style={styles.eventMeta}>
                        <Text style={{ color: event.impact.toLowerCase() === 'high' ? RED : colors.amber }}>
                          {event.time}
                        </Text>{' '}
                        · {event.currency}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            )
          })
        : null}
    </View>
  )
}

const styles = StyleSheet.create({
  calendarCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    padding: 12,
  },
  calendarHeader: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  calendarTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  dayColumn: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 8,
    padding: 8,
  },
  dayName: { color: colors.text, fontSize: 13, fontWeight: '700', marginBottom: 4 },
  eventChip: {
    backgroundColor: colors.bg,
    borderRadius: 6,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  eventMeta: { color: colors.muted, fontSize: 10 },
  eventRow: {
    backgroundColor: colors.bg,
    borderRadius: 6,
    marginBottom: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  eventTitle: { color: colors.text, fontSize: 11, fontWeight: '600' },
  highBadge: {
    backgroundColor: RED,
    borderRadius: 3,
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  miniDay: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 4,
  },
  miniDayLabel: { color: colors.muted, fontSize: 9, fontWeight: '700' },
})
