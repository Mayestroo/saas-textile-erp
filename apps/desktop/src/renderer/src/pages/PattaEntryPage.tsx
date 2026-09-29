import { useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import type { DesktopPattaLookup, DesktopPattaSheetLookup } from '../../../preload/erp-api'
import type { PattaSheetProjection } from '@textile/sync-protocol'

interface EntryAssignment {
  operation_id: string
  badge_number: string
  nuqson: boolean
}

interface CustomOperationDraft {
  id: string
  name: string
  initial_price: string
}

function canonical(value: string): string {
  return value.replace(/[ \t\n\v\f\r]+/g, ' ').trim()
}

function formatQuantity(value: number | null): string {
  return value === null ? 'Noma’lum' : new Intl.NumberFormat('uz-UZ').format(value)
}

function formatMoney(value: string): string {
  const [whole, fraction = '00'] = value.split('.')
  if (!whole || !/^[0-9]+$/.test(whole) || !/^[0-9]{2}$/.test(fraction)) return `${value} so‘m`
  const formatted = new Intl.NumberFormat('uz-UZ').format(BigInt(whole))
  return `${fraction === '00' ? formatted : `${formatted},${fraction}`} so‘m`
}

export function PattaEntryPage(): React.JSX.Element {
  const [partiyaNumber, setPartiyaNumber] = useState('')
  const [pattaNumber, setPattaNumber] = useState('')
  const [patta, setPatta] = useState<DesktopPattaLookup | null>(null)
  const [sheet, setSheet] = useState<PattaSheetProjection | null>(null)
  const [sheetRows, setSheetRows] = useState<DesktopPattaSheetLookup['rows']>([])
  const [assignments, setAssignments] = useState<readonly EntryAssignment[]>([])
  const [conveyorSnapshot, setConveyorSnapshot] = useState('')
  const [badgeResolutions, setBadgeResolutions] = useState<Readonly<Record<string, { worker_id: string; full_name: string } | null>>>({})
  const [customOperations, setCustomOperations] = useState<readonly CustomOperationDraft[]>([])
  const [customOperationName, setCustomOperationName] = useState('')
  const [customOperationPrice, setCustomOperationPrice] = useState('')
  const [clearOperationIds, setClearOperationIds] = useState<readonly string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [isLookingUp, setIsLookingUp] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const badgeRefs = useRef<Array<HTMLInputElement | null>>([])

  const activeOperations = useMemo(() => {
    if (!sheet) return new Set<string>()
    const operationBySnapshotId = new Map(sheet.operation_snapshots.map((snapshot) => [snapshot.id, snapshot.model_operation_id]))
    return new Set(sheet.rows.filter((row) => row.deleted_at === null)
      .flatMap((row) => {
        const operationId = operationBySnapshotId.get(row.patta_sheet_operation_snapshot_id)
        return operationId ? [operationId] : []
      }))
  }, [sheet])
  const displayOperations = useMemo(() => sheet
    ? sheet.operation_snapshots.map((snapshot) => ({
        id: snapshot.model_operation_id,
        operation_name_snapshot: snapshot.operation_name_snapshot,
        unit_price_snapshot: snapshot.unit_price_snapshot
      }))
    : [
        ...(patta?.operations.map((operation) => ({
          id: operation.operation_id,
          operation_name_snapshot: operation.operation_name_snapshot,
          unit_price_snapshot: operation.unit_price_snapshot
        })) ?? []),
        ...customOperations.map((operation) => ({
          id: operation.id,
          operation_name_snapshot: operation.name,
          unit_price_snapshot: operation.initial_price
        }))
      ], [customOperations, patta, sheet])
  const canSave = useMemo(() => Boolean(
    patta && patta.status === 'ACTIVE' && patta.ish_soni !== null && assignments.length === displayOperations.length &&
    (sheet === null || isEditing) && assignments.every(({ operation_id, badge_number }) =>
      clearOperationIds.includes(operation_id) || activeOperations.has(operation_id) || canonical(badge_number))
  ), [activeOperations, assignments, clearOperationIds, displayOperations.length, isEditing, patta, sheet])

  const lookup = async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
    event?.preventDefault()
    if (isLookingUp) return
    const partiya = canonical(partiyaNumber)
    const number = canonical(pattaNumber)
    if (!partiya || !/^[1-9][0-9]*$/.test(number)) {
      setMessage('Partiya va Patta raqamlarini kiriting')
      return
    }
    setIsLookingUp(true)
    setMessage(null)
    setPatta(null)
    setSheet(null)
    setSheetRows([])
    setAssignments([])
    setBadgeResolutions({})
    setConveyorSnapshot('')
    setCustomOperations([])
    setCustomOperationName('')
    setCustomOperationPrice('')
    setClearOperationIds([])
    setIsEditing(false)
    try {
      const result = await window.erp.pattaSheet.lookup(partiya, number)
      if (!result) {
        setMessage('Patta mahalliy ma’lumotlarda topilmadi. Sinxronlangandan keyin qayta qidiring.')
        return
      }
      setPatta(result.patta)
      setSheet(result.sheet)
      setSheetRows(result.rows)
      setConveyorSnapshot(result.sheet?.conveyor_snapshot ?? result.patta.konveyer_snapshot ?? '')
      const operationCatalog = result.sheet
        ? result.sheet.operation_snapshots.map((snapshot) => ({ id: snapshot.model_operation_id }))
        : result.patta.operations.map((operation) => ({ id: operation.operation_id }))
      const currentByOperation = new Map(result.rows.map((row) => [row.model_operation_id, row]))
      setAssignments(operationCatalog.map((operation) => {
        const current = currentByOperation.get(operation.id)
        return {
          operation_id: operation.id,
          badge_number: current?.deleted_at === null ? current.badge_number ?? '' : '',
          nuqson: current?.deleted_at === null ? current.nuqson : false
        }
      }))
      setBadgeResolutions(Object.fromEntries(result.rows
        .filter((row) => row.deleted_at === null)
        .map((row) => [row.model_operation_id, { worker_id: row.worker_id, full_name: row.worker_name }])))
      setClearOperationIds(result.rows.filter((row) => row.deleted_at !== null).map((row) => row.model_operation_id))
      setIsEditing(result.sheet === null)
      if (result.sheet) setMessage(result.sheet.deleted_at ? 'Varaq Korzinkada' : 'Bu Patta uchun varaq allaqachon kiritilgan')
      else if (result.patta.ish_soni === null) setMessage('Haqiqiy Patta miqdori tuzatilmaguncha varaq kiritib bo‘lmaydi')
      else if (result.patta.status !== 'ACTIVE') setMessage('VOID qilingan Patta uchun varaq kiritib bo‘lmaydi')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Patta qidirib bo‘lmadi')
    } finally {
      setIsLookingUp(false)
    }
  }

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!patta || !canSave || isSaving) return
    setIsSaving(true)
    setMessage(null)
    try {
      const input = {
        partiya_number: patta.partiya_number,
        patta_number: patta.patta_number,
        conveyor_snapshot: canonical(conveyorSnapshot) || null,
        assignments: assignments.map((assignment) => ({
          model_operation_id: assignment.operation_id,
          badge_number: canonical(assignment.badge_number),
          nuqson: assignment.nuqson
        })),
        custom_operations: customOperations
      }
      const saved = sheet
        ? await window.erp.pattaSheet.update({
            sheet_id: sheet.id,
            expected_version: sheet.version,
            conveyor_snapshot: input.conveyor_snapshot,
            assignments: input.assignments,
            clear_operation_ids: clearOperationIds
          })
        : await window.erp.pattaSheet.create(input)
      setSheet(saved)
      setConveyorSnapshot(saved.conveyor_snapshot ?? '')
      setClearOperationIds([])
      setIsEditing(false)
      const refreshed = await window.erp.pattaSheet.lookup(patta.partiya_number, patta.patta_number)
      if (refreshed) setSheetRows(refreshed.rows)
      setMessage(sheet ? 'Varaqdagi o‘zgarishlar mahalliy bazaga saqlandi' : 'Varaq mahalliy bazaga saqlandi')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Varaqni saqlab bo‘lmadi')
    } finally {
      setIsSaving(false)
    }
  }

  const trash = async (): Promise<void> => {
    if (!sheet || sheet.deleted_at !== null || isSaving) return
    if (!window.confirm('Varaq Korzinkaga yuborilsinmi?')) return
    setIsSaving(true)
    try {
      const trashed = await window.erp.pattaSheet.trash(sheet.id, sheet.version)
      setSheet(trashed)
      setMessage('Varaq Korzinkaga yuborildi')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Varaqni Korzinkaga yuborib bo‘lmadi')
    } finally {
      setIsSaving(false)
    }
  }

  const cancelEdit = (): void => {
    if (!patta) return
    const currentByOperation = new Map(sheetRows
      .filter((row) => row.deleted_at === null)
      .map((row) => [row.model_operation_id, row]))
    setAssignments(sheet?.operation_snapshots.map((snapshot) => ({ id: snapshot.model_operation_id }))
      .map((operation) => {
      const operationId = operation.id
      const current = currentByOperation.get(operationId)
      return {
        operation_id: operationId,
        badge_number: current?.badge_number ?? '',
        nuqson: current?.nuqson ?? false
      }
    }) ?? patta.operations.map((operation) => {
      const current = currentByOperation.get(operation.operation_id)
      return { operation_id: operation.operation_id, badge_number: current?.badge_number ?? '', nuqson: current?.nuqson ?? false }
    }))
    setClearOperationIds(sheetRows.filter((row) => row.deleted_at !== null).map((row) => row.model_operation_id))
    setConveyorSnapshot(sheet?.conveyor_snapshot ?? '')
    setIsEditing(false)
  }

  const addCustomOperation = (): void => {
    const name = canonical(customOperationName)
    const price = canonical(customOperationPrice)
    if (!name || !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(price)) {
      setMessage('Operatsiya nomi va narxini 0.00 ko‘rinishida kiriting')
      return
    }
    if (customOperations.some((item) => canonical(item.name).toLocaleLowerCase() === name.toLocaleLowerCase()) ||
      displayOperations.some((item) => canonical(item.operation_name_snapshot).toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setMessage('Bu nomdagi operatsiya varaqda bor')
      return
    }
    const id = crypto.randomUUID()
    setCustomOperations((current) => [...current, { id, name, initial_price: price }])
    setAssignments((current) => [...current, { operation_id: id, badge_number: '', nuqson: false }])
    setCustomOperationName('')
    setCustomOperationPrice('')
    setMessage(null)
  }

  const handleBadgeKey = async (event: KeyboardEvent<HTMLInputElement>, index: number): Promise<void> => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const assignment = assignments[index]
    if (!assignment) return
    const badgeNumber = canonical(assignment.badge_number)
    if (!badgeNumber) {
      setMessage('Ishchi Jetonini kiriting')
      return
    }
    try {
      const resolution = await window.erp.pattaSheet.resolveBadge(badgeNumber, sheet?.entered_at)
      setBadgeResolutions((current) => ({ ...current, [assignment.operation_id]: resolution }))
      if (!resolution) {
        setMessage('Topilmadi')
        return
      }
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Jetonni tekshirib bo‘lmadi')
      return
    }
    const next = badgeRefs.current[index + 1]
    if (next) next.focus()
    else formRef.current?.requestSubmit()
  }

  return (
    <section className="patta-entry-page" aria-labelledby="patta-entry-title">
      <header className="print-page-heading">
        <div>
          <p className="print-kicker"><span className="print-kicker-mark" /> ISHLAB CHIQARISH / KIRITISH</p>
          <h2 id="patta-entry-title">Patta kiritish</h2>
          <p className="print-intro">Jetonlar Patta varag‘iga faqat yakuniy Enter’dan keyin saqlanadi.</p>
        </div>
      </header>

      <form className="entry-lookup" onSubmit={(event) => void lookup(event)}>
        <label className="print-field">
          <span className="print-label">PARTIYA №</span>
          <input value={partiyaNumber} onChange={(event) => setPartiyaNumber(event.target.value)} required />
        </label>
        <label className="print-field">
          <span className="print-label">PATTA №</span>
          <input value={pattaNumber} onChange={(event) => setPattaNumber(event.target.value)} inputMode="numeric" required />
        </label>
        <button className="save-batch-button" type="submit" disabled={isLookingUp}>
          {isLookingUp ? 'Qidirilmoqda…' : 'Patta qidirish'}
        </button>
      </form>

      {message ? <p className="print-status-message" role="status">{message}</p> : null}
      {patta ? (
        <section className="entry-card" aria-label="Patta ma’lumoti">
          <div className="entry-readonly-fields">
            <div><small>MODEL</small><strong>{patta.model_name_snapshot}</strong></div>
            <div><small>PARTIYA №</small><strong>{patta.partiya_number}</strong></div>
            <div><small>PATTA №</small><strong>{patta.patta_number}</strong></div>
            <div><small>ISH SONI</small><strong>{formatQuantity(patta.ish_soni)} dona</strong></div>
            <div><small>RAZMER</small><strong>{patta.razmer ?? '—'}</strong></div>
            <div><small>RANG</small><strong>{patta.rang ?? '—'}</strong></div>
            {sheet && !isEditing ? <div><small>KONVEYER</small><strong>{sheet.conveyor_snapshot ?? '—'}</strong></div> : null}
          </div>
          {sheet ? (
            <>
              <p className="entry-existing-note">{sheet.deleted_at ? 'Varaq Korzinkada' : 'Varaq allaqachon kiritilgan'}</p>
              {!sheet.deleted_at && !isEditing ? (
                <div className="entry-actions">
                  <button className="save-batch-button" type="button" onClick={() => setIsEditing(true)}>Tahrirlash</button>
                  <button className="entry-trash-button" type="button" onClick={() => void trash()} disabled={isSaving}>O‘chirish</button>
                </div>
              ) : null}
              {!sheet.deleted_at && isEditing ? (
                <button className="entry-cancel-button" type="button" onClick={cancelEdit}>Tahrirni bekor qilish</button>
              ) : null}
            </>
          ) : null}
          {patta.status === 'ACTIVE' && patta.ish_soni !== null && (sheet === null || (sheet.deleted_at === null && isEditing)) ? (
            <form ref={formRef} className="entry-grid-form" onSubmit={(event) => void submit(event)}>
              <label className="print-field entry-conveyor-field">
                <span className="print-label">KONVEYER <b className="auto-tag">IXTIYORIY</b></span>
                <input
                  value={conveyorSnapshot}
                  onChange={(event) => setConveyorSnapshot(event.target.value)}
                  maxLength={120}
                  placeholder="Masalan, 1-konveyer"
                />
              </label>
              {sheet === null ? (
                <div className="entry-custom-operation">
                  <strong>Qo‘shimcha operatsiya</strong>
                  <label><span className="print-label">OPERATSIYA NOMI</span>
                    <input value={customOperationName} onChange={(event) => setCustomOperationName(event.target.value)} maxLength={500} />
                  </label>
                  <label><span className="print-label">NARX · SO‘M</span>
                    <input value={customOperationPrice} onChange={(event) => setCustomOperationPrice(event.target.value)} inputMode="decimal" placeholder="0.00" />
                  </label>
                  <button type="button" className="entry-row-clear-button" onClick={addCustomOperation}>Qo‘shish</button>
                  {customOperations.length > 0 ? <p>Qo‘shimcha operatsiya va varaq yakuniy saqlashda birga navbatga qo‘shiladi.</p> : null}
                </div>
              ) : null}
              <div className="entry-grid-heading"><span>OPERATSIYA</span><span>NARX</span><span>JETON</span><span>ISHCHI</span><span>NUQSON</span><span>O‘CHIRISH</span></div>
              {displayOperations.map((operation, index) => (
                <div className="entry-grid-row" key={operation.id}>
                  <strong>{operation.operation_name_snapshot}</strong>
                  <span>{formatMoney(operation.unit_price_snapshot)}</span>
                  <input
                    ref={(element) => { badgeRefs.current[index] = element }}
                    value={assignments[index]?.badge_number ?? ''}
                    onChange={(event) => {
                      setAssignments((current) => current.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, badge_number: event.target.value } : row))
                      setBadgeResolutions((current) => {
                        const next = { ...current }
                        delete next[operation.id]
                        return next
                      })
                      setClearOperationIds((current) => current.filter((id) => id !== operation.id))
                    }}
                    onKeyDown={(event) => { void handleBadgeKey(event, index) }}
                    aria-label={`${operation.operation_name_snapshot} jetoni`}
                    autoComplete="off"
                    inputMode="text"
                    maxLength={48}
                  />
                  <span className="entry-worker-name" title={sheetRows.find((row) => row.model_operation_id === operation.id && row.deleted_at === null)?.worker_id}>
                    {clearOperationIds.includes(operation.id) ? 'O‘chiriladi' :
                      badgeResolutions[operation.id] === null ? 'Topilmadi' :
                        badgeResolutions[operation.id]?.full_name ??
                          (sheetRows.find((row) => row.model_operation_id === operation.id &&
                            row.deleted_at === null && row.badge_number === canonical(assignments[index]?.badge_number ?? ''))?.worker_name ?? '—')}
                  </span>
                  <input
                    type="checkbox"
                    checked={assignments[index]?.nuqson ?? false}
                    onChange={(event) => setAssignments((current) => current.map((row, rowIndex) =>
                      rowIndex === index ? { ...row, nuqson: event.target.checked } : row))}
                    aria-label={`${operation.operation_name_snapshot} nuqsoni`}
                  />
                  {sheet ? (
                    <button className="entry-row-clear-button" type="button"
                      disabled={!activeOperations.has(operation.id) && !clearOperationIds.includes(operation.id)}
                      onClick={() => setClearOperationIds((current) => current.includes(operation.id)
                        ? current.filter((id) => id !== operation.id)
                        : [...current, operation.id])}>
                      {clearOperationIds.includes(operation.id) ? 'Tiklash' : 'O‘chirish'}
                    </button>
                  ) : <span>—</span>}
                </div>
              ))}
              <button className="save-batch-button entry-save-button" type="submit" disabled={!canSave || isSaving}>
                {isSaving ? 'Saqlanmoqda…' : sheet ? 'O‘zgarishlarni saqlash' : 'Yakuniy Enter · varaqni saqlash'}
              </button>
            </form>
          ) : null}
        </section>
      ) : null}
    </section>
  )
}
