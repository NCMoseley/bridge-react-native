import { useState } from 'react'
import { Button } from './Button'
import { postJson } from '../api/client'
import { useToast } from '../context/ToastContext'
import type { RangeTradeEvent, TradeEventType, TradeOutcome } from '../types'

const OUTCOMES: TradeOutcome[] = ['win', 'loss', 'breakeven']
const SIDES = ['long', 'short'] as const
const ACTIONS = ['buy', 'sell', 'cancel', 'exit'] as const
const EVENT_TYPES: TradeEventType[] = [
  'entry_armed',
  'entry_filled',
  'entry_cancelled',
  'exit_filled',
  'trade_closed',
]

interface TradeAdjustFormProps {
  trade: RangeTradeEvent
  onSave: (trade: RangeTradeEvent) => void
  onCancel: () => void
  onDelete?: () => void
}

function parseDecimal(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

function centsFromDisplay(value: string): number | null {
  const n = parseDecimal(value)
  if (n === null) return null
  return Math.round(n * 100)
}

function formatCentsForInput(cents?: number): string {
  if (cents === undefined || cents === null) return ''
  return (cents / 100).toFixed(2)
}

export function TradeAdjustForm({ trade, onSave, onCancel, onDelete }: TradeAdjustFormProps) {
  const { success, error } = useToast()
  const [note, setNote] = useState(trade.adjustmentNote ?? '')
  const [deleting, setDeleting] = useState(false)
  const [saving, setSaving] = useState(false)

  const [draft, setDraft] = useState<Partial<RangeTradeEvent>>({
    outcome: trade.outcome,
    instrument: trade.instrument,
    side: trade.side,
    action: trade.action,
    eventType: trade.eventType,
    occurredAt: trade.occurredAt,
  })

  const [raw, setRaw] = useState({
    quantity: trade.quantity !== undefined ? String(trade.quantity) : '',
    dollars: formatCentsForInput(trade.realizedDollarsCents),
    ticks: formatCentsForInput(trade.realizedTicksCents),
    entryPrice: trade.entryPrice !== undefined ? String(trade.entryPrice) : '',
    exitPrice: trade.exitPrice !== undefined ? String(trade.exitPrice) : '',
  })

  const changed = (key: keyof RangeTradeEvent, next: string | undefined): void => {
    setDraft((prev) => ({ ...prev, [key]: next } as Partial<RangeTradeEvent>))
  }

  const changedRaw = (key: keyof typeof raw, next: string): void => {
    setRaw((prev) => ({ ...prev, [key]: next }))
  }

  function buildChanges(): { changes: Record<string, string | number | null>; note: string } | null {
    const trimmedNote = note.trim()
    if (!trimmedNote) {
      error('A note is required to explain the adjustment.')
      return null
    }

    const quantity = parseDecimal(raw.quantity)
    const realizedDollarsCents = centsFromDisplay(raw.dollars)
    const realizedTicksCents = centsFromDisplay(raw.ticks)
    const entryPrice = parseDecimal(raw.entryPrice)
    const exitPrice = parseDecimal(raw.exitPrice)

    if (quantity === null || quantity <= 0) {
      error('Quantity must be a number greater than 0.')
      return null
    }
    if (draft.eventType === 'trade_closed') {
      if (realizedDollarsCents === null || realizedTicksCents === null) {
        error('P&L and net ticks are required for a closed trade.')
        return null
      }
    }

    const derivedOutcome: TradeOutcome | undefined =
      draft.eventType === 'trade_closed' && realizedDollarsCents !== null
        ? realizedDollarsCents > 0
          ? 'win'
          : realizedDollarsCents < 0
            ? 'loss'
            : 'breakeven'
        : draft.outcome

    const changes: Record<string, string | number | null> = {}
    if (draft.eventType === 'trade_closed') {
      changes.outcome = derivedOutcome ?? null
      if (realizedDollarsCents !== null) changes.realizedDollarsCents = realizedDollarsCents
      if (realizedTicksCents !== null) changes.realizedTicksCents = realizedTicksCents
    } else {
      if (derivedOutcome !== trade.outcome) {
        changes.outcome = derivedOutcome ?? null
      }
      if (realizedDollarsCents !== trade.realizedDollarsCents) {
        changes.realizedDollarsCents = realizedDollarsCents
      }
      if (realizedTicksCents !== trade.realizedTicksCents) {
        changes.realizedTicksCents = realizedTicksCents
      }
    }
    if (quantity !== trade.quantity) {
      changes.quantity = quantity
    }
    if (entryPrice !== trade.entryPrice) {
      changes.entryPrice = entryPrice
    }
    if (exitPrice !== trade.exitPrice) {
      changes.exitPrice = exitPrice
    }
    if (draft.instrument !== trade.instrument) {
      changes.instrument = draft.instrument ?? null
    }
    if (draft.side !== trade.side) {
      changes.side = draft.side ?? null
    }
    if (draft.action !== trade.action) {
      changes.action = draft.action ?? null
    }
    if (draft.eventType !== trade.eventType) {
      changes.eventType = draft.eventType ?? null
    }
    if (draft.occurredAt !== trade.occurredAt) {
      changes.occurredAt = draft.occurredAt ?? null
    }
    return { changes, note: trimmedNote }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const payload = buildChanges()
    if (!payload) return
    if (Object.keys(payload.changes).length === 0) {
      onCancel()
      return
    }
    setSaving(true)
    try {
      const res = await postJson(`/api/trade-events/${trade.id}/adjust`, payload)
      const data = await res.json()
      success('Trade adjusted.')
      window.dispatchEvent(new CustomEvent('journal:refresh'))
      onSave(data.trade as RangeTradeEvent)
    } catch (err) {
      console.error('Failed to adjust trade:', err)
      error(err instanceof Error ? err.message : 'Failed to adjust trade.')
    } finally {
      setSaving(false)
    }
  }

  // TODO: Re-enable apply-all when ready
  // const handleApplyAll = async () => {
  //   const payload = buildChanges()
  //   if (!payload) return
  //   if (payload.note === (trade.adjustmentNote ?? '').trim() && Object.keys(payload.changes).length === 0) {
  //     onCancel()
  //     return
  //   }
  //   if (!window.confirm('Apply these values to all accounts for this trade?')) return
  //   setApplying(true)
  //   try {
  //     const res = await postJson(`/api/trade-events/${trade.id}/apply-all`, payload)
  //     const data = await res.json()
  //     success('Applied to all accounts.')
  //     window.dispatchEvent(new CustomEvent('journal:refresh'))
  //     onSave(data.trade as RangeTradeEvent)
  //   } catch (err) {
  //     console.error('Failed to apply to all:', err)
  //     error(err instanceof Error ? err.message : 'Failed to apply to all accounts.')
  //   } finally {
  //     setApplying(false)
  //   }
  // }

  const handleDelete = async () => {
    if (!onDelete) return
    if (!window.confirm('Delete this trade record? This cannot be undone.')) return
    setDeleting(true)
    try {
      await postJson(`/api/trade-events/${trade.id}/delete`, {})
      success('Trade deleted.')
      window.dispatchEvent(new CustomEvent('journal:refresh'))
      onDelete()
    } catch (err) {
      console.error('Failed to delete trade:', err)
      error(err instanceof Error ? err.message : 'Failed to delete trade.')
    } finally {
      setDeleting(false)
    }
  }

  const busy = saving || deleting

  return (
    <form onSubmit={handleSubmit} className="space-y-4 text-slate-100">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Instrument</span>
          <input
            type="text"
            value={draft.instrument ?? ''}
            onChange={(e) => changed('instrument', e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Event type</span>
          <select
            value={draft.eventType ?? ''}
            onChange={(e) => changed('eventType', e.target.value as TradeEventType)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Side</span>
          <select
            value={draft.side ?? ''}
            onChange={(e) => changed('side', e.target.value as 'long' | 'short')}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            {SIDES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Action</span>
          <select
            value={draft.action ?? ''}
            onChange={(e) => changed('action', e.target.value || undefined)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">—</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Quantity</span>
          <input
            type="text"
            inputMode="decimal"
            value={raw.quantity}
            onChange={(e) => changedRaw('quantity', e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Outcome</span>
          <select
            value={draft.outcome ?? ''}
            onChange={(e) => changed('outcome', e.target.value || undefined)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">—</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">P&L ($)</span>
          <input
            type="text"
            inputMode="decimal"
            value={raw.dollars}
            onChange={(e) => changedRaw('dollars', e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Net ticks</span>
          <input
            type="text"
            inputMode="decimal"
            value={raw.ticks}
            onChange={(e) => changedRaw('ticks', e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Entry price</span>
          <input
            type="text"
            inputMode="decimal"
            value={raw.entryPrice}
            onChange={(e) => changedRaw('entryPrice', e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">Exit price</span>
          <input
            type="text"
            inputMode="decimal"
            value={raw.exitPrice}
            onChange={(e) => changedRaw('exitPrice', e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>
        <label className="block md:col-span-2">
          <span className="mb-1 block text-xs font-medium text-slate-400">Occurred at</span>
          <input
            type="datetime-local"
            value={draft.occurredAt ? draft.occurredAt.slice(0, 16) : ''}
            onChange={(e) => changed('occurredAt', new Date(e.target.value).toISOString())}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        </label>
      </div>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-400">Adjustment note</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          required
          rows={3}
          placeholder="Why are you adjusting this trade?"
          className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
        />
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        {onDelete && (
          <Button
            type="button"
            variant="danger"
            onClick={handleDelete}
            disabled={busy}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {/* TODO: Re-enable apply-all when ready */}
        {/* <Button
          type="button"
          onClick={handleApplyAll}
          disabled={busy}
        >
          {applying ? 'Saving…' : 'Save globally'}
        </Button> */}
        <Button type="submit" variant="primary" disabled={busy}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  )
}
