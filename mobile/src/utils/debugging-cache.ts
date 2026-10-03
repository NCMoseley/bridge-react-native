import { storage } from './storage'
import type { DebuggingData } from '../types'

const CACHE_KEY = 'bridge:debugging'

export function getCachedDebugging(): DebuggingData | undefined {
  try {
    const raw = storage.getItem(CACHE_KEY)
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
    storage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch {
    // ignore
  }
}

export function clearDebuggingCache(): void {
  try {
    storage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}
