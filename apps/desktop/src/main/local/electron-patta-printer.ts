import { BrowserWindow } from 'electron'
import type { PattaPrintBatchProjection } from '@textile/sync-protocol'
import { renderPattaPrintHtml } from './patta-print-document'

export async function printPattaBatchInMain(batch: PattaPrintBatchProjection): Promise<void> {
  const html = renderPattaPrintHtml(batch)
  const printWindow = new BrowserWindow({
    width: 940,
    height: 1_180,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  try {
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const succeeded = await new Promise<boolean>((resolve, reject) => {
      printWindow.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
        if (!success && failureReason) {
          reject(new Error(`Patta chop etish amalga oshmadi: ${failureReason}`))
          return
        }
        resolve(success)
      })
    })
    if (!succeeded) throw new Error('Patta chop etish amalga oshmadi')
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy()
  }
}
