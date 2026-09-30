import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DesktopSafeSession } from '../../../preload/erp-api'
import { ModelAccountPage } from '../pages/ModelAccountPage'
import { createTestErp, installTestErp } from '../test/mock-erp'
import { makeModelAccount, modelOption } from './fixtures'

function accountSession(permissions: readonly string[]): DesktopSafeSession {
  return {
    state: 'AUTHENTICATED',
    user: { id: 'user-1', email: 'operator@example.uz', full_name: 'Operator Test' },
    company: { id: 'company-1', name: 'Sinov korxonasi', slug: 'sinov', timezone: 'Asia/Tashkent' },
    tenant_host: 'https://sinov.example.uz',
    permission_codes: permissions
  }
}

describe('Model hisob', () => {
  it('renders permanent worker identity, operation quantity, and totals from the projection', async () => {
    const { api } = createTestErp({
      'model-account:models': () => [modelOption],
      'auth:session': () => accountSession(['patta.hisob.view']),
      'model-account:get': () => makeModelAccount()
    })
    installTestErp(api)
    render(<ModelAccountPage />)

    expect(await screen.findByRole('columnheader', { name: 'ISHCHI ID' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'F.I.O.' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: /Tikish/ })).toBeTruthy()
    const workerRow = screen.getByRole('row', { name: /101 Abdullayeva Nodira/ })
    expect(within(workerRow).getByText(/Patta 100 .*Mustaqil 25/)).toBeTruthy()
    expect(screen.getByRole('row', { name: /Jami dona/ })).toBeTruthy()
    const totalAmountRow = screen.getByRole('row', { name: /Jami so‘m/ })
    expect(within(totalAmountRow).getAllByText(/62\s500 so‘m/)).toHaveLength(2)
  })

  it('shows price management only with the current models.manage permission', async () => {
    const { api } = createTestErp({
      'model-account:models': () => [modelOption],
      'auth:session': () => accountSession(['patta.hisob.view', 'models.manage']),
      'model-account:get': () => makeModelAccount()
    })
    installTestErp(api)
    render(<ModelAccountPage />)

    expect(await screen.findByRole('button', { name: 'O‘zgartirish' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '+ Qo‘lda qo‘shish' })).toBeNull()
  })

  it('exposes manual adjustment actions only with the current manual_manage permission', async () => {
    const { api } = createTestErp({
      'model-account:models': () => [modelOption],
      'auth:session': () => accountSession(['patta.hisob.view', 'patta.hisob.manual_manage']),
      'model-account:get': () => makeModelAccount(),
      'model-account:workers': () => [{ id: '101', name: 'Abdullayeva Nodira' }],
      'model-account:manual-operations': () => [{
        model_operation_id: '20000000-0000-4000-8000-000000000001',
        operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '500.00',
        sort_order: 0,
        version: '1'
      }]
    })
    installTestErp(api)
    render(<ModelAccountPage />)

    fireEvent.click(await screen.findByRole('button', { name: '+ Qo‘lda qo‘shish' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('ISHCHI')).toBeTruthy()
  })
})
