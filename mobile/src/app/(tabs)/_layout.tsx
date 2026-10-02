import { Pressable, StyleSheet, Text } from 'react-native'
import { Tabs } from 'expo-router'
import { useAuth } from '../../context/AuthContext'
import { colors } from '../../components/ui'

export default function TabsLayout() {
  const { logout } = useAuth()
  return (
    <Tabs
      screenOptions={{
        headerRight: () => (
          <Pressable onPress={logout} style={styles.logout}>
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        ),
        headerStyle: { backgroundColor: colors.card },
        headerTintColor: colors.text,
        sceneStyle: { backgroundColor: colors.bg },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
        },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Journal' }} />
      <Tabs.Screen name="accounts" options={{ title: 'Accounts' }} />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  logout: { marginRight: 14 },
  logoutText: { color: colors.accent, fontSize: 14 },
})
