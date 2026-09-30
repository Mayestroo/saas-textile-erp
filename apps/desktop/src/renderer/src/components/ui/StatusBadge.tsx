export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface StatusBadgeProps {
  children: React.ReactNode
  tone?: StatusTone
  className?: string
}

export function StatusBadge({ children, tone = 'neutral', className = '' }: StatusBadgeProps): React.JSX.Element {
  return (
    <span className={['ui-status-badge', `ui-status-badge--${tone}`, className].filter(Boolean).join(' ')}>
      <span className="ui-status-badge__dot" aria-hidden="true" />
      {children}
    </span>
  )
}
