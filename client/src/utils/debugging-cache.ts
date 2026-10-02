import type { DebuggingData } from '../pages/Debugging'

const CACHE_KEY = 'bridge:debugging'

export function getCachedDebugging(): DebuggingData | undefined {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as DebuggingData
    if (Array.isArray(parsed.accounts) && Array.isArray(parsed.rangeConfigurations)) {
      return parsed
    }
  } catch {
    // ignore
  }
  return undefined
}

export function setCachedDebugging(data: DebuggingData): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function clearDebuggingCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}
