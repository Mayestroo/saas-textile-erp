import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from '../App'
import { createTestErp, installTestErp } from '../test/mock-erp'
import type { IpcTestHandlers } from '../test/mock-erp'
import { modelOption } from './fixtures'

describe('desktop login UI', () => {
  it('submits Korxona, email, and parol through the current auth IPC', async () => {
    let authenticated = false
    const { api, invoke } = createTestErp({
      'auth:login': () => {
        authenticated = true
        return { state: 'AUTHENTICATED', errorCode: null, message: null }
      },
      'auth:status': () => ({
        state: authenticated ? 'AUTHENTICATED' : 'SIGNED_OUT',
        errorCode: null,
        message: null
      }),
      'auth:session': () => ({
        state: authenticated ? 'AUTHENTICATED' : 'SIGNED_OUT',
        user: authenticated ? { id: 'user-1', email: 'operator@example.uz', full_name: 'Operator Test' } : null,
        company: authenticated ? { id: 'company-1', name: 'Sinov korxonasi', slug: 'sinov', timezone: 'Asia/Tashkent' } : null,
        tenant_host: authenticated ? 'https://sinov.example.uz' : null,
        permission_codes: []
      })
    })
    installTestErp(api)

    render(<App />)

    const company = await screen.findByLabelText('Korxona')
    const email = screen.getByLabelText('Email')
    const password = screen.getByLabelText('Parol')
    fireEvent.change(company, { target: { value: 'https://sinov.example.uz' } })
    fireEvent.change(email, { target: { value: 'operator@example.uz' } })
    fireEvent.change(password, { target: { value: 'secret-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Kirish' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('auth:login', {
        tenantUrl: 'https://sinov.example.uz',
        email: 'operator@example.uz',
        password: 'secret-password'
      })
    })
  })
})

describe('permission-aware navigation', () => {
  const signedInHandlers = (permissions: readonly string[]): IpcTestHandlers => ({
    'auth:status': () => ({ state: 'AUTHENTICATED', errorCode: null, message: null }),
    'auth:session': () => ({
      state: 'AUTHENTICATED',
      user: { id: 'user-1', email: 'operator@example.uz', full_name: 'Operator Test' },
      company: { id: 'company-1', name: 'Sinov korxonasi', slug: 'sinov', timezone: 'Asia/Tashkent' },
      tenant_host: 'https://sinov.example.uz',
      permission_codes: permissions
    }),
    'sync:status': () => ({
      connectivity: 'ONLINE',
      unsyncedCount: 0,
      conflictCount: 0,
      lastSuccessfulSyncAt: null,
      errorCode: null
    }),
    'patta-print:models': () => [],
    'patta-sheet:history-models': () => [modelOption]
  })

  it('shows only routes allowed by the safe session permissions', async () => {
    const { api } = createTestErp(signedInHandlers(['patta.chiqarish.view']))
    installTestErp(api)

    render(<App />)

    expect(await screen.findByRole('button', { name: 'Patta chiqarish' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Patta kiritish' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model hisob' })).toBeNull()
  })

  it('changes the active page using the current navigation', async () => {
    const { api } = createTestErp(signedInHandlers(['patta.chiqarish.view', 'patta_varaq.view']))
    installTestErp(api)

    render(<App />)

    const historyButton = await screen.findByRole('button', { name: 'Kiritilgan Pattalar' })
    expect(screen.getByRole('button', { name: 'Patta chiqarish' }).getAttribute('aria-current')).toBe('page')
    fireEvent.click(historyButton)
    await waitFor(() => expect(historyButton.getAttribute('aria-current')).toBe('page'))
    expect(await screen.findByRole('heading', { name: 'Kiritilgan Pattalar' })).toBeTruthy()
  })

  it('shows offline, pending, and conflict sync states without hiding local work', async () => {
    const { api } = createTestErp({
      'auth:status': () => ({ state: 'OFFLINE_SESSION_PENDING', errorCode: null, message: null }),
      'auth:session': () => ({
        state: 'OFFLINE_SESSION_PENDING',
        user: { id: 'user-1', email: 'operator@example.uz', full_name: 'Operator Test' },
        company: { id: 'company-1', name: 'Sinov korxonasi', slug: 'sinov', timezone: 'Asia/Tashkent' },
        tenant_host: 'https://sinov.example.uz',
        permission_codes: ['patta.chiqarish.view']
      }),
      'sync:status': () => ({
        connectivity: 'OFFLINE',
        unsyncedCount: 3,
        conflictCount: 1,
        lastSuccessfulSyncAt: null,
        errorCode: null
      }),
      'patta-print:models': () => []
    })
    installTestErp(api)
    render(<App />)

    expect(await screen.findByText('Oflayn')).toBeTruthy()
    expect(screen.getByText('Sinxronlanmagan: 3')).toBeTruthy()
    expect(screen.getByText('Ziddiyat: 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Patta chiqarish' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sinxronlash' }).hasAttribute('disabled')).toBe(true)
  })
})
