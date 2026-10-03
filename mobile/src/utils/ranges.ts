import type { RangeConfiguration } from '../types'

export interface RangeDaySchedule {
  rangeName: string
  instrument: string
  rangeWindow: string
  tradingSession: string
  entriesPerRange: number
  description: string
  startAt: number
  endAt: number
}

export interface RangeScheduleState {
  countdown: string
  countdownLabel: string
  countdownValue: string
  status: string
  intensity: number
  state: 'upcoming' | 'active' | 'completed'
  imminent: boolean
}

const JOURNAL_TIME_OFFSET_MINUTES = -4 * 60

function journalShiftedDate(now = new Date()): Date {
  return new Date(now.getTime() + JOURNAL_TIME_OFFSET_MINUTES * 60 * 1000)
}

export function currentJournalDateKey(now = new Date()): string {
  const shifted = journalShiftedDate(now)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function currentJournalWeekday(now = new Date()): number {
  return journalShiftedDate(now).getUTCDay()
}

export function journalDateFromKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day) - JOURNAL_TIME_OFFSET_MINUTES * 60 * 1000)
}

export function journalDateAtTime(dateKey: string, hour: number, minute: number): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return (
    Date.UTC(year, month - 1, day, hour, minute) -
    JOURNAL_TIME_OFFSET_MINUTES * 60 * 1000
  )
}

function parseRangeClockSegment(value: string):
  | { hour: number; minute: number }
  | undefined {
  const normalized = value.replace(/:/g, '').trim()
  if (!/^\d{4}$/.test(normalized)) return undefined
  const hour = Number(normalized.slice(0, 2))
  const minute = Number(normalized.slice(2, 4))
  if (hour === 24 && minute === 0) return { hour: 24, minute: 0 }
  if (hour > 23 || minute > 59) return undefined
  return { hour, minute }
}

export function defaultRangeConfiguration(rangeName: string): RangeConfiguration {
  const now = new Date().toISOString()
  return {
    rangeName,
    instrument: '',
    description: '',
    riskDollarsCents: 0,
    rangeWindow: '',
    tradingSession: '',
    takeProfitStyle: 'ticks',
    takeProfitTicksCents: 0,
    stopLossStyle: 'ticks',
    stopLossTicksCents: 0,
    breakEvenEnabled: false,
    breakEvenTriggerTicksCents: 0,
    breakEvenOffsetTicksCents: 0,
    ocoMode: 'oco',
    stopOnlyEntries: true,
    runMonday: false,
    runTuesday: false,
    runWednesday: false,
    runThursday: false,
    runFriday: false,
    runSaturday: false,
    runSunday: false,
    entriesPerRange: 1,
    createdAt: now,
    updatedAt: now,
  }
}

export function buildRangeDaySchedule(
  configuration: RangeConfiguration,
  dateKey: string,
): RangeDaySchedule | undefined {
  const [rangeStartToken, rangeEndToken] = configuration.rangeWindow.split('-')
  const rangeStart = parseRangeClockSegment(rangeStartToken ?? '')
  const rangeEnd = parseRangeClockSegment(rangeEndToken ?? '')
  if (!rangeStart || !rangeEnd) return undefined

  // The active window is the range window itself; tradingSession is not used.
  const startAt = journalDateAtTime(dateKey, rangeStart.hour, rangeStart.minute)
  const endAt = journalDateAtTime(dateKey, rangeEnd.hour, rangeEnd.minute)

  return {
    rangeName: configuration.rangeName,
    instrument: configuration.instrument,
    rangeWindow: configuration.rangeWindow,
    tradingSession: configuration.tradingSession,
    entriesPerRange: configuration.entriesPerRange,
    description: configuration.description,
    startAt,
    endAt,
  }
}

const WEEKDAY_FLAGS = [
  'runSunday',
  'runMonday',
  'runTuesday',
  'runWednesday',
  'runThursday',
  'runFriday',
  'runSaturday',
] as const

export function rangeRunsOnWeekday(
  configuration: RangeConfiguration,
  weekday: number,
): boolean {
  const flag = WEEKDAY_FLAGS[weekday] as keyof RangeConfiguration | undefined
  if (!flag) return false
  return Boolean(configuration[flag])
}

function formatRelativeMinutes(milliseconds: number): string {
  const absoluteMinutes = Math.max(
    0,
    Math.round(Math.abs(milliseconds) / 60_000),
  )
  const hours = Math.floor(absoluteMinutes / 60)
  const minutes = absoluteMinutes % 60
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

function highlightIntensity(remainingMs: number): number {
  const highlightWindowMs = 60 * 60_000
  if (remainingMs > highlightWindowMs) return 0
  return Math.max(0.12, Math.min(1, 1 - remainingMs / highlightWindowMs))
}

export function describeRangeScheduleState(
  startAt: number,
  endAt: number,
  nowMs = Date.now(),
): RangeScheduleState {
  if (nowMs < startAt) {
    const remainingMs = startAt - nowMs
    const countdownValue = formatRelativeMinutes(remainingMs)
    return {
      countdown: `${countdownValue}`,
      countdownLabel: 'Range will be active in',
      countdownValue,
      status: 'Scheduled',
      intensity: highlightIntensity(remainingMs),
      state: 'upcoming',
      imminent: remainingMs <= 15 * 60_000,
    }
  }
  if (nowMs <= endAt) {
    const remainingMs = endAt - nowMs
    const countdownValue = formatRelativeMinutes(remainingMs)
    return {
      countdown: `${countdownValue}`,
      countdownLabel: 'Range will end in',
      countdownValue,
      status: 'Forming now',
      intensity: highlightIntensity(remainingMs),
      state: 'active',
      imminent: remainingMs <= 15 * 60_000,
    }
  }
  const countdownValue = `${formatRelativeMinutes(nowMs - endAt)} ago`
  return {
    countdown: countdownValue,
    countdownLabel: '',
    countdownValue,
    status: 'Completed',
    intensity: 0,
    state: 'completed',
    imminent: false,
  }
}

export function formatRangeWindow(rangeWindow: string): string {
  const [start, end] = rangeWindow.split('-')
  const s = parseRangeClockSegment(start ?? '')
  const e = parseRangeClockSegment(end ?? '')
  if (!s || !e) return rangeWindow
  const fmt = (h: number, m: number) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(2026, 0, 1, h, m))
  return `${fmt(s.hour, s.minute)} – ${fmt(e.hour, e.minute)}`
}

export function formatScheduleWindow(schedule: RangeDaySchedule): string {
  const fmt = (at: number) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Etc/GMT+4',
    }).format(new Date(at))
  return `${fmt(schedule.startAt)} – ${fmt(schedule.endAt)}`
}
