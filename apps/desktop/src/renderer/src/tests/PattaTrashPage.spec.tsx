import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { DesktopSafeSession } from '../../../preload/erp-api'
import { PattaTrashPage } from '../pages/PattaTrashPage'
import { createTestErp, installTestErp } from '../test/mock-erp'
import { makeHistoryItem, makeSheetProjection, modelOption, sheetId } from './fixtures'

function trashSession(permissions: readonly string[]): DesktopSafeSession {
  return {
    state: 'AUTHENTICATED',
    user: { id: 'user-1', email: 'operator@example.uz', full_name: 'Operator Test' },
    company: { id: 'company-1', name: 'Sinov korxonasi', slug: 'sinov', timezone: 'Asia/Tashkent' },
    tenant_host: 'https://sinov.example.uz',
    permission_codes: permissions
  }
}

describe('Korzinka lifecycle', () => {
  it('restores an Entry through the current IPC method', async () => {
    let historyReads = 0
    const { api, invoke } = createTestErp({
      'patta-sheet:history-models': () => [modelOption],
      'auth:session': () => trashSession(['patta_varaq.view', 'patta_varaq.restore']),
      'patta-sheet:history': () => {
        historyReads += 1
        return historyReads === 1 ? [makeHistoryItem({ deleted_at: '2026-09-30T08:00:00.000Z' })] : []
      },
      'patta-sheet:restore': () => makeSheetProjection()
    })
    installTestErp(api)
    render(<PattaTrashPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Qayta tiklash' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('patta-sheet:restore', {
      sheet_id: sheetId,
      expected_version: '1'
    }))
  })

  it('requires explicit irreversible confirmation before Purge', async () => {
    let historyReads = 0
    const { api, invoke } = createTestErp({
      'patta-sheet:history-models': () => [modelOption],
      'auth:session': () => trashSession(['patta_varaq.view', 'patta_varaq.purge']),
      'patta-sheet:history': () => {
        historyReads += 1
        return historyReads === 1 ? [makeHistoryItem({ deleted_at: '2026-09-30T08:00:00.000Z' })] : []
      },
      'patta-sheet:purge': () => undefined
    })
    installTestErp(api)
    render(<PattaTrashPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Butunlay o‘chirish' }))
    expect(screen.getByText(/Bu amalni ortga qaytarib bo‘lmaydi/)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Butunlay o‘chirish' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('patta-sheet:purge', {
      sheet_id: sheetId,
      expected_version: '1'
    }))
  })

  it('hides lifecycle actions when the session lacks their permissions', async () => {
    const { api } = createTestErp({
      'patta-sheet:history-models': () => [modelOption],
      'auth:session': () => trashSession(['patta_varaq.view']),
      'patta-sheet:history': () => [makeHistoryItem({ deleted_at: '2026-09-30T08:00:00.000Z' })]
    })
    installTestErp(api)
    render(<PattaTrashPage />)

    expect(await screen.findByText('P-12')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Qayta tiklash' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Butunlay o‘chirish' })).toBeNull()
  })
})
