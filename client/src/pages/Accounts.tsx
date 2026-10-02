import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { Input } from '../components/Input'
import { Button } from '../components/Button'
import { AccountPerformanceChart } from '../components/AccountPerformanceChart'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { useToast } from '../context/ToastContext'
import { getCachedAccounts, setCachedAccounts } from '../utils/accounts-cache'
import { classForCents, formatDollars, formatPnl } from '../utils/format'
import { getJson, postForm, postJson } from '../api/client'
import type {
  AccountAlertSummary,
  AccountJournal,
  TradersPostAccountDestination,
} from '../types'

function summarizeTradersPost(
  destination: TradersPostAccountDestination | undefined,
): string {
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

function processedAlertCount(summary: AccountAlertSummary): number {
  return summary.processed
}

// Per-card watermark tile: an inline SVG with the account name so the CSS
// ::after can repeat it as a background pattern.
function accountWatermarkTile(name: string): string {
  const safe = name
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="96"><text x="150" y="56" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="22" font-weight="800" letter-spacing="4" fill="rgb(148,163,184)" transform="rotate(-14 150 48)">${safe.toUpperCase()}</text></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

interface AccountCardProps {
  accountJournal: AccountJournal
  alertSummary: AccountAlertSummary
  destination: TradersPostAccountDestination | undefined
  enabledRoutes: number
  expanded?: boolean
  onToggleExpand?: () => void
  onUpdateDestination: (
    accountId: string,
    destination: TradersPostAccountDestination,
    successMessage?: string,
  ) => Promise<boolean>
  onUpdateStartingBalance: (
    accountId: string,
    startingBalance: string,
  ) => void
  onDelete: (accountId: string) => void
  onDeprecate: (accountId: string, deprecated: boolean) => void
  onClone: (accountId: string, name: string) => void
}

function AccountCard({
  accountJournal,
  alertSummary,
  destination,
  enabledRoutes,
  expanded,
  onToggleExpand,
  onUpdateDestination,
  onUpdateStartingBalance,
  onDelete,
  onDeprecate,
  onClone,
}: AccountCardProps) {
  const { account, allTime, internalBalanceCents } = accountJournal
  const { success, error } = useToast()

  const [webhookUrl, setWebhookUrl] = useState(destination?.webhookUrl ?? '')
  const [outboundMode, setOutboundMode] = useState(
    destination?.outboundTickerMode ?? 'micros_only',
  )
  const [outboundTicker, setOutboundTicker] = useState(destination?.outboundTicker ?? '')
  const [useLimitPriceTP, setUseLimitPriceTP] = useState(destination?.useLimitPriceTP ?? false)
  const [useAlertTP, setUseAlertTP] = useState(destination?.useAlertTP ?? false)
  const [eodEnabled, setEodEnabled] = useState(destination?.eodEnabled ?? true)
  const [eodCancelTime, setEodCancelTime] = useState(
    destination?.eodCancelTime ?? '16:30',
  )
  const [eodExitTime, setEodExitTime] = useState(
    destination?.eodExitTime ?? '16:45',
  )
  const [newsFlattenEnabled, setNewsFlattenEnabled] = useState(
    destination?.newsFlattenEnabled ?? false,
  )
  const [newsFlattenMinutes, setNewsFlattenMinutes] = useState(
    destination?.newsFlattenMinutes ?? 5,
  )
  const [reapplyOnTradeCloseEnabled, setReapplyOnTradeCloseEnabled] = useState(
    destination?.reapplyOnTradeCloseEnabled ?? false,
  )
  const [crossTradeWebhookUrl, setCrossTradeWebhookUrl] = useState(
    destination?.crossTradeWebhookUrl ?? '',
  )
  // Write-only credential: the API reports only whether a key is saved
  // (crossTradeSecretKeySet); a typed value here always means "replace it".
  const [crossTradeSecretKey, setCrossTradeSecretKey] = useState('')
  const [crossTradeAccountName, setCrossTradeAccountName] = useState(
    destination?.crossTradeAccountName ?? '',
  )
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

  // The save button only appears when the form differs from the persisted
  // destination. `enabled` is excluded — the masterswitch saves it immediately.
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
    if (newsFlattenMinutes !== (destination?.newsFlattenMinutes ?? 5)) return true
    if (crossTradeWebhookUrl.trim() !== (destination?.crossTradeWebhookUrl ?? '')) return true
    if (crossTradeSecretKey.trim() !== '') return true
    if (crossTradeAccountName.trim() !== (destination?.crossTradeAccountName ?? '')) return true
    if (quantityOverrideMode !== (destination?.quantityOverrideMode ?? 'off')) return true
    if (quantityOverrideMode !== 'off' && quantityOverrideValue.trim() !== (destination?.quantityOverrideValue == null ? '' : String(destination.quantityOverrideValue))) return true
    return false
  }, [
    dispatchMode, webhookUrl, outboundMode, outboundTicker,
    useLimitPriceTP, useAlertTP, reapplyOnTradeCloseEnabled,
    eodEnabled, eodCancelTime, eodExitTime,
    newsFlattenEnabled, newsFlattenMinutes,
    crossTradeWebhookUrl, crossTradeSecretKey, crossTradeAccountName,
    quantityOverrideMode, quantityOverrideValue,
    destination,
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
    setNewsFlattenMinutes(destination?.newsFlattenMinutes ?? 5)
    setReapplyOnTradeCloseEnabled(destination?.reapplyOnTradeCloseEnabled ?? false)
    setCrossTradeWebhookUrl(destination?.crossTradeWebhookUrl ?? '')
    setCrossTradeSecretKey('')
    setCrossTradeAccountName(destination?.crossTradeAccountName ?? '')
    setDispatchMode(destination?.crossTradeEnabled !== false && destination?.crossTradeWebhookUrl ? 'crosstrade' : 'traderspost')
    setQuantityOverrideMode(destination?.quantityOverrideMode ?? 'off')
    setQuantityOverrideValue(destination?.quantityOverrideValue == null ? '' : String(destination.quantityOverrideValue))
    setEnabled(destination?.enabled ?? true)
  }, [destination?.updatedAt])

  if (account.deprecated) {
    return (
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 shadow-sm">
        <h3 className="break-words text-base font-semibold text-slate-100">
          {account.name}
        </h3>
        <Button
          type="button"
          variant="primary"
          onClick={() => onDeprecate(account.id, false)}
          className="shrink-0 px-3 py-1.5 text-xs"
        >
          Reactivate
        </Button>
      </div>
    )
  }

  const handleExitAllSafeguard = () => {
    if (!destination?.webhookUrl) {
      error('Save a TradersPost destination first')
      return
    }
    if (!confirm(`Cancel all orders and positions for ${account.name}?`)) return
    setExiting(true)
    postJson('/exit-all-safeguard', { accountId: account.id })
      .then(async (res) => {
        const data = (await res.json()) as {
          instruments: string[]
          sent: number
          errors: number
          results: Array<{ instrument: string; ok: boolean; status?: number; error?: string }>
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
      .catch((err) => {
        error('Failed to send Safeguard')
        console.error('Cancel and flatten failed:', err)
      })
      .finally(() => setExiting(false))
  }

  const handleDestination = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const ctActive = dispatchMode === 'crosstrade'
    const next: TradersPostAccountDestination = {
      accountId: account.id,
      // In CrossTrade mode the CT webhook doubles as the primary dispatch URL —
      // the column is required and several server paths gate on it being set.
      webhookUrl: webhookUrl.trim() || (ctActive ? crossTradeWebhookUrl.trim() : ''),
      enabled,
      outboundTickerMode: outboundMode,
      outboundTicker:
        outboundMode === 'exact'
          ? outboundTicker.toUpperCase() || undefined
          : undefined,
      useLimitPriceTP,
      useAlertTP,
      reapplyOnTradeCloseEnabled,
      eodEnabled,
      eodCancelTime,
      eodExitTime,
      newsFlattenEnabled,
      newsFlattenMinutes,
      crossTradeEnabled: ctActive,
      // Parked CT config stays stored — send current field values regardless of
      // mode so switching back only re-enables, never re-enters creds.
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
    onUpdateDestination(account.id, next)
  }

  // The masterswitch saves only the persisted destination with `enabled` flipped,
  // so unsaved config edits in the form are never submitted by a toggle.
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
        // Omit the secret — the server preserves the stored key.
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

  const handleStartingBalance = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const startingBalance = String(data.get('startingBalance') || '')
    onUpdateStartingBalance(account.id, startingBalance)
  }

  return (
    <CollapsibleSection
      storageKey={`accounts:card:${account.id}`}
      {...(expanded !== undefined ? { open: expanded, onToggle: onToggleExpand } : {})}
      watermark={account.name}
      style={{ ['--account-watermark' as string]: accountWatermarkTile(account.name) }}
      defaultOpen={false}
      className={
        destination?.enabled && destination?.webhookUrl && !account.deprecated
          ? 'account-card-live account-card-watermark min-w-0 rounded-xl border shadow-sm'
          : 'account-card-watermark min-w-0 rounded-xl border border-slate-700 bg-slate-900 shadow-sm'
      }
      title={
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-slate-100">
            {account.name}
          </div>
          <div className="mt-0.5 text-xs">
            <div className={classForCents(allTime.realizedDollarsCents)}>
              {formatPnl(allTime.realizedDollarsCents)}
            </div>
            <div className="text-slate-400">{formatDollars(internalBalanceCents)}</div>
          </div>
        </div>
      }
      actions={
        <Link
          to={`/app/accounts/${account.id}/pnl`}
          className="shrink-0 rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-indigo-900/20 transition hover:from-blue-500 hover:to-purple-500"
        >
          24h P&L
        </Link>
      }
    >
      {enabledRoutes > 0 && !(destination?.webhookUrl || destination?.crossTradeWebhookUrl) && (
        <div className="mb-4 rounded-lg border border-amber-600/50 bg-amber-900/20 px-3 py-2 text-xs font-medium text-amber-200">
          ⚠ {enabledRoutes} range{enabledRoutes === 1 ? '' : 's'} set to run, but no dispatch
          destination is configured — orders will not send until a webhook is added.
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-4 text-sm">
        <div className="text-slate-400">Starting balance</div>
        <div className="text-right font-medium text-slate-200">
          {formatDollars(account.startingBalanceCents)}
        </div>
        <div className="text-slate-400">Realized P&L</div>
        <div
          className={`text-right font-medium ${classForCents(
            allTime.realizedDollarsCents,
          )}`}
        >
          {formatPnl(allTime.realizedDollarsCents)}
        </div>
        <div className="text-slate-400">Internal balance</div>
        <div className="text-right font-medium text-slate-200">
          {formatDollars(internalBalanceCents)}
        </div>
        <CollapsibleSection
          title={<span className="text-sm text-slate-400">Update balance</span>}
          storageKey={`accounts:card:${account.id}:starting-balance`}
          defaultOpen={false}
          className="col-span-2"
        >
          <form autoComplete="off" onSubmit={handleStartingBalance} className="grid gap-4 pt-2">
            <Input
              label="Balance (dollars)"
              name="startingBalance"
              inputMode="decimal"
              defaultValue={(account.startingBalanceCents / 100).toFixed(2)}
              autoComplete="off"
              placeholder="1000.00"
              required
            />
            <div className="flex items-end">
              <Button type="submit" variant="primary">
                Save
              </Button>
            </div>
          </form>
        </CollapsibleSection>
        <div className="text-slate-400">Alert activity</div>
        <div className="text-right font-medium text-slate-200">
          {alertSummary.totalReceived} received · {processedAlertCount(alertSummary)} processed
        </div>
        <div className="text-slate-400">Order forwarding</div>
        <div className="text-right font-medium text-slate-200">
          {summarizeTradersPost(destination)}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-700 pt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setCloneName(`${account.name} copy`)
            setCloneOpen(true)
          }}
          className="px-3 py-1.5 text-xs"
        >
          Clone
        </Button>
        <Button
          type="button"
          variant={account.deprecated ? 'primary' : 'ghost'}
          onClick={() =>
            onDeprecate(account.id, !account.deprecated)
          }
          className="px-3 py-1.5 text-xs"
        >
          {account.deprecated ? 'Reactivate' : 'Deprecate'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (confirm('Delete this account?')) onDelete(account.id)
          }}
          className="px-3 py-1.5 text-xs hover:text-negative-400"
        >
          Delete
        </Button>
      </div>

      <div className="mt-6 border-t border-slate-700 pt-4">
        <h4 className="text-base font-semibold text-slate-100">Account config</h4>
        <p className="mb-4 text-sm text-slate-400">
          Manage this account&apos;s order dispatch destination.
        </p>
        <form autoComplete="off" onSubmit={handleDestination} className="grid gap-4">
          <div>
            <span className="mb-2 block text-sm font-medium text-slate-300">
              Dispatch destination
            </span>
            <div className="grid items-start gap-3 md:grid-cols-2">
              <div
                className={`rounded-lg border p-3 transition ${
                  dispatchMode === 'traderspost'
                    ? 'border-indigo-500/60 bg-slate-800/70'
                    : 'border-slate-700 bg-slate-800/40 opacity-70'
                }`}
              >
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-200">
                  <input
                    type="radio"
                    name={`dispatch-mode-${account.id}`}
                    checked={dispatchMode === 'traderspost'}
                    onChange={() => setDispatchMode('traderspost')}
                    className="h-4 w-4 border-slate-600 bg-slate-800 text-indigo-500"
                  />
                  TradersPost
                </label>
                <p className="mt-1 text-xs text-slate-500">
                  Send the TradersPost-shaped payload to the account webhook.
                </p>
                {dispatchMode === 'traderspost' ? (
                  <div className="mt-3 grid gap-3">
                    <Input
                      label="Webhook URL"
                      name="webhookUrl"
                      type="url"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      required
                    />
                    <label className="block">
                      <span className="mb-1 block text-sm font-medium text-slate-300">
                        Override definition
                      </span>
                      <select
                        name="outboundTickerMode"
                        value={outboundMode}
                        onChange={(e) =>
                          setOutboundMode(e.target.value as 'none' | 'exact' | 'micros_only')
                        }
                        className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="none">None</option>
                        <option value="exact">Exact ticker</option>
                        <option value="micros_only">Micros only</option>
                      </select>
                    </label>
                    {outboundMode === 'exact' && (
                      <Input
                        label="Exact ticker"
                        name="outboundTicker"
                        autoComplete="off"
                        value={outboundTicker}
                        onChange={(e) => setOutboundTicker(e.target.value)}
                      />
                    )}
                    <label className="flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        name="reapplyOnTradeCloseEnabled"
                        checked={reapplyOnTradeCloseEnabled}
                        onChange={(e) => setReapplyOnTradeCloseEnabled(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                      />
                      Re-apply remaining bracket orders after trade close
                    </label>
                    <p className="text-xs text-slate-500">
                      When a trade closes, any remaining armed brackets on this account/instrument are cancelled and then re-sent in order of closeness to the close price. This can only run if no other bracket is currently filled.
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    {webhookUrl ? 'Configured — inactive while CrossTrade is selected.' : 'Not configured.'}
                  </p>
                )}
              </div>
              <div
                className={`rounded-lg border p-3 transition ${
                  dispatchMode === 'crosstrade'
                    ? 'border-indigo-500/60 bg-slate-800/70'
                    : 'border-slate-700 bg-slate-800/40 opacity-70'
                }`}
              >
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-200">
                  <input
                    type="radio"
                    name={`dispatch-mode-${account.id}`}
                    checked={dispatchMode === 'crosstrade'}
                    onChange={() => setDispatchMode('crosstrade')}
                    className="h-4 w-4 border-slate-600 bg-slate-800 text-indigo-500"
                  />
                  CrossTrade
                </label>
                <p className="mt-1 text-xs text-slate-500">
                  Convert orders to the CrossTrade command format and send them to its webhook. Reapply is not used for CrossTrade accounts.
                </p>
                {dispatchMode === 'crosstrade' ? (
                  <div className="mt-3 grid gap-3">
                    <p className="text-xs text-slate-500">
                      Routes through the CrossTrade NT8 Add-On — NinjaTrader 8 must be running with the add-on connected.
                    </p>
                    <Input
                      label="Webhook URL"
                      name="crossTradeWebhookUrl"
                      type="url"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      placeholder="https://app.crosstrade.io/v1/send/…"
                      value={crossTradeWebhookUrl}
                      onChange={(e) => setCrossTradeWebhookUrl(e.target.value)}
                      required
                    />
                    <Input
                      label="Secret key"
                      name="crossTradeSecretKey"
                      type="text"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      className="pw-mask"
                      placeholder={destination?.crossTradeSecretKeySet ? 'Saved — enter a new key to replace' : ''}
                      value={crossTradeSecretKey}
                      onChange={(e) => setCrossTradeSecretKey(e.target.value)}
                      required={!destination?.crossTradeSecretKeySet}
                    />
                    <Input
                      label="NT8 account name (e.g. Sim101)"
                      name="crossTradeAccountName"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      placeholder={account.name}
                      value={crossTradeAccountName}
                      onChange={(e) => setCrossTradeAccountName(e.target.value)}
                    />
                    <p className="text-xs text-slate-500">
                      {destination?.crossTradeSecretKeySet
                        ? 'A key is saved and never sent back to the browser — leave blank to keep it, or enter a new one to replace it.'
                        : 'The secret key doubles as the Bearer token for live order/position queries.'}
                    </p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    {crossTradeWebhookUrl ? 'Configured — inactive while TradersPost is selected.' : 'Not configured.'}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Outbound ticker override — same setting as inside the dispatch
              boxes, surfaced here so it's reachable in either mode. */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <span className="mb-3 block text-sm font-medium text-slate-300">
              Outbound override
            </span>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-300">
                  Override definition
                </span>
                <select
                  value={outboundMode}
                  onChange={(e) =>
                    setOutboundMode(e.target.value as 'none' | 'exact' | 'micros_only')
                  }
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="none">None</option>
                  <option value="exact">Exact ticker</option>
                  <option value="micros_only">Micros only</option>
                </select>
              </label>
              {outboundMode === 'exact' && (
                <Input
                  label="Exact ticker"
                  value={outboundTicker}
                  onChange={(e) => setOutboundTicker(e.target.value)}
                  required
                />
              )}
            </div>
          </div>

          {/* Order sizing — applies to every outbound entry quantity on this
              account, both TradersPost and CrossTrade. */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <span className="mb-3 block text-sm font-medium text-slate-300">
              Order sizing
            </span>
            <div className="grid items-end gap-3 md:grid-cols-2">
              <div className="block">
                <span className="mb-1 block text-sm font-medium text-slate-300">
                  Mode
                </span>
                <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-600 bg-slate-900/60 p-1">
                  {(
                    [
                      ['off', 'Off'],
                      ['percent', '% of alert'],
                      ['fixed', 'Fixed contracts'],
                      ['risk', '$ risk per trade'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setQuantityOverrideMode(value)}
                      className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                        quantityOverrideMode === value
                          ? 'bg-indigo-600 text-white'
                          : 'text-slate-400 hover:bg-slate-700/60 hover:text-slate-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {quantityOverrideMode !== 'off' && (
                <Input
                  label={
                    quantityOverrideMode === 'percent'
                      ? 'Percent'
                      : quantityOverrideMode === 'fixed'
                        ? 'Contracts per order'
                        : 'Dollar risk per trade'
                  }
                  name="quantityOverrideValue"
                  type="number"
                  min="0"
                  step="any"
                  value={quantityOverrideValue}
                  onChange={(e) => setQuantityOverrideValue(e.target.value)}
                  required
                />
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Applies to TradersPost and CrossTrade dispatches — one mode at a
              time. Percent accepts any value (15 → 15% of the alert size, 300 →
              3×). $ risk sizes the entry so a full stop-out loses ≈ the amount,
              using the order's stop distance and the instrument's tick value;
              micros-routed accounts are sized in micro contracts. Results floor
              to whole contracts, minimum 1.
            </p>
          </div>

          {/* Safety schedules apply to whichever dispatch destination is
              selected — the fields live on the shared destination row and the
              server converts cancel/exit to the CT command set when needed. */}
          <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-3">
            <span className="mb-3 block text-sm font-medium text-slate-300">
              Safety schedules
            </span>
            <div className="grid gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  name="eodEnabled"
                  checked={eodEnabled}
                  onChange={(e) => setEodEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                />
                Enable EOD cancel/flatten
              </label>
              <div className="grid gap-3 md:grid-cols-2">
                <Input
                  label="EOD cancel"
                  name="eodCancelTime"
                  type="time"
                  value={eodCancelTime}
                  onChange={(e) => setEodCancelTime(e.target.value)}
                  disabled={!eodEnabled}
                />
                <Input
                  label="EOD exit"
                  name="eodExitTime"
                  type="time"
                  value={eodExitTime}
                  onChange={(e) => setEodExitTime(e.target.value)}
                  disabled={!eodEnabled}
                />
              </div>
              <p className="text-xs text-slate-500">
                At the cancel time, open bracket orders are cancelled. At the exit time, open positions are flattened. Both times are in New York time (UTC-4).
              </p>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  name="newsFlattenEnabled"
                  checked={newsFlattenEnabled}
                  onChange={(e) => setNewsFlattenEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                />
                Flatten all positions and orders before red-folder news
              </label>
              <Input
                label="Minutes before high-impact news"
                name="newsFlattenMinutes"
                type="number"
                min={1}
                max={120}
                value={newsFlattenMinutes}
                onChange={(e) => setNewsFlattenMinutes(Number(e.target.value))}
                disabled={!newsFlattenEnabled}
              />
              <p className="text-xs text-slate-500">
                When enabled, all open bracket orders and positions for this account are cancelled/flattened this many minutes before any Forex Factory high-impact (red) event.
              </p>
            </div>
          </div>

          {configModified && (
            <div>
              <Button type="submit" variant="primary" className="px-3 py-1.5 text-xs">
                Save config
              </Button>
            </div>
          )}
        </form>

        <div className="mt-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
          <h5 className="text-sm font-semibold text-slate-200">Safeguard</h5>
          <p className="mt-1 text-xs text-slate-400">
            Send exit-and-cancel requests for every instrument this account has actually traded in the last
            24 hours, including the continuous contract, the current month, and the months on either
            side. This closes open positions and clears all pending bracket orders.
          </p>
          <button
            type="button"
            onClick={handleExitAllSafeguard}
            disabled={exiting || !(destination?.webhookUrl || destination?.crossTradeWebhookUrl)}
            className="mt-3 w-full rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-purple-900/20 transition hover:from-blue-500 hover:to-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            {exiting ? 'Sending...' : `Flatten account${destination?.crossTradeWebhookUrl ? ' in NT8' : ' in Tradovate'}`}
          </button>
        </div>

        <div
          className={`mt-4 rounded-lg border p-4 transition ${
            enabled
              ? 'border-positive/60 bg-positive-950/20'
              : 'border-slate-700 bg-slate-800/50'
          }`}
        >
          <div className="flex items-center justify-between">
            <h5 className="text-sm font-semibold text-slate-200">
              Order routing masterswitch
            </h5>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                enabled
                  ? 'bg-positive/20 text-positive'
                  : 'bg-slate-700 text-slate-400'
              }`}
            >
              {enabled ? 'ON' : 'OFF'}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {enabled
              ? `Routing is live — entries, exits, and cancels are forwarded to ${destination?.crossTradeWebhookUrl ? 'CrossTrade' : 'TradersPost'} for this account.`
              : 'Routing is off — nothing is forwarded for this account.'}
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleToggleRouting}
            disabled={toggling || !(destination?.webhookUrl || destination?.crossTradeWebhookUrl)}
            className={`mt-3 flex w-full items-center justify-between rounded-lg px-4 py-3 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${
              enabled
                ? 'bg-gradient-to-r from-positive-500 to-positive text-[#022c22] shadow-lg shadow-positive-500/25 hover:from-positive-400 hover:to-positive focus:ring-positive-500'
                : 'bg-slate-700 text-slate-300 hover:bg-slate-600 focus:ring-slate-500'
            }`}
          >
            <span>
              {toggling ? 'Saving…' : enabled ? 'Routing ON' : 'Routing OFF'}
            </span>
            <span
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
                enabled ? 'bg-positive-950/30' : 'bg-slate-900/60'
              }`}
            >
              <span
                className={`absolute h-4 w-4 rounded-full bg-white shadow transition ${
                  enabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </span>
          </button>
          {!destination?.webhookUrl && (
            <p className="mt-2 text-xs text-slate-500">
              Save a dispatch destination above before toggling routing.
            </p>
          )}
        </div>

        <div className="mt-4 border-t border-slate-700 pt-3 text-center">
          <div className="text-lg font-semibold text-slate-100">{account.name}</div>
        </div>
      </div>

      {cloneOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card
            title="Clone account"
            right={
              <Button type="button" variant="ghost" onClick={() => setCloneOpen(false)}>
                Close
              </Button>
            }
            className="w-full max-w-md"
          >
            <p className="mb-4 text-sm text-slate-400">
              Creates a copy of <strong className="text-slate-200">{account.name}</strong> with
              identical settings — dispatch destination, secrets, order sizing, and route
              subscriptions.
            </p>
            <form
              autoComplete="off"
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (!cloneName.trim()) return
                onClone(account.id, cloneName.trim())
                setCloneOpen(false)
              }}
            >
              <Input
                label="New account name"
                name="cloneName"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                value={cloneName}
                onChange={(e) => setCloneName(e.target.value)}
                autoFocus
                required
                maxLength={128}
              />
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setCloneOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary">
                  Clone account
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </CollapsibleSection>
  )
}

// Static class map — Tailwind needs literal class names at build time.
const ACCOUNT_GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
}

export function AccountsPage() {
  const cached = getCachedAccounts()
  const [openCardIds, setOpenCardIds] = useState<ReadonlySet<string>>(() => {
    // Seed from the per-card storage keys so prior expansions survive.
    const seed = new Set<string>()
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)
        if (key?.startsWith('accounts:card:') && window.localStorage.getItem(key) === 'true') {
          seed.add(key.slice('accounts:card:'.length))
        }
      }
    } catch { /* ignore */ }
    return seed
  })
  const [accountCols, setAccountCols] = useState<number>(() => {
    const saved = Number(window.localStorage.getItem('accounts:cols'))
    return [1, 2, 3, 4].includes(saved) ? saved : 2
  })
  useEffect(() => {
    window.localStorage.setItem('accounts:cols', String(accountCols))
  }, [accountCols])
  const [serverAccounts, setServerAccounts] = useState<AccountJournal[] | undefined>(cached?.accounts)
  const [serverAlertSummaryMap, setServerAlertSummaryMap] = useState<
    Record<string, AccountAlertSummary> | undefined
  >(cached?.alertSummaries)
  const [serverEnabledRouteCounts, setServerEnabledRouteCounts] = useState<
    Record<string, number>
  >(cached?.enabledRouteCounts ?? {})
  const [serverDestinationMap, setServerDestinationMap] = useState<
    Record<string, TradersPostAccountDestination | undefined> | undefined
  >(cached?.destinations)
  const [fetching, setFetching] = useState(false)
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
      .catch((error) => {
        console.error('Failed to load accounts from server:', error)
      })
      .finally(() => {
        setFetching(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [])

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => a.account.createdAt.localeCompare(b.account.createdAt)),
    [serverAccounts],
  )
  const activeAccounts = useMemo(
    () => sortedAccounts.filter((aj) => !aj.account.deprecated),
    [sortedAccounts],
  )
  const deprecatedAccounts = useMemo(
    () => sortedAccounts.filter((aj) => aj.account.deprecated),
    [sortedAccounts],
  )

  const persistCardOpen = (id: string, open: boolean) => {
    try {
      window.localStorage.setItem(`accounts:card:${id}`, String(open))
    } catch { /* ignore */ }
  }

  // Opening a card opens every card in its grid row so a row reads as one
  // expanded band; closing still affects just that card.
  const toggleAccountCard = (list: AccountJournal[], index: number) => {
    const id = list[index].account.id
    const opening = !openCardIds.has(id)
    const next = new Set(openCardIds)
    if (opening) {
      const rowStart = Math.floor(index / accountCols) * accountCols
      for (let i = rowStart; i < Math.min(rowStart + accountCols, list.length); i++) {
        next.add(list[i].account.id)
        persistCardOpen(list[i].account.id, true)
      }
    } else {
      next.delete(id)
      persistCardOpen(id, false)
    }
    setOpenCardIds(next)
  }

  const cloneAccount = (accountId: string, name: string) => {
    postForm('/accounts/clone', { accountId, name })
      .then(() => {
        refresh()
        success(`Account "${name}" cloned`)
      })
      .catch((err) => {
        error('Failed to clone account')
        console.error('Failed to clone account:', err)
      })
  }

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault()
    postForm('/accounts', { name: newName, startingBalance: newStartingBalance })
      .then(() => {
        setNewName('')
        setNewStartingBalance('')
        refresh()
        success('Account added')
      })
      .catch((err) => {
        error('Failed to add account')
        console.error('Failed to add account:', err)
      })
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
      useLimitPriceTP: destination.useLimitPriceTP
        ? 'true'
        : undefined,
      useAlertTP: destination.useAlertTP
        ? 'true'
        : undefined,
      reapplyOnTradeCloseEnabled: destination.reapplyOnTradeCloseEnabled
        ? 'true'
        : undefined,
      eodEnabled: destination.eodEnabled ? 'true' : undefined,
      eodCancelTime: destination.eodCancelTime,
      eodExitTime: destination.eodExitTime,
      newsFlattenEnabled: destination.newsFlattenEnabled ? 'true' : undefined,
      newsFlattenMinutes:
        destination.newsFlattenMinutes === undefined
          ? undefined
          : String(destination.newsFlattenMinutes),
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
        destination.quantityOverrideValue == null
          ? undefined
          : String(destination.quantityOverrideValue),
    })
      .then(() => {
        refresh()
        success(successMessage)
        return true
      })
      .catch((err) => {
        error('Failed to save dispatch destination')
        console.error('Failed to update destination:', err)
        return false
      })
  }

  const deleteAccount = (accountId: string) => {
    postForm('/accounts/delete', { accountId })
      .then(() => {
        refresh()
        success('Account deleted')
      })
      .catch((err) => {
        error('Failed to delete account')
        console.error('Failed to delete account:', err)
      })
  }

  const deprecateAccount = (accountId: string, deprecated: boolean) => {
    postForm('/accounts/deprecate', {
      accountId,
      deprecated: deprecated ? 'true' : 'false',
    })
      .then(() => {
        refresh()
        success(deprecated ? 'Account deprecated' : 'Account reactivated')
      })
      .catch((err) => {
        error('Failed to update account status')
        console.error('Failed to update account deprecation:', err)
      })
  }

  const updateStartingBalance = (
    accountId: string,
    startingBalance: string,
  ) => {
    postForm('/accounts/starting-balance', {
      accountId,
      startingBalance,
    })
      .then(() => {
        refresh()
        success('Starting balance updated')
      })
      .catch((err) => {
        error('Failed to update starting balance')
        console.error('Failed to update starting balance:', err)
      })
  }

  const titleWithSpinner = (text: string) => (
    <span className="flex items-center gap-2">
      {text}
      {fetching && <LoadingSpinner size={16} />}
    </span>
  )

  return (
    <div className="space-y-8 text-slate-100">
      <PageHeader title="Accounts" subtitle="Account overview" onTitleClick={refresh} />

      {!showAddAccount && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="primary"
            onClick={() => setShowAddAccount(true)}
          >
            add
          </Button>
        </div>
      )}

      {showAddAccount && (
      <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
        <section>
          <h3 className="mb-1 font-bold text-slate-100">Add account</h3>
          <p className="mb-1 text-sm text-slate-400">
            Internal balance starts with your opening figure, then realized P&L
            carries it forward automatically.
          </p>
          <p className="mb-4 text-xs text-slate-500">
            You can configure the account's destination, safety, and routing
            settings after it is created.
          </p>
          <form onSubmit={handleAdd} className="grid gap-4 md:grid-cols-3">
            <Input
              label="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              maxLength={128}
            />
            <Input
              label="Starting balance (dollars)"
              inputMode="decimal"
              value={newStartingBalance}
              onChange={(e) => setNewStartingBalance(e.target.value)}
              placeholder="1000.00"
              required
            />
            <div className="flex items-end">
              <Button type="submit" variant="primary">
                Add account
              </Button>
            </div>
          </form>
        </section>
      </div>
      )}

      <CollapsibleSection
        title={titleWithSpinner('Accounts')}
        storageKey="accounts:overview"
        actions={
          <div className="hidden items-center gap-0.5 rounded-md border border-slate-700 p-0.5 sm:flex">
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                title={`${n} column${n === 1 ? '' : 's'}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setAccountCols(n)
                }}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium leading-none transition ${
                  accountCols === n
                    ? 'bg-slate-600 text-white'
                    : 'text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        }
      >
        <section>
          <p className="mb-4 text-slate-400">
            You can toggle the routing masterswitch for each account here.
          </p>
          <div className={`grid gap-6 ${ACCOUNT_GRID_COLS[accountCols]}`}>
            {activeAccounts.map((aj, idx) => (
              <AccountCard
                key={aj.account.id + (destinationMap[aj.account.id]?.updatedAt ?? '')}
                accountJournal={aj}
                expanded={openCardIds.has(aj.account.id)}
                onToggleExpand={() => toggleAccountCard(activeAccounts, idx)}
                enabledRoutes={enabledRouteCounts[aj.account.id] ?? 0}
                alertSummary={
                  alertSummaryMap[aj.account.id] ?? {
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
                }
                destination={destinationMap[aj.account.id]}
                onUpdateDestination={updateDestination}
                onUpdateStartingBalance={updateStartingBalance}
                onDelete={deleteAccount}
                onDeprecate={deprecateAccount}
                onClone={cloneAccount}
              />
            ))}
          </div>

          {deprecatedAccounts.length > 0 && (
            <CollapsibleSection
              title={
                <span className="text-sm font-bold uppercase tracking-widest text-slate-500">
                  Deprecated accounts ({deprecatedAccounts.length})
                </span>
              }
              storageKey="accounts:deprecated"
              defaultOpen={false}
              className="mt-6 rounded-xl border border-slate-700 bg-slate-800/50"
            >
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
                {deprecatedAccounts.map((aj, idx) => (
                  <AccountCard
                    key={aj.account.id + (destinationMap[aj.account.id]?.updatedAt ?? '')}
                    accountJournal={aj}
                    expanded={openCardIds.has(aj.account.id)}
                    onToggleExpand={() => toggleAccountCard(deprecatedAccounts, idx)}
                    enabledRoutes={enabledRouteCounts[aj.account.id] ?? 0}
                    alertSummary={
                      alertSummaryMap[aj.account.id] ?? {
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
                    }
                    destination={destinationMap[aj.account.id]}
                    onUpdateDestination={updateDestination}
                    onUpdateStartingBalance={updateStartingBalance}
                    onDelete={deleteAccount}
                    onDeprecate={deprecateAccount}
                    onClone={cloneAccount}
                  />
                ))}
              </div>
            </CollapsibleSection>
          )}
        </section>
      </CollapsibleSection>

      <CollapsibleSection
        title={titleWithSpinner('Accounts Performance')}
        storageKey="accounts:performance"
      >
        <section>
          <p className="mb-4 text-slate-400">
            All accounts stay visible here for comparison.
          </p>
          <AccountPerformanceChart accounts={accounts} />
        </section>
      </CollapsibleSection>
    </div>
  )
}
