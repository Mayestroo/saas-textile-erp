import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreatePattaSheetV3Dto } from './patta-sheet-v3-input.dto.js';

const STANDALONE_INPUT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  entry_kind: 'STANDALONE',
  patta_hisob_id: null,
  model_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  model_name_snapshot: 'Atlas',
  ish_soni: 125,
  partiya_number_snapshot: null,
  patta_number_snapshot: null,
  rang_snapshot: 'Qora',
  razmer_snapshot: 'M',
  entered_at: '2026-09-29T10:00:00.000Z',
  business_date: '2026-09-29',
  conveyor_snapshot: null,
  deleted_at: null,
  deleted_by: null,
  operation_snapshots: [{
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    model_operation_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    source_type: 'MODEL',
    source_patta_operation_snapshot_id: null,
    operation_name_snapshot: 'Yeng tikish',
    unit_price_snapshot: '150.00',
    sort_order: 0
  }],
  rows: [{
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    patta_sheet_operation_snapshot_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    worker_id: '17',
    quantity_snapshot: 125,
    nuqson: false,
    entered_badge_number: '00418'
  }],
  depends_on_event_ids: [],
  device_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
}

function validationErrors(value: unknown) {
  return validateSync(plainToInstance(CreatePattaSheetV3Dto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true
  })
}

describe('CreatePattaSheetV3Dto', () => {
  it('accepts a standalone entry without a Patta identity and with model-source snapshots', () => {
    expect(validationErrors(STANDALONE_INPUT)).toEqual([])
  })

  it('requires a Patta FK for the linked entry kind', () => {
    const linkedWithoutPatta = {
      ...STANDALONE_INPUT,
      entry_kind: 'PATTA_LINKED',
      patta_hisob_id: null
    }

    expect(validationErrors(linkedWithoutPatta).some((error) => error.property === 'patta_hisob_id')).toBe(true)
  })

  it('rejects a Patta FK on a standalone entry', () => {
    const standaloneWithPatta = {
      ...STANDALONE_INPUT,
      patta_hisob_id: '11111111-1111-4111-8111-111111111111'
    }

    expect(validationErrors(standaloneWithPatta).some((error) => error.property === 'patta_hisob_id')).toBe(true)
  })

  it('requires null Patta source IDs for MODEL and CUSTOM snapshots', () => {
    const standaloneWithPattaSource = {
      ...STANDALONE_INPUT,
      operation_snapshots: [{
        ...STANDALONE_INPUT.operation_snapshots[0],
        source_patta_operation_snapshot_id: '11111111-1111-4111-8111-111111111111'
      }]
    }

    const errors = validationErrors(standaloneWithPattaSource)
    const operationSnapshotErrors = errors.find((error) => error.property === 'operation_snapshots')?.children ?? []
    const firstOperationErrors = operationSnapshotErrors[0]?.children ?? []
    expect(firstOperationErrors.some((error) => error.property === 'source_patta_operation_snapshot_id')).toBe(true)
  })

  it('requires a source Patta snapshot ID for PATTA snapshots', () => {
    const pattaWithoutSource = {
      ...STANDALONE_INPUT,
      entry_kind: 'PATTA_LINKED',
      patta_hisob_id: '11111111-1111-4111-8111-111111111111',
      operation_snapshots: [{
        ...STANDALONE_INPUT.operation_snapshots[0],
        source_type: 'PATTA',
        source_patta_operation_snapshot_id: null
      }]
    }

    const errors = validationErrors(pattaWithoutSource)
    const operationSnapshotErrors = errors.find((error) => error.property === 'operation_snapshots')?.children ?? []
    const firstOperationErrors = operationSnapshotErrors[0]?.children ?? []
    expect(firstOperationErrors.some((error) => error.property === 'source_patta_operation_snapshot_id')).toBe(true)
  })
})
