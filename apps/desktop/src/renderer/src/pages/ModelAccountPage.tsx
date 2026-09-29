import { useEffect, useMemo, useState } from 'react'
import type { DesktopModelAccountSheet, DesktopModelOption } from '../../../preload/erp-api'

interface WorkerAccountRow {
  worker_id: string
  worker_name: string
  quantities: ReadonlyMap<string, bigint>
}

function formatQuantity(value: bigint): string {
  return new Intl.NumberFormat('uz-UZ').format(value)
}

export function ModelAccountPage(): React.JSX.Element {
  const [models, setModels] = useState<readonly DesktopModelOption[]>([])
  const [modelId, setModelId] = useState('')
  const [account, setAccount] = useState<DesktopModelAccountSheet | null>(null)
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
    void window.erp.modelAccount.get(modelId).then((result) => {
      if (!active) return
      setAccount(result)
      setMessage(null)
    }).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : 'Model hisobini olib bo‘lmadi')
    })
    return () => { active = false }
  }, [modelId])

  const workerRows = useMemo<readonly WorkerAccountRow[]>(() => {
    if (!account) return []
    const workers = new Map<string, { worker_name: string; quantities: Map<string, bigint> }>()
    for (const row of account.rows) {
      const worker = workers.get(row.worker_id) ?? { worker_name: row.worker_name, quantities: new Map<string, bigint>() }
      worker.quantities.set(row.model_operation_id,
        (worker.quantities.get(row.model_operation_id) ?? 0n) + BigInt(row.quantity))
      workers.set(row.worker_id, worker)
    }
    return [...workers.entries()].map(([worker_id, worker]) => ({ worker_id, ...worker }))
  }, [account])

  const operationTotals = useMemo(() => {
    const totals = new Map<string, bigint>()
    for (const worker of workerRows) {
      for (const [operationId, quantity] of worker.quantities) {
        totals.set(operationId, (totals.get(operationId) ?? 0n) + quantity)
      }
    }
    return totals
  }, [workerRows])

  const totalForWorker = (worker: WorkerAccountRow): bigint =>
    [...worker.quantities.values()].reduce((total, quantity) => total + quantity, 0n)

  const grandTotal = [...operationTotals.values()].reduce((total, quantity) => total + quantity, 0n)
  const loading = Boolean(modelId && account?.model_id !== modelId && !message)

  return (
    <section className="patta-entry-page" aria-labelledby="model-account-title">
      <header className="print-page-heading">
        <div>
          <p className="print-kicker"><span className="print-kicker-mark" /> ISHLAB CHIQARISH / HISOB</p>
          <h2 id="model-account-title">Model hisob</h2>
          <p className="print-intro">Hisob faol Patta va o‘chirilmagan varaq qatorlaridan avtomatik tuziladi.</p>
        </div>
      </header>
      <label className="print-field entry-model-filter">
        <span className="print-label">MODEL</span>
        <select value={modelId} onChange={(event) => setModelId(event.target.value)} disabled={models.length === 0}>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      {message ? <p className="print-status-message" role="status">{message}</p> : null}
      {loading ? <p className="entry-empty-state">Hisob yangilanmoqda…</p> : account ? (
        account.operations.length === 0 ? <p className="entry-empty-state">Modelda operatsiya yo‘q.</p> : (
          <div className="model-account-table-wrap">
            <table className="model-account-table">
              <thead>
                <tr>
                  <th scope="col">ISHCHI</th>
                  {account.operations.map((operation) => (
                    <th scope="col" key={operation.model_operation_id}>{operation.operation_name}</th>
                  ))}
                  <th scope="col" className="model-account-total">Jami</th>
                </tr>
              </thead>
              <tbody>
                {workerRows.length === 0 ? (
                  <tr><td colSpan={account.operations.length + 2} className="model-account-empty">Hozircha topshiriq yo‘q.</td></tr>
                ) : workerRows.map((worker) => (
                  <tr key={worker.worker_id}>
                    <th scope="row">
                      <span>{worker.worker_name}</span>
                      <small>#{worker.worker_id}</small>
                    </th>
                    {account.operations.map((operation) => (
                      <td key={operation.model_operation_id}>
                        {formatQuantity(worker.quantities.get(operation.model_operation_id) ?? 0n)}
                      </td>
                    ))}
                    <td className="model-account-total">{formatQuantity(totalForWorker(worker))}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Jami</th>
                  {account.operations.map((operation) => (
                    <td key={operation.model_operation_id}>
                      {formatQuantity(operationTotals.get(operation.model_operation_id) ?? 0n)}
                    </td>
                  ))}
                  <td className="model-account-total">{formatQuantity(grandTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : <p className="entry-empty-state">Modelni tanlang.</p>}
    </section>
  )
}
