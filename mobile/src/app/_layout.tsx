import { useEffect, useState } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { AuthProvider, useAuth } from '../context/AuthContext'
import { ToastProvider } from '../context/ToastContext'
import { colors, setTheme, Spinner } from '../components/ui'
import { hydrateStorage } from '../utils/storage'
import { currentTheme } from '../utils/theme'
import { onEvent } from '../utils/events'

function AuthGate() {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    void hydrateStorage().then(() => {
      setTheme(currentTheme())
      setHydrated(true)
    })
  }, [])
  const { user, loading } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  useEffect(() => {
    if (!hydrated || loading) return
    const inLogin = segments[0] === 'login'
    if (!user && !inLogin) router.replace('/login')
    else if (user && inLogin) router.replace('/')
  }, [user, loading, segments])

  if (!hydrated) {
    return (
      <>
        <StatusBar style="light" />
        <Spinner />
      </>
    )
  }

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="range-calendar"
          options={{ title: 'Range Review' }}
        />
        <Stack.Screen
          name="category-calendar"
          options={{ title: 'Category Calendar' }}
        />
        <Stack.Screen name="messages" options={{ title: 'Messages' }} />
        <Stack.Screen name="debugging" options={{ title: 'Debugging' }} />
        <Stack.Screen name="account-pnl" options={{ title: 'P&L Review' }} />
      </Stack>
    </>
  )
}

export default function RootLayout() {
  const [themeVersion, setThemeVersion] = useState(0)
  useEffect(() => onEvent('theme:changed', () => setThemeVersion((v) => v + 1)), [])
  return (
    <AuthProvider>
      <ToastProvider>
        <AuthGate key={themeVersion} />
      </ToastProvider>
    </AuthProvider>
  )
}
