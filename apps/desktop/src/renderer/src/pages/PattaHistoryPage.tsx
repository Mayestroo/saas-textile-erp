import { useEffect, useState } from 'react'
import type { DesktopModelOption, DesktopPattaSheetHistoryItem } from '../../../preload/erp-api'

function displayDate(value: string): string {
  return `${value.slice(0, 10)} · ${value.slice(11, 16)} UTC`
}

export function PattaHistoryPage(): React.JSX.Element {
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [entries, setEntries] = useState<readonly DesktopPattaSheetHistoryItem[]>([])
  const [loadedModelId, setLoadedModelId] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.erp.pattaSheet.models().then((result) => {
      if (!active) return
      setModels(result)
      setModelId(result[0]?.id ?? '')
    }).catch(() => {
      if (active) setMessage('Modellar ro‘yxatini olib bo‘lmadi')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!modelId) {
      return
    }
    let active = true
    void window.erp.pattaSheet.history(modelId, false).then((result) => {
      if (!active) return
      setEntries(result.filter(({ sheet }) => sheet.deleted_at === null))
      setLoadedModelId(modelId)
      setMessage(null)
    }).catch((error: unknown) => {
      if (!active) return
      setLoadedModelId(modelId)
      setMessage(error instanceof Error ? error.message : 'Varaqlar tarixini olib bo‘lmadi')
    })
    return () => { active = false }
  }, [modelId])

  return (
    <section className="patta-entry-page" aria-labelledby="patta-history-title">
      <header className="print-page-heading">
        <div>
          <p className="print-kicker"><span className="print-kicker-mark" /> ISHLAB CHIQARISH / TARIX</p>
          <h2 id="patta-history-title">Kiritilgan Pattalar</h2>
          <p className="print-intro">Faol varaq yozuvlari va ularning saqlangan operatsiya snapshotlari.</p>
        </div>
      </header>
      <label className="print-field entry-model-filter">
        <span className="print-label">MODEL</span>
        <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={models.length === 0}>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {message ? <p className="print-status-message" role="status">{message}</p> : null}
      {!modelId ? <p className="entry-empty-state">Modelni tanlang.</p> : loadedModelId !== modelId ? <p className="entry-empty-state">Yuklanmoqda…</p> : entries.length === 0 ? (
        <p className="entry-empty-state">Bu model uchun faol varaq topilmadi.</p>
      ) : (
        <div className="entry-history-list">
          {entries.map(({ patta, sheet, rows }) => {
            const activeRows = sheet.rows.filter((row) => row.deleted_at === null)
            const detailsByRowId = new Map(rows.map((row) => [row.row_id, row]))
            return (
              <article className="entry-history-card" key={sheet.id}>
                <div className="entry-history-main">
                  <strong>{patta.partiya_number} / {patta.patta_number}</strong>
                  <span>{displayDate(sheet.entered_at)}</span>
                  <span>{patta.razmer ?? '—'} · {patta.ish_soni ?? 'Noma’lum'} dona</span>
                </div>
                <div className="entry-history-operations">
                  {sheet.operation_snapshots.map((operation) => {
                    const row = activeRows.find((item) => item.patta_sheet_operation_snapshot_id === operation.id)
                    return (
                      <span key={operation.id}>
                        {operation.operation_name_snapshot}: {row
                          ? `${detailsByRowId.get(row.id)?.worker_name ?? `Ishchi ${row.worker_id}`}${row.nuqson ? ' · Nuqson' : ''}`
                          : '—'}
                      </span>
                    )
                  })}
                </div>
                <p className="entry-history-meta">Kiritilgan sana: {sheet.business_date} · Varaq v{sheet.version}</p>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
