import type { ReactNode } from 'react'

interface BadgeProps {
  children: ReactNode
  status?: 'online' | 'offline' | 'warning'
}

const styles = {
  online: 'bg-positive-900 text-positive-100',
  offline: 'bg-slate-800 text-slate-300',
  warning: 'bg-amber-900 text-amber-100',
}

export function Badge({ children, status = 'online' }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {children}
    </span>
  )
}
