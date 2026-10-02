import { useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useAuth } from '../context/AuthContext'
import { Card, colors } from '../components/ui'
import { BASE_URL } from '../config'

export default function LoginScreen() {
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setLoading(true)
    setError(null)
    const err = await login(email.trim(), password)
    setLoading(false)
    if (err) setError(err)
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <View style={styles.inner}>
        <Text style={styles.logo}>Bridge</Text>
        <Card title="Sign in">
          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={email}
          />
          <TextInput
            onChangeText={setPassword}
            onSubmitEditing={submit}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={styles.input}
            value={password}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            disabled={loading}
            onPress={submit}
            style={[styles.button, loading && { opacity: 0.6 }]}
          >
            <Text style={styles.buttonText}>
              {loading ? 'Signing in…' : 'Sign in'}
            </Text>
          </Pressable>
        </Card>
        <Text style={styles.server}>{BASE_URL}</Text>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 8,
    marginTop: 12,
    paddingVertical: 12,
  },
  buttonText: { color: '#082f49', fontSize: 16, fontWeight: '700' },
  container: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    flex: 1,
    justifyContent: 'center',
  },
  error: { color: colors.negative, fontSize: 13, marginTop: 8 },
  inner: { width: '88%', maxWidth: 420 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  logo: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '800',
    marginBottom: 20,
    textAlign: 'center',
  },
  server: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 16,
    textAlign: 'center',
  },
})
