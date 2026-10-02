import { createContext, useContext, useEffect, useState } from 'react'
import { getJson } from '../api/client'

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
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
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

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
