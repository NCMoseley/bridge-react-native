import type { CSSProperties, ReactNode } from 'react'

interface CardProps {
  title?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  shape?: 'rounded' | 'scoop' | 'notch'
}

const scoopStyle = { borderRadius: '1.5rem', cornerShape: 'scoop' } as unknown as CSSProperties

const notchStyle = { borderRadius: '1.5rem', cornerShape: 'notch' } as unknown as CSSProperties

export function Card({
  title,
  right,
  children,
  className = '',
  shape = 'rounded',
}: CardProps) {
  return (
    <div
      className={`min-w-0 rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-sm ${className}`}
      style={shape === 'scoop' ? scoopStyle : shape === 'notch' ? notchStyle : undefined}
    >
      {title && (
        <div className="mb-4 flex items-center justify-between gap-4">
          <h3 className="break-words text-lg font-semibold text-slate-100">
            {title}
          </h3>
          {right}
        </div>
      )}
      {children}
    </div>
  )
}
