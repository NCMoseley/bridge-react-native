import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { getJson, postForm, postJson } from '../api/client'
import { useToast } from '../context/ToastContext'
import {
  Button,
  Card,
  Field,
  Input,
  SelectPicker,
  colors,
} from '../components/ui'
import { monthRangeFromHtml } from '../utils/forex-factory'
import { isAlertSoundEnabled, setAlertSoundEnabled } from '../utils/alertSound'
import { getCachedSettings, setCachedSettings } from '../utils/settings-cache'
import type {
  BridgeAccount,
  RangeRoute,
  RangeSubcategory,
  RangeSubcategoryAssignment,
} from '../types'

interface RouteEdit {
  id: string
  rangeName: string
  accountId: string
  accountName: string
  extensionEnabled: boolean
  traderspostEnabled: boolean
  runScheduled: boolean
}

interface SettingsResponse {
  accounts: BridgeAccount[]
  rangeRoutes: RangeRoute[]
  rangeNames: string[]
  rangeSubcategories: RangeSubcategory[]
  rangeSubcategoryAssignments: RangeSubcategoryAssignment[]
  extensionToken: string
  extensionVersion: string
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

function Check({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={[styles.checkbox, checked && styles.checkboxOn, disabled && { opacity: 0.5 }]}
    >
      {checked ? <Text style={styles.checkboxMark}>✓</Text> : null}
    </Pressable>
  )
}

function CheckLabel({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Pressable onPress={() => onChange(!checked)} style={styles.checkRow}>
      <Check checked={checked} onChange={onChange} />
      <Text style={styles.dim}>{label}</Text>
    </Pressable>
  )
}

function RouteTable({
  rangeName,
  currentRoutes,
  activeAccounts,
  selectedAccountIds,
  saving,
  updateRoute,
}: {
  rangeName: string
  currentRoutes: RouteEdit[]
  activeAccounts: BridgeAccount[]
  selectedAccountIds: Set<string>
  saving?: boolean
  updateRoute: (rangeName: string, accountId: string, extension: boolean, traderspost: boolean, runScheduled: boolean) => void
}) {
  const currentByAccount = new Map(currentRoutes.map((r) => [r.accountId, r]))
  const displayAccounts =
    selectedAccountIds.size > 0 ? activeAccounts.filter((a) => selectedAccountIds.has(a.id)) : activeAccounts
  return (
    <View>
      <View style={styles.routeHeader}>
        <Text style={[styles.dimSmall, { flex: 1 }]}>Account</Text>
        <Text style={[styles.dimSmall, styles.col]}>Ext</Text>
        <Text style={[styles.dimSmall, styles.col]}>Broker</Text>
        <Text style={[styles.dimSmall, styles.col]}>Sched</Text>
      </View>
      {displayAccounts.map((account) => {
        const route = currentByAccount.get(account.id)
        const extension = route?.extensionEnabled ?? false
        const traderspost = route?.traderspostEnabled ?? false
        const runScheduled = route?.runScheduled ?? false
        return (
          <View key={account.id} style={styles.routeRow}>
            <Text style={[styles.routeAccount, { flex: 1 }]} numberOfLines={1}>
              {account.name}
              {route?.runScheduled ? ' 📅' : ''}
            </Text>
            <View style={styles.col}>
              <Check
                disabled={saving}
                checked={extension}
                onChange={(v) => updateRoute(rangeName, account.id, v, traderspost, runScheduled)}
              />
            </View>
            <View style={styles.col}>
              <Check
                disabled={saving}
                checked={traderspost}
                onChange={(v) => updateRoute(rangeName, account.id, extension, v, runScheduled)}
              />
            </View>
            <View style={styles.col}>
              <Check
                disabled={saving}
                checked={runScheduled}
                onChange={(v) => updateRoute(rangeName, account.id, extension, traderspost, v)}
              />
            </View>
          </View>
        )
      })}
    </View>
  )
}

function ModelSubscribeForm({
  accounts,
  subcategories,
  assignments,
  onSubscribed,
}: {
  accounts: BridgeAccount[]
  subcategories: RangeSubcategory[]
  assignments: RangeSubcategoryAssignment[]
  onSubscribed: () => void
}) {
  const { success, error } = useToast()
  const [subcategoryName, setSubcategoryName] = useState(subcategories[0]?.name ?? '')
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
      .catch(() => error('Failed to subscribe to model'))
      .finally(() => setSubscribing(false))
  }

