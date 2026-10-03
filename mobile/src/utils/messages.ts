// In-app message center: every SSE toast is stored here so warnings/errors
// are reviewable later instead of only firing transient phone alerts.
import { emitEvent } from './events'
import { storage } from './storage'

export interface StoredMessage {
  id: string
  ts: number
  type: 'success' | 'error' | 'warning'
  message: string
}

const KEY = 'bridge:messages'
const MAX_MESSAGES = 300
let messages: StoredMessage[] | null = null

function load(): StoredMessage[] {
  if (messages) return messages
  try {
    messages = JSON.parse(storage.getItem(KEY) ?? '[]') as StoredMessage[]
  } catch {
    messages = []
  }
  return messages
}

function persist() {
  try {
    storage.setItem(KEY, JSON.stringify(load().slice(0, MAX_MESSAGES)))
  } catch {}
}

export function getMessages(): StoredMessage[] {
  return [...load()]
}

export function unreadCount(): number {
  const lastSeen = Number(storage.getItem('bridge:messages:seen') ?? 0)
  return load().filter((m) => m.ts > lastSeen).length
}

export function markAllRead(): void {
  const newest = load()[0]
  if (newest) storage.setItem('bridge:messages:seen', String(newest.ts))
  emitEvent('messages:updated')
}

export function addMessage(type: StoredMessage['type'], message: string): void {
  const list = load()
  // Collapse exact repeats within 60s into nothing — keeps CT warning storms
  // from flooding the center the same way they flooded notifications.
  if (list[0] && list[0].message === message && list[0].type === type && Date.now() - list[0].ts < 60_000) {
    return
  }
  list.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), type, message })
  if (list.length > MAX_MESSAGES) list.length = MAX_MESSAGES
  persist()
  emitEvent('messages:updated')
}

export function clearMessages(): void {
  messages = []
  persist()
  emitEvent('messages:updated')
}
