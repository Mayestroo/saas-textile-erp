import { app, shell, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { DesktopAuthService } from './auth/desktop-auth.service'
import { DesktopTenantRuntime } from './auth/desktop-tenant-runtime'
import { ElectronSecureSessionStore, createElectronSecureSessionFileSystem } from './auth/electron-secure-session-store'
import { TenantAuthApiClient } from './auth/tenant-auth-api-client'
import { TenantDatabaseManager } from './database/tenant-database-manager'
import { DeviceIdentityService } from './device/device-identity.service'
import { createMainProcessIpcServices, registerIpcHandlers } from './ipc/register-ipc-handlers'
import type { IpcMainHandlerRegistrar } from './ipc/register-ipc-handlers'

const SESSION_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const

let tenantRuntime: DesktopTenantRuntime | undefined
let authService: DesktopAuthService | undefined
let restoreRetryTimer: ReturnType<typeof setTimeout> | null = null
let restoreRetryAttempt = 0
let shutdownPrepared = false

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked/resources/icon.png')
    : join(app.getAppPath(), 'resources/icon.png')

  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['VITE_DEV_SERVER_URL']) {
    mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/renderer/index.html'))
  }
}

function scheduleOfflineSessionRestore(): void {
  if (restoreRetryTimer !== null) {
    clearTimeout(restoreRetryTimer)
    restoreRetryTimer = null
  }
  if (!authService || authService.status().state !== 'OFFLINE_SESSION_PENDING') {
    restoreRetryAttempt = 0
    return
  }

  const delay = SESSION_RETRY_DELAYS_MS[
    Math.min(restoreRetryAttempt, SESSION_RETRY_DELAYS_MS.length - 1)
  ]
  restoreRetryAttempt += 1
  restoreRetryTimer = setTimeout(() => {
    restoreRetryTimer = null
    void authService
      ?.refreshAccessToken()
      .catch(() => false)
      .finally(scheduleOfflineSessionRestore)
  }, delay)
  restoreRetryTimer.unref?.()
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  const userDataPath = app.getPath('userData')
  const databaseManager = new TenantDatabaseManager(userDataPath)
  const deviceIdentity = new DeviceIdentityService(userDataPath)
  tenantRuntime = new DesktopTenantRuntime(databaseManager, deviceIdentity)
  const secureSessionStore = new ElectronSecureSessionStore(
    safeStorage,
    createElectronSecureSessionFileSystem(),
    join(userDataPath, 'desktop-auth-session.dat')
  )
  authService = new DesktopAuthService(new TenantAuthApiClient(), secureSessionStore, tenantRuntime)
  tenantRuntime.setSessionProvider(authService)

  const ipcMainAdapter: IpcMainHandlerRegistrar = {
    handle: (channel, listener) => {
      ipcMain.handle(channel, (event, ...args) => listener(event, ...args))
    }
  }
  registerIpcHandlers(
    ipcMainAdapter,
    createMainProcessIpcServices({
      appVersion: () => app.getVersion(),
      authService,
      tenantRuntime
    })
  )

  void authService.restoreSession().then(scheduleOfflineSessionRestore, scheduleOfflineSessionRestore)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (shutdownPrepared) return
  event.preventDefault()
  shutdownPrepared = true
  authService?.prepareForShutdown()
  if (restoreRetryTimer !== null) {
    clearTimeout(restoreRetryTimer)
    restoreRetryTimer = null
  }
  void (tenantRuntime?.clearTenant() ?? Promise.resolve()).finally(() => app.quit())
})
