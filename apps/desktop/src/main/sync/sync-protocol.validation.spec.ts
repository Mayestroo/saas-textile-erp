import { describe, expect, it } from 'vitest'
import { parseSyncChange, parseSyncProjection, SyncProtocolValidationError } from './sync-protocol.validation'

const standaloneProjection = {
  projection_version: 3,
  entity_type: 'patta_sheets',
  entity_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  entity_version: '1',
  data: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    entry_kind: 'STANDALONE',
    patta_hisob_id: null,
    model_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    model_name_snapshot: 'Atlas',
    ish_soni: 95,
    partiya_number_snapshot: null,
    patta_number_snapshot: null,
    rang_snapshot: 'Qora',
    razmer_snapshot: 'M',
    entered_at: '2026-09-28T10:00:00.000000Z',
    business_date: '2026-09-28',
    conveyor_snapshot: null,
    version: '1',
    created_by: null,
    created_at: '2026-09-28T10:00:00.000000Z',
    updated_at: '2026-09-28T10:00:00.000000Z',
    deleted_at: null,
    deleted_by: null,
    deleted_by_name_snapshot: null,
    operation_snapshots: [{
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      patta_sheet_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      model_operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      source_type: 'MODEL',
      source_patta_operation_snapshot_id: null,
      operation_name_snapshot: 'Tikish',
      unit_price_snapshot: '10.00',
      sort_order: 0,
      created_at: '2026-09-28T10:00:00.000000Z'
    }],
    rows: [{
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      patta_sheet_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      patta_sheet_operation_snapshot_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      worker_id: '17',
      quantity_snapshot: 95,
      nuqson: false,
      deleted_at: null,
      deleted_by: null,
      created_at: '2026-09-28T10:00:00.000000Z',
      updated_at: '2026-09-28T10:00:00.000000Z'
    }]
  }
}

describe('sync protocol V3 validation', () => {
  it('accepts a nullable-Patta Standalone projection and change', () => {
    expect(parseSyncProjection(standaloneProjection)).toEqual(standaloneProjection)
    expect(parseSyncChange({
      sequence_id: '11',
      entity_type: 'patta_sheets',
      entity_id: standaloneProjection.entity_id,
      operation: 'UPSERT',
      entity_version: '1',
      projection_version: 3,
      payload: standaloneProjection,
      changed_at: '2026-09-28T10:00:01.000000Z'
    })).toMatchObject({ projection_version: 3, payload: { data: { entry_kind: 'STANDALONE' } } })
  })

  it('rejects a Standalone row whose quantity differs from the Entry header', () => {
    const invalid = {
      ...standaloneProjection,
      data: {
        ...standaloneProjection.data,
        rows: [{ ...standaloneProjection.data.rows[0], quantity_snapshot: 94 }]
      }
    }
    expect(() => parseSyncProjection(invalid)).toThrow(SyncProtocolValidationError)
  })

  it('rejects a Patta source on a Standalone operation snapshot', () => {
    const invalid = {
      ...standaloneProjection,
      data: {
        ...standaloneProjection.data,
        operation_snapshots: [{
          ...standaloneProjection.data.operation_snapshots[0],
          source_type: 'PATTA',
          source_patta_operation_snapshot_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
        }]
      }
    }
    expect(() => parseSyncProjection(invalid)).toThrow(SyncProtocolValidationError)
  })

  it('accepts a decimal-price V3 manual adjustment projection', () => {
    expect(parseSyncProjection({
      projection_version: 3,
      entity_type: 'model_account_adjustments',
      entity_id: '11111111-1111-4111-8111-111111111111',
      entity_version: '2',
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        model_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        model_operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        worker_id: '17',
        quantity: 20,
        unit_price_snapshot: '21.50',
        entered_at: '2026-09-28T10:00:00.000000Z',
        business_date: '2026-09-28',
        version: '2',
        created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        created_device_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        created_at: '2026-09-28T10:00:00.000000Z',
        updated_at: '2026-09-28T10:01:00.000000Z',
        deleted_at: null,
        deleted_by: null
      }
    })).toMatchObject({ entity_type: 'model_account_adjustments', projection_version: 3 })
  })

  it('rejects a V3 adjustment with inconsistent trash metadata', () => {
    expect(() => parseSyncProjection({
      projection_version: 3,
      entity_type: 'model_account_adjustments',
      entity_id: '11111111-1111-4111-8111-111111111111',
      entity_version: '2',
      data: {
        id: '11111111-1111-4111-8111-111111111111',
        model_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        model_operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        worker_id: '17',
        quantity: 20,
        unit_price_snapshot: '21.50',
        entered_at: '2026-09-28T10:00:00.000000Z',
        business_date: '2026-09-28',
        version: '2',
        created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        created_device_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        created_at: '2026-09-28T10:00:00.000000Z',
        updated_at: '2026-09-28T10:01:00.000000Z',
        deleted_at: null,
        deleted_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      }
    })).toThrow(SyncProtocolValidationError)
  })
})
