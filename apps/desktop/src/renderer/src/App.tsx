import { useEffect, useState } from 'react'
import type {
  DesktopAuthStatus,
  DesktopModelOption,
  DesktopSafeSession,
  DesktopSyncRunResult,
  DesktopSyncStatus
} from '../../preload/erp-api'
import { AppHeader } from './components/AppHeader'
import type { AppSidebarItem, FactoryScreen } from './components/AppSidebar'
import { AppSidebar } from './components/AppSidebar'
import { NewModelModal } from './components/modals/NewModelModal'
import { Button } from './components/ui/Button'
import { TextField } from './components/ui/TextField'
import { ConveyorAccountPage } from './pages/ConveyorAccountPage'
import { ModelAccountPage } from './pages/ModelAccountPage'
import { PattaEntryPage } from './pages/PattaEntryPage'
import { PattaHistoryPage } from './pages/PattaHistoryPage'
import { PattaPrintPage } from './pages/PattaPrintPage'
import { PattaTrashPage } from './pages/PattaTrashPage'

const EMPTY_AUTH_STATUS: DesktopAuthStatus = {
  state: 'REFRESHING',
  errorCode: null,
  message: null
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
  const [factoryScreen, setFactoryScreen] = useState<FactoryScreen>('print')
  const [entrySheetId, setEntrySheetId] = useState<string | null>(null)

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
  const permissionCodes = new Set(session?.permission_codes ?? [])
  const canViewPrint = permissionCodes.has('patta.chiqarish.view') || permissionCodes.has('patta.chiqarish.create')
  const canViewEntry = permissionCodes.has('patta_varaq.view') || permissionCodes.has('patta_varaq.create') ||
    permissionCodes.has('patta_varaq.edit')
  const canViewTrash = permissionCodes.has('patta_varaq.view')
  const canViewAccounts = permissionCodes.has('patta.hisob.view')
  const navigationItems: readonly AppSidebarItem[] = [
    { screen: 'print', label: 'Patta chiqarish', mark: 'P', group: 'Ishlab chiqarish', visible: canViewPrint },
    { screen: 'entry', label: 'Patta kiritish', mark: 'K', group: 'Ishlab chiqarish', visible: canViewEntry },
    { screen: 'history', label: 'Kiritilgan Pattalar', mark: 'T', group: 'Ishlab chiqarish', visible: canViewEntry },
    { screen: 'trash', label: 'Korzinka', mark: 'K', group: 'Ishlab chiqarish', visible: canViewTrash },
    { screen: 'conveyor', label: 'Konveyer hisobi', mark: 'H', group: 'Hisob', visible: canViewAccounts },
    { screen: 'account', label: 'Model hisob', mark: 'M', group: 'Hisob', visible: canViewAccounts }
  ]
  const activeScreen = navigationItems.find((item) => item.screen === factoryScreen && item.visible)?.screen ??
    navigationItems.find((item) => item.visible)?.screen ?? 'print'
  const pageTitles: Record<FactoryScreen, string> = {
    print: 'Patta chiqarish',
    entry: 'Patta kiritish',
    history: 'Kiritilgan Pattalar',
    trash: 'Korzinka',
    conveyor: 'Konveyer hisobi',
    account: 'Model hisob'
  }

  const [isNewModelModalOpen, setIsNewModelModalOpen] = useState(false)
  const [availableModels, setAvailableModels] = useState<readonly DesktopModelOption[]>([])

  useEffect(() => {
    let mounted = true
    if (sessionIsAvailable && window.erp?.modelAccount?.models) {
      window.erp.modelAccount.models().then((res) => {
        if (mounted) setAvailableModels(res)
      }).catch(() => undefined)
    }
    return () => { mounted = false }
  }, [sessionIsAvailable])

  // Ctrl+S global shortcut for runSync
  useEffect(() => {
    const handleGlobalKeys = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void runSync()
      }
    }
    window.addEventListener('keydown', handleGlobalKeys)
    return () => window.removeEventListener('keydown', handleGlobalKeys)
  }, [])

  if (sessionIsAvailable && session) {
    const page = activeScreen === 'print' && canViewPrint ? <PattaPrintPage />
      : activeScreen === 'entry' && canViewEntry ? <PattaEntryPage key={entrySheetId ?? 'new-entry'} initialSheetId={entrySheetId} />
        : activeScreen === 'history' && canViewEntry ? <PattaHistoryPage onEdit={(sheetId) => {
          setEntrySheetId(sheetId)
          setFactoryScreen('entry')
        }} />
          : activeScreen === 'trash' && canViewTrash ? <PattaTrashPage />
            : activeScreen === 'conveyor' && canViewAccounts ? <ConveyorAccountPage />
              : activeScreen === 'account' && canViewAccounts ? <ModelAccountPage /> : null

    return (
      <div className="excel-app erp-shell" style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
        <AppHeader
          pageTitle={pageTitles[activeScreen]}
          companyName={session.company?.name || session.company?.slug || 'Korxona'}
          userName={session.user?.full_name || session.user?.email || 'Foydalanuvchi'}
          connectivity={syncStatus?.connectivity ?? null}
          unsyncedCount={syncStatus?.unsyncedCount ?? 0}
          conflictCount={syncStatus?.conflictCount ?? 0}
          syncing={isSyncing}
          onSync={() => void runSync()}
          onLogout={() => void logout()}
        />
        <div className="erp-main-column" style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', position: 'relative', minHeight: 0 }}>
          <AppSidebar
            activeScreen={activeScreen}
            items={navigationItems}
            onNavigate={(screen) => {
              if (screen === 'entry') setEntrySheetId(null)
              setFactoryScreen(screen)
            }}
            onOpenNewModel={() => setIsNewModelModalOpen(true)}
          />
          <main className="erp-page-viewport" id="main-content" style={{ flex: 1, width: '100%', height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {deviceMessage ? <p className="erp-global-message erp-global-message--danger" role="status">{deviceMessage}</p> : null}
            {syncMessage ? <p className="erp-global-message" role="status">{syncMessage}</p> : null}
            {authStatus.state === 'OFFLINE_SESSION_PENDING' ? (
              <p className="erp-global-message erp-global-message--offline" role="status">
                Internet bilan aloqa yo‘q. Mahalliy ma’lumotlar saqlanadi.
              </p>
            ) : null}
            {authStatus.state === 'REFRESHING' ? <p className="erp-global-message" role="status">Sessiya tekshirilmoqda…</p> : null}
            {page ?? <section className="permission-empty" role="status">Sizga ko‘rish ruxsati berilgan sahifa topilmadi.</section>}
            {appVersion ? <footer className="erp-app-version">Dastur versiyasi {appVersion}</footer> : null}
          </main>
        </div>

        <NewModelModal
          isOpen={isNewModelModalOpen}
          models={availableModels}
          onClose={() => setIsNewModelModalOpen(false)}
          onSubmit={async (name) => {
            setSyncMessage(`Yangi model "${name}" yaratish so‘rovi qabul qilindi`)
          }}
        />
      </div>
    )
  }

  if (authStatus.state === 'REFRESHING' || authStatus.state === 'AUTHENTICATING') {
    return (
      <main className="erp-auth-shell">
        <section className="auth-card loading-card" aria-live="polite">
          <span className="loading-mark" aria-hidden="true" />
          <p>Sessiya tekshirilmoqda…</p>
        </section>
      </main>
    )
  }

  return (
    <main className="erp-auth-shell">
      <section className="auth-brand" aria-label="Textile ERP">
        <span className="auth-brand__mark" aria-hidden="true">T</span>
        <p className="auth-brand__eyebrow">TO‘QIMACHILIK KORXONASI</p>
        <h1>Textile ERP</h1>
        <p className="auth-brand__description">Ishlab chiqarish ma’lumotlari avval qurilmada saqlanadi.</p>
      </section>
      <form className="auth-card" onSubmit={(event) => void submitLogin(event)}>
        <div className="auth-card-heading">
          <p className="auth-card__eyebrow">XAVFSIZ KIRISH</p>
          <h2>Kirish</h2>
          <p>Korxona hisobiga kiring</p>
        </div>
        <TextField
          autoComplete="url"
          autoCapitalize="none"
          disabled={isSubmitting}
          inputMode="url"
          label="Korxona"
          maxLength={2_048}
          onChange={(event) => setTenantUrl(event.target.value)}
          placeholder="korxona.example.uz"
          required
          spellCheck={false}
          type="text"
          value={tenantUrl}
        />
        <TextField
          autoComplete="username"
          autoCapitalize="none"
          disabled={isSubmitting}
          label="Email"
          maxLength={320}
          onChange={(event) => setEmail(event.target.value)}
          required
          spellCheck={false}
          type="email"
          value={email}
        />
        <TextField
          autoComplete="current-password"
          disabled={isSubmitting}
          label="Parol"
          maxLength={1_024}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        {authStatus.message ? <p className="auth-message" role="alert">{authStatus.message}</p> : null}
        <Button className="auth-submit" disabled={isSubmitting} type="submit" variant="primary">
          {isSubmitting ? 'Tekshirilmoqda…' : 'Kirish'}
        </Button>
        <p className="auth-offline-note">Internet vaqtincha uzilsa, mavjud mahalliy ma’lumotlardan foydalanish davom etadi.</p>
      </form>
      {appVersion ? <p className="auth-version">Dastur versiyasi {appVersion}</p> : null}
    </main>
  )
}

export default App