  return (
    <View>
      <Text style={[styles.dim, { marginBottom: 8 }]}>
        Subscribe an account to every range currently assigned to a model.
        {rangeCount > 0 ? ` This will create ${rangeCount} new route${rangeCount === 1 ? '' : 's'}.` : ''}
      </Text>
      <SelectPicker
        label="Model"
        options={subcategories.map((s) => ({ value: s.name, label: s.name }))}
        value={subcategoryName}
        onChange={setSubcategoryName}
      />
      <View style={{ height: 8 }} />
      <SelectPicker
        label="Account"
        options={[
          { value: '', label: 'Select an account' },
          ...accounts.map((a) => ({ value: a.id, label: a.name })),
        ]}
        value={accountId}
        onChange={setAccountId}
      />
      <View style={{ flexDirection: 'row', gap: 14, marginVertical: 8 }}>
        <CheckLabel label="Extension" checked={extensionEnabled} onChange={setExtensionEnabled} />
        <CheckLabel label="Broker" checked={traderspostEnabled} onChange={setTraderspostEnabled} />
        <CheckLabel label="Only scheduled" checked={runScheduled} onChange={setRunScheduled} />
      </View>
      <Button
        small
        title={subscribing ? 'Subscribing...' : 'Subscribe'}
        disabled={!subcategoryName || !accountId || subscribing}
        onPress={handleSubscribe}
      />
    </View>
  )
}

