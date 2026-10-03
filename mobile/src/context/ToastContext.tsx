import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import EventSource from 'react-native-sse'
import { API_BASE } from '../config'
import { emitEvent, onEvent } from '../utils/events'
import { playAlertBeep, playToastSound } from '../utils/alertSound'
import { initNotifications, notifyToast } from '../utils/notifications'

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
    const offSuccess = onEvent('api:success', () => {
      if (toastsRef.current.length === 0) addToast('Saved')
    })
    const offError = onEvent('api:error', (detail) => {
      const d = detail as { action?: string; message?: string } | undefined
      if (toastsRef.current.length === 0) addToast(d?.message ?? 'Save failed', 'error')
    })
    return () => {
      offSuccess()
      offError()
    }
  }, [])

  useEffect(() => {
    initNotifications()
    const source = new EventSource<'toast:success' | 'toast:error' | 'toast:warning' | 'journal:refresh' | 'log:bridge'>(
      `${API_BASE}/api/events/stream`,
    )
    const onStreamSuccess = (e: { data?: string | null }) => {
      try {
        const data = JSON.parse(e.data ?? '') as { message: string; silent?: boolean }
        if (!data.silent) playToastSound('success')
        notifyToast(data.message, 'success')
        success(data.message)
      } catch {
        // ignore malformed events
      }
    }
    const onStreamError = (e: { data?: string | null }) => {
      try {
        const data = JSON.parse(e.data ?? '') as { message: string; persistent?: boolean }
        playToastSound('error')
        notifyToast(data.message, 'error')
        error(data.message, Boolean(data.persistent))
      } catch {
        // ignore malformed events
      }
    }
    const onStreamWarning = (e: { data?: string | null }) => {
      try {
        const data = JSON.parse(e.data ?? '') as { message: string; persistent?: boolean }
        playToastSound('warning')
        notifyToast(data.message, 'warning')
        addToast(data.message, 'warning', Boolean(data.persistent))
      } catch {
        // ignore malformed events
      }
    }
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const onStreamRefresh = () => {
      if (refreshTimer != null) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        emitEvent('journal:refresh')
      }, 500)
    }
    const onStreamLog = (e: { data?: string | null }) => {
      try {
        const data = JSON.parse(e.data ?? '') as Record<string, unknown>
        emitEvent('bridge:log', data)
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
      if (refreshTimer != null) clearTimeout(refreshTimer)
      source.removeAllEventListeners()
      source.close()
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast, success, error }}>
      {children}
      <View pointerEvents="box-none" style={styles.toastWrap}>
        {toasts.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => dismissToast(t.id)}
            style={[
              styles.toast,
              t.type === 'error'
                ? styles.toastError
                : t.type === 'warning'
                  ? styles.toastWarning
                  : styles.toastSuccess,
            ]}
          >
            <Text style={styles.toastText}>{t.message}</Text>
            <Text style={styles.toastClose}>×</Text>
          </Pressable>
        ))}
      </View>
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

const styles = StyleSheet.create({
  toast: {
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  toastClose: { color: '#e2e8f0', fontSize: 16, lineHeight: 18 },
  toastError: { backgroundColor: '#450a0a', borderColor: '#7f1d1d' },
  toastSuccess: { backgroundColor: '#022c22', borderColor: '#065f46' },
  toastText: { color: '#e2e8f0', flex: 1, fontSize: 13, fontWeight: '600' },
  toastWarning: { backgroundColor: '#451a03', borderColor: '#92400e' },
  toastWrap: {
    left: 16,
    position: 'absolute',
    right: 16,
    top: 60,
    zIndex: 50,
  },
})
