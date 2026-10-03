// Routine confirmations that don't deserve a system alert — anything else
// (fills, rejects, flatten, phantom/orphan, EOD, dispatch failures) notifies.
const ROUTINE_PATTERN =
  /saved|marked|copied|renamed|deleted|updated|imported|subscription|assigned|scheduled|applied|reassign|excluded|included|flag|created|sent to|refreshed/i

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

export function notifyToast(message: string, type: 'success' | 'error' | 'warning') {
  if (!Notifications || !shouldNotifyToast(message, type)) return
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
