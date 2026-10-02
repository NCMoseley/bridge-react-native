import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { PageHeader } from '../components/PageHeader'
import { useToast } from '../context/ToastContext'
import { getJson, postJson } from '../api/client'
import {
  absoluteProtection,
  entryPrice,
  formatDraftAge,
  formatPrice,
  formatProtection,
  formatStrategyStop,
  strategyStopPresentation,
} from '../utils/drafts'
import type { DraftStatus, OrderDraft } from '../types'

const RECENT_DRAFT_LIMIT = 200
const DEFAULT_SINCE_HOURS = 12

const statusStyles: Record<DraftStatus, string> = {
  pending: 'border-amber-500/60 bg-amber-500/10 text-amber-300',
  reviewed: 'border-indigo-500/60 bg-indigo-500/10 text-indigo-300',
  submitted: 'border-positive-500/60 bg-positive-500/10 text-positive-400',
  rejected: 'border-negative-500/60 bg-negative-500/10 text-negative-300',
  expired: 'border-slate-500/60 bg-slate-500/10 text-slate-400',
}

const headingStyles: Record<OrderDraft['action'], string> = {
  buy: 'text-positive-400',
  sell: 'text-negative-300',
  cancel: 'text-amber-300',
}

const copyIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
  </svg>
)

const checkIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-current">
    <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
)

function CopyButton({ value, label }: { value: string; label: string }) {
  const { error } = useToast()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      className={`shrink-0 rounded p-0.5 transition hover:text-slate-200 ${
        copied ? 'text-positive-400' : 'text-slate-500'
      }`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        } catch {
          error('Could not copy to the clipboard.')
        }
      }}
    >
      {copied ? checkIcon : copyIcon}
    </button>
  )
}

function Field({
  label,
  value,
  note,
  copyValue,
}: {
  label: string
  value: string
  note?: string
  copyValue?: string
}) {
  return (
    <div className="min-w-0">
      <span className="block text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <div className="mt-0.5 flex items-center gap-1.5">
        <strong className="break-words text-sm text-slate-100">{value}</strong>
        {copyValue != null && <CopyButton value={copyValue} label={label.toLowerCase()} />}
      </div>
      {note && <small className="mt-0.5 block text-xs text-slate-500">{note}</small>}
    </div>
  )
}

type DraftAction = 'submitted' | 'rejected' | 'reviewed' | 'resend'

function DraftCard({
  draft,
  actionable,
  now,
  onAction,
}: {
  draft: OrderDraft
  actionable: boolean
  now: number
  onAction: (draft: OrderDraft, action: DraftAction) => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (action: DraftAction) => {
    setBusy(action)
    try {
      await onAction(draft, action)
    } catch {
      setBusy(null)
    }
  }

  const heading =
    draft.action === 'cancel'
      ? draft.cancellationMessage ?? 'Cancel opposite entry'
      : `${draft.action.toUpperCase()} ${draft.quantity} ${draft.ticker}${
          draft.rangeName ? ` - ${draft.rangeName}` : ''
        }${draft.orderLeg ? ` (${draft.orderLeg})` : ''}${
          draft.accountName ? ` - ${draft.accountName}` : ''
        }`

  return (
    <article
      className={`space-y-4 rounded-xl border bg-slate-900 p-5 shadow-sm ${
        draft.action === 'cancel' && draft.status === 'pending'
          ? 'border-amber-600/60'
          : 'border-slate-700'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className={`text-lg font-semibold ${headingStyles[draft.action]}`}>
          {heading}
        </h3>
        <span className="flex items-center gap-2">
          {draft.extensionEligible === false && (
            <span
              className="rounded-full border border-slate-600 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-slate-500"
              title="Subscription had extension routing off — not sent to the extension"
            >
              web only
            </span>
          )}
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide ${statusStyles[draft.status]}`}
          >
            {draft.status}
          </span>
        </span>
      </div>

      {draft.action === 'cancel' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <strong className="text-sm text-slate-100 sm:col-span-2">
            Review and cancel the opposite {draft.ticker} entry in Tradovate.
          </strong>
          {draft.accountName && <Field label="Account" value={draft.accountName} />}
        </div>
      ) : (
        <DraftFields draft={draft} />
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>Received {new Date(draft.receivedAt).toLocaleString()}</span>
        {actionable && (
          <strong className="font-medium text-slate-400">
            Age: {formatDraftAge(draft.receivedAt, now)}
          </strong>
        )}
      </div>

      {actionable && (
        <div className="flex flex-wrap gap-2">
          {draft.action === 'cancel' ? (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void act('reviewed')}
            >
              {busy === 'reviewed' ? 'Marking…' : 'Mark reminder handled'}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void act('submitted')}
              >
                {busy === 'submitted' ? 'Marking…' : 'Mark as submitted'}
              </Button>
            </>
          )}
        </div>
      )}

      {!actionable && draft.status !== 'pending' && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void act('resend')}
            title="Return this draft to pending so the extension picks it up again"
          >
            {busy === 'resend' ? 'Resending…' : 'Resend'}
          </Button>
        </div>
      )}
    </article>
  )
}

