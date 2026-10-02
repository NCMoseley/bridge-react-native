interface LoadingSpinnerProps {
  className?: string
  size?: number
}

export function LoadingSpinner({ className = '', size = 16 }: LoadingSpinnerProps) {
  return (
    <div
      className={`inline-block animate-spin rounded-full border-2 border-slate-600 border-t-indigo-500 ${className}`}
      style={{ width: size, height: size }}
    />
  )
}
