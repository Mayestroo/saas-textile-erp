import { useEffect, useState } from 'react'
import type {
  DesktopAuthStatus,
  DesktopSafeSession,
  DesktopSyncRunResult,
  DesktopSyncStatus
} from '../../preload/erp-api'
import { PattaPrintPage } from './pages/PattaPrintPage'
import { PattaEntryPage } from './pages/PattaEntryPage'
import { PattaHistoryPage } from './pages/PattaHistoryPage'
import { PattaTrashPage } from './pages/PattaTrashPage'
import { ModelAccountPage } from './pages/ModelAccountPage'

const EMPTY_AUTH_STATUS: DesktopAuthStatus = {
  state: 'REFRESHING',
  errorCode: null,
  message: null
}

function connectivityLabel(connectivity: DesktopSyncStatus['connectivity']): string {
  if (connectivity === 'ONLINE') return 'Onlayn'
  if (connectivity === 'AUTH_REQUIRED') return 'Tizimga kirish kerak'
  if (connectivity === 'DEVICE_NOT_CONFIGURED') return 'Qurilma ro‘yxatdan o‘tkazilmagan'
  return 'Oflayn'
}

function syncErrorMessage(code: string | null): string | null {
  if (code === 'DEVICE_NOT_CONFIGURED') return 'Qurilma ro‘yxatdan o‘tkazilmagan'
  if (code === 'DEVICE_TENANT_MISMATCH') return 'Qurilma bu korxonaga tegishli emas'
  if (code === 'DEVICE_NOT_ACTIVE' || code === 'DEVICE_NOT_FOUND') {
    return 'Qurilma ro‘yxatdan o‘tkazilmagan'
  }
  if (code === 'SESSION_EXPIRED' || code === 'AUTH_REQUIRED' || code === 'INVALID_ACCESS_TOKEN') {
    return 'Sessiya muddati tugagan'
  }
  if (code === 'NETWORK_ERROR' || code === 'SYNC_NETWORK_ERROR') return 'Internet bilan aloqa yo‘q'
  return null
}

function runResultMessage(result: DesktopSyncRunResult): string {
  if (result.status === 'COMPLETED') return 'Sinxronlash yakunlandi'
  if (result.status === 'DEVICE_NOT_CONFIGURED') return 'Qurilma ro‘yxatdan o‘tkazilmagan'
  if (result.status === 'AUTH_REQUIRED') return 'Sessiya muddati tugagan'
  if (result.status === 'OFFLINE') return 'Internet bilan aloqa yo‘q. Mahalliy ma’lumotlar saqlanadi.'
  return syncErrorMessage(result.errorCode ?? null) ?? 'Sinxronlashni yakunlab bo‘lmadi'
}

function hasLocalSession(session: DesktopSafeSession | null, state: DesktopAuthStatus['state']): boolean {
  return (
    session !== null &&
    session.company !== null &&
    (state === 'AUTHENTICATED' ||
      state === 'OFFLINE_SESSION_PENDING' ||
      state === 'REFRESHING')
  )
}

