import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { JOURNAL_TIME_ZONE } from '../utils/format'

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: JOURNAL_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
})

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: JOURNAL_TIME_ZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
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

  // Futures market hours (NY): daily 17:00–18:00 maintenance is closed, plus
  // the weekend close — Friday 17:00 through Sunday 18:00.
  const nyHour = Number(nyHourFormatter.format(now))
  const nyDay = nyDayFormatter.format(now)
  const marketClosed =
    nyHour === 17 ||
    nyDay === 'Sat' ||
    (nyDay === 'Fri' && nyHour >= 17) ||
    (nyDay === 'Sun' && nyHour < 18)
  const dotClass = marketClosed ? 'bg-red-500' : 'bg-emerald-400'
  const dotShadow = marketClosed ? 'rgba(239,68,68,0.6)' : 'rgba(52,211,153,0.6)'

  return (
    <Link
      to="/app/monitoring"
      className="fixed right-2 top-2 z-50 flex items-center gap-2 bg-black px-3.5 py-2 shadow-lg transition-transform hover:scale-105 active:scale-95 lg:right-5 lg:top-5 lg:gap-2.5 lg:px-4 lg:py-2.5"
    >
      <span className="hidden lg:flex flex-col items-center gap-1">
        <span className="text-sm font-bold uppercase tracking-widest text-white lg:text-base">NY</span>
        <span className="relative flex h-2 w-2 lg:h-2.5 lg:w-2.5">
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotClass} opacity-60`} />
          <span
            className={`relative inline-flex h-2 w-2 rounded-full lg:h-2.5 lg:w-2.5 ${dotClass}`}
            style={{ boxShadow: `0 0 8px ${dotShadow}` }}
          />
        </span>
      </span>
      <div className="text-left leading-none">
        <div className="text-xl font-bold tabular-nums tracking-tight text-white lg:text-4xl">
          {(() => {
            const formatted = timeFormatter.format(now)
            const match = formatted.match(/^(.*?)\s*(AM|PM)$/i)
            if (!match) return <span className="led-matrix">{formatted}</span>
            return (
              <>
                <span className="led-matrix">{match[1]}</span>{' '}
                <span className="align-middle text-base font-semibold lg:text-xl">{match[2]}</span>
              </>
            )
          })()}
        </div>
        <div className="mt-1 hidden text-[0.7rem] font-medium tracking-wide text-white/90 lg:block">
          {dateFormatter.format(now)}
        </div>
      </div>
    </Link>
  )
}
