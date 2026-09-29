import { contextBridge, ipcRenderer } from 'electron'
import { createErpApi, createNarrowIpcInvoker } from './erp-api'

const erp = createErpApi(createNarrowIpcInvoker(ipcRenderer))

contextBridge.exposeInMainWorld('erp', erp)
