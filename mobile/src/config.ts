// Dev builds hit the local bridge server (npm run dev, port 3000). The Metro
// host URI carries the dev machine's LAN IP, so physical devices reach the
// bridge the same way they reach the bundler. Release builds keep production.
import Constants from 'expo-constants'
import { Platform } from 'react-native'

function devBase(): string {
  const hostUri = Constants.expoConfig?.hostUri
  const host = hostUri?.split(':')[0]
  // Only use the Metro host when it's a LAN IP — under --tunnel the hostUri is
  // an exp.direct domain that can't reach the local bridge.
  if (host && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return `http://${host}:3000`
  return Platform.OS === 'android' ? 'http://10.0.2.2:3000' : 'http://localhost:3000'
}

export const BASE_URL = __DEV__ ? devBase() : 'https://tradovate-browser-bridge.onrender.com'
export const API_BASE = `${BASE_URL}/app`
