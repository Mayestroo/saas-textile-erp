import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { OperationsService } from './operations.service.js';
import { OperationPriceService } from './operation-price.service.js';

const actorUserId = '11111111-1111-4111-8111-111111111111';
const modelId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';

interface OperationRow {
  id: string;
  model_id: string;
  name: string;
  sort_order: number;
  status: 'ACTIVE' | 'INACTIVE';
  version: string;
  created_at: Date;
  updated_at: Date;
}

function row(overrides: Partial<OperationRow> = {}): OperationRow {
  const now = new Date('2026-09-26T00:00:00.000Z');
  return {
    id: operationId,
    model_id: modelId,
    name: 'Yeng tikish',
    sort_order: 0,
    status: 'ACTIVE',
    version: '1',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createHarness() {
  const manager = { query: vi.fn() };
  const dataSource = {
    query: vi.fn(),
    transaction: vi.fn(async (work: (transaction: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager)),
  };
  const auditService = { append: vi.fn(async () => undefined) };
  const syncChangeRecorder = {
    record: vi.fn(async () => ({ sequenceId: '1' })),
  };
  const priceService = {
    createInitialPrice: vi.fn(async (_manager, operation_id, price, created_by, effectiveAt) => ({
      id: '44444444-4444-4444-8444-444444444444',
      operation_id,
      price,
      valid_from: effectiveAt,
      valid_to: null,
      created_by,
      created_at: '2026-09-26T00:00:00.000Z',
    })),
    resolvePrice: vi.fn(async () => '1000.00'),
    resolveCurrentPrice: vi.fn(async () => '1000.00'),
    resolveCurrentPrices: vi.fn(async () => new Map([[operationId, '1000.00']])),
  };
  return {
    manager,
    dataSource: dataSource as unknown as DataSource,
    query: dataSource.query,
    transaction: dataSource.transaction,
    auditService,
    syncChangeRecorder,
    priceService,
    service: new OperationsService(
      auditService as unknown as AuditService,
      priceService as unknown as OperationPriceService,
      syncChangeRecorder as unknown as SyncChangeRecorder,
    ),
  };
}

describe('OperationsService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('creates an operation and its initial history in the same transaction', async () => {
    const created = row();
    harness.manager.query
      .mockResolvedValueOnce([{ id: modelId, status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ transaction_time: '2026-09-26T00:00:00.000Z' }])
      .mockResolvedValueOnce([created]);

    await expect(harness.service.create(
      harness.dataSource,
      modelId,
      actorUserId,
      { name: ' Yeng   tikish ', price: '1000', sort_order: 0 },
    )).resolves.toMatchObject({
      id: operationId,
      name: 'Yeng tikish',
      price: '1000.00',
      version: '1',
    });

    expect(harness.transaction).toHaveBeenCalledOnce();
    expect(harness.manager.query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(harness.priceService.createInitialPrice).toHaveBeenCalledWith(
      expect.anything(),
      operationId,
      '1000.00',
      actorUserId,
      expect.any(String),
    );
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'operation.create',
        actorUserId,
        entityId: operationId,
        before: null,
      }),
    );
    expect(harness.syncChangeRecorder.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: 'model_operations',
        entityId: operationId,
        operation: 'UPSERT',
        entityVersion: '1',
        projectionVersion: 1,
        payload: expect.objectContaining({
          projection_version: 1,
          entity_type: 'model_operations',
          entity_id: operationId,
          entity_version: '1',
        }),
      }),
    );
  });

  it('creates a new sheet operation with stable ID and a price interval effective at entered_at', async () => {
    const customOperation = row({ id: operationId, name: 'Kesish', sort_order: 2 });
    harness.manager.query
      .mockResolvedValueOnce([{ id: modelId, status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ transaction_time: '2026-09-28T10:00:00.000Z' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([customOperation]);

    await expect(harness.service.createForPattaSheet(
      harness.dataSource,
      modelId,
      actorUserId,
      '55555555-5555-4555-8555-555555555555',
      {
        id: operationId,
        name: ' Kesish ',
        initial_price: '4.50',
        sort_order: 2,
        effective_from: '2026-09-27T20:00:00.000Z',
      },
    )).resolves.toMatchObject({ id: operationId, name: 'Kesish', price: '4.50' });
    expect(harness.priceService.createInitialPrice).toHaveBeenCalledWith(
      expect.anything(), operationId, '4.50', actorUserId, '2026-09-27T20:00:00.000Z',
    );
    expect(harness.auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      deviceId: '55555555-5555-4555-8555-555555555555', action: 'operation.create', entityId: operationId,
    }));
  });

  it('reuses an active same-model canonical operation without adding a price history row', async () => {
    harness.manager.query
      .mockResolvedValueOnce([{ id: modelId, status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ transaction_time: '2026-09-28T10:00:00.000Z' }])
      .mockResolvedValueOnce([row({ name: 'Kesish', sort_order: 2 })]);

    await expect(harness.service.createForPattaSheet(
      harness.dataSource,
      modelId,
      actorUserId,
      '55555555-5555-4555-8555-555555555555',
      {
        id: '99999999-9999-4999-8999-999999999999',
        name: ' Kesish ', initial_price: '4.50', sort_order: 2,
        effective_from: '2026-09-27T20:00:00.000Z',
      },
    )).resolves.toMatchObject({ id: operationId, name: 'Kesish', price: '1000.00' });
    expect(harness.priceService.createInitialPrice).not.toHaveBeenCalled();
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('rejects operation creation under an inactive model', async () => {
    harness.manager.query.mockResolvedValueOnce([{ id: modelId, status: 'INACTIVE' }]);

    await expect(harness.service.create(
      harness.dataSource,
      modelId,
      actorUserId,
      { name: 'Yeng tikish', price: '1000', sort_order: 0 },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.manager.query).toHaveBeenCalledOnce();
    expect(harness.priceService.createInitialPrice).not.toHaveBeenCalled();
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('rejects invalid operation money and sort order before opening a transaction', async () => {
    await expect(harness.service.create(
      harness.dataSource,
      modelId,
      actorUserId,
      { name: 'Negative price', price: '-1.00', sort_order: 0 },
    )).rejects.toMatchObject({ response: { code: 'INVALID_PRICE' } });
    await expect(harness.service.create(
      harness.dataSource,
      modelId,
      actorUserId,
      { name: 'Negative order', price: '1.00', sort_order: -1 },
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it('maps an active normalized operation-name collision to a structured conflict', async () => {
    harness.manager.query.mockRejectedValueOnce(Object.assign(new Error('database detail'), {
      driverError: { code: '23505', constraint: 'uq_model_operations_active_name' },
    }));

    await expect(harness.service.create(
      harness.dataSource,
      modelId,
      actorUserId,
      { name: 'Yeng tikish', price: '1000.00', sort_order: 0 },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('lists by model and resolves each current price through OperationPriceService', async () => {
    harness.query
      .mockResolvedValueOnce([{ id: modelId }])
      .mockResolvedValueOnce([row()]);

    await expect(harness.service.listByModel(harness.dataSource, modelId)).resolves.toMatchObject([
      { id: operationId, price: '1000.00' },
    ]);
    expect(harness.query.mock.calls[0]?.[0]).not.toContain('"model_operations"."price"');
    expect(harness.priceService.resolveCurrentPrices).toHaveBeenCalledWith(
      harness.dataSource,
      [operationId],
    );
  });

  it('updates an operation with optimistic locking and resolves current price from history', async () => {
    const before = row();
    const after = row({ name: 'Yeng biriktirish', version: '2' });
    harness.manager.query
      .mockResolvedValueOnce([{ model_id: modelId }])
      .mockResolvedValueOnce([{ id: modelId, status: 'ACTIVE' }])
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([after]);
    harness.priceService.resolveCurrentPrice
      .mockResolvedValueOnce('1000.00')
      .mockResolvedValueOnce('1200.00');

    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      operationId,
      { name: 'Yeng biriktirish', expected_version: '1' },
    )).resolves.toMatchObject({ name: 'Yeng biriktirish', price: '1200.00', version: '2' });

    expect(harness.manager.query.mock.calls[2]?.[0]).toContain('FOR UPDATE');
    expect(harness.manager.query.mock.calls[3]?.[0]).toContain('"version" = "version" + 1');
    expect(harness.priceService.resolveCurrentPrice).toHaveBeenCalledWith(
      expect.anything(),
      operationId,
    );
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'operation.update' }),
    );
    expect(harness.syncChangeRecorder.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: 'model_operations',
        entityId: operationId,
        entityVersion: '2',
        operation: 'UPSERT',
        payload: expect.objectContaining({
          entity_version: '2',
          data: expect.objectContaining({ version: '2', name: 'Yeng biriktirish' }),
        }),
      }),
    );
  });

  it('returns VERSION_CONFLICT for a stale locked operation without writing', async () => {
    harness.manager.query
      .mockResolvedValueOnce([{ model_id: modelId }])
      .mockResolvedValueOnce([{ id: modelId, status: 'ACTIVE' }])
      .mockResolvedValueOnce([row({ version: '4' })]);

    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      operationId,
      { name: 'New name', expected_version: '3' },
    )).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    expect(harness.manager.query).toHaveBeenCalledTimes(3);
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('rejects reactivation when the locked parent model is inactive', async () => {
    harness.manager.query
      .mockResolvedValueOnce([{ model_id: modelId }])
      .mockResolvedValueOnce([{ id: modelId, status: 'INACTIVE' }])
      .mockResolvedValueOnce([row({ status: 'INACTIVE', version: '2' })]);

    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      operationId,
      { status: 'ACTIVE', expected_version: '2' },
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(harness.manager.query).toHaveBeenCalledTimes(3);
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('deactivates operations without deleting their price history', async () => {
    const before = row();
    const after = row({ status: 'INACTIVE', version: '2' });
    harness.manager.query
      .mockResolvedValueOnce([{ model_id: modelId }])
      .mockResolvedValueOnce([{ id: modelId, status: 'ACTIVE' }])
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([after]);

    await expect(harness.service.update(
      harness.dataSource,
      actorUserId,
      operationId,
      { status: 'INACTIVE', expected_version: '1' },
    )).resolves.toMatchObject({ status: 'INACTIVE', version: '2' });
    expect(harness.manager.query.mock.calls[3]?.[0]).not.toContain('DELETE');
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'operation.deactivate' }),
    );
  });
});
