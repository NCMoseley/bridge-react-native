import { useEffect, useMemo, useState } from 'react'
import { Button } from './Button'
import { Card } from './Card'
import { Input } from './Input'
import { postJson } from '../api/client'
import { useToast } from '../context/ToastContext'
import { inferredDollarPerTick, inferredTickSize } from '../utils/instrument-values'
import type { AccountJournal } from '../types'

interface ManualTradeFormProps {
  accounts: AccountJournal[]
  onCancel: () => void
  onSave: () => void
}

function formatDateTimeLocal(offset: number) {
  const shifted = new Date(Date.now() - offset * 60 * 1000)
  return shifted.toISOString().slice(0, 16)
}

export function ManualTradeForm({ accounts, onCancel, onSave }: ManualTradeFormProps) {
  const { success, error } = useToast()
  const eligibleAccounts = useMemo(
    () => accounts.filter((aj) => !aj.account.deprecated),
    [accounts],
  )
  const [accountId, setAccountId] = useState(eligibleAccounts[0]?.account.id ?? '')
  const [instrument, setInstrument] = useState('')
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [quantity, setQuantity] = useState('1')
  const [entryPrice, setEntryPrice] = useState('')
  const [exitPrice, setExitPrice] = useState('')
  const [realizedDollars, setRealizedDollars] = useState('')
  const [realizedTicks, setRealizedTicks] = useState('')
  const [outcome, setOutcome] = useState<'win' | 'loss' | 'breakeven'>('win')
  const [occurredAt, setOccurredAt] = useState(formatDateTimeLocal(4 * 60))
  const [note, setNote] = useState('')
  const [autoCalculate, setAutoCalculate] = useState(true)
  const [saving, setSaving] = useState(false)

  const canSubmit = useMemo(() => {
    return (
      accountId &&
      instrument.trim() &&
      quantity &&
      Number(quantity) > 0 &&
      realizedDollars !== '' &&
      realizedTicks !== ''
    )
  }, [accountId, instrument, quantity, realizedDollars, realizedTicks])

  useEffect(() => {
    if (!autoCalculate) return
    const entry = Number(entryPrice)
    const exit = Number(exitPrice)
    const qty = Number(quantity)
    const ticker = instrument.trim().toUpperCase()
    const tickSize = inferredTickSize(ticker)
    const dollarPerTick = inferredDollarPerTick(ticker)
    if (
      !Number.isFinite(entry) ||
      !Number.isFinite(exit) ||
      !Number.isFinite(qty) ||
      tickSize <= 0 ||
      dollarPerTick <= 0 ||
      qty <= 0
    ) {
      return
    }
    const signedMove = side === 'long' ? exit - entry : entry - exit
    const ticks = signedMove / tickSize
    const dollars = ticks * dollarPerTick * qty
    setRealizedTicks(String(Number(ticks.toFixed(2))))
    setRealizedDollars(String(Number(dollars.toFixed(2))))
    setOutcome(ticks > 0 ? 'win' : ticks < 0 ? 'loss' : 'breakeven')
  }, [autoCalculate, entryPrice, exitPrice, quantity, side, instrument])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    try {
      const adjusted = `${occurredAt}:00-04:00`
      const occurredAtIso = new Date(adjusted).toISOString()
      await postJson('/api/journal/manual-trade', {
        accountId,
        instrument: instrument.trim().toUpperCase(),
        side,
        quantity: Number(quantity),
        entryPrice: entryPrice ? Number(entryPrice) : undefined,
        exitPrice: exitPrice ? Number(exitPrice) : undefined,
        realizedDollars: Number(realizedDollars),
        realizedTicks: Number(realizedTicks),
        outcome,
        occurredAt: occurredAtIso,
        note,
      })
      success('Manual trade recorded')
      onSave()
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to record manual trade')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="Record manual trade" right={<Button type="button" variant="ghost" onClick={onCancel}>Close</Button>}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">Account</span>
          <select
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {eligibleAccounts.length === 0 && (
              <option value="">No active accounts</option>
            )}
            {eligibleAccounts.map((aj) => (
              <option key={aj.account.id} value={aj.account.id}>
                {aj.account.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <Input
            label="Instrument"
            type="text"
            value={instrument}
            onChange={(e) => setInstrument(e.target.value)}
            placeholder="MNQ1!"
            required
          />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-300">Side</span>
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              value={side}
              onChange={(e) => setSide(e.target.value as 'long' | 'short')}
            >
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Input
            label="Quantity"
            type="number"
            step="any"
            min="0.01"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
          />
          <Input
            label="Entry price"
            type="number"
            step="any"
            min="0"
            value={entryPrice}
            onChange={(e) => setEntryPrice(e.target.value)}
          />
          <Input
            label="Exit price"
            type="number"
            step="any"
            min="0"
            value={exitPrice}
            onChange={(e) => setExitPrice(e.target.value)}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={autoCalculate}
            onChange={(e) => setAutoCalculate(e.target.checked)}
            className="rounded border-slate-600 bg-slate-800 text-indigo-500 focus:ring-indigo-500"
          />
          Auto-calculate realized ticks and P&L from prices
        </label>

        <div className="grid gap-4 md:grid-cols-3">
          <Input
            label="Realized $"
            type="number"
            step="0.01"
            value={realizedDollars}
            onChange={(e) => setRealizedDollars(e.target.value)}
            placeholder={autoCalculate ? 'auto' : '125.50 (negative for a loss)'}
            disabled={autoCalculate}
            required
          />
          <Input
            label="Realized ticks"
            type="number"
            step="0.01"
            value={realizedTicks}
            onChange={(e) => setRealizedTicks(e.target.value)}
            placeholder={autoCalculate ? 'auto' : '-2.50'}
            disabled={autoCalculate}
            required
          />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-300">Outcome</span>
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as 'win' | 'loss' | 'breakeven')}
              disabled={autoCalculate}
            >
              <option value="win">Win</option>
              <option value="loss">Loss</option>
              <option value="breakeven">Breakeven</option>
            </select>
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Input
            label="Trade time (UTC-4)"
            type="datetime-local"
            step={60}
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            required
          />
          <Input
            label="Note (optional)"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit || saving}>
            {saving ? 'Saving…' : 'Record trade'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
