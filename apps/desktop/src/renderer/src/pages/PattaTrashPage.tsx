import { useEffect, useState } from 'react'
import type { DesktopModelOption, DesktopPattaSheetHistoryItem } from '../../../preload/erp-api'

function displayDate(value: string): string {
  return `${value.slice(0, 10)} · ${value.slice(11, 16)} UTC`
}

export function PattaTrashPage(): React.JSX.Element {
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [entries, setEntries] = useState<readonly DesktopPattaSheetHistoryItem[]>([])
  const [loadedModelId, setLoadedModelId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busySheetId, setBusySheetId] = useState<string | null>(null)

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
    if (!modelId) return
    let active = true
    void window.erp.pattaSheet.history(modelId, true).then((result) => {
      if (!active) return
      setEntries(result.filter(({ sheet }) => sheet.deleted_at !== null))
      setLoadedModelId(modelId)
      setMessage(null)
    }).catch((error: unknown) => {
      if (!active) return
      setLoadedModelId(modelId)
      setMessage(error instanceof Error ? error.message : 'Korzinkani olib bo‘lmadi')
    })
    return () => { active = false }
  }, [modelId])

  const refresh = async (targetModelId: string): Promise<void> => {
    if (!targetModelId) return
    try {
      const result = await window.erp.pattaSheet.history(targetModelId, true)
      setEntries(result.filter(({ sheet }) => sheet.deleted_at !== null))
      setLoadedModelId(targetModelId)
      setMessage(null)
    } catch (error) {
      setLoadedModelId(targetModelId)
      setMessage(error instanceof Error ? error.message : 'Korzinkani olib bo‘lmadi')
    }
  }

  const restore = async (entry: DesktopPattaSheetHistoryItem): Promise<void> => {
    setBusySheetId(entry.sheet.id)
    try {
      await window.erp.pattaSheet.restore(entry.sheet.id, entry.sheet.version)
      setMessage('Varaq tiklandi')
      await refresh(modelId)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Varaqni tiklab bo‘lmadi')
    } finally {
      setBusySheetId(null)
    }
  }

  const purge = async (entry: DesktopPattaSheetHistoryItem): Promise<void> => {
    if (!window.confirm('Varaq va uning qatorlari butunlay o‘chiriladi. Asl Patta saqlanadi. Davom etilsinmi?')) return
    setBusySheetId(entry.sheet.id)
    try {
      await window.erp.pattaSheet.purge(entry.sheet.id, entry.sheet.version)
      setMessage('Varaq butunlay o‘chirildi; asl Patta saqlandi')
      await refresh(modelId)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Varaqni butunlay o‘chirib bo‘lmadi')
    } finally {
      setBusySheetId(null)
    }
  }

  return (
    <section className="patta-entry-page" aria-labelledby="patta-trash-title">
      <header className="print-page-heading">
        <div>
          <p className="print-kicker"><span className="print-kicker-mark" /> ISHLAB CHIQARISH / KORZINKA</p>
          <h2 id="patta-trash-title">Korzinka</h2>
          <p className="print-intro">Varaqlarni tiklang yoki ularning yozuvlarini butunlay o‘chiring. Asl Pattalar saqlanadi.</p>
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
        <p className="entry-empty-state">Korzinkada varaq yo‘q.</p>
      ) : (
        <div className="entry-history-list">
          {entries.map((entry) => (
            <article className="entry-history-card entry-trash-card" key={entry.sheet.id}>
              <div className="entry-history-main">
                <strong>{entry.patta.partiya_number} / {entry.patta.patta_number}</strong>
                <span>{entry.sheet.deleted_at ? displayDate(entry.sheet.deleted_at) : '—'}</span>
                <span>{entry.patta.razmer ?? '—'} · {entry.patta.ish_soni ?? 'Noma’lum'} dona</span>
              </div>
              <p className="entry-history-meta">Kiritilgan sana: {entry.sheet.business_date} · Varaq v{entry.sheet.version}</p>
              <div className="entry-actions">
                <button className="save-batch-button" type="button" disabled={busySheetId !== null}
                  onClick={() => void restore(entry)}>
                  {busySheetId === entry.sheet.id ? 'Bajarilmoqda…' : 'Tiklash'}
                </button>
                <button className="entry-trash-button entry-purge-button" type="button" disabled={busySheetId !== null}
                  onClick={() => void purge(entry)}>
                  Butunlay o‘chirish
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
