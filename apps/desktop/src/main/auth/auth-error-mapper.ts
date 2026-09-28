import { LocalDomainError } from '../local/local-errors'
import { SecureSessionStoreError } from './secure-session-store'
import { TenantAuthApiError } from './tenant-auth-api-client'

const INVALID_CREDENTIAL_CODES = new Set(['INVALID_CREDENTIALS', 'USER_BLOCKED'])
const TENANT_UNAVAILABLE_CODES = new Set([
  'TENANT_CONTEXT_MISMATCH',
  'TENANT_NOT_FOUND',
  'TENANT_INACTIVE',
  'TENANT_HOST_INVALID'
])
const RATE_LIMIT_CODES = new Set(['TOO_MANY_LOGIN_ATTEMPTS', 'RATE_LIMITED'])
const SESSION_INVALID_CODES = new Set([
  'SESSION_EXPIRED',
  'INVALID_REFRESH_TOKEN',
  'SESSION_REVOKED',
  'INVALID_ACCESS_TOKEN',
  'AUTH_REQUIRED',
  'AUTHENTICATION_REQUIRED'
])

export function authErrorMessage(error: unknown): string {
  if (error instanceof TenantAuthApiError) {
    if (INVALID_CREDENTIAL_CODES.has(error.code)) return "Email yoki parol noto'g'ri"
    if (TENANT_UNAVAILABLE_CODES.has(error.code)) {
      return 'Korxona manzili topilmadi yoki faol emas'
    }
    if (RATE_LIMIT_CODES.has(error.code)) {
      return 'Urinishlar soni oshib ketdi. Keyinroq qayta urinib ko‘ring'
    }
    if (SESSION_INVALID_CODES.has(error.code)) return 'Sessiya muddati tugagan'
    if (
      error.code === 'SECURE_STORAGE_WRITE_FAILED' ||
      error.code === 'SECURE_STORAGE_UNAVAILABLE' ||
      error.code === 'SECURE_SESSION_CORRUPT'
    ) {
      return 'Xavfsiz sessiyani saqlab bo‘lmadi'
    }
    if (error.code === 'TENANT_DATABASE_OWNERSHIP_MISMATCH') {
      return 'Mahalliy ma’lumotlar boshqa korxonaga tegishli'
    }
    if (error.code === 'TENANT_DATABASE_OWNERSHIP_MISSING' || error.code === 'TENANT_DATABASE_SCHEMA_MISMATCH') {
      return 'Mahalliy ma’lumotlar xavfsiz ochilmadi'
    }
    if (error.code === 'DEVICE_NOT_CONFIGURED') return 'Qurilma ro‘yxatdan o‘tkazilmagan'
    if (
      error.code === 'AUTHENTICATION_UNAVAILABLE' ||
      error.code === 'LOGIN_RATE_LIMIT_UNAVAILABLE' ||
      error.code === 'TENANT_RESOLUTION_UNAVAILABLE' ||
      error.transient
    ) {
      return 'Internet bilan aloqa yo‘q'
    }
    return 'Kirishni bajarib bo‘lmadi'
  }

  if (error instanceof SecureSessionStoreError) {
    return 'Xavfsiz sessiyani saqlab bo‘lmadi'
  }
  if (error instanceof TenantAuthApiError && error.code === 'SECURE_STORAGE_WRITE_FAILED') {
    return 'Xavfsiz sessiyani saqlab bo‘lmadi'
  }
  if (error instanceof LocalDomainError && error.code === 'DEVICE_NOT_CONFIGURED') {
    return 'Qurilma ro‘yxatdan o‘tkazilmagan'
  }
  if (error instanceof LocalDomainError && error.code === 'TENANT_DATABASE_OWNERSHIP_MISMATCH') {
    return 'Mahalliy ma’lumotlar boshqa korxonaga tegishli'
  }
  if (error instanceof LocalDomainError && error.code === 'TENANT_DATABASE_OWNERSHIP_MISSING') {
    return 'Mahalliy ma’lumotlar xavfsiz ochilmadi'
  }
  if (error instanceof TypeError) return 'Internet bilan aloqa yo‘q'
  return 'Kirishni bajarib bo‘lmadi'
}
