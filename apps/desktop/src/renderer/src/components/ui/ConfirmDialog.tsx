import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Button } from './Button'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  busy?: boolean
  danger?: boolean
  onConfirm(): void | Promise<void>
  onCancel(): void
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  danger = true,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    confirmRef.current?.focus()
    return () => previousFocus?.focus()
  }, [open])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onCancel()
      return
    }
    if (event.key !== 'Tab') return
    if (event.shiftKey && document.activeElement === cancelRef.current) {
      event.preventDefault()
      confirmRef.current?.focus()
    } else if (!event.shiftKey && document.activeElement === confirmRef.current) {
      event.preventDefault()
      cancelRef.current?.focus()
    }
  }

  if (!open) return null

  return (
    <div className="ui-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel()
    }}>
      <section
        aria-labelledby="ui-confirm-title"
        aria-describedby="ui-confirm-description"
        aria-modal="true"
        className="ui-confirm-dialog"
        onKeyDown={handleKeyDown}
        role={danger ? 'alertdialog' : 'dialog'}
      >
        <div className="ui-confirm-dialog__mark" aria-hidden="true">!</div>
        <h2 id="ui-confirm-title">{title}</h2>
        <div className="ui-confirm-dialog__description" id="ui-confirm-description">{description}</div>
        <div className="ui-confirm-dialog__actions">
          <Button ref={cancelRef} disabled={busy} onClick={onCancel}>Bekor qilish</Button>
          <Button ref={confirmRef} variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={() => void onConfirm()}>
            {busy ? 'Bajarilmoqda…' : confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  )
}
