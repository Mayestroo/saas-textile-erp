import { describe, expect, it } from 'vitest'
import type { PattaPrintBatchProjection } from '@textile/sync-protocol'
import { renderPattaPrintHtml } from './patta-print-document'

function createBatch(count: number): PattaPrintBatchProjection {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    model_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    model_name_snapshot: 'Atlas <Model>',
    partiya_number: '1',
    partiya_block_id: null,
    ish_soni: 125,
    rang: 'Qora',
    status: 'ACTIVE',
    version: '1',
    revision: 1,
    corrected_from_batch_id: null,
    created_by: null,
    created_device_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    created_at: '2026-09-28T10:00:00.000000Z',
    updated_at: '2026-09-28T10:00:00.000000Z',
    printed_at: null,
    size_distribution: [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      print_batch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      razmer: 'S', patta_count: count, sort_order: 0
    }],
    pattas: Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      partiya_number: '1',
      patta_number: String(index + 1),
      model_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      model_name_snapshot: 'Atlas <Model>',
      template_id: null,
      konveyer_snapshot: null,
      razmer: 'S',
      rang: 'Qora',
      ish_soni: 125,
      legacy_operation_count: null,
      status: 'ACTIVE',
      version: '1',
      print_batch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      created_device_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      created_from_block_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      created_at: '2026-09-28T10:00:00.000000Z',
      client_created_at: null,
      occurred_at: null,
      operations: [{
        id: `ffffffff-ffff-4fff-8fff-${String(index + 1).padStart(12, '0')}`,
        patta_hisob_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        operation_id: '99999999-9999-4999-8999-999999999999',
        operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '1200.00',
        sort_order: 0,
        created_at: '2026-09-28T10:00:00.000000Z'
      }]
    }))
  }
}

describe('renderPattaPrintHtml', () => {
  it('prints two persisted Pattas on each A4 sheet and escapes snapshot text', () => {
    const html = renderPattaPrintHtml(createBatch(13))
    expect(html.match(/<section class="page">/g)).toHaveLength(7)
    expect(html).toContain('@page { size: A4 portrait; margin: 0; }')
    expect(html).toContain('MAHSULOT MIQDORI')
    expect(html).toContain('125')
    expect(html).toContain('Atlas &lt;Model&gt;')
    expect(html).toContain('1200.00 so‘m')
    expect(html).toContain('Jami <b>13</b> pachka')
  })

  it('keeps VOID Pattas in history but excludes them from corrected print output', () => {
    const batch = createBatch(3)
    const corrected: PattaPrintBatchProjection = {
      ...batch,
      revision: 2,
      size_distribution: [{ ...batch.size_distribution[0]!, patta_count: 2 }],
      pattas: batch.pattas.map((patta, index) => index === 1 ? { ...patta, status: 'VOID' } : patta)
    }
    const html = renderPattaPrintHtml(corrected)

    expect(html).toContain('TUZATILGAN NUSXA · 2-tahrir')
    expect(html).toContain('Jami <b>2</b> pachka')
    expect(html).not.toContain('<small>PATTA №</small><strong>2</strong>')
  })

  it('refuses to print an empty or non-ACTIVE batch', () => {
    expect(() => renderPattaPrintHtml({ ...createBatch(0), status: 'ACTIVE' })).toThrow(/faol va saqlangan/)
    expect(() => renderPattaPrintHtml({ ...createBatch(1), status: 'VOID' })).toThrow(/faol va saqlangan/)
  })
})
