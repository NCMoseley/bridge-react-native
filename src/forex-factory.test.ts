import { describe, expect, it } from 'vitest';
import {
  currentForexFactoryWeekRange,
  filterForexFactoryEvents,
  ForexFactoryError,
  normalizeForexFactoryDay,
  normalizeForexFactoryRange,
  normalizeForexFactorySnapshotTimezone,
  parseForexFactoryCalendarHtml,
  parseScopeBounds,
  parseForexFactoryRangeHtml,
} from './forex-factory.js';

const sampleCalendarHtml = `
<!doctype html>
<html>
  <head>
    <script>window.calendar = { timezone_name: 'America/New_York' };</script>
  </head>
  <body>
    <table>
      <tr class="calendar__row" data-event-id="1001">
        <td class="calendar__cell calendar__date">Sun Aug 9</td>
        <td class="calendar__cell calendar__time">8:30am</td>
        <td class="calendar__cell calendar__currency">USD</td>
        <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-red"></span></td>
        <td class="calendar__cell calendar__event"><span class="calendar__event-title">CPI m/m</span></td>
        <td class="calendar__cell calendar__actual">0.3%</td>
        <td class="calendar__cell calendar__forecast">0.2%</td>
        <td class="calendar__cell calendar__previous">0.1%</td>
      </tr>
      <tr class="calendar__row" data-event-id="1002">
        <td class="calendar__cell calendar__date"></td>
        <td class="calendar__cell calendar__time"></td>
        <td class="calendar__cell calendar__currency">EUR</td>
        <td class="calendar__cell calendar__impact"><span class="icon icon--ff-impact-ora"></span></td>
        <td class="calendar__cell calendar__event"><span class="calendar__event-title">ECB Press Conference</span></td>
        <td class="calendar__cell calendar__actual"></td>
        <td class="calendar__cell calendar__forecast"></td>
        <td class="calendar__cell calendar__previous"></td>
      </tr>
    </table>
  </body>
</html>`;

describe('forex factory calendar parsing', () => {
  it('normalizes supported day formats', () => {
    expect(normalizeForexFactoryDay()).toBe('today');
    expect(normalizeForexFactoryDay('today')).toBe('today');
    expect(normalizeForexFactoryDay('2026-08-09')).toBe('aug9.2026');
    expect(normalizeForexFactoryDay('Aug9.2026')).toBe('aug9.2026');
  });

  it('normalizes supported range formats', () => {
    expect(normalizeForexFactoryRange('2026-08-09:2026-08-14')).toBe('aug9.2026-aug14.2026');
    expect(normalizeForexFactoryRange('Aug9.2026-Aug14.2026')).toBe('aug9.2026-aug14.2026');
  });

  it('rejects invalid day formats', () => {
    expect(() => normalizeForexFactoryDay('08/09/2026')).toThrow(ForexFactoryError);
  });

  it('rejects invalid range formats', () => {
    expect(() => normalizeForexFactoryRange('2026-08-14:2026-08-09')).toThrow(ForexFactoryError);
    expect(() => normalizeForexFactoryRange('08/09/2026-08/14/2026')).toThrow(ForexFactoryError);
  });

  it('parses rows, carries forward blank date/time cells, and maps impacts', () => {
    const result = parseForexFactoryCalendarHtml(sampleCalendarHtml, 'today');
    expect(result.source).toBe('ForexFactory');
    expect(result.timezone).toBe('America/New_York');
    expect(result.events).toEqual([
      expect.objectContaining({
        eventId: '1001',
        date: 'Sun Aug 9',
        time: '8:30am',
        currency: 'USD',
        title: 'CPI m/m',
        impact: 'High',
      }),
      expect.objectContaining({
        eventId: '1002',
        date: 'Sun Aug 9',
        time: '8:30am',
        currency: 'EUR',
        title: 'ECB Press Conference',
        impact: 'Medium',
      }),
    ]);
    expect(filterForexFactoryEvents(result.events, 'high')).toHaveLength(1);
    expect(filterForexFactoryEvents(result.events, 'all')).toHaveLength(2);
  });

  it('wraps the same parsed rows in a range response shape', () => {
    const result = parseForexFactoryRangeHtml(sampleCalendarHtml, 'aug9.2026-aug14.2026');
    expect(result.range).toBe('aug9.2026-aug14.2026');
    expect(result.events).toHaveLength(2);
    expect(result.timezone).toBe('America/New_York');
  });

  it('normalizes imported event times into the requested display timezone', () => {
    const normalized = normalizeForexFactorySnapshotTimezone({
      source: 'ForexFactory',
      range: 'aug9.2026-aug14.2026',
      timezone: 'America/Los_Angeles',
      fetchedAt: '2026-08-10T00:00:00.000Z',
      events: [{
        eventId: 'ff-pacific',
        date: 'Sun Aug 9',
        time: '5:30am',
        currency: 'USD',
        title: 'CPI m/m',
        actual: '',
        previous: '',
        forecast: '',
        impact: 'High' as const,
      }],
    }, 'Etc/GMT+4');
    expect(normalized.timezone).toBe('Etc/GMT+4');
    expect(normalized.events[0]).toEqual(expect.objectContaining({
      date: 'Sun Aug 9',
      time: '8:30am',
    }));
  });

  it('derives the current forex factory week range in UTC-4', () => {
    expect(currentForexFactoryWeekRange(new Date('2026-08-10T23:00:00.000Z'))).toBe('aug9.2026-aug14.2026');
    expect(currentForexFactoryWeekRange(new Date('2026-08-15T04:30:00.000Z'))).toBe('aug9.2026-aug14.2026');
  });
  it('throws a source error when blocked by Cloudflare', () => {
    expect(() => parseForexFactoryCalendarHtml('<html><title>Just a moment...</title></html>', 'today'))
      .toThrow('ForexFactory blocked the calendar request.');
  });
});

describe('parseScopeBounds', () => {
  it('keeps the final day of a range covered until end-of-day', () => {
    const bounds = parseScopeBounds('sep1.2026-sep30.2026')!;
    // Any time on Sep 30 must still be inside — previously the end was
    // midnight UTC, so red-folder events on the last day never flattened.
    expect(bounds.end).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 30, 23, 59, 59));
    // Bounds are the local (UTC-4) day — Sep 1 starts at 04:00 UTC, Sep 30
    // ends at 03:59:59.999 UTC on Oct 1.
    expect(bounds.start).toBe(Date.UTC(2026, 8, 1) + 4 * 60 * 60 * 1_000);
    expect(bounds.end).toBe(Date.UTC(2026, 9, 1) + 4 * 60 * 60 * 1_000 - 1);
  });
});
