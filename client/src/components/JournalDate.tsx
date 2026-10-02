import { formatJournalDate } from '../utils/format'

// "Sep 25, 10:06 AM" rendered as two intentional rows — date, then time —
// instead of letting the single string wrap mid-value in narrow columns.
export function JournalDate({ value, className }: { value: string; className?: string }) {
  const formatted = formatJournalDate(value)
  const split = formatted.lastIndexOf(', ')
  const date = split > -1 ? formatted.slice(0, split) : formatted
  const time = split > -1 ? formatted.slice(split + 2) : ''
  return (
    <span className={className}>
      <span className="block whitespace-nowrap">{date}</span>
      {time && (
        <span className="block whitespace-nowrap text-xs text-slate-400">{time}</span>
      )}
    </span>
  )
}
