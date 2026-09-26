import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { OperationPriceService } from './operation-price.service.js';

const actorUserId = '11111111-1111-4111-8111-111111111111';
const operationId = '33333333-3333-4333-8333-333333333333';
const historyId = '44444444-4444-4444-8444-444444444444';
const transactionTime = '2026-09-26 00:00:00+00';

interface PriceHistoryRow {
  id: string;
  operation_id: string;
  price: string;
  valid_from: string;
  valid_to: string | null;
  created_by: string | null;
  created_at: string;
}

function openHistory(overrides: Partial<PriceHistoryRow> = {}): PriceHistoryRow {
  return {
    id: historyId,
    operation_id: operationId,
    price: '1000.00',
    valid_from: '2026-09-01 00:00:00+00',
    valid_to: null,
    created_by: actorUserId,
    created_at: '2026-09-01 00:00:00+00',
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
  return {
    manager,
    dataSource: dataSource as unknown as DataSource,
    query: dataSource.query,
    transaction: dataSource.transaction,
    auditService,
    service: new OperationPriceService(auditService as unknown as AuditService),
  };
}

function scheduleHappyPath(
  harness: ReturnType<typeof createHarness>,
  options: { price?: string; operationVersion?: string; openPrice?: string } = {},
): PriceHistoryRow {
  const result: PriceHistoryRow = {
    id: '55555555-5555-4555-8555-555555555555',
    operation_id: operationId,
    price: options.price ?? '1200.00',
    valid_from: '2026-10-01T00:00:00.000000Z',
    valid_to: null,
    created_by: actorUserId,
    created_at: '2026-09-26T00:00:00.000000Z',
  };
  harness.manager.query
    .mockResolvedValueOnce([{ id: operationId, model_id: '22222222-2222-4222-8222-222222222222', name: 'Yeng tikish', status: 'ACTIVE', version: options.operationVersion ?? '1' }])
    .mockResolvedValueOnce([{ transaction_time: transactionTime }])
    .mockResolvedValueOnce([openHistory({ price: options.openPrice ?? '1000.00' })])
    .mockResolvedValueOnce([{ not_past: true, after_open: true }])
    .mockResolvedValueOnce([{ id: historyId }])
    .mockResolvedValueOnce([result])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ version: '2' }]);
  return result;
}

