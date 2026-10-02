import { useCallback, useEffect, useState } from 'react'
import { CollapsibleSection } from './CollapsibleSection'
import { Button } from './Button'
import { getJson } from '../api/client'
import { JOURNAL_TIME_ZONE } from '../utils/format'

interface EmailLog {
  id: string
  timestamp: string
  subject?: string
  from?: string
  to?: string | null
  body?: string
  errorText?: string
  ticker?: string | null
  accountName?: string
  bracketId?: string | null
  attributedBy?: string | null
  matchedOrders?: string[]
  success?: boolean
  unattributed?: boolean
  notFailure?: boolean
  ambiguous?: boolean
  senderTrusted?: boolean
}

export function EmailIngestCard() {
  const [emails, setEmails] = useState<EmailLog[]>([])
  const [loading, setLoading] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [hours, setHours] = useState(4)

  const load = useCallback(() => {
    setLoading(true)
    getJson<{ logs: Array<{ id: string; category: string; timestamp: string; data: Record<string, unknown> }> }>(
      `/api/bridge-logs?hours=${hours}&category=email`,
    )
      .then((res) => {
        setEmails(
          res.logs.map((log) => ({
            ...(log.data as unknown as EmailLog),
            id: log.id,
            timestamp: String(log.data.timestamp ?? log.timestamp),
          })),
        )
      })
      .catch((err) => console.error('Failed to load ingested emails:', err))
      .finally(() => setLoading(false))
  }, [hours])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent<Record<string, unknown>>).detail
      if (!data || data.category !== 'email') return
      setEmails((prev) =>
        [{ ...(data as unknown as EmailLog), id: String(data.id ?? `live-${Date.now()}`) }, ...prev].slice(0, 100),
      )
    }
    window.addEventListener('bridge:log', handler)
    return () => window.removeEventListener('bridge:log', handler)
  }, [])

  return (
    <CollapsibleSection
      className="rounded-xl border border-slate-700 bg-slate-900 lg:col-span-2"
      storageKey="monitoring:emailIngest:open"
      title={
        <h3 className="text-lg font-semibold text-slate-100">
          Ingested emails{emails.length > 0 ? ` (${emails.length})` : ''}
        </h3>
      }
      actions={
        <Button type="button" variant="ghost" className="px-2 py-1" onClick={load} disabled={loading}>
          <span className={loading ? 'inline-block animate-spin' : ''}>↻</span>
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-400">Hours</label>
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value={1}>1 hour</option>
            <option value={4}>4 hours</option>
            <option value={12}>12 hours</option>
            <option value={24}>24 hours</option>
            <option value={48}>48 hours</option>
          </select>
        </div>
      </div>
      {emails.length === 0 ? (
        <p className="text-sm text-slate-400">No ingested emails in the selected window.</p>
      ) : (
      <div className="space-y-2 text-xs">
          {emails.map((mail) => {
            const matched = Array.isArray(mail.matchedOrders) ? mail.matchedOrders.length : 0
            const open = openId === mail.id
            return (
              <div
                key={mail.id}
                className={`rounded border p-2 ${
                  mail.unattributed || mail.ambiguous
                    ? 'border-amber-600/40 bg-amber-900/20'
                    : matched > 0
                      ? 'border-negative-600/40 bg-negative-900/20'
                      : 'border-slate-600/40 bg-slate-900/20'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 font-mono text-slate-200">
                  <span className="text-slate-400">
                    {new Date(String(mail.timestamp)).toLocaleString('en-US', {
                      timeZone: JOURNAL_TIME_ZONE,
                    })}
                  </span>
                  <span className="rounded bg-negative-600/30 px-1.5 py-0.5 font-semibold text-negative-100">
                    MAIL
                  </span>
                  <span className="font-bold text-slate-100">
                    {mail.subject ?? 'TradersPost email'}
                  </span>
                  <span className="text-slate-500">
                    {[mail.accountName, mail.ticker].filter(Boolean).join(' · ')}
                  </span>
                  <span className="text-slate-500">
                    {mail.unattributed
                      ? 'unattributed'
                      : mail.notFailure
                        ? 'stored (not a failure)'
                        : mail.ambiguous
                          ? 'ambiguous — review'
                          : `${matched} order${matched === 1 ? '' : 's'} rejected`}
                    {mail.senderTrusted === false ? ' · untrusted sender' : ''}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="ml-auto px-2 py-0.5"
                    onClick={() => setOpenId(open ? null : mail.id)}
                  >
                    {open ? 'Hide' : 'View'}
                  </Button>
                </div>
                {open && (
                  <div className="mt-2 space-y-1">
                    <div className="text-slate-400">
                      <div>From: {mail.from ?? '-'}</div>
                      <div>To: {mail.to ?? '-'}</div>
                      <div>Subject: {mail.subject ?? '-'}</div>
                      {mail.bracketId && <div>Bracket: {mail.bracketId}</div>}
                      {mail.attributedBy && <div>Attributed by: {mail.attributedBy}</div>}
                    </div>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[10px] text-slate-300">
                      {mail.body ?? mail.errorText ?? 'No body captured'}
                    </pre>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </CollapsibleSection>
  )
}
