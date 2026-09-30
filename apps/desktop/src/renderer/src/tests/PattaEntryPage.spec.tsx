import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { DesktopSafeSession } from '../../../preload/erp-api'
import { PattaEntryPage } from '../pages/PattaEntryPage'
import { createTestErp, installTestErp } from '../test/mock-erp'
import type { IpcTestHandlers } from '../test/mock-erp'
import {
  makePattaLookup,
  makeSheetProjection,
  modelOption,
  operationOneId,
  operationTwoId
} from './fixtures'

function entrySession(): DesktopSafeSession {
  return {
    state: 'AUTHENTICATED',
    user: { id: 'user-1', email: 'operator@example.uz', full_name: 'Operator Test' },
    company: { id: 'company-1', name: 'Sinov korxonasi', slug: 'sinov', timezone: 'Asia/Tashkent' },
    tenant_host: 'https://sinov.example.uz',
    permission_codes: ['patta_varaq.create', 'patta_varaq.edit', 'patta_varaq.delete']
  }
}

function entryHandlers(resolution: { worker_id: string; full_name: string } | null = {
  worker_id: '101',
  full_name: 'Abdullayeva Nodira'
}): IpcTestHandlers {
  return {
    'patta-sheet:models': () => [modelOption],
    'auth:session': () => entrySession(),
    'patta-sheet:lookup': () => ({ patta: makePattaLookup(), sheet: null, rows: [] }),
    'patta-sheet:resolve-badge': () => resolution,
    'patta-sheet:create': () => makeSheetProjection(),
    'patta-sheet:model-operations': () => [{
      model_operation_id: operationOneId,
      operation_name_snapshot: 'Tikish',
      unit_price_snapshot: '500.00',
      sort_order: 0,
      version: '1'
    }]
  }
}

async function lookupLinkedPatta(): Promise<void> {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('PARTIYA №'), 'P-12')
  await user.type(screen.getByLabelText('PATTA №'), '1')
  await user.click(screen.getByRole('button', { name: 'Patta qidirish' }))
  await screen.findByLabelText('Tikish jetoni')
}

describe('Patta Entry keyboard flow', () => {
  it('moves a valid Jeton to the next row and saves atomically on the last Enter', async () => {
    const { api, invoke } = createTestErp(entryHandlers())
    installTestErp(api)
    render(<PattaEntryPage />)
    await lookupLinkedPatta()

    const user = userEvent.setup()
    const firstBadge = screen.getByLabelText('Tikish jetoni')
    const secondBadge = screen.getByLabelText('Dazmollash jetoni')
    firstBadge.focus()
    await user.type(firstBadge, 'J-101')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(document.activeElement).toBe(secondBadge))

    await user.type(secondBadge, 'J-202')
    await user.keyboard('{Enter}')
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('patta-sheet:create', expect.objectContaining({
        partiya_number: 'P-12',
        patta_number: '1',
        assignments: [
          { model_operation_id: operationOneId, badge_number: 'J-101', nuqson: false },
          { model_operation_id: operationTwoId, badge_number: 'J-202', nuqson: false }
        ]
      }))
    })
  })

  it('keeps focus on the row and shows Topilmadi for an invalid Jeton', async () => {
    const { api, invoke } = createTestErp(entryHandlers(null))
    installTestErp(api)
    render(<PattaEntryPage />)
    await lookupLinkedPatta()

    const user = userEvent.setup()
    const badge = screen.getByLabelText('Tikish jetoni')
    badge.focus()
    await user.type(badge, 'J-404')
    await user.keyboard('{Enter}')

    expect((await screen.findAllByText('Topilmadi')).length).toBeGreaterThan(0)
    expect(document.activeElement).toBe(badge)
    expect(invoke).not.toHaveBeenCalledWith('patta-sheet:create', expect.anything())
  })

  it('adds a custom operation to the standalone operation grid', async () => {
    const { api } = createTestErp(entryHandlers())
    installTestErp(api)
    render(<PattaEntryPage />)

    const modeToggle = screen.getByRole('checkbox', { name: /Patta bo‘yicha kiritish/ })
    await waitFor(() => expect(modeToggle.hasAttribute('disabled')).toBe(false))
    fireEvent.click(modeToggle)
    await screen.findByText('Tikish')
    fireEvent.change(screen.getByLabelText('ISH SONI'), { target: { value: '125' } })
    fireEvent.change(screen.getByLabelText('OPERATSIYA NOMI'), { target: { value: 'Yakuniy tekshiruv' } })
    fireEvent.change(screen.getByLabelText('NARX · SO‘M'), { target: { value: '300.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Qo‘shish' }))

    expect(screen.getByText('Yakuniy tekshiruv')).toBeTruthy()
    expect(screen.getByText('300 so‘m')).toBeTruthy()
  })
})
