import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  subtitle?: string
  description?: string
  children?: ReactNode
  onTitleClick?: () => void
}

export function PageHeader({ title, subtitle, description, children, onTitleClick }: PageHeaderProps) {
  return (
    <header className="border-b border-slate-800 pb-6">
      {subtitle && (
        <p className="mb-1 text-xs font-bold uppercase tracking-widest text-positive">
          {subtitle}
        </p>
      )}
      <h1 className="flex items-center gap-2 text-3xl font-bold">
        {onTitleClick ? (
          <span
            role="button"
            tabIndex={0}
            onClick={onTitleClick}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onTitleClick()
              }
            }}
            className="cursor-pointer hover:text-indigo-400"
            title="Click to refresh"
          >
            {title}
          </span>
        ) : (
          title
        )}
        {children}
      </h1>
      {description && (
        <p className="mt-2 text-slate-400">{description}</p>
      )}
    </header>
  )
}
