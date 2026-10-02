import { createContext, useContext, useEffect, useState } from 'react'
import { getJson, fetchCsrfToken, clearCsrfToken } from '../api/client'
import { BASE_URL } from '../config'

export interface SessionUser {
  userId: string
  email: string
  csrfToken: string
  isAdmin: boolean
  devMode?: boolean
}

interface AuthContextValue {
  user: SessionUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<string | null>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  login: async () => null,
  logout: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getJson<SessionUser>('/api/session')
      .then((data) => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const login = async (email: string, password: string) => {
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'include',
      body: new URLSearchParams({ email, password }).toString(),
    })
    const data = (await res.json().catch(() => undefined)) as
      | { error?: string }
      | undefined
    if (!res.ok) return data?.error ?? 'Invalid email or password'
    clearCsrfToken()
    try {
      const session = await getJson<SessionUser>('/api/session')
      setUser(session)
      return null
    } catch {
      return 'Logged in but could not load session'
    }
  }

  const logout = async () => {
    try {
      const csrfToken = await fetchCsrfToken()
      await fetch(`${BASE_URL}/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body: new URLSearchParams({ csrfToken }).toString(),
      })
    } catch {}
    clearCsrfToken()
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
