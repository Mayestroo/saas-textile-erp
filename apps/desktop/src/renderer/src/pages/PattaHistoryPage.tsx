import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { DesktopModelOption, DesktopPattaSheetHistoryItem } from '../../../preload/erp-api'
import type { PattaSheetProjectionV3 } from '@textile/sync-protocol'
import { Button } from '../components/ui/Button'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { PageHeader } from '../components/ui/PageHeader'

function displayDate(value: string): string {
  return `${value.slice(0, 10)} · ${value.slice(11, 16)} UTC`
}

export interface PattaHistoryPageProps {
  onEdit(sheetId: string): void
}

export function PattaHistoryPage({ onEdit }: PattaHistoryPageProps): React.JSX.Element {
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [entries, setEntries] = useState<readonly DesktopPattaSheetHistoryItem[]>([])
  const [loadedModelId, setLoadedModelId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [canDelete, setCanDelete] = useState(false)
  const [trashTarget, setTrashTarget] = useState<PattaSheetProjectionV3 | null>(null)
  const [isTrashing, setIsTrashing] = useState(false)
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([window.erp.pattaSheet.historyModels(), window.erp.auth.session()]).then(([result, session]) => {
      if (!active) return
      setModels(result)
      setModelId(result[0]?.id ?? '')
      setCanEdit(session.permission_codes.includes('patta_varaq.edit'))
      setCanDelete(session.permission_codes.includes('patta_varaq.delete'))
    }).catch(() => {
      if (active) setMessage('Modellar ro‘yxatini olib bo‘lmadi')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!modelId) return
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

  const visibleEntries = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    if (!query) return entries
    return entries.filter(({ sheet, rows }) => {
      const values = [
        sheet.business_date,
        sheet.entered_at,
        sheet.partiya_number_snapshot,
        sheet.patta_number_snapshot,
        sheet.model_name_snapshot,
        sheet.razmer_snapshot,
        sheet.rang_snapshot,
        sheet.conveyor_snapshot,
        ...rows.flatMap((row) => [row.worker_id, row.worker_name])
      ]
      return values.some((value) => value?.toLocaleLowerCase().includes(query))
    })
  }, [entries, search])

  const confirmTrash = async (): Promise<void> => {
    if (!trashTarget || isTrashing) return
    setIsTrashing(true)
    try {
      await window.erp.pattaSheet.trash(trashTarget.id, trashTarget.version)
      const refreshed = await window.erp.pattaSheet.history(modelId, false)
      setEntries(refreshed.filter(({ sheet }) => sheet.deleted_at === null))
      setMessage('Varaq Korzinkaga yuborildi')
      setTrashTarget(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Varaqni Korzinkaga yuborib bo‘lmadi')
      setTrashTarget(null)
    } finally {
      setIsTrashing(false)
    }
  }

  return (
    <section className="patta-entry-page history-page" aria-label="Kiritilgan Pattalar" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        id="patta-history-title"
        eyebrow="ISHLAB CHIQARISH / TARIX"
        title="Kiritilgan Pattalar"
        description="Sana, model va ishchi bo‘yicha qidiring; o‘zgartirishlar joriy Entry xizmatlari orqali saqlanadi."
      />

      {/* Control bar matching hisob PattaHisobView */}
      <div
        className="history-toolbar"
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

          {/* Search Box */}
          <div style={{ position: 'relative', width: '280px' }}>
            <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: '10px', top: '10px' }} />
            <input
              type="search"
              aria-label="Tarixdan qidirish"
              placeholder="Partiya, Patta, model yoki ishchi"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="soft-input"
              style={{ paddingLeft: '32px', height: '34px', borderRadius: 'var(--radius-full)', fontSize: '12px' }}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', background: 'var(--bg-surface-subtle)', padding: '4px 12px', borderRadius: 'var(--radius-full)', fontWeight: 600 }}>
            Jami varaqlar: <strong>{visibleEntries.length} ta</strong>
          </span>
        </div>
      </div>

      {message ? <p className="print-status-message" role="status">{message}</p> : null}

      {!modelId ? (
        <EmptyState title="Modelni tanlang" />
      ) : loadedModelId !== modelId ? (
        <p className="entry-empty-state" role="status">Yuklanmoqda…</p>
      ) : visibleEntries.length === 0 ? (
        <EmptyState
          title={search ? 'Qidiruv bo‘yicha yozuv topilmadi' : 'Faol varaq topilmadi'}
          description={search ? 'Boshqa so‘z bilan qidiring.' : 'Yangi Patta yoki mustaqil Entry kiritilgach, shu yerda ko‘rinadi.'}
        />
      ) : (
        <div className="excel-grid-container history-table-wrap" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)' }}>
          <table className="excel-table history-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-surface-subtle)' }}>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>Sana</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Partiya</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Patta</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>Model</th>
                <th scope="col" style={{ padding: '8px 8px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Razmer</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Rang</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'right', borderBottom: '1px solid var(--border-subtle)' }}>Ish soni</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Konveyer</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>Tahrirlash</th>
                <th scope="col" style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>O‘chirish</th>
              </tr>
            </thead>
            <tbody>
              {visibleEntries.map(({ sheet }) => {
                const isHovered = hoveredRowId === sheet.id
                return (
                  <tr
                    key={sheet.id}
                    className="fast-row"
                    onMouseEnter={() => setHoveredRowId(sheet.id)}
                    onMouseLeave={() => setHoveredRowId(null)}
                    style={{
                      backgroundColor: isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)',
                      transition: 'background-color 0.12s ease'
                    }}
                  >
                    <td className="history-table__date" style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {displayDate(sheet.entered_at)}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700, color: '#4f46e5', borderBottom: '1px solid var(--border-subtle)' }}>
                      {sheet.partiya_number_snapshot ?? 'Noma’lum'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 10px', fontWeight: 700, borderBottom: '1px solid var(--border-subtle)' }}>
                      {sheet.patta_number_snapshot ?? 'Noma’lum'}
                    </td>
                    <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {sheet.model_name_snapshot}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 8px', borderBottom: '1px solid var(--border-subtle)' }}>
                      <span style={{ background: 'var(--bg-surface-subtle)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontSize: '11.5px', fontWeight: 600 }}>
                        {sheet.razmer_snapshot ?? '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 10px', color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {sheet.rang_snapshot ?? '—'}
                    </td>
                    <td className="history-table__quantity" style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 700, color: 'var(--primary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {new Intl.NumberFormat('uz-UZ').format(sheet.ish_soni)} dona
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                      {sheet.conveyor_snapshot ?? '—'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                      {canEdit ? (
                        <Button onClick={() => onEdit(sheet.id)} type="button">
                          Tahrirlash
                        </Button>
                      ) : '—'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                      {canDelete ? (
                        <Button onClick={() => setTrashTarget(sheet)} type="button" variant="danger">
                          O‘chirish
                        </Button>
                      ) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={trashTarget !== null}
        title="Varaqni Korzinkaga yuborish"
        description="Entry yozuvi Korzinkaga ko‘chiriladi. Asl Patta va tarixiy snapshotlar saqlanadi."
        confirmLabel="Korzinkaga yuborish"
        busy={isTrashing}
        onCancel={() => setTrashTarget(null)}
        onConfirm={() => void confirmTrash()}
      />
    </section>
  )
}
