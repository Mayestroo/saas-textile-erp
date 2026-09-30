import type {
  DesktopPattaLookup,
  DesktopPattaPrintBatchResult,
  DesktopPattaSheetHistoryItem
} from '../../../preload/erp-api'
import type {
  ModelAccountSheetV3,
  PattaSheetProjectionV3
} from '@textile/sync-protocol'

export const modelId = '10000000-0000-4000-8000-000000000001'
export const operationOneId = '20000000-0000-4000-8000-000000000001'
export const operationTwoId = '20000000-0000-4000-8000-000000000002'
export const batchId = '30000000-0000-4000-8000-000000000001'
export const sheetId = '40000000-0000-4000-8000-000000000001'
export const pattaId = '50000000-0000-4000-8000-000000000001'

export const modelOption = { id: modelId, name: 'Model A' }

export function makePattaLookup(): DesktopPattaLookup {
  return {
    id: pattaId,
    partiya_number: 'P-12',
    patta_number: '1',
    model_id: modelId,
    model_name_snapshot: 'Model A',
    template_id: null,
    print_batch_id: batchId,
    printed_at: '2026-09-30T07:00:00.000Z',
    konveyer_snapshot: '1-konveyer',
    razmer: 'M',
    rang: 'Qora',
    ish_soni: 125,
    legacy_operation_count: null,
    status: 'ACTIVE',
    created_at: '2026-09-30T07:00:00.000Z',
    operations: [
      {
        id: '60000000-0000-4000-8000-000000000001',
        operation_id: operationOneId,
        operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '500.00',
        sort_order: 0
      },
      {
        id: '60000000-0000-4000-8000-000000000002',
        operation_id: operationTwoId,
        operation_name_snapshot: 'Dazmollash',
        unit_price_snapshot: '250.00',
        sort_order: 1
      }
    ]
  }
}

export function makeSheetProjection(overrides: Partial<PattaSheetProjectionV3> = {}): PattaSheetProjectionV3 {
  return {
    id: sheetId,
    entry_kind: 'PATTA_LINKED',
    patta_hisob_id: pattaId,
    model_id: modelId,
    model_name_snapshot: 'Model A',
    ish_soni: 125,
    partiya_number_snapshot: 'P-12',
    patta_number_snapshot: '1',
    rang_snapshot: 'Qora',
    razmer_snapshot: 'M',
    entered_at: '2026-09-30T07:00:00.000Z',
    business_date: '2026-09-30',
    conveyor_snapshot: '1-konveyer',
    version: '1',
    created_by: '70000000-0000-4000-8000-000000000001',
    created_at: '2026-09-30T07:00:00.000Z',
    updated_at: '2026-09-30T07:00:00.000Z',
    deleted_at: null,
    deleted_by: null,
    deleted_by_name_snapshot: null,
    operation_snapshots: [
      {
        id: '80000000-0000-4000-8000-000000000001',
        patta_sheet_id: sheetId,
        model_operation_id: operationOneId,
        source_type: 'PATTA',
        source_patta_operation_snapshot_id: '60000000-0000-4000-8000-000000000001',
        operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '500.00',
        sort_order: 0,
        created_at: '2026-09-30T07:00:00.000Z'
      },
      {
        id: '80000000-0000-4000-8000-000000000002',
        patta_sheet_id: sheetId,
        model_operation_id: operationTwoId,
        source_type: 'PATTA',
        source_patta_operation_snapshot_id: '60000000-0000-4000-8000-000000000002',
        operation_name_snapshot: 'Dazmollash',
        unit_price_snapshot: '250.00',
        sort_order: 1,
        created_at: '2026-09-30T07:00:00.000Z'
      }
    ],
    rows: [],
    ...overrides
  }
}

export function makeHistoryItem(overrides: Partial<PattaSheetProjectionV3> = {}): DesktopPattaSheetHistoryItem {
  return {
    patta: makePattaLookup(),
    sheet: makeSheetProjection(overrides),
    rows: []
  }
}

export function makeModelAccount(): ModelAccountSheetV3 {
  return {
    model_id: modelId,
    model_name: 'Model A',
    operations: [
      {
        model_operation_id: operationOneId,
        operation_name: 'Tikish',
        sort_order: 0,
        version: '1',
        status: 'ACTIVE',
        current_price: '500.00',
        quantity: '125',
        patta_quantity: '100',
        standalone_quantity: '25',
        manual_quantity: '0',
        gross_amount: '62500.00',
        patta_amount: '50000.00',
        standalone_amount: '12500.00',
        manual_amount: '0.00'
      }
    ],
    rows: [
      {
        worker_id: '101',
        worker_name: 'Abdullayeva Nodira',
        model_operation_id: operationOneId,
        patta_quantity: '100',
        standalone_quantity: '25',
        manual_quantity: '0',
        total_quantity: '125',
        patta_amount: '50000.00',
        standalone_amount: '12500.00',
        manual_amount: '0.00',
        gross_amount: '62500.00'
      }
    ]
  }
}

export function makePrintBatch(): DesktopPattaPrintBatchResult {
  const patta = makePattaLookup()
  return {
    id: batchId,
    model_id: modelId,
    model_name_snapshot: 'Model A',
    partiya_number: 'P-12',
    partiya_block_id: null,
    ish_soni: 125,
    rang: 'Qora',
    status: 'ACTIVE',
    version: '1',
    revision: 1,
    corrected_from_batch_id: null,
    created_by: null,
    created_device_id: 'test-device',
    created_at: '2026-09-30T07:00:00.000Z',
    updated_at: '2026-09-30T07:00:00.000Z',
    printed_at: null,
    size_distribution: [{ id: '90000000-0000-4000-8000-000000000001', print_batch_id: batchId, razmer: 'M', patta_count: 1, sort_order: 0 }],
    pattas: [patta]
  }
}