describe('OperationPriceService', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('resolves a historical price only from the interval table', async () => {
    harness.query.mockResolvedValueOnce([{ price: '1000.00' }]);

    await expect(harness.service.resolvePrice(
      operationId,
      '2026-09-15T12:00:00.000Z',
      harness.dataSource,
    )).resolves.toBe('1000.00');
    expect(harness.query.mock.calls[0]?.[0]).toContain('FROM "model_operation_prices"');
    expect(harness.query.mock.calls[0]?.[0]).not.toContain('"model_operations"');
  });

  it('resolves current price at database transaction time without reading the compatibility price', async () => {
    harness.query.mockResolvedValueOnce([{ price: '1000.00' }]);

    await expect(harness.service.resolveCurrentPrice(harness.dataSource, operationId))
      .resolves.toBe('1000.00');
    expect(harness.query.mock.calls[0]?.[0]).toContain('transaction_timestamp()');
    expect(harness.query.mock.calls[0]?.[0]).toContain('FROM "model_operation_prices"');
    expect(harness.query.mock.calls[0]?.[0]).not.toContain('model_operations');
  });

  it('returns an explicit not-found error instead of falling back when no interval matches', async () => {
    harness.query.mockResolvedValueOnce([]);

    await expect(harness.service.resolvePrice(
      operationId,
      '2026-08-01T00:00:00.000Z',
      harness.dataSource,
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('appends a future price after locking and rechecking operation version', async () => {
    const scheduled = scheduleHappyPath(harness);

    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1200',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: '1',
    })).resolves.toMatchObject({
      ...scheduled,
      price: '1200.00',
      operation_version: '2',
    });

    expect(harness.manager.query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(harness.manager.query.mock.calls[0]?.[1]).toEqual([operationId]);
    expect(harness.manager.query.mock.calls[4]?.[0]).toContain('SET "valid_to"');
    expect(harness.manager.query.mock.calls[5]?.[0]).toContain('INSERT INTO "model_operation_prices"');
    expect(harness.manager.query.mock.calls[6]?.[0]).toContain('"version" = "version" + 1');
    expect(harness.manager.query.mock.calls[7]?.[0]).toContain('SELECT "version"::text');
    expect(harness.auditService.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'operation.price_change', actorUserId }),
    );
  });

  it('uses the transaction database timestamp when effective_from is omitted', async () => {
    scheduleHappyPath(harness);

    await harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1200.00',
      expectedVersion: '1',
    });

    expect(harness.manager.query.mock.calls[4]?.[1]).toEqual([transactionTime, historyId]);
    expect(harness.manager.query.mock.calls[5]?.[1]).toEqual([
      operationId,
      '1200.00',
      transactionTime,
      actorUserId,
    ]);
  });

  it('accepts effective_from equal to the transaction timestamp', async () => {
    const schedule = scheduleHappyPath(harness);
    schedule.valid_from = transactionTime;

    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1200.00',
      effectiveFrom: transactionTime,
      expectedVersion: '1',
    })).resolves.toMatchObject({ price: '1200.00' });
    expect(harness.manager.query.mock.calls[3]?.[1]).toEqual([
      transactionTime,
      transactionTime,
      expect.any(String),
    ]);
  });

  it('rejects a past effective_from without changing history or audit', async () => {
    harness.manager.query
      .mockResolvedValueOnce([{ id: operationId, status: 'ACTIVE', version: '1', name: 'Yeng tikish' }])
      .mockResolvedValueOnce([{ transaction_time: transactionTime }])
      .mockResolvedValueOnce([openHistory()])
      .mockResolvedValueOnce([{ not_past: false, after_open: true }]);

    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1200.00',
      effectiveFrom: '2026-09-25T23:59:59.999Z',
      expectedVersion: '1',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.manager.query).toHaveBeenCalledTimes(4);
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('rejects insertion inside an already scheduled interval instead of silently splitting it', async () => {
    harness.manager.query
      .mockResolvedValueOnce([{ id: operationId, status: 'ACTIVE', version: '1', name: 'Yeng tikish' }])
      .mockResolvedValueOnce([{ transaction_time: transactionTime }])
      .mockResolvedValueOnce([openHistory({ valid_from: '2026-10-01T00:00:00.000Z' })])
      .mockResolvedValueOnce([{ not_past: true, after_open: false }]);

    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1250.00',
      effectiveFrom: '2026-09-30T00:00:00.000Z',
      expectedVersion: '1',
    })).rejects.toBeInstanceOf(ConflictException);
    expect(harness.manager.query).toHaveBeenCalledTimes(4);
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('returns VERSION_CONFLICT from the locked row when a competing request already advanced it', async () => {
    harness.manager.query.mockResolvedValueOnce([
      { id: operationId, status: 'ACTIVE', version: '2', name: 'Yeng tikish' },
    ]);

    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1300.00',
      expectedVersion: '1',
    })).rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
    expect(harness.manager.query).toHaveBeenCalledOnce();
    expect(harness.auditService.append).not.toHaveBeenCalled();
  });

  it('rejects scheduling a price for an inactive operation', async () => {
    harness.manager.query.mockResolvedValueOnce([
      { id: operationId, status: 'INACTIVE', version: '1', name: 'Yeng tikish' },
    ]);

    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1200.00',
      expectedVersion: '1',
    })).rejects.toMatchObject({ response: { code: 'OPERATION_INACTIVE' } });
    expect(harness.manager.query).toHaveBeenCalledOnce();
  });

  it('maps a database exclusion violation to a structured price conflict', async () => {
    const overlap = Object.assign(new Error('database detail'), {
      driverError: { code: '23P01', constraint: 'ex_model_operation_prices_no_overlap' },
    });
    harness.manager.query.mockRejectedValueOnce(overlap);

    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '1200.00',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: '1',
    })).rejects.toMatchObject({ response: { code: 'OPERATION_PRICE_CONFLICT' } });
  });

  it('rejects negative prices before opening a transaction', async () => {
    await expect(harness.service.changePrice(harness.dataSource, {
      operationId,
      actorUserId,
      price: '-1.00',
      expectedVersion: '1',
    })).rejects.toMatchObject({ response: { code: 'INVALID_PRICE' } });
    expect(harness.transaction).not.toHaveBeenCalled();
  });
});