function DraftFields({ draft }: { draft: OrderDraft }) {
  const strategyStop = strategyStopPresentation(draft)
  const takeProfit = absoluteProtection(draft, 'takeProfit')
  const stopLoss = absoluteProtection(draft, 'stopLoss')
  const entry = entryPrice(draft)
  const fields: Array<{ label: string; value: string; note?: string; copyValue?: string }> = [
    { label: 'Side', value: draft.action.toUpperCase() },
    { label: 'Quantity', value: String(draft.quantity), copyValue: String(draft.quantity) },
    { label: 'Order type', value: draft.orderType.toUpperCase() },
    {
      label: 'Entry',
      value: formatPrice(draft.ticker, entry),
      copyValue: entry != null ? formatPrice(draft.ticker, entry) : undefined,
    },
    { label: 'Account', value: draft.accountName ?? 'Unassigned' },
    {
      label: 'Take profit',
      value: formatProtection(draft, 'takeProfit'),
      copyValue: takeProfit != null ? formatPrice(draft.ticker, takeProfit) : undefined,
    },
    ...(strategyStop
      ? [
          {
            label: strategyStop.label,
            value: formatStrategyStop(draft, strategyStop.price),
            note: 'Informational only — not filled into Tradovate.',
            copyValue: formatPrice(draft.ticker, strategyStop.price),
          },
        ]
      : [
          {
            label: 'Stop loss',
            value: formatProtection(draft, 'stopLoss'),
            copyValue:
              stopLoss != null ? formatPrice(draft.ticker, stopLoss) : undefined,
          },
        ]),
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {fields.map((field) => (
        <Field key={field.label} {...field} />
      ))}
    </div>
  )
}

