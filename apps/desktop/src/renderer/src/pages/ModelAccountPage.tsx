import type {
  DesktopModelOperationOption,
  ModelAccountContributionRow,
  ModelAccountWorkerDetail
} from '@textile/sync-protocol'
import { AlertTriangle, DollarSign, Layers, Plus, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DesktopModelAccountSheet, DesktopModelOption } from '../../../preload/erp-api'

interface ManualDialogState {
  worker_id: string
  worker_name: string
  model_operation_id: string
}

interface PriceDialogState {
  model_operation_id: string
  operation_name: string
  version: string
  price: string | null
}

interface WorkerAccountRow {
  worker_id: string
  worker_name: string
  contributions: ReadonlyMap<string, ModelAccountContributionRow>
}

function formatQuantity(value: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return value
  return new Intl.NumberFormat('uz-UZ').format(BigInt(value))
}

function amountInMinorUnits(value: string): bigint {
  const match = /^(0|[1-9][0-9]*)\.([0-9]{2})$/.exec(value)
  if (!match) return 0n
  return BigInt(match[1] ?? '0') * 100n + BigInt(match[2] ?? '0')
}

function formatMinorUnits(value: bigint): string {
  const whole = value / 100n
  const fraction = (value % 100n).toString().padStart(2, '0')
  return `${new Intl.NumberFormat('uz-UZ').format(whole)}${fraction === '00' ? '' : `,${fraction}`} so‘m`
}

function formatMoney(value: string | null): string {
  return value === null ? '—' : formatMinorUnits(amountInMinorUnits(value))
}

function displayDate(value: string): string {
  return `${value.slice(0, 10)} · ${value.slice(11, 16)} UTC`
}

