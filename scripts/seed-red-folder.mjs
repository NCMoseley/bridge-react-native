import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import dotenv from 'dotenv'

dotenv.config()

const databasePath = resolve(process.env.DATABASE_PATH ?? './data/bridge.sqlite')
const db = new Database(databasePath)

const now = new Date().toISOString()
const range = 'aug16.2026-aug21.2026'
const payload = JSON.stringify({
  source: 'ForexFactory',
  range,
  timezone: 'America/New_York',
  fetchedAt: now,
  events: [
    {
      eventId: 'us-2026-08-19-1',
      date: 'Wed Aug 19',
      time: '8:30am',
      currency: 'USD',
      title: 'CPI m/m',
      actual: '',
      previous: '0.2%',
      forecast: '0.3%',
      impact: 'High',
    },
    {
      eventId: 'us-2026-08-19-2',
      date: 'Wed Aug 19',
      time: '2:00pm',
      currency: 'USD',
      title: 'FOMC Minutes',
      actual: '',
      previous: '',
      forecast: '',
      impact: 'High',
    },
  ],
})

db.prepare(
  `INSERT OR REPLACE INTO forex_factory_snapshots (scope_kind, scope_key, timezone, fetched_at, payload_json)
   VALUES (?, ?, ?, ?, ?)`,
).run('range', range, 'America/New_York', now, payload)

console.log(`Seeded red-folder snapshot for ${range} with 2 high-impact events.`)
db.close()
