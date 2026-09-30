import { useEffect, useMemo, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { DesktopPattaPrintBatchResult } from '../../../preload/erp-api'
import { Button } from './ui/Button'

export interface PattaPrintPreviewProps {
  batch: DesktopPattaPrintBatchResult
  printing: boolean
  onClose(): void
  onPrint(): void
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('uz-UZ').format(value)
}

function formatPrintDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function PattaPrintPreview({ batch, printing, onClose, onPrint }: PattaPrintPreviewProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const printRef = useRef<HTMLButtonElement>(null)
  const pages = useMemo(() => {
    const pattas = batch.pattas.filter((patta) => patta.status === 'ACTIVE')
    pattas.sort((left, right) => {
        const leftNumber = BigInt(left.patta_number)
        const rightNumber = BigInt(right.patta_number)
        return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
      })
    const result: typeof pattas[] = []
    for (let index = 0; index < pattas.length; index += 2) result.push(pattas.slice(index, index + 2))
    return result
  }, [batch.pattas])
  const sizeSummary = batch.size_distribution.map((size) => `${size.razmer} ${formatCount(size.patta_count)} pachka`).join(' · ')

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => previousFocus?.focus()
  }, [])

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Tab' && !printing) {
      if (event.shiftKey && document.activeElement === printRef.current) {
        event.preventDefault()
        closeRef.current?.focus()
      } else if (!event.shiftKey && document.activeElement === closeRef.current) {
        event.preventDefault()
        printRef.current?.focus()
      }
      return
    }
    if (event.key === 'Escape' && !printing) {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className="print-preview-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !printing) onClose()
    }}>
      <section className="print-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="print-preview-title" onKeyDown={handleDialogKeyDown}>
        <header className="print-preview-toolbar">
          <div>
            <p className="print-kicker">SAQLANGAN MA’LUMOT · KO‘RIB CHIQISH</p>
            <h2 id="print-preview-title">Pechat ko‘rinishi</h2>
            <p>{batch.model_name_snapshot} · Partiya № {batch.partiya_number} · {formatCount(batch.ish_soni)} dona</p>
          </div>
          <div className="print-preview-toolbar__actions">
            <Button ref={printRef} disabled={printing || pages.length === 0} onClick={onPrint} variant="primary">
              {printing ? 'Pechat qilinmoqda…' : 'Pechat qilish'}
            </Button>
            <Button ref={closeRef} disabled={printing} onClick={onClose}>Yopish</Button>
          </div>
        </header>
        <div className="print-preview-summary" aria-label="Bosma to‘plami xulosasi">
          <span><small>JAMI PACHKA</small><strong>{formatCount(batch.pattas.filter((patta) => patta.status === 'ACTIVE').length)}</strong></span>
          <span><small>RAZMER TAQSIMOTI</small><strong>{sizeSummary || '—'}</strong></span>
          {batch.revision > 1 ? <span className="print-preview-revision">Tuzatilgan nusxa · {batch.revision}-tahrir</span> : null}
        </div>
        <div className="print-preview-pages">
          {pages.length === 0 ? <p className="ui-empty-state">Faol Patta topilmadi.</p> : pages.map((pagePattas, pageIndex) => (
            <article className="print-preview-page" key={pagePattas[0]?.id ?? pageIndex} aria-label={`A4 sahifa ${pageIndex + 1}`}>
              <div className="print-preview-page__number">A4 · {pageIndex + 1} / {pages.length}</div>
              <div className="print-preview-page__slips">
                {pagePattas.map((patta) => (
                  <section className="print-preview-slip" key={patta.id}>
                    <div className="print-preview-slip__brand"><span>ISHLAB CHIQARISH</span><b>PATTA</b></div>
                    <h3>{batch.model_name_snapshot}</h3>
                    <div className="print-preview-slip__identity">
                      <span><small>PARTIYA №</small><strong>{batch.partiya_number}</strong></span>
                      <span><small>PATTA №</small><strong>{patta.patta_number}</strong></span>
                    </div>
                    <div className="print-preview-slip__quantity"><span>ISH SONI</span><strong>{formatCount(patta.ish_soni ?? batch.ish_soni)} <small>dona</small></strong></div>
                    <div className="print-preview-slip__details">
                      <span><small>RAZMER</small><strong>{patta.razmer ?? '—'}</strong></span>
                      <span><small>RANG</small><strong>{patta.rang ?? batch.rang}</strong></span>
                      <span><small>CHOP ETILDI</small><strong>{formatPrintDate(batch.printed_at ?? batch.created_at)}</strong></span>
                    </div>
                    <div className="print-preview-slip__operations" role="table" aria-label="Patta operatsiyalari">
                      <div className="print-preview-slip__operation-head" role="row">
                        <span role="columnheader">№</span><span role="columnheader">Operatsiya</span>
                        <span role="columnheader">Narx</span><span role="columnheader">Jeton</span>
                      </div>
                      {[...patta.operations]
                        .sort((left, right) => left.sort_order - right.sort_order || left.operation_id.localeCompare(right.operation_id))
                        .map((operation, index) => (
                        <div className="print-preview-slip__operation" role="row" key={operation.id}>
                          <span role="cell">{index + 1}</span>
                          <span role="cell">{operation.operation_name_snapshot}</span>
                          <span role="cell">{operation.unit_price_snapshot} so‘m</span>
                          <span className="print-preview-slip__badge-slot" role="cell" aria-label="Jeton kiritish joyi" />
                        </div>
                      ))}
                    </div>
                    <footer>Jetonni har bir operatsiya bajarilganda kiriting.</footer>
                  </section>
                ))}
                {pagePattas.length === 1 ? <div className="print-preview-slip print-preview-slip--blank" aria-hidden="true" /> : null}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
