import * as cheerio from 'cheerio';

export type ForexFactoryImpact = 'High' | 'Medium' | 'Low' | 'Non-Economic' | 'Unknown';
export type ForexFactoryImpactFilter = 'all' | 'high';

export interface ForexFactoryEvent {
  eventId: string;
  date: string;
  time: string;
  currency: string;
  title: string;
  actual: string;
  previous: string;
  forecast: string;
  impact: ForexFactoryImpact;
}

export interface ForexFactoryDayResult {
  source: 'ForexFactory';
  day: string;
  timezone: string;
  fetchedAt: string;
  events: ForexFactoryEvent[];
}

export interface ForexFactoryRangeResult {
  source: 'ForexFactory';
  range: string;
  timezone: string;
  fetchedAt: string;
  events: ForexFactoryEvent[];
}

const IMPACT_CLASSES: Record<string, ForexFactoryImpact> = {
  'icon--ff-impact-gra': 'Non-Economic',
  'icon--ff-impact-yel': 'Low',
  'icon--ff-impact-ora': 'Medium',
  'icon--ff-impact-red': 'High',
};

const FOREX_FACTORY_DAY_PATTERN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{1,2}\.\d{4}$/i;
const FOREX_FACTORY_RANGE_PATTERN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{1,2}\.\d{4}-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{1,2}\.\d{4}$/i;
const FOREX_FACTORY_EVENT_DATE_PATTERN = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Za-z]{3})\s+(\d{1,2})$/;
const FOREX_FACTORY_EVENT_TIME_PATTERN = /^(\d{1,2}):(\d{2})(am|pm)$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_ABBREVIATIONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const MONTH_INDEX_BY_ABBREVIATION = Object.fromEntries(MONTH_ABBREVIATIONS.map((month, index) => [month, index])) as Record<string, number>;

function shiftedForexFactoryDate(now = new Date()): Date {
  return new Date(now.getTime() + (-4 * 60 * 60 * 1_000));
}

function formatForexFactoryDate(date: Date): string {
  return `${MONTH_ABBREVIATIONS[date.getUTCMonth()]}${date.getUTCDate()}.${date.getUTCFullYear()}`;
}

export function forexFactoryWeekRangeForDate(date: Date): string {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 5));
  return `${formatForexFactoryDate(start)}-${formatForexFactoryDate(end)}`;
}

export class ForexFactoryError extends Error {
  status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ForexFactoryError';
    this.status = status;
  }
}

export function normalizeForexFactoryDay(day?: string): string {
  if (!day || day === 'today') return 'today';
  const normalized = day.trim().toLowerCase();
  if (FOREX_FACTORY_DAY_PATTERN.test(normalized)) return normalized;
  if (!ISO_DATE_PATTERN.test(normalized)) {
    throw new ForexFactoryError('Invalid day. Use "today", YYYY-MM-DD, or ForexFactory format like aug9.2026.', 400);
  }
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw new ForexFactoryError('Invalid day.', 400);
  }
  return `${MONTH_ABBREVIATIONS[date.getUTCMonth()]}${date.getUTCDate()}.${date.getUTCFullYear()}`;
}

export function normalizeForexFactoryRange(range?: string): string {
  if (!range) {
    throw new ForexFactoryError('Invalid range. Use YYYY-MM-DD:YYYY-MM-DD or ForexFactory format like aug9.2026-aug14.2026.', 400);
  }
  const normalized = range.trim().toLowerCase();
  if (FOREX_FACTORY_RANGE_PATTERN.test(normalized)) return normalized;
  const [start, end] = normalized.split(':');
  if (!start || !end || !ISO_DATE_PATTERN.test(start) || !ISO_DATE_PATTERN.test(end)) {
    throw new ForexFactoryError('Invalid range. Use YYYY-MM-DD:YYYY-MM-DD or ForexFactory format like aug9.2026-aug14.2026.', 400);
  }
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate.getTime() < startDate.getTime()) {
    throw new ForexFactoryError('Invalid range.', 400);
  }
  return `${formatForexFactoryDate(startDate)}-${formatForexFactoryDate(endDate)}`;
}

export function currentForexFactoryWeekRange(now = new Date()): string {
  return forexFactoryWeekRangeForDate(shiftedForexFactoryDate(now));
}

