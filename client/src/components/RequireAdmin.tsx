import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { LoadingSpinner } from './LoadingSpinner'

export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <LoadingSpinner size={24} />
      </div>
    )
  }

  if (!user?.isAdmin) {
    return <Navigate to="/app" replace />
  }

  return <>{children}</>
}
