import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { openSqliteDatabase } from './database/sqlite-database'
import { PattaLocalRepository } from './local/patta-local.repository'
import { SyncConflictRepository } from './local/sync-conflict.repository'
import { SyncQueueRepository } from './local/sync-queue.repository'
import { NetworkStatusService } from './sync/network-status.service'
import { desktopSyncEngineRegistry } from './sync/sync-engine-registry'
import { createMainProcessIpcServices, registerIpcHandlers } from './ipc/register-ipc-handlers'
import type { IpcMainHandlerRegistrar } from './ipc/register-ipc-handlers'

let localDatabase: ReturnType<typeof openSqliteDatabase> | undefined

function createWindow(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked/resources/icon.png')
    : join(app.getAppPath(), 'resources/icon.png')

  // Create the browser window.
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

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on vite-plugin-electron.
  // Load the remote URL for development or the local html file for production.
  if (process.env['VITE_DEV_SERVER_URL']) {
    mainWindow.loadURL(process.env['VITE_DEV_SERVER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  try {
    localDatabase = openSqliteDatabase(join(app.getPath('userData'), 'textile-erp.sqlite'))
  } catch (error) {
    console.error('Failed to initialize the local SQLite database', error)
    app.exit(1)
    return
  }

  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const queueRepository = new SyncQueueRepository(localDatabase)
  const conflictRepository = new SyncConflictRepository(localDatabase)
  const networkStatus = new NetworkStatusService(queueRepository, conflictRepository)
  const ipcMainAdapter: IpcMainHandlerRegistrar = {
    handle: (channel, listener) => {
      ipcMain.handle(channel, (event, ...args) => listener(event, ...args))
    }
  }
  registerIpcHandlers(
    ipcMainAdapter,
    createMainProcessIpcServices({
      appVersion: () => app.getVersion(),
      getSyncEngine: () => desktopSyncEngineRegistry.current(),
      networkStatus,
      pattaRepository: new PattaLocalRepository(localDatabase)
    })
  )

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  desktopSyncEngineRegistry.dispose()
  if (localDatabase?.open) {
    localDatabase.close()
    localDatabase = undefined
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
