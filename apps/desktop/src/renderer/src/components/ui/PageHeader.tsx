import type { ReactNode } from 'react'

export interface PageHeaderProps {
  id?: string
  title: string
  description?: string
  eyebrow?: string
  actions?: ReactNode
}

export function PageHeader({ id, title, description, eyebrow, actions }: PageHeaderProps): React.JSX.Element {
  return (
    <header className="ui-page-header">
      <div className="ui-page-header__copy">
        {eyebrow ? <p className="ui-page-header__eyebrow">{eyebrow}</p> : null}
        <h1 className="ui-page-header__title" id={id}>{title}</h1>
        {description ? <p className="ui-page-header__description">{description}</p> : null}
      </div>
      {actions ? <div className="ui-page-header__actions">{actions}</div> : null}
    </header>
  )
}
