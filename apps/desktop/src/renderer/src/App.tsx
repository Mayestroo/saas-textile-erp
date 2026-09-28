import { useEffect, useState } from 'react'
import type { DesktopSyncRunResult, DesktopSyncStatus } from '../../preload/erp-api'
import Versions from './components/Versions'

function connectivityLabel(connectivity: DesktopSyncStatus['connectivity']): string {
  if (connectivity === 'ONLINE') return 'Onlayn'
  if (connectivity === 'AUTH_REQUIRED') return 'Tizimga kirish kerak'
  return 'Oflayn'
}

function runResultMessage(result: DesktopSyncRunResult): string {
  if (result.status === 'COMPLETED') return 'Sinxronlash yakunlandi'
  if (result.status === 'AUTH_REQUIRED') return 'Sinxronlash uchun tizimga kiring'
  if (result.status === 'OFFLINE') return 'Ulanish yo‘q. Mahalliy ishlar davom etadi.'
  return 'Sinxronlashni yakunlab bo‘lmadi'
}

function App(): React.JSX.Element {
  const [syncStatus, setSyncStatus] = useState<DesktopSyncStatus | null>(null)
  const [runMessage, setRunMessage] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)

  useEffect(() => {
    let isMounted = true
    void window.erp.sync
      .status()
      .then((status) => {
        if (isMounted) setSyncStatus(status)
      })
      .catch(() => {
        if (isMounted) setRunMessage('Sinxronlash holatini olishda xatolik')
      })
    return () => {
      isMounted = false
    }
  }, [])

  const runSync = async (): Promise<void> => {
    setIsRunning(true)
    setRunMessage(null)
    try {
      const result = await window.erp.sync.run()
      setRunMessage(runResultMessage(result))
      setSyncStatus(await window.erp.sync.status())
    } catch {
      setRunMessage('Sinxronlashda xatolik yuz berdi')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <main className="erp-shell">
      <header className="erp-header">
        <p className="erp-eyebrow">To‘qimachilik korxonasi</p>
        <h1>Textile ERP</h1>
        <p className="erp-subtitle">Mahalliy ishlar internet bo‘lmaganda ham saqlanadi</p>
      </header>

      <section className="sync-card" aria-labelledby="sync-heading">
        <div className="sync-card-heading">
          <div>
            <h2 id="sync-heading">Sinxronlash</h2>
            <p className="sync-connectivity" aria-live="polite">
              {syncStatus ? connectivityLabel(syncStatus.connectivity) : 'Holat aniqlanmoqda'}
            </p>
          </div>
          <span
            className={`sync-indicator ${syncStatus?.connectivity.toLowerCase() ?? 'unknown'}`}
            aria-hidden="true"
          />
        </div>

        <dl className="sync-counts">
          <div>
            <dt>Sinxronlanmagan</dt>
            <dd>{syncStatus?.unsyncedCount ?? '—'}</dd>
          </div>
          <div>
            <dt>Ochiq ziddiyatlar</dt>
            <dd>{syncStatus?.conflictCount ?? '—'}</dd>
          </div>
        </dl>

        {runMessage ? (
          <p className="sync-message" role="status">
            {runMessage}
          </p>
        ) : null}
        <button className="sync-button" type="button" disabled={isRunning} onClick={runSync}>
          {isRunning ? 'Sinxronlanmoqda…' : 'Hozir sinxronlash'}
        </button>
      </section>

      <Versions />
    </main>
  )
}

export default App
