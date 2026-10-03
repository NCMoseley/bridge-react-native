import { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { postJson } from '../api/client'
import { useToast } from '../context/ToastContext'
import { inferredDollarPerTick, inferredTickSize } from '../utils/instrument-values'
import type { AccountJournal } from '../types'
import { Button, Card, Field, Input, SelectPicker, colors } from './ui'

function formatDateTimeLocal(offset: number) {
  const shifted = new Date(Date.now() - offset * 60 * 1000)
  return shifted.toISOString().slice(0, 16)
}

export function ManualTradeForm({
  accounts,
  onCancel,
  onSave,
}: {
  accounts: AccountJournal[]
  onCancel: () => void
  onSave: () => void
}) {
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
  // "YYYY-MM-DDTHH:mm" in journal time (UTC-4)
  const [occurredAt, setOccurredAt] = useState(formatDateTimeLocal(4 * 60))
  const [note, setNote] = useState('')
  const [autoCalculate, setAutoCalculate] = useState(true)
  const [saving, setSaving] = useState(false)

  const canSubmit =
    Boolean(accountId) &&
    Boolean(instrument.trim()) &&
    Boolean(quantity) &&
    Number(quantity) > 0 &&
    realizedDollars !== '' &&
    realizedTicks !== ''

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

  const handleSubmit = async () => {
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
    <Card title="Record manual trade">
      <SelectPicker
        label="Account"
        options={eligibleAccounts.map((aj) => ({ value: aj.account.id, label: aj.account.name }))}
        value={accountId}
        onChange={setAccountId}
      />
      <View style={{ height: 10 }} />
      <Field label="Instrument">
        <Input value={instrument} onChangeText={setInstrument} placeholder="MNQ1!" />
      </Field>
      <SelectPicker
        label="Side"
        options={[
          { value: 'long', label: 'Long' },
          { value: 'short', label: 'Short' },
        ]}
        value={side}
        onChange={(v) => setSide(v)}
      />
      <View style={{ height: 10 }} />
      <Field label="Quantity">
        <Input value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" />
      </Field>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Entry price">
            <Input value={entryPrice} onChangeText={setEntryPrice} keyboardType="decimal-pad" />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Exit price">
            <Input value={exitPrice} onChangeText={setExitPrice} keyboardType="decimal-pad" />
          </Field>
        </View>
      </View>
      <Pressable
        onPress={() => setAutoCalculate((v) => !v)}
        style={{ alignItems: 'center', flexDirection: 'row', gap: 8, marginBottom: 10 }}
      >
        <View
          style={{
            alignItems: 'center',
            borderColor: colors.border,
            borderRadius: 4,
            borderWidth: 1,
            height: 18,
            justifyContent: 'center',
            width: 18,
          }}
        >
          {autoCalculate ? <Text style={{ color: colors.accent, fontSize: 12 }}>✓</Text> : null}
        </View>
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          Auto-calculate realized ticks and P&L from prices
        </Text>
      </Pressable>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Field label="Realized $">
            <Input
              value={realizedDollars}
              onChangeText={setRealizedDollars}
              keyboardType="decimal-pad"
              placeholder={autoCalculate ? 'auto' : '125.50'}
            />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Realized ticks">
            <Input
              value={realizedTicks}
              onChangeText={setRealizedTicks}
              keyboardType="decimal-pad"
              placeholder={autoCalculate ? 'auto' : '-2.50'}
            />
          </Field>
        </View>
      </View>
      <SelectPicker
        label="Outcome"
        options={[
          { value: 'win', label: 'Win' },
          { value: 'loss', label: 'Loss' },
          { value: 'breakeven', label: 'Breakeven' },
        ]}
        value={outcome}
        onChange={setOutcome}
      />
      <View style={{ height: 10 }} />
      <Field label="Trade time (UTC-4, YYYY-MM-DDTHH:mm)">
        <Input value={occurredAt} onChangeText={setOccurredAt} />
      </Field>
      <Field label="Note (optional)">
        <Input value={note} onChangeText={setNote} />
      </Field>
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
        <Button title="Cancel" variant="ghost" onPress={onCancel} disabled={saving} />
        <Button
          title={saving ? 'Saving…' : 'Record trade'}
          onPress={() => void handleSubmit()}
          disabled={!canSubmit || saving}
        />
      </View>
    </Card>
  )
}
