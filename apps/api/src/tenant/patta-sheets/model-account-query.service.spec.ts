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
    const aggregateSql = String(query.mock.calls[2]?.[0]);
    expect(aggregateSql).toContain('patta."status" = \'ACTIVE\'');
    expect(aggregateSql).toContain('sheet."deleted_at" IS NULL');
    expect(aggregateSql).toContain('sheet_row."deleted_at" IS NULL');
    expect(aggregateSql).toContain('GROUP BY patta."model_id", sheet_operation."model_operation_id", sheet_row."worker_id"');
  });

  it('returns a structured not-found error for unknown model IDs', async () => {
    const service = new ModelAccountQueryService();
    const dataSource = { query: vi.fn(async () => []) } as unknown as DataSource;
    await expect(service.getModelAccountSheet(dataSource, modelId)).rejects.toMatchObject({
      response: { code: 'MODEL_NOT_FOUND' },
    });
  });
});
