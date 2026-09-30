import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { DesktopModelOption, DesktopPattaSheetHistoryItem } from '../../../preload/erp-api'
import type { PattaSheetProjectionV3 } from '@textile/sync-protocol'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'

function displayDate(value: string | null): string {
  if (!value) return '—'
  return `${value.slice(0, 10)} · ${value.slice(11, 16)} UTC`
}

export function PattaTrashPage(): React.JSX.Element {
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [entries, setEntries] = useState<readonly DesktopPattaSheetHistoryItem[]>([])
  const [loadedModelId, setLoadedModelId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busySheetId, setBusySheetId] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<readonly string[]>([])
  const [purgeTarget, setPurgeTarget] = useState<PattaSheetProjectionV3 | null>(null)
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null)

  const canRestore = permissions.includes('patta_varaq.restore')
  const canPurge = permissions.includes('patta_varaq.purge')

  useEffect(() => {
    let active = true
    void Promise.all([window.erp.pattaSheet.historyModels(), window.erp.auth.session()]).then(([result, session]) => {
      if (!active) return
      setModels(result)
      setModelId(result[0]?.id ?? '')
      setPermissions(session.permission_codes)
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

  const refresh = async (targetModelId: string, successMessage?: string): Promise<void> => {
    if (!targetModelId) return
    try {
      const result = await window.erp.pattaSheet.history(targetModelId, true)
      setEntries(result.filter(({ sheet }) => sheet.deleted_at !== null))
      setLoadedModelId(targetModelId)
      setMessage(successMessage ?? null)
    } catch (error) {
      setLoadedModelId(targetModelId)
      setMessage(error instanceof Error ? error.message : 'Korzinkani olib bo‘lmadi')
    }
  }

  const restore = async (entry: DesktopPattaSheetHistoryItem): Promise<void> => {
    setBusySheetId(entry.sheet.id)
    try {
      await window.erp.pattaSheet.restore(entry.sheet.id, entry.sheet.version)
      await refresh(modelId, 'Varaq tiklandi')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Varaqni tiklab bo‘lmadi')
    } finally {
      setBusySheetId(null)
    }
  }

  const confirmPurge = async (): Promise<void> => {
    if (!purgeTarget || busySheetId !== null) return
    setBusySheetId(purgeTarget.id)
    try {
      await window.erp.pattaSheet.purge(purgeTarget.id, purgeTarget.version)
      setPurgeTarget(null)
      await refresh(modelId, 'Varaq butunlay o‘chirildi; asl Patta saqlandi')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Varaqni butunlay o‘chirib bo‘lmadi')
      setPurgeTarget(null)
    } finally {
      setBusySheetId(null)
    }
  }

  return (
    <section className="patta-entry-page trash-page" aria-label="Korzinka" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        id="patta-trash-title"
        eyebrow="ISHLAB CHIQARISH / KORZINKA"
        title="Korzinka"
        description="Varaqlarni tiklang yoki butunlay o‘chiring. Asl Pattalar saqlanadi."
      />

      {/* Control bar */}
      <div
        style={{
          padding: '10px 16px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-lg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '12px',
          boxShadow: 'var(--shadow-sm)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label className="print-field entry-model-filter" style={{ margin: 0 }}>
            <span className="print-label" style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>MODEL</span>
            <select
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={models.length === 0}
              className="soft-input"
              style={{ height: '34px', minWidth: '160px', fontWeight: 600 }}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: '#dc2626', background: '#fee2e2', padding: '4px 12px', borderRadius: 'var(--radius-full)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Trash2 size={13} />
            <span>O‘chirilganlar: <strong>{entries.length} ta</strong></span>
          </span>
        </div>
      </div>

      {message ? <p className="print-status-message" role="status">{message}</p> : null}

      {!modelId ? (
        <EmptyState title="Modelni tanlang" />
      ) : loadedModelId !== modelId ? (
        <p className="entry-empty-state" role="status">Yuklanmoqda…</p>
      ) : entries.length === 0 ? (
        <EmptyState title="Korzinka bo‘sh" description="O‘chirilgan Entry’lar shu yerda ko‘rinadi." />
      ) : (
        <div className="excel-grid-container trash-table-wrap" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)' }}>
          <table className="excel-table history-table trash-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-surface-subtle)' }}>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>O‘chirilgan sana</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>Kiritilgan sana</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Partiya</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Patta</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>Model</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'right', borderBottom: '1px solid var(--border-subtle)' }}>Ish soni</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>O‘chirgan foydalanuvchi</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Amallar</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isHovered = hoveredRowId === entry.sheet.id
                return (
                  <tr
                    key={entry.sheet.id}
                    className="fast-row"
                    onMouseEnter={() => setHoveredRowId(entry.sheet.id)}
                    onMouseLeave={() => setHoveredRowId(null)}
                    style={{
                      backgroundColor: isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)',
                      transition: 'background-color 0.12s ease'
                    }}
                  >
                    <td style={{ padding: '8px 12px', fontSize: '12px', color: '#dc2626', fontWeight: 600, borderBottom: '1px solid var(--border-subtle)' }}>
                      {displayDate(entry.sheet.deleted_at)}
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {displayDate(entry.sheet.entered_at)}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700, color: '#4f46e5', borderBottom: '1px solid var(--border-subtle)' }}>
                      {entry.sheet.partiya_number_snapshot ?? 'Noma’lum'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700, borderBottom: '1px solid var(--border-subtle)' }}>
                      {entry.sheet.patta_number_snapshot ?? 'Noma’lum'}
                    </td>
                    <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {entry.sheet.model_name_snapshot}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 700, color: 'var(--primary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {new Intl.NumberFormat('uz-UZ').format(entry.sheet.ish_soni)} dona
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {entry.sheet.deleted_by_name_snapshot ?? 'Noma’lum'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '6px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                      <div className="trash-row-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                        {canRestore ? (
                          <Button disabled={busySheetId !== null} onClick={() => void restore(entry)}>
                            {busySheetId === entry.sheet.id ? 'Bajarilmoqda…' : 'Qayta tiklash'}
                          </Button>
                        ) : null}
                        {canPurge ? (
                          <Button disabled={busySheetId !== null} onClick={() => setPurgeTarget(entry.sheet)} variant="danger">
                            Butunlay o‘chirish
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={purgeTarget !== null}
        title="Butunlay o‘chirish"
        description={<>Bu amalni ortga qaytarib bo‘lmaydi. <b>{purgeTarget?.model_name_snapshot}</b> Entry yozuvi butunlay o‘chadi, asl Patta saqlanadi.</>}
        confirmLabel="Butunlay o‘chirish"
        busy={busySheetId !== null}
        onCancel={() => setPurgeTarget(null)}
        onConfirm={() => void confirmPurge()}
      />
    </section>
  )
}
