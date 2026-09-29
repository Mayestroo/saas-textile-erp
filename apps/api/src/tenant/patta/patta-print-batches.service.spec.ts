import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { OperationPriceService } from '../operations/operation-price.service.js';
import type { SyncChangeRecorder } from '../sync/sync-change-recorder.js';
import { PattaNumberBlocksService } from './patta-number-blocks.service.js';
import { PattaOfflineRegistrationValidator } from './patta-offline-registration.validator.js';
import { PattaPartiyaNumberBlocksService } from './patta-partiya-number-blocks.service.js';
import { PattaPrintBatchesService } from './patta-print-batches.service.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const modelId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const batchId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const printEventId = '99999999-9999-4999-8999-999999999999';
const transactionTime = '2026-09-28T10:00:00.000000Z';

function createService(queryHandler: (sql: string, parameters?: unknown[]) => Promise<unknown> = async () => []) {
  const query = vi.fn(queryHandler);
  const manager = { query } as unknown as EntityManager;
  const dataSource = {
    query,
    transaction: vi.fn(async <T>(callback: (transactionManager: EntityManager) => Promise<T>) => callback(manager)),
  } as unknown as DataSource;
  const auditService = { append: vi.fn(async () => undefined) };
  const operationPriceService = { resolvePrice: vi.fn(async () => '1000.00') };
  const syncChangeRecorder = { record: vi.fn(async () => ({ sequenceId: '1' })) };
  const pattaBlocks = { assertAllocatedNumber: vi.fn(async () => undefined) };
  const partiyaBlocks = { assertAllocatedNumber: vi.fn(async () => undefined) };
  const offlineValidator = new PattaOfflineRegistrationValidator(pattaBlocks as unknown as PattaNumberBlocksService);
  const service = new PattaPrintBatchesService(
    auditService as unknown as AuditService,
    operationPriceService as unknown as OperationPriceService,
    { numberStart: 1n, partiyaNumberStart: 1n, blockSize: 1000n, maxActiveBlocksPerDevice: 2, maxBatchSize: 100 },
    syncChangeRecorder as unknown as SyncChangeRecorder,
    pattaBlocks as unknown as PattaNumberBlocksService,
    partiyaBlocks as unknown as PattaPartiyaNumberBlocksService,
    offlineValidator,
  );
  return { service, dataSource, query, auditService, operationPriceService, syncChangeRecorder };
}

function batchQueryHandler(sql: string, parameters?: unknown[]): Promise<unknown> {
  if (sql.includes('FROM "models"')) return Promise.resolve([{ id: modelId, name: 'Atlas model', status: 'ACTIVE' }]);
  if (sql.includes('FROM "model_operations"')) return Promise.resolve([
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Tikish', sort_order: 1 },
    { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'Qadoqlash', sort_order: 2 },
  ]);
  if (sql.includes('transaction_timestamp()')) return Promise.resolve([{ transaction_time: transactionTime }]);
  if (sql.includes('FROM "patta_partiya_number_sequence"')) return Promise.resolve([{ next_number: '1' }]);
  if (sql.includes('FROM "patta_number_sequence"')) return Promise.resolve([{ next_number: '1' }]);
  if (sql.includes('INSERT INTO "patta_print_batches"')) return Promise.resolve([{ created_at: transactionTime, updated_at: transactionTime }]);
  if (sql.includes('INSERT INTO "patta_hisob"')) {
    return Promise.resolve([{
      id: parameters?.[0], partiya_number: parameters?.[1], patta_number: parameters?.[2],
      model_id: parameters?.[3], model_name_snapshot: parameters?.[4], print_batch_id: parameters?.[10],
      ish_soni: parameters?.[7], rang: parameters?.[6], razmer: parameters?.[5], version: '1',
      legacy_operation_count: null, status: 'ACTIVE', created_device_id: deviceId,
      created_from_block_id: null, created_by: actorId, template_id: null, konveyer_snapshot: null,
      client_created_at: null, occurred_at: null, created_at: transactionTime,
    }]);
  }
  return Promise.resolve([]);
}

