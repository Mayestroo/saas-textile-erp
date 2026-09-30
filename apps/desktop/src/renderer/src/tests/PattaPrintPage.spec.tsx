import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PattaPrintPage } from '../pages/PattaPrintPage'
import { createTestErp, installTestErp } from '../test/mock-erp'
import { batchId, makePrintBatch, modelOption } from './fixtures'

describe('Patta chiqarish and preview', () => {
  it('previews saved batch data and prints through the current main-process IPC', async () => {
    const onePattaBatch = makePrintBatch()
    const firstPatta = onePattaBatch.pattas[0]
    if (!firstPatta) throw new Error('Print fixture must contain a persisted Patta')
    const batch = {
      ...onePattaBatch,
      size_distribution: onePattaBatch.size_distribution.map((size) => ({ ...size, patta_count: 3 })),
      pattas: [
        firstPatta,
        { ...firstPatta, id: '50000000-0000-4000-8000-000000000002', patta_number: '2' },
        { ...firstPatta, id: '50000000-0000-4000-8000-000000000003', patta_number: '3' }
      ]
    }
    const { api, invoke } = createTestErp({
      'patta-print:models': () => [modelOption],
      'patta-print:create-batch': () => batch,
      'patta-print:print-batch': () => ({
        batch: { ...batch, printed_at: '2026-09-30T08:30:00.000Z' },
        event: {
          id: 'a0000000-0000-4000-8000-000000000001',
          batch_id: batchId,
          revision: 1,
          kind: 'INITIAL',
          outcome: 'SUCCEEDED',
          actor_user_id: null,
          device_id: 'test-device',
          created_at: '2026-09-30T08:30:00.000Z',
          printed_at: '2026-09-30T08:30:00.000Z'
        }
      })
    })
    installTestErp(api)
    render(<PattaPrintPage />)

    fireEvent.change(await screen.findByLabelText('Mahsulot miqdori'), { target: { value: '125' } })
    fireEvent.change(screen.getByLabelText(/RANG/), { target: { value: 'Qora' } })
    fireEvent.change(screen.getByLabelText('Razmer 1'), { target: { value: 'M' } })
    fireEvent.click(screen.getByRole('button', { name: /Bosma to‘plamini saqlash/ }))

    fireEvent.click(await screen.findByRole('button', { name: 'Ko‘rib chiqish' }))
    const preview = screen.getByRole('dialog', { name: 'Pechat ko‘rinishi' })
    expect(within(preview).getByText(/Model A · Partiya № P-12 · 125 dona/)).toBeTruthy()
    expect(within(preview).getAllByText('Tikish')).toHaveLength(3)
    expect(within(preview).getAllByRole('columnheader', { name: 'Jeton' })).toHaveLength(3)
    expect(within(preview).getByText('A4 · 1 / 2')).toBeTruthy()
    expect(within(preview).getByText('A4 · 2 / 2')).toBeTruthy()
    expect(within(preview).getAllByRole('article')).toHaveLength(2)

    fireEvent.click(within(preview).getByRole('button', { name: 'Pechat qilish' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('patta-print:print-batch', batchId))
  })
})
