// Synchronous key-value storage shim matching the web client's localStorage
// usage. Currently in-memory — swap the Map for a persistent backend (e.g.
// MMKV or AsyncStorage hydration) if cache persistence across launches is
// needed.
const store = new Map<string, string>()

export const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value)
  },
  removeItem: (key: string) => {
    store.delete(key)
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
