// Minimal event emitter replacing the web client's window CustomEvent bus
// ('api:success', 'api:error', 'journal:refresh', 'bridge:log').
type Handler = (detail?: unknown) => void

const handlers = new Map<string, Set<Handler>>()

export function onEvent(name: string, handler: Handler): () => void {
  let set = handlers.get(name)
  if (!set) {
    set = new Set()
    handlers.set(name, set)
  }
  set.add(handler)
  return () => {
    set!.delete(handler)
  }
}

export function emitEvent(name: string, detail?: unknown): void {
  handlers.get(name)?.forEach((h) => {
    try {
      h(detail)
    } catch {
      // ignore listener errors
    }
  })
}
