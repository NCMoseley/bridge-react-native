import { createContext, useContext, useEffect, useState } from 'react'
import { postForm } from '../api/client'

export type Theme = 'dark' | 'light' | 'ultra' | 'barbie' | 'neonsign' | 'irish' | 'medieval' | 'optimist' | 'cush' | 'castrol'

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

const THEME_CLASSES = ['theme-light', 'theme-ultra', 'theme-barbie', 'theme-neonsign', 'theme-irish', 'theme-medieval', 'theme-optimist', 'theme-cush', 'theme-glass', 'theme-glassdark', 'theme-castrol'] as const

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

function readStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  let saved = localStorage.getItem('bridge:theme')
  if (saved === 'glass') saved = 'light'        // glass became the default light
  if (saved === 'glassdark') saved = 'dark'     // dark glass became the default dark
  if (saved === 'neon') saved = 'ultra'         // renamed to match the picker label
  return saved === 'light' || saved === 'ultra' || saved === 'barbie' || saved === 'neonsign' || saved === 'irish' || saved === 'medieval' || saved === 'optimist' || saved === 'cush' || saved === 'castrol' ? saved : 'dark'
}

function applyClass(next: Theme): void {
  document.documentElement.classList.remove(...THEME_CLASSES)
  if (next === 'dark') {
    // Dark IS the glass material: theme-glass supplies structure (blur,
    // sheen, shadows), theme-glassdark supplies the dark tokens.
    document.documentElement.classList.add('theme-glass', 'theme-glassdark')
  } else if (next === 'light') {
    // Light IS the glass material.
    document.documentElement.classList.add('theme-glass')
  } else {
    document.documentElement.classList.add(`theme-${next}`)
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  const setTheme = (next: Theme) => {
    setThemeState(next)
    applyClass(next)
    localStorage.setItem('bridge:theme', next)
    postForm('/theme', { theme: next }).catch(() => {
      // best-effort server persistence
    })
  }

  const toggleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  useEffect(() => {
    applyClass(theme)
  }, [theme])

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
