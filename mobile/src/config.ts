// Dev builds hit the local bridge server (npm run dev, port 3000).
// Release builds keep production. Android emulator needs 10.0.2.2 instead of
// localhost to reach the host machine.
import { Platform } from 'react-native'

export const BASE_URL = __DEV__
  ? Platform.OS === 'android'
    ? 'http://10.0.2.2:3000'
    : 'http://localhost:3000'
  : 'https://tradovate-browser-bridge.onrender.com'
export const API_BASE = `${BASE_URL}/app`
