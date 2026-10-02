import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Link } from 'expo-router'
import { useAuth } from '../../context/AuthContext'
import { colors } from '../../components/ui'

const LINKS = [
  { href: '/ranges', label: 'Ranges', desc: 'Tracked ranges, models, performance' },
  { href: '/order-review', label: 'Order Review', desc: 'Extension order drafts queue' },
  { href: '/range-calendar', label: 'Range Calendar', desc: 'Per-range monthly P&L' },
  { href: '/category-calendar', label: 'Category Calendar', desc: 'Per-model monthly P&L' },
  { href: '/settings', label: 'Settings', desc: 'Route subscriptions & extension' },
] as const

export default function MoreScreen() {
  const { user } = useAuth()
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.list}>
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

const styles = StyleSheet.create({
  chevron: { color: colors.muted, fontSize: 22 },
  container: { backgroundColor: colors.bg, flex: 1 },
  desc: { color: colors.muted, fontSize: 12, marginTop: 2 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  list: { padding: 12 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 8,
    padding: 14,
  },
})
