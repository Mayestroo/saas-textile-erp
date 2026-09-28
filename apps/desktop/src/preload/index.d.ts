import type { ErpApi } from './erp-api'

declare global {
  interface Window {
    erp: ErpApi
  }
}

export {}
