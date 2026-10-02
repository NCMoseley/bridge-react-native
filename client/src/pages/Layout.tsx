import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import {
  isAlertSoundEnabled,
  playAlertBeep,
  setAlertSoundEnabled,
} from '../utils/alertSound'
import { Utc4Clock } from '../components/Utc4Clock'
import { prefetchPageData } from '../utils/page-prefetch'

const links = [
  { to: '/app', label: 'Journal' },
  { to: '/app/accounts', label: 'Accounts' },
  { to: '/app/alerts', label: 'Alerts' },
  { to: '/app/ranges', label: 'Ranges' },
  { to: '/app/categories/calendar', label: 'Model Calendar' },
  { to: '/app/settings', label: 'Settings' },
  { to: '/app/debugging', label: 'Debugging' },
  { to: '/app/monitoring', label: 'Monitoring' },
]

const mobileLinks = [
  { to: '/app', label: 'Journal' },
  { to: '/app/accounts', label: 'Accounts' },
  { to: '/app/alerts', label: 'Alerts' },
  { to: '/app/ranges', label: 'Ranges' },
  { to: '/app/settings', label: 'Settings' },
]

function NavItem({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `rounded-lg px-3 py-2 text-sm font-semibold transition ${
          isActive
            ? 'bg-slate-800 text-slate-100 ring-1 ring-slate-600'
            : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
        }`
      }
    >
      {label}
    </NavLink>
  )
}

function MobileNavItem({ to, label, end }: { to: string; label: string; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center justify-center rounded-2xl border px-2 py-3 text-xs font-semibold transition ${
          isActive
            ? 'border-indigo-500 bg-slate-800 text-indigo-500'
            : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
        }`
      }
    >
      {label}
    </NavLink>
  )
}

function SunIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  )
}

function MoonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function SpeakerIcon({ muted, ...props }: { muted?: boolean } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      {muted ? (
        <path d="m23 9-6 6M17 9l6 6" />
      ) : (
        <>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </>
      )}
    </svg>
  )
}

export function Layout() {
  const { theme, toggleTheme } = useTheme()
  const { user } = useAuth()
  const [soundOn, setSoundOn] = useState(isAlertSoundEnabled)

  useEffect(() => {
    const sync = () => setSoundOn(isAlertSoundEnabled())
    window.addEventListener('bridge:alert-sound', sync)
    return () => window.removeEventListener('bridge:alert-sound', sync)
  }, [])
  const csrfToken = user?.csrfToken ?? ''

  useEffect(() => {
    prefetchPageData()
  }, [])

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[248px_minmax(0,1fr)] text-slate-100">
      <Utc4Clock />
      <aside className="hidden flex-col gap-8 border-r border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 px-5 py-7 lg:flex">
        {theme === 'neonsign' ? (
          <img
            src="/app/neon-banner.jpg"
            alt="Bridge NEON"
            className="w-full rounded-lg"
          />
        ) : theme === 'light' ? (
          <img
            src="/app/glass-banner.png"
            alt="Bridge Workspace"
            className="w-full rounded-lg"
          />
        ) : theme === 'castrol' ? (
          <img
            src="/app/castrol-banner.jpg"
            alt="Bridge"
            className="w-full rounded-lg"
          />
        ) : (
          <div className="flex items-center gap-3">
            <img src="/app/app-logo.svg" alt="Bridge" className="h-8 w-auto" />
            <div>
              <div className="font-extrabold tracking-wide">Bridge</div>
              <div className="text-[0.68rem] font-semibold uppercase tracking-widest text-slate-400">
                Workspace
              </div>
            </div>
          </div>
        )}
        <nav className="grid gap-1.5">
          {links
            .filter((link) => link.to !== '/app/debugging' || user?.isAdmin)
            .map((link) => (
              <NavItem key={link.to} to={link.to} label={link.label} end={link.to === '/app'} />
            ))}
        </nav>
        <div className="mt-auto space-y-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const next = !soundOn
                setAlertSoundEnabled(next)
                setSoundOn(next)
                if (next) playAlertBeep()
              }}
              aria-label={soundOn ? 'Mute alert sounds' : 'Enable alert sounds'}
              title={soundOn ? 'Mute alert sounds' : 'Enable alert sounds'}
              className="flex items-center justify-center rounded-lg border border-slate-800 p-3 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            >
              <SpeakerIcon muted={!soundOn} />
              <span className="sr-only">{soundOn ? 'Mute sounds' : 'Enable sounds'}</span>
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-800 p-3 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
            <span className="sr-only">{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
            </button>
          </div>
          <form
            action="/logout"
            method="post"
            className="rounded-lg border border-slate-800 p-3"
          >
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <button
              type="submit"
              disabled={!csrfToken}
              className="w-full text-sm text-slate-400 hover:text-slate-100 disabled:opacity-50"
            >
              Sign out
            </button>
          </form>
          <div className="rounded-lg border border-slate-800/50 bg-slate-900/50 p-3 text-[0.65rem] font-medium text-slate-500">
            All times are in New York time (UTC-4)
          </div>
        </div>
      </aside>
      <main className="min-w-0 p-4 pb-28 lg:p-7 lg:pb-7">
        <Outlet />
      </main>
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 grid grid-cols-5 gap-2 border-t border-slate-800 bg-slate-900/95 p-2 backdrop-blur lg:hidden"
        aria-label="Mobile navigation"
      >
        {mobileLinks.map((link) => (
          <MobileNavItem
            key={link.to}
            to={link.to}
            label={link.label}
            end={link.to === '/app'}
          />
        ))}
      </nav>
    </div>
  )
}