describe('PattaPrintBatchesService', () => {
  it('atomically allocates tenant-global Partiya and Patta numbers and keeps product quantity separate from operations', async () => {
    const { service, dataSource, query, auditService, operationPriceService, syncChangeRecorder } = createService(batchQueryHandler);
    const result = await service.create(dataSource, actorId, deviceId, {
      model_id: modelId,
      ish_soni: 125,
      rang: ' Qora  rang ',
      size_distribution: [
        { razmer: ' S ', patta_count: 1, sort_order: 1 },
        { razmer: 'XS', patta_count: 1, sort_order: 0 },
      ],
      device_id: deviceId,
    });

    expect(result).toMatchObject({ partiya_number: '1', ish_soni: 125, rang: 'Qora rang', status: 'ACTIVE' });
    expect(result.size_distribution.map(({ razmer }) => razmer)).toEqual(['XS', 'S']);
    expect(result.pattas.map(({ patta_number, ish_soni }) => [patta_number, ish_soni])).toEqual([['1', 125], ['2', 125]]);
    expect(result.pattas[0]?.operations).toHaveLength(2);
    expect(dataSource.transaction).toHaveBeenCalledOnce();
    const partiyaLock = query.mock.calls.findIndex(([sql]) => String(sql).includes('FROM "patta_partiya_number_sequence"'));
    const pattaLock = query.mock.calls.findIndex(([sql]) => String(sql).includes('FROM "patta_number_sequence"'));
    expect(partiyaLock).toBeLessThan(pattaLock);
    expect(query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "patta_partiya_number_sequence"'))?.[1]).toEqual(['2']);
    expect(query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "patta_number_sequence"'))?.[1]).toEqual(['3']);
    expect(operationPriceService.resolvePrice).toHaveBeenCalledTimes(2);
    expect(auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_print_batch', action: 'patta_print_batch.create',
    }));
    expect(syncChangeRecorder.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_print_batches', projectionVersion: 2,
    }));
  });

  it('rejects duplicate size rows before opening a transaction', async () => {
    const { service, dataSource } = createService(batchQueryHandler);
    await expect(service.create(dataSource, actorId, deviceId, {
      model_id: modelId, ish_soni: 1, rang: 'Qora', device_id: deviceId,
      size_distribution: [
        { razmer: 'S', patta_count: 1, sort_order: 0 },
        { razmer: ' S ', patta_count: 2, sort_order: 1 },
      ],
    })).rejects.toMatchObject({ response: { code: 'PATTA_SIZE_DISTRIBUTION_INVALID' } });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('rejects a total size count over the configured batch limit before opening a transaction', async () => {
    const { service, dataSource } = createService(batchQueryHandler);
    await expect(service.create(dataSource, actorId, deviceId, {
      model_id: modelId, ish_soni: 1, rang: 'Qora', device_id: deviceId,
      size_distribution: [{ razmer: 'S', patta_count: 101, sort_order: 0 }],
    })).rejects.toMatchObject({ response: { code: 'PATTA_BATCH_SIZE_INVALID' } });
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('records a successful print once and keeps the first printed_at without allocating more numbers', async () => {
    const printEvent = {
      id: printEventId,
      batch_id: batchId,
      revision: 1,
      kind: 'INITIAL',
      outcome: 'SUCCEEDED',
      actor_user_id: actorId,
      device_id: deviceId,
      created_at: transactionTime,
    };
    let batchSelectCount = 0;
    const { service, dataSource, query, auditService, syncChangeRecorder } = createService(async (sql) => {
      if (sql.includes('FROM "patta_print_batches"')) {
        batchSelectCount += 1;
        return batchSelectCount === 1
          ? [{ id: batchId, revision: 1, status: 'ACTIVE', printed_at: null }]
          : [{ printed_at: transactionTime }];
      }
      if (sql.includes('FROM "patta_print_events"')) return [];
      if (sql.includes('INSERT INTO "patta_print_events"')) return [printEvent];
      if (sql.includes('UPDATE "patta_print_batches"')) return [{ id: batchId }];
      return [];
    });

    await expect(service.recordPrintEvent(
      dataSource, actorId, deviceId, batchId,
      { event_id: printEventId, revision: 1, kind: 'INITIAL', outcome: 'SUCCEEDED', device_id: deviceId },
    )).resolves.toMatchObject({ id: printEventId, batch_id: batchId, outcome: 'SUCCEEDED', printed_at: transactionTime });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "patta_number_sequence"'))).toBe(false);
    expect(auditService.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_print_event', action: 'patta_print_event.record',
    }));
    expect(syncChangeRecorder.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      entityType: 'patta_print_events', projectionVersion: 2,
    }));
  });

  it('returns legacy unknown quantity separately from operation count in v2 lookup', async () => {
    const { service, dataSource, query } = createService(async (sql) => {
      if (sql.includes('FROM "patta_hisob" patta')) return [{
        id: batchId,
        partiya_number: 'LEGACY-1',
        patta_number: '15',
        model_id: modelId,
        model_name_snapshot: 'Atlas',
        template_id: null,
        konveyer_snapshot: null,
        razmer: 'S',
        rang: 'Qora',
        ish_soni: null,
        legacy_operation_count: 13,
        status: 'ACTIVE',
        print_batch_id: null,
        created_device_id: deviceId,
        created_from_block_id: null,
        version: '1',
        client_created_at: null,
        occurred_at: null,
        printed_at: null,
        created_at: transactionTime,
      }];
      if (sql.includes('FROM "patta_operation_snapshots"')) {
        return Array.from({ length: 13 }, (_, index) => ({
          id: `${index}`,
          operation_id: `operation-${index}`,
          operation_name_snapshot: `Operation ${index}`,
          unit_price_snapshot: '1.00',
          sort_order: index,
          created_at: transactionTime,
        }));
      }
      if (sql.includes('FROM "server_change_log"')) return [{ sequence: '17' }];
      return [];
    });

    const result = await service.lookup(dataSource, { partiya_number: ' LEGACY-1 ', patta_number: '15' });
    expect(result).toMatchObject({ ish_soni: null, legacy_operation_count: 13, operation_count: 13, printed_at: null });
    expect(query).toHaveBeenCalledTimes(3);
    expect(result.mirror).toMatchObject({ server_sequence: '17', batch: null });
    expect(result.mirror.patta).toMatchObject({ id: batchId, ish_soni: null, legacy_operation_count: 13 });
    expect(result.mirror.patta.operations[0]).toMatchObject({ operation_id: 'operation-0' });
    expect(result.mirror.patta.operations).toHaveLength(13);
    expect(query.mock.calls[0]?.[1]).toEqual(['LEGACY-1', '15']);
  });

  it('returns the original event on an identical retry without writing another attempt', async () => {
    const existingEvent = {
      id: printEventId,
      batch_id: batchId,
      revision: 1,
      kind: 'REPRINT',
      outcome: 'FAILED',
      actor_user_id: actorId,
      device_id: deviceId,
      created_at: transactionTime,
    };
    const { service, dataSource, query, auditService } = createService(async (sql) => {
      if (sql.includes('FROM "patta_print_batches"')) return [{ id: batchId, revision: 2, status: 'ACTIVE', printed_at: transactionTime }];
      if (sql.includes('FROM "patta_print_events"')) return [existingEvent];
      return [];
    });

    await expect(service.recordPrintEvent(
      dataSource, actorId, deviceId, batchId,
      { event_id: printEventId, revision: 1, kind: 'REPRINT', outcome: 'FAILED', device_id: deviceId },
    )).resolves.toMatchObject({ id: printEventId, revision: 1, printed_at: transactionTime });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO "patta_print_events"'))).toBe(false);
    expect(auditService.append).not.toHaveBeenCalled();
  });

  it('blocks a correction that would change the size of a Patta with an existing Entry', async () => {
    const activePatta = {
      id: '88888888-8888-4888-8888-888888888888',
      partiya_number: '1', patta_number: '1', model_id: modelId, model_name_snapshot: 'Atlas',
      template_id: null, konveyer_snapshot: null, razmer: 'S', rang: 'Qora', ish_soni: 125,
      legacy_operation_count: null, status: 'ACTIVE', print_batch_id: batchId,
      created_device_id: deviceId, created_from_block_id: null, created_by: actorId,
      created_at: transactionTime, client_created_at: null, occurred_at: null, version: '1',
    };
    const { service, dataSource, query } = createService(async (sql, parameters) => {
      if (sql.includes('FROM "patta_print_batches" WHERE "id" = $1 FOR UPDATE')) return [{
        id: batchId, model_id: modelId, model_name_snapshot: 'Atlas', partiya_number: '1',
        partiya_block_id: null, ish_soni: 125, rang: 'Qora', status: 'ACTIVE', version: '1', revision: 1,
        corrected_from_batch_id: null, created_by: actorId, created_device_id: deviceId,
        printed_at: transactionTime, created_at: transactionTime, updated_at: transactionTime,
      }];
      if (sql.includes('SELECT EXISTS')) return [{ allowed: parameters?.[1] === 'patta.chiqarish.correct' }];
      if (sql.includes('FROM "patta_print_batch_sizes"')) return [{
        id: '77777777-7777-4777-8777-777777777777', razmer: 'S', patta_count: 1, sort_order: 0,
      }];
      if (sql.includes('FROM "patta_hisob" WHERE "print_batch_id" = $1 AND "status"')) return [activePatta];
      if (sql.includes("to_regclass('public.patta_sheets')")) return [{ present: true }];
      if (sql.includes('FROM "patta_sheets"')) return [{
        id: '66666666-6666-4666-8666-666666666666', patta_hisob_id: activePatta.id,
        version: '1', deleted_at: null,
      }];
      return [];
    });

    await expect(service.correctBatch(dataSource, actorId, deviceId, batchId, {
      expected_version: '1', correction_reason: 'Razmer noto‘g‘ri', ish_soni: 125,
      rang: 'Qora', size_distribution: [{ razmer: 'M', patta_count: 1, sort_order: 0 }],
      device_id: deviceId,
    })).rejects.toMatchObject({ response: { code: 'PATTA_ALREADY_IN_USE' } });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO "patta_print_batch_corrections"'))).toBe(false);
  });

  it('allocates fresh global Patta numbers for size deficits and returns the revised batch projection', async () => {
    const originalPattaId = '88888888-8888-4888-8888-888888888888';
    const basePatta = {
      id: originalPattaId,
      partiya_number: '1', patta_number: '1', model_id: modelId, model_name_snapshot: 'Atlas',
      template_id: null, konveyer_snapshot: null, razmer: 'S', rang: 'Qora', ish_soni: 125,
      legacy_operation_count: null, status: 'ACTIVE', print_batch_id: batchId,
      created_device_id: deviceId, created_from_block_id: null, created_by: actorId,
      created_at: transactionTime, client_created_at: null, occurred_at: null, version: '1',
    };
    const newPattaId = '55555555-5555-4555-8555-555555555555';
    const { service, dataSource, query } = createService(async (sql, _parameters) => {
      if (sql.includes('FROM "patta_print_batches" WHERE "id" = $1 FOR UPDATE')) return [{
        id: batchId, model_id: modelId, model_name_snapshot: 'Atlas', partiya_number: '1',
        partiya_block_id: null, ish_soni: 125, rang: 'Qora', status: 'ACTIVE', version: '1', revision: 1,
        corrected_from_batch_id: null, created_by: actorId, created_device_id: deviceId,
        printed_at: transactionTime, created_at: transactionTime, updated_at: transactionTime,
      }];
      if (sql.includes('SELECT EXISTS')) return [{ allowed: true }];
      if (sql.includes('SELECT "id", "razmer", "patta_count"')) return [{
        id: '77777777-7777-4777-8777-777777777777', razmer: 'S', patta_count: 1, sort_order: 0,
      }];
      if (sql.includes('FROM "patta_hisob" WHERE "print_batch_id" = $1 AND "status"')) return [basePatta];
      if (sql.includes("to_regclass('public.patta_sheets')")) return [{ present: false }];
      if (sql.includes('FROM "patta_number_sequence"')) return [{ next_number: '9' }];
      if (sql.includes('SELECT snapshot."id"')) return [{
        id: '99999999-9999-4999-8999-999999999999', patta_hisob_id: originalPattaId,
        operation_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', operation_name_snapshot: 'Tikish',
        unit_price_snapshot: '1000.00', sort_order: 0, created_at: transactionTime,
      }];
      if (sql.includes('INSERT INTO "patta_hisob"') && sql.includes('VALUES ($1, $2, $3::bigint')) return [];
      if (sql.includes('FROM patta_print_batches WHERE id = $1')) return [{
        id: batchId, model_id: modelId, model_name_snapshot: 'Atlas', partiya_number: '1',
        partiya_block_id: null, ish_soni: 125, rang: 'Qora', status: 'ACTIVE', version: '2', revision: 2,
        corrected_from_batch_id: null, created_by: actorId, created_device_id: deviceId,
        printed_at: transactionTime, created_at: transactionTime, updated_at: transactionTime,
      }];
      if (sql.includes('SELECT id, print_batch_id, razmer')) return [{
        id: '77777777-7777-4777-8777-777777777777', print_batch_id: batchId,
        razmer: 'S', patta_count: 2, sort_order: 0,
      }];
      if (sql.includes('SELECT id, partiya_number, patta_number::text')) return [
        { ...basePatta, version: '2' },
        {
          ...basePatta, id: newPattaId, patta_number: '9', version: '1',
        },
      ];
      if (sql.includes('SELECT snapshot.id')) return [
        {
          id: '99999999-9999-4999-8999-999999999999', patta_hisob_id: originalPattaId,
          operation_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', operation_name_snapshot: 'Tikish',
          unit_price_snapshot: '1000.00', sort_order: 0, created_at: transactionTime,
        },
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab', patta_hisob_id: newPattaId,
          operation_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', operation_name_snapshot: 'Tikish',
          unit_price_snapshot: '1000.00', sort_order: 0, created_at: transactionTime,
        },
      ];
      return [];
    });

    const result = await service.correctBatch(dataSource, actorId, deviceId, batchId, {
      expected_version: '1', correction_reason: 'Yana bitta Patta kerak', ish_soni: 125,
      rang: 'Qora', size_distribution: [{ razmer: 'S', patta_count: 2, sort_order: 0 }],
      device_id: deviceId,
    });
    expect(result).toMatchObject({ version: '2', revision: 2, ish_soni: 125 });
    expect(result.pattas.map(({ patta_number }) => patta_number)).toEqual(['1', '9']);
    expect(result.pattas[1]?.version).toBe('1');
    expect(query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "patta_number_sequence"'))?.[1]).toEqual(['10']);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "patta_partiya_number_sequence"'))).toBe(false);
  });
});
