import { useState } from 'react'
import { Alert, View } from 'react-native'
import { postJson } from '../api/client'
import { useToast } from '../context/ToastContext'
import { emitEvent } from '../utils/events'
import { Button, Field, Input, SelectPicker } from './ui'
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
    if (quantity !== trade.quantity) changes.quantity = quantity
    if (entryPrice !== trade.entryPrice) changes.entryPrice = entryPrice
    if (exitPrice !== trade.exitPrice) changes.exitPrice = exitPrice
    if (draft.instrument !== trade.instrument) changes.instrument = draft.instrument ?? null
    if (draft.side !== trade.side) changes.side = draft.side ?? null
    if (draft.action !== trade.action) changes.action = draft.action ?? null
    if (draft.eventType !== trade.eventType) changes.eventType = draft.eventType ?? null
    if (draft.occurredAt !== trade.occurredAt) changes.occurredAt = draft.occurredAt ?? null
    return { changes, note: trimmedNote }
  }

  const handleSubmit = async () => {
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
      emitEvent('journal:refresh')
      onSave(data.trade as RangeTradeEvent)
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to adjust trade.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = () => {
    if (!onDelete) return
    Alert.alert('Delete trade', 'Delete this trade record? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          setDeleting(true)
          void (async () => {
            try {
              await postJson(`/api/trade-events/${trade.id}/delete`, {})
              success('Trade deleted.')
              emitEvent('journal:refresh')
              onDelete()
            } catch (err) {
              error(err instanceof Error ? err.message : 'Failed to delete trade.')
            } finally {
              setDeleting(false)
            }
          })()
        },
      },
    ])
  }

  const busy = saving || deleting

  return (
    <View>
      <Field label="Instrument">
        <Input value={draft.instrument ?? ''} onChangeText={(v) => changed('instrument', v)} />
      </Field>
      <SelectPicker
        label="Event type"
        options={EVENT_TYPES.map((t) => ({ value: t, label: t }))}
        value={draft.eventType ?? ''}
        onChange={(v) => changed('eventType', v)}
      />
      <View style={{ height: 8 }} />
      <SelectPicker
        label="Side"
        options={SIDES.map((s) => ({ value: s, label: s }))}
        value={draft.side ?? ''}
        onChange={(v) => changed('side', v)}
      />
      <View style={{ height: 8 }} />
      <SelectPicker
        label="Action"
        options={[{ value: '', label: '—' }, ...ACTIONS.map((a) => ({ value: a, label: a }))]}
        value={draft.action ?? ''}
        onChange={(v) => changed('action', v || undefined)}
      />
      <View style={{ height: 8 }} />
      <Field label="Quantity">
        <Input value={raw.quantity} onChangeText={(v) => changedRaw('quantity', v)} keyboardType="decimal-pad" />
      </Field>
      <SelectPicker
        label="Outcome"
        options={[{ value: '', label: '—' }, ...OUTCOMES.map((o) => ({ value: o, label: o }))]}
        value={draft.outcome ?? ''}
        onChange={(v) => changed('outcome', v || undefined)}
      />
      <View style={{ height: 8 }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Field label="P&L ($)">
            <Input value={raw.dollars} onChangeText={(v) => changedRaw('dollars', v)} keyboardType="decimal-pad" />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Net ticks">
            <Input value={raw.ticks} onChangeText={(v) => changedRaw('ticks', v)} keyboardType="decimal-pad" />
          </Field>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Field label="Entry price">
            <Input value={raw.entryPrice} onChangeText={(v) => changedRaw('entryPrice', v)} keyboardType="decimal-pad" />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Exit price">
            <Input value={raw.exitPrice} onChangeText={(v) => changedRaw('exitPrice', v)} keyboardType="decimal-pad" />
          </Field>
        </View>
      </View>
      <Field label="Occurred at (ISO)">
        <Input
          value={draft.occurredAt ?? ''}
          onChangeText={(v) => {
            const t = Date.parse(v)
            changed('occurredAt', Number.isFinite(t) ? new Date(t).toISOString() : v)
          }}
        />
      </Field>
      <Field label="Adjustment note">
        <Input
          value={note}
          onChangeText={setNote}
          multiline
          numberOfLines={3}
          placeholder="Why are you adjusting this trade?"
        />
      </Field>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
        {onDelete ? (
          <Button small variant="danger" title={deleting ? 'Deleting…' : 'Delete'} disabled={busy} onPress={handleDelete} />
        ) : null}
        <Button small variant="ghost" title="Cancel" disabled={busy} onPress={onCancel} />
        <Button small title={saving ? 'Saving…' : 'Save'} disabled={busy} onPress={() => void handleSubmit()} />
      </View>
    </View>
  )
}

