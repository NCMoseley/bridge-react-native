import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { ToastProvider } from './context/ToastContext'
import { routes } from './router'

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
)

describe('client router', () => {
  it('renders the login page at /login', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/login'] })
    render(<RouterProvider router={router} />, { wrapper })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy()
  })

  it('has a /login route', () => {
    const login = routes.find((r) => r.path === '/login')
    expect(login).toBeTruthy()
    expect(login?.element?.type.name).toBe('LoginPage')
  })

  it('has an /app/* layout route with all expected pages', () => {
    const app = routes.find((r) => r.path === '/app/*') as
      | { children: { path?: string; index?: boolean }[] }
      | undefined
    expect(app).toBeTruthy()
    const childPaths =
      app?.children.map((c) => (c.index ? 'index' : c.path)) ?? []
    expect(childPaths).toContain('index')
    expect(childPaths).toContain('journal/day')
    expect(childPaths).toContain('accounts')
    expect(childPaths).toContain('accounts/:accountId/pnl')
    expect(childPaths).toContain('alerts')
    expect(childPaths).toContain('ranges')
    expect(childPaths).toContain('ranges/calendar')
    expect(childPaths).toContain('settings')
    expect(childPaths).toContain('debugging')
  })
})
