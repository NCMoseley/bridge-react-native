// Synchronous key-value storage shim matching the web client's localStorage
// usage. Backed by AsyncStorage for persistence across launches: call
// hydrateStorage() once at startup before rendering screens that read cache.
import AsyncStorage from '@react-native-async-storage/async-storage'

const store = new Map<string, string>()
let hydrated = false

export function hydrateStorage(): Promise<void> {
  if (hydrated) return Promise.resolve()
  hydrated = true
  return AsyncStorage.getAllKeys()
    .then((keys) => AsyncStorage.multiGet(keys))
    .then((pairs) => {
      for (const [k, v] of pairs) {
        if (v != null) store.set(k, v)
      }
    })
    .catch(() => {})
}

export const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
    void AsyncStorage.setItem(key, value).catch(() => {})
  },
  removeItem: (key: string) => {
    store.delete(key)
    void AsyncStorage.removeItem(key).catch(() => {})
  },
  get length() {
    return store.size
  },
  key: (index: number) => [...store.keys()][index] ?? null,
}

// localStorage-compatible enumeration for cache-clear loops.
export function storageKeys(): string[] {
  return [...store.keys()]
}
