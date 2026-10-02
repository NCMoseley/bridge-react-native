import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { Input } from '../components/Input'
import { Button } from '../components/Button'
import { LoadingSpinner } from '../components/LoadingSpinner'
import { PageHeader } from '../components/PageHeader'
import { useToast } from '../context/ToastContext'
import { useTheme, type Theme } from '../context/ThemeContext'
import { monthRangeFromHtml } from '../utils/forex-factory'
import { getCachedSettings, setCachedSettings } from '../utils/settings-cache'
import { isAlertSoundEnabled, setAlertSoundEnabled } from '../utils/alertSound'
import { getJson, postForm, postJson } from '../api/client'
import type { BridgeAccount, RangeRoute, RangeSubcategory, RangeSubcategoryAssignment } from '../types'

interface RouteEdit {
  id: string
  rangeName: string
  accountId: string
  accountName: string
  extensionEnabled: boolean
  traderspostEnabled: boolean
  runScheduled: boolean
}

interface SettingsData {
  accounts: BridgeAccount[]
  rangeRoutes: RangeRoute[]
  rangeNames: string[]
  rangeSubcategories: RangeSubcategory[]
  rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
  extensionToken: string
  extensionVersion: string
}

interface RouteTableProps {
  rangeName: string
  currentRoutes: RouteEdit[]
  activeAccounts: BridgeAccount[]
  selectedAccountIds: Set<string>
  saving?: boolean
  updateRoute: (
    rangeName: string,
    accountId: string,
    extension: boolean,
    traderspost: boolean,
    runScheduled: boolean,
  ) => void
}