export function currentForexFactoryMonthRange(now = new Date()): string {
  const shifted = shiftedForexFactoryDate(now);
  const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1));
  const end = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0));
  return `${formatForexFactoryDate(start)}-${formatForexFactoryDate(end)}`;
}

function parseScopeYears(scope: string): number[] {
  if (FOREX_FACTORY_DAY_PATTERN.test(scope)) {
    return [Number(scope.split('.')[1])];
  }
  const [startText, endText] = scope.split('-');
  const startYear = startText ? Number(startText.split('.')[1]) : Number.NaN;
  const endYear = endText ? Number(endText.split('.')[1]) : Number.NaN;
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear) || endYear < startYear) return [];
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) years.push(year);
  return years;
}

// Scope/event bounds use ForexFactory-local days (UTC-4, matching
// shiftedForexFactoryDate), not UTC days — an event late on the last listed
// day lands in the early UTC hours of the next and would otherwise fall
// outside the window.
const LOCAL_DAY_OFFSET_MS = 4 * 60 * 60 * 1_000;

export function parseScopeBounds(scope: string): { start: number; end: number } | undefined {
  const match = scope.match(/^([a-z]{3})(\d{1,2})\.(\d{4})-([a-z]{3})(\d{1,2})\.(\d{4})$/i);
  if (!match) return undefined;
  const startMonth = MONTH_INDEX_BY_ABBREVIATION[match[1].toLowerCase()];
  const endMonth = MONTH_INDEX_BY_ABBREVIATION[match[4].toLowerCase()];
  if (startMonth == null || endMonth == null) return undefined;
  return {
    start: Date.UTC(Number(match[3]), startMonth, Number(match[2])) + LOCAL_DAY_OFFSET_MS,
    end: Date.UTC(Number(match[6]), endMonth, Number(match[5]) + 1) + LOCAL_DAY_OFFSET_MS - 1,
  };
}

function resolveForexFactoryEventYear(scope: string, eventDate: string): number | undefined {
  const dateMatch = eventDate.match(FOREX_FACTORY_EVENT_DATE_PATTERN);
  if (!dateMatch) return undefined;
  const monthIndex = MONTH_INDEX_BY_ABBREVIATION[dateMatch[1].toLowerCase()];
  if (monthIndex == null) return undefined;
  const day = Number(dateMatch[2]);
  const scopeYears = parseScopeYears(scope);
  if (!scopeYears.length) return undefined;
  const scopeBounds = parseScopeBounds(scope);
  for (const year of scopeYears) {
    // Scope bounds are UTC-4-shifted — compare the event day's local start
    // (00:00 ET = 04:00 UTC), not the UTC-midnight instant.
    const eventDay = Date.UTC(year, monthIndex, day) + LOCAL_DAY_OFFSET_MS;
    if (!scopeBounds || (eventDay >= scopeBounds.start && eventDay <= scopeBounds.end)) return year;
  }
  return undefined;
}

function timeZoneOffsetMinutes(epochMs: number, timeZone: string): number {
  const offsetLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
    hour12: false,
  }).formatToParts(new Date(epochMs)).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = offsetLabel.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  return sign * ((hours * 60) + minutes);
}

function zonedDateTimeToUtcMs(
  year: number,
  monthIndex: number,
  day: number,
  hour24: number,
  minute: number,
  timeZone: string,
): number {
  const naiveUtc = Date.UTC(year, monthIndex, day, hour24, minute);
  let epochMs = naiveUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const nextEpochMs = naiveUtc - (timeZoneOffsetMinutes(epochMs, timeZone) * 60 * 1_000);
    if (nextEpochMs === epochMs) break;
    epochMs = nextEpochMs;
  }
  return epochMs;
}

