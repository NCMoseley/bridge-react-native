import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'

export const colors = {
  bg: '#020617',
  card: '#0f172a',
  border: '#1e293b',
  text: '#e2e8f0',
  muted: '#94a3b8',
  positive: '#4ade80',
  negative: '#f87171',
  accent: '#38bdf8',
}

export function pnlColor(cents: number): string {
  if (cents > 0) return colors.positive
  if (cents < 0) return colors.negative
  return colors.text
}

export function Card({
  title,
  children,
}: {
  title?: string
  children: React.ReactNode
}) {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  )
}

export function Stat({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
    </View>
  )
}

export function Spinner() {
  return (
    <View style={styles.spinner}>
      <ActivityIndicator color={colors.accent} size="large" />
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    padding: 14,
  },
  cardTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  spinner: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  stat: { minWidth: '30%', paddingVertical: 4 },
  statLabel: { color: colors.muted, fontSize: 11, marginBottom: 2 },
  statValue: { color: colors.text, fontSize: 16, fontWeight: '600' },
})
