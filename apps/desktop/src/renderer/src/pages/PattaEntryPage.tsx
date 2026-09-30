import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import {
  Layers,
  Send,
  Plus,
  Trash2,
  Check,
  AlertTriangle,
  Sparkles,
  Search
} from 'lucide-react'
import type {
  DesktopModelOption,
  DesktopPattaLookup,
  DesktopPattaSheetCreateInput,
  DesktopPattaSheetLookup,
  DesktopPattaSheetRowDetail
} from '../../../preload/erp-api'
import type { DesktopModelOperationOption, PattaSheetProjectionV3 } from '@textile/sync-protocol'

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

function formatMoney(value: string): string {
  const [whole, fraction = '00'] = value.split('.')
  if (!whole || !/^[0-9]+$/.test(whole) || !/^[0-9]{2}$/.test(fraction)) return `${value} so‘m`
  const formatted = new Intl.NumberFormat('uz-UZ').format(BigInt(whole))
  return `${fraction === '00' ? formatted : `${formatted},${fraction}`} so‘m`
}

export interface PattaEntryPageProps {
  initialSheetId?: string | null
}

export function PattaEntryPage({ initialSheetId = null }: PattaEntryPageProps): React.JSX.Element {
  const [linkedMode, setLinkedMode] = useState(true)
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [permissionCodes, setPermissionCodes] = useState<readonly string[]>([])
  const [modelId, setModelId] = useState('')
  const [modelOperations, setModelOperations] = useState<readonly DesktopModelOperationOption[]>([])
  const [enteredAt, setEnteredAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [standaloneQuantity, setStandaloneQuantity] = useState('125')
  const [standalonePartiya, setStandalonePartiya] = useState('')
  const [standalonePatta, setStandalonePatta] = useState('')
  const [standaloneColor, setStandaloneColor] = useState('')
  const [standaloneSize, setStandaloneSize] = useState('')
  const [partiyaNumber, setPartiyaNumber] = useState('')
  const [pattaNumber, setPattaNumber] = useState('')
  const [patta, setPatta] = useState<DesktopPattaLookup | null>(null)
  const [sheet, setSheet] = useState<PattaSheetProjectionV3 | null>(null)
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
  const [loadedInitialSheetId, setLoadedInitialSheetId] = useState<string | null>(null)
  const isLoadingEntry = initialSheetId !== null && loadedInitialSheetId !== initialSheetId
  const canCreateEntry = permissionCodes.includes('patta_varaq.create')
  const canEditEntry = permissionCodes.includes('patta_varaq.edit')
  const canDeleteEntry = permissionCodes.includes('patta_varaq.delete')
  const formRef = useRef<HTMLFormElement>(null)
  const badgeRefs = useRef<Array<HTMLInputElement | null>>([])
  const [isCustomOpModalOpen, setIsCustomOpModalOpen] = useState(false)

  const loadModelOperations = useCallback(async (targetModelId: string, timestamp: string): Promise<void> => {
    try {
      const operations = await window.erp.pattaSheet.modelOperations(targetModelId, timestamp)
      setModelOperations(operations)
      setAssignments(operations.map((operation) => ({
        operation_id: operation.model_operation_id,
        badge_number: '',
        nuqson: false
      })))
      setBadgeResolutions({})
      setClearOperationIds([])
    } catch {
      // Graceful fallback
    }
  }, [])

  // Load models and permissions on startup
  useEffect(() => {
    let active = true
    const loadData = async (): Promise<void> => {
      try {
        let loadedModels: readonly DesktopModelOption[] = []
        try {
          loadedModels = await window.erp.pattaSheet.models()
        } catch {
          if (window.erp?.pattaPrint?.models) {
            loadedModels = await window.erp.pattaPrint.models()
          }
        }
        if (!active) return
        setModels(loadedModels)
        const initialId = loadedModels[0]?.id || ''
        setModelId((curr) => curr || initialId)

        const session = await window.erp.auth.session().catch(() => null)
        if (active && session) {
          setPermissionCodes(session.permission_codes || [])
        }

        if (initialId) {
          void loadModelOperations(initialId, new Date().toISOString())
        }
      } catch {
        // Keep UI clean if initial load is pending
      }
    }
    void loadData()
    return () => { active = false }
  }, [loadModelOperations])

  const modelName = useMemo(() => {
    if (sheet?.model_name_snapshot) return sheet.model_name_snapshot
    if (patta?.model_name_snapshot) return patta.model_name_snapshot
    return models.find((item) => item.id === modelId)?.name ?? (models[0]?.name || 'Model')
  }, [models, modelId, sheet, patta])

  // Load sheet when editing initialSheetId
  useEffect(() => {
    if (!initialSheetId || loadedInitialSheetId === initialSheetId) return
    let active = true
    void window.erp.pattaSheet.get(initialSheetId).then(async (lookupResult) => {
      if (!active || !lookupResult) return
      setLoadedInitialSheetId(initialSheetId)
      setSheet(lookupResult.sheet)
      setSheetRows(lookupResult.rows)
      setModelId(lookupResult.sheet.model_id)
      setConveyorSnapshot(lookupResult.sheet.conveyor_snapshot ?? '')
      setEnteredAt(lookupResult.sheet.entered_at.slice(0, 10))
      const pNum = lookupResult.sheet.partiya_number_snapshot ?? lookupResult.patta?.partiya_number ?? ''
      const ptNum = lookupResult.sheet.patta_number_snapshot ?? lookupResult.patta?.patta_number ?? ''
      setPartiyaNumber(pNum)
      setPattaNumber(ptNum)
      setStandaloneQuantity(lookupResult.sheet.ish_soni ? String(lookupResult.sheet.ish_soni) : '')
      setStandalonePartiya(pNum)
      setStandalonePatta(ptNum)
      setStandaloneColor(lookupResult.sheet.rang_snapshot ?? lookupResult.patta?.rang ?? '')
      setStandaloneSize(lookupResult.sheet.razmer_snapshot ?? lookupResult.patta?.razmer ?? '')
      setLinkedMode(lookupResult.sheet.entry_kind === 'PATTA_LINKED')

      if (lookupResult.patta) {
        setPatta(lookupResult.patta)
      } else if (pNum && ptNum) {
        const pattaData = await window.erp.pattaSheet.lookup(pNum, ptNum).catch(() => null)
        if (active && pattaData) {
          setPatta(pattaData.patta)
        }
      }

      const existingRows = new Map<string, DesktopPattaSheetRowDetail>(
        lookupResult.rows
          .filter((row: DesktopPattaSheetRowDetail) => row.deleted_at === null)
          .map((row: DesktopPattaSheetRowDetail) => [row.model_operation_id, row])
      )

      setAssignments(lookupResult.sheet.operation_snapshots.map((snapshot) => {
        const row = existingRows.get(snapshot.model_operation_id)
        return {
          operation_id: snapshot.model_operation_id,
          badge_number: row?.badge_number ?? '',
          nuqson: row?.nuqson ?? false
        }
      }))

      const resolvedMap: Record<string, { worker_id: string; full_name: string } | null> = {}
      for (const row of lookupResult.rows) {
        if (row.deleted_at === null && row.badge_number) {
          resolvedMap[row.model_operation_id] = {
            worker_id: row.worker_id,
            full_name: row.worker_name
          }
        }
      }
      setBadgeResolutions(resolvedMap)
      setIsEditing(false)
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : 'Varaqni ochib bo‘lmadi')
    })
    return () => { active = false }
  }, [initialSheetId, loadedInitialSheetId])

  // Compute operations to display in spreadsheet
  const displayOperations = useMemo(() => {
    if (sheet) {
      return sheet.operation_snapshots.map((op) => ({
        id: op.model_operation_id,
        operation_name_snapshot: op.operation_name_snapshot,
        unit_price_snapshot: op.unit_price_snapshot,
        sort_order: op.sort_order
      }))
    }
    if (linkedMode && patta) {
      const base = patta.operations.map((op) => ({
        id: op.operation_id,
        operation_name_snapshot: op.operation_name_snapshot,
        unit_price_snapshot: op.unit_price_snapshot,
        sort_order: op.sort_order
      }))
      const custom = customOperations.map((op, index) => ({
        id: op.id,
        operation_name_snapshot: op.name,
        unit_price_snapshot: op.initial_price,
        sort_order: base.length + index
      }))
      return [...base, ...custom]
    }
    const base = modelOperations.map((op) => ({
      id: op.model_operation_id,
      operation_name_snapshot: op.operation_name_snapshot,
      unit_price_snapshot: op.unit_price_snapshot,
      sort_order: op.sort_order
    }))
    const custom = customOperations.map((op, index) => ({
      id: op.id,
      operation_name_snapshot: op.name,
      unit_price_snapshot: op.initial_price,
      sort_order: base.length + index
    }))
    return [...base, ...custom]
  }, [sheet, linkedMode, patta, modelOperations, customOperations])



  const activeOperations = useMemo(
    () => new Set(sheetRows.filter((row) => row.deleted_at === null).map((row) => row.model_operation_id)),
    [sheetRows]
  )

  const standaloneQuantityNumber = Number(standaloneQuantity)
  const isStandaloneQuantityValid = Number.isSafeInteger(standaloneQuantityNumber) && standaloneQuantityNumber > 0

  const canSave = useMemo(() => {
    if (isLoadingEntry) return false
    if (sheet) {
      if (!isEditing || sheet.deleted_at !== null) return false
      return canEditEntry
    }
    if (!canCreateEntry) return false
    if (linkedMode) {
      if (!patta || patta.status !== 'ACTIVE' || patta.ish_soni === null) return false
    } else {
      if (!modelId || !isStandaloneQuantityValid) return false
    }
    if (assignments.length === 0 || assignments.length !== displayOperations.length) return false
    return assignments.every(({ operation_id, badge_number }) =>
      clearOperationIds.includes(operation_id) || activeOperations.has(operation_id) || Boolean(canonical(badge_number)))
  }, [
    isLoadingEntry,
    sheet,
    isEditing,
    canEditEntry,
    canCreateEntry,
    linkedMode,
    patta,
    modelId,
    isStandaloneQuantityValid,
    assignments,
    displayOperations.length,
    clearOperationIds,
    activeOperations
  ])

  const lookup = async (event?: FormEvent): Promise<void> => {
    if (event) event.preventDefault()
    const cleanPartiya = canonical(partiyaNumber)
    const cleanPatta = canonical(pattaNumber)
    if (!cleanPartiya || !cleanPatta) return
    setIsLookingUp(true)
    setMessage(null)
    try {
      const result = await window.erp.pattaSheet.lookup(cleanPartiya, cleanPatta)
      if (!result) {
        setPatta(null)
        setSheet(null)
        setSheetRows([])
        setAssignments([])
        setBadgeResolutions({})
        setMessage('Patta topilmadi')
        return
      }
      setPatta(result.patta)
      setSheet(result.sheet)
      setSheetRows(result.rows)
      setModelId(result.patta.model_id)
      setConveyorSnapshot(result.sheet?.conveyor_snapshot ?? result.patta.konveyer_snapshot ?? '')
      setEnteredAt(result.sheet?.entered_at.slice(0, 10) ?? new Date().toISOString().slice(0, 10))

      if (result.sheet) {
        const existingRows = new Map<string, DesktopPattaSheetRowDetail>(
          result.rows
            .filter((row: DesktopPattaSheetRowDetail) => row.deleted_at === null)
            .map((row: DesktopPattaSheetRowDetail) => [row.model_operation_id, row])
        )
        setAssignments(result.sheet.operation_snapshots.map((snapshot) => {
          const row = existingRows.get(snapshot.model_operation_id)
          return {
            operation_id: snapshot.model_operation_id,
            badge_number: row?.badge_number ?? '',
            nuqson: row?.nuqson ?? false
          }
        }))
        const resolvedMap: Record<string, { worker_id: string; full_name: string } | null> = {}
        for (const row of result.rows) {
          if (row.deleted_at === null && row.badge_number) {
            resolvedMap[row.model_operation_id] = {
              worker_id: row.worker_id,
              full_name: row.worker_name
            }
          }
        }
        setBadgeResolutions(resolvedMap)
      } else {
        setAssignments(result.patta.operations.map((operation) => ({
          operation_id: operation.operation_id,
          badge_number: '',
          nuqson: false
        })))
        setBadgeResolutions({})
      }
      setIsEditing(false)
      setTimeout(() => {
        badgeRefs.current[0]?.focus()
      }, 50)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Pattani qidirib bo‘lmadi')
    } finally {
      setIsLookingUp(false)
    }
  }

  const updateBadgeNumber = (operationId: string, badgeNumber: string): void => {
    setAssignments((prev) => prev.map((a) =>
      a.operation_id === operationId ? { ...a, badge_number: badgeNumber } : a
    ))
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
      const resolution = await window.erp.pattaSheet.resolveBadge(badgeNumber, enteredAt)
      setBadgeResolutions((current) => ({ ...current, [assignment.operation_id]: resolution }))
      if (!resolution) {
        setMessage('Topilmadi')
        badgeRefs.current[index]?.focus()
        return
      }
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Jetonni tekshirib bo‘lmadi')
      return
    }
    const next = badgeRefs.current[index + 1]
    if (next) {
      next.focus()
    } else {
      formRef.current?.requestSubmit()
    }
  }

  const submit = async (event?: FormEvent): Promise<void> => {
    if (event) event.preventDefault()
    if (!canSave || isSaving) return
    setIsSaving(true)
    setMessage(null)
    try {
      const input: DesktopPattaSheetCreateInput = linkedMode
        ? {
            entry_kind: 'PATTA_LINKED',
            partiya_number: patta?.partiya_number ?? canonical(partiyaNumber),
            patta_number: patta?.patta_number ?? canonical(pattaNumber),
            conveyor_snapshot: canonical(conveyorSnapshot) || null,
            assignments: assignments.map((assignment) => ({
              model_operation_id: assignment.operation_id,
              badge_number: canonical(assignment.badge_number),
              nuqson: assignment.nuqson
            })),
            custom_operations: customOperations.map((op) => ({
              id: op.id,
              name: op.name,
              initial_price: op.initial_price
            }))
          }
        : {
            entry_kind: 'STANDALONE',
            entered_at: new Date(enteredAt).toISOString(),
            model_id: modelId,
            ish_soni: Number(standaloneQuantity),
            partiya_number_snapshot: canonical(standalonePartiya) || null,
            patta_number_snapshot: canonical(standalonePatta) || null,
            rang_snapshot: canonical(standaloneColor) || null,
            razmer_snapshot: canonical(standaloneSize) || null,
            conveyor_snapshot: canonical(conveyorSnapshot) || null,
            assignments: assignments.map((assignment) => ({
              model_operation_id: assignment.operation_id,
              badge_number: canonical(assignment.badge_number),
              nuqson: assignment.nuqson
            })),
            custom_operations: customOperations.map((op) => ({
              id: op.id,
              name: op.name,
              initial_price: op.initial_price
            }))
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
      if (patta) {
        const refreshed = await window.erp.pattaSheet.lookup(patta.partiya_number, patta.patta_number)
        if (refreshed) setSheetRows(refreshed.rows)
      }
      setMessage(sheet ? 'Varaqdagi o‘zgarishlar mahalliy bazaga saqlandi' : 'Varaq muvaffaqiyatli saqlandi!')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Saqlashda xatolik yuz berdi')
    } finally {
      setIsSaving(false)
    }
  }

  const changeEntryMode = (nextLinked: boolean): void => {
    setLinkedMode(nextLinked)
    setMessage(null)
    setPartiyaNumber('')
    setPattaNumber('')
    setPatta(null)
    setSheet(null)
    setSheetRows([])
    setAssignments([])
    setBadgeResolutions({})
    setCustomOperations([])
    if (!nextLinked && modelId) {
      void loadModelOperations(modelId, enteredAt)
    }
  }

  const addCustomOperation = (): void => {
    const cleanName = canonical(customOperationName)
    const cleanPrice = canonical(customOperationPrice)
    if (!cleanName) return
    const id = `custom-op-${Date.now()}`
    const newDraft: CustomOperationDraft = {
      id,
      name: cleanName,
      initial_price: cleanPrice || '0.00'
    }
    setCustomOperations((prev) => [...prev, newDraft])
    setAssignments((prev) => [...prev, { operation_id: id, badge_number: '', nuqson: false }])
    setCustomOperationName('')
    setCustomOperationPrice('')
    setIsCustomOpModalOpen(false)
  }

  const cancelEdit = (): void => {
    setIsEditing(false)
  }

  const trash = async (): Promise<void> => {
    if (!sheet || isSaving) return
    setIsSaving(true)
    try {
      await window.erp.pattaSheet.trash(sheet.id, sheet.version)
      setSheet((prev) => prev ? { ...prev, deleted_at: new Date().toISOString() } : null)
      setMessage('Varaq korzinkaga olindi')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Korzinkaga olib bo‘lmadi')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      className="excel-grid-container"
      style={{
        padding: '20px',
        background: 'var(--bg-app)',
        overflowY: 'auto',
        userSelect: 'none'
      }}
      aria-labelledby="patta-entry-title"
    >
      <div
        style={{
          maxWidth: '960px',
          margin: '0 auto',
          background: 'var(--bg-surface)',
          borderRadius: 'var(--radius-xl, 16px)',
          boxShadow: 'var(--shadow-md)',
          border: '1px solid var(--border-subtle)',
          overflow: 'hidden'
        }}
      >
        {/* Modern Top Header Card matching hisob PattaView */}
        <div
          style={{
            padding: '16px 20px',
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '12px'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: 'var(--radius-md, 8px)',
                background: 'var(--primary-light)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Layers size={18} color="var(--primary)" />
            </div>
            <div>
              <div id="patta-entry-title" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Patta Kiritish — {modelName}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Ishchilar raqamini ketma-ket kiritib Enter bosing
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Mode Switch: Linked vs Standalone */}
            <label
              className="entry-mode-toggle"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
                background: 'var(--bg-surface-subtle)',
                padding: '5px 12px',
                borderRadius: 'var(--radius-full, 9999px)',
                border: '1px solid var(--border-subtle)'
              }}
            >
              <input
                type="checkbox"
                aria-label="Patta bo‘yicha kiritish"
                checked={linkedMode}
                disabled={!canCreateEntry || sheet !== null || isLoadingEntry}
                onChange={(event) => changeEntryMode(event.target.checked)}
                style={{ accentColor: 'var(--primary)', cursor: 'pointer' }}
              />
              <span style={{ color: 'var(--text-primary)' }}>Patta bo‘yicha kiritish</span>
            </label>

            {/* Operatsiya qo'shish button */}
            <button
              type="button"
              onClick={() => setIsCustomOpModalOpen((prev) => !prev)}
              className="soft-btn soft-btn-secondary"
              style={{ borderRadius: 'var(--radius-full, 9999px)', padding: '6px 14px' }}
            >
              <Plus size={14} color="var(--primary)" />
              <span>Operatsiya qo‘shish</span>
            </button>

            {/* Jo'natish / Submit button */}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSave || isSaving}
              className="soft-btn soft-btn-primary"
              style={{
                borderRadius: 'var(--radius-full, 9999px)',
                padding: '6px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
              title="Kiritilgan ma'lumotlarni saqlash (Enter / F5)"
            >
              <Send size={14} />
              <span>{isSaving ? 'Saqlanmoqda…' : sheet ? 'Saqlash' : 'Jo‘natish'}</span>
            </button>
          </div>
        </div>

        {/* Status Message */}
        {message ? (
          <div
            style={{
              padding: '10px 18px',
              background: message.includes('xato') || message.includes('Topilmadi') ? 'rgba(239, 68, 68, 0.12)' : 'var(--primary-light)',
              color: message.includes('xato') || message.includes('Topilmadi') ? '#dc2626' : 'var(--primary)',
              fontSize: '12.5px',
              fontWeight: 600,
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}
            role="status"
          >
            {message.includes('xato') || message.includes('Topilmadi') ? <AlertTriangle size={15} /> : <Check size={15} />}
            <span>{message}</span>
          </div>
        ) : null}

        {/* Custom Operation Inline Box */}
        {(sheet === null && (!linkedMode || isCustomOpModalOpen)) && (
          <div
            className="entry-custom-operation"
            style={{
              padding: '12px 20px',
              background: 'var(--primary-light)',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              flexWrap: 'wrap'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700, color: 'var(--primary)' }}>
              <Sparkles size={16} />
              <strong>Qo‘shimcha operatsiya</strong>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>OPERATSIYA NOMI</span>
              <input
                aria-label="OPERATSIYA NOMI"
                value={customOperationName}
                onChange={(event) => setCustomOperationName(event.target.value)}
                maxLength={500}
                className="soft-input"
                style={{ width: '180px', height: '28px' }}
                placeholder="Nomi"
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>NARX · SO‘M</span>
              <input
                aria-label="NARX · SO‘M"
                value={customOperationPrice}
                onChange={(event) => setCustomOperationPrice(event.target.value)}
                inputMode="decimal"
                placeholder="500.00"
                className="soft-input"
                style={{ width: '100px', height: '28px', textAlign: 'right' }}
              />
            </label>
            <button
              type="button"
              className="soft-btn soft-btn-primary"
              onClick={addCustomOperation}
              style={{ height: '28px', padding: '0 14px', fontSize: '11.5px', borderRadius: 'var(--radius-sm, 6px)' }}
            >
              Qo‘shish
            </button>
            {isCustomOpModalOpen && (
              <button
                type="button"
                className="soft-btn"
                onClick={() => setIsCustomOpModalOpen(false)}
                style={{ height: '28px', padding: '0 10px', fontSize: '11.5px', borderRadius: 'var(--radius-sm, 6px)' }}
              >
                Yopish
              </button>
            )}
          </div>
        )}

        {/* Existing Sheet Note & Actions */}
        {sheet && (
          <div
            style={{
              padding: '10px 20px',
              background: 'var(--bg-surface-subtle)',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <p style={{ fontWeight: 700, color: sheet.deleted_at ? '#dc2626' : 'var(--primary)', margin: 0, fontSize: '12.5px' }}>
              {sheet.deleted_at ? 'Varaq Korzinkada' : 'Varaq allaqachon kiritilgan'}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {!sheet.deleted_at && !isEditing && canEditEntry ? (
                <button className="soft-btn soft-btn-secondary" type="button" onClick={() => setIsEditing(true)}>
                  Tahrirlash
                </button>
              ) : null}
              {!sheet.deleted_at && isEditing ? (
                <button className="soft-btn soft-btn-secondary" type="button" onClick={cancelEdit}>
                  Tahrirni bekor qilish
                </button>
              ) : null}
              {!sheet.deleted_at && canDeleteEntry ? (
                <button className="soft-btn soft-btn-danger" type="button" onClick={() => void trash()} disabled={isSaving}>
                  <Trash2 size={13} />
                  <span>O‘chirish</span>
                </button>
              ) : null}
            </div>
          </div>
        )}

        {/* UNIFIED SPREADSHEET TABLE: Matching hisob PattaView */}
        <form ref={formRef} className="entry-grid-form" onSubmit={(event) => void submit(event)}>
          <table className="excel-table" style={{ width: '100%' }}>
            <colgroup>
              <col style={{ width: '54px' }} />
              <col style={{ width: '260px' }} />
              <col style={{ width: '130px' }} />
              <col style={{ width: '260px' }} />
              <col style={{ width: '180px' }} />
            </colgroup>

            <tbody>
              {/* ROW 1: Model Title */}
              <tr style={{ height: '38px', backgroundColor: 'var(--bg-surface-subtle)' }}>
                <td></td>
                <td
                  colSpan={4}
                  style={{
                    fontWeight: 800,
                    fontSize: '15px',
                    color: 'var(--primary)',
                    textAlign: 'center',
                    letterSpacing: '0.2px'
                  }}
                >
                  Model — {modelName}
                </td>
              </tr>

              {/* ROW 2: Konveyer & Date */}
              <tr style={{ height: '36px' }}>
                <td></td>
                <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                  Konveyer:
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <input
                    type="text"
                    value={conveyorSnapshot}
                    onChange={(e) => setConveyorSnapshot(e.target.value)}
                    className="soft-input"
                    style={{ height: '30px', textAlign: 'center', fontWeight: 700 }}
                    placeholder="(ixtiyoriy)"
                  />
                </td>
                <td colSpan={2} style={{ fontWeight: 600, textAlign: 'center' }}>
                  <span style={{ color: 'var(--text-secondary)', marginRight: '8px', fontSize: '12px' }}>Sana:</span>
                  <input
                    type="date"
                    value={enteredAt}
                    onChange={(e) => setEnteredAt(e.target.value)}
                    className="soft-input"
                    style={{ width: 'auto', display: 'inline-block', height: '30px', fontWeight: 600, fontSize: '12px' }}
                  />
                </td>
              </tr>

              {/* ROW 3: Party (Partiya №) */}
              <tr style={{ height: '36px' }}>
                <td></td>
                <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                  PARTIYA №:
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <label className="visually-hidden" htmlFor="partiya-input">
                    PARTIYA №
                  </label>
                  <input
                    id="partiya-input"
                    aria-label="PARTIYA №"
                    type="text"
                    value={linkedMode ? partiyaNumber : standalonePartiya}
                    onChange={(e) => {
                      if (linkedMode) setPartiyaNumber(e.target.value)
                      else setStandalonePartiya(e.target.value)
                    }}
                    className="soft-input"
                    style={{ height: '30px', textAlign: 'center', fontWeight: 700 }}
                    placeholder="P-12"
                  />
                </td>
                <td colSpan={2} style={{ padding: '4px 8px' }}>
                  {linkedMode ? (
                    <button
                      type="button"
                      onClick={() => void lookup()}
                      disabled={isLookingUp}
                      className="soft-btn soft-btn-primary"
                      style={{ height: '30px', padding: '0 14px', borderRadius: 'var(--radius-sm, 6px)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      <Search size={13} />
                      <span>{isLookingUp ? 'Qidirilmoqda…' : 'Patta qidirish'}</span>
                    </button>
                  ) : null}
                </td>
              </tr>

              {/* ROW 4: Patta, Rang, Razmer */}
              <tr style={{ height: '36px' }}>
                <td></td>
                <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                  PATTA №:
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <label className="visually-hidden" htmlFor="patta-input">
                    PATTA №
                  </label>
                  <input
                    id="patta-input"
                    aria-label="PATTA №"
                    type="text"
                    value={linkedMode ? pattaNumber : standalonePatta}
                    onChange={(e) => {
                      if (linkedMode) setPattaNumber(e.target.value)
                      else setStandalonePatta(e.target.value)
                    }}
                    className="soft-input"
                    style={{ height: '30px', textAlign: 'center', fontWeight: 700 }}
                    placeholder="1"
                  />
                </td>
                <td style={{ fontWeight: 700, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  Rang
                </td>
                <td style={{ fontWeight: 700, textAlign: 'center', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  Razmer
                </td>
              </tr>

              {/* ROW 5: Qty (Ish soni), Color, Size */}
              <tr style={{ height: '38px' }}>
                <td></td>
                <td style={{ fontWeight: 700, textAlign: 'right', paddingRight: '16px', color: 'var(--text-secondary)' }}>
                  ISH SONI:
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <label className="visually-hidden" htmlFor="ish-soni-input">
                    ISH SONI
                  </label>
                  <input
                    id="ish-soni-input"
                    aria-label="ISH SONI"
                    type="number"
                    value={linkedMode ? (patta?.ish_soni ? String(patta.ish_soni) : standaloneQuantity) : standaloneQuantity}
                    onChange={(e) => setStandaloneQuantity(e.target.value)}
                    className="soft-input"
                    style={{
                      height: '32px',
                      textAlign: 'center',
                      fontWeight: 800,
                      fontSize: '13.5px',
                      color: 'var(--primary)',
                      backgroundColor: 'var(--primary-light)',
                      borderColor: 'rgba(52, 211, 153, 0.4)'
                    }}
                    placeholder="125"
                  />
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <input
                    type="text"
                    value={linkedMode ? (patta?.rang || standaloneColor) : standaloneColor}
                    onChange={(e) => setStandaloneColor(e.target.value)}
                    placeholder="Rang (masalan, Qora)"
                    className="soft-input"
                    style={{ height: '30px', textAlign: 'center', fontWeight: 600, fontSize: '12px' }}
                  />
                </td>
                <td style={{ padding: '4px 8px' }}>
                  <input
                    type="text"
                    value={linkedMode ? (patta?.razmer || standaloneSize) : standaloneSize}
                    onChange={(e) => setStandaloneSize(e.target.value)}
                    placeholder="Razmer (masalan, M)"
                    className="soft-input"
                    style={{ height: '30px', textAlign: 'center', fontWeight: 600, fontSize: '12px' }}
                  />
                </td>
              </tr>

              {/* ROW 6: Column Headers */}
              <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', fontWeight: 700, height: '36px' }}>
                <th className="col-header" style={{ width: '54px', textAlign: 'center' }}>№</th>
                <th className="col-header" style={{ textAlign: 'left', paddingLeft: '14px' }}>Operatsiya nomi</th>
                <th className="col-header" style={{ textAlign: 'center', color: 'var(--primary)', width: '130px' }}>Jeton</th>
                <th className="col-header" style={{ textAlign: 'left', paddingLeft: '14px' }}>Ishchining ismi</th>
                <th className="col-header" style={{ textAlign: 'right', paddingRight: '14px', width: '180px' }}>Narxi / Summa</th>
              </tr>

              {/* ROW 7+: Operations List */}
              {displayOperations.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--text-muted)' }}>
                    Operatsiyalar ro‘yxati topilmadi. Yuqoridagi &quot;Operatsiya qo‘shish&quot; tugmasi orqali yangi operatsiya qo‘shishingiz mumkin.
                  </td>
                </tr>
              ) : (
                displayOperations.map((operation, index) => {
                  const assignment = assignments.find((a) => a.operation_id === operation.id) || {
                    operation_id: operation.id,
                    badge_number: '',
                    nuqson: false
                  }
                  const resolved = badgeResolutions[operation.id]
                  const isCleared = clearOperationIds.includes(operation.id)
                  const badgeInputId = `badge-input-${operation.id}`

                  return (
                    <tr
                      key={operation.id}
                      style={{
                        height: '36px',
                        backgroundColor: index % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-surface-subtle)',
                        transition: 'background-color 0.15s'
                      }}
                    >
                      <td style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 600 }}>
                        {index + 1}
                      </td>
                      <td style={{ paddingLeft: '14px', fontWeight: 700, fontSize: '13px', color: 'var(--text-primary)' }}>
                        {operation.operation_name_snapshot}
                      </td>
                      <td style={{ padding: '3px 8px', textAlign: 'center' }}>
                        <label className="visually-hidden" htmlFor={badgeInputId}>
                          {`${operation.operation_name_snapshot} jetoni`}
                        </label>
                        <input
                          id={badgeInputId}
                          aria-label={`${operation.operation_name_snapshot} jetoni`}
                          ref={(el) => { badgeRefs.current[index] = el }}
                          value={assignment.badge_number}
                          onChange={(e) => updateBadgeNumber(operation.id, e.target.value)}
                          onKeyDown={(e) => void handleBadgeKey(e, index)}
                          placeholder="Jeton"
                          disabled={isCleared}
                          className="soft-input"
                          style={{
                            height: '28px',
                            textAlign: 'center',
                            fontWeight: 700,
                            fontSize: '12px',
                            backgroundColor: assignment.badge_number ? 'var(--primary-light)' : 'transparent',
                            borderColor: assignment.badge_number ? 'var(--primary)' : 'var(--border-default)',
                            color: assignment.badge_number ? 'var(--primary-dark)' : 'var(--text-primary)'
                          }}
                        />
                      </td>
                      <td style={{ paddingLeft: '14px', fontSize: '12.5px' }}>
                        {resolved ? (
                          <span style={{ fontWeight: 700, color: 'var(--primary)' }}>
                            {resolved.full_name}
                          </span>
                        ) : assignment.badge_number && !resolved ? (
                          <span style={{ color: '#ef4444', fontWeight: 700, fontSize: '12px' }}>
                            Topilmadi
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: '12px' }}>
                            —
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', paddingRight: '14px', fontWeight: 600, fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                        {formatMoney(operation.unit_price_snapshot)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>

            {/* Footer Summary Row */}
            {displayOperations.length > 0 && (
              <tfoot>
                <tr style={{ height: '38px', backgroundColor: 'var(--bg-surface-subtle)', borderTop: '2px solid var(--border-subtle)', fontWeight: 800 }}>
                  <td colSpan={2} style={{ paddingLeft: '14px', fontSize: '12.5px', color: 'var(--text-primary)' }}>
                    JAMI: {displayOperations.length} ta operatsiya
                  </td>
                  <td style={{ textAlign: 'center', fontSize: '12px', color: 'var(--primary)' }}>
                    {assignments.filter((a) => Boolean(canonical(a.badge_number))).length} kiritildi
                  </td>
                  <td colSpan={2} style={{ textAlign: 'right', paddingRight: '14px', fontSize: '13px', color: 'var(--primary)' }}>
                    {formatMoney(displayOperations.reduce((sum, op) => sum + (parseFloat(op.unit_price_snapshot) || 0), 0).toFixed(2))}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </form>
      </div>
    </div>
  )
}