function RouteTable({
  rangeName,
  currentRoutes,
  activeAccounts,
  selectedAccountIds,
  saving,
  updateRoute,
}: RouteTableProps) {
  const currentByAccount = new Map(
    currentRoutes.map((r) => [r.accountId, r]),
  )
  const displayAccounts =
    selectedAccountIds.size > 0
      ? activeAccounts.filter((a) => selectedAccountIds.has(a.id))
      : activeAccounts
  return (
    <div className="overflow-x-auto -my-1 py-1">
    <table className="w-full min-w-[28rem] text-left text-sm">
      <thead className="text-xs uppercase tracking-wide text-slate-400">
        <tr>
          <th className="py-2 pr-2">Account</th>
          <th className="py-2 pr-2 text-center">Extension</th>
          <th className="py-2 pr-2 text-center">Broker</th>
          <th className="py-2 text-center">Only Scheduled</th>
        </tr>
      </thead>
      <tbody>
        {displayAccounts.map((account) => {
          const route = currentByAccount.get(account.id)
          const extension = route?.extensionEnabled ?? false
          const traderspost = route?.traderspostEnabled ?? false
          const runScheduled = route?.runScheduled ?? false
          return (
            <tr key={account.id} className="border-t border-slate-700/50">
              <td className="break-words py-2 pr-2">{account.name}{route?.runScheduled ? ' 📅' : ''}</td>
              <td className="py-2 pr-2 text-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                  disabled={saving}
                  checked={extension}
                  onChange={(e) =>
                    updateRoute(
                      rangeName,
                      account.id,
                      e.target.checked,
                      traderspost,
                      runScheduled,
                    )
                  }
                />
              </td>
              <td className="py-2 pr-2 text-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                  disabled={saving}
                  checked={traderspost}
                  onChange={(e) =>
                    updateRoute(
                      rangeName,
                      account.id,
                      extension,
                      e.target.checked,
                      runScheduled,
                    )
                  }
                />
              </td>
              <td className="py-2 text-center">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                  disabled={saving}
                  checked={runScheduled}
                  onChange={(e) =>
                    updateRoute(
                      rangeName,
                      account.id,
                      extension,
                      traderspost,
                      e.target.checked,
                    )
                  }
                />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
    </div>
  )
}

function buildRoutes(routes: RangeRoute[], accounts: BridgeAccount[]): RouteEdit[] {
  const accountById = new Map(accounts.map((a) => [a.id, a]))
  return routes.map((route) => ({
    id: `${route.rangeName}|${route.accountId}`,
    rangeName: route.rangeName,
    accountId: route.accountId,
    accountName: accountById.get(route.accountId)?.name ?? route.accountId,
    extensionEnabled: route.extensionEnabled,
    traderspostEnabled: route.traderspostEnabled,
    runScheduled: route.runScheduled,
  }))
}

interface ModelSubscribeFormProps {
  accounts: BridgeAccount[]
  subcategories: RangeSubcategory[]
  assignments: RangeSubcategoryAssignment[]
  onSubscribed: () => void
}

function ModelSubscribeForm({
  accounts,
  subcategories,
  assignments,
  onSubscribed,
}: ModelSubscribeFormProps) {
  const { success, error } = useToast()
  const [subcategoryName, setSubcategoryName] = useState(
    subcategories[0]?.name ?? '',
  )
  const [accountId, setAccountId] = useState('')
  const [extensionEnabled, setExtensionEnabled] = useState(true)
  const [traderspostEnabled, setTraderspostEnabled] = useState(true)
  const [runScheduled, setRunScheduled] = useState(true)
  const [subscribing, setSubscribing] = useState(false)

  const rangeCount = useMemo(
    () => assignments.filter((a) => a.subcategoryName === subcategoryName).length,
    [assignments, subcategoryName],
  )

  const handleSubscribe = () => {
    if (!subcategoryName || !accountId) return
    setSubscribing(true)
    postJson('/api/model-subscribe', {
      subcategoryName,
      accountId,
      extensionEnabled,
      traderspostEnabled,
      runScheduled,
    })
      .then((res) => res.json() as Promise<{ success: boolean; count: number }>)
      .then(({ count }) => {
        success(`Subscribed ${count} range${count === 1 ? '' : 's'} in ${subcategoryName}`)
        onSubscribed()
      })
      .catch((err) => {
        console.error('Failed to subscribe to model:', err)
        error('Failed to subscribe to model')
      })
      .finally(() => setSubscribing(false))
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-400">
        Subscribe an account to every range currently assigned to a model.
        {rangeCount > 0 && (
          <span className="ml-1 text-slate-300">
            This will create {rangeCount} new route{rangeCount === 1 ? '' : 's'}.
          </span>
        )}
      </p>
      <div className="flex flex-col flex-wrap gap-3 sm:flex-row sm:items-end">
        <label className="flex w-full flex-col gap-1 text-sm text-slate-400 sm:w-56">
          Model
          <select
            value={subcategoryName}
            onChange={(e) => setSubcategoryName(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            {subcategories.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex w-full flex-col gap-1 text-sm text-slate-400 sm:w-56">
          Account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">Select an account</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-slate-400">
          <input
            type="checkbox"
            checked={extensionEnabled}
            onChange={(e) => setExtensionEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500"
          />
          Extension
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-slate-400">
          <input
            type="checkbox"
            checked={traderspostEnabled}
            onChange={(e) => setTraderspostEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500"
          />
          Broker
        </label>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-slate-400">
          <input
            type="checkbox"
            checked={runScheduled}
            onChange={(e) => setRunScheduled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-indigo-500"
          />
          Only scheduled
        </label>
        <Button
          type="button"
          variant="primary"
          onClick={handleSubscribe}
          disabled={!subcategoryName || !accountId || subscribing}
          className="whitespace-nowrap"
        >
          {subscribing ? 'Subscribing...' : 'Subscribe'}
        </Button>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const cached = getCachedSettings()
  const [accounts, setAccounts] = useState<BridgeAccount[]>(cached?.accounts ?? [])
  const [rangeNames, setRangeNames] = useState<string[]>(cached?.rangeNames ?? [])
  const [subcategories, setSubcategories] = useState<RangeSubcategory[]>(cached?.rangeSubcategories ?? [])
  const [assignments, setAssignments] = useState<RangeSubcategoryAssignment[]>(cached?.rangeSubcategoryAssignments ?? [])
  const [routes, setRoutes] = useState<RouteEdit[]>(
    buildRoutes(cached?.rangeRoutes ?? [], cached?.accounts ?? []),
  )
  const [fetching, setFetching] = useState(false)
  const { theme, setTheme } = useTheme()
  const [alertSound, setAlertSound] = useState(isAlertSoundEnabled)
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set(),
  )
  const [savingSubscriptions, setSavingSubscriptions] = useState(false)
  const [dirtyRanges, setDirtyRanges] = useState<Set<string>>(new Set())
  const dirtyRangesRef = useRef<Set<string>>(new Set())
  const [forexHtml, setForexHtml] = useState('')
  const [extensionToken, setExtensionToken] = useState<string | undefined>(
    cached?.extensionToken,
  )
  const [extensionVersion, setExtensionVersion] = useState<string | undefined>(
    cached?.extensionVersion,
  )
  const { success, error } = useToast()

  const allAccounts = accounts
  const activeAccounts = useMemo(
    () => allAccounts.filter((a) => !a.deprecated),
    [allAccounts],
  )
  const accountById = useMemo(
    () => new Map(allAccounts.map((a) => [a.id, a])),
    [allAccounts],
  )

  const load = useCallback((preserveLocalEdits = false) => {
    setFetching(true)
    return getJson<SettingsData>('/api/settings')
      .then(({ accounts, rangeRoutes, rangeNames, rangeSubcategories, rangeSubcategoryAssignments, extensionToken, extensionVersion }) => {
        setAccounts(accounts)
        setRangeNames(rangeNames)
        setSubcategories(rangeSubcategories)
        setAssignments(rangeSubcategoryAssignments)
        setRoutes((current) => {
          const serverRoutes = buildRoutes(rangeRoutes, accounts)
          const dirty = preserveLocalEdits ? dirtyRangesRef.current : new Set<string>()
          if (dirty.size === 0) return serverRoutes
          // Reloads that aren't a save (add/remove subscription) must not discard
          // unsaved local edits — keep the local draft for each dirty range.
          const localByRange = new Map<string, RouteEdit[]>()
          for (const route of current) {
            const list = localByRange.get(route.rangeName) ?? []
            list.push(route)
            localByRange.set(route.rangeName, list)
          }
          const merged: RouteEdit[] = []
          const emitted = new Set<string>()
          for (const route of serverRoutes) {
            if (!dirty.has(route.rangeName)) {
              merged.push(route)
            } else if (!emitted.has(route.rangeName)) {
              emitted.add(route.rangeName)
              merged.push(...(localByRange.get(route.rangeName) ?? [route]))
            }
          }
          for (const [rangeName, localRoutes] of localByRange) {
            if (dirty.has(rangeName) && !emitted.has(rangeName)) merged.push(...localRoutes)
          }
          return merged
        })
        if (!preserveLocalEdits) {
          dirtyRangesRef.current = new Set()
          setDirtyRanges(new Set())
        }
        setExtensionToken(extensionToken)
        setExtensionVersion(extensionVersion)
        setCachedSettings({ accounts, rangeRoutes, rangeNames, rangeSubcategories, rangeSubcategoryAssignments, extensionToken, extensionVersion })
      })
      .catch((err) => {
        console.error('Failed to load settings:', err)
        error('Failed to load settings')
      })
      .finally(() => {
        setFetching(false)
      })
  }, [error])

  const handleForexImport = (e: React.FormEvent) => {
    e.preventDefault()
    if (forexHtml.trim().startsWith('http')) {
      error('Please paste the page HTML source, not the URL.')
      return
    }
    const range = monthRangeFromHtml(forexHtml)
    if (!range) {
      error('Could not detect a month in the pasted page source.')
      return
    }
    postForm('/forex-factory/import', { range, html: forexHtml })
      .then(() => {
        success('Forex Factory monthly snapshot imported')
        setForexHtml('')
      })
      .catch((err) => {
        console.error('Failed to import Forex Factory snapshot:', err)
        error('Failed to import snapshot')
      })
  }

  useEffect(() => {
    load()
  }, [])

  const [newRange, setNewRange] = useState('')
  const [newExtension, setNewExtension] = useState<Set<string>>(new Set())
  const [newTraderspost, setNewTraderspost] = useState<Set<string>>(new Set())
  const [newRunScheduled, setNewRunScheduled] = useState<Set<string>>(new Set())
  const [removeAccountId, setRemoveAccountId] = useState('')
  const [removing, setRemoving] = useState(false)
  const [copyFromId, setCopyFromId] = useState('')
  const [copyToId, setCopyToId] = useState('')
  const [copying, setCopying] = useState(false)

  const sharedRangeNames = rangeNames

  const groupedRoutes = useMemo(() => {
    const activeRoutes = routes.filter(
      (r) => !accountById.get(r.accountId)?.deprecated,
    )
    const filtered =
      selectedAccountIds.size > 0
        ? activeRoutes.filter((r) => selectedAccountIds.has(r.accountId))
        : activeRoutes
    const byRange = new Map<string, RouteEdit[]>()
    for (const route of filtered) {
      // A range stays listed while its unsaved edits are pending — removing a
      // subscription (unchecking both) must not drop the card before save.
      if (!route.extensionEnabled && !route.traderspostEnabled && !dirtyRanges.has(route.rangeName)) continue
      const list = byRange.get(route.rangeName) ?? []
      list.push(route)
      byRange.set(route.rangeName, list)
    }
    return [...byRange.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [routes, selectedAccountIds, accountById, dirtyRanges])

  const syncRange = (rangeName: string, next: RouteEdit[]) => {
    const rangeRoutes = next.filter((r) => r.rangeName === rangeName)
    const extensionAccountIds = rangeRoutes
      .filter((r) => r.extensionEnabled)
      .map((r) => r.accountId)
    const traderspostAccountIds = rangeRoutes
      .filter((r) => r.traderspostEnabled)
      .map((r) => r.accountId)
    const selectedAccountIds = new Set([
      ...extensionAccountIds,
      ...traderspostAccountIds,
    ])
    const runScheduledAccountIds = rangeRoutes
      .filter((r) => r.runScheduled && selectedAccountIds.has(r.accountId))
      .map((r) => r.accountId)
    return postForm('/range-routes', {
      rangeName,
      extensionAccountIds,
      traderspostAccountIds,
      runScheduledAccountIds,
    })
  }

  const updateRoute = (
    rangeName: string,
    accountId: string,
    extension: boolean,
    traderspost: boolean,
    runScheduled: boolean,
  ) => {
    const next = [...routes]
    const index = next.findIndex(
      (r) => r.rangeName === rangeName && r.accountId === accountId,
    )
    if (index >= 0) {
      next[index] = {
        ...next[index],
        extensionEnabled: extension,
        traderspostEnabled: traderspost,
        runScheduled,
      }
    } else if (extension || traderspost) {
      const account = accountById.get(accountId)
      if (account) {
        next.push({
          id: `${rangeName}|${accountId}`,
          rangeName,
          accountId,
          accountName: account.name,
          extensionEnabled: extension,
          traderspostEnabled: traderspost,
          runScheduled,
        })
      }
    }
    setRoutes(next)
    setDirtyRanges((prev) => {
      const nextDirty = new Set(prev).add(rangeName)
      dirtyRangesRef.current = nextDirty
      return nextDirty
    })
  }

  const saveSubscriptionChanges = async () => {
    const pending = [...dirtyRanges]
    if (pending.length === 0) return
    setSavingSubscriptions(true)
    try {
      for (const rangeName of pending) {
        await syncRange(rangeName, routes)
      }
      await load()
      success(
        `Subscription settings saved for ${pending.length} range${pending.length === 1 ? '' : 's'}`,
      )
    } catch (err) {
      console.error('Failed to save subscription settings:', err)
      error('Failed to save subscription settings')
    } finally {
      setSavingSubscriptions(false)
    }
  }

  const saveNewSubscription = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newRange.trim()) return
    const name = newRange.trim()
    if (!window.confirm(`Save subscription for ${name}?`)) return
    const extensionAccountIds = activeAccounts
      .filter((a) => newExtension.has(a.id))
      .map((a) => a.id)
    const traderspostAccountIds = activeAccounts
      .filter((a) => newTraderspost.has(a.id))
      .map((a) => a.id)
    const selectedAccountIds = new Set([
      ...extensionAccountIds,
      ...traderspostAccountIds,
    ])
    const runScheduledAccountIds = activeAccounts
      .filter((a) => newRunScheduled.has(a.id) && selectedAccountIds.has(a.id))
      .map((a) => a.id)
    try {
      await postForm('/range-routes', {
        rangeName: name,
        extensionAccountIds,
        traderspostAccountIds,
        runScheduledAccountIds,
      })
      setNewRange('')
      setNewExtension(new Set())
      setNewTraderspost(new Set())
      setNewRunScheduled(new Set())
      load(true)
      success(`Subscription for ${name} saved`)
    } catch (err) {
      error(err instanceof Error ? err.message : 'Failed to save subscription')
    }
  }

  const handleRemoveAllSubscriptions = () => {
    if (!removeAccountId) return
    const account = accountById.get(removeAccountId)
    if (!window.confirm(`Remove all subscriptions for ${account?.name ?? 'this account'}?`)) return
    setRemoving(true)
    postForm('/account/subscriptions/remove', { accountId: removeAccountId })
      .then((res) => res.json() as Promise<{ removed: number }>)
      .then(({ removed }) => {
        setRemoveAccountId('')
        load(true)
        success(`Removed ${removed} subscription${removed === 1 ? '' : 's'}`)
      })
      .catch((err) => {
        console.error('Failed to remove subscriptions:', err)
        error('Failed to remove subscriptions')
      })
      .finally(() => setRemoving(false))
  }

  const handleCopySubscriptions = () => {
    if (!copyFromId || !copyToId || copyFromId === copyToId) return
    const from = accountById.get(copyFromId)
    const to = accountById.get(copyToId)
    if (!window.confirm(
      `Copy all subscriptions from ${from?.name ?? 'source'} to ${to?.name ?? 'target'}? ` +
      `This replaces every existing subscription on ${to?.name ?? 'the target account'}.`,
    )) return
    setCopying(true)
    postForm('/account/subscriptions/copy', {
      fromAccountId: copyFromId,
      toAccountId: copyToId,
    })
      .then((res) => res.json() as Promise<{ copied: number; removed: number }>)
      .then(({ copied, removed }) => {
        setCopyFromId('')
        setCopyToId('')
        load(true)
        success(
          `Copied ${copied} subscription${copied === 1 ? '' : 's'} to ${to?.name ?? 'account'}` +
          (removed > 0 ? ` (replaced ${removed})` : ''),
        )
      })
      .catch((err) => {
        console.error('Failed to copy subscriptions:', err)
        error('Failed to copy subscriptions')
      })
      .finally(() => setCopying(false))
  }

  const toggleNewExtension = (accountId: string, checked: boolean) => {
    setNewExtension((prev) => {
      const next = new Set(prev)
      if (checked) next.add(accountId)
      else next.delete(accountId)
      return next
    })
  }

  const toggleNewTraderspost = (accountId: string, checked: boolean) => {
    setNewTraderspost((prev) => {
      const next = new Set(prev)
      if (checked) next.add(accountId)
      else next.delete(accountId)
      return next
    })
  }

  const toggleNewRunScheduled = (accountId: string, checked: boolean) => {
    setNewRunScheduled((prev) => {
      const next = new Set(prev)
      if (checked) next.add(accountId)
      else next.delete(accountId)
      return next
    })
  }

  const extensionZipAvailable = true

  return (
    <div className="space-y-6 text-slate-100">
      <PageHeader
        title="Settings"
        subtitle="Configuration"
        description="Configure routes and subscriptions."
        onTitleClick={() => void load()}
      >
        {fetching && <LoadingSpinner size={20} />}
      </PageHeader>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card title="Model subscriptions">
            <ModelSubscribeForm
              accounts={activeAccounts}
              subcategories={subcategories}
              assignments={assignments}
              onSubscribed={load}
            />
          </Card>

          <Card title="Single range subscription">
            <p className="mb-4 text-sm text-slate-400">
              Type an exact tracked range name, then check Extension and/or
              Broker for every account that should use it. Turn on Run
              Scheduled to only use this route on days the range runs — ranges
              in a model follow that model's per-range run days when the
              account is subscribed to the whole model.
            </p>
            <form onSubmit={saveNewSubscription} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-300">
                  Range name
                </label>
                <Input
                  list="shared-range-options"
                  value={newRange}
                  onChange={(e) => setNewRange(e.target.value)}
                  placeholder="Opening Range"
                />
                <datalist id="shared-range-options">
                  {sharedRangeNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>

              <div className="overflow-x-auto -mx-6 -my-2 px-6 py-2">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="py-2 pr-2">Account</th>
                    <th className="py-2 pr-2 text-center">Extension</th>
                    <th className="py-2 pr-2 text-center">Broker</th>
                    <th className="py-2 text-center">Only Scheduled</th>
                  </tr>
                </thead>
                <tbody>
                  {activeAccounts.map((account) => (
                    <tr
                      key={account.id}
                      className="border-t border-slate-700/50"
                    >
                      <td className="py-2 pr-2">{account.name}</td>
                      <td className="py-2 pr-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                          checked={newExtension.has(account.id)}
                          onChange={(e) =>
                            toggleNewExtension(account.id, e.target.checked)
                          }
                        />
                      </td>
                      <td className="py-2 pr-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                          checked={newTraderspost.has(account.id)}
                          onChange={(e) =>
                            toggleNewTraderspost(account.id, e.target.checked)
                          }
                        />
                      </td>
                      <td className="py-2 text-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                          checked={newRunScheduled.has(account.id)}
                          onChange={(e) =>
                            toggleNewRunScheduled(account.id, e.target.checked)
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>

              <Button type="submit">Save subscription</Button>
            </form>
          </Card>

          <Card title="Theme">
            <p className="mb-4 text-sm text-slate-400">
              Switch the journal workspace between dark and light mode.
            </p>
            <div className="space-y-3">
              <select
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                value={theme}
                onChange={(e) => {
                  setTheme(e.target.value as Theme)
                }}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="castrol">Castrol</option>
                <option value="ultra">Ultra</option>
                <option value="neonsign">Neon</option>
                <option value="barbie">Barbie House</option>
                <option value="irish">Eire</option>
                <option value="medieval">Medieval</option>
                <option value="optimist">The Optimist</option>
                <option value="cush">Cush</option>
              </select>
            </div>
          </Card>

          <Card title="Alert sound">
            <p className="mb-4 text-sm text-slate-400">
              Play a short sound when new alerts reach the Bridge.
            </p>
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-indigo-500"
                checked={alertSound}
                onChange={(e) => {
                  const next = e.target.checked
                  setAlertSound(next)
                  setAlertSoundEnabled(next)
                  success(`Alert sound ${next ? 'enabled' : 'disabled'}`)
                }}
              />
              Play a sound when new alerts arrive.
            </label>
            <p className="mt-2 text-sm text-slate-400">
              Current sound: {alertSound ? 'On' : 'Off'}. The browser may
              require one click or key press in this tab before audio can play.
            </p>
          </Card>

          <Card title="Extension download">
            <p className="mb-4 text-sm text-slate-400">
              Download the latest browser extension zip
              {extensionVersion ? ` (v${extensionVersion})` : ''} for this user,
              then load it into the browser profile that uses this bridge
              connection.
            </p>
            {extensionZipAvailable ? (
              <a
                href="/app/extension-download"
                className="inline-flex items-center justify-center rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-700"
              >
                Download extension{extensionVersion ? ` v${extensionVersion}` : ''} zip
              </a>
            ) : (
              <p className="text-sm text-slate-500">
                The latest extension zip is not available on this server yet.
              </p>
            )}

            <div className="mt-4 border-t border-slate-700 pt-4">
              <p className="mb-2 text-sm text-slate-400">Extension token</p>
              {extensionToken ? (
                <div className="flex items-start gap-2">
                  <code className="break-all rounded bg-slate-900 px-2 py-1 text-xs text-slate-300">
                    {extensionToken}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(extensionToken)
                      success('Token copied')
                    }}
                  >
                    Copy
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-slate-500">No token available.</p>
              )}
            </div>
          </Card>

          <Card title="Forex Factory month import">
            <p className="mb-4 text-sm text-slate-400">
              Import the current Forex Factory month to see red-folder events.
              Open the Bridge extension popup and click Import current Forex
              month, or paste the monthly page source below.
            </p>
            <form
              onSubmit={handleForexImport}
              className="space-y-3"
            >
              <label className="block text-sm text-slate-300">
                Monthly page source
                <textarea
                  value={forexHtml}
                  onChange={(e) => setForexHtml(e.target.value)}
                  rows={5}
                  placeholder="Paste the full Forex Factory monthly page source here."
                  className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 p-3 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  required
                />
              </label>
              <Button type="submit">Import monthly snapshot</Button>
            </form>
            <p className="mt-4 text-sm text-slate-500">
              No red-folder events are stored for this month yet.
            </p>
          </Card>

          <Card title="Remove all for an account">
            <p className="mb-4 text-sm text-slate-400">
              Remove every range subscription for one account. This will also
              delete the related delivery drafts but leave the account itself
              and the journal history intact.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex w-full flex-col gap-1 text-sm text-slate-400 sm:w-72">
                Account
                <select
                  value={removeAccountId}
                  onChange={(e) => setRemoveAccountId(e.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">Select an account</option>
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                variant="danger"
                onClick={handleRemoveAllSubscriptions}
                disabled={!removeAccountId || removing}
                className="whitespace-nowrap"
              >
                {removing ? 'Removing...' : 'Remove all subscriptions'}
              </Button>
            </div>
          </Card>
        </div>

        <div className="order-first space-y-6 lg:order-none">
          <Card title="Subscriptions" className="!p-2 sm:!p-6">
            <p className="mb-4 text-sm text-slate-400">
              Manage which accounts receive each exact range, with
              independent Extension and Broker toggles.
            </p>

            {activeAccounts.length > 0 && (
              <div className="mb-4">
                <div className="flex flex-wrap gap-2 pb-2">
                  {activeAccounts.map((a) => {
                    const selected = selectedAccountIds.has(a.id)
                    return (
                      <label
                        key={a.id}
                        className={`inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                          selected
                            ? 'sub-chip-selected'
                            : 'sub-chip border-slate-600 bg-slate-900 text-slate-300 hover:border-slate-500 hover:bg-slate-800'
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={selected}
                          onChange={(e) => {
                            setSelectedAccountIds((prev) => {
                              const next = new Set(prev)
                              if (e.target.checked) next.add(a.id)
                              else next.delete(a.id)
                              return next
                            })
                          }}
                        />
                        {selected && <span aria-hidden="true" className="sub-chip-check">✓</span>}
                        {a.name}
                      </label>
                    )
                  })}
                </div>
              </div>
            )}

            {dirtyRanges.size > 0 && (
              <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-700 pb-4">
                <span
                  className="line-clamp-2 text-sm text-amber-300"
                  title={[...dirtyRanges].sort().join(', ')}
                >
                  Unsaved changes: {[...dirtyRanges].sort().join(', ')}
                </span>
                <button
                  type="button"
                  onClick={saveSubscriptionChanges}
                  disabled={savingSubscriptions}
                  className="rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-purple-900/20 transition hover:from-blue-500 hover:to-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
                >
                  {savingSubscriptions
                    ? 'Saving...'
                    : 'Save subscription settings'}
                </button>
              </div>
            )}

            {groupedRoutes.length === 0 && (
              <div className="text-sm text-slate-500">
                {selectedAccountIds.size > 0
                  ? 'No subscriptions configured for the selected accounts yet.'
                  : 'No subscriptions configured yet. Use the form on the left to attach a range to any mix of your accounts.'}
              </div>
            )}

            <div className="max-h-[65vh] space-y-4 overflow-y-auto overscroll-contain pr-1">
              {groupedRoutes.map(([rangeName, currentRoutes]) => (
                <div
                  key={rangeName}
                  className="rounded-lg border border-slate-700 bg-slate-900 p-2 sm:p-4"
                >
                  <h3 className="mb-2 break-words font-semibold text-slate-100">
                    {rangeName}
                    {assignments
                      .filter((a) => a.rangeName === rangeName)
                      .map((a) => (
                        <span
                          key={a.subcategoryName}
                          title={`In model ${a.subcategoryName} — Only Scheduled routes follow this model's run days for the range`}
                          className="ml-2 rounded bg-indigo-500/10 px-1.5 py-0.5 text-xs font-normal text-indigo-300"
                        >
                          {a.subcategoryName}
                        </span>
                      ))}
                    {dirtyRanges.has(rangeName) && (
                      <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-normal text-amber-300">
                        unsaved
                      </span>
                    )}
                  </h3>
                  <RouteTable
                    rangeName={rangeName}
                    currentRoutes={currentRoutes}
                    activeAccounts={activeAccounts}
                    selectedAccountIds={selectedAccountIds}
                    saving={savingSubscriptions}
                    updateRoute={updateRoute}
                  />
                </div>
              ))}
            </div>

            {dirtyRanges.size > 0 && (
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-700 pt-4">
                <span
                  className="line-clamp-2 text-sm text-amber-300"
                  title={[...dirtyRanges].sort().join(', ')}
                >
                  Unsaved changes: {[...dirtyRanges].sort().join(', ')}
                </span>
                <button
                  type="button"
                  onClick={saveSubscriptionChanges}
                  disabled={savingSubscriptions}
                  className="rounded-lg bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-purple-900/20 transition hover:from-blue-500 hover:to-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-slate-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
                >
                  {savingSubscriptions
                    ? 'Saving...'
                    : 'Save subscription settings'}
                </button>
              </div>
            )}
          </Card>

          <Card title="Bulk subscriptions">
            <p className="mb-4 text-sm text-slate-400">
              Copy every range subscription and its settings from one account to
              another. This replaces the target account&apos;s existing
              subscriptions.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex w-full flex-col gap-1 text-sm text-slate-400 sm:flex-1">
                Copy from
                <select
                  value={copyFromId}
                  onChange={(e) => setCopyFromId(e.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">Select source account</option>
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex w-full flex-col gap-1 text-sm text-slate-400 sm:flex-1">
                Copy to
                <select
                  value={copyToId}
                  onChange={(e) => setCopyToId(e.target.value)}
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">Select target account</option>
                  {activeAccounts
                    .filter((a) => a.id !== copyFromId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                type="button"
                variant="primary"
                onClick={handleCopySubscriptions}
                disabled={!copyFromId || !copyToId || copyFromId === copyToId || copying}
                className="whitespace-nowrap"
              >
                {copying ? 'Copying...' : 'Copy subscriptions'}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
