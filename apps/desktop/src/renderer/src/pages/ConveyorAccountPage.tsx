import { useEffect, useMemo, useState } from 'react'

import type { ConveyorAccountRow } from '@textile/sync-protocol'
import { PageHeader } from '../components/ui/PageHeader'

function formatQuantity(value: string): string {
  return /^(0|[1-9][0-9]*)$/.test(value) ? new Intl.NumberFormat('uz-UZ').format(BigInt(value)) : value
}

export function ConveyorAccountPage(): React.JSX.Element {
  const [rows, setRows] = useState<readonly ConveyorAccountRow[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    void window.erp.modelAccount.conveyorAccount().then((result) => {
      if (!active) return
      setRows(result)
      setLoaded(true)
      setMessage(null)
    }).catch((error: unknown) => {
      if (!active) return
      setLoaded(true)
      setMessage(error instanceof Error ? error.message : 'Konveyer hisobini olib bo‘lmadi')
    })
    return () => { active = false }
  }, [])

  const totals = useMemo(() => rows.reduce((sum, row) => ({
    pattas: sum.pattas + BigInt(row.patta_count),
    standalone: sum.standalone + BigInt(row.standalone_entry_count),
    manual: sum.manual + BigInt(row.manual_adjustment_count),
    quantity: sum.quantity + BigInt(row.ish_soni)
  }), { pattas: 0n, standalone: 0n, manual: 0n, quantity: 0n }), [rows])

  return (
    <section className="patta-entry-page" aria-labelledby="conveyor-account-title" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        id="conveyor-account-title"
        eyebrow="ISHLAB CHIQARISH / KONVEYER"
        title="Konveyer hisobi"
        description="Har bir Patta yoki Entry miqdori bir marta hisoblanadi; qo‘lda qo‘shilganlar alohida sanaladi."
      />

      {/* KPI Stats Cards matching hisob KonveyerView */}
      {loaded && rows.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px',
            marginBottom: '16px'
          }}
        >
          <div
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '12px 16px',
              boxShadow: 'var(--shadow-sm)'
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700, marginBottom: '4px' }}>
              JAMI PATTA
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#4f46e5' }}>
              {formatQuantity(totals.pattas.toString())} ta
            </div>
          </div>

          <div
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '12px 16px',
              boxShadow: 'var(--shadow-sm)'
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700, marginBottom: '4px' }}>
              MUSTAQIL ENTRY
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>
              {formatQuantity(totals.standalone.toString())} ta
            </div>
          </div>

          <div
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-lg)',
              padding: '12px 16px',
              boxShadow: 'var(--shadow-sm)'
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700, marginBottom: '4px' }}>
              QO‘LDA QO‘SHILGAN
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: '#b45309' }}>
              {formatQuantity(totals.manual.toString())} ta
            </div>
          </div>

          <div
            style={{
              background: 'var(--primary-light)',
              border: '1px solid rgba(16, 185, 129, 0.3)',
              borderRadius: 'var(--radius-lg)',
              padding: '12px 16px',
              boxShadow: 'var(--shadow-sm)'
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 700, marginBottom: '4px' }}>
              JAMI ISH SONI
            </div>
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--primary)' }}>
              {formatQuantity(totals.quantity.toString())} dona
            </div>
          </div>
        </div>
      ) : null}

      {message ? <p className="print-status-message" role="status">{message}</p> : null}

      {!loaded ? (
        <p className="entry-empty-state">Hisob yangilanmoqda…</p>
      ) : rows.length === 0 ? (
        <p className="entry-empty-state">Faol ishlab chiqarish yozuvi topilmadi.</p>
      ) : (
        <div className="excel-grid-container model-account-table-wrap" style={{ flex: 1, overflow: 'auto', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)' }}>
          <table className="excel-table model-account-table conveyor-account-table" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
            <thead>
              <tr style={{ backgroundColor: 'var(--bg-surface-subtle)' }}>
                <th scope="col" style={{ padding: '8px 14px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>KONVEYER</th>
                <th scope="col" style={{ padding: '8px 14px', textAlign: 'left', borderBottom: '1px solid var(--border-subtle)' }}>MODEL</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>PATTA SONI</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>MUSTAQIL ENTRY</th>
                <th scope="col" style={{ padding: '8px 12px', textAlign: 'center', borderBottom: '1px solid var(--border-subtle)' }}>QO‘LDA QO‘SHILGAN</th>
                <th scope="col" className="model-account-total" style={{ padding: '8px 14px', textAlign: 'right', borderBottom: '1px solid var(--border-subtle)', borderLeft: '2px solid var(--primary)', backgroundColor: 'var(--primary-light)', color: 'var(--primary)', fontWeight: 800 }}>
                  ISH SONI
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const isHovered = hoveredIndex === idx
                return (
                  <tr
                    key={`${row.conveyor_label}-${row.model_id}`}
                    className="fast-row"
                    onMouseEnter={() => setHoveredIndex(idx)}
                    onMouseLeave={() => setHoveredIndex(null)}
                    style={{
                      backgroundColor: isHovered ? 'var(--bg-surface-hover)' : 'var(--bg-surface)',
                      transition: 'background-color 0.12s ease'
                    }}
                  >
                    <th scope="row" style={{ textAlign: 'left', padding: '8px 14px', fontWeight: 700, borderBottom: '1px solid var(--border-subtle)' }}>
                      <span style={{ background: 'var(--bg-surface-subtle)', padding: '3px 10px', borderRadius: 'var(--radius-full)', fontSize: '12px' }}>
                        {row.conveyor_label}
                      </span>
                    </th>
                    <td style={{ padding: '8px 14px', fontWeight: 600, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)' }}>
                      {row.model_name}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                      {formatQuantity(row.patta_count)}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                      {formatQuantity(row.standalone_entry_count)}
                    </td>
                    <td style={{ textAlign: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                      {formatQuantity(row.manual_adjustment_count)}
                    </td>
                    <td className="model-account-total" style={{ textAlign: 'right', padding: '8px 14px', borderLeft: '2px solid var(--primary)', borderBottom: '1px solid var(--border-subtle)', fontWeight: 700, color: 'var(--primary)', backgroundColor: 'var(--primary-light)' }}>
                      {formatQuantity(row.ish_soni)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', fontWeight: 700 }}>
                <th scope="row" colSpan={2} style={{ padding: '10px 14px', textAlign: 'left', borderTop: '1px solid var(--border-subtle)' }}>
                  Jami
                </th>
                <td style={{ textAlign: 'center', padding: '10px 12px', borderTop: '1px solid var(--border-subtle)' }}>
                  {formatQuantity(totals.pattas.toString())}
                </td>
                <td style={{ textAlign: 'center', padding: '10px 12px', borderTop: '1px solid var(--border-subtle)' }}>
                  {formatQuantity(totals.standalone.toString())}
                </td>
                <td style={{ textAlign: 'center', padding: '10px 12px', borderTop: '1px solid var(--border-subtle)' }}>
                  {formatQuantity(totals.manual.toString())}
                </td>
                <td className="model-account-total" style={{ textAlign: 'right', padding: '10px 14px', borderLeft: '2px solid var(--primary)', borderTop: '1px solid var(--border-subtle)', color: 'var(--primary)', fontWeight: 800 }}>
                  {formatQuantity(totals.quantity.toString())}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}
