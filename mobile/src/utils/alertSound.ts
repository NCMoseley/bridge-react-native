import * as Haptics from 'expo-haptics'
import { storage } from './storage'

// Web client plays WebAudio tones; on mobile we map the same cues onto haptic
// feedback so no audio session is needed.
const ENABLED_KEY = 'bridge:alertSound'

export function isAlertSoundEnabled() {
  try {
    return storage.getItem(ENABLED_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setAlertSoundEnabled(enabled: boolean) {
  try {
    storage.setItem(ENABLED_KEY, enabled ? 'on' : 'off')
  } catch {
    // ignore
  }
}

export function playAlertBeep(force = false) {
  if (!force && !isAlertSoundEnabled()) return
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
}

export function playToastSound(
  type: 'success' | 'error' | 'warning',
  force = false,
) {
  if (!force && !isAlertSoundEnabled()) return
  const kind =
    type === 'error'
      ? Haptics.NotificationFeedbackType.Error
      : type === 'warning'
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Success
  void Haptics.notificationAsync(kind)
}

export function unlockAlertAudio() {
  // No-op on mobile — kept for API parity with the web client.
}
