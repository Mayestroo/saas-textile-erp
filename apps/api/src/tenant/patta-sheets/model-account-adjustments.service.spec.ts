import type { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { OperationPriceService } from '../operations/operation-price.service.js';
import type { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { ModelAccountAdjustmentsService } from './model-account-adjustments.service.js';

const adjustmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const modelId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const deviceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const enteredAt = '2026-09-27T20:00:00.000Z';
const timestamp = '2026-09-28T10:00:00.000000Z';

function createService(
  queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown>,
  effectivePrice = '21.50'
) {
  const query = vi.fn(queryHandler);
  const manager = { query } as unknown as EntityManager;
  const audit = { append: vi.fn(async () => undefined) };
  const prices = { resolvePrice: vi.fn(async () => effectivePrice) };
  const changes = { record: vi.fn(async () => ({ sequenceId: '73' })) };
  const service = new ModelAccountAdjustmentsService(
    audit as unknown as AuditService,
    prices as unknown as OperationPriceService,
    changes as unknown as SyncChangeRecorder
  );
  return { service, manager, query, audit, prices, changes };
}

function input(price = '21.50') {
  return {
    model_id: modelId,
    model_operation_id: operationId,
    worker_id: '17',
    quantity: 20,
    unit_price_snapshot: price,
    entered_at: enteredAt,
    business_date: '2026-09-28',
    deleted_at: null,
    deleted_by: null,
    depends_on_event_ids: []
  };
}

function successQuery(sql: string): Promise<unknown> {
  if (sql.includes('AT TIME ZONE $2::text')) return Promise.resolve([{ business_date: '2026-09-28' }]);
  if (sql.includes('FROM "models" WHERE "id" = $1 FOR SHARE')) return Promise.resolve([{ id: modelId, status: 'ACTIVE' }]);
  if (sql.includes('FROM "model_operations" WHERE "id" = $1 FOR SHARE')) {
    return Promise.resolve([{ id: operationId, model_id: modelId, status: 'ACTIVE' }]);
  }
  if (sql.includes('FROM "workers" WHERE "id" = $1::bigint FOR SHARE')) {
    return Promise.resolve([{ id: '17', status: 'ACTIVE' }]);
  }
  if (sql.includes('transaction_timestamp()::text')) return Promise.resolve([{ transaction_time: timestamp }]);
  if (sql.includes('FROM "model_account_adjustments" WHERE "id" = $1')) return Promise.resolve([{
    id: adjustmentId, model_id: modelId, model_operation_id: operationId, worker_id: '17', quantity: 20,
    unit_price_snapshot: '21.50', entered_at: '2026-09-27T20:00:00.000000Z', business_date: '2026-09-28',
    version: '1', created_by: actorId, created_device_id: deviceId, created_at: timestamp,
    updated_at: timestamp, deleted_at: null, deleted_by: null
  }]);
  return Promise.resolve([]);
}

describe('ModelAccountAdjustmentsService', () => {
  it('validates authoritative references and effective price, then audits and records one V3 projection', async () => {
    const setup = createService(successQuery);
    const result = await setup.service.createInTransaction(
      setup.manager,
      actorId,
      deviceId,
      'Asia/Tashkent',
      adjustmentId,
      input()
    );

    expect(result).toMatchObject({
      id: adjustmentId,
      model_id: modelId,
      model_operation_id: operationId,
      worker_id: '17',
      quantity: 20,
      unit_price_snapshot: '21.50',
      business_date: '2026-09-28',
      version: '1'
    });
    expect(setup.prices.resolvePrice).toHaveBeenCalledWith(operationId, enteredAt, setup.manager);
    expect(setup.audit.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'model_account_adjustment', action: 'model_account_adjustment.create', entityId: adjustmentId
    }));
    expect(setup.changes.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'model_account_adjustments', projectionVersion: 3,
      payload: expect.objectContaining({ projection_version: 3, entity_type: 'model_account_adjustments' })
    }));
  });

  it('rejects an incorrect historical price before inserting a manual row', async () => {
    const setup = createService(successQuery, '30.00');
    await expect(setup.service.createInTransaction(
      setup.manager, actorId, deviceId, 'Asia/Tashkent', adjustmentId, input('21.50')
    )).rejects.toMatchObject({ response: { code: 'MODEL_ACCOUNT_ADJUSTMENT_PRICE_MISMATCH' } });
    expect(setup.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO "model_account_adjustments"'))).toBe(false);
    expect(setup.audit.append).not.toHaveBeenCalled();
  });
});