export default function SettingsScreen() {
  const cached = getCachedSettings()
  const [accounts, setAccounts] = useState<BridgeAccount[]>(cached?.accounts ?? [])
  const [rangeNames, setRangeNames] = useState<string[]>(cached?.rangeNames ?? [])
  const [subcategories, setSubcategories] = useState<RangeSubcategory[]>(cached?.rangeSubcategories ?? [])
  const [assignments, setAssignments] = useState<RangeSubcategoryAssignment[]>(cached?.rangeSubcategoryAssignments ?? [])
  const [routes, setRoutes] = useState<RouteEdit[]>(buildRoutes(cached?.rangeRoutes ?? [], cached?.accounts ?? []))
  const [, setFetching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [alertSound, setAlertSound] = useState(isAlertSoundEnabled())
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [savingSubscriptions, setSavingSubscriptions] = useState(false)
  const [dirtyRanges, setDirtyRanges] = useState<Set<string>>(new Set())
  const dirtyRangesRef = useRef<Set<string>>(new Set())
  const [forexHtml, setForexHtml] = useState('')
  const [extensionToken, setExtensionToken] = useState<string | undefined>(cached?.extensionToken)
  const [extensionVersion, setExtensionVersion] = useState<string | undefined>(cached?.extensionVersion)
  const { success, error } = useToast()

  const [newRange, setNewRange] = useState('')
  const [newExtension, setNewExtension] = useState<Set<string>>(new Set())
  const [newTraderspost, setNewTraderspost] = useState<Set<string>>(new Set())
  const [newRunScheduled, setNewRunScheduled] = useState<Set<string>>(new Set())
  const [removeAccountId, setRemoveAccountId] = useState('')
  const [removing, setRemoving] = useState(false)
  const [copyFromId, setCopyFromId] = useState('')
  const [copyToId, setCopyToId] = useState('')
  const [copying, setCopying] = useState(false)

  const activeAccounts = useMemo(() => accounts.filter((a) => !a.deprecated), [accounts])
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])

  const load = useCallback(
    (preserveLocalEdits = false) => {
      setFetching(true)
      return getJson<SettingsResponse>('/api/settings')
        .then(({ accounts, rangeRoutes, rangeNames, rangeSubcategories, rangeSubcategoryAssignments, extensionToken, extensionVersion }) => {
          setAccounts(accounts)
          setRangeNames(rangeNames)
          setSubcategories(rangeSubcategories)
          setAssignments(rangeSubcategoryAssignments)
          setRoutes((current) => {
            const serverRoutes = buildRoutes(rangeRoutes, accounts)
            const dirty = preserveLocalEdits ? dirtyRangesRef.current : new Set<string>()
            if (dirty.size === 0) return serverRoutes
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
          setCachedSettings({
            accounts,
            rangeRoutes,
            rangeNames,
            rangeSubcategories,
            rangeSubcategoryAssignments,
            extensionToken,
            extensionVersion,
          })
        })
        .catch(() => error('Failed to load settings'))
        .finally(() => {
          setFetching(false)
          setRefreshing(false)
        })
    },
    [error],
  )

  useEffect(() => {
    void load()
  }, [])

  const groupedRoutes = useMemo(() => {
    const activeRoutes = routes.filter((r) => !accountById.get(r.accountId)?.deprecated)
    const filtered =
      selectedAccountIds.size > 0 ? activeRoutes.filter((r) => selectedAccountIds.has(r.accountId)) : activeRoutes
    const byRange = new Map<string, RouteEdit[]>()
    for (const route of filtered) {
      if (!route.extensionEnabled && !route.traderspostEnabled && !dirtyRanges.has(route.rangeName)) continue
      const list = byRange.get(route.rangeName) ?? []
      list.push(route)
      byRange.set(route.rangeName, list)
    }
    return [...byRange.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [routes, selectedAccountIds, accountById, dirtyRanges])

  const syncRange = (rangeName: string, next: RouteEdit[]) => {
    const rangeRoutes = next.filter((r) => r.rangeName === rangeName)
    const extensionAccountIds = rangeRoutes.filter((r) => r.extensionEnabled).map((r) => r.accountId)
    const traderspostAccountIds = rangeRoutes.filter((r) => r.traderspostEnabled).map((r) => r.accountId)
    const selectedIds = new Set([...extensionAccountIds, ...traderspostAccountIds])
    const runScheduledAccountIds = rangeRoutes
      .filter((r) => r.runScheduled && selectedIds.has(r.accountId))
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
    const index = next.findIndex((r) => r.rangeName === rangeName && r.accountId === accountId)
    if (index >= 0) {
      next[index] = { ...next[index], extensionEnabled: extension, traderspostEnabled: traderspost, runScheduled }
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
      success(`Subscription settings saved for ${pending.length} range${pending.length === 1 ? '' : 's'}`)
    } catch {
      error('Failed to save subscription settings')
    } finally {
      setSavingSubscriptions(false)
    }
  }

  const saveNewSubscription = () => {
    if (!newRange.trim()) return
    const name = newRange.trim()
    Alert.alert('Save subscription', `Save subscription for ${name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Save',
        onPress: () => {
          void (async () => {
            const extensionAccountIds = activeAccounts.filter((a) => newExtension.has(a.id)).map((a) => a.id)
            const traderspostAccountIds = activeAccounts.filter((a) => newTraderspost.has(a.id)).map((a) => a.id)
            const selectedIds = new Set([...extensionAccountIds, ...traderspostAccountIds])
            const runScheduledAccountIds = activeAccounts
              .filter((a) => newRunScheduled.has(a.id) && selectedIds.has(a.id))
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
              void load(true)
              success(`Subscription for ${name} saved`)
            } catch (err) {
              error(err instanceof Error ? err.message : 'Failed to save subscription')
            }
          })()
        },
      },
    ])
  }

  const handleRemoveAllSubscriptions = () => {
    if (!removeAccountId) return
    const account = accountById.get(removeAccountId)
    Alert.alert('Remove subscriptions', `Remove all subscriptions for ${account?.name ?? 'this account'}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          setRemoving(true)
          postForm('/account/subscriptions/remove', { accountId: removeAccountId })
            .then((res) => res.json() as Promise<{ removed: number }>)
            .then(({ removed }) => {
              setRemoveAccountId('')
              void load(true)
              success(`Removed ${removed} subscription${removed === 1 ? '' : 's'}`)
            })
            .catch(() => error('Failed to remove subscriptions'))
            .finally(() => setRemoving(false))
        },
      },
    ])
  }

  const handleCopySubscriptions = () => {
    if (!copyFromId || !copyToId || copyFromId === copyToId) return
    const from = accountById.get(copyFromId)
    const to = accountById.get(copyToId)
    Alert.alert(
      'Copy subscriptions',
      `Copy all subscriptions from ${from?.name ?? 'source'} to ${to?.name ?? 'target'}? This replaces every existing subscription on ${to?.name ?? 'the target account'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Copy',
          onPress: () => {
            setCopying(true)
            postForm('/account/subscriptions/copy', { fromAccountId: copyFromId, toAccountId: copyToId })
              .then((res) => res.json() as Promise<{ copied: number; removed: number }>)
              .then(({ copied, removed }) => {
                setCopyFromId('')
                setCopyToId('')
                void load(true)
                success(
                  `Copied ${copied} subscription${copied === 1 ? '' : 's'} to ${to?.name ?? 'account'}` +
                    (removed > 0 ? ` (replaced ${removed})` : ''),
                )
              })
              .catch(() => error('Failed to copy subscriptions'))
              .finally(() => setCopying(false))
          },
        },
      ],
    )
  }

  const handleForexImport = () => {
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
      .catch(() => error('Failed to import snapshot'))
  }

  const accountOptions = [
    { value: '', label: 'Select an account' },
    ...activeAccounts.map((a) => ({ value: a.id, label: a.name })),
  ]

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true)
            void load()
          }}
          tintColor={colors.accent}
        />
      }
    >
      <Card title="Model subscriptions">
        <ModelSubscribeForm
          accounts={activeAccounts}
          subcategories={subcategories}
          assignments={assignments}
          onSubscribed={() => void load()}
        />
      </Card>

      <Card title="Single range subscription">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Type an exact tracked range name, then check Extension and/or Broker for every account that should use it. Turn on Run Scheduled to only use this route on days the range runs.
        </Text>
        <Field label="Range name">
          <Input value={newRange} onChangeText={setNewRange} placeholder="Opening Range" />
        </Field>
        {rangeNames.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
              {rangeNames.slice(0, 16).map((n) => (
                <Pressable key={n} onPress={() => setNewRange(n)} style={styles.chip}>
                  <Text style={styles.chipText}>{n}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        ) : null}
        <RouteTable
          rangeName={newRange}
          currentRoutes={[]}
          activeAccounts={activeAccounts}
          selectedAccountIds={new Set()}
          updateRoute={(_r, accountId, extension, traderspost, runScheduled) => {
            setNewExtension((prev) => {
              const next = new Set(prev)
              if (extension) next.add(accountId)
              else next.delete(accountId)
              return next
            })
            setNewTraderspost((prev) => {
              const next = new Set(prev)
              if (traderspost) next.add(accountId)
              else next.delete(accountId)
              return next
            })
            setNewRunScheduled((prev) => {
              const next = new Set(prev)
              if (runScheduled) next.add(accountId)
              else next.delete(accountId)
              return next
            })
          }}
        />
        <Button small title="Save subscription" disabled={!newRange.trim()} onPress={saveNewSubscription} style={{ marginTop: 8 }} />
      </Card>

      <Card title="Subscriptions">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Manage which accounts receive each exact range, with independent Extension and Broker toggles.
        </Text>
        {activeAccounts.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {activeAccounts.map((a) => {
              const selected = selectedAccountIds.has(a.id)
              return (
                <Pressable
                  key={a.id}
                  onPress={() =>
                    setSelectedAccountIds((prev) => {
                      const next = new Set(prev)
                      if (selected) next.delete(a.id)
                      else next.add(a.id)
                      return next
                    })
                  }
                  style={[styles.chip, selected && styles.chipActive]}
                >
                  <Text style={[styles.chipText, selected && { color: '#a5b4fc' }]}>
                    {selected ? '✓ ' : ''}
                    {a.name}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        ) : null}
        {dirtyRanges.size > 0 ? (
          <View style={styles.unsavedBar}>
            <Text style={[styles.dim, { color: colors.amber, flex: 1 }]} numberOfLines={2}>
              Unsaved changes: {[...dirtyRanges].sort().join(', ')}
            </Text>
            <Button
              small
              title={savingSubscriptions ? 'Saving...' : 'Save subscription settings'}
              disabled={savingSubscriptions}
              onPress={() => void saveSubscriptionChanges()}
            />
          </View>
        ) : null}
        {groupedRoutes.length === 0 ? (
          <Text style={styles.dim}>
            {selectedAccountIds.size > 0
              ? 'No subscriptions configured for the selected accounts yet.'
              : 'No subscriptions configured yet. Use the form above to attach a range to any mix of your accounts.'}
          </Text>
        ) : (
          groupedRoutes.map(([rangeName, currentRoutes]) => (
            <View key={rangeName} style={styles.rangeCard}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <Text style={styles.value}>{rangeName}</Text>
                {assignments
                  .filter((a) => a.rangeName === rangeName)
                  .map((a) => (
                    <View key={a.subcategoryName} style={styles.modelBadge}>
                      <Text style={styles.modelBadgeText}>{a.subcategoryName}</Text>
                    </View>
                  ))}
                {dirtyRanges.has(rangeName) ? (
                  <View style={styles.unsavedBadge}>
                    <Text style={{ color: colors.amber, fontSize: 10 }}>unsaved</Text>
                  </View>
                ) : null}
              </View>
              <RouteTable
                rangeName={rangeName}
                currentRoutes={currentRoutes}
                activeAccounts={activeAccounts}
                selectedAccountIds={selectedAccountIds}
                saving={savingSubscriptions}
                updateRoute={updateRoute}
              />
            </View>
          ))
        )}
        {dirtyRanges.size > 0 ? (
          <View style={[styles.unsavedBar, { marginTop: 8 }]}>
            <Button
              small
              title={savingSubscriptions ? 'Saving...' : 'Save subscription settings'}
              disabled={savingSubscriptions}
              onPress={() => void saveSubscriptionChanges()}
            />
          </View>
        ) : null}
      </Card>

      <Card title="Bulk subscriptions">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Copy every range subscription and its settings from one account to another. This replaces the target account&rsquo;s existing subscriptions.
        </Text>
        <SelectPicker label="Copy from" options={accountOptions} value={copyFromId} onChange={setCopyFromId} />
        <View style={{ height: 8 }} />
        <SelectPicker label="Copy to" options={accountOptions} value={copyToId} onChange={setCopyToId} />
        <View style={{ height: 8 }} />
        <Button
          small
          title={copying ? 'Copying...' : 'Copy subscriptions'}
          disabled={!copyFromId || !copyToId || copyFromId === copyToId || copying}
          onPress={handleCopySubscriptions}
        />
      </Card>

      <Card title="Alert sound">
        <CheckLabel
          label="Play a haptic alert when new alerts arrive."
          checked={alertSound}
          onChange={(v) => {
            setAlertSound(v)
            setAlertSoundEnabled(v)
            success(`Alert sound ${v ? 'enabled' : 'disabled'}`)
          }}
        />
        <Text style={[styles.dim, { marginTop: 6 }]}>Current sound: {alertSound ? 'On' : 'Off'}.</Text>
      </Card>

      <Card title="Extension download">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Download the latest browser extension zip{extensionVersion ? ` (v${extensionVersion})` : ''} from the web app for this user, then load it into the browser profile that uses this bridge connection.
        </Text>
        <Text style={[styles.dim, { marginBottom: 4 }]}>Extension token</Text>
        {extensionToken ? (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={[styles.dimSmall, { flex: 1 }]} selectable numberOfLines={2}>
              {extensionToken}
            </Text>
            <Button
              small
              variant="ghost"
              title="Copy"
              onPress={() => {
                void Clipboard.setStringAsync(extensionToken).then(() => success('Token copied'))
              }}
            />
          </View>
        ) : (
          <Text style={styles.dim}>No token available.</Text>
        )}
      </Card>

      <Card title="Forex Factory month import">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Import the current Forex Factory month to see red-folder events. Open the Bridge extension popup and click Import current Forex month, or paste the monthly page source below.
        </Text>
        <Field label="Monthly page source">
          <Input
            value={forexHtml}
            onChangeText={setForexHtml}
            placeholder="Paste the full Forex Factory monthly page source here."
            multiline
            numberOfLines={5}
            style={{ minHeight: 100, textAlignVertical: 'top' }}
          />
        </Field>
        <Button small title="Import monthly snapshot" onPress={handleForexImport} />
      </Card>

      <Card title="Remove all for an account">
        <Text style={[styles.dim, { marginBottom: 8 }]}>
          Remove every range subscription for one account. This will also delete the related delivery drafts but leave the account itself and the journal history intact.
        </Text>
        <SelectPicker label="Account" options={accountOptions} value={removeAccountId} onChange={setRemoveAccountId} />
        <View style={{ height: 8 }} />
        <Button
          small
          variant="danger"
          title={removing ? 'Removing...' : 'Remove all subscriptions'}
          disabled={!removeAccountId || removing}
          onPress={handleRemoveAllSubscriptions}
        />
      </Card>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  checkRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  checkbox: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 4,
    borderWidth: 1,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  checkboxMark: { color: '#fff', fontSize: 12, fontWeight: '700' },
  checkboxOn: { backgroundColor: '#6366f1', borderColor: '#6366f1' },
  chip: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: 'rgba(99,102,241,0.12)', borderColor: '#6366f1' },
  chipText: { color: colors.muted, fontSize: 12 },
  col: { alignItems: 'center', width: 52 },
  container: { backgroundColor: colors.bg, flex: 1 },
  dim: { color: colors.muted, fontSize: 12 },
  dimSmall: { color: colors.faint, fontSize: 11 },
  modelBadge: {
    backgroundColor: 'rgba(99,102,241,0.12)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  modelBadgeText: { color: '#a5b4fc', fontSize: 10 },
  rangeCard: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 10,
    padding: 10,
  },
  routeAccount: { color: colors.text, fontSize: 13 },
  routeHeader: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingVertical: 6,
  },
  routeRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    paddingVertical: 8,
  },
  unsavedBadge: {
    backgroundColor: 'rgba(251,191,36,0.15)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  unsavedBar: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
    paddingTop: 10,
  },
  value: { color: colors.text, fontSize: 14, fontWeight: '700' },
})
