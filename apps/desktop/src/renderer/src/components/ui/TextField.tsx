import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: ReactNode
}

export function TextField({ label, hint, id, className = '', ...props }: TextFieldProps): React.JSX.Element {
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const hintId = hint ? `${fieldId}-hint` : undefined
  const describedBy = [props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined

  return (
    <label className="ui-field" htmlFor={fieldId}>
      <span className="ui-field__label">{label}</span>
      <input {...props} id={fieldId} className={['ui-field__input', className].filter(Boolean).join(' ')} aria-describedby={describedBy} />
      {hint ? <span className="ui-field__hint" id={hintId}>{hint}</span> : null}
    </label>
  )
}
