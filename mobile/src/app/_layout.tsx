import { useEffect } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { AuthProvider, useAuth } from '../context/AuthContext'
import { ToastProvider } from '../context/ToastContext'
import { colors } from '../components/ui'

function AuthGate() {
  const { user, loading } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  useEffect(() => {
    if (loading) return
    const inLogin = segments[0] === 'login'
    if (!user && !inLogin) router.replace('/login')
    else if (user && inLogin) router.replace('/')
  }, [user, loading, segments])

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
        <Stack.Screen name="ranges" options={{ title: 'Ranges' }} />
        <Stack.Screen
          name="range-calendar"
          options={{ title: 'Range Calendar' }}
        />
        <Stack.Screen
          name="category-calendar"
          options={{ title: 'Category Calendar' }}
        />
        <Stack.Screen name="debugging" options={{ title: 'Debugging' }} />
        <Stack.Screen name="account-pnl" options={{ title: 'P&L Review' }} />
      </Stack>
    </>
  )
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AuthGate />
      </ToastProvider>
    </AuthProvider>
  )
}
