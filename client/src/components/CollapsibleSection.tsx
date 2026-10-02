import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface CollapsibleSectionProps {
  title: ReactNode
  /** Extra controls rendered beside the title but outside the toggle's interactive
   *  area — use for links/buttons that must not be nested inside role="button". */
  actions?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  storageKey?: string
  open?: boolean
  onToggle?: (anchor?: HTMLElement) => void
  className?: string
  /** Faint background text/pattern rendered behind the card via ::after. */
  watermark?: string
  style?: React.CSSProperties
}

function readStoredOpen(key: string | undefined, fallback: boolean): boolean {
  if (!key || typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    if (raw === 'true') return true
    if (raw === 'false') return false
  } catch {
    // ignore
  }
  return fallback
}

function writeStoredOpen(key: string | undefined, open: boolean): void {
  if (!key || typeof window === 'undefined') return
  try {
    localStorage.setItem(key, String(open))
  } catch {
    // ignore
  }
}

export function CollapsibleSection({
  title,
  actions,
  children,
  defaultOpen = true,
  storageKey,
  open: controlledOpen,
  onToggle,
  className,
  watermark,
  style,
}: CollapsibleSectionProps) {
  const isControlled = controlledOpen !== undefined
  const [internalOpen, setInternalOpen] = useState(() => {
    if (isControlled || !storageKey) return defaultOpen
    return readStoredOpen(storageKey, defaultOpen)
  })

  const isOpen = controlledOpen ?? internalOpen
  const headerRef = useRef<HTMLDivElement>(null)
  const pinnedTop = useRef<number | null>(null)

  const toggle = (anchor?: HTMLElement) => {
    pinnedTop.current = (anchor ?? headerRef.current)?.getBoundingClientRect().top ?? null
    if (isControlled) {
      onToggle?.(anchor ?? headerRef.current ?? undefined)
      return
    }
    setInternalOpen((open) => {
      const next = !open
      writeStoredOpen(storageKey, next)
      return next
    })
  }

  // Toggling can collapse a sibling above, shifting this header — pin its
  // viewport position so the user's view doesn't jump.
  useLayoutEffect(() => {
    if (pinnedTop.current === null || !headerRef.current) return
    const delta = headerRef.current.getBoundingClientRect().top - pinnedTop.current
    pinnedTop.current = null
    if (Math.abs(delta) > 1) window.scrollBy(0, delta)
  }, [isOpen])

  return (
    <div
      className={
        className ??
        'rounded-xl border border-slate-700 bg-slate-800'
      }
      data-watermark={watermark || undefined}
      style={style}
    >
      <div ref={headerRef} onClick={(e) => toggle(e.currentTarget)} className="flex w-full cursor-pointer items-center justify-between p-4 hover:bg-slate-700">
        <div
          className="min-w-0 flex-1 text-left"
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggle()
            }
          }}
        >
          {title}
        </div>
        {actions && (
          // Actions are interactive controls, not part of the toggle surface —
          // their clicks must not bubble up to the header's toggle handler.
          <div className="contents" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
        <button
          type="button"
          onClick={(e) => {
            // The header div also toggles on click — without stopping
            // propagation this button would fire toggle() twice.
            e.stopPropagation()
            toggle(e.currentTarget)
          }}
          className="ml-4 text-2xl leading-none text-slate-400"
          aria-label={isOpen ? 'Collapse' : 'Expand'}
        >
          {isOpen ? '−' : '+'}
        </button>
      </div>
      {isOpen && <div className="px-2 md:px-5 py-5 border-t border-slate-700">{children}</div>}
    </div>
  )
}
