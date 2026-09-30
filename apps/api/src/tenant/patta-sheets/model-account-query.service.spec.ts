import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { ModelAccountQueryService } from './model-account-query.service.js';

const modelId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('ModelAccountQueryService', () => {
  it('groups live production by stable model operation and worker IDs', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "models"')) return [{ id: modelId }];
      if (sql.includes('FROM "model_operations"')) return [
        { model_operation_id: 'operation-a', operation_name: 'Tikish', sort_order: 0 },
        { model_operation_id: 'operation-b', operation_name: 'Qadoqlash', sort_order: 1 },
      ];
      return [
        { worker_id: '7', worker_name: 'Nodira', model_operation_id: 'operation-a', quantity: '250' },
        { worker_id: '8', worker_name: 'Nodira', model_operation_id: 'operation-a', quantity: '125' },
      ];
    });
    const service = new ModelAccountQueryService();

    await expect(service.getModelAccountSheet({ query } as unknown as DataSource, modelId)).resolves.toEqual({
      model_id: modelId,
      operations: [
        { model_operation_id: 'operation-a', operation_name: 'Tikish', sort_order: 0 },
        { model_operation_id: 'operation-b', operation_name: 'Qadoqlash', sort_order: 1 },
      ],
      rows: [
        { worker_id: '7', worker_name: 'Nodira', model_operation_id: 'operation-a', quantity: '250' },
        { worker_id: '8', worker_name: 'Nodira', model_operation_id: 'operation-a', quantity: '125' },
      ],
    });
    const aggregateSql = String(query.mock.calls[3]?.[0]);
    expect(aggregateSql).toContain('WHERE sheet."model_id" = $1');
    expect(aggregateSql).not.toContain('JOIN "patta_hisob" patta');
    expect(aggregateSql).toContain('sheet."deleted_at" IS NULL');
    expect(aggregateSql).toContain('sheet_row."deleted_at" IS NULL');
    expect(aggregateSql).toContain('GROUP BY sheet."model_id", sheet_operation."model_operation_id", sheet_row."worker_id"');
  });

  it('returns a structured not-found error for unknown model IDs', async () => {
    const service = new ModelAccountQueryService();
    const dataSource = { query: vi.fn(async () => []) } as unknown as DataSource;
    await expect(service.getModelAccountSheet(dataSource, modelId)).rejects.toMatchObject({
      response: { code: 'MODEL_NOT_FOUND' },
    });
  });

  it('blocks V2 account totals when the model has V3-only contributions', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "models"')) return [{ id: modelId }];
      return [{ present: true }];
    });

    await expect(new ModelAccountQueryService().getModelAccountSheet({ query } as unknown as DataSource, modelId))
      .rejects.toMatchObject({ response: { code: 'SYNC_PROTOCOL_UPGRADE_REQUIRED' } });
  });

  it('combines Patta and manual contributions using each immutable source price snapshot', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "models"')) return [{ id: modelId, name: 'Atlas' }];
      if (sql.includes('FROM "model_operations"')) return [{
        model_operation_id: 'operation-a', operation_name: 'Tikish', sort_order: 0, version: '4',
        status: 'ACTIVE', current_price: '30.00'
      }];
      if (sql.includes('FROM "patta_sheet_rows"')) return [{
        entry_kind: 'PATTA_LINKED', model_operation_id: 'operation-a', worker_id: '7',
        worker_name: 'Nodira', quantity: '125', gross_amount: '1250.00'
      }, {
        entry_kind: 'STANDALONE', model_operation_id: 'operation-a', worker_id: '8',
        worker_name: 'Zuhra', quantity: '95', gross_amount: '2042.50'
      }];
      if (sql.includes('FROM "model_account_adjustments"')) return [{
        model_operation_id: 'operation-a', worker_id: '7', worker_name: 'Nodira', quantity: '20', gross_amount: '500.00'
      }];
      return [];
    });

    await expect(new ModelAccountQueryService().getModelAccountSheetV3({ query } as unknown as DataSource, modelId))
      .resolves.toEqual({
        model_id: modelId,
        model_name: 'Atlas',
        operations: [{
          model_operation_id: 'operation-a', operation_name: 'Tikish', sort_order: 0,
          version: '4', status: 'ACTIVE', current_price: '30.00', quantity: '240', patta_quantity: '125', standalone_quantity: '95',
          manual_quantity: '20', gross_amount: '3792.50', patta_amount: '1250.00',
          standalone_amount: '2042.50', manual_amount: '500.00'
        }],
        rows: [{
          worker_id: '7', worker_name: 'Nodira', model_operation_id: 'operation-a',
          patta_quantity: '125', standalone_quantity: '0', manual_quantity: '20', total_quantity: '145',
          patta_amount: '1250.00', standalone_amount: '0.00', manual_amount: '500.00', gross_amount: '1750.00'
        }, {
          worker_id: '8', worker_name: 'Zuhra', model_operation_id: 'operation-a',
          patta_quantity: '0', standalone_quantity: '95', manual_quantity: '0', total_quantity: '95',
          patta_amount: '0.00', standalone_amount: '2042.50', manual_amount: '0.00', gross_amount: '2042.50'
        }]
      });
    expect(String(query.mock.calls.find(([sql]) => String(sql).includes('sum(adjustment."quantity"::numeric'))?.[0]))
      .toContain('adjustment."unit_price_snapshot"');
  });

  it('groups linked, Standalone, and manual production once per source for the conveyor report', async () => {
    const query = vi.fn(async () => [{
      conveyor_label: 'Noma’lum', model_id: modelId, model_name: 'Atlas',
      patta_count: '2', standalone_entry_count: '1', manual_adjustment_count: '1', ish_soni: '145'
    }]);
    await expect(new ModelAccountQueryService().getConveyorAccount({ query } as unknown as DataSource)).resolves.toEqual([{
      conveyor_label: 'Noma’lum', model_id: modelId, model_name: 'Atlas',
      patta_count: '2', standalone_entry_count: '1', manual_adjustment_count: '1', ish_soni: '145'
    }]);
  });
});
