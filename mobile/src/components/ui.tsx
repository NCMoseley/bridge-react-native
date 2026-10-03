import { useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { StyleProp, TextStyle, ViewStyle } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import { storage } from '../utils/storage'

export const colors = {
  bg: '#020617',
  card: '#0f172a',
  cardAlt: '#111c34',
  border: '#1e293b',
  text: '#e2e8f0',
  muted: '#94a3b8',
  faint: '#64748b',
  positive: '#4ade80',
  negative: '#f87171',
  accent: '#38bdf8',
  amber: '#fbbf24',
}

export function pnlColor(cents: number): string {
  if (cents > 0) return colors.positive
  if (cents < 0) return colors.negative
  return colors.text
}

export function toneForCents(cents: number): 'positive' | 'negative' | 'neutral' {
  if (cents > 0) return 'positive'
  if (cents < 0) return 'negative'
  return 'neutral'
}

export function Card({
  title,
  children,
  style,
}: {
  title?: string
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[styles.card, style]}>
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

// Label/value row used across detail cards (web KpiStat / detail rows).
export function KpiRow({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  return (
    <View style={styles.kpiRow}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text
        style={[
          styles.kpiValue,
          tone === 'positive'
            ? { color: colors.positive }
            : tone === 'negative'
              ? { color: colors.negative }
              : null,
        ]}
      >
        {value}
      </Text>
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

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  style,
  small,
}: {
  title: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  disabled?: boolean
  style?: StyleProp<ViewStyle>
  small?: boolean
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        variant === 'ghost' && styles.buttonGhost,
        (disabled || pressed) && { opacity: disabled ? 0.5 : 0.8 },
        style,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          small && styles.buttonTextSmall,
          variant === 'secondary' && { color: colors.text },
          variant === 'ghost' && { color: colors.accent },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  )
}

export function Input({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  secureTextEntry,
  multiline,
  numberOfLines,
  style,
}: {
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  keyboardType?: 'default' | 'numeric' | 'decimal-pad' | 'email-address'
  secureTextEntry?: boolean
  multiline?: boolean
  numberOfLines?: number
  style?: StyleProp<TextStyle>
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.faint}
      keyboardType={keyboardType}
      secureTextEntry={secureTextEntry}
      multiline={multiline}
      numberOfLines={numberOfLines}
      autoCapitalize="none"
      autoCorrect={false}
      style={[styles.input, multiline && { minHeight: 70, textAlignVertical: 'top' }, style]}
    />
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  )
}

export function Badge({
  children,
  status = 'online',
}: {
  children: React.ReactNode
  status?: 'online' | 'offline' | 'warning' | 'error' | 'info'
}) {
  const bg =
    status === 'online'
      ? '#14532d'
      : status === 'warning'
        ? '#451a03'
        : status === 'error'
          ? '#450a0a'
          : status === 'info'
            ? '#0c4a6e'
            : '#1e293b'
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={styles.badgeText}>{children}</Text>
    </View>
  )
}

// Simple horizontal option picker (replaces <select>).
export function SegmentedPicker<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable
          key={String(o.value)}
          onPress={() => onChange(o.value)}
          style={[styles.segment, value === o.value && styles.segmentActive]}
        >
          <Text
            style={[
              styles.segmentText,
              value === o.value && styles.segmentTextActive,
            ]}
          >
            {o.label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}


// Modal dropdown replacing <select>. Renders the current label; tapping opens
// a scrollable option sheet.
export function SelectPicker<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <View>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <Pressable style={styles.selectButton} onPress={() => setOpen(true)}>
        <Text style={styles.selectButtonText} numberOfLines={1}>
          {current?.label ?? String(value)}
        </Text>
        <Text style={{ color: colors.muted }}>▾</Text>
      </Pressable>
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.selectBackdrop} onPress={() => setOpen(false)}>
          <View style={styles.selectSheet}>
            <ScrollView>
              {options.map((o) => (
                <Pressable
                  key={String(o.value)}
                  onPress={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  style={[styles.selectOption, o.value === value && { backgroundColor: colors.border }]}
                >
                  <Text style={{ color: colors.text, fontSize: 14 }}>{o.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

export function CollapsibleSection({
  title,
  actions,
  children,
  defaultOpen = true,
  storageKey,
  open,
  onToggle,
  style,
}: {
  title: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
  storageKey?: string
  open?: boolean
  onToggle?: () => void
  style?: StyleProp<ViewStyle>
}) {
  const isControlled = open !== undefined
  const [internalOpen, setInternalOpen] = useState(() => {
    if (!storageKey) return defaultOpen
    const raw = storage.getItem(storageKey)
    return raw === 'true' ? true : raw === 'false' ? false : defaultOpen
  })
  const isOpen = open ?? internalOpen
  const toggle = () => {
    if (isControlled) {
      onToggle?.()
      return
    }
    setInternalOpen((v) => {
      const next = !v
      if (storageKey) storage.setItem(storageKey, String(next))
      return next
    })
  }
  return (
    <View style={[styles.card, style]}>
      <Pressable onPress={toggle} style={styles.collapsibleHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>{title}</View>
        {actions}
        <Text style={styles.collapsibleToggle}>{isOpen ? '−' : '+'}</Text>
      </Pressable>
      {isOpen ? <View style={styles.collapsibleBody}>{children}</View> : null}
    </View>
  )
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.cardTitle}>{children}</Text>
}

export function EmptyText({ children }: { children: React.ReactNode }) {
  return <Text style={styles.emptyText}>{children}</Text>
}

export function RingChart({
  positive,
  negative = 100 - positive,
  label,
  size = 90,
  positiveColor = colors.positive,
  negativeColor = colors.negative,
}: {
  positive: number
  negative?: number
  label: string
  size?: number
  positiveColor?: string
  negativeColor?: string
}) {
  const total = Math.max(1, positive + negative)
  const positivePct = positive / total
  const negativePct = negative / total

  const stroke = Math.max(8, size * 0.11)
  const r = (size - stroke) / 2 - 1
  const c = size / 2
  const circumference = 2 * Math.PI * r
  const capGap = Math.min(0.012, 2 / circumference)
  const posLen = Math.max(0, (positivePct - capGap) * circumference)
  const negLen = Math.max(0, (negativePct - capGap) * circumference)
  const negOffset = -(positivePct + capGap) * circumference

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        <Circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={colors.border}
          strokeOpacity={0.6}
          strokeWidth={stroke}
        />
        {posLen > 0 ? (
          <Circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={positiveColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${posLen} ${circumference}`}
            rotation={-90}
            origin={`${c}, ${c}`}
          />
        ) : null}
        {negLen > 0 ? (
          <Circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={negativeColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${negLen} ${circumference}`}
            strokeDashoffset={negOffset}
            rotation={-90}
            origin={`${c}, ${c}`}
          />
        ) : null}
      </Svg>
      <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>{label}</Text>
      </View>
    </View>
  )
}

export function BalanceBar({ positive, negative }: { positive: number; negative: number }) {
  const total = Math.max(1, positive + negative)
  const positivePct = Math.round((positive / total) * 100)
  const negativePct = 100 - positivePct
  return (
    <View style={styles.balanceBar}>
      {positivePct > 0 ? (
        <View style={{ backgroundColor: colors.positive, flex: positivePct, height: '100%' }} />
      ) : null}
      {negativePct > 0 ? (
        <View style={{ backgroundColor: colors.negative, flex: negativePct, height: '100%' }} />
      ) : null}
    </View>
  )
}

// Semicircle gauge with a needle at `value` percent (0–100).
export function GaugeChart({
  value,
  label,
  size = 170,
}: {
  value: number
  label: string
  size?: number
}) {
  const pct = Math.max(0, Math.min(100, value))
  const stroke = Math.max(10, size * 0.1)
  const w = size
  const h = size * 0.62
  const cx = w / 2
  const cy = h - 6
  const r = Math.min(w / 2, cy) - stroke / 2 - 2

  const point = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) }
  }
  const arc = `M ${point(180).x} ${point(180).y} A ${r} ${r} 0 0 1 ${point(0).x} ${point(0).y}`
  const rad = ((180 - (pct / 100) * 180) * Math.PI) / 180
  const len = r - stroke / 2 - 4
  const tip = { x: cx + len * Math.cos(rad), y: cy - len * Math.sin(rad) }

  return (
    <View style={{ alignItems: 'center', width: '100%', maxWidth: size }}>
      <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <Path d={arc} fill="none" stroke={colors.border} strokeWidth={stroke} />
        {/* red→amber→green approximation: three band segments */}
        <Path
          d={`M ${point(180).x} ${point(180).y} A ${r} ${r} 0 0 1 ${point(120).x} ${point(120).y}`}
          fill="none"
          stroke={colors.negative}
          strokeWidth={stroke}
          strokeOpacity={0.9}
        />
        <Path
          d={`M ${point(120).x} ${point(120).y} A ${r} ${r} 0 0 1 ${point(60).x} ${point(60).y}`}
          fill="none"
          stroke={colors.amber}
          strokeWidth={stroke}
          strokeOpacity={0.9}
        />
        <Path
          d={`M ${point(60).x} ${point(60).y} A ${r} ${r} 0 0 1 ${point(0).x} ${point(0).y}`}
          fill="none"
          stroke={colors.positive}
          strokeWidth={stroke}
          strokeOpacity={0.9}
        />
        <Circle cx={cx} cy={cy} r={stroke * 0.45} fill={colors.text} />
        <Path
          d={`M ${cx} ${cy} L ${tip.x} ${tip.y}`}
          stroke={colors.text}
          strokeWidth={Math.max(3, size * 0.025)}
          strokeLinecap="round"
        />
      </Svg>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 4 }}>
        {label}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  badgeText: { color: colors.text, fontSize: 11, fontWeight: '600' },
  balanceBar: {
    backgroundColor: colors.bg,
    borderRadius: 999,
    flexDirection: 'row',
    height: 8,
    overflow: 'hidden',
  },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonDanger: { backgroundColor: '#7f1d1d' },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonPrimary: { backgroundColor: '#0369a1' },
  buttonSecondary: { backgroundColor: colors.border },
  buttonSmall: { paddingHorizontal: 10, paddingVertical: 6 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  buttonTextSmall: { fontSize: 12 },
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
  collapsibleBody: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: 12,
  },
  collapsibleHeader: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  collapsibleToggle: { color: colors.muted, fontSize: 22, marginLeft: 12 },
  emptyText: { color: colors.muted, paddingVertical: 8, textAlign: 'center' },
  fieldLabel: { color: colors.muted, fontSize: 12, marginBottom: 4 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  kpiLabel: { color: colors.muted, fontSize: 13 },
  kpiRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  kpiValue: { color: colors.text, fontSize: 13, fontWeight: '600' },
  selectBackdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  selectButton: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  selectButtonText: { color: colors.text, flex: 1, fontSize: 14, marginRight: 8 },
  selectOption: { borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10 },
  selectSheet: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: '70%',
    padding: 6,
    width: '100%',
  },
  segment: {
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  segmentActive: { backgroundColor: colors.border },
  segmentText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  segmentTextActive: { color: colors.text },
  segmented: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    padding: 2,
  },
  spinner: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  stat: { minWidth: '30%', paddingVertical: 4 },
  statLabel: { color: colors.muted, fontSize: 11, marginBottom: 2 },
  statValue: { color: colors.text, fontSize: 16, fontWeight: '600' },
})
