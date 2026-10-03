import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Link } from 'expo-router'
import { useAuth } from '../../context/AuthContext'
import { useState } from 'react'
import { Card, SelectPicker, setTheme, themedStyles } from '../../components/ui'
import { THEME_OPTIONS, currentTheme, type ThemeName } from '../../utils/theme'

const LINKS = [
  { href: '/messages', label: 'Messages', desc: 'Toasts & trade alerts history' },
  { href: '/range-calendar', label: 'Range Review', desc: 'Per-range monthly P&L' },
  { href: '/category-calendar', label: 'Category Calendar', desc: 'Per-model monthly P&L' },
  { href: '/settings', label: 'Settings', desc: 'Route subscriptions & extension' },
] as const

function ThemeCard() {
  const [theme, setThemeState] = useState<ThemeName>(currentTheme())
  return (
    <Card title="Theme">
      <SelectPicker
        options={THEME_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
        value={theme}
        onChange={(v) => {
          const next = v as ThemeName
          setThemeState(next)
          setTheme(next)
        }}
      />
    </Card>
  )
}

export default function MoreScreen() {
  const { user } = useAuth()
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.list}>
      <ThemeCard />
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} asChild>
          <Pressable style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{l.label}</Text>
              <Text style={styles.desc}>{l.desc}</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </Link>
      ))}
      {user?.isAdmin ? (
        <Link href="/debugging" asChild>
          <Pressable style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Debugging</Text>
              <Text style={styles.desc}>Admin diagnostics & reconciliation</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        </Link>
      ) : null}
    </ScrollView>
  )
}

const styles = themedStyles((c) => StyleSheet.create({
  chevron: { color: c.muted, fontSize: 22 },
  container: { backgroundColor: c.bg, flex: 1 },
  desc: { color: c.muted, fontSize: 12, marginTop: 2 },
  label: { color: c.text, fontSize: 15, fontWeight: '600' },
  list: { padding: 12 },
  row: {
    alignItems: 'center',
    backgroundColor: c.card,
    borderColor: c.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 14,
  },
}))
