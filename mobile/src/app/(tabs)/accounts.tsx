import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { getJson, postForm, postJson } from '../../api/client'
import { useToast } from '../../context/ToastContext'
import {
  Button,
  Card,
  CollapsibleSection,
  Field,
  Input,
  KpiRow,
  SelectPicker,
  colors,
  pnlColor,
} from '../../components/ui'
import { AccountPerformanceChart } from '../../components/charts'
import { getCachedAccounts, setCachedAccounts } from '../../utils/accounts-cache'
import { formatDollars, formatPnl } from '../../utils/format'
import { storage } from '../../utils/storage'
import type {
  AccountAlertSummary,
  AccountJournal,
  TradersPostAccountDestination,
} from '../../types'

function summarizeTradersPost(destination: TradersPostAccountDestination | undefined): string {
  if (!destination?.webhookUrl) return 'Not configured'
  const parts = [
    destination.enabled ? 'Enabled' : 'Disabled',
    `override: ${destination.outboundTickerMode || 'none'}`,
  ]
  if (destination.outboundTickerMode === 'exact' && destination.outboundTicker) {
    parts.push(`(${destination.outboundTicker})`)
  }
  if (destination.crossTradeWebhookUrl && destination.crossTradeEnabled !== false) parts.push('via CrossTrade')
  if (destination.useLimitPriceTP) parts.push('limit TP/SL')
  if (destination.reapplyOnTradeCloseEnabled) parts.push('reapply on trade close')
  if (destination.eodEnabled === false) {
    parts.push('EOD off')
  } else {
    parts.push(`EOD cancel ${destination.eodCancelTime ?? '16:30'}`)
    parts.push(`EOD exit ${destination.eodExitTime ?? '16:45'}`)
  }
  if (destination.newsFlattenEnabled) {
    parts.push(`news flatten ${destination.newsFlattenMinutes ?? 5}m before red folder`)
  }
  return parts.join(' · ')
}

const EMPTY_SUMMARY: AccountAlertSummary = {
  totalReceived: 0,
  processed: 0,
  extensionPending: 0,
  extensionReviewed: 0,
  extensionSubmitted: 0,
  extensionRejected: 0,
  traderspostDelivered: 0,
  traderspostPending: 0,
  traderspostFailed: 0,
  traderspostNotConfigured: 0,
  ignored: 0,
  noDestination: 0,
}

function CheckRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={[styles.checkRow, disabled && { opacity: 0.5 }]}
    >
      <View style={[styles.checkbox, checked && { borderColor: colors.accent }]}>
        {checked ? <Text style={{ color: colors.accent, fontSize: 12 }}>✓</Text> : null}
      </View>
      <Text style={styles.checkLabel}>{label}</Text>
    </Pressable>
  )
}

