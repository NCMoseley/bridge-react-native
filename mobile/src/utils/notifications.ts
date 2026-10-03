// Routine confirmations that don't deserve a system alert — anything else
// (fills, rejects, flatten, phantom/orphan, EOD, dispatch failures) notifies.
const ROUTINE_PATTERN =
  /saved|marked|copied|renamed|deleted|updated|imported|subscription|assigned|scheduled|applied|reassign|excluded|included|flag|created|sent to|refreshed/i

import { Platform } from 'react-native'

type NotificationsModule = typeof import('expo-notifications')

// expo-notifications throws at import time inside Expo Go (SDK 53+) — load it
// lazily so the app still runs there; notifications no-op outside a dev build.
let Notifications: NotificationsModule | null = null
try {
  Notifications = require('expo-notifications') as NotificationsModule
} catch {
  Notifications = null
}

let ready = false

export function initNotifications() {
  if (ready || !Notifications) return
  ready = true
  // Android 8+ requires an explicit channel — HIGH importance for banner+sound.
  if (Platform.OS === 'android') {
    void Notifications.setNotificationChannelAsync('bridge-alerts', {
      name: 'Bridge alerts',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
    }).catch(() => {})
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  })
  void Notifications.requestPermissionsAsync().catch(() => {})
}

export function shouldNotifyToast(message: string, type: 'success' | 'error' | 'warning'): boolean {
  if (type !== 'success') return true
  return !ROUTINE_PATTERN.test(message)
}

const lastNotified = new Map<string, number>()
let lastNotifyAt = 0

export function notifyToast(message: string, type: 'success' | 'error' | 'warning') {
  if (!Notifications || !shouldNotifyToast(message, type)) return
  // Dedupe identical messages for 15 min and cap the global rate — CT warning
  // storms previously fired one phone alert per repeat.
  const now = Date.now()
  const prev = lastNotified.get(message)
  if (prev && now - prev < 15 * 60_000) return
  if (now - lastNotifyAt < 10_000) return
  lastNotified.set(message, now)
  lastNotifyAt = now
  if (lastNotified.size > 200) lastNotified.clear()
  void Notifications.scheduleNotificationAsync({
    content: {
      title:
        type === 'error'
          ? 'Bridge error'
          : type === 'warning'
            ? 'Bridge warning'
            : 'Bridge',
      body: message,
      sound: true,
    },
    trigger: null,
  }).catch(() => {})
}
