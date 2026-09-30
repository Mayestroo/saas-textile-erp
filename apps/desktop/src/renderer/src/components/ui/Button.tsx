import { forwardRef } from 'react'
import type { ButtonHTMLAttributes } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  className = '',
  type = 'button',
  variant = 'secondary',
  ...props
}, ref): React.JSX.Element {
  const classes = ['ui-button', `ui-button--${variant}`, className].filter(Boolean).join(' ')
  return <button {...props} className={classes} ref={ref} type={type}>{children}</button>
})
