import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { OperationPriceService } from '../operations/operation-price.service.js';
import type { PattaConfiguration } from './patta.config.js';
import { PattaService } from './patta.service.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const modelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const templateId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const operationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const transactionTime = '2026-09-26T10:00:00.000000Z';

const activeOperation = {
  id: operationId,
  name: 'Yeng tikish',
  sort_order: 4,
};

const activeTemplate = {
  id: templateId,
  model_id: modelId,
  konveyer: '2-konveyer',
  razmer: '42',
  rang: 'Qora',
  status: 'ACTIVE',
};

function createService(
  queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown>,
  options: { maxBatchSize?: number; price?: string } = {},
) {
  const query = vi.fn((sql: string, parameters?: unknown[]) => queryHandler(sql, parameters));
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    query,
    transaction: vi.fn(async <T>(callback: (transactionManager: EntityManager) => Promise<T>) =>
      callback(manager)),
  } as unknown as DataSource;
  const auditService = { append: vi.fn(async () => undefined) };
  const priceService = {
    resolvePrice: vi.fn(async () => options.price ?? '1000.00'),
  };
  const configuration: PattaConfiguration = {
    numberStart: 1n,
    blockSize: 1000n,
    maxActiveBlocksPerDevice: 2,
    maxBatchSize: options.maxBatchSize ?? 100,
  };
  return {
    service: new PattaService(
      auditService as unknown as AuditService,
      priceService as unknown as OperationPriceService,
      configuration,
    ),
    dataSource,
    query,
    auditService,
    priceService,
  };
}

function generationQueryHandler(count: number) {
  let pattaInsertIndex = 0;
  return async (sql: string, parameters?: unknown[]): Promise<unknown> => {
    if (sql.includes('SELECT "model_id" FROM "patta_templates"')) {
      return [{ model_id: modelId }];
    }
    if (sql.includes('FROM "models"')) {
      return [{ id: modelId, name: 'Atlas model', status: 'ACTIVE' }];
    }
    if (sql.includes('FROM "model_operations"')) {
      return [activeOperation];
    }
    if (sql.includes('FROM "patta_templates"') && sql.includes('FOR SHARE')) {
      return [activeTemplate];
    }
    if (sql.includes('transaction_timestamp()::text')) {
      return [{ transaction_time: transactionTime }];
    }
    if (sql.includes('FROM "patta_number_sequence"')) {
      return [{ next_number: '1057' }];
    }
    if (sql.includes('INSERT INTO "patta_operation_snapshots"')) {
      return [];
    }
    if (sql.includes('count(*)::integer AS "snapshot_count"')) {
      return [{ snapshot_count: 1 }];
    }
    if (sql.includes('INSERT INTO "patta_hisob"')) {
      pattaInsertIndex += 1;
      return [{
        id: parameters?.[0],
        partiya_number: parameters?.[1],
        patta_number: parameters?.[2],
        model_id: modelId,
        model_name_snapshot: 'Atlas model',
        template_id: parameters?.[5],
        konveyer_snapshot: parameters?.[6],
        razmer: parameters?.[7],
        rang: parameters?.[8],
        ish_soni: parameters?.[9],
        created_at: transactionTime,
      }];
    }
    if (sql.includes('UPDATE "patta_number_sequence"')) {
      return [];
    }
    if (sql.includes('SELECT count(*)::text AS "total"')) {
      return [{ total: String(count) }];
    }
    return [];
  };
}

describe('PattaService', () => {
  it('creates a batch from locked template values and one locked operation/price set', async () => {
    const { service, dataSource, query, auditService, priceService } = createService(
      generationQueryHandler(2),
    );

    const result = await service.generate(dataSource, actorId, deviceId, {
      partiya_number: ' 25/09-3 ',
      model_id: modelId,
      template_id: templateId,
      konveyer: ' 3  konveyer ',
      rang: null,
      count: 2,
      device_id: deviceId,
    });

    expect(result).toHaveLength(2);
    expect(result.map(({ patta_number }) => patta_number)).toEqual(['1057', '1058']);
    expect(result[0]).toMatchObject({
      partiya_number: '25/09-3',
      model_name_snapshot: 'Atlas model',
      konveyer_snapshot: '3 konveyer',
      razmer: '42',
      rang: null,
      ish_soni: 1,
      operations: [{ operation_name_snapshot: 'Yeng tikish', unit_price_snapshot: '1000.00', sort_order: 4 }],
    });
    const templateLockIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('FROM "patta_templates"') && sql.includes('FOR SHARE'));
    const operationLockIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('FROM "model_operations"'));
    const sequenceLockIndex = query.mock.calls.findIndex(([sql]) =>
      sql.includes('FROM "patta_number_sequence"'));
    expect(templateLockIndex).toBeGreaterThan(operationLockIndex);
    expect(sequenceLockIndex).toBeGreaterThan(templateLockIndex);
    expect(query.mock.calls.some(([sql]) => sql.includes('"price"') && sql.includes('model_operations'))).toBe(false);
    expect(priceService.resolvePrice).toHaveBeenCalledTimes(1);
    expect(priceService.resolvePrice).toHaveBeenCalledWith(operationId, transactionTime, expect.anything());
    expect(query.mock.calls.find(([sql]) => sql.includes('UPDATE "patta_number_sequence"'))?.[1])
      .toEqual(['1059']);
    expect(auditService.append).toHaveBeenCalledTimes(2);
    expect(auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta',
      action: 'patta.create',
      after: expect.objectContaining({ device_id: deviceId, block_id: null, source: 'ONLINE' }),
    }));
  });

  it('rejects a batch above the configured limit before opening a transaction', async () => {
    const { service, dataSource } = createService(async () => [], { maxBatchSize: 2 });
    await expect(service.generate(dataSource, actorId, deviceId, {
      partiya_number: 'A-1',
      model_id: modelId,
      konveyer: '1',
      count: 3,
      device_id: deviceId,
    })).rejects.toMatchObject({ response: { code: 'PATTA_BATCH_SIZE_INVALID' } });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a model with no ACTIVE operations before allocating sequence numbers', async () => {
    const queryHandler = async (sql: string): Promise<unknown> => {
      if (sql.includes('FROM "models"')) return [{ id: modelId, name: 'Atlas', status: 'ACTIVE' }];
      if (sql.includes('FROM "model_operations"')) return [];
      return [];
    };
    const { service, dataSource, query } = createService(queryHandler);
    await expect(service.generate(dataSource, actorId, deviceId, {
      partiya_number: 'A-1', model_id: modelId, konveyer: '1', count: 1, device_id: deviceId,
    })).rejects.toMatchObject({ response: { code: 'PATTA_MODEL_HAS_NO_OPERATIONS' } });
    expect(query.mock.calls.some(([sql]) => sql.includes('patta_number_sequence'))).toBe(false);
  });
});