export function OrderReviewPage() {
  const [pending, setPending] = useState<OrderDraft[] | null>(null)
  const [history, setHistory] = useState<OrderDraft[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [statusIsError, setStatusIsError] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [rangeFilter, setRangeFilter] = useState('all')
  const [accountFilter, setAccountFilter] = useState('all')
  const [sinceHours, setSinceHours] = useState(DEFAULT_SINCE_HOURS)
  const [query, setQuery] = useState('')
  const searchTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!pending?.length) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [pending?.length])

  const load = useCallback(
    async (options?: { since?: number; search?: string }) => {
      const since = options?.since ?? sinceHours
      const search = options?.search ?? query
      setIsLoading(true)
      try {
        const [pendingRes, historyRes] = await Promise.all([
          getJson<{ drafts: OrderDraft[] }>('/api/drafts'),
          getJson<{ drafts: OrderDraft[] }>(
            `/api/drafts/history?limit=${RECENT_DRAFT_LIMIT}&sinceHours=${since}&accountId=all${
              search ? `&query=${encodeURIComponent(search)}` : ''
            }`,
          ),
        ])
        setPending(
          pendingRes.drafts.sort(
            (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
          ),
        )
        setHistory(historyRes.drafts)
        setStatusIsError(false)
        setStatusMessage(
          pendingRes.drafts.length === 0
            ? 'No pending order drafts.'
            : `${pendingRes.drafts.length} order draft(s) require review.`,
        )
      } catch (err) {
        setStatusIsError(true)
        setStatusMessage(err instanceof Error ? err.message : 'Could not load drafts.')
      } finally {
        setIsLoading(false)
      }
    },
    [sinceHours, query],
  )

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [submittingAll, setSubmittingAll] = useState(false)
  const submitAll = useCallback(async () => {
    if (submittingAll || !pending?.length) return
    setSubmittingAll(true)
    try {
      await postJson('/api/drafts/submit-all', {})
      setStatusIsError(false)
      setStatusMessage('All pending drafts marked submitted.')
      await load()
    } catch {
      setStatusIsError(true)
      setStatusMessage('Could not mark all drafts submitted.')
    } finally {
      setSubmittingAll(false)
    }
  }, [submittingAll, pending, load])

  const onAction = useCallback(
    async (draft: OrderDraft, action: DraftAction) => {
      const friendly = {
        submitted: 'Could not mark draft submitted.',
        rejected: 'Could not reject draft.',
        reviewed: 'Could not mark reminder handled.',
        resend: 'Could not resend draft.',
      }[action]
      try {
        await postJson(`/api/drafts/${draft.id}/${action}`, {})
        await load()
      } catch (err) {
        setStatusIsError(true)
        setStatusMessage(friendly)
        throw err
      }
    },
    [load],
  )

  const accountOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const draft of history ?? []) {
      if (draft.accountId && draft.accountName) map.set(draft.accountId, draft.accountName)
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [history])

  const rangeOptions = useMemo(
    () =>
      [...new Set((history ?? []).map((d) => d.rangeName).filter((n): n is string => Boolean(n)))].sort(),
    [history],
  )

  const filteredHistory = useMemo(
    () =>
      (history ?? []).filter(
        (draft) =>
          (accountFilter === 'all' || draft.accountId === accountFilter) &&
          (rangeFilter === 'all' || draft.rangeName === rangeFilter),
      ),
    [history, accountFilter, rangeFilter],
  )

  const historySummary = useMemo(() => {
    const notes = [`Showing the last ${sinceHours} hours.`]
    if (rangeFilter !== 'all') notes.push(`Range: ${rangeFilter}.`)
    if (query) notes.push(`Filter: "${query}".`)
    if (accountFilter !== 'all') {
      notes.push(
        `Account: ${accountOptions.find(([id]) => id === accountFilter)?.[1] ?? accountFilter}.`,
      )
    }
    notes.push(`${filteredHistory.length} result${filteredHistory.length === 1 ? '' : 's'}.`)
    return notes.join(' ')
  }, [sinceHours, rangeFilter, query, accountFilter, accountOptions, filteredHistory.length])

  return (
    <div className="space-y-8 text-slate-100">
      <PageHeader
        title="Order Review"
        subtitle="Incoming Alerts"
        description="Use the extension review page to fill orders with automation in Tradovate"
        onTitleClick={() => void load()}
      >
        {isLoading && (
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-indigo-500" />
        )}
      </PageHeader>

      <p role="status" className={`-mt-4 text-sm ${statusIsError ? 'text-negative-400' : 'text-slate-400'}`}>
        {statusMessage}
      </p>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Fresh orders and reminders</h2>
          {pending !== null && pending.length > 0 && (
            <button
              type="button"
              onClick={() => void submitAll()}
              disabled={submittingAll}
              className="rounded-lg border border-positive-500/60 bg-positive-500/10 px-3 py-1.5 text-sm font-medium text-positive-400 transition-colors hover:bg-positive-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submittingAll ? 'Marking...' : `Mark all as submitted (${pending.length})`}
            </button>
          )}
        </div>
        {pending === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="rounded-xl border border-slate-700 bg-slate-900 p-6 text-center text-sm text-slate-500">
            No pending drafts or reminders right now.
          </p>
        ) : (
          pending.map((draft) => (
            <DraftCard key={draft.id} draft={draft} actionable now={now} onAction={onAction} />
          ))
        )}
      </section>

      <Card
        title="Completed orders and reminders"
        right={
          <span className="text-xs text-slate-500">{historySummary}</span>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-300">Range</span>
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
              value={rangeFilter}
              onChange={(e) => setRangeFilter(e.target.value)}
            >
              <option value="all">All ranges</option>
              {rangeOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-300">Account</span>
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
            >
              <option value="all">All accounts</option>
              {accountOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-300">Since</span>
            <select
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100"
              value={sinceHours}
              onChange={(e) => {
                const next = Number(e.target.value)
                setSinceHours(next)
                void load({ since: next })
              }}
            >
              <option value={12}>12 hours</option>
              <option value={24}>24 hours</option>
              <option value={48}>48 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>1 week</option>
            </select>
          </label>
          <Input
            label="Search"
            type="search"
            maxLength={256}
            placeholder="Range, ticker, action"
            value={query}
            onChange={(e) => {
              const next = e.target.value
              setQuery(next)
              window.clearTimeout(searchTimer.current)
              searchTimer.current = window.setTimeout(() => void load({ search: next }), 150)
            }}
          />
        </div>

        {history === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : filteredHistory.length === 0 ? (
          <p className="rounded-xl border border-slate-700 bg-slate-800 p-6 text-center text-sm text-slate-500">
            No completed drafts match this filter in the last {sinceHours} hours.
          </p>
        ) : (
          <div className="space-y-4">
            {filteredHistory.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                actionable={false}
                now={now}
                onAction={onAction}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
