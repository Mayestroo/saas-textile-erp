import { contextBridge, ipcRenderer } from 'electron'
import { createErpApi } from './erp-api'

const erp = createErpApi({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload)
})

contextBridge.exposeInMainWorld('erp', erp)
