import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/Button'
import { getJson, postForm } from '../api/client'
import { useToast } from '../context/ToastContext'
import {
  getCachedAlerts,
  getPreloadedPage,
  setCachedAlerts,
} from '../utils/alerts-cache'
import type {
  AlertActivityFilter,
  AlertFeedEntry,
  AlertFeedSummary,
  AlertTimeFilter,
} from '../types'

const TIME_OPTIONS: { value: AlertTimeFilter; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: '15m', label: 'Past 15 minutes' },
  { value: '30m', label: 'Past 30 minutes' },
  { value: 'hour', label: 'Past hour' },
  { value: '2h', label: 'Past 2 hours' },
  { value: '4h', label: 'Past 4 hours' },
  { value: '12h', label: 'Past 12 hours' },
  { value: 'day', label: 'Past 24 hours' },
  { value: '3d', label: 'Past 3 days' },
  { value: 'week', label: 'Past 7 days' },
]

const ACTIVITY_OPTIONS: { value: AlertActivityFilter; label: string }[] = [
  { value: 'all', label: 'All activity' },
  { value: 'routed', label: 'Routed only' },
  { value: 'unrouted', label: 'Unrouted only' },
  { value: 'lifecycle', label: 'Lifecycle only' },
  { value: 'traderspost_delivered', label: 'Broker delivered' },
  { value: 'traderspost_failed', label: 'Broker failed' },
]

const PAGE_SIZE = 50

const TIME_MS: Record<AlertTimeFilter, number> = {
  all: Number.POSITIVE_INFINITY,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  hour: 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
}

function describeActivity(alert: AlertFeedEntry): string {
  if (alert.tradeEventCount > 0) {
    return alert.deliveryCount > 0
      ? 'Lifecycle recorded'
      : 'Lifecycle stored'
  }
  if (alert.deliveryCount === 0) return 'Not routed'
  const notes: string[] = []
  if (alert.traderspostDeliveredCount > 0)
    notes.push(`${alert.traderspostDeliveredCount} broker delivered`)
  if (alert.traderspostPendingCount > 0)
    notes.push(`${alert.traderspostPendingCount} broker pending`)
  if (alert.traderspostFailedCount > 0)
    notes.push(`${alert.traderspostFailedCount} broker failed`)
  if (alert.traderspostNotConfiguredCount > 0)
    notes.push(`${alert.traderspostNotConfiguredCount} destination missing`)
  return notes.length
    ? `${alert.deliveryCount} route${alert.deliveryCount === 1 ? '' : 's'} matched · ${notes.join(' · ')}`
    : `${alert.deliveryCount} route${alert.deliveryCount === 1 ? '' : 's'} matched`
}

function statusIcon(alert: AlertFeedEntry): string {
  if (alert.tradeEventCount > 0) return '↻'
  if (alert.deliveryCount === 0) return '⏚'
  if (alert.traderspostFailedCount > 0) return '✕'
  if (alert.traderspostPendingCount > 0) return '⏳'
  if (alert.traderspostDeliveredCount > 0) return '䷧'
  if (alert.traderspostNotConfiguredCount > 0) return '⚠'
  return '↖︎'
}

function statusTone(alert: AlertFeedEntry): string {
  if (alert.tradeEventCount > 0) return 'text-indigo-300'
  if (alert.deliveryCount === 0) return 'text-slate-500'
  if (alert.traderspostFailedCount > 0) return 'text-negative-400'
  if (alert.traderspostPendingCount > 0) return 'text-amber-300'
  if (alert.traderspostDeliveredCount > 0) return 'text-positive'
  if (alert.traderspostNotConfiguredCount > 0) return 'text-amber-300'
  return 'text-positive'
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Etc/GMT+4',
  })
}

