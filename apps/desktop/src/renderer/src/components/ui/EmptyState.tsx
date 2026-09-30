export interface EmptyStateProps {
  title: string
  description?: string
}

export function EmptyState({ title, description }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="ui-empty-state" role="status">
      <span className="ui-empty-state__mark" aria-hidden="true">—</span>
      <strong>{title}</strong>
      {description ? <span>{description}</span> : null}
    </div>
  )
}
