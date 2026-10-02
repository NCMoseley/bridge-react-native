import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { playAlertBeep, playToastSound, unlockAlertAudio } from '../utils/alertSound'

interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'warning'
  persistent: boolean
  createdAt: number
}

interface ToastContextValue {
  toast: (message: string, type?: 'success' | 'error' | 'warning', persistent?: boolean) => void
  success: (message: string) => void
  error: (message: string, persistent?: boolean) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const TOAST_DURATION_MS = 3500
const TOAST_CLEANUP_INTERVAL_MS = 100

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)
  // Mirror of `toasts` readable inside event listeners — api:* events fire in
  // the same tick as the caller's own toast, before state would re-render.
  const toastsRef = useRef<Toast[]>([])

  const setToastsSynced = (next: Toast[]) => {
    toastsRef.current = next
    setToasts(next)
  }

  const dismissToast = (id: number) => {
    setToastsSynced(toastsRef.current.filter((t) => t.id !== id))
  }

  const addToast = (
    message: string,
    type: 'success' | 'error' | 'warning' = 'success',
    persistent = false,
  ) => {
    const id = ++nextId.current
    const createdAt = Date.now()
    // Local UI toasts (settings saves, user actions) stay silent — sounds are
    // only for server-pushed alert/warning/error moments via the SSE handlers.
    setToastsSynced([...toastsRef.current, { id, message, type, persistent, createdAt }])
  }

  const success = (message: string) => addToast(message, 'success')
  const error = (message: string, persistent = false) => addToast(message, 'error', persistent)

  useEffect(() => {
    const interval = setInterval(() => {
      const kept = toastsRef.current.filter(
        (t) => t.persistent || Date.now() - t.createdAt < TOAST_DURATION_MS,
      )
      if (kept.length !== toastsRef.current.length) setToastsSynced(kept)
    }, TOAST_CLEANUP_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    // api:* events fire alongside the caller's own toast — when one is already
    // on screen it played the sound, so only act when nothing is showing.
    const onSuccess = () => {
      if (toastsRef.current.length === 0) addToast('Saved')
    }
    const onError = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string; message: string }>)
        .detail
      if (toastsRef.current.length === 0) addToast(detail?.message ?? 'Save failed', 'error')
    }
    window.addEventListener('api:success', onSuccess)
    window.addEventListener('api:error', onError)
    return () => {
      window.removeEventListener('api:success', onSuccess)
      window.removeEventListener('api:error', onError)
    }
  }, [])

  useEffect(() => {
    const unlock = () => unlockAlertAudio()
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource('/app/api/events/stream')
    const onStreamSuccess = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { message: string; silent?: boolean }
        if (!data.silent) playToastSound('success')
        success(data.message)
      } catch {
        // ignore malformed events
      }
    }
    const onStreamError = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { message: string; persistent?: boolean }
        playToastSound('error')
        error(data.message, Boolean(data.persistent))
      } catch {
        // ignore malformed events
      }
    }
    const onStreamWarning = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { message: string; persistent?: boolean }
        playToastSound('warning')
        addToast(data.message, 'warning', Boolean(data.persistent))
      } catch {
        // ignore malformed events
      }
    }
    let refreshTimer: number | null = null
    const onStreamRefresh = () => {
      if (refreshTimer != null) return
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        window.dispatchEvent(new CustomEvent('journal:refresh'))
      }, 500)
    }
    const onStreamLog = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as Record<string, unknown>
        window.dispatchEvent(new CustomEvent('bridge:log', { detail: data }))
        if (
          data.category === 'routing' ||
          data.category === 'lifecycle' ||
          data.category === 'email'
        ) {
          playAlertBeep()
        }
      } catch {
        // ignore malformed events
      }
    }
    source.addEventListener('toast:success', onStreamSuccess)
    source.addEventListener('toast:error', onStreamError)
    source.addEventListener('toast:warning', onStreamWarning)
    source.addEventListener('journal:refresh', onStreamRefresh)
    source.addEventListener('log:bridge', onStreamLog)
    return () => {
      if (refreshTimer != null) window.clearTimeout(refreshTimer)
      source.removeEventListener('toast:success', onStreamSuccess)
      source.removeEventListener('toast:error', onStreamError)
      source.removeEventListener('toast:warning', onStreamWarning)
      source.removeEventListener('journal:refresh', onStreamRefresh)
      source.removeEventListener('log:bridge', onStreamLog)
      source.close()
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast, success, error }}>
      {children}
      <div className="fixed right-4 top-16 z-50 flex flex-col gap-2 lg:top-24">
        {toasts.map((t) => (
          <div
            key={t.id}
            onClick={() => dismissToast(t.id)}
            className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm font-semibold shadow-lg transition ${
              t.type === 'error'
                ? 'border-[#7f1d1d] bg-[#450a0a]/95 text-[#fecaca]'
                : t.type === 'warning'
                  ? 'border-[#92400e] bg-[#451a03]/95 text-[#fde68a]'
                  : 'border-[#065f46] bg-[#022c22]/95 text-[#a7f3d0]'
            }`}
          >
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                dismissToast(t.id)
              }}
              className="shrink-0 leading-none hover:opacity-70"
              aria-label="Dismiss toast"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}