function formatPayload(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

interface MetricCardProps {
  label: string
  value: number
  detail: string
}

function MetricCard({ label, value, detail }: MetricCardProps) {
  return (
    <Card title={label}>
      <div className="text-3xl font-bold text-slate-100">{value}</div>
      <div className="text-sm text-slate-400">{detail}</div>
    </Card>
  )
}

export function AlertsPage() {
  const [name, setName] = useState('')
  const [time, setTime] = useState<AlertTimeFilter>('all')
  const [activity, setActivity] = useState<AlertActivityFilter>('all')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)
  const [selectedAlert, setSelectedAlert] = useState<AlertFeedEntry | null>(null)
  const { success, error: showError } = useToast()

  const [serverAlertFeed, setServerAlertFeed] = useState<
    { alerts: AlertFeedEntry[]; totalCount: number } | undefined
  >()
  const [serverAlertRangeNames, setServerAlertRangeNames] = useState<
    string[] | undefined
  >()
  const [serverAlertSummary, setServerAlertSummary] = useState<
    AlertFeedSummary | undefined
  >()

  const emptyAlertSummary: AlertFeedSummary = {
    totalAlerts: 0,
    routedAlerts: 0,
    unroutedAlerts: 0,
    traderspostDeliveredCount: 0,
    traderspostPendingCount: 0,
    traderspostFailedCount: 0,
  }
  const alertFeed = serverAlertFeed ?? { alerts: [], totalCount: 0 }
  const alertRangeNames = serverAlertRangeNames ?? []
  const alertSummary = serverAlertSummary ?? emptyAlertSummary

  const filteredAlerts = useMemo(() => alertFeed.alerts, [serverAlertFeed])

  useEffect(() => {
    setPage(1)
  }, [name, time, activity])

  useEffect(() => {
    const offset = (page - 1) * PAGE_SIZE
    const params = new URLSearchParams()
    if (activity !== 'all') params.set('activity', activity)
    if (name.trim()) params.set('name', name.trim())
    if (time !== 'all') {
      const receivedAfter = new Date(
        Date.now() - TIME_MS[time],
      ).toISOString()
      params.set('receivedAfter', receivedAfter)
    }
    params.set('limit', String(PAGE_SIZE))
    params.set('offset', String(offset))
    const query = params.toString()

    const cached = getCachedAlerts(query)
    if (cached) {
      setServerAlertFeed({
        alerts: cached.alerts,
        totalCount: cached.totalCount,
      })
      setServerAlertRangeNames(cached.rangeNames)
      setServerAlertSummary(cached.summary)
      setLoading(false)
    } else {
      const preloaded =
        !name.trim() && time === 'all' && activity === 'all' && page <= 2
          ? getPreloadedPage(page, PAGE_SIZE)
          : undefined
      if (preloaded) {
        setServerAlertFeed({
          alerts: preloaded.alerts,
          totalCount: preloaded.totalCount,
        })
        setServerAlertRangeNames(preloaded.rangeNames)
        setServerAlertSummary(preloaded.summary)
        setLoading(false)
      } else {
        setLoading(true)
      }
    }

    getJson<{
      alerts: AlertFeedEntry[]
      totalCount: number
      rangeNames: string[]
      summary: AlertFeedSummary
    }>(`/api/alerts${query ? `?${query}` : ''}`)
      .then((data) => {
        setServerAlertFeed({
          alerts: data.alerts,
          totalCount: data.totalCount,
        })
        setServerAlertRangeNames(data.rangeNames)
        setServerAlertSummary(data.summary)
        setCachedAlerts(query, {
          alerts: data.alerts,
          totalCount: data.totalCount,
          rangeNames: data.rangeNames,
          summary: data.summary,
        })
        setLoading(false)
      })
      .catch((error) => {
        console.error('Failed to load alerts from server:', error)
        setLoading(false)
      })
  }, [name, time, activity, page, refreshKey])

  const handleDeleteAlert = (alert: AlertFeedEntry) => {
    const message = `Delete alert for ${alert.rangeName ?? '—'} from ${formatDateTime(alert.receivedAt)}? This will also remove its deliveries.`
    if (!window.confirm(message)) return
    postForm('/alerts/delete', { alertId: alert.alertId })
      .then(() => {
        setSelectedAlert(null)
        setRefreshKey((k) => k + 1)
        success('Alert deleted')
      })
      .catch((error) => {
        console.error('Failed to delete alert:', error)
        showError('Failed to delete alert')
      })
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-slate-400">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-600 border-t-indigo-500" />
        Loading alerts…
      </div>
    )
  }

  return (
    <div className="space-y-8 text-slate-100">
      <PageHeader title="Alert Activity" subtitle="Alert bridge" onTitleClick={() => setRefreshKey((k) => k + 1)} />

      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Received alerts"
          value={alertSummary.totalAlerts}
          detail={"Matching ranges logged"}
        />
        <MetricCard
          label="Extension drafts sent"
          value={alertSummary.routedAlerts}
          detail={`${alertSummary.unroutedAlerts} unrouted`}
        />
        <MetricCard
          label="Broker delivered"
          value={alertSummary.traderspostDeliveredCount}
          detail={`${alertSummary.traderspostFailedCount} failed`}
        />
        {/* <MetricCard
          label="TradersPost failed"
          value={alertSummary.traderspostFailedCount}
          detail="Filter the feed below by name, time, or status"
        /> */}
      </section>

      <section className="grid gap-4 rounded-xl border border-slate-700 bg-slate-800 p-4 md:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Name
          </span>
          <input
            type="text"
            list="alert-range-options"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Breakfast"
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
          {alertRangeNames.length > 0 && (
            <datalist id="alert-range-options">
              {alertRangeNames.map((range) => (
                <option key={range} value={range} />
              ))}
            </datalist>
          )}
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Time
          </span>
          <select
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            value={time}
            onChange={(e) => setTime(e.target.value as AlertTimeFilter)}
          >
            {TIME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-300">
            Activity
          </span>
          <select
            className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            value={activity}
            onChange={(e) => setActivity(e.target.value as AlertActivityFilter)}
          >
            {ACTIVITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <p className="text-slate-400">
            Page {page} of {Math.ceil(alertFeed.totalCount / PAGE_SIZE)} ·
            showing {filteredAlerts.length} of {alertFeed.totalCount} alerts
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPage((p) => p - 1)}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPage((p) => p + 1)}
              disabled={page * PAGE_SIZE >= alertFeed.totalCount}
            >
              Next
            </Button>
          </div>
        </div>
        <div className="-mx-4 overflow-x-auto border-y border-slate-700 bg-slate-800 sm:-mx-0 sm:rounded-xl sm:border">
          <table className="w-full text-left text-[10px] sm:text-sm">
            <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-1.5 py-1.5 sm:px-4 sm:py-3">Received</th>
                <th className="px-1.5 py-1.5 sm:px-4 sm:py-3">Range</th>
                <th className="px-1.5 py-1.5 sm:px-4 sm:py-3">Action</th>
                <th className="hidden px-1.5 py-1.5 sm:table-cell sm:px-4 sm:py-3">Ticker</th>
                <th className="px-1.5 py-1.5 sm:px-4 sm:py-3">Status</th>
                <th className="px-1.5 py-1.5 sm:px-4 sm:py-3">Payload</th>
                <th className="px-1.5 py-1.5 sm:px-4 sm:py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {filteredAlerts.length ? (
                filteredAlerts.map((alert) => (
                  <tr key={alert.alertId}>
                    <td className="px-1.5 py-1.5 sm:px-4 sm:py-3 text-slate-200">
                      {formatDateTime(alert.receivedAt)}
                    </td>
                    <td className="px-1.5 py-1.5 sm:px-4 sm:py-3 text-slate-200">
                      {alert.rangeName ?? '—'}
                    </td>
                    <td className="px-1.5 py-1.5 sm:px-4 sm:py-3 text-slate-200 text-center">
                      {alert.action}
                    </td>
                    <td className="hidden px-1.5 py-1.5 text-slate-200 sm:table-cell sm:px-4 sm:py-3">
                      {alert.ticker}
                    </td>
                    <td className="px-1.5 py-1.5 text-center sm:px-4 sm:py-3 sm:text-left">
                      {alert.currentUserLinked ? (
                        <>
                          <span className={`text-base font-semibold sm:mr-2 ${statusTone(alert)}`}>
                            {statusIcon(alert)}
                          </span>
                          <span className="hidden flex-wrap items-center justify-center rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-slate-100 sm:px-2 sm:text-xs sm:inline-flex">
                            {describeActivity(alert)}
                          </span>
                        </>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1.5 sm:px-4 sm:py-3">
                      <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          className="!px-1.5 !py-0.5 !text-[10px] sm:!px-2 sm:!py-1 sm:!text-sm"
                          onClick={() => setSelectedAlert(alert)}
                        >
                          JSON
                        </Button>
                      </div>
                    </td>
                     <td className="px-1.5 py-1.5 sm:px-4 sm:py-3">
                      <div className="flex flex-col gap-1 sm:flex-row sm:gap-2">
                         <Button
                          type="button"
                          variant="ghost"
                          className="!px-1.5 !py-0.5 !text-[10px] sm:!px-2 sm:!py-1 sm:!text-sm"
                          onClick={() => handleDeleteAlert(alert)}
                        >
                          X
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-slate-400"
                  >
                    No alerts match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedAlert && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card
            title={`Alert from ${formatDateTime(selectedAlert.receivedAt)}`}
            className="w-full max-w-3xl"
          >
            <pre className="max-h-[70vh] overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-200">
              {formatPayload(selectedAlert.payloadJson)}
            </pre>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="danger"
                onClick={() => handleDeleteAlert(selectedAlert)}
              >
                Delete
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSelectedAlert(null)}>
                Close
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}
