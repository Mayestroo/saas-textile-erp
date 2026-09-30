import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopSafeSession } from '../../../preload/erp-api'
import { PattaHistoryPage } from '../pages/PattaHistoryPage'
import { createTestErp, installTestErp } from '../test/mock-erp'
import { makeHistoryItem, makeSheetProjection, modelOption, sheetId } from './fixtures'

function historySession(permissions: readonly string[]): DesktopSafeSession {
  return {
    state: 'AUTHENTICATED',
    user: { id: 'user-1', email: 'operator@example.uz', full_name: 'Operator Test' },
    company: { id: 'company-1', name: 'Sinov korxonasi', slug: 'sinov', timezone: 'Asia/Tashkent' },
    tenant_host: 'https://sinov.example.uz',
    permission_codes: permissions
  }
}

describe('Kiritilgan Pattalar', () => {
  it('renders current Entry fields and invokes edit for the selected sheet', async () => {
    const onEdit = vi.fn()
    const { api } = createTestErp({
      'patta-sheet:history-models': () => [modelOption],
      'auth:session': () => historySession(['patta_varaq.view', 'patta_varaq.edit']),
      'patta-sheet:history': () => [makeHistoryItem()]
    })
    installTestErp(api)
    render(<PattaHistoryPage onEdit={onEdit} />)

    expect(await screen.findByRole('columnheader', { name: 'Sana' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Konveyer' })).toBeTruthy()
    expect(screen.getByText('P-12')).toBeTruthy()
    expect(screen.getByText('125 dona')).toBeTruthy()
    expect(screen.getByText('Qora')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tahrirlash' }))
    expect(onEdit).toHaveBeenCalledWith(sheetId)
  })

  it('soft-trashes a sheet only after operator confirmation', async () => {
    let historyReads = 0
    const { api, invoke } = createTestErp({
      'patta-sheet:history-models': () => [modelOption],
      'auth:session': () => historySession(['patta_varaq.view', 'patta_varaq.delete']),
      'patta-sheet:history': () => {
        historyReads += 1
        return historyReads === 1 ? [makeHistoryItem()] : []
      },
      'patta-sheet:trash': () => makeSheetProjection({ deleted_at: '2026-09-30T08:00:00.000Z' })
    })
    installTestErp(api)
    render(<PattaHistoryPage onEdit={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: 'O‘chirish' }))
    expect(screen.getByRole('alertdialog', { name: 'Varaqni Korzinkaga yuborish' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Korzinkaga yuborish' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('patta-sheet:trash', {
      sheet_id: sheetId,
      expected_version: '1'
    }))
  })
})