function formatForexFactoryEventDateInTimeZone(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).formatToParts(new Date(epochMs));
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${weekday} ${month} ${day}`.trim();
}

function formatForexFactoryEventTimeInTimeZone(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(epochMs));
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  const period = parts.find((part) => part.type === 'dayPeriod')?.value.toLowerCase() ?? '';
  return `${hour}:${minute}${period}`;
}

function normalizeForexFactoryEvent(
  scope: string,
  event: ForexFactoryEvent,
  sourceTimeZone: string,
  targetTimeZone: string,
): ForexFactoryEvent {
  if (sourceTimeZone === targetTimeZone) return event;
  const dateMatch = event.date.match(FOREX_FACTORY_EVENT_DATE_PATTERN);
  const timeMatch = event.time.match(FOREX_FACTORY_EVENT_TIME_PATTERN);
  if (!dateMatch || !timeMatch) return event;
  const monthIndex = MONTH_INDEX_BY_ABBREVIATION[dateMatch[1].toLowerCase()];
  const year = resolveForexFactoryEventYear(scope, event.date);
  if (monthIndex == null || year == null) return event;
  const day = Number(dateMatch[2]);
  const hour12 = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const period = timeMatch[3].toLowerCase();
  const hour24 = period === 'pm'
    ? (hour12 === 12 ? 12 : hour12 + 12)
    : (hour12 === 12 ? 0 : hour12);
  const epochMs = zonedDateTimeToUtcMs(year, monthIndex, day, hour24, minute, sourceTimeZone);
  return {
    ...event,
    date: formatForexFactoryEventDateInTimeZone(epochMs, targetTimeZone),
    time: formatForexFactoryEventTimeInTimeZone(epochMs, targetTimeZone),
  };
}

export function normalizeForexFactorySnapshotTimezone<T extends ForexFactoryDayResult | ForexFactoryRangeResult>(
  snapshot: T,
  targetTimeZone: string,
): T {
  const scope = 'day' in snapshot ? snapshot.day : snapshot.range;
  return {
    ...snapshot,
    timezone: targetTimeZone,
    events: snapshot.events.map((event) => normalizeForexFactoryEvent(scope, event, snapshot.timezone, targetTimeZone)),
  };
}

export function filterForexFactoryEvents(
  events: ForexFactoryEvent[],
  impact: ForexFactoryImpactFilter,
): ForexFactoryEvent[] {
  if (impact === 'all') return events;
  return events.filter((event) => event.impact.toLowerCase() === impact);
}

export function parseForexFactoryCalendarHtml(
  html: string,
  requestedDay: string,
): ForexFactoryDayResult {
  if (/Cloudflare|Just a moment|Attention Required/i.test(html)) {
    throw new ForexFactoryError('ForexFactory blocked the calendar request.');
  }
  const timezone = html.match(/timezone_name:\s*'([^']+)'/)?.[1] ?? 'America/New_York';
  const $ = cheerio.load(html);
  const rows = $('tr.calendar__row[data-event-id]');
  if (rows.length === 0) {
    throw new ForexFactoryError('ForexFactory calendar markup did not contain any event rows.');
  }
  const events: ForexFactoryEvent[] = [];
  let lastDate = '';
  let lastTime = '';
  rows.each((_index, row) => {
    const $row = $(row);
    const eventId = $row.attr('data-event-id');
    if (!eventId) return;
    const date = $row.find('.calendar__date').first().text().trim();
    const time = $row.find('.calendar__time').first().text().trim();
    const currency = $row.find('.calendar__currency').first().text().trim();
    const title = $row.find('.calendar__event-title').first().text().trim()
      || $row.find('.calendar__event').first().text().trim();
    if (date) lastDate = date;
    if (time) lastTime = time;
    const impactClass = $row.find('.calendar__impact span').attr('class') ?? '';
    const impact = Object.entries(IMPACT_CLASSES)
      .find(([pattern]) => impactClass.includes(pattern))?.[1] ?? 'Unknown';
    if (!title || !currency) return;
    events.push({
      eventId,
      date: lastDate || requestedDay,
      time: lastTime || 'Tentative',
      currency,
      title,
      actual: $row.find('.calendar__actual').first().text().trim(),
      previous: $row.find('.calendar__previous').first().text().trim(),
      forecast: $row.find('.calendar__forecast').first().text().trim(),
      impact,
    });
  });
  if (events.length === 0) {
    throw new ForexFactoryError('ForexFactory calendar markup did not contain parseable events.');
  }
  return {
    source: 'ForexFactory',
    day: requestedDay,
    timezone,
    fetchedAt: new Date().toISOString(),
    events,
  };
}

export function parseForexFactoryRangeHtml(
  html: string,
  requestedRange: string,
): ForexFactoryRangeResult {
  const parsed = parseForexFactoryCalendarHtml(html, requestedRange);
  return {
    source: parsed.source,
    range: requestedRange,
    timezone: parsed.timezone,
    fetchedAt: parsed.fetchedAt,
    events: parsed.events,
  };
}