function AccountCard({
  accountJournal,
  alertSummary,
  destination,
  enabledRoutes,
  onUpdateDestination,
  onUpdateStartingBalance,
  onDelete,
  onDeprecate,
  onClone,
}: {
  accountJournal: AccountJournal
  alertSummary: AccountAlertSummary
  destination: TradersPostAccountDestination | undefined
  enabledRoutes: number
  onUpdateDestination: (
    accountId: string,
    destination: TradersPostAccountDestination,
    successMessage?: string,
  ) => Promise<boolean>
  onUpdateStartingBalance: (accountId: string, startingBalance: string) => void
  onDelete: (accountId: string) => void
  onDeprecate: (accountId: string, deprecated: boolean) => void
  onClone: (accountId: string, name: string) => void
}) {
  const { account, allTime, internalBalanceCents } = accountJournal
  const { success, error } = useToast()
  const router = useRouter()

  const [webhookUrl, setWebhookUrl] = useState(destination?.webhookUrl ?? '')
  const [outboundMode, setOutboundMode] = useState(destination?.outboundTickerMode ?? 'micros_only')
  const [outboundTicker, setOutboundTicker] = useState(destination?.outboundTicker ?? '')
  const [useLimitPriceTP, setUseLimitPriceTP] = useState(destination?.useLimitPriceTP ?? false)
  const [useAlertTP, setUseAlertTP] = useState(destination?.useAlertTP ?? false)
  const [eodEnabled, setEodEnabled] = useState(destination?.eodEnabled ?? true)
  const [eodCancelTime, setEodCancelTime] = useState(destination?.eodCancelTime ?? '16:30')
  const [eodExitTime, setEodExitTime] = useState(destination?.eodExitTime ?? '16:45')
  const [newsFlattenEnabled, setNewsFlattenEnabled] = useState(destination?.newsFlattenEnabled ?? false)
  const [newsFlattenMinutes, setNewsFlattenMinutes] = useState(String(destination?.newsFlattenMinutes ?? 5))
  const [reapplyOnTradeCloseEnabled, setReapplyOnTradeCloseEnabled] = useState(
    destination?.reapplyOnTradeCloseEnabled ?? false,
  )
  const [crossTradeWebhookUrl, setCrossTradeWebhookUrl] = useState(destination?.crossTradeWebhookUrl ?? '')
  const [crossTradeSecretKey, setCrossTradeSecretKey] = useState('')
  const [crossTradeAccountName, setCrossTradeAccountName] = useState(destination?.crossTradeAccountName ?? '')
  const [quantityOverrideMode, setQuantityOverrideMode] = useState<'off' | 'percent' | 'fixed' | 'risk'>(
    destination?.quantityOverrideMode ?? 'off',
  )
  const [quantityOverrideValue, setQuantityOverrideValue] = useState(
    destination?.quantityOverrideValue == null ? '' : String(destination.quantityOverrideValue),
  )
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneName, setCloneName] = useState('')
  const [dispatchMode, setDispatchMode] = useState<'traderspost' | 'crosstrade'>(
    destination?.crossTradeEnabled !== false && destination?.crossTradeWebhookUrl ? 'crosstrade' : 'traderspost',
  )
  const [enabled, setEnabled] = useState(destination?.enabled ?? true)
  const [exiting, setExiting] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [balanceInput, setBalanceInput] = useState((account.startingBalanceCents / 100).toFixed(2))

  const configModified = useMemo(() => {
    const persistedMode = destination?.crossTradeEnabled !== false && destination?.crossTradeWebhookUrl ? 'crosstrade' : 'traderspost'
    if (dispatchMode !== persistedMode) return true
    if (webhookUrl.trim() !== (destination?.webhookUrl ?? '')) return true
    if (outboundMode !== (destination?.outboundTickerMode ?? 'micros_only')) return true
    if (outboundMode === 'exact' && outboundTicker.trim().toUpperCase() !== (destination?.outboundTicker ?? '')) return true
    if (useLimitPriceTP !== (destination?.useLimitPriceTP ?? false)) return true
    if (useAlertTP !== (destination?.useAlertTP ?? false)) return true
    if (reapplyOnTradeCloseEnabled !== (destination?.reapplyOnTradeCloseEnabled ?? false)) return true
    if (eodEnabled !== (destination?.eodEnabled ?? true)) return true
    if (eodCancelTime !== (destination?.eodCancelTime ?? '16:30')) return true
    if (eodExitTime !== (destination?.eodExitTime ?? '16:45')) return true
    if (newsFlattenEnabled !== (destination?.newsFlattenEnabled ?? false)) return true
    if (Number(newsFlattenMinutes) !== (destination?.newsFlattenMinutes ?? 5)) return true
    if (crossTradeWebhookUrl.trim() !== (destination?.crossTradeWebhookUrl ?? '')) return true
    if (crossTradeSecretKey.trim() !== '') return true
    if (crossTradeAccountName.trim() !== (destination?.crossTradeAccountName ?? '')) return true
    if (quantityOverrideMode !== (destination?.quantityOverrideMode ?? 'off')) return true
    if (
      quantityOverrideMode !== 'off' &&
      quantityOverrideValue.trim() !==
        (destination?.quantityOverrideValue == null ? '' : String(destination.quantityOverrideValue))
    )
      return true
    return false
  }, [
    dispatchMode, webhookUrl, outboundMode, outboundTicker,
    useLimitPriceTP, useAlertTP, reapplyOnTradeCloseEnabled,
    eodEnabled, eodCancelTime, eodExitTime,
    newsFlattenEnabled, newsFlattenMinutes,
    crossTradeWebhookUrl, crossTradeSecretKey, crossTradeAccountName,
    quantityOverrideMode, quantityOverrideValue, destination,
  ])

  useEffect(() => {
    setWebhookUrl(destination?.webhookUrl ?? '')
    setOutboundMode(destination?.outboundTickerMode ?? 'micros_only')
    setOutboundTicker(destination?.outboundTicker ?? '')
    setUseLimitPriceTP(destination?.useLimitPriceTP ?? false)
    setUseAlertTP(destination?.useAlertTP ?? false)
    setEodEnabled(destination?.eodEnabled ?? true)
    setEodCancelTime(destination?.eodCancelTime ?? '16:30')
    setEodExitTime(destination?.eodExitTime ?? '16:45')
    setNewsFlattenEnabled(destination?.newsFlattenEnabled ?? false)
    setNewsFlattenMinutes(String(destination?.newsFlattenMinutes ?? 5))
    setReapplyOnTradeCloseEnabled(destination?.reapplyOnTradeCloseEnabled ?? false)
    setCrossTradeWebhookUrl(destination?.crossTradeWebhookUrl ?? '')
    setCrossTradeSecretKey('')
    setCrossTradeAccountName(destination?.crossTradeAccountName ?? '')
    setDispatchMode(
      destination?.crossTradeEnabled !== false && destination?.crossTradeWebhookUrl ? 'crosstrade' : 'traderspost',
    )
    setQuantityOverrideMode(destination?.quantityOverrideMode ?? 'off')
    setQuantityOverrideValue(
      destination?.quantityOverrideValue == null ? '' : String(destination.quantityOverrideValue),
    )
    setEnabled(destination?.enabled ?? true)
    setBalanceInput((account.startingBalanceCents / 100).toFixed(2))
  }, [destination?.updatedAt])

  if (account.deprecated) {
    return (
      <View style={styles.deprecatedRow}>
        <Text style={styles.accountName}>{account.name}</Text>
        <Button small title="Reactivate" onPress={() => onDeprecate(account.id, false)} />
      </View>
    )
  }

  const handleExitAllSafeguard = () => {
    if (!destination?.webhookUrl) {
      error('Save a TradersPost destination first')
      return
    }
    Alert.alert('Flatten account', `Cancel all orders and positions for ${account.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Flatten',
        style: 'destructive',
        onPress: () => {
          setExiting(true)
          postJson('/exit-all-safeguard', { accountId: account.id })
            .then(async (res) => {
              const data = (await res.json()) as {
                instruments: string[]
                sent: number
                errors: number
                results: { instrument: string; ok: boolean; status?: number; error?: string }[]
              }
              if (data.sent === 0) {
                success(`No buy/sell alerts found for ${account.name} in the last 24 hours`)
              } else if (data.errors === 0) {
                success(`Cancel all sent for ${data.instruments.join(', ')}`)
              } else {
                const details = data.results
                  .filter((r) => !r.ok)
                  .map((r) => `${r.instrument}: ${r.error ?? `HTTP ${r.status ?? 'unknown'}`}`)
                  .join('\n')
                error(`Cancel all partially failed:\n${details}`)
              }
            })
            .catch(() => error('Failed to send Safeguard'))
            .finally(() => setExiting(false))
        },
      },
    ])
  }

  const handleDestination = () => {
    const ctActive = dispatchMode === 'crosstrade'
    const next: TradersPostAccountDestination = {
      accountId: account.id,
      webhookUrl: webhookUrl.trim() || (ctActive ? crossTradeWebhookUrl.trim() : ''),
      enabled,
      outboundTickerMode: outboundMode,
      outboundTicker: outboundMode === 'exact' ? outboundTicker.toUpperCase() || undefined : undefined,
      useLimitPriceTP,
      useAlertTP,
      reapplyOnTradeCloseEnabled,
      eodEnabled,
      eodCancelTime,
      eodExitTime,
      newsFlattenEnabled,
      newsFlattenMinutes: Number(newsFlattenMinutes) || undefined,
      crossTradeEnabled: ctActive,
      crossTradeWebhookUrl: crossTradeWebhookUrl.trim() || undefined,
      crossTradeSecretKey: crossTradeSecretKey.trim() || undefined,
      crossTradeAccountName: crossTradeAccountName.trim() || undefined,
      quantityOverrideMode: quantityOverrideMode === 'off' ? undefined : quantityOverrideMode,
      quantityOverrideValue:
        quantityOverrideMode === 'off' || quantityOverrideValue.trim() === ''
          ? undefined
          : Number(quantityOverrideValue),
      updatedAt: new Date().toISOString(),
    }
    void onUpdateDestination(account.id, next)
  }

  const handleToggleRouting = () => {
    if (!destination?.webhookUrl || toggling) return
    const nextEnabled = !enabled
    setToggling(true)
    setEnabled(nextEnabled)
    onUpdateDestination(
      account.id,
      {
        accountId: account.id,
        webhookUrl: destination.webhookUrl,
        enabled: nextEnabled,
        outboundTickerMode: destination.outboundTickerMode,
        outboundTicker: destination.outboundTicker,
        useLimitPriceTP: destination.useLimitPriceTP,
        useAlertTP: destination.useAlertTP,
        reapplyOnTradeCloseEnabled: destination.reapplyOnTradeCloseEnabled,
        eodEnabled: destination.eodEnabled,
        eodCancelTime: destination.eodCancelTime,
        eodExitTime: destination.eodExitTime,
        newsFlattenEnabled: destination.newsFlattenEnabled,
        newsFlattenMinutes: destination.newsFlattenMinutes,
        crossTradeWebhookUrl: destination.crossTradeWebhookUrl,
        crossTradeAccountName: destination.crossTradeAccountName,
        crossTradeEnabled: destination.crossTradeEnabled,
        quantityOverrideMode: destination.quantityOverrideMode,
        quantityOverrideValue: destination.quantityOverrideValue,
        updatedAt: new Date().toISOString(),
      },
      `Order routing ${nextEnabled ? 'enabled' : 'disabled'}`,
    )
      .then((ok) => {
        if (!ok) setEnabled(destination.enabled ?? true)
      })
      .finally(() => setToggling(false))
  }

  return (
    <CollapsibleSection
      storageKey={`accounts:card:${account.id}`}
      defaultOpen={false}
      title={
        <View style={{ flex: 1 }}>
          <Text style={styles.accountName}>{account.name}</Text>
          <Text style={{ color: pnlColor(allTime.realizedDollarsCents), fontSize: 12, fontWeight: '600' }}>
            {formatPnl(allTime.realizedDollarsCents)}
          </Text>
          <Text style={styles.dim}>{formatDollars(internalBalanceCents)}</Text>
        </View>
      }
      actions={
        <Pressable onPress={() => router.push(`/account-pnl?accountId=${account.id}`)} style={styles.pnlBtn}>
          <Text style={styles.pnlBtnText}>24h P&L</Text>
        </Pressable>
      }
    >
      {enabledRoutes > 0 && !(destination?.webhookUrl || destination?.crossTradeWebhookUrl) ? (
        <View style={styles.warnBox}>
          <Text style={styles.warnText}>
            ⚠ {enabledRoutes} range{enabledRoutes === 1 ? '' : 's'} set to run, but no dispatch destination is configured — orders will not send until a webhook is added.
          </Text>
        </View>
      ) : null}

      <KpiRow label="Starting balance" value={formatDollars(account.startingBalanceCents)} />
      <KpiRow label="Realized P&L" value={formatPnl(allTime.realizedDollarsCents)} tone={allTime.realizedDollarsCents > 0 ? 'positive' : allTime.realizedDollarsCents < 0 ? 'negative' : 'neutral'} />
      <KpiRow label="Internal balance" value={formatDollars(internalBalanceCents)} />
      <CollapsibleSection
        title={<Text style={styles.dim}>Update balance</Text>}
        defaultOpen={false}
        style={{ marginVertical: 6 }}
      >
        <Field label="Balance (dollars)">
          <Input value={balanceInput} onChangeText={setBalanceInput} keyboardType="decimal-pad" placeholder="1000.00" />
        </Field>
        <Button small title="Save" onPress={() => onUpdateStartingBalance(account.id, balanceInput)} />
      </CollapsibleSection>
      <KpiRow label="Alert activity" value={`${alertSummary.totalReceived} received · ${alertSummary.processed} processed`} />
      <View style={{ marginVertical: 4 }}>
        <Text style={styles.dim}>Order forwarding</Text>
        <Text style={styles.value}>{summarizeTradersPost(destination)}</Text>
      </View>

      <View style={styles.btnRow}>
        <Button
          small
          variant="ghost"
          title="Clone"
          onPress={() => {
            setCloneName(`${account.name} copy`)
            setCloneOpen(true)
          }}
        />
        <Button small variant="ghost" title="Deprecate" onPress={() => onDeprecate(account.id, true)} />
        <Button
          small
          variant="ghost"
          title="Delete"
          onPress={() =>
            Alert.alert('Delete account', 'Delete this account?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => onDelete(account.id) },
            ])
          }
        />
      </View>

      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Account config</Text>
      <Text style={[styles.dim, { marginBottom: 8 }]}>Manage this account&rsquo;s order dispatch destination.</Text>

      <Text style={styles.fieldLabel}>Dispatch destination</Text>
      <View style={styles.modeRow}>
        {(['traderspost', 'crosstrade'] as const).map((mode) => (
          <Pressable
            key={mode}
            onPress={() => setDispatchMode(mode)}
            style={[styles.modeCard, dispatchMode === mode && styles.modeCardActive]}
          >
            <Text style={styles.value}>{mode === 'traderspost' ? 'TradersPost' : 'CrossTrade'}</Text>
            <Text style={styles.dimSmall}>
              {mode === 'traderspost'
                ? 'Send the TradersPost-shaped payload to the account webhook.'
                : 'Convert orders to the CrossTrade command format and send them to its webhook.'}
            </Text>
          </Pressable>
        ))}
      </View>

      {dispatchMode === 'traderspost' ? (
        <View style={{ marginTop: 8 }}>
          <Field label="Webhook URL">
            <Input value={webhookUrl} onChangeText={setWebhookUrl} />
          </Field>
          <SelectPicker
            label="Override definition"
            options={[
              { value: 'none', label: 'None' },
              { value: 'exact', label: 'Exact ticker' },
              { value: 'micros_only', label: 'Micros only' },
            ]}
            value={outboundMode}
            onChange={(v) => setOutboundMode(v)}
          />
          {outboundMode === 'exact' ? (
            <View style={{ marginTop: 8 }}>
              <Field label="Exact ticker">
                <Input value={outboundTicker} onChangeText={setOutboundTicker} />
              </Field>
            </View>
          ) : null}
          <View style={{ marginTop: 8 }}>
            <CheckRow
              label="Re-apply remaining bracket orders after trade close"
              checked={reapplyOnTradeCloseEnabled}
              onChange={setReapplyOnTradeCloseEnabled}
            />
            <Text style={styles.dimSmall}>
              When a trade closes, any remaining armed brackets on this account/instrument are cancelled and then re-sent in order of closeness to the close price.
            </Text>
          </View>
        </View>
      ) : (
        <View style={{ marginTop: 8 }}>
          <Text style={styles.dimSmall}>
            Routes through the CrossTrade NT8 Add-On — NinjaTrader 8 must be running with the add-on connected.
          </Text>
          <Field label="Webhook URL">
            <Input value={crossTradeWebhookUrl} onChangeText={setCrossTradeWebhookUrl} placeholder="https://app.crosstrade.io/v1/send/…" />
          </Field>
          <Field label="Secret key">
            <Input
              value={crossTradeSecretKey}
              onChangeText={setCrossTradeSecretKey}
              placeholder={destination?.crossTradeSecretKeySet ? 'Saved — enter a new key to replace' : ''}
              secureTextEntry
            />
          </Field>
          <Field label="NT8 account name (e.g. Sim101)">
            <Input value={crossTradeAccountName} onChangeText={setCrossTradeAccountName} placeholder={account.name} />
          </Field>
          <Text style={styles.dimSmall}>
            {destination?.crossTradeSecretKeySet
              ? 'A key is saved and never sent back — leave blank to keep it, or enter a new one to replace it.'
              : 'The secret key doubles as the Bearer token for live order/position queries.'}
          </Text>
        </View>
      )}

      <View style={styles.subCard}>
        <Text style={styles.fieldLabel}>Outbound override</Text>
        <SelectPicker
          options={[
            { value: 'none', label: 'None' },
            { value: 'exact', label: 'Exact ticker' },
            { value: 'micros_only', label: 'Micros only' },
          ]}
          value={outboundMode}
          onChange={(v) => setOutboundMode(v)}
        />
        {outboundMode === 'exact' ? (
          <View style={{ marginTop: 8 }}>
            <Field label="Exact ticker">
              <Input value={outboundTicker} onChangeText={setOutboundTicker} />
            </Field>
          </View>
        ) : null}
      </View>

      <View style={styles.subCard}>
        <Text style={styles.fieldLabel}>Order sizing</Text>
        <SelectPicker
          label="Mode"
          options={[
            { value: 'off', label: 'Off' },
            { value: 'percent', label: '% of alert' },
            { value: 'fixed', label: 'Fixed contracts' },
            { value: 'risk', label: '$ risk per trade' },
          ]}
          value={quantityOverrideMode}
          onChange={(v) => setQuantityOverrideMode(v)}
        />
        {quantityOverrideMode !== 'off' ? (
          <View style={{ marginTop: 8 }}>
            <Field
              label={
                quantityOverrideMode === 'percent'
                  ? 'Percent'
                  : quantityOverrideMode === 'fixed'
                    ? 'Contracts per order'
                    : 'Dollar risk per trade'
              }
            >
              <Input value={quantityOverrideValue} onChangeText={setQuantityOverrideValue} keyboardType="decimal-pad" />
            </Field>
          </View>
        ) : null}
        <Text style={[styles.dimSmall, { marginTop: 4 }]}>
          Applies to TradersPost and CrossTrade dispatches — one mode at a time. Percent accepts any value (15 → 15% of the alert size, 300 → 3×). $ risk sizes the entry so a full stop-out loses ≈ the amount. Results floor to whole contracts, minimum 1.
        </Text>
      </View>

      <View style={styles.subCard}>
        <Text style={styles.fieldLabel}>Safety schedules</Text>
        <CheckRow label="Enable EOD cancel/flatten" checked={eodEnabled} onChange={setEodEnabled} />
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
          <View style={{ flex: 1 }}>
            <Field label="EOD cancel (HH:MM)">
              <Input value={eodCancelTime} onChangeText={setEodCancelTime} />
            </Field>
          </View>
          <View style={{ flex: 1 }}>
            <Field label="EOD exit (HH:MM)">
              <Input value={eodExitTime} onChangeText={setEodExitTime} />
            </Field>
          </View>
        </View>
        <Text style={styles.dimSmall}>
          At the cancel time, open bracket orders are cancelled. At the exit time, open positions are flattened. Both times are in New York time (UTC-4).
        </Text>
        <View style={{ marginTop: 8 }}>
          <CheckRow
            label="Flatten all positions and orders before red-folder news"
            checked={newsFlattenEnabled}
            onChange={setNewsFlattenEnabled}
          />
        </View>
        <View style={{ marginTop: 8 }}>
          <Field label="Minutes before high-impact news">
            <Input value={newsFlattenMinutes} onChangeText={setNewsFlattenMinutes} keyboardType="numeric" />
          </Field>
        </View>
      </View>

      {configModified ? (
        <Button title="Save config" onPress={handleDestination} style={{ marginTop: 8 }} />
      ) : null}

      <View style={styles.subCard}>
        <Text style={styles.sectionTitle}>Safeguard</Text>
        <Text style={styles.dimSmall}>
          Send exit-and-cancel requests for every instrument this account has actually traded in the last 24 hours. This closes open positions and clears all pending bracket orders.
        </Text>
        <Button
          title={exiting ? 'Sending...' : `Flatten account${destination?.crossTradeWebhookUrl ? ' in NT8' : ' in Tradovate'}`}
          disabled={exiting || !(destination?.webhookUrl || destination?.crossTradeWebhookUrl)}
          onPress={handleExitAllSafeguard}
          style={{ marginTop: 8 }}
        />
      </View>

      <View style={[styles.subCard, enabled && { borderColor: colors.positive }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={styles.sectionTitle}>Order routing masterswitch</Text>
          <Text style={[styles.dimSmall, { color: enabled ? colors.positive : colors.muted, fontWeight: '800' }]}>
            {enabled ? 'ON' : 'OFF'}
          </Text>
        </View>
        <Text style={[styles.dimSmall, { marginVertical: 6 }]}>
          {enabled
            ? `Routing is live — entries, exits, and cancels are forwarded to ${destination?.crossTradeWebhookUrl ? 'CrossTrade' : 'TradersPost'} for this account.`
            : 'Routing is off — nothing is forwarded for this account.'}
        </Text>
        <View style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={styles.value}>{toggling ? 'Saving…' : enabled ? 'Routing ON' : 'Routing OFF'}</Text>
          <Switch
            value={enabled}
            disabled={toggling || !(destination?.webhookUrl || destination?.crossTradeWebhookUrl)}
            onValueChange={handleToggleRouting}
            trackColor={{ false: colors.border, true: colors.positive }}
          />
        </View>
        {!destination?.webhookUrl ? (
          <Text style={[styles.dimSmall, { marginTop: 4 }]}>Save a dispatch destination above before toggling routing.</Text>
        ) : null}
      </View>

      <Modal visible={cloneOpen} transparent animationType="fade" onRequestClose={() => setCloneOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.sectionTitle}>Clone account</Text>
            <Text style={[styles.dim, { marginVertical: 8 }]}>
              Creates a copy of {account.name} with identical settings — dispatch destination, secrets, order sizing, and route subscriptions.
            </Text>
            <Field label="New account name">
              <Input value={cloneName} onChangeText={setCloneName} />
            </Field>
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
              <Button small variant="ghost" title="Cancel" onPress={() => setCloneOpen(false)} />
              <Button
                small
                title="Clone account"
                onPress={() => {
                  if (!cloneName.trim()) return
                  onClone(account.id, cloneName.trim())
                  setCloneOpen(false)
                }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </CollapsibleSection>
  )
}

export default function AccountsScreen() {
  const cached = getCachedAccounts()
  const [serverAccounts, setServerAccounts] = useState<AccountJournal[] | undefined>(cached?.accounts)
  const [serverAlertSummaryMap, setServerAlertSummaryMap] = useState<Record<string, AccountAlertSummary> | undefined>(cached?.alertSummaries)
  const [serverEnabledRouteCounts, setServerEnabledRouteCounts] = useState<Record<string, number>>(cached?.enabledRouteCounts ?? {})
  const [serverDestinationMap, setServerDestinationMap] = useState<Record<string, TradersPostAccountDestination | undefined> | undefined>(cached?.destinations)
  const [fetching, setFetching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showAddAccount, setShowAddAccount] = useState(false)
  const [newName, setNewName] = useState('')
  const [newStartingBalance, setNewStartingBalance] = useState('')
  const { success, error } = useToast()

  const accounts = serverAccounts ?? []
  const alertSummaryMap = serverAlertSummaryMap ?? {}
  const destinationMap = serverDestinationMap ?? {}
  const enabledRouteCounts = serverEnabledRouteCounts

  const refresh = useCallback(() => {
    setFetching(true)
    getJson<{
      accounts: AccountJournal[]
      alertSummaries: Record<string, AccountAlertSummary>
      destinations: Record<string, TradersPostAccountDestination | undefined>
      enabledRouteCounts: Record<string, number>
    }>('/api/accounts')
      .then((data) => {
        setServerAccounts(data.accounts)
        setServerAlertSummaryMap(data.alertSummaries)
        setServerDestinationMap(data.destinations)
        setServerEnabledRouteCounts(data.enabledRouteCounts ?? {})
        setCachedAccounts(data)
      })
      .catch(() => {})
      .finally(() => {
        setFetching(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => a.account.createdAt.localeCompare(b.account.createdAt)),
    [serverAccounts],
  )
  const activeAccounts = useMemo(() => sortedAccounts.filter((aj) => !aj.account.deprecated), [sortedAccounts])
  const deprecatedAccounts = useMemo(() => sortedAccounts.filter((aj) => aj.account.deprecated), [sortedAccounts])

  const cloneAccount = (accountId: string, name: string) => {
    postForm('/accounts/clone', { accountId, name })
      .then(() => {
        refresh()
        success(`Account "${name}" cloned`)
      })
      .catch(() => error('Failed to clone account'))
  }

  const handleAdd = () => {
    postForm('/accounts', { name: newName, startingBalance: newStartingBalance })
      .then(() => {
        setNewName('')
        setNewStartingBalance('')
        setShowAddAccount(false)
        refresh()
        success('Account added')
      })
      .catch(() => error('Failed to add account'))
  }

  const updateDestination = (
    accountId: string,
    destination: TradersPostAccountDestination,
    successMessage = 'Configuration saved',
  ): Promise<boolean> => {
    return postForm('/traderspost-destination', {
      accountId,
      webhookUrl: destination.webhookUrl,
      enabled: destination.enabled ? 'true' : 'false',
      outboundTickerMode: destination.outboundTickerMode,
      outboundTicker: destination.outboundTicker,
      useLimitPriceTP: destination.useLimitPriceTP ? 'true' : undefined,
      useAlertTP: destination.useAlertTP ? 'true' : undefined,
      reapplyOnTradeCloseEnabled: destination.reapplyOnTradeCloseEnabled ? 'true' : undefined,
      eodEnabled: destination.eodEnabled ? 'true' : undefined,
      eodCancelTime: destination.eodCancelTime,
      eodExitTime: destination.eodExitTime,
      newsFlattenEnabled: destination.newsFlattenEnabled ? 'true' : undefined,
      newsFlattenMinutes:
        destination.newsFlattenMinutes === undefined ? undefined : String(destination.newsFlattenMinutes),
      crossTradeWebhookUrl: destination.crossTradeWebhookUrl,
      crossTradeSecretKey: destination.crossTradeSecretKey,
      crossTradeAccountName: destination.crossTradeAccountName,
      crossTradeEnabled:
        destination.crossTradeEnabled === undefined
          ? undefined
          : destination.crossTradeEnabled
            ? 'true'
            : 'false',
      quantityOverrideMode: destination.quantityOverrideMode ?? 'off',
      quantityOverrideValue:
        destination.quantityOverrideValue == null ? undefined : String(destination.quantityOverrideValue),
    })
      .then(() => {
        refresh()
        success(successMessage)
        return true
      })
      .catch(() => {
        error('Failed to save dispatch destination')
        return false
      })
  }

  const deleteAccount = (accountId: string) => {
    postForm('/accounts/delete', { accountId })
      .then(() => {
        refresh()
        success('Account deleted')
      })
      .catch(() => error('Failed to delete account'))
  }

  const deprecateAccount = (accountId: string, deprecated: boolean) => {
    postForm('/accounts/deprecate', { accountId, deprecated: deprecated ? 'true' : 'false' })
      .then(() => {
        refresh()
        success(deprecated ? 'Account deprecated' : 'Account reactivated')
      })
      .catch(() => error('Failed to update account status'))
  }

  const updateStartingBalance = (accountId: string, startingBalance: string) => {
    postForm('/accounts/starting-balance', { accountId, startingBalance })
      .then(() => {
        refresh()
        success('Starting balance updated')
      })
      .catch(() => error('Failed to update starting balance'))
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            refresh()
          }}
          tintColor={colors.accent}
        />
      }
    >
      {!showAddAccount ? (
        <View style={{ alignItems: 'flex-end', marginBottom: 8 }}>
          <Button small title="add" onPress={() => setShowAddAccount(true)} />
        </View>
      ) : (
        <Card title="Add account">
          <Text style={[styles.dim, { marginBottom: 8 }]}>
            Internal balance starts with your opening figure, then realized P&L carries it forward automatically.
          </Text>
          <Field label="Name">
            <Input value={newName} onChangeText={setNewName} />
          </Field>
          <Field label="Starting balance (dollars)">
            <Input value={newStartingBalance} onChangeText={setNewStartingBalance} keyboardType="decimal-pad" placeholder="1000.00" />
          </Field>
          <Button title="Add account" onPress={handleAdd} />
        </Card>
      )}

      <CollapsibleSection title={<Text style={styles.sectionTitle}>Accounts{fetching ? ' …' : ''}</Text>} storageKey="accounts:overview">
        <Text style={[styles.dim, { marginBottom: 8 }]}>You can toggle the routing masterswitch for each account here.</Text>
        {activeAccounts.map((aj) => (
          <AccountCard
            key={aj.account.id + (destinationMap[aj.account.id]?.updatedAt ?? '')}
            accountJournal={aj}
            enabledRoutes={enabledRouteCounts[aj.account.id] ?? 0}
            alertSummary={alertSummaryMap[aj.account.id] ?? EMPTY_SUMMARY}
            destination={destinationMap[aj.account.id]}
            onUpdateDestination={updateDestination}
            onUpdateStartingBalance={updateStartingBalance}
            onDelete={deleteAccount}
            onDeprecate={deprecateAccount}
            onClone={cloneAccount}
          />
        ))}
        {deprecatedAccounts.length > 0 ? (
          <CollapsibleSection
            title={<Text style={styles.dim}>Deprecated accounts ({deprecatedAccounts.length})</Text>}
            storageKey="accounts:deprecated"
            defaultOpen={false}
          >
            {deprecatedAccounts.map((aj) => (
              <AccountCard
                key={aj.account.id + (destinationMap[aj.account.id]?.updatedAt ?? '')}
                accountJournal={aj}
                enabledRoutes={enabledRouteCounts[aj.account.id] ?? 0}
                alertSummary={alertSummaryMap[aj.account.id] ?? EMPTY_SUMMARY}
                destination={destinationMap[aj.account.id]}
                onUpdateDestination={updateDestination}
                onUpdateStartingBalance={updateStartingBalance}
                onDelete={deleteAccount}
                onDeprecate={deprecateAccount}
                onClone={cloneAccount}
              />
            ))}
          </CollapsibleSection>
        ) : null}
      </CollapsibleSection>

      <CollapsibleSection title={<Text style={styles.sectionTitle}>Accounts Performance</Text>} storageKey="accounts:performance">
        <Text style={[styles.dim, { marginBottom: 8 }]}>All accounts stay visible here for comparison.</Text>
        <AccountPerformanceChart accounts={accounts} />
      </CollapsibleSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  accountName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  btnRow: { flexDirection: 'row', gap: 8, justifyContent: 'flex-end', marginTop: 8 },
  checkLabel: { color: colors.text, flex: 1, fontSize: 13 },
  checkRow: { alignItems: 'center', flexDirection: 'row', gap: 8, paddingVertical: 4 },
  checkbox: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  container: { backgroundColor: colors.bg, flex: 1 },
  deprecatedRow: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    padding: 12,
  },
  dim: { color: colors.muted, fontSize: 12 },
  dimSmall: { color: colors.faint, fontSize: 11 },
  divider: { borderTopColor: colors.border, borderTopWidth: 1, marginVertical: 12 },
  fieldLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', marginBottom: 6 },
  modalBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    width: '100%',
  },
  modeCard: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    padding: 10,
  },
  modeCardActive: { borderColor: '#6366f1' },
  modeRow: { flexDirection: 'row', gap: 8 },
  pnlBtn: {
    backgroundColor: '#4f46e5',
    borderRadius: 8,
    marginLeft: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pnlBtnText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  sectionTitle: { color: colors.text, fontSize: 14, fontWeight: '700', marginBottom: 4 },
  subCard: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 10,
    padding: 10,
  },
  value: { color: colors.text, fontSize: 13, fontWeight: '600' },
  warnBox: {
    backgroundColor: 'rgba(251,191,36,0.12)',
    borderColor: colors.amber,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    padding: 10,
  },
  warnText: { color: colors.amber, fontSize: 12 },
})