function App(): React.JSX.Element {
  const [authStatus, setAuthStatus] = useState(EMPTY_AUTH_STATUS)
  const [session, setSession] = useState<DesktopSafeSession | null>(null)
  const [syncStatus, setSyncStatus] = useState<DesktopSyncStatus | null>(null)
  const [tenantUrl, setTenantUrl] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [factoryScreen, setFactoryScreen] = useState<'print' | 'entry' | 'history' | 'trash' | 'account'>('print')

  useEffect(() => {
    let isMounted = true
    const refreshScreen = async (): Promise<void> => {
      try {
        const [nextAuthStatus, nextSession] = await Promise.all([
          window.erp.auth.status(),
          window.erp.auth.session()
        ])
        if (!isMounted) return
        setAuthStatus(nextAuthStatus)
        setSession(nextSession)
        if (
          nextAuthStatus.state === 'AUTHENTICATED' ||
          nextAuthStatus.state === 'OFFLINE_SESSION_PENDING' ||
          nextAuthStatus.state === 'REFRESHING'
        ) {
          setSyncStatus(await window.erp.sync.status())
        } else {
          setSyncStatus(null)
        }
      } catch {
        if (isMounted) {
          setAuthStatus({ state: 'ERROR', errorCode: 'AUTH_OPERATION_FAILED', message: 'Holatni olib bo‘lmadi' })
        }
      }
    }

    void refreshScreen()
    const timer = setInterval(() => void refreshScreen(), 2_000)
    void window.erp.app
      .getVersion()
      .then((version) => {
        if (isMounted) setAppVersion(version)
      })
      .catch(() => undefined)

    return () => {
      isMounted = false
      clearInterval(timer)
    }
  }, [])

  const submitLogin = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    setSyncMessage(null)
    setPassword('')
    setAuthStatus({ state: 'AUTHENTICATING', errorCode: null, message: null })
    try {
      const result = await window.erp.auth.login({ tenantUrl, email, password })
      setAuthStatus(result)
      setSession(await window.erp.auth.session())
      if (result.state === 'AUTHENTICATED') setSyncStatus(await window.erp.sync.status())
    } catch {
      setAuthStatus({
        state: 'ERROR',
        errorCode: 'AUTH_OPERATION_FAILED',
        message: 'Kirishni bajarib bo‘lmadi'
      })
    } finally {
      setPassword('')
      setIsSubmitting(false)
    }
  }

  const runSync = async (): Promise<void> => {
    setIsSyncing(true)
    setSyncMessage(null)
    try {
      const result = await window.erp.sync.run()
      setSyncMessage(runResultMessage(result))
      setSyncStatus(await window.erp.sync.status())
      const currentAuth = await window.erp.auth.status()
      setAuthStatus(currentAuth)
      setSession(await window.erp.auth.session())
    } catch {
      setSyncMessage('Sinxronlashni yakunlab bo‘lmadi')
    } finally {
      setIsSyncing(false)
    }
  }

  const logout = async (): Promise<void> => {
    setPassword('')
    setSyncMessage(null)
    try {
      const result = await window.erp.auth.logout()
      setAuthStatus(result)
      setSession(await window.erp.auth.session())
      setSyncStatus(null)
    } catch {
      setAuthStatus({
        state: 'ERROR',
        errorCode: 'AUTH_OPERATION_FAILED',
        message: 'Tizimdan chiqib bo‘lmadi'
      })
    }
  }

  const sessionIsAvailable = hasLocalSession(session, authStatus.state)
  const deviceMessage = syncErrorMessage(syncStatus?.errorCode ?? null)

  return (
    <main className={`erp-shell ${sessionIsAvailable ? 'has-session' : ''}`}>
      <header className="erp-header">
        <p className="erp-eyebrow">To‘qimachilik korxonasi</p>
        <h1>Textile ERP</h1>
        <p className="erp-subtitle">Mahalliy ma’lumotlar internet bo‘lmaganda ham saqlanadi</p>
      </header>

      {sessionIsAvailable && session ? (
        <>
          <section className="session-card" aria-labelledby="session-heading">
            <div className="session-heading">
              <div>
                <p className="session-eyebrow">Korxona</p>
                <h2 id="session-heading">{session.company?.slug}</h2>
                <p className="session-user">{session.user?.full_name}</p>
              </div>
              <button className="logout-button" type="button" onClick={() => void logout()}>
                Chiqish
              </button>
            </div>
            {authStatus.state === 'OFFLINE_SESSION_PENDING' ? (
              <p className="state-message offline-message" role="status">
                Internet bilan aloqa yo‘q. Mahalliy ma’lumotlar saqlanadi.
              </p>
            ) : authStatus.state === 'REFRESHING' ? (
              <p className="state-message" role="status">Sessiya tekshirilmoqda…</p>
            ) : null}
          </section>

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

            {deviceMessage ? <p className="sync-message error-message" role="status">{deviceMessage}</p> : null}
            {syncMessage ? <p className="sync-message" role="status">{syncMessage}</p> : null}
            <button
              className="sync-button"
              type="button"
              disabled={isSyncing || syncStatus?.connectivity === 'DEVICE_NOT_CONFIGURED'}
              onClick={() => void runSync()}
            >
              {isSyncing ? 'Sinxronlanmoqda…' : 'Hozir sinxronlash'}
            </button>
          </section>
          <nav className="factory-navigation" aria-label="Ish bo‘limlari">
            <button type="button" className={factoryScreen === 'print' ? 'factory-nav-active' : ''}
              aria-current={factoryScreen === 'print' ? 'page' : undefined} onClick={() => setFactoryScreen('print')}>
              Patta chiqarish
            </button>
            <button type="button" className={factoryScreen === 'entry' ? 'factory-nav-active' : ''}
              aria-current={factoryScreen === 'entry' ? 'page' : undefined} onClick={() => setFactoryScreen('entry')}>
              Patta kiritish
            </button>
            <button type="button" className={factoryScreen === 'history' ? 'factory-nav-active' : ''}
              aria-current={factoryScreen === 'history' ? 'page' : undefined} onClick={() => setFactoryScreen('history')}>
              Kiritilgan Pattalar
            </button>
            <button type="button" className={factoryScreen === 'trash' ? 'factory-nav-active' : ''}
              aria-current={factoryScreen === 'trash' ? 'page' : undefined} onClick={() => setFactoryScreen('trash')}>
              Korzinka
            </button>
            <button type="button" className={factoryScreen === 'account' ? 'factory-nav-active' : ''}
              aria-current={factoryScreen === 'account' ? 'page' : undefined} onClick={() => setFactoryScreen('account')}>
              Model hisob
            </button>
            <span>Offline ish stoli</span>
          </nav>
          {factoryScreen === 'print' ? <PattaPrintPage /> : null}
          {factoryScreen === 'entry' ? <PattaEntryPage /> : null}
          {factoryScreen === 'history' ? <PattaHistoryPage /> : null}
          {factoryScreen === 'trash' ? <PattaTrashPage /> : null}
          {factoryScreen === 'account' ? <ModelAccountPage /> : null}
        </>
      ) : authStatus.state === 'REFRESHING' || authStatus.state === 'AUTHENTICATING' ? (
        <section className="auth-card loading-card" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" />
          <p>Sessiya tekshirilmoqda…</p>
        </section>
      ) : (
        <form className="auth-card" onSubmit={(event) => void submitLogin(event)}>
          <div className="auth-card-heading">
            <h2>Kirish</h2>
            <p>Korxona hisobiga kiring</p>
          </div>

          <label className="form-field">
            <span>Korxona manzili</span>
            <input
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              type="text"
              inputMode="url"
              value={tenantUrl}
              onChange={(event) => setTenantUrl(event.target.value)}
              placeholder="korxona.example.uz"
              maxLength={2_048}
              required
              disabled={isSubmitting}
            />
          </label>

          <label className="form-field">
            <span>Email</span>
            <input
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={320}
              required
              disabled={isSubmitting}
            />
          </label>

          <label className="form-field">
            <span>Parol</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={1_024}
              required
              disabled={isSubmitting}
            />
          </label>

          {authStatus.message ? (
            <p className="auth-message error-message" role="alert">{authStatus.message}</p>
          ) : null}
          <button className="login-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Tekshirilmoqda…' : 'Kirish'}
          </button>
        </form>
      )}

      {appVersion ? <p className="app-version">Dastur versiyasi {appVersion}</p> : null}
    </main>
  )
}

export default App