export function ModelAccountPage(): React.JSX.Element {
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [manualWorkers, setManualWorkers] = useState<readonly DesktopModelOption[]>([])
  const [manualOperations, setManualOperations] = useState<readonly DesktopModelOperationOption[]>(
    []
  )
  const [manualOperationsModelId, setManualOperationsModelId] = useState('')
  const [modelId, setModelId] = useState('')
  const [account, setAccount] = useState<DesktopModelAccountSheet | null>(null)
  const [permissionCodes, setPermissionCodes] = useState<readonly string[]>([])
  const [loadedModelId, setLoadedModelId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [manualDialog, setManualDialog] = useState<ManualDialogState | null>(null)
  const [priceDialog, setPriceDialog] = useState<PriceDialogState | null>(null)
  const [manualQuantity, setManualQuantity] = useState('')
  const [selectedWorker, setSelectedWorker] = useState<{ id: string; name: string } | null>(null)
  const [workerDetails, setWorkerDetails] = useState<readonly ModelAccountWorkerDetail[]>([])
  const [editedQuantities, setEditedQuantities] = useState<Readonly<Record<string, string>>>({})
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null)

  const canManageManual = permissionCodes.includes('patta.hisob.manual_manage')
  const canManageModels = permissionCodes.includes('models.manage')

  const currentModel = useMemo(() => {
    return models.find((m) => m.id === modelId) || models[0] || null
  }, [models, modelId])

  useEffect(() => {
    let active = true
    const loadData = async (): Promise<void> => {
      try {
        let modelOptions: readonly DesktopModelOption[] = []
        try {
          modelOptions = await window.erp.modelAccount.models()
        } catch {
          if (window.erp?.pattaPrint?.models) {
            modelOptions = await window.erp.pattaPrint.models().catch(() => [])
          }
        }
        if (!active) return
        setModels(modelOptions)
        const initialModelId = modelOptions[0]?.id || ''
        setModelId((current) => current || initialModelId)

        const session = await window.erp.auth.session().catch(() => null)
        if (!active || !session) return
        setPermissionCodes(session.permission_codes || [])

        if (session.permission_codes.includes('patta.hisob.manual_manage')) {
          void window.erp.modelAccount
            .workers()
            .then((workers) => {
              if (active) setManualWorkers(workers)
            })
            .catch(() => {})
        }
      } catch {
        // Keep UI clean
      }
    }
    void loadData()
    return () => {
      active = false
    }
  }, [])

  const refreshAccount = useCallback(async (targetModelId: string): Promise<void> => {
    if (!targetModelId) return
    try {
      const result = await window.erp.modelAccount.get(targetModelId)
      setAccount(result)
      setLoadedModelId(targetModelId)
      setMessage(null)
    } catch {
      setLoadedModelId(targetModelId)
    }
  }, [])

  useEffect(() => {
    if (!modelId) return
    let active = true
    void window.erp.modelAccount
      .get(modelId)
      .then((result) => {
        if (!active) return
        setAccount(result)
        setLoadedModelId(modelId)
        setMessage(null)
      })
      .catch(() => {
        if (!active) return
        setLoadedModelId(modelId)
      })
    return () => {
      active = false
    }
  }, [modelId])

  useEffect(() => {
    if (!modelId || !canManageManual) return
    let active = true
    const enteredAt = new Date().toISOString()
    void window.erp.modelAccount
      .manualOperations(modelId, enteredAt)
      .then((operations) => {
        if (!active) return
        setManualOperations(operations)
        setManualOperationsModelId(modelId)
      })
      .catch((error: unknown) => {
        if (!active) return
        setManualOperations([])
        setManualOperationsModelId(modelId)
        setMessage(
          error instanceof Error ? error.message : 'Qo‘lda qo‘shish operatsiyalarini olib bo‘lmadi'
        )
      })
    return () => {
      active = false
    }
  }, [canManageManual, modelId])

  const availableManualOperations = manualOperationsModelId === modelId ? manualOperations : []

  const workerRows = useMemo<readonly WorkerAccountRow[]>(() => {
    const workers = new Map<
      string,
      { worker_name: string; contributions: Map<string, ModelAccountContributionRow> }
    >()
    for (const contribution of account?.rows ?? []) {
      const worker = workers.get(contribution.worker_id) ?? {
        worker_name: contribution.worker_name,
        contributions: new Map<string, ModelAccountContributionRow>()
      }
      worker.contributions.set(contribution.model_operation_id, contribution)
      workers.set(contribution.worker_id, worker)
    }
    return [...workers.entries()].map(([worker_id, worker]) => ({ worker_id, ...worker }))
  }, [account])

  const filteredWorkerRows = useMemo(() => {
    if (!searchQuery.trim()) return workerRows
    const query = searchQuery.toLowerCase().trim()
    return workerRows.filter(
      (w) =>
        w.worker_name.toLowerCase().includes(query) || w.worker_id.toLowerCase().includes(query)
    )
  }, [workerRows, searchQuery])

  const grandQuantity = useMemo(
    () =>
      account?.operations.reduce((sum, operation) => sum + BigInt(operation.quantity), 0n) ?? 0n,
    [account]
  )

  const grandAmount = useMemo(
    () =>
      account?.operations.reduce(
        (sum, operation) => sum + amountInMinorUnits(operation.gross_amount),
        0n
      ) ?? 0n,
    [account]
  )

  const loading = Boolean(modelId && loadedModelId !== modelId && !message)

  const openManualDialog = (
    workerId: string,
    workerName: string,
    modelOperationId: string
  ): void => {
    if (!canManageManual) return
    setManualDialog({
      worker_id: workerId,
      worker_name: workerName,
      model_operation_id: modelOperationId
    })
    setManualQuantity('')
    setMessage(null)
  }

  const openManualAdjustmentDialog = (): void => {
    if (!availableManualOperations[0]) return
    setManualDialog({
      worker_id: '',
      worker_name: '',
      model_operation_id: availableManualOperations[0].model_operation_id
    })
    setManualQuantity('')
    setMessage(null)
  }

  const addManual = async (): Promise<void> => {
    if (
      !manualDialog ||
      !manualDialog.worker_id ||
      !manualDialog.model_operation_id ||
      !Number.isSafeInteger(Number(manualQuantity)) ||
      Number(manualQuantity) < 1 ||
      isBusy
    ) {
      setMessage('Qo‘lda qo‘shiladigan soni musbat butun son bo‘lishi kerak')
      return
    }
    setIsBusy(true)
    try {
      await window.erp.modelAccount.addManual({
        model_id: modelId,
        model_operation_id: manualDialog.model_operation_id,
        worker_id: manualDialog.worker_id,
        quantity: Number(manualQuantity)
      })
      setManualDialog(null)
      setMessage('Qo‘shimcha mahalliy bazaga saqlandi')
      await refreshAccount(modelId)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Qo‘shimchani saqlab bo‘lmadi')
    } finally {
      setIsBusy(false)
    }
  }

  const changePrice = async (): Promise<void> => {
    if (
      !priceDialog ||
      !priceDialog.price ||
      isBusy ||
      !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(priceDialog.price)
    ) {
      setMessage('Narxni 0.00 ko‘rinishida kiriting')
      return
    }
    setIsBusy(true)
    try {
      await window.erp.modelAccount.changePrice({
        operation_id: priceDialog.model_operation_id,
        expected_version: priceDialog.version,
        price: priceDialog.price
      })
      setPriceDialog(null)
      setMessage('Yangi narx amalda. Eski yozuvlarning narx snapshoti o‘zgarmadi.')
      await refreshAccount(modelId)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Operatsiya narxini o‘zgartirib bo‘lmadi')
    } finally {
      setIsBusy(false)
    }
  }

  const openWorkerDetails = async (workerId: string, workerName: string): Promise<void> => {
    setSelectedWorker({ id: workerId, name: workerName })
    setLoadingDetails(true)
    try {
      const details = await window.erp.modelAccount.workerDetails(workerId)
      setWorkerDetails(details.filter((detail) => detail.model_id === modelId))
      setEditedQuantities(
        Object.fromEntries(
          details
            .filter((detail) => detail.model_id === modelId && detail.manual_adjustment_id !== null)
            .map((detail) => [detail.manual_adjustment_id ?? '', detail.quantity])
        )
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ishchi hisobini olib bo‘lmadi')
      setSelectedWorker(null)
    } finally {
      setLoadingDetails(false)
    }
  }

  const updateManual = async (detail: ModelAccountWorkerDetail): Promise<void> => {
    if (!detail.manual_adjustment_id || !detail.version || isBusy) return
    const quantity = Number(editedQuantities[detail.manual_adjustment_id] ?? detail.quantity)
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      setMessage('Qo‘lda qo‘shiladigan soni musbat butun son bo‘lishi kerak')
      return
    }
    setIsBusy(true)
    try {
      await window.erp.modelAccount.updateManual(
        detail.manual_adjustment_id,
        detail.version,
        quantity
      )
      setMessage('Qo‘shimcha tahrirlandi')
      await refreshAccount(modelId)
      if (selectedWorker) {
        const updatedDetails = await window.erp.modelAccount.workerDetails(selectedWorker.id)
        const scopedDetails = updatedDetails.filter((row) => row.model_id === modelId)
        setWorkerDetails(scopedDetails)
        setEditedQuantities(
          Object.fromEntries(
            scopedDetails
              .filter((row) => row.manual_adjustment_id !== null)
              .map((row) => [row.manual_adjustment_id ?? '', row.quantity])
          )
        )
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Qo‘shimchani tahrirlab bo‘lmadi')
    } finally {
      setIsBusy(false)
    }
  }

  const setManualTrashed = async (
    detail: ModelAccountWorkerDetail,
    restore: boolean
  ): Promise<void> => {
    if (!detail.manual_adjustment_id || !detail.version || isBusy) return
    if (!restore && !window.confirm('Qo‘lda qo‘shilgan yozuv Model hisobdan chiqarilsinmi?')) return
    setIsBusy(true)
    try {
      if (restore) {
        await window.erp.modelAccount.restoreManual(detail.manual_adjustment_id, detail.version)
      } else {
        await window.erp.modelAccount.trashManual(detail.manual_adjustment_id, detail.version)
      }
      setMessage(restore ? 'Qo‘shimcha tiklandi' : 'Qo‘shimcha Korzinkaga yuborildi')
      await refreshAccount(modelId)
      if (selectedWorker) {
        const updatedDetails = await window.erp.modelAccount.workerDetails(selectedWorker.id)
        const scopedDetails = updatedDetails.filter((row) => row.model_id === modelId)
        setWorkerDetails(scopedDetails)
        setEditedQuantities(
          Object.fromEntries(
            scopedDetails
              .filter((row) => row.manual_adjustment_id !== null)
              .map((row) => [row.manual_adjustment_id ?? '', row.quantity])
          )
        )
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Qo‘shimcha holatini o‘zgartirib bo‘lmadi'
      )
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div
      className="excel-grid-container model-account-page"
      aria-labelledby="model-account-title"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--bg-app)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden'
      }}
    >
      {/* Top Header Bar */}
      <div
        style={{
          padding: '12px 18px',
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          gap: '12px',
          flexWrap: 'wrap'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '34px',
              height: '34px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--primary-light)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--primary)',
              flexShrink: 0
            }}
          >
            <Layers size={18} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2
                id="model-account-title"
                style={{
                  margin: 0,
                  fontSize: '15px',
                  fontWeight: 800,
                  color: 'var(--text-primary)'
                }}
              >
                {currentModel ? currentModel.name : 'Model hisob'}
              </h2>
              <span
                style={{
                  fontSize: '11px',
                  background: 'var(--bg-surface-subtle)',
                  color: 'var(--text-secondary)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  fontWeight: 600
                }}
              >
                Hisob-Kitob
              </span>
            </div>
            <p style={{ margin: '2px 0 0', fontSize: '11.5px', color: 'var(--text-muted)' }}>
              Patta ishlab chiqarishi va qo‘lda qo‘shilgan yozuvlar alohida ko‘rinadi
            </p>
          </div>

          {/* Model Selector */}
          <div style={{ marginLeft: '12px' }}>
            <label className="visually-hidden" htmlFor="model-account-select">
              MODEL
            </label>
            <select
              id="model-account-select"
              aria-label="MODEL"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={models.length === 0}
              className="soft-input"
              style={{
                height: '32px',
                minWidth: '160px',
                fontWeight: 700,
                fontSize: '12.5px',
                borderRadius: 'var(--radius-full)',
                padding: '0 12px',
                cursor: 'pointer'
              }}
            >
              {models.length === 0 ? (
                <option value="">Modellar mavjud emas</option>
              ) : (
                models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {/* Search Box */}
          <div style={{ position: 'relative', width: '200px' }}>
            <Search
              size={14}
              color="var(--text-muted)"
              style={{ position: 'absolute', left: '10px', top: '9px' }}
            />
            <input
              type="text"
              placeholder="Ishchi qidirish..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="soft-input"
              style={{
                paddingLeft: '30px',
                height: '32px',
                borderRadius: 'var(--radius-full)',
                fontSize: '12px'
              }}
            />
          </div>

          {canManageManual && availableManualOperations.length > 0 ? (
            <button
              className="soft-btn soft-btn-primary"
              type="button"
              onClick={openManualAdjustmentDialog}
              style={{
                borderRadius: 'var(--radius-full)',
                padding: '6px 14px',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <Plus size={14} />
              <span>+ Qo‘lda qo‘shish</span>
            </button>
          ) : null}

          {/* Grand Total Metric Pill */}
          {account ? (
            <div
              style={{
                fontSize: '12px',
                fontWeight: 700,
                color: 'var(--primary)',
                background: 'var(--primary-light)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                padding: '6px 14px',
                borderRadius: 'var(--radius-full)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <DollarSign size={14} color="var(--primary)" />
              <span>
                Jami: {formatMinorUnits(grandAmount)} ({formatQuantity(grandQuantity.toString())}{' '}
                dona)
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {message ? (
        <div
          role="status"
          style={{
            margin: '12px 18px 0',
            padding: '10px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            color: 'var(--danger)',
            fontSize: '12.5px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}
        >
          <AlertTriangle size={15} style={{ flexShrink: 0 }} />
          <span>{message}</span>
        </div>
      ) : null}

      {/* Grid Table */}
      {loading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)'
          }}
        >
          <p className="entry-empty-state">Hisob yangilanmoqda…</p>
        </div>
      ) : account ? (
        account.operations.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)'
            }}
          >
            <p className="entry-empty-state">Modelda operatsiya yo‘q.</p>
          </div>
        ) : (
          <div
            className="excel-grid-container model-account-table-wrap"
            style={{ flex: 1, overflow: 'auto', background: 'var(--bg-app)' }}
          >
            <table
              className="excel-table model-account-table model-account-v3-table"
              style={{
                width: 'max-content',
                minWidth: '100%',
                borderCollapse: 'separate',
                borderSpacing: 0
              }}
            >
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-surface-subtle)' }}>
                  <th
                    scope="col"
                    className="model-account-worker-id"
                    style={{
                      position: 'sticky',
                      left: 0,
                      top: 0,
                      zIndex: 29,
                      backgroundColor: 'var(--bg-surface-subtle)',
                      fontWeight: 700,
                      textAlign: 'center',
                      padding: '8px 12px',
                      borderRight: '1px solid var(--border-subtle)',
                      borderBottom: '1px solid var(--border-subtle)'
                    }}
                  >
                    ISHCHI ID
                  </th>
                  <th
                    scope="col"
                    className="model-account-worker-name"
                    style={{
                      position: 'sticky',
                      left: '60px',
                      top: 0,
                      zIndex: 29,
                      backgroundColor: 'var(--bg-surface-subtle)',
                      fontWeight: 700,
                      textAlign: 'left',
                      padding: '8px 14px',
                      borderRight: '1px solid var(--border-subtle)',
                      borderBottom: '1px solid var(--border-subtle)'
                    }}
                  >
                    F.I.O.
                  </th>
                  {account.operations.map((operation) => (
                    <th
                      scope="col"
                      key={operation.model_operation_id}
                      style={{
                        position: 'sticky',
                        top: 0,
                        zIndex: 19,
                        backgroundColor: 'var(--bg-surface-subtle)',
                        fontWeight: 700,
                        textAlign: 'center',
                        padding: '6px 12px',
                        borderRight: '1px solid var(--border-subtle)',
                        borderBottom: '1px solid var(--border-subtle)'
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '2px'
                        }}
                      >
                        <span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                          {operation.operation_name}
                        </span>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            fontSize: '11px',
                            color: 'var(--text-secondary)'
                          }}
                        >
                          <span>Narx {formatMoney(operation.current_price)}</span>
                          {canManageModels &&
                          operation.status === 'ACTIVE' &&
                          operation.current_price !== null ? (
                            <button
                              type="button"
                              className="model-account-price-edit soft-btn"
                              style={{
                                padding: '2px 8px',
                                fontSize: '10.5px',
                                borderRadius: 'var(--radius-sm)',
                                background: 'rgba(245, 158, 11, 0.15)',
                                color: '#b45309',
                                border: '1px solid rgba(245, 158, 11, 0.3)',
                                cursor: 'pointer'
                              }}
                              onClick={() =>
                                setPriceDialog({
                                  model_operation_id: operation.model_operation_id,
                                  operation_name: operation.operation_name,
                                  version: operation.version,
                                  price: operation.current_price
                                })
                              }
                            >
                              O‘zgartirish
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="model-account-total"
                    style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 19,
                      backgroundColor: 'var(--primary-light)',
                      color: 'var(--primary)',
                      borderLeft: '2px solid var(--primary)',
                      borderBottom: '1px solid var(--border-subtle)',
                      fontWeight: 800,
                      textAlign: 'center',
                      padding: '8px 14px'
                    }}
                  >
                    Jami
                  </th>
                </tr>
              </thead>
              <tbody>
                {account.rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={account.operations.length + 3}
                      className="model-account-empty"
                      style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}
                    >
                      Hozircha ishlab chiqarish yo‘q.
                    </td>
                  </tr>
                ) : (
                  filteredWorkerRows.map((worker) => {
                    const isHovered = hoveredRowId === worker.worker_id
                    return (
                      <tr
                        key={worker.worker_id}
                        className="fast-row"
                        onMouseEnter={() => setHoveredRowId(worker.worker_id)}
                        onMouseLeave={() => setHoveredRowId(null)}
                        style={{
                          backgroundColor: isHovered
                            ? 'var(--bg-surface-hover)'
                            : 'var(--bg-surface)',
                          transition: 'background-color 0.12s ease'
                        }}
                      >
                        <th
                          className="model-account-worker-id"
                          scope="row"
                          style={{
                            position: 'sticky',
                            left: 0,
                            zIndex: 8,
                            backgroundColor: isHovered
                              ? 'var(--bg-surface-hover)'
                              : 'var(--bg-surface)',
                            textAlign: 'center',
                            padding: '6px 8px',
                            borderRight: '1px solid var(--border-subtle)',
                            borderBottom: '1px solid var(--border-subtle)',
                            fontWeight: 700
                          }}
                        >
                          <span
                            style={{
                              background: isHovered
                                ? 'var(--border-default)'
                                : 'var(--bg-surface-subtle)',
                              padding: '2px 8px',
                              borderRadius: 'var(--radius-full)',
                              fontSize: '11.5px',
                              color: isHovered ? 'var(--text-primary)' : 'var(--text-secondary)'
                            }}
                          >
                            {worker.worker_id}
                          </span>
                        </th>
                        <td
                          className="model-account-worker-name"
                          style={{
                            position: 'sticky',
                            left: '60px',
                            zIndex: 8,
                            backgroundColor: isHovered
                              ? 'var(--bg-surface-hover)'
                              : 'var(--bg-surface)',
                            padding: '6px 14px',
                            whiteSpace: 'nowrap',
                            borderRight: '1px solid var(--border-subtle)',
                            borderBottom: '1px solid var(--border-subtle)'
                          }}
                        >
                          <button
                            className="model-account-worker"
                            type="button"
                            onClick={() =>
                              void openWorkerDetails(worker.worker_id, worker.worker_name)
                            }
                            title="Ishchi tafsilotlarini ochish"
                            style={{
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              color: 'var(--primary)',
                              fontWeight: 600,
                              fontSize: '13px',
                              textAlign: 'left',
                              padding: 0
                            }}
                          >
                            <span>{worker.worker_name}</span>
                          </button>
                        </td>
                        {account.operations.map((operation) => {
                          const contribution = worker.contributions.get(
                            operation.model_operation_id
                          )
                          return (
                            <td
                              key={operation.model_operation_id}
                              style={{
                                padding: '6px 10px',
                                textAlign: 'center',
                                borderRight: '1px solid var(--border-subtle)',
                                borderBottom: '1px solid var(--border-subtle)',
                                backgroundColor:
                                  contribution && Number(contribution.total_quantity) > 0
                                    ? 'var(--primary-light)'
                                    : 'transparent'
                              }}
                            >
                              {contribution ? (
                                <div
                                  className="model-account-quantity-cell"
                                  style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    gap: '2px'
                                  }}
                                >
                                  <strong
                                    style={{ fontSize: '13px', color: 'var(--text-primary)' }}
                                  >
                                    {formatQuantity(contribution.total_quantity)}
                                  </strong>
                                  <small
                                    style={{ fontSize: '10.5px', color: 'var(--text-secondary)' }}
                                  >
                                    Patta {formatQuantity(contribution.patta_quantity)} · Mustaqil{' '}
                                    {formatQuantity(contribution.standalone_quantity)} · Qo‘lda{' '}
                                    {formatQuantity(contribution.manual_quantity)}
                                  </small>
                                  <small
                                    style={{
                                      fontSize: '11px',
                                      fontWeight: 600,
                                      color: 'var(--primary)'
                                    }}
                                  >
                                    {formatMoney(contribution.gross_amount)}
                                  </small>
                                  {canManageManual &&
                                  availableManualOperations.some(
                                    (item) =>
                                      item.model_operation_id === operation.model_operation_id
                                  ) ? (
                                    <button
                                      type="button"
                                      className="entry-row-clear-button soft-btn"
                                      style={{
                                        padding: '2px 6px',
                                        fontSize: '10px',
                                        borderRadius: 'var(--radius-sm)',
                                        marginTop: '2px',
                                        background: 'var(--bg-surface-subtle)',
                                        color: 'var(--text-secondary)',
                                        border: '1px solid var(--border-subtle)'
                                      }}
                                      onClick={() =>
                                        openManualDialog(
                                          worker.worker_id,
                                          worker.worker_name,
                                          operation.model_operation_id
                                        )
                                      }
                                    >
                                      + Qo‘shish
                                    </button>
                                  ) : null}
                                </div>
                              ) : canManageManual &&
                                availableManualOperations.some(
                                  (item) => item.model_operation_id === operation.model_operation_id
                                ) ? (
                                <button
                                  type="button"
                                  className="entry-row-clear-button model-account-add-empty soft-btn"
                                  style={{
                                    padding: '3px 8px',
                                    fontSize: '11px',
                                    borderRadius: 'var(--radius-sm)',
                                    background: 'var(--bg-surface-subtle)',
                                    color: 'var(--text-muted)',
                                    border: '1px dashed var(--border-subtle)'
                                  }}
                                  onClick={() =>
                                    openManualDialog(
                                      worker.worker_id,
                                      worker.worker_name,
                                      operation.model_operation_id
                                    )
                                  }
                                >
                                  + Qo‘shish
                                </button>
                              ) : (
                                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                                  0
                                </span>
                              )}
                            </td>
                          )
                        })}
                        <td
                          className="model-account-total"
                          style={{
                            textAlign: 'right',
                            fontWeight: 700,
                            padding: '6px 14px',
                            borderLeft: '2px solid var(--primary)',
                            borderBottom: '1px solid var(--border-subtle)',
                            color: 'var(--primary)',
                            fontSize: '13px',
                            backgroundColor: 'var(--primary-light)'
                          }}
                        >
                          {formatQuantity(
                            [...worker.contributions.values()]
                              .reduce((sum, item) => sum + BigInt(item.total_quantity), 0n)
                              .toString()
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
              <tfoot>
                <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', fontWeight: 700 }}>
                  <th
                    scope="row"
                    colSpan={2}
                    style={{
                      padding: '8px 14px',
                      textAlign: 'left',
                      borderBottom: '1px solid var(--border-subtle)'
                    }}
                  >
                    Jami dona
                  </th>
                  {account.operations.map((operation) => (
                    <td
                      key={operation.model_operation_id}
                      style={{
                        textAlign: 'center',
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--border-subtle)'
                      }}
                    >
                      {formatQuantity(operation.quantity)}
                    </td>
                  ))}
                  <td
                    className="model-account-total"
                    style={{
                      textAlign: 'right',
                      padding: '8px 14px',
                      borderLeft: '2px solid var(--primary)',
                      borderBottom: '1px solid var(--border-subtle)',
                      color: 'var(--primary)',
                      fontWeight: 800
                    }}
                  >
                    {formatQuantity(grandQuantity.toString())}
                  </td>
                </tr>
                <tr style={{ backgroundColor: 'var(--bg-surface-subtle)', fontWeight: 700 }}>
                  <th scope="row" colSpan={2} style={{ padding: '8px 14px', textAlign: 'left' }}>
                    Jami so‘m
                  </th>
                  {account.operations.map((operation) => (
                    <td
                      key={operation.model_operation_id}
                      style={{ textAlign: 'center', padding: '8px 10px', color: 'var(--primary)' }}
                    >
                      {formatMoney(operation.gross_amount)}
                    </td>
                  ))}
                  <td
                    className="model-account-total"
                    style={{
                      textAlign: 'right',
                      padding: '8px 14px',
                      borderLeft: '2px solid var(--primary)',
                      color: 'var(--primary)',
                      fontWeight: 800
                    }}
                  >
                    {formatMinorUnits(grandAmount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '40px 20px',
            gap: '12px',
            color: 'var(--text-muted)'
          }}
        >
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              background: 'var(--bg-surface-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)'
            }}
          >
            <Layers size={24} />
          </div>
          <p className="entry-empty-state" style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
            {models.length === 0
              ? 'Modellar mavjud emas yoki hali yuklanmagan.'
              : 'Modelni tanlang.'}
          </p>
        </div>
      )}

      {/* Manual Dialog */}
      {manualDialog ? (
        <div className="modal-overlay" style={{ zIndex: 1000 }}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-adjustment-title"
            style={{ width: '440px', maxWidth: '92vw' }}
          >
            <div className="modal-header">
              <div>
                <p
                  className="print-kicker"
                  style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 700, margin: 0 }}
                >
                  QO‘LDA QO‘SHISH
                </p>
                <h3
                  id="manual-adjustment-title"
                  style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 800 }}
                >
                  {manualDialog.worker_name || 'Ishchiga qo‘shish'}
                </h3>
              </div>
              <button
                className="modal-close-btn"
                type="button"
                onClick={() => setManualDialog(null)}
                aria-label="Yopish"
              >
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                padding: '16px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px'
              }}
            >
              <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                Operatsiya:{' '}
                <strong>
                  {account?.operations.find(
                    (op) => op.model_operation_id === manualDialog.model_operation_id
                  )?.operation_name ?? '—'}
                </strong>
              </p>

              <label
                className="print-field"
                style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
              >
                <span
                  className="print-label"
                  style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}
                >
                  ISHCHI
                </span>
                <select
                  value={manualDialog.worker_id}
                  onChange={(event) => {
                    const worker = manualWorkers.find((item) => item.id === event.target.value)
                    setManualDialog((current) =>
                      current
                        ? {
                            ...current,
                            worker_id: event.target.value,
                            worker_name: worker?.name ?? ''
                          }
                        : current
                    )
                  }}
                  disabled={manualWorkers.length === 0}
                  className="soft-input"
                  style={{ height: '36px' }}
                >
                  <option value="">Ishchini tanlang</option>
                  {manualWorkers.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.name}
                    </option>
                  ))}
                </select>
              </label>

              <label
                className="print-field"
                style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
              >
                <span
                  className="print-label"
                  style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}
                >
                  OPERATSIYA
                </span>
                <select
                  value={manualDialog.model_operation_id}
                  onChange={(event) =>
                    setManualDialog((current) =>
                      current ? { ...current, model_operation_id: event.target.value } : current
                    )
                  }
                  className="soft-input"
                  style={{ height: '36px' }}
                >
                  {availableManualOperations.map((operation) => (
                    <option key={operation.model_operation_id} value={operation.model_operation_id}>
                      {operation.operation_name_snapshot}
                    </option>
                  ))}
                </select>
              </label>

              <label
                className="print-field"
                style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
              >
                <span
                  className="print-label"
                  style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}
                >
                  SONI
                </span>
                <input
                  value={manualQuantity}
                  onChange={(event) => setManualQuantity(event.target.value)}
                  inputMode="numeric"
                  className="soft-input"
                  style={{ height: '36px' }}
                  autoFocus
                />
              </label>
            </div>

            <div
              className="modal-footer"
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                padding: '12px 20px',
                borderTop: '1px solid var(--border-subtle)'
              }}
            >
              <button
                className="soft-btn soft-btn-secondary"
                type="button"
                onClick={() => setManualDialog(null)}
              >
                Bekor qilish
              </button>
              <button
                className="soft-btn soft-btn-primary"
                type="button"
                disabled={isBusy}
                onClick={() => void addManual()}
              >
                {isBusy ? 'Saqlanmoqda…' : 'Qo‘shish'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* Price Dialog */}
      {priceDialog ? (
        <div className="modal-overlay" style={{ zIndex: 1000 }}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="operation-price-title"
            style={{ width: '440px', maxWidth: '92vw' }}
          >
            <div className="modal-header">
              <div>
                <p
                  className="print-kicker"
                  style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 700, margin: 0 }}
                >
                  MODELLARNI BOSHQARISH
                </p>
                <h3
                  id="operation-price-title"
                  style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 800 }}
                >
                  {priceDialog.operation_name} · narx
                </h3>
              </div>
              <button
                className="modal-close-btn"
                type="button"
                onClick={() => setPriceDialog(null)}
                aria-label="Yopish"
              >
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                padding: '16px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px'
              }}
            >
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)' }}>
                Yangi narx server vaqtidan boshlab kuchga kiradi. Eski Patta va qo‘lda qo‘shilgan
                yozuvlarning narxi o‘zgarmaydi.
              </p>
              <label
                className="print-field"
                style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
              >
                <span
                  className="print-label"
                  style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}
                >
                  NARX · SO‘M
                </span>
                <input
                  value={priceDialog.price ?? ''}
                  onChange={(event) =>
                    setPriceDialog((current) =>
                      current ? { ...current, price: event.target.value } : current
                    )
                  }
                  inputMode="decimal"
                  className="soft-input"
                  style={{ height: '36px' }}
                  autoFocus
                />
              </label>
            </div>

            <div
              className="modal-footer"
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '8px',
                padding: '12px 20px',
                borderTop: '1px solid var(--border-subtle)'
              }}
            >
              <button
                className="soft-btn soft-btn-secondary"
                type="button"
                onClick={() => setPriceDialog(null)}
              >
                Bekor qilish
              </button>
              <button
                className="soft-btn soft-btn-primary"
                type="button"
                disabled={isBusy}
                onClick={() => void changePrice()}
              >
                {isBusy ? 'Saqlanmoqda…' : 'Narxni saqlash'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* Selected Worker Detail Modal */}
      {selectedWorker ? (
        <div className="modal-overlay" style={{ zIndex: 1000 }}>
          <section
            className="modal-card model-account-details"
            role="dialog"
            aria-modal="true"
            aria-labelledby="worker-details-title"
            style={{
              width: '560px',
              maxWidth: '94vw',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div className="modal-header">
              <div>
                <p
                  className="print-kicker"
                  style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 700, margin: 0 }}
                >
                  ISHCHI HISOBI · #{selectedWorker.id}
                </p>
                <h3
                  id="worker-details-title"
                  style={{ margin: '4px 0 0', fontSize: '16px', fontWeight: 800 }}
                >
                  {selectedWorker.name}
                </h3>
              </div>
              <button
                className="modal-close-btn"
                type="button"
                onClick={() => setSelectedWorker(null)}
                aria-label="Yopish"
              >
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                padding: '16px 20px',
                overflowY: 'auto',
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px'
              }}
            >
              {loadingDetails ? (
                <p className="entry-empty-state">Tafsilotlar yuklanmoqda…</p>
              ) : workerDetails.length === 0 ? (
                <p className="entry-empty-state">Bu ishchi uchun yozuv yo‘q.</p>
              ) : (
                workerDetails.map((detail, index) => (
                  <article
                    className="model-account-detail-row"
                    key={`${detail.source}-${detail.manual_adjustment_id ?? detail.entered_at}-${index}`}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-surface-subtle)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px'
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start'
                      }}
                    >
                      <div>
                        <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                          {detail.operation_name}
                        </strong>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {detail.source === 'PATTA'
                            ? 'Patta'
                            : detail.source === 'STANDALONE'
                              ? 'Mustaqil'
                              : 'Qo‘lda'}{' '}
                          · {displayDate(detail.entered_at)}
                        </div>
                        <div
                          style={{ fontSize: '11.5px', color: 'var(--primary)', fontWeight: 600 }}
                        >
                          {formatQuantity(detail.quantity)} ×{' '}
                          {formatMoney(detail.unit_price_snapshot)} ={' '}
                          {formatMoney(detail.gross_amount)}
                        </div>
                        {detail.deleted_at ? (
                          <div style={{ fontSize: '10.5px', color: '#ef4444' }}>
                            O‘chirilgan: {displayDate(detail.deleted_at)}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {detail.source === 'MANUAL' &&
                    canManageManual &&
                    detail.manual_adjustment_id &&
                    detail.version ? (
                      <div
                        className="model-account-detail-actions"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          marginTop: '6px',
                          paddingTop: '6px',
                          borderTop: '1px solid var(--border-subtle)'
                        }}
                      >
                        {detail.deleted_at === null ? (
                          <>
                            <label
                              className="print-field"
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                margin: 0
                              }}
                            >
                              <span className="print-label" style={{ fontSize: '11px' }}>
                                SONI
                              </span>
                              <input
                                inputMode="numeric"
                                value={
                                  editedQuantities[detail.manual_adjustment_id] ?? detail.quantity
                                }
                                onChange={(event) =>
                                  setEditedQuantities((current) => ({
                                    ...current,
                                    [detail.manual_adjustment_id ?? '']: event.target.value
                                  }))
                                }
                                className="soft-input"
                                style={{ width: '80px', height: '30px', textAlign: 'center' }}
                              />
                            </label>
                            <button
                              className="soft-btn soft-btn-primary"
                              type="button"
                              disabled={isBusy}
                              onClick={() => void updateManual(detail)}
                              style={{ padding: '4px 10px', fontSize: '11.5px' }}
                            >
                              Saqlash
                            </button>
                            <button
                              className="soft-btn"
                              type="button"
                              disabled={isBusy}
                              onClick={() => void setManualTrashed(detail, false)}
                              style={{
                                padding: '4px 10px',
                                fontSize: '11.5px',
                                background: '#fee2e2',
                                color: '#dc2626',
                                border: '1px solid #fecaca'
                              }}
                            >
                              O‘chirish
                            </button>
                          </>
                        ) : (
                          <button
                            className="soft-btn soft-btn-primary"
                            type="button"
                            disabled={isBusy}
                            onClick={() => void setManualTrashed(detail, true)}
                            style={{ padding: '4px 10px', fontSize: '11.5px' }}
                          >
                            Tiklash
                          </button>
                        )}
                      </div>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}
