import { API_BASE } from '../config'
import { emitEvent } from '../utils/events'

let cachedCsrfToken: string | null = null

export async function fetchCsrfToken(): Promise<string> {
  if (cachedCsrfToken) return cachedCsrfToken
  const res = await fetch(`${API_BASE}/api/session`, { credentials: 'include' })
  if (!res.ok) throw new Error('Unable to fetch session token. Are you logged in?')
  const data = (await res.json()) as { csrfToken: string }
  cachedCsrfToken = data.csrfToken
  return data.csrfToken
}

export function clearCsrfToken() {
  cachedCsrfToken = null
}

async function failureReason(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  } catch {}
  return body
}

async function failRequest(action: string, res: Response): Promise<never> {
  const reason = await failureReason(res)
  const err = new Error(`POST ${action} failed: ${res.status} ${reason}`)
  ;(err as Error & { reason?: string }).reason = reason || undefined
  throw err
}

export async function postForm(
  action: string,
  fields: Record<string, string | string[] | undefined>,
) {
  const buildBody = (csrfToken: string) => {
    const params = new URLSearchParams()
    params.append('csrfToken', csrfToken)
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      if (Array.isArray(value)) {
        for (const item of value) params.append(key, item)
      } else {
        params.append(key, value)
      }
    }
    return params.toString()
  }
  const send = (csrfToken: string) =>
    fetch(`${API_BASE}${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: buildBody(csrfToken),
    })
  let res = await send(await fetchCsrfToken())
  if (res.status === 403) {
    clearCsrfToken()
    res = await send(await fetchCsrfToken())
  }
  if (!res.ok) await failRequest(action, res)
  emitEvent('api:success')
  return res
}

export async function postJson(action: string, body: Record<string, unknown>) {
  const send = (csrfToken: string) =>
    fetch(`${API_BASE}${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ...body, csrfToken }),
    })
  let res = await send(await fetchCsrfToken())
  if (res.status === 403) {
    clearCsrfToken()
    res = await send(await fetchCsrfToken())
  }
  if (!res.ok) await failRequest(action, res)
  emitEvent('api:success')
  return res
}

export async function getJson<T = unknown>(action: string): Promise<T> {
  const res = await fetch(`${API_BASE}${action}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`GET ${action} failed: ${res.status} ${text}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  return res.json() as Promise<T>
}
