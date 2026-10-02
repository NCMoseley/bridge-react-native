import { useState } from 'react'
import { useToast } from '../context/ToastContext'
import { Button } from '../components/Button'
import { Input } from '../components/Input'
import { Card } from '../components/Card'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const { error } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email, password }),
        credentials: 'same-origin',
      })
      const data = (await res.json().catch(() => undefined)) as
        | { redirect?: string; error?: string }
        | undefined
      if (res.ok) {
        window.location.href = data?.redirect ?? '/app'
      } else {
        error(data?.error ?? 'Invalid email or password')
      }
    } catch {
      error('Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-950 p-4">
      <img
        src="/app/logo.svg"
        alt=""
        className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-[120vmin] w-[120vmin] -translate-x-1/2 -translate-y-1/2 object-contain"
        style={{
          filter: 'blur(80px) brightness(1.2)',
          opacity: 0.2,
          mixBlendMode: 'screen',
        }}
      />
      <div className="relative z-10 w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <img src="/app/app-logo.svg" alt="Bridge" className="h-14 w-auto" />
        </div>
        <Card title="Sign in" className="w-full max-w-md">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-300">
                Password
              </span>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 pr-16 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700 hover:text-slate-100"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
            </label>
            <Button type="submit" disabled={loading} className="w-full">
              Sign in
            </Button>
          </form>
        </Card>
      </div>
    </div>
  )
}
